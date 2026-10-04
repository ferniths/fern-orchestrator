import { Command } from 'cmdk'
import { Plus, Terminal, ListChecks, Search } from 'lucide-react'
import { call, useApi } from '../lib/api'
import { NAV } from '../lib/nav'
import { useRouter } from '../state/router'
import { toast } from '../state/toast'

const ITEM_CLASS =
  'flex cursor-pointer items-center gap-2.5 rounded-md px-2.5 py-2 text-[12.5px] text-fgm outline-none transition-colors data-[selected=true]:bg-panel2 data-[selected=true]:text-fg'

const GROUP_CLASS =
  'overflow-hidden p-1 [&_[cmdk-group-heading]]:px-2.5 [&_[cmdk-group-heading]]:pb-1 [&_[cmdk-group-heading]]:pt-2 [&_[cmdk-group-heading]]:text-[10.5px] [&_[cmdk-group-heading]]:font-semibold [&_[cmdk-group-heading]]:tracking-wider [&_[cmdk-group-heading]]:text-fgf [&_[cmdk-group-heading]]:uppercase'

export function CommandPalette({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const navigate = useRouter((s) => s.navigate)
  const jobs = useApi('jobs.list', [{ limit: 100 }], { enabled: open })

  const activeJobs = (jobs.data ?? [])
    .filter((item) => !['completed', 'failed', 'cancelled'].includes(item.job.status))
    .slice(0, 8)

  function go(path: string) {
    onOpenChange(false)
    navigate(path)
  }

  async function detectOpencode() {
    onOpenChange(false)
    try {
      const res = await call('opencode.detect')
      navigate('/opencode')
      if (res.detected) toast.success('OpenCode detected', `${res.version ?? ''}${res.path ? ` · ${res.path}` : ''}`.trim())
      else toast.warn('OpenCode not found', 'Install it or set the binary path in Settings.')
    } catch (err) {
      toast.error('Detect failed', (err as Error).message)
    }
  }

  return (
    <Command.Dialog
      open={open}
      onOpenChange={onOpenChange}
      label="Command palette"
      loop
      overlayClassName="fx-in-fade fixed inset-0 z-40 bg-black/65 backdrop-blur-[2px]"
      contentClassName="fx-in-pop fixed left-1/2 top-[16vh] z-50 w-[min(560px,calc(100vw-32px))] -translate-x-1/2 overflow-hidden rounded-xl border border-line2 bg-panel shadow-2xl shadow-black/60"
      className="flex flex-col overflow-hidden"
    >
      <div className="flex items-center gap-2.5 border-b border-line px-3.5">
        <Search size={14} className="shrink-0 text-fgf" />
        <Command.Input
          placeholder="Type a command or search…"
          className="h-11 w-full bg-transparent text-[13px] text-fg outline-none placeholder:text-fgf"
        />
        <span className="mono shrink-0 rounded border border-line2 px-1.5 py-0.5 text-[10px] text-fgf">esc</span>
      </div>

      <Command.List className="max-h-[52vh] overflow-y-auto py-1.5">
        <Command.Empty className="px-3.5 py-6 text-center text-[12.5px] text-fgf">No results found.</Command.Empty>

        <Command.Group heading="Navigate" className={GROUP_CLASS}>
          {NAV.map((item) => {
            const Icon = item.icon
            return (
              <Command.Item key={item.path} value={`go ${item.label} ${item.path}`} onSelect={() => go(item.path)} className={ITEM_CLASS}>
                <Icon size={14} className="text-fgf" />
                <span className="flex-1 text-left">{item.label}</span>
                <span className="mono text-[10.5px] text-fgf">{item.path}</span>
              </Command.Item>
            )
          })}
        </Command.Group>

        <Command.Group heading="Actions" className={GROUP_CLASS}>
          <Command.Item value="new job create start" onSelect={() => go('/new')} className={ITEM_CLASS}>
            <Plus size={14} className="text-fgf" />
            <span className="flex-1 text-left">New job</span>
            <span className="mono text-[10.5px] text-fgf">/new</span>
          </Command.Item>
          <Command.Item value="detect opencode binary version" onSelect={() => void detectOpencode()} className={ITEM_CLASS}>
            <Terminal size={14} className="text-fgf" />
            <span className="flex-1 text-left">Detect OpenCode</span>
          </Command.Item>
          <Command.Item value="open jobs queue active running" onSelect={() => go('/jobs')} className={ITEM_CLASS}>
            <ListChecks size={14} className="text-fgf" />
            <span className="flex-1 text-left">Open jobs</span>
            <span className="mono text-[10.5px] text-fgf">/jobs</span>
          </Command.Item>
        </Command.Group>

        {activeJobs.length > 0 && (
          <Command.Group heading="Active jobs" className={GROUP_CLASS}>
            {activeJobs.map(({ job }) => (
              <Command.Item key={job.id} value={`job ${job.title} ${job.id}`} onSelect={() => go(`/jobs/${job.id}`)} className={ITEM_CLASS}>
                <ListChecks size={14} className="text-fgf" />
                <span className="min-w-0 flex-1 truncate text-left">{job.title}</span>
                <span className="text-[10.5px] text-fgf">{job.status.replace(/_/g, ' ')}</span>
              </Command.Item>
            ))}
          </Command.Group>
        )}
      </Command.List>
    </Command.Dialog>
  )
}
