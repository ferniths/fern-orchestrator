import { randomBytes } from 'node:crypto'
import { mkdir, readFile, rm, rmdir, stat, writeFile } from 'node:fs/promises'
import { rmSync } from 'node:fs'
import { join } from 'node:path'
import type { ModelInfo } from '@shared/domain'
import { taskSchema, workerSchema } from '@shared/domain'
import type { HarnessComponentResult, HarnessHealthReport, HarnessStatus } from '@shared/ipc'
import type { AppContext } from '../kernel/appContext'
import { appConfigSchema } from '../kernel/config'
import { AppError } from '../kernel/errors'
import { fetchModels } from '../ai/models'
import { resolveModel } from '../ai/router'
import { detectOpencode } from '../platform/binaries'
import { findBlocked, isLoopSettled, pickReady, pickRetries } from './scheduler'

/** Worker states that can never progress — matches the engine's view of a settled run. */
export const WORKER_TERMINAL = new Set(['succeeded', 'failed', 'timed_out', 'aborted', 'orphaned'])

/** Probe order: cheap local checks first, then providers, then live OpenCode probes. */
export const HARNESS_COMPONENTS = [
  'database',
  'config',
  'eventBus',
  'schedulerDag',
  'opencodeBinary',
  'providerRoute',
  'workspaceFs',
  'artifactRecording',
  'opencodeServer',
  'workerManager',
] as const

type ProbeResult = { status: HarnessStatus; reason: string }
type Probe = () => Promise<ProbeResult>

interface HealthRun {
  /** Isolated directory this health run owns; removed when the run ends. */
  sandbox: string
  /** Server ids started by this run — stopped when the run ends. */
  servers: string[]
}

const SANDBOX_ROOT_NAME = 'harness-selftest'

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function runComponent(name: string, probe: Probe): Promise<HarnessComponentResult> {
  const startedAt = Date.now()
  try {
    const result = await probe()
    return { name, status: result.status, reason: result.reason, durationMs: Date.now() - startedAt }
  } catch (err) {
    return { name, status: 'fail', reason: AppError.from(err).message, durationMs: Date.now() - startedAt }
  }
}

/**
 * Removes a temp job and every row that does not cascade from `jobs`
 * (`sessions`, `events`, `usage_records`, `notifications` carry no FK), plus its
 * scratch transcript directory. Leaves nothing the UI can observe.
 */
export function purgeTempJob(ctx: AppContext, jobId: string): void {
  try {
    ctx.repos.jobs.delete(jobId)
  } catch (err) {
    ctx.log('orchestration').warn('temp job delete failed', { jobId, error: String(err) })
  }
  try {
    ctx.db.run('DELETE FROM sessions WHERE job_id = ?', jobId)
    ctx.db.run('DELETE FROM events WHERE job_id = ?', jobId)
    ctx.db.run('DELETE FROM usage_records WHERE job_id = ?', jobId)
    ctx.db.run('DELETE FROM notifications WHERE job_id = ?', jobId)
  } catch (err) {
    ctx.log('orchestration').warn('temp job row purge failed', { jobId, error: String(err) })
  }
  try {
    // Transcripts and any scratch files under paths.jobs/<jobId> are not rows.
    rmSync(join(ctx.paths.jobs, jobId), { recursive: true, force: true })
  } catch {
    /* nothing written there */
  }
}

async function removeSandbox(dir: string): Promise<void> {
  try {
    await rm(dir, { recursive: true, force: true })
  } catch {
    /* best effort — the report carries the outcome */
  }
  try {
    // Drop the shared parent when this was the last run.
    await rmdir(join(dir, '..'))
  } catch {
    /* other runs active, or already gone */
  }
}

/* --------------------------------------------------------------- components */

async function probeDatabase(ctx: AppContext): Promise<ProbeResult> {
  const integrity = ctx.db.integrity()
  if (!integrity.ok) return { status: 'fail', reason: `integrity_check failed: ${integrity.details}` }

  const table = `harness_probe_${randomBytes(4).toString('hex')}`
  const nonce = randomBytes(8).toString('hex')
  ctx.db.exec(`CREATE TEMP TABLE ${table} (value TEXT NOT NULL)`)
  try {
    ctx.db.run(`INSERT INTO ${table} (value) VALUES (?)`, nonce)
    const row = ctx.db.get<{ value: string }>(`SELECT value FROM ${table} WHERE value = ?`, nonce)
    if (row?.value !== nonce) return { status: 'fail', reason: 'temp-table write/read roundtrip returned the wrong value' }
  } finally {
    ctx.db.exec(`DROP TABLE IF EXISTS ${table}`)
  }
  return { status: 'pass', reason: 'integrity_check ok; temp-table write/read roundtrip ok (no user data touched)' }
}

async function probeConfig(ctx: AppContext): Promise<ProbeResult> {
  let raw: string
  try {
    raw = await readFile(ctx.paths.config, 'utf8')
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code
    if (code === 'ENOENT') return { status: 'pass', reason: 'no config file on disk — running on schema defaults' }
    return { status: 'fail', reason: `config file unreadable (${code ?? 'unknown error'}): ${AppError.from(err).message}` }
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (err) {
    return { status: 'fail', reason: `config is not valid JSON (${AppError.from(err).message}) — the app silently fell back to defaults` }
  }

  const result = appConfigSchema.safeParse(parsed)
  if (!result.success) {
    const issues = result.error.issues
      .slice(0, 3)
      .map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`)
      .join('; ')
    return { status: 'fail', reason: `config failed schema validation: ${issues} — the app silently fell back to defaults` }
  }
  return { status: 'pass', reason: `valid JSON matching the config schema (version ${result.data.version})` }
}

async function probeEventBus(ctx: AppContext): Promise<ProbeResult> {
  const probeType = 'harness.probe'
  let delivered = 0
  let lastSeq: number | null = null
  const off = ctx.events.subscribeType(probeType, (event) => {
    delivered += 1
    lastSeq = event.seq
  })
  try {
    ctx.events.publish(probeType, { message: 'harness event-bus probe' })
    if (delivered !== 1) return { status: 'fail', reason: `listener saw ${delivered} deliver${delivered === 1 ? 'y' : 'ies'}, expected exactly 1` }
  } finally {
    off()
  }
  ctx.events.publish(probeType, { message: 'harness event-bus probe after unsubscribe' })
  if (delivered !== 1) return { status: 'fail', reason: `unsubscribe did not stop delivery (${delivered} total)` }
  return { status: 'pass', reason: `subscribe/publish delivered seq ${lastSeq}; unsubscribe stopped further delivery` }
}

function probeTask(id: string, overrides: Record<string, unknown> = {}) {
  return taskSchema.parse({
    id,
    jobId: 'harness_scheduler_probe',
    loopIndex: 1,
    title: id,
    role: 'coder',
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  })
}

function probeWorker(id: string, taskId: string, status: string) {
  return workerSchema.parse({
    id,
    jobId: 'harness_scheduler_probe',
    loopIndex: 1,
    taskId,
    name: id,
    role: 'coder',
    status,
    createdAt: 1,
    updatedAt: 1,
  })
}

async function probeSchedulerDag(): Promise<ProbeResult> {
  const failures: string[] = []

  const high = probeTask('t_high', { status: 'ready', priority: 90, createdAt: 2 })
  const low = probeTask('t_low', { status: 'ready', priority: 10, createdAt: 1 })
  const waiting = probeTask('t_waiting', { status: 'ready', dependencyIds: ['t_running'] })
  const running = probeTask('t_running', { status: 'running' })
  const pending = probeTask('t_pending')

  const picked = pickReady([low, waiting, pending, running, high], 10).map((t) => t.id)
  if (picked.join(',') !== 't_high,t_low') failures.push(`pickReady ordering/budget returned [${picked.join(', ')}]`)
  const budgeted = pickReady([low, high], 1).map((t) => t.id)
  if (budgeted.length !== 1 || budgeted[0] !== 't_high') failures.push(`pickReady ignored the priority order under budget=1 (got [${budgeted.join(', ')}])`)

  const failedDep = probeTask('t_failed', { status: 'failed', completedAt: 10 })
  const succeededDep = probeTask('t_done', { status: 'succeeded', completedAt: 10 })
  const dependent = probeTask('t_dependent', { dependencyIds: ['t_failed'] })
  if (!findBlocked(new Map([['t_failed', failedDep], ['t_dependent', dependent]])).includes('t_dependent')) {
    failures.push('findBlocked did not block a task whose dependency failed')
  }
  const waitingOnRunning = probeTask('t_dependent', { dependencyIds: ['t_running'] })
  if (findBlocked(new Map([['t_running', running], ['t_dependent', waitingOnRunning]])).includes('t_dependent')) {
    failures.push('findBlocked blocked a task whose dependency is still running')
  }
  const waitingOnDone = probeTask('t_dependent', { dependencyIds: ['t_done'] })
  if (findBlocked(new Map([['t_done', succeededDep], ['t_dependent', waitingOnDone]])).includes('t_dependent')) {
    failures.push('findBlocked blocked a task whose dependency succeeded')
  }
  if (!findBlocked(new Map([['t_dependent', probeTask('t_dependent', { dependencyIds: ['ghost'] })]])).includes('t_dependent')) {
    failures.push('findBlocked did not block a task with a missing dependency')
  }

  if (!isLoopSettled([succeededDep, failedDep])) failures.push('isLoopSettled missed terminal tasks')
  if (isLoopSettled([running])) failures.push('isLoopSettled reported a loop with a running task as settled')

  const retryable = probeTask('t_retryable', { status: 'failed', attempt: 1 })
  const exhausted = probeTask('t_exhausted', { status: 'failed', attempt: 2 })
  const workers = new Map([
    ['t_retryable', probeWorker('w1', 't_retryable', 'failed')],
    ['t_exhausted', probeWorker('w2', 't_exhausted', 'failed')],
  ])
  const retries = pickRetries([retryable, exhausted], workers).map((t) => t.id)
  if (retries.join(',') !== 't_retryable') failures.push(`pickRetries returned [${retries.join(', ')}]`)

  if (failures.length) return { status: 'fail', reason: failures.join('; ') }
  return { status: 'pass', reason: 'pickReady/findBlocked/isLoopSettled/pickRetries produced the expected DAG outcomes' }
}

async function probeOpencodeBinary(ctx: AppContext): Promise<ProbeResult> {
  const configured = ctx.config.get().opencode.binaryPath
  if (configured) {
    try {
      const info = await stat(configured)
      if (!info.isFile()) return { status: 'fail', reason: `configured binary path is not a file: ${configured}` }
    } catch {
      // Strict on purpose: the app would otherwise silently fall back to PATH discovery.
      return { status: 'fail', reason: `configured binary path does not exist: ${configured}` }
    }
  }
  // Tests and embedded runs inject their binary through startOptions instead of config.
  const detected = await detectOpencode(configured ?? ctx.opencode.startOptions?.binaryPath ?? null)
  if (!detected.path) {
    return { status: 'fail', reason: 'OpenCode binary not found — install opencode or set its path in Settings → OpenCode' }
  }
  return { status: 'pass', reason: `opencode ${detected.version ?? 'unknown version'} at ${detected.path} (${detected.source})` }
}

async function probeProviderRoute(ctx: AppContext): Promise<ProbeResult> {
  const providers = ctx.repos.providers.listProviders().filter((p) => p.enabled)
  if (providers.length === 0) return { status: 'fail', reason: 'no model provider configured — add one under Providers' }

  const catalog = new Map<string, ModelInfo[]>()
  const unreachable: string[] = []
  for (const provider of providers) {
    try {
      const key = provider.apiKeyRef ? ctx.keystore.get(provider.apiKeyRef) : null
      const { models } = await fetchModels({ ...provider, timeoutMs: Math.min(provider.timeoutMs, 5_000) }, key)
      catalog.set(provider.id, models)
    } catch (err) {
      unreachable.push(`${provider.name}: ${AppError.from(err, 'provider_error').message}`)
    }
  }
  if (catalog.size === 0) return { status: 'fail', reason: `no reachable provider — ${unreachable.join('; ')}` }

  const routes = ctx.repos.providers.listRoutes()
  const decision = resolveModel({
    role: 'coder',
    route: routes.find((r) => r.isDefault) ?? null,
    providers,
    catalog,
  })
  if (!decision) return { status: 'fail', reason: 'model router could not resolve a model for role "coder"' }

  const primary = providers.find((p) => p.id === decision.primary.providerId)
  const note = unreachable.length ? `; unreachable: ${unreachable.join('; ')}` : ''
  return {
    status: 'pass',
    reason: `${catalog.size}/${providers.length} provider(s) reachable; coder → ${primary?.name ?? decision.primary.providerId}/${decision.primary.modelId}${note}`,
  }
}

async function probeWorkspaceFs(run: HealthRun): Promise<ProbeResult> {
  const dir = join(run.sandbox, 'fs-probe')
  const nonce = randomBytes(8).toString('hex')
  const file = join(dir, `probe-${nonce}.txt`)
  try {
    await mkdir(dir, { recursive: true })
    await writeFile(file, nonce, 'utf8')
    const back = await readFile(file, 'utf8')
    if (back !== nonce) return { status: 'fail', reason: 'sandbox file roundtrip returned the wrong content' }
    await rm(file, { force: true })
  } catch (err) {
    return { status: 'fail', reason: `sandbox workspace write/read failed: ${AppError.from(err).message}` }
  }
  return { status: 'pass', reason: `wrote, read back and removed a probe file under ${dir}` }
}

function createTempJob(ctx: AppContext, title: string): string {
  const job = ctx.repos.jobs.create({
    title,
    originalPrompt: 'harness internal probe — row is removed when the probe ends',
    status: 'draft',
    projectId: null,
    vaultId: null,
    loopCount: 1,
    routeId: null,
    requirePlanApproval: false,
    templateId: null,
  })
  return job.id
}

async function probeArtifactRecording(ctx: AppContext, run: HealthRun): Promise<ProbeResult> {
  const workspace = join(run.sandbox, 'artifact-probe')
  const rel = 'probe/note.txt'
  const abs = join(workspace, 'probe', 'note.txt')
  const nonce = randomBytes(8).toString('hex')
  let jobId: string | null = null
  try {
    await mkdir(join(workspace, 'probe'), { recursive: true })
    await writeFile(abs, nonce, 'utf8')
    jobId = createTempJob(ctx, 'harness health artifact probe')
    ctx.repos.jobs.setWorkspace(jobId, workspace)

    const created = ctx.repos.workers.createArtifact({
      jobId,
      loopIndex: 1,
      kind: 'file',
      name: 'note.txt',
      path: rel,
      bytes: nonce.length,
      status: 'available',
    })
    const readBack = ctx.repos.workers.listArtifacts(jobId).find((a) => a.id === created.id)
    if (!readBack) return { status: 'fail', reason: 'artifact row did not round-trip through the repository' }
    if (readBack.path !== rel) return { status: 'fail', reason: `artifact path mismatch: recorded "${readBack.path}", expected "${rel}"` }
    if (readBack.status !== 'available') return { status: 'fail', reason: `artifact status came back as "${readBack.status}"` }
    const onDisk = await stat(abs)
    if (onDisk.size !== nonce.length) return { status: 'fail', reason: `artifact byte count ${onDisk.size} does not match the file on disk` }
    return { status: 'pass', reason: `artifact row ${created.id} recorded and verified on disk (${onDisk.size} bytes)` }
  } catch (err) {
    return { status: 'fail', reason: `artifact record/verify failed: ${AppError.from(err).message}` }
  } finally {
    if (jobId) purgeTempJob(ctx, jobId)
  }
}

async function probeOpencodeServer(ctx: AppContext, run: HealthRun): Promise<ProbeResult> {
  const cfg = ctx.config.get()
  const detected = await detectOpencode(ctx.opencode.startOptions?.binaryPath ?? cfg.opencode.binaryPath)
  if (!detected.path) {
    return { status: 'skipped', reason: 'OpenCode binary not found — install opencode or set its path in Settings → OpenCode' }
  }

  const dir = join(run.sandbox, 'server-probe')
  await mkdir(dir, { recursive: true })
  try {
    const state = await ctx.opencode.startServer({ directory: dir })
    run.servers.push(state.id)
    const listed = ctx.opencode.listServers().find((s) => s.id === state.id)
    if (!listed || listed.status !== 'ready') {
      return { status: 'fail', reason: `server ${state.id} started but the pool reports "${listed?.status ?? 'missing'}"` }
    }
    return { status: 'pass', reason: `server ${state.id} healthy at ${state.url} (pid ${state.pid ?? 'unknown'})` }
  } catch (err) {
    return { status: 'fail', reason: `server start failed: ${AppError.from(err, 'opencode_error').message}` }
  }
}

async function probeWorkerManager(ctx: AppContext, run: HealthRun): Promise<ProbeResult> {
  const serverId = run.servers[run.servers.length - 1]
  const server = serverId ? ctx.opencode.listServers().find((s) => s.id === serverId) : undefined
  if (!server || server.status !== 'ready') {
    return { status: 'skipped', reason: 'no OpenCode server available — see the opencodeServer component' }
  }

  let jobId: string | null = null
  try {
    jobId = createTempJob(ctx, 'harness health worker probe')
    const task = ctx.repos.jobs.createTask({
      jobId,
      loopIndex: 1,
      title: 'harness probe step',
      role: 'coder',
      prompt: 'Reply with the single word: ok',
    })
    const worker = ctx.repos.workers.createWorker({
      jobId,
      loopIndex: 1,
      taskId: task.id,
      name: 'harness probe worker',
      role: 'coder',
      workspacePath: server.directory,
      taskPrompt: 'Reply with the single word: ok',
      status: 'queued',
      timeoutMs: 60_000,
    })

    const dispatched = await ctx.opencode.dispatch(worker)
    if (!dispatched.sessionId) return { status: 'fail', reason: 'dispatch finished without creating a session id' }
    if (dispatched.status !== 'running') return { status: 'fail', reason: `dispatch left the worker in "${dispatched.status}" instead of "running"` }

    const session = ctx.repos.workers.getSession(dispatched.sessionId)
    if (!session || session.workerId !== worker.id) return { status: 'fail', reason: 'the session row was not linked to the dispatched worker' }

    const transcript = await ctx.opencode.nativeTranscript(server.id, dispatched.sessionId)
    if (transcript.length === 0) return { status: 'fail', reason: 'the live session returned no transcript messages' }

    await ctx.opencode.abort(worker.id, 'health probe complete')
    const deadline = Date.now() + 2_000
    let settled = ctx.repos.workers.getWorker(worker.id)
    while (settled && !WORKER_TERMINAL.has(settled.status) && Date.now() < deadline) {
      await sleep(50)
      settled = ctx.repos.workers.getWorker(worker.id)
    }
    if (!settled || !WORKER_TERMINAL.has(settled.status)) {
      return { status: 'fail', reason: `worker did not settle after abort (status "${settled?.status ?? 'missing'}")` }
    }
    return {
      status: 'pass',
      reason: `session ${session.sessionId} opened and read back (${transcript.length} transcript entries); worker settled at "${settled.status}"`,
    }
  } catch (err) {
    return { status: 'fail', reason: `dispatch/abort probe failed: ${AppError.from(err, 'opencode_error').message}` }
  } finally {
    if (jobId) {
      // Let any fire-and-forget transcript write from the abort land before the purge.
      await sleep(150)
      purgeTempJob(ctx, jobId)
    }
  }
}

/* -------------------------------------------------------------------- entry */

/**
 * Probes every harness component with a real check (no status guessing):
 * database roundtrip, config schema, event bus delivery, scheduler DAG math,
 * binary discovery, provider reachability + routing, sandbox filesystem,
 * artifact recording, an OpenCode server roundtrip, and a full
 * dispatch → session → transcript → abort worker cycle. All probe resources
 * (sandbox dir, servers, temp job rows) are removed before returning.
 */
export async function runHealthCheck(ctx: AppContext, opts: { signal?: AbortSignal } = {}): Promise<HarnessHealthReport> {
  const startedAt = Date.now()
  const runId = `${startedAt.toString(36)}-${randomBytes(3).toString('hex')}`
  const run: HealthRun = { sandbox: join(ctx.paths.root, SANDBOX_ROOT_NAME, `health-${runId}`), servers: [] }
  await mkdir(run.sandbox, { recursive: true })

  const probes: [string, Probe][] = [
    ['database', () => probeDatabase(ctx)],
    ['config', () => probeConfig(ctx)],
    ['eventBus', () => probeEventBus(ctx)],
    ['schedulerDag', () => probeSchedulerDag()],
    ['opencodeBinary', () => probeOpencodeBinary(ctx)],
    ['providerRoute', () => probeProviderRoute(ctx)],
    ['workspaceFs', () => probeWorkspaceFs(run)],
    ['artifactRecording', () => probeArtifactRecording(ctx, run)],
    ['opencodeServer', () => probeOpencodeServer(ctx, run)],
    ['workerManager', () => probeWorkerManager(ctx, run)],
  ]

  const components: HarnessComponentResult[] = []
  try {
    for (const [name, probe] of probes) {
      if (opts.signal?.aborted) {
        components.push({ name, status: 'skipped', durationMs: 0, reason: 'health check cancelled before this component ran' })
        continue
      }
      components.push(await runComponent(name, probe))
    }
  } finally {
    for (const id of run.servers) {
      try {
        await ctx.opencode.stopServer(id)
      } catch {
        /* already stopped */
      }
    }
    await removeSandbox(run.sandbox)
  }

  const status: HarnessStatus = components.some((c) => c.status === 'fail')
    ? 'fail'
    : components.some((c) => c.status === 'skipped')
      ? 'skipped'
      : 'pass'
  return { status, checkedAt: startedAt, durationMs: Date.now() - startedAt, components }
}
