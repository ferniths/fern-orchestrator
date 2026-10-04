import { randomBytes } from 'node:crypto'
import { mkdir, rm, rmdir, stat } from 'node:fs/promises'
import { join, sep } from 'node:path'
import type { ModelInfo } from '@shared/domain'
import type { HarnessSelfTestEvidence, HarnessSelfTestInvariants, HarnessSelfTestReport, HarnessSelfTestStep } from '@shared/ipc'
import type { AppContext } from '../kernel/appContext'
import { AppError } from '../kernel/errors'
import { EVENTS } from '../kernel/eventBus'
import { fetchModels } from '../ai/models'
import { detectOpencode } from '../platform/binaries'
import { WORKER_TERMINAL, purgeTempJob, runHealthCheck } from './harnessHealth'
import { isTaskTerminal } from './scheduler'
export const DEFAULT_SELF_TEST_TIMEOUT_MS = 45_000

const SANDBOX_ROOT_NAME = 'harness-selftest'
const JOB_TERMINAL = new Set(['completed', 'failed', 'cancelled'])

export interface SelfTestRunOptions {
  mode?: 'diagnostics' | 'selfTest'
  timeoutMs?: number
  signal?: AbortSignal
  /** Test hook: invoked after evidence is gathered and before cleanup so callers can inspect the live sandbox and rows. */
  onEvidence?: (evidence: HarnessSelfTestEvidence) => void | Promise<void>
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function isFile(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile()
  } catch {
    return false
  }
}

/**
 * Runs the harness self-test.
 *
 * - `diagnostics`: component health checks only (fast, no pipeline).
 * - `selfTest`: prerequisite gates, then the REAL engine pipeline
 *   (refine → plan → workers → integrate → review) inside an isolated sandbox,
 *   verified against four invariants, then fully cleaned up. Missing
 *   prerequisites report `skipped` with the exact actionable message — never a
 *   pass, never a fake run.
 */
export async function runSelfTest(ctx: AppContext, opts: SelfTestRunOptions = {}): Promise<HarnessSelfTestReport> {
  const mode = opts.mode ?? 'selfTest'
  const startedAt = Date.now()
  const steps: HarnessSelfTestStep[] = []
  const report: HarnessSelfTestReport = {
    mode,
    status: 'fail',
    reason: '',
    startedAt,
    durationMs: 0,
    steps,
    invariants: null,
    evidence: null,
    sandboxPath: null,
  }

  if (mode === 'diagnostics') {
    const health = await runHealthCheck(ctx, opts.signal ? { signal: opts.signal } : {})
    for (const component of health.components) steps.push({ name: component.name, status: component.status, reason: component.reason })
    const failed = health.components.filter((c) => c.status === 'fail')
    const skipped = health.components.filter((c) => c.status === 'skipped')
    report.status = failed.length ? 'fail' : skipped.length ? 'skipped' : 'pass'
    report.reason = failed.length
      ? `${failed.length}/${health.components.length} component(s) failed: ${failed.map((c) => `${c.name}: ${c.reason}`).join('; ')}`
      : skipped.length
        ? `${skipped.length}/${health.components.length} component(s) skipped: ${skipped.map((c) => `${c.name}: ${c.reason}`).join('; ')}`
        : `all ${health.components.length} components passed`
    report.durationMs = Date.now() - startedAt
    return report
  }

  const timeoutMs = opts.timeoutMs && opts.timeoutMs > 0 ? opts.timeoutMs : DEFAULT_SELF_TEST_TIMEOUT_MS
  const runId = `${startedAt.toString(36)}-${randomBytes(3).toString('hex')}`
  const sandbox = join(ctx.paths.root, SANDBOX_ROOT_NAME, `selftest-${runId}`)
  let jobId: string | null = null
  let cleanupError: string | null = null
  const unsubscribe: (() => void)[] = []

  const skip = (stepName: string, reason: string): HarnessSelfTestReport => {
    steps.push({ name: stepName, status: 'skipped', reason })
    report.status = 'skipped'
    report.reason = reason
    return report
  }

  try {
    if (opts.signal?.aborted) return skip('prerequisites', 'cancelled before the self-test started')

    /* prerequisite: a model provider that actually answers ---------------- */
    const enabled = ctx.repos.providers.listProviders().filter((p) => p.enabled)
    if (enabled.length === 0) return skip('providers', 'no model provider configured — add one under Providers')

    const catalog = new Map<string, ModelInfo[]>()
    const unreachable: string[] = []
    for (const provider of enabled) {
      try {
        const key = provider.apiKeyRef ? ctx.keystore.get(provider.apiKeyRef) : null
        const { models } = await fetchModels({ ...provider, timeoutMs: Math.min(provider.timeoutMs, 5_000) }, key)
        catalog.set(provider.id, models)
      } catch (err) {
        unreachable.push(`${provider.name}: ${AppError.from(err, 'provider_error').message}`)
      }
    }
    if (catalog.size === 0) return skip('providers', `provider unreachable — ${unreachable.join('; ')}`)
    steps.push({
      name: 'providers',
      status: 'pass',
      reason: `${catalog.size}/${enabled.length} provider(s) reachable${unreachable.length ? `; unreachable: ${unreachable.join('; ')}` : ''}`,
    })

    /* prerequisite: an OpenCode binary or an explicitly manual server ------ */
    const cfg = ctx.config.get()
    if (!cfg.opencode.autoStart) {
      return skip(
        'opencode',
        'OpenCode auto-start is off — start a server for this workspace on the OpenCode page, or enable "Auto-start servers" in Settings → OpenCode',
      )
    }
    const detected = await detectOpencode(ctx.opencode.startOptions?.binaryPath ?? cfg.opencode.binaryPath)
    if (!detected.path) return skip('opencode', 'OpenCode binary not found — install opencode or set its path in Settings → OpenCode')
    steps.push({ name: 'opencode', status: 'pass', reason: `binary ${detected.path} (${detected.source})` })

    if (opts.signal?.aborted) return skip('pipeline', 'cancelled before the pipeline started')

    /* sandbox + job ------------------------------------------------------- */
    const workspace = join(sandbox, 'workspace')
    await mkdir(workspace, { recursive: true })
    report.sandboxPath = sandbox

    const job = ctx.repos.jobs.create({
      title: 'harness self-test',
      originalPrompt:
        'Harness self-test run. Create a file named self-test-output.md in the workspace containing a short summary, then finish.',
      status: 'draft',
      projectId: null,
      vaultId: null,
      loopCount: 1,
      routeId: null,
      requirePlanApproval: false,
      templateId: null,
    })
    jobId = job.id
    ctx.repos.jobs.setWorkspace(jobId, workspace)

    const events = { started: 0, completed: 0, failed: 0 }
    const trackedJob = jobId
    unsubscribe.push(
      ctx.events.subscribeType(EVENTS.TASK_STARTED, (e) => {
        if (e.jobId === trackedJob) events.started += 1
      }),
      ctx.events.subscribeType(EVENTS.TASK_COMPLETED, (e) => {
        if (e.jobId === trackedJob) events.completed += 1
      }),
      ctx.events.subscribeType(EVENTS.TASK_FAILED, (e) => {
        if (e.jobId === trackedJob) events.failed += 1
      }),
    )

    /* run the real pipeline ------------------------------------------------ */
    try {
      ctx.engine.start(jobId)
    } catch (err) {
      const reason = `engine refused to start: ${AppError.from(err).message}`
      steps.push({ name: 'pipeline', status: 'fail', reason })
      report.status = 'fail'
      report.reason = reason
      return report
    }

    const deadline = Date.now() + timeoutMs
    let jobStatus = ''
    let timedOut = false
    let cancelled = false
    for (;;) {
      if (opts.signal?.aborted) {
        cancelled = true
        break
      }
      const current = ctx.repos.jobs.get(jobId)
      jobStatus = current?.status ?? 'missing'
      if (JOB_TERMINAL.has(jobStatus)) break
      if (Date.now() >= deadline) {
        timedOut = true
        break
      }
      await sleep(100)
    }

    if (timedOut || cancelled) {
      // Never a pass: stop the run honestly and say why.
      ctx.engine.cancel(jobId)
      await ctx.opencode.abortJob(jobId, 'harness self-test stopped')
      const now = Date.now()
      for (const worker of ctx.repos.workers.listWorkers(jobId)) {
        if (!WORKER_TERMINAL.has(worker.status)) {
          ctx.repos.workers.updateWorker(worker.id, { status: 'aborted', statusReason: 'self-test stopped', completedAt: now })
        }
      }
      ctx.repos.jobs.update(jobId, {
        status: timedOut ? 'failed' : 'cancelled',
        statusReason: timedOut ? `self-test timed out after ${timeoutMs}ms` : 'self-test cancelled',
        completedAt: now,
      })
      const engineDeadline = Date.now() + 3_000
      while (ctx.engine.isRunning(jobId) && Date.now() < engineDeadline) await sleep(50)
      jobStatus = ctx.repos.jobs.get(jobId)?.status ?? jobStatus

      if (cancelled) {
        steps.push({ name: 'pipeline', status: 'skipped', reason: 'cancelled before the pipeline finished' })
        report.status = 'skipped'
        report.reason = 'cancelled before the pipeline finished'
        return report
      }
      const reason = `pipeline did not finish within ${timeoutMs}ms (last job status "${jobStatus}")`
      steps.push({ name: 'pipeline', status: 'fail', reason })
      report.status = 'fail'
      report.reason = reason
      return report
    }

    const pipelineOk = jobStatus === 'completed'
    if (pipelineOk) {
      steps.push({ name: 'pipeline', status: 'pass', reason: `job completed in ${Date.now() - startedAt}ms` })
    } else {
      const finished = ctx.repos.jobs.get(jobId)
      const detail = finished?.error ?? finished?.statusReason ?? 'no error recorded'
      steps.push({ name: 'pipeline', status: 'fail', reason: `job ended as "${jobStatus}": ${detail}` })
    }

    /* evidence — read from the real repositories before anything is cleaned - */
    const workspacePath = ctx.repos.jobs.get(jobId)?.workspacePath ?? workspace
    const workerRows = ctx.repos.workers.listWorkers(jobId)
    const taskRows = ctx.repos.jobs.listTasks(jobId)
    const artifactRows = ctx.repos.workers.listArtifacts(jobId)
    const artifacts: HarnessSelfTestEvidence['artifacts'] = []
    for (const artifact of artifactRows) {
      artifacts.push({
        id: artifact.id,
        name: artifact.name,
        path: artifact.path,
        status: artifact.status,
        bytes: artifact.bytes,
        existsOnDisk: artifact.path ? await isFile(join(workspacePath, artifact.path)) : false,
      })
    }
    const evidence: HarnessSelfTestEvidence = {
      jobId,
      workspace: workspacePath,
      jobStatus,
      workers: workerRows.map((w) => ({
        id: w.id,
        name: w.name,
        status: w.status,
        filesTouched: w.filesTouched.length,
        artifacts: w.artifacts.length,
      })),
      tasks: taskRows.map((t) => ({ id: t.id, title: t.title, status: t.status })),
      taskEvents: { started: events.started, completed: events.completed, failed: events.failed },
      artifacts,
    }
    report.evidence = evidence
    steps.push({
      name: 'evidence',
      status: 'pass',
      reason: `${evidence.workers.length} worker(s), ${evidence.tasks.length} task(s), ${evidence.artifacts.length} artifact row(s) captured from the database`,
    })

    if (opts.onEvidence) await opts.onEvidence(evidence)

    /* invariants ----------------------------------------------------------- */
    const invariants: HarnessSelfTestInvariants = { workersTerminal: { status: 'pass', reason: '' }, taskTransitions: { status: 'pass', reason: '' }, artifactOnDisk: { status: 'pass', reason: '' }, noFakeSuccess: { status: 'pass', reason: '' } }

    if (evidence.workers.length === 0) {
      invariants.workersTerminal = { status: 'fail', reason: 'no workers were dispatched' }
    } else {
      const stuck = evidence.workers.filter((w) => !WORKER_TERMINAL.has(w.status))
      invariants.workersTerminal = stuck.length
        ? { status: 'fail', reason: `stuck workers: ${stuck.map((w) => `${w.name}=${w.status}`).join(', ')}` }
        : { status: 'pass', reason: `${evidence.workers.length}/${evidence.workers.length} workers terminal (${summarize(evidence.workers.map((w) => w.status))})` }
    }

    if (evidence.tasks.length === 0) {
      invariants.taskTransitions = { status: 'fail', reason: 'the pipeline produced no tasks' }
    } else {
      const problems: string[] = []
      if (evidence.taskEvents.started < 1) problems.push('no task.started event was observed')
      const unsettled = taskRows.filter((t) => !isTaskTerminal(t))
      if (unsettled.length) problems.push(`${unsettled.length} task(s) never settled: ${unsettled.map((t) => `${t.title}=${t.status}`).join(', ')}`)
      invariants.taskTransitions = problems.length
        ? { status: 'fail', reason: problems.join('; ') }
        : { status: 'pass', reason: `${evidence.taskEvents.started} task.started event(s); all ${evidence.tasks.length} tasks settled (${summarize(evidence.tasks.map((t) => t.status))})` }
    }

    const onDisk = evidence.artifacts.filter((a) => a.path && a.status === 'available' && a.existsOnDisk)
    invariants.artifactOnDisk = onDisk.length
      ? { status: 'pass', reason: `${onDisk.length} artifact file(s) verified on disk: ${onDisk.map((a) => a.path).join(', ')}` }
      : { status: 'fail', reason: `no artifact row with a file on disk (checked ${evidence.artifacts.length} artifact row(s))` }

    const succeeded = workerRows.filter((w) => w.status === 'succeeded')
    const hollow = succeeded.filter((w) => {
      const session = w.sessionId ? ctx.repos.workers.getSession(w.sessionId) : null
      return !(session?.summary ?? '').trim() && w.filesTouched.length === 0 && w.artifacts.length === 0
    })
    invariants.noFakeSuccess = hollow.length
      ? { status: 'fail', reason: `workers claimed success with no assistant output, files or artifacts: ${hollow.map((w) => w.name).join(', ')}` }
      : { status: 'pass', reason: succeeded.length ? `${succeeded.length} succeeded worker(s) each carry session/artifact evidence` : 'no worker claimed success — nothing to verify' }

    report.invariants = invariants
    const failedInvariants = (Object.keys(invariants) as (keyof HarnessSelfTestInvariants)[]).filter((k) => invariants[k].status !== 'pass')
    if (pipelineOk && failedInvariants.length === 0) {
      steps.push({ name: 'invariants', status: 'pass', reason: 'all 4 invariants verified' })
      report.status = 'pass'
      report.reason = `job completed; all ${Object.keys(invariants).length} invariants verified`
    } else {
      const reasons: string[] = []
      if (!pipelineOk) reasons.push(`job ended as "${jobStatus}"`)
      if (failedInvariants.length) reasons.push(`invariant(s) failed: ${failedInvariants.join(', ')}`)
      steps.push({ name: 'invariants', status: 'fail', reason: failedInvariants.join(', ') || `job ended as "${jobStatus}"` })
      report.status = 'fail'
      report.reason = reasons.join('; ')
    }
  } finally {
    for (const off of unsubscribe) {
      try {
        off()
      } catch {
        /* already gone */
      }
    }
    try {
      if (jobId) {
        const live = ctx.repos.jobs.get(jobId)
        if (live && !JOB_TERMINAL.has(live.status)) {
          ctx.engine.cancel(jobId)
          await ctx.opencode.abortJob(jobId, 'harness self-test cleanup')
        }
        const engineDeadline = Date.now() + 3_000
        while (ctx.engine.isRunning(jobId) && Date.now() < engineDeadline) await sleep(50)

        const prefix = sandbox.endsWith(sep) ? sandbox : sandbox + sep
        for (const server of ctx.opencode.listServers()) {
          if (server.directory === sandbox || server.directory.startsWith(prefix)) {
            try {
              await ctx.opencode.stopServer(server.id)
            } catch {
              /* already stopped */
            }
          }
        }

        const now = Date.now()
        for (const worker of ctx.repos.workers.listWorkers(jobId)) {
          if (!WORKER_TERMINAL.has(worker.status)) {
            ctx.repos.workers.updateWorker(worker.id, { status: 'aborted', statusReason: 'self-test cleanup', completedAt: now })
          }
        }
        purgeTempJob(ctx, jobId)
      }
      if (report.sandboxPath) {
        await rm(report.sandboxPath, { recursive: true, force: true })
      }
      try {
        await rmdir(join(ctx.paths.root, SANDBOX_ROOT_NAME))
      } catch {
        /* other runs active, or already gone */
      }
    } catch (err) {
      cleanupError = AppError.from(err).message
    }

    steps.push({
      name: 'cleanup',
      status: cleanupError ? 'fail' : 'pass',
      reason: cleanupError
        ? `cleanup incomplete: ${cleanupError}`
        : report.sandboxPath
          ? `sandbox ${report.sandboxPath} removed; temp job rows purged`
          : 'no sandbox was created',
    })
    if (cleanupError && report.status === 'pass') {
      report.status = 'fail'
      report.reason = `${report.reason}; cleanup failed: ${cleanupError}`
    }
    report.durationMs = Date.now() - startedAt
  }

  return report
}

function summarize(statuses: string[]): string {
  const counts = new Map<string, number>()
  for (const status of statuses) counts.set(status, (counts.get(status) ?? 0) + 1)
  return [...counts.entries()].map(([status, count]) => `${count} ${status}`).join(', ')
}
