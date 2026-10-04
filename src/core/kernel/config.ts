import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { z } from 'zod'
import { orchestrationLimitsSchema, outputLanguageSchema, permissionPolicySchema } from '@shared/domain'
import { AppError } from './errors'
import { redact } from './logger'

export const appConfigSchema = z.object({
  version: z.number().int().default(1),
  onboardingComplete: z.boolean().default(false),

  general: z
    .object({
      locale: z.string().default('en'),
      /** Output language for natural-language AI prose (Settings → General). */
      language: outputLanguageSchema.default('English'),
      launchAtLogin: z.boolean().default(false),
      minimizeToTray: z.boolean().default(true),
      confirmDestructive: z.boolean().default(true),
    })
    .prefault({}),

  appearance: z
    .object({
      theme: z.enum(['dark', 'light', 'system']).default('dark'),
      accent: z.enum(['neutral', 'blue', 'green', 'amber']).default('neutral'),
      reduceMotion: z.boolean().default(false),
      showProseMotion: z.boolean().default(true),
    })
    .prefault({}),

  opencode: z
    .object({
      /** Explicit binary path; null = auto-discover. */
      binaryPath: z.string().nullable().default(null),
      autoStart: z.boolean().default(true),
      serverTimeoutMs: z.number().int().min(5_000).default(60_000),
      maxServers: z.number().int().min(1).max(16).default(6),
      /** Extra args appended to every `opencode serve` invocation. */
      extraArgs: z.array(z.string()).default([]),
      /** Restrict workers to these OpenCode agents (null = all). */
      allowedAgents: z.array(z.string()).nullable().default(null),
      /** Inject a dashboard plugin that blocks unapproved git commit/push. */
      enableApprovalPlugin: z.boolean().default(true),
      /**
       * Shell OpenCode's `bash` tool runs through. null = auto-detect a
       * POSIX-capable shell on Windows (Git Bash, then bash/pwsh on PATH);
       * PowerShell 5.1 is OpenCode's Windows fallback and it rejects `&&`,
       * which silently breaks ordinary model commands.
       */
      shell: z.string().nullable().default(null),
    })
    .prefault({}),

  orchestration: z
    .object({
      limits: orchestrationLimitsSchema.prefault({}),
      defaultLoopCount: z.number().int().min(1).max(100).default(3),
      defaultRouteId: z.string().nullable().default(null),
      requirePlanApproval: z.boolean().default(false),
      /** Keep full worker transcripts in the DB (bounded per worker). */
      persistTranscripts: z.boolean().default(true),
      taskTimeoutMs: z.number().int().min(60_000).default(30 * 60_000),
      /**
       * How long an unanswered permission approval (git gate, vault write, …)
       * may park a worker. 0 = wait forever (the worker then parks until
       * `taskTimeoutMs`). Plan approvals never expire — they are a deliberate
       * human decision with no deadline.
       */
      approvalTimeoutMs: z.number().int().min(0).default(15 * 60_000),
    })
    .prefault({}),

  permissions: permissionPolicySchema.prefault({}),

  obsidian: z
    .object({
      defaultVaultId: z.string().nullable().default(null),
      watch: z.boolean().default(true),
      /** Debounce for filesystem events before re-indexing a note. */
      debounceMs: z.number().int().min(50).default(400),
      searchLimit: z.number().int().min(10).max(500).default(50),
    })
    .prefault({}),

  git: z
    .object({
      /** Directories scanned for repository discovery. */
      searchPaths: z.array(z.string()).default([]),
      autoDetect: z.boolean().default(true),
      /** Ignore patterns while discovering repositories. */
      ignore: z.array(z.string()).default(['node_modules', '.venv', 'dist', 'build', 'target', '.cache']),
      maxDiscoveryDepth: z.number().int().min(1).max(8).default(4),
    })
    .prefault({}),

  notifications: z
    .object({
      enabled: z.boolean().default(true),
      onJobCompleted: z.boolean().default(true),
      onJobFailed: z.boolean().default(true),
      onApprovalRequested: z.boolean().default(true),
      onWorkerStuck: z.boolean().default(false),
      onProviderUnhealthy: z.boolean().default(false),
    })
    .prefault({}),

  diagnostics: z
    .object({
      logLevel: z.enum(['debug', 'info', 'warn', 'error']).default('info'),
      /** Extra verbose logging of provider/OpenCode payloads (still redacted). */
      diagnosticMode: z.boolean().default(false),
      retainLogDays: z.number().int().min(1).max(365).default(14),
    })
    .prefault({}),
})

export type AppConfig = z.infer<typeof appConfigSchema>

export const DEFAULT_CONFIG: AppConfig = appConfigSchema.parse({})

/** Environment overrides — used by tests and headless runs, never required. */
const ENV_OVERRIDES: Record<string, (cfg: AppConfig, value: string) => void> = {
  FERN_LOG_LEVEL: (c, v) => {
    if (['debug', 'info', 'warn', 'error'].includes(v)) c.diagnostics.logLevel = v as AppConfig['diagnostics']['logLevel']
  },
  FERN_OPENCODE_BIN: (c, v) => {
    c.opencode.binaryPath = v
  },
  FERN_DATA_DIR: () => undefined,
  FERN_WORKER_CONCURRENCY: (c, v) => {
    const n = Number(v)
    if (Number.isFinite(n) && n > 0) c.orchestration.limits.maxConcurrentWorkers = Math.floor(n)
  },
}

function deepMerge<T>(base: T, patch: unknown): T {
  if (patch === undefined || patch === null) return base
  if (Array.isArray(base) || typeof base !== 'object' || base === null) return patch as T
  if (typeof patch !== 'object') return patch as T
  const out: Record<string, unknown> = { ...(base as Record<string, unknown>) }
  for (const [k, v] of Object.entries(patch as Record<string, unknown>)) {
    const current = out[k]
    out[k] =
      current && typeof current === 'object' && !Array.isArray(current) && v && typeof v === 'object' && !Array.isArray(v)
        ? deepMerge(current, v)
        : v
  }
  return out as T
}

export class ConfigStore {
  private config: AppConfig
  private chain: Promise<void> = Promise.resolve()

  constructor(
    private readonly filePath: string,
    initial: AppConfig = DEFAULT_CONFIG,
  ) {
    this.config = initial
  }

  static async load(filePath: string): Promise<ConfigStore> {
    let fileConfig: unknown = {}
    try {
      const raw = await readFile(filePath, 'utf8')
      fileConfig = JSON.parse(raw)
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code
      if (code && code !== 'ENOENT') {
        // Corrupt config must not brick the app: keep defaults and surface it.
        throw new AppError('invalid_argument', `config is unreadable (${code})`, { cause: err })
      }
    }

    const merged = deepMerge(DEFAULT_CONFIG, fileConfig)
    const parsed = appConfigSchema.safeParse(merged)
    const config = parsed.success ? parsed.data : deepMerge(DEFAULT_CONFIG, {})

    for (const [key, apply] of Object.entries(ENV_OVERRIDES)) {
      const value = process.env[key]
      if (value) {
        try {
          apply(config, value)
        } catch {
          /* ignore malformed env overrides */
        }
      }
    }

    const store = new ConfigStore(filePath, config)
    // If the file was missing or partially invalid, persist the resolved shape.
    if (!parsed.success || Object.keys(fileConfig as object).length === 0) await store.save()
    return store
  }

  get(): AppConfig {
    return this.config
  }

  section<K extends keyof AppConfig>(key: K): AppConfig[K] {
    return this.config[key]
  }

  async update(patch: unknown): Promise<AppConfig> {
    this.config = appConfigSchema.parse(deepMerge(this.config, patch))
    await this.save()
    return this.config
  }

  async replace(next: AppConfig): Promise<AppConfig> {
    this.config = appConfigSchema.parse(next)
    await this.save()
    return this.config
  }

  save(): Promise<void> {
    const payload = JSON.stringify(this.config, null, 2)
    this.chain = this.chain
      .then(async () => {
        await mkdir(dirname(this.filePath), { recursive: true })
        const tmp = `${this.filePath}.tmp`
        await writeFile(tmp, payload, 'utf8')
        await rename(tmp, this.filePath)
      })
      .catch((err) => {
        throw new AppError('internal', 'failed to persist config', { cause: err })
      })
    return this.chain
  }

  /** Redacted view safe for logs/diagnostics screens. */
  redacted(): AppConfig {
    return redact(this.config) as AppConfig
  }

  async flush(): Promise<void> {
    await this.chain
  }
}
