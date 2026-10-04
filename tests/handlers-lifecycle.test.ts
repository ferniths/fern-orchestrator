import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { createCoreContext, type AppContext } from '@core/kernel/appContext'
import { AppError } from '@core/kernel/errors'
import { git } from '@core/services/git'
import type { AutomationJob, StatsSnapshot } from '@shared/domain'
import { appHandlers } from '../src/main/ipc/handlers/app'
import { jobHandlers } from '../src/main/ipc/handlers/jobs'

vi.mock('electron', () => ({
  app: { getName: () => 'fern-test', getVersion: () => '0.0.0', getLocale: () => 'en-US' },
  dialog: { showOpenDialog: async () => ({ canceled: true, filePaths: [] }) },
  shell: { openPath: async () => '', showItemInFolder: () => undefined, openExternal: async () => undefined },
}))

type ApprovePlan = (args: [string, { approve: boolean; note?: string }]) => Promise<AutomationJob>
type CancelJob = (args: [string]) => Promise<AutomationJob>
type RerunLoop = (args: [string, number]) => Promise<AutomationJob>
type StatsUsage = (args: [{ jobId?: string; days?: number }?]) => {
  byModel: { modelId: string; providerId: string; input: number; output: number; cost: number; calls: number }[]
  total: { input: number; output: number; cost: number }
}

let ctx: AppContext
let dataDir: string
let handlers: ReturnType<typeof jobHandlers>

beforeAll(async () => {
  dataDir = await mkdtemp(join(tmpdir(), 'fern-life-'))
  ctx = await createCoreContext({ dataDir, consoleLogs: false })
  handlers = jobHandlers(ctx)
})

afterAll(async () => {
  await ctx.shutdown()
  await rm(dataDir, { recursive: true, force: true })
})

function createJob(fields: { status?: AutomationJob['status']; requirePlanApproval?: boolean; title?: string } = {}): AutomationJob {
  return ctx.repos.jobs.create({
    title: fields.title ?? 'lifecycle job',
    originalPrompt: 'do the thing',
    projectId: null,
    vaultId: null,
    loopCount: 1,
    routeId: null,
    templateId: null,
    requirePlanApproval: fields.requirePlanApproval ?? false,
    status: fields.status ?? 'draft',
  })
}

async function expectInvalid(promise: Promise<unknown>, match: RegExp): Promise<void> {
  let caught: unknown
  try {
    await promise
  } catch (err) {
    caught = err
  }
  expect(caught).toBeInstanceOf(AppError)
  expect((caught as AppError).code).toBe('invalid_argument')
  expect((caught as AppError).message).toMatch(match)
}

/* -------------------------------------------------------------------------- */
/* jobs.approvePlan                                                           */
/* -------------------------------------------------------------------------- */

describe('jobs.approvePlan', () => {
  it('refuses to resurrect a cancelled job', async () => {
    const job = createJob({ status: 'cancelled', requirePlanApproval: true, title: 'cancelled approve' })
    ctx.repos.jobs.setPlan(job.id, { text: 'plan', data: {} })

    const approvePlan = handlers['jobs.approvePlan'] as ApprovePlan
    await expectInvalid(approvePlan([job.id, { approve: true }]), /job is cancelled/)
    expect(ctx.repos.jobs.get(job.id)!.status).toBe('cancelled')
  })

  it('refuses the deny path for a job that is not awaiting approval', async () => {
    const job = createJob({ status: 'completed', requirePlanApproval: true, title: 'completed deny' })
    ctx.repos.jobs.setPlan(job.id, { text: 'plan', data: {} })

    const approvePlan = handlers['jobs.approvePlan'] as ApprovePlan
    await expectInvalid(approvePlan([job.id, { approve: false }]), /job is completed/)
    expect(ctx.repos.jobs.get(job.id)!.status).toBe('completed')
  })

  it('approves from awaiting_approval, resolves the gate and starts the engine', async () => {
    const job = createJob({ status: 'awaiting_approval', requirePlanApproval: true, title: 'approve path' })
    ctx.repos.jobs.setPlan(job.id, { text: 'plan', data: { steps: [] } })
    const approval = ctx.repos.workers.createApproval({ kind: 'plan', title: 'Plan approval', jobId: job.id })

    const approvePlan = handlers['jobs.approvePlan'] as ApprovePlan
    const started = await approvePlan([job.id, { approve: true, note: 'lgtm' }])

    expect(started.id).toBe(job.id)
    expect(started.status).toBe('refining')
    const decided = ctx.repos.workers.getApproval(approval.id)!
    expect(decided.status).toBe('approved')
    expect(decided.decisionNote).toBe('lgtm')
    const after = ctx.repos.jobs.get(job.id)!
    expect(after.planApprovedAt).toBeGreaterThan(0)
    expect(after.status).not.toBe('awaiting_approval')
  })

  it('denies from awaiting_approval and returns the job to draft', async () => {
    const job = createJob({ status: 'awaiting_approval', requirePlanApproval: true, title: 'deny path' })
    ctx.repos.jobs.setPlan(job.id, { text: 'plan', data: {} })
    const approval = ctx.repos.workers.createApproval({ kind: 'plan', title: 'Plan approval', jobId: job.id })

    const approvePlan = handlers['jobs.approvePlan'] as ApprovePlan
    const rejected = await approvePlan([job.id, { approve: false, note: 'too risky' }])

    expect(rejected.status).toBe('draft')
    expect(ctx.repos.workers.getApproval(approval.id)!.status).toBe('denied')
    expect(ctx.repos.jobs.get(job.id)!.planApprovedAt).toBeNull()
  })
})

/* -------------------------------------------------------------------------- */
/* approvals.decide                                                           */
/* -------------------------------------------------------------------------- */

type Decide = (args: [string, { approve: boolean; note?: string }]) => Promise<{ approval: { status: string }; delivered: boolean }>

describe('approvals.decide', () => {
  it('settles a plan approval the same way the plan bar does (deny returns to draft)', async () => {
    const job = createJob({ status: 'awaiting_approval', requirePlanApproval: true, title: 'card deny path' })
    ctx.repos.jobs.setPlan(job.id, { text: 'plan', data: {} })
    const approval = ctx.repos.workers.createApproval({ kind: 'plan', title: 'Plan approval', jobId: job.id })

    const decide = handlers['approvals.decide'] as Decide
    const res = await decide([approval.id, { approve: false, note: 'nope' }])

    expect(res.delivered).toBe(true)
    expect(res.approval.status).toBe('denied')
    // Before this, the card path decided the approval but left the job parked
    // in awaiting_approval with nothing left to restart it.
    expect(ctx.repos.jobs.get(job.id)!.status).toBe('draft')
    expect(ctx.repos.workers.listApprovals('pending').some((a) => a.id === approval.id)).toBe(false)
  })

  it('moves an approved plan out of awaiting_approval', async () => {
    const job = createJob({ status: 'awaiting_approval', requirePlanApproval: true, title: 'card approve path' })
    ctx.repos.jobs.setPlan(job.id, { text: 'plan', data: { steps: [] } })
    const approval = ctx.repos.workers.createApproval({ kind: 'plan', title: 'Plan approval', jobId: job.id })

    const decide = handlers['approvals.decide'] as Decide
    const res = await decide([approval.id, { approve: true }])

    expect(res.delivered).toBe(true)
    expect(res.approval.status).toBe('approved')
    const after = ctx.repos.jobs.get(job.id)!
    expect(after.status).not.toBe('awaiting_approval')
    expect(after.planApprovedAt).toBeGreaterThan(0)
    await ctx.engine.cancel(job.id)
  })

  it('reports a permission decision that never reached OpenCode', async () => {
    const job = createJob({ title: 'undeliverable decision' })
    const approval = ctx.repos.workers.createApproval({
      kind: 'git_commit',
      title: 'Commit needs approval',
      detail: 'git commit -m wip',
      jobId: job.id,
      workerId: null,
      sessionId: null,
      opencodePermissionId: 'per_missing_session',
    })

    const decide = handlers['approvals.decide'] as Decide
    const res = await decide([approval.id, { approve: true }])

    // The row is decided either way, but the UI is told the truth: no session
    // was listening, so nothing was delivered.
    expect(res.approval.status).toBe('approved')
    expect(res.delivered).toBe(false)
  })
})

/* -------------------------------------------------------------------------- */
/* approvals.diff                                                             */
/* -------------------------------------------------------------------------- */

type Diff = (args: [string]) => Promise<{ raw: string; files: { path: string; additions: number; deletions: number }[] }>

describe('approvals.diff', () => {
  it('computes the real staged diff from the job workspace and caches it', async () => {
    const repo = await mkdtemp(join(tmpdir(), 'fern-appr-diff-'))
    try {
      await git(['init', '-q'], { cwd: repo })
      await git(['config', 'user.email', 'diff@example.com'], { cwd: repo })
      await git(['config', 'user.name', 'diff'], { cwd: repo })
      await writeFile(join(repo, 'file.txt'), 'first line\n')
      await git(['add', '-A'], { cwd: repo })
      await git(['commit', '-qm', 'base'], { cwd: repo })
      await writeFile(join(repo, 'file.txt'), 'first line\nsecond line\n')
      await git(['add', '-A'], { cwd: repo })

      const job = createJob({ title: 'diff job' })
      ctx.repos.jobs.setWorkspace(job.id, repo)
      const approval = ctx.repos.workers.createApproval({
        kind: 'git_commit',
        title: 'Commit 1 file',
        detail: 'git commit -m wip',
        jobId: job.id,
      })

      const diff = await (handlers['approvals.diff'] as Diff)([approval.id])

      expect(diff.raw).toContain('second line')
      expect(diff.files.map((f) => f.path)).toContain('file.txt')
      expect(diff.files[0]!.additions).toBeGreaterThan(0)
      // Persisted, so the panel still works after the workspace is cleaned up.
      expect(ctx.repos.workers.getApprovalDiff(approval.id)).toBe(diff.raw)

      // Second call is served from the stored diff rather than recomputed.
      const again = await (handlers['approvals.diff'] as Diff)([approval.id])
      expect(again.raw).toBe(diff.raw)
    } finally {
      await rm(repo, { recursive: true, force: true })
    }
  })
})

/* -------------------------------------------------------------------------- */
/* jobs.cancel                                                                */
/* -------------------------------------------------------------------------- */

describe('jobs.cancel', () => {
  it('denies the pending approvals of the cancelled job', async () => {
    const job = createJob({ status: 'awaiting_approval', requirePlanApproval: true, title: 'cancel approvals' })
    ctx.repos.jobs.setPlan(job.id, { text: 'plan', data: {} })
    const planApproval = ctx.repos.workers.createApproval({ kind: 'plan', title: 'Plan approval', jobId: job.id })
    const gitApproval = ctx.repos.workers.createApproval({ kind: 'git_commit', title: 'Commit 3 files', jobId: job.id })
    const unrelated = ctx.repos.workers.createApproval({ kind: 'git_commit', title: 'Unrelated commit', jobId: null })

    const cancel = handlers['jobs.cancel'] as CancelJob
    const cancelled = await cancel([job.id])

    expect(cancelled.status).toBe('cancelled')
    const plan = ctx.repos.workers.getApproval(planApproval.id)!
    expect(plan.status).toBe('denied')
    expect(plan.decisionNote).toBe('job cancelled')
    expect(ctx.repos.workers.getApproval(gitApproval.id)!.status).toBe('denied')
    expect(ctx.repos.workers.getApproval(unrelated.id)!.status).toBe('pending')

    const approvePlan = handlers['jobs.approvePlan'] as ApprovePlan
    await expectInvalid(approvePlan([job.id, { approve: true }]), /job is cancelled/)
  })
})

/* -------------------------------------------------------------------------- */
/* jobs.rerunLoop                                                             */
/* -------------------------------------------------------------------------- */

describe('jobs.rerunLoop', () => {
  it('resets the existing plan tasks and restarts the engine on them', async () => {
    const job = createJob({ status: 'completed', title: 'rerun target' })
    ctx.repos.jobs.setPlan(job.id, { text: 'plan', data: { steps: [] } })
    ctx.repos.jobs.createLoop(job.id, 1)
    const root = ctx.repos.jobs.createTask({
      jobId: job.id,
      loopIndex: 1,
      title: 'Root step',
      role: 'coder',
      status: 'succeeded',
      attempt: 2,
      error: 'boom',
      statusReason: 'done',
      startedAt: 1_000,
      completedAt: 2_000,
    })
    const child = ctx.repos.jobs.createTask({
      jobId: job.id,
      loopIndex: 1,
      title: 'Child step',
      role: 'coder',
      dependencyIds: [root.id],
      status: 'failed',
      attempt: 1,
      error: 'nope',
      statusReason: 'failed',
      startedAt: 1_000,
      completedAt: 2_000,
    })
    ctx.repos.jobs.updateLoop(job.id, 1, { status: 'completed', verdict: 'pass', completedAt: 3_000 })

    const rerunLoop = handlers['jobs.rerunLoop'] as RerunLoop
    const restarted = await rerunLoop([job.id, 1])

    expect(restarted.status).toBe('refining')

    const tasks = ctx.repos.jobs.listTasks(job.id, 1)
    const reloadedRoot = tasks.find((t) => t.id === root.id)!
    const reloadedChild = tasks.find((t) => t.id === child.id)!
    expect(reloadedRoot.status).toBe('ready')
    expect(reloadedRoot.attempt).toBe(0)
    expect(reloadedRoot.error).toBeNull()
    expect(reloadedRoot.statusReason).toBeNull()
    expect(reloadedRoot.startedAt).toBeNull()
    expect(reloadedRoot.completedAt).toBeNull()
    expect(reloadedChild.status).toBe('pending')
    expect(reloadedChild.attempt).toBe(0)
    expect(reloadedChild.error).toBeNull()
    expect(reloadedChild.statusReason).toBeNull()
    expect(reloadedChild.startedAt).toBeNull()
    expect(reloadedChild.completedAt).toBeNull()

    const loop = ctx.repos.jobs.getLoop(job.id, 1)!
    expect(loop.status).toBe('planning')
    expect(loop.verdict).toBe('pending')
    expect(loop.completedAt).toBeNull()

    const after = ctx.repos.jobs.get(job.id)!
    expect(after.currentLoop).toBe(1)
    expect(after.planApprovedAt).toBeGreaterThan(0)
  })

  it('refuses to rerun while the job is running', async () => {
    const job = createJob({ status: 'running', title: 'busy rerun' })
    const rerunLoop = handlers['jobs.rerunLoop'] as RerunLoop
    await expectInvalid(rerunLoop([job.id, 1]), /job is running/)
  })
})

/* -------------------------------------------------------------------------- */
/* stats handlers                                                             */
/* -------------------------------------------------------------------------- */

describe('stats handlers', () => {
  it('reports the live opencode server and session counts', () => {
    const job = createJob({ title: 'stats target' })
    const worker = ctx.repos.workers.createWorker({
      jobId: job.id,
      taskId: 'tsk_stats_1',
      name: 'stats worker',
      role: 'coder',
      loopIndex: 1,
      status: 'running',
    })

    const snapshot = (appHandlers(ctx)['stats.snapshot'] as () => StatsSnapshot)()
    expect(snapshot.opencode.servers).toBe(0)
    expect(snapshot.opencode.sessions).toBe(1)
    expect(snapshot.opencode.sessions).toBe(ctx.repos.workers.countByStatus().running)

    ctx.repos.workers.updateWorker(worker.id, { status: 'aborted', completedAt: Date.now() })
  })

  it('filters usage rows by the requested days window', () => {
    const usage = appHandlers(ctx)['stats.usage'] as StatsUsage
    ctx.repos.workers.recordUsage({
      jobId: null,
      taskId: null,
      workerId: null,
      providerId: 'p1',
      modelId: 'recent-model',
      inputTokens: 100,
      outputTokens: 10,
      costUsd: 0.5,
      at: Date.now(),
    })
    ctx.repos.workers.recordUsage({
      jobId: null,
      taskId: null,
      workerId: null,
      providerId: 'p1',
      modelId: 'stale-model',
      inputTokens: 1_000,
      outputTokens: 100,
      costUsd: 5,
      at: Date.now() - 40 * 86_400_000,
    })

    const last30 = usage([{ days: 30 }])
    expect(last30.total.input).toBe(100)
    expect(last30.total.output).toBe(10)
    expect(last30.total.cost).toBe(0.5)
    expect(last30.byModel.some((m) => m.modelId === 'recent-model')).toBe(true)
    expect(last30.byModel.some((m) => m.modelId === 'stale-model')).toBe(false)

    const all = usage([{}])
    expect(all.total.input).toBe(1_100)
    expect(all.byModel.find((m) => m.modelId === 'stale-model')?.input).toBe(1_000)
  })
})

/* -------------------------------------------------------------------------- */
/* boot reconciliation                                                        */
/* -------------------------------------------------------------------------- */

describe('boot reconciliation', () => {
  it('orphans stale workers and pauses stale jobs left behind by an unclean exit', async () => {
    const staleDir = await mkdtemp(join(tmpdir(), 'fern-recon-'))
    const first = await createCoreContext({ dataDir: staleDir, consoleLogs: false })

    const runningJob = first.repos.jobs.create({
      title: 'stuck running job',
      originalPrompt: 'was mid-flight',
      status: 'running',
    })
    const awaitingJob = first.repos.jobs.create({
      title: 'stuck awaiting job',
      originalPrompt: 'was gated',
      status: 'awaiting_approval',
      requirePlanApproval: true,
    })
    const finishedJob = first.repos.jobs.create({
      title: 'finished job',
      originalPrompt: 'done',
      status: 'completed',
    })
    const runningWorker = first.repos.workers.createWorker({
      jobId: runningJob.id,
      taskId: 'tsk_stale_1',
      name: 'stale running worker',
      role: 'coder',
      loopIndex: 1,
      status: 'running',
    })
    const queuedWorker = first.repos.workers.createWorker({
      jobId: runningJob.id,
      taskId: 'tsk_stale_2',
      name: 'stale queued worker',
      role: 'coder',
      loopIndex: 1,
      status: 'queued',
    })
    await first.shutdown()

    const second = await createCoreContext({ dataDir: staleDir, consoleLogs: false })

    const reloadedRunning = second.repos.jobs.get(runningJob.id)!
    expect(reloadedRunning.status).toBe('paused')
    expect(reloadedRunning.statusReason).toBe('interrupted — resume to continue')
    expect(second.repos.jobs.get(awaitingJob.id)!.status).toBe('paused')
    expect(second.repos.jobs.get(finishedJob.id)!.status).toBe('completed')

    const reloadedRunningWorker = second.repos.workers.getWorker(runningWorker.id)!
    expect(reloadedRunningWorker.status).toBe('orphaned')
    expect(reloadedRunningWorker.statusReason).toBe('recovered after restart')
    expect(reloadedRunningWorker.completedAt).toBeGreaterThan(0)
    expect(second.repos.workers.getWorker(queuedWorker.id)!.status).toBe('orphaned')

    await second.shutdown()
    await rm(staleDir, { recursive: true, force: true })
  })
})
