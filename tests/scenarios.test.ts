import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Db } from '@core/db/db'
import { createCoreContext, type AppContext } from '@core/kernel/appContext'
import { EVENTS } from '@core/kernel/eventBus'
import { compilePlan, planDataSchema } from '@core/orchestration/plan'
import { isTaskTerminal, pickReady } from '@core/orchestration/scheduler'
import { automationJobSchema, type AppEvent, type AutomationJob, type Task } from '@shared/domain'

let ctx: AppContext
let dataDir: string
let downServer: Server
let upServer: Server
let downUrl = ''
let upUrl = ''

const up = { mode: 'ok' as 'ok' | 'fail' }

function chatReply(content: string, model: string): string {
  return JSON.stringify({
    id: 'cmpl-1',
    model,
    choices: [{ message: { role: 'assistant', content }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 11, completion_tokens: 7 },
  })
}

function listen(server: Server): Promise<string> {
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      const port = typeof address === 'object' && address ? address.port : 0
      resolve(`http://127.0.0.1:${port}/v1`)
    })
  })
}

beforeAll(async () => {
  downServer = createServer((_req: IncomingMessage, res: ServerResponse) => {
    res.writeHead(503, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ error: { message: 'upstream down' } }))
  })
  downUrl = await listen(downServer)

  upServer = createServer((req: IncomingMessage, res: ServerResponse) => {
    const path = req.url ?? ''
    if (path.endsWith('/models')) {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ data: [{ id: 'backup-model' }] }))
      return
    }
    if (path.endsWith('/chat/completions')) {
      if (up.mode === 'fail') {
        res.writeHead(503, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ error: { message: 'upstream exploded' } }))
        return
      }
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(chatReply('fallback reply', 'backup-model'))
      return
    }
    res.writeHead(404)
    res.end()
  })
  upUrl = await listen(upServer)

  dataDir = await mkdtemp(join(tmpdir(), 'fern-scn-'))
  ctx = await createCoreContext({ dataDir, consoleLogs: false })

  const primary = ctx.repos.providers.createProvider({
    name: 'Primary',
    type: 'openai_compatible',
    baseUrl: downUrl,
    defaultModel: 'down-model',
  })
  ctx.repos.providers.updateProvider(primary.id, {
    health: { status: 'healthy', latencyMs: 5, checkedAt: Date.now(), modelCount: 1, lastError: null, lastSuccessAt: Date.now() },
  })
  ctx.repos.providers.createProvider({
    name: 'Backup',
    type: 'openai_compatible',
    baseUrl: upUrl,
    defaultModel: 'backup-model',
  })
}, 30_000)

afterAll(async () => {
  await ctx?.shutdown()
  downServer?.closeAllConnections?.()
  upServer?.closeAllConnections?.()
  await Promise.all([
    new Promise<void>((resolve) => (downServer ? downServer.close(() => resolve()) : resolve())),
    new Promise<void>((resolve) => (upServer ? upServer.close(() => resolve()) : resolve())),
  ])
  if (dataDir) await rm(dataDir, { recursive: true, force: true })
})

describe('spec section 67: 3 workers run in parallel', () => {
  it('three independent steps are all ready and dispatch together', () => {
    const job = automationJobSchema.parse({
      id: 'job_parallel',
      title: 'parallel job',
      originalPrompt: 'run three independent steps',
      createdAt: 1,
      updatedAt: 1,
    })
    const plan = planDataSchema.parse({
      summary: 'three steps with no dependencies between them',
      steps: [
        { id: 'a', title: 'Research', role: 'researcher', dependsOn: [], prompt: 'research the topic' },
        { id: 'b', title: 'Implement', role: 'coder', dependsOn: [], prompt: 'implement the change' },
        { id: 'c', title: 'Verify', role: 'tester', dependsOn: [], prompt: 'verify the change' },
      ],
    })

    const compiled = compilePlan(job, 1, plan)
    expect(compiled.tasks.map((t) => t.status)).toEqual(['ready', 'ready', 'ready'])
    expect(pickReady(compiled.tasks, 3).map((t) => t.title)).toEqual(['Research', 'Implement', 'Verify'])
    expect(pickReady(compiled.tasks, 2)).toHaveLength(2)
    expect(pickReady(compiled.tasks, 0)).toHaveLength(0)
  })
})

describe('spec section 67: provider becomes unavailable', () => {
  it('falls back to a healthy provider, then reports provider.failed when nothing survives', async () => {
    up.mode = 'ok'
    const seen: string[] = []
    const off = ctx.events.subscribe((e) => seen.push(e.type))

    const res = await ctx.ai.runText({ role: 'planner', messages: [{ role: 'user', content: 'hello' }] })
    expect(res.text).toBe('fallback reply')
    expect(res.modelId).toBe('backup-model')
    expect(seen).toContain('provider.fallback')
    expect(seen).not.toContain('provider.failed')

    seen.length = 0
    up.mode = 'fail'
    await expect(ctx.ai.runText({ role: 'planner', messages: [{ role: 'user', content: 'hello' }] })).rejects.toMatchObject({
      code: 'provider_error',
    })
    expect(seen).toContain('provider.failed')
    off()
    up.mode = 'ok'
  })
})

describe('spec section 67: application restarts (migrations)', () => {
  it('re-opening the database re-runs migrations as a no-op and keeps data intact', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'fern-mig-'))
    const file = join(dir, 'app.db')

    const first = new Db(file)
    const version = first.schemaVersion
    expect(version).toBeGreaterThanOrEqual(2)
    first.run('INSERT INTO events (ts, type, severity, message, data) VALUES (?,?,?,?,?)', 1, 'test.migration', 'info', 'first run', '{}')
    first.close()

    const second = new Db(file)
    expect(second.schemaVersion).toBe(version)
    expect(second.get<{ message: string }>('SELECT message FROM events WHERE type = ?', 'test.migration')?.message).toBe('first run')
    expect(second.integrity().ok).toBe(true)

    const third = new Db(file)
    expect(third.schemaVersion).toBe(version)
    expect(third.integrity().ok).toBe(true)

    third.close()
    second.close()
    await rm(dir, { recursive: true, force: true })
  })
})

describe('spec section 67: Obsidian note changes externally', () => {
  it('reindex picks up an out-of-band edit and refreshes the FTS index', async () => {
    const vaultDir = await mkdtemp(join(tmpdir(), 'fern-vx-'))
    const notePath = join(vaultDir, 'Field Notes.md')
    await writeFile(notePath, '# Field Notes\n\nThe quagga frog lives in the wetlands.\n', 'utf8')

    const handlers = await import('../src/main/ipc/handlers/obsidian').then((m) => m.obsidianHandlers(ctx))
    const add = handlers['vaults.add'] as (args: [{ path: string; name?: string }]) => Promise<{ id: string }>
    const reindex = handlers['vaults.reindex'] as (args: [string]) => Promise<{ noteCount: number }>
    const search = handlers['notes.search'] as (args: [string, { vaultId?: string }?]) => { title: string }[]

    const vault = await add([{ path: vaultDir, name: 'External Change Vault' }])
    const first = await reindex([vault.id])
    expect(first.noteCount).toBe(1)
    expect(search(['quagga', { vaultId: vault.id }]).map((n) => n.title)).toContain('Field Notes')

    await writeFile(notePath, '# Field Notes\n\nThe axolotl salamander regrows limbs.\n', 'utf8')

    const second = await reindex([vault.id])
    expect(second.noteCount).toBe(1)
    expect(search(['axolotl', { vaultId: vault.id }]).map((n) => n.title)).toContain('Field Notes')
    expect(search(['quagga', { vaultId: vault.id }])).toHaveLength(0)

    await rm(vaultDir, { recursive: true, force: true })
  })
})

/* -------------------------------------------------------------------------- */
/* Scenarios that need a live `opencode serve` fixture and their own context.  */
/* Each one owns a context + dataDir so boot reconciliation, server restarts    */
/* and workspace isolation can be observed against real rows.                   */
/* -------------------------------------------------------------------------- */

const FIXTURE = fileURLToPath(new URL('./fixtures/fake-opencode.mjs', import.meta.url))
const SCENARIO_TIMEOUT = 60_000
const SCENARIO_WAIT = 45_000
const TERMINAL_WORKER = ['succeeded', 'failed', 'timed_out', 'aborted', 'orphaned']
const LIVE_WORKER = ['queued', 'starting', 'running', 'waiting_approval']

type ScenarioStep = {
  id: string
  title: string
  role?: string
  prompt: string
  expectedArtifacts?: string[]
}

/** Knobs the scenario mock AI honours; every field is reset per test. */
const scn = {
  steps: [] as ScenarioStep[],
  planCalls: 0,
  reviewCalls: 0,
  reviewVerdicts: [] as string[],
  reviewDown: false,
}

function resetScn(steps: ScenarioStep[] = []): void {
  scn.steps = steps
  scn.planCalls = 0
  scn.reviewCalls = 0
  scn.reviewVerdicts = []
  scn.reviewDown = false
}

function scnPlan() {
  return {
    summary: 'Scenario plan: one honest step.',
    risks: [] as string[],
    acceptance: ['the step finishes honestly'],
    steps: scn.steps.map((s) => ({
      id: s.id,
      title: s.title,
      role: s.role ?? 'coder',
      dependsOn: [] as string[],
      objective: '',
      prompt: s.prompt,
      expectedArtifacts: s.expectedArtifacts ?? [],
      successCriteria: [] as string[],
      rationale: 'seeded by the scenario mock',
      complexity: 'low' as const,
      timeoutMinutes: 5,
    })),
  }
}

describe('spec section 67: scenarios needing live processes or owned elsewhere', () => {
  let scnServer: Server
  let scnUrl = ''

  beforeAll(async () => {
    delete process.env.FAKE_OC_IDLE
    delete process.env.FAKE_OC_IDLE_DELAY_MS
    // Two fixture processes serve two workspaces in the parallel-worktree case.
    process.env.FAKE_OC_UNIQUE_SESSIONS = '1'

    scnServer = createServer((req: IncomingMessage, res: ServerResponse) => {
      const chunks: Buffer[] = []
      req.on('data', (c: Buffer) => chunks.push(c))
      req.on('end', () => {
        try {
          const path = req.url ?? ''
          if (path.endsWith('/models')) {
            res.writeHead(200, { 'content-type': 'application/json' })
            res.end(JSON.stringify({ data: [{ id: 'test-model' }] }))
            return
          }
          if (path.endsWith('/chat/completions')) {
            let body: { response_format?: { json_schema?: { name?: string } } } = {}
            if (chunks.length) body = JSON.parse(Buffer.concat(chunks).toString()) as typeof body
            const name = body.response_format?.json_schema?.name
            if (name === 'job_review' && scn.reviewDown) {
              res.writeHead(503, { 'content-type': 'application/json' })
              res.end(JSON.stringify({ error: { message: 'reviewer offline' } }))
              return
            }
            res.writeHead(200, { 'content-type': 'application/json' })
            if (name === 'job_plan') {
              scn.planCalls++
              res.end(chatReply(JSON.stringify(scnPlan()), 'test-model'))
              return
            }
            if (name === 'job_review') {
              scn.reviewCalls++
              const verdict = scn.reviewVerdicts.length ? scn.reviewVerdicts.shift()! : 'pass'
              res.end(
                chatReply(JSON.stringify({ verdict, summary: `review ${verdict}`, problems: [], changes: [] }), 'test-model'),
              )
              return
            }
            res.end(chatReply('Produce a short write-up of the result', 'test-model'))
            return
          }
          res.writeHead(404)
          res.end()
        } catch (err) {
          res.writeHead(500, { 'content-type': 'application/json' })
          res.end(JSON.stringify({ error: String(err) }))
        }
      })
    })
    scnUrl = await listen(scnServer)
  }, 30_000)

  afterAll(async () => {
    delete process.env.FAKE_OC_IDLE
    delete process.env.FAKE_OC_IDLE_DELAY_MS
    delete process.env.FAKE_OC_UNIQUE_SESSIONS
    scnServer?.closeAllConnections?.()
    await new Promise<void>((resolve) => (scnServer ? scnServer.close(() => resolve()) : resolve()))
  }, 30_000)

  /* ---------------------------------------------------------------- harness */

  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

  async function waitFor(predicate: () => boolean, timeoutMs = SCENARIO_WAIT, label = 'condition'): Promise<void> {
    const deadline = Date.now() + timeoutMs
    for (;;) {
      if (predicate()) return
      if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`)
      await sleep(40)
    }
  }

  async function waitForJobTerminal(ctx: AppContext, jobId: string, timeoutMs = SCENARIO_WAIT): Promise<AutomationJob> {
    const deadline = Date.now() + timeoutMs
    for (;;) {
      const job = ctx.repos.jobs.get(jobId)
      if (!job) throw new Error(`job disappeared: ${jobId}`)
      if (job.status === 'completed' || job.status === 'failed' || job.status === 'cancelled') return job
      if (Date.now() > deadline) {
        throw new Error(
          `timed out waiting for a terminal state (status=${job.status} reason=${job.statusReason ?? ''} error=${job.error ?? ''})`,
        )
      }
      await sleep(50)
    }
  }

  async function createHarness(opts: { dataDir?: string; keep?: boolean } = {}) {
    const dir = opts.dataDir ?? (await mkdtemp(join(tmpdir(), 'fern-scn-')))
    const ctx = await createCoreContext({ dataDir: dir, consoleLogs: false })
    ctx.opencode.startOptions = {
      binaryPath: process.execPath,
      commandArgs: (args) => [FIXTURE, ...args],
      minimalEnv: true,
    }
    ctx.repos.providers.createProvider({
      name: 'Scenario AI',
      type: 'openai_compatible',
      baseUrl: scnUrl,
      defaultModel: 'test-model',
    })
    return {
      ctx,
      dir,
      close: async () => {
        await ctx.shutdown()
        if (!opts.keep) await rm(dir, { recursive: true, force: true })
      },
    }
  }

  function makeJob(ctx: AppContext, fields: Partial<Parameters<AppContext['repos']['jobs']['create']>[0]> = {}) {
    return ctx.repos.jobs.create({
      title: 'scenario job',
      originalPrompt: 'Produce a short write-up of the result',
      projectId: null,
      vaultId: null,
      loopCount: 1,
      routeId: null,
      requirePlanApproval: false,
      templateId: null,
      status: 'draft',
      ...fields,
    })
  }

  type SeededStep = {
    title: string
    prompt: string
    expectedArtifacts?: string[]
    timeoutMs?: number
    status?: Task['status']
    attempt?: number
  }

  /** A job already refined + planned: the engine goes straight to execute → integrate → review. */
  function seedRun(
    ctx: AppContext,
    fields: Partial<Parameters<AppContext['repos']['jobs']['create']>[0]>,
    steps: SeededStep[],
  ) {
    const job = makeJob(ctx, fields)
    ctx.repos.jobs.setRefinedPrompt(job.id, 'refined: produce a short write-up of the result')
    ctx.repos.jobs.setPlan(job.id, {
      text: 'seeded plan',
      data: planDataSchema.parse({
        summary: 'seeded plan',
        steps: steps.map((s, i) => ({
          id: `s${i + 1}`,
          title: s.title,
          role: 'coder',
          dependsOn: [],
          prompt: s.prompt,
          expectedArtifacts: s.expectedArtifacts ?? [],
        })),
      }),
    })
    ctx.repos.jobs.update(job.id, { planApprovedAt: Date.now() })
    ctx.repos.jobs.createLoop(job.id, 1)
    const tasks = steps.map((s) =>
      ctx.repos.jobs.createTask({
        jobId: job.id,
        loopIndex: 1,
        title: s.title,
        role: 'coder',
        prompt: s.prompt,
        expectedArtifacts: s.expectedArtifacts ?? [],
        status: s.status ?? 'ready',
        attempt: s.attempt ?? 0,
        timeoutMs: s.timeoutMs ?? 30 * 60_000,
      }),
    )
    return { job, tasks }
  }

  /* --------------------------------------------------------------- scenarios */

  it('worker fails mid-task and the task settles as failed', async () => {
    resetScn([{ id: 's1', title: 'broken-transcript step', prompt: 'Carry out the step and write a short write-up of the result.' }])
    const h = await createHarness()
    const completedEvents: AppEvent[] = []
    const off = h.ctx.events.subscribeType(EVENTS.JOB_COMPLETED, (e) => completedEvents.push(e))
    try {
      const job = makeJob(h.ctx, { title: 'worker fails mid-task' })
      h.ctx.engine.start(job.id)
      const failed = await waitForJobTerminal(h.ctx, job.id)

      expect(failed.status).toBe('failed')
      expect(failed.error).toMatch(/no successful tasks and no artifacts/)
      expect(completedEvents.some((e) => e.jobId === job.id)).toBe(false)

      const tasks = h.ctx.repos.jobs.listTasks(job.id, 1)
      expect(tasks).toHaveLength(1)
      expect(isTaskTerminal(tasks[0]!)).toBe(true)
      expect(tasks[0]!.status).toBe('failed')
      expect(tasks[0]!.attempt).toBe(2)

      const workers = h.ctx.repos.workers.listWorkers(job.id)
      expect(workers).toHaveLength(2)
      expect(workers.every((w) => TERMINAL_WORKER.includes(w.status))).toBe(true)
      const last = workers[workers.length - 1]!
      expect(last.status).toBe('failed')
      expect(last.attempt).toBe(2)
      expect(last.completedAt).toBeGreaterThan(0)
      expect(last.statusReason).toContain('transcript unavailable')
      expect(last.statusReason).toContain('HTTP 500')
      expect(h.ctx.repos.workers.getSession(last.sessionId!)?.status).toBe('failed')

      const loop = h.ctx.repos.jobs.getLoop(job.id, 1)!
      expect(loop.status).toBe('failed')
      expect(loop.verdict).toBe('fail')
    } finally {
      off()
      await h.close()
    }
  }, SCENARIO_TIMEOUT)

  it('reviewer fails implementation and the loop reacts', async () => {
    resetScn([{ id: 's1', title: 'Implement the change', prompt: 'Implement the change and write a short write-up of the result.' }])
    scn.reviewVerdicts = ['fail']
    const h = await createHarness()
    const completedEvents: AppEvent[] = []
    const off = h.ctx.events.subscribeType(EVENTS.JOB_COMPLETED, (e) => completedEvents.push(e))
    try {
      const job = makeJob(h.ctx, { title: 'reviewer fails implementation', loopCount: 2 })
      h.ctx.engine.start(job.id)

      // The reviewer rejects loop 1 → the loop reacts by planning a second one.
      await waitFor(() => h.ctx.repos.jobs.getLoop(job.id, 1)?.verdict === 'fail', SCENARIO_WAIT, 'loop 1 rejected by the reviewer')
      expect(scn.reviewVerdicts).toHaveLength(0)
      expect(scn.planCalls).toBeGreaterThanOrEqual(1)

      // …and now the reviewer itself goes away: loop 2 must fail, never pass.
      scn.reviewDown = true
      const failed = await waitForJobTerminal(h.ctx, job.id)

      expect(failed.status).toBe('failed')
      expect(failed.error).toMatch(/review unavailable/)
      expect(failed.currentLoop).toBe(2)
      expect(completedEvents.some((e) => e.jobId === job.id)).toBe(false)
      expect(scn.planCalls).toBeGreaterThanOrEqual(2)

      const loop1 = h.ctx.repos.jobs.getLoop(job.id, 1)!
      const loop2 = h.ctx.repos.jobs.getLoop(job.id, 2)!
      expect(loop1.verdict).toBe('fail')
      expect(loop2.status).toBe('failed')
      expect(loop2.verdict).toBe('fail')
      expect(loop2.reviewSummary).toMatch(/review unavailable/)

      const reviews = h.ctx.repos.jobs.listReviews(job.id)
      expect(reviews).toHaveLength(2)
      expect(reviews.map((r) => r.verdict)).toEqual(['fail', 'fail'])
      expect(reviews.some((r) => r.verdict === 'pass')).toBe(false)
      expect(reviews[1]!.summary).toMatch(/review unavailable/)

      // The implementation succeeded — it is the reviewer that failed.
      expect(h.ctx.repos.jobs.listTasks(job.id, 1).every((t) => t.status === 'succeeded')).toBe(true)
      expect(h.ctx.repos.jobs.listTasks(job.id, 2).every((t) => t.status === 'succeeded')).toBe(true)
      expect(h.ctx.repos.workers.listWorkers(job.id).every((w) => w.status === 'succeeded')).toBe(true)
    } finally {
      scn.reviewDown = false
      off()
      await h.close()
    }
  }, SCENARIO_TIMEOUT)

  it('OpenCode restarts and active sessions are recovered', async () => {
    resetScn()
    // Hold session.idle back so the kill lands on a worker that is still live.
    process.env.FAKE_OC_IDLE_DELAY_MS = '3000'
    const ws = await mkdtemp(join(tmpdir(), 'fern-scn-restart-'))
    const h = await createHarness()
    try {
      const { job, tasks } = seedRun(h.ctx, { title: 'OpenCode restart mid-job', workspacePath: ws }, [
        { title: 'restart step', prompt: 'Carry out the step and write a short write-up of the result.', timeoutMs: 8_000 },
      ])
      const task = tasks[0]!

      h.ctx.engine.start(job.id)
      await waitFor(
        () => h.ctx.repos.workers.listWorkers(job.id).some((w) => w.status === 'running'),
        SCENARIO_WAIT,
        'the first worker to start',
      )
      // Let the prompt round-trip land before killing the server underneath it.
      await sleep(300)

      const before = h.ctx.opencode.listServers().filter((s) => s.directory === ws)
      expect(before).toHaveLength(1)
      expect(before[0]!.status).toBe('ready')
      expect(await h.ctx.opencode.stopServer(before[0]!.id)).toBe(true)
      expect(h.ctx.opencode.listServers().find((s) => s.id === before[0]!.id)?.status).toBe('stopped')

      // The wedged attempt must settle on its own instead of staying `running`.
      await waitFor(
        () => {
          const w = h.ctx.repos.workers.listWorkers(job.id)[0]
          return !!w && TERMINAL_WORKER.includes(w.status)
        },
        SCENARIO_WAIT,
        'the first worker to settle after the server died',
      )
      const first = h.ctx.repos.workers.listWorkers(job.id)[0]!
      expect(first.status).toBe('timed_out')
      expect(first.error).toContain('timed out')

      const done = await waitForJobTerminal(h.ctx, job.id, 50_000)
      expect(done.status).toBe('completed')

      const workers = h.ctx.repos.workers.listWorkers(job.id)
      expect(workers).toHaveLength(2)
      expect(workers[0]!.id).toBe(first.id)
      expect(workers[1]!.status).toBe('succeeded')
      expect(workers[1]!.attempt).toBe(2)
      expect(h.ctx.repos.jobs.getTask(task.id)!.status).toBe('succeeded')
      expect(h.ctx.repos.jobs.getTask(task.id)!.attempt).toBe(2)

      const servers = h.ctx.opencode.listServers().filter((s) => s.directory === ws)
      expect(servers).toHaveLength(2)
      expect(servers.filter((s) => s.status === 'ready')).toHaveLength(1)
      expect(servers.filter((s) => s.status === 'stopped')).toHaveLength(1)
    } finally {
      delete process.env.FAKE_OC_IDLE_DELAY_MS
      await h.close()
      await rm(ws, { recursive: true, force: true })
    }
  }, SCENARIO_TIMEOUT)

  it('application restarts and in-flight jobs are reconciled', async () => {
    resetScn()
    const dir = await mkdtemp(join(tmpdir(), 'fern-scn-reboot-'))

    // The previous run died mid-flight: job running, task running, worker running.
    const first = await createCoreContext({ dataDir: dir, consoleLogs: false })
    const { job, tasks } = seedRun(first, { title: 'interrupted by restart', status: 'running' }, [
      { title: 'interrupted step', prompt: 'Carry out the step and write a short write-up of the result.', status: 'running', attempt: 1 },
    ])
    const task = tasks[0]!
    const stale = first.repos.workers.createWorker({
      jobId: job.id,
      loopIndex: 1,
      taskId: task.id,
      name: 'interrupted step',
      role: 'coder',
      status: 'running',
      attempt: 1,
    })
    await first.shutdown()

    // A fresh boot over the same dataDir reconciles the wedged rows…
    const h = await createHarness({ dataDir: dir, keep: true })
    try {
      const paused = h.ctx.repos.jobs.get(job.id)!
      expect(paused.status).toBe('paused')
      expect(paused.statusReason).toBe('interrupted — resume to continue')

      const orphaned = h.ctx.repos.workers.getWorker(stale.id)!
      expect(orphaned.status).toBe('orphaned')
      expect(orphaned.statusReason).toBe('recovered after restart')
      expect(orphaned.completedAt).toBeGreaterThan(0)

      // …and resuming the job settles the task instead of leaving it wedged.
      h.ctx.engine.start(job.id)
      const done = await waitForJobTerminal(h.ctx, job.id)
      expect(done.status).toBe('completed')

      const settled = h.ctx.repos.jobs.getTask(task.id)!
      expect(settled.status).toBe('succeeded')
      expect(settled.attempt).toBe(2)

      const workers = h.ctx.repos.workers.listWorkers(job.id)
      expect(workers.map((w) => w.status)).toEqual(['orphaned', 'succeeded'])
      expect(workers[1]!.attempt).toBe(2)
    } finally {
      await h.close()
      await rm(dir, { recursive: true, force: true })
    }
  }, SCENARIO_TIMEOUT)

  it('worker modifies a file in its workspace', async () => {
    resetScn([
      {
        id: 's1',
        title: 'Write the deliverable',
        prompt: 'Create the deliverable exactly as specified. FILE:sub/dir/created.txt',
        expectedArtifacts: ['sub/dir/created.txt'],
      },
    ])
    const h = await createHarness()
    try {
      const job = makeJob(h.ctx, { title: 'workspace file writes' })
      h.ctx.engine.start(job.id)
      const done = await waitForJobTerminal(h.ctx, job.id)

      expect(done.status).toBe('completed')
      const workspace = done.workspacePath!
      expect(workspace).toBeTruthy()

      const abs = join(workspace, 'sub', 'dir', 'created.txt')
      expect(existsSync(abs)).toBe(true)
      const onDisk = await readFile(abs, 'utf8')

      const row = h.ctx.repos.workers.listArtifacts(job.id).find((a) => a.path === 'sub/dir/created.txt')
      expect(row).toBeTruthy()
      expect(row!.path).toBe('sub/dir/created.txt')
      expect(String(row!.path).startsWith(workspace)).toBe(false)
      expect(row!.status).toBe('available')
      expect(row!.bytes).toBeGreaterThan(0)
      expect(row!.checksum).toBe(createHash('sha256').update(onDisk).digest('hex'))

      const worker = h.ctx.repos.workers.listWorkers(job.id).find((w) => w.status === 'succeeded')!
      expect(worker.workspacePath).toBe(workspace)
      expect(worker.filesTouched).toContain('sub/dir/created.txt')
      expect(h.ctx.repos.jobs.listTasks(job.id, 1).every((t) => t.status === 'succeeded')).toBe(true)
    } finally {
      await h.close()
    }
  }, SCENARIO_TIMEOUT)

  it('two isolated worktrees run in parallel', async () => {
    resetScn()
    // Keep both sessions in flight long enough to observe them together.
    process.env.FAKE_OC_IDLE_DELAY_MS = '3500'
    const wsA = await mkdtemp(join(tmpdir(), 'fern-scn-wt-a-'))
    const wsB = await mkdtemp(join(tmpdir(), 'fern-scn-wt-b-'))
    const h = await createHarness()
    try {
      const a = seedRun(h.ctx, { title: 'worktree A job', workspacePath: wsA }, [
        { title: 'Alpha step', prompt: 'Write the alpha deliverable. FILE:only-alpha.txt', expectedArtifacts: ['only-alpha.txt'] },
      ])
      const b = seedRun(h.ctx, { title: 'worktree B job', workspacePath: wsB }, [
        { title: 'Beta step', prompt: 'Write the beta deliverable. FILE:only-beta.txt', expectedArtifacts: ['only-beta.txt'] },
      ])

      let peakLive = 0
      const terminal = (s: string) => s === 'completed' || s === 'failed' || s === 'cancelled'
      h.ctx.engine.start(a.job.id)
      h.ctx.engine.start(b.job.id)

      const deadline = Date.now() + 45_000
      for (;;) {
        const workers = [
          ...h.ctx.repos.workers.listWorkers(a.job.id),
          ...h.ctx.repos.workers.listWorkers(b.job.id),
        ]
        peakLive = Math.max(peakLive, workers.filter((w) => LIVE_WORKER.includes(w.status)).length)
        const jobA = h.ctx.repos.jobs.get(a.job.id)!
        const jobB = h.ctx.repos.jobs.get(b.job.id)!
        if (terminal(jobA.status) && terminal(jobB.status)) break
        if (Date.now() > deadline) {
          const describe = (id: string) =>
            h.ctx.repos.workers
              .listWorkers(id)
              .map((w) => `${w.name}=${w.status}(${w.statusReason ?? w.error ?? ''})`)
              .join(', ')
          throw new Error(
            `timed out with A=${jobA.status}/${jobA.statusReason ?? jobA.error ?? '-'} B=${jobB.status}` +
              ` — A workers: ${describe(a.job.id)} | B workers: ${describe(b.job.id)}` +
              ` | servers: ${JSON.stringify(h.ctx.opencode.listServers().map((s) => ({ dir: s.directory, status: s.status, err: s.lastError })))}` +
              ` | files written: ${existsSync(join(wsA, 'only-alpha.txt'))},${existsSync(join(wsB, 'only-beta.txt'))}`,
          )
        }
        await sleep(40)
      }

      expect(h.ctx.repos.jobs.get(a.job.id)!.status).toBe('completed')
      expect(h.ctx.repos.jobs.get(b.job.id)!.status).toBe('completed')
      expect(peakLive).toBeGreaterThanOrEqual(2)

      // Each workspace only ever saw its own deliverable.
      expect(existsSync(join(wsA, 'only-alpha.txt'))).toBe(true)
      expect(existsSync(join(wsA, 'only-beta.txt'))).toBe(false)
      expect(existsSync(join(wsB, 'only-beta.txt'))).toBe(true)
      expect(existsSync(join(wsB, 'only-alpha.txt'))).toBe(false)

      const artA = h.ctx.repos.workers.listArtifacts(a.job.id)
      expect(artA.find((x) => x.path === 'only-alpha.txt')?.status).toBe('available')
      expect(artA.some((x) => x.path === 'only-beta.txt')).toBe(false)
      const artB = h.ctx.repos.workers.listArtifacts(b.job.id)
      expect(artB.find((x) => x.path === 'only-beta.txt')?.status).toBe('available')
      expect(artB.some((x) => x.path === 'only-alpha.txt')).toBe(false)

      expect(h.ctx.repos.workers.listWorkers(a.job.id).every((w) => w.workspacePath === wsA)).toBe(true)
      expect(h.ctx.repos.workers.listWorkers(b.job.id).every((w) => w.workspacePath === wsB)).toBe(true)
      expect(h.ctx.repos.jobs.listTasks(a.job.id, 1).every((t) => t.status === 'succeeded')).toBe(true)
      expect(h.ctx.repos.jobs.listTasks(b.job.id, 1).every((t) => t.status === 'succeeded')).toBe(true)

      const servers = h.ctx.opencode.listServers().filter((s) => s.directory === wsA || s.directory === wsB)
      expect(servers).toHaveLength(2)
      expect(new Set(servers.map((s) => s.directory)).size).toBe(2)
      expect(servers.every((s) => s.status === 'ready')).toBe(true)
    } finally {
      delete process.env.FAKE_OC_IDLE_DELAY_MS
      await h.close()
      await rm(wsA, { recursive: true, force: true })
      await rm(wsB, { recursive: true, force: true })
    }
  }, SCENARIO_TIMEOUT)
})
