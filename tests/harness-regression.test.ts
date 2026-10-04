import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { existsSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createCoreContext, type AppContext } from '@core/kernel/appContext'
import { BUILTIN_PROFILES } from '@core/config/builtins'
import { EVENTS } from '@core/kernel/eventBus'
import { planDataSchema } from '@core/orchestration/plan'
import { isTaskTerminal } from '@core/orchestration/scheduler'
import type { AppEvent, AutomationJob } from '@shared/domain'

/**
 * Engine-level regression coverage for the fixed harness: the worker-manager
 * tests already prove dispatch honesty against a manually driven session, so
 * the gaps here are the full plan → dispatch → settle → review chains.
 */

const FIXTURE = fileURLToPath(new URL('./fixtures/fake-opencode.mjs', import.meta.url))
const WAIT_MS = 30_000
const E2E_TIMEOUT = 60_000
const LIVE_WORKER = ['queued', 'starting', 'running', 'waiting_approval']
const TERMINAL_WORKER = ['succeeded', 'failed', 'timed_out', 'aborted', 'orphaned']

/* -------------------------------------------------------------------------- */
/* Mock OpenAI-compatible provider                                            */
/* -------------------------------------------------------------------------- */

type RawStep = {
  id: string
  title: string
  role: string
  prompt: string
  dependsOn?: string[]
  expectedArtifacts?: string[]
}

function plan(steps: RawStep[], summary = 'Regression plan') {
  return {
    summary,
    risks: [] as string[],
    acceptance: ['every step finishes honestly'],
    steps: steps.map((s) => ({ dependsOn: [] as string[], ...s })),
  }
}

const state = {
  planCalls: 0,
  reviewCalls: 0,
  reviewVerdicts: [] as string[],
  reviewBodies: [] as string[],
  plan: plan([{ id: 's1', title: 'Do the work', role: 'coder', prompt: 'Do the work and reply DONE.' }]),
}

function chatReply(content: string): string {
  return JSON.stringify({
    id: 'cmpl-1',
    model: 'test-model',
    choices: [{ message: { role: 'assistant', content }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 11, completion_tokens: 7 },
  })
}

let server: Server
let baseUrl = ''
let ctx: AppContext
let dataDir: string

beforeAll(async () => {
  delete process.env.FAKE_OC_IDLE
  delete process.env.FAKE_OC_IDLE_DELAY_MS

  server = createServer((req: IncomingMessage, res: ServerResponse) => {
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
          let body: { response_format?: { json_schema?: { name?: string } }; messages?: { role: string; content: string }[] } = {}
          if (chunks.length) body = JSON.parse(Buffer.concat(chunks).toString()) as typeof body
          const name = body.response_format?.json_schema?.name
          res.writeHead(200, { 'content-type': 'application/json' })
          if (name === 'job_plan') {
            state.planCalls++
            res.end(chatReply(JSON.stringify(state.plan)))
            return
          }
          if (name === 'job_review') {
            state.reviewCalls++
            state.reviewBodies.push(((body.messages ?? []).map((m) => m.content).join('\n')).slice(0, 8_000))
            const verdict = state.reviewVerdicts.length ? state.reviewVerdicts.shift()! : 'pass'
            res.end(chatReply(JSON.stringify({ verdict, summary: `review ${verdict}`, problems: [], changes: [] })))
            return
          }
          res.end(chatReply('Refined brief: a short write-up of the result.'))
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
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  const port = typeof address === 'object' && address ? address.port : 0
  baseUrl = `http://127.0.0.1:${port}/v1`

  dataDir = await mkdtemp(join(tmpdir(), 'fern-reg-'))
  ctx = await createCoreContext({ dataDir, consoleLogs: false })
  ctx.opencode.startOptions = {
    binaryPath: process.execPath,
    commandArgs: (args) => [FIXTURE, ...args],
    minimalEnv: true,
  }
  ctx.repos.providers.createProvider({
    name: 'Mock OpenAI',
    type: 'openai_compatible',
    baseUrl,
    defaultModel: 'test-model',
  })
  ctx.repos.providers.resetBuiltinProfiles(BUILTIN_PROFILES)
}, 30_000)

afterAll(async () => {
  delete process.env.FAKE_OC_IDLE_DELAY_MS
  await ctx?.shutdown()
  server?.closeAllConnections?.()
  await new Promise<void>((resolve) => server?.close(() => resolve()))
  if (dataDir) await rm(dataDir, { recursive: true, force: true })
}, 30_000)

beforeEach(() => {
  state.planCalls = 0
  state.reviewCalls = 0
  state.reviewVerdicts = []
  state.reviewBodies = []
  state.plan = plan([{ id: 's1', title: 'Do the work', role: 'coder', prompt: 'Do the work and reply DONE.' }])
  delete process.env.FAKE_OC_IDLE_DELAY_MS
})

/* -------------------------------------------------------------------------- */
/* Helpers                                                                    */
/* -------------------------------------------------------------------------- */

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

async function waitForTerminal(jobId: string, timeoutMs = WAIT_MS): Promise<AutomationJob> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const job = ctx.repos.jobs.get(jobId)
    if (!job) throw new Error(`job disappeared: ${jobId}`)
    if (job.status === 'completed' || job.status === 'failed' || job.status === 'cancelled') return job
    if (Date.now() > deadline) {
      throw new Error(`timed out waiting for a terminal state (last status=${job.status} reason=${job.statusReason ?? ''} error=${job.error ?? ''})`)
    }
    await sleep(50)
  }
}

function createJob(fields: Partial<Parameters<AppContext['repos']['jobs']['create']>[0]> = {}) {
  return ctx.repos.jobs.create({
    title: 'harness regression job',
    originalPrompt: 'Exercise the fixed harness end to end',
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

/* -------------------------------------------------------------------------- */
/* 1. Parallel dispatch at the engine level                                    */
/* -------------------------------------------------------------------------- */

describe('parallel dispatch', () => {
  it('runs three independent plan steps concurrently, before any of them settles', async () => {
    state.plan = plan([
      { id: 's1', title: 'Independent step one', role: 'coder', prompt: 'Carry out step one and reply DONE.' },
      { id: 's2', title: 'Independent step two', role: 'coder', prompt: 'Carry out step two and reply DONE.' },
      { id: 's3', title: 'Independent step three', role: 'coder', prompt: 'Carry out step three and reply DONE.' },
    ])
    // Hold session.idle back so the in-flight window is observable.
    process.env.FAKE_OC_IDLE_DELAY_MS = '2500'
    try {
      const job = createJob({ title: 'parallel dispatch' })
      const firstCrossing = { seen: false, live: 0, settled: -1, taskIds: [] as string[] }
      ctx.engine.start(job.id)

      const deadline = Date.now() + E2E_TIMEOUT - 15_000
      for (;;) {
        const workers = ctx.repos.workers.listWorkers(job.id)
        const live = workers.filter((w) => LIVE_WORKER.includes(w.status))
        if (!firstCrossing.seen && live.length >= 3) {
          firstCrossing.seen = true
          firstCrossing.live = live.length
          firstCrossing.settled = workers.filter((w) => TERMINAL_WORKER.includes(w.status)).length
          firstCrossing.taskIds = [...new Set(live.map((w) => w.taskId))]
        }
        const current = ctx.repos.jobs.get(job.id)
        if (current?.status === 'completed' || current?.status === 'failed') break
        if (Date.now() > deadline) throw new Error(`timed out (last status=${current?.status} reason=${current?.statusReason ?? ''})`)
        await sleep(40)
      }

      const done = ctx.repos.jobs.get(job.id)!
      expect(done.status).toBe('completed')
      expect(firstCrossing.seen).toBe(true)
      expect(firstCrossing.live).toBeGreaterThanOrEqual(3)
      expect(firstCrossing.settled).toBe(0)
      expect(firstCrossing.taskIds.length).toBeGreaterThanOrEqual(3)

      const workers = ctx.repos.workers.listWorkers(job.id)
      expect(workers).toHaveLength(3)
      expect(workers.every((w) => w.status === 'succeeded')).toBe(true)
      expect(ctx.repos.jobs.listTasks(job.id, 1).every((t) => t.status === 'succeeded')).toBe(true)
    } finally {
      delete process.env.FAKE_OC_IDLE_DELAY_MS
    }
  }, E2E_TIMEOUT)
})

/* -------------------------------------------------------------------------- */
/* 2. On-disk artifact through the whole plan → dispatch chain                 */
/* -------------------------------------------------------------------------- */

describe('engine artifact collection', () => {
  it('collects a real on-disk artifact row for an engine-dispatched FILE: step', async () => {
    state.plan = plan([
      {
        id: 's1',
        title: 'Write the marker file',
        role: 'coder',
        prompt: 'Create the deliverable exactly as specified. FILE:engine-artifact.txt',
        expectedArtifacts: ['engine-artifact.txt'],
      },
    ])
    const job = createJob({ title: 'engine file artifact' })
    ctx.engine.start(job.id)
    const done = await waitForTerminal(job.id)

    expect(done.status).toBe('completed')
    expect(done.workspacePath).toBeTruthy()
    const workspace = done.workspacePath!

    const row = ctx.repos.workers.listArtifacts(job.id).find((a) => a.path === 'engine-artifact.txt')
    expect(row).toBeTruthy()
    expect(row!.status).toBe('available')
    expect(row!.bytes).toBeGreaterThan(0)
    expect(existsSync(join(workspace, 'engine-artifact.txt'))).toBe(true)

    const worker = ctx.repos.workers.listWorkers(job.id).find((w) => w.status === 'succeeded')!
    expect(worker.filesTouched).toContain('engine-artifact.txt')
    expect(worker.artifacts.length).toBeGreaterThan(0)
  }, E2E_TIMEOUT)
})

/* -------------------------------------------------------------------------- */
/* 3. A hard "fail" verdict on a non-final loop replans (only needs_more_work   */
/*    was covered before)                                                      */
/* -------------------------------------------------------------------------- */

describe('review verdict routing', () => {
  it("replans loop 2 when the reviewer answers 'fail' on a non-final loop", async () => {
    state.reviewVerdicts = ['fail']
    const job = createJob({ title: 'fail verdict replans', loopCount: 2 })
    ctx.engine.start(job.id)
    const done = await waitForTerminal(job.id)

    expect(done.status).toBe('completed')
    expect(done.currentLoop).toBe(2)

    const loop1 = ctx.repos.jobs.getLoop(job.id, 1)!
    expect(loop1.verdict).toBe('fail')
    const loop2 = ctx.repos.jobs.getLoop(job.id, 2)!
    expect(loop2.status).toBe('completed')
    expect(loop2.verdict).toBe('pass')

    expect(ctx.repos.jobs.listTasks(job.id, 2).every((t) => t.status === 'succeeded')).toBe(true)
    expect(ctx.repos.jobs.listReviews(job.id).some((r) => r.loopIndex === 1 && r.verdict === 'fail')).toBe(true)
    expect(state.reviewCalls).toBe(2)
    expect(state.planCalls).toBeGreaterThanOrEqual(2)
  }, E2E_TIMEOUT)
})

/* -------------------------------------------------------------------------- */
/* 4. An unresolved task on the final loop never completes the job             */
/* -------------------------------------------------------------------------- */

describe('final-loop failure honesty', () => {
  it('fails a final loop that still carries a failed task instead of completing', async () => {
    const job = createJob({ title: 'unresolved on the final loop', loopCount: 1 })
    ctx.repos.jobs.setRefinedPrompt(job.id, 'refined: build the demo')
    ctx.repos.jobs.setPlan(job.id, {
      text: 'seeded plan',
      data: planDataSchema.parse({ summary: 'seeded', steps: [{ id: 's1', title: 'Step 1', role: 'coder', dependsOn: [], prompt: 'do it' }] }),
    })
    ctx.repos.jobs.update(job.id, { planApprovedAt: Date.now() })
    ctx.repos.jobs.createLoop(job.id, 1)

    const good = ctx.repos.jobs.createTask({
      jobId: job.id,
      loopIndex: 1,
      title: 'good step',
      role: 'coder',
      prompt: 'Carry out the good step.',
      status: 'succeeded',
      attempt: 1,
      completedAt: Date.now(),
    })
    const bad = ctx.repos.jobs.createTask({
      jobId: job.id,
      loopIndex: 1,
      title: 'bad step',
      role: 'coder',
      prompt: 'Carry out the bad step.',
      status: 'failed',
      attempt: 1,
      error: 'boom',
      statusReason: 'boom',
      completedAt: Date.now(),
      retryPolicy: { maxAttempts: 1, backoffMs: 500, backoffMultiplier: 2, noRetryOn: [] },
    })
    ctx.repos.workers.createWorker({
      jobId: job.id,
      loopIndex: 1,
      taskId: bad.id,
      name: 'bad step',
      role: 'coder',
      status: 'failed',
      attempt: 1,
      error: 'boom',
      statusReason: 'boom',
      completedAt: Date.now(),
    })

    ctx.engine.start(job.id)
    const failed = await waitForTerminal(job.id)

    expect(failed.status).toBe('failed')
    expect(failed.error).toMatch(/final loop/)
    expect(failed.error).toMatch(/unresolved/)
    expect(ctx.repos.jobs.getLoop(job.id, 1)!.verdict).toBe('fail')
    // The reviewer answered "pass" — the unresolved guard is what stopped it.
    expect(ctx.repos.jobs.listReviews(job.id).some((r) => r.verdict === 'pass')).toBe(true)
    expect(ctx.repos.jobs.getTask(good.id)!.status).toBe('succeeded')
    expect(ctx.repos.jobs.getTask(bad.id)!.status).toBe('failed')
  }, E2E_TIMEOUT)
})

/* -------------------------------------------------------------------------- */
/* 5. Subagent visibility through the engine chain (manager-level existed)     */
/* -------------------------------------------------------------------------- */

describe('subagent visibility', () => {
  it('records the child session for a subagent-titled step dispatched by the engine', async () => {
    state.plan = plan([
      { id: 's1', title: 'delegate to the subagent helper', role: 'coder', prompt: 'Run the helper subagent then reply DONE.' },
    ])
    const spawned: AppEvent[] = []
    const off = ctx.events.subscribeType(EVENTS.SUBAGENT_SPAWNED, (e) => spawned.push(e))
    try {
      const job = createJob({ title: 'subagent engine run' })
      ctx.engine.start(job.id)
      const done = await waitForTerminal(job.id)
      expect(done.status).toBe('completed')

      const worker = ctx.repos.workers.listWorkers(job.id).find((w) => w.status === 'succeeded')!
      expect(worker.sessionId).toBeTruthy()

      const event = spawned.find((e) => e.jobId === job.id)
      expect(event).toBeTruthy()
      const childId = event!.data.childSessionId as string
      expect(childId).toMatch(/^ses_child_/)

      const child = ctx.repos.workers.getSession(childId)
      expect(child).toBeTruthy()
      expect(child?.parentSessionId).toBe(worker.sessionId)
      expect(child?.jobId).toBe(job.id)
    } finally {
      off()
    }
  }, E2E_TIMEOUT)
})

/* -------------------------------------------------------------------------- */
/* 6. No fake success when the transcript has no assistant message             */
/* -------------------------------------------------------------------------- */

describe('completion honesty through the engine', () => {
  it('fails the job when a worker never produced assistant output (no fake success)', async () => {
    state.plan = plan([{ id: 's1', title: 'no-output step', role: 'coder', prompt: 'Attempt the step without producing output.' }])
    const completedEvents: AppEvent[] = []
    const off = ctx.events.subscribeType(EVENTS.JOB_COMPLETED, (e) => completedEvents.push(e))
    try {
      const job = createJob({ title: 'no output honesty', loopCount: 1 })
      ctx.engine.start(job.id)
      const done = await waitForTerminal(job.id)

      expect(done.status).toBe('failed')
      expect(completedEvents.some((e) => e.jobId === job.id)).toBe(false)
      expect(done.error).toMatch(/unresolved/)

      const workers = ctx.repos.workers.listWorkers(job.id)
      expect(workers.length).toBeGreaterThanOrEqual(2)
      expect(workers.every((w) => TERMINAL_WORKER.includes(w.status))).toBe(true)
      expect(workers.some((w) => (w.statusReason ?? '').includes('no assistant output'))).toBe(true)

      const tasks = ctx.repos.jobs.listTasks(job.id, 1)
      expect(tasks.every((t) => isTaskTerminal(t))).toBe(true)
      expect(tasks.some((t) => t.status === 'failed')).toBe(true)
    } finally {
      off()
    }
  }, E2E_TIMEOUT)
})

/* -------------------------------------------------------------------------- */
/* 7. A rejected final review fails the job (no silent completion)             */
/* -------------------------------------------------------------------------- */

describe('final-loop review honesty', () => {
  it("fails the job when the reviewer answers 'fail' on the final loop", async () => {
    state.reviewVerdicts = ['fail']
    const completedEvents: AppEvent[] = []
    const off = ctx.events.subscribeType(EVENTS.JOB_COMPLETED, (e) => completedEvents.push(e))
    try {
      const job = createJob({ title: 'final review rejection', loopCount: 1 })
      ctx.engine.start(job.id)
      const done = await waitForTerminal(job.id)

      expect(done.status).toBe('failed')
      expect(done.error).toMatch(/final review verdict "fail"/)
      expect(completedEvents.some((e) => e.jobId === job.id)).toBe(false)
      expect(ctx.repos.jobs.getLoop(job.id, 1)!.verdict).toBe('fail')
      expect(ctx.repos.jobs.listReviews(job.id).some((r) => r.loopIndex === 1 && r.verdict === 'fail')).toBe(true)
    } finally {
      off()
    }
  }, E2E_TIMEOUT)
})

/* -------------------------------------------------------------------------- */
/* 8. The reviewer is judged on harness-verified evidence, not model prose     */
/* -------------------------------------------------------------------------- */

describe('review evidence', () => {
  it('sends application-verified on-disk evidence to the reviewer', async () => {
    state.plan = plan([
      {
        id: 's1',
        title: 'Write the evidence file',
        role: 'coder',
        prompt: 'Create the deliverable exactly as specified. FILE:evidence-check.txt',
        expectedArtifacts: ['evidence-check.txt'],
      },
    ])
    const job = createJob({ title: 'review evidence', loopCount: 1 })
    ctx.engine.start(job.id)
    const done = await waitForTerminal(job.id)

    expect(done.status).toBe('completed')
    expect(state.reviewCalls).toBe(1)

    const body = state.reviewBodies.join('\n')
    expect(body).toContain('Application-verified evidence')
    expect(body).toContain('Steps (1):')
    expect(body).toContain('evidence-check.txt: PRESENT')
    expect(body).not.toContain('MISSING')
  }, E2E_TIMEOUT)
})
