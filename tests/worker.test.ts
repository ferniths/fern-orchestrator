import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createHash } from 'node:crypto'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createCoreContext, type AppContext } from '@core/kernel/appContext'
import { EVENTS } from '@core/kernel/eventBus'
import { OpenCodeAdapter, type TranscriptMessage } from '@core/opencode/adapter'
import { messagesToTranscript } from '@core/opencode/workerManager'
import type { NormalizedEvent } from '@core/opencode/events'
import type { AppEvent, Worker } from '@shared/domain'

const FIXTURE = fileURLToPath(new URL('./fixtures/fake-opencode.mjs', import.meta.url))

let ctx: AppContext
let dataDir: string
let jobId: string
let taskId: string

async function waitFor(predicate: () => boolean, timeoutMs = 8_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (predicate()) return
    await new Promise((r) => setTimeout(r, 50))
  }
  throw new Error('condition not met within timeout')
}

function event(partial: Partial<NormalizedEvent> & { type: string; sessionId: string }): NormalizedEvent {
  return { data: {}, directory: null, at: Date.now(), ...partial }
}

beforeAll(async () => {
  dataDir = await mkdtemp(join(tmpdir(), 'fern-wm-'))
  ctx = await createCoreContext({ dataDir, consoleLogs: false })
  // Keep the fake server from emitting session.idle: these tests assert
  // abort/timeout behaviour on workers that must stay active.
  process.env.FAKE_OC_IDLE = '0'
  ctx.opencode.startOptions = {
    binaryPath: process.execPath,
    commandArgs: (args) => [FIXTURE, ...args],
    minimalEnv: true,
  }
  // The approval-deadline tests drive the sweep directly; the background poll
  // would otherwise race them for the same rows.
  ctx.opencode.autoSweep = false

  const job = ctx.repos.jobs.create({
    title: 'worker runtime test',
    originalPrompt: 'exercise the worker manager',
    projectId: null,
    vaultId: null,
    loopCount: 1,
    routeId: null,
    requirePlanApproval: false,
    templateId: null,
    status: 'draft',
  })
  jobId = job.id
  const task = ctx.repos.jobs.createTask({ jobId, loopIndex: 1, title: 'step one', role: 'coder', objective: 'build the thing', prompt: 'build the thing' })
  taskId = task.id
}, 30_000)

afterAll(async () => {
  delete process.env.FAKE_OC_IDLE
  await ctx?.shutdown()
  await rm(dataDir, { recursive: true, force: true })
})

function makeWorker(name: string, extra: Partial<Worker> = {}): Worker {
  return ctx.repos.workers.createWorker({
    jobId,
    taskId,
    loopIndex: 1,
    name,
    role: 'coder',
    objective: 'build the thing',
    taskPrompt: 'build the thing',
    workspacePath: join(dataDir, 'ws'),
    ...extra,
  })
}

/** The fake server suppresses `session.idle`; tests drive completion manually. */
function fireIdle(worker: Worker): void {
  const sessionId = worker.sessionId!
  const serverId = ctx.repos.workers.getSession(sessionId)!.serverId
  ctx.opencode.handleEvent(serverId, event({ type: 'session.idle', sessionId, data: { info: { sessionID: sessionId } } }))
}

type CreateSessionOpts = { title?: string; parentID?: string | null; agent?: string | null }

/** The fake server ignores `parentID`, so observe it at the adapter boundary. */
function spyCreateSession(): { calls: CreateSessionOpts[]; restore: () => void } {
  const original = OpenCodeAdapter.prototype.createSession
  const calls: CreateSessionOpts[] = []
  OpenCodeAdapter.prototype.createSession = function (this: OpenCodeAdapter, opts: CreateSessionOpts = {}) {
    calls.push(opts)
    return original.call(this, opts)
  }
  return {
    calls,
    restore: () => {
      OpenCodeAdapter.prototype.createSession = original
    },
  }
}

describe('WorkerManager', () => {
  it('reports OpenCode detection', async () => {
    const detection = await ctx.opencode.detect()
    expect(detection.detected).toBe(true)
    expect(detection.path).toBeTruthy()
    if (detection.version) expect(detection.version).toMatch(/\d+/)
  }, 20_000)

  it('dispatches a worker onto a native session', async () => {
    const worker = makeWorker('worker A')
    const dispatched = await ctx.opencode.dispatch(worker)
    expect(dispatched.status).toBe('running')
    expect(dispatched.sessionId).toMatch(/^ses_/)
    expect(dispatched.attempt).toBe(1)

    const session = ctx.repos.workers.getSession(dispatched.sessionId!)
    expect(session?.status).toBe('active')
    expect(session?.workerId).toBe(worker.id)

    const servers = ctx.opencode.listServers()
    expect(servers.some((s) => s.status === 'ready')).toBe(true)
    expect(servers[0]?.logTail).toBeUndefined()
  }, 30_000)

  it('states the exact workspace path in the prompt the model receives', async () => {
    const worker = makeWorker('worker path-hint')
    const dispatched = await ctx.opencode.dispatch(worker)
    const serverId = ctx.repos.workers.getSession(dispatched.sessionId!)!.serverId
    const server = ctx.opencode.listServers().find((s) => s.id === serverId)!
    const prompts = (await (await fetch(`${server.url}/__prompts`)).json()) as { sessionId: string; text: string }[]
    const mine = prompts.find((p) => p.sessionId === dispatched.sessionId)
    expect(mine?.text).toContain(join(dataDir, 'ws'))
    expect(mine?.text).toContain('build the thing')
    expect(mine?.text).toContain('Only create or modify the files this task asks for')
    // a worker globbed twice, saw the file absent, then trusted fusion-panel prose
    expect(mine?.text).toContain('only a write/bash call in this session can create a file')
    ctx.opencode.handleEvent(
      serverId,
      event({ type: 'session.idle', sessionId: dispatched.sessionId!, data: { info: { sessionID: dispatched.sessionId } } }),
    )
  }, 30_000)

  it('lists the expected artifacts and the previous failure in the prompt', async () => {
    const task = ctx.repos.jobs.createTask({
      jobId,
      loopIndex: 1,
      title: 'write the summary',
      role: 'coder',
      objective: 'write summary.md',
      prompt: 'write summary.md',
      expectedArtifacts: ['summary.md', 'notes/report.md'],
    })
    const dead = makeWorker('worker earlier attempt', { taskId: task.id, taskPrompt: 'write summary.md' })
    ctx.repos.workers.updateWorker(dead.id, { status: 'failed', error: 'missing expected artifacts: summary.md', statusReason: 'missing expected artifacts: summary.md' })

    const worker = makeWorker('worker with feedback', { taskId: task.id, taskPrompt: 'write summary.md' })
    const dispatched = await ctx.opencode.dispatch(worker)
    const serverId = ctx.repos.workers.getSession(dispatched.sessionId!)!.serverId
    const server = ctx.opencode.listServers().find((s) => s.id === serverId)!
    const prompts = (await (await fetch(`${server.url}/__prompts`)).json()) as { sessionId: string; text: string }[]
    const text = prompts.find((p) => p.sessionId === dispatched.sessionId)?.text ?? ''

    expect(text).toContain('- summary.md')
    expect(text).toContain('- notes/report.md')
    expect(text).toContain('A previous attempt at this exact task failed: missing expected artifacts: summary.md')
    expect(text.indexOf('- summary.md')).toBeLessThan(text.indexOf('write summary.md'))
    ctx.opencode.handleEvent(
      serverId,
      event({ type: 'session.idle', sessionId: dispatched.sessionId!, data: { info: { sessionID: dispatched.sessionId } } }),
    )
  }, 30_000)

  it('names the other tasks files as off-limits so a worker cannot clobber a sibling deliverable', async () => {
    const mine = ctx.repos.jobs.createTask({
      jobId,
      loopIndex: 1,
      title: 'write the summary',
      role: 'coder',
      objective: 'write summary.md',
      prompt: 'write summary.md',
      expectedArtifacts: ['summary.md'],
    })
    ctx.repos.jobs.createTask({
      jobId,
      loopIndex: 1,
      title: 'write the marker',
      role: 'coder',
      objective: 'write harness-smoke-test.txt',
      prompt: 'write harness-smoke-test.txt',
      expectedArtifacts: ['harness-smoke-test.txt'],
    })

    const worker = makeWorker('worker sibling guard', { taskId: mine.id, taskPrompt: 'write summary.md' })
    const dispatched = await ctx.opencode.dispatch(worker)
    const serverId = ctx.repos.workers.getSession(dispatched.sessionId!)!.serverId
    const server = ctx.opencode.listServers().find((s) => s.id === serverId)!
    const prompts = (await (await fetch(`${server.url}/__prompts`)).json()) as { sessionId: string; text: string }[]
    const text = prompts.find((p) => p.sessionId === dispatched.sessionId)?.text ?? ''

    expect(text).toContain('These files belong to other tasks in this job')
    const siblingAt = text.indexOf('These files belong to other tasks')
    expect(text.slice(siblingAt)).toContain('- harness-smoke-test.txt')
    // the own file stays in the "must exist when you finish" checklist, not the off-limits list
    expect(text.indexOf('- summary.md')).toBeGreaterThan(-1)
    expect(text.indexOf('- summary.md')).toBeLessThan(siblingAt)
    ctx.opencode.handleEvent(
      serverId,
      event({ type: 'session.idle', sessionId: dispatched.sessionId!, data: { info: { sessionID: dispatched.sessionId } } }),
    )
  }, 30_000)

  it('turns OpenCode permission prompts into dashboard approvals and replies', async () => {
    const worker = ctx.repos.workers.listWorkers(jobId).find((w) => w.name === 'worker A')!
    const sessionId = worker.sessionId!
    const serverId = ctx.repos.workers.getSession(sessionId)!.serverId

    ctx.opencode.handleEvent(
      serverId,
      event({
        type: 'permission.asked',
        sessionId,
        data: { permission: { id: 'per_42', type: 'bash', pattern: 'git commit -m "wip"', sessionID: sessionId, title: 'Commit changes' } },
      }),
    )

    const approval = ctx.repos.workers.listApprovals('pending').find((a) => a.opencodePermissionId === 'per_42')
    expect(approval).toBeTruthy()
    expect(approval?.kind).toBe('git_commit')
    expect(ctx.repos.workers.getWorker(worker.id)?.status).toBe('waiting_approval')

    await ctx.opencode.decidePermission(approval!.id, true)
    expect(ctx.repos.workers.getWorker(worker.id)?.status).toBe('running')
  })

  it('owns a permission raised from a subagent session and answers it', async () => {
    const worker = ctx.repos.workers.listWorkers(jobId).find((w) => w.name === 'worker A')!
    const parentSession = worker.sessionId!
    const serverId = ctx.repos.workers.getSession(parentSession)!.serverId

    // Subagent sessions are stored exactly like this: no workerId of their own,
    // only a link back to the parent session.
    ctx.repos.workers.upsertSession({
      sessionId: 'ses_subagent_perm',
      workerId: null,
      serverId,
      parentSessionId: parentSession,
      jobId,
      projectId: null,
      title: 'subagent',
      directory: '',
      modelId: null,
      providerId: null,
      opencodeAgent: null,
      depth: 1,
      status: 'active',
      summary: '',
      diffStats: { additions: 0, deletions: 0, files: 0 },
      lastEventAt: Date.now(),
    })

    ctx.opencode.handleEvent(
      serverId,
      event({
        type: 'permission.asked',
        sessionId: 'ses_subagent_perm',
        data: { permission: { id: 'per_sub', type: 'bash', pattern: 'git commit -m sub', sessionID: 'ses_subagent_perm' } },
      }),
    )

    const approval = ctx.repos.workers.listApprovals('pending').find((a) => a.opencodePermissionId === 'per_sub')
    expect(approval).toBeTruthy()
    // Without the parent walk this approval would have no owner at all — no job
    // to show it under and no worker to reply to.
    expect(approval?.workerId).toBe(worker.id)
    expect(approval?.jobId).toBe(jobId)

    const replied = await ctx.opencode.decidePermission(approval!.id, true)
    expect(replied).toBe(true)
    expect(ctx.repos.workers.getWorker(worker.id)?.status).toBe('running')
  })

  it('gives every permission approval a deadline', async () => {
    const worker = ctx.repos.workers.listWorkers(jobId).find((w) => w.name === 'worker A')!
    const sessionId = worker.sessionId!
    const serverId = ctx.repos.workers.getSession(sessionId)!.serverId

    ctx.opencode.handleEvent(
      serverId,
      event({
        type: 'permission.asked',
        sessionId,
        data: { permission: { id: 'per_deadline', type: 'bash', pattern: 'git push origin main', sessionID: sessionId } },
      }),
    )

    const approval = ctx.repos.workers.listApprovals('pending').find((a) => a.opencodePermissionId === 'per_deadline')!
    expect(approval.kind).toBe('git_push')
    expect(approval.expiresAt).toBeGreaterThan(Date.now())
    // default approvalTimeoutMs is 15 minutes
    expect(approval.expiresAt! - approval.createdAt).toBe(15 * 60_000)
    expect(ctx.repos.workers.getWorker(worker.id)?.status).toBe('waiting_approval')

    await ctx.opencode.decidePermission(approval.id, true)
  })

  it('rejects an unanswered approval once its deadline passes', async () => {
    const worker = ctx.repos.workers.listWorkers(jobId).find((w) => w.name === 'worker A')!
    const approval = ctx.repos.workers.createApproval({
      kind: 'git_push',
      title: 'push needs approval',
      detail: 'git push origin main',
      jobId,
      workerId: worker.id,
      sessionId: worker.sessionId,
      opencodePermissionId: 'per_expired',
      expiresAt: Date.now() - 1_000,
    })
    ctx.repos.workers.updateWorker(worker.id, { status: 'waiting_approval', statusReason: 'approval needed: push needs approval' })

    const expired = await ctx.opencode.sweepExpiredApprovals()

    expect(expired.map((a) => a.id)).toContain(approval.id)
    const after = ctx.repos.workers.getApproval(approval.id)!
    expect(after.status).toBe('expired')
    expect(after.decisionNote).toBe('approval timed out — rejected')
    const settled = ctx.repos.workers.getWorker(worker.id)!
    // the reject reached OpenCode, so the worker resumed instead of parking
    expect(settled.status).toBe('running')
    expect(settled.statusReason).toBe('approval timed out — rejected')
  })

  it('never expires an approval without a deadline', async () => {
    const plan = ctx.repos.workers.createApproval({ kind: 'plan', title: 'Plan approval — loop 1', detail: 'the DAG', jobId })
    expect(plan.expiresAt).toBeNull()
    expect(await ctx.opencode.sweepExpiredApprovals()).toHaveLength(0)
    expect(ctx.repos.workers.getApproval(plan.id)?.status).toBe('pending')
    ctx.repos.workers.decideApproval(plan.id, false, 'dropped by the test')
  })

  it('does not expire an approval someone already decided', () => {
    const approval = ctx.repos.workers.createApproval({ kind: 'manual_gate', title: 'gate', detail: 'x', jobId: null, expiresAt: Date.now() - 1_000 })
    ctx.repos.workers.decideApproval(approval.id, false, 'denied by the user')
    expect(ctx.repos.workers.expireApproval(approval.id, 'approval timed out — rejected')).toBeNull()
    expect(ctx.repos.workers.getApproval(approval.id)?.status).toBe('denied')
    expect(ctx.repos.workers.getApproval(approval.id)?.decisionNote).toBe('denied by the user')
  })

  it('selects only pending approvals whose deadline has passed', () => {
    const past = Date.now() - 1_000
    const due = ctx.repos.workers.createApproval({ kind: 'manual_gate', title: 'due', detail: 'x', jobId: null, expiresAt: past })
    const future = ctx.repos.workers.createApproval({ kind: 'manual_gate', title: 'not yet', detail: 'x', jobId: null, expiresAt: Date.now() + 60_000 })
    const noDeadline = ctx.repos.workers.createApproval({ kind: 'manual_gate', title: 'never', detail: 'x', jobId: null })

    const selected = ctx.repos.workers.listExpiredApprovals().map((a) => a.id)
    expect(selected).toContain(due.id)
    expect(selected).not.toContain(future.id)
    expect(selected).not.toContain(noDeadline.id)
    ctx.repos.workers.decideApproval(due.id, false, 'cleanup')
    ctx.repos.workers.decideApproval(future.id, false, 'cleanup')
    ctx.repos.workers.decideApproval(noDeadline.id, false, 'cleanup')
  })

  it('completes the worker when the session goes idle', async () => {
    const worker = ctx.repos.workers.listWorkers(jobId).find((w) => w.name === 'worker A')!
    const sessionId = worker.sessionId!
    const serverId = ctx.repos.workers.getSession(sessionId)!.serverId

    ctx.opencode.handleEvent(serverId, event({ type: 'session.idle', sessionId, data: { info: { sessionID: sessionId } } }))
    await waitFor(() => ctx.repos.workers.getWorker(worker.id)?.status === 'succeeded')

    const done = ctx.repos.workers.getWorker(worker.id)!
    expect(done.status).toBe('succeeded')
    expect(done.completedAt).toBeGreaterThan(0)
    expect(ctx.repos.workers.getSession(sessionId)?.status).toBe('completed')

    const transcript = await ctx.opencode.transcriptFor(worker.id)
    expect(transcript.length).toBeGreaterThan(0)
    expect(transcript[0]?.role).toBe('user')
  })

  it('aborts a running worker and settles it locally', async () => {
    const worker = makeWorker('worker B')
    await ctx.opencode.dispatch(worker)
    await ctx.opencode.abort(worker.id, 'user pressed stop')

    const settled = ctx.repos.workers.getWorker(worker.id)!
    expect(settled.status).toBe('aborted')
    expect(settled.statusReason).toContain('user pressed stop')
    expect(settled.completedAt).toBeGreaterThan(0)
  }, 30_000)

  it('times out a worker that never goes idle', async () => {
    const worker = makeWorker('worker C', { timeoutMs: 1_200 })
    await ctx.opencode.dispatch(worker)
    expect(ctx.repos.workers.getWorker(worker.id)?.status).toBe('running')

    await waitFor(() => ctx.repos.workers.getWorker(worker.id)?.status === 'timed_out', 10_000)
    const timedOut = ctx.repos.workers.getWorker(worker.id)!
    expect(timedOut.error).toContain('timed out')
    expect(ctx.repos.workers.getSession(timedOut.sessionId!)?.status).toBe('failed')
  }, 30_000)

  it('re-dispatches a settled worker on retry', async () => {
    const worker = ctx.repos.workers.listWorkers(jobId).find((w) => w.name === 'worker B')!
    expect(worker.status).toBe('aborted')
    const retried = await ctx.opencode.retry(worker.id)
    expect(retried.status).toBe('running')
    expect(retried.attempt).toBe(worker.attempt + 1)
    await ctx.opencode.abort(worker.id, 'cleanup')
  }, 30_000)
})

describe('completion honesty', () => {
  it('fails the worker when the transcript fetch keeps erroring', async () => {
    const worker = makeWorker('worker broken-transcript')
    const dispatched = await ctx.opencode.dispatch(worker)
    fireIdle(dispatched)

    await waitFor(() => ctx.repos.workers.getWorker(worker.id)?.status === 'failed', 15_000)
    const done = ctx.repos.workers.getWorker(worker.id)!
    expect(done.status).toBe('failed')
    expect(done.statusReason).toContain('transcript unavailable')
    expect(done.statusReason).toContain('500')
    expect(done.completedAt).toBeGreaterThan(0)
    expect(ctx.repos.workers.getSession(done.sessionId!)?.status).toBe('failed')
  }, 30_000)

  it('fails the worker when the transcript has no assistant message', async () => {
    const worker = makeWorker('worker no-output')
    const dispatched = await ctx.opencode.dispatch(worker)
    fireIdle(dispatched)

    await waitFor(() => ctx.repos.workers.getWorker(worker.id)?.status === 'failed', 15_000)
    const done = ctx.repos.workers.getWorker(worker.id)!
    expect(done.status).toBe('failed')
    expect(done.statusReason).toContain('no assistant output')
  }, 30_000)
})

describe('artifact collection', () => {
  it('records real artifact rows, filesTouched and diff stats on success', async () => {
    const task = ctx.repos.jobs.createTask({
      jobId,
      loopIndex: 1,
      title: 'artifact step',
      role: 'coder',
      objective: 'produce the deliverable',
      prompt: 'produce the deliverable',
      expectedArtifacts: ['deliverable.md'],
    })
    const artifactEvents: AppEvent[] = []
    const off = ctx.events.subscribeType(EVENTS.ARTIFACT_CREATED, (e) => artifactEvents.push(e))

    try {
      const worker = makeWorker('worker artifacts', {
        taskId: task.id,
        taskPrompt: 'write the deliverable FILE:deliverable.md',
      })
      const dispatched = await ctx.opencode.dispatch(worker)
      fireIdle(dispatched)
      await waitFor(() => ctx.repos.workers.getWorker(worker.id)?.status === 'succeeded', 15_000)

      const done = ctx.repos.workers.getWorker(worker.id)!
      expect(done.status).toBe('succeeded')
      expect(done.statusReason).toBeNull()
      expect(done.filesTouched).toContain('deliverable.md')
      expect(done.artifacts.length).toBeGreaterThan(0)

      const rows = ctx.repos.workers.listArtifacts(jobId).filter((a) => a.workerId === worker.id)
      const row = rows.find((a) => a.path === 'deliverable.md')
      expect(row).toBeTruthy()
      expect(row).toMatchObject({
        status: 'available',
        taskId: task.id,
        sessionId: dispatched.sessionId,
        jobId,
        name: 'deliverable.md',
        bytes: expect.any(Number) as number,
      })
      expect(row!.bytes).toBeGreaterThan(0)

      const onDisk = await readFile(join(dataDir, 'ws', 'deliverable.md'), 'utf8')
      expect(row!.checksum).toBe(createHash('sha256').update(onDisk).digest('hex'))

      const session = ctx.repos.workers.getSession(dispatched.sessionId!)!
      expect(session.diffStats.files).toBeGreaterThanOrEqual(1)
      expect(session.diffStats.additions).toBeGreaterThan(0)

      expect(artifactEvents.some((e) => e.workerId === worker.id && e.jobId === jobId)).toBe(true)
      expect(done.artifacts.every((id) => rows.some((r) => r.id === id))).toBe(true)
    } finally {
      off()
    }
  }, 30_000)

  it('fails a worker that produced none of its expected artifacts', async () => {
    const task = ctx.repos.jobs.createTask({
      jobId,
      loopIndex: 1,
      title: 'ghost step',
      role: 'coder',
      objective: 'produce ghost-artifact.md',
      prompt: 'produce ghost-artifact.md',
      expectedArtifacts: ['ghost-artifact.md'],
    })
    const worker = makeWorker('worker missing deliverable', {
      taskId: task.id,
      taskPrompt: 'produce ghost-artifact.md',
    })
    const dispatched = await ctx.opencode.dispatch(worker)
    fireIdle(dispatched)
    await waitFor(() => ctx.repos.workers.getWorker(worker.id)?.status === 'failed', 15_000)

    const done = ctx.repos.workers.getWorker(worker.id)!
    expect(done.status).toBe('failed')
    // the fixture never emits a write tool for this task, so the failure names
    // the absent tool call rather than the generic verification wording
    expect(done.statusReason).toContain('no write tool was ever called')
    expect(done.statusReason).toContain('ghost-artifact.md')

    const rows = ctx.repos.workers.listArtifacts(jobId).filter((a) => a.workerId === worker.id)
    expect(rows.some((r) => r.path === 'ghost-artifact.md' && r.status === 'missing')).toBe(true)
  }, 30_000)

  it('names the promised file that no write tool ever targeted', async () => {
    // The no-write-tool wording above is only correct when no write tool ran.
    // Here the worker does write — just not the promised one — so the reason
    // has to point at the specific file the next attempt must create.
    const task = ctx.repos.jobs.createTask({
      jobId,
      loopIndex: 1,
      title: 'wrong file',
      role: 'coder',
      objective: 'produce wanted.md',
      prompt: 'produce wanted.md',
      expectedArtifacts: ['wanted.md'],
    })
    const worker = makeWorker('worker wrote the wrong file', {
      taskId: task.id,
      taskPrompt: 'do the work FILE:decoy.md',
    })
    const dispatched = await ctx.opencode.dispatch(worker)
    fireIdle(dispatched)
    await waitFor(() => ctx.repos.workers.getWorker(worker.id)?.status === 'failed', 15_000)

    const done = ctx.repos.workers.getWorker(worker.id)!
    // a write did happen (decoy.md), just never aimed at the promised file —
    // say which one instead of the generic verification wording
    expect(done.statusReason).toBe('never called a write tool for wanted.md — wanted.md does not exist')
  }, 30_000)

  it('fails a partial delivery so it retries, but stops retrying on the last attempt', async () => {
    // The collector keeps `verdict.ok` for a partial delivery (pinned contract),
    // so the retry has to be decided above it or no attempt 2 ever happens.
    const task = ctx.repos.jobs.createTask({
      jobId,
      loopIndex: 1,
      title: 'two files',
      role: 'coder',
      objective: 'produce both files',
      prompt: 'produce both files',
      expectedArtifacts: ['half-a.md', 'half-b.md'],
      retryPolicy: { maxAttempts: 2, noRetryOn: [] },
    })

    const first = makeWorker('worker partial attempt 1', {
      taskId: task.id,
      taskPrompt: 'produce both files FILE:half-a.md',
    })
    const dispatchedFirst = await ctx.opencode.dispatch(first)
    fireIdle(dispatchedFirst)
    try {
      await waitFor(() => ctx.repos.workers.getWorker(first.id)?.status === 'failed', 15_000)
    } catch {
      const stuck = ctx.repos.workers.getWorker(first.id)!
      throw new Error(`first worker ended ${stuck.status} / ${stuck.statusReason} attempt=${stuck.attempt}`)
    }

    const afterFirst = ctx.repos.workers.getWorker(first.id)!
    expect(afterFirst.statusReason).toBe('never called a write tool for half-b.md — half-b.md does not exist')

    const last = makeWorker('worker partial attempt 2', {
      taskId: task.id,
      taskPrompt: 'produce both files FILE:half-a.md',
      attempt: 1,
    })
    const dispatchedLast = await ctx.opencode.dispatch(last)
    fireIdle(dispatchedLast)
    await waitFor(() => ctx.repos.workers.getWorker(last.id)?.status === 'succeeded', 15_000)

    const afterLast = ctx.repos.workers.getWorker(last.id)!
    expect(afterLast.status).toBe('succeeded')
    expect(afterLast.statusReason).toBeTruthy()
  }, 40_000)
})

describe('subagent visibility', () => {
  it('records child sessions and emits subagent.spawned after success', async () => {
    const spawned: AppEvent[] = []
    const off = ctx.events.subscribeType(EVENTS.SUBAGENT_SPAWNED, (e) => spawned.push(e))
    try {
      const worker = makeWorker('worker with subagent')
      const dispatched = await ctx.opencode.dispatch(worker)
      fireIdle(dispatched)
      await waitFor(() => ctx.repos.workers.getWorker(worker.id)?.status === 'succeeded', 15_000)

      expect(spawned.length).toBeGreaterThan(0)
      const event = spawned.find((e) => e.workerId === worker.id)!
      expect(event.jobId).toBe(jobId)
      const childId = event.data.childSessionId as string
      expect(childId).toMatch(/^ses_child_/)

      const child = ctx.repos.workers.getSession(childId)
      expect(child).toBeTruthy()
      expect(child?.parentSessionId).toBe(dispatched.sessionId)
      expect(child?.jobId).toBe(jobId)
      expect(child?.serverId).toBe(ctx.repos.workers.getSession(dispatched.sessionId!)!.serverId)
    } finally {
      off()
    }
  }, 30_000)
})

describe('subagent parent linkage at spawn', () => {
  it('passes parentID to createSession only when the worker carries a parent session', async () => {
    const spy = spyCreateSession()
    try {
      const plain = makeWorker('worker no parent link')
      const dispatchedPlain = await ctx.opencode.dispatch(plain)
      expect(spy.calls[0]?.title).toBe('worker no parent link')
      expect(spy.calls[0]?.parentID).toBeUndefined()
      expect(ctx.repos.workers.getSession(dispatchedPlain.sessionId!)?.parentSessionId).toBeNull()
      await ctx.opencode.abort(plain.id, 'cleanup')

      const linked = makeWorker('worker parent linked', { parentSessionId: 'ses_parent_fixture' })
      const dispatchedLinked = await ctx.opencode.dispatch(linked)
      expect(spy.calls[1]?.title).toBe('worker parent linked')
      expect(spy.calls[1]?.parentID).toBe('ses_parent_fixture')
      expect(ctx.repos.workers.getSession(dispatchedLinked.sessionId!)?.parentSessionId).toBe('ses_parent_fixture')
      await ctx.opencode.abort(linked.id, 'cleanup')
    } finally {
      spy.restore()
    }
  }, 30_000)

  it('resolves the parent session from parentWorkerId when parentSessionId is unset', async () => {
    const spy = spyCreateSession()
    try {
      const parent = makeWorker('worker parent row')
      const dispatchedParent = await ctx.opencode.dispatch(parent)
      const child = makeWorker('worker child row', { parentWorkerId: parent.id })
      const dispatchedChild = await ctx.opencode.dispatch(child)

      expect(spy.calls.find((c) => c.title === 'worker parent row')?.parentID).toBeUndefined()
      expect(spy.calls.find((c) => c.title === 'worker child row')?.parentID).toBe(dispatchedParent.sessionId)
      expect(ctx.repos.workers.getSession(dispatchedChild.sessionId!)?.parentSessionId).toBe(dispatchedParent.sessionId)

      await ctx.opencode.abort(child.id, 'cleanup')
      await ctx.opencode.abort(parent.id, 'cleanup')
    } finally {
      spy.restore()
    }
  }, 30_000)
})

describe('abort honesty', () => {
  it('returns false for a nonexistent worker id', async () => {
    expect(await ctx.opencode.abort('wrk_does_not_exist')).toBe(false)
  })

  it('reports true only while it actually settles the worker', async () => {
    const worker = makeWorker('worker abort honesty')
    await ctx.opencode.dispatch(worker)
    expect(await ctx.opencode.abort(worker.id, 'user pressed stop')).toBe(true)

    const settled = ctx.repos.workers.getWorker(worker.id)!
    expect(settled.status).toBe('aborted')
    expect(await ctx.opencode.abort(worker.id, 'stop again')).toBe(false)
    expect(ctx.repos.workers.getWorker(worker.id)?.status).toBe('aborted')
  }, 30_000)

  it('settles a never-dispatched worker and reports true', async () => {
    const worker = makeWorker('worker queued abort')
    expect(worker.status).toBe('queued')
    expect(await ctx.opencode.abort(worker.id, 'cancelled while queued')).toBe(true)
    expect(ctx.repos.workers.getWorker(worker.id)?.status).toBe('aborted')
  })
})

describe('transcript tool evidence', () => {
  const msg = (parts: TranscriptMessage['parts']): TranscriptMessage[] => [
    { info: { id: 'msg_1', role: 'assistant', time: { created: 1 } } as TranscriptMessage['info'], parts },
  ]

  it('surfaces a failed tool with its executor error (state.status, OpenCode 1.18 shape)', () => {
    const entries = messagesToTranscript(msg([
      { id: 'prt_1', type: 'tool', tool: 'write', state: { status: 'error', error: 'EACCES: permission denied' } },
    ]))
    expect(entries).toHaveLength(1)
    expect(entries[0]!.role).toBe('tool')
    expect(entries[0]!.tool).toEqual({ name: 'write', status: 'error' })
    expect(entries[0]!.text).toBe('write (error) \u2014 EACCES: permission denied')
  })

  it('records a completed tool even when the part has no top-level status', () => {
    const entries = messagesToTranscript(msg([
      { id: 'prt_2', type: 'tool', tool: 'bash', state: { status: 'completed' } },
    ]))
    expect(entries[0]!.tool).toEqual({ name: 'bash', status: 'completed' })
    expect(entries[0]!.text).toBe('bash (completed)')
  })

  it('keeps the legacy top-level tool status working', () => {
    const entries = messagesToTranscript(msg([{ id: 'prt_3', type: 'tool', tool: 'read', status: 'completed' }]))
    expect(entries[0]!.tool).toEqual({ name: 'read', status: 'completed' })
  })

  it('still converts assistant text parts unchanged', () => {
    const entries = messagesToTranscript(msg([
      { id: 'prt_4', type: 'text', text: 'All files created successfully.' },
      { id: 'prt_5', type: 'tool', tool: 'write', state: { status: 'error', error: 'path escapes workspace' } },
    ]))
    expect(entries.map((e) => e.role)).toEqual(['assistant', 'tool'])
    expect(entries[0]!.text).toBe('All files created successfully.')
    expect(entries[1]!.text).toContain('path escapes workspace')
  })
})
