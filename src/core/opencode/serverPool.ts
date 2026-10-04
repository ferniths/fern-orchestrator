import { randomBytes } from 'node:crypto'
import { mkdir, writeFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { spawn, type ChildProcessByStdio } from 'node:child_process'
import type { Readable } from 'node:stream'

type ManagedProc = ChildProcessByStdio<null, Readable, Readable>
import type { AgentProfile, ProviderConnection } from '@shared/domain'
import type { AppConfig } from '../kernel/config'
import { AppError } from '../kernel/errors'
import { detectOpencode, detectShell, planLaunch, runProcess } from '../platform/binaries'
import { OpenCodeAdapter, type ServerEndpoint } from './adapter'
import { startEventLoop, type NormalizedEvent } from './events'

export type ServerStatus = 'starting' | 'ready' | 'unhealthy' | 'stopped' | 'failed'

export interface ServerState {
  id: string
  label: string
  directory: string
  port: number
  url: string
  pid: number | null
  status: ServerStatus
  version: string | null
  sessions: number
  startedAt: number
  lastError: string | null
  /** Last few stdout/stderr lines — surfaced in the UI's OpenCode monitor. */
  logTail: string[]
}

export interface StartOptions {
  /** Workspace root; defaults to the app's data root ("core" server). */
  directory?: string
  label?: string
  /** Explicit binary (tests pass a fake server executable/script). */
  binaryPath?: string
  /** Skip building provider/permission env (tests). */
  minimalEnv?: boolean
  /** Remap the spawn argv (tests launch a fake server through node). */
  commandArgs?: (args: string[]) => string[]
}

export interface PoolDeps {
  configDir: string
  getConfig: () => AppConfig
  getProviders: () => ProviderConnection[]
  getProfiles: () => AgentProfile[]
  /** Keystore lookup for a provider's apiKeyRef (never leaves the main process). */
  getKey: (apiKeyRef: string) => string | null
  onEvent?: (serverId: string, event: NormalizedEvent) => void
  /** Test hook: extra spawn options merged into every start (binary overrides). */
  startOptions?: StartOptions
  log?: (msg: string, data?: Record<string, unknown>) => void
}

const READY_TIMEOUT_MS = 45_000

async function freePort(): Promise<number> {
  const net = await import('node:net')
  return new Promise((resolve, reject) => {
    const srv = net.createServer()
    srv.on('error', reject)
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address()
      const port = typeof addr === 'object' && addr ? addr.port : 0
      srv.close(() => resolve(port))
    })
  })
}

/** `{env:VAR}` keeps secrets out of the generated config file. */
function envNameFor(index: number): string {
  return `FERN_OC_KEY_${index}`
}

/** Stable config id for a provider connection (matches `buildConfigContent`). */
export function providerSlug(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'provider'
}

/**
 * `OPENCODE_PERMISSION` rules: the catch-all stays `allow`, git commit/push —
 * including chained forms (`echo ok && git commit`, matched via `* git …*`
 * because rules are wildcards evaluated last-match-wins on the whole command) —
 * resolve to the configured action, with chains taking the strictest of both
 * git policies so one rule can never clobber the other.
 *
 * `opencode.enableApprovalPlugin` is the master switch for the whole rule set:
 * when it is off, workers run with a plain allow-everything policy and the
 * permission policy below is never injected.
 */
export function buildPermissionEnv(cfg: AppConfig): Record<string, string | undefined> {
  // Every permission key OpenCode 1.18 knows about. Anything omitted falls back
  // to OpenCode's own default, which is `ask` for `external_directory` — and an
  // `ask` nobody answers deadlocks a headless worker until the job times out.
  // Seen live: a model typo'd a path (`C:\Users\ Fern\…`), OpenCode asked for
  // `external_directory` approval, and the smoke run hung for 334s.
  //
  // Two shapes exist: pattern maps (read/edit/glob/grep/list/bash/task/
  // external_directory) and flat actions (todowrite/question/webfetch/websearch/
  // doom_loop), which reject per-pattern objects.
  const allowAll = {
    read: { '*': 'allow' },
    edit: { '*': 'allow' },
    glob: { '*': 'allow' },
    grep: { '*': 'allow' },
    list: { '*': 'allow' },
    bash: { '*': 'allow' },
    task: { '*': 'allow' },
    external_directory: { '*': 'allow' },
    webfetch: 'allow',
    websearch: 'allow',
    todowrite: 'allow',
    question: 'allow',
    doom_loop: 'allow',
  }
  if (!cfg.opencode.enableApprovalPlugin) return { OPENCODE_PERMISSION: JSON.stringify(allowAll) }

  const gitAction = (mode: 'ask' | 'allow' | 'deny'): string => mode
  const strictest = (...modes: ('ask' | 'allow' | 'deny')[]): 'ask' | 'allow' | 'deny' =>
    modes.includes('deny') ? 'deny' : modes.includes('ask') ? 'ask' : 'allow'
  const { gitCommit, gitPush, interceptChainedGit } = cfg.permissions
  const chainAction = strictest(gitCommit, gitPush)
  const rules: Record<string, string | Record<string, string>> = {
    ...allowAll,
    bash: {
      '*': 'allow',
      'git commit*': gitAction(gitCommit),
      'git push*': gitAction(gitPush),
      'git commit --amend*': gitAction(gitCommit),
      'git -C * commit*': gitAction(gitCommit),
      'git -C * push*': gitAction(gitPush),
      ...(interceptChainedGit
        ? {
            '* git push*': chainAction,
            '* git commit*': chainAction,
            '* git -C * commit*': chainAction,
            '* git -C * push*': chainAction,
          }
        : {}),
    },
  }
  return { OPENCODE_PERMISSION: JSON.stringify(rules) }
}

export function buildConfigContent(
  providers: ProviderConnection[],
  keys: Map<string, string | null>,
  modelIds: Map<string, string[]>,
  keyEnv: Record<string, string> = {},
  shell?: string | null,
): string {
  const providerEntries: Record<string, unknown> = {}
  let keyIndex = 0
  for (const p of providers) {
    if (!p.enabled || !p.baseUrl) continue
    const id = providerSlug(p.name)
    const key = keys.get(p.id) ?? null
    let apiKey: string | null = null
    if (key) {
      const env = envNameFor(keyIndex++)
      apiKey = `{env:${env}}`
      keyEnv[env] = key
    }
    const models = modelIds.get(p.id) ?? (p.defaultModel ? [p.defaultModel] : [])
    const modelMap: Record<string, unknown> = {}
    for (const m of [...new Set([...models, p.defaultModel, p.fallbackModel].filter(Boolean) as string[])]) {
      modelMap[m] = {}
    }
    if (Object.keys(modelMap).length === 0) continue
    providerEntries[id] = {
      npm: '@ai-sdk/openai-compatible',
      options: { baseURL: p.baseUrl, ...(apiKey ? { apiKey } : {}) },
      models: modelMap,
    }
  }
  return JSON.stringify({
    $schema: 'https://opencode.ai/config.json',
    ...(shell ? { shell } : {}),
    ...(Object.keys(providerEntries).length ? { provider: providerEntries } : {}),
  })
}

/** Writes `agents/*.md` for custom profiles so `opencode serve` exposes them. */
export async function generateAgentFiles(dir: string, profiles: AgentProfile[]): Promise<string[]> {
  const builtin = new Set(['build', 'plan', 'general', 'explore'])
  await mkdir(dir, { recursive: true })
  const written: string[] = []
  for (const p of profiles) {
    if (!p.enabled) continue
    const name = p.opencodeAgent?.trim()
    if (!name || builtin.has(name)) continue
    const file = join(dir, `${name}.md`)
    const front = [
      '---',
      `name: ${name}`,
      `description: ${JSON.stringify(p.description || p.name)}`,
      'mode: subagent',
      p.modelPreference?.modelId ? `model: ${p.modelPreference.modelId}` : '',
      p.allowedTools?.length ? `tools: ${JSON.stringify(p.allowedTools)}` : '',
      '---',
      '',
    ]
      .filter(Boolean)
      .join('\n')
    await writeFile(file, `${front}${p.systemPrompt || p.description || p.name}\n`, 'utf8')
    written.push(file)
  }
  return written
}

/**
 * Owns every `opencode serve` process we started (and only those).
 * One server per workspace root; a shared "core" server handles everything else.
 */
export class OpenCodeServerPool {
  private readonly servers = new Map<string, ServerState>()
  private readonly procs = new Map<string, ManagedProc>()
  private readonly controllers = new Map<string, AbortController>()
  private readonly endpoints = new Map<string, ServerEndpoint>()
  /**
   * In-flight `ensureFor` starts keyed by directory. The check/set below is
   * synchronous (no await between them), so two concurrent dispatches to the
   * same workspace can never both reach `start()` and spawn a second
   * `opencode serve`. Cleared as soon as the start settles so failures retry.
   */
  private readonly starting = new Map<string, Promise<ServerState>>()
  private counter = 0
  private disposed = false

  constructor(private readonly deps: PoolDeps) {}

  list(): ServerState[] {
    return [...this.servers.values()].map((s) => ({ ...s, logTail: [...s.logTail] }))
  }

  get(id: string): ServerState | null {
    const s = this.servers.get(id)
    return s ? { ...s, logTail: [...s.logTail] } : null
  }

  /** The server bound to a directory, starting a new one if needed. */
  async ensureFor(directory: string): Promise<ServerState> {
    const existing = [...this.servers.values()].find((s) => s.directory === directory && (s.status === 'ready' || s.status === 'starting'))
    if (existing) {
      if (existing.status === 'starting') await this.waitReady(existing.id)
      return this.get(existing.id)!
    }
    const pending = this.starting.get(directory)
    if (pending) return pending
    const start = this.start({ directory })
    this.starting.set(directory, start)
    const settleMemo = (): void => {
      if (this.starting.get(directory) === start) this.starting.delete(directory)
    }
    start.then(settleMemo, settleMemo)
    return start
  }

  adapterFor(id: string): OpenCodeAdapter {
    const endpoint = this.endpoints.get(id)
    if (!endpoint) throw new AppError('not_found', `unknown opencode server: ${id}`)
    return new OpenCodeAdapter(endpoint)
  }

  async start(opts: StartOptions = {}): Promise<ServerState> {
    if (this.disposed) throw new AppError('aborted', 'server pool is shutting down')
    opts = { ...this.deps.startOptions, ...opts }
    const directory = opts.directory ?? this.deps.configDir
    const cfg = this.deps.getConfig()

    // `opencode.maxServers`: evict the oldest idle server first so a long-lived
    // session never silently blocks a new workspace from starting.
    if (this.servers.size >= cfg.opencode.maxServers) {
      const evictable = [...this.servers.values()]
        .filter((s) => s.directory !== directory && (s.status === 'ready' || s.status === 'unhealthy'))
        .sort((a, b) => a.startedAt - b.startedAt)[0]
      if (evictable) {
        this.deps.log?.('evicting idle opencode server to stay within maxServers', { serverId: evictable.id, maxServers: cfg.opencode.maxServers })
        await this.stop(evictable.id)
      } else {
        throw new AppError(
          'unavailable',
          `opencode server limit reached (${cfg.opencode.maxServers}) — raise "Max servers" in Settings → OpenCode`,
        )
      }
    }

    const detection = await detectOpencode(opts.binaryPath ?? cfg.opencode.binaryPath)
    if (!detection.path) throw new AppError('unavailable', detection.error ?? 'OpenCode binary not found — install opencode or set its path in Settings')

    const id = `srv_${++this.counter}_${Date.now().toString(36)}`
    const label = opts.label ?? (opts.directory ? directory.split(/[\\/]/).filter(Boolean).pop() ?? 'workspace' : 'core')
    const port = await freePort()
    const url = `http://127.0.0.1:${port}`
    const password = randomBytes(18).toString('base64url')
    const configDir = join(this.deps.configDir, id)
    await mkdir(join(configDir, 'agents'), { recursive: true })

    const state: ServerState = {
      id,
      label,
      directory,
      port,
      url,
      pid: null,
      status: 'starting',
      version: detection.version,
      sessions: 0,
      startedAt: Date.now(),
      lastError: null,
      logTail: [],
    }
    this.servers.set(id, state)

    const endpoint: ServerEndpoint = { url, password, directory }
    this.endpoints.set(id, endpoint)

    const env: NodeJS.ProcessEnv = { ...process.env, OPENCODE_SERVER_PASSWORD: password }
    if (!opts.minimalEnv) {
      Object.assign(env, buildPermissionEnv(cfg))
      const providers = this.deps.getProviders().filter((p) => p.enabled)
      const keys = new Map(providers.map((p) => [p.id, p.apiKeyRef ? this.deps.getKey(p.apiKeyRef) : null] as const))
      const modelIds = new Map<string, string[]>()
      for (const p of providers) modelIds.set(p.id, p.defaultModel ? [p.defaultModel] : [])
      const keyEnv: Record<string, string> = {}
      const shell = await detectShell(cfg.opencode.shell)
      env.OPENCODE_CONFIG_CONTENT = buildConfigContent(providers, keys, modelIds, keyEnv, shell)
      if (!shell && cfg.opencode.shell) {
        this.pushLog(state, `configured shell "${cfg.opencode.shell}" is not usable — OpenCode will fall back to its default`)
      }
      Object.assign(env, keyEnv)
      env.OPENCODE_CONFIG_DIR = configDir
      try {
        await generateAgentFiles(join(configDir, 'agents'), this.deps.getProfiles())
      } catch (err) {
        this.pushLog(state, `agent generation failed: ${String(err)}`)
      }
    }

    const baseArgs = ['serve', '--port', String(port), '--hostname', '127.0.0.1']
    // `opencode.extraArgs` are appended to every `opencode serve` invocation.
    const extraArgs = opts.minimalEnv ? [] : (cfg.opencode.extraArgs ?? []).filter((a) => typeof a === 'string' && a.trim())
    const args = opts.commandArgs?.([...baseArgs, ...extraArgs]) ?? [...baseArgs, ...extraArgs]
    const exe = detection.path!
    if (!exe || exe.trim() === '') {
      state.status = 'failed'
      state.lastError = 'OpenCode executable path is empty'
      throw new AppError('unavailable', 'OpenCode executable path is empty')
    }
    let proc: ManagedProc
    try {
      // Structured launch: `.cmd` shims are resolved to the executable they
      // invoke (planLaunch); only an unresolvable batch file goes through the
      // shell. Spawning a `.cmd` directly would throw EINVAL (CVE-2024-27980).
      const plan = planLaunch(exe, args)
      proc = spawn(plan.file, plan.argv, {
        cwd: directory,
        env,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
        ...(plan.shell ? { shell: true } : {}),
      })
    } catch (err) {
      state.status = 'failed'
      state.lastError = String(err)
      throw new AppError('opencode_error', `failed to spawn opencode: ${String(err)}`)
    }

    state.pid = proc.pid ?? null
    this.procs.set(id, proc)
    proc.stdout.setEncoding('utf8')
    proc.stderr.setEncoding('utf8')
    proc.stdout.on('data', (chunk: string) => this.pushLog(state, chunk))
    proc.stderr.on('data', (chunk: string) => this.pushLog(state, chunk))
    proc.on('error', (err) => {
      state.status = 'failed'
      state.lastError = String(err)
      this.deps.log?.(`opencode process error: ${String(err)}`, { serverId: id })
    })
    proc.on('exit', (code, signal) => {
      if (state.status !== 'stopped') {
        state.status = 'failed'
        state.lastError = `exited (code=${code ?? 'null'} signal=${signal ?? 'null'})`
      }
      this.procs.delete(id)
      this.controllers.get(id)?.abort()
      this.controllers.delete(id)
      this.deps.log?.(`opencode exited: ${state.lastError}`, { serverId: id })
    })

    try {
      await this.waitReady(id)
    } catch (err) {
      state.status = 'failed'
      state.lastError = (err as Error).message
      await this.stop(id)
      throw err
    }

    this.beginEventLoop(id)
    this.deps.log?.('opencode server ready', { serverId: id, url, label })
    return this.get(id)!
  }

  /** Polls /global/health until the server answers or the timeout elapses. */
  async waitReady(id: string): Promise<void> {
    const state = this.servers.get(id)
    const endpoint = this.endpoints.get(id)
    if (!state || !endpoint) throw new AppError('not_found', `unknown server ${id}`)
    const adapter = new OpenCodeAdapter(endpoint)
    const timeoutMs = this.deps.getConfig().opencode.serverTimeoutMs || READY_TIMEOUT_MS
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      if (state.status === 'failed') throw new AppError('opencode_error', state.lastError ?? 'opencode failed to start')
      if (await adapter.health()) {
        state.status = 'ready'
        state.lastError = null
        return
      }
      await new Promise((r) => setTimeout(r, 350))
    }
    throw new AppError('timeout', `opencode did not become healthy within ${timeoutMs}ms`)
  }

  private beginEventLoop(id: string): void {
    const endpoint = this.endpoints.get(id)
    const state = this.servers.get(id)
    if (!endpoint || !state) return
    const controller = new AbortController()
    this.controllers.set(id, controller)
    void startEventLoop({
      server: endpoint,
      signal: controller.signal,
      onEvent: (event) => {
        this.deps.onEvent?.(id, event)
      },
      onError: (err, attempt) => {
        if (state.status === 'ready') state.status = 'unhealthy'
        this.pushLog(state, `event stream error (attempt ${attempt}): ${String(err)}`)
      },
      // A (re)connect proves the server answered again: restore `ready` after a
      // stream error, otherwise the pool stays `unhealthy` forever and both
      // agents()/sessions() and ensureFor misbehave (duplicate spawns).
      onConnected: () => {
        if (state.status === 'unhealthy') {
          state.status = 'ready'
          state.lastError = null
        }
      },
    })
  }

  async stop(id: string): Promise<boolean> {
    const state = this.servers.get(id)
    if (!state) return false
    state.status = 'stopped'
    this.controllers.get(id)?.abort()
    this.controllers.delete(id)
    const proc = this.procs.get(id)
    this.procs.delete(id)
    if (proc && proc.exitCode === null) {
      await new Promise<void>((resolve) => {
        const timer = setTimeout(() => {
          try {
            proc.kill('SIGKILL')
          } catch {
            /* already gone */
          }
          resolve()
        }, 4000)
        proc.once('exit', () => {
          clearTimeout(timer)
          resolve()
        })
        try {
          proc.kill()
        } catch {
          clearTimeout(timer)
          resolve()
        }
      })
    }
    this.endpoints.delete(id)
    try {
      await rm(join(this.deps.configDir, id), { recursive: true, force: true })
    } catch {
      /* best effort */
    }
    this.deps.log?.('opencode server stopped', { serverId: id })
    return true
  }

  async stopAll(): Promise<void> {
    this.disposed = true
    await Promise.all([...this.servers.keys()].map((id) => this.stop(id)))
  }

  /** Health-refresh pass used by the UI poller. */
  async refresh(id: string): Promise<ServerState | null> {
    const state = this.servers.get(id)
    const endpoint = this.endpoints.get(id)
    if (!state || !endpoint) return null
    const adapter = new OpenCodeAdapter(endpoint)
    const healthy = await adapter.health()
    if (state.status !== 'stopped' && state.status !== 'failed') state.status = healthy ? 'ready' : 'unhealthy'
    if (healthy) {
      try {
        const sessions = await adapter.listSessions()
        state.sessions = sessions.length
      } catch {
        /* ignore */
      }
    }
    return this.get(id)
  }

  private pushLog(state: ServerState, chunk: string): void {
    const lines = chunk
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter(Boolean)
    if (lines.length === 0) return
    state.logTail.push(...lines)
    if (state.logTail.length > 60) state.logTail.splice(0, state.logTail.length - 60)
  }
}

/** Small helper for version probing used by the health check. */
export async function probeVersion(binaryPath: string): Promise<string | null> {
  try {
    const out = await runProcess(binaryPath, ['--version'])
    return out.match(/\d+\.\d+(\.\d+)?/)?.[0] ?? null
  } catch {
    return null
  }
}
