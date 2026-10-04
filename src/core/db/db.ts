import Database from 'better-sqlite3'
import type { Database as SqliteDatabase } from 'better-sqlite3'
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { AppError } from '../kernel/errors'
import { migrations } from './migrations'

export type { Database } from 'better-sqlite3'

export interface DbOptions {
  readonly?: boolean
  verbose?: (message?: unknown, ...args: unknown[]) => void
}

/** Parse a JSON column defensively — a corrupt row must not crash a query. */
export function readJson<T>(raw: string | null | undefined, fallback: T): T {
  if (!raw) return fallback
  try {
    return JSON.parse(raw) as T
  } catch {
    return fallback
  }
}

export function writeJson(value: unknown): string {
  if (value === undefined || value === null) return 'null'
  try {
    return JSON.stringify(value)
  } catch {
    return 'null'
  }
}

export class Db {
  readonly raw: SqliteDatabase
  private closed = false

  constructor(
    readonly path: string,
    options: DbOptions = {},
  ) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true })
    try {
      this.raw = new Database(path, {
        readonly: options.readonly ?? false,
        ...(options.verbose ? { verbose: options.verbose } : {}),
      })
    } catch (err) {
      throw new AppError('internal', `cannot open database at ${path}`, { cause: err })
    }
    this.raw.pragma('journal_mode = WAL')
    this.raw.pragma('foreign_keys = ON')
    this.raw.pragma('busy_timeout = 5000')
    this.raw.pragma('synchronous = NORMAL')
    this.raw.pragma('temp_store = MEMORY')
    this.migrate()
  }

  private migrate(): void {
    const target = migrations.reduce((max, m) => Math.max(max, m.version), 0)
    const current = Number(this.raw.pragma('user_version', { simple: true }))
    if (current >= target) return

    for (const migration of migrations) {
      if (migration.version <= current) continue
      const run = this.raw.transaction(() => {
        this.raw.exec(migration.sql)
        this.raw.pragma(`user_version = ${migration.version}`)
      })
      try {
        run()
      } catch (err) {
        throw new AppError('internal', `migration ${migration.version} (${migration.name}) failed`, { cause: err })
      }
    }
  }

  get schemaVersion(): number {
    return Number(this.raw.pragma('user_version', { simple: true }))
  }

  get<T = unknown>(sql: string, ...params: unknown[]): T | undefined {
    return this.raw.prepare(sql).get(...(params as never[])) as T | undefined
  }

  all<T = unknown>(sql: string, ...params: unknown[]): T[] {
    return this.raw.prepare(sql).all(...(params as never[])) as T[]
  }

  run(sql: string, ...params: unknown[]): { changes: number; lastInsertRowid: number | bigint } {
    const info = this.raw.prepare(sql).run(...(params as never[]))
    return { changes: info.changes, lastInsertRowid: info.lastInsertRowid }
  }

  exec(sql: string): void {
    this.raw.exec(sql)
  }

  tx<T>(fn: () => T): T {
    return this.raw.transaction(fn)()
  }

  pragma<T = unknown>(text: string, simple = true): T {
    return this.raw.pragma(text, { simple }) as T
  }

  /** Integrity check used by the Health screen / diagnostics export. */
  integrity(): { ok: boolean; details: string } {
    const rows = this.raw.pragma('integrity_check') as { integrity_check: string }[]
    const details = rows.map((r) => r.integrity_check).join('; ')
    return { ok: details === 'ok', details }
  }

  close(): void {
    if (this.closed) return
    this.closed = true
    try {
      this.raw.close()
    } catch {
      /* already closed */
    }
  }

  get isClosed(): boolean {
    return this.closed
  }
}
