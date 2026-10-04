import type { z } from 'zod'
import type { AgentRole, ModelInfo, ProviderConnection } from '@shared/domain'
import { proseLanguageInstruction } from '@shared/domain'
import { AppError } from '../kernel/errors'
import type { AppContext } from '../kernel/appContext'
import { complete, type ChatMessage, type CompleteResult } from '../ai/chat'
import { completeJson, type StructuredResult } from '../ai/structured'
import { fetchModels } from '../ai/models'
import { resolveModel, type RouteDecision } from '../ai/router'

const CATALOG_TTL_MS = 10 * 60_000

export interface UsageTags {
  jobId?: string | null
  loopIndex?: number | null
  taskId?: string | null
  workerId?: string | null
}

export interface RunArgs extends UsageTags {
  role: AgentRole
  messages: ChatMessage[]
  /** Direct model override from a task or agent profile. */
  override?: { providerId?: string | null; modelId?: string | null } | null
  routeId?: string | null
  complexity?: 'low' | 'medium' | 'high'
  model?: string | null
  temperature?: number
  maxTokens?: number
  timeoutMs?: number
  signal?: AbortSignal
}

export interface StructuredRunArgs<T> extends RunArgs {
  schema: z.ZodType<T>
  jsonSchema: { name: string; schema: Record<string, unknown> }
  maxAttempts?: number
}

/**
 * Control-plane AI access: provider selection, key retrieval, completion,
 * usage accounting and provider health events in one place. Workers do NOT go
 * through this class — they run as real OpenCode sessions.
 */
export class ControlPlane {
  private readonly catalog = new Map<string, { at: number; models: ModelInfo[] }>()

  constructor(private readonly ctx: AppContext) {}

  private keyFor(provider: ProviderConnection): string | null {
    return provider.apiKeyRef ? this.ctx.keystore.get(provider.apiKeyRef) : null
  }

  /** Cached model discovery for one provider (TTL-bounded). */
  async modelsFor(provider: ProviderConnection): Promise<ModelInfo[]> {
    const hit = this.catalog.get(provider.id)
    if (hit && Date.now() - hit.at < CATALOG_TTL_MS) return hit.models
    try {
      const { models } = await fetchModels(provider, this.keyFor(provider))
      this.catalog.set(provider.id, { at: Date.now(), models })
      return models
    } catch (err) {
      // Serve the last known catalog rather than failing the run, but never
      // do it silently — a stale model list is a diagnosable condition.
      this.ctx.log('provider').debug('model catalog refresh failed', { providerId: provider.id, error: String(err) })
      return hit?.models ?? []
    }
  }

  /** Drop cached model discovery (call after a provider is created/edited/deleted). */
  invalidateCatalog(providerId?: string): void {
    if (providerId) this.catalog.delete(providerId)
    else this.catalog.clear()
  }

  /** providerId → discovered models, best effort (unknown providers map to []). */
  async snapshotCatalog(providers: ProviderConnection[]): Promise<Map<string, ModelInfo[]>> {
    const entries = await Promise.all(providers.map(async (p) => [p.id, await this.modelsFor(p)] as const))
    return new Map(entries)
  }

  /** Chooses provider/model/key or throws a user-facing `unavailable` error. */
  async resolve(args: RunArgs): Promise<{ decision: RouteDecision; provider: ProviderConnection; key: string | null }> {
    const providers = this.ctx.repos.providers.listProviders().filter((p) => p.enabled)
    if (providers.length === 0) throw new AppError('unavailable', 'no model provider configured — add one under Providers')

    const routes = this.ctx.repos.providers.listRoutes()
    const route =
      args.routeId != null
        ? (routes.find((r) => r.id === args.routeId) ?? null)
        : (routes.find((r) => r.isDefault) ?? null)

    const catalog = await this.snapshotCatalog(providers)
    const decision = resolveModel({
      role: args.role,
      route,
      providers,
      catalog,
      override: args.override ?? (args.model ? { modelId: args.model } : null),
      complexity: args.complexity,
    })
    if (!decision) throw new AppError('unavailable', 'no usable model for this role — check provider health and defaults')

    const provider = providers.find((p) => p.id === decision.primary.providerId)
    if (!provider) throw new AppError('unavailable', 'resolved provider disappeared while routing')
    return { decision, provider, key: this.keyFor(provider) }
  }

  /**
   * `diagnostics.diagnosticMode`: logs the shape of every control-plane request
   * (role, route, model, message count and a truncated transcript). The logger
   * redacts secrets before anything reaches disk.
   */
  private traceRequest(args: RunArgs, decision: RouteDecision): void {
    if (!this.ctx.config.get().diagnostics.diagnosticMode) return
    this.ctx.log('provider').debug('control-plane request', {
      role: args.role,
      jobId: args.jobId ?? null,
      providerId: decision.primary.providerId,
      modelId: decision.primary.modelId,
      messages: args.messages.length,
      transcript: args.messages
        .map((m) => `${m.role}: ${m.content.slice(0, 400)}`)
        .join('\n')
        .slice(0, 4000),
    })
  }

  private record(args: RunArgs, res: { modelId: string; providerId: string; inputTokens: number; outputTokens: number; latencyMs: number }): void {
    try {
      this.ctx.repos.workers.recordUsage({
        jobId: args.jobId ?? null,
        loopIndex: args.loopIndex ?? null,
        taskId: args.taskId ?? null,
        workerId: args.workerId ?? null,
        providerId: res.providerId,
        modelId: res.modelId,
        inputTokens: Math.round(res.inputTokens),
        outputTokens: Math.round(res.outputTokens),
        costUsd: 0,
        latencyMs: res.latencyMs,
        source: 'control_plane',
        at: Date.now(),
      })
    } catch (err) {
      this.ctx.log('provider').warn('usage record failed', { error: String(err) })
    }
  }

  private onFailure(args: RunArgs, err: unknown): void {
    if (!(err instanceof AppError)) return
    if (err.code === 'provider_auth' || err.code === 'unavailable' || err.code === 'rate_limited' || err.code === 'provider_error') {
      this.ctx.emit('provider.failed', {
        severity: 'warn',
        message: `${args.role}: ${err.message}`,
        jobId: args.jobId ?? null,
        data: { code: err.code, role: args.role },
      })
    }
  }

  /**
   * Effective output language for a run: the job's per-job override when it
   * has one, otherwise the global Settings → General language. Never throws —
   * a missing job or a stubbed context falls back to the default.
   */
  private effectiveLanguage(jobId?: string | null): string {
    const fallback = this.ctx.config?.get?.()?.general.language ?? 'English'
    if (!jobId) return fallback
    try {
      return this.ctx.repos.jobs.get(jobId)?.language ?? fallback
    } catch {
      return fallback
    }
  }

  /**
   * Appends the output-language instruction to the existing system message so
   * reviewer/final_reviewer/synthesizer prose comes back in the job's language.
   * Message roles are untouched and no message is added; English appends
   * nothing, keeping the default prompts byte-identical.
   */
  private withOutputLanguage(args: RunArgs): ChatMessage[] {
    const instruction = proseLanguageInstruction(this.effectiveLanguage(args.jobId))
    if (!instruction) return args.messages
    let appended = false
    return args.messages.map((message) => {
      if (!appended && message.role === 'system') {
        appended = true
        return { ...message, content: `${message.content}\n\n${instruction}` }
      }
      return message
    })
  }

  /** Plain text completion (titles, summaries, synthesis prose). */
  async runText(args: RunArgs): Promise<CompleteResult> {
    const messages = this.withOutputLanguage(args)
    const { decision, provider, key } = await this.resolve(args)
    this.traceRequest({ ...args, messages }, decision)
    try {
      const res = await complete(provider, key, {
        messages,
        model: decision.primary.modelId,
        temperature: args.temperature,
        maxTokens: args.maxTokens,
        timeoutMs: args.timeoutMs,
        signal: args.signal,
      })
      this.record(args, { modelId: res.modelId, providerId: provider.id, ...res.usage, outputTokens: res.usage.outputTokens, inputTokens: res.usage.inputTokens })
      return res
    } catch (err) {
      const fallback = await this.tryFallbacks(args, decision, err, (p, model) =>
        complete(p.provider, p.key, {
          messages,
          model,
          temperature: args.temperature,
          maxTokens: args.maxTokens,
          timeoutMs: args.timeoutMs,
          signal: args.signal,
        }),
      )
      if (fallback) return fallback
      this.onFailure(args, err)
      throw err
    }
  }

  /** Schema-validated completion with parse→repair→retry and usage accounting. */
  async runStructured<T>(args: StructuredRunArgs<T>): Promise<StructuredResult<T>> {
    const messages = this.withOutputLanguage(args)
    const { decision, provider, key } = await this.resolve(args)
    this.traceRequest({ ...args, messages }, decision)
    try {
      const res = await completeJson(provider, key, {
        messages,
        schema: args.schema,
        jsonSchema: args.jsonSchema,
        model: decision.primary.modelId,
        temperature: args.temperature,
        maxTokens: args.maxTokens,
        timeoutMs: args.timeoutMs,
        signal: args.signal,
        maxAttempts: args.maxAttempts,
      })
      this.record(args, { modelId: res.modelId, providerId: provider.id, ...res.usage })
      return res
    } catch (err) {
      const fallback = await this.tryFallbacks(args, decision, err, (p, model) =>
        completeJson(p.provider, p.key, {
          messages,
          schema: args.schema,
          jsonSchema: args.jsonSchema,
          model,
          temperature: args.temperature,
          maxTokens: args.maxTokens,
          timeoutMs: args.timeoutMs,
          signal: args.signal,
          maxAttempts: 1,
        }),
      )
      if (fallback) return fallback
      this.onFailure(args, err)
      throw err
    }
  }

  /** Walks the fallback chain for retryable failures only. */
  private async tryFallbacks<R>(
    args: RunArgs,
    decision: RouteDecision,
    err: unknown,
    attempt: (p: { provider: ProviderConnection; key: string | null }, model: string) => Promise<R>,
  ): Promise<R | null> {
    if (!(err instanceof AppError) || !err.retryable) return null
    for (const target of decision.fallbacks) {
      const provider = this.ctx.repos.providers.getProvider(target.providerId)
      if (!provider || !provider.enabled) continue
      try {
        const res = await attempt({ provider, key: this.keyFor(provider) }, target.modelId)
        const usage = (res as { usage?: { inputTokens: number; outputTokens: number; latencyMs: number } }).usage
        if (usage) {
          this.record(args, { modelId: target.modelId, providerId: target.providerId, ...usage })
        }
        this.ctx.emit('provider.fallback', {
          severity: 'info',
          message: `${args.role} fell back to ${target.modelId}`,
          jobId: args.jobId ?? null,
          data: { from: decision.primary.modelId, to: target.modelId },
        })
        return res
      } catch (next) {
        this.ctx.log('provider').warn('fallback failed', { model: target.modelId, error: String(next) })
      }
    }
    return null
  }
}
