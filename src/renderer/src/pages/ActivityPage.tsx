import { useEffect, useMemo, useState } from 'react'
import { Activity as ActivityIcon, Search, Filter, Download } from 'lucide-react'
import { useApi } from '../lib/api'
import { cn, fullTime, money, timeAgo, tokens } from '../lib/format'
import type { PageProps } from '../lib/types'
import { useRouter } from '../state/router'
import { useEventStream } from '../state/events'
import { Button, EmptyState, ErrorNote, Input, LoadingRow, Panel, Pill, Select } from '../components/ui'

const SEVERITIES = ['debug', 'info', 'warn', 'error'] as const

export default function ActivityPage({ params }: PageProps) {
  const initialQuery = params.q ?? ''
  const navigate = useRouter((s) => s.navigate)
  const [severity, setSeverity] = useState<string>('all')
  const [query, setQuery] = useState(initialQuery)
  const [searchQuery, setSearchQuery] = useState(initialQuery)

  const timeline = useApi('timeline.list', [{ severity: severity === 'all' ? undefined : [severity], limit: 400 }], { pollMs: 5000 })
  const search = useApi('search.global', [searchQuery], { enabled: searchQuery.trim().length >= 2 })
  const usage = useApi('stats.usage', [{ days: 30 }])
  const live = useEventStream((s) => s.events)

  useEffect(() => {
    setQuery(initialQuery)
    setSearchQuery(initialQuery)
  }, [initialQuery])

  const entries = useMemo(() => {
    const base = timeline.data ?? []
    const liveAsEntries = live.slice(-40).map((e) => ({
      seq: e.seq,
      type: e.type,
      severity: e.severity,
      at: e.at,
      message: e.message,
      jobId: e.jobId,
      workerId: e.workerId,
      taskId: e.taskId,
      data: e.data,
    }))
    const merged = [...base, ...liveAsEntries]
    const seen = new Set<number>()
    const uniq = merged.filter((e) => (seen.has(e.seq) ? false : (seen.add(e.seq), true)))
    uniq.sort((a, b) => b.at - a.at)
    const q = query.trim().toLowerCase()
    return q ? uniq.filter((e) => e.message.toLowerCase().includes(q) || e.type.toLowerCase().includes(q)) : uniq
  }, [timeline.data, live, query])

  const result = search.data

  return (
    <div className="flex min-h-0 flex-1 overflow-hidden">
      <div className="flex min-w-0 flex-1 flex-col border-r border-line">
        <div className="flex items-center gap-2 border-b border-line px-4 py-2.5">
          <Filter size={13} className="text-fgf" />
          <Select value={severity} onChange={(e) => setSeverity(e.target.value)} className="h-[30px] w-32 text-[12.5px]">
            <option value="all">All levels</option>
            {SEVERITIES.map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </Select>
          <Input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Filter events…"
            className="h-[30px] w-56 text-[12.5px]"
          />
          <span className="mono ml-auto text-[11px] text-fgf">{entries.length} events</span>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto">
          {timeline.loading && entries.length === 0 ? (
            <LoadingRow />
          ) : timeline.error ? (
            <div className="p-4">
              <ErrorNote message={timeline.error} onRetry={timeline.reload} />
            </div>
          ) : entries.length === 0 ? (
            <EmptyState icon={<ActivityIcon size={22} />} title="No events" description="Job, worker, approval and vault activity streams in here as it happens." />
          ) : (
            entries.map((e) => (
              <div key={e.seq} className="fx-in-fade flex items-start gap-3 border-b border-line/50 px-4 py-2">
                <span
                  className={cn(
                    'mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full',
                    e.severity === 'error' ? 'bg-danger' : e.severity === 'warn' ? 'bg-warn' : e.severity === 'debug' ? 'bg-line2' : 'bg-info/70',
                  )}
                />
                <div className="min-w-0 flex-1">
                  <div className="text-[12.5px] text-fg">{e.message || e.type}</div>
                  <div className="mono flex flex-wrap gap-x-2 text-[10.5px] text-fgf">
                    <span>{e.type}</span>
                    {e.jobId && (
                      <button className="text-info hover:underline" onClick={() => navigate(`/jobs/${e.jobId}`)}>
                        {e.jobId.slice(0, 16)}
                      </button>
                    )}
                    {e.workerId && <span>{e.workerId.slice(0, 14)}</span>}
                  </div>
                </div>
                <span className="mono shrink-0 text-[10.5px] text-fgf">{fullTime(e.at)}</span>
              </div>
            ))
          )}
        </div>
      </div>

      {/* right column */}
      <div className="flex w-[340px] shrink-0 flex-col overflow-y-auto">
        <div className="border-b border-line p-3.5">
          <div className="stack-title mb-2">Global search</div>
          <div className="relative">
            <Search size={13} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-fgf" />
            <Input
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="Jobs, tasks, workers, artifacts, notes…"
              className="input-icon text-[12.5px]"
            />
          </div>
          {searchQuery.trim().length >= 2 && (
            <div className="mt-3 max-h-72 space-y-2.5 overflow-y-auto">
              {search.loading ? (
                <div className="text-[12px] text-fgf">Searching…</div>
              ) : search.error ? (
                <ErrorNote message={search.error} onRetry={search.reload} />
              ) : !result ? null : (
                <SearchGroups
                  result={result}
                  onJob={(id) => navigate(`/jobs/${id}`)}
                  onNote={(path) => navigate(`/knowledge?note=${encodeURIComponent(path)}`)}
                />
              )}
            </div>
          )}
        </div>

        <Panel title="Usage · 30 days" className="m-3.5">
          {usage.loading && !usage.data ? (
            <LoadingRow label="Loading usage…" />
          ) : usage.error ? (
            <div className="p-3">
              <ErrorNote message={usage.error} onRetry={usage.reload} />
            </div>
          ) : (
            <div className="p-3.5">
              <div className="grid grid-cols-3 gap-px bg-line/60 text-center">
                {[
                  ['input', tokens(usage.data?.total.input ?? 0)],
                  ['output', tokens(usage.data?.total.output ?? 0)],
                  ['cost', money(usage.data?.total.cost ?? 0)],
                ].map(([k, v]) => (
                  <div key={k} className="bg-panel py-2">
                    <div className="text-[15px] font-semibold text-fg">{v}</div>
                    <div className="text-[10px] uppercase tracking-wide text-fgf">{k}</div>
                  </div>
                ))}
              </div>
              <div className="mt-3 space-y-1.5">
                {(usage.data?.byModel ?? []).slice(0, 8).map((m) => (
                  <div key={`${m.providerId}-${m.modelId}`} className="flex items-center gap-2 text-[11.5px]">
                    <span className="mono min-w-0 flex-1 truncate text-fgm">{m.modelId}</span>
                    <span className="mono text-fgf">{m.calls}×</span>
                    <span className="mono text-fgf">{tokens(m.input + m.output)}</span>
                    <span className="mono text-ok">{money(m.cost)}</span>
                  </div>
                ))}
                {(usage.data?.byModel.length ?? 0) === 0 && <div className="text-[11.5px] text-fgf">No model usage recorded yet.</div>}
              </div>
              <div className="mt-3 flex gap-2">
                <Button size="sm" variant="ghost" onClick={() => timeline.reload()}>
                  <Download size={12} /> Refresh
                </Button>
              </div>
            </div>
          )}
        </Panel>

        <div className="px-3.5 pb-4 text-[11px] leading-relaxed text-fgf">
          Events are retained for {14} days in the local JSONL log. Redaction runs on every payload — secrets never reach this feed.
          <span className="mono"> ({timeAgo(Date.now())})</span>
        </div>
      </div>
    </div>
  )
}

function SearchGroups({
  result,
  onJob,
  onNote,
}: {
  result: import('@shared/ipc').GlobalSearchResult
  onJob: (id: string) => void
  onNote: (path: string) => void
}) {
  const groups: { label: string; items: { key: string; label: string; sub?: string; onClick?: () => void }[] }[] = [
    {
      label: 'Jobs',
      items: result.jobs.map((j) => ({ key: j.id, label: j.title, sub: j.snippet, onClick: () => onJob(j.id) })),
    },
    {
      label: 'Tasks',
      items: result.tasks.map((t) => ({ key: t.id, label: t.title, onClick: () => onJob(t.jobId) })),
    },
    {
      label: 'Workers',
      items: result.workers.map((w) => ({ key: w.id, label: w.name, onClick: () => onJob(w.jobId) })),
    },
    {
      label: 'Artifacts',
      items: result.artifacts.map((a) => ({ key: a.id, label: a.name, sub: a.kind, onClick: () => onJob(a.jobId) })),
    },
    {
      label: 'Notes',
      items: result.notes.map((n) => ({ key: n.path, label: n.title, sub: n.folder, onClick: () => onNote(n.path) })),
    },
    {
      label: 'Projects',
      items: result.projects.map((p) => ({ key: p.id, label: p.name, sub: p.path })),
    },
  ].filter((g) => g.items.length > 0)

  if (groups.length === 0) return <div className="text-[12px] text-fgf">Nothing matched.</div>

  return (
    <div className="space-y-3">
      {groups.map((g) => (
        <div key={g.label}>
          <div className="mb-1 flex items-center gap-1.5">
            <span className="text-[11px] uppercase tracking-wide text-fgf">{g.label}</span>
            <Pill tone="neutral">{g.items.length}</Pill>
          </div>
          {g.items.slice(0, 8).map((item) => (
            <button
              key={item.key}
              onClick={item.onClick}
              className="block w-full truncate rounded px-2 py-1 text-left text-[12px] text-fg transition-colors hover:bg-panel2"
              title={item.label}
            >
              {item.label}
              {item.sub && <span className="ml-1.5 text-[11px] text-fgf">{item.sub.slice(0, 60)}</span>}
            </button>
          ))}
        </div>
      ))}
    </div>
  )
}
