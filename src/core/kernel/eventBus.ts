import type { AppEvent, EventSeverity } from '@shared/domain'

/** Canonical event names. The UI renders from these, not from ad-hoc strings. */
export const EVENTS = {
  JOB_CREATED: 'job.created',
  JOB_STARTED: 'job.started',
  JOB_STATUS: 'job.status',
  JOB_COMPLETED: 'job.completed',
  JOB_FAILED: 'job.failed',
  JOB_CANCELLED: 'job.cancelled',
  JOB_PLAN_READY: 'job.plan.ready',
  JOB_PLAN_APPROVED: 'job.plan.approved',
  JOB_FINALIZED: 'job.finalized',

  LOOP_STARTED: 'loop.started',
  LOOP_COMPLETED: 'loop.completed',
  LOOP_FAILED: 'loop.failed',

  TASK_CREATED: 'task.created',
  TASK_STARTED: 'task.started',
  TASK_WAITING: 'task.waiting',
  TASK_COMPLETED: 'task.completed',
  TASK_FAILED: 'task.failed',
  TASK_UPDATED: 'task.updated',

  WORKER_QUEUED: 'worker.queued',
  WORKER_SPAWNED: 'worker.spawned',
  WORKER_STARTED: 'worker.started',
  WORKER_OUTPUT: 'worker.output',
  WORKER_COMPLETED: 'worker.completed',
  WORKER_FAILED: 'worker.failed',
  WORKER_ABORTED: 'worker.aborted',
  WORKER_RETRIED: 'worker.retried',
  SUBAGENT_SPAWNED: 'subagent.spawned',

  ARTIFACT_CREATED: 'artifact.created',

  REVIEW_STARTED: 'review.started',
  REVIEW_COMPLETED: 'review.completed',

  APPROVAL_REQUESTED: 'approval.requested',
  APPROVAL_RESOLVED: 'approval.resolved',

  PROVIDER_ADDED: 'provider.added',
  PROVIDER_FAILED: 'provider.failed',
  PROVIDER_HEALTH: 'provider.health',

  OPENCODE_SERVER_STARTED: 'opencode.server.started',
  OPENCODE_SERVER_STOPPED: 'opencode.server.stopped',
  OPENCODE_SERVER_FAILED: 'opencode.server.failed',
  OPENCODE_SESSION_LOST: 'opencode.session.lost',

  VAULT_INDEXED: 'obsidian.indexed',
  VAULT_NOTE_CHANGED: 'obsidian.note.changed',
  VAULT_ERROR: 'obsidian.error',

  PROJECT_UPDATED: 'project.updated',
  NOTIFICATION: 'notification',
  STATS_UPDATED: 'stats.updated',
} as const

export type EventName = (typeof EVENTS)[keyof typeof EVENTS]

export interface PublishPayload {
  severity?: EventSeverity
  jobId?: string | null
  workerId?: string | null
  taskId?: string | null
  projectId?: string | null
  message?: string
  data?: Record<string, unknown>
}

type Listener = (event: AppEvent) => void

/**
 * Application-wide event bus.
 *
 * - assigns a monotonic `seq` so clients can resume after a reconnect
 * - keeps a bounded replay buffer (default 2000 events)
 * - listeners are isolated: one throwing subscriber never breaks another
 */
export class EventBus {
  private seq = 0
  private readonly buffer: AppEvent[] = []
  private readonly listeners = new Set<Listener>()
  private readonly byType = new Map<string, Set<Listener>>()

  constructor(private readonly bufferSize = 2000) {}

  publish(type: string, payload: PublishPayload = {}): AppEvent {
    const event: AppEvent = {
      seq: ++this.seq,
      type,
      severity: payload.severity ?? 'info',
      at: Date.now(),
      jobId: payload.jobId ?? null,
      workerId: payload.workerId ?? null,
      taskId: payload.taskId ?? null,
      projectId: payload.projectId ?? null,
      message: payload.message ?? '',
      data: payload.data ?? {},
    }
    this.buffer.push(event)
    if (this.buffer.length > this.bufferSize) this.buffer.splice(0, this.buffer.length - this.bufferSize)

    for (const l of this.listeners) this.safe(l, event)
    for (const l of this.byType.get(type) ?? []) this.safe(l, event)
    return event
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  subscribeType(type: string, listener: Listener): () => void {
    let set = this.byType.get(type)
    if (!set) {
      set = new Set()
      this.byType.set(type, set)
    }
    set.add(listener)
    return () => {
      set!.delete(listener)
      if (set!.size === 0) this.byType.delete(type)
    }
  }

  /** Everything after `seq` (used when a renderer reconnects). */
  replaySince(seq: number): AppEvent[] {
    return this.buffer.filter((e) => e.seq > seq)
  }

  recent(limit = 100): AppEvent[] {
    return this.buffer.slice(-limit)
  }

  get lastSeq(): number {
    return this.seq
  }

  private safe(listener: Listener, event: AppEvent): void {
    try {
      listener(event)
    } catch {
      /* subscriber isolation */
    }
  }
}
