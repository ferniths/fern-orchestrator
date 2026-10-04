import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createCoreContext, type AppContext } from '@core/kernel/appContext'
import { EVENTS, type PublishPayload } from '@core/kernel/eventBus'
import { artifactDiskNote, CHECKSUM_SIZE_CAP, collectWorkerArtifacts, persistCollection } from '@core/opencode/artifactCollector'
import type { Artifact } from '@shared/domain'

let ctx: AppContext
let dataDir: string
let jobId: string
let taskId: string
let workerId: string
let sessionId: string
let workspace: string

function collectorDeps() {
  const emitted: { type: string; payload?: PublishPayload }[] = []
  return {
    emitted,
    deps: {
      createArtifact: (input: Partial<Artifact> & { jobId: string; name: string }): Artifact =>
        ctx.repos.workers.createArtifact(input),
      emit: (type: string, payload?: PublishPayload): void => {
        emitted.push({ type, payload })
      },
      warn: (): void => undefined,
    },
  }
}

function baseRequest(overrides: Partial<Parameters<typeof collectWorkerArtifacts>[1]> = {}) {
  return {
    jobId,
    loopIndex: 1,
    taskId,
    workerId,
    sessionId,
    workspaceRoot: workspace,
    expectedArtifacts: [] as string[],
    diff: [],
    assistantText: 'done',
    ...overrides,
  }
}

beforeAll(async () => {
  dataDir = await mkdtemp(join(tmpdir(), 'fern-art-'))
  ctx = await createCoreContext({ dataDir, consoleLogs: false })
  workspace = join(dataDir, 'ws')
  await mkdir(workspace, { recursive: true })

  const job = ctx.repos.jobs.create({
    title: 'artifact collector test',
    originalPrompt: 'collect artifacts',
    projectId: null,
    vaultId: null,
    loopCount: 1,
    routeId: null,
    requirePlanApproval: false,
    templateId: null,
    status: 'draft',
  })
  jobId = job.id
  const task = ctx.repos.jobs.createTask({
    jobId,
    loopIndex: 1,
    title: 'step one',
    role: 'coder',
    objective: 'produce files',
    prompt: 'produce files',
    expectedArtifacts: ['deliverable.md'],
  })
  taskId = task.id
  const worker = ctx.repos.workers.createWorker({
    jobId,
    taskId,
    loopIndex: 1,
    name: 'collector worker',
    role: 'coder',
    objective: 'produce files',
    taskPrompt: 'produce files',
    workspacePath: workspace,
  })
  workerId = worker.id
  sessionId = 'ses_collector_1'
  ctx.repos.workers.upsertSession({
    sessionId,
    workerId,
    serverId: 'srv_collector',
    parentSessionId: null,
    jobId,
    projectId: null,
    title: 'collector worker',
    directory: workspace,
    modelId: null,
    providerId: null,
    opencodeAgent: null,
    depth: 0,
    status: 'active',
    summary: '',
    diffStats: { additions: 0, deletions: 0, files: 0 },
    lastEventAt: Date.now(),
  })
}, 30_000)

afterAll(async () => {
  await ctx?.shutdown()
  await rm(dataDir, { recursive: true, force: true })
})

describe('collectWorkerArtifacts', () => {
  it('rejects paths that escape the workspace instead of reading them', async () => {
    const { deps } = collectorDeps()
    const res = await collectWorkerArtifacts(deps, baseRequest({ expectedArtifacts: ['../evil.txt'], diff: [{ file: '../escape.txt', additions: 5, deletions: 1 }] }))

    expect(res.rejectedPaths).toEqual(expect.arrayContaining(['../evil.txt', '../escape.txt']))
    expect(res.artifacts).toHaveLength(0)
    expect(res.artifacts.find((a) => a.path?.includes('evil'))).toBeUndefined()
    expect(res.verdict.ok).toBe(false)
    expect(res.verdict.reason).toContain('missing expected artifacts')
    expect(res.verdict.reason).toContain('../evil.txt')
  })

  it('records available vs missing rows and verifies a partial delivery', async () => {
    await writeFile(join(workspace, 'present.txt'), 'hello', 'utf8')
    const { deps, emitted } = collectorDeps()
    const res = await collectWorkerArtifacts(deps, baseRequest({ expectedArtifacts: ['present.txt', 'absent.txt'] }))

    expect(res.verdict.ok).toBe(true)
    expect(res.verdict.note).toContain('absent.txt')
    expect(res.presentExpected).toEqual(['present.txt'])
    expect(res.missingExpected).toEqual(['absent.txt'])
    expect(res.filesTouched).toEqual(['present.txt'])

    const present = res.artifacts.find((a) => a.path === 'present.txt')!
    expect(present).toMatchObject({ status: 'available', kind: 'file', name: 'present.txt', bytes: 5 })
    expect(present.checksum).toBe(createHash('sha256').update('hello').digest('hex'))
    expect(present.workerId).toBe(workerId)
    expect(present.taskId).toBe(taskId)
    expect(present.sessionId).toBe(sessionId)

    const absent = res.artifacts.find((a) => a.path === 'absent.txt')!
    expect(absent).toMatchObject({ status: 'missing', bytes: 0, checksum: null })

    const created = emitted.filter((e) => e.type === EVENTS.ARTIFACT_CREATED)
    expect(created).toHaveLength(2)
    expect(created.every((e) => e.payload?.jobId === jobId && e.payload?.workerId === workerId)).toBe(true)
  })

  it('fails the verdict when none of the declared artifacts exist', async () => {
    const { deps } = collectorDeps()
    const res = await collectWorkerArtifacts(deps, baseRequest({ expectedArtifacts: ['a.md', 'b.md'], assistantText: 'looks done' }))

    expect(res.verdict.ok).toBe(false)
    expect(res.verdict.reason).toContain('a.md')
    expect(res.verdict.reason).toContain('b.md')
    expect(res.artifacts.every((a) => a.status === 'missing')).toBe(true)
  })

  it('checksums small files and leaves large ones unchecked', async () => {
    await writeFile(join(workspace, 'small.bin'), Buffer.from([1, 2, 3]), 'utf8')
    await writeFile(join(workspace, 'big.bin'), Buffer.alloc(CHECKSUM_SIZE_CAP + 1, 7))
    const { deps } = collectorDeps()
    const res = await collectWorkerArtifacts(deps, baseRequest({ expectedArtifacts: ['small.bin', 'big.bin'] }))

    const small = res.artifacts.find((a) => a.path === 'small.bin')!
    expect(small.bytes).toBe(3)
    expect(small.checksum).toBe(createHash('sha256').update(Buffer.from([1, 2, 3])).digest('hex'))

    const big = res.artifacts.find((a) => a.path === 'big.bin')!
    expect(big.bytes).toBe(CHECKSUM_SIZE_CAP + 1)
    expect(big.checksum).toBeNull()
  })

  it('uses diff files on disk as evidence when nothing was declared', async () => {
    await writeFile(join(workspace, 'code.ts'), 'export {}\n', 'utf8')
    const { deps } = collectorDeps()
    const res = await collectWorkerArtifacts(
      deps,
      baseRequest({
        expectedArtifacts: [],
        assistantText: '',
        diff: [
          { file: 'code.ts', additions: 3, deletions: 1 },
          { file: 'gone.txt', additions: 9, deletions: 9 },
        ],
      }),
    )

    expect(res.verdict.ok).toBe(true)
    expect(res.diffStats).toEqual({ additions: 3, deletions: 1, files: 1 })
    expect(res.unmatchedDiff).toEqual(['gone.txt'])

    const row = res.artifacts.find((a) => a.path === 'code.ts')!
    expect(row).toMatchObject({ kind: 'modified_file', status: 'available' })
    expect(row.bytes).toBe(10)
    expect(row.metadata).toMatchObject({ additions: 3, deletions: 1, source: 'diff' })
  })

  it('fails when there is no deliverable at all', async () => {
    const { deps } = collectorDeps()
    const res = await collectWorkerArtifacts(
      deps,
      baseRequest({ workspaceRoot: join(dataDir, 'empty-ws'), expectedArtifacts: [], assistantText: '   ' }),
    )

    expect(res.verdict.ok).toBe(false)
    expect(res.verdict.reason).toContain('no deliverables')
    expect(res.artifacts).toHaveLength(0)
  })
})

describe('persistCollection', () => {
  it('writes filesTouched/artifacts onto the worker and diff stats onto the session', async () => {
    const { deps } = collectorDeps()
    const res = await collectWorkerArtifacts(deps, baseRequest({ expectedArtifacts: ['present.txt', 'absent.txt'] }))

    persistCollection(
      {
        getWorker: (id) => ctx.repos.workers.getWorker(id),
        updateWorker: (id, patch) => ctx.repos.workers.updateWorker(id, patch),
        getSession: (id) => ctx.repos.workers.getSession(id),
        upsertSession: (input) => ctx.repos.workers.upsertSession(input),
      },
      { workerId, sessionId, result: res },
    )

    const worker = ctx.repos.workers.getWorker(workerId)!
    expect(worker.filesTouched).toEqual(['present.txt'])
    expect(worker.artifacts).toEqual(res.artifactIds)
    expect(worker.artifacts.length).toBeGreaterThan(0)

    const session = ctx.repos.workers.getSession(sessionId)!
    expect(session.diffStats.files).toBe(0)
    expect(session.diffStats.additions).toBe(0)

    const rows = ctx.repos.workers.listArtifacts(jobId).filter((a) => a.workerId === workerId)
    for (const id of worker.artifacts) expect(rows.some((r) => r.id === id)).toBe(true)
  })

  it('persists non-zero diff stats from real diff entries', async () => {
    const { deps } = collectorDeps()
    const res = await collectWorkerArtifacts(
      deps,
      baseRequest({ expectedArtifacts: [], diff: [{ file: 'present.txt', additions: 4, deletions: 2 }] }),
    )

    persistCollection(
      {
        getWorker: (id) => ctx.repos.workers.getWorker(id),
        updateWorker: (id, patch) => ctx.repos.workers.updateWorker(id, patch),
        getSession: (id) => ctx.repos.workers.getSession(id),
        upsertSession: (input) => ctx.repos.workers.upsertSession(input),
      },
      { workerId, sessionId, result: res },
    )

    const session = ctx.repos.workers.getSession(sessionId)!
    expect(session.diffStats).toEqual({ additions: 4, deletions: 2, files: 1 })
  })
})

describe('artifactDiskNote', () => {
  const sha = (text: string) => createHash('sha256').update(text).digest('hex')

  it('reports an unchanged file as PRESENT with its recorded status', async () => {
    const abs = join(dataDir, 'ok.txt')
    await writeFile(abs, 'HARNESS_SMOKE_TEST_OK')

    const note = await artifactDiskNote(abs, { bytes: 21, checksum: sha('HARNESS_SMOKE_TEST_OK'), status: 'present' })
    expect(note).toBe('PRESENT (21 bytes, recorded present)')
  })

  it('flags a file rewritten by someone else after verification', async () => {
    const abs = join(dataDir, 'clobbered.txt')
    await writeFile(abs, 'HARNESS_SMOKE_TEST_OK')

    const note = await artifactDiskNote(abs, { bytes: 21, checksum: sha('HARNESS_SMOKE_TEST_OK'), status: 'present' })
    expect(note).toContain('PRESENT')

    await writeFile(abs, 'smoke test marker')
    const after = await artifactDiskNote(abs, { bytes: 21, checksum: sha('HARNESS_SMOKE_TEST_OK'), status: 'present' })
    expect(after).toContain('CHANGED since verification')
    expect(after).toContain('17 bytes')
  })

  it('returns null when the file is gone so the caller reports MISSING', async () => {
    const note = await artifactDiskNote(join(dataDir, 'nope.txt'), { bytes: 1, checksum: null, status: 'present' })
    expect(note).toBeNull()
  })
})
