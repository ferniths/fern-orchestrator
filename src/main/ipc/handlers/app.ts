import { app, dialog, shell } from 'electron'
import type { AppContext } from '../../context'
import type { AppInfo, GlobalSearchResult, OnboardingState, ServiceHealth, TimelineEntry } from '@shared/ipc'
import type { StatsSnapshot } from '@shared/domain'
import { detectGit, detectOpencode } from '@core/platform/binaries'
import type { Handlers } from '../router'
import { harnessHandlers } from './harness'

export function appHandlers(ctx: AppContext): Handlers {
  const startedAt = Date.now()

  return {
    ...harnessHandlers(ctx),

    'app.info': (): AppInfo => ({
      name: app.getName(),
      version: app.getVersion(),
      platform: process.platform as AppInfo['platform'],
      userDataPath: ctx.paths.root,
      locale: app.getLocale(),
      uptimeMs: Date.now() - startedAt,
    }),

    'app.health': async (): Promise<ServiceHealth[]> => {
      const nowTs = Date.now()
      const checks: ServiceHealth[] = []

      try {
        const integrity = ctx.db.integrity()
        checks.push({
          name: 'database',
          healthy: integrity.ok,
          message: integrity.ok ? 'ok' : integrity.details,
          lastError: integrity.ok ? null : integrity.details,
          checkedAt: nowTs,
        })
      } catch (err) {
        checks.push({ name: 'database', healthy: false, message: String(err), lastError: String(err), checkedAt: nowTs })
      }

      const git = await detectGit()
      checks.push({
        name: 'git',
        healthy: Boolean(git.path),
        message: git.version ? `git ${git.version}` : 'not found on PATH',
        lastError: git.path ? null : 'git executable missing',
        checkedAt: nowTs,
      })

      const oc = await detectOpencode(ctx.config.get().opencode.binaryPath)
      checks.push({
        name: 'opencode',
        healthy: Boolean(oc.path),
        message: oc.version ? `opencode ${oc.version} (${oc.source})` : 'not detected',
        lastError: oc.path ? null : 'opencode executable missing',
        checkedAt: nowTs,
      })

      // Honest: this reports the *stored* result of the last real probe
      // (`providers.test` → GET /models). It is not a live network check and
      // must not pretend to be one — the message says so.
      const providers = ctx.repos.providers.healthSummary()
      const allVerified = providers.configured > 0 && providers.healthy === providers.configured
      checks.push({
        name: 'providers',
        healthy: allVerified,
        message:
          providers.configured === 0
            ? 'no providers configured'
            : allVerified
              ? `${providers.healthy}/${providers.configured} healthy (from last probe)`
              : `${providers.healthy}/${providers.configured} verified healthy — run Test connection on Providers to re-probe`,
        lastError: providers.configured === 0 ? 'no providers configured' : allVerified ? null : 'one or more providers unverified or failing',
        checkedAt: nowTs,
      })

      const vault = ctx.repos.vaults.stats()
      checks.push({
        name: 'obsidian',
        healthy: ctx.repos.vaults.listVaults().length > 0,
        message: `${vault.notes} notes indexed`,
        lastError: null,
        checkedAt: nowTs,
      })

      return checks
    },

    'app.onboarding': async (): Promise<OnboardingState> => {
      const [opencode, git] = await Promise.all([
        detectOpencode(ctx.config.get().opencode.binaryPath),
        detectGit(),
      ])
      const providers = ctx.repos.providers.healthSummary()
      const vaults = ctx.repos.vaults.listVaults()
      const defaultVault = ctx.repos.vaults.defaultVault()
      const projects = ctx.repos.projects.list()
      const cfg = ctx.config.get()

      const state: OnboardingState = {
        opencode: { detected: Boolean(opencode.path), version: opencode.version, path: opencode.path },
        git: { detected: Boolean(git.path), version: git.version, path: git.path },
        providers: { configured: providers.configured, healthy: providers.healthy },
        vault: { configured: vaults.length > 0, path: defaultVault?.path ?? null, noteCount: defaultVault?.noteCount ?? 0 },
        projects: { registered: projects.length },
        complete:
          cfg.onboardingComplete &&
          Boolean(opencode.path) &&
          Boolean(git.path) &&
          providers.configured > 0 &&
          vaults.length > 0,
      }
      return state
    },

    'app.finishOnboarding': async (args): Promise<OnboardingState> => {
      const patch = (args[0] ?? {}) as { skip?: boolean }
      await ctx.config.update({ onboardingComplete: true })
      ctx.log('app').info('onboarding finished', { skipped: Boolean(patch.skip) })
      const handler = appHandlers(ctx)['app.onboarding']
      return (handler as () => Promise<OnboardingState>)()
    },

    'app.chooseDirectory': async (args): Promise<string | null> => {
      const opts = (args[0] ?? {}) as { title?: string; defaultPath?: string }
      const result = await dialog.showOpenDialog({
        properties: ['openDirectory', 'createDirectory'],
        ...(opts.title ? { title: opts.title } : {}),
        ...(opts.defaultPath ? { defaultPath: opts.defaultPath } : {}),
      })
      return result.canceled ? null : (result.filePaths[0] ?? null)
    },

    'app.chooseFile': async (args): Promise<string | null> => {
      const opts = (args[0] ?? {}) as { title?: string; defaultPath?: string; filters?: { name: string; extensions: string[] }[] }
      const result = await dialog.showOpenDialog({
        properties: ['openFile'],
        ...(opts.title ? { title: opts.title } : {}),
        ...(opts.defaultPath ? { defaultPath: opts.defaultPath } : {}),
        ...(opts.filters ? { filters: opts.filters } : {}),
      })
      return result.canceled ? null : (result.filePaths[0] ?? null)
    },

    'app.openPath': async (args): Promise<boolean> => {
      const target = String(args[0] ?? '')
      if (!target) return false
      const error = await shell.openPath(target)
      if (error) {
        ctx.log('app').warn('openPath failed', { target, error })
        return false
      }
      return true
    },

    'app.revealInFolder': async (args): Promise<boolean> => {
      const target = String(args[0] ?? '')
      if (!target) return false
      shell.showItemInFolder(target)
      return true
    },

    'app.openExternal': async (args): Promise<boolean> => {
      const url = String(args[0] ?? '')
      if (!/^https?:\/\//i.test(url)) return false
      await shell.openExternal(url)
      return true
    },

    /* settings ------------------------------------------------------------- */

    'settings.get': () => ctx.config.get(),

    'settings.update': async (args) => {
      const patch = args[0] as Record<string, unknown>
      const prev = ctx.config.get()
      const next = await ctx.config.update(patch)
      ctx.logger.setLevel(next.diagnostics.logLevel)
      if (next.diagnostics.retainLogDays !== prev.diagnostics.retainLogDays) {
        void ctx.logger.pruneOldLogs(next.diagnostics.retainLogDays)
      }
      if (next.obsidian.watch !== prev.obsidian.watch || next.obsidian.debounceMs !== prev.obsidian.debounceMs) {
        ctx.vaults.configure({ watch: next.obsidian.watch, debounceMs: next.obsidian.debounceMs })
      }
      try {
        ctx.onSettingsChanged?.(next)
      } catch (err) {
        ctx.log('app').warn('settings side effect failed', { error: String(err) })
      }
      return next
    },

    /* stats ---------------------------------------------------------------- */

    'stats.snapshot': (): StatsSnapshot => {
      const jobs = ctx.repos.jobs.countByStatus()
      const workers = ctx.repos.workers.countByStatus()
      const usage = ctx.repos.workers.usageByJob()
      const providers = ctx.repos.providers.healthSummary()
      const vault = ctx.repos.vaults.stats()
      return {
        jobs,
        workers,
        approvals: { pending: ctx.repos.jobs.pendingApprovals() },
        artifacts: { total: ctx.repos.workers.artifactCount() },
        providers,
        opencode: { servers: ctx.opencode.listServers().length, sessions: workers.running },
        vault,
        usage: { inputTokens: usage.total.input, outputTokens: usage.total.output, costUsd: usage.total.cost },
      }
    },

    'stats.usage': (args) => {
      const opts = (args[0] ?? {}) as { jobId?: string; days?: number }
      const days = opts.days && opts.days > 0 ? opts.days : null
      const since = days ? Date.now() - days * 86_400_000 : 0
      const byModel = new Map<string, { modelId: string; providerId: string; input: number; output: number; cost: number; calls: number }>()
      let input = 0
      let output = 0
      let cost = 0
      for (const row of ctx.repos.workers.listUsage(opts.jobId)) {
        if (row.at < since) continue
        const key = `${row.providerId}|${row.modelId}`
        const entry = byModel.get(key) ?? { modelId: row.modelId, providerId: row.providerId, input: 0, output: 0, cost: 0, calls: 0 }
        entry.input += row.inputTokens
        entry.output += row.outputTokens
        entry.cost += row.costUsd
        entry.calls += 1
        byModel.set(key, entry)
        input += row.inputTokens
        output += row.outputTokens
        cost += row.costUsd
      }
      return { byModel: [...byModel.values()], total: { input, output, cost } }
    },

    /* activity -------------------------------------------------------------- */

    'timeline.list': (args) => {
      const opts = (args[0] ?? {}) as { jobId?: string; severity?: string[]; limit?: number; after?: number }
      return ctx.repos.events.list(opts) as TimelineEntry[]
    },

    'search.global': (args) => {
      const query = String(args[0] ?? '').trim()
      const result: GlobalSearchResult = { jobs: [], tasks: [], workers: [], artifacts: [], notes: [], projects: [] }
      if (!query) return result
      const like = `%${query}%`

      result.jobs = ctx.db
        .all<{ id: string; title: string; refined_prompt: string }>(
          'SELECT id, title, refined_prompt FROM automation_jobs WHERE title LIKE ? OR original_prompt LIKE ? OR refined_prompt LIKE ? LIMIT 20',
          like,
          like,
          like,
        )
        .map((r) => ({ id: r.id, title: r.title, snippet: r.refined_prompt.slice(0, 160) }))

      result.tasks = ctx.db
        .all<{ id: string; title: string; job_id: string }>('SELECT id, title, job_id FROM tasks WHERE title LIKE ? OR objective LIKE ? LIMIT 30', like, like)
        .map((r) => ({ id: r.id, title: r.title, jobId: r.job_id }))

      result.workers = ctx.db
        .all<{ id: string; name: string; job_id: string }>('SELECT id, name, job_id FROM workers WHERE name LIKE ? OR objective LIKE ? LIMIT 30', like, like)
        .map((r) => ({ id: r.id, name: r.name, jobId: r.job_id }))

      result.artifacts = ctx.db
        .all<{ id: string; name: string; job_id: string; kind: string }>(
          'SELECT id, name, job_id, kind FROM artifacts WHERE name LIKE ? OR summary LIKE ? LIMIT 30',
          like,
          like,
        )
        .map((r) => ({ id: r.id, name: r.name, jobId: r.job_id, kind: r.kind }))

      result.projects = ctx.db
        .all<{ id: string; name: string; path: string }>('SELECT id, name, path FROM projects WHERE name LIKE ? OR path LIKE ? LIMIT 20', like, like)
        .map((r) => ({ id: r.id, name: r.name, path: r.path }))

      const vaultId = ctx.config.get().obsidian.defaultVaultId ?? undefined
      result.notes = ctx.repos.vaults.searchRaw(vaultId, query, 30).map((hit) => ({
        path: hit.meta.path,
        title: hit.meta.title,
        folder: hit.meta.folder,
        snippet: hit.snippet,
      }))

      return result
    },

    /* templates -------------------------------------------------------------- */

    'templates.list': () => ctx.repos.misc.listTemplates(),
    'templates.save': (args) => ctx.repos.misc.saveTemplate(args[0] as never),
    'templates.delete': (args) => ctx.repos.misc.deleteTemplate(String(args[0])),
  }
}
