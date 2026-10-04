import { mkdir } from 'node:fs/promises'
import { ConfigStore, type AppConfig } from './config'
import { EventBus, EVENTS } from './eventBus'
import type { PublishPayload } from './eventBus'
import { Logger } from './logger'
import type { LogChannel } from './logger'
import { resolveAppPaths, type AppPaths } from '../platform/paths'
import { Db } from '../db/db'
import { Repos } from '../db/repos'
import { Keystore } from '../security/keystore'
import { VaultService } from '../services/vault'
import { ControlPlane } from '../services/controlPlane'
import { WorkerManager } from '../opencode/workerManager'
import { Engine } from '../orchestration/engine'

export interface DesktopNotification {
  title: string
  body: string
  severity: 'info' | 'warn' | 'error'
  jobId: string | null
}

export interface AppContext {
  paths: AppPaths
  config: ConfigStore
  logger: Logger
  events: EventBus
  db: Db
  repos: Repos
  keystore: Keystore
  vaults: VaultService
  /** Provider-aware control-plane AI access (routing, structured output, usage). */
  ai: ControlPlane
  /** OpenCode server pool + worker session lifecycle. */
  opencode: WorkerManager
  /** Refine → plan → schedule → execute → review run loop. */
  engine: Engine
  startedAt: number
  /** Publish an event: fans out to subscribers and appends to the event log. */
  emit: (type: string, payload?: PublishPayload) => void
  log: (channel: LogChannel) => Logger
  /** OS notification sink — set by the Electron shell, null in headless runs. */
  setDesktopNotifier: (fn: ((n: DesktopNotification) => void) | null) => void
  /** Assigned by the Electron shell: applied after every settings write. */
  onSettingsChanged?: (cfg: AppConfig) => void
  shutdown: () => Promise<void>
}

export interface CreateContextOptions {
  dataDir: string
  /** Print log records to the console (disabled in tests). */
  consoleLogs?: boolean
}

/**
 * After an unclean exit, rows left mid-flight wedge the engine: workers stuck in
 * `queued|starting|running|waiting_approval` hold the concurrency budget forever and
 * jobs stuck in `refining|planning|running|awaiting_approval` can never be resumed.
 * Runs once per context creation against whatever the previous process left behind.
 */
function reconcileStaleRows(db: Db, repos: Repos, logger: Logger): void {
  try {
    const nowTs = Date.now()
    const staleWorkers = db
      .all<{ id: string }>(
        "SELECT id FROM workers WHERE status IN ('queued','starting','running','waiting_approval')",
      )
      .map((row) => row.id)
    for (const id of staleWorkers) {
      repos.workers.updateWorker(id, { status: 'orphaned', statusReason: 'recovered after restart', completedAt: nowTs })
    }

    const staleJobs = repos.jobs.list({
      status: ['refining', 'planning', 'running', 'awaiting_approval'],
      limit: 1000,
    })
    for (const job of staleJobs) {
      repos.jobs.update(job.id, { status: 'paused', statusReason: 'interrupted — resume to continue' })
    }

    if (staleWorkers.length > 0 || staleJobs.length > 0) {
      logger.info('reconciled rows left mid-flight by the previous run', {
        workers: staleWorkers.length,
        jobs: staleJobs.length,
      })
    }
  } catch (err) {
    logger.warn('boot reconciliation failed', { error: String(err) })
  }
}

/**
 * Builds the full application context with zero Electron imports so the same
 * object powers the real app and headless integration tests.
 */
export async function createCoreContext(options: CreateContextOptions): Promise<AppContext> {
  const paths = resolveAppPaths(options.dataDir)

  await Promise.all([paths.root, paths.logs, paths.jobs, paths.bridge, paths.cache].map((d) => mkdir(d, { recursive: true })))

  const logger = new Logger({ dir: paths.logs, level: 'info', console: options.consoleLogs ?? true })

  let config: ConfigStore
  try {
    config = await ConfigStore.load(paths.config)
  } catch (err) {
    logger.error('config load failed, using defaults', { error: String(err) })
    config = new ConfigStore(paths.config)
  }
  logger.setLevel(config.get().diagnostics.logLevel)
  // Keep the log directory inside the retention window the user configured.
  void logger.pruneOldLogs(config.get().diagnostics.retainLogDays)

  const db = new Db(paths.db)
  const repos = new Repos(db)
  const events = new EventBus()
  const keystore = new Keystore(paths.keystore)
  const vaults = new VaultService(repos, {
    debounceMs: config.get().obsidian.debounceMs,
    watch: config.get().obsidian.watch,
  })
  // Index/watch failures (transient FS errors, vanished directories) surface in
  // the log instead of disappearing into a silent catch.
  vaults.setErrorHandler((message, data) => logger.warn(message, data))

  let desktopNotifier: ((n: DesktopNotification) => void) | null = null

  /**
   * Which notification toggle governs an event type. Every toggle in Settings
   * maps to real events here — nothing is decorative.
   */
  const notificationToggle = (type: string, n: AppConfig['notifications']): boolean => {
    switch (type) {
      case EVENTS.JOB_COMPLETED:
        return n.onJobCompleted
      case EVENTS.JOB_FAILED:
        return n.onJobFailed
      case EVENTS.APPROVAL_REQUESTED:
        return n.onApprovalRequested
      case EVENTS.WORKER_FAILED:
      case EVENTS.OPENCODE_SESSION_LOST:
        return n.onWorkerStuck
      case EVENTS.PROVIDER_FAILED:
      case EVENTS.PROVIDER_HEALTH:
        return n.onProviderUnhealthy
      default:
        return false
    }
  }

  const emit = (type: string, payload: PublishPayload = {}): void => {
    const event = events.publish(type, payload)
    try {
      repos.events.append(event)
    } catch (err) {
      logger.warn('event persistence failed', { error: String(err) })
    }

    const n = config.get().notifications
    if (!n.enabled || !notificationToggle(type, n)) return
    const severity: 'info' | 'warn' | 'error' =
      event.severity === 'error' ? 'error' : event.severity === 'warn' ? 'warn' : 'info'
    const body = event.data && Object.keys(event.data).length ? JSON.stringify(event.data) : ''
    repos.misc.notify({
      kind: type,
      title: event.message || type,
      body,
      severity,
      jobId: event.jobId,
    })
    try {
      desktopNotifier?.({ title: event.message || type, body, severity, jobId: event.jobId })
    } catch (err) {
      logger.warn('desktop notification failed', { error: String(err) })
    }
  }

  const context = {
    paths,
    config,
    logger,
    events,
    db,
    repos,
    keystore,
    vaults,
    startedAt: Date.now(),
    emit,
    log: (channel: LogChannel) => logger.child(channel),
    setDesktopNotifier: (fn: ((n: DesktopNotification) => void) | null) => {
      desktopNotifier = fn
    },
    shutdown: async () => {
      // Order matters: stop scheduling, then kill worker sessions, then persist/close.
      try {
        await context.engine.shutdown()
      } catch (err) {
        logger.warn('engine shutdown failed', { error: String(err) })
      }
      try {
        await context.opencode.shutdown()
      } catch (err) {
        logger.warn('opencode shutdown failed', { error: String(err) })
      }
      try {
        vaults.dispose()
        await config.flush()
        await keystore.flush()
      } catch (err) {
        logger.warn('state flush failed during shutdown', { error: String(err) })
      }
      try {
        await logger.flush()
      } catch {
        /* logger is going away — nothing left to report to */
      }
      repos.close()
    },
  } as unknown as AppContext

  context.ai = new ControlPlane(context)
  context.opencode = new WorkerManager(context)
  context.engine = new Engine(context)

  reconcileStaleRows(db, repos, logger)

  logger.info('context ready', { dataDir: paths.root, schema: db.schemaVersion })
  return context
}
