import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createCoreContext, type AppContext } from '@core/kernel/appContext'
import { AppError } from '@core/kernel/errors'
import { compilePlan, planDataSchema, PLAN_JSON_SCHEMA, REVIEW_JSON_SCHEMA, type PlanData } from '@core/orchestration/plan'
import {
  findBlocked,
  isLoopSettled,
  isTaskTerminal,
  latestWorkerByTask,
  pickReady,
  pickRetries,
} from '@core/orchestration/scheduler'
import { automationJobSchema, type Task, type Worker } from '@shared/domain'

const FIXTURE = fileURLToPath(new URL('./fixtures/fake-opencode.mjs', import.meta.url))
const WAIT_MS = 30_000
const E2E_TIMEOUT = 60_000

/* -------------------------------------------------------------------------- */
/* Mock OpenAI-compatible provider                                            */
/* -------------------------------------------------------------------------- */

const PLAN_RESPONSE = {
  summary: 'Research the goal, implement the change, then synthesize the deliverable.',
  risks: ['Requirements shift mid-flight'],
  acceptance: ['All three steps finish', 'A single integrated answer is produced'],
  steps: [
    {
      id: 's1',
      title: 'Research the requirements',
      role: 'researcher',
      dependsOn: [] as string[],
      prompt: 'Gather the requirements, constraints and definition of done for the request.',
    },
    {
      id: 's2',
      title: 'Implement the solution',
      role: 'coder',
      dependsOn: ['s1'],
      prompt: 'Implement the solution using the research findings from step one.',
    },
    {
      id: 's3',
      title: 'Assemble the final deliverable',
      role: 'synthesizer',
      dependsOn: ['s2'],
      prompt: 'Merge the work of every prior step into one coherent deliverable for the user.',
    },
  ],
}

const TEXT_REPLY =
  'Refined brief: build a small demo that exercises refine, plan, execute and review, with a short write-up of the result.'

const state = {
  planCalls: 0,
  reviewCalls: 0,
  textCalls: 0,
  reviewVerdicts: [] as string[],
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
  // The fake OpenCode server must emit session.idle for the engine to settle workers.
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
          let body: { response_format?: { json_schema?: { name?: string } } } = {}
          if (chunks.length) body = JSON.parse(Buffer.concat(chunks).toString()) as typeof body
          const name = body.response_format?.json_schema?.name
          res.writeHead(200, { 'content-type': 'application/json' })
          if (name === 'job_plan') {
            state.planCalls++
            res.end(chatReply(JSON.stringify(PLAN_RESPONSE)))
            return
          }
          if (name === 'job_review') {
            state.reviewCalls++
            const verdict = state.reviewVerdicts.length ? state.reviewVerdicts.shift()! : 'pass'
            res.end(
              chatReply(JSON.stringify({ verdict, summary: `review pass ${state.reviewCalls}`, problems: [], changes: [] })),
            )
            return
          }
          state.textCalls++
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

  dataDir = await mkdtemp(join(tmpdir(), 'fern-eng-'))
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
}, 30_000)

afterAll(async () => {
  await ctx?.shutdown()
  server?.closeAllConnections?.()
  await new Promise<void>((resolve) => server?.close(() => resolve()))
  if (dataDir) await rm(dataDir, { recursive: true, force: true })
}, 30_000)

beforeEach(() => {
  state.planCalls = 0
  state.reviewCalls = 0
  state.textCalls = 0
  state.reviewVerdicts = []
})

/* -------------------------------------------------------------------------- */
/* Helpers                                                                    */
/* -------------------------------------------------------------------------- */

async function waitForJobStatus(jobId: string, status: string, timeoutMs = WAIT_MS): Promise<void> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const job = ctx.repos.jobs.get(jobId)
    if (job?.status === 'failed') {
      throw new Error(`job failed while waiting for "${status}": ${job.error ?? job.statusReason ?? 'unknown error'}`)
    }
    if (job?.status === status) return
    if (Date.now() > deadline) {
      throw new Error(
        `timed out waiting for status "${status}" (last status=${job?.status} reason=${job?.statusReason ?? ''} error=${job?.error ?? ''})`,
      )
    }
    await new Promise((r) => setTimeout(r, 50))
  }
}

function createJob(fields: Partial<Parameters<AppContext['repos']['jobs']['create']>[0]> = {}) {
  return ctx.repos.jobs.create({
    title: 'orchestration test job',
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

function rawStep(id: string, role: string, dependsOn: string[]): Record<string, unknown> {
  return { id, title: `Step ${id}`, role, dependsOn, prompt: `Carry out step ${id} for this job.` }
}

function makePlan(steps: Record<string, unknown>[]): PlanData {
  return planDataSchema.parse({ summary: 'Test plan', steps })
}

function unitJob() {
  return automationJobSchema.parse({
    id: 'job_unit',
    title: 'unit job',
    originalPrompt: 'do the thing',
    createdAt: 1,
    updatedAt: 1,
  })
}

function expectInvalidResponse(fn: () => unknown, match: RegExp): void {
  let caught: unknown
  try {
    fn()
  } catch (err) {
    caught = err
  }
  expect(caught).toBeInstanceOf(AppError)
  expect((caught as AppError).code).toBe('invalid_response')
  expect((caught as AppError).message).toMatch(match)
}

function makeTask(partial: Partial<Task> & { id: string }): Task {
  return {
    jobId: 'job_sched',
    loopIndex: 1,
    title: partial.id,
    role: 'coder',
    status: 'pending',
    dependencyIds: [],
    priority: 50,
    createdAt: 1,
    updatedAt: 1,
    attempt: 0,
    retryPolicy: { maxAttempts: 2, backoffMs: 1_000, backoffMultiplier: 2, noRetryOn: [] },
    ...partial,
  } as unknown as Task
}

function makeWorker(partial: Partial<Worker> & { id: string; taskId: string }): Worker {
  return {
    jobId: 'job_sched',
    loopIndex: 1,
    name: partial.id,
    role: 'coder',
    workspacePath: '',
    status: 'queued',
    createdAt: 1,
    updatedAt: 1,
    ...partial,
  } as unknown as Worker
}

/* -------------------------------------------------------------------------- */
/* compilePlan                                                                */
/* -------------------------------------------------------------------------- */

describe('compilePlan()', () => {
  it('turns a three step plan into tasks, nodes and layered edges', () => {
    const plan = makePlan([
      rawStep('s1', 'researcher', []),
      rawStep('s2', 'coder', ['s1']),
      rawStep('s3', 'synthesizer', ['s2']),
    ])
    const compiled = compilePlan(unitJob(), 1, plan)

    expect(compiled.tasks).toHaveLength(3)
    expect(compiled.nodes).toHaveLength(3)
    expect(compiled.edges).toHaveLength(2)

    const byStep = new Map(compiled.tasks.map((t, i) => [plan.steps[i]!.id, t]))
    const t1 = byStep.get('s1')!
    const t2 = byStep.get('s2')!
    const t3 = byStep.get('s3')!

    expect(t1.dependencyIds).toEqual([])
    expect(t2.dependencyIds).toEqual([t1.id])
    expect(t3.dependencyIds).toEqual([t2.id])
    expect(t1.status).toBe('ready')
    expect(t2.status).toBe('pending')
    expect(t3.status).toBe('pending')

    const nodeByTask = new Map(compiled.nodes.map((n) => [n.taskId ?? '', n]))
    expect(nodeByTask.get(t1.id)?.kind).toBe('research')
    expect(nodeByTask.get(t2.id)?.kind).toBe('implementation')
    expect(nodeByTask.get(t3.id)?.kind).toBe('final')

    const n1 = nodeByTask.get(t1.id)!
    const n2 = nodeByTask.get(t2.id)!
    const n3 = nodeByTask.get(t3.id)!
    expect(compiled.edges.map((e) => `${e.sourceNodeId}->${e.targetNodeId}`)).toEqual([
      `${n1.id}->${n2.id}`,
      `${n2.id}->${n3.id}`,
    ])
    expect(compiled.edges.every((e) => e.kind === 'dependency')).toBe(true)

    expect(n1.x).toBe(80)
    expect(n2.x).toBe(380)
    expect(n3.x).toBe(680)
    expect(n1.y).toBe(60)
    expect(n2.y).toBe(60)
    expect(n3.y).toBe(60)
  })

  it('drops prose that the model wrote into expectedArtifacts', () => {
    const plan = makePlan([
      {
        ...rawStep('s1', 'coder', []),
        expectedArtifacts: ['report.md', 'Confirmation of no pending TODOs', 'List of top-level files in workspace', 'src/app.ts'],
      },
    ])
    const compiled = compilePlan(unitJob(), 1, plan)
    expect(compiled.tasks[0]!.expectedArtifacts).toEqual(['report.md', 'src/app.ts'])
  })

  it('rejects duplicate step ids', () => {
    const plan = makePlan([rawStep('s1', 'researcher', []), rawStep('s1', 'coder', [])])
    expectInvalidResponse(() => compilePlan(unitJob(), 1, plan), /duplicate step id/)
  })

  it('rejects a dependency on a step that does not exist', () => {
    const plan = makePlan([rawStep('s1', 'researcher', []), rawStep('s2', 'coder', ['ghost'])])
    expectInvalidResponse(() => compilePlan(unitJob(), 1, plan), /unknown step: ghost/)
  })

  it('rejects a step that depends on itself', () => {
    const plan = makePlan([rawStep('s1', 'researcher', ['s1'])])
    expectInvalidResponse(() => compilePlan(unitJob(), 1, plan), /depends on itself/)
  })

  it('rejects a plan with a dependency cycle', () => {
    const plan = makePlan([rawStep('s1', 'researcher', ['s2']), rawStep('s2', 'coder', ['s1'])])
    expectInvalidResponse(() => compilePlan(unitJob(), 1, plan), /dependency cycle/)
  })

  it('deduplicates repeated dependsOn entries into one dependency and one edge', () => {
    const plan = makePlan([rawStep('s1', 'researcher', []), rawStep('s2', 'coder', ['s1', 's1', 's1'])])
    const compiled = compilePlan(unitJob(), 1, plan)

    const t1 = compiled.tasks[0]!
    const t2 = compiled.tasks[1]!
    expect(t2.dependencyIds).toEqual([t1.id])
    expect(t2.status).toBe('pending')
    expect(compiled.edges).toHaveLength(1)
    expect(new Set(compiled.edges.map((e) => e.id)).size).toBe(1)
  })
})

/* -------------------------------------------------------------------------- */
/* Strict-mode structured output contracts                                    */
/* -------------------------------------------------------------------------- */

describe('structured output contracts', () => {
  it('marks every declared property required so strict-mode providers accept the schema', () => {
    const plan = PLAN_JSON_SCHEMA.schema
    expect(new Set(plan.required)).toEqual(new Set(Object.keys(plan.properties)))

    const step = plan.properties.steps.items
    expect(new Set(step.required)).toEqual(new Set(Object.keys(step.properties)))

    const review = REVIEW_JSON_SCHEMA.schema
    expect(new Set(review.required)).toEqual(new Set(Object.keys(review.properties)))
  })

  it('still parses a plan response that contains every declared field', () => {
    const full = {
      ...PLAN_RESPONSE,
      steps: PLAN_RESPONSE.steps.map((s) => ({
        ...s,
        objective: `Objective for ${s.title}`,
        expectedArtifacts: ['notes.md'],
        successCriteria: ['step complete'],
        rationale: 'needed by the goal',
        complexity: 'medium',
        timeoutMinutes: 30,
      })),
    }
    const parsed = planDataSchema.parse(full)
    expect(parsed.steps).toHaveLength(3)
    expect(parsed.steps[0]!.rationale).toBe('needed by the goal')
    expect(parsed.steps[0]!.timeoutMinutes).toBe(30)
  })
})

/* -------------------------------------------------------------------------- */
/* Scheduler                                                                  */
/* -------------------------------------------------------------------------- */

describe('scheduler', () => {
  it('isTaskTerminal only reports states that can never progress', () => {
    for (const status of ['succeeded', 'failed', 'cancelled', 'skipped', 'timed_out', 'blocked'] as const) {
      expect(isTaskTerminal(makeTask({ id: `t-${status}`, status }))).toBe(true)
    }
    for (const status of ['pending', 'ready', 'running', 'waiting_approval'] as const) {
      expect(isTaskTerminal(makeTask({ id: `t-${status}`, status }))).toBe(false)
    }
  })

  it('isLoopSettled waits for every task to settle', () => {
    expect(isLoopSettled([makeTask({ id: 'a', status: 'succeeded' }), makeTask({ id: 'b', status: 'failed' })])).toBe(true)
    expect(isLoopSettled([makeTask({ id: 'a', status: 'succeeded' }), makeTask({ id: 'b', status: 'blocked' })])).toBe(true)
    expect(isLoopSettled([makeTask({ id: 'a', status: 'succeeded' }), makeTask({ id: 'b', status: 'running' })])).toBe(false)
    expect(isLoopSettled([makeTask({ id: 'a', status: 'ready' })])).toBe(false)
  })

  it('findBlocked blocks tasks whose dependency failed, not the healthy ones', () => {
    const failed = makeTask({ id: 'a', status: 'failed', completedAt: 10 })
    const succeeded = makeTask({ id: 'a', status: 'succeeded', completedAt: 10 })
    const dependent = makeTask({ id: 'b', status: 'pending', dependencyIds: ['a'] })
    const independent = makeTask({ id: 'c', status: 'pending' })

    expect(findBlocked(new Map([['a', failed], ['b', dependent], ['c', independent]]))).toEqual(['b'])
    expect(findBlocked(new Map([['a', succeeded], ['b', dependent], ['c', independent]]))).toEqual([])
  })

  it('findBlocked keeps waiting while a dependency is still in flight', () => {
    const running = makeTask({ id: 'a', status: 'running' })
    const readyDep = makeTask({ id: 'a', status: 'ready' })
    const dependent = makeTask({ id: 'b', status: 'pending', dependencyIds: ['a'] })

    expect(findBlocked(new Map([['a', running], ['b', dependent]]))).toEqual([])
    expect(findBlocked(new Map([['a', readyDep], ['b', dependent]]))).toEqual([])
  })

  it('findBlocked cascades through blocked or missing dependencies', () => {
    const blocked = makeTask({ id: 'a', status: 'blocked' })
    const dependent = makeTask({ id: 'b', status: 'pending', dependencyIds: ['a'] })
    expect(findBlocked(new Map([['a', blocked], ['b', dependent]]))).toEqual(['b'])

    const orphan = makeTask({ id: 'x', status: 'pending', dependencyIds: ['ghost'] })
    expect(findBlocked(new Map([['x', orphan]]))).toEqual(['x'])
  })

  it('pickReady returns nothing on a zero budget', () => {
    expect(pickReady([makeTask({ id: 'a', status: 'ready' })], 0)).toEqual([])
    expect(pickReady([makeTask({ id: 'a', status: 'ready' })], -1)).toEqual([])
  })

  it('pickReady only dispatches tasks whose dependencies succeeded', () => {
    const running = makeTask({ id: 'a', status: 'running' })
    const waiting = makeTask({ id: 'b', status: 'ready', dependencyIds: ['a'] })
    const free = makeTask({ id: 'c', status: 'ready' })

    expect(pickReady([running, waiting, free], 5).map((t) => t.id)).toEqual(['c'])
  })

  it('pickReady sorts by priority and honors the budget', () => {
    const low = makeTask({ id: 'low', status: 'ready', priority: 10, createdAt: 1 })
    const high = makeTask({ id: 'high', status: 'ready', priority: 90, createdAt: 2 })

    expect(pickReady([low, high], 5).map((t) => t.id)).toEqual(['high', 'low'])
    expect(pickReady([low, high], 1).map((t) => t.id)).toEqual(['high'])
  })

  it('pickRetries only picks failed tasks with attempts left and a retryable worker', () => {
    const retryable = makeTask({ id: 'a', status: 'failed', attempt: 1 })
    const exhausted = makeTask({ id: 'b', status: 'failed', attempt: 2 })
    const succeeded = makeTask({ id: 'c', status: 'succeeded' })
    const workers = new Map<string, Worker>([
      ['a', makeWorker({ id: 'w-a', taskId: 'a', status: 'failed' })],
      ['b', makeWorker({ id: 'w-b', taskId: 'b', status: 'failed' })],
      ['c', makeWorker({ id: 'w-c', taskId: 'c', status: 'failed' })],
    ])

    expect(pickRetries([retryable, exhausted, succeeded], workers).map((t) => t.id)).toEqual(['a'])
  })

  it('pickRetries skips tasks whose latest worker is not retryable', () => {
    const task = makeTask({ id: 'a', status: 'failed', attempt: 1 })
    const aborted = new Map<string, Worker>([['a', makeWorker({ id: 'w', taskId: 'a', status: 'aborted' })]])
    const finished = new Map<string, Worker>([['a', makeWorker({ id: 'w', taskId: 'a', status: 'succeeded' })]])

    expect(pickRetries([task], aborted)).toEqual([])
    expect(pickRetries([task], finished)).toEqual([])
    expect(pickRetries([task], new Map())).toHaveLength(1)
  })

  it('latestWorkerByTask keeps the last worker per task', () => {
    const first = makeWorker({ id: 'w1', taskId: 'a', status: 'failed' })
    const second = makeWorker({ id: 'w2', taskId: 'a', status: 'succeeded' })
    const other = makeWorker({ id: 'w3', taskId: 'b', status: 'failed' })

    const map = latestWorkerByTask([first, second, other])
    expect(map.size).toBe(2)
    expect(map.get('a')?.id).toBe('w2')
    expect(map.get('b')?.id).toBe('w3')
  })
})

/* -------------------------------------------------------------------------- */
/* Engine end-to-end                                                          */
/* -------------------------------------------------------------------------- */

describe('Engine', () => {
  it('runs refine → plan → workers → integrate → review to completion', async () => {
    const job = createJob({ title: 'happy path' })
    ctx.engine.start(job.id)
    await waitForJobStatus(job.id, 'completed')

    const done = ctx.repos.jobs.get(job.id)!
    expect(done.refinedPrompt.length).toBeGreaterThan(0)

    const plan = ctx.repos.jobs.getPlan(job.id)
    expect(plan).toBeTruthy()
    expect((plan!.data as PlanData).steps).toHaveLength(3)
    expect(plan!.text.length).toBeGreaterThan(0)

    const tasks = ctx.repos.jobs.listTasks(job.id, 1)
    expect(tasks).toHaveLength(3)
    expect(tasks.every((t) => t.status === 'succeeded')).toBe(true)

    const workers = ctx.repos.workers.listWorkers(job.id)
    expect(workers).toHaveLength(3)
    expect(workers.every((w) => w.status === 'succeeded')).toBe(true)

    const artifact = ctx.repos.workers.listArtifacts(job.id).find((a) => a.name === 'integration')
    expect(artifact).toBeTruthy()
    expect((artifact?.content ?? '').length).toBeGreaterThan(0)

    expect(ctx.repos.jobs.listReviews(job.id).some((r) => r.verdict === 'pass')).toBe(true)
    expect(ctx.repos.jobs.getLoop(job.id, 1)?.status).toBe('completed')
    expect(done.stats.workersRun).toBe(3)
    expect(state.planCalls).toBe(1)
    expect(state.reviewCalls).toBe(1)
  }, E2E_TIMEOUT)

  it('pauses at the plan approval gate and resumes once approved', async () => {
    const job = createJob({ title: 'approval gate', requirePlanApproval: true })
    ctx.engine.start(job.id)
    await waitForJobStatus(job.id, 'awaiting_approval')

    const pending = ctx.repos.workers
      .listApprovals('pending')
      .find((a) => a.jobId === job.id && a.kind === 'plan')
    expect(pending).toBeTruthy()
    expect(ctx.repos.workers.listWorkers(job.id)).toHaveLength(0)

    ctx.repos.workers.decideApproval(pending!.id, true)
    ctx.repos.jobs.update(job.id, { planApprovedAt: Date.now() })
    ctx.engine.start(job.id)
    await waitForJobStatus(job.id, 'completed')

    expect(ctx.repos.jobs.listTasks(job.id, 1).every((t) => t.status === 'succeeded')).toBe(true)
    expect(ctx.repos.workers.listWorkers(job.id)).toHaveLength(3)
    expect(ctx.repos.jobs.listReviews(job.id).some((r) => r.verdict === 'pass')).toBe(true)
  }, E2E_TIMEOUT)

  it('re-plans and runs a second loop when the review needs more work', async () => {
    state.reviewVerdicts = ['needs_more_work']
    const job = createJob({ title: 'multi loop', loopCount: 2 })
    ctx.engine.start(job.id)
    await waitForJobStatus(job.id, 'completed')

    const loop1 = ctx.repos.jobs.getLoop(job.id, 1)!
    expect(loop1.verdict).toBe('partial')
    const loop2 = ctx.repos.jobs.getLoop(job.id, 2)!
    expect(loop2.status).toBe('completed')
    expect(loop2.verdict).toBe('pass')

    expect(ctx.repos.jobs.get(job.id)!.currentLoop).toBe(2)
    expect(ctx.repos.jobs.listTasks(job.id, 2)).toHaveLength(3)
    expect(ctx.repos.jobs.listTasks(job.id, 2).every((t) => t.status === 'succeeded')).toBe(true)

    const done = ctx.repos.jobs.get(job.id)!
    expect(ctx.repos.jobs.listTasks(job.id, 1).every((t) => t.status === 'succeeded')).toBe(true)
    // Stats are scoped to the finishing loop (loop 2): counting both loops here
    // was the cross-loop double count — replans must not inflate the totals.
    expect(done.stats.tasksCompleted).toBe(3)
    expect(done.stats.workersRun).toBe(3)
    expect(done.stats.durationMs).toBeGreaterThan(0)

    expect(state.planCalls).toBeGreaterThanOrEqual(2)
    expect(state.reviewCalls).toBe(2)
  }, E2E_TIMEOUT)

  it('start() while the job is already running returns the same job', async () => {
    const job = createJob({ title: 'concurrent guard' })
    const first = ctx.engine.start(job.id)
    const second = ctx.engine.start(job.id)

    expect(first.id).toBe(job.id)
    expect(second.id).toBe(job.id)
    expect(ctx.engine.isRunning(job.id)).toBe(true)

    await waitForJobStatus(job.id, 'completed')
    expect(ctx.repos.workers.listWorkers(job.id)).toHaveLength(3)
    expect(ctx.repos.jobs.listTasks(job.id, 1)).toHaveLength(3)
  }, E2E_TIMEOUT)

  it('start() while a plan approval is pending keeps the approval detail and tasks intact', async () => {
    const job = createJob({ title: 'stale approval guard', requirePlanApproval: true })
    ctx.engine.start(job.id)
    await waitForJobStatus(job.id, 'awaiting_approval')

    const planCallsBefore = state.planCalls
    const taskIdsBefore = ctx.repos.jobs.listTasks(job.id, 1).map((t) => t.id)
    expect(taskIdsBefore).toHaveLength(3)

    const returned = ctx.engine.start(job.id)
    expect(returned.status).toBe('awaiting_approval')
    await new Promise((r) => setTimeout(r, 500))

    expect(ctx.repos.jobs.get(job.id)!.status).toBe('awaiting_approval')
    expect(state.planCalls).toBe(planCallsBefore)
    expect(ctx.repos.jobs.listTasks(job.id, 1).map((t) => t.id)).toEqual(taskIdsBefore)

    const pending = ctx.repos.workers
      .listApprovals('pending')
      .find((a) => a.jobId === job.id && a.kind === 'plan')
    expect(pending).toBeTruthy()

    ctx.repos.workers.decideApproval(pending!.id, true)
    ctx.repos.jobs.update(job.id, { planApprovedAt: Date.now() })
    ctx.engine.start(job.id)
    await waitForJobStatus(job.id, 'completed')

    expect(ctx.repos.jobs.listTasks(job.id, 1).every((t) => t.status === 'succeeded')).toBe(true)
    expect(state.planCalls).toBe(planCallsBefore)
  }, E2E_TIMEOUT)
})

/* -------------------------------------------------------------------------- */
/* executeLoop (direct)                                                       */
/* -------------------------------------------------------------------------- */

type ExecuteLoopRunner = {
  executeLoop(jobId: string, loopIndex: number, signal: AbortSignal): Promise<{ failures: Task[]; cancelled: boolean }>
}

function loopJob(title: string) {
  const job = createJob({ title })
  ctx.repos.jobs.createLoop(job.id, 1)
  return job
}

describe('executeLoop', () => {
  it('retries a failed task even when it is the last non-terminal task', async () => {
    const job = loopJob('retry after settle')
    const task = ctx.repos.jobs.createTask({
      jobId: job.id,
      loopIndex: 1,
      title: 'flaky step',
      role: 'coder',
      prompt: 'Carry out the flaky step.',
      status: 'running',
      attempt: 1,
      retryPolicy: { maxAttempts: 2, backoffMs: 1_000, backoffMultiplier: 2, noRetryOn: [] },
    })
    ctx.repos.workers.createWorker({
      jobId: job.id,
      loopIndex: 1,
      taskId: task.id,
      name: 'flaky step',
      role: 'coder',
      status: 'failed',
      attempt: 1,
      error: 'boom',
      statusReason: 'boom',
      completedAt: Date.now(),
    })

    const runner = ctx.engine as unknown as ExecuteLoopRunner
    const outcome = await runner.executeLoop(job.id, 1, new AbortController().signal)

    expect(outcome.cancelled).toBe(false)
    expect(outcome.failures).toEqual([])

    const final = ctx.repos.jobs.getTask(task.id)!
    expect(final.status).toBe('succeeded')
    expect(final.attempt).toBe(2)

    const workers = ctx.repos.workers.listWorkers(job.id)
    expect(workers).toHaveLength(2)
    const retried = workers[workers.length - 1]!
    expect(retried.attempt).toBe(2)
    expect(retried.status).toBe('succeeded')
  }, E2E_TIMEOUT)

  it('counts blocked dependents as failures', async () => {
    const job = loopJob('blocked failures')
    const doomed = ctx.repos.jobs.createTask({
      jobId: job.id,
      loopIndex: 1,
      title: 'doomed step',
      role: 'coder',
      prompt: 'Carry out the doomed step.',
      status: 'failed',
      attempt: 1,
      retryPolicy: { maxAttempts: 1, backoffMs: 1_000, backoffMultiplier: 2, noRetryOn: [] },
      error: 'boom',
      statusReason: 'boom',
      completedAt: Date.now(),
    })
    const dependent = ctx.repos.jobs.createTask({
      jobId: job.id,
      loopIndex: 1,
      title: 'dependent step',
      role: 'coder',
      prompt: 'Carry out the dependent step.',
      status: 'pending',
      dependencyIds: [doomed.id],
    })

    const runner = ctx.engine as unknown as ExecuteLoopRunner
    const outcome = await runner.executeLoop(job.id, 1, new AbortController().signal)

    const failureIds = outcome.failures.map((t) => t.id)
    expect(failureIds).toContain(doomed.id)
    expect(failureIds).toContain(dependent.id)
    expect(ctx.repos.jobs.getTask(dependent.id)!.status).toBe('blocked')
  }, E2E_TIMEOUT)

  it('un-blocks a dependent once its dependency succeeds', async () => {
    const job = loopJob('unblock after dep success')
    const first = ctx.repos.jobs.createTask({
      jobId: job.id,
      loopIndex: 1,
      title: 'first step',
      role: 'coder',
      prompt: 'Carry out the first step.',
      status: 'failed',
      attempt: 1,
      retryPolicy: { maxAttempts: 2, backoffMs: 1_000, backoffMultiplier: 2, noRetryOn: [] },
      error: 'boom',
      statusReason: 'boom',
      completedAt: Date.now(),
    })
    const second = ctx.repos.jobs.createTask({
      jobId: job.id,
      loopIndex: 1,
      title: 'second step',
      role: 'coder',
      prompt: 'Carry out the second step.',
      status: 'pending',
      dependencyIds: [first.id],
    })
    ctx.repos.workers.createWorker({
      jobId: job.id,
      loopIndex: 1,
      taskId: first.id,
      name: 'first step',
      role: 'coder',
      status: 'failed',
      attempt: 1,
      error: 'boom',
      statusReason: 'boom',
      completedAt: Date.now(),
    })

    const runner = ctx.engine as unknown as ExecuteLoopRunner
    const outcome = await runner.executeLoop(job.id, 1, new AbortController().signal)

    expect(outcome.failures).toEqual([])
    expect(ctx.repos.jobs.getTask(first.id)!.status).toBe('succeeded')
    expect(ctx.repos.jobs.getTask(second.id)!.status).toBe('succeeded')
  }, E2E_TIMEOUT)
})
