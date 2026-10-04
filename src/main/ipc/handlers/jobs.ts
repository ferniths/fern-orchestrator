import type { Approval, AutomationJob, Task, WorkerSession } from '@shared/domain'
import { outputLanguageSchema } from '@shared/domain'
import type { JobDetail, JobListItem, WorkerDetail, WorkerSessionSummary } from '@shared/ipc'
import type { Handlers } from '../router'
import { invalid, notFound } from '@core/kernel/errors'
import { diffAgainstUpstream, diffSummary, isGitRepo, status as gitStatus } from '@core/services/git'
import { validateProjectPath } from '@core/services/projectPath'
import { join } from 'node:path'
import type { AppContext } from '../../context'

function deriveTitle(prompt: string): string {
  const clean = prompt.replace(/\s+/g, ' ').trim()
  return clean.length > 72 ? `${clean.slice(0, 69).trimEnd()}…` : clean || 'Untitled job'
}

function summarizeSession(s: WorkerSession): WorkerSessionSummary {
  return {
    sessionId: s.sessionId,
    workerId: s.workerId,
    parentSessionId: s.parentSessionId,
    title: s.title,
    status: s.status,
    depth: s.depth,
    summary: s.summary,
    diffStats: s.diffStats,
  }
}

export function jobHandlers(ctx: AppContext): Handlers {
  const log = ctx.log('orchestration')

  const detail = (job: AutomationJob): JobDetail => {
    return {
      job,
      project: ctx.repos.jobs.projectOf(job),
      loops: ctx.repos.jobs.listLoops(job.id),
      tasks: ctx.repos.jobs.listTasks(job.id),
      workers: ctx.repos.workers.listWorkers(job.id),
      nodes: ctx.repos.jobs.listNodes(job.id),
      edges: ctx.repos.jobs.listEdges(job.id),
      reviews: ctx.repos.jobs.listReviews(job.id),
      pendingApprovals: ctx.repos.jobs.pendingApprovals(job.id),
      plan: ctx.repos.jobs.getPlan(job.id),
    }
  }

  /**
   * Settles a plan approval: closes the approval row, moves the job out of
   * `awaiting_approval`, and emits the event the rest of the app listens to.
   *
   * Shared by `jobs.approvePlan` and `approvals.decide` so that a decision
   * taken from the approval card behaves exactly like the plan bar buttons —
   * deciding through the generic channel alone used to leave the job parked in
   * `awaiting_approval` with no pending approval and nothing left to restart it.
   */
  const decidePlanApproval = (jobId: string, decision: { approve: boolean; note?: string }): void => {
    const pending = ctx.repos.workers.listApprovals('pending').find((a) => a.jobId === jobId && a.kind === 'plan')
    if (pending) ctx.repos.workers.decideApproval(pending.id, decision.approve, decision.note)
    ctx.repos.jobs.update(jobId, {
      ...(decision.approve
        ? { status: 'ready' as const, planApprovedAt: Date.now() }
        : { status: 'draft' as const, statusReason: decision.note ?? 'plan rejected' }),
    })
    ctx.emit('job.plan.approved', {
      jobId,
      message: decision.approve ? 'plan approved' : 'plan rejected',
      severity: decision.approve ? 'info' : 'warn',
      data: { note: decision.note ?? null },
    })
    log.info('plan decision', { jobId, approve: decision.approve })
  }

  /**
   * Directory the approval's git command was going to run in — the worker's
   * own workspace first, then the session directory, then the job workspace.
   */
  const workspaceFor = (approval: Approval): string | null => {
    const worker = approval.workerId ? ctx.repos.workers.getWorker(approval.workerId) : null
    const session = approval.sessionId ? ctx.repos.workers.getSession(approval.sessionId) : null
    const job = approval.jobId ? ctx.repos.jobs.get(approval.jobId) : null
    const dir = worker?.workspacePath || session?.directory || job?.workspacePath || (approval.jobId ? join(ctx.paths.jobs, approval.jobId) : null)
    return dir && isGitRepo(dir) ? dir : null
  }

  return {
    'jobs.list': (args) => {
      const filter = (args[0] ?? {}) as { status?: string[]; limit?: number }
      const jobs = ctx.repos.jobs.list(filter)
      return jobs.map((job): JobListItem => {
        const loop = ctx.repos.jobs.getLoop(job.id, Math.max(job.currentLoop, 1))
        const workers = ctx.repos.workers.listWorkers(job.id)
        return {
          job,
          project: job.projectId ? pickProject(ctx, job.projectId) : null,
          loop,
          counts: {
            workers: workers.length,
            tasks: ctx.repos.jobs.listTasks(job.id).length,
            pendingApprovals: ctx.repos.jobs.pendingApprovals(job.id),
            artifacts: ctx.repos.workers.artifactCount(job.id),
          },
        }
      })
    },

    'jobs.get': (args) => {
      const job = ctx.repos.jobs.get(String(args[0]))
      return job ? detail(job) : null
    },

    'jobs.create': async (args) => {
      const input = args[0] as {
        prompt: string
        projectId?: string | null
        vaultId?: string | null
        loopCount?: number
        routeId?: string | null
        requirePlanApproval?: boolean
        templateId?: string | null
        language?: string
        title?: string
      }
      const prompt = input?.prompt?.trim()
      if (!prompt) throw invalid('prompt is required')

      const cfg = ctx.config.get()
      const language = outputLanguageSchema.safeParse(input.language ?? cfg.general.language)
      if (!language.success) throw invalid(`unsupported output language: ${String(input.language)}`)
      if (input.projectId) {
        const project = ctx.repos.projects.get(input.projectId)
        if (!project) throw notFound('project', input.projectId)
        const status = validateProjectPath(project.path)
        if (status.message) throw invalid(`project "${project.name}" cannot be used: ${status.message}`)
      }

      const job = ctx.repos.jobs.create({
        title: input.title?.trim() || deriveTitle(prompt),
        originalPrompt: prompt,
        projectId: input.projectId ?? null,
        vaultId: input.vaultId ?? cfg.obsidian.defaultVaultId,
        loopCount: Math.min(Math.max(input.loopCount ?? cfg.orchestration.defaultLoopCount, 1), cfg.orchestration.limits.maxLoops),
        routeId: input.routeId ?? cfg.orchestration.defaultRouteId,
        requirePlanApproval: input.requirePlanApproval ?? cfg.orchestration.requirePlanApproval,
        templateId: input.templateId ?? null,
        language: language.data,
        status: 'draft',
      })
      ctx.repos.jobs.createLoop(job.id, 1)
      ctx.emit('job.created', { jobId: job.id, message: `job created: ${job.title}` })
      log.info('job created', { jobId: job.id, loops: job.loopCount })
      return job
    },

    'jobs.update': async (args) => {
      const [id, patch] = args as [string, Partial<AutomationJob>]
      const job = ctx.repos.jobs.get(id)
      if (!job) throw notFound('job', id)
      if (job.status === 'running') throw invalid('cannot edit a running job')
      const next = ctx.repos.jobs.update(id, patch)
      ctx.emit('job.status', { jobId: id, message: `job updated: ${next.title}`, data: { status: next.status } })
      return next
    },

    'jobs.delete': async (args) => {
      const id = String(args[0])
      const job = ctx.repos.jobs.get(id)
      if (!job) return false
      if (job.status === 'running') throw invalid('cancel the job before deleting it')
      const removed = ctx.repos.jobs.delete(id)
      if (removed) ctx.emit('job.cancelled', { jobId: id, message: `job deleted: ${job.title}`, severity: 'warn' })
      return removed
    },

    'jobs.start': async (args) => {
      const id = String(args[0])
      const job = ctx.repos.jobs.get(id)
      if (!job) throw notFound('job', id)
      if (['completed', 'cancelled'].includes(job.status)) throw invalid(`job is ${job.status}`)
      log.info('job started', { jobId: id })
      return ctx.engine.start(id)
    },

    'jobs.pause': async (args) => {
      const id = String(args[0])
      const job = ctx.repos.jobs.get(id)
      if (!job) throw notFound('job', id)
      if (job.status !== 'running') throw invalid(`job is ${job.status}`)
      const next = ctx.repos.jobs.update(id, { status: 'paused', statusReason: 'paused by user' })
      ctx.emit('job.status', { jobId: id, message: 'job paused', severity: 'warn', data: { status: 'paused' } })
      return next
    },

    'jobs.resume': async (args) => {
      const id = String(args[0])
      const job = ctx.repos.jobs.get(id)
      if (!job) throw notFound('job', id)
      if (job.status !== 'paused') throw invalid(`job is ${job.status}`)
      ctx.emit('job.status', { jobId: id, message: 'job resumed', data: { status: 'running' } })
      if (ctx.engine.isRunning(id)) return ctx.repos.jobs.update(id, { status: 'running', statusReason: null })
      return ctx.engine.start(id)
    },

    'jobs.cancel': async (args) => {
      const id = String(args[0])
      const job = ctx.repos.jobs.get(id)
      if (!job) throw notFound('job', id)
      if (job.status === 'completed' || job.status === 'cancelled') return job
      const now = Date.now()
      ctx.engine.cancel(id)
      await ctx.opencode.abortJob(id, 'job cancelled')
      for (const worker of ctx.repos.workers.listWorkers(id)) {
        if (!['succeeded', 'failed', 'aborted', 'timed_out'].includes(worker.status)) {
          ctx.repos.workers.updateWorker(worker.id, { status: 'aborted', statusReason: 'job cancelled', completedAt: now })
        }
      }
      const next = ctx.repos.jobs.update(id, { status: 'cancelled', statusReason: 'cancelled by user', completedAt: now })
      for (const pending of ctx.repos.workers.listApprovals('pending').filter((a) => a.jobId === id)) {
        ctx.repos.workers.decideApproval(pending.id, false, 'job cancelled')
      }
      ctx.emit('job.cancelled', { jobId: id, message: `job cancelled: ${job.title}`, severity: 'warn' })
      return next
    },

    'jobs.approvePlan': async (args) => {
      const [id, decision] = args as [string, { approve: boolean; note?: string }]
      const job = ctx.repos.jobs.get(id)
      if (!job) throw notFound('job', id)
      if (job.status !== 'awaiting_approval') throw invalid(`job is ${job.status}`)
      if (!ctx.repos.jobs.getPlan(id)) throw invalid('no plan has been produced for this job')

      await decidePlanApproval(job.id, decision)
      const next = ctx.repos.jobs.get(id)
      if (!decision.approve || !next) return next ?? job
      try {
        return ctx.engine.start(job.id)
      } catch (err) {
        log.warn('engine did not start after approval', { jobId: job.id, error: String(err) })
        return ctx.repos.jobs.get(job.id) ?? next
      }
    },

    'jobs.rerunLoop': async (args) => {
      const [id, loopIndex] = args as [string, number]
      const job = ctx.repos.jobs.get(id)
      if (!job) throw notFound('job', id)
      if (job.status === 'running' || ctx.engine.isRunning(id)) throw invalid('job is running')
      const loop = ctx.repos.jobs.getLoop(id, loopIndex)
      if (!loop) throw notFound('loop', String(loopIndex))

      const plan = ctx.repos.jobs.getPlan(id)
      const tasks = plan ? ctx.repos.jobs.listTasks(id, loopIndex) : []
      for (const task of tasks) {
        const root = task.dependencyIds.length === 0
        ctx.repos.jobs.updateTask(task.id, {
          status: root ? 'ready' : 'pending',
          attempt: 0,
          error: null,
          statusReason: null,
          startedAt: null,
          completedAt: null,
        })
        if (task.nodeId) ctx.repos.jobs.updateNodeState(id, task.nodeId, root ? 'ready' : 'pending', task.id)
      }

      ctx.repos.jobs.updateLoop(id, loopIndex, { status: 'planning', verdict: 'pending', completedAt: null })
      const patch: Partial<AutomationJob> = { currentLoop: loopIndex, status: 'ready', statusReason: null, completedAt: null }
      // The plan already ran once, so treat it as approved to stop the engine from re-planning (and wiping) the tasks.
      if (tasks.length > 0 && !job.planApprovedAt && !job.requirePlanApproval) patch.planApprovedAt = Date.now()
      ctx.repos.jobs.update(id, patch)
      ctx.emit('loop.started', { jobId: id, message: `loop ${loopIndex} queued for re-run` })
      return ctx.engine.start(id)
    },

    'jobs.finalResult': (args) => {
      const id = String(args[0])
      const job = ctx.repos.jobs.get(id)
      if (!job) return null
      const artifacts = ctx.repos.workers.listArtifacts(id)
      const synthesis = artifacts.find((a) => a.kind === 'review_report' || a.kind === 'response') ?? null
      const reviews = ctx.repos.jobs.listReviews(id)
      const finalReview = reviews.find((r) => r.kind === 'final') ?? null
      const unresolved = ctx.repos.jobs.listLoops(id).flatMap((l) => l.unresolved)
      if (!synthesis && !finalReview) return null
      return {
        summary: synthesis?.content ?? finalReview?.summary ?? job.statusReason ?? '',
        artifacts,
        reviews,
        unresolved: [...new Set(unresolved)],
      }
    },

    /* tasks ------------------------------------------------------------------ */

    'tasks.get': (args) => ctx.repos.jobs.getTask(String(args[0])),

    'tasks.update': async (args) => {
      const [id, patch] = args as [string, Partial<Task>]
      const task = ctx.repos.jobs.getTask(id)
      if (!task) throw notFound('task', id)
      const next = ctx.repos.jobs.updateTask(id, patch)
      ctx.emit('task.updated', { jobId: task.jobId, taskId: id, message: `task ${task.title}: ${next.status}` })
      return next
    },

    'tasks.retry': async (args) => {
      const id = String(args[0])
      const task = ctx.repos.jobs.getTask(id)
      if (!task) throw notFound('task', id)
      if (!['failed', 'timed_out', 'cancelled', 'skipped'].includes(task.status)) throw invalid(`task is ${task.status}`)
      const next = ctx.repos.jobs.updateTask(id, { status: 'ready', statusReason: null, error: null, completedAt: null })
      ctx.emit('task.updated', { jobId: task.jobId, taskId: id, message: `task re-queued: ${task.title}` })
      return next
    },

    'tasks.skip': async (args) => {
      const id = String(args[0])
      const task = ctx.repos.jobs.getTask(id)
      if (!task) throw notFound('task', id)
      const next = ctx.repos.jobs.updateTask(id, { status: 'skipped', statusReason: 'skipped by user', completedAt: Date.now() })
      ctx.emit('task.updated', { jobId: task.jobId, taskId: id, message: `task skipped: ${task.title}`, severity: 'warn' })
      return next
    },

    /* workers ---------------------------------------------------------------- */

    'workers.get': async (args) => {
      const id = String(args[0])
      const worker = ctx.repos.workers.getWorker(id)
      if (!worker) return null
      const sessions = ctx.repos.workers.listSessions(worker.jobId)
      const own = sessions.filter((s) => s.workerId === id || (worker.sessionId !== null && s.sessionId === worker.sessionId))
      const ownIds = new Set(own.map((s) => s.sessionId))
      const childSessions = sessions.filter(
        (s) => s.parentSessionId !== null && s.parentSessionId === worker.sessionId && !ownIds.has(s.sessionId),
      )
      const detail: WorkerDetail = {
        worker,
        sessions: own.map(summarizeSession),
        childSessions: childSessions.map(summarizeSession),
        children: ctx.repos.workers.children(id),
        artifacts: ctx.repos.workers.listArtifacts(worker.jobId).filter((a) => a.workerId === id),
        transcript: await ctx.opencode.transcriptFor(id),
      }
      return detail
    },

    'workers.transcript': async (args) => ctx.opencode.transcriptFor(String(args[0])),

    'workers.abort': async (args) => {
      const id = String(args[0])
      const worker = ctx.repos.workers.getWorker(id)
      if (!worker) throw notFound('worker', id)
      if (['succeeded', 'failed', 'aborted', 'timed_out'].includes(worker.status)) throw invalid(`worker is ${worker.status}`)
      await ctx.opencode.abort(id, 'aborted by user')
      return true
    },

    'workers.retry': async (args) => {
      const id = String(args[0])
      const worker = ctx.repos.workers.getWorker(id)
      if (!worker) throw notFound('worker', id)
      if (!['failed', 'timed_out', 'aborted', 'orphaned'].includes(worker.status)) throw invalid(`worker is ${worker.status}`)
      ctx.repos.workers.updateWorker(id, {
        status: 'queued',
        statusReason: null,
        error: null,
        queuedAt: Date.now(),
        startedAt: null,
        completedAt: null,
      })
      ctx.emit('worker.queued', { jobId: worker.jobId, workerId: id, message: `worker re-queued: ${worker.name}` })
      return ctx.opencode.retry(id)
    },

    /* approvals --------------------------------------------------------------- */

    'approvals.list': (args) => {
      const opts = (args[0] ?? {}) as { status?: 'pending' | 'all' }
      return ctx.repos.workers.listApprovals(opts.status ?? 'pending')
    },

    'approvals.decide': async (args) => {
      const [id, decision] = args as [string, { approve: boolean; note?: string }]
      const approval = ctx.repos.workers.getApproval(id)
      if (!approval) throw notFound('approval', id)
      if (approval.status !== 'pending') throw invalid(`approval already ${approval.status}`)

      if (approval.kind === 'plan' && approval.jobId) {
        // Same path as the plan bar — otherwise the job stays parked in
        // `awaiting_approval` with no pending approval and nothing to restart it.
        const jobId = approval.jobId
        decidePlanApproval(jobId, decision)
        ctx.emit('approval.resolved', {
          jobId,
          workerId: approval.workerId,
          message: `plan ${decision.approve ? 'approved' : 'denied'}`,
          severity: decision.approve ? 'info' : 'warn',
          data: { approvalId: id, note: decision.note ?? null, delivered: true },
        })
        if (decision.approve) {
          try {
            ctx.engine.start(jobId)
          } catch (err) {
            log.warn('engine did not start after plan approval', { jobId, error: String(err) })
          }
        }
        return { approval: ctx.repos.workers.getApproval(id) ?? approval, delivered: true }
      }

      const next = ctx.repos.workers.decideApproval(id, decision.approve, decision.note)
      // Only permission gates have an OpenCode prompt to answer; report honestly
      // whether the reply actually reached the waiting session.
      const delivered = approval.opencodePermissionId
        ? await ctx.opencode.decidePermission(id, decision.approve, decision.note)
        : true
      if (!delivered) {
        log.warn('approval decision could not be delivered to OpenCode', { approvalId: id })
      }
      ctx.emit('approval.resolved', {
        jobId: approval.jobId,
        workerId: approval.workerId,
        message: `${approval.kind} ${decision.approve ? 'approved' : 'denied'}`,
        severity: decision.approve ? 'info' : 'warn',
        data: { approvalId: id, note: decision.note ?? null, delivered },
      })
      log.info('approval decided', { approvalId: id, approve: decision.approve, delivered })
      return { approval: next ?? approval, delivered }
    },

    'approvals.diff': async (args) => {
      const id = String(args[0])
      const approval = ctx.repos.workers.getApproval(id)
      if (!approval) throw notFound('approval', id)
      const cached = ctx.repos.workers.getApprovalDiff(id)
      const files = ((approval.payload.files as { path: string; additions: number; deletions: number }[] | undefined) ?? []).map(
        (f) => ({ path: f.path, additions: f.additions, deletions: f.deletions }),
      )
      if (cached.trim() || files.length > 0) return { raw: cached, files }

      // Nothing stored yet: compute it from the workspace the git command was
      // about to touch, so the reviewer sees the real pending change instead of
      // an empty panel.
      const dir = workspaceFor(approval)
      if (!dir) return { raw: '', files: [] }
      try {
        const computed =
          approval.kind === 'git_push'
            ? ((await diffAgainstUpstream(dir)) ?? (await diffSummary(dir, true)))
            : await diffSummary(dir, true)
        ctx.repos.workers.setApprovalDiff(id, computed.raw)
        const listed = computed.files.map((f) => ({ path: f.path, additions: f.additions, deletions: f.deletions }))
        if (listed.length === 0) {
          // A pure add-file change has no diff text until it is staged, so fall
          // back to the untracked list rather than showing an empty panel.
          const st = await gitStatus(dir)
          return { raw: computed.raw, files: st.untracked.map((p) => ({ path: p, additions: 0, deletions: 0 })) }
        }
        return { raw: computed.raw, files: listed }
      } catch (err) {
        log.warn('approval diff failed', { approvalId: id, error: String(err) })
        return { raw: '', files: [] }
      }
    },
  }
}

function pickProject(ctx: AppContext, projectId: string): { id: string; name: string } | null {
  const project = ctx.repos.projects.get(projectId)
  return project ? { id: project.id, name: project.name } : null
}
