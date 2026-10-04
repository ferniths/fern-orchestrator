import { homedir } from 'node:os'
import { join } from 'node:path'

export interface AppPaths {
  /** Root data directory (everything the app owns lives under here). */
  root: string
  config: string
  logs: string
  db: string
  keystore: string
  /** Scratch space for job-owned workspaces (non-project automations). */
  jobs: string
  /** Generated OpenCode bridge config (agents/, plugins/) — one subdir per profile. */
  bridge: string
  cache: string
}

/**
 * Resolve where the app stores state.
 *
 * Precedence: explicit override → `FERN_DATA_DIR` → platform convention.
 * Nothing here hardcodes a username, drive letter or home directory.
 */
export function defaultDataDir(): string {
  const fromEnv = process.env.FERN_DATA_DIR
  if (fromEnv && fromEnv.trim()) return fromEnv.trim()

  const name = 'fern-orchestrator'
  if (process.platform === 'win32') {
    const appData = process.env.APPDATA ?? join(homedir(), 'AppData', 'Roaming')
    return join(appData, name)
  }
  if (process.platform === 'darwin') {
    return join(homedir(), 'Library', 'Application Support', name)
  }
  const xdg = process.env.XDG_CONFIG_HOME
  return join(xdg && xdg.trim() ? xdg.trim() : join(homedir(), '.config'), name)
}

export function resolveAppPaths(rootOverride?: string): AppPaths {
  const root = rootOverride?.trim() || defaultDataDir()
  return {
    root,
    config: join(root, 'config.json'),
    logs: join(root, 'logs'),
    db: join(root, 'fern.db'),
    keystore: join(root, 'keystore.bin'),
    jobs: join(root, 'jobs'),
    bridge: join(root, 'opencode-bridge'),
    cache: join(root, 'cache'),
  }
}

/** Windows and Linux both accept forward slashes in Node APIs; keep comparisons stable. */
export function normalizePath(p: string): string {
  return p.replace(/\\/g, '/').replace(/\/+$/, '')
}
