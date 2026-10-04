import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createCoreContext, type AppContext } from '@core/kernel/appContext'
import { HARNESS_COMPONENTS, runHealthCheck } from '@core/orchestration/harnessHealth'
import { runSelfTest } from '@core/orchestration/selfTest'
import type { HarnessSelfTestEvidence } from '@shared/ipc'

const FIXTURE = fileURLToPath(new URL('./fixtures/fake-opencode.mjs', import.meta.url))
const E2E_TIMEOUT = 60_000

/* -------------------------------------------------------------------------- */
/* Mock OpenAI-compatible provider                                            */
/* -------------------------------------------------------------------------- */

const PLAN_RESPONSE = {
  summary: 'Write the self-test artifact, then summarize it.',
  risks: ['The artifact never lands on disk'],
  acceptance: ['self-test-artifact.md exists in the workspace'],
  steps: [
    {
      id: 's1',
      title: 'Write the self-test artifact',
      role: 'coder',
      dependsOn: [] as string[],
      prompt: 'Create the deliverable in the workspace root. Write it exactly here: FILE:self-test-artifact.md',
      expectedArtifacts: ['self-test-artifact.md'],
    },
    {
      id: 's2',
      title: 'Summarize the result',
      role: 'synthesizer',
      dependsOn: ['s1'],
      prompt: 'Summarize what the first step produced for the user.',
    },
  ],
}

const TEXT_REPLY = 'Refined brief: run the harness self-test pipeline to completion.'

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
            res.end(chatReply(JSON.stringify(PLAN_RESPONSE)))
            return
          }
          if (name === 'job_review') {
            res.end(
              chatReply(JSON.stringify({ verdict: 'pass', summary: 'review pass', problems: [], changes: [] })),
            )
            return
          }
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

  dataDir = await mkdtemp(join(tmpdir(), 'fern-harness-'))
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

/* -------------------------------------------------------------------------- */
/* Helpers                                                                    */
/* -------------------------------------------------------------------------- */

function mockProvider() {
  return ctx.repos.providers.listProviders().find((p) => p.name === 'Mock OpenAI')!
}

function expectNoLeftovers(): void {
  const dir = join(ctx.paths.root, 'harness-selftest')
  if (existsSync(dir)) expect(readdirSync(dir)).toEqual([])
}

async function withMockDisabled<T>(fn: () => Promise<T>): Promise<T> {
  const mock = mockProvider()
  ctx.repos.providers.updateProvider(mock.id, { enabled: false })
  try {
    return await fn()
  } finally {
    ctx.repos.providers.updateProvider(mock.id, { enabled: true })
  }
}

/* -------------------------------------------------------------------------- */
/* Health check                                                               */
/* -------------------------------------------------------------------------- */

describe('runHealthCheck()', () => {
  it('probes all ten components with real checks and cleans up after itself', async () => {
    const report = await runHealthCheck(ctx)

    expect(report.components.map((c) => c.name)).toEqual([...HARNESS_COMPONENTS])
    for (const component of report.components) {
      expect(component.reason.length, `${component.name} has an empty reason`).toBeGreaterThan(0)
      expect(component.durationMs).toBeGreaterThanOrEqual(0)
    }

    const byName = Object.fromEntries(report.components.map((c) => [c.name, c]))
    const mustPass = [
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
    ]
    for (const name of mustPass) {
      expect(byName[name]!.status, `${name}: ${byName[name]!.reason}`).toBe('pass')
    }
    expect(report.status).toBe('pass')
    expectNoLeftovers()
  }, E2E_TIMEOUT)

  it('fails opencodeBinary when the configured binary path does not exist', async () => {
    const broken = join(dataDir, 'missing-opencode-binary.exe')
    await ctx.config.update({ opencode: { binaryPath: broken } })
    try {
      const report = await runHealthCheck(ctx)
      const component = report.components.find((c) => c.name === 'opencodeBinary')!
      expect(component.status).toBe('fail')
      expect(component.reason).toContain('missing-opencode-binary.exe')
      expect(report.status).toBe('fail')
    } finally {
      await ctx.config.update({ opencode: { binaryPath: null } })
    }
  }, E2E_TIMEOUT)

  it('fails providerRoute when every provider is unreachable', async () => {
    const dead = ctx.repos.providers.createProvider({
      name: 'Dead provider',
      type: 'openai_compatible',
      baseUrl: 'http://127.0.0.1:1/v1',
      defaultModel: 'dead-model',
    })
    try {
      const result = await withMockDisabled(() => runHealthCheck(ctx))
      const component = result.components.find((c) => c.name === 'providerRoute')!
      expect(component.status).toBe('fail')
      expect(component.reason).toContain('no reachable provider')
      expect(component.reason).toContain('cannot reach http://127.0.0.1:1/v1')
      expect(result.status).toBe('fail')
    } finally {
      ctx.repos.providers.deleteProvider(dead.id)
    }
  }, E2E_TIMEOUT)
})

/* -------------------------------------------------------------------------- */
/* Self-test                                                                  */
/* -------------------------------------------------------------------------- */

describe('runSelfTest()', () => {
  it('runs the real pipeline end-to-end, verifies every invariant and removes the sandbox', async () => {
    let captured: HarnessSelfTestEvidence | null = null

    const report = await runSelfTest(ctx, {
      mode: 'selfTest',
      onEvidence: (evidence) => {
        captured = evidence
        // Live observations, before cleanup: the artifact is really on disk
        // and the temp job is still in the database while the report is built.
        const artifactAbs = join(evidence.workspace, 'self-test-artifact.md')
        expect(existsSync(artifactAbs)).toBe(true)
        expect(readFileSync(artifactAbs, 'utf8')).toContain('self-test-artifact.md')
        expect(ctx.repos.jobs.get(evidence.jobId)).toBeTruthy()
        expect(ctx.repos.workers.listArtifacts(evidence.jobId).length).toBeGreaterThan(0)
        expect(evidence.jobStatus).toBe('completed')
      },
    })

    expect(report.mode).toBe('selfTest')
    expect(report.status).toBe('pass')
    expect(report.reason).toMatch(/all 4 invariants verified/)

    const stepNames = report.steps.map((s) => s.name)
    expect(stepNames).toEqual(expect.arrayContaining(['providers', 'opencode', 'pipeline', 'evidence', 'invariants', 'cleanup']))
    const byName = Object.fromEntries(report.steps.map((s) => [s.name, s]))
    for (const name of ['providers', 'opencode', 'pipeline', 'evidence', 'invariants', 'cleanup']) {
      expect(byName[name]!.status, `${name}: ${byName[name]!.reason}`).toBe('pass')
    }

    expect(report.invariants).not.toBeNull()
    for (const [name, check] of Object.entries(report.invariants!)) {
      expect(check.status, `${name}: ${check.reason}`).toBe('pass')
    }

    expect(report.evidence).not.toBeNull()
    expect(report.evidence!.jobStatus).toBe('completed')
    expect(report.evidence!.workers.length).toBeGreaterThanOrEqual(2)
    expect(report.evidence!.tasks.length).toBeGreaterThanOrEqual(2)
    expect(report.evidence!.taskEvents.started).toBeGreaterThanOrEqual(1)
    expect(
      report.evidence!.artifacts.some((a) => a.path === 'self-test-artifact.md' && a.existsOnDisk),
    ).toBe(true)
    expect(captured).not.toBeNull()

    // Full cleanup: sandbox, temp job rows, transcripts, shared parent.
    expect(report.sandboxPath).not.toBeNull()
    expect(existsSync(report.sandboxPath!)).toBe(false)
    expect(ctx.repos.jobs.get(report.evidence!.jobId)).toBeNull()
    expect(existsSync(join(ctx.paths.jobs, report.evidence!.jobId))).toBe(false)
    expectNoLeftovers()
  }, E2E_TIMEOUT)

  it('reports skipped — never a pass — when no model provider is configured', async () => {
    const report = await withMockDisabled(() => runSelfTest(ctx, { mode: 'selfTest' }))

    expect(report.status).toBe('skipped')
    expect(report.reason).toMatch(/no model provider configured/)
    expect(report.invariants).toBeNull()
    expect(report.evidence).toBeNull()
    expect(report.sandboxPath).toBeNull()
    expect(report.steps.find((s) => s.name === 'providers')?.status).toBe('skipped')
    expectNoLeftovers()
  }, E2E_TIMEOUT)

  it('reports skipped when OpenCode auto-start is off', async () => {
    await ctx.config.update({ opencode: { autoStart: false } })
    try {
      const report = await runSelfTest(ctx, { mode: 'selfTest' })

      expect(report.status).toBe('skipped')
      expect(report.reason).toMatch(/auto-start is off/)
      expect(report.invariants).toBeNull()
      expect(report.evidence).toBeNull()
      expect(report.sandboxPath).toBeNull()
      expectNoLeftovers()
    } finally {
      await ctx.config.update({ opencode: { autoStart: true } })
    }
  }, E2E_TIMEOUT)

  it('reports skipped when the only provider is unreachable', async () => {
    const dead = ctx.repos.providers.createProvider({
      name: 'Dead provider',
      type: 'openai_compatible',
      baseUrl: 'http://127.0.0.1:1/v1',
      defaultModel: 'dead-model',
    })
    try {
      const report = await withMockDisabled(() => runSelfTest(ctx, { mode: 'selfTest' }))

      expect(report.status).toBe('skipped')
      expect(report.reason).toMatch(/provider unreachable/)
      expect(report.reason).toContain('cannot reach http://127.0.0.1:1/v1')
      expect(report.invariants).toBeNull()
      expect(report.evidence).toBeNull()
      expect(report.sandboxPath).toBeNull()
      expectNoLeftovers()
    } finally {
      ctx.repos.providers.deleteProvider(dead.id)
    }
  }, E2E_TIMEOUT)

  it('diagnostics mode maps every health component onto a step without running the pipeline', async () => {
    const report = await runSelfTest(ctx, { mode: 'diagnostics' })

    expect(report.mode).toBe('diagnostics')
    expect(report.steps.map((s) => s.name)).toEqual([...HARNESS_COMPONENTS])
    expect(report.invariants).toBeNull()
    expect(report.evidence).toBeNull()
    expect(report.sandboxPath).toBeNull()
    expectNoLeftovers()
  }, E2E_TIMEOUT)
})
