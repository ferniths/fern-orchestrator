import { useState } from 'react'
import { Plus, Zap, Trash2, RefreshCw, Route, Bot, Cpu, Eye, EyeOff } from 'lucide-react'
import type { AgentProfile, ModelRoute, ProviderConnection, ProviderType } from '@shared/domain'
import { call, useApi } from '../lib/api'
import { cn } from '../lib/format'
import type { PageProps } from '../lib/types'
import { toast } from '../state/toast'
import { Button, ConfirmDialog, ErrorNote, Field, Input, Modal, Panel, Pill, Select, Spinner, StatusPill, Switch } from '../components/ui'

const TABS = [
  { id: 'providers', label: 'Connections', icon: Cpu },
  { id: 'routes', label: 'Model routes', icon: Route },
  { id: 'agents', label: 'Agent profiles', icon: Bot },
] as const
type TabId = (typeof TABS)[number]['id']

export default function ProvidersPage(_: PageProps) {
  const [tab, setTab] = useState<TabId>('providers')
  const providers = useApi('providers.list', [], { pollMs: 30_000 })
  const routes = useApi('routes.list', [])
  const agents = useApi('agents.list', [])

  const [providerDialog, setProviderDialog] = useState<ProviderConnection | 'new' | null>(null)
  const [routeDialog, setRouteDialog] = useState<ModelRoute | 'new' | null>(null)
  const [agentDialog, setAgentDialog] = useState<AgentProfile | null>(null)
  const [deleting, setDeleting] = useState<{ kind: 'provider' | 'route' | 'agent'; id: string; label: string } | null>(null)
  const [busy, setBusy] = useState(false)

  async function remove() {
    if (!deleting) return
    setBusy(true)
    try {
      if (deleting.kind === 'provider') await call('providers.delete', deleting.id)
      else if (deleting.kind === 'route') await call('routes.delete', deleting.id)
      else await call('agents.delete', deleting.id)
      toast.success('Deleted', deleting.label)
      providers.reload()
      routes.reload()
      agents.reload()
    } catch (err) {
      toast.error('Delete failed', (err as Error).message)
    } finally {
      setBusy(false)
      setDeleting(null)
    }
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
      <div className="flex items-center gap-2 border-b border-line px-5 py-3">
        <div className="flex gap-1">
          {TABS.map((t) => {
            const Icon = t.icon
            return (
              <button
                key={t.id}
                onClick={() => setTab(t.id)}
                className={cn('tab', tab === t.id && 'tab-active')}
              >
                <Icon size={13} />
                {t.label}
              </button>
            )
          })}
        </div>
        <div className="ml-auto">
          {tab === 'providers' && (
            <button className="btn btn-primary" onClick={() => setProviderDialog('new')}>
              <Plus size={14} /> Add connection
            </button>
          )}
          {tab === 'routes' && (
            <button className="btn btn-primary" onClick={() => setRouteDialog('new')}>
              <Plus size={14} /> New route
            </button>
          )}
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto p-5">
        {tab === 'providers' && (
          <ProvidersTab
            state={providers}
            onEdit={(p) => setProviderDialog(p)}
            onDelete={(p) => setDeleting({ kind: 'provider', id: p.id, label: p.name })}
          />
        )}
        {tab === 'routes' && (
          <RoutesTab
            state={routes}
            onEdit={(r) => setRouteDialog(r)}
            onDelete={(r) => setDeleting({ kind: 'route', id: r.id, label: r.name })}
            onChanged={routes.reload}
          />
        )}
        {tab === 'agents' && <AgentsTab state={agents} onEdit={(a) => setAgentDialog(a)} />}
      </div>

      <ProviderDialog
        open={providerDialog !== null}
        provider={providerDialog === 'new' ? null : providerDialog}
        onOpenChange={(v) => !v && setProviderDialog(null)}
        onSaved={() => providers.reload()}
      />
      <RouteDialog
        open={routeDialog !== null}
        route={routeDialog === 'new' ? null : routeDialog}
        onOpenChange={(v) => !v && setRouteDialog(null)}
        onSaved={routes.reload}
      />
      <AgentDialog open={!!agentDialog} agent={agentDialog} onOpenChange={(v) => !v && setAgentDialog(null)} onSaved={agents.reload} />
      <ConfirmDialog
        open={!!deleting}
        onOpenChange={(v) => !v && setDeleting(null)}
        title={`Delete ${deleting?.label ?? ''}?`}
        message={
          deleting?.kind === 'provider'
            ? 'The stored API key is destroyed with this connection.'
            : 'This lookup entry is removed. Jobs already referencing it keep working until replanned.'
        }
        confirmLabel="Delete"
        danger
        pending={busy}
        onConfirm={remove}
      />
    </div>
  )
}

/* ---------------------------------------------------------------- providers */

type ListState<T> = { data: T[] | null; loading: boolean; error: string | null; reload: () => void }

function ProvidersTab({
  state,
  onEdit,
  onDelete,
}: {
  state: ListState<ProviderConnection>
  onEdit: (p: ProviderConnection) => void
  onDelete: (p: ProviderConnection) => void
}) {
  const [testing, setTesting] = useState<string | null>(null)
  const [models, setModels] = useState<Record<string, string[]>>({})

  async function test(p: ProviderConnection) {
    setTesting(p.id)
    try {
      const res = await call('providers.test', p.id)
      if (res.ok) toast.success(`${p.name} healthy`, `${res.models.length} models in ${res.latencyMs ?? '?'}ms`)
      else toast.error(`${p.name} failed`, res.message)
      state.reload()
    } catch (err) {
      toast.error('Test failed', (err as Error).message)
    } finally {
      setTesting(null)
    }
  }

  async function toggleModels(p: ProviderConnection) {
    if (models[p.id]) {
      setModels((m) => {
        const next = { ...m }
        delete next[p.id]
        return next
      })
      return
    }
    try {
      const list = await call('providers.models', p.id)
      setModels((m) => ({ ...m, [p.id]: list.map((x) => x.id) }))
    } catch (err) {
      toast.error('Models unavailable', (err as Error).message)
    }
  }

  if (state.loading && state.data === null) return <div className="text-[12.5px] text-fgf">Loading connections…</div>
  if (state.error) return <ErrorNote message={state.error} onRetry={state.reload} />

  const list = state.data ?? []
  if (list.length === 0) {
    return (
      <EmptyRow
        title="No model connections yet"
        description="Add 9Router or any OpenAI-compatible endpoint. The control plane uses it for refining and planning; workers use it through OpenCode."
      />
    )
  }

  return (
    <div className="grid grid-cols-1 gap-3 lg:grid-cols-2 2xl:grid-cols-3">
      {list.map((p) => (
        <Panel
          key={p.id}
          title={
            <span className="flex items-center gap-2">
              {p.name}
              <StatusPill status={p.health.status === 'healthy' ? 'healthy' : p.health.status === 'degraded' ? 'degraded' : p.health.status === 'unreachable' ? 'unhealthy' : 'pending'} />
            </span>
          }
          action={
            <div className="flex gap-1.5">
              <Button size="sm" onClick={() => test(p)} disabled={testing === p.id}>
                {testing === p.id ? <Spinner size={12} /> : <Zap size={12} />} Test
              </Button>
              <Button size="sm" variant="ghost" onClick={() => onEdit(p)}>
                Edit
              </Button>
              <Button size="sm" variant="ghost" onClick={() => onDelete(p)}>
                <Trash2 size={12} className="text-danger" />
              </Button>
            </div>
          }
        >
          <div className="flex flex-col gap-2 p-3.5">
            <div className="mono truncate text-[11.5px] text-fgf">{p.baseUrl}</div>
            <div className="flex flex-wrap gap-1.5">
              <Pill tone="accent">{p.type.replace(/_/g, ' ')}</Pill>
              {p.defaultModel && <Pill>{p.defaultModel}</Pill>}
              {p.streaming && <Pill tone="info">streaming</Pill>}
              {p.combo && <Pill tone="warn">combo {p.combo}</Pill>}
            </div>
            <div className="grid grid-cols-3 gap-px rounded-md bg-line/60 text-center">
              {[
                ['latency', p.health.latencyMs ? `${p.health.latencyMs}ms` : '—'],
                ['models', p.health.modelCount != null ? String(p.health.modelCount) : '—'],
                ['checked', p.health.checkedAt ? 'yes' : 'never'],
              ].map(([k, v]) => (
                <div key={k} className="bg-panel px-2 py-1.5">
                  <div className="text-[13px] font-semibold text-fg">{v}</div>
                  <div className="text-[10px] uppercase tracking-wide text-fgf">{k}</div>
                </div>
              ))}
            </div>
            {p.health.lastError && <div className="truncate text-[11.5px] text-danger">{p.health.lastError}</div>}
            <button className="flex items-center gap-1.5 text-[11.5px] text-fgf transition-colors hover:text-fgm" onClick={() => toggleModels(p)}>
              {models[p.id] ? <EyeOff size={12} /> : <Eye size={12} />}
              {models[p.id] ? 'Hide models' : 'List models'}
            </button>
            {models[p.id] && (
              <div className="max-h-32 overflow-y-auto rounded-md border border-line bg-app p-2">
                {models[p.id]!.length === 0 ? (
                  <div className="text-[11.5px] text-fgf">No models returned.</div>
                ) : (
                  models[p.id]!.map((id) => (
                    <div key={id} className="mono truncate py-0.5 text-[11px] text-fgm">
                      {id}
                    </div>
                  ))
                )}
              </div>
            )}
          </div>
        </Panel>
      ))}
    </div>
  )
}

function ProviderDialog({
  open,
  provider,
  onOpenChange,
  onSaved,
}: {
  open: boolean
  provider: ProviderConnection | null
  onOpenChange: (v: boolean) => void
  onSaved: () => void
}) {
  const [name, setName] = useState('')
  const [type, setType] = useState<ProviderType>('openai_compatible')
  const [baseUrl, setBaseUrl] = useState('')
  const [apiKey, setApiKey] = useState('')
  const [defaultModel, setDefaultModel] = useState('')
  const [streaming, setStreaming] = useState(true)
  const [showKey, setShowKey] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [initialized, setInitialized] = useState<string | null>(null)

  if (open && initialized !== (provider?.id ?? 'new')) {
    setInitialized(provider?.id ?? 'new')
    setName(provider?.name ?? '')
    setType(provider?.type ?? 'openai_compatible')
    setBaseUrl(provider?.baseUrl ?? 'http://127.0.0.1:20128/v1')
    setDefaultModel(provider?.defaultModel ?? '')
    setStreaming(provider?.streaming ?? true)
    setApiKey('')
    setError(null)
  }

  async function save() {
    setError(null)
    setBusy(true)
    try {
      if (provider) {
        await call('providers.update', provider.id, {
          name: name.trim(),
          type,
          baseUrl: baseUrl.trim(),
          defaultModel,
          streaming,
          ...(apiKey ? { apiKey } : {}),
        })
      } else {
        await call('providers.create', {
          name: name.trim(),
          type,
          baseUrl: baseUrl.trim(),
          defaultModel,
          streaming,
          apiKeyRef: null,
          fallbackModel: null,
          combo: null,
          customHeaders: {},
          timeoutMs: 120_000,
          maxRetries: 2,
          enabled: true,
          ...(apiKey ? { apiKey } : {}),
        })
      }
      toast.success(provider ? 'Connection updated' : 'Connection added')
      onSaved()
      onOpenChange(false)
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <Modal
      open={open}
      onOpenChange={onOpenChange}
      title={provider ? 'Edit connection' : 'Add a connection'}
      description="Keys are encrypted at rest in the OS key file and never sent to the renderer in plaintext."
      footer={
        <>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button variant="primary" disabled={busy || !name.trim() || !baseUrl.trim()} onClick={save}>
            {busy ? 'Saving…' : 'Save'}
          </Button>
        </>
      }
    >
      <Field label="Name">
        <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="9Router (local)" />
      </Field>
      <Field label="Type">
        <Select value={type} onChange={(e) => setType(e.target.value as ProviderType)}>
          <option value="openai_compatible">OpenAI-compatible</option>
          <option value="nine_router">9Router</option>
        </Select>
      </Field>
      <Field label="Base URL" hint="Include the /v1 prefix if the endpoint expects it.">
        <Input value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} placeholder="http://127.0.0.1:20128/v1" className="mono" />
      </Field>
      <Field label={provider ? 'API key (leave blank to keep)' : 'API key'}>
        <div className="flex gap-2">
          <Input
            type={showKey ? 'text' : 'password'}
            value={apiKey}
            onChange={(e) => setApiKey(e.target.value)}
            placeholder={provider ? '••••••••' : 'sk-…'}
            className="mono flex-1"
          />
          <button className="btn" type="button" onClick={() => setShowKey((v) => !v)}>
            {showKey ? <EyeOff size={13} /> : <Eye size={13} />}
          </button>
        </div>
      </Field>
      <Field label="Default model">
        <Input value={defaultModel} onChange={(e) => setDefaultModel(e.target.value)} placeholder="openai/gpt-5.1" className="mono" />
      </Field>
      <div className="flex items-center justify-between">
        <span className="text-[12.5px] text-fgm">Stream responses</span>
        <Switch checked={streaming} onCheckedChange={setStreaming} />
      </div>
      {error && <div className="mt-3"><ErrorNote message={error} /></div>}
    </Modal>
  )
}

/* ------------------------------------------------------------------ routes */

function RoutesTab({
  state,
  onEdit,
  onDelete,
  onChanged,
}: {
  state: ListState<ModelRoute>
  onEdit: (r: ModelRoute) => void
  onDelete: (r: ModelRoute) => void
  onChanged: () => void
}) {
  async function makeDefault(r: ModelRoute) {
    try {
      await call('routes.save', { ...r, isDefault: true })
      toast.success(`${r.name} is the default route`)
      onChanged()
    } catch (err) {
      toast.error('Could not set default', (err as Error).message)
    }
  }

  const list = state.data ?? []
  if (state.error) return <ErrorNote message={state.error} onRetry={state.reload} />
  if (list.length === 0) {
    return (
      <EmptyRow
        title="No model routes"
        description="A route decides which model each agent role uses. With 'automatic', every role shares the connection's default model."
      />
    )
  }

  return (
    <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
      {list.map((r) => (
        <Panel
          key={r.id}
          title={
            <span className="flex items-center gap-2">
              {r.name} {r.isDefault && <Pill tone="accent">default</Pill>}
            </span>
          }
          action={
            <div className="flex gap-1.5">
              {!r.isDefault && (
                <Button size="sm" onClick={() => makeDefault(r)}>
                  Make default
                </Button>
              )}
              <Button size="sm" variant="ghost" onClick={() => onEdit(r)}>
                Edit
              </Button>
              <Button size="sm" variant="ghost" onClick={() => onDelete(r)}>
                <Trash2 size={12} className="text-danger" />
              </Button>
            </div>
          }
        >
          <div className="p-3.5">
            <Pill tone={r.strategy === 'automatic' ? 'ok' : 'info'}>{r.strategy}</Pill>
            <div className="mt-2 text-[11.5px] text-fgf">
              {r.preferences.length === 0
                ? r.strategy === 'automatic'
                  ? 'All roles use the connection default model.'
                  : 'No per-role overrides yet.'
                : `${r.preferences.length} role overrides`}
            </div>
            <div className="mt-2 flex flex-wrap gap-1.5">
              {r.preferences.slice(0, 8).map((p) => (
                <Pill key={p.role} tone="neutral">
                  {p.role} → {p.modelId ?? 'auto'}
                </Pill>
              ))}
            </div>
          </div>
        </Panel>
      ))}
    </div>
  )
}

function RouteDialog({ open, route, onOpenChange, onSaved }: { open: boolean; route: ModelRoute | null; onOpenChange: (v: boolean) => void; onSaved: () => void }) {
  const [name, setName] = useState('')
  const [strategy, setStrategy] = useState<'automatic' | 'explicit'>('automatic')
  const [isDefault, setIsDefault] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [initialized, setInitialized] = useState<string | null>(null)

  if (open && initialized !== (route?.id ?? 'new')) {
    setInitialized(route?.id ?? 'new')
    setName(route?.name ?? '')
    setStrategy(route?.strategy ?? 'automatic')
    setIsDefault(route?.isDefault ?? false)
    setError(null)
  }

  async function save() {
    setError(null)
    setBusy(true)
    try {
      await call('routes.save', {
        ...(route ? { id: route.id, preferences: route.preferences, createdAt: route.createdAt } : { preferences: [] }),
        name: name.trim(),
        strategy,
        isDefault,
      })
      toast.success('Route saved')
      onSaved()
      onOpenChange(false)
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <Modal
      open={open}
      onOpenChange={onOpenChange}
      title={route ? 'Edit route' : 'New model route'}
      footer={
        <>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button variant="primary" disabled={busy || !name.trim()} onClick={save}>
            {busy ? 'Saving…' : 'Save'}
          </Button>
        </>
      }
    >
      <Field label="Name">
        <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="Balanced" />
      </Field>
      <Field label="Strategy">
        <Select value={strategy} onChange={(e) => setStrategy(e.target.value as 'automatic' | 'explicit')}>
          <option value="automatic">Automatic — every role uses the default model</option>
          <option value="explicit">Explicit — per-role model preferences</option>
        </Select>
      </Field>
      <div className="flex items-center justify-between">
        <span className="text-[12.5px] text-fgm">Use as default route</span>
        <Switch checked={isDefault} onCheckedChange={setIsDefault} />
      </div>
      {error && <div className="mt-3"><ErrorNote message={error} /></div>}
    </Modal>
  )
}

/* ------------------------------------------------------------------ agents */

function AgentsTab({ state, onEdit }: { state: ListState<AgentProfile>; onEdit: (a: AgentProfile) => void }) {
  const list = state.data ?? []
  if (state.error) return <ErrorNote message={state.error} onRetry={state.reload} />
  if (list.length === 0) return <EmptyRow title="No agent profiles" description="Reset the built-ins from Settings to restore the curated roles." />

  return (
    <div className="grid grid-cols-1 gap-3 lg:grid-cols-2 2xl:grid-cols-3">
      {list.map((a) => (
        <Panel
          key={a.id}
          title={
            <span className="flex items-center gap-2">
              {a.name} {a.builtIn && <Pill tone="neutral">built-in</Pill>}
            </span>
          }
          action={
            <Button size="sm" variant="ghost" onClick={() => onEdit(a)}>
              Edit
            </Button>
          }
        >
          <div className="p-3.5">
            <div className="flex flex-wrap gap-1.5">
              <Pill tone="info">{a.role}</Pill>
              {a.opencodeAgent && <Pill tone="accent">agent {a.opencodeAgent}</Pill>}
              <Pill>priority {a.priority}</Pill>
              <Pill tone={a.enabled ? 'ok' : 'neutral'}>{a.enabled ? 'enabled' : 'disabled'}</Pill>
              <Pill tone={a.outputFormat === 'text' ? 'neutral' : 'warn'}>{a.outputFormat}</Pill>
            </div>
            {a.description && <p className="mt-2 line-clamp-2 text-[11.5px] leading-relaxed text-fgf">{a.description}</p>}
            <div className="mono mt-2 text-[11px] text-fgf">timeout {Math.round(a.timeoutMs / 60_000)}m · retries {a.retryPolicy.maxAttempts}</div>
          </div>
        </Panel>
      ))}
    </div>
  )
}

function AgentDialog({ open, agent, onOpenChange, onSaved }: { open: boolean; agent: AgentProfile | null; onOpenChange: (v: boolean) => void; onSaved: () => void }) {
  const [systemPrompt, setSystemPrompt] = useState('')
  const [opencodeAgent, setOpencodeAgent] = useState('')
  const [priority, setPriority] = useState(50)
  const [enabled, setEnabled] = useState(true)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [initialized, setInitialized] = useState<string | null>(null)

  if (open && agent && initialized !== agent.id) {
    setInitialized(agent.id)
    setSystemPrompt(agent.systemPrompt)
    setOpencodeAgent(agent.opencodeAgent ?? '')
    setPriority(agent.priority)
    setEnabled(agent.enabled)
    setError(null)
  }

  async function save() {
    if (!agent) return
    setError(null)
    setBusy(true)
    try {
      await call('agents.save', {
        id: agent.id,
        createdAt: agent.createdAt,
        name: agent.name,
        role: agent.role,
        systemPrompt,
        opencodeAgent: opencodeAgent.trim() || null,
        priority,
        enabled,
      })
      toast.success('Profile saved')
      onSaved()
      onOpenChange(false)
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <Modal
      open={open}
      onOpenChange={onOpenChange}
      title={agent ? `Edit ${agent.name}` : 'Edit profile'}
      description="System prompts are injected into every worker spawned with this profile."
      width="max-w-2xl"
      footer={
        <>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button variant="primary" disabled={busy} onClick={save}>
            {busy ? 'Saving…' : 'Save'}
          </Button>
        </>
      }
    >
      {agent && (
        <>
          <div className="mb-3 flex flex-wrap gap-1.5">
            <Pill tone="info">{agent.role}</Pill>
            {agent.builtIn && <Pill>built-in</Pill>}
          </div>
          <Field label="OpenCode agent binding" hint="Leave blank to use the OpenCode default agent. Known names: build, plan, explore, general.">
            <Input value={opencodeAgent} onChange={(e) => setOpencodeAgent(e.target.value)} placeholder="build" className="mono" />
          </Field>
          <Field label={`Priority (${priority})`} hint="Higher priority profiles get the stronger models when a route is automatic.">
            <input type="range" min={0} max={100} value={priority} onChange={(e) => setPriority(Number(e.target.value))} className="w-full accent-accent" />
          </Field>
          <Field label="System prompt">
            <textarea className="textarea mono text-[11.5px]" rows={10} value={systemPrompt} onChange={(e) => setSystemPrompt(e.target.value)} />
          </Field>
          <div className="flex items-center justify-between">
            <span className="text-[12.5px] text-fgm">Enabled</span>
            <Switch checked={enabled} onCheckedChange={setEnabled} />
          </div>
          {error && <div className="mt-3"><ErrorNote message={error} /></div>}
        </>
      )}
    </Modal>
  )
}

function EmptyRow({ title, description }: { title: string; description: string }) {
  return (
    <div className="panel flex flex-col items-center gap-2 px-6 py-10 text-center">
      <div className="text-sm font-medium text-fgm">{title}</div>
      <div className="max-w-md text-[12.5px] leading-relaxed text-fgf">{description}</div>
      <RefreshCw size={14} className="mt-1 text-fgf opacity-40" />
    </div>
  )
}
