import { appendFile, mkdir, readdir, unlink } from 'node:fs/promises'
import { join } from 'node:path'

export type LogLevel = 'debug' | 'info' | 'warn' | 'error'
export type LogChannel =
  | 'app'
  | 'kernel'
  | 'db'
  | 'ipc'
  | 'orchestration'
  | 'worker'
  | 'opencode'
  | 'provider'
  | 'git'
  | 'obsidian'
  | 'notify'

export interface LogRecord {
  ts: number
  level: LogLevel
  channel: LogChannel
  message: string
  data?: Record<string, unknown>
  jobId?: string
  workerId?: string
}

const LEVEL_ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 }

const SENSITIVE_KEY = /(api[-_]?key|authorization|secret|password|passwd|token|credential|private[-_]?key|bearer)/i
const SENSITIVE_VALUE = /\b(sk|sess|ghp|gho|xox[bap])[-_][A-Za-z0-9_-]{8,}|\bBearer\s+[A-Za-z0-9._-]{16,}/g

/** Deep-clone with secrets removed. Never let a key reach disk or the UI. */
export function redact(value: unknown, depth = 0): unknown {
  if (depth > 8) return '[deep]'
  if (value == null) return value
  if (typeof value === 'string') return value.replace(SENSITIVE_VALUE, '[redacted]')
  if (typeof value !== 'object') return value
  if (Array.isArray(value)) return value.map((v) => redact(v, depth + 1))
  if (value instanceof Error) return { name: value.name, message: redact(value.message) }
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    out[k] = SENSITIVE_KEY.test(k) ? '[redacted]' : redact(v, depth + 1)
  }
  return out
}

export interface LoggerOptions {
  dir: string | null
  level: LogLevel
  /** Keep this many records in memory for the in-app log monitor. */
  ringSize?: number
  console?: boolean
}

export class Logger {
  private readonly dir: string | null
  private readonly ring: LogRecord[]
  private readonly ringSize: number
  private readonly printToConsole: boolean
  private level: LogLevel
  private writeChain: Promise<void> = Promise.resolve()
  private ensured = false
  private listeners = new Set<(r: LogRecord) => void>()

  constructor(
    private readonly opts: LoggerOptions,
    private readonly channel: LogChannel = 'app',
  ) {
    this.dir = opts.dir
    this.level = opts.level
    this.ringSize = opts.ringSize ?? 2000
    this.ring = []
    this.printToConsole = opts.console ?? true
  }

  child(channel: LogChannel): Logger {
    const c = new Logger(this.opts, channel)
    c.level = this.level
    // children share the parent's ring + listeners so queries see everything
    Object.assign(c, { ring: this.ring, ringSize: this.ringSize, listeners: this.listeners })
    return c
  }

  setLevel(level: LogLevel): void {
    this.level = level
  }

  getLevel(): LogLevel {
    return this.level
  }

  onRecord(listener: (r: LogRecord) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  query(filter: { level?: LogLevel; channels?: LogChannel[]; contains?: string; limit?: number } = {}): LogRecord[] {
    const min = filter.level ? LEVEL_ORDER[filter.level] : 0
    let out = this.ring.filter((r) => LEVEL_ORDER[r.level] >= min)
    if (filter.channels?.length) out = out.filter((r) => filter.channels!.includes(r.channel))
    if (filter.contains) {
      const needle = filter.contains.toLowerCase()
      out = out.filter((r) => r.message.toLowerCase().includes(needle) || JSON.stringify(r.data ?? {}).toLowerCase().includes(needle))
    }
    return out.slice(-(filter.limit ?? 500))
  }

  debug(message: string, data?: Record<string, unknown>): void {
    this.write('debug', message, data)
  }
  info(message: string, data?: Record<string, unknown>): void {
    this.write('info', message, data)
  }
  warn(message: string, data?: Record<string, unknown>): void {
    this.write('warn', message, data)
  }
  error(message: string, data?: Record<string, unknown>): void {
    this.write('error', message, data)
  }

  private write(level: LogLevel, message: string, data?: Record<string, unknown>): void {
    if (LEVEL_ORDER[level] < LEVEL_ORDER[this.level]) return
    const record: LogRecord = {
      ts: Date.now(),
      level,
      channel: this.channel,
      message,
      ...(data ? { data: redact(data) as Record<string, unknown> } : {}),
    }
    this.ring.push(record)
    if (this.ring.length > this.ringSize) this.ring.splice(0, this.ring.length - this.ringSize)

    if (this.printToConsole) {
      const line = `[${new Date(record.ts).toISOString()}] ${level.toUpperCase().padEnd(5)} ${this.channel}: ${message}`
      if (level === 'error') console.error(line, record.data ?? '')
      else if (level === 'warn') console.warn(line, record.data ?? '')
      else if (level !== 'debug') console.log(line, record.data ?? '')
    }

    for (const l of this.listeners) {
      try {
        l(record)
      } catch {
        /* listener errors must never break logging */
      }
    }
    this.persist(record)
  }

  private persist(record: LogRecord): void {
    if (!this.dir) return
    const day = new Date(record.ts).toISOString().slice(0, 10)
    const file = join(this.dir, `${day}.jsonl`)
    const line = JSON.stringify(record) + '\n'
    this.writeChain = this.writeChain
      .then(async () => {
        if (!this.ensured) {
          await mkdir(this.dir!, { recursive: true })
          this.ensured = true
        }
        await appendFile(file, line, 'utf8')
      })
      .catch(() => {
        /* disk failures must not take the app down */
      })
  }

  async flush(): Promise<void> {
    await this.writeChain
  }

  /**
   * Deletes `YYYY-MM-DD.jsonl` files older than `days`. Honours
   * `diagnostics.retainLogDays`; runs once at boot and whenever that setting
   * changes so the log directory cannot grow without bound.
   */
  async pruneOldLogs(days: number): Promise<number> {
    if (!this.dir || !Number.isFinite(days) || days < 1) return 0
    try {
      const cutoff = Date.now() - days * 86_400_000
      let removed = 0
      for (const name of await readdir(this.dir)) {
        const m = name.match(/^(\d{4}-\d{2}-\d{2})\.jsonl$/)
        if (!m) continue
        const day = Date.parse(`${m[1]}T00:00:00.000Z`)
        if (Number.isFinite(day) && day < cutoff) {
          await unlink(`${this.dir}/${name}`).catch(() => undefined)
          removed++
        }
      }
      if (removed > 0) this.info('pruned old log files', { removed, retainDays: days })
      return removed
    } catch {
      return 0
    }
  }
}
