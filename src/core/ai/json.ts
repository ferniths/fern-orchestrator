import { AppError } from '../kernel/errors'

/**
 * Pulls the first JSON object/array out of a model response.
 * Tolerates code fences, prose wrappers and trailing commentary.
 */
export function extractJson(text: string): unknown {
  const trimmed = text.trim()
  if (!trimmed) throw new AppError('invalid_response', 'empty response while expecting JSON')

  const unfenced = trimmed
    .replace(/^```(?:json|JSON)?\s*/g, '')
    .replace(/\s*```\s*$/g, '')
    .trim()

  try {
    return JSON.parse(unfenced)
  } catch {
    // fall through to scanning
  }

  for (const open of ['{', '[']) {
    const close = open === '{' ? '}' : ']'
    const start = unfenced.indexOf(open)
    if (start === -1) continue
    const end = findBalanced(unfenced, start, open, close)
    if (end > start) {
      const candidate = unfenced.slice(start, end + 1)
      try {
        return JSON.parse(candidate)
      } catch {
        // keep scanning
      }
    }
  }

  throw new AppError('invalid_response', 'no JSON payload found in response', { details: { preview: trimmed.slice(0, 200) } })
}

function findBalanced(s: string, start: number, open: string, close: string): number {
  let depth = 0
  let inString = false
  let escaped = false
  for (let i = start; i < s.length; i++) {
    const ch = s[i]!
    if (inString) {
      if (escaped) escaped = false
      else if (ch === '\\') escaped = true
      else if (ch === '"') inString = false
      continue
    }
    if (ch === '"') inString = true
    else if (ch === open) depth++
    else if (ch === close) {
      depth--
      if (depth === 0) return i
    }
  }
  return -1
}
