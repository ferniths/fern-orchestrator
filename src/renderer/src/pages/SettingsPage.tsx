import { useEffect, useMemo, useState } from 'react'
import {
  Settings as SettingsIcon,
  RotateCcw,
  Info,
  ShieldCheck,
  Bell,
  Gauge,
  Palette,
  Terminal,
  Bot,
  NotebookPen,
  PlayCircle,
  Stethoscope,
} from 'lucide-react'
import { call, useApi } from '../lib/api'
import { cn } from '../lib/format'
import type { PageProps } from '../lib/types'
import { invalidateSettings, LANGUAGE_OPTIONS, type SettingsShape } from '../state/settings'
import { toast } from '../state/toast'
import type { OutputLanguage } from '@shared/domain'
import type { HarnessHealthReport, HarnessSelfTestReport, HarnessStatus } from '@shared/ipc'
import { Button, ConfirmDialog, ErrorNote, LoadingRow, Modal, Panel, Pill, Select, Spinner, Switch, type PillTone } from '../components/ui'

const SECTIONS = [
  { id: 'general', label: 'General', icon: SettingsIcon },
  { id: 'opencode', label: 'OpenCode', icon: Bot },
  { id: 'orchestration', label: 'Orchestration', icon: Gauge },
  { id: 'permissions', label: 'Permissions', icon: ShieldCheck },
  { id: 'notifications', label: 'Notifications', icon: Bell },
  { id: 'obsidian', label: 'Knowledge', icon: NotebookPen },
  { id: 'appearance', label: 'Appearance', icon: Palette },
  { id: 'diagnostics', label: 'Diagnostics', icon: Terminal },
  { id: 'about', label: 'About', icon: Info },
] as const
type SectionId = (typeof SECTIONS)[number]['id']

/** Only the fields this page reads — keeps the UI off `any`. */
interface Cfg {
  general?: {
    launchAtLogin?: boolean
    minimizeToTray?: boolean
    confirmDestructive?: boolean
    language?: OutputLanguage
  }
  appearance?: { theme?: 'dark' | 'light' | 'system'; accent?: 'neutral' | 'blue' | 'green' | 'amber'; reduceMotion?: boolean }
  opencode?: {
    autoStart?: boolean
    serverTimeoutMs?: number
    maxServers?: number
    extraArgs?: string[]
    allowedAgents?: string[] | null
    enableApprovalPlugin?: boolean
    shell?: string | null
  }
  obsidian?: { watch?: boolean; debounceMs?: number; searchLimit?: number }
  orchestration?: {
    limits?: { maxConcurrentWorkers?: number }
    defaultLoopCount?: number
    taskTimeoutMs?: number
    approvalTimeoutMs?: number
    requirePlanApproval?: boolean
    persistTranscripts?: boolean
  }
  permissions?: { gitCommit?: string; gitPush?: string; vaultWrite?: string; interceptChainedGit?: boolean }
  notifications?: Record<string, boolean>
  diagnostics?: { logLevel?: 'debug' | 'info' | 'warn' | 'error'; diagnosticMode?: boolean; retainLogDays?: number }
}

export default function SettingsPage(_: PageProps) {
  const [section, setSection] = useState<SectionId>('general')
  const settings = useApi('settings.get', [])
  const info = useApi('app.info', [])
  const health = useApi('app.health', [], { pollMs: 30_000 })
  const onboarding = useApi('app.onboarding', [])
  const agents = useApi('agents.list', [])
  const templates = useApi('templates.list', [])

  const cfg: Cfg = useMemo(() => (settings.data ?? {}) as Cfg, [settings.data])
  const [resetOpen, setResetOpen] = useState(false)
  const [templateOpen, setTemplateOpen] = useState<{ id: string; name: string; body: Record<string, unknown> } | null>(null)

  async function patchLocal(sectionKey: string, value: Record<string, unknown>) {
    try {
      const next = await call('settings.update', { [sectionKey]: value })
      // Appearance and the confirm gate live in the renderer — refresh both.
      invalidateSettings(next as unknown as SettingsShape)
      settings.reload()
    } catch (err) {
      toast.error('Could not save setting', (err as Error).message)
    }
  }

  if (settings.loading && !settings.data) {
    return (
      <div className="flex flex-1">
        <LoadingRow label="Loading settings…" />
      </div>
    )
  }
  if (settings.error) {
    return (
      <div className="flex flex-1 p-5">
        <ErrorNote message={settings.error} onRetry={settings.reload} />
      </div>
    )
  }

  return (
    <div className="flex min-h-0 flex-1 overflow-hidden">
      <aside className="w-[210px] shrink-0 border-r border-line p-2.5">
        {SECTIONS.map((s) => {
          const Icon = s.icon
          return (
            <button
              key={s.id}
              onClick={() => setSection(s.id)}
              className={cn(
                'mb-0.5 flex w-full items-center gap-2.5 rounded-md px-2.5 py-[7px] text-[12.5px] transition-colors',
                section === s.id ? 'bg-panel2 text-fg' : 'text-fgm hover:bg-panel2/60 hover:text-fg',
              )}
            >
              <Icon size={14} className={section === s.id ? 'text-accent' : 'text-fgf'} />
              {s.label}
            </button>
          )
        })}
      </aside>

      <div className="min-h-0 flex-1 overflow-y-auto p-5">
        <div className="mx-auto max-w-2xl">
          {section === 'general' && (
            <Section title="General" description="Behaviour of the app shell itself.">
              <SelectRow
                label="Output language"
                value={cfg.general?.language ?? 'English'}
                options={LANGUAGE_OPTIONS}
                onChange={(v) => patchLocal('general', { language: v as OutputLanguage })}
              />
              <ToggleRow
                label="Minimize to tray"
                hint="Keep running in the background when the window closes."
                value={cfg.general?.minimizeToTray ?? true}
                onChange={(v) => patchLocal('general', { minimizeToTray: v })}
              />
              <ToggleRow
                label="Confirm destructive actions"
                hint="Ask before cancelling jobs, deleting projects or removing vaults. Off = act immediately."
                value={cfg.general?.confirmDestructive ?? true}
                onChange={(v) => patchLocal('general', { confirmDestructive: v })}
              />
              <ToggleRow
                label="Launch at login"
                hint="Start Fern Orchestrator when you sign in (packaged builds only)."
                value={cfg.general?.launchAtLogin ?? false}
                onChange={(v) => patchLocal('general', { launchAtLogin: v })}
              />
            </Section>
          )}

          {section === 'opencode' && (
            <Section title="OpenCode" description="How worker servers are spawned and what they may do.">
              <ToggleRow
                label="Auto-start servers"
                hint="Spin up an `opencode serve` process per workspace when a worker needs one. Off = reuse only servers you started."
                value={cfg.opencode?.autoStart ?? true}
                onChange={(v) => patchLocal('opencode', { autoStart: v })}
              />
              <NumberRow
                label="Server startup timeout (seconds)"
                hint="How long a server may take to answer /global/health."
                value={Math.round((cfg.opencode?.serverTimeoutMs ?? 60_000) / 1000)}
                min={5}
                max={600}
                onChange={(v) => patchLocal('opencode', { serverTimeoutMs: v * 1000 })}
              />
              <NumberRow
                label="Max servers"
                hint="Oldest idle server is stopped first when the limit is hit."
                value={cfg.opencode?.maxServers ?? 6}
                min={1}
                max={16}
                onChange={(v) => patchLocal('opencode', { maxServers: v })}
              />
              <ToggleRow
                label="Permission rules for workers"
                hint="Inject the git commit/push approval rules into every server. Off = workers run with allow-everything."
                value={cfg.opencode?.enableApprovalPlugin ?? true}
                onChange={(v) => patchLocal('opencode', { enableApprovalPlugin: v })}
              />
              <TextListRow
                label="Extra server arguments"
                hint="Appended to every `opencode serve` invocation. Comma-separated."
                value={cfg.opencode?.extraArgs ?? []}
                placeholder="e.g. --experimental, --verbose"
                onChange={(v) => patchLocal('opencode', { extraArgs: v })}
              />
              <TextRow
                label="Allowed agents"
                hint="Comma-separated allow-list for worker sessions. Empty = every agent."
                value={(cfg.opencode?.allowedAgents ?? []).join(', ')}
                placeholder="build, plan, general"
                onChange={(v) => {
                  const list = v
                    .split(',')
                    .map((s) => s.trim())
                    .filter(Boolean)
                  patchLocal('opencode', { allowedAgents: list.length ? list : null })
                }}
              />
              <TextRow
                label="Worker shell"
                hint="Shell that worker bash commands run through. Empty = auto-detect (Git Bash on Windows). PowerShell 5.1 rejects `&&`, which silently breaks ordinary commands."
                value={cfg.opencode?.shell ?? ''}
                placeholder="Auto-detect"
                onChange={(v) => patchLocal('opencode', { shell: v.trim() ? v.trim() : null })}
              />
            </Section>
          )}

          {section === 'orchestration' && (
            <Section title="Orchestration" description="Budgets and defaults for the runtime.">
              <NumberRow
                label="Max concurrent workers"
                hint="How many OpenCode sessions may run at once."
                value={cfg.orchestration?.limits?.maxConcurrentWorkers ?? 4}
                min={1}
                max={64}
                onChange={(v) => patchLocal('orchestration', { limits: { ...(cfg.orchestration?.limits ?? {}), maxConcurrentWorkers: v } })}
              />
              <NumberRow
                label="Default loop count"
                hint="Loops proposed for new jobs."
                value={cfg.orchestration?.defaultLoopCount ?? 3}
                min={1}
                max={100}
                onChange={(v) => patchLocal('orchestration', { defaultLoopCount: v })}
              />
              <NumberRow
                label="Task timeout (minutes)"
                value={Math.round((cfg.orchestration?.taskTimeoutMs ?? 1_800_000) / 60_000)}
                min={1}
                max={240}
                onChange={(v) => patchLocal('orchestration', { taskTimeoutMs: v * 60_000 })}
              />
              <NumberRow
                label="Approval timeout (minutes)"
                hint="An unanswered permission request is rejected after this long, so the worker stops waiting. 0 = wait forever."
                value={Math.round((cfg.orchestration?.approvalTimeoutMs ?? 900_000) / 60_000)}
                min={0}
                max={240}
                onChange={(v) => patchLocal('orchestration', { approvalTimeoutMs: v * 60_000 })}
              />
              <ToggleRow
                label="Require plan approval"
                hint="Every new job pauses after planning until you accept the DAG."
                value={cfg.orchestration?.requirePlanApproval ?? false}
                onChange={(v) => patchLocal('orchestration', { requirePlanApproval: v })}
              />
              <ToggleRow
                label="Persist worker transcripts"
                hint="Store full session transcripts in the local database."
                value={cfg.orchestration?.persistTranscripts ?? true}
                onChange={(v) => patchLocal('orchestration', { persistTranscripts: v })}
              />
            </Section>
          )}

          {section === 'permissions' && (
            <Section title="Permission policy" description="What workers may do without asking you.">
              <SelectRow
                label="Git commit"
                value={cfg.permissions?.gitCommit ?? 'ask'}
                options={[
                  ['ask', 'Ask every time'],
                  ['allow', 'Allow automatically'],
                  ['deny', 'Never allow'],
                ]}
                onChange={(v) => patchLocal('permissions', { gitCommit: v })}
              />
              <SelectRow
                label="Git push"
                value={cfg.permissions?.gitPush ?? 'ask'}
                options={[
                  ['ask', 'Ask every time'],
                  ['allow', 'Allow automatically'],
                  ['deny', 'Never allow'],
                ]}
                onChange={(v) => patchLocal('permissions', { gitPush: v })}
              />
              <SelectRow
                label="Vault writes"
                value={cfg.permissions?.vaultWrite ?? 'allow'}
                options={[
                  ['ask', 'Ask every time'],
                  ['allow', 'Allow automatically'],
                  ['deny', 'Never allow'],
                ]}
                onChange={(v) => patchLocal('permissions', { vaultWrite: v })}
              />
              <ToggleRow
                label="Intercept chained git commands"
                hint="Block `… && git commit` style escapes through the OpenCode plugin backstop."
                value={cfg.permissions?.interceptChainedGit ?? true}
                onChange={(v) => patchLocal('permissions', { interceptChainedGit: v })}
              />
            </Section>
          )}

          {section === 'notifications' && (
            <Section title="Notifications" description="Desktop notifications for the moments that matter.">
              <ToggleRow
                label="Enabled"
                hint="Master switch — no notification is shown while this is off."
                value={cfg.notifications?.['enabled'] ?? true}
                onChange={(v) => patchLocal('notifications', { enabled: v })}
              />
              <ToggleRow
                label="Job completed"
                hint="Notifies on job.completed."
                value={cfg.notifications?.['onJobCompleted'] ?? true}
                onChange={(v) => patchLocal('notifications', { onJobCompleted: v })}
              />
              <ToggleRow
                label="Job failed"
                hint="Notifies on job.failed."
                value={cfg.notifications?.['onJobFailed'] ?? true}
                onChange={(v) => patchLocal('notifications', { onJobFailed: v })}
              />
              <ToggleRow
                label="Approval requested"
                hint="Notifies when a plan or permission needs your decision."
                value={cfg.notifications?.['onApprovalRequested'] ?? true}
                onChange={(v) => patchLocal('notifications', { onApprovalRequested: v })}
              />
              <ToggleRow
                label="Worker failed or lost"
                hint="Notifies on worker.failed and lost OpenCode sessions."
                value={cfg.notifications?.['onWorkerStuck'] ?? false}
                onChange={(v) => patchLocal('notifications', { onWorkerStuck: v })}
              />
              <ToggleRow
                label="Provider unhealthy"
                hint="Notifies when a provider fails or its health changes."
                value={cfg.notifications?.['onProviderUnhealthy'] ?? false}
                onChange={(v) => patchLocal('notifications', { onProviderUnhealthy: v })}
              />
            </Section>
          )}

          {section === 'obsidian' && (
            <Section title="Knowledge" description="How Obsidian vaults are watched and searched.">
              <ToggleRow
                label="Watch vaults"
                hint="Re-index notes automatically when files change on disk."
                value={cfg.obsidian?.watch ?? true}
                onChange={(v) => patchLocal('obsidian', { watch: v })}
              />
              <NumberRow
                label="Watch debounce (ms)"
                hint="Quiet period before a changed note is re-indexed."
                value={cfg.obsidian?.debounceMs ?? 400}
                min={50}
                max={5000}
                onChange={(v) => patchLocal('obsidian', { debounceMs: v })}
              />
              <NumberRow
                label="Search result limit"
                hint="Notes returned per search query."
                value={cfg.obsidian?.searchLimit ?? 50}
                min={10}
                max={500}
                onChange={(v) => patchLocal('obsidian', { searchLimit: v })}
              />
            </Section>
          )}

          {section === 'appearance' && (
            <Section title="Appearance" description="The app is dark by default; the accent colour and motion are yours to pick.">
              <SelectRow
                label="Accent"
                value={cfg.appearance?.accent ?? 'neutral'}
                options={[
                  ['neutral', 'Default (emerald)'],
                  ['blue', 'Blue'],
                  ['green', 'Green'],
                  ['amber', 'Amber'],
                ]}
                onChange={(v) => patchLocal('appearance', { accent: v })}
              />
              <ToggleRow
                label="Reduce motion"
                hint="Disables transitions, pulses and animated placeholders."
                value={cfg.appearance?.reduceMotion ?? false}
                onChange={(v) => patchLocal('appearance', { reduceMotion: v })}
              />
            </Section>
          )}

          {section === 'diagnostics' && (
            <>
            <Section title="Diagnostics" description="Logging and troubleshooting.">
              <SelectRow
                label="Log level"
                value={cfg.diagnostics?.logLevel ?? 'info'}
                options={[
                  ['debug', 'Debug'],
                  ['info', 'Info'],
                  ['warn', 'Warnings'],
                  ['error', 'Errors only'],
                ]}
                onChange={(v) => patchLocal('diagnostics', { logLevel: v })}
              />
              <ToggleRow
                label="Diagnostic mode"
                hint="Log provider and OpenCode payloads (secrets are redacted)."
                value={cfg.diagnostics?.diagnosticMode ?? false}
                onChange={(v) => patchLocal('diagnostics', { diagnosticMode: v })}
              />
              <NumberRow
                label="Retain logs (days)"
                value={cfg.diagnostics?.retainLogDays ?? 14}
                min={1}
                max={365}
                onChange={(v) => patchLocal('diagnostics', { retainLogDays: v })}
              />
            </Section>

            <Section title="Harness" description="Probe every subsystem with a live health check, then run the real pipeline end-to-end in an isolated sandbox.">
              <HarnessPanel />
            </Section>
            </>
          )}

          {section === 'about' && (
            <>
              <Section title="About" description="Build and runtime information.">
                <div className="grid grid-cols-2 gap-px overflow-hidden rounded-lg bg-line/60">
                  {[
                    ['App', `${info.data?.name ?? 'Fern Orchestrator'} ${info.data?.version ?? ''}`],
                    ['Platform', info.data?.platform ?? '—'],
                    ['Locale', info.data?.locale ?? '—'],
                    ['Uptime', info.data ? `${Math.round(info.data.uptimeMs / 1000)}s` : '—'],
                    ['Data dir', info.data?.userDataPath ?? '—'],
                    ['Onboarding', onboarding.data?.complete ? 'complete' : 'pending'],
                  ].map(([k, v]) => (
                    <div key={k} className="bg-panel px-3 py-2.5">
                      <div className="stack-title">{k}</div>
                      <div className="mono mt-0.5 truncate text-[11.5px] text-fg" title={String(v)}>
                        {v}
                      </div>
                    </div>
                  ))}
                </div>
              </Section>

              <Section title="Service health" description="Last probe of every local dependency.">
                <div className="space-y-1.5">
                  {(health.data ?? []).map((h) => (
                    <div key={h.name} className="flex items-center gap-2.5 rounded-md border border-line px-3 py-2">
                      <Pill tone={h.healthy ? 'ok' : 'danger'}>{h.name}</Pill>
                      <span className="min-w-0 flex-1 truncate text-[12px] text-fgm">{h.message}</span>
                      {!h.healthy && h.lastError && <span className="truncate text-[11px] text-danger">{h.lastError}</span>}
                    </div>
                  ))}
                  {!health.data && <div className="text-[12px] text-fgf">Checking…</div>}
                </div>
              </Section>

              <Section title="Maintenance" description="Safe resets that never touch your data.">
                <div className="flex flex-wrap gap-2">
                  <Button onClick={() => setResetOpen(true)}>
                    <RotateCcw size={13} /> Reset built-in agent profiles
                  </Button>
                  <Button onClick={() => { settings.reload(); onboarding.reload(); health.reload() }}>
                    Refresh state
                  </Button>
                </div>
                <div className="mt-3 text-[11.5px] leading-relaxed text-fgf">
                  Custom profiles you edited are kept. Templates: {templates.data?.length ?? 0} stored.
                </div>
                {(templates.data ?? []).length > 0 && (
                  <div className="mt-2 flex flex-wrap gap-1.5">
                    {(templates.data ?? []).map((t) => (
                      <button key={t.id} className="pill pill-muted" onClick={() => setTemplateOpen({ id: t.id, name: t.name, body: t.body })}>
                        {t.name}
                      </button>
                    ))}
                  </div>
                )}
              </Section>

              <Section title="Onboarding" description="Re-run or skip the first-run checklist.">
                <div className="space-y-1.5 text-[12.5px]">
                  {onboarding.data && [
                    ['OpenCode binary', onboarding.data.opencode.detected, onboarding.data.opencode.version ?? 'not found'],
                    ['Git binary', onboarding.data.git.detected, onboarding.data.git.version ?? 'not found'],
                    ['Providers', onboarding.data.providers.configured > 0, `${onboarding.data.providers.configured} configured · ${onboarding.data.providers.healthy} healthy`],
                    ['Vault', onboarding.data.vault.configured, onboarding.data.vault.configured ? `${onboarding.data.vault.noteCount} notes` : 'not configured'],
                    ['Projects', onboarding.data.projects.registered > 0, `${onboarding.data.projects.registered} registered`],
                  ].map(([label, ok, detail]) => (
                    <div key={String(label)} className="flex items-center gap-2.5">
                      <Pill tone={ok ? 'ok' : 'warn'}>{ok ? 'ok' : 'todo'}</Pill>
                      <span className="text-fgm">{String(label)}</span>
                      <span className="mono text-fgf">{String(detail)}</span>
                    </div>
                  ))}
                </div>
                <div className="mt-3">
                  <Button
                    onClick={async () => {
                      try {
                        await call('app.finishOnboarding', {})
                        toast.success('Onboarding marked complete')
                        onboarding.reload()
                      } catch (err) {
                        toast.error('Failed', (err as Error).message)
                      }
                    }}
                  >
                    Mark onboarding complete
                  </Button>
                </div>
              </Section>
            </>
          )}
        </div>
      </div>

      <ConfirmDialog
        open={resetOpen}
        onOpenChange={setResetOpen}
        title="Reset built-in profiles?"
        message="Curated agent profiles (refiner, planner, coder, reviewers…) are restored to factory definitions. Your custom profiles stay."
        confirmLabel="Reset"
        pending={false}
        onConfirm={async () => {
          try {
            await call('agents.resetBuiltins')
            toast.success('Built-ins restored')
            agents.reload()
          } catch (err) {
            toast.error('Reset failed', (err as Error).message)
          }
          setResetOpen(false)
        }}
      />

      <Modal
        open={!!templateOpen}
        onOpenChange={(v) => !v && setTemplateOpen(null)}
        title={templateOpen?.name ?? 'Template'}
        width="max-w-2xl"
        footer={
          <Button onClick={() => setTemplateOpen(null)}>Close</Button>
        }
      >
        <pre className="mono max-h-96 overflow-auto whitespace-pre-wrap rounded-md border border-line bg-app p-3 text-[11.5px] leading-relaxed text-fgm">
          {JSON.stringify(templateOpen?.body ?? {}, null, 2)}
        </pre>
      </Modal>
    </div>
  )
}

/* ------------------------------------------------------------- primitives */

/** Harness health check + self-test controls (Diagnostics → Harness). */
function HarnessPanel() {
  const [health, setHealth] = useState<HarnessHealthReport | null>(null)
  const [selfTest, setSelfTest] = useState<HarnessSelfTestReport | null>(null)
  const [busy, setBusy] = useState<'health' | 'selfTest' | null>(null)

  const tone = (status: HarnessStatus): PillTone => (status === 'pass' ? 'ok' : status === 'fail' ? 'danger' : 'warn')

  async function runHealth() {
    setBusy('health')
    setHealth(null)
    try {
      setHealth(await call('harness.health'))
    } catch (err) {
      toast.error('Health check failed', (err as Error).message)
    } finally {
      setBusy(null)
    }
  }

  async function runSelfTest() {
    setBusy('selfTest')
    setSelfTest(null)
    try {
      setSelfTest(await call('harness.selfTest', { mode: 'selfTest' }))
    } catch (err) {
      toast.error('Self-test failed', (err as Error).message)
    } finally {
      setBusy(null)
    }
  }

  async function cancelSelfTest() {
    try {
      const cancelling = await call('harness.selfTestCancel')
      if (cancelling) toast.info('Cancelling self-test…')
      else toast.warn('Nothing to cancel')
    } catch (err) {
      toast.error('Cancel failed', (err as Error).message)
    }
  }

  return (
    <div className="py-2.5">
      <div className="flex flex-wrap gap-2">
        <Button onClick={runHealth} disabled={busy !== null}>
          {busy === 'health' ? <Spinner size={13} /> : <Stethoscope size={13} />} Run health check
        </Button>
        <Button onClick={runSelfTest} disabled={busy !== null}>
          {busy === 'selfTest' ? <Spinner size={13} /> : <PlayCircle size={13} />} Run self-test
        </Button>
        {busy === 'selfTest' && (
          <Button variant="danger" onClick={cancelSelfTest}>
            Cancel
          </Button>
        )}
      </div>

      {health && (
        <div className="mt-3 space-y-1.5">
          <div className="flex items-center gap-2">
            <span className="text-[12.5px] font-medium text-fg">Health check</span>
            <Pill tone={tone(health.status)}>{health.status}</Pill>
            <span className="mono text-[11px] text-fgf">
              {health.durationMs}ms · {health.components.length} components
            </span>
          </div>
          {health.components.map((c) => (
            <div key={c.name} className="flex items-start gap-2.5 rounded-md border border-line px-3 py-2">
              <Pill tone={tone(c.status)}>{c.status}</Pill>
              <span className="mono w-36 shrink-0 text-[11.5px] text-fg">{c.name}</span>
              <span className="min-w-0 flex-1 text-[11.5px] leading-snug text-fgm">{c.reason}</span>
              <span className="mono shrink-0 text-[10.5px] text-fgf">{c.durationMs}ms</span>
            </div>
          ))}
        </div>
      )}

      {selfTest && (
        <div className="mt-3 space-y-1.5">
          <div className="flex items-center gap-2">
            <span className="text-[12.5px] font-medium text-fg">Self-test ({selfTest.mode})</span>
            <Pill tone={tone(selfTest.status)}>{selfTest.status}</Pill>
            <span className="mono text-[11px] text-fgf">{selfTest.durationMs}ms</span>
          </div>
          <div className="text-[11.5px] leading-snug text-fgm">{selfTest.reason}</div>
          <div className="space-y-1">
            {selfTest.steps.map((step, i) => (
              <div key={`${step.name}-${i}`} className="flex items-start gap-2.5">
                <Pill tone={tone(step.status)}>{step.status}</Pill>
                <span className="mono w-28 shrink-0 text-[11.5px] text-fg">{step.name}</span>
                <span className="min-w-0 flex-1 text-[11.5px] leading-snug text-fgm">{step.reason}</span>
              </div>
            ))}
          </div>
          {selfTest.invariants && (
            <div className="rounded-md border border-line px-3 py-2">
              <div className="stack-title">Invariants</div>
              <div className="mt-1.5 space-y-1">
                {Object.entries(selfTest.invariants).map(([name, check]) => (
                  <div key={name} className="flex items-start gap-2.5">
                    <Pill tone={tone(check.status)}>{check.status}</Pill>
                    <span className="mono w-36 shrink-0 text-[11.5px] text-fg">{name}</span>
                    <span className="min-w-0 flex-1 text-[11.5px] leading-snug text-fgm">{check.reason}</span>
                  </div>
                ))}
              </div>
            </div>
          )}
          {selfTest.evidence && (
            <div className="text-[11.5px] leading-snug text-fgf">
              Evidence: {selfTest.evidence.workers.length} worker(s), {selfTest.evidence.tasks.length} task(s),
              {' '}
              {selfTest.evidence.artifacts.filter((a) => a.existsOnDisk).length} file artifact(s) on disk,
              {' '}
              {selfTest.evidence.taskEvents.started} task.started event(s)
            </div>
          )}
        </div>
      )}
    </div>
  )
}

function Section({ title, description, children }: { title: string; description?: string; children: React.ReactNode }) {
  return (
    <Panel className="mb-4">
      <div className="p-4">
        <div className="text-[13.5px] font-semibold text-fg">{title}</div>
        {description && <div className="mt-0.5 text-[11.5px] text-fgf">{description}</div>}
        <div className="mt-3.5 divide-y divide-line/60">{children}</div>
      </div>
    </Panel>
  )
}

function ToggleRow({ label, hint, value, onChange }: { label: string; hint?: string; value: boolean; onChange: (v: boolean) => void }) {
  return (
    <div className="flex items-start justify-between gap-4 py-2.5">
      <div className="min-w-0">
        <div className="text-[12.5px] text-fg">{label}</div>
        {hint && <div className="mt-0.5 text-[11.5px] leading-snug text-fgf">{hint}</div>}
      </div>
      <Switch checked={value} onCheckedChange={onChange} />
    </div>
  )
}

function SelectRow({ label, value, options, onChange }: { label: string; value: string; options: [string, string][]; onChange: (v: string) => void }) {
  return (
    <div className="flex items-center justify-between gap-4 py-2.5">
      <div className="text-[12.5px] text-fg">{label}</div>
      <Select value={value} onChange={(e) => onChange(e.target.value)} className="w-52 text-[12.5px]">
        {options.map(([v, l]) => (
          <option key={v} value={v}>
            {l}
          </option>
        ))}
      </Select>
    </div>
  )
}

function NumberRow({ label, hint, value, min, max, onChange }: { label: string; hint?: string; value: number; min: number; max: number; onChange: (v: number) => void }) {
  const [local, setLocal] = useState(String(value))
  const [saving, setSaving] = useState(false)

  useEffect(() => setLocal(String(value)), [value])

  async function commit() {
    const n = Number(local)
    if (!Number.isFinite(n) || n === value) return
    setSaving(true)
    onChange(Math.min(max, Math.max(min, Math.round(n))))
    setTimeout(() => setSaving(false), 300)
  }

  return (
    <div className="flex items-start justify-between gap-4 py-2.5">
      <div className="min-w-0">
        <div className="text-[12.5px] text-fg">{label}</div>
        {hint && <div className="mt-0.5 text-[11.5px] leading-snug text-fgf">{hint}</div>}
      </div>
      <div className="flex items-center gap-2">
        {saving && <Spinner size={12} />}
        <input
          className="input w-24 text-right text-[12.5px]"
          type="number"
          min={min}
          max={max}
          value={local}
          onChange={(e) => setLocal(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => e.key === 'Enter' && commit()}
        />
      </div>
    </div>
  )
}

/** Free-text setting; commits on blur/Enter like NumberRow. */
function TextRow({ label, hint, value, placeholder, onChange }: { label: string; hint?: string; value: string; placeholder?: string; onChange: (v: string) => void }) {
  const [local, setLocal] = useState(value)
  useEffect(() => setLocal(value), [value])

  function commit() {
    if (local === value) return
    onChange(local)
  }

  return (
    <div className="flex items-start justify-between gap-4 py-2.5">
      <div className="min-w-0">
        <div className="text-[12.5px] text-fg">{label}</div>
        {hint && <div className="mt-0.5 text-[11.5px] leading-snug text-fgf">{hint}</div>}
      </div>
      <input
        className="input w-60 text-[12.5px]"
        type="text"
        placeholder={placeholder}
        value={local}
        onChange={(e) => setLocal(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => e.key === 'Enter' && commit()}
      />
    </div>
  )
}

/** Comma-separated list setting; emits a clean `string[]`. */
function TextListRow({ label, hint, value, placeholder, onChange }: { label: string; hint?: string; value: string[]; placeholder?: string; onChange: (v: string[]) => void }) {
  return (
    <TextRow
      label={label}
      hint={hint}
      placeholder={placeholder}
      value={value.join(', ')}
      onChange={(v) => onChange(v.split(',').map((s) => s.trim()).filter(Boolean))}
    />
  )
}
