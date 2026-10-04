import { AppError } from '../kernel/errors'

/** Everything needed to talk to one running `opencode serve` instance. */
export interface ServerEndpoint {
  url: string
  /** Basic-auth password injected as OPENCODE_SERVER_PASSWORD when spawned. */
  password?: string | null
  username?: string
  /** Workspace directory the server was started in (sends `directory` query). */
  directory?: string | null
  timeoutMs?: number
}

export interface OcSession {
  id: string
  title: string
  directory?: string
  parentID?: string | null
  projectID?: string | null
  time?: { created?: number; updated?: number }
}

export interface PromptOptions {
  text: string
  agent?: string | null
  model?: { providerID: string; modelID: string } | null
  system?: string | null
  tools?: Record<string, boolean> | null
  /** Fire-and-forget: returns immediately, progress arrives over SSE. */
  async?: boolean
  signal?: AbortSignal
}

export interface MessageInfo {
  id: string
  role: string
  sessionID?: string
  modelID?: string | null
  providerID?: string | null
  time?: { created?: number; completed?: number }
  tokens?: { input?: number; output?: number; reasoning?: number; cache?: { read?: number; write?: number } }
  cost?: number
  error?: { name?: string; data?: unknown } | null
}

/** Tool-call state carried under `part.state` by OpenCode ≥1.18 (`status: pending|running|completed|error`). */
export interface OcToolState {
  status?: string
  error?: string | { name?: string; data?: unknown }
  input?: Record<string, unknown>
  output?: unknown
  /** OpenCode keeps the real process result here even when status says "completed". */
  metadata?: { exit?: number; output?: string; truncated?: boolean; [key: string]: unknown }
}

export interface TranscriptMessage {
  info: MessageInfo
  parts: {
    id?: string
    type: string
    text?: string
    tool?: string
    status?: string
    state?: OcToolState
    time?: { start?: number; end?: number }
  }[]
}

/** Human-readable error text behind a failed tool call, or null. */
export function toolStateError(part: { state?: OcToolState; status?: string }): string | null {
  const raw = part.state?.error
  if (raw) {
    if (typeof raw === 'string') return raw
    const data = typeof raw.data === 'string' ? raw.data : raw.name ? raw.name : JSON.stringify(raw.data ?? raw)
    return String(data)
  }
  // A non-zero exit code is executor evidence even when OpenCode reports the
  // tool as "completed" (bash returning exit 1 is not a tool-level error).
  // Without this, a PowerShell parse error would surface as a green "completed".
  const meta = part.state?.metadata
  const exit = typeof meta?.exit === 'number' ? meta.exit : null
  if (exit === null || exit === 0) return null
  const out = typeof meta?.output === 'string' ? meta.output.trim().replace(/\s+/g, ' ') : ''
  return out ? `exit ${exit}: ${out.slice(0, 300)}` : `exit ${exit}`
}

/** Effective tool status: 1.18 keeps it under `state.status`, older builds on the part. */
export function toolPartStatus(part: { status?: string; state?: OcToolState }): string {
  return part.state?.status ?? part.status ?? 'unknown'
}

export interface OcPermission {
  id: string
  type: string
  pattern?: string
  title?: string
  sessionID?: string
  messageID?: string
  metadata?: Record<string, unknown>
}

export interface OcAgent {
  name: string
  mode: string
  description?: string | null
}

export interface DiffEntry {
  file?: string
  additions?: number
  deletions?: number
}

/** Thin typed client over one `opencode serve` endpoint. */
export class OpenCodeAdapter {
  constructor(private readonly server: ServerEndpoint) {}

  get url(): string {
    return this.server.url.replace(/\/+$/, '')
  }

  private headers(): Record<string, string> {
    const headers: Record<string, string> = { 'content-type': 'application/json', accept: 'application/json' }
    if (this.server.password) {
      const user = this.server.username ?? 'opencode'
      headers.authorization = `Basic ${Buffer.from(`${user}:${this.server.password}`).toString('base64')}`
    }
    return headers
  }

  private withDirectory(query?: Record<string, string | undefined>): string {
    const params = new URLSearchParams()
    if (this.server.directory) params.set('directory', this.server.directory)
    for (const [k, v] of Object.entries(query ?? {})) if (v) params.set(k, v)
    const qs = params.toString()
    return qs ? `?${qs}` : ''
  }

  private async request<T>(method: 'GET' | 'POST' | 'DELETE', path: string, body?: unknown, query?: Record<string, string | undefined>, signal?: AbortSignal): Promise<T> {
    const timeoutMs = this.server.timeoutMs ?? 30_000
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    const onAbort = () => controller.abort()
    signal?.addEventListener('abort', onAbort, { once: true })
    try {
      const res = await fetch(`${this.url}${path}${this.withDirectory(query)}`, {
        method,
        headers: this.headers(),
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: controller.signal,
      })
      const text = await res.text()
      if (!res.ok) {
        if (res.status === 401 || res.status === 403) throw new AppError('permission_denied', `opencode rejected auth (HTTP ${res.status})`)
        if (res.status === 404) throw new AppError('not_found', `opencode endpoint not found: ${path}`)
        throw new AppError('opencode_error', `opencode ${method} ${path} failed (HTTP ${res.status})`, { details: { body: text.slice(0, 300) } })
      }
      if (!text) return undefined as T
      try {
        return JSON.parse(text) as T
      } catch {
        return text as unknown as T
      }
    } catch (err) {
      if (err instanceof AppError) throw err
      if ((err as Error).name === 'AbortError') throw new AppError('timeout', `opencode ${method} ${path} timed out`)
      throw new AppError('opencode_error', `opencode unreachable at ${this.url}: ${(err as Error).message}`, { cause: err })
    } finally {
      clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
    }
  }

  /* ------------------------------------------------------------- lifecycle */

  async health(): Promise<boolean> {
    try {
      await this.request<unknown>('GET', '/global/health')
      return true
    } catch {
      return false
    }
  }

  async version(): Promise<string | null> {
    try {
      const cfg = await this.request<Record<string, unknown>>('GET', '/config')
      const meta = (cfg.meta ?? {}) as Record<string, unknown>
      return typeof meta.version === 'string' ? meta.version : null
    } catch {
      return null
    }
  }

  /* -------------------------------------------------------------- sessions */

  async createSession(opts: { title?: string; parentID?: string | null; agent?: string | null } = {}): Promise<OcSession> {
    const body: Record<string, unknown> = {}
    if (opts.title) body.title = opts.title
    if (opts.parentID) body.parentID = opts.parentID
    if (opts.agent) body.agent = opts.agent
    return this.request<OcSession>('POST', '/session', body)
  }

  async listSessions(): Promise<OcSession[]> {
    const res = await this.request<OcSession[] | { sessions?: OcSession[] }>('GET', '/session')
    return Array.isArray(res) ? res : (res.sessions ?? [])
  }

  async children(sessionId: string): Promise<OcSession[]> {
    const res = await this.request<OcSession[] | { sessions?: OcSession[] }>('GET', `/session/${encodeURIComponent(sessionId)}/children`)
    return Array.isArray(res) ? res : (res.sessions ?? [])
  }

  async abortSession(sessionId: string): Promise<boolean> {
    const res = await this.request<boolean>('POST', `/session/${encodeURIComponent(sessionId)}/abort`)
    return res === true
  }

  /* --------------------------------------------------------------- prompting */

  async prompt(sessionId: string, opts: PromptOptions): Promise<TranscriptMessage> {
    const body = this.promptBody(opts)
    if (opts.async) {
      await this.request<void>('POST', `/session/${encodeURIComponent(sessionId)}/prompt_async`, body, undefined, opts.signal)
      return { info: { id: '', role: 'assistant' }, parts: [] }
    }
    return this.request<TranscriptMessage>('POST', `/session/${encodeURIComponent(sessionId)}/message`, body, undefined, opts.signal)
  }

  private promptBody(opts: PromptOptions): Record<string, unknown> {
    const body: Record<string, unknown> = {
      parts: [{ type: 'text', text: opts.text }],
    }
    if (opts.agent) body.agent = opts.agent
    if (opts.system) body.system = opts.system
    if (opts.model) body.model = { providerID: opts.model.providerID, modelID: opts.model.modelID }
    if (opts.tools) body.tools = opts.tools
    return body
  }

  async messages(sessionId: string, limit = 200): Promise<TranscriptMessage[]> {
    const res = await this.request<TranscriptMessage[] | { messages?: TranscriptMessage[] }>('GET', `/session/${encodeURIComponent(sessionId)}/message`, undefined, {
      limit: String(limit),
    })
    if (Array.isArray(res)) return res
    const list = res.messages ?? []
    // Some versions return {info, parts} pairs; normalize into our shape.
    return list.map((m) => (m.info ? m : ({ info: m as unknown as MessageInfo, parts: [] } as TranscriptMessage)))
  }

  async diff(sessionId: string): Promise<DiffEntry[]> {
    const res = await this.request<DiffEntry[]>('GET', `/session/${encodeURIComponent(sessionId)}/diff`)
    return Array.isArray(res) ? res : []
  }

  /* ----------------------------------------------------------- permissions */

  async listPermissions(): Promise<OcPermission[]> {
    const res = await this.request<OcPermission[] | { permissions?: OcPermission[] }>('GET', '/permission')
    return Array.isArray(res) ? res : (res.permissions ?? [])
  }

  async replyPermission(requestId: string, reply: 'once' | 'always' | 'reject', message?: string): Promise<boolean> {
    const res = await this.request<boolean>('POST', `/permission/${encodeURIComponent(requestId)}/reply`, {
      reply,
      ...(message ? { message } : {}),
    })
    return res === true
  }

  /* ----------------------------------------------------------------- misc */

  async agents(): Promise<OcAgent[]> {
    const res = await this.request<OcAgent[] | { agents?: OcAgent[] }>('GET', '/agent')
    return Array.isArray(res) ? res : (res.agents ?? [])
  }

  async status(): Promise<Record<string, unknown>> {
    return this.request<Record<string, unknown>>('GET', '/session/status')
  }
}
