import type {
  AutomationJob,
  LoopRecord,
  Project,
  Review,
  Task,
  WorkflowEdge,
} from '@shared/domain'
import { automationJobSchema, loopRecordSchema, taskSchema } from '@shared/domain'
import { newId, now } from '../../kernel/ids'
import type { Db } from '../db'
import { bool, flag, j, num, nullableNum, nullableStr, str, type Row } from './helpers'
import type { FlowNode } from '@shared/ipc'

function toJob(row: Row): AutomationJob {
  return automationJobSchema.parse({
    id: row.id,
    title: row.title,
    originalPrompt: row.original_prompt,
    refinedPrompt: row.refined_prompt,
    projectId: row.project_id,
    vaultId: row.vault_id,
    status: row.status,
    statusReason: row.status_reason,
    loopCount: num(row.loop_count),
    currentLoop: num(row.current_loop),
    routeId: row.route_id,
    templateId: row.template_id,
    language: row.language ?? null,
    requirePlanApproval: bool(row.require_plan_approval),
    planApprovedAt: nullableNum(row.plan_approved_at),
    workspacePath: row.workspace_path,
    stats: j(row.stats, {}),
    startedAt: nullableNum(row.started_at),
    completedAt: nullableNum(row.completed_at),
    error: row.error,
    createdAt: num(row.created_at),
    updatedAt: num(row.updated_at),
  })
}

function toLoop(row: Row): LoopRecord {
  return loopRecordSchema.parse({
    id: row.id,
    jobId: row.job_id,
    index: num(row.loop_index),
    status: row.status,
    planSummary: row.plan_summary,
    reviewSummary: row.review_summary,
    verdict: row.verdict,
    problems: j(row.problems, []),
    changes: j(row.changes, []),
    unresolved: j(row.unresolved, []),
    artifactsProduced: num(row.artifacts_produced),
    durationMs: num(row.duration_ms),
    stats: j(row.stats, {}),
    startedAt: nullableNum(row.started_at),
    completedAt: nullableNum(row.completed_at),
    createdAt: num(row.created_at),
    updatedAt: num(row.updated_at),
  })
}

function toTask(row: Row): Task {
  return taskSchema.parse({
    id: row.id,
    jobId: row.job_id,
    loopIndex: num(row.loop_index),
    nodeId: row.node_id,
    parentId: row.parent_id,
    title: row.title,
    objective: row.objective,
    role: row.role,
    profileId: row.profile_id,
    modelId: row.model_id,
    providerId: row.provider_id,
    opencodeAgent: row.opencode_agent,
    systemPrompt: row.system_prompt,
    prompt: row.prompt,
    dependencyIds: j(row.dependency_ids, []),
    expectedArtifacts: j(row.expected_artifacts, []),
    successCriteria: j(row.success_criteria, []),
    status: row.status,
    statusReason: row.status_reason,
    priority: num(row.priority),
    timeoutMs: num(row.timeout_ms),
    retryPolicy: j(row.retry_policy, {}),
    attempt: num(row.attempt),
    rationale: row.rationale,
    complexity: row.complexity,
    artifacts: j(row.artifacts, []),
    resultSummary: row.result_summary,
    startedAt: nullableNum(row.started_at),
    completedAt: nullableNum(row.completed_at),
    error: row.error,
    createdAt: num(row.created_at),
    updatedAt: num(row.updated_at),
  })
}

function toNode(row: Row): FlowNode {
  return {
    id: str(row.id),
    jobId: str(row.job_id),
    loopIndex: num(row.loop_index),
    taskId: row.task_id ? str(row.task_id) : null,
    kind: row.kind as FlowNode['kind'],
    label: str(row.label),
    detail: str(row.detail),
    rationale: str(row.rationale),
    state: row.state as FlowNode['state'],
    priority: num(row.priority),
    timeoutMs: num(row.timeout_ms),
    condition: row.condition === null || row.condition === undefined ? null : str(row.condition),
    createdAt: num(row.created_at),
    updatedAt: num(row.updated_at),
    x: num(row.pos_x),
    y: num(row.pos_y),
  }
}

function toEdge(row: Row): WorkflowEdge {
  return {
    id: str(row.id),
    jobId: str(row.job_id),
    loopIndex: num(row.loop_index),
    sourceNodeId: str(row.source_node_id),
    targetNodeId: str(row.target_node_id),
    kind: row.kind as WorkflowEdge['kind'],
    label: str(row.label),
    createdAt: num(row.created_at),
    updatedAt: num(row.updated_at),
  }
}

export interface JobPlan {
  text: string
  data: unknown
}

export class JobRepo {
  constructor(private readonly db: Db) {}

  /* jobs ------------------------------------------------------------------ */

  list(filter: { status?: string[]; limit?: number } = {}): AutomationJob[] {
    const limit = filter.limit ?? 200
    if (filter.status?.length) {
      const placeholders = filter.status.map(() => '?').join(',')
      return this.db
        .all<Row>(`SELECT * FROM automation_jobs WHERE status IN (${placeholders}) ORDER BY created_at DESC LIMIT ?`, ...filter.status, limit)
        .map(toJob)
    }
    return this.db.all<Row>('SELECT * FROM automation_jobs ORDER BY created_at DESC LIMIT ?', limit).map(toJob)
  }

  get(id: string): AutomationJob | null {
    const row = this.db.get<Row>('SELECT * FROM automation_jobs WHERE id = ?', id)
    return row ? toJob(row) : null
  }

  create(input: Partial<AutomationJob> & { title: string; originalPrompt: string }): AutomationJob {
    const t = now()
    const job = automationJobSchema.parse({ ...input, id: newId('job'), createdAt: t, updatedAt: t })
    this.db.run(
      `INSERT INTO automation_jobs (id, title, original_prompt, refined_prompt, plan_text, plan_json, project_id, vault_id, status, status_reason, loop_count, current_loop, route_id, template_id, language, require_plan_approval, plan_approved_at, plan_submitted_at, workspace_path, settings, stats, error, created_at, started_at, completed_at, updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      job.id,
      job.title,
      job.originalPrompt,
      job.refinedPrompt,
      '',
      '{}',
      job.projectId,
      job.vaultId,
      job.status,
      job.statusReason,
      job.loopCount,
      job.currentLoop,
      job.routeId,
      job.templateId,
      job.language,
      flag(job.requirePlanApproval),
      job.planApprovedAt,
      null,
      job.workspacePath,
      '{}',
      JSON.stringify(job.stats),
      job.error,
      job.createdAt,
      job.startedAt,
      job.completedAt,
      job.updatedAt,
    )
    return job
  }

  update(id: string, patch: Partial<AutomationJob>): AutomationJob {
    const current = this.get(id)
    if (!current) throw new Error(`job not found: ${id}`)
    const next = automationJobSchema.parse({ ...current, ...patch, id, updatedAt: now() })
    this.db.run(
      `UPDATE automation_jobs SET title=?, original_prompt=?, refined_prompt=?, project_id=?, vault_id=?, status=?, status_reason=?, loop_count=?, current_loop=?, route_id=?, template_id=?, language=?, require_plan_approval=?, plan_approved_at=?, workspace_path=?, stats=?, error=?, started_at=?, completed_at=?, updated_at=? WHERE id=?`,
      next.title,
      next.originalPrompt,
      next.refinedPrompt,
      next.projectId,
      next.vaultId,
      next.status,
      next.statusReason,
      next.loopCount,
      next.currentLoop,
      next.routeId,
      next.templateId,
      next.language,
      flag(next.requirePlanApproval),
      next.planApprovedAt,
      next.workspacePath,
      JSON.stringify(next.stats),
      next.error,
      next.startedAt,
      next.completedAt,
      next.updatedAt,
      id,
    )
    return next
  }

  delete(id: string): boolean {
    return this.db.run('DELETE FROM automation_jobs WHERE id = ?', id).changes > 0
  }

  setPlan(id: string, plan: JobPlan): void {
    this.db.run(
      'UPDATE automation_jobs SET plan_text = ?, plan_json = ?, plan_submitted_at = ?, updated_at = ? WHERE id = ?',
      plan.text,
      JSON.stringify(plan.data ?? {}),
      now(),
      now(),
      id,
    )
  }

  getPlan(id: string): JobPlan | null {
    const row = this.db.get<Row>('SELECT plan_text, plan_json, plan_submitted_at FROM automation_jobs WHERE id = ?', id)
    if (!row || !num(row.plan_submitted_at)) return null
    return { text: str(row.plan_text), data: j(row.plan_json, {}) }
  }

  setRefinedPrompt(id: string, refined: string): void {
    this.db.run('UPDATE automation_jobs SET refined_prompt = ?, updated_at = ? WHERE id = ?', refined, now(), id)
  }

  setWorkspace(id: string, path: string): void {
    this.db.run('UPDATE automation_jobs SET workspace_path = ?, updated_at = ? WHERE id = ?', path, now(), id)
  }

  /* loops ----------------------------------------------------------------- */

  listLoops(jobId: string): LoopRecord[] {
    return this.db.all<Row>('SELECT * FROM job_loops WHERE job_id = ? ORDER BY loop_index', jobId).map(toLoop)
  }

  getLoop(jobId: string, index: number): LoopRecord | null {
    const row = this.db.get<Row>('SELECT * FROM job_loops WHERE job_id = ? AND loop_index = ?', jobId, index)
    return row ? toLoop(row) : null
  }

  createLoop(jobId: string, index: number): LoopRecord {
    const t = now()
    const id = newId('lop')
    this.db.run(
      `INSERT INTO job_loops (id, job_id, loop_index, status, created_at, updated_at) VALUES (?,?,?,?,?,?)`,
      id,
      jobId,
      index,
      'planning',
      t,
      t,
    )
    return loopRecordSchema.parse({
      id,
      jobId,
      index,
      status: 'planning',
      createdAt: t,
      updatedAt: t,
    })
  }

  updateLoop(jobId: string, index: number, patch: Partial<LoopRecord>): LoopRecord {
    const current = this.getLoop(jobId, index)
    if (!current) return this.createLoop(jobId, index)
    const next = loopRecordSchema.parse({ ...current, ...patch, id: current.id, jobId, index, updatedAt: now() })
    this.db.run(
      `UPDATE job_loops SET status=?, plan_summary=?, review_summary=?, verdict=?, problems=?, changes=?, unresolved=?, artifacts_produced=?, duration_ms=?, stats=?, started_at=?, completed_at=?, updated_at=? WHERE id=?`,
      next.status,
      next.planSummary,
      next.reviewSummary,
      next.verdict,
      JSON.stringify(next.problems),
      JSON.stringify(next.changes),
      JSON.stringify(next.unresolved),
      next.artifactsProduced,
      next.durationMs,
      JSON.stringify(next.stats),
      next.startedAt,
      next.completedAt,
      next.updatedAt,
      next.id,
    )
    return next
  }

  /* tasks ----------------------------------------------------------------- */

  listTasks(jobId: string, loopIndex?: number): Task[] {
    const rows =
      loopIndex === undefined
        ? this.db.all<Row>('SELECT * FROM tasks WHERE job_id = ? ORDER BY created_at, id', jobId)
        : this.db.all<Row>('SELECT * FROM tasks WHERE job_id = ? AND loop_index = ? ORDER BY created_at, id', jobId, loopIndex)
    return rows.map(toTask)
  }

  getTask(id: string): Task | null {
    const row = this.db.get<Row>('SELECT * FROM tasks WHERE id = ?', id)
    return row ? toTask(row) : null
  }

  createTask(input: Partial<Task> & { jobId: string; title: string }): Task {
    const t = now()
    const task = taskSchema.parse({ ...input, id: newId('tsk'), createdAt: t, updatedAt: t })
    this.db.run(
      `INSERT INTO tasks (id, job_id, loop_index, node_id, parent_id, title, objective, role, profile_id, model_id, provider_id, opencode_agent, system_prompt, prompt, dependency_ids, expected_artifacts, success_criteria, status, status_reason, priority, timeout_ms, retry_policy, attempt, rationale, complexity, artifacts, result_summary, error, created_at, started_at, completed_at, updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      task.id,
      task.jobId,
      task.loopIndex,
      task.nodeId,
      task.parentId,
      task.title,
      task.objective,
      task.role,
      task.profileId,
      task.modelId,
      task.providerId,
      task.opencodeAgent,
      task.systemPrompt,
      task.prompt,
      JSON.stringify(task.dependencyIds),
      JSON.stringify(task.expectedArtifacts),
      JSON.stringify(task.successCriteria),
      task.status,
      task.statusReason,
      task.priority,
      task.timeoutMs,
      JSON.stringify(task.retryPolicy),
      task.attempt,
      task.rationale,
      task.complexity,
      JSON.stringify(task.artifacts),
      task.resultSummary,
      task.error,
      task.createdAt,
      task.startedAt,
      task.completedAt,
      task.updatedAt,
    )
    return task
  }

  updateTask(id: string, patch: Partial<Task>): Task {
    const current = this.getTask(id)
    if (!current) throw new Error(`task not found: ${id}`)
    const next = taskSchema.parse({ ...current, ...patch, id, jobId: current.jobId, updatedAt: now() })
    this.db.run(
      `UPDATE tasks SET loop_index=?, node_id=?, parent_id=?, title=?, objective=?, role=?, profile_id=?, model_id=?, provider_id=?, opencode_agent=?, system_prompt=?, prompt=?, dependency_ids=?, expected_artifacts=?, success_criteria=?, status=?, status_reason=?, priority=?, timeout_ms=?, retry_policy=?, attempt=?, rationale=?, complexity=?, artifacts=?, result_summary=?, error=?, started_at=?, completed_at=?, updated_at=? WHERE id=?`,
      next.loopIndex,
      next.nodeId,
      next.parentId,
      next.title,
      next.objective,
      next.role,
      next.profileId,
      next.modelId,
      next.providerId,
      next.opencodeAgent,
      next.systemPrompt,
      next.prompt,
      JSON.stringify(next.dependencyIds),
      JSON.stringify(next.expectedArtifacts),
      JSON.stringify(next.successCriteria),
      next.status,
      next.statusReason,
      next.priority,
      next.timeoutMs,
      JSON.stringify(next.retryPolicy),
      next.attempt,
      next.rationale,
      next.complexity,
      JSON.stringify(next.artifacts),
      next.resultSummary,
      next.error,
      next.startedAt,
      next.completedAt,
      next.updatedAt,
      id,
    )
    return next
  }

  deleteTasksForLoop(jobId: string, loopIndex: number): void {
    this.db.run('DELETE FROM tasks WHERE job_id = ? AND loop_index = ?', jobId, loopIndex)
  }

  /* workflow -------------------------------------------------------------- */

  listNodes(jobId: string, loopIndex?: number): FlowNode[] {
    const rows =
      loopIndex === undefined
        ? this.db.all<Row>('SELECT * FROM workflow_nodes WHERE job_id = ?', jobId)
        : this.db.all<Row>('SELECT * FROM workflow_nodes WHERE job_id = ? AND loop_index = ?', jobId, loopIndex)
    return rows.map(toNode)
  }

  listEdges(jobId: string, loopIndex?: number): WorkflowEdge[] {
    const rows =
      loopIndex === undefined
        ? this.db.all<Row>('SELECT * FROM workflow_edges WHERE job_id = ?', jobId)
        : this.db.all<Row>('SELECT * FROM workflow_edges WHERE job_id = ? AND loop_index = ?', jobId, loopIndex)
    return rows.map(toEdge)
  }

  clearWorkflow(jobId: string, loopIndex: number): void {
    this.db.tx(() => {
      this.db.run('DELETE FROM workflow_nodes WHERE job_id = ? AND loop_index = ?', jobId, loopIndex)
      this.db.run('DELETE FROM workflow_edges WHERE job_id = ? AND loop_index = ?', jobId, loopIndex)
    })
  }

  saveWorkflow(
    jobId: string,
    loopIndex: number,
    nodes: (Omit<FlowNode, 'createdAt' | 'updatedAt' | 'jobId' | 'loopIndex'> & { taskId?: string | null })[],
    edges: Omit<WorkflowEdge, 'createdAt' | 'updatedAt' | 'jobId' | 'loopIndex'>[],
  ): void {
    const t = now()
    this.db.tx(() => {
      this.clearWorkflow(jobId, loopIndex)
      for (const n of nodes) {
        this.db.run(
          `INSERT INTO workflow_nodes (id, job_id, loop_index, node_id, task_id, kind, label, detail, rationale, state, priority, timeout_ms, condition, pos_x, pos_y, created_at, updated_at)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
          n.id,
          jobId,
          loopIndex,
          n.id,
          n.taskId ?? null,
          n.kind,
          n.label,
          n.detail,
          n.rationale,
          n.state,
          n.priority,
          n.timeoutMs,
          n.condition,
          n.x,
          n.y,
          t,
          t,
        )
      }
      for (const e of edges) {
        this.db.run(
          `INSERT INTO workflow_edges (id, job_id, loop_index, source_node_id, target_node_id, kind, label, created_at, updated_at)
           VALUES (?,?,?,?,?,?,?,?,?)`,
          e.id,
          jobId,
          loopIndex,
          e.sourceNodeId,
          e.targetNodeId,
          e.kind,
          e.label,
          t,
          t,
        )
      }
    })
  }

  updateNodeState(jobId: string, nodeId: string, state: FlowNode['state'], taskId?: string | null): void {
    this.db.run(
      'UPDATE workflow_nodes SET state = ?, task_id = COALESCE(?, task_id), updated_at = ? WHERE job_id = ? AND node_id = ?',
      state,
      taskId ?? null,
      now(),
      jobId,
      nodeId,
    )
  }

  /* aggregates ------------------------------------------------------------- */

  countByStatus(): { total: number; active: number; completed: number; failed: number } {
    const rows = this.db.all<Row>('SELECT status, COUNT(*) AS c FROM automation_jobs GROUP BY status')
    const map = new Map(rows.map((r) => [str(r.status), num(r.c)]))
    const active = ['refining', 'planning', 'ready', 'running', 'paused', 'awaiting_approval']
      .reduce((sum, s) => sum + (map.get(s) ?? 0), 0)
    return {
      total: [...map.values()].reduce((a, b) => a + b, 0),
      active,
      completed: map.get('completed') ?? 0,
      failed: (map.get('failed') ?? 0) + (map.get('cancelled') ?? 0),
    }
  }

  pendingApprovals(jobId?: string): number {
    const row = jobId
      ? this.db.get<Row>("SELECT COUNT(*) AS c FROM approvals WHERE status = 'pending' AND job_id = ?", jobId)
      : this.db.get<Row>("SELECT COUNT(*) AS c FROM approvals WHERE status = 'pending'")
    return num(row?.c)
  }

  pendingTaskCount(jobId: string): number {
    return num(this.db.get<Row>("SELECT COUNT(*) AS c FROM tasks WHERE job_id = ? AND status IN ('pending','ready','running')", jobId)?.c)
  }

  projectOf(job: AutomationJob): Project | null {
    if (!job.projectId) return null
    const row = this.db.get<Row>('SELECT * FROM projects WHERE id = ?', job.projectId)
    if (!row) return null
    return {
      id: str(row.id),
      name: str(row.name),
      path: str(row.path),
      description: str(row.description),
      instructions: str(row.instructions),
      vaultId: nullableStr(row.vault_id),
      workspaceStrategy: str(row.workspace_strategy) as Project['workspaceStrategy'],
      defaultModel: nullableStr(row.default_model),
      enabled: bool(row.enabled),
      lastOpenedAt: nullableNum(row.last_opened_at),
      metadata: j(row.metadata, {}),
      createdAt: num(row.created_at),
      updatedAt: num(row.updated_at),
    }
  }

  listReviews(jobId: string): Review[] {
    return this.db
      .all<Row>('SELECT * FROM reviews WHERE job_id = ? ORDER BY created_at', jobId)
      .map((row) => ({
        id: str(row.id),
        jobId: str(row.job_id),
        loopIndex: num(row.loop_index),
        kind: str(row.kind) as Review['kind'],
        targetId: nullableStr(row.target_id),
        reviewerRole: str(row.reviewer_role) as Review['reviewerRole'],
        reviewerWorkerId: nullableStr(row.reviewer_worker_id),
        criteria: j(row.criteria, []),
        verdict: str(row.verdict) as Review['verdict'],
        summary: str(row.summary),
        findings: j(row.findings, []),
        artifactIds: j(row.artifact_ids, []),
        modelId: nullableStr(row.model_id),
        durationMs: num(row.duration_ms),
        createdAt: num(row.created_at),
        updatedAt: num(row.updated_at),
      }))
  }

  saveReview(review: Omit<Review, 'createdAt' | 'updatedAt' | 'id'> & { id?: string }): Review {
    const t = now()
    const id = review.id ?? newId('rev')
    const existing = this.db.get<Row>('SELECT created_at FROM reviews WHERE id = ?', id)
    this.db.run(
      `INSERT INTO reviews (id, job_id, loop_index, kind, target_id, reviewer_role, reviewer_worker_id, criteria, verdict, summary, findings, artifact_ids, model_id, duration_ms, created_at, updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
       ON CONFLICT(id) DO UPDATE SET verdict=excluded.verdict, summary=excluded.summary, findings=excluded.findings,
         artifact_ids=excluded.artifact_ids, duration_ms=excluded.duration_ms, updated_at=excluded.updated_at`,
      id,
      review.jobId,
      review.loopIndex,
      review.kind,
      review.targetId,
      review.reviewerRole,
      review.reviewerWorkerId,
      JSON.stringify(review.criteria),
      review.verdict,
      review.summary,
      JSON.stringify(review.findings),
      JSON.stringify(review.artifactIds),
      review.modelId,
      review.durationMs,
      existing ? num(existing.created_at) : t,
      t,
    )
    return { ...review, id, createdAt: existing ? num(existing.created_at) : t, updatedAt: t }
  }
}
