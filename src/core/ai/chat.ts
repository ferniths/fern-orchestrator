import type { ProviderConnection } from '@shared/domain'
import { AppError } from '../kernel/errors'

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant'
  content: string
}

export interface JsonSchemaSpec {
  name: string
  schema: Record<string, unknown>
}

export interface CompleteOptions {
  messages: ChatMessage[]
  /** Provider-specific model id; falls back to the connection default. */
  model?: string | null
  temperature?: number
  maxTokens?: number
  jsonSchema?: JsonSchemaSpec | null
  timeoutMs?: number
  signal?: AbortSignal
}

export interface CompleteUsage {
  inputTokens: number
  outputTokens: number
  latencyMs: number
}

export interface CompleteResult {
  text: string
  modelId: string
  providerId: string
  finishReason: string | null
  usage: CompleteUsage
}

function normalizeBaseUrl(baseUrl: string): string {
  return baseUrl.replace(/\/+$/, '')
}

/** Maps HTTP status codes onto the shared error taxonomy used by retry policy. */
export function classifyHttpError(status: number, body: string, retryAfterMs?: number | null): AppError {
  const snippet = body.slice(0, 400)
  const details: Record<string, unknown> = { body: snippet, ...(retryAfterMs ? { retryAfterMs } : {}) }
  if (status === 401 || status === 403) return new AppError('provider_auth', `authentication failed (HTTP ${status})`, { details })
  if (status === 402) return new AppError('provider_error', `insufficient credits (HTTP ${status})`, { details })
  // 404 here means "this model/endpoint is not served here" — a retryable miss so
  // the fallback chain can move to another model/provider instead of dying hard.
  if (status === 404) return new AppError('provider_error', `model or endpoint not found (HTTP ${status})`, { details })
  if (status === 408 || status === 504) return new AppError('timeout', `provider gateway timeout (HTTP ${status})`, { details })
  if (status === 429) return new AppError('rate_limited', 'rate limited by provider', { details })
  if (status >= 500) return new AppError('provider_error', `provider error (HTTP ${status})`, { details })
  return new AppError('invalid_argument', `request rejected (HTTP ${status})`, { details })
}

/** `Retry-After` in seconds or as an HTTP date → milliseconds. */
function retryAfterMs(res: Response): number | null {
  const raw = res.headers.get('retry-after')
  if (!raw) return null
  const secs = Number(raw)
  if (Number.isFinite(secs)) return Math.max(0, secs * 1000)
  const at = Date.parse(raw)
  return Number.isNaN(at) ? null : Math.max(0, at - Date.now())
}

function backoffFor(err: AppError, attempt: number): number {
  const hinted = (err.details?.retryAfterMs as number | undefined) ?? null
  if (hinted !== null) return Math.min(hinted, 10_000)
  return Math.min(250 * 2 ** attempt, 2_000)
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

/** Some backends answer with `content: null` and put the payload in reasoning fields. */
function pickText(message: Record<string, unknown>): string | null {
  const direct = message.content
  if (typeof direct === 'string' && direct.trim()) return direct
  for (const key of ['reasoning_content', 'reasoning', 'thinking']) {
    const v = message[key]
    if (typeof v === 'string' && v.trim()) return v
    if (Array.isArray(v)) {
      const joined = v
        .map((part) => (typeof part === 'string' ? part : typeof part?.text === 'string' ? part.text : ''))
        .join('')
        .trim()
      if (joined) return joined
    }
  }
  if (typeof direct === 'string') return direct
  return null
}

/**
 * One-shot OpenAI-compatible chat completion against a stored connection.
 * Non-streaming by design: the control plane wants a single validated payload,
 * workers stream through OpenCode instead.
 */
export async function complete(
  provider: Pick<ProviderConnection, 'id' | 'baseUrl' | 'customHeaders' | 'timeoutMs' | 'defaultModel' | 'maxRetries'>,
  apiKey: string | null,
  opts: CompleteOptions,
): Promise<CompleteResult> {
  const model = opts.model?.trim() || provider.defaultModel.trim()
  if (!model) throw new AppError('invalid_argument', 'no model selected for completion')

  const timeoutMs = opts.timeoutMs ?? provider.timeoutMs
  const maxRetries = Math.max(0, provider.maxRetries ?? 0)
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    accept: 'application/json',
    ...provider.customHeaders,
  }
  if (apiKey) {
    // Drop every case variant first: spreading `Authorization` and then setting
    // `authorization` would send two conflicting headers on the wire.
    for (const k of Object.keys(headers)) if (k.toLowerCase() === 'authorization') delete headers[k]
    headers.authorization = `Bearer ${apiKey}`
  }

  const body: Record<string, unknown> = {
    model,
    messages: opts.messages,
    stream: false,
  }
  if (opts.temperature !== undefined) body.temperature = opts.temperature
  if (opts.maxTokens !== undefined) body.max_tokens = opts.maxTokens
  if (opts.jsonSchema) {
    body.response_format = {
      type: 'json_schema',
      json_schema: { name: opts.jsonSchema.name, schema: opts.jsonSchema.schema, strict: true },
    }
  }

  for (let attempt = 0; ; attempt++) {
    try {
      return await attemptComplete(provider, headers, body, opts, timeoutMs, model)
    } catch (err) {
      const appErr = err instanceof AppError ? err : null
      // Timeouts are not retried in place: the same endpoint will likely be
      // slow again, and re-trying would stall the caller for minutes before
      // the fallback chain ever gets its turn.
      const worth = Boolean(appErr?.retryable) && appErr?.code !== 'timeout'
      if (!worth || attempt >= maxRetries || opts.signal?.aborted) throw err
      await sleep(backoffFor(appErr!, attempt))
    }
  }
}

async function attemptComplete(
  provider: Pick<ProviderConnection, 'id' | 'baseUrl'>,
  headers: Record<string, string>,
  body: Record<string, unknown>,
  opts: CompleteOptions,
  timeoutMs: number,
  model: string,
): Promise<CompleteResult> {
  const controller = new AbortController()
  const onAbort = () => controller.abort()
  opts.signal?.addEventListener('abort', onAbort, { once: true })
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  const started = Date.now()

  try {
    const res = await fetch(`${normalizeBaseUrl(provider.baseUrl)}/chat/completions`, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: controller.signal,
    })
    const raw = await res.text()
    if (!res.ok) throw classifyHttpError(res.status, raw, retryAfterMs(res))

    let json: Record<string, unknown>
    try {
      json = JSON.parse(raw) as Record<string, unknown>
    } catch {
      throw new AppError('invalid_response', 'provider returned non-JSON body', { details: { body: raw.slice(0, 400) } })
    }

    const choices = Array.isArray(json.choices) ? (json.choices as Record<string, unknown>[]) : []
    const message = (choices[0]?.message ?? {}) as Record<string, unknown>
    const text = pickText(message) ?? ''
    const usage = (json.usage ?? {}) as Record<string, unknown>
    const requestedModel = typeof json.model === 'string' && json.model ? json.model : model

    return {
      text,
      modelId: requestedModel,
      providerId: provider.id,
      finishReason: typeof choices[0]?.finish_reason === 'string' ? (choices[0].finish_reason as string) : null,
      usage: {
        inputTokens: Number(usage.prompt_tokens ?? usage.input_tokens ?? 0) || 0,
        outputTokens: Number(usage.completion_tokens ?? usage.output_tokens ?? 0) || 0,
        latencyMs: Date.now() - started,
      },
    }
  } catch (err) {
    if (err instanceof AppError) throw err
    if ((err as Error).name === 'AbortError') {
      if (opts.signal?.aborted) throw new AppError('aborted', 'completion aborted')
      throw new AppError('timeout', `provider did not respond within ${timeoutMs}ms`)
    }
    throw new AppError('unavailable', `cannot reach ${provider.baseUrl}: ${(err as Error).message}`, { cause: err })
  } finally {
    clearTimeout(timer)
    opts.signal?.removeEventListener('abort', onAbort)
  }
}
