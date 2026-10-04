import { useEffect, useMemo, useState } from 'react'
import {
  ArrowLeft,
  Play,
  Pause,
  PlayCircle,
  XCircle,
  RotateCcw,
  CheckCircle2,
  GitBranch,
  Users,
  ListTree,
  ScrollText,
  Eye,
  FileDiff,
  Package,
  Sparkles,
  Copy,
  RefreshCw,
} from 'lucide-react'
import type { Approval, Artifact } from '@shared/domain'
import { call, useApi } from '../lib/api'
import { bytes, cn, duration, fullTime, timeAgo, tokens } from '../lib/format'
import type { PageProps } from '../lib/types'
import { useRouter } from '../state/router'
import { toast } from '../state/toast'
import { useEventStream } from '../state/events'
import { Button, ConfirmDialog, EmptyState, ErrorNote, LoadingRow, Modal, Panel, Pill, StatusPill } from '../components/ui'
import { Markdown } from '../components/Markdown'
import { DagCanvas } from '../components/DagCanvas'

const TABS = [
  { id: 'plan', label: 'Plan', icon: ScrollText },
  { id: 'graph', label: 'Workflow', icon: ListTree },
  { id: 'tasks', label: 'Tasks', icon: ListTree },
  { id: 'workers', label: 'Workers', icon: Users },
  { id: 'artifacts', label: 'Artifacts', icon: Package },
  { id: 'timeline', label: 'Timeline', icon: Eye },
] as const

type TabId = (typeof TABS)[number]['id'] | 'result'

const MARKDOWN_KINDS = new Set(['response', 'review_report', 'research_report', 'markdown_note', 'documentation', 'test_report', 'plan'])

export default function JobDetailPage({ params }: PageProps) {
  const jobId = params.id!
  const navigate = useRouter((s) => s.navigate)

  const [tab, setTab] = useState<TabId>('plan')
  const [selectedNode, setSelectedNode] = useState<string | null>(null)
  const [openWorker, setOpenWorker] = useState<string | null>(null)
  const [openArtifact, setOpenArtifact] = useState<Artifact | null>(null)
  const [confirm, setConfirm] = useState<null | 'cancel' | 'pause' | 'resume' | 'start'>(null)
  const [busy, setBusy] = useState(false)

  const job = useApi('jobs.get', [jobId], { pollMs: 5000 })
  const timeline = useApi('timeline.list', [{ jobId, limit: 250 }], { pollMs: 5000 })
  const approvals = useApi('approvals.list', [{ status: 'all' }], { pollMs: 5000 })
  const artifacts = useApi('artifacts.list', [jobId], { pollMs: 5000 })
  const finalResult = useApi('jobs.finalResult', [jobId], { enabled: job.data?.job.status === 'completed' })
  useEventStream((s) => s.lastSeq) // re-render liveness marker

  const detail = job.data
  const jobApprovals = useMemo(() => (approvals.data ?? []).filter((a) => a.jobId === jobId), [approvals.data, jobId])

  async function act(label: string, fn: () => Promise<unknown>) {
    setBusy(true)
    try {
      await fn()
      toast.success(label)
      job.reload()
    } catch (err) {
      toast.error(`${label} failed`, (err as Error).message)
    } finally {
      setBusy(false)
      setConfirm(null)
    }
  }

  if (job.loading && !detail) {
    return (
      <div className="flex flex-1 flex-col">
        <LoadingRow label="Loading job…" />
      </div>
    )
  }
  if (job.error || !detail) {
    return (
      <div className="flex flex-1 flex-col p-5">
        <ErrorNote message={job.error ?? 'Job not found'} onRetry={job.reload} />
        <div className="mt-3">
          <Button onClick={() => navigate('/jobs')}>
            <ArrowLeft size={13} /> Back to jobs
          </Button>
        </div>
      </div>
    )
  }

  const { job: j, tasks, workers, nodes, edges, reviews, loops, plan, pendingApprovals, project } = detail
  const selectedTaskId = nodes.find((n) => n.id === selectedNode)?.taskId ?? null
  const workerNameById = new Map(workers.map((w) => [w.id, w.name]))
  const taskTitleById = new Map(tasks.map((t) => [t.id, t.title]))
  const visibleTabs: readonly { id: TabId; label: string; icon: typeof ScrollText }[] =
    j.status === 'completed' ? [...TABS, { id: 'result', label: 'Result', icon: Sparkles }] : TABS

  const controls = (
    <div className="flex items-center gap-2">
      {['draft', 'ready', 'awaiting_approval'].includes(j.status) && j.status !== 'awaiting_approval' && (
        <Button variant="primary" size="sm" disabled={busy} onClick={() => setConfirm('start')}>
          <Play size={13} /> Start
        </Button>
      )}
      {j.status === 'running' && (
        <Button size="sm" disabled={busy} onClick={() => setConfirm('pause')}>
          <Pause size={13} /> Pause
        </Button>
      )}
      {j.status === 'paused' && (
        <Button variant="primary" size="sm" disabled={busy} onClick={() => setConfirm('resume')}>
          <PlayCircle size={13} /> Resume
        </Button>
      )}
      {!['completed', 'cancelled', 'failed'].includes(j.status) && (
        <Button size="sm" disabled={busy} onClick={() => act('Loop re-queued', () => call('jobs.rerunLoop', jobId, Math.max(j.currentLoop, 1)))}>
          <RotateCcw size={13} /> Re-run loop
        </Button>
      )}
      {!['completed', 'cancelled'].includes(j.status) && (
        <Button variant="danger" size="sm" disabled={busy} onClick={() => setConfirm('cancel')}>
          <XCircle size={13} /> Cancel
        </Button>
      )}
    </div>
  )

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
      {/* header */}
      <div className="border-b border-line px-5 pb-3.5 pt-4">
        <button className="mb-2 flex items-center gap-1.5 text-[11.5px] text-fgf transition-colors hover:text-fgm" onClick={() => navigate('/jobs')}>
          <ArrowLeft size={12} /> All jobs
        </button>
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2.5">
              <StatusPill status={j.status} />
              <h2 className="text-[16.5px] font-semibold tracking-tight text-white">{j.title}</h2>
              {pendingApprovals > 0 && <Pill tone="warn">{pendingApprovals} approval{pendingApprovals === 1 ? '' : 's'} pending</Pill>}
            </div>
            <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11.5px] text-fgf">
              <span className="mono">{j.id}</span>
              <span>·</span>
              <span>loop {Math.max(j.currentLoop, 1)}/{j.loopCount}</span>
              <span>·</span>
              <span>{tasks.length} tasks</span>
              <span>·</span>
              <span>{workers.length} workers</span>
              {project && (
                <>
                  <span>·</span>
                  <span className="flex items-center gap-1">
                    <GitBranch size={11} /> {project.name}
                  </span>
                </>
              )}
              <span>·</span>
              <span>updated {timeAgo(j.updatedAt)}</span>
              {j.stats.durationMs > 0 && (
                <>
                  <span>·</span>
                  <span>{duration(j.stats.durationMs)}</span>
                </>
              )}
              {j.stats.totalTokens > 0 && (
                <>
                  <span>·</span>
                  <span>
                    {tokens(j.stats.totalTokens)} tokens · ${j.stats.totalCost.toFixed(2)}
                  </span>
                </>
              )}
            </div>
            {j.statusReason && <div className="mt-1 text-[11.5px] text-warn/85">{j.statusReason}</div>}
            {j.error && <div className="mt-1 text-[11.5px] text-danger">{j.error}</div>}
          </div>
          {controls}
        </div>

        {/* tab bar */}
        <div className="mt-3 flex items-center gap-1">
          {visibleTabs.map((t) => {
            const Icon = t.icon
            return (
              <button
                key={t.id}
                onClick={() => setTab(t.id)}
                className={cn('press tab', tab === t.id && 'tab-active')}
              >
                <Icon size={13} />
                {t.label}
                {t.id === 'tasks' && <span className="mono text-[10.5px] text-fgf">{tasks.length}</span>}
                {t.id === 'workers' && <span className="mono text-[10.5px] text-fgf">{workers.length}</span>}
                {t.id === 'artifacts' && <span className="mono text-[10.5px] text-fgf">{(artifacts.data ?? []).length}</span>}
                {t.id === 'plan' && j.status === 'awaiting_approval' && <Pill tone="warn">review</Pill>}
              </button>
            )
          })}
        </div>
      </div>

      {/* body */}
      <div key={tab} className="fx-in-fade flex min-h-0 flex-1 overflow-hidden">
        <div className="flex min-w-0 flex-1 flex-col overflow-hidden">
          {tab === 'plan' && (
            <div className="min-h-0 flex-1 overflow-y-auto p-5">
              {j.status === 'awaiting_approval' && (
                <Panel title="Plan approval required" className="mb-3 border-warn/40">
                  <div className="flex flex-col gap-3 p-3.5">
                    <p className="text-[12.5px] leading-relaxed text-fgm">
                      The planner finished the DAG for loop {Math.max(j.currentLoop, 1)}. Approving starts execution; rejecting fails the job back to draft.
                    </p>
                    <div className="flex gap-2">
                      <Button variant="primary" disabled={busy} onClick={() => act('Plan approved', () => call('jobs.approvePlan', jobId, { approve: true }))}>
                        <CheckCircle2 size={14} /> Approve plan
                      </Button>
                      <Button variant="danger" disabled={busy} onClick={() => act('Plan rejected', () => call('jobs.approvePlan', jobId, { approve: false }))}>
                        Reject
                      </Button>
                    </div>
                  </div>
                </Panel>
              )}
              <Panel title={`Plan · loop ${Math.max(j.currentLoop, 1)}`}>
                {plan?.text ? (
                  <div className="p-4">
                    <Markdown content={plan.text} />
                  </div>
                ) : (
                  <EmptyState
                    title="No plan yet"
                    description={
                      j.status === 'refining' || j.status === 'planning'
                        ? 'The control plane is refining your prompt and building the plan…'
                        : 'Plans appear here once the refiner and planner have run.'
                    }
                  />
                )}
              </Panel>
              {loops.length > 0 && (
                <Panel title="Loops" className="mt-3">
                  <div className="divide-y divide-line/60">
                    {loops.map((loop) => (
                      <div key={loop.id} className="flex items-start gap-3 px-3.5 py-2.5">
                        <Pill tone={loop.verdict === 'pass' ? 'ok' : loop.verdict === 'fail' ? 'danger' : loop.status === 'executing' ? 'accent' : 'neutral'}>
                          #{loop.index} {loop.status}
                        </Pill>
                        <div className="min-w-0 flex-1">
                          {loop.planSummary && <div className="truncate text-[12.5px] text-fg">{loop.planSummary}</div>}
                          {loop.reviewSummary && <div className="mt-0.5 text-[11.5px] text-fgf">{loop.reviewSummary}</div>}
                          {loop.problems.length > 0 && (
                            <div className="mt-1 text-[11.5px] text-warn/85">{loop.problems.length} open problems</div>
                          )}
                        </div>
                        <div className="text-right text-[11px] text-fgf">
                          <div>{loop.stats.workers} workers</div>
                          <div>{loop.durationMs ? duration(loop.durationMs) : timeAgo(loop.createdAt)}</div>
                        </div>
                      </div>
                    ))}
                  </div>
                </Panel>
              )}
              {reviews.length > 0 && (
                <Panel title="Reviews" className="mt-3">
                  <div className="divide-y divide-line/60">
                    {reviews.map((r) => (
                      <div key={r.id} className="px-3.5 py-2.5">
                        <div className="flex items-center gap-2">
                          <Pill tone={r.verdict === 'pass' ? 'ok' : r.verdict === 'fail' ? 'danger' : r.verdict === 'stop' ? 'warn' : 'info'}>
                            {r.kind} · {r.verdict}
                          </Pill>
                          <span className="text-[11.5px] text-fgf">
                            {r.reviewerRole} · loop {r.loopIndex}
                          </span>
                        </div>
                        {r.summary && <div className="mt-1.5 text-[12.5px] leading-relaxed text-fgm">{r.summary}</div>}
                        {r.findings.length > 0 && (
                          <ul className="mt-1.5 space-y-1">
                            {r.findings.map((f) => (
                              <li key={f.id} className="flex items-start gap-2 text-[11.5px]">
                                <span
                                  className={cn(
                                    'mt-1 h-1.5 w-1.5 shrink-0 rounded-full',
                                    f.severity === 'critical' || f.severity === 'major' ? 'bg-danger' : 'bg-warn',
                                  )}
                                />
                                <span className="text-fgm">
                                  <span className="text-fg">{f.title}</span>
                                  {f.detail && ` — ${f.detail}`}
                                </span>
                              </li>
                            ))}
                          </ul>
                        )}
                      </div>
                    ))}
                  </div>
                </Panel>
              )}
            </div>
          )}

          {tab === 'graph' && (
            <div className="min-h-0 flex-1 p-5">
              <Panel title="Workflow DAG" className="h-full">
                <div className="min-h-0 flex-1">
                  <DagCanvas nodes={nodes} edges={edges} onSelect={(n) => setSelectedNode(n.id)} selectedId={selectedNode} />
                </div>
              </Panel>
            </div>
          )}

          {tab === 'tasks' && (
            <div className="min-h-0 flex-1 overflow-y-auto">
              {tasks.length === 0 ? (
                <EmptyState title="No tasks yet" description="Tasks are created from the approved plan." />
              ) : (
                <table className="w-full text-left text-[12.5px]">
                  <thead className="sticky top-0 bg-panel">
                    <tr className="border-b border-line text-[11px] uppercase tracking-wide text-fgf">
                      <th className="px-4 py-2 font-medium">Status</th>
                      <th className="px-4 py-2 font-medium">Task</th>
                      <th className="px-4 py-2 font-medium">Role</th>
                      <th className="px-4 py-2 font-medium">Attempt</th>
                      <th className="px-4 py-2 font-medium">Timing</th>
                      <th className="px-4 py-2" />
                    </tr>
                  </thead>
                  <tbody>
                    {tasks.map((t) => (
                      <tr
                        key={t.id}
                        onClick={() => t.nodeId && setSelectedNode(t.nodeId)}
                        className={cn('border-b border-line/60 hover:bg-panel2/60', selectedTaskId === t.id && 'bg-panel2/80')}
                      >
                        <td className="px-4 py-2.5">
                          <StatusPill status={t.status} />
                        </td>
                        <td className="max-w-0 px-4 py-2.5">
                          <div className="truncate font-medium text-fg">{t.title}</div>
                          {t.resultSummary && <div className="truncate text-[11.5px] text-fgf">{t.resultSummary}</div>}
                          {t.error && <div className="truncate text-[11.5px] text-danger">{t.error}</div>}
                        </td>
                        <td className="whitespace-nowrap px-4 py-2.5 text-fgm">{t.role}</td>
                        <td className="mono px-4 py-2.5 text-fgf">
                          {t.attempt}/{t.retryPolicy.maxAttempts}
                        </td>
                        <td className="whitespace-nowrap px-4 py-2.5 text-fgf">{t.completedAt ? duration(t.completedAt - (t.startedAt ?? t.createdAt)) : t.startedAt ? duration(Date.now() - t.startedAt) : '—'}</td>
                        <td className="px-4 py-2.5 text-right">
                          {t.status === 'failed' && (
                            <Button
                              size="sm"
                              onClick={async (e) => {
                                e.stopPropagation()
                                try {
                                  await call('tasks.retry', t.id)
                                  toast.success('Task re-queued')
                                  job.reload()
                                } catch (err) {
                                  toast.error('Retry failed', (err as Error).message)
                                }
                              }}
                            >
                              Retry
                            </Button>
                          )}
                          {['pending', 'blocked', 'ready'].includes(t.status) && (
                            <Button
                              size="sm"
                              variant="ghost"
                              onClick={async (e) => {
                                e.stopPropagation()
                                try {
                                  await call('tasks.skip', t.id)
                                  toast.success('Task skipped')
                                  job.reload()
                                } catch (err) {
                                  toast.error('Skip failed', (err as Error).message)
                                }
                              }}
                            >
                              Skip
                            </Button>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>
          )}

          {tab === 'workers' && (
            <div className="min-h-0 flex-1 overflow-y-auto p-5">
              {workers.length === 0 ? (
                <EmptyState title="No workers yet" description="Workers are OpenCode sessions spawned for ready tasks." />
              ) : (
                <div className="grid grid-cols-1 gap-2.5 lg:grid-cols-2">
                  {workers.map((w, i) => (
                    <button
                      key={w.id}
                      onClick={() => setOpenWorker(w.id)}
                      className="panel fx-row lift px-3.5 py-3 text-left hover:border-line2 hover:bg-panel2"
                      style={{ ['--i' as never]: i } as React.CSSProperties}
                    >
                      <div className="flex items-center gap-2.5">
                        <StatusPill status={w.status} />
                        <span className="truncate text-[13px] font-medium text-fg">{w.name}</span>
                        <span className="ml-auto mono text-[11px] text-fgf">{w.role}</span>
                      </div>
                      <div className="mt-1.5 line-clamp-2 text-[11.5px] leading-snug text-fgf">{w.objective}</div>
                      {w.statusReason && <div className="mt-1 text-[11.5px] leading-snug text-warn/85">{w.statusReason}</div>}
                      {w.error && <div className="mt-1 text-[11.5px] leading-snug text-danger">{w.error}</div>}
                      <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-fgf">
                        <span>{w.modelId ?? 'auto model'}</span>
                        <span>· depth {w.depth}</span>
                        {w.sessionId && <span className="mono">· {w.sessionId.slice(0, 10)}</span>}
                        <span>· {tokens(w.usage.inputTokens + w.usage.outputTokens)} tok</span>
                        {w.filesTouched.length > 0 && (
                          <span>
                            · {w.filesTouched.length} file{w.filesTouched.length === 1 ? '' : 's'} touched
                          </span>
                        )}
                        {w.artifacts.length > 0 && (
                          <span>
                            · {w.artifacts.length} artifact{w.artifacts.length === 1 ? '' : 's'}
                          </span>
                        )}
                        <span>· {w.completedAt ? duration(w.completedAt - (w.startedAt ?? w.createdAt)) : timeAgo(w.createdAt)}</span>
                      </div>
                    </button>
                  ))}
                </div>
              )}
            </div>
          )}

          {tab === 'artifacts' && (
            <div className="min-h-0 flex-1 overflow-y-auto">
              {artifacts.loading && !artifacts.data ? (
                <LoadingRow label="Loading artifacts…" />
              ) : artifacts.error ? (
                <div className="p-4">
                  <ErrorNote message={artifacts.error} onRetry={artifacts.reload} />
                </div>
              ) : (artifacts.data ?? []).length === 0 ? (
                <EmptyState
                  icon={<Package size={22} />}
                  title="No artifacts yet"
                  description="Workers write responses, diffs, reports and notes here as tasks complete."
                />
              ) : (
                <table className="w-full text-left text-[12.5px]">
                  <thead className="sticky top-0 bg-panel">
                    <tr className="border-b border-line text-[11px] uppercase tracking-wide text-fgf">
                      <th className="px-4 py-2 font-medium">Kind</th>
                      <th className="px-4 py-2 font-medium">Worker / task</th>
                      <th className="px-4 py-2 font-medium">Name</th>
                      <th className="px-4 py-2 font-medium">Size</th>
                      <th className="px-4 py-2 font-medium">Checksum</th>
                      <th className="px-4 py-2 font-medium">Status</th>
                      <th className="px-4 py-2 font-medium">Created</th>
                    </tr>
                  </thead>
                  <tbody>
                    {(artifacts.data ?? []).map((a) => {
                      const sourceWorker = a.workerId ? workerNameById.get(a.workerId) : undefined
                      const sourceTask = a.taskId ? taskTitleById.get(a.taskId) : undefined
                      return (
                        <tr
                          key={a.id}
                          onClick={() => setOpenArtifact(a)}
                          className="cursor-pointer border-b border-line/60 transition-colors last:border-b-0 hover:bg-panel2/60"
                        >
                          <td className="whitespace-nowrap px-4 py-2.5">
                            <Pill tone="info">{a.kind.replace(/_/g, ' ')}</Pill>
                          </td>
                          <td className="px-4 py-2.5">
                            {sourceWorker ? (
                              <div className="max-w-[180px]">
                                <div className="truncate text-fg">{sourceWorker}</div>
                                {sourceTask && <div className="truncate text-[11px] text-fgf">{sourceTask}</div>}
                              </div>
                            ) : sourceTask ? (
                              <div className="max-w-[180px] truncate text-[11.5px] text-fgf">{sourceTask}</div>
                            ) : null}
                          </td>
                          <td className="max-w-0 px-4 py-2.5">
                            <div className="truncate font-medium text-fg">{a.name}</div>
                            {a.path && <div className="mono truncate text-[11px] text-fgf">{a.path}</div>}
                            {a.status === 'missing' && <div className="text-[11px] text-danger">expected file not found on disk</div>}
                          </td>
                          <td className="mono whitespace-nowrap px-4 py-2.5 text-fgf">{bytes(a.bytes)}</td>
                          <td className="mono whitespace-nowrap px-4 py-2.5 text-[11px] text-fgf">
                            {a.checksum ? <span title={a.checksum}>{a.checksum.slice(0, 12)}</span> : null}
                          </td>
                          <td className="px-4 py-2.5">
                            <StatusPill status={a.status} />
                          </td>
                          <td className="whitespace-nowrap px-4 py-2.5 text-fgf">{timeAgo(a.createdAt)}</td>
                        </tr>
                      )
                    })}
                  </tbody>
                </table>
              )}
            </div>
          )}

          {tab === 'result' && (
            <div className="min-h-0 flex-1 overflow-y-auto p-5">
              {finalResult.loading && !finalResult.data ? (
                <LoadingRow label="Loading final result…" />
              ) : finalResult.error ? (
                <ErrorNote message={finalResult.error} onRetry={finalResult.reload} />
              ) : !finalResult.data ? (
                <EmptyState
                  icon={<Sparkles size={22} />}
                  title="No final result yet"
                  description="The synthesis lands here once the job finishes its review loop."
                />
              ) : (
                <>
                  <Panel title="Final result" action={<Button size="sm" variant="ghost" onClick={finalResult.reload}><RefreshCw size={12} /> Refresh</Button>}>
                    <div className="p-4">
                      <Markdown content={finalResult.data.summary || 'No summary produced.'} />
                    </div>
                  </Panel>
                  <Panel title="Stats" className="mt-3">
                    <div className="grid grid-cols-2 gap-px bg-line/60 sm:grid-cols-4">
                      {[
                        ['workers', String(j.stats.workersRun)],
                        ['duration', duration(j.stats.durationMs)],
                        ['tokens', tokens(j.stats.totalTokens)],
                        ['cost', `$${j.stats.totalCost.toFixed(2)}`],
                      ].map(([label, value]) => (
                        <div key={label} className="bg-panel px-3 py-2.5 text-center">
                          <div className="text-[16px] font-semibold text-fg">{value}</div>
                          <div className="text-[10.5px] uppercase tracking-wide text-fgf">{label}</div>
                        </div>
                      ))}
                    </div>
                  </Panel>
                  {finalResult.data.artifacts.length > 0 && (
                    <Panel title={`Artifacts (${finalResult.data.artifacts.length})`} className="mt-3">
                      <div className="divide-y divide-line/60">
                        {finalResult.data.artifacts.map((a) => (
                          <button
                            key={a.id}
                            onClick={() => setOpenArtifact(a)}
                            className="flex w-full items-center gap-2.5 px-3.5 py-2.5 text-left transition-colors hover:bg-panel2/60"
                          >
                            <Pill tone="info">{a.kind.replace(/_/g, ' ')}</Pill>
                            <span className="min-w-0 flex-1 truncate text-[12.5px] text-fg">{a.name}</span>
                            <span className="mono text-[11px] text-fgf">{bytes(a.bytes)}</span>
                          </button>
                        ))}
                      </div>
                    </Panel>
                  )}
                  {finalResult.data.unresolved.length > 0 && (
                    <Panel title={`Unresolved (${finalResult.data.unresolved.length})`} className="mt-3">
                      <ul className="divide-y divide-line/60">
                        {finalResult.data.unresolved.map((issue, i) => (
                          <li key={`${i}-${issue.slice(0, 24)}`} className="px-3.5 py-2 text-[12.5px] leading-relaxed text-fgm">
                            {issue}
                          </li>
                        ))}
                      </ul>
                    </Panel>
                  )}
                </>
              )}
            </div>
          )}

          {tab === 'timeline' && (
            <div className="min-h-0 flex-1 overflow-y-auto">
              {timeline.data?.length === 0 ? (
                <EmptyState title="No events yet" description="Every state change, worker spawn and approval lands here." />
              ) : (
                <div className="divide-y divide-line/50">
                  {[...(timeline.data ?? [])].reverse().map((e) => (
                    <div key={e.seq} className="flex items-start gap-3 px-4 py-2">
                      <span
                        className={cn(
                          'mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full',
                          e.severity === 'error' ? 'bg-danger' : e.severity === 'warn' ? 'bg-warn' : e.severity === 'debug' ? 'bg-line2' : 'bg-info/70',
                        )}
                      />
                      <div className="min-w-0 flex-1">
                        <div className="text-[12.5px] text-fg">{e.message || e.type}</div>
                        <div className="mono truncate text-[10.5px] text-fgf">
                          {e.type}
                          {e.workerId ? ` · ${e.workerId.slice(0, 14)}` : ''}
                        </div>
                      </div>
                      <span className="mono shrink-0 text-[10.5px] text-fgf">{fullTime(e.at)}</span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>

        {/* right rail */}
        <aside className="hidden w-[300px] shrink-0 flex-col overflow-y-auto border-l border-line xl:flex">
          <Panel title={`Approvals (${jobApprovals.length})`} className="border-0 border-b border-line">
            {jobApprovals.length === 0 ? (
              <div className="px-3.5 py-4 text-[12px] text-fgf">No approvals requested for this job.</div>
            ) : (
              jobApprovals.map((a) => <ApprovalCard key={a.id} approval={a} onDone={() => { job.reload(); approvals.reload() }} />)
            )}
          </Panel>

          <Panel title="Task progress" className="border-0 border-b border-line">
            <div className="p-3.5">
              <div className="mb-2 flex items-center justify-between text-[11.5px]">
                <span className="text-fgf">
                  {tasks.filter((t) => t.status === 'succeeded').length} of {tasks.length} done
                </span>
                <span className="text-fgf">
                  {tasks.filter((t) => t.status === 'failed').length} failed
                </span>
              </div>
              <div className="h-2 overflow-hidden rounded-full bg-panel2">
                <div
                  className="h-full rounded-full bg-accent transition-all"
                  style={{ width: `${tasks.length ? (tasks.filter((t) => t.status === 'succeeded').length / tasks.length) * 100 : 0}%` }}
                />
              </div>
              <div className="mt-3 grid grid-cols-3 gap-2 text-center">
                {[
                  ['queued', workers.filter((w) => w.status === 'queued').length],
                  ['running', workers.filter((w) => ['running', 'starting'].includes(w.status)).length],
                  ['done', workers.filter((w) => w.status === 'succeeded').length],
                ].map(([label, value]) => (
                  <div key={label as string} className="rounded-md bg-panel2/70 py-1.5">
                    <div className="text-[15px] font-semibold text-fg">{value as number}</div>
                    <div className="text-[10.5px] uppercase tracking-wide text-fgf">{label as string}</div>
                  </div>
                ))}
              </div>
            </div>
          </Panel>

          <Panel title="Original prompt" className="border-0">
            <div className="p-3.5">
              <pre className="whitespace-pre-wrap break-words text-[11.5px] leading-relaxed text-fgm">{j.originalPrompt}</pre>
              {j.refinedPrompt && (
                <>
                  <div className="stack-title mt-3">Refined</div>
                  <pre className="mt-1.5 whitespace-pre-wrap break-words text-[11.5px] leading-relaxed text-fgm">{j.refinedPrompt}</pre>
                </>
              )}
            </div>
          </Panel>
        </aside>
      </div>

      <ConfirmDialog
        open={confirm !== null}
        onOpenChange={(v) => !v && setConfirm(null)}
        title={
          confirm === 'cancel' ? 'Cancel this job?' : confirm === 'pause' ? 'Pause this job?' : confirm === 'resume' ? 'Resume this job?' : 'Start this job?'
        }
        message={
          confirm === 'cancel'
            ? 'Running workers are aborted and remaining tasks are cancelled. Completed artifacts are kept.'
            : confirm === 'pause'
              ? 'New tasks stop spawning; in-flight workers keep running until they finish.'
              : confirm === 'resume'
                ? 'Execution continues from the current loop state.'
                : 'The refiner and planner run, then the job waits at plan approval if required.'
        }
        confirmLabel={confirm === 'cancel' ? 'Cancel job' : confirm === 'pause' ? 'Pause' : confirm === 'resume' ? 'Resume' : 'Start'}
        danger={confirm === 'cancel'}
        pending={busy}
        onConfirm={() => {
          if (confirm === 'cancel') act('Job cancelled', () => call('jobs.cancel', jobId))
          else if (confirm === 'pause') act('Job paused', () => call('jobs.pause', jobId))
          else if (confirm === 'resume') act('Job resumed', () => call('jobs.resume', jobId))
          else act('Job started', () => call('jobs.start', jobId))
        }}
      />

      <WorkerModal workerId={openWorker} onClose={() => setOpenWorker(null)} onChanged={job.reload} />
      <ArtifactViewer artifact={openArtifact} onClose={() => setOpenArtifact(null)} />
    </div>
  )
}

/* ------------------------------------------------------------- approvals */

function ApprovalCard({ approval, onDone }: { approval: Approval; onDone: () => void }) {
  const [busy, setBusy] = useState(false)
  const [showDiff, setShowDiff] = useState(false)
  const [diff, setDiff] = useState<{ raw: string; files: { path: string; additions: number; deletions: number }[] } | null>(null)
  const isGit = approval.kind === 'git_commit' || approval.kind === 'git_push'

  async function decide(approve: boolean) {
    setBusy(true)
    try {
      const res = await call('approvals.decide', approval.id, { approve })
      if (res.delivered === false) {
        toast.warn('Decision saved, but not delivered', 'OpenCode did not accept the reply — the worker is still waiting.')
      } else {
        toast.success(approve ? 'Approved' : 'Denied')
      }
      onDone()
    } catch (err) {
      toast.error('Decision failed', (err as Error).message)
    } finally {
      setBusy(false)
    }
  }

  async function loadDiff() {
    if (diff) {
      setShowDiff((v) => !v)
      return
    }
    try {
      const d = await call('approvals.diff', approval.id)
      setDiff(d)
      setShowDiff(true)
    } catch (err) {
      toast.error('Diff unavailable', (err as Error).message)
    }
  }

  if (approval.status !== 'pending') {
    return (
      <div className="border-b border-line/60 px-3.5 py-2.5 last:border-b-0">
        <div className="flex items-center gap-2">
          <Pill tone={approval.status === 'approved' ? 'ok' : 'danger'}>{approval.status}</Pill>
          <span className="truncate text-[12px] text-fgm">{approval.title}</span>
        </div>
        {approval.decisionNote && <div className="mt-1 text-[11px] text-fgf">{approval.decisionNote}</div>}
      </div>
    )
  }

  return (
    <div className="border-b border-line/60 px-3.5 py-3 last:border-b-0">
      <div className="flex items-start gap-2">
        <Pill tone="warn">{approval.kind.replace(/_/g, ' ')}</Pill>
        <div className="min-w-0 flex-1">
          <div className="text-[12.5px] font-medium text-fg">{approval.title}</div>
          {approval.detail && <div className="mt-0.5 break-words text-[11.5px] leading-snug text-fgf">{approval.detail}</div>}
        </div>
      </div>
      <div className="mt-2 flex gap-1.5">
        <Button size="sm" variant="primary" disabled={busy} onClick={() => decide(true)}>
          Approve
        </Button>
        <Button size="sm" variant="danger" disabled={busy} onClick={() => decide(false)}>
          Deny
        </Button>
        {isGit && (
          <Button size="sm" variant="ghost" onClick={loadDiff}>
            <FileDiff size={12} /> Diff
          </Button>
        )}
      </div>
      {showDiff && diff && (
        <div className="fx-in-fade mt-2 max-h-48 overflow-auto rounded-md border border-line bg-app p-2">
          {diff.files.length > 0 && (
            <div className="mb-1.5 space-y-0.5">
              {diff.files.map((f) => (
                <div key={f.path} className="mono flex items-center gap-2 text-[10.5px] text-fgf">
                  <span className="truncate">{f.path}</span>
                  <span className="text-ok">+{f.additions}</span>
                  <span className="text-danger">-{f.deletions}</span>
                </div>
              ))}
            </div>
          )}
          <pre className="whitespace-pre-wrap break-all text-[10.5px] leading-relaxed text-fgm">{diff.raw.slice(0, 8000)}</pre>
        </div>
      )}
    </div>
  )
}

/* --------------------------------------------------------- artifact viewer */

function ArtifactViewer({ artifact, onClose }: { artifact: Artifact | null; onClose: () => void }) {
  const content = artifact?.content ?? ''
  const asMarkdown = artifact ? MARKDOWN_KINDS.has(artifact.kind) : false

  async function copy() {
    try {
      await navigator.clipboard.writeText(content)
      toast.success('Copied to clipboard')
    } catch (err) {
      toast.error('Copy failed', (err as Error).message)
    }
  }

  return (
    <Modal
      open={artifact !== null}
      onOpenChange={(v) => !v && onClose()}
      title={artifact?.name ?? 'Artifact'}
      description={artifact ? `${artifact.kind.replace(/_/g, ' ')} · ${bytes(artifact.bytes)} · ${artifact.status}` : undefined}
      width="max-w-3xl"
      footer={
        <>
          <Button size="sm" variant="ghost" disabled={!content} onClick={copy}>
            <Copy size={12} /> Copy
          </Button>
          <Button size="sm" onClick={onClose}>
            Close
          </Button>
        </>
      }
    >
      {!artifact ? null : !content ? (
        <div className="text-[12.5px] text-fgf">
          No inline content stored{artifact.path ? ` — ${artifact.path}` : ''}
        </div>
      ) : asMarkdown ? (
        <Markdown content={content} />
      ) : (
        <pre className="max-h-[60vh] overflow-auto whitespace-pre-wrap break-words rounded-md border border-line bg-app p-3 text-[11.5px] leading-relaxed text-fgm">
          {content}
        </pre>
      )}
    </Modal>
  )
}

/* ------------------------------------------------------------ worker modal */

function WorkerModal({ workerId, onClose, onChanged }: { workerId: string | null; onClose: () => void; onChanged: () => void }) {
  const detail = useApi('workers.get', [workerId ?? ''], { enabled: !!workerId, pollMs: 1500 })
  const transcript = useApi('workers.transcript', [workerId ?? ''], { enabled: !!workerId, pollMs: 1500 })
  const events = useEventStream((s) => s.events)
  const [busy, setBusy] = useState(false)

  const lastEvent = events.length > 0 ? events[events.length - 1] : undefined
  const outputSeq = lastEvent && lastEvent.type === 'worker.output' && lastEvent.workerId === workerId ? lastEvent.seq : 0

  useEffect(() => {
    if (!outputSeq) return
    detail.reload()
    transcript.reload()
  }, [outputSeq])

  const d = detail.data
  const entries = transcript.data ?? d?.transcript ?? []
  const ownSession = d ? (d.sessions.find((s) => s.sessionId === d.worker.sessionId) ?? d.sessions[0]) : undefined
  const diffStats = ownSession?.diffStats
  const hasDiffStats = !!diffStats && (diffStats.files > 0 || diffStats.additions > 0 || diffStats.deletions > 0)

  async function abort() {
    if (!workerId) return
    setBusy(true)
    try {
      await call('workers.abort', workerId)
      toast.success('Worker aborted')
      detail.reload()
      onChanged()
    } catch (err) {
      toast.error('Abort failed', (err as Error).message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <Modal
      open={!!workerId}
      onOpenChange={(v) => !v && onClose()}
      title={d ? d.worker.name : 'Worker'}
      description={d ? `${d.worker.role} · ${d.worker.status} · ${d.worker.modelId ?? 'auto model'}` : undefined}
      width="max-w-3xl"
      footer={
        <>
          {d && !['succeeded', 'failed', 'aborted', 'timed_out'].includes(d.worker.status) && (
            <Button variant="danger" size="sm" disabled={busy} onClick={abort}>
              Abort worker
            </Button>
          )}
          <Button size="sm" onClick={onClose}>
            Close
          </Button>
        </>
      }
    >
      {detail.loading && !d ? (
        <LoadingRow label="Loading worker…" />
      ) : !d ? (
        <ErrorNote message={detail.error ?? 'Worker not found'} onRetry={detail.reload} />
      ) : (
        <div className="space-y-3">
          <div className="flex flex-wrap gap-2">
            <Pill>{d.worker.status}</Pill>
            <Pill>loop {d.worker.loopIndex}</Pill>
            <Pill>depth {d.worker.depth}</Pill>
            {d.worker.sessionId && <Pill tone="info">session {d.worker.sessionId.slice(0, 12)}</Pill>}
            <Pill tone="accent">
              {tokens(d.worker.usage.inputTokens + d.worker.usage.outputTokens)} tokens
            </Pill>
          </div>

          {d.worker.statusReason && <div className="text-[11.5px] leading-relaxed text-warn/85">{d.worker.statusReason}</div>}
          {d.worker.error && <div className="text-[11.5px] leading-relaxed text-danger">{d.worker.error}</div>}

          {d.worker.objective && (
            <div>
              <div className="stack-title mb-1">Objective</div>
              <p className="text-[12.5px] leading-relaxed text-fgm">{d.worker.objective}</p>
            </div>
          )}

          {(hasDiffStats || d.worker.filesTouched.length > 0) && (
            <div>
              <div className="stack-title mb-1.5">Evidence</div>
              <div className="rounded-md border border-line bg-app p-2.5">
                {hasDiffStats && diffStats && (
                  <div>
                    <div className="mb-1 text-[11px] uppercase tracking-wide text-fgf">Session diff</div>
                    <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[12px]">
                      <span className="mono text-ok">+{diffStats.additions}</span>
                      <span className="mono text-danger">-{diffStats.deletions}</span>
                      <span className="text-fgf">
                        {diffStats.files} file{diffStats.files === 1 ? '' : 's'} changed
                      </span>
                    </div>
                  </div>
                )}
                {d.worker.filesTouched.length > 0 && (
                  <div className={hasDiffStats ? 'mt-2' : ''}>
                    <div className="mb-1 text-[11px] uppercase tracking-wide text-fgf">Files touched</div>
                    <ul className="space-y-0.5">
                      {d.worker.filesTouched.map((f) => (
                        <li key={f} className="mono truncate text-[11px] text-fgm">
                          {f}
                        </li>
                      ))}
                    </ul>
                  </div>
                )}
              </div>
            </div>
          )}

          {entries.length > 0 ? (
            <div>
              <div className="stack-title mb-1.5">Transcript</div>
              <div className="max-h-72 space-y-2 overflow-y-auto rounded-md border border-line bg-app p-2.5">
                {entries.map((t) => (
                  <div key={t.id} className="text-[11.5px] leading-relaxed">
                    <span
                      className={cn(
                        'mono mr-1.5 uppercase',
                        t.role === 'user' ? 'text-info' : t.role === 'assistant' ? 'text-accent' : t.role === 'tool' ? 'text-warn' : 'text-fgf',
                      )}
                    >
                      {t.role}
                    </span>
                    <span className="whitespace-pre-wrap text-fgm">{t.text}</span>
                  </div>
                ))}
              </div>
            </div>
          ) : (
            <div className="text-[12px] text-fgf">No transcript captured yet. Output appears here while the worker runs.</div>
          )}

          {d.artifacts.length > 0 && (
            <div>
              <div className="stack-title mb-1.5">Artifacts ({d.artifacts.length})</div>
              <div className="divide-y divide-line/60 rounded-md border border-line">
                {d.artifacts.map((a) => (
                  <div key={a.id} className="px-2.5 py-2">
                    <div className="flex items-center gap-2">
                      <Pill tone="info">{a.kind.replace(/_/g, ' ')}</Pill>
                      <span className="min-w-0 flex-1 truncate text-[12px] text-fg">{a.name}</span>
                      <span className="mono text-[11px] text-fgf">{bytes(a.bytes)}</span>
                      <StatusPill status={a.status} />
                    </div>
                    {a.path && <div className="mono truncate text-[10.5px] text-fgf">{a.path}</div>}
                    {a.status === 'missing' && <div className="text-[11px] text-danger">expected file not found on disk</div>}
                    {a.checksum && (
                      <div className="mono truncate text-[10.5px] text-fgf" title={a.checksum}>
                        sha256 {a.checksum.slice(0, 16)}
                      </div>
                    )}
                  </div>
                ))}
              </div>
            </div>
          )}

          {(d.children.length > 0 || d.childSessions.length > 0) && (
            <div>
              <div className="stack-title mb-1.5">Subagents</div>
              <div className="flex flex-wrap gap-1.5">
                {d.children.map((c) => (
                  <Pill key={c.id} tone={c.status === 'succeeded' ? 'ok' : c.status === 'failed' ? 'danger' : 'neutral'}>
                    {c.name} · {c.status}
                  </Pill>
                ))}
                {d.childSessions.map((s) => (
                  <Pill key={s.sessionId} tone={s.status === 'completed' ? 'ok' : s.status === 'failed' ? 'danger' : 'neutral'}>
                    {s.title || s.sessionId.slice(0, 12)} · {s.status}
                    {s.diffStats.files > 0 ? ` · ${s.diffStats.files} files` : ''}
                  </Pill>
                ))}
              </div>
            </div>
          )}
        </div>
      )}
    </Modal>
  )
}
