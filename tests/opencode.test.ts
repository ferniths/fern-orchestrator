import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { spawn, type ChildProcess } from 'node:child_process'
import { mkdtemp, rm, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { OpenCodeAdapter, toolPartStatus, toolStateError } from '../src/core/opencode/adapter'
import { parseSseBlock, readEventStream, type NormalizedEvent } from '../src/core/opencode/events'
import { OpenCodeServerPool, buildConfigContent, buildPermissionEnv, generateAgentFiles } from '../src/core/opencode/serverPool'
import { detectShell } from '../src/core/platform/binaries'
import { appConfigSchema } from '../src/core/kernel/config'
import { agentProfileSchema, providerConnectionSchema } from '../src/shared/domain'

const FIXTURE = fileURLToPath(new URL('./fixtures/fake-opencode.mjs', import.meta.url))

let child: ChildProcess
let base: string
let configDir: string

beforeAll(async () => {
  configDir = await mkdtemp(join(tmpdir(), 'fern-oc-test-'))
  child = spawn(process.execPath, [FIXTURE, '--port', '0', '--hostname', '127.0.0.1'], { stdio: ['ignore', 'pipe', 'pipe'] })
  const port = await new Promise<number>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('fixture did not start')), 8000)
    child.stdout!.on('data', (chunk: Buffer) => {
      const m = /listening (\d+)/.exec(String(chunk))
      if (m) {
        clearTimeout(timer)
        resolve(Number(m[1]))
      }
    })
    child.stderr!.on('data', (chunk: Buffer) => {
      if (String(chunk).includes('Error')) {
        clearTimeout(timer)
        reject(new Error(String(chunk)))
      }
    })
    child.on('exit', (code) => {
      clearTimeout(timer)
      reject(new Error(`fixture exited early: ${code}`))
    })
  })
  base = `http://127.0.0.1:${port}`
})

afterAll(async () => {
  child?.kill()
  await rm(configDir, { recursive: true, force: true })
})

function adapter(): OpenCodeAdapter {
  return new OpenCodeAdapter({ url: base, password: 'test-pass', directory: process.cwd() })
}

async function waitFor(predicate: () => boolean, timeoutMs = 8_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (predicate()) return
    await new Promise((r) => setTimeout(r, 50))
  }
  throw new Error('condition not met within timeout')
}

describe('OpenCodeAdapter', () => {
  it('reports health and version', async () => {
    const a = adapter()
    await expect(a.health()).resolves.toBe(true)
    await expect(a.version()).resolves.toBe('1.18.33-fake')
  })

  it('creates and lists sessions', async () => {
    const a = adapter()
    const created = await a.createSession({ title: 'worker one' })
    expect(created.id).toMatch(/^ses_/)
    const list = await a.listSessions()
    expect(list.some((s) => s.id === 'ses_1')).toBe(true)
  })

  it('sends prompts synchronously and asynchronously', async () => {
    const a = adapter()
    const res = await a.prompt('ses_1', { text: 'do the thing', agent: 'build' })
    expect(res.parts[0]?.text).toBe('worker finished')
    await expect(a.prompt('ses_1', { text: 'background', async: true })).resolves.toBeTruthy()
  })

  it('reads messages, diff, children and agents', async () => {
    const a = adapter()
    expect((await a.messages('ses_1')).length).toBeGreaterThan(0)
    expect((await a.diff('ses_1'))[0]).toMatchObject({ file: 'a.txt', additions: 2 })
    expect(await a.children('ses_1')).toEqual([])
    expect((await a.agents())[0]).toMatchObject({ name: 'build' })
  })

  it('lists and replies to permissions', async () => {
    const a = adapter()
    const perms = await a.listPermissions()
    expect(perms[0]).toMatchObject({ id: 'per_1', type: 'bash' })
    await expect(a.replyPermission('per_1', 'once')).resolves.toBe(true)
  })

  it('aborts sessions', async () => {
    await expect(adapter().abortSession('ses_1')).resolves.toBe(true)
  })

  it('maps unreachable servers onto the error taxonomy', async () => {
    const a = new OpenCodeAdapter({ url: 'http://127.0.0.1:1', timeoutMs: 500 })
    await expect(a.health()).resolves.toBe(false)
    await expect(a.createSession({})).rejects.toMatchObject({ code: 'opencode_error' })
  })
})

describe('tool executor evidence', () => {
  it('surfaces a non-zero exit code even when OpenCode reports status "completed"', () => {
    const part = {
      state: {
        status: 'completed',
        metadata: {
          exit: 1,
          output: "At line:1 char:117\r\n+ ...\r\nThe token '&&' is not a valid statement separator in this version.\r\n",
        },
      },
    }
    expect(toolPartStatus(part)).toBe('completed')
    const err = toolStateError(part)
    expect(err).toContain('exit 1')
    expect(err).toContain('not a valid statement separator')
    expect(err).not.toContain('\n')
  })

  it('reports no error for a clean exit', () => {
    expect(toolStateError({ state: { status: 'completed', metadata: { exit: 0, output: 'ok' } } })).toBeNull()
    expect(toolStateError({ state: { status: 'completed' } })).toBeNull()
    expect(toolStateError({})).toBeNull()
  })

  it('prefers an explicit tool error over the exit code', () => {
    const part = { state: { status: 'error', error: 'File not found: x.md', metadata: { exit: 1 } } }
    expect(toolStateError(part)).toBe('File not found: x.md')
    expect(toolPartStatus(part)).toBe('error')
  })
})

describe('SSE parsing', () => {
  it('parses a plain data block', () => {
    const e = parseSseBlock('data: {"type":"session.idle","info":{"sessionID":"ses_9"}}')
    expect(e).toMatchObject({ type: 'session.idle', sessionId: 'ses_9' })
  })

  it('parses a wrapped global event with an event: field', () => {
    const e = parseSseBlock('event: permission.asked\ndata: {"payload":{"type":"permission.asked","permission":{"id":"per_2"}},"directory":"C:/x"}')
    expect(e).toMatchObject({ type: 'permission.asked', directory: 'C:/x' })
    expect(e?.data).toHaveProperty('permission')
  })

  it('parses real 1.18.33 session.idle (evt_ id, session id under properties)', () => {
    const block =
      'data: {"directory":"C:\\\\ws","project":"global","payload":{"id":"evt_0ee84580d002C24OvOjR2t89lD","type":"session.idle","properties":{"sessionID":"ses_f117bc07cffeNDu6dR408goOOI"}}}'
    const e = parseSseBlock(block)
    expect(e).toMatchObject({
      type: 'session.idle',
      sessionId: 'ses_f117bc07cffeNDu6dR408goOOI',
      directory: 'C:\\ws',
    })
  })

  it('exposes the inner properties as data for message.part.updated', () => {
    const block =
      'data: {"directory":"C:\\\\ws","payload":{"id":"evt_1","type":"message.part.updated","properties":{"sessionID":"ses_2","part":{"type":"text","text":"hello"},"time":1790708039573}}}'
    const e = parseSseBlock(block)
    expect(e?.sessionId).toBe('ses_2')
    expect(e?.data).toMatchObject({ sessionID: 'ses_2', part: { type: 'text', text: 'hello' } })
  })

  it('parses real permission.asked (permission as a string, id per_)', () => {
    const block =
      'data: {"directory":"C:\\\\ws","payload":{"id":"evt_2","type":"permission.asked","properties":{"id":"per_abc","sessionID":"ses_3","permission":"bash","patterns":["git commit*"]}}}'
    const e = parseSseBlock(block)
    expect(e?.type).toBe('permission.asked')
    expect(e?.sessionId).toBe('ses_3')
    expect(e?.data).toMatchObject({ id: 'per_abc', permission: 'bash' })
  })

  it('parses session.status and session.created', () => {
    const status = parseSseBlock(
      'data: {"directory":"C:\\\\ws","payload":{"id":"evt_3","type":"session.status","properties":{"sessionID":"ses_4","status":{"type":"busy"}}}}',
    )
    expect(status).toMatchObject({ type: 'session.status', sessionId: 'ses_4' })
    const created = parseSseBlock(
      'data: {"directory":"C:\\\\ws","payload":{"id":"evt_4","type":"session.created","properties":{"sessionID":"ses_5","info":{"id":"ses_5","slug":"swift-knight"}}}}',
    )
    expect(created).toMatchObject({ type: 'session.created', sessionId: 'ses_5' })
  })

  it('drops sync envelopes, which mirror already-delivered named events', () => {
    const block =
      'data: {"directory":"C:\\\\ws","payload":{"type":"sync","syncEvent":{"id":"evt_5","type":"session.idle.1","data":{"sessionID":"ses_6"}},"id":"evt_5"}}'
    expect(parseSseBlock(block)).toBeNull()
  })

  it('handles heartbeat blocks without a directory wrapper', () => {
    const e = parseSseBlock('data: {"payload":{"id":"evt_6","type":"server.heartbeat","properties":{}}}')
    expect(e).toMatchObject({ type: 'server.heartbeat', sessionId: null, directory: null })
  })

  it('ignores comment and empty blocks', () => {
    expect(parseSseBlock(': keep-alive')).toBeNull()
    expect(parseSseBlock('')).toBeNull()
  })

  it('returns null for non-JSON payloads', () => {
    expect(parseSseBlock('data: not json')).toBeNull()
  })
})

describe('readEventStream', () => {
  it('delivers events until aborted', async () => {
    const controller = new AbortController()
    const seen: NormalizedEvent[] = []
    const done = readEventStream({
      server: { url: base },
      signal: controller.signal,
      onEvent: (e) => {
        seen.push(e)
        if (e.type === 'session.idle') controller.abort()
      },
    })
    await done.catch(() => undefined)
    const types = seen.map((e) => e.type)
    expect(types).toContain('session.created')
    expect(types).toContain('permission.asked')
    expect(types).toContain('session.idle')

    // Regression: a real 1.18.33 stream must yield a session id for every
    // session-scoped event, otherwise workers never settle.
    const idle = seen.find((e) => e.type === 'session.idle')
    expect(idle?.sessionId).toBe('ses_1')
    const permission = seen.find((e) => e.type === 'permission.asked')
    expect(permission?.sessionId).toBe('ses_1')
    const created = seen.find((e) => e.type === 'session.created')
    expect(created?.sessionId).toBe('ses_1')
  })
})

describe('server pool config builders', () => {
  it('builds git permission rules from policy', () => {
    const cfg = appConfigSchema.parse({ permissions: { gitCommit: 'ask', gitPush: 'deny' } })
    const env = buildPermissionEnv(cfg)
    const rules = JSON.parse(env.OPENCODE_PERMISSION!) as Record<string, Record<string, string>>
    expect(rules.bash!['*']).toBe('allow')
    expect(rules.bash!['git commit*']).toBe('ask')
    expect(rules.bash!['git push*']).toBe('deny')
  })

  it('covers every OpenCode permission key so nothing falls back to a silent ask', () => {
    // A key we omit falls back to OpenCode's own default, which is `ask` for
    // external_directory — and an unanswered ask deadlocks a headless worker.
    const cfg = appConfigSchema.parse({})
    const rules = JSON.parse(buildPermissionEnv(cfg).OPENCODE_PERMISSION!) as Record<string, string | Record<string, string>>
    for (const key of ['read', 'edit', 'glob', 'grep', 'list', 'task', 'external_directory']) {
      expect(rules[key], key).toEqual({ '*': 'allow' })
    }
    // `bash` also carries the git gates, so only its catch-all is asserted here.
    expect((rules.bash as Record<string, string>)['*'], 'bash').toBe('allow')
    for (const key of ['webfetch', 'websearch', 'todowrite', 'question', 'doom_loop']) {
      expect(rules[key], key).toBe('allow')
    }
    expect(Object.keys(rules)).toEqual(
      expect.arrayContaining(['read', 'edit', 'glob', 'grep', 'list', 'bash', 'task', 'external_directory', 'webfetch', 'websearch', 'todowrite', 'question', 'doom_loop']),
    )
  })

  it('inlines the API key as an env reference, never plaintext', () => {
    const provider = providerConnectionSchema.parse({
      id: 'prv_1',
      name: '9Router Local',
      type: 'nine_router',
      baseUrl: 'http://127.0.0.1:20128/v1',
      defaultModel: 'gpt-x',
      createdAt: 1,
      updatedAt: 1,
    })
    const keyEnv: Record<string, string> = {}
    const content = buildConfigContent([provider], new Map([['prv_1', 'super-secret-key']]), new Map([['prv_1', ['gpt-x', 'gpt-y']]]), keyEnv)
    expect(content).not.toContain('super-secret-key')
    expect(content).toContain('{env:FERN_OC_KEY_0}')
    expect(content).toContain('@ai-sdk/openai-compatible')
    expect(content).toContain('gpt-y')
    expect(keyEnv.FERN_OC_KEY_0).toBe('super-secret-key')
  })

  it('emits the shell override only when one was resolved', async () => {
    const empty = buildConfigContent([], new Map(), new Map(), {})
    expect(JSON.parse(empty)).not.toHaveProperty('shell')
    const withShell = buildConfigContent([], new Map(), new Map(), {}, 'C:/Program Files/Git/bin/bash.exe')
    expect(JSON.parse(withShell).shell).toBe('C:/Program Files/Git/bin/bash.exe')
    expect(JSON.parse(buildConfigContent([], new Map(), new Map(), {}, null))).not.toHaveProperty('shell')
  })

  it('resolves a PowerShell 5.1-safe shell on Windows and nothing on POSIX', async () => {
    const shell = await detectShell(null)
    if (process.platform !== 'win32') expect(shell).toBeNull()
    else if (shell) expect(shell).not.toMatch(/powershell\.exe$/i)
    expect(await detectShell('definitely/not/a/shell.exe')).toBeNull()
  })

  it('generates agent files only for custom OpenCode agent names', async () => {
    const dir = join(configDir, 'agents-gen')
    const custom = agentProfileSchema.parse({
      id: 'ag_1',
      name: 'Reviewer',
      role: 'reviewer',
      opencodeAgent: 'fern-reviewer',
      systemPrompt: 'Review carefully.',
      createdAt: 1,
      updatedAt: 1,
    })
    const builtin = agentProfileSchema.parse({
      id: 'ag_2',
      name: 'Coder',
      role: 'coder',
      opencodeAgent: 'build',
      systemPrompt: 'code',
      createdAt: 1,
      updatedAt: 1,
    })
    const written = await generateAgentFiles(dir, [custom, builtin])
    expect(written).toHaveLength(1)
    const body = await readFile(written[0]!, 'utf8')
    expect(body).toContain('name: fern-reviewer')
    expect(body).toContain('Review carefully.')
  })
})

describe('OpenCodeServerPool', () => {
  it('starts a server, verifies health through the adapter, and stops it', async () => {
    const cfg = appConfigSchema.parse({})
    const pool = new OpenCodeServerPool({
      configDir,
      getConfig: () => cfg,
      getProviders: () => [],
      getProfiles: () => [],
      getKey: () => null,
    })
    try {
      const state = await pool.start({
        label: 'fixture',
        directory: configDir,
        binaryPath: process.execPath,
        commandArgs: (args) => [FIXTURE, ...args],
        minimalEnv: true,
      })
      expect(state.status).toBe('ready')
      expect(state.pid).toBeGreaterThan(0)

      const adapter = pool.adapterFor(state.id)
      await expect(adapter.health()).resolves.toBe(true)
      await expect(adapter.listSessions()).resolves.toHaveLength(1)

      const refreshed = await pool.refresh(state.id)
      expect(refreshed?.status).toBe('ready')

      // ensureFor reuses the running server for the same directory
      const again = await pool.ensureFor(configDir)
      expect(again.id).toBe(state.id)
      expect(pool.list()).toHaveLength(1)

      await expect(pool.stop(state.id)).resolves.toBe(true)
      expect(pool.get(state.id)?.status).toBe('stopped')
      await expect(pool.adapterFor.bind(pool, state.id)).toThrow()
    } finally {
      await pool.stopAll()
    }
  }, 30_000)

  it('spawns only one server for concurrent ensureFor calls on the same directory', async () => {
    const cfg = appConfigSchema.parse({})
    const workspace = await mkdtemp(join(tmpdir(), 'fern-oc-race-'))
    const pool = new OpenCodeServerPool({
      configDir,
      getConfig: () => cfg,
      getProviders: () => [],
      getProfiles: () => [],
      getKey: () => null,
      startOptions: {
        binaryPath: process.execPath,
        commandArgs: (args) => [FIXTURE, ...args],
        minimalEnv: true,
      },
    })
    try {
      const [a, b] = await Promise.all([pool.ensureFor(workspace), pool.ensureFor(workspace)])
      expect(a.id).toBe(b.id)
      expect(a.status).toBe('ready')
      expect(pool.list()).toHaveLength(1)
    } finally {
      await pool.stopAll()
      await rm(workspace, { recursive: true, force: true })
    }
  }, 30_000)

  it('restores ready status once the event stream reconnects', async () => {
    const cfg = appConfigSchema.parse({})
    const workspace = await mkdtemp(join(tmpdir(), 'fern-oc-sse-'))
    const pool = new OpenCodeServerPool({
      configDir,
      getConfig: () => cfg,
      getProviders: () => [],
      getProfiles: () => [],
      getKey: () => null,
      startOptions: {
        binaryPath: process.execPath,
        commandArgs: (args) => [FIXTURE, ...args],
        minimalEnv: true,
      },
    })
    try {
      const state = await pool.ensureFor(workspace)
      expect(state.status).toBe('ready')

      // Drop the SSE socket until the stream errors (drops before the client
      // connects are no-ops), then the loop must come back to `ready`.
      const deadline = Date.now() + 8_000
      let sawUnhealthy = false
      while (Date.now() < deadline && !sawUnhealthy) {
        await fetch(`${state.url}/__sse_drop`).catch(() => undefined)
        sawUnhealthy = pool.get(state.id)?.status === 'unhealthy'
        if (!sawUnhealthy) await new Promise((r) => setTimeout(r, 200))
      }
      expect(sawUnhealthy).toBe(true)

      await waitFor(() => pool.get(state.id)?.status === 'ready', 8_000)
      expect(pool.get(state.id)?.status).toBe('ready')
      expect(pool.list().filter((s) => s.directory === workspace)).toHaveLength(1)
    } finally {
      await pool.stopAll()
      await rm(workspace, { recursive: true, force: true })
    }
  }, 30_000)
})
