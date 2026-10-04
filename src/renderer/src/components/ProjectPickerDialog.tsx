import { useEffect, useMemo, useState } from 'react'
import { FolderGit2, FolderOpen, Search } from 'lucide-react'
import { call, useApi } from '../lib/api'
import { cn } from '../lib/format'
import { Button, Modal } from './ui'
import type { ProjectPathStatus } from '@shared/ipc'

interface Props {
  open: boolean
  onOpenChange: (v: boolean) => void
  value: string
  onSelect: (projectId: string) => void
}

/**
 * Picks the project a job runs against. Shows each project's folder and checks
 * that the folder still exists before it can be selected, so a job never starts
 * against a path that disappeared since the project was registered.
 */
export function ProjectPickerDialog({ open, onOpenChange, value, onSelect }: Props) {
  const projects = useApi('projects.list', [], { enabled: open })
  const [query, setQuery] = useState('')
  const [status, setStatus] = useState<Record<string, ProjectPathStatus>>({})

  const projectCount = projects.data?.length ?? 0

  useEffect(() => {
    if (!open) return
    let alive = true
    const list = projects.data ?? []
    void Promise.all(
      list.map(async (p) => [p.id, await call('projects.validate', p.path)] as const),
    ).then((entries) => {
      if (alive) setStatus(Object.fromEntries(entries))
    })
    return () => {
      alive = false
    }
  }, [open, projectCount, projects.data])

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase()
    const list = projects.data ?? []
    if (!q) return list
    return list.filter((p) => p.name.toLowerCase().includes(q) || p.path.toLowerCase().includes(q))
  }, [projects.data, query])

  function pick(id: string) {
    onSelect(id)
    onOpenChange(false)
    setQuery('')
  }

  const noneSelected = !value

  return (
    <Modal
      open={open}
      onOpenChange={onOpenChange}
      title="Choose a project"
      description="Workers edit the selected project folder directly. Without one, the job uses its own scratch workspace."
      width="max-w-xl"
      footer={
        <>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button variant="primary" onClick={() => pick('')}>
            Use scratch workspace
          </Button>
        </>
      }
    >
      <div className="relative">
        <Search size={14} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-fgf" />
        <input
          className="input input-icon h-[30px] w-full text-[12.5px]"
          placeholder="Filter by name or path…"
          aria-label="Filter projects"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
      </div>

      <button
        onClick={() => pick('')}
        className={cn(
          'mt-2.5 flex w-full items-center gap-3 rounded-lg border px-3 py-2.5 text-left transition-colors',
          noneSelected ? 'border-accent/50 bg-accent/10' : 'border-line hover:border-line2 hover:bg-panel2',
        )}
      >
        <FolderOpen size={16} className="shrink-0 text-fgf" />
        <div className="min-w-0 flex-1">
          <div className="text-[12.5px] font-medium text-fg">No project — scratch workspace</div>
          <div className="truncate text-[11.5px] text-fgf">A throwaway folder for this job only.</div>
        </div>
      </button>

      <div className="mt-2 flex flex-col gap-1.5">
        {visible.map((p) => {
          const s = status[p.id]
          const broken = s ? Boolean(s.message) : false
          const selected = value === p.id
          return (
            <button
              key={p.id}
              onClick={() => pick(p.id)}
              className={cn(
                'flex w-full items-center gap-3 rounded-lg border px-3 py-2.5 text-left transition-colors',
                selected ? 'border-accent/50 bg-accent/10' : 'border-line hover:border-line2 hover:bg-panel2',
                broken && 'border-warn/40',
              )}
            >
              <FolderGit2 size={16} className={cn('shrink-0', broken ? 'text-warn' : 'text-fgf')} />
              <div className="min-w-0 flex-1">
                <div className="truncate text-[12.5px] font-medium text-fg">{p.name}</div>
                <div className="mono truncate text-[11px] text-fgf">{p.path}</div>
              </div>
              {s && (
                <span className={cn('shrink-0 text-[11px]', broken ? 'text-warn' : 'text-ok')}>
                  {broken ? s.message : s.isGitRepo ? 'git' : 'ready'}
                </span>
              )}
            </button>
          )
        })}

        {!projects.loading && visible.length === 0 && (
          <div className="rounded-lg border border-dashed border-line px-3 py-6 text-center text-[12.5px] text-fgf">
            {query ? 'No project matches that filter.' : 'No projects registered yet — add one under Projects.'}
          </div>
        )}
        {projects.error && <div className="text-[12.5px] text-danger">{projects.error}</div>}
      </div>
    </Modal>
  )
}
