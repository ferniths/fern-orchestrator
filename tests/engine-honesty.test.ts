import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createCoreContext, type AppContext } from '@core/kernel/appContext'
import { BUILTIN_PROFILES } from '@core/config/builtins'
import { planDataSchema, type PlanData } from '@core/orchestration/plan'
import type { AutomationJob, Task, Worker } from '@shared/domain'

const FIXTURE = fileURLToPath(new URL('./fixtures/fake-opencode.mjs', import.meta.url))
const WAIT_MS = 30_000
const E2E_TIMEOUT = 60_000

/* -------------------------------------------------------------------------- */
/* Mock OpenAI-compatible provider                                            */
/* -------------------------------------------------------------------------- */

const PLAN_RESPONSE = {
  summary: 'One research step, one implementation step.',
  risks: [] as string[],
  acceptance: ['both steps finish'],
  steps: [
    {
      id: 's1',
      title: 'Research the requirements',
      role: 'researcher',
      dependsOn: [] as string[],
      prompt: 'Gather the requirements for the request.',
    },
    {
      id: 's2',
      title: 'Implement the solution',
      role: 'coder',
      dependsOn: ['s1'],
      prompt: 'Implement the solution from the research findings.',
    },
  ],
}

const TEXT_REPLY = 'Refined brief: a short write-up of the result.'

const state = {
  aiDown: false,
  reviewVerdicts: [] as string[],
  lastTextBody: '',
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
let providerId = ''

beforeAll(async () => {
  delete process.env.FAKE_OC_IDLE

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
          if (state.aiDown) {
            res.writeHead(503, { 'content-type': 'application/json' })
            res.end(JSON.stringify({ error: { message: 'review provider is down' } }))
            return
          }
          const name = body.response_format?.json_schema?.name
          res.writeHead(200, { 'content-type': 'application/json' })
          if (name === 'job_plan') {
            res.end(chatReply(JSON.stringify(PLAN_RESPONSE)))
            return
          }
          if (name === 'job_review') {
            const verdict = state.reviewVerdicts.length ? state.reviewVerdicts.shift()! : 'pass'
            res.end(chatReply(JSON.stringify({ verdict, summary: `review ${verdict}`, problems: [], changes: [] })))
            return
          }
          state.lastTextBody = (body.messages ?? []).map((m) => m.content).join('\n')
          res.end(chatReply(TEXT_REPLY))
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

  dataDir = await mkdtemp(join(tmpdir(), 'fern-hon-'))
  ctx = await createCoreContext({ dataDir, consoleLogs: false })
  ctx.opencode.startOptions = {
    binaryPath: process.execPath,
    commandArgs: (args) => [FIXTURE, ...args],
    minimalEnv: true,
  }
  providerId = ctx.repos.providers.createProvider({
    name: 'Mock OpenAI',
    type: 'openai_compatible',
    baseUrl,
    defaultModel: 'test-model',
  }).id
  // The Electron shell seeds these on boot; the headless context does not.
  ctx.repos.providers.resetBuiltinProfiles(BUILTIN_PROFILES)
}, 30_000)

afterAll(async () => {
  await ctx?.shutdown()
  server?.closeAllConnections?.()
  await new Promise<void>((resolve) => server?.close(() => resolve()))
  if (dataDir) await rm(dataDir, { recursive: true, force: true })
}, 30_000)

beforeEach(() => {
  state.aiDown = false
  state.reviewVerdicts = []
  state.lastTextBody = ''
})

/* -------------------------------------------------------------------------- */
/* Helpers (local copy of the orchestration harness — there is no shared one) */
/* -------------------------------------------------------------------------- */

async function waitForJobStatus(jobId: string, status: string, timeoutMs = WAIT_MS): Promise<AutomationJob> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const job = ctx.repos.jobs.get(jobId)
    if (!job) throw new Error(`job disappeared: ${jobId}`)
    if (job.status === status) return job
    if (job.status === 'failed') throw new Error(`job failed while waiting for "${status}": ${job.error ?? job.statusReason ?? ''}`)
    if (Date.now() > deadline) {
      throw new Error(`timed out waiting for "${status}" (last status=${job.status} reason=${job.statusReason ?? ''} error=${job.error ?? ''})`)
    }
    await new Promise((r) => setTimeout(r, 50))
  }
}

async function waitForJobFailed(jobId: string, timeoutMs = WAIT_MS): Promise<AutomationJob> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const job = ctx.repos.jobs.get(jobId)
    if (!job) throw new Error(`job disappeared: ${jobId}`)
    if (job.status === 'failed') return job
    if (job.status === 'completed') throw new Error(`job dishonestly completed: ${job.statusReason ?? ''}`)
    if (Date.now() > deadline) {
      throw new Error(`timed out waiting for the job to fail (last status=${job.status} reason=${job.statusReason ?? ''})`)
    }
    await new Promise((r) => setTimeout(r, 50))
  }
}

async function waitForWorkerSettled(workerId: string, timeoutMs = 15_000): Promise<Worker> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const worker = ctx.repos.workers.getWorker(workerId)
    if (worker && ['succeeded', 'failed', 'timed_out', 'aborted', 'orphaned'].includes(worker.status)) return worker
    if (Date.now() > deadline) throw new Error(`worker never settled (status=${worker?.status ?? 'missing'})`)
    await new Promise((r) => setTimeout(r, 50))
  }
}

function createJob(fields: Partial<Parameters<AppContext['repos']['jobs']['create']>[0]> = {}) {
  return ctx.repos.jobs.create({
    title: 'honesty test job',
    originalPrompt: 'Build a small demo of the orchestration pipeline',
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

/**
 * A job whose refined prompt and plan already exist, so `run()` skips the
 * refiner/planner and the only AI calls left are integration + review.
 */
function seededJob(fields: Partial<Parameters<AppContext['repos']['jobs']['create']>[0]> = {}, steps: { id: string; status: Task['status'] }[] = []) {
  const job = createJob(fields)
  ctx.repos.jobs.setRefinedPrompt(job.id, 'refined: build the demo and write it up')
  ctx.repos.jobs.setPlan(job.id, { text: 'seeded plan', data: planDataSchema.parse({ summary: 'seeded', steps: [{ id: 's1', title: 'Step 1', role: 'coder', dependsOn: [], prompt: 'do it' }] }) })
  ctx.repos.jobs.update(job.id, { planApprovedAt: Date.now() })
  ctx.repos.jobs.createLoop(job.id, 1)
  for (const step of steps) {
    ctx.repos.jobs.createTask({
      jobId: job.id,
      loopIndex: 1,
      title: `Step ${step.id}`,
      role: 'coder',
      prompt: `Carry out ${step.id}.`,
      status: step.status,
      attempt: 1,
      completedAt: Date.now(),
      retryPolicy: { maxAttempts: 1, backoffMs: 500, backoffMultiplier: 2, noRetryOn: [] },
    })
  }
  return job
}

function makePlan(steps: { id: string; role: string; dependsOn?: string[] }[]): PlanData {
  return planDataSchema.parse({
    summary: 'Test plan',
    steps: steps.map((s) => ({ id: s.id, title: `Step ${s.id}`, role: s.role, dependsOn: s.dependsOn ?? [], prompt: `Carry out step ${s.id}.` })),
  })
}

type LoopRunner = {
  executeLoop(jobId: string, loopIndex: number, signal: AbortSignal): Promise<{ failures: Task[]; cancelled: boolean }>
}
type DispatchRunner = {
  dispatchTask(jobId: string, loopIndex: number, task: Task): Promise<void>
}

function loopJob(title: string) {
  const job = createJob({ title })
  ctx.repos.jobs.createLoop(job.id, 1)
  return job
}

/* -------------------------------------------------------------------------- */
/* 1. A dead reviewer is never an approval                                     */
/* -------------------------------------------------------------------------- */

describe('review honesty', () => {
  it('fails the job when the reviewer cannot run instead of recording a pass', async () => {
    state.aiDown = true
    const seen: { type: string; severity: string; message: string }[] = []
    const off = ctx.events.subscribe((e) => seen.push({ type: e.type, severity: e.severity, message: e.message }))

    // Work is already done: only integration + review still have to run.
    const job = seededJob({ title: 'review unavailable' }, [
      { id: 's1', status: 'succeeded' },
      { id: 's2', status: 'succeeded' },
    ])
    ctx.engine.start(job.id)
    const failed = await waitForJobFailed(job.id)

    expect(failed.error).toMatch(/review unavailable/)
    expect(failed.status).toBe('failed')

    const loop = ctx.repos.jobs.getLoop(job.id, 1)!
    expect(loop.status).toBe('failed')
    expect(loop.verdict).not.toBe('pass')
    expect(loop.reviewSummary).toMatch(/review unavailable/)

    const review = ctx.repos.jobs.listReviews(job.id).find((r) => r.loopIndex === 1)
    expect(review).toBeTruthy()
    expect(review!.verdict).not.toBe('pass')
    expect(review!.verdict).toBe('fail')
    expect(review!.summary).toMatch(/review unavailable/)

    // The swallowed synthesis failure must be user visible, not just a log line.
    expect(loop.unresolved.some((u) => u.startsWith('integration step failed'))).toBe(true)
    const integrationEvents = seen.filter((e) => e.type === 'provider.failed' && e.message.includes('integration failed for loop 1'))
    expect(integrationEvents.length).toBeGreaterThan(0)
    expect(integrationEvents[0]!.severity).toBe('warn')

    off()
  }, E2E_TIMEOUT)
})

/* -------------------------------------------------------------------------- */
/* 2. An empty task list fails loudly                                          */
/* -------------------------------------------------------------------------- */

describe('empty loop guard', () => {
  it('refuses to run a loop that has no tasks at all', async () => {
    const job = loopJob('empty plan')
    const runner = ctx.engine as unknown as LoopRunner

    await expect(runner.executeLoop(job.id, 1, new AbortController().signal)).rejects.toThrow(/has no tasks/)
    expect(ctx.repos.jobs.get(job.id)!.status).not.toBe('completed')
  })
})

/* -------------------------------------------------------------------------- */
/* 3. Unresolved failures block completion even when the review says pass      */
/* -------------------------------------------------------------------------- */

describe('unresolved work blocks completion', () => {
  it('does not complete a non-final loop that still carries a failed task', async () => {
    state.reviewVerdicts = ['pass']
    const job = createJob({ title: 'unresolved on loop 1', loopCount: 2 })
    ctx.repos.jobs.setRefinedPrompt(job.id, 'refined: build the demo')
    ctx.repos.jobs.setPlan(job.id, { text: 'seeded plan', data: makePlan([{ id: 's1', role: 'coder' }, { id: 's2', role: 'coder', dependsOn: ['s1'] }]) })
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
    const failed = await waitForJobFailed(job.id)

    expect(failed.status).not.toBe('completed')
    expect(failed.error).toMatch(/unresolved/)
    expect(failed.error).toContain('bad step')

    const loop = ctx.repos.jobs.getLoop(job.id, 1)!
    expect(loop.status).toBe('failed')
    expect(loop.verdict).toBe('fail')
    // The reviewer did answer "pass" — the guard, not the verdict, is what stopped it.
    expect(ctx.repos.jobs.listReviews(job.id).some((r) => r.verdict === 'pass')).toBe(true)
    expect(ctx.repos.jobs.getTask(good.id)!.status).toBe('succeeded')
  }, E2E_TIMEOUT)
})

/* -------------------------------------------------------------------------- */
/* 4. Orphaned workers settle instead of spinning                              */
/* -------------------------------------------------------------------------- */

describe('orphaned workers', () => {
  it('treats an orphaned session as a retryable failure and settles the task', async () => {
    const job = loopJob('orphaned retry')
    const task = ctx.repos.jobs.createTask({
      jobId: job.id,
      loopIndex: 1,
      title: 'interrupted step',
      role: 'coder',
      prompt: 'Carry out the interrupted step.',
      status: 'running',
      attempt: 1,
      retryPolicy: { maxAttempts: 2, backoffMs: 500, backoffMultiplier: 2, noRetryOn: [] },
    })
    ctx.repos.workers.createWorker({
      jobId: job.id,
      loopIndex: 1,
      taskId: task.id,
      name: 'interrupted step',
      role: 'coder',
      status: 'orphaned',
      statusReason: 'recovered after restart',
      attempt: 1,
      completedAt: Date.now(),
    })

    const runner = ctx.engine as unknown as LoopRunner
    const outcome = await runner.executeLoop(job.id, 1, new AbortController().signal)

    expect(outcome.cancelled).toBe(false)
    expect(outcome.failures).toEqual([])

    const final = ctx.repos.jobs.getTask(task.id)!
    expect(final.status).toBe('succeeded')
    expect(final.attempt).toBe(2)

    const workers = ctx.repos.workers.listWorkers(job.id)
    expect(workers).toHaveLength(2)
    expect(workers[workers.length - 1]!.status).toBe('succeeded')
  }, E2E_TIMEOUT)

  it('settles an orphaned task as failed when no attempts remain', async () => {
    const job = loopJob('orphaned exhausted')
    const task = ctx.repos.jobs.createTask({
      jobId: job.id,
      loopIndex: 1,
      title: 'doomed step',
      role: 'coder',
      prompt: 'Carry out the doomed step.',
      status: 'running',
      attempt: 1,
      retryPolicy: { maxAttempts: 1, backoffMs: 500, backoffMultiplier: 2, noRetryOn: [] },
    })
    ctx.repos.workers.createWorker({
      jobId: job.id,
      loopIndex: 1,
      taskId: task.id,
      name: 'doomed step',
      role: 'coder',
      status: 'orphaned',
      statusReason: 'recovered after restart',
      attempt: 1,
      completedAt: Date.now(),
    })

    const runner = ctx.engine as unknown as LoopRunner
    const outcome = await runner.executeLoop(job.id, 1, new AbortController().signal)

    expect(outcome.failures.map((t) => t.id)).toEqual([task.id])
    expect(ctx.repos.jobs.getTask(task.id)!.status).toBe('failed')
  })
})

/* -------------------------------------------------------------------------- */
/* 5. Dispatch-time model routing                                              */
/* -------------------------------------------------------------------------- */

describe('dispatch routing', () => {
  it('stamps a concrete provider + model (and the role profile) onto the worker', async () => {
    const job = loopJob('routing target')
    const task = ctx.repos.jobs.createTask({
      jobId: job.id,
      loopIndex: 1,
      title: 'routed step',
      role: 'coder',
      prompt: 'Carry out the routed step.',
      status: 'ready',
    })

    const runner = ctx.engine as unknown as DispatchRunner
    await runner.dispatchTask(job.id, 1, task)

    const worker = ctx.repos.workers.listWorkers(job.id)[0]!
    expect(worker.providerId).toBe(providerId)
    expect(worker.modelId).toBe('test-model')
    expect(worker.profileId).toBeTruthy()
    expect(worker.systemPrompt).toMatch(/implementation agent/i)
    expect(worker.opencodeAgent).toBe('build')

    // The stamped ids must be usable: the session really runs and settles.
    const settled = await waitForWorkerSettled(worker.id)
    expect(settled.status).toBe('succeeded')
  }, E2E_TIMEOUT)

  it('warns loudly when no provider or model can be resolved', async () => {
    const bareDir = await mkdtemp(join(tmpdir(), 'fern-hon-bare-'))
    const bare = await createCoreContext({ dataDir: bareDir, consoleLogs: false })
    bare.opencode.startOptions = {
      binaryPath: process.execPath,
      commandArgs: (args) => [FIXTURE, ...args],
      minimalEnv: true,
    }
    expect(bare.repos.providers.listProviders()).toHaveLength(0)

    try {
      const job = bare.repos.jobs.create({
        title: 'no provider job',
        originalPrompt: 'do the thing',
        projectId: null,
        vaultId: null,
        loopCount: 1,
        routeId: null,
        requirePlanApproval: false,
        templateId: null,
        status: 'draft',
      })
      bare.repos.jobs.createLoop(job.id, 1)
      const task = bare.repos.jobs.createTask({
        jobId: job.id,
        loopIndex: 1,
        title: 'unrouted step',
        role: 'coder',
        prompt: 'Carry out the unrouted step.',
        status: 'ready',
      })

      const runner = bare.engine as unknown as DispatchRunner
      await runner.dispatchTask(job.id, 1, task)

      const worker = bare.repos.workers.listWorkers(job.id)[0]!
      expect(worker.providerId).toBeNull()
      expect(worker.modelId).toBeNull()

      const warnings = bare.logger.query({ level: 'warn', contains: 'OpenCode default model' })
      expect(warnings.length).toBeGreaterThan(0)
      expect(warnings[0]!.message).toMatch(/no provider\/model resolved/)
      expect(warnings[0]!.data).toMatchObject({ taskId: task.id, role: 'coder' })
    } finally {
      await bare.shutdown()
      await rm(bareDir, { recursive: true, force: true })
    }
  }, E2E_TIMEOUT)
})

/* -------------------------------------------------------------------------- */
/* 6. Zero-work completion guard                                               */
/* -------------------------------------------------------------------------- */

describe('zero-work guard', () => {
  it('fails a loop that produced no successful tasks and no artifacts', async () => {
    state.reviewVerdicts = ['pass']
    const job = seededJob({ title: 'zero work' }, [
      { id: 's1', status: 'skipped' },
      { id: 's2', status: 'skipped' },
    ])
    ctx.engine.start(job.id)
    const failed = await waitForJobFailed(job.id)

    expect(failed.status).toBe('failed')
    expect(failed.error).toMatch(/loop produced no successful tasks and no artifacts/)
    expect(ctx.repos.jobs.getLoop(job.id, 1)!.status).toBe('failed')
    expect(ctx.repos.workers.listArtifacts(job.id).filter((a) => a.loopIndex === 1)).toHaveLength(0)
  }, E2E_TIMEOUT)
})

/* -------------------------------------------------------------------------- */
/* 7. Integration body tells the truth about evidence                          */
/* -------------------------------------------------------------------------- */

describe('integration evidence', () => {
  it('reports captured output instead of passing objectives off as results', async () => {
    state.reviewVerdicts = ['pass']
    const job = seededJob({ title: 'truthful integration' }, [{ id: 's1', status: 'succeeded' }])
    ctx.engine.start(job.id)
    await waitForJobStatus(job.id, 'completed')

    expect(state.lastTextBody).toContain('Evidence, not intent')
    expect(state.lastTextBody).toContain('intent:')
    expect(state.lastTextBody).toContain('captured output: none recorded — this step produced no captured output')
    expect(state.lastTextBody).toContain('artifacts: none recorded')
  }, E2E_TIMEOUT)
})
