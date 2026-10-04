import type { z } from 'zod'
import type { ProviderConnection } from '@shared/domain'
import { AppError } from '../kernel/errors'
import { complete, type ChatMessage, type JsonSchemaSpec } from './chat'
import { extractJson } from './json'

export interface StructuredOptions<T> {
  messages: ChatMessage[]
  schema: z.ZodType<T>
  jsonSchema: JsonSchemaSpec
  model?: string | null
  temperature?: number
  maxTokens?: number
  timeoutMs?: number
  signal?: AbortSignal
  /** parse → validate → repair → retry budget (default 3 completions). */
  maxAttempts?: number
}

export interface StructuredResult<T> {
  data: T
  raw: string
  /** True when a later attempt had to repair an earlier malformed payload. */
  repaired: boolean
  attempts: number
  modelId: string
  providerId: string
  usage: { inputTokens: number; outputTokens: number; latencyMs: number }
}

function repairInstruction(reason: string): string {
  return [
    'Your previous reply could not be used:',
    reason,
    '',
    'Reply with ONLY a single JSON object that satisfies the schema you were given.',
    'No markdown fences, no commentary, no trailing text.',
  ].join('\n')
}

/**
 * Schema-validated completion with a parse→validate→repair→retry loop.
 * This is the control plane's answer to models that wrap JSON in prose,
 * drop `content` into `reasoning_content`, or drift from the schema.
 */
export async function completeJson<T>(
  provider: Pick<ProviderConnection, 'id' | 'baseUrl' | 'customHeaders' | 'timeoutMs' | 'defaultModel' | 'maxRetries'>,
  apiKey: string | null,
  opts: StructuredOptions<T>,
): Promise<StructuredResult<T>> {
  const maxAttempts = Math.max(1, opts.maxAttempts ?? 3)
  const usage = { inputTokens: 0, outputTokens: 0, latencyMs: 0 }
  const messages: ChatMessage[] = [...opts.messages]

  let lastReason = ''
  let lastRaw = ''

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const useSchema = attempt <= 2
    const res = await complete(provider, apiKey, {
      messages,
      model: opts.model ?? null,
      temperature: opts.temperature,
      maxTokens: opts.maxTokens,
      jsonSchema: useSchema ? opts.jsonSchema : null,
      timeoutMs: opts.timeoutMs,
      signal: opts.signal,
    })

    usage.inputTokens += res.usage.inputTokens
    usage.outputTokens += res.usage.outputTokens
    usage.latencyMs += res.usage.latencyMs
    lastRaw = res.text

    try {
      const parsed = extractJson(res.text)
      const check = opts.schema.safeParse(parsed)
      if (check.success) {
        return {
          data: check.data,
          raw: res.text,
          repaired: attempt > 1,
          attempts: attempt,
          modelId: res.modelId,
          providerId: res.providerId,
          usage,
        }
      }
      lastReason = check.error.issues
        .slice(0, 6)
        .map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`)
        .join('; ')
    } catch (err) {
      lastReason = err instanceof AppError ? err.message : String(err)
    }

    if (attempt < maxAttempts) {
      messages.push({ role: 'assistant', content: res.text || '(empty)' })
      messages.push({ role: 'user', content: repairInstruction(lastReason) })
    }
  }

  throw new AppError('invalid_response', `structured output failed after ${maxAttempts} attempts: ${lastReason}`, {
    details: { preview: lastRaw.slice(0, 300), attempts: maxAttempts },
  })
}
