import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { createCoreContext, type AppContext } from '@core/kernel/appContext'
import type { Artifact, AutomationJob, Task, WorkerSession } from '@shared/domain'
import type { WorkerDetail } from '@shared/ipc'
import { artifactHandlers } from '../src/main/ipc/handlers/artifacts'
import { jobHandlers } from '../src/main/ipc/handlers/jobs'

vi.mock('electron', () => ({
  app: { getName: () => 'fern-test', getVersion: () => '0.0.0', getLocale: () => 'en-US' },
  dialog: { showOpenDialog: async () => ({ canceled: true, filePaths: [] }) },
  shell: { openPath: async () => '', showItemInFolder: () => undefined, openExternal: async () => undefined },
}))

type GetWorker = (args: [string]) => Promise<WorkerDetail | null>
type ListArtifacts = (args: [string]) => Artifact[]

let ctx: AppContext
let dataDir: string
let handlers: ReturnType<typeof jobHandlers>
let listArtifacts: ListArtifacts

beforeAll(async () => {
  dataDir = await mkdtemp(join(tmpdir(), 'fern-jobdetail-'))
  ctx = await createCoreContext({ dataDir, consoleLogs: false })
  handlers = jobHandlers(ctx)
  listArtifacts = artifactHandlers(ctx)['artifacts.list'] as ListArtifacts
})

afterAll(async () => {
  await ctx.shutdown()
  await rm(dataDir, { recursive: true, force: true })
})

function createJob(title: string): AutomationJob {
  return ctx.repos.jobs.create({
    title,
    originalPrompt: 'show me the evidence',
    projectId: null,
    vaultId: null,
    loopCount: 1,
    routeId: null,
    templateId: null,
    requirePlanApproval: false,
    status: 'draft',
  })
}

function createTask(jobId: string, title: string): Task {
  return ctx.repos.jobs.createTask({ jobId, loopIndex: 1, title, role: 'coder', objective: title, prompt: title })
}

function upsertSession(fields: {
  sessionId: string
  jobId: string
  workerId?: string | null
  parentSessionId?: string | null
  title?: string
  depth?: number
  status?: WorkerSession['status']
  diffStats?: { additions: number; deletions: number; files: number }
}): void {
  ctx.repos.workers.upsertSession({
    sessionId: fields.sessionId,
    workerId: fields.workerId ?? null,
    serverId: 'srv_jobdetail',
    parentSessionId: fields.parentSessionId ?? null,
    jobId: fields.jobId,
    projectId: null,
    title: fields.title ?? '',
    directory: dataDir,
    modelId: null,
    providerId: null,
    opencodeAgent: null,
    depth: fields.depth ?? 0,
    status: fields.status ?? 'completed',
    summary: '',
    diffStats: fields.diffStats ?? { additions: 0, deletions: 0, files: 0 },
    lastEventAt: Date.now(),
  })
}

/* -------------------------------------------------------------------------- */
/* workers.get — transcript                                                    */
/* -------------------------------------------------------------------------- */

describe('workers.get transcript', () => {
  it('returns the persisted transcript rows instead of an empty placeholder', async () => {
    const job = createJob('job detail transcript')
    const task = createTask(job.id, 'write the report')
    const worker = ctx.repos.workers.createWorker({
      jobId: job.id,
      taskId: task.id,
      loopIndex: 1,
      name: 'transcript worker',
      role: 'coder',
      sessionId: 'ses_jobdetail_transcript',
      status: 'succeeded',
    })

    const entries = [
      { id: 'e1', role: 'user', text: 'write the report', at: 1_000 },
      { id: 'e2', role: 'tool', text: 'read docs/spec.md', at: 1_500 },
      { id: 'e3', role: 'assistant', text: 'report written to docs/report.md', at: 2_000 },
    ]
    const dir = join(ctx.paths.jobs, job.id, 'transcripts')
    await mkdir(dir, { recursive: true })
    await writeFile(join(dir, 'ses_jobdetail_transcript.jsonl'), entries.map((e) => JSON.stringify(e)).join('\n'), 'utf8')

    const get = handlers['workers.get'] as GetWorker
    const detail = await get([worker.id])

    expect(detail).not.toBeNull()
    expect(detail!.transcript).toHaveLength(3)
    expect(detail!.transcript.map((e) => e.role)).toEqual(['user', 'tool', 'assistant'])
    expect(detail!.transcript[0]).toMatchObject({ id: 'e1', text: 'write the report', at: 1_000 })
    expect(detail!.transcript[2]).toMatchObject({ role: 'assistant', text: 'report written to docs/report.md' })
  })

  it('returns null for an unknown worker instead of throwing', async () => {
    const get = handlers['workers.get'] as GetWorker
    await expect(get(['wrk_does_not_exist'])).resolves.toBeNull()
  })
})

/* -------------------------------------------------------------------------- */
/* workers.get — artifacts filtered per worker                                 */
/* -------------------------------------------------------------------------- */

describe('workers.get artifacts', () => {
  it('returns only this worker\'s rows with path, status, bytes and checksum', async () => {
    const job = createJob('job detail artifacts')
    const task = createTask(job.id, 'build the page')
    const worker = ctx.repos.workers.createWorker({
      jobId: job.id,
      taskId: task.id,
      loopIndex: 1,
      name: 'artifact worker',
      role: 'coder',
      sessionId: 'ses_jobdetail_artifacts',
    })
    const other = ctx.repos.workers.createWorker({
      jobId: job.id,
      taskId: task.id,
      loopIndex: 1,
      name: 'other worker',
      role: 'reviewer',
    })

    const available = ctx.repos.workers.createArtifact({
      jobId: job.id,
      loopIndex: 1,
      taskId: task.id,
      workerId: worker.id,
      sessionId: 'ses_jobdetail_artifacts',
      kind: 'file',
      name: 'page.md',
      path: 'docs/page.md',
      bytes: 2048,
      checksum: 'a'.repeat(64),
      status: 'available',
    })
    const missing = ctx.repos.workers.createArtifact({
      jobId: job.id,
      loopIndex: 1,
      taskId: task.id,
      workerId: worker.id,
      sessionId: 'ses_jobdetail_artifacts',
      kind: 'file',
      name: 'absent.md',
      path: 'docs/absent.md',
      bytes: 0,
      checksum: null,
      status: 'missing',
    })
    ctx.repos.workers.createArtifact({
      jobId: job.id,
      loopIndex: 1,
      taskId: task.id,
      workerId: other.id,
      kind: 'file',
      name: 'other.md',
      path: 'other.md',
      bytes: 10,
      status: 'available',
    })

    const get = handlers['workers.get'] as GetWorker
    const detail = await get([worker.id])

    expect(detail).not.toBeNull()
    expect(detail!.artifacts.map((a) => a.id).sort()).toEqual([available.id, missing.id].sort())

    const page = detail!.artifacts.find((a) => a.id === available.id)
    expect(page).toMatchObject({ path: 'docs/page.md', status: 'available', bytes: 2048, checksum: 'a'.repeat(64) })
    expect(page?.workerId).toBe(worker.id)

    const absent = detail!.artifacts.find((a) => a.id === missing.id)
    expect(absent?.status).toBe('missing')
    expect(absent?.path).toBe('docs/absent.md')
    expect(absent?.checksum).toBeNull()
  })
})

/* -------------------------------------------------------------------------- */
/* workers.get — evidence: filesTouched / statusReason / diffStats / children  */
/* -------------------------------------------------------------------------- */

describe('workers.get evidence', () => {
  it('carries filesTouched, statusReason, session diffStats and linked child sessions', async () => {
    const job = createJob('job detail evidence')
    const task = createTask(job.id, 'ship it')
    const worker = ctx.repos.workers.createWorker({
      jobId: job.id,
      taskId: task.id,
      loopIndex: 1,
      name: 'evidence worker',
      role: 'coder',
      sessionId: 'ses_jobdetail_parent',
    })
    ctx.repos.workers.updateWorker(worker.id, {
      status: 'succeeded',
      statusReason: 'missing expected artifacts: docs/absent.md',
      filesTouched: ['src/app.ts', 'docs/absent.md'],
    })

    upsertSession({
      sessionId: 'ses_jobdetail_parent',
      jobId: job.id,
      workerId: worker.id,
      title: 'evidence worker',
      status: 'completed',
      diffStats: { additions: 12, deletions: 4, files: 3 },
    })
    upsertSession({
      sessionId: 'ses_jobdetail_child',
      jobId: job.id,
      workerId: null,
      parentSessionId: 'ses_jobdetail_parent',
      title: 'subagent helper',
      depth: 1,
      status: 'completed',
      diffStats: { additions: 5, deletions: 1, files: 1 },
    })
    upsertSession({
      sessionId: 'ses_jobdetail_stranger',
      jobId: job.id,
      workerId: null,
      parentSessionId: 'ses_someone_else',
      title: 'unrelated session',
      status: 'idle',
    })

    const get = handlers['workers.get'] as GetWorker
    const detail = await get([worker.id])

    expect(detail).not.toBeNull()
    expect(detail!.worker.statusReason).toBe('missing expected artifacts: docs/absent.md')
    expect(detail!.worker.filesTouched).toEqual(['src/app.ts', 'docs/absent.md'])

    const parent = detail!.sessions.find((s) => s.sessionId === 'ses_jobdetail_parent')
    expect(parent).toBeDefined()
    expect(parent?.diffStats).toEqual({ additions: 12, deletions: 4, files: 3 })
    expect(parent?.parentSessionId).toBeNull()
    expect(detail!.sessions.some((s) => s.sessionId === 'ses_jobdetail_stranger')).toBe(false)

    expect(detail!.childSessions.map((s) => s.sessionId)).toEqual(['ses_jobdetail_child'])
    expect(detail!.childSessions[0]).toMatchObject({
      title: 'subagent helper',
      depth: 1,
      parentSessionId: 'ses_jobdetail_parent',
      diffStats: { additions: 5, deletions: 1, files: 1 },
    })
  })

  it('links a child session through parentSessionId even without a worker row', async () => {
    const job = createJob('job detail childless parent')
    const task = createTask(job.id, 'delegate')
    const worker = ctx.repos.workers.createWorker({
      jobId: job.id,
      taskId: task.id,
      loopIndex: 1,
      name: 'delegating worker',
      role: 'planner',
      sessionId: 'ses_jobdetail_solo_parent',
    })
    upsertSession({
      sessionId: 'ses_jobdetail_solo_parent',
      jobId: job.id,
      workerId: worker.id,
      title: 'delegating worker',
      status: 'completed',
    })

    const get = handlers['workers.get'] as GetWorker
    const beforeSpawn = await get([worker.id])
    expect(beforeSpawn!.childSessions).toEqual([])

    upsertSession({
      sessionId: 'ses_jobdetail_solo_child',
      jobId: job.id,
      workerId: null,
      parentSessionId: 'ses_jobdetail_solo_parent',
      title: 'subagent of delegating worker',
      depth: 1,
      status: 'idle',
    })

    const afterSpawn = await get([worker.id])
    expect(afterSpawn!.childSessions.map((s) => s.sessionId)).toEqual(['ses_jobdetail_solo_child'])
    expect(afterSpawn!.childSessions[0]?.parentSessionId).toBe('ses_jobdetail_solo_parent')
  })
})

/* -------------------------------------------------------------------------- */
/* artifacts.list                                                              */
/* -------------------------------------------------------------------------- */

describe('artifacts.list', () => {
  it('returns the job rows with workspace-relative path, bytes and status', () => {
    const job = createJob('job detail artifact list')
    const row = ctx.repos.workers.createArtifact({
      jobId: job.id,
      loopIndex: 1,
      kind: 'diff',
      name: 'change.diff',
      path: 'patches/change.diff',
      bytes: 64,
      checksum: 'b'.repeat(64),
      status: 'available',
      content: 'diff --git a/x b/x',
    })
    const gone = ctx.repos.workers.createArtifact({
      jobId: job.id,
      loopIndex: 1,
      kind: 'file',
      name: 'expected.txt',
      path: 'out/expected.txt',
      bytes: 0,
      status: 'missing',
    })

    const rows = listArtifacts([job.id])
    expect(rows.map((r) => r.id).sort()).toEqual([row.id, gone.id].sort())

    const change = rows.find((r) => r.id === row.id)
    expect(change).toMatchObject({
      path: 'patches/change.diff',
      status: 'available',
      bytes: 64,
      checksum: 'b'.repeat(64),
      kind: 'diff',
    })

    const expected = rows.find((r) => r.id === gone.id)
    expect(expected).toMatchObject({ path: 'out/expected.txt', status: 'missing', bytes: 0 })
    expect(expected?.checksum).toBeNull()
  })
})
