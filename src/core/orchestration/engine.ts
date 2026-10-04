import { join } from 'node:path'
import type { AgentProfile, Artifact, AutomationJob, ModelInfo, ProviderConnection, Task, Worker } from '@shared/domain'
import { artifactDiskNote } from '../opencode/artifactCollector'
import type { TranscriptEntry } from '@shared/ipc'
import type { AppContext } from '../kernel/appContext'
import { EVENTS } from '../kernel/eventBus'
import { AppError } from '../kernel/errors'
import { resolveModel } from '../ai/router'
import { validateProjectPath } from '../services/projectPath'
import { compilePlan, createPlan, reviewDataSchema, REVIEW_JSON_SCHEMA } from './plan'
import { refinePrompt } from './refiner'
import { findBlocked, isLoopSettled, latestWorkerByTask, pickReady, pickRetries } from './scheduler'

const TICK_MS = 400

/** Route catalog cache — matches the control plane's TTL so dispatch never refetches per task. */
const ROUTE_CATALOG_TTL_MS = 10 * 60_000
/** Upper bound on how long a dead provider may stall the scheduling tick while resolving a route. */
const ROUTE_CATALOG_WAIT_MS = 3_000

/** Task states that mean "this loop still carries unresolved work". */
const UNRESOLVED_TASK = new Set(['failed', 'timed_out', 'blocked'])
/** Worker states that mean the session actually ran and is now at rest. */
const SETTLED_WORKER = new Set(['succeeded', 'failed', 'timed_out', 'aborted', 'orphaned'])

const NODE_STATE_BY_TASK: Record<string, 'pending' | 'ready' | 'running' | 'waiting_approval' | 'blocked' | 'succeeded' | 'failed' | 'skipped' | 'cancelled' | 'timed_out'> = {
  pending: 'pending',
  ready: 'ready',
  running: 'running',
  waiting_approval: 'waiting_approval',
  blocked: 'blocked',
  succeeded: 'succeeded',
  failed: 'failed',
  skipped: 'skipped',
  cancelled: 'cancelled',
  timed_out: 'timed_out',
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

/**
 * The run loop: refine → plan → (approval gate) → schedule DAG → real OpenCode
 * workers → integrate → review → next loop or finish. One engine per app
 * context; at most one active run per job.
 */
export class Engine {
  private readonly runs = new Map<string, AbortController>()
  /** Dispatch-time model catalog (TTL-bounded) shared by every task of this context. */
  private routeCache: { at: number; models: Map<string, ModelInfo[]> } | null = null

  constructor(private readonly ctx: AppContext) {}

  isRunning(jobId: string): boolean {
    return this.runs.has(jobId)
  }

  /** Validates and launches a detached run. Returns the job as it stands now. */
  start(jobId: string): AutomationJob {
    const job = this.ctx.repos.jobs.get(jobId)
    if (!job) throw new AppError('not_found', `job not found: ${jobId}`)
    if (this.runs.has(jobId)) return job
    if (job.status === 'completed' || job.status === 'cancelled') throw new AppError('conflict', `job is ${job.status}`)

    const pendingPlanApproval =
      job.status === 'awaiting_approval' &&
      this.ctx.repos.workers.listApprovals('pending').some((a) => a.jobId === jobId && a.kind === 'plan')

    const controller = new AbortController()
    this.runs.set(jobId, controller)

    const next = pendingPlanApproval
      ? job
      : this.ctx.repos.jobs.update(jobId, {
          status: 'refining',
          statusReason: null,
          error: null,
          startedAt: job.startedAt ?? Date.now(),
          completedAt: null,
        })
    if (!pendingPlanApproval) {
      this.ctx.emit(EVENTS.JOB_STARTED, { jobId, message: `job started: ${job.title}` })
      this.ctx.log('orchestration').info('engine start', { jobId })
    }

    void this.run(jobId, controller.signal)
      .catch((err) => {
        try {
          const e = AppError.from(err)
          const current = this.ctx.repos.jobs.get(jobId)
          if (!current || current.status === 'cancelled' || controller.signal.aborted) return
          this.ctx.repos.jobs.update(jobId, { status: 'failed', statusReason: e.message, error: e.message, completedAt: Date.now() })
          this.ctx.emit(EVENTS.JOB_FAILED, { jobId, message: `job failed: ${e.message}`, severity: 'error', data: { code: e.code } })
          this.ctx.log('orchestration').error('engine failed', { jobId, error: e.message, code: e.code })
        } catch {
          return
        }
      })
      .finally(() => {
        this.runs.delete(jobId)
      })

    return next
  }

  /** Abort the run loop and every live worker of the job. */
  cancel(jobId: string): void {
    const controller = this.runs.get(jobId)
    if (controller) controller.abort()
    void this.ctx.opencode.abortJob(jobId, 'job cancelled')
  }

  async shutdown(): Promise<void> {
    for (const controller of this.runs.values()) controller.abort()
    this.runs.clear()
  }

  /* ------------------------------------------------------------------ run */

  private async run(jobId: string, signal: AbortSignal): Promise<void> {
    let job = this.ctx.repos.jobs.get(jobId)
    if (!job) throw new AppError('not_found', `job not found: ${jobId}`)

    // Workspace: a selected project owns its own folder; jobs without one get a
    // per-job scratch directory. Validated here so a deleted/moved project fails
    // loudly instead of having an empty folder recreated under its old path.
    const project = job.projectId ? this.ctx.repos.projects.get(job.projectId) : null
    if (job.projectId && !project) {
      throw new AppError('not_found', 'the selected project no longer exists — pick another project and restart the job')
    }
    if (project) {
      const status = validateProjectPath(project.path)
      if (status.message) throw new AppError('invalid_argument', `project "${project.name}" cannot be used: ${status.message}`)
    }
    const workspace = project?.path ?? job.workspacePath ?? join(this.ctx.paths.jobs, jobId)
    if (job.workspacePath !== workspace) this.ctx.repos.jobs.setWorkspace(jobId, workspace)
    if (!job.refinedPrompt) {
      const refined = await refinePrompt(this.ctx, job, signal)
      this.ctx.repos.jobs.setRefinedPrompt(jobId, refined)
      this.ctx.log('orchestration').info('prompt refined', { jobId, length: refined.length })
    }

    let prior: { problems: string[]; summary: string } | undefined

    for (;;) {
      if (signal.aborted) return
      job = this.ctx.repos.jobs.get(jobId)!
      if (!job || job.status === 'cancelled') return
      if (job.status === 'paused') {
        await sleep(TICK_MS)
        continue
      }
      if (
        job.status === 'awaiting_approval' &&
        this.ctx.repos.workers.listApprovals('pending').some((a) => a.jobId === jobId && a.kind === 'plan')
      ) {
        return
      }

      const loopIndex = Math.max(job.currentLoop, 1)
      const loop = this.ctx.repos.jobs.getLoop(jobId, loopIndex) ?? this.ctx.repos.jobs.createLoop(jobId, loopIndex)
      this.ctx.repos.jobs.updateLoop(jobId, loopIndex, { status: 'planning', startedAt: loop.startedAt ?? Date.now() })
      this.ctx.repos.jobs.update(jobId, { status: 'planning', currentLoop: loopIndex })
      this.ctx.emit(EVENTS.LOOP_STARTED, { jobId, message: `loop ${loopIndex}: planning`, data: { loopIndex } })

      const existingTasks = this.ctx.repos.jobs.listTasks(jobId, loopIndex)
      const reusePlan = Boolean(job.planApprovedAt) && existingTasks.length > 0

      if (!reusePlan) {
        const plan = await createPlan(this.ctx, job, loopIndex, prior, signal)
        this.ctx.repos.jobs.setPlan(jobId, { text: plan.text, data: plan.data })

        const compiled = compilePlan(job, loopIndex, plan.data)
        this.ctx.repos.jobs.deleteTasksForLoop(jobId, loopIndex)
        const created = compiled.tasks.map((t) => this.ctx.repos.jobs.createTask(t))
        // createTask always mints fresh ids: rewrite the dependency references and
        // the workflow's taskId links onto the ids that actually landed in the DB.
        const persistedId = new Map(compiled.tasks.map((t, i) => [t.id, created[i]!.id]))
        for (let i = 0; i < created.length; i++) {
          const original = compiled.tasks[i]!.dependencyIds ?? []
          if (original.length === 0) continue
          const deps = original.map((d) => persistedId.get(d) ?? d)
          if (deps.some((d, j) => d !== original[j])) {
            this.ctx.repos.jobs.updateTask(created[i]!.id, { dependencyIds: deps })
          }
        }
        const taskIdByNode = new Map(compiled.tasks.map((t, i) => [t.nodeId ?? '', created[i]!.id]))
        this.ctx.repos.jobs.saveWorkflow(
          jobId,
          loopIndex,
          compiled.nodes.map((n) => ({ ...n, taskId: taskIdByNode.get(n.id) ?? n.taskId ?? null })),
          compiled.edges,
        )
        this.ctx.emit(EVENTS.JOB_PLAN_READY, {
          jobId,
          message: `plan ready: ${created.length} steps`,
          data: { loopIndex, steps: created.length },
        })

        if (job.requirePlanApproval && !job.planApprovedAt) {
          const alreadyPending = this.ctx.repos.workers.listApprovals('pending').some((a) => a.jobId === jobId && a.kind === 'plan')
          if (!alreadyPending) {
            this.ctx.repos.workers.createApproval({
              kind: 'plan',
              title: `Plan approval — loop ${loopIndex}`,
              detail: plan.text.slice(0, 4000),
              jobId,
              payload: { loopIndex },
            })
          }
          this.ctx.repos.jobs.update(jobId, { status: 'awaiting_approval', statusReason: 'waiting for plan approval' })
          this.ctx.emit(EVENTS.APPROVAL_REQUESTED, {
            jobId,
            message: 'plan awaits approval',
            severity: 'warn',
            data: { loopIndex },
          })
          this.ctx.log('orchestration').info('awaiting plan approval', { jobId, loopIndex })
          return
        }
      }

      const outcome = await this.executeLoop(jobId, loopIndex, signal)
      if (signal.aborted) return
      if (outcome.cancelled) return

      const review = await this.integrateAndReview(jobId, loopIndex, outcome, signal)
      if (signal.aborted) return

      while (!signal.aborted) {
        const current = this.ctx.repos.jobs.get(jobId)
        if (!current || current.status === 'cancelled') return
        if (current.status !== 'paused') break
        await sleep(TICK_MS)
      }
      if (signal.aborted) return

      // A reviewer that could not run is not an approval. Fail loudly instead of
      // finishing (or silently spending another loop) on an unreadable verdict.
      if (review.unavailable) {
        this.failLoop(jobId, loopIndex, review.problems, review.summary)
        this.ctx.emit(EVENTS.LOOP_FAILED, {
          jobId,
          severity: 'error',
          message: `loop ${loopIndex}: review unavailable — ${review.summary}`,
          data: { loopIndex },
        })
        throw new AppError('unavailable', review.summary)
      }

      const needsAnotherLoop = (review.verdict === 'fail' || review.verdict === 'needs_more_work') && loopIndex < job.loopCount
      if (needsAnotherLoop) {
        prior = { problems: review.problems, summary: review.summary }
        const nextIndex = loopIndex + 1
        if (!this.ctx.repos.jobs.getLoop(jobId, nextIndex)) this.ctx.repos.jobs.createLoop(jobId, nextIndex)
        this.ctx.repos.jobs.update(jobId, { currentLoop: nextIndex, status: 'planning' })
        this.ctx.emit(EVENTS.LOOP_COMPLETED, { jobId, message: `loop ${loopIndex}: ${review.verdict} — planning loop ${nextIndex}`, severity: 'warn', data: { loopIndex, verdict: review.verdict } })
        continue
      }

      // Nothing below this point may report success for a loop that is not clean.
      const finishing = this.ctx.repos.jobs.listTasks(jobId, loopIndex)
      const unresolved = finishing.filter((t) => UNRESOLVED_TASK.has(t.status))
      const succeeded = finishing.filter((t) => t.status === 'succeeded').length
      const artifacts = this.ctx.repos.workers.listArtifacts(jobId).filter((a) => a.loopIndex === loopIndex).length
      if (unresolved.length > 0 || (succeeded === 0 && artifacts === 0)) {
        const names = unresolved.map((t) => t.title).join(', ')
        const zeroWork = succeeded === 0 && artifacts === 0
        const reason = zeroWork
          ? `loop produced no successful tasks and no artifacts${unresolved.length ? ` — unresolved tasks: ${names}` : ''}`
          : `${unresolved.length} task(s) ended ${loopIndex >= job.loopCount ? 'the final loop' : 'the loop'} unresolved: ${names}`
        this.failLoop(jobId, loopIndex, [...review.problems, ...(unresolved.length ? [`failed tasks: ${names}`] : []), ...(zeroWork ? ['loop produced no successful tasks and no artifacts'] : [])], reason)
        this.ctx.emit(EVENTS.LOOP_FAILED, { jobId, severity: 'error', message: `loop ${loopIndex}: ${reason}`, data: { loopIndex } })
        throw new AppError('internal', reason)
      }

      // No repair loops remain and the reviewer rejected the deliverable:
      // that is a failure, not a "completed" job wearing a negative summary.
      if (loopIndex >= job.loopCount && (review.verdict === 'fail' || review.verdict === 'needs_more_work')) {
        const reason = `final review verdict "${review.verdict}" — ${review.summary || 'the reviewer rejected the deliverable'}`
        this.failLoop(jobId, loopIndex, review.problems, review.summary || reason)
        this.ctx.emit(EVENTS.LOOP_FAILED, { jobId, severity: 'error', message: `loop ${loopIndex}: ${reason}`, data: { loopIndex } })
        throw new AppError('internal', reason)
      }

      this.finish(jobId, loopIndex, review.summary)
      return
    }
  }

  /** Records a loop that could not be honestly reported as done. */
  private failLoop(jobId: string, loopIndex: number, problems: string[], summary: string): void {
    this.ctx.repos.jobs.updateLoop(jobId, loopIndex, { status: 'failed', verdict: 'fail', problems, reviewSummary: summary })
  }

  /* ------------------------------------------------------------ execution */

  private async executeLoop(
    jobId: string,
    loopIndex: number,
    signal: AbortSignal,
  ): Promise<{ failures: Task[]; cancelled: boolean }> {
    const cfg = this.ctx.config.get()
    // `isLoopSettled([])` is vacuously true: an empty task list would break the
    // loop on the first tick and be reported as a successful run with zero
    // dispatches. Refuse loudly instead of manufacturing a pass.
    if (this.ctx.repos.jobs.listTasks(jobId, loopIndex).length === 0) {
      throw new AppError('internal', `loop ${loopIndex} has no tasks — refusing to treat an empty plan as work`)
    }
    this.ctx.repos.jobs.update(jobId, { status: 'running', statusReason: null })
    this.ctx.repos.jobs.updateLoop(jobId, loopIndex, { status: 'executing' })
    this.ctx.emit(EVENTS.JOB_STATUS, { jobId, message: 'executing plan', data: { status: 'running' } })

    for (;;) {
      if (signal.aborted) return { failures: [], cancelled: true }
      const job = this.ctx.repos.jobs.get(jobId)
      if (!job || job.status === 'cancelled') return { failures: [], cancelled: true }
      if (job.status === 'paused') {
        await sleep(TICK_MS)
        continue
      }

      const workers = latestWorkerByTask(this.ctx.repos.workers.listWorkers(jobId).filter((w) => w.loopIndex === loopIndex))
      let tasks = this.ctx.repos.jobs.listTasks(jobId, loopIndex)
      const byId = new Map(tasks.map((t) => [t.id, t]))

      for (const id of findBlocked(byId)) {
        this.setTask(id, { status: 'blocked', statusReason: 'dependency did not succeed', completedAt: Date.now() })
      }

      for (const task of tasks) {
        if (task.status === 'pending' && task.dependencyIds.every((id) => ['succeeded', 'skipped'].includes(byId.get(id)?.status ?? ''))) {
          this.setTask(task.id, { status: 'ready' })
        }
      }

      tasks = this.ctx.repos.jobs.listTasks(jobId, loopIndex)
      for (const task of tasks) {
        const worker = workers.get(task.id)
        if (!worker) continue
        if (task.status === 'running' || task.status === 'waiting_approval') {
          if (worker.status === 'succeeded') {
            this.setTask(task.id, { status: 'succeeded', completedAt: Date.now(), resultSummary: task.resultSummary || '', statusReason: null, error: null })
            this.ctx.emit(EVENTS.TASK_COMPLETED, { jobId, taskId: task.id, message: `task done: ${task.title}` })
          } else if (worker.status === 'waiting_approval') {
            if (task.status !== 'waiting_approval') this.setTask(task.id, { status: 'waiting_approval', statusReason: 'waiting for approval' })
          } else if (worker.status === 'failed' || worker.status === 'timed_out' || worker.status === 'aborted' || worker.status === 'orphaned') {
            // `orphaned` is set by boot reconciliation for sessions that died with the
            // app. It is a retryable failure like any other — without this branch the
            // task stays `running` forever and the tick spins on an idle worker.
            const error = worker.error ?? worker.statusReason ?? worker.status
            const retryable = worker.status !== 'aborted' || !task.retryPolicy.noRetryOn.includes('aborted')
            const willRetry = retryable && task.attempt < task.retryPolicy.maxAttempts
            if (willRetry) {
              this.setTask(task.id, { status: 'failed', error, statusReason: `${error} — retrying` })
            } else {
              this.setTask(task.id, { status: worker.status === 'timed_out' ? 'timed_out' : 'failed', error, statusReason: error, completedAt: Date.now() })
              this.ctx.emit(EVENTS.TASK_FAILED, { jobId, taskId: task.id, message: `task failed: ${task.title} — ${error}`, severity: 'error' })
            }
          }
        }
      }

      tasks = this.ctx.repos.jobs.listTasks(jobId, loopIndex)
      const freshById = new Map(tasks.map((t) => [t.id, t]))
      for (const task of tasks) {
        if (task.status === 'blocked' && task.dependencyIds.every((id) => ['succeeded', 'skipped'].includes(freshById.get(id)?.status ?? ''))) {
          this.setTask(task.id, { status: 'ready', statusReason: null, error: null, completedAt: null })
        }
      }

      const retryWorkers = latestWorkerByTask(this.ctx.repos.workers.listWorkers(jobId).filter((w) => w.loopIndex === loopIndex))
      for (const task of pickRetries(tasks, retryWorkers)) {
        this.setTask(task.id, { status: 'ready', error: null, statusReason: null, completedAt: null })
      }

      tasks = this.ctx.repos.jobs.listTasks(jobId, loopIndex)
      if (isLoopSettled(tasks)) break

      const active = this.ctx.repos.workers.listWorkers(jobId).filter((w) => ['queued', 'starting', 'running', 'waiting_approval'].includes(w.status)).length
      const budget = Math.max(0, cfg.orchestration.limits.maxConcurrentWorkers - active)
      for (const task of pickReady(tasks, budget)) {
        if (signal.aborted) break
        await this.dispatchTask(jobId, loopIndex, task)
      }

      await sleep(TICK_MS)
    }

    const finalTasks = this.ctx.repos.jobs.listTasks(jobId, loopIndex)
    return {
      failures: finalTasks.filter((t) => t.status === 'failed' || t.status === 'timed_out' || t.status === 'blocked'),
      cancelled: false,
    }
  }

  private async dispatchTask(jobId: string, loopIndex: number, task: Task): Promise<void> {
    const job = this.ctx.repos.jobs.get(jobId)
    if (!job) return
    const attempt = task.attempt + 1
    this.setTask(task.id, { status: 'running', attempt, startedAt: task.startedAt ?? Date.now(), error: null, statusReason: null })

    let worker: Worker | null = null
    try {
      const route = await this.resolveDispatchRoute(job, task)
      if (!route.providerId || !route.modelId) {
        // Never claim a model that was not chosen: say out loud that the worker
        // is falling back to whatever OpenCode picks on its own.
        this.ctx.log('orchestration').warn('no provider/model resolved for task — worker will use the OpenCode default model', {
          jobId,
          taskId: task.id,
          role: task.role,
          routeId: job.routeId ?? null,
        })
      }
      worker = this.ctx.repos.workers.createWorker({
        jobId,
        loopIndex,
        taskId: task.id,
        name: attempt > 1 ? `${task.title} (attempt ${attempt})` : task.title,
        role: task.role,
        objective: task.objective,
        systemPrompt: task.systemPrompt || route.profile?.systemPrompt || '',
        taskPrompt: task.prompt,
        modelId: route.modelId,
        providerId: route.providerId,
        opencodeAgent: task.opencodeAgent ?? route.profile?.opencodeAgent ?? null,
        profileId: task.profileId ?? route.profile?.id ?? null,
        workspacePath: job.workspacePath ?? join(this.ctx.paths.jobs, jobId),
        projectId: job.projectId,
        timeoutMs: task.timeoutMs,
        status: 'queued',
        attempt: task.attempt,
      })
      await this.ctx.opencode.dispatch(worker)
      this.ctx.emit(EVENTS.TASK_STARTED, { jobId, taskId: task.id, message: `task started: ${task.title}` })
    } catch (err) {
      const e = AppError.from(err)
      if (worker) {
        this.ctx.repos.workers.updateWorker(worker.id, {
          status: 'failed',
          statusReason: e.message,
          error: e.message,
          completedAt: Date.now(),
        })
      }
      this.setTask(task.id, { status: 'failed', error: e.message, statusReason: e.message, completedAt: Date.now() })
      this.ctx.emit(EVENTS.TASK_FAILED, { jobId, taskId: task.id, message: `task could not start: ${task.title} — ${e.message}`, severity: 'error' })
      this.ctx.log('orchestration').error('dispatch failed', { taskId: task.id, error: e.message })
    }
  }

  /**
   * Dispatch-time routing: the plan never carries a model, so the concrete
   * provider + model (and the agent profile matching the task's role) are
   * resolved here from the job's `routeId`, the profile's preference and the
   * task's own override, through the same `resolveModel` machinery the control
   * plane uses. Nulls mean "nothing resolvable" — the caller warns rather than
   * letting OpenCode silently pick its own default.
   */
  private async resolveDispatchRoute(
    job: AutomationJob,
    task: Task,
  ): Promise<{ profile: AgentProfile | null; providerId: string | null; modelId: string | null }> {
    const profile = task.profileId
      ? this.ctx.repos.providers.getProfile(task.profileId)
      : (this.ctx.repos.providers.listProfiles().find((p) => p.enabled && p.role === task.role) ?? null)

    const override =
      task.providerId || task.modelId
        ? { providerId: task.providerId, modelId: task.modelId }
        : profile?.modelPreference && (profile.modelPreference.modelId || profile.modelPreference.providerId)
          ? { providerId: profile.modelPreference.providerId, modelId: profile.modelPreference.modelId }
          : null
    const explicit = override && override.providerId && override.modelId ? override : null

    const providers = this.ctx.repos.providers.listProviders().filter((p) => p.enabled)
    if (providers.length === 0) return { profile, providerId: explicit?.providerId ?? null, modelId: explicit?.modelId ?? null }

    const routes = this.ctx.repos.providers.listRoutes()
    const route = (job.routeId ? routes.find((r) => r.id === job.routeId) : null) ?? routes.find((r) => r.isDefault) ?? null
    const decision = resolveModel({
      role: task.role,
      route,
      providers,
      catalog: await this.routeCatalog(providers),
      override,
      complexity: task.complexity,
    })
    if (decision) return { profile, providerId: decision.primary.providerId, modelId: decision.primary.modelId }
    return { profile, providerId: explicit?.providerId ?? null, modelId: explicit?.modelId ?? null }
  }

  /** Cached model catalog, bounded so an unreachable provider cannot stall the tick. */
  private async routeCatalog(providers: ProviderConnection[]): Promise<Map<string, ModelInfo[]>> {
    const now = Date.now()
    if (this.routeCache && now - this.routeCache.at < ROUTE_CATALOG_TTL_MS) return this.routeCache.models
    let timer: ReturnType<typeof setTimeout> | null = null
    try {
      const models = await Promise.race([
        this.ctx.ai.snapshotCatalog(providers),
        new Promise<Map<string, ModelInfo[]>>((resolve) => {
          timer = setTimeout(() => resolve(new Map<string, ModelInfo[]>()), ROUTE_CATALOG_WAIT_MS)
        }),
      ])
      this.routeCache = { at: now, models }
      return models
    } catch (err) {
      this.ctx.log('orchestration').warn('route catalog unavailable — routing from provider defaults only', {
        error: AppError.from(err).message,
      })
      this.routeCache = { at: now, models: new Map() }
      return this.routeCache.models
    } finally {
      if (timer) clearTimeout(timer)
    }
  }

  private setTask(taskId: string, patch: Partial<Task>): Task | null {
    const task = this.ctx.repos.jobs.getTask(taskId)
    if (!task) return null
    const next = this.ctx.repos.jobs.updateTask(taskId, patch)
    if (next.nodeId) {
      this.ctx.repos.jobs.updateNodeState(next.jobId, next.nodeId, NODE_STATE_BY_TASK[next.status] ?? 'pending', next.id)
    }
    return next
  }

  /* -------------------------------------------------------- integrate/review */

  private async integrateAndReview(
    jobId: string,
    loopIndex: number,
    outcome: { failures: Task[] },
    signal: AbortSignal,
  ): Promise<{
    verdict: 'pass' | 'fail' | 'needs_more_work' | 'stop'
    summary: string
    problems: string[]
    changes: string[]
    unavailable: boolean
  }> {
    const job = this.ctx.repos.jobs.get(jobId)!
    const tasks = this.ctx.repos.jobs.listTasks(jobId, loopIndex)
    const succeeded = tasks.filter((t) => t.status === 'succeeded')
    const failed = outcome.failures

    this.ctx.repos.jobs.updateLoop(jobId, loopIndex, { status: 'integrating' })
    let synthesis = ''
    let integrationError: string | null = null
    if (succeeded.length > 0) {
      const body = this.integrationBody(job, jobId, loopIndex, succeeded, failed)
      try {
        const res = await this.ctx.ai.runText({
          role: 'synthesizer',
          jobId,
          loopIndex,
          ...(job.routeId ? { routeId: job.routeId } : {}),
          messages: [
            { role: 'system', content: 'You are the integration lead. Merge the step outputs into one coherent deliverable for the user. Plain markdown, no meta commentary.' },
            { role: 'user', content: body.slice(0, 12_000) },
          ],
          temperature: 0.3,
          signal,
        })
        synthesis = res.text.trim()
        if (synthesis) {
          this.ctx.repos.workers.createArtifact({
            jobId,
            loopIndex,
            kind: 'response',
            name: 'integration',
            content: synthesis,
            bytes: Buffer.byteLength(synthesis),
            status: 'available',
          })
          this.ctx.emit(EVENTS.ARTIFACT_CREATED, { jobId, message: 'integration artifact produced', data: { name: 'integration' } })
        }
      } catch (err) {
        // A swallowed synthesis failure must never be invisible: surface it on the
        // timeline, on the loop's unresolved list and to the reviewer below.
        const message = AppError.from(err).message
        integrationError = `integration step failed: ${message}`
        this.ctx.log('orchestration').warn('integration failed', { jobId, loopIndex, error: message })
        this.ctx.emit(EVENTS.PROVIDER_FAILED, {
          jobId,
          severity: 'warn',
          message: `integration failed for loop ${loopIndex}: ${message}`,
          data: { loopIndex, stage: 'integration' },
        })
        const loop = this.ctx.repos.jobs.getLoop(jobId, loopIndex)
        const unresolved = loop?.unresolved ?? []
        if (!unresolved.includes(integrationError)) {
          this.ctx.repos.jobs.updateLoop(jobId, loopIndex, { unresolved: [...unresolved, integrationError] })
        }
      }
    }

    this.ctx.repos.jobs.updateLoop(jobId, loopIndex, { status: 'reviewing' })
    return this.review(jobId, loopIndex, { synthesis, failed: failed.map((t) => `${t.title}: ${t.error ?? t.status}`), integrationError }, signal)
  }

  /**
   * Evidence handed to the synthesizer: what each completed step was asked to do
   * next to what was actually recorded (session output, result summary,
   * artifacts). `resultSummary` is not populated by any producer today, so an
   * objective is never presented as delivered work — steps with nothing captured
   * say so explicitly.
   */
  private integrationBody(job: AutomationJob, jobId: string, loopIndex: number, succeeded: Task[], failed: Task[]): string {
    const workersByTask = latestWorkerByTask(this.ctx.repos.workers.listWorkers(jobId).filter((w) => w.loopIndex === loopIndex))
    const artifactsByTask = new Map<string, Artifact[]>()
    for (const a of this.ctx.repos.workers.listArtifacts(jobId)) {
      if (a.loopIndex !== loopIndex || !a.taskId) continue
      artifactsByTask.set(a.taskId, [...(artifactsByTask.get(a.taskId) ?? []), a])
    }
    const step = (t: Task): string => {
      const worker = workersByTask.get(t.id)
      const sessionSummary = worker?.sessionId ? (this.ctx.repos.workers.getSession(worker.sessionId)?.summary ?? '') : ''
      const captured = [t.resultSummary, sessionSummary]
        .map((s) => s.trim())
        .filter(Boolean)
        .join(' — ')
      const artifactList = (artifactsByTask.get(t.id) ?? [])
        .map((a) => `${a.name} (${a.kind}, ${a.bytes} bytes)`)
        .join(', ')
      return [
        `- ${t.title}`,
        `  intent: ${(t.objective || t.prompt).slice(0, 300)}`,
        `  captured output: ${captured || 'none recorded — this step produced no captured output'}`,
        `  artifacts: ${artifactList || 'none recorded'}`,
      ].join('\n')
    }
    return [
      `Goal: ${job.refinedPrompt || job.originalPrompt}`,
      '',
      'Evidence, not intent: "captured output" and "artifacts" are what the workers actually recorded; "intent" is only what the step was asked to do.',
      '',
      `Completed steps (${succeeded.length}):`,
      ...succeeded.map(step),
      ...(failed.length
        ? ['', `Failed steps (${failed.length}):`, ...failed.map((t) => `- ${t.title}: ${t.error ?? t.status}`)]
        : []),
    ].join('\n')
  }

  /**
   * Evidence handed to the reviewer: task/worker outcomes plus every file
   * artifact re-checked on disk *by the application*. The reviewer judges real
   * results — never the model's prose about them. `path` is workspace-relative
   * (the collector rejects escapes), so a missing file reads as `MISSING`.
   */
  private async reviewEvidence(jobId: string, loopIndex: number): Promise<string> {
    const job = this.ctx.repos.jobs.get(jobId)
    const workspace = job?.workspacePath ?? join(this.ctx.paths.jobs, jobId)
    const tasks = this.ctx.repos.jobs.listTasks(jobId, loopIndex)
    const workers = latestWorkerByTask(this.ctx.repos.workers.listWorkers(jobId).filter((w) => w.loopIndex === loopIndex))
    const artifacts = this.ctx.repos.workers.listArtifacts(jobId).filter((a) => a.loopIndex === loopIndex)

    const lines: string[] = [`Steps (${tasks.length}):`]
    for (const t of tasks) {
      const w = workers.get(t.id)
      const workerNote = w ? ` | worker ${w.status} (attempt ${w.attempt})${w.statusReason ? `: ${w.statusReason}` : ''}` : ' | no worker ran'
      lines.push(`- ${t.title}: ${t.status}${workerNote}`)
    }

    const files = artifacts.filter((a): a is Artifact & { path: string } => Boolean(a.path))
    if (files.length) {
      lines.push('', `File artifacts re-checked on disk under ${workspace}:`)
      for (const a of files) {
        try {
          const abs = join(workspace, a.path)
          const note = await artifactDiskNote(abs, a)
          lines.push(`- ${a.path}: ${note ?? `MISSING on disk (recorded ${a.status})`}`)
        } catch {
          lines.push(`- ${a.path}: MISSING on disk (recorded ${a.status})`)
        }
      }
    } else {
      lines.push('', 'File artifacts: none recorded for this loop.')
    }
    const textArtifacts = artifacts.filter((a) => a.kind !== 'file')
    if (textArtifacts.length) {
      lines.push(`Text artifacts: ${textArtifacts.map((a) => `${a.name} (${a.bytes} bytes)`).join(', ')}`)
    }

    // Tool-executor evidence: what the tools actually reported, independent of
    // the model's prose. A step whose writes all errored must not read as done.
    const toolFindings = await this.toolFindings(jobId, workers.values())
    if (toolFindings.length) {
      lines.push('', 'Failed tool executions (executor-reported, from worker transcripts):')
      for (const f of toolFindings.slice(0, 20)) lines.push(`- ${f}`)
    }
    return lines.join('\n')
  }

  /** Collects errored/non-zero tool calls across the loop's worker transcripts. */
  private async toolFindings(jobId: string, workers: Iterable<Worker>): Promise<string[]> {
    const out: string[] = []
    for (const w of workers) {
      if (!w.sessionId) continue
      let entries: TranscriptEntry[] = []
      try {
        entries = await this.ctx.opencode.transcriptFor(w.id)
      } catch {
        continue
      }
      for (const e of entries) {
        if (e.role !== 'tool') continue
        const status = e.tool?.status ?? 'unknown'
        const failed = status === 'error' || status === 'failed' || /exit [1-9]/.test(e.text)
        if (failed) out.push(`${w.name}: ${e.text.slice(0, 300)}`)
      }
    }
    return out
  }

  private async review(
    jobId: string,
    loopIndex: number,
    context: { synthesis: string; failed: string[]; integrationError: string | null },
    signal: AbortSignal,
  ): Promise<{
    verdict: 'pass' | 'fail' | 'needs_more_work' | 'stop'
    summary: string
    problems: string[]
    changes: string[]
    unavailable: boolean
  }> {
    const job = this.ctx.repos.jobs.get(jobId)!
    const isFinal = loopIndex >= job.loopCount
    const integrationProblems = context.integrationError ? [context.integrationError] : []
    let evidence = ''
    try {
      evidence = await this.reviewEvidence(jobId, loopIndex)
    } catch (err) {
      evidence = `evidence collection failed: ${AppError.from(err).message}`
    }
    const user = [
      `Goal: ${job.refinedPrompt || job.originalPrompt}`,
      context.synthesis ? `\nDeliverable:\n${context.synthesis.slice(0, 8_000)}` : '',
      !context.synthesis && context.integrationError ? `\nNo deliverable was produced: ${context.integrationError}` : '',
      context.failed.length ? `\nFailed steps:\n${context.failed.map((f) => `- ${f}`).join('\n')}` : '',
      `\nApplication-verified evidence (checked by the harness, not model claims):\n${evidence.slice(0, 6_000)}`,
      '\nJudge only against the goal, using the verified evidence above. Return the JSON verdict.',
    ].join('\n')

    try {
      const res = await this.ctx.ai.runStructured({
        role: isFinal ? 'final_reviewer' : 'reviewer',
        jobId,
        loopIndex,
        ...(job.routeId ? { routeId: job.routeId } : {}),
        schema: reviewDataSchema,
        jsonSchema: REVIEW_JSON_SCHEMA,
        messages: [
          { role: 'system', content: 'You are a strict reviewer. Verdict "pass" only if the deliverable meets the goal with no outstanding failures.' },
          { role: 'user', content: user },
        ],
        temperature: 0.1,
        maxAttempts: 3,
        signal,
      })
      const data = res.data
      const problems = [...data.problems, ...context.failed, ...integrationProblems]
      this.persistReview(jobId, loopIndex, isFinal ? 'final' : 'loop', data.verdict, data.summary, problems, data.changes)
      return { verdict: data.verdict, summary: data.summary, problems, changes: data.changes, unavailable: false }
    } catch (err) {
      if (signal.aborted) throw err
      const message = `review unavailable: ${AppError.from(err).message}`
      const problems = [...context.failed, ...integrationProblems, message]
      this.ctx.log('orchestration').error('review unavailable', { jobId, loopIndex, error: message })
      // A reviewer that could not run is not an approval: persist and report a
      // failure, never a pass manufactured from "there happened to be no failures".
      this.persistReview(jobId, loopIndex, isFinal ? 'final' : 'loop', 'fail', message, problems, [])
      return { verdict: 'fail', summary: message, problems, changes: [], unavailable: true }
    }
  }

  private persistReview(
    jobId: string,
    loopIndex: number,
    kind: 'loop' | 'final',
    verdict: 'pass' | 'fail' | 'needs_more_work' | 'stop',
    summary: string,
    problems: string[],
    changes: string[],
  ): void {
    const job = this.ctx.repos.jobs.get(jobId)
    this.ctx.repos.jobs.saveReview({
      jobId,
      loopIndex,
      kind,
      reviewerRole: kind === 'final' ? 'final_reviewer' : 'reviewer',
      reviewerWorkerId: null,
      targetId: null,
      criteria: ['goal satisfied', 'no unresolved failures'],
      verdict,
      summary,
      findings: problems.map((p, i) => ({ id: `f${i}`, severity: 'minor' as const, title: p, detail: '', targetTaskId: null, requiredAction: '' })),
      artifactIds: [],
      modelId: null,
      durationMs: 0,
    })
    this.ctx.repos.jobs.updateLoop(jobId, loopIndex, {
      verdict: verdict === 'needs_more_work' ? 'partial' : verdict,
      reviewSummary: summary,
      problems,
      changes,
    })
    this.ctx.emit(EVENTS.REVIEW_COMPLETED, { jobId, message: `review: ${verdict}`, data: { loopIndex, verdict }, severity: verdict === 'pass' ? 'info' : 'warn' })
    if (job) this.ctx.log('orchestration').info('review recorded', { jobId, loopIndex, verdict })
  }

  private finish(jobId: string, loopIndex: number, summary: string): void {
    const nowTs = Date.now()
    const job = this.ctx.repos.jobs.get(jobId)
    const loop = this.ctx.repos.jobs.getLoop(jobId, loopIndex)

    // Counts are scoped to the loop being closed so replans cannot double count
    // the same work, and only workers that ran to a terminal state are reported —
    // a session still in flight is not work that happened.
    const loopWorkers = this.ctx.repos.workers.listWorkers(jobId).filter((w) => w.loopIndex === loopIndex)
    const settled = loopWorkers.filter((w) => SETTLED_WORKER.has(w.status))
    const failures = loopWorkers.filter((w) => w.status === 'failed' || w.status === 'timed_out' || w.status === 'orphaned').length
    const retries = loopWorkers.reduce((total, w) => total + Math.max(0, w.attempt - 1), 0)
    const loopTokens = loopWorkers.reduce((total, w) => total + w.usage.inputTokens + w.usage.outputTokens, 0)
    const tasksCompleted = this.ctx.repos.jobs.listTasks(jobId, loopIndex).filter((t) => t.status === 'succeeded').length
    const artifactsProduced = this.ctx.repos.workers.listArtifacts(jobId).filter((a) => a.loopIndex === loopIndex).length
    // Token and cost spend stay job-cumulative: every control-plane call and
    // worker session really happened, whichever loop it belonged to.
    const jobStats = this.ctx.repos.workers.jobStats(jobId)
    const durationMs = job?.startedAt ? nowTs - job.startedAt : loop?.startedAt ? nowTs - loop.startedAt : 0
    this.ctx.repos.jobs.updateLoop(jobId, loopIndex, {
      status: 'completed',
      completedAt: nowTs,
      durationMs: loop?.startedAt ? nowTs - loop.startedAt : 0,
      artifactsProduced,
      stats: { totalTokens: loopTokens, workers: settled.length, failures, retries },
    })
    this.ctx.repos.jobs.update(jobId, {
      status: 'completed',
      statusReason: summary.slice(0, 500),
      completedAt: nowTs,
      stats: {
        totalTokens: jobStats.totalTokens,
        totalCost: jobStats.totalCost,
        workersRun: settled.length,
        tasksCompleted,
        failures,
        retries,
        durationMs,
      },
    })
    this.ctx.emit(EVENTS.LOOP_COMPLETED, { jobId, message: `loop ${loopIndex} completed`, data: { loopIndex } })
    this.ctx.emit(EVENTS.JOB_COMPLETED, { jobId, message: `job completed: ${summary.slice(0, 160) || 'done'}` })
    this.ctx.log('orchestration').info('job completed', { jobId, loopIndex })
  }
}
