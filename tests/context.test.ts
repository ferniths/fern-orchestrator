import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createCoreContext, type AppContext } from '@core/kernel/appContext'
import { seedBuiltins } from '../src/main/ipc/handlers/providers'

let ctx: AppContext
let dataDir: string

beforeAll(async () => {
  dataDir = await mkdtemp(join(tmpdir(), 'fern-ctx-'))
  ctx = await createCoreContext({ dataDir, consoleLogs: false })
  seedBuiltins(ctx)
})

afterAll(async () => {
  await ctx.shutdown()
  await rm(dataDir, { recursive: true, force: true })
})

describe('context', () => {
  it('creates state directories and applies schema', () => {
    expect(ctx.db.schemaVersion).toBeGreaterThanOrEqual(1)
    expect(ctx.paths.root).toBe(dataDir)
    expect(ctx.db.integrity().ok).toBe(true)
  })

  it('persists and reloads config', async () => {
    await ctx.config.update({ appearance: { theme: 'light' }, diagnostics: { logLevel: 'debug' } })
    const reloaded = await (await import('@core/kernel/config')).ConfigStore.load(ctx.paths.config)
    expect(reloaded.get().appearance.theme).toBe('light')
    expect(reloaded.get().diagnostics.logLevel).toBe('debug')
    expect(reloaded.get().orchestration.limits.maxConcurrentWorkers).toBeGreaterThan(0)
    await reloaded.flush()
  })

  it('seeds built-in agent profiles', () => {
    const profiles = ctx.repos.providers.listProfiles()
    expect(profiles.length).toBeGreaterThanOrEqual(15)
    expect(profiles.some((p) => p.name === 'Coder' && p.opencodeAgent === 'build')).toBe(true)
  })

  it('publishes events with monotonic seq and persists them', () => {
    const seen: number[] = []
    const off = ctx.events.subscribe((e) => seen.push(e.seq))
    ctx.emit('job.created', { message: 'one' })
    ctx.emit('job.status', { message: 'two', severity: 'warn' })
    off()
    expect(seen).toHaveLength(2)
    expect(seen[1]).toBeGreaterThan(seen[0] ?? 0)

    const history = ctx.repos.events.list({ limit: 10 })
    expect(history.some((e) => e.message === 'one')).toBe(true)
    expect(ctx.events.replaySince(seen[0] ?? 0).length).toBeGreaterThanOrEqual(1)
  })

  it('encrypts provider keys at rest and never returns them from the store', async () => {
    const provider = ctx.repos.providers.createProvider({
      name: 'Test Router',
      type: 'nine_router',
      baseUrl: 'http://127.0.0.1:20128/v1',
    })
    const ref = `provider_${provider.id}`
    ctx.keystore.set(ref, 'sk-super-secret-value')

    expect(ctx.keystore.get(ref)).toBe('sk-super-secret-value')
    expect(ctx.keystore.has(ref)).toBe(true)

    const onDisk = await import('node:fs/promises').then((fs) => fs.readFile(ctx.paths.keystore, 'utf8'))
    expect(onDisk).not.toContain('sk-super-secret-value')

    const redacted = JSON.stringify(ctx.config.redacted())
    expect(redacted).not.toContain('sk-super-secret-value')
  })
})

describe('job handlers', () => {
  it('creates a job with its first loop and derives a title', async () => {
    const handlers = await import('../src/main/ipc/handlers/jobs').then((m) => m.jobHandlers(ctx))
    const create = handlers['jobs.create'] as (args: [{ prompt: string; loopCount?: number }]) => Promise<{ id: string; title: string; loopCount: number }>

    const job = await create([{ prompt: 'Build a CLI that converts CSV files into SQLite databases' }])
    expect(job.title).toContain('CSV')
    expect(job.loopCount).toBeGreaterThanOrEqual(1)

    const list = (handlers['jobs.list'] as (args: [{ status?: string[] }]) => { job: { id: string } }[])([{}])
    expect(list.some((j) => j.job.id === job.id)).toBe(true)

    const detail = (handlers['jobs.get'] as (args: [string]) => { job: { id: string }; loops: unknown[]; tasks: unknown[]; plan: unknown })([job.id])
    expect(detail.job.id).toBe(job.id)
    expect(detail.loops).toHaveLength(1)
    expect(detail.tasks).toHaveLength(0)
    expect(detail.plan).toBeNull()
  })

  it('rejects an empty prompt', async () => {
    const handlers = await import('../src/main/ipc/handlers/jobs').then((m) => m.jobHandlers(ctx))
    const create = handlers['jobs.create'] as (args: [{ prompt: string }]) => Promise<unknown>
    await expect(create([{ prompt: '   ' }])).rejects.toThrow(/prompt is required/)
  })
})

describe('project handlers', () => {
  it('registers a project directory and reports non-repo status', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'fern-proj-'))
    const handlers = await import('../src/main/ipc/handlers/projects').then((m) => m.projectHandlers(ctx))

    const create = handlers['projects.create'] as (args: [{ name: string; path: string }]) => Promise<{ id: string; path: string }>
    const project = await create([{ name: 'Sandbox', path: dir }])
    expect(project.path).toBe(dir)

    const st = (await (handlers['projects.gitStatus'] as (args: [string]) => Promise<{ isRepo: boolean }>)([project.id]))
    expect(st.isRepo).toBe(false)

    const duplicate = create([{ name: 'Again', path: dir }])
    await expect(duplicate).rejects.toThrow(/already registered/)

    const remove = handlers['projects.delete'] as (args: [string]) => Promise<boolean>
    await expect(remove([project.id])).resolves.toBe(true)
    await rm(dir, { recursive: true, force: true })
  })
})

describe('project workspace', () => {
  it('validates the project folder and hands it to the job as its workspace', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'fern-ws-'))
    const projects = await import('../src/main/ipc/handlers/projects').then((m) => m.projectHandlers(ctx))
    const jobHandlersApi = await import('../src/main/ipc/handlers/jobs').then((m) => m.jobHandlers(ctx))

    const createProject = projects['projects.create'] as (args: [{ name: string; path: string }]) => Promise<{ id: string; path: string }>
    const project = await createProject([{ name: 'Workspace', path: dir }])

    const validate = projects['projects.validate'] as (args: [string]) => { exists: boolean; isDirectory: boolean; writable: boolean; message: string | null }
    const healthy = validate([dir])
    expect(healthy.exists && healthy.isDirectory && healthy.writable).toBe(true)
    expect(healthy.message).toBeNull()
    expect(validate([join(dir, 'does-not-exist')]).message).toMatch(/does not exist/)

    const createJob = jobHandlersApi['jobs.create'] as (args: [{ prompt: string; projectId?: string }]) => Promise<{ id: string }>
    const job = await createJob([{ prompt: 'Do the thing in the project folder', projectId: project.id }])

    ctx.engine.start(job.id)
    const deadline = Date.now() + 3000
    while (ctx.repos.jobs.get(job.id)?.workspacePath !== dir && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 25))
    }
    expect(ctx.repos.jobs.get(job.id)?.workspacePath).toBe(dir)

    // A job against a folder that vanished must be refused, not silently
    // recreated as an empty directory by the worker dispatcher.
    await rm(dir, { recursive: true, force: true })
    await expect(createJob([{ prompt: 'Another one', projectId: project.id }])).rejects.toThrow(/cannot be used/)
    expect(validate([dir]).message).toMatch(/does not exist/)
  })
})

describe('obsidian handlers', () => {
  it('indexes a vault, searches it, resolves links and writes notes', async () => {
    const vaultDir = await mkdtemp(join(tmpdir(), 'fern-vault-'))
    await mkdir(join(vaultDir, 'projects'), { recursive: true })
    await writeFile(
      join(vaultDir, 'Home.md'),
      '---\ntags: [index, dashboard]\n---\n# Home\n\nSee [[projects/Fern Orchestrator]] and [[Missing Note]].\n',
      'utf8',
    )
    await writeFile(
      join(vaultDir, 'projects', 'Fern Orchestrator.md'),
      '# Fern Orchestrator\n\nBack to [[Home]]. Keyword quokka.\n',
      'utf8',
    )

    const handlers = await import('../src/main/ipc/handlers/obsidian').then((m) => m.obsidianHandlers(ctx))
    const add = handlers['vaults.add'] as (args: [{ path: string; name?: string }]) => Promise<{ id: string; name: string }>
    const vault = await add([{ path: vaultDir, name: 'Smoke Vault' }])

    const reindex = handlers['vaults.reindex'] as (args: [string]) => Promise<{ noteCount: number; indexStatus: string }>
    const indexed = await reindex([vault.id])
    expect(indexed.noteCount).toBe(2)
    expect(indexed.indexStatus).toBe('ready')

    const search = handlers['notes.search'] as (args: [string, { vaultId?: string }?]) => { title: string }[]
    const hits = search(['quokka', { vaultId: vault.id }])
    expect(hits.map((h) => h.title)).toContain('Fern Orchestrator')

    const backlinks = handlers['notes.backlinks'] as (args: [string, string]) => { title: string }[]
    expect(backlinks([vault.id, 'Home.md']).map((n) => n.title)).toContain('Fern Orchestrator')

    const broken = handlers['notes.brokenLinks'] as (args: [string]) => { from: string; target: string }[]
    expect(broken([vault.id]).some((l) => l.target.includes('Missing Note'))).toBe(true)

    const graph = handlers['notes.graph'] as (args: [string]) => { nodes: unknown[]; edges: unknown[] }
    const g = graph([vault.id])
    expect(g.nodes).toHaveLength(2)
    expect(g.edges).toHaveLength(2) // Home ↔ Fern Orchestrator

    const create = handlers['notes.create'] as (args: [string, { path: string; content: string }]) => Promise<{ title: string }>
    const created = await create([vault.id, { path: 'inbox/new-note.md', content: '# New\n\nLinked from nowhere.\n' }])
    expect(created.title).toBe('new-note')

    const update = handlers['notes.update'] as (args: [string, string, { content: string }]) => Promise<{ title: string }>
    await update([vault.id, 'inbox/new-note.md', { content: '# Renamed Title\n\nUpdated body.\n' }])
    const read = handlers['notes.get'] as (args: [string, string]) => Promise<{ content: string } | null>
    const note = await read([vault.id, 'inbox/new-note.md'])
    expect(note?.content).toContain('Updated body')

    const remove = handlers['notes.delete'] as (args: [string, string]) => Promise<boolean>
    await expect(remove([vault.id, 'inbox/new-note.md'])).resolves.toBe(true)

    await rm(vaultDir, { recursive: true, force: true })
  })
})

describe('approvals', () => {
  it('records a pending approval and resolves it', async () => {
    const handlers = await import('../src/main/ipc/handlers/jobs').then((m) => m.jobHandlers(ctx))
    const approval = ctx.repos.workers.createApproval({ kind: 'git_commit', title: 'Commit 3 files', jobId: null }, { diff: 'diff --git a/x b/x' })
    expect(approval.status).toBe('pending')

    const list = handlers['approvals.list'] as (args: [{ status?: 'pending' | 'all' }?]) => { id: string }[]
    expect(list([{}]).some((a) => a.id === approval.id)).toBe(true)

    const decide = handlers['approvals.decide'] as (args: [string, { approve: boolean; note?: string }]) => Promise<{
      approval: { status: string }
      delivered: boolean
    }>
    const decided = await decide([approval.id, { approve: false, note: 'not yet' }])
    expect(decided.approval.status).toBe('denied')
    // No OpenCode prompt behind this row, so there was nothing to deliver.
    expect(decided.delivered).toBe(true)

    const diff = handlers['approvals.diff'] as (args: [string]) => Promise<{ raw: string }>
    await expect(diff([approval.id])).resolves.toMatchObject({ raw: expect.stringContaining('diff --git') })
  })
})
