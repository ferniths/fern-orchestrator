import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { Approval, Worker } from '@shared/domain'
import type { OpencodeDetection, OpencodeServerState, TranscriptEntry } from '@shared/ipc'
import type { AppContext } from '../kernel/appContext'
import { EVENTS } from '../kernel/eventBus'
import { AppError } from '../kernel/errors'
import { detectOpencode } from '../platform/binaries'
import { interceptChainedGit } from '../services/git'
import type { DiffEntry, MessageInfo, OcPermission, TranscriptMessage } from './adapter'
import { toolPartStatus, toolStateError } from './adapter'
import { collectWorkerArtifacts, persistCollection, type CollectResult } from './artifactCollector'
import type { NormalizedEvent } from './events'
import { OpenCodeServerPool, providerSlug, type ServerState } from './serverPool'

interface ActiveRun {
  workerId: string
  sessionId: string
  serverId: string
  jobId: string
  timer: ReturnType<typeof setTimeout> | null
}

const TRANSCRIPT_LIMIT = 400
const TEXT_LIMIT = 6_000
/** Completion transcript fetches: bounded retries so an early `session.idle` cannot fake success. */
const TRANSCRIPT_RETRIES = 3
const TRANSCRIPT_RETRY_MS = 650

/**
 * Tools that can actually put bytes on disk. Used only to tell "tried and
 * failed" apart from "never attempted": a worker that reports a file as created
 * without any of these in its transcript did not create it.
 */
const WRITE_TOOLS = new Set(['write', 'edit', 'patch', 'create', 'apply_patch', 'bash', 'shell', 'run_command', 'powershell'])

function noWriteReason(missing: string[]): string {
  return `no write tool was ever called — ${missing.join(', ')} does not exist (a claim is not a file)`
}

/**
 * Which of the still-missing files no write-class tool ever targeted. Catches
 * the sharpest form of #5: a worker writes one deliverable, never attempts the
 * other, and reports both as created — generic "missing expected artifacts"
 * does not tell the retry which one to actually write.
 */
function neverTargeted(entries: TranscriptEntry[], missing: string[]): string[] {
  const targets = new Set<string>()
  for (const e of entries) {
    if (e.role !== 'tool' || !WRITE_TOOLS.has((e.tool?.name ?? '').toLowerCase())) continue
    const input = e.tool?.input
    const raw = typeof input === 'string' ? input : JSON.stringify(input ?? {})
    for (const hit of raw.matchAll(/"(?:filePath|file|path|filename)"\s*:\s*"([^"]+)"/gi)) {
      const norm = normalizePath(hit[1] ?? '')
      if (!norm) continue
      targets.add(norm)
      targets.add(norm.slice(norm.lastIndexOf('/') + 1))
    }
  }
  return missing.filter((name) => {
    const norm = normalizePath(name)
    return !targets.has(norm) && !targets.has(norm.slice(norm.lastIndexOf('/') + 1))
  })
}

function normalizePath(p: string): string {
  return p.replace(/\\/g, '/').toLowerCase()
}

const TERMINAL_STATUSES = ['succeeded', 'failed', 'timed_out', 'aborted'] as const

function isTerminal(status: string): boolean {
  return (TERMINAL_STATUSES as readonly string[]).includes(status)
}

function errorMessage(err: unknown): string {
  return (err as Error)?.message ?? String(err)
}

type WorkerSessionStatus = 'active' | 'idle' | 'completed' | 'failed' | 'lost' | 'aborted'

function toServerState(s: ServerState): OpencodeServerState {
  const { logTail: _logTail, ...rest } = s
  return rest
}

function permissionKind(permission: OcPermission): Approval['kind'] {
  const text = `${permission.type} ${permission.pattern ?? ''} ${permission.title ?? ''}`.toLowerCase()
  if (text.includes('git') && text.includes('commit')) return 'git_commit'
  if (text.includes('git') && text.includes('push')) return 'git_push'
  return 'manual_gate'
}

/** Best-effort command text behind a permission prompt (bash payloads carry it in `metadata.command`). */
function permissionCommand(permission: OcPermission, data: Record<string, unknown>): string {
  const meta = (permission.metadata ?? data.metadata) as Record<string, unknown> | undefined
  if (meta && typeof meta.command === 'string' && meta.command) return meta.command
  if (typeof permission.pattern === 'string' && permission.pattern) return permission.pattern
  if (permission.type === 'bash' && Array.isArray(data.patterns)) {
    const joined = data.patterns.filter((p): p is string => typeof p === 'string').join(' && ')
    if (joined) return joined
  }
  return ''
}

/** Converts native OpenCode messages into the renderer's transcript shape. */
export function messagesToTranscript(messages: TranscriptMessage[]): TranscriptEntry[] {
  const out: TranscriptEntry[] = []
  for (const msg of messages) {
    const role: TranscriptEntry['role'] = msg.info.role === 'user' ? 'user' : msg.info.role === 'assistant' ? 'assistant' : 'system'
    const at = (msg.info.time?.created ?? 0) || Date.now()
    msg.parts.forEach((part, i) => {
      const id = part.id ?? `${msg.info.id}-${i}`
      if (part.type === 'tool') {
        // Tool evidence: which tool ran and whether the executor actually
        // succeeded. A model claiming success over an errored tool must be
        // visible in the transcript — `state.status` is the executor's verdict.
        const status = toolPartStatus(part)
        const error = toolStateError(part)
        out.push({
          id,
          role: 'tool',
          text: `${part.tool ?? 'tool'} (${status})${error ? ` — ${error.slice(0, 300)}` : ''}`,
          tool: { name: part.tool ?? 'tool', status, input: part.state?.input },
          at,
        })
      } else if (part.type === 'text' && part.text) {
        out.push({ id, role, text: part.text.slice(0, TEXT_LIMIT), at })
      }
    })
  }
  return out
}

/**
 * Runs the worker side of the pipeline: ensures an `opencode serve` process
 * exists for the worker's workspace, opens one native session per worker,
 * streams its transcript, converts OpenCode permission prompts into dashboard
 * approvals, and enforces timeouts.
 */
export class WorkerManager {
  private poolInstance: OpenCodeServerPool | null = null
  private readonly active = new Map<string, ActiveRun>()
  private readonly bySession = new Map<string, string>()
  private readonly transcripts = new Map<string, TranscriptEntry[]>()
  /** Guards against two `session.idle` events racing the same completion. */
  private readonly completing = new Set<string>()
  private disposed = false
  /** Test hook: forwarded to the pool (fake server spawn options). */
  startOptions: { binaryPath?: string; commandArgs?: (args: string[]) => string[]; minimalEnv?: boolean } | null = null
  /** Test hook: turn off the background expiry poll so a test can drive `sweepExpiredApprovals()` itself. */
  autoSweep = true
  /** Rejects permission approvals nobody answered in time (cleared in `shutdown`). */
  private sweeper: NodeJS.Timeout | null = null

  constructor(private readonly ctx: AppContext) {
    this.sweeper = setInterval(() => {
      if (this.disposed || !this.autoSweep) return
      void this.sweepExpiredApprovals()
    }, 15_000)
    // Never keep the process alive just to poll for deadlines.
    this.sweeper.unref?.()
  }

  /* ------------------------------------------------------------- pool wiring */

  private pool(): OpenCodeServerPool {
    if (!this.poolInstance) {
      this.poolInstance = new OpenCodeServerPool({
        configDir: this.ctx.paths.cache,
        getConfig: () => this.ctx.config.get(),
        getProviders: () => this.ctx.repos.providers.listProviders(),
        getProfiles: () => this.ctx.repos.providers.listProfiles(),
        getKey: (ref) => this.ctx.keystore.get(ref),
        startOptions: this.startOptions ?? undefined,
        onEvent: (serverId, event) => this.handleEvent(serverId, event),
        log: (msg, data) => this.ctx.log('opencode').info(msg, data),
      })
    }
    return this.poolInstance
  }

  /* ------------------------------------------------------------ IPC: servers */

  /**
   * `opencode.autoStart = false`: reuse a server already serving this workspace
   * instead of spawning one. Fails with an actionable message when none is up.
   */
  private async reuseRunning(directory: string): Promise<ServerState> {
    const existing = this.poolInstance
      ?.list()
      .find((s) => s.directory === directory && (s.status === 'ready' || s.status === 'starting'))
    if (!existing) {
      throw new AppError(
        'unavailable',
        'OpenCode auto-start is off — start a server for this workspace on the OpenCode page, or enable "Auto-start servers" in Settings → OpenCode',
      )
    }
    if (existing.status === 'starting') await this.pool().waitReady(existing.id)
    return this.pool().get(existing.id) ?? existing
  }

  /** `opencode.allowedAgents`: blocks worker sessions from using other agents. */
  private allowedAgent(requested: string | null | undefined): string | undefined {
    const allowed = this.ctx.config.get().opencode.allowedAgents
    if (!allowed || allowed.length === 0) return requested ?? undefined
    if (requested && allowed.includes(requested)) return requested
    if (!requested) return undefined
    return allowed.includes('general') ? 'general' : allowed[0]
  }

  async detect(): Promise<OpencodeDetection> {
    const found = await detectOpencode(this.ctx.config.get().opencode.binaryPath)
    return { detected: Boolean(found.path), path: found.path, version: found.version, source: found.source }
  }

  listServers(): OpencodeServerState[] {
    if (!this.poolInstance) return []
    return this.poolInstance.list().map(toServerState)
  }

  async startServer(opts: { directory?: string } = {}): Promise<OpencodeServerState> {
    const state = await this.pool().start({
      directory: opts.directory,
      label: opts.directory ? undefined : 'core',
    })
    this.ctx.emit(EVENTS.OPENCODE_SERVER_STARTED, { message: `opencode server started: ${state.label}`, data: { serverId: state.id } })
    return toServerState(state)
  }

  async stopServer(id: string): Promise<boolean> {
    const removed = await this.pool().stop(id)
    if (removed) this.ctx.emit(EVENTS.OPENCODE_SERVER_STOPPED, { message: 'opencode server stopped', severity: 'warn', data: { serverId: id } })
    return removed
  }

  async agents(): Promise<{ name: string; mode: string; description: string | null }[]> {
    const ready = this.poolInstance?.list().find((s) => s.status === 'ready')
    if (!ready) return []
    try {
      const list = await this.pool().adapterFor(ready.id).agents()
      return list.map((a) => ({ name: a.name, mode: a.mode, description: a.description ?? null }))
    } catch (err) {
      this.ctx.log('opencode').warn('agent listing failed', { error: String(err) })
      return []
    }
  }

  async sessions(serverId?: string): Promise<{ id: string; title: string; directory: string; status: string }[]> {
    const servers = this.poolInstance?.list().filter((s) => s.status === 'ready' && (!serverId || s.id === serverId)) ?? []
    const out: { id: string; title: string; directory: string; status: string }[] = []
    for (const s of servers) {
      try {
        for (const sess of await this.pool().adapterFor(s.id).listSessions()) {
          const workerId = this.bySession.get(sess.id)
          const worker = workerId ? this.ctx.repos.workers.getWorker(workerId) : null
          out.push({ id: sess.id, title: sess.title, directory: sess.directory ?? s.directory, status: worker?.status ?? 'idle' })
        }
      } catch (err) {
        this.ctx.log('opencode').warn('session listing failed', { serverId: s.id, error: String(err) })
      }
    }
    return out
  }

  async killSession(serverId: string, sessionId: string): Promise<boolean> {
    const workerId = this.bySession.get(sessionId)
    const before = workerId ? this.ctx.repos.workers.getWorker(workerId) : null
    let abortOk = false
    try {
      await this.pool().adapterFor(serverId).abortSession(sessionId)
      abortOk = true
    } catch (err) {
      this.ctx.log('opencode').warn('session abort failed', { sessionId, error: String(err) })
    }
    let settled = false
    if (workerId && before && !isTerminal(before.status)) {
      this.settle(workerId, 'aborted', 'session killed', { severity: 'warn' })
      settled = true
    }
    // Honest result: the abort call failed AND no worker changed state.
    return abortOk || settled
  }

  /** Persisted/native transcript for a native session (IPC `opencode.transcript`). */
  async nativeTranscript(serverId: string, sessionId: string): Promise<TranscriptEntry[]> {
    const cached = this.transcripts.get(sessionId)
    if (cached?.length) return cached
    try {
      const messages = await this.pool().adapterFor(serverId).messages(sessionId)
      return messagesToTranscript(messages)
    } catch (err) {
      this.ctx.log('opencode').warn('transcript fetch failed', { sessionId, error: String(err) })
      return []
    }
  }

  /* ------------------------------------------------------------- IPC: workers */

  private resolveParentSessionId(worker: Worker): string | null {
    if (worker.parentSessionId) return worker.parentSessionId
    if (!worker.parentWorkerId) return null
    return this.ctx.repos.workers.getWorker(worker.parentWorkerId)?.sessionId ?? null
  }

  /**
   * The exact files the collector will stat when this worker finishes. Workers
   * have reported `summary.md` as created — "verified via `type`" — while only
   * ever calling `write` for the other file, so the list goes in the prompt and
   * the model has something concrete to check off instead of trusting itself.
   */
  private expectedArtifactChecklist(worker: Worker): string[] {
    const declared = this.ctx.repos.jobs.getTask(worker.taskId)?.expectedArtifacts ?? []
    return declared
      .filter((name) => name && name.length < 300 && !name.includes('\n'))
      .map((name) => `- ${name}`)
  }

  /**
   * Files other tasks of this loop own. Saying "only touch your files" was not
   * enough: a worker writing `summary.md` also overwrote `harness-smoke-test.txt`
   * with the words "smoke test marker", destroying a sibling's correct deliverable
   * after that sibling had already settled `succeeded`. Naming the files makes the
   * boundary concrete.
   */
  private siblingArtifactNote(worker: Worker): string[] {
    const own = new Set(this.ctx.repos.jobs.getTask(worker.taskId)?.expectedArtifacts ?? [])
    const others = new Set<string>()
    for (const task of this.ctx.repos.jobs.listTasks(worker.jobId, worker.loopIndex)) {
      if (task.id === worker.taskId) continue
      for (const name of task.expectedArtifacts ?? []) {
        if (name && !own.has(name) && name.length < 300 && !name.includes('\n')) others.add(name)
      }
    }
    if (!others.size) return []
    return [
      'These files belong to other tasks in this job — do not create, modify or truncate them:',
      ...[...others].map((name) => `- ${name}`),
      '',
    ]
  }

  /**
   * What the previous attempt of this task got wrong, in a form the model can
   * act on. Without it every retry is the same prompt, so a worker that failed
   * by describing a file instead of writing it repeats the identical mistake —
   * observed end-to-end: attempt 2 reported `summary.md` as created again and
   * failed with the same "missing expected artifacts".
   */
  private priorFailureNote(worker: Worker): string[] {
    if (worker.attempt < 1) return []
    const earlier = this.ctx.repos.workers
      .listWorkers(worker.jobId)
      .filter((w) => w.taskId === worker.taskId && w.id !== worker.id && (w.status === 'failed' || w.status === 'succeeded' || w.status === 'aborted'))
      .sort((a, b) => b.attempt - a.attempt)[0]
    if (!earlier || earlier.status !== 'failed') return []
    const reason = (earlier.error || earlier.statusReason || 'it did not produce the expected artifacts').trim()
    return [
      `A previous attempt at this exact task failed: ${reason}.`,
      'The files it reported were not found on disk. Verify each expected file exists with a real tool call (write it if it is missing), and only then report success.',
      '',
    ]
  }

  /** Opens a session and fires the worker's prompt. Idempotent per active worker. */
  async dispatch(worker: Worker): Promise<Worker> {
    if (this.disposed) throw new AppError('aborted', 'shutting down')
    const existing = this.active.get(worker.id)
    if (existing) return this.ctx.repos.workers.getWorker(worker.id) ?? worker

    const cfg = this.ctx.config.get()
    const directory = worker.workspacePath || join(this.ctx.paths.jobs, worker.jobId)
    await mkdir(directory, { recursive: true })

    const server = cfg.opencode.autoStart
      ? await this.pool().ensureFor(directory)
      : await this.reuseRunning(directory)
    const adapter = this.pool().adapterFor(server.id)

    const parentSessionId = this.resolveParentSessionId(worker)
    const session = await adapter.createSession({
      title: worker.name,
      agent: this.allowedAgent(worker.opencodeAgent),
      parentID: parentSessionId || undefined,
    })

    const model = this.resolveModel(worker)
    const started = Date.now()
    const updated = this.ctx.repos.workers.updateWorker(worker.id, {
      sessionId: session.id,
      status: 'running',
      statusReason: null,
      error: null,
      attempt: worker.attempt + 1,
      startedAt: worker.startedAt ?? started,
      completedAt: null,
      queuedAt: worker.queuedAt ?? started,
    })
    this.ctx.repos.workers.upsertSession({
      sessionId: session.id,
      workerId: worker.id,
      serverId: server.id,
      parentSessionId,
      jobId: worker.jobId,
      projectId: worker.projectId,
      title: session.title || worker.name,
      directory,
      modelId: worker.modelId,
      providerId: worker.providerId,
      opencodeAgent: worker.opencodeAgent,
      depth: worker.depth,
      status: 'active',
      summary: '',
      diffStats: { additions: 0, deletions: 0, files: 0 },
      lastEventAt: Date.now(),
    })

    const run: ActiveRun = { workerId: worker.id, sessionId: session.id, serverId: server.id, jobId: worker.jobId, timer: null }
    this.active.set(worker.id, run)
    this.bySession.set(session.id, worker.id)
    this.ctx.emit(EVENTS.WORKER_SPAWNED, {
      jobId: worker.jobId,
      workerId: worker.id,
      message: `worker spawned: ${worker.name}`,
      data: { sessionId: session.id, serverId: server.id },
    })

    run.timer = setTimeout(() => {
      void this.onTimeout(worker.id, updated.timeoutMs || cfg.orchestration.taskTimeoutMs)
    }, updated.timeoutMs || cfg.orchestration.taskTimeoutMs)

    const body = (updated.taskPrompt || updated.objective || updated.name).trim()
    // Always name the workspace explicitly. OpenCode reports `Workspace root
    // folder: /` for non-repo directories, and a model reasoning from that (or
    // from a POSIX shell's `pwd`) happily writes `/c/Users/...` — which Windows
    // resolves to `C:\c\Users\...`, so the file lands outside the workspace and
    // the task later fails as "missing expected artifacts".
    //
    // The second paragraph is not decoration: workers have settled `succeeded`
    // after writing a confident sentence with `finish=stop` and zero tool calls.
    // Say out loud that the file must be created by a tool, not described.
    const expected = this.expectedArtifactChecklist(updated)
    const text = [
      `Workspace directory (create files here, using this exact Windows path): ${directory}`,
      '',
      'Do the work with your tools (write/bash) and then report what actually happened on disk. ',
      'Describing the result is not doing it: if you never called a tool, you created nothing.',
      // Observed end-to-end: a worker globbed twice and saw summary.md was absent,
      // then trusted model-fusion "panel" prose claiming it existed, replied DONE
      // with zero write calls, and the file never appeared. Only a write/bash call
      // in THIS session creates a file; a read, glob or ls proves nothing about
      // what you made.
      'Listing or reading a file does not create it: only a write/bash call in this session can create a file. ',
      'Before you finish, every file in the list below must have been created by your own write/bash call — if you did not just create it, it does not exist.',
      'Other workers may be writing to this same directory right now. Only create or modify the files this task asks for. ',
      'Never truncate, empty or overwrite a file you were not asked to write, and never write an empty file when content was specified.',
      ...(expected.length ? ['', 'The task is verified against these files — every one of them must exist when you finish:', ...expected] : []),
      ...(expected.length ? ['', ...this.siblingArtifactNote(updated)] : []),
      '',
      ...(this.priorFailureNote(updated) ?? []),
      body,
    ].join('\n')
    try {
      await adapter.prompt(session.id, {
        text,
        agent: updated.opencodeAgent ?? undefined,
        system: updated.systemPrompt || null,
        model,
        async: true,
      })
    } catch (err) {
      this.fail(worker.id, String(err))
      throw err
    }

    this.ctx.emit(EVENTS.WORKER_STARTED, {
      jobId: worker.jobId,
      workerId: worker.id,
      message: `worker started: ${worker.name}`,
    })
    this.ctx.log('opencode').info('worker dispatched', { workerId: worker.id, sessionId: session.id, serverId: server.id })
    return this.ctx.repos.workers.getWorker(worker.id) ?? updated
  }

  /** Abort the native session and settle the worker locally. */
  async abort(workerId: string, reason = 'aborted by user'): Promise<boolean> {
    const worker = this.ctx.repos.workers.getWorker(workerId)
    if (!worker) return false
    const run = this.active.get(workerId)
    let abortOk = false
    if (run && worker.sessionId) {
      try {
        await this.pool().adapterFor(run.serverId).abortSession(worker.sessionId)
        abortOk = true
      } catch (err) {
        this.ctx.log('opencode').warn('abort failed', { workerId, error: String(err) })
      }
    }
    let settled = false
    if (!isTerminal(worker.status)) {
      this.settle(workerId, 'aborted', reason, { severity: 'warn' })
      const after = this.ctx.repos.workers.getWorker(workerId)
      settled = !!after && isTerminal(after.status)
    }
    return abortOk || settled
  }

  /** Abort every live worker of a job (job cancel path). */
  async abortJob(jobId: string, reason = 'job cancelled'): Promise<void> {
    for (const worker of this.ctx.repos.workers.listWorkers(jobId)) {
      if (this.active.has(worker.id)) await this.abort(worker.id, reason)
    }
  }

  /**
   * Re-dispatch a settled worker: fresh session, status back to running.
   * The caller (IPC handler) has already reset the row to `queued`.
   */
  async retry(workerId: string): Promise<Worker> {
    const worker = this.ctx.repos.workers.getWorker(workerId)
    if (!worker) throw new AppError('not_found', `worker not found: ${workerId}`)
    return this.dispatch(worker)
  }

  /** Respond to an OpenCode permission prompt surfaced as a dashboard approval. Returns whether the reply landed. */
  async decidePermission(approvalId: string, approve: boolean, note?: string): Promise<boolean> {
    const approval = this.ctx.repos.workers.getApproval(approvalId)
    if (!approval || !approval.opencodePermissionId) return false
    const session = approval.sessionId ? this.ctx.repos.workers.getSession(approval.sessionId) : null
    const workerId = approval.workerId ?? (session ? this.bySession.get(approval.sessionId ?? '') ?? null : null)
    const run = workerId ? this.active.get(workerId) : null
    let replied = false
    if (run) {
      try {
        replied = (await this.pool().adapterFor(run.serverId).replyPermission(approval.opencodePermissionId, approve ? 'once' : 'reject', note)) === true
      } catch (err) {
        this.ctx.log('opencode').warn('permission reply failed', { approvalId, error: String(err) })
      }
    }
    if (workerId && this.active.has(workerId)) {
      if (replied) {
        this.ctx.repos.workers.updateWorker(workerId, { status: 'running', statusReason: null })
      } else {
        // The OpenCode-side reply never landed: keep the worker waiting instead
        // of pretending it resumed, and say why.
        this.ctx.repos.workers.updateWorker(workerId, {
          statusReason: 'permission reply not delivered — still waiting for approval',
        })
      }
    }
    return replied
  }

  /**
   * Reject permission approvals that were never answered before their deadline,
   * so an unattended gate cannot park a worker (and the concurrency budget it
   * holds) for the whole `taskTimeoutMs`. Returns the approvals it expired.
   */
  async sweepExpiredApprovals(at = Date.now()): Promise<Approval[]> {
    const expired: Approval[] = []
    for (const approval of this.ctx.repos.workers.listExpiredApprovals(at)) {
      const note = 'approval timed out — rejected'
      const next = this.ctx.repos.workers.expireApproval(approval.id, note)
      // A decision landed between the SELECT and the UPDATE: respect it.
      if (!next) continue
      const workerId = approval.workerId
      const workerBefore = workerId ? this.ctx.repos.workers.getWorker(workerId) : null
      const wasWaiting = workerBefore?.status === 'waiting_approval'
      expired.push(next)
      let replied = false
      try {
        replied = await this.decidePermission(approval.id, false, note)
      } catch (err) {
        this.ctx.log('opencode').warn('permission reject on expiry failed', { approvalId: approval.id, error: String(err) })
      }
      if (workerId && wasWaiting) {
        // Decide over whatever `decidePermission` just wrote so the reason for
        // the resume (or the failure to resume) is visible on the worker row.
        this.ctx.repos.workers.updateWorker(workerId, {
          // Reply landed: the model resumes and handles the denial. It did not:
          // say so instead of silently claiming the worker is running.
          status: replied ? 'running' : 'waiting_approval',
          statusReason: replied ? note : `${note} — the reject could not be delivered to OpenCode`,
        })
      }
      this.ctx.emit(EVENTS.APPROVAL_RESOLVED, {
        jobId: approval.jobId,
        workerId,
        message: `${approval.kind} expired unanswered`,
        severity: 'warn',
        data: { approvalId: approval.id, note },
      })
      this.ctx.log('opencode').warn('approval expired unanswered', { approvalId: approval.id, kind: approval.kind, sessionId: approval.sessionId })
    }
    return expired
  }

  /* -------------------------------------------------------------- transcripts */

  /** In-memory transcript, falling back to disk and finally the live session. */
  async transcriptFor(workerId: string): Promise<TranscriptEntry[]> {
    const worker = this.ctx.repos.workers.getWorker(workerId)
    if (!worker || !worker.sessionId) return []
    const cached = this.transcripts.get(worker.sessionId)
    if (cached?.length) return cached

    const file = this.transcriptPath(worker)
    try {
      const raw = await readFile(file, 'utf8')
      const entries = raw
        .split('\n')
        .filter(Boolean)
        .map((line) => JSON.parse(line) as TranscriptEntry)
      if (entries.length) {
        this.transcripts.set(worker.sessionId, entries)
        return entries
      }
    } catch {
      /* no file yet */
    }

    const run = this.active.get(workerId)
    if (run) {
      try {
        const messages = await this.pool().adapterFor(run.serverId).messages(worker.sessionId)
        return messagesToTranscript(messages)
      } catch {
        /* fall through */
      }
    }
    return []
  }

  private transcriptPath(worker: Worker): string {
    return join(this.ctx.paths.jobs, worker.jobId, 'transcripts', `${worker.sessionId ?? 'none'}.jsonl`)
  }

  private async persistTranscript(worker: Worker, entries: TranscriptEntry[]): Promise<void> {
    if (!this.ctx.config.get().orchestration.persistTranscripts || entries.length === 0) return
    try {
      const file = this.transcriptPath(worker)
      await mkdir(join(file, '..'), { recursive: true })
      await writeFile(file, entries.map((e) => JSON.stringify(e)).join('\n'), 'utf8')
    } catch (err) {
      this.ctx.log('opencode').warn('transcript persist failed', { workerId: worker.id, error: String(err) })
    }
  }

  private appendTranscript(sessionId: string, entries: TranscriptEntry[]): TranscriptEntry[] {
    const list = this.transcripts.get(sessionId) ?? []
    for (const entry of entries) {
      const existing = list.findIndex((e) => e.id === entry.id)
      // Same id = the same part upserted again (streaming text growth, a tool
      // moving pending → completed). Keep order, replace the snapshot.
      if (existing >= 0) list[existing] = entry
      else list.push(entry)
    }
    while (list.length > TRANSCRIPT_LIMIT) list.shift()
    this.transcripts.set(sessionId, list)
    return list
  }

  /* ------------------------------------------------------------------ events */

  /** Feed an SSE event straight into the lifecycle state machine. */
  handleEvent(serverId: string, event: NormalizedEvent): void {
    try {
      if (event.type === 'permission.asked') return this.onPermissionAsked(serverId, event)
      if (event.type === 'session.idle') return this.onIdle(event)
      if (event.type === 'message.part.updated') return this.onPartUpdated(event)
      if (event.type === 'server.disconnected' || event.type === 'server.connected') {
        if (event.type === 'server.disconnected') this.ctx.emit(EVENTS.OPENCODE_SESSION_LOST, { message: 'opencode event stream dropped', severity: 'warn', data: { serverId } })
        return
      }
      const sessionId = event.sessionId
      if (sessionId) {
        const workerId = this.bySession.get(sessionId)
        if (workerId) this.ctx.repos.workers.upsertSessionLastEvent(sessionId)
      }
    } catch (err) {
      this.ctx.log('opencode').warn('event handling failed', { type: event.type, error: String(err) })
    }
  }

  private onPermissionAsked(serverId: string, event: NormalizedEvent): void {
    const raw = event.data.permission
    const permission = (
      raw && typeof raw === 'object' ? raw : { ...event.data, type: typeof raw === 'string' ? raw : event.data.type }
    ) as OcPermission
    const sessionId = permission.sessionID ?? event.sessionId
    if (!sessionId) return
    // Subagent sessions are not registered in `bySession`; resolve through the
    // session row and its parents so their gates still belong to a worker/job
    // (otherwise the approval lands orphaned and can never be answered).
    const workerId = this.bySession.get(sessionId) ?? this.resolveWorkerForSession(sessionId)
    if (workerId) this.bySession.set(sessionId, workerId)
    const worker = workerId ? this.ctx.repos.workers.getWorker(workerId) : null
    const sessionRow = this.ctx.repos.workers.getSession(sessionId)

    const command = permissionCommand(permission, event.data)
    const gate =
      command && this.ctx.config.get().permissions.interceptChainedGit
        ? interceptChainedGit(command)
        : { kind: null, verbs: [] as string[] }
    const kind = gate.kind ?? permissionKind(permission)

    // An unanswered gate parks the worker until it expires or `taskTimeoutMs`
    // fires — without a deadline it holds the concurrency budget hostage.
    const approvalTimeoutMs = this.ctx.config.get().orchestration.approvalTimeoutMs
    const approval = this.ctx.repos.workers.createApproval({
      kind,
      title:
        permission.title ??
        (gate.kind ? `${gate.kind.replace('_', ' ')} needs approval` : `opencode permission: ${permission.type}`),
      detail: command || (permission.pattern ?? permission.type),
      jobId: worker?.jobId ?? sessionRow?.jobId ?? null,
      sessionId,
      workerId,
      opencodePermissionId: permission.id,
      expiresAt: approvalTimeoutMs > 0 ? Date.now() + approvalTimeoutMs : null,
      payload: { permission, serverId, command, gitVerbs: gate.verbs } as unknown as Record<string, unknown>,
    })
    if (workerId) {
      this.ctx.repos.workers.updateWorker(workerId, { status: 'waiting_approval', statusReason: approval.title })
    }
    this.ctx.emit(EVENTS.APPROVAL_REQUESTED, {
      jobId: approval.jobId,
      workerId,
      message: `approval needed: ${approval.title}`,
      severity: 'warn',
      data: { approvalId: approval.id, kind: approval.kind },
    })
    this.ctx.log('opencode').info('permission requested', { approvalId: approval.id, sessionId, workerId, kind: approval.kind })
  }

  /**
   * Walks a session row and its parents until it finds a session that belongs
   * to a worker. Subagent sessions are stored with `workerId = null`, so their
   * approval would otherwise have no owner at all.
   */
  private resolveWorkerForSession(sessionId: string): string | null {
    let current = this.ctx.repos.workers.getSession(sessionId)
    for (let hops = 0; current && hops < 5; hops++) {
      if (current.workerId) return current.workerId
      if (!current.parentSessionId || current.parentSessionId === current.sessionId) return null
      current = this.ctx.repos.workers.getSession(current.parentSessionId)
    }
    return null
  }

  private onIdle(event: NormalizedEvent): void {
    const sessionId = event.sessionId
    if (!sessionId) return
    const workerId = this.bySession.get(sessionId)
    if (!workerId) return
    void this.complete(workerId)
  }

  private onPartUpdated(event: NormalizedEvent): void {
    const sessionId = event.sessionId
    if (!sessionId) return
    const workerId = this.bySession.get(sessionId)
    if (!workerId) return
    const part = (event.data.part ?? event.data) as {
      id?: string
      type?: string
      text?: string
      tool?: string
      status?: string
      state?: { status?: string; error?: string | { name?: string; data?: unknown } }
    }
    if (!part || !part.type) return

    // Tool parts stream in as pending → completed/error upserts on the same id.
    // Recording them live means the transcript shows the executor's verdict, not
    // just the model's prose about what it claims to have done.
    if (part.type === 'tool') {
      const status = part.state?.status ?? part.status ?? 'unknown'
      const error = toolStateError(part as Parameters<typeof toolStateError>[0])
      const id = part.id ?? `${sessionId}-tool-${Date.now()}`
      this.appendTranscript(sessionId, [
        {
          id,
          role: 'tool',
          text: `${part.tool ?? 'tool'} (${status})${error ? ` — ${String(error).slice(0, 300)}` : ''}`,
          tool: { name: part.tool ?? 'tool', status, input: (part.state as { input?: unknown } | undefined)?.input },
          at: Date.now(),
        },
      ])
      return
    }

    if (part.type !== 'text' || !part.text) return
    const id = part.id ?? `${sessionId}-${Date.now()}`
    const entries = this.appendTranscript(sessionId, [{ id, role: 'assistant', text: part.text.slice(0, TEXT_LIMIT), at: Date.now() }])
    const last = entries.find((e) => e.id === id) ?? entries[entries.length - 1]
    this.ctx.emit(EVENTS.WORKER_OUTPUT, {
      jobId: this.active.get(workerId)?.jobId ?? null,
      workerId,
      message: last?.text.slice(0, 160) ?? '',
      data: { sessionId, at: last?.at ?? Date.now() },
    })
  }

  /* -------------------------------------------------------------- completion */

  /**
   * Fetches the transcript with bounded retries: `session.idle` can arrive
   * before the assistant message is queryable, and a transient fetch error must
   * not settle the worker as `succeeded` with no evidence.
   */
  private async fetchEvidence(
    serverId: string,
    sessionId: string,
  ): Promise<{ messages: TranscriptMessage[]; failure: string | null }> {
    let messages: TranscriptMessage[] = []
    let lastError: unknown = null
    for (let attempt = 1; attempt <= TRANSCRIPT_RETRIES; attempt++) {
      if (attempt > 1) await new Promise((r) => setTimeout(r, TRANSCRIPT_RETRY_MS))
      try {
        messages = await this.pool().adapterFor(serverId).messages(sessionId)
        lastError = null
        const hasAssistant = messages.some((m) => m.info.role === 'assistant')
        if (hasAssistant) return { messages, failure: null }
      } catch (err) {
        lastError = err
      }
    }
    if (lastError) return { messages, failure: `transcript unavailable: ${errorMessage(lastError)}` }
    return { messages, failure: 'worker produced no assistant output' }
  }

  /** Reads the task's `expectedArtifacts`, pulls the session diff, verifies files on disk. */
  private async collectArtifacts(
    worker: Worker,
    serverId: string,
    sessionId: string,
    assistantText: string,
  ): Promise<CollectResult> {
    const task = this.ctx.repos.jobs.getTask(worker.taskId)
    let diff: DiffEntry[] = []
    try {
      diff = await this.pool().adapterFor(serverId).diff(sessionId)
    } catch (err) {
      this.ctx.log('opencode').warn('session diff fetch failed', { workerId: worker.id, error: String(err) })
    }
    return collectWorkerArtifacts(
      {
        createArtifact: (input) => this.ctx.repos.workers.createArtifact(input),
        emit: (type, payload) => this.ctx.emit(type, payload),
        warn: (message, data) => this.ctx.log('opencode').warn(message, data),
      },
      {
        jobId: worker.jobId,
        loopIndex: worker.loopIndex,
        taskId: worker.taskId,
        workerId: worker.id,
        sessionId,
        workspaceRoot: worker.workspacePath || join(this.ctx.paths.jobs, worker.jobId),
        expectedArtifacts: task?.expectedArtifacts ?? [],
        diff,
        assistantText,
      },
    )
  }

  /** Best-effort: record child (subagent) sessions so the UI can see them. */
  private async recordChildSessions(worker: Worker, run: ActiveRun): Promise<void> {
    if (!worker.sessionId) return
    try {
      const children = await this.pool().adapterFor(run.serverId).children(worker.sessionId)
      for (const child of children) {
        if (!child?.id || child.id === worker.sessionId) continue
        const existing = this.ctx.repos.workers.getSession(child.id)
        this.ctx.repos.workers.upsertSession({
          sessionId: child.id,
          // Attribute the subagent to its worker so its permission prompts and
          // events have an owner (parent sessions carry `workerId`).
          workerId: existing?.workerId ?? worker.id,
          serverId: run.serverId,
          parentSessionId: worker.sessionId,
          jobId: worker.jobId,
          projectId: worker.projectId,
          title: child.title || `subagent of ${worker.name}`,
          directory: child.directory || worker.workspacePath || join(this.ctx.paths.jobs, worker.jobId),
          modelId: existing?.modelId ?? worker.modelId,
          providerId: existing?.providerId ?? worker.providerId,
          opencodeAgent: existing?.opencodeAgent ?? worker.opencodeAgent,
          depth: existing?.depth ?? worker.depth + 1,
          status: existing?.status ?? 'idle',
          summary: existing?.summary ?? '',
          diffStats: existing?.diffStats ?? { additions: 0, deletions: 0, files: 0 },
          lastEventAt: Date.now(),
        })
        this.ctx.emit(EVENTS.SUBAGENT_SPAWNED, {
          jobId: worker.jobId,
          workerId: worker.id,
          message: `subagent spawned: ${child.title || child.id}`,
          data: { parentSessionId: worker.sessionId, childSessionId: child.id, serverId: run.serverId },
        })
      }
    } catch (err) {
      // children() is visibility-only: never let it fail a finished worker.
      this.ctx.log('opencode').warn('child session listing failed', { workerId: worker.id, error: String(err) })
    }
  }

  private async complete(workerId: string): Promise<void> {
    const run = this.active.get(workerId)
    const worker = this.ctx.repos.workers.getWorker(workerId)
    if (!run || !worker || !worker.sessionId) return
    if (this.completing.has(workerId)) return
    this.completing.add(workerId)
    try {
      await this.settleCompletion(run, worker)
    } finally {
      this.completing.delete(workerId)
    }
  }

  private async settleCompletion(run: ActiveRun, worker: Worker): Promise<void> {
    const workerId = worker.id
    const sessionId = worker.sessionId!

    const { messages, failure } = await this.fetchEvidence(run.serverId, sessionId)

    // The transcript fetch awaits: abort()/onTimeout()/fail() may have settled
    // the worker meanwhile — never resurrect a terminal row as `succeeded`.
    const current = this.ctx.repos.workers.getWorker(workerId)
    if (!current || isTerminal(current.status)) return

    const entries = messages.length ? messagesToTranscript(messages) : this.transcripts.get(sessionId) ?? []
    if (messages.length) this.transcripts.set(sessionId, entries)

    const assistant = [...messages].reverse().find((m) => m.info.role === 'assistant')
    const summary = [...entries].reverse().find((e) => e.role === 'assistant')?.text.slice(0, 400) ?? ''
    const assistantText = (assistant?.parts ?? [])
      .filter((p) => p.type === 'text' && p.text)
      .map((p) => p.text)
      .join('\n')
      .trim()

    // Evidence required: without a fetchable assistant message (or when the
    // fetch kept failing) the worker FAILED — never a fake `succeeded`.
    if (failure) {
      this.fail(workerId, failure, { summary })
      return
    }
    if (!assistant) {
      this.fail(workerId, 'worker produced no assistant output', { summary })
      return
    }

    this.recordUsage(worker, assistant.info)
    const error = assistant.info.error
    if (error) {
      this.fail(workerId, typeof error.data === 'string' ? error.data : (error.name ?? 'opencode error'), { summary })
      return
    }

    // Real artifacts + deliverable verification (never throws past here).
    let collected: CollectResult
    try {
      collected = await this.collectArtifacts(worker, run.serverId, sessionId, assistantText)
    } catch (err) {
      this.fail(workerId, `artifact verification failed: ${errorMessage(err)}`, { summary })
      return
    }
    persistCollection(
      {
        getWorker: (id) => this.ctx.repos.workers.getWorker(id),
        updateWorker: (id, patch) => this.ctx.repos.workers.updateWorker(id, patch),
        getSession: (id) => this.ctx.repos.workers.getSession(id),
        upsertSession: (input) => this.ctx.repos.workers.upsertSession(input),
      },
      { workerId, sessionId, result: collected },
    )

    // Re-check after the awaits above (abort/timeout may have settled the row).
    const afterCollect = this.ctx.repos.workers.getWorker(workerId)
    if (!afterCollect || isTerminal(afterCollect.status)) return

    // Why the file is missing changes what the retry must be told. A worker
    // that ran no write-class tool at all never even attempted the deliverable:
    // observed end-to-end, attempt 2 globbed `No files found`, then reported the
    // file as created and answered DONE. The generic "missing expected
    // artifacts" reads like a verification quirk; naming the absent tool call
    // is what the next attempt can actually act on.
    const missing = collected.missingExpected
    const attemptedWrite = entries.some((e) => e.role === 'tool' && WRITE_TOOLS.has((e.tool?.name ?? '').toLowerCase()))
    const neverTried = missing.length > 0 && !attemptedWrite
    const untargeted = neverTried ? [] : neverTargeted(entries, missing)
    const why = neverTried
      ? noWriteReason(missing)
      : untargeted.length
        ? `never called a write tool for ${untargeted.join(', ')} — ${missing.join(', ')} does not exist`
        : null

    if (!collected.verdict.ok) {
      this.fail(workerId, why ?? collected.verdict.reason ?? 'worker produced no deliverables', { summary })
      return
    }

    // A partial delivery is not done: the collector keeps `verdict.ok` for it
    // (pinned contract), but the worker must not settle `succeeded` when a file
    // it promised is absent — otherwise no retry ever runs, the model is never
    // told which file is missing, and the job only dies later at final review.
    // Observed end-to-end: `summary.md` was reported "verified" while only
    // `harness-smoke-test.txt` was ever written. On the last allowed attempt we
    // stop failing here and let the reviewer adjudicate.
    const task = this.ctx.repos.jobs.getTask(worker.taskId)
    const attemptsLeft = task ? worker.attempt < task.retryPolicy.maxAttempts : false
    if (collected.missingExpected.length > 0 && attemptsLeft) {
      this.fail(workerId, why ?? `missing expected artifacts: ${collected.missingExpected.join(', ')}`, { summary })
      return
    }

    this.clearRun(workerId)
    this.ctx.repos.workers.updateWorker(workerId, {
      status: 'succeeded',
      statusReason: collected.verdict.note,
      error: null,
      completedAt: Date.now(),
    })
    this.ctx.repos.workers.updateSessionStatus(sessionId, 'completed', summary)
    await this.persistTranscript(worker, entries)
    this.ctx.emit(EVENTS.WORKER_COMPLETED, {
      jobId: worker.jobId,
      workerId,
      message: `worker completed: ${worker.name}`,
      data: {
        summary: summary.slice(0, 160),
        filesTouched: collected.filesTouched,
        artifacts: collected.artifactIds.length,
        ...(collected.verdict.note ? { note: collected.verdict.note } : {}),
      },
    })
    this.ctx.log('opencode').info('worker completed', {
      workerId,
      filesTouched: collected.filesTouched.length,
      artifacts: collected.artifactIds.length,
    })

    await this.recordChildSessions(worker, run)
  }

  private recordUsage(worker: Worker, info: MessageInfo): void {
    const tokens = info.tokens ?? {}
    if (!tokens.input && !tokens.output && !info.cost) return
    this.ctx.repos.workers.recordUsage({
      jobId: worker.jobId,
      loopIndex: worker.loopIndex,
      taskId: worker.taskId,
      workerId: worker.id,
      providerId: info.providerID ?? worker.providerId ?? '',
      modelId: info.modelID ?? worker.modelId ?? 'unknown',
      inputTokens: tokens.input ?? 0,
      outputTokens: tokens.output ?? 0,
      cacheReadTokens: tokens.cache?.read ?? 0,
      costUsd: info.cost ?? 0,
      source: 'opencode',
    })
    const current = this.ctx.repos.workers.getWorker(worker.id)
    if (current) {
      this.ctx.repos.workers.updateWorker(worker.id, {
        usage: {
          ...current.usage,
          inputTokens: current.usage.inputTokens + (tokens.input ?? 0),
          outputTokens: current.usage.outputTokens + (tokens.output ?? 0),
          costUsd: current.usage.costUsd + (info.cost ?? 0),
          requests: current.usage.requests + 1,
        },
      })
    }
  }

  private async onTimeout(workerId: string, timeoutMs: number): Promise<void> {
    const run = this.active.get(workerId)
    if (!run) return
    try {
      await this.pool().adapterFor(run.serverId).abortSession(run.sessionId)
    } catch {
      /* already gone */
    }
    this.settle(workerId, 'timed_out', `timed out after ${Math.round(timeoutMs / 1000)}s`, { severity: 'error' })
  }

  private fail(workerId: string, reason: string, extra: { summary?: string } = {}): void {
    this.settle(workerId, 'failed', reason, { severity: 'error', summary: extra.summary })
  }

  /** Shared terminal transition for failed/timed_out/aborted workers. */
  private settle(
    workerId: string,
    status: 'failed' | 'timed_out' | 'aborted',
    reason: string,
    opts: { severity?: 'warn' | 'error'; summary?: string } = {},
  ): void {
    const worker = this.ctx.repos.workers.getWorker(workerId)
    if (!worker) return
    if (isTerminal(worker.status)) return
    this.clearRun(workerId)
    this.ctx.repos.workers.updateWorker(workerId, {
      status,
      statusReason: reason,
      error: status === 'aborted' ? null : reason,
      completedAt: Date.now(),
    })
    if (worker.sessionId) {
      const sessionStatus: WorkerSessionStatus = status === 'timed_out' ? 'failed' : status
      this.ctx.repos.workers.updateSessionStatus(worker.sessionId, sessionStatus, opts.summary ?? reason)
    }
    const entries = worker.sessionId ? this.transcripts.get(worker.sessionId) : undefined
    if (entries) void this.persistTranscript(worker, entries)
    const eventType = status === 'aborted' ? EVENTS.WORKER_ABORTED : EVENTS.WORKER_FAILED
    this.ctx.emit(eventType, {
      jobId: worker.jobId,
      workerId,
      message: `worker ${status}: ${worker.name} — ${reason}`,
      severity: opts.severity ?? (status === 'aborted' ? 'warn' : 'error'),
      data: { status, reason },
    })
    this.ctx.log('opencode')[status === 'aborted' ? 'warn' : 'error']('worker settled', { workerId, status, reason })
  }

  private clearRun(workerId: string): void {
    const run = this.active.get(workerId)
    if (!run) return
    if (run.timer) clearTimeout(run.timer)
    this.active.delete(workerId)
    this.bySession.delete(run.sessionId)
  }

  private resolveModel(worker: Worker): { providerID: string; modelID: string } | null {
    if (!worker.providerId || !worker.modelId) return null
    const provider = this.ctx.repos.providers.getProvider(worker.providerId)
    if (!provider) return null
    return { providerID: providerSlug(provider.name), modelID: worker.modelId }
  }

  async shutdown(): Promise<void> {
    if (this.disposed) return
    this.disposed = true
    if (this.sweeper) {
      clearInterval(this.sweeper)
      this.sweeper = null
    }
    for (const workerId of [...this.active.keys()]) {
      const run = this.active.get(workerId)
      if (run) this.settle(workerId, 'aborted', 'application shutting down', { severity: 'warn' })
    }
    if (this.poolInstance) await this.poolInstance.stopAll()
  }
}
