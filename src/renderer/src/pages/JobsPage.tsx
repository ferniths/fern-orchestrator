import { useMemo, useState } from 'react'
import { Plus, Inbox } from 'lucide-react'
import { useApi } from '../lib/api'
import { cn, timeAgo } from '../lib/format'
import type { PageProps } from '../lib/types'
import { useRouter } from '../state/router'
import { EmptyState, ErrorNote, Input, LoadingRow, Panel, Pill, StatusPill } from '../components/ui'

const FILTERS = ['all', 'active', 'awaiting_approval', 'completed', 'failed', 'draft'] as const

export default function JobsPage(_: PageProps) {
  const navigate = useRouter((s) => s.navigate)
  const [filter, setFilter] = useState<(typeof FILTERS)[number]>('active')
  const [query, setQuery] = useState('')

  const jobs = useApi('jobs.list', [{ limit: 200 }], { pollMs: 8000 })

  const rows = useMemo(() => {
    let list = jobs.data ?? []
    if (filter === 'active') list = list.filter((j) => !['completed', 'failed', 'cancelled'].includes(j.job.status))
    else if (filter !== 'all') list = list.filter((j) => j.job.status === filter)
    const q = query.trim().toLowerCase()
    if (q) list = list.filter((j) => j.job.title.toLowerCase().includes(q) || j.job.originalPrompt.toLowerCase().includes(q))
    return list
  }, [jobs.data, filter, query])

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
      <div className="flex items-center gap-2.5 border-b border-line px-5 py-3">
        <div className="flex items-center gap-1">
          {FILTERS.map((f) => (
            <button
              key={f}
              onClick={() => setFilter(f)}
              className={cn('tab', filter === f && 'tab-active')}
            >
              {f.replace(/_/g, ' ')}
            </button>
          ))}
        </div>
        <div className="ml-auto flex items-center gap-2">
          <Input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Filter by title or goal"
            className="h-[30px] w-56 text-[12.5px]"
          />
          <button className="btn btn-primary" onClick={() => navigate('/new')}>
            <Plus size={14} /> New job
          </button>
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto">
        {jobs.loading && jobs.data === null ? (
          <LoadingRow label="Loading jobs…" />
        ) : jobs.error ? (
          <div className="p-5">
            <ErrorNote message={jobs.error} onRetry={jobs.reload} />
          </div>
        ) : rows.length === 0 ? (
          <EmptyState
            icon={<Inbox size={22} />}
            title={filter === 'active' && !query ? 'Nothing running' : 'No jobs match'}
            description={
              filter === 'active' && !query
                ? 'Jobs you start will appear here with live status, task progress and approval gates.'
                : 'Try a different filter or search term.'
            }
            action={
              <button className="btn btn-primary" onClick={() => navigate('/new')}>
                <Plus size={13} /> Create job
              </button>
            }
          />
        ) : (
          <Panel flat>
            <table className="w-full text-left text-[12.5px]">
              <thead className="sticky top-0 z-10 bg-panel">
                <tr className="border-b border-line text-[11px] uppercase tracking-wide text-fgf">
                  <th className="px-4 py-2 font-medium">Status</th>
                  <th className="px-4 py-2 font-medium">Job</th>
                  <th className="px-4 py-2 font-medium">Progress</th>
                  <th className="px-4 py-2 font-medium">Loop</th>
                  <th className="px-4 py-2 font-medium">Updated</th>
                </tr>
              </thead>
              <tbody>
                {rows.map(({ job, counts, loop }, i) => (
                  <tr
                    key={job.id}
                    onClick={() => navigate(`/jobs/${job.id}`)}
                    className="fx-row-fade cursor-pointer border-b border-line/60 transition-colors last:border-b-0 hover:bg-panel2/70"
                    style={{ ['--i' as never]: i } as React.CSSProperties}
                  >
                    <td className="px-4 py-2.5">
                      <StatusPill status={job.status} />
                    </td>
                    <td className="max-w-0 px-4 py-2.5">
                      <div className="truncate font-medium text-fg">{job.title}</div>
                      <div className="mt-0.5 truncate text-[11.5px] text-fgf">{job.originalPrompt}</div>
                    </td>
                    <td className="px-4 py-2.5">
                      <div className="flex items-center gap-2">
                        <div className="h-1.5 w-24 overflow-hidden rounded-full bg-panel2">
                          <div
                            className={cn('h-full rounded-full transition-all', job.status === 'failed' ? 'bg-danger' : 'bg-accent')}
                            style={{
                              width: `${counts.tasks > 0 ? Math.min(100, (job.stats.tasksCompleted / counts.tasks) * 100) : 0}%`,
                            }}
                          />
                        </div>
                        <span className="mono text-[11px] text-fgf">
                          {job.stats.tasksCompleted}/{counts.tasks}
                        </span>
                        {counts.pendingApprovals > 0 && <Pill tone="warn">{counts.pendingApprovals} gate</Pill>}
                      </div>
                    </td>
                    <td className="px-4 py-2.5 text-fgm">
                      {Math.max(job.currentLoop, 1)}/{job.loopCount}
                      {loop ? <span className="text-fgf"> · {loop.status}</span> : null}
                    </td>
                    <td className="whitespace-nowrap px-4 py-2.5 text-fgf">{timeAgo(job.updatedAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Panel>
        )}
      </div>
    </div>
  )
}
