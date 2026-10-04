import { accessSync, constants, existsSync, statSync, type Stats } from 'node:fs'
import { join } from 'node:path'
import type { ProjectPathStatus } from '@shared/ipc'

/**
 * Checks that a path still exists, is a directory and is writable — i.e. that
 * it can be used as a job workspace. Used when a job is created and again when
 * it starts, so a stale project never silently turns into an empty scratch
 * folder under the missing path.
 */
export function validateProjectPath(path: string): ProjectPathStatus {
  const trimmed = path?.trim() ?? ''
  const base: ProjectPathStatus = {
    path: trimmed,
    exists: false,
    isDirectory: false,
    writable: false,
    isGitRepo: false,
    message: null,
  }
  if (!trimmed) return { ...base, message: 'project path is required' }

  let stats: Stats
  try {
    stats = statSync(trimmed)
  } catch {
    return { ...base, message: `path does not exist: ${trimmed}` }
  }
  if (!stats.isDirectory()) return { ...base, exists: true, message: `not a directory: ${trimmed}` }

  let writable = true
  try {
    accessSync(trimmed, constants.W_OK)
  } catch {
    writable = false
  }
  const isGitRepo = existsSync(join(trimmed, '.git'))
  return {
    path: trimmed,
    exists: true,
    isDirectory: true,
    writable,
    isGitRepo,
    message: writable ? null : `folder is not writable: ${trimmed}`,
  }
}
