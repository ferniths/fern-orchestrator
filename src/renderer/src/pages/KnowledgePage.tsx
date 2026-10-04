import { useMemo, useState } from 'react'
import { BookOpen, Plus, RefreshCw, Search, Star, Trash2, ExternalLink, Link2, AlertOctagon, Clock, FileText, FolderTree } from 'lucide-react'
import type { NoteMeta, Vault } from '@shared/domain'
import type { VaultNote } from '@shared/ipc'
import { call, useApi } from '../lib/api'
import { cn, timeAgo } from '../lib/format'
import type { PageProps } from '../lib/types'
import { toast } from '../state/toast'
import { Button, ConfirmDialog, EmptyState, ErrorNote, Field, Input, LoadingRow, Modal, Pill } from '../components/ui'
import { Markdown } from '../components/Markdown'
import { VaultTree, type FolderNode } from '../components/vault/VaultTree'

type Mode = 'search' | 'recent' | 'orphans' | 'broken' | 'browse'

export default function KnowledgePage(_: PageProps) {
  const vaults = useApi('vaults.list', [])
  const [vaultId, setVaultId] = useState<string>('')
  const [mode, setMode] = useState<Mode>('search')
  const [query, setQuery] = useState('')
  const [activeNote, setActiveNote] = useState<string | null>(null)
  const [addOpen, setAddOpen] = useState(false)
  const [removing, setRemoving] = useState<Vault | null>(null)
  const [busy, setBusy] = useState(false)

  const list = vaults.data ?? []
  const activeVault = useMemo(() => list.find((v) => v.id === vaultId) ?? list.find((v) => v.isDefault) ?? list[0] ?? null, [list, vaultId])
  const vid = activeVault?.id ?? ''

  const search = useApi('notes.search', [query, { vaultId: vid, limit: 100 }], { enabled: !!vid && mode === 'search' && query.trim().length > 0 })
  const recent = useApi('notes.recent', [vid, 60], { enabled: !!vid && mode === 'recent' })
  const orphans = useApi('notes.orphans', [vid], { enabled: !!vid && mode === 'orphans' })
  const broken = useApi('notes.brokenLinks', [vid], { enabled: !!vid && mode === 'broken' })
  const folders = useApi('notes.folders', [vid], { enabled: !!vid && mode === 'browse' })
  const allNotes = useApi('notes.list', [vid, 5000], { enabled: !!vid && mode === 'browse' })

  const treeFolders: FolderNode[] = (folders.data ?? [])
    .filter((f) => f.path !== '')
    .map((f) => ({
      id: f.path,
      name: f.name,
      parentId: f.path.includes('/') ? f.path.slice(0, f.path.lastIndexOf('/')) : '',
      noteCount: f.noteCount,
      path: f.path,
    }))

  const notesByFolder = useMemo(() => {
    const map: Record<string, NoteMeta[]> = {}
    for (const n of allNotes.data ?? []) (map[n.folder ?? ''] ??= []).push(n)
    return map
  }, [allNotes.data])

  const notes: NoteMeta[] =
    mode === 'search'
      ? (search.data ?? [])
      : mode === 'recent'
        ? (recent.data ?? [])
        : mode === 'orphans'
          ? (orphans.data ?? [])
          : []

  const treeLoading = folders.loading || allNotes.loading
  const treeError = folders.error ?? allNotes.error

  async function reindex() {
    if (!activeVault) return
    setBusy(true)
    try {
      await call('vaults.reindex', activeVault.id)
      toast.success('Re-index queued', activeVault.name)
      vaults.reload()
    } catch (err) {
      toast.error('Re-index failed', (err as Error).message)
    } finally {
      setBusy(false)
    }
  }

  async function setDefault() {
    if (!activeVault) return
    try {
      await call('vaults.setDefault', activeVault.id)
      toast.success('Default vault set', activeVault.name)
      vaults.reload()
    } catch (err) {
      toast.error('Failed', (err as Error).message)
    }
  }

  async function removeVault() {
    if (!removing) return
    setBusy(true)
    try {
      await call('vaults.remove', removing.id)
      toast.success('Vault removed', removing.name)
      setVaultId('')
      vaults.reload()
    } catch (err) {
      toast.error('Remove failed', (err as Error).message)
    } finally {
      setBusy(false)
      setRemoving(null)
    }
  }

  return (
    <div className="flex min-h-0 flex-1 overflow-hidden">
      {/* left: vaults */}
      <aside className="flex w-[260px] shrink-0 flex-col border-r border-line">
        <div className="flex items-center justify-between border-b border-line px-3.5 py-2.5">
          <span className="stack-title">Vaults</span>
          <button className="btn btn-sm btn-ghost" onClick={() => setAddOpen(true)}>
            <Plus size={13} />
          </button>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto p-2.5">
          {vaults.loading && list.length === 0 && <LoadingRow label="Loading vaults…" />}
          {vaults.error && <div className="p-2"><ErrorNote message={vaults.error} onRetry={vaults.reload} /></div>}
          {list.length === 0 && !vaults.loading && (
            <div className="px-2 py-6 text-center">
              <BookOpen size={20} className="mx-auto mb-2 text-fgf opacity-50" />
              <div className="text-[12.5px] text-fgm">No vaults</div>
              <div className="mt-1 text-[11.5px] leading-snug text-fgf">Point Fern at an Obsidian folder to index notes, links and backlinks.</div>
              <button className="btn btn-primary mt-3" onClick={() => setAddOpen(true)}>
                <Plus size={13} /> Add vault
              </button>
            </div>
          )}
          {list.map((v) => (
            <button
              key={v.id}
              onClick={() => setVaultId(v.id)}
              className={cn(
                'mb-1 w-full rounded-md border px-2.5 py-2 text-left transition-colors',
                activeVault?.id === v.id ? 'border-line2 bg-panel2' : 'border-transparent hover:bg-panel2/60',
              )}
            >
              <div className="flex items-center gap-2">
                <span className="truncate text-[12.5px] font-medium text-fg">{v.name}</span>
                {v.isDefault && <Star size={11} className="shrink-0 text-accent" />}
              </div>
              <div className="mono truncate text-[10.5px] text-fgf">{v.path}</div>
              <div className="mt-1 flex items-center gap-1.5">
                <Pill tone={v.indexStatus === 'ready' ? 'ok' : v.indexStatus === 'failed' ? 'danger' : 'neutral'}>
                  {v.indexStatus === 'ready' ? 'indexed' : v.indexStatus}
                </Pill>
                <span className="text-[10.5px] text-fgf">{v.noteCount} notes</span>
              </div>
            </button>
          ))}
        </div>
        {activeVault && (
          <div className="flex items-center gap-1.5 border-t border-line p-2.5">
            <Button size="sm" variant="ghost" onClick={setDefault} title="Make default">
              <Star size={12} />
            </Button>
            <Button size="sm" variant="ghost" onClick={reindex} disabled={busy} title="Re-index">
              <RefreshCw size={12} className={busy ? 'animate-spin' : ''} />
            </Button>
            <Button size="sm" variant="ghost" onClick={() => window.fern.invoke('app.revealInFolder', activeVault.path)} title="Open folder">
              <ExternalLink size={12} />
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setRemoving(activeVault)} title="Remove vault">
              <Trash2 size={12} className="text-danger" />
            </Button>
          </div>
        )}
      </aside>

      {/* middle: notes */}
      <div className="flex min-w-0 flex-1 flex-col">
        <div className="flex items-center gap-2 border-b border-line px-4 py-2.5">
          <div className="relative flex-1">
            <Search size={13} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-fgf" />
            <Input
              value={query}
              onChange={(e) => {
                setQuery(e.target.value)
                if (mode !== 'search') setMode('search')
              }}
              placeholder={activeVault ? `Search ${activeVault.name}…` : 'Add a vault first'}
              disabled={!activeVault}
              className="input-icon h-[30px] text-[12.5px]"
            />
          </div>
          <div className="flex gap-1">
            {(
              [
                ['browse', 'Browse', FolderTree],
                ['recent', 'Recent', Clock],
                ['orphans', 'Orphans', Link2],
                ['broken', 'Broken', AlertOctagon],
              ] as [Mode, string, typeof Clock][]
            ).map(([m, label, Icon]) => (
              <button
                key={m}
                onClick={() => setMode(m)}
                className={cn(
                  'flex items-center gap-1.5 rounded-md px-2.5 py-1.5 text-[12px] transition-colors',
                  mode === m ? 'bg-panel2 text-fg' : 'text-fgf hover:text-fgm',
                )}
              >
                <Icon size={12} />
                {label}
              </button>
            ))}
          </div>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto">
          {!activeVault ? (
            <EmptyState icon={<BookOpen size={22} />} title="No vault selected" description="Add an Obsidian vault to browse notes, backlinks and broken links." />
          ) : mode === 'browse' && treeError ? (
            <div className="p-4">
              <ErrorNote message={treeError} onRetry={() => { folders.reload(); allNotes.reload() }} />
            </div>
          ) : mode === 'browse' && treeLoading && !allNotes.data ? (
            <LoadingRow />
          ) : mode === 'browse' ? (
            <VaultTree
              folders={treeFolders}
              notes={notesByFolder}
              onNavigate={(p) => setActiveNote(p)}
              className="animate-in fade-in duration-200"
            />
          ) : mode === 'search' && !query.trim() ? (
            <EmptyState icon={<Search size={22} />} title="Search the vault" description="Full-text search across indexed notes, plus tags and titles." />
          ) : mode === 'broken' ? (
            <BrokenList items={broken.data ?? []} loading={broken.loading} onOpen={setActiveNote} />
          ) : (search.loading || recent.loading || orphans.loading) && notes.length === 0 && !search.error ? (
            <LoadingRow />
          ) : (search.error ?? recent.error ?? orphans.error) ? (
            <div className="p-4">
              <ErrorNote message={(search.error ?? recent.error ?? orphans.error)!} onRetry={() => { search.reload(); recent.reload(); orphans.reload() }} />
            </div>
          ) : notes.length === 0 ? (
            <EmptyState
              icon={<FileText size={22} />}
              title={mode === 'orphans' ? 'No orphan notes' : mode === 'recent' ? 'No notes yet' : 'No matches'}
              description={
                mode === 'orphans'
                  ? 'Every note is reachable through at least one link — healthy graph.'
                  : mode === 'recent'
                    ? 'Notes you touch will show up here.'
                    : 'Try another term, or re-index if this vault was just added.'
              }
            />
          ) : (
            notes.map((n) => (
              <button
                key={n.path}
                onClick={() => setActiveNote(n.path)}
                className={cn(
                  'block w-full border-b border-line/60 px-4 py-2.5 text-left transition-colors hover:bg-panel2/60',
                  activeNote === n.path && 'bg-panel2/80',
                )}
              >
                <div className="flex items-center gap-2">
                  <span className="truncate text-[13px] font-medium text-fg">{n.title}</span>
                  <span className="ml-auto shrink-0 text-[10.5px] text-fgf">{timeAgo(n.mtime)}</span>
                </div>
                <div className="mono truncate text-[10.5px] text-fgf">
                  {n.folder || '/'} · {n.links.length} links · {n.backlinks.length} backlinks{n.unresolved.length ? ` · ${n.unresolved.length} unresolved` : ''}
                </div>
                {n.tags.length > 0 && (
                  <div className="mt-1 flex flex-wrap gap-1">
                    {n.tags.slice(0, 6).map((t) => (
                      <Pill key={t} tone="accent">#{t}</Pill>
                    ))}
                  </div>
                )}
              </button>
            ))
          )}
        </div>
      </div>

      {/* right: note viewer */}
      <NotePane
        vaultId={vid}
        path={activeNote}
        onClose={() => setActiveNote(null)}
        onBacklinks={(p) => setActiveNote(p)}
      />

      <AddVaultDialog open={addOpen} onOpenChange={setAddOpen} onSaved={vaults.reload} />
      <ConfirmDialog
        open={!!removing}
        onOpenChange={(v) => !v && setRemoving(null)}
        title={`Remove ${removing?.name ?? ''}?`}
        message="Fern stops watching and indexing this folder. Notes on disk are untouched."
        confirmLabel="Remove"
        danger
        pending={busy}
        onConfirm={removeVault}
      />
    </div>
  )
}

function BrokenList({ items, loading, onOpen }: { items: { from: string; target: string }[]; loading: boolean; onOpen: (path: string) => void }) {
  if (loading && items.length === 0) return <LoadingRow />
  if (items.length === 0)
    return <EmptyState icon={<Link2 size={22} />} title="No broken links" description="Every [[wiki link]] resolves to an indexed note." />
  return (
    <div>
      {items.map((b, i) => (
        <div key={`${b.from}-${b.target}-${i}`} className="flex items-center gap-2 border-b border-line/60 px-4 py-2.5">
          <AlertOctagon size={13} className="shrink-0 text-warn" />
          <button className="min-w-0 flex-1 text-left" onClick={() => onOpen(b.from)}>
            <div className="mono truncate text-[12px] text-fg">{b.from}</div>
            <div className="mono truncate text-[11px] text-danger">→ {b.target}</div>
          </button>
        </div>
      ))}
    </div>
  )
}

function NotePane({
  vaultId,
  path,
  onClose,
  onBacklinks,
}: {
  vaultId: string
  path: string | null
  onClose: () => void
  onBacklinks: (path: string) => void
}) {
  const note = useApi('notes.get', [vaultId, path ?? ''], { enabled: !!vaultId && !!path })
  const data: VaultNote | null = note.data

  if (!path) {
    return (
      <aside className="hidden w-[380px] shrink-0 flex-col items-center justify-center border-l border-line px-6 text-center xl:flex">
        <FileText size={22} className="mb-2 text-fgf opacity-50" />
        <div className="text-[12.5px] text-fgm">Select a note</div>
        <div className="mt-1 text-[11.5px] leading-relaxed text-fgf">Content, frontmatter, backlinks and unresolved links appear here.</div>
      </aside>
    )
  }

  return (
    <aside data-testid="note-pane-open" className="flex w-[380px] shrink-0 flex-col border-l border-line">
      <div className="flex items-center justify-between gap-2 border-b border-line px-3.5 py-2.5">
        <div className="min-w-0">
          <div className="truncate text-[13px] font-semibold text-fg">{data?.title ?? path.split(/[\\/]/).pop()}</div>
          <div className="mono truncate text-[10.5px] text-fgf">{path}</div>
        </div>
        <button className="btn btn-sm btn-ghost" onClick={onClose}>
          ✕
        </button>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto p-3.5">
        {note.loading && !data ? (
          <LoadingRow />
        ) : note.error ? (
          <ErrorNote message={note.error} onRetry={note.reload} />
        ) : data ? (
          <>
            <div className="mb-3 flex flex-wrap gap-1.5">
              {data.tags.map((t) => (
                <Pill key={t} tone="accent">#{t}</Pill>
              ))}
              <Pill>{data.size} B</Pill>
              <Pill tone="info">{timeAgo(data.mtime)}</Pill>
            </div>
            {Object.keys(data.frontmatter).length > 0 && (
              <div className="mb-3 rounded-md border border-line bg-app p-2.5">
                <div className="stack-title mb-1">Frontmatter</div>
                <pre className="mono whitespace-pre-wrap text-[10.5px] leading-relaxed text-fgm">
                  {Object.entries(data.frontmatter)
                    .map(([k, v]) => `${k}: ${typeof v === 'object' ? JSON.stringify(v) : String(v)}`)
                    .join('\n')}
                </pre>
              </div>
            )}
            <Markdown content={data.content} className="text-[12.5px]" />
            {data.backlinks.length > 0 && (
              <div className="mt-4">
                <div className="stack-title mb-1.5">Backlinks ({data.backlinks.length})</div>
                {data.backlinks.map((b) => (
                  <button
                    key={b}
                    className="mono block w-full truncate rounded px-2 py-1 text-left text-[11.5px] text-info transition-colors hover:bg-panel2"
                    onClick={() => onBacklinks(b)}
                  >
                    ← {b}
                  </button>
                ))}
              </div>
            )}
            {data.unresolved.length > 0 && (
              <div className="mt-3">
                <div className="stack-title mb-1.5">Unresolved ({data.unresolved.length})</div>
                {data.unresolved.map((u) => (
                  <div key={u} className="mono truncate px-2 py-0.5 text-[11.5px] text-warn">
                    {u}
                  </div>
                ))}
              </div>
            )}
          </>
        ) : null}
      </div>
    </aside>
  )
}

function AddVaultDialog({ open, onOpenChange, onSaved }: { open: boolean; onOpenChange: (v: boolean) => void; onSaved: () => void }) {
  const [path, setPath] = useState('')
  const [name, setName] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function choose() {
    const dir = await window.fern.invoke('app.chooseDirectory', { title: 'Select an Obsidian vault' })
    if (dir.ok && dir.data) {
      setPath(dir.data)
      if (!name) setName(dir.data.split(/[\\/]/).filter(Boolean).pop() ?? '')
    }
  }

  async function save() {
    setError(null)
    setBusy(true)
    try {
      await call('vaults.add', { path: path.trim(), ...(name.trim() ? { name: name.trim() } : {}) })
      toast.success('Vault added', 'Indexing starts immediately.')
      onSaved()
      onOpenChange(false)
      setPath('')
      setName('')
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
      title="Add an Obsidian vault"
      description="Fern indexes markdown notes, frontmatter, [[wiki links]] and markdown links. Files are never moved or deleted by the indexer."
      footer={
        <>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button variant="primary" disabled={busy || !path.trim()} onClick={save}>
            {busy ? 'Adding…' : 'Add vault'}
          </Button>
        </>
      }
    >
      <Field label="Vault folder">
        <div className="flex gap-2">
          <Input className="flex-1" value={path} onChange={(e) => setPath(e.target.value)} placeholder="C:\Users\me\Documents\main-brain" />
          <button className="btn" type="button" onClick={choose}>
            Browse…
          </button>
        </div>
      </Field>
      <Field label="Display name">
        <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="main-brain" />
      </Field>
      {error && <ErrorNote message={error} />}
    </Modal>
  )
}
