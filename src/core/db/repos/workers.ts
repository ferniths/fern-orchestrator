import type { Approval, Artifact, UsageRecord, Worker, WorkerSession } from '@shared/domain'
import { approvalSchema, artifactSchema, usageRecordSchema, workerSchema, workerSessionSchema } from '@shared/domain'
import { newId, now } from '../../kernel/ids'
import type { Db } from '../db'
import { j, num, nullableNum, str, type Row } from './helpers'

function toWorker(row: Row): Worker {
  return workerSchema.parse({
    id: row.id,
    jobId: row.job_id,
    loopIndex: num(row.loop_index),
    taskId: row.task_id,
    name: row.name,
    role: row.role,
    objective: row.objective,
    systemPrompt: row.system_prompt,
    taskPrompt: row.task_prompt,
    modelId: row.model_id,
    providerId: row.provider_id,
    opencodeAgent: row.opencode_agent,
    profileId: row.profile_id,
    workspacePath: row.workspace_path,
    projectId: row.project_id,
    parentWorkerId: row.parent_worker_id,
    parentSessionId: row.parent_session_id,
    sessionId: row.session_id,
    depth: num(row.depth),
    status: row.status,
    attempt: num(row.attempt),
    timeoutMs: num(row.timeout_ms),
    statusReason: row.status_reason,
    filesTouched: j(row.files_touched, []),
    artifacts: j(row.artifacts, []),
    usage: j(row.usage, {}),
    queuedAt: nullableNum(row.queued_at),
    startedAt: nullableNum(row.started_at),
    completedAt: nullableNum(row.completed_at),
    error: row.error,
    createdAt: num(row.created_at),
    updatedAt: num(row.updated_at) || num(row.created_at),
  })
}

function toSession(row: Row): WorkerSession {
  return workerSessionSchema.parse({
    id: row.session_id,
    workerId: row.worker_id ? str(row.worker_id) : null,
    sessionId: row.session_id,
    serverId: str(row.server_id),
    parentSessionId: row.parent_session_id,
    jobId: row.job_id,
    projectId: row.project_id,
    title: row.title,
    directory: row.directory,
    modelId: row.model_id,
    providerId: row.provider_id,
    opencodeAgent: row.opencode_agent,
    depth: num(row.depth),
    status: row.status,
    summary: row.summary,
    diffStats: j(row.diff_stats, {}),
    lastEventAt: nullableNum(row.last_event_at),
    createdAt: num(row.created_at),
    updatedAt: num(row.updated_at),
  })
}

function toApproval(row: Row): Approval {
  return approvalSchema.parse({
    id: row.id,
    jobId: row.job_id,
    kind: row.kind,
    title: row.title,
    detail: row.detail,
    status: row.status,
    opencodePermissionId: row.opencode_permission_id,
    sessionId: row.session_id,
    workerId: row.worker_id,
    payload: j(row.payload, {}),
    decidedAt: nullableNum(row.decided_at),
    decisionNote: row.decision_note,
    expiresAt: nullableNum(row.expires_at),
    createdAt: num(row.created_at),
    updatedAt: num(row.updated_at),
  })
}

function toArtifact(row: Row): Artifact {
  return artifactSchema.parse({
    id: row.id,
    jobId: row.job_id,
    loopIndex: num(row.loop_index),
    taskId: row.task_id,
    workerId: row.worker_id,
    sessionId: row.session_id,
    kind: row.kind,
    name: row.name,
    path: row.path,
    content: row.content,
    mimeType: row.mime_type,
    bytes: num(row.bytes),
    checksum: row.checksum,
    status: row.status,
    metadata: j(row.metadata, {}),
    createdAt: num(row.created_at),
    updatedAt: num(row.updated_at),
  })
}

function toUsage(row: Row): UsageRecord {
  return usageRecordSchema.parse({
    id: row.id,
    jobId: row.job_id,
    loopIndex: nullableNum(row.loop_index),
    taskId: row.task_id,
    workerId: row.worker_id,
    providerId: row.provider_id,
    modelId: row.model_id,
    inputTokens: num(row.input_tokens),
    outputTokens: num(row.output_tokens),
    cacheReadTokens: num(row.cache_read_tokens),
    costUsd: num(row.cost_usd),
    latencyMs: num(row.latency_ms),
    requestId: row.request_id,
    source: row.source,
    at: num(row.at),
    createdAt: num(row.created_at),
    updatedAt: num(row.updated_at),
  })
}

export class WorkerRepo {
  constructor(private readonly db: Db) {}

  listUsage(jobId?: string): UsageRecord[] {
    const rows = jobId
      ? this.db.all<Row>('SELECT * FROM usage_records WHERE job_id = ? ORDER BY at', jobId)
      : this.db.all<Row>('SELECT * FROM usage_records ORDER BY at')
    return rows.map(toUsage)
  }

  /* workers ---------------------------------------------------------------- */

  listWorkers(jobId: string): Worker[] {
    return this.db.all<Row>('SELECT * FROM workers WHERE job_id = ? ORDER BY created_at', jobId).map(toWorker)
  }

  getWorker(id: string): Worker | null {
    const row = this.db.get<Row>('SELECT * FROM workers WHERE id = ?', id)
    return row ? toWorker(row) : null
  }

  children(workerId: string): Worker[] {
    return this.db.all<Row>('SELECT * FROM workers WHERE parent_worker_id = ? ORDER BY created_at', workerId).map(toWorker)
  }

  createWorker(input: Partial<Worker> & { jobId: string; taskId: string; name: string }): Worker {
    const t = now()
    const worker = workerSchema.parse({
      queuedAt: t,
      ...input,
      id: newId('wrk'),
      createdAt: t,
      updatedAt: t,
    })
    this.db.run(
       `INSERT INTO workers (id, job_id, loop_index, task_id, name, role, objective, system_prompt, task_prompt, model_id, provider_id, opencode_agent, profile_id, workspace_path, project_id, parent_worker_id, parent_session_id, session_id, server_id, depth, status, status_reason, attempt, timeout_ms, files_touched, artifacts, usage, error, created_at, queued_at, started_at, completed_at, updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      worker.id,
      worker.jobId,
      worker.loopIndex,
      worker.taskId,
      worker.name,
      worker.role,
      worker.objective,
      worker.systemPrompt,
      worker.taskPrompt,
      worker.modelId,
      worker.providerId,
      worker.opencodeAgent,
      worker.profileId,
      worker.workspacePath,
      worker.projectId,
      worker.parentWorkerId,
      worker.parentSessionId,
      worker.sessionId,
      null,
      worker.depth,
      worker.status,
      worker.statusReason,
      worker.attempt,
      worker.timeoutMs,
      JSON.stringify(worker.filesTouched),
      JSON.stringify(worker.artifacts),
      JSON.stringify(worker.usage),
      worker.error,
      worker.createdAt,
      worker.queuedAt,
      worker.startedAt,
      worker.completedAt,
      worker.updatedAt,
    )
    return worker
  }

  updateWorker(id: string, patch: Partial<Worker>): Worker {
    const current = this.getWorker(id)
    if (!current) throw new Error(`worker not found: ${id}`)
    const next = workerSchema.parse({ ...current, ...patch, id, jobId: current.jobId, updatedAt: now() })
    this.db.run(
      `UPDATE workers SET loop_index=?, name=?, role=?, objective=?, system_prompt=?, task_prompt=?, model_id=?, provider_id=?, opencode_agent=?, profile_id=?, workspace_path=?, project_id=?, parent_worker_id=?, parent_session_id=?, session_id=?, depth=?, status=?, status_reason=?, attempt=?, timeout_ms=?, files_touched=?, artifacts=?, usage=?, error=?, queued_at=?, started_at=?, completed_at=?, updated_at=? WHERE id=?`,
      next.loopIndex,
      next.name,
      next.role,
      next.objective,
      next.systemPrompt,
      next.taskPrompt,
      next.modelId,
      next.providerId,
      next.opencodeAgent,
      next.profileId,
      next.workspacePath,
      next.projectId,
      next.parentWorkerId,
      next.parentSessionId,
      next.sessionId,
      next.depth,
      next.status,
      next.statusReason,
      next.attempt,
      next.timeoutMs,
      JSON.stringify(next.filesTouched),
      JSON.stringify(next.artifacts),
      JSON.stringify(next.usage),
      next.error,
      next.queuedAt,
      next.startedAt,
      next.completedAt,
      next.updatedAt,
      id,
    )
    return next
  }

  countByStatus(jobId?: string): { running: number; queued: number; completed: number; failed: number } {
    const rows = jobId
      ? this.db.all<Row>('SELECT status, COUNT(*) AS c FROM workers WHERE job_id = ? GROUP BY status', jobId)
      : this.db.all<Row>('SELECT status, COUNT(*) AS c FROM workers GROUP BY status')
    const map = new Map(rows.map((r) => [str(r.status), num(r.c)]))
    const sum = (...keys: string[]) => keys.reduce((acc, k) => acc + (map.get(k) ?? 0), 0)
    return {
      running: sum('starting', 'running', 'waiting_approval'),
      queued: map.get('queued') ?? 0,
      completed: map.get('succeeded') ?? 0,
      failed: sum('failed', 'timed_out', 'orphaned'),
    }
  }

  activeCount(jobId: string): number {
    return num(
      this.db.get<Row>(
        "SELECT COUNT(*) AS c FROM workers WHERE job_id = ? AND status IN ('queued','starting','running','waiting_approval')",
        jobId,
      )?.c,
    )
  }

  /* sessions --------------------------------------------------------------- */

  upsertSession(input: Omit<WorkerSession, 'id' | 'createdAt' | 'updatedAt'> & { id?: string }): WorkerSession {
    const t = now()
    const sessionId = input.sessionId
    const existing = this.db.get<Row>('SELECT created_at FROM sessions WHERE session_id = ?', sessionId)
    this.db.run(
      `INSERT INTO sessions (session_id, worker_id, server_id, parent_session_id, job_id, project_id, title, directory, model_id, provider_id, opencode_agent, depth, status, summary, diff_stats, last_event_at, created_at, updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
       ON CONFLICT(session_id) DO UPDATE SET worker_id=excluded.worker_id, server_id=excluded.server_id,
         parent_session_id=excluded.parent_session_id, job_id=excluded.job_id, project_id=excluded.project_id,
         title=excluded.title, directory=excluded.directory, model_id=excluded.model_id, provider_id=excluded.provider_id,
         opencode_agent=excluded.opencode_agent, depth=excluded.depth, status=excluded.status, summary=excluded.summary,
         diff_stats=excluded.diff_stats, last_event_at=excluded.last_event_at, updated_at=excluded.updated_at`,
      sessionId,
      input.workerId,
      input.serverId,
      input.parentSessionId,
      input.jobId,
      input.projectId,
      input.title,
      input.directory,
      input.modelId,
      input.providerId,
      input.opencodeAgent,
      input.depth,
      input.status,
      input.summary,
      JSON.stringify(input.diffStats),
      input.lastEventAt,
      existing ? num(existing.created_at) : t,
      t,
    )
    return workerSessionSchema.parse({ ...input, id: sessionId, createdAt: existing ? num(existing.created_at) : t, updatedAt: t })
  }

  listSessions(jobId: string): WorkerSession[] {
    return this.db.all<Row>('SELECT * FROM sessions WHERE job_id = ? ORDER BY created_at', jobId).map(toSession)
  }

  getSession(sessionId: string): WorkerSession | null {
    const row = this.db.get<Row>('SELECT * FROM sessions WHERE session_id = ?', sessionId)
    return row ? toSession(row) : null
  }

  updateSessionStatus(sessionId: string, status: WorkerSession['status'], summary?: string): void {
    this.db.run(
      'UPDATE sessions SET status = ?, summary = COALESCE(?, summary), last_event_at = ?, updated_at = ? WHERE session_id = ?',
      status,
      summary ?? null,
      now(),
      now(),
      sessionId,
    )
  }

  /** Touch `last_event_at` when an SSE event arrives for the session. */
  upsertSessionLastEvent(sessionId: string): void {
    this.db.run('UPDATE sessions SET last_event_at = ?, updated_at = ? WHERE session_id = ?', now(), now(), sessionId)
  }

  /* artifacts -------------------------------------------------------------- */

  listArtifacts(jobId: string): Artifact[] {
    return this.db.all<Row>('SELECT * FROM artifacts WHERE job_id = ? ORDER BY created_at DESC', jobId).map(toArtifact)
  }

  getArtifact(id: string): Artifact | null {
    const row = this.db.get<Row>('SELECT * FROM artifacts WHERE id = ?', id)
    return row ? toArtifact(row) : null
  }

  createArtifact(input: Partial<Artifact> & { jobId: string; name: string }): Artifact {
    const t = now()
    const artifact = artifactSchema.parse({ ...input, id: newId('art'), createdAt: t, updatedAt: t })
    this.db.run(
      `INSERT INTO artifacts (id, job_id, loop_index, task_id, worker_id, session_id, kind, name, path, content, mime_type, bytes, checksum, status, metadata, created_at, updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      artifact.id,
      artifact.jobId,
      artifact.loopIndex,
      artifact.taskId,
      artifact.workerId,
      artifact.sessionId,
      artifact.kind,
      artifact.name,
      artifact.path,
      artifact.content,
      artifact.mimeType,
      artifact.bytes,
      artifact.checksum,
      artifact.status,
      JSON.stringify(artifact.metadata),
      artifact.createdAt,
      artifact.updatedAt,
    )
    return artifact
  }

  artifactCount(jobId?: string): number {
    const row = jobId
      ? this.db.get<Row>('SELECT COUNT(*) AS c FROM artifacts WHERE job_id = ?', jobId)
      : this.db.get<Row>('SELECT COUNT(*) AS c FROM artifacts')
    return num(row?.c)
  }

  /* approvals --------------------------------------------------------------- */

  listApprovals(status: 'pending' | 'all' = 'pending'): Approval[] {
    const rows =
      status === 'all'
        ? this.db.all<Row>('SELECT * FROM approvals ORDER BY created_at DESC LIMIT 500')
        : this.db.all<Row>("SELECT * FROM approvals WHERE status = 'pending' ORDER BY created_at")
    return rows.map(toApproval)
  }

  getApproval(id: string): Approval | null {
    const row = this.db.get<Row>('SELECT * FROM approvals WHERE id = ?', id)
    return row ? toApproval(row) : null
  }

  getApprovalByPermission(permissionId: string): Approval | null {
    const row = this.db.get<Row>('SELECT * FROM approvals WHERE opencode_permission_id = ?', permissionId)
    return row ? toApproval(row) : null
  }

  createApproval(
    input: Partial<Approval> & { kind: Approval['kind']; title: string },
    extra: { diff?: string } = {},
  ): Approval {
    const t = now()
    const approval = approvalSchema.parse({ status: 'pending', ...input, id: newId('apr'), createdAt: t, updatedAt: t })
    this.db.run(
      `INSERT INTO approvals (id, job_id, kind, title, detail, status, opencode_permission_id, session_id, worker_id, payload, diff, decided_at, decision_note, expires_at, created_at, updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      approval.id,
      approval.jobId,
      approval.kind,
      approval.title,
      approval.detail,
      approval.status,
      approval.opencodePermissionId,
      approval.sessionId,
      approval.workerId,
      JSON.stringify(approval.payload),
      extra.diff ?? '',
      approval.decidedAt,
      approval.decisionNote,
      approval.expiresAt,
      approval.createdAt,
      approval.updatedAt,
    )
    return approval
  }

  decideApproval(id: string, approve: boolean, note?: string): Approval {
    const current = this.getApproval(id)
    if (!current) throw new Error(`approval not found: ${id}`)
    const next = approvalSchema.parse({
      ...current,
      status: approve ? 'approved' : 'denied',
      decidedAt: now(),
      decisionNote: note ?? null,
      updatedAt: now(),
    })
    this.db.run(
      'UPDATE approvals SET status = ?, decided_at = ?, decision_note = ?, updated_at = ? WHERE id = ?',
      next.status,
      next.decidedAt,
      next.decisionNote,
      next.updatedAt,
      id,
    )
    return next
  }

  getApprovalDiff(id: string): string {
    return str(this.db.get<Row>('SELECT diff FROM approvals WHERE id = ?', id)?.diff)
  }

  /** Persists a computed diff so the reviewer still sees it after the workspace is cleaned up. */
  setApprovalDiff(id: string, diff: string): void {
    this.db.run('UPDATE approvals SET diff = ? WHERE id = ?', diff, id)
  }

  /** Pending approvals whose deadline has passed (the sweep turns these `expired`). */
  listExpiredApprovals(at = Date.now()): Approval[] {
    const rows = this.db.all<Row>(
      "SELECT * FROM approvals WHERE status = 'pending' AND expires_at IS NOT NULL AND expires_at <= ? ORDER BY created_at",
      at,
    )
    return rows.map(toApproval)
  }

  /**
   * Mark a still-pending approval expired. Returns null when someone already
   * decided it, so a sweep cannot overwrite a click in the UI.
   */
  expireApproval(id: string, note: string): Approval | null {
    const current = this.getApproval(id)
    if (!current || current.status !== 'pending') return null
    const t = now()
    const next = approvalSchema.parse({
      ...current,
      status: 'expired',
      decidedAt: t,
      decisionNote: note,
      updatedAt: t,
    })
    this.db.run(
      "UPDATE approvals SET status = 'expired', decided_at = ?, decision_note = ?, updated_at = ? WHERE id = ? AND status = 'pending'",
      next.decidedAt,
      next.decisionNote,
      next.updatedAt,
      id,
    )
    return next
  }

  /* usage ------------------------------------------------------------------- */

  recordUsage(input: Partial<UsageRecord> & { modelId: string }): UsageRecord {
    const t = now()
    const rec = usageRecordSchema.parse({ providerId: '', at: t, ...input, id: newId('usg'), createdAt: t, updatedAt: t })
    this.db.run(
      `INSERT INTO usage_records (id, job_id, loop_index, task_id, worker_id, provider_id, model_id, input_tokens, output_tokens, cache_read_tokens, cost_usd, latency_ms, request_id, source, at, created_at, updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      rec.id,
      rec.jobId,
      rec.loopIndex,
      rec.taskId,
      rec.workerId,
      rec.providerId,
      rec.modelId,
      rec.inputTokens,
      rec.outputTokens,
      rec.cacheReadTokens,
      rec.costUsd,
      rec.latencyMs,
      rec.requestId,
      rec.source,
      rec.at,
      rec.createdAt,
      rec.updatedAt,
    )
    return rec
  }

  usageByJob(jobId?: string): {
    byModel: { modelId: string; providerId: string; input: number; output: number; cost: number; calls: number }[]
    total: { input: number; output: number; cost: number }
  } {
    const rows = jobId
      ? this.db.all<Row>('SELECT model_id, provider_id, input_tokens, output_tokens, cost_usd FROM usage_records WHERE job_id = ?', jobId)
      : this.db.all<Row>('SELECT model_id, provider_id, input_tokens, output_tokens, cost_usd FROM usage_records')
    const map = new Map<string, { modelId: string; providerId: string; input: number; output: number; cost: number; calls: number }>()
    let input = 0
    let output = 0
    let cost = 0
    for (const r of rows) {
      const key = `${str(r.provider_id)}|${str(r.model_id)}`
      const entry = map.get(key) ?? { modelId: str(r.model_id), providerId: str(r.provider_id), input: 0, output: 0, cost: 0, calls: 0 }
      entry.input += num(r.input_tokens)
      entry.output += num(r.output_tokens)
      entry.cost += num(r.cost_usd)
      entry.calls += 1
      map.set(key, entry)
      input += num(r.input_tokens)
      output += num(r.output_tokens)
      cost += num(r.cost_usd)
    }
    return { byModel: [...map.values()], total: { input, output, cost } }
  }

  jobStats(jobId: string): { totalTokens: number; totalCost: number; workersRun: number; failures: number } {
    const usage = this.usageByJob(jobId)
    const workers = this.countByStatus(jobId)
    return {
      totalTokens: usage.total.input + usage.total.output,
      totalCost: usage.total.cost,
      workersRun: workers.completed + workers.failed + workers.running,
      failures: workers.failed,
    }
  }
}
