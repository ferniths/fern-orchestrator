import { useState } from 'react'
import { FolderGit2, Plus, RefreshCw, Search, ExternalLink, Trash2 } from 'lucide-react'
import type { Project } from '@shared/domain'
import { call, useApi } from '../lib/api'
import { cn, timeAgo } from '../lib/format'
import type { PageProps } from '../lib/types'
import { toast } from '../state/toast'
import { Button, ConfirmDialog, EmptyState, ErrorNote, Field, LoadingRow, Modal, Pill, Select } from '../components/ui'

const STRATEGIES = [
  { value: 'shared', label: 'Shared tree', hint: 'All workers share the main working tree.' },
  { value: 'sequential_main', label: 'Sequential', hint: 'One worker at a time on the main tree.' },
  { value: 'worktree_per_worker', label: 'Worktree / worker', hint: 'Each worker gets an isolated git worktree.' },
  { value: 'worktree_per_task', label: 'Worktree / task', hint: 'Maximum isolation; more git overhead.' },
] as const

export default function ProjectsPage(_: PageProps) {
  const projects = useApi('projects.list', [])
  const [dialog, setDialog] = useState(false)
  const [discoverOpen, setDiscoverOpen] = useState(false)
  const [deleting, setDeleting] = useState<Project | null>(null)
  const [busy, setBusy] = useState(false)

  const list = projects.data ?? []

  async function remove() {
    if (!deleting) return
    setBusy(true)
    try {
      await call('projects.delete', deleting.id)
      toast.success('Project removed', deleting.name)
      projects.reload()
    } catch (err) {
      toast.error('Delete failed', (err as Error).message)
    } finally {
      setBusy(false)
      setDeleting(null)
    }
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-y-auto">
      <div className="flex items-center gap-2.5 border-b border-line px-5 py-3">
        <div className="flex items-center gap-2 text-[13px] text-fgm">
          <FolderGit2 size={14} className="text-fgf" />
          {list.length} registered project{list.length === 1 ? '' : 's'}
        </div>
        <div className="ml-auto flex gap-2">
          <button className="btn btn-sm" onClick={() => setDiscoverOpen(true)}>
            <Search size={13} /> Discover
          </button>
          <button className="btn btn-primary" onClick={() => setDialog(true)}>
            <Plus size={14} /> Register project
          </button>
        </div>
      </div>

      <div className="p-5">
        {projects.loading && list.length === 0 ? (
          <LoadingRow />
        ) : projects.error ? (
          <ErrorNote message={projects.error} onRetry={projects.reload} />
        ) : list.length === 0 ? (
          <EmptyState
            icon={<FolderGit2 size={22} />}
            title="No projects yet"
            description="Register a repository so workers can edit files, run tests and commit with approval gates."
            action={
              <button className="btn btn-primary" onClick={() => setDialog(true)}>
                <Plus size={14} /> Register a repository
              </button>
            }
          />
        ) : (
          <div className="grid grid-cols-1 gap-3 lg:grid-cols-2 2xl:grid-cols-3">
            {list.map((p) => (
              <ProjectCard key={p.id} project={p} onChanged={projects.reload} onDelete={() => setDeleting(p)} />
            ))}
          </div>
        )}
      </div>

      <RegisterProjectDialog open={dialog} onOpenChange={setDialog} onSaved={projects.reload} />
      <DiscoverDialog open={discoverOpen} onOpenChange={setDiscoverOpen} onRegister={projects.reload} />
      <ConfirmDialog
        open={!!deleting}
        onOpenChange={(v) => !v && setDeleting(null)}
        title={`Remove ${deleting?.name ?? ''}?`}
        message="The project row is deleted from Fern Orchestrator. The repository on disk is untouched."
        confirmLabel="Remove"
        danger
        pending={busy}
        onConfirm={remove}
      />
    </div>
  )
}

function ProjectCard({ project, onChanged, onDelete }: { project: Project; onChanged: () => void; onDelete: () => void }) {
  const status = useApi('projects.gitStatus', [project.id], { pollMs: 15_000 })
  const s = status.data
  const dirty = s ? s.staged.length + s.unstaged.length + s.untracked.length : 0

  return (
    <div className="panel flex flex-col gap-2.5 p-3.5">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="truncate text-[13.5px] font-semibold text-fg">{project.name}</div>
          <div className="mono mt-0.5 truncate text-[11px] text-fgf">{project.path}</div>
        </div>
        <div className="flex shrink-0 gap-1.5">
          <button className="btn btn-sm btn-ghost" title="Reveal in folder" onClick={() => call('app.revealInFolder', project.path)}>
            <ExternalLink size={13} />
          </button>
          <button className="btn btn-sm btn-ghost" title="Remove" onClick={onDelete}>
            <Trash2 size={13} className="text-danger" />
          </button>
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-1.5">
        <Pill>{project.workspaceStrategy.replace(/_/g, ' ')}</Pill>
        {project.vaultId ? <Pill tone="info">vault linked</Pill> : <Pill tone="neutral">no vault</Pill>}
        {project.enabled ? <Pill tone="ok">enabled</Pill> : <Pill tone="neutral">disabled</Pill>}
        {project.defaultModel && <Pill tone="accent">{project.defaultModel}</Pill>}
      </div>

      {s && s.isRepo ? (
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-md border border-line bg-panel2/50 px-2.5 py-2 text-[11.5px]">
          <Pill tone="info">{s.branch ?? 'detached'}</Pill>
          <span className="text-fgf">
            {s.staged.length} staged · {s.unstaged.length} unstaged · {s.untracked.length} untracked
          </span>
          {dirty > 0 && <Pill tone="warn">{dirty} dirty</Pill>}
          {!s.hasIdentity && <Pill tone="danger">no git identity</Pill>}
        </div>
      ) : (
        <div className="rounded-md border border-warn/30 bg-warn/5 px-2.5 py-2 text-[11.5px] text-warn">
          {status.loading ? 'Checking git…' : s?.isRepo === false ? 'Not a git repository' : 'Git status unavailable'}
        </div>
      )}

      {project.instructions && <p className="line-clamp-3 text-[11.5px] leading-relaxed text-fgf">{project.instructions}</p>}
      <div className="mt-auto flex items-center justify-between text-[11px] text-fgf">
        <span>opened {timeAgo(project.lastOpenedAt)}</span>
        <button className="text-fgf transition-colors hover:text-fgm" onClick={() => { onChanged(); status.reload() }}>
          <RefreshCw size={12} />
        </button>
      </div>
    </div>
  )
}

function RegisterProjectDialog({ open, onOpenChange, onSaved }: { open: boolean; onOpenChange: (v: boolean) => void; onSaved: () => void }) {
  const [name, setName] = useState('')
  const [path, setPath] = useState('')
  const [strategy, setStrategy] = useState<string>('shared')
  const [description, setDescription] = useState('')
  const [instructions, setInstructions] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function chooseDir() {
    const dir = await window.fern.invoke('app.chooseDirectory', { title: 'Select a project folder' })
    if (dir.ok && dir.data) {
      setPath(dir.data)
      if (!name) setName(dir.data.split(/[\\/]/).filter(Boolean).pop() ?? '')
    }
  }

  async function save() {
    setError(null)
    setBusy(true)
    try {
      await call('projects.create', {
        name: name.trim() || path.split(/[\\/]/).filter(Boolean).pop() || 'Project',
        path: path.trim(),
        workspaceStrategy: strategy as Project['workspaceStrategy'],
        description: description.trim(),
        instructions: instructions.trim(),
      })
      toast.success('Project registered', name || path)
      onSaved()
      onOpenChange(false)
      setName('')
      setPath('')
      setDescription('')
      setInstructions('')
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
      title="Register a project"
      description="Workers get access to this folder for the duration of a job."
      footer={
        <>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button variant="primary" disabled={busy || !path.trim()} onClick={save}>
            {busy ? 'Saving…' : 'Register'}
          </Button>
        </>
      }
    >
      <Field label="Path">
        <div className="flex gap-2">
          <input className="input flex-1" value={path} onChange={(e) => setPath(e.target.value)} placeholder="C:\repos\my-project" />
          <button className="btn" onClick={chooseDir} type="button">
            Browse…
          </button>
        </div>
      </Field>
      <Field label="Display name">
        <input className="input" value={name} onChange={(e) => setName(e.target.value)} placeholder="My project" />
      </Field>
      <Field label="Workspace strategy" hint="How parallel workers share (or isolate) the working tree.">
        <Select value={strategy} onChange={(e) => setStrategy(e.target.value)}>
          {STRATEGIES.map((s) => (
            <option key={s.value} value={s.value}>
              {s.label}
            </option>
          ))}
        </Select>
      </Field>
      <div className="mt-1 flex flex-wrap gap-1.5">
        {STRATEGIES.filter((s) => s.value === strategy).map((s) => (
          <span key={s.value} className="text-[11.5px] text-fgf">
            {s.hint}
          </span>
        ))}
      </div>
      <Field label="Description">
        <input className="input" value={description} onChange={(e) => setDescription(e.target.value)} placeholder="What this repo is" />
      </Field>
      <Field label="Standing instructions" hint="Injected into every worker's prompt for this project.">
        <textarea
          className={cn('textarea')}
          rows={4}
          value={instructions}
          onChange={(e) => setInstructions(e.target.value)}
          placeholder={'e.g.\nRun `npm test` before claiming a task is done.\nNever touch files under vendor/.'}
        />
      </Field>
      {error && <ErrorNote message={error} />}
    </Modal>
  )
}

function DiscoverDialog({ open, onOpenChange, onRegister }: { open: boolean; onOpenChange: (v: boolean) => void; onRegister: () => void }) {
  const [roots, setRoots] = useState<string[]>([])
  const [busy, setBusy] = useState(false)
  const [candidates, setCandidates] = useState<{ path: string; registered: boolean }[] | null>(null)

  async function chooseRoot() {
    const dir = await window.fern.invoke('app.chooseDirectory', { title: 'Folder to scan for repositories' })
    if (dir.ok && dir.data && !roots.includes(dir.data)) setRoots((r) => [...r, dir.data!])
  }

  async function scan() {
    setBusy(true)
    try {
      const res = await call('projects.discover', roots.length ? { roots } : {})
      setCandidates(res)
    } catch (err) {
      toast.error('Scan failed', (err as Error).message)
    } finally {
      setBusy(false)
    }
  }

  async function register(path: string) {
    try {
      await call('projects.create', { name: path.split(/[\\/]/).filter(Boolean).pop() ?? 'Project', path })
      toast.success('Registered', path)
      setCandidates((c) => c?.map((x) => (x.path === path ? { ...x, registered: true } : x)) ?? null)
      onRegister()
    } catch (err) {
      toast.error('Register failed', (err as Error).message)
    }
  }

  return (
    <Modal
      open={open}
      onOpenChange={onOpenChange}
      title="Discover repositories"
      description="Scan folders for git repositories and register them in one click."
      width="max-w-2xl"
      footer={
        <>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Close
          </Button>
          <Button variant="primary" disabled={busy} onClick={scan}>
            {busy ? 'Scanning…' : 'Scan'}
          </Button>
        </>
      }
    >
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <Button size="sm" onClick={chooseRoot}>
          <Plus size={13} /> Add root
        </Button>
        {roots.map((r) => (
          <Pill key={r} className="mono">
            {r}
          </Pill>
        ))}
        {roots.length === 0 && <span className="text-[11.5px] text-fgf">No roots chosen — uses the platform default locations.</span>}
      </div>

      {candidates === null ? (
        <div className="py-6 text-center text-[12.5px] text-fgf">Run a scan to see candidates.</div>
      ) : candidates.length === 0 ? (
        <div className="py-6 text-center text-[12.5px] text-fgf">No repositories found under the selected roots.</div>
      ) : (
        <div className="max-h-72 space-y-1.5 overflow-y-auto">
          {candidates.map((c) => (
            <div key={c.path} className="flex items-center gap-3 rounded-md border border-line px-3 py-2">
              <div className="min-w-0 flex-1">
                <div className="truncate text-[12.5px] text-fg">{c.path.split(/[\\/]/).filter(Boolean).pop()}</div>
                <div className="mono truncate text-[11px] text-fgf">{c.path}</div>
              </div>
              {c.registered ? (
                <Pill tone="ok">registered</Pill>
              ) : (
                <Button size="sm" onClick={() => register(c.path)}>
                  Register
                </Button>
              )}
            </div>
          ))}
        </div>
      )}
    </Modal>
  )
}
