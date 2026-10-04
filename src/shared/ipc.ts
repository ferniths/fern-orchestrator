import type {
  AppEvent,
  Approval,
  Artifact,
  AutomationJob,
  GitStatus,
  GitWorktree,
  LoopRecord,
  ModelInfo,
  NoteMeta,
  ProviderConnection,
  Project,
  Review,
  StatsSnapshot,
  Task,
  Vault,
  Worker,
  WorkflowEdge,
  WorkflowNode,
  AgentProfile,
  ModelRoute,
  OutputLanguage,
} from './domain'

/* ============================================================================
 * Result envelope — every IPC reply is serializable and never throws.
 * ==========================================================================*/

/** All renderer→main calls are namespaced so Electron's channel space stays clean. */
export const IPC_PREFIX = 'fern:'

/** Main→renderer channels. */
export const EVENT_CHANNEL = 'fern:event'
export const BUFFERED_EVENTS_CHANNEL = 'fern:buffer'

export type IpcSuccess<T> = { ok: true; data: T }
export type IpcFailure = { ok: false; error: string; code?: string }
export type IpcResult<T> = IpcSuccess<T> | IpcFailure

export const ok = <T>(data: T): IpcSuccess<T> => ({ ok: true, data })
export const fail = (error: string, code?: string): IpcFailure => ({ ok: false, error, ...(code ? { code } : {}) })

/* ============================================================================
 * Common payloads
 * ==========================================================================*/

export interface AppInfo {
  name: string
  version: string
  platform: 'win32' | 'linux' | 'darwin'
  userDataPath: string
  locale: string
  uptimeMs: number
}

export interface ServiceHealth {
  name: string
  healthy: boolean
  message: string
  lastError: string | null
  checkedAt: number
}

export interface OnboardingState {
  opencode: { detected: boolean; version: string | null; path: string | null }
  git: { detected: boolean; version: string | null; path: string | null }
  providers: { configured: number; healthy: number }
  vault: { configured: boolean; path: string | null; noteCount: number }
  projects: { registered: number }
  complete: boolean
}

export interface JobListItem {
  job: AutomationJob
  project: Pick<Project, 'id' | 'name'> | null
  loop: LoopRecord | null
  counts: { workers: number; tasks: number; pendingApprovals: number; artifacts: number }
}

/** Workflow node with persisted canvas coordinates (layout is UI state, not domain). */
export interface FlowNode extends WorkflowNode {
  x: number
  y: number
}

export interface JobDetail {
  job: AutomationJob
  project: Project | null
  loops: LoopRecord[]
  tasks: Task[]
  workers: Worker[]
  nodes: FlowNode[]
  edges: WorkflowEdge[]
  reviews: Review[]
  pendingApprovals: number
  plan: { text: string; data: unknown } | null
}

/** One row from the `sessions` table, shaped for the worker detail payload. */
export interface WorkerSessionSummary {
  sessionId: string
  workerId: string | null
  parentSessionId: string | null
  title: string
  status: string
  depth: number
  summary: string
  /** Session diff recorded by the artifact collector (0/0/0 when never populated). */
  diffStats: { additions: number; deletions: number; files: number }
}

export interface WorkerDetail {
  worker: Worker
  /** Sessions linked to this worker (`workerId` match or the worker's own session id). */
  sessions: WorkerSessionSummary[]
  /** Subagent sessions spawned from this worker's session (`parentSessionId` link). */
  childSessions: WorkerSessionSummary[]
  children: Worker[]
  artifacts: Artifact[]
  transcript: TranscriptEntry[]
}

export interface TranscriptEntry {
  id: string
  role: 'user' | 'assistant' | 'tool' | 'system'
  text: string
  tool?: { name: string; status: string; input?: unknown; output?: string }
  at: number
}

export interface TimelineEntry {
  seq: number
  type: string
  severity: 'debug' | 'info' | 'warn' | 'error'
  at: number
  message: string
  jobId: string | null
  workerId: string | null
  taskId: string | null
  data: Record<string, unknown>
}

export interface GlobalSearchResult {
  jobs: { id: string; title: string; snippet: string }[]
  tasks: { id: string; title: string; jobId: string }[]
  workers: { id: string; name: string; jobId: string }[]
  artifacts: { id: string; name: string; jobId: string; kind: string }[]
  notes: { path: string; title: string; folder: string; snippet: string }[]
  projects: { id: string; name: string; path: string }[]
}

export interface GraphData {
  nodes: { id: string; label: string; folder: string; tags: string[]; degree: number; orphans: boolean }[]
  edges: { source: string; target: string; kind: 'wiki' | 'markdown' }[]
}

export interface VaultNote {
  path: string
  title: string
  folder: string
  content: string
  tags: string[]
  frontmatter: Record<string, unknown>
  links: string[]
  backlinks: string[]
  unresolved: string[]
  mtime: number
  size: number
}

export interface OpencodeServerState {
  id: string
  label: string
  directory: string
  port: number
  url: string
  pid: number | null
  status: 'starting' | 'ready' | 'unhealthy' | 'stopped' | 'failed'
  version: string | null
  sessions: number
  startedAt: number
  lastError: string | null
}

export interface OpencodeDetection {
  detected: boolean
  path: string | null
  version: string | null
  source: 'path' | 'npm' | 'scoop' | 'manual' | null
}

export interface ProviderTestResult {
  ok: boolean
  latencyMs: number | null
  message: string
  models: ModelInfo[]
}

export interface GitDiffSummary {
  files: { path: string; additions: number; deletions: number; status: string }[]
  raw: string
}

/** Result of checking that a project folder can actually be used as a workspace. */
export interface ProjectPathStatus {
  path: string
  exists: boolean
  isDirectory: boolean
  writable: boolean
  isGitRepo: boolean
  /** Human-readable reason when the path cannot be used. */
  message: string | null
}

/* ============================================================================
 * Harness health check + self-test
 * ==========================================================================*/

/** `skipped` = the check could not run (missing prerequisite); never a pass. */
export type HarnessStatus = 'pass' | 'fail' | 'skipped'

export interface HarnessComponentResult {
  /** Stable component id (e.g. `database`, `opencodeServer`). */
  name: string
  status: HarnessStatus
  durationMs: number
  /** What was actually probed and observed — always set, even on failure. */
  reason: string
}

export interface HarnessHealthReport {
  status: HarnessStatus
  checkedAt: number
  durationMs: number
  components: HarnessComponentResult[]
}

export interface HarnessSelfTestStep {
  name: string
  status: HarnessStatus
  reason: string
}

export type HarnessCheck = { status: HarnessStatus; reason: string }

export interface HarnessSelfTestInvariants {
  /** Every dispatched worker reached a terminal state. */
  workersTerminal: HarnessCheck
  /** ≥1 `task.started` event observed and every task settled. */
  taskTransitions: HarnessCheck
  /** ≥1 artifact row verified as a real file on disk. */
  artifactOnDisk: HarnessCheck
  /** Every `succeeded` worker has assistant/artifact evidence behind it. */
  noFakeSuccess: HarnessCheck
}

export interface HarnessSelfTestEvidence {
  jobId: string
  /** Isolated workspace the run executed in (removed during cleanup). */
  workspace: string
  jobStatus: string
  workers: { id: string; name: string; status: string; filesTouched: number; artifacts: number }[]
  tasks: { id: string; title: string; status: string }[]
  taskEvents: { started: number; completed: number; failed: number }
  artifacts: { id: string; name: string; path: string | null; status: string; bytes: number; existsOnDisk: boolean }[]
}

export interface HarnessSelfTestReport {
  mode: 'diagnostics' | 'selfTest'
  status: HarnessStatus
  reason: string
  startedAt: number
  durationMs: number
  steps: HarnessSelfTestStep[]
  /** Null in diagnostics mode or when prerequisites were missing. */
  invariants: HarnessSelfTestInvariants | null
  evidence: HarnessSelfTestEvidence | null
  /** Sandbox root used by the run; removed during cleanup. */
  sandboxPath: string | null
}

/* ============================================================================
 * API map — the single source of truth for the IPC surface.
 * ==========================================================================*/

export interface IpcApi {
  /* app / system ---------------------------------------------------------- */
  'app.info': { args: []; result: AppInfo }
  'app.health': { args: []; result: ServiceHealth[] }
  'app.onboarding': { args: []; result: OnboardingState }
  'app.finishOnboarding': { args: [Partial<{ skip: boolean }>]; result: OnboardingState }
  'app.chooseDirectory': { args: [{ title?: string; defaultPath?: string }]; result: string | null }
  'app.chooseFile': { args: [{ title?: string; defaultPath?: string; filters?: { name: string; extensions: string[] }[] }]; result: string | null }
  'app.openPath': { args: [string]; result: boolean }
  'app.revealInFolder': { args: [string]; result: boolean }
  'app.openExternal': { args: [string]; result: boolean }

  /* settings -------------------------------------------------------------- */
  'settings.get': { args: []; result: Record<string, unknown> }
  'settings.update': { args: [Record<string, unknown>]; result: Record<string, unknown> }

  /* stats ----------------------------------------------------------------- */
  'stats.snapshot': { args: []; result: StatsSnapshot }

  /* projects -------------------------------------------------------------- */
  'projects.list': { args: []; result: Project[] }
  'projects.get': { args: [string]; result: Project | null }
  'projects.create': { args: [Partial<Project> & { name: string; path: string }]; result: Project }
  'projects.update': { args: [string, Partial<Project>]; result: Project }
  'projects.delete': { args: [string]; result: boolean }
  'projects.gitStatus': { args: [string]; result: GitStatus }
  'projects.worktrees': { args: [string]; result: GitWorktree[] }
  'projects.createWorktree': { args: [string, { branch: string; path?: string }]; result: GitWorktree }
  'projects.removeWorktree': { args: [string]; result: boolean }
  'projects.discover': { args: [{ roots?: string[] }?]; result: { path: string; registered: boolean }[] }
  'projects.validate': { args: [string]; result: ProjectPathStatus }

  /* providers ------------------------------------------------------------- */
  'providers.list': { args: []; result: ProviderConnection[] }
  'providers.create': { args: [Omit<ProviderConnection, 'id' | 'createdAt' | 'updatedAt' | 'health'> & { apiKey?: string }]; result: ProviderConnection }
  'providers.update': { args: [string, Partial<ProviderConnection> & { apiKey?: string }]; result: ProviderConnection }
  'providers.delete': { args: [string]; result: boolean }
  'providers.test': { args: [string]; result: ProviderTestResult }
  'providers.models': { args: [string]; result: ModelInfo[] }
  'providers.hasKey': { args: [string]; result: boolean }

  /* model routes ---------------------------------------------------------- */
  'routes.list': { args: []; result: ModelRoute[] }
  'routes.save': { args: [Partial<ModelRoute> & { name: string }]; result: ModelRoute }
  'routes.delete': { args: [string]; result: boolean }

  /* agent profiles -------------------------------------------------------- */
  'agents.list': { args: []; result: AgentProfile[] }
  'agents.save': { args: [Partial<AgentProfile> & { name: string; role: string }]; result: AgentProfile }
  'agents.delete': { args: [string]; result: boolean }
  'agents.resetBuiltins': { args: []; result: AgentProfile[] }

  /* jobs ------------------------------------------------------------------ */
  'jobs.list': { args: [{ status?: string[]; limit?: number }?]; result: JobListItem[] }
  'jobs.get': { args: [string]; result: JobDetail | null }
  'jobs.create': {
    args: [
      {
        prompt: string
        projectId?: string | null
        vaultId?: string | null
        loopCount?: number
        routeId?: string | null
        requirePlanApproval?: boolean
        templateId?: string | null
        /** Per-job output-language override; omitted = follow the global setting. */
        language?: OutputLanguage
        title?: string
      },
    ]
    result: AutomationJob
  }
  'jobs.update': { args: [string, Partial<AutomationJob>]; result: AutomationJob }
  'jobs.start': { args: [string]; result: AutomationJob }
  'jobs.pause': { args: [string]; result: AutomationJob }
  'jobs.resume': { args: [string]; result: AutomationJob }
  'jobs.cancel': { args: [string]; result: AutomationJob }
  'jobs.delete': { args: [string]; result: boolean }
  'jobs.approvePlan': { args: [string, { approve: boolean; note?: string }]; result: AutomationJob }
  'jobs.rerunLoop': { args: [string, number]; result: AutomationJob }
  'jobs.finalResult': { args: [string]; result: { summary: string; artifacts: Artifact[]; reviews: Review[]; unresolved: string[] } | null }

  /* tasks ----------------------------------------------------------------- */
  'tasks.get': { args: [string]; result: Task | null }
  'tasks.update': { args: [string, Partial<Task>]; result: Task }
  'tasks.retry': { args: [string]; result: Task }
  'tasks.skip': { args: [string]; result: Task }

  /* workers --------------------------------------------------------------- */
  'workers.get': { args: [string]; result: WorkerDetail | null }
  'workers.abort': { args: [string]; result: boolean }
  'workers.retry': { args: [string]; result: Worker }
  'workers.transcript': { args: [string]; result: TranscriptEntry[] }

  /* artifacts -------------------------------------------------------------- */
  'artifacts.list': { args: [string]; result: Artifact[] }

  /* approvals ------------------------------------------------------------- */
  'approvals.list': { args: [{ status?: 'pending' | 'all' }?]; result: Approval[] }
  'approvals.decide': {
    args: [string, { approve: boolean; note?: string }]
    result: { approval: Approval; delivered: boolean }
  }
  'approvals.diff': { args: [string]; result: { raw: string; files: { path: string; additions: number; deletions: number }[] } }

  /* opencode -------------------------------------------------------------- */
  'opencode.detect': { args: []; result: OpencodeDetection }
  'opencode.servers': { args: []; result: OpencodeServerState[] }
  'opencode.startServer': { args: [{ directory?: string }]; result: OpencodeServerState }
  'opencode.stopServer': { args: [string]; result: boolean }
  'opencode.agents': { args: []; result: { name: string; mode: string; description: string | null }[] }
  'opencode.sessions': { args: [string?]; result: { id: string; title: string; directory: string; status: string }[] }
  'opencode.transcript': { args: [string, string]; result: TranscriptEntry[] }
  'opencode.killSession': { args: [string, string]; result: boolean }

  /* harness (health check + self-test) -------------------------------------- */
  'harness.health': { args: []; result: HarnessHealthReport }
  'harness.selfTest': { args: [{ mode?: 'diagnostics' | 'selfTest'; timeoutMs?: number }?]; result: HarnessSelfTestReport }
  'harness.selfTestCancel': { args: []; result: boolean }

  /* obsidian -------------------------------------------------------------- */
  'vaults.list': { args: []; result: Vault[] }
  'vaults.add': { args: [{ name?: string; path: string }]; result: Vault }
  'vaults.remove': { args: [string]; result: boolean }
  'vaults.setDefault': { args: [string]; result: Vault[] }
  'vaults.reindex': { args: [string]; result: Vault }
  'notes.search': { args: [string, { vaultId?: string; limit?: number }?]; result: NoteMeta[] }
  'notes.get': { args: [string, string]; result: VaultNote | null }
  'notes.create': { args: [string, { path: string; content: string }]; result: NoteMeta }
  'notes.update': { args: [string, string, { content: string }]; result: NoteMeta }
  'notes.delete': { args: [string, string]; result: boolean }
  'notes.rename': { args: [string, string, string]; result: NoteMeta }
  'notes.folders': { args: [string]; result: { path: string; name: string; noteCount: number; depth: number }[] }
  'notes.tags': { args: [string]; result: { tag: string; count: number }[] }
  'notes.backlinks': { args: [string, string]; result: NoteMeta[] }
  'notes.related': { args: [string, string, number?]; result: { meta: NoteMeta; score: number }[] }
  'notes.orphans': { args: [string]; result: NoteMeta[] }
  'notes.brokenLinks': { args: [string]; result: { from: string; target: string }[] }
  'notes.recent': { args: [string, number?]; result: NoteMeta[] }
  'notes.list': { args: [string, number?]; result: NoteMeta[] }
  'notes.graph': { args: [string]; result: GraphData }

  /* templates ------------------------------------------------------------- */
  'templates.list': { args: []; result: { id: string; name: string; description: string; body: Record<string, unknown> }[] }
  'templates.save': { args: [{ id?: string; name: string; description: string; body: Record<string, unknown> }]; result: { id: string } }
  'templates.delete': { args: [string]; result: boolean }

  /* activity / search ----------------------------------------------------- */
  'timeline.list': { args: [{ jobId?: string; severity?: string[]; limit?: number; after?: number }?]; result: TimelineEntry[] }
  'search.global': { args: [string]; result: GlobalSearchResult }
  'stats.usage': { args: [{ jobId?: string; days?: number }?]; result: { byModel: { modelId: string; providerId: string; input: number; output: number; cost: number; calls: number }[]; total: { input: number; output: number; cost: number } } }
}

export type ApiChannel = keyof IpcApi
export type ApiArgs<C extends ApiChannel> = IpcApi[C]['args']
export type ApiResult<C extends ApiChannel> = IpcApi[C]['result']

/* ============================================================================
 * Renderer bridge contract
 * ==========================================================================*/

export interface FernBridge {
  invoke<C extends ApiChannel>(channel: C, ...args: ApiArgs<C>): Promise<IpcResult<ApiResult<C>>>
  /** Subscribe to the application event bus. Returns an unsubscribe function. */
  onEvent(listener: (event: AppEvent) => void): () => void
  /** Buffered events emitted before the listener attached. */
  onBufferedEvents(listener: (events: AppEvent[]) => void): () => void
}
