import { useEffect, useState, type ReactNode } from 'react'
import { Plus, ShieldCheck, Search } from 'lucide-react'
import { cn } from '../lib/format'
import { useApi } from '../lib/api'
import { NAV } from '../lib/nav'
import { useRouter } from '../state/router'
import { Pill } from './ui'
import { CommandPalette } from './CommandPalette'

export function Shell({ children, title, subtitle, actions }: { children: ReactNode; title?: string; subtitle?: ReactNode; actions?: ReactNode }) {
  const path = useRouter((s) => s.path)
  const navigate = useRouter((s) => s.navigate)
  const [search, setSearch] = useState('')
  const [paletteOpen, setPaletteOpen] = useState(false)

  const stats = useApi('stats.snapshot', [], { pollMs: 10_000 })
  const pendingApprovals = stats.data?.approvals.pending ?? 0

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key === 'k') {
        e.preventDefault()
        setPaletteOpen(true)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  const isActive = (navPath: string): boolean => (navPath === '/' ? path === '/' : path === navPath || path.startsWith(`${navPath}/`))
  const routeKey = path.split('?')[0] ?? path

  return (
    <div className="flex h-screen w-full overflow-hidden bg-app">
      {/* sidebar — collapses to an icon rail on narrow windows */}
      <aside className="flex w-[56px] shrink-0 flex-col border-r border-line bg-panel sm:w-[196px]">
        <div className="flex items-center gap-2.5 px-3.5 pb-4 pt-4 sm:px-4">
          <div className="mono flex h-7 w-7 shrink-0 items-center justify-center rounded-md bg-accent/15 text-[11px] font-semibold text-accent">
            fern
          </div>
          <div className="hidden min-w-0 sm:block">
            <div className="truncate text-[13px] font-semibold leading-tight text-fg">Fern Orchestrator</div>
            <div className="mono truncate text-[10.5px] leading-tight text-fgf">local-first orchestration</div>
          </div>
        </div>

        <nav className="flex min-h-0 flex-1 flex-col gap-0.5 overflow-y-auto px-1.5 pb-3 sm:px-2">
          {NAV.map((item) => {
            const Icon = item.icon
            const active = isActive(item.path)
            return (
              <button
                key={item.path}
                onClick={() => navigate(item.path)}
                aria-current={active ? 'page' : undefined}
                title={item.label}
                className={cn(
                  'group press flex items-center justify-center gap-2.5 rounded-md px-2.5 py-[7px] text-[12.5px] hover:translate-x-px sm:justify-start',
                  active ? 'bg-panel2 text-fg' : 'text-fgm hover:bg-panel2/60 hover:text-fg',
                )}
              >
                <Icon size={15} className={cn('shrink-0', active ? 'text-accent' : 'text-fgf group-hover:text-fgm')} />
                <span className="hidden flex-1 truncate text-left sm:block">{item.label}</span>
                {item.path === '/jobs' && pendingApprovals > 0 && <Pill tone="warn">{pendingApprovals}</Pill>}
              </button>
            )
          })}
        </nav>
      </aside>

      {/* main column */}
      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex h-[52px] shrink-0 items-center gap-3 border-b border-line bg-panel/70 px-4 backdrop-blur">
          <div className="min-w-0 flex-1">
            <div className="flex items-baseline gap-2.5">
              <h1 className="truncate text-[14.5px] font-semibold text-fg">{title ?? 'Dashboard'}</h1>
              {subtitle && <span className="truncate text-[12px] text-fgf">{subtitle}</span>}
            </div>
          </div>

          <div className="relative hidden w-64 shrink-0 md:block">
            <Search size={13} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-fgf" />
            <input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && search.trim()) navigate(`/activity?q=${encodeURIComponent(search.trim())}`)
              }}
              placeholder="Search…"
              aria-label="Search jobs, tasks and notes"
              className="input input-icon h-[30px] w-full text-[12.5px]"
            />
          </div>

          {pendingApprovals > 0 && (
            <button className="btn btn-sm" onClick={() => navigate('/jobs')}>
              <ShieldCheck size={13} className="text-warn" />
              {pendingApprovals} approval{pendingApprovals === 1 ? '' : 's'}
            </button>
          )}

          {actions ?? (
            <button className="btn btn-primary" onClick={() => navigate('/new')}>
              <Plus size={14} />
              New job
            </button>
          )}
        </header>

        {/* Keyed on the pathname (query changes must not remount the page) so
            each navigation plays the shared page-entrance animation. */}
        <main key={routeKey} className="fx-page flex min-h-0 flex-1 flex-col overflow-hidden">
          {children}
        </main>
      </div>

      <CommandPalette open={paletteOpen} onOpenChange={setPaletteOpen} />
    </div>
  )
}