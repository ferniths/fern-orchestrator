import type { ModelInfo, ProviderConnection } from '@shared/domain'
import { AppError } from '../kernel/errors'

export interface ModelsResult {
  models: ModelInfo[]
  latencyMs: number
}

function normalizeBaseUrl(baseUrl: string): string {
  return baseUrl.replace(/\/+$/, '')
}

/** GET /models against an OpenAI-compatible server, tolerant of response shapes. */
export async function fetchModels(provider: Pick<ProviderConnection, 'baseUrl' | 'customHeaders' | 'timeoutMs'>, apiKey: string | null): Promise<ModelsResult> {
  const started = Date.now()
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), Math.min(provider.timeoutMs, 30_000))
  try {
    const headers: Record<string, string> = { accept: 'application/json', ...provider.customHeaders }
    if (apiKey) headers.authorization = `Bearer ${apiKey}`

    const res = await fetch(`${normalizeBaseUrl(provider.baseUrl)}/models`, { headers, signal: controller.signal })
    if (!res.ok) {
      const body = (await res.text()).slice(0, 300)
      if (res.status === 401 || res.status === 403) {
        throw new AppError('provider_auth', `authentication failed (${res.status})`, { details: { body } })
      }
      if (res.status === 429) throw new AppError('rate_limited', 'rate limited by provider')
      throw new AppError('provider_error', `model list failed with HTTP ${res.status}`, { details: { body } })
    }

    const json = (await res.json()) as { data?: unknown[]; models?: unknown[]; id?: string }
    const raw = Array.isArray(json.data) ? json.data : Array.isArray(json.models) ? json.models : []

    const models: ModelInfo[] = []
    for (const entry of raw) {
      if (typeof entry === 'string') {
        models.push(emptyModel(entry))
        continue
      }
      if (!entry || typeof entry !== 'object') continue
      const e = entry as Record<string, unknown>
      const id = typeof e.id === 'string' ? e.id : typeof e.name === 'string' ? e.name : null
      if (!id) continue
      const model: ModelInfo = {
        ...emptyModel(id),
        name: typeof e.name === 'string' ? e.name : undefined,
        contextWindow: numberOrNull(e.context_length ?? e.contextWindow),
        maxOutput: numberOrNull(e.max_output_tokens ?? e.maxOutput),
        reasoning: booleanOrNull(e.reasoning),
        toolCalls: booleanOrNull(e.supports_tools ?? e.tools ?? e.toolCalls),
        vision: booleanOrNull(e.supports_vision ?? e.vision),
        isCombo: id.includes('+'),
      }
      models.push(model)
    }
    return { models, latencyMs: Date.now() - started }
  } catch (err) {
    if (err instanceof AppError) throw err
    if ((err as Error).name === 'AbortError') throw new AppError('timeout', 'provider did not respond in time')
    throw new AppError('unavailable', `cannot reach ${provider.baseUrl}: ${(err as Error).message}`)
  } finally {
    clearTimeout(timer)
  }
}

function emptyModel(id: string): ModelInfo {
  return {
    id,
    providerId: '',
    contextWindow: null,
    maxOutput: null,
    reasoning: null,
    toolCalls: null,
    vision: null,
    isCombo: id.includes('+'),
  }
}

function numberOrNull(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null
}
function booleanOrNull(v: unknown): boolean | null {
  if (typeof v === 'boolean') return v
  if (typeof v === 'string') return v === 'true' || v === 'yes'
  return null
}
