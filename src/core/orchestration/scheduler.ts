import type { Task, Worker } from '@shared/domain'

// `blocked` counts as terminal: once a dependency is unreachable the task can never be scheduled again.
const TERMINAL_TASK = new Set(['succeeded', 'failed', 'cancelled', 'skipped', 'timed_out', 'blocked'])
const DONE_TASK = new Set(['succeeded', 'skipped'])
const RETRYABLE_WORKER = new Set(['failed', 'timed_out', 'orphaned'])

export function isTaskTerminal(task: Task): boolean {
  return TERMINAL_TASK.has(task.status)
}

/** True when every task settled (success, failure, skip or blocked) — nothing left to schedule. */
export function isLoopSettled(tasks: Task[]): boolean {
  return tasks.every((t) => isTaskTerminal(t))
}

/**
 * Tasks whose dependencies did not succeed are blocked.
 * Dependencies that are merely still in flight (pending/ready/running) keep the
 * task waiting — only a finished-but-unsuccessful (or blocked/missing) dependency blocks it.
 * Returns the ids that *should* become blocked — the caller persists them.
 */
export function findBlocked(taskById: Map<string, Task>): string[] {
  const blocked: string[] = []
  for (const task of taskById.values()) {
    if (isTaskTerminal(task)) continue
    const bad = task.dependencyIds.some((id) => {
      const dep = taskById.get(id)
      return !dep || (isTaskTerminal(dep) && !DONE_TASK.has(dep.status))
    })
    if (bad) blocked.push(task.id)
  }
  return blocked
}

/**
 * Ready tasks to dispatch next, honoring the concurrency budget.
 * A task is ready when it is marked ready and every dependency succeeded.
 */
export function pickReady(tasks: Task[], budget: number): Task[] {
  if (budget <= 0) return []
  const byId = new Map(tasks.map((t) => [t.id, t]))
  return tasks
    .filter((t) => t.status === 'ready')
    .filter((t) => t.dependencyIds.every((id) => DONE_TASK.has(byId.get(id)?.status ?? 'failed')))
    .sort((a, b) => b.priority - a.priority || a.createdAt - b.createdAt)
    .slice(0, budget)
}

/**
 * Failed tasks eligible for another attempt, using their retry policy and the
 * terminal state of the worker that last ran them.
 */
export function pickRetries(tasks: Task[], workersByTask: Map<string, Worker>): Task[] {
  const out: Task[] = []
  for (const task of tasks) {
    if (task.status !== 'failed') continue
    const worker = workersByTask.get(task.id)
    if (worker && !RETRYABLE_WORKER.has(worker.status)) continue
    if (worker && worker.status === 'aborted' && task.retryPolicy.noRetryOn.includes('aborted')) continue
    if (task.attempt < task.retryPolicy.maxAttempts) out.push(task)
  }
  return out
}

/** Latest worker created for each task (retries replace earlier attempts). */
export function latestWorkerByTask(workers: Worker[]): Map<string, Worker> {
  const map = new Map<string, Worker>()
  for (const w of workers) map.set(w.taskId, w)
  return map
}
