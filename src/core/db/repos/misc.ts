import { newId, now } from '../../kernel/ids'
import type { Db } from '../db'
import { j, num, nullableStr, str, type Row } from './helpers'

export interface Template {
  id: string
  name: string
  description: string
  body: Record<string, unknown>
}

export interface Notification {
  id: string
  kind: string
  title: string
  body: string
  severity: 'info' | 'warn' | 'error'
  jobId: string | null
  action: string | null
  readAt: number | null
  createdAt: number
}

export class MiscRepo {
  constructor(private readonly db: Db) {}

  /* templates --------------------------------------------------------------- */

  listTemplates(): Template[] {
    return this.db.all<Row>('SELECT * FROM templates ORDER BY name').map((r) => ({
      id: str(r.id),
      name: str(r.name),
      description: str(r.description),
      body: j(r.body, {}),
    }))
  }

  saveTemplate(input: Template): Template {
    const t = now()
    const id = input.id || newId('tpl')
    const existing = this.db.get<Row>('SELECT created_at FROM templates WHERE id = ?', id)
    this.db.run(
      `INSERT INTO templates (id, name, description, body, created_at, updated_at) VALUES (?,?,?,?,?,?)
       ON CONFLICT(id) DO UPDATE SET name=excluded.name, description=excluded.description, body=excluded.body, updated_at=excluded.updated_at`,
      id,
      input.name,
      input.description,
      JSON.stringify(input.body ?? {}),
      existing ? num(existing.created_at) : t,
      t,
    )
    return { ...input, id }
  }

  deleteTemplate(id: string): boolean {
    return this.db.run('DELETE FROM templates WHERE id = ?', id).changes > 0
  }

  /* notifications ------------------------------------------------------------ */

  listNotifications(unreadOnly = false): Notification[] {
    const where = unreadOnly ? 'WHERE read_at IS NULL' : ''
    return this.db
      .all<Row>(`SELECT * FROM notifications ${where} ORDER BY created_at DESC LIMIT 200`)
      .map((r) => ({
        id: str(r.id),
        kind: str(r.kind),
        title: str(r.title),
        body: str(r.body),
        severity: (str(r.severity) || 'info') as Notification['severity'],
        jobId: nullableStr(r.job_id),
        action: nullableStr(r.action),
        readAt: r.read_at === null || r.read_at === undefined ? null : num(r.read_at),
        createdAt: num(r.created_at),
      }))
  }

  notify(input: { kind: string; title: string; body?: string; severity?: Notification['severity']; jobId?: string | null; action?: string | null }): Notification {
    const n: Notification = {
      id: newId('ntf'),
      kind: input.kind,
      title: input.title,
      body: input.body ?? '',
      severity: input.severity ?? 'info',
      jobId: input.jobId ?? null,
      action: input.action ?? null,
      readAt: null,
      createdAt: now(),
    }
    this.db.run(
      'INSERT INTO notifications (id, kind, title, body, severity, job_id, action, read_at, created_at) VALUES (?,?,?,?,?,?,?,?,?)',
      n.id,
      n.kind,
      n.title,
      n.body,
      n.severity,
      n.jobId,
      n.action,
      null,
      n.createdAt,
    )
    return n
  }

  markNotificationsRead(ids?: string[]): number {
    if (ids?.length) {
      return this.db.run(`UPDATE notifications SET read_at = ? WHERE id IN (${ids.map(() => '?').join(',')})`, now(), ...ids).changes
    }
    return this.db.run('UPDATE notifications SET read_at = ? WHERE read_at IS NULL', now()).changes
  }

  unreadCount(): number {
    return num(this.db.get<Row>('SELECT COUNT(*) AS c FROM notifications WHERE read_at IS NULL')?.c)
  }
}
