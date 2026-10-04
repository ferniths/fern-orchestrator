import { ArrowRight, FolderGit2, Plus, Cpu, BookOpen, CircleDot } from 'lucide-react'
import { useApi } from '../lib/api'
import { cn, duration, money, timeAgo, tokens } from '../lib/format'
import type { PageProps } from '../lib/types'
import { useRouter } from '../state/router'
import { useEventStream } from '../state/events'
import { EmptyState, ErrorNote, LoadingRow, Panel, Pill, StatCard, StatusPill } from '../components/ui'

export default function DashboardPage(_: PageProps) {
  const navigate = useRouter((s) => s.navigate)

  const stats = useApi('stats.snapshot', [])
  const jobs = useApi('jobs.list', [{ limit: 6 }], { pollMs: 8000 })
  const timeline = useApi('timeline.list', [{ limit: 14 }], { pollMs: 8000 })
  const projects = useApi('projects.list', [])
  const vaults = useApi('vaults.list', [])
  const providers = useApi('providers.list', [])

  const liveEvents = useEventStream((s) => s.events)
  const s = stats.data

  const quickActions = [
    { label: 'New job', icon: Plus, path: '/new', show: true },
    { label: 'Register project', icon: FolderGit2, path: '/projects', show: (projects.data?.length ?? 0) === 0 },
    { label: 'Connect provider', icon: Cpu, path: '/providers', show: (providers.data?.length ?? 0) === 0 },
    { label: 'Add vault', icon: BookOpen, path: '/knowledge', show: (vaults.data?.length ?? 0) === 0 },
  ].filter((a) => a.show)

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-y-auto">
      {/* hero strip */}
      <div className="relative overflow-hidden border-b border-line bg-panel/50 px-5 pb-5 pt-6">
        <div className="grid-fade pointer-events-none absolute inset-0 opacity-40" />
        <div className="relative flex flex-wrap items-end justify-between gap-x-6 gap-y-3">
          <div className="min-w-0">
            <div className="stack-title mb-1.5">Command center</div>
            <h2 className="text-[19px] font-semibold leading-tight tracking-tight text-white">
              Rough idea → plan → workers → reviewed result
            </h2>
            <p className="mt-1 max-w-xl text-[12.5px] leading-relaxed text-fgm">
              Local-first orchestration over real OpenCode sessions, with approval gates for git and a vault for what matters.
            </p>
          </div>
          <div className="flex flex-wrap gap-2">
            {quickActions.map((a) => (
              <button key={a.label} className="btn" onClick={() => navigate(a.path)}>
                <a.icon size={13} />
                {a.label}
              </button>
            ))}
          </div>
        </div>
      </div>

      {/* stats */}
      <div className="fx-stagger grid grid-cols-2 gap-3 px-5 pt-5 lg:grid-cols-4">
        <StatCard
          label="Active jobs"
          value={s?.jobs.active ?? '—'}
          sub={`${s?.jobs.completed ?? 0} completed · ${s?.jobs.failed ?? 0} failed`}
          tone={(s?.jobs.active ?? 0) > 0 ? 'accent' : undefined}
          onClick={() => navigate('/jobs')}
        />
        <StatCard
          label="Approvals waiting"
          value={s?.approvals.pending ?? '—'}
          sub="git commit / push gates"
          tone={(s?.approvals.pending ?? 0) > 0 ? 'warn' : undefined}
          onClick={() => navigate('/jobs')}
        />
        <StatCard
          label="Workers"
          value={`${s?.workers.running ?? 0} / ${s?.workers.queued ?? 0}`}
          sub="running / queued"
          onClick={() => navigate('/jobs')}
        />
        <StatCard
          label="Spend"
          value={money(s?.usage.costUsd ?? 0)}
          sub={`${tokens(s?.usage.inputTokens ?? 0)} in · ${tokens(s?.usage.outputTokens ?? 0)} out`}
        />
      </div>

      {/* main columns */}
      <div className="mt-4 grid min-h-0 flex-1 grid-cols-1 gap-3 px-5 pb-5 xl:grid-cols-[1.35fr_1fr]">
        <Panel
          title="Jobs"
          action={
            <button className="btn btn-sm btn-ghost" onClick={() => navigate('/jobs')}>
              View all <ArrowRight size={12} />
            </button>
          }
        >
          {jobs.loading && jobs.data === null ? (
            <LoadingRow />
          ) : jobs.error ? (
            <div className="p-3.5">
              <ErrorNote message={jobs.error} onRetry={jobs.reload} />
            </div>
          ) : (jobs.data ?? []).length === 0 ? (
            <EmptyState
              icon={<CircleDot size={22} />}
              title="No jobs yet"
              description="Start with a rough prompt. The refiner sharpens it, the planner turns it into a DAG, and real OpenCode workers execute it."
              action={
                <button className="btn btn-primary" onClick={() => navigate('/new')}>
                  <Plus size={14} /> Create your first job
                </button>
              }
            />
          ) : (
            <div className="flex flex-col">
              {(jobs.data ?? []).map(({ job, counts, loop }) => {
                const done = counts.tasks > 0 && job.stats.tasksCompleted >= counts.tasks
                return (
                  <button
                    key={job.id}
                    onClick={() => navigate(`/jobs/${job.id}`)}
                    className="group flex items-center gap-3 border-b border-line/70 px-3.5 py-2.5 text-left transition-colors last:border-b-0 hover:bg-panel2/70"
                  >
                    <StatusPill status={job.status} />
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-[13px] font-medium text-fg group-hover:text-white">{job.title}</div>
                      <div className="mt-0.5 flex items-center gap-2 text-[11.5px] text-fgf">
                        <span>
                          loop {Math.max(job.currentLoop, 1)}/{job.loopCount}
                          {loop ? ` · ${loop.status}` : ''}
                        </span>
                        <span>·</span>
                        <span>
                          {counts.tasks} tasks · {counts.workers} workers
                        </span>
                        {counts.pendingApprovals > 0 && (
                          <>
                            <span>·</span>
                            <span className="text-warn">{counts.pendingApprovals} approvals</span>
                          </>
                        )}
                      </div>
                    </div>
                    <div className="hidden text-right text-[11.5px] text-fgf sm:block">
                      <div>{timeAgo(job.updatedAt)}</div>
                      <div className={cn('mono', done && 'text-ok')}>
                        {job.stats.tasksCompleted}/{counts.tasks || 0} done
                      </div>
                    </div>
                    <ArrowRight size={14} className="text-fgf opacity-0 transition-opacity group-hover:opacity-100" />
                  </button>
                )
              })}
            </div>
          )}
        </Panel>

        <div className="flex min-h-0 flex-col gap-3">
          <Panel
            title="Live activity"
            action={
              <button className="btn btn-sm btn-ghost" onClick={() => navigate('/activity')}>
                Open <ArrowRight size={12} />
              </button>
            }
          >
            <div className="flex max-h-[340px] flex-col overflow-y-auto">
              {liveEvents.length === 0 && timeline.data?.length === 0 && (
                <EmptyState title="Quiet in here" description="Events from jobs, workers and the vault stream into this feed." />
              )}
              {(liveEvents.length > 0
                ? [...liveEvents].reverse().slice(0, 14)
                : (timeline.data ?? []).map((e) => ({ ...e, at: e.at }))
              ).map((e, i) => (
                <div key={`${e.seq}-${i}`} className="flex items-start gap-2.5 border-b border-line/60 px-3.5 py-2 last:border-b-0">
                  <span
                    className={cn(
                      'mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full',
                      e.severity === 'error' ? 'bg-danger' : e.severity === 'warn' ? 'bg-warn' : e.type.includes('worker') ? 'bg-accent' : 'bg-info/70',
                    )}
                  />
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-[12.5px] text-fg">{e.message || e.type}</div>
                    <div className="mono truncate text-[10.5px] text-fgf">
                      {e.type} · {timeAgo(e.at)}
                    </div>
                  </div>
                </div>
              ))}
            </div>
          </Panel>

          <Panel title="Runtime">
            <div className="grid grid-cols-2 gap-px bg-line/60">
              {(timeline.data ?? []).length >= 0 &&
                [
                  ['Sessions', `${s?.opencode.sessions ?? 0}`],
                  ['Artifacts', `${s?.artifacts.total ?? 0}`],
                  ['Notes', `${s?.vault.notes ?? 0}`],
                  ['Providers', `${s?.providers.healthy}/${s?.providers.configured ?? 0}`],
                ].map(([label, value]) => (
                  <div key={label} className="bg-panel px-3.5 py-2.5">
                    <div className="stack-title">{label}</div>
                    <div className="mt-1 text-[16px] font-semibold text-fg">{value}</div>
                  </div>
                ))}
            </div>
            <div className="flex items-center gap-2 border-t border-line px-3.5 py-2.5 text-[11.5px] text-fgf">
              <Pill tone={s?.vault.lastIndexedAt ? 'ok' : 'neutral'}>
                {s?.vault.lastIndexedAt ? `vault indexed ${timeAgo(s.vault.lastIndexedAt)}` : 'vault not indexed'}
              </Pill>
              {duration(Date.now() - (s?.vault.lastIndexedAt ?? 0)) !== '—' && <span>uptime context</span>}
            </div>
          </Panel>
        </div>
      </div>
    </div>
  )
}
