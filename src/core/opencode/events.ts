import type { ServerEndpoint } from './adapter'

export interface NormalizedEvent {
  /** OpenCode event type, e.g. `session.status`, `permission.asked`, `message.part.updated`. */
  type: string
  data: Record<string, unknown>
  sessionId: string | null
  directory: string | null
  at: number
}

function headersFor(server: ServerEndpoint): Record<string, string> {
  const headers: Record<string, string> = { accept: 'text/event-stream' }
  if (server.password) {
    const user = server.username ?? 'opencode'
    headers.authorization = `Basic ${Buffer.from(`${user}:${server.password}`).toString('base64')}`
  }
  return headers
}

/** Turns one SSE block (`event:` / `data:` lines) into a normalized event. */
export function parseSseBlock(block: string): NormalizedEvent | null {
  let eventName = ''
  const dataLines: string[] = []
  for (const raw of block.split(/\r?\n/)) {
    if (raw.startsWith(':')) continue
    const idx = raw.indexOf(':')
    const field = idx === -1 ? raw : raw.slice(0, idx)
    const value = idx === -1 ? '' : raw.slice(idx + 1).replace(/^ /, '')
    if (field === 'event') eventName = value
    else if (field === 'data') dataLines.push(value)
  }
  if (dataLines.length === 0) return null

  const joined = dataLines.join('\n')
  let parsed: unknown
  try {
    parsed = JSON.parse(joined)
  } catch {
    return null
  }
  if (!parsed || typeof parsed !== 'object') return null

  // Global stream wraps everything as {directory, project, workspace, payload}.
  const wrapper = parsed as { payload?: unknown; directory?: unknown }
  const payload = (
    wrapper.payload && typeof wrapper.payload === 'object' ? wrapper.payload : parsed
  ) as Record<string, unknown>

  // `sync` envelopes re-broadcast events that already arrive as named events —
  // dropping them keeps one delivery per transition (idle/permission must be idempotent).
  if (payload.type === 'sync') return null

  const type =
    typeof payload.type === 'string'
      ? payload.type
      : eventName ||
        (typeof payload.type === 'object' && payload.type && typeof (payload.type as { name?: unknown }).name === 'string'
          ? ((payload.type as { name: string }).name)
          : 'unknown')

  // 1.18.33 carries the payload under `properties` (OpenAPI documents it as `data`);
  // older builds used `data`, ancient ones had fields flat on the payload. Accept all.
  const nested = (payload.properties ?? payload.data) as unknown
  const info = (nested && typeof nested === 'object' ? nested : payload) as Record<string, unknown>
  const flat = payload as Record<string, unknown>
  const id = (v: unknown): string | null => (typeof v === 'string' && v.startsWith('ses') ? v : null)
  const sessionId =
    id(info.sessionID) ??
    id((info.info as Record<string, unknown> | undefined)?.sessionID) ??
    id(flat.sessionID) ??
    id((flat.info as Record<string, unknown> | undefined)?.sessionID) ??
    id(info.id) ??
    id((info.info as Record<string, unknown> | undefined)?.id) ??
    id(flat.id)

  return {
    type,
    // Handlers read the inner payload (permission, part, sessionID, …).
    data: info,
    sessionId,
    directory: typeof wrapper.directory === 'string' ? wrapper.directory : null,
    at: Date.now(),
  }
}

/**
 * Reads an SSE endpoint until the stream ends or the signal aborts.
 * Reconnection is the caller's job (see `startEventLoop`).
 */
export async function readEventStream(opts: {
  server: ServerEndpoint
  onEvent: (event: NormalizedEvent) => void
  /** Fires once the stream is established, before any event is delivered. */
  onConnected?: () => void
  signal?: AbortSignal
  /** Path defaults to the global stream, which carries every directory. */
  path?: string
}): Promise<void> {
  const url = `${opts.server.url.replace(/\/+$/, '')}${opts.path ?? '/global/event'}`
  const res = await fetch(url, { headers: headersFor(opts.server), signal: opts.signal })
  if (!res.ok || !res.body) throw new Error(`event stream refused (HTTP ${res.status})`)
  opts.onConnected?.()

  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  const drain = (): void => {
    let match = /\r?\n\r?\n/.exec(buffer)
    while (match) {
      const block = buffer.slice(0, match.index)
      buffer = buffer.slice(match.index + match[0].length)
      const event = parseSseBlock(block)
      if (event) opts.onEvent(event)
      match = /\r?\n\r?\n/.exec(buffer)
    }
  }
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      drain()
    }
    drain()
  } finally {
    reader.releaseLock()
  }
}

/**
 * Persistent auto-reconnecting subscription with capped backoff.
 * Resolves only when `signal` is aborted.
 */
export async function startEventLoop(opts: {
  server: ServerEndpoint
  onEvent: (event: NormalizedEvent) => void
  onError?: (err: unknown, attempt: number) => void
  /** Fires every time the loop (re)connects; `attempt` is the failed-attempt counter (0 before any error). */
  onConnected?: (attempt: number) => void
  signal: AbortSignal
  path?: string
}): Promise<void> {
  let attempt = 0
  while (!opts.signal.aborted) {
    try {
      await readEventStream({
        server: opts.server,
        onEvent: opts.onEvent,
        signal: opts.signal,
        path: opts.path,
        onConnected: () => opts.onConnected?.(attempt),
      })
      attempt = 0
    } catch (err) {
      if (opts.signal.aborted) return
      attempt++
      opts.onError?.(err, attempt)
      const delay = Math.min(30_000, 500 * 2 ** Math.min(attempt, 6))
      await new Promise((resolve) => setTimeout(resolve, delay))
    }
  }
}
