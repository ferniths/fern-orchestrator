import { useEffect, useState } from 'react'
import { Server, Users, Activity, RefreshCw, Play, Square, XCircle } from 'lucide-react'
import { call, useApi } from '../lib/api'
import { cn, fullTime, timeAgo } from '../lib/format'
import type { PageProps } from '../lib/types'
import { toast } from '../state/toast'
import { Button, EmptyState, ErrorNote, LoadingRow, Panel, Pill, Spinner, StatusPill } from '../components/ui'

export default function OpenCodePage(_: PageProps) {
  const [busy, setBusy] = useState<string | null>(null)
  const [serverId, setServerId] = useState<string | null>(null)
  const [sessionId, setSessionId] = useState<string | null>(null)

  const detect = useApi('opencode.detect', [], { pollMs: 60_000 })
  const servers = useApi('opencode.servers', [], { pollMs: 5000 })

  const serverList = servers.data ?? []
  const activeServerId = serverId ?? serverList.find((s) => s.status === 'ready')?.id ?? serverList[0]?.id ?? null

  const sessions = useApi('opencode.sessions', [activeServerId ?? undefined], { enabled: !!activeServerId, pollMs: 5000 })
  const sessionsForActive = sessions.data ?? []
  const transcript = useApi('opencode.transcript', [activeServerId ?? '', sessionId ?? ''], {
    enabled: !!activeServerId && !!sessionId,
    pollMs: 2000,
  })

  useEffect(() => {
    if (sessionId && sessions.data && !sessions.data.some((s) => s.id === sessionId)) setSessionId(null)
  }, [sessionId, sessions.data])

  async function guard(id: string, fn: () => Promise<void>) {
    setBusy(id)
    try {
      await fn()
    } catch (err) {
      toast.error('Request failed', (err as Error).message)
    } finally {
      setBusy(null)
    }
  }

  function stopServer(id: string) {
    return guard(`stop:${id}`, async () => {
      await call('opencode.stopServer', id)
      toast.success('Server stopped')
      if (activeServerId === id) {
        setServerId(null)
        setSessionId(null)
      }
      servers.reload()
    })
  }

  function startServer() {
    return guard('start', async () => {
      const state = await call('opencode.startServer', {})
      toast.success('Server started', state.label)
      servers.reload()
    })
  }

  function killSession(id: string) {
    if (!activeServerId) return
    return guard(`kill:${id}`, async () => {
      await call('opencode.killSession', activeServerId, id)
      toast.success('Session killed')
      sessions.reload()
      servers.reload()
    })
  }

  function rerunDetect() {
    return guard('detect', async () => {
      const res = await call('opencode.detect')
      detect.reload()
      if (res.detected) toast.success('OpenCode detected', `${res.version ?? ''}${res.path ? ` · ${res.path}` : ''}`.trim())
      else toast.warn('OpenCode not found', 'Install it or set the binary path in Settings.')
    })
  }

  const detection = detect.data

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
      <div className="min-h-0 flex-1 overflow-y-auto p-5">
        <Panel
          title="OpenCode binary"
          action={
            <Button size="sm" disabled={busy === 'detect'} onClick={rerunDetect}>
              {busy === 'detect' ? <Spinner size={12} /> : <RefreshCw size={12} />} Detect
            </Button>
          }
        >
          {detect.loading && !detection ? (
            <LoadingRow label="Detecting OpenCode…" />
          ) : detect.error ? (
            <div className="p-3.5">
              <ErrorNote message={detect.error} onRetry={detect.reload} />
            </div>
          ) : (
            <div className="flex flex-wrap items-center gap-x-5 gap-y-2 p-3.5 text-[12.5px]">
              <Pill tone={detection?.detected ? 'ok' : 'warn'}>
                <span className="dot" />
                {detection?.detected ? 'detected' : 'not found'}
              </Pill>
              <span className="mono min-w-0 truncate text-fgm">{detection?.path ?? '—'}</span>
              <span className="text-fgf">{detection?.version ?? 'no version'}</span>
              {detection?.source && <Pill tone="info">via {detection.source}</Pill>}
            </div>
          )}
        </Panel>

        <Panel
          title="Servers"
          className="mt-3"
          action={
            <Button size="sm" disabled={busy === 'start'} onClick={startServer}>
              {busy === 'start' ? <Spinner size={12} /> : <Play size={12} />} Start server
            </Button>
          }
        >
          {servers.loading && !servers.data ? (
            <LoadingRow label="Loading servers…" />
          ) : servers.error ? (
            <div className="p-3.5">
              <ErrorNote message={servers.error} onRetry={servers.reload} />
            </div>
          ) : serverList.length === 0 ? (
            <EmptyState icon={<Server size={22} />} title="No servers running" description="Workers need an `opencode serve` process per workspace. Start one to inspect its sessions." />
          ) : (
            <table className="w-full text-left text-[12.5px]">
              <thead className="border-b border-line text-[11px] uppercase tracking-wide text-fgf">
                <tr>
                  <th className="px-4 py-2 font-medium">Status</th>
                  <th className="px-4 py-2 font-medium">Label</th>
                  <th className="px-4 py-2 font-medium">Port</th>
                  <th className="px-4 py-2 font-medium">Directory</th>
                  <th className="px-4 py-2 font-medium">Sessions</th>
                  <th className="px-4 py-2" />
                </tr>
              </thead>
              <tbody>
                {serverList.map((s) => (
                  <tr
                    key={s.id}
                    onClick={() => {
                      setServerId(s.id)
                      setSessionId(null)
                    }}
                    className={cn('cursor-pointer border-b border-line/60 transition-colors hover:bg-panel2/60', activeServerId === s.id && 'bg-panel2/80')}
                  >
                    <td className="px-4 py-2.5">
                      <StatusPill status={s.status === 'ready' ? 'healthy' : s.status} />
                    </td>
                    <td className="px-4 py-2.5">
                      <div className="font-medium text-fg">{s.label}</div>
                      <div className="mono text-[10.5px] text-fgf">{s.pid ? `pid ${s.pid}` : s.id.slice(0, 14)}</div>
                      {s.lastError && <div className="truncate text-[11px] text-danger">{s.lastError}</div>}
                    </td>
                    <td className="mono px-4 py-2.5 text-fgf">{s.port}</td>
                    <td className="max-w-0 px-4 py-2.5">
                      <div className="mono truncate text-[11.5px] text-fgf">{s.directory}</div>
                    </td>
                    <td className="mono px-4 py-2.5 text-fgf">{s.sessions}</td>
                    <td className="px-4 py-2.5 text-right">
                      {s.status !== 'stopped' && (
                        <Button
                          size="sm"
                          variant="ghost"
                          disabled={busy === `stop:${s.id}`}
                          onClick={(e) => {
                            e.stopPropagation()
                            stopServer(s.id)
                          }}
                        >
                          {busy === `stop:${s.id}` ? <Spinner size={12} /> : <Square size={12} className="text-danger" />} Stop
                        </Button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Panel>

        <Panel title="Sessions" className="mt-3">
          {!activeServerId ? (
            <EmptyState icon={<Users size={22} />} title="No server selected" description="Select a running server above to list the sessions it owns." />
          ) : sessions.loading && !sessions.data ? (
            <LoadingRow label="Loading sessions…" />
          ) : sessions.error ? (
            <div className="p-3.5">
              <ErrorNote message={sessions.error} onRetry={sessions.reload} />
            </div>
          ) : sessionsForActive.length === 0 ? (
            <EmptyState icon={<Users size={22} />} title="No sessions" description="Native OpenCode sessions appear here as workers are dispatched." />
          ) : (
            <table className="w-full text-left text-[12.5px]">
              <thead className="border-b border-line text-[11px] uppercase tracking-wide text-fgf">
                <tr>
                  <th className="px-4 py-2 font-medium">Status</th>
                  <th className="px-4 py-2 font-medium">Session</th>
                  <th className="px-4 py-2 font-medium">Title</th>
                  <th className="px-4 py-2 font-medium">Directory</th>
                  <th className="px-4 py-2" />
                </tr>
              </thead>
              <tbody>
                {sessionsForActive.map((s) => (
                  <tr
                    key={s.id}
                    onClick={() => setSessionId(s.id)}
                    className={cn('cursor-pointer border-b border-line/60 transition-colors hover:bg-panel2/60', sessionId === s.id && 'bg-panel2/80')}
                  >
                    <td className="px-4 py-2.5">
                      <StatusPill status={s.status} />
                    </td>
                    <td className="mono px-4 py-2.5 text-fgf">{s.id.slice(0, 14)}</td>
                    <td className="max-w-0 px-4 py-2.5">
                      <div className="truncate text-fg">{s.title || '—'}</div>
                    </td>
                    <td className="max-w-0 px-4 py-2.5">
                      <div className="mono truncate text-[11.5px] text-fgf">{s.directory}</div>
                    </td>
                    <td className="px-4 py-2.5 text-right">
                      <Button
                        size="sm"
                        variant="ghost"
                        disabled={busy === `kill:${s.id}`}
                        onClick={(e) => {
                          e.stopPropagation()
                          killSession(s.id)
                        }}
                      >
                        {busy === `kill:${s.id}` ? <Spinner size={12} /> : <XCircle size={12} className="text-danger" />} Kill
                      </Button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Panel>

        <Panel
          title="Transcript"
          className="mt-3"
          action={
            sessionId ? (
              <span className="mono text-[10.5px] text-fgf">{sessionId.slice(0, 14)} · refreshing every 2s</span>
            ) : undefined
          }
        >
          {!sessionId ? (
            <EmptyState icon={<Activity size={22} />} title="Select a session" description="Pick a session above to stream its transcript here." />
          ) : transcript.loading && !transcript.data ? (
            <LoadingRow label="Loading transcript…" />
          ) : transcript.error ? (
            <div className="p-3.5">
              <ErrorNote message={transcript.error} onRetry={transcript.reload} />
            </div>
          ) : (transcript.data ?? []).length === 0 ? (
            <EmptyState title="No transcript yet" description="Output shows up here while the session produces tokens." />
          ) : (
            <div className="max-h-[420px] space-y-2 overflow-y-auto p-3.5">
              {(transcript.data ?? []).map((t) => (
                <div key={t.id} className="fx-in-fade text-[11.5px] leading-relaxed">
                  <span
                    className={cn(
                      'mono mr-1.5 uppercase',
                      t.role === 'user' ? 'text-info' : t.role === 'assistant' ? 'text-accent' : t.role === 'tool' ? 'text-warn' : 'text-fgf',
                    )}
                  >
                    {t.role}
                  </span>
                  <span className="text-fgf">{fullTime(t.at)}</span>
                  <span className="ml-1.5 whitespace-pre-wrap text-fgm">{t.text}</span>
                </div>
              ))}
            </div>
          )}
        </Panel>

        <div className="px-1 pb-4 pt-3 text-[11px] leading-relaxed text-fgf">
          Last refreshed {timeAgo(Date.now())} · servers and sessions poll every 5s, transcripts every 2s while this page is open.
        </div>
      </div>
    </div>
  )
}
