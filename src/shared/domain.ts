import { z } from 'zod'

/* ============================================================================
 * Primitives
 * ==========================================================================*/

export const idSchema = z.string().min(1).max(64)
export const timestampSchema = z.number().int().nonnegative()

/** Every persisted entity carries provenance-friendly ids + timestamps. */
const baseFields = {
  id: idSchema,
  createdAt: timestampSchema,
  updatedAt: timestampSchema,
}

/* ============================================================================
 * Projects & Git
 * ==========================================================================*/

/** How parallel workers share (or isolate) the project working tree. */
export const workspaceStrategySchema = z.enum(['shared', 'worktree_per_worker', 'worktree_per_task', 'sequential_main'])
export type WorkspaceStrategy = z.infer<typeof workspaceStrategySchema>

export const projectSchema = z.object({
  ...baseFields,
  name: z.string().min(1),
  path: z.string().min(1),
  description: z.string().default(''),
  instructions: z.string().default(''),
  /** Path of the vault whose notes should be surfaced as project knowledge. */
  vaultId: idSchema.nullable().default(null),
  workspaceStrategy: workspaceStrategySchema.default('shared'),
  defaultModel: z.string().nullable().default(null),
  enabled: z.boolean().default(true),
  lastOpenedAt: timestampSchema.nullable().default(null),
  metadata: z.record(z.string(), z.unknown()).default({}),
})
export type Project = z.infer<typeof projectSchema>

export const gitStatusSchema = z.object({
  repoRoot: z.string(),
  branch: z.string().nullable(),
  detached: z.boolean(),
  ahead: z.number().int(),
  behind: z.number().int(),
  staged: z.array(z.string()),
  unstaged: z.array(z.string()),
  untracked: z.array(z.string()),
  conflicted: z.array(z.string()),
  isRepo: z.boolean(),
  hasIdentity: z.boolean(),
})
export type GitStatus = z.infer<typeof gitStatusSchema>

export const gitWorktreeSchema = z.object({
  ...baseFields,
  projectId: idSchema,
  path: z.string(),
  branch: z.string(),
  /** Worker/worktree this belongs to; null for the main worktree. */
  workerId: idSchema.nullable().default(null),
  detached: z.boolean().default(false),
  status: z.enum(['active', 'merged', 'removed', 'stale']).default('active'),
})
export type GitWorktree = z.infer<typeof gitWorktreeSchema>

/* ============================================================================
 * Providers, models, agent profiles
 * ==========================================================================*/

export const providerTypeSchema = z.enum(['nine_router', 'openai_compatible'])
export type ProviderType = z.infer<typeof providerTypeSchema>

export const providerConnectionSchema = z.object({
  ...baseFields,
  name: z.string().min(1),
  type: providerTypeSchema,
  baseUrl: z.string().url(),
  /** Stored encrypted at rest; never returned to the UI in plaintext. */
  apiKeyRef: z.string().nullable().default(null),
  defaultModel: z.string().default(''),
  fallbackModel: z.string().nullable().default(null),
  /** 9Router combo model id, when applicable. */
  combo: z.string().nullable().default(null),
  customHeaders: z.record(z.string(), z.string()).default({}),
  timeoutMs: z.number().int().positive().default(120_000),
  maxRetries: z.number().int().min(0).max(10).default(2),
  streaming: z.boolean().default(true),
  enabled: z.boolean().default(true),
  health: z
    .object({
      status: z.enum(['unknown', 'healthy', 'degraded', 'unreachable']),
      latencyMs: z.number().nullable().default(null),
      checkedAt: timestampSchema.nullable().default(null),
      modelCount: z.number().int().nullable().default(null),
      lastError: z.string().nullable().default(null),
      lastSuccessAt: timestampSchema.nullable().default(null),
    })
    .default({ status: 'unknown', latencyMs: null, checkedAt: null, modelCount: null, lastError: null, lastSuccessAt: null }),
})
export type ProviderConnection = z.infer<typeof providerConnectionSchema>

export const modelInfoSchema = z.object({
  id: z.string(),
  providerId: z.string(),
  name: z.string().optional(),
  contextWindow: z.number().nullable().default(null),
  maxOutput: z.number().nullable().default(null),
  reasoning: z.boolean().nullable().default(null),
  toolCalls: z.boolean().nullable().default(null),
  vision: z.boolean().nullable().default(null),
  isCombo: z.boolean().default(false),
})
export type ModelInfo = z.infer<typeof modelInfoSchema>

/** Roles the router knows how to price/choose models for. */
export const agentRoleSchema = z.enum([
  'refiner',
  'planner',
  'architect',
  'researcher',
  'coder',
  'debugger',
  'tester',
  'reviewer',
  'security_reviewer',
  'documenter',
  'ui_ux',
  'integration',
  'synthesizer',
  'final_reviewer',
  'knowledge',
  'custom',
])
export type AgentRole = z.infer<typeof agentRoleSchema>

export const modelPreferenceSchema = z.object({
  role: agentRoleSchema,
  /** `provider/model` id; null = automatic routing. */
  modelId: z.string().nullable().default(null),
  fallbackModelId: z.string().nullable().default(null),
  providerId: z.string().nullable().default(null),
})
export type ModelPreference = z.infer<typeof modelPreferenceSchema>

export const modelRouteSchema = z.object({
  ...baseFields,
  name: z.string().min(1),
  strategy: z.enum(['automatic', 'explicit']),
  /** role -> model preference, used when strategy === 'explicit'. */
  preferences: z.array(modelPreferenceSchema).default([]),
  isDefault: z.boolean().default(false),
})
export type ModelRoute = z.infer<typeof modelRouteSchema>

export const retryPolicySchema = z.object({
  maxAttempts: z.number().int().min(1).max(10).default(2),
  backoffMs: z.number().int().min(0).default(2_000),
  backoffMultiplier: z.number().min(1).default(2),
  /** Errors that must not be retried at all. */
  noRetryOn: z.array(z.enum(['aborted', 'permission_denied', 'invalid_response', 'provider_auth'])).default([]),
})
export type RetryPolicy = z.infer<typeof retryPolicySchema>

export const agentProfileSchema = z.object({
  ...baseFields,
  name: z.string().min(1),
  role: agentRoleSchema,
  description: z.string().default(''),
  systemPrompt: z.string().default(''),
  /** OpenCode agent name to bind workers to (e.g. `build`, `plan`, `explore`). */
  opencodeAgent: z.string().nullable().default(null),
  modelPreference: modelPreferenceSchema.nullable().default(null),
  fallbackModel: z.string().nullable().default(null),
  allowedTools: z.array(z.string()).nullable().default(null),
  timeoutMs: z.number().int().positive().default(15 * 60_000),
  retryPolicy: retryPolicySchema.prefault({}),
  /** Preferred structured-output contract when this agent is run. */
  outputFormat: z.enum(['text', 'json', 'plan', 'review', 'synthesis']).default('text'),
  priority: z.number().int().min(0).max(100).default(50),
  builtIn: z.boolean().default(false),
  enabled: z.boolean().default(true),
})
export type AgentProfile = z.infer<typeof agentProfileSchema>

/* ============================================================================
 * Output language
 *
 * The language used for natural-language AI prose the user reads (refined
 * prompts, plan summaries/objectives, review problems, synthesis text). It
 * never applies to code, file paths, identifiers, JSON keys/enums or worker
 * task instructions.
 * ==========================================================================*/

/** Canonical stored values — the UI labels differ (see renderer LANGUAGE_OPTIONS). */
export const OUTPUT_LANGUAGES = ['English', 'Japanese', 'Portuguese (Brazil)', 'Spanish', 'Jamaican Patois'] as const
export const outputLanguageSchema = z.enum(OUTPUT_LANGUAGES)
export type OutputLanguage = z.infer<typeof outputLanguageSchema>
export const DEFAULT_OUTPUT_LANGUAGE: OutputLanguage = 'English'

/**
 * One-line instruction appended to an existing system message when a
 * non-English output language is active. Returns null for the default so
 * English prompts stay byte-identical to the ones shipped without this feature.
 */
export function proseLanguageInstruction(language: string | null | undefined): string | null {
  if (!language || language === DEFAULT_OUTPUT_LANGUAGE) return null
  return `Write all human-readable prose (summaries, problems, changes) in ${language}. Keep JSON keys and enum values exactly as specified.`
}

/* ============================================================================
 * Jobs, loops, workflows, tasks, workers
 * ==========================================================================*/

export const jobStatusSchema = z.enum([
  'draft',
  'refining',
  'planning',
  'ready',
  'running',
  'paused',
  'awaiting_approval',
  'completed',
  'failed',
  'cancelled',
])
export type JobStatus = z.infer<typeof jobStatusSchema>

export const automationJobSchema = z.object({
  ...baseFields,
  title: z.string().min(1),
  originalPrompt: z.string().min(1),
  refinedPrompt: z.string().default(''),
  projectId: idSchema.nullable().default(null),
  vaultId: idSchema.nullable().default(null),
  status: jobStatusSchema.default('draft'),
  statusReason: z.string().nullable().default(null),
  loopCount: z.number().int().min(1).max(100).default(1),
  currentLoop: z.number().int().min(0).default(0),
  routeId: idSchema.nullable().default(null),
  templateId: idSchema.nullable().default(null),
  /** Per-job output-language override; null = follow the global setting. */
  language: outputLanguageSchema.nullable().default(null),
  /** Set when the user asked to review the plan before executing. */
  requirePlanApproval: z.boolean().default(false),
  planApprovedAt: timestampSchema.nullable().default(null),
  workspacePath: z.string().nullable().default(null),
  stats: z
    .object({
      totalTokens: z.number().int().default(0),
      totalCost: z.number().default(0),
      workersRun: z.number().int().default(0),
      tasksCompleted: z.number().int().default(0),
      failures: z.number().int().default(0),
      retries: z.number().int().default(0),
      durationMs: z.number().int().default(0),
    })
    .default({
      totalTokens: 0,
      totalCost: 0,
      workersRun: 0,
      tasksCompleted: 0,
      failures: 0,
      retries: 0,
      durationMs: 0,
    }),
  startedAt: timestampSchema.nullable().default(null),
  completedAt: timestampSchema.nullable().default(null),
  error: z.string().nullable().default(null),
})
export type AutomationJob = z.infer<typeof automationJobSchema>

export const loopStatusSchema = z.enum(['planning', 'executing', 'integrating', 'reviewing', 'completed', 'failed'])
export type LoopStatus = z.infer<typeof loopStatusSchema>

/**
 * One iteration. Loops are iteration budgets: each stores its own plan
 * snapshot, tasks, results, review and unresolved issues.
 */
export const loopRecordSchema = z.object({
  ...baseFields,
  jobId: idSchema,
  index: z.number().int().min(1),
  status: loopStatusSchema,
  /** Refined plan text/JSON produced for this iteration. */
  planSummary: z.string().default(''),
  reviewSummary: z.string().default(''),
  verdict: z.enum(['pending', 'pass', 'fail', 'partial', 'stop']).default('pending'),
  problems: z.array(z.string()).default([]),
  changes: z.array(z.string()).default([]),
  unresolved: z.array(z.string()).default([]),
  artifactsProduced: z.number().int().default(0),
  durationMs: z.number().int().default(0),
  stats: z
    .object({
      totalTokens: z.number().int().default(0),
      workers: z.number().int().default(0),
      failures: z.number().int().default(0),
      retries: z.number().int().default(0),
    })
    .default({ totalTokens: 0, workers: 0, failures: 0, retries: 0 }),
  startedAt: timestampSchema.nullable().default(null),
  completedAt: timestampSchema.nullable().default(null),
})
export type LoopRecord = z.infer<typeof loopRecordSchema>

export const nodeKindSchema = z.enum([
  'task',
  'gate',
  'condition',
  'integration',
  'review',
  'final',
  'research',
  'implementation',
  'validation',
])
export type NodeKind = z.infer<typeof nodeKindSchema>

export const nodeStateSchema = z.enum([
  'pending',
  'ready',
  'running',
  'waiting_approval',
  'blocked',
  'succeeded',
  'failed',
  'skipped',
  'cancelled',
  'timed_out',
])
export type NodeState = z.infer<typeof nodeStateSchema>

export const workflowNodeSchema = z.object({
  ...baseFields,
  jobId: idSchema,
  loopIndex: z.number().int(),
  taskId: idSchema.nullable().default(null),
  kind: nodeKindSchema,
  label: z.string(),
  detail: z.string().default(''),
  /** Why the planner created this node — surfaced in the UI. */
  rationale: z.string().default(''),
  state: nodeStateSchema.default('pending'),
  priority: z.number().int().min(0).max(100).default(50),
  timeoutMs: z.number().int().positive().default(30 * 60_000),
  /** `continue` / `repair` semantics for condition nodes. */
  condition: z.string().nullable().default(null),
})
export type WorkflowNode = z.infer<typeof workflowNodeSchema>

export const edgeKindSchema = z.enum(['dependency', 'on_success', 'on_failure', 'conditional'])
export type EdgeKind = z.infer<typeof edgeKindSchema>

export const workflowEdgeSchema = z.object({
  ...baseFields,
  jobId: idSchema,
  loopIndex: z.number().int(),
  sourceNodeId: idSchema,
  targetNodeId: idSchema,
  kind: edgeKindSchema.default('dependency'),
  label: z.string().default(''),
})
export type WorkflowEdge = z.infer<typeof workflowEdgeSchema>

export const taskStatusSchema = z.enum([
  'pending',
  'ready',
  'running',
  'waiting_approval',
  'blocked',
  'succeeded',
  'failed',
  'cancelled',
  'skipped',
  'timed_out',
])
export type TaskStatus = z.infer<typeof taskStatusSchema>

export const taskSchema = z.object({
  ...baseFields,
  jobId: idSchema,
  loopIndex: z.number().int(),
  nodeId: idSchema.nullable().default(null),
  parentId: idSchema.nullable().default(null),
  title: z.string().min(1),
  objective: z.string().default(''),
  role: agentRoleSchema,
  profileId: idSchema.nullable().default(null),
  modelId: z.string().nullable().default(null),
  providerId: z.string().nullable().default(null),
  opencodeAgent: z.string().nullable().default(null),
  systemPrompt: z.string().default(''),
  prompt: z.string().default(''),
  dependencyIds: z.array(idSchema).default([]),
  expectedArtifacts: z.array(z.string()).default([]),
  successCriteria: z.array(z.string()).default([]),
  status: taskStatusSchema.default('pending'),
  statusReason: z.string().nullable().default(null),
  priority: z.number().int().min(0).max(100).default(50),
  timeoutMs: z.number().int().positive().default(30 * 60_000),
  retryPolicy: retryPolicySchema.prefault({}),
  attempt: z.number().int().min(0).default(0),
  /** Short machine-readable rationale from the planner. */
  rationale: z.string().default(''),
  complexity: z.enum(['low', 'medium', 'high']).default('medium'),
  artifacts: z.array(z.string()).default([]),
  resultSummary: z.string().default(''),
  startedAt: timestampSchema.nullable().default(null),
  completedAt: timestampSchema.nullable().default(null),
  error: z.string().nullable().default(null),
})
export type Task = z.infer<typeof taskSchema>

export const workerStatusSchema = z.enum([
  'queued',
  'starting',
  'running',
  'waiting_approval',
  'succeeded',
  'failed',
  'timed_out',
  'aborted',
  'orphaned',
])
export type WorkerStatus = z.infer<typeof workerStatusSchema>

/** A unit of delegated work backed by a real OpenCode session. */
export const workerSchema = z.object({
  ...baseFields,
  jobId: idSchema,
  loopIndex: z.number().int(),
  taskId: idSchema,
  name: z.string(),
  role: agentRoleSchema,
  objective: z.string().default(''),
  systemPrompt: z.string().default(''),
  taskPrompt: z.string().default(''),
  modelId: z.string().nullable().default(null),
  providerId: z.string().nullable().default(null),
  opencodeAgent: z.string().nullable().default(null),
  profileId: idSchema.nullable().default(null),
  workspacePath: z.string().default(''),
  projectId: idSchema.nullable().default(null),
  parentWorkerId: idSchema.nullable().default(null),
  parentSessionId: z.string().nullable().default(null),
  /** Native OpenCode session id; null until the session exists. */
  sessionId: z.string().nullable().default(null),
  depth: z.number().int().min(0).default(0),
  status: workerStatusSchema.default('queued'),
  attempt: z.number().int().min(0).default(0),
  timeoutMs: z.number().int().positive().default(30 * 60_000),
  statusReason: z.string().nullable().default(null),
  filesTouched: z.array(z.string()).default([]),
  artifacts: z.array(idSchema).default([]),
  usage: z
    .object({
      inputTokens: z.number().int().default(0),
      outputTokens: z.number().int().default(0),
      costUsd: z.number().default(0),
      requests: z.number().int().default(0),
      durationMs: z.number().int().default(0),
    })
    .default({ inputTokens: 0, outputTokens: 0, costUsd: 0, requests: 0, durationMs: 0 }),
  queuedAt: timestampSchema.nullable().default(null),
  startedAt: timestampSchema.nullable().default(null),
  completedAt: timestampSchema.nullable().default(null),
  error: z.string().nullable().default(null),
})
export type Worker = z.infer<typeof workerSchema>

/** Mirror of a native OpenCode session, keeping the 1:1 mapping explicit. */
export const workerSessionSchema = z.object({
  ...baseFields,
  workerId: idSchema.nullable(),
  sessionId: z.string(),
  serverId: idSchema,
  parentSessionId: z.string().nullable().default(null),
  jobId: idSchema.nullable().default(null),
  projectId: idSchema.nullable().default(null),
  title: z.string().default(''),
  directory: z.string().default(''),
  modelId: z.string().nullable().default(null),
  providerId: z.string().nullable().default(null),
  opencodeAgent: z.string().nullable().default(null),
  depth: z.number().int().min(0).default(0),
  status: z.enum(['active', 'idle', 'completed', 'failed', 'lost', 'aborted']).default('active'),
  summary: z.string().default(''),
  diffStats: z.object({ additions: z.number().int().default(0), deletions: z.number().int().default(0), files: z.number().int().default(0) }).default({
    additions: 0,
    deletions: 0,
    files: 0,
  }),
  lastEventAt: timestampSchema.nullable().default(null),
})
export type WorkerSession = z.infer<typeof workerSessionSchema>

/* ============================================================================
 * Artifacts, reviews, approvals, usage
 * ==========================================================================*/

export const artifactKindSchema = z.enum([
  'file',
  'modified_file',
  'diff',
  'patch',
  'research_report',
  'markdown_note',
  'test_report',
  'screenshot',
  'log',
  'json_data',
  'documentation',
  'response',
  'review_report',
  'plan',
  'obsidian_ops',
])
export type ArtifactKind = z.infer<typeof artifactKindSchema>

export const artifactSchema = z.object({
  ...baseFields,
  jobId: idSchema,
  loopIndex: z.number().int(),
  taskId: idSchema.nullable().default(null),
  workerId: idSchema.nullable().default(null),
  sessionId: z.string().nullable().default(null),
  kind: artifactKindSchema,
  name: z.string(),
  path: z.string().nullable().default(null),
  /** Inline payload for small artifacts (responses, reviews, JSON). */
  content: z.string().nullable().default(null),
  mimeType: z.string().default('text/plain'),
  bytes: z.number().int().min(0).default(0),
  checksum: z.string().nullable().default(null),
  status: z.enum(['pending', 'available', 'missing', 'superseded', 'failed']).default('available'),
  metadata: z.record(z.string(), z.unknown()).default({}),
})
export type Artifact = z.infer<typeof artifactSchema>

export const reviewFindingSchema = z.object({
  id: z.string(),
  severity: z.enum(['info', 'minor', 'major', 'critical']),
  title: z.string(),
  detail: z.string().default(''),
  targetTaskId: idSchema.nullable().default(null),
  requiredAction: z.string().default(''),
})

export const reviewSchema = z.object({
  ...baseFields,
  jobId: idSchema,
  loopIndex: z.number().int(),
  kind: z.enum(['task', 'loop', 'final']),
  targetId: idSchema.nullable().default(null),
  reviewerRole: agentRoleSchema,
  reviewerWorkerId: idSchema.nullable().default(null),
  criteria: z.array(z.string()).default([]),
  verdict: z.enum(['pending', 'pass', 'fail', 'needs_more_work', 'stop']),
  summary: z.string().default(''),
  findings: z.array(reviewFindingSchema).default([]),
  artifactIds: z.array(idSchema).default([]),
  modelId: z.string().nullable().default(null),
  durationMs: z.number().int().default(0),
})
export type Review = z.infer<typeof reviewSchema>

export const approvalKindSchema = z.enum(['git_commit', 'git_push', 'plan', 'manual_gate', 'vault_write'])
export type ApprovalKind = z.infer<typeof approvalKindSchema>

export const approvalSchema = z.object({
  ...baseFields,
  jobId: idSchema.nullable(),
  kind: approvalKindSchema,
  title: z.string(),
  detail: z.string().default(''),
  status: z.enum(['pending', 'approved', 'denied', 'expired', 'cancelled']),
  /** Permission id on the OpenCode side, when this approval answers one. */
  opencodePermissionId: z.string().nullable().default(null),
  sessionId: z.string().nullable().default(null),
  workerId: idSchema.nullable().default(null),
  payload: z.record(z.string(), z.unknown()).default({}),
  decidedAt: timestampSchema.nullable().default(null),
  decisionNote: z.string().nullable().default(null),
  expiresAt: timestampSchema.nullable().default(null),
})
export type Approval = z.infer<typeof approvalSchema>

export const usageRecordSchema = z.object({
  ...baseFields,
  jobId: idSchema.nullable(),
  loopIndex: z.number().int().nullable().default(null),
  taskId: idSchema.nullable(),
  workerId: idSchema.nullable(),
  providerId: z.string(),
  modelId: z.string(),
  inputTokens: z.number().int().default(0),
  outputTokens: z.number().int().default(0),
  cacheReadTokens: z.number().int().default(0),
  costUsd: z.number().default(0),
  latencyMs: z.number().int().default(0),
  requestId: z.string().nullable().default(null),
  source: z.enum(['control_plane', 'opencode', 'unknown']).default('unknown'),
  at: timestampSchema,
})
export type UsageRecord = z.infer<typeof usageRecordSchema>

/* ============================================================================
 * Events (application-wide bus payloads)
 * ==========================================================================*/

export const eventSeveritySchema = z.enum(['debug', 'info', 'warn', 'error'])
export type EventSeverity = z.infer<typeof eventSeveritySchema>

export const appEventSchema = z.object({
  /** Monotonic sequence so the UI can detect gaps after reconnect. */
  seq: z.number().int().nonnegative(),
  type: z.string().min(1),
  severity: eventSeveritySchema.default('info'),
  at: timestampSchema,
  jobId: idSchema.nullable().default(null),
  workerId: idSchema.nullable().default(null),
  taskId: idSchema.nullable().default(null),
  projectId: idSchema.nullable().default(null),
  message: z.string().default(''),
  data: z.record(z.string(), z.unknown()).default({}),
})
export type AppEvent = z.infer<typeof appEventSchema>

/* ============================================================================
 * Obsidian
 * ==========================================================================*/

export const vaultSchema = z.object({
  ...baseFields,
  name: z.string().min(1),
  path: z.string().min(1),
  enabled: z.boolean().default(true),
  lastIndexedAt: timestampSchema.nullable().default(null),
  noteCount: z.number().int().default(0),
  linkCount: z.number().int().default(0),
  indexStatus: z.enum(['never', 'building', 'ready', 'failed']).default('never'),
  lastError: z.string().nullable().default(null),
  isDefault: z.boolean().default(false),
})
export type Vault = z.infer<typeof vaultSchema>

export const noteMetaSchema = z.object({
  path: z.string(),
  title: z.string(),
  folder: z.string(),
  tags: z.array(z.string()),
  links: z.array(z.string()),
  backlinks: z.array(z.string()),
  unresolved: z.array(z.string()),
  size: z.number().int(),
  mtime: timestampSchema,
  hasFrontmatter: z.boolean().default(false),
})
export type NoteMeta = z.infer<typeof noteMetaSchema>

/* ============================================================================
 * Config / settings
 * ==========================================================================*/

export const orchestrationLimitsSchema = z.object({
  maxConcurrentWorkers: z.number().int().min(1).max(64).default(4),
  maxQueuedWorkers: z.number().int().min(1).max(256).default(64),
  maxSessionsPerJob: z.number().int().min(1).max(1000).default(128),
  maxSubagentDepth: z.number().int().min(0).max(5).default(2),
  maxSubagentsPerWorker: z.number().int().min(0).max(32).default(4),
  maxRetries: z.number().int().min(0).max(10).default(2),
  maxLoops: z.number().int().min(1).max(100).default(10),
  maxRuntimeMs: z.number().int().min(60_000).default(4 * 60 * 60_000),
  maxTokenBudget: z.number().int().min(0).default(0),
})
export type OrchestrationLimits = z.infer<typeof orchestrationLimitsSchema>

export const permissionPolicySchema = z.object({
  gitCommit: z.enum(['ask', 'allow', 'deny']).default('ask'),
  gitPush: z.enum(['ask', 'allow', 'deny']).default('ask'),
  vaultWrite: z.enum(['ask', 'allow', 'deny']).default('allow'),
  /** Chained commands (`a && git commit`) are intercepted by the plugin backstop. */
  interceptChainedGit: z.boolean().default(true),
  requirePlanApproval: z.boolean().default(false),
})
export type PermissionPolicy = z.infer<typeof permissionPolicySchema>

/* ============================================================================
 * Lookups / list results used across the IPC boundary
 * ==========================================================================*/

export const statsSnapshotSchema = z.object({
  jobs: z.object({
    total: z.number().int(),
    active: z.number().int(),
    completed: z.number().int(),
    failed: z.number().int(),
  }),
  workers: z.object({
    running: z.number().int(),
    queued: z.number().int(),
    completed: z.number().int(),
    failed: z.number().int(),
  }),
  approvals: z.object({ pending: z.number().int() }),
  artifacts: z.object({ total: z.number().int() }),
  providers: z.object({ configured: z.number().int(), healthy: z.number().int() }),
  opencode: z.object({ servers: z.number().int(), sessions: z.number().int() }),
  vault: z.object({ notes: z.number().int(), lastIndexedAt: timestampSchema.nullable() }),
  usage: z.object({ inputTokens: z.number().int(), outputTokens: z.number().int(), costUsd: z.number() }),
})
export type StatsSnapshot = z.infer<typeof statsSnapshotSchema>
