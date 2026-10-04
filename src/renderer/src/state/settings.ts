import type { OutputLanguage } from '@shared/domain'
import { call } from '../lib/api'

/**
 * Renderer-side view of the settings the UI actually consumes. Kept as a local
 * shape (the zod schema lives in the main process) so nothing here can drift
 * into `any`.
 */
export interface SettingsShape {
  general?: {
    launchAtLogin?: boolean
    minimizeToTray?: boolean
    confirmDestructive?: boolean
    language?: OutputLanguage
  }
  appearance?: {
    theme?: 'dark' | 'light' | 'system'
    accent?: 'neutral' | 'blue' | 'green' | 'amber'
    reduceMotion?: boolean
  }
  opencode?: {
    autoStart?: boolean
    serverTimeoutMs?: number
    maxServers?: number
    extraArgs?: string[]
    allowedAgents?: string[] | null
    enableApprovalPlugin?: boolean
    binaryPath?: string | null
    shell?: string | null
  }
  obsidian?: {
    watch?: boolean
    debounceMs?: number
    searchLimit?: number
    defaultVaultId?: string | null
  }
  notifications?: Record<string, boolean>
  [section: string]: unknown
}

/**
 * Output-language choices: `[canonical stored value, UI label]` pairs.
 * The stored value is what Settings → General and jobs.create persist; the
 * label is what the user sees in the select.
 */
export const LANGUAGE_OPTIONS: [OutputLanguage, string][] = [
  ['English', 'English (Default)'],
  ['Japanese', 'Japanese'],
  ['Portuguese (Brazil)', 'Brazilian'],
  ['Spanish', 'Spanish'],
  ['Jamaican Patois', 'Jamaican Patois'],
]

let cache: SettingsShape | null = null
let inflight: Promise<SettingsShape> | null = null

/** Applies appearance preferences to the document (accent palette, motion). */
export function applyAppearance(cfg: SettingsShape): void {
  const root = document.documentElement
  root.dataset['accent'] = cfg.appearance?.accent ?? 'neutral'
  root.classList.toggle('reduce-motion', Boolean(cfg.appearance?.reduceMotion))
}

export async function getSettings(): Promise<SettingsShape> {
  if (cache) return cache
  inflight ??= call('settings.get')
    .then((raw) => {
      cache = raw as SettingsShape
      applyAppearance(cache)
      return cache
    })
    .finally(() => {
      inflight = null
    })
  return inflight
}

/** Drops the cache so the next read re-fetches (call after any update). */
export function invalidateSettings(next?: SettingsShape): void {
  if (next) {
    cache = next
    applyAppearance(next)
  } else {
    cache = null
  }
}

/**
 * Whether a destructive action still needs to be confirmed. Returns false when
 * the user turned "Confirm destructive actions" off, so dialogs can act
 * immediately instead of asking.
 */
export async function requiresConfirmation(): Promise<boolean> {
  try {
    const cfg = await getSettings()
    return cfg.general?.confirmDestructive !== false
  } catch {
    // Unknown state → keep asking; confirming twice beats deleting by accident.
    return true
  }
}
