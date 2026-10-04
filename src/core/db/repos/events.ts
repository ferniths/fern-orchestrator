import type { AppEvent } from '@shared/domain'
import type { TimelineEntry } from '@shared/ipc'
import type { Db } from '../db'
import { j, num, nullableStr, str, type Row } from './helpers'

function toTimeline(row: Row): TimelineEntry {
  return {
    seq: num(row.seq),
    type: str(row.type),
    severity: str(row.severity) as TimelineEntry['severity'],
    at: num(row.ts),
    message: str(row.message),
    jobId: nullableStr(row.job_id),
    workerId: nullableStr(row.worker_id),
    taskId: nullableStr(row.task_id),
    data: j(row.data, {}),
  }
}

/**
 * Persistent copy of the event bus (bounded by age/size in `prune`).
 * The in-memory bus feeds this table; the UI reads history from here and
 * live events from the SSE bridge.
 */
export class EventRepo {
  constructor(
    private readonly db: Db,
    private readonly retainMs = 14 * 24 * 60 * 60 * 1000,
  ) {}

  append(event: AppEvent): void {
    this.db.run(
      'INSERT INTO events (ts, type, severity, job_id, worker_id, task_id, project_id, message, data) VALUES (?,?,?,?,?,?,?,?,?)',
      event.at,
      event.type,
      event.severity,
      event.jobId,
      event.workerId,
      event.taskId,
      event.projectId,
      event.message,
      JSON.stringify(event.data ?? {}),
    )
  }

  /** Batched write used by the bus subscriber to keep the hot path cheap. */
  appendMany(events: AppEvent[]): void {
    if (events.length === 0) return
    this.db.tx(() => {
      for (const e of events) this.append(e)
    })
  }

  list(filter: { jobId?: string; severity?: string[]; type?: string[]; limit?: number; after?: number } = {}): TimelineEntry[] {
    const clauses: string[] = []
    const params: unknown[] = []
    if (filter.jobId) {
      clauses.push('job_id = ?')
      params.push(filter.jobId)
    }
    if (filter.severity?.length) {
      clauses.push(`severity IN (${filter.severity.map(() => '?').join(',')})`)
      params.push(...filter.severity)
    }
    if (filter.type?.length) {
      clauses.push(`type IN (${filter.type.map(() => '?').join(',')})`)
      params.push(...filter.type)
    }
    if (filter.after) {
      clauses.push('seq > ?')
      params.push(filter.after)
    }
    const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : ''
    params.push(filter.limit ?? 500)
    return this.db.all<Row>(`SELECT * FROM events ${where} ORDER BY seq DESC LIMIT ?`, ...params).map(toTimeline)
  }

  count(): number {
    return num(this.db.get<Row>('SELECT COUNT(*) AS c FROM events')?.c)
  }

  prune(): number {
    return this.db.run('DELETE FROM events WHERE ts < ?', Date.now() - this.retainMs).changes
  }
}
