import { useMemo, useState } from 'react'
import { ChevronDown, ChevronRight, Folder, FolderOpen } from 'lucide-react'
import type { NoteMeta } from '@shared/domain'
import { cn } from '../../lib/format'

export interface FolderNode {
  id: string
  name: string
  parentId: string | null
  noteCount: number
  path: string
}

interface VaultTreeProps {
  folders: FolderNode[]
  notes: Record<string, NoteMeta[]>
  onNavigate: (path: string) => void
  className?: string
}

export function VaultTree({ folders, notes, onNavigate, className }: VaultTreeProps) {
  const realFolders = useMemo(() => folders.filter((f) => f.path !== ''), [folders])
  const [expanded, setExpanded] = useState<Set<string> | null>(null)

  const defaultExpanded = useMemo(
    () => new Set(realFolders.filter((f) => !f.parentId || f.parentId === '').map((f) => f.id)),
    [realFolders],
  )
  const expandedSet = expanded ?? defaultExpanded

  const folderMap = useMemo(() => {
    const map = new Map<string, FolderNode>()
    const children = new Map<string, string[]>()
    realFolders.forEach((f) => {
      map.set(f.id, f)
      if (!children.has(f.parentId ?? '')) children.set(f.parentId ?? '', [])
      children.get(f.parentId ?? '')?.push(f.id)
    })
    return { map, children }
  }, [realFolders])

  const rootFolders = realFolders.filter((f) => !f.parentId || f.parentId === '')
  const rootNotes = notes[''] ?? []

  function toggleNode(id: string) {
    const next = new Set(expandedSet)
    if (next.has(id)) next.delete(id)
    else next.add(id)
    setExpanded(next)
  }

  function renderNotes(items: NoteMeta[], className?: string) {
    return (
      <>
        {items.slice(0, 25).map((n) => (
          <button
            key={n.path}
            data-note-path={n.path}
            onClick={() => onNavigate(n.path)}
            className={cn('block w-full truncate rounded px-2 py-0.5 text-left text-xs text-fgf hover:bg-panel2 hover:text-fg', className)}
          >
            {n.title || n.path.split('/').pop()}
          </button>
        ))}
        {items.length > 25 && <div className="px-2 text-xs text-fgf/60">+ {items.length - 25} more</div>}
      </>
    )
  }

  function renderFolder(folder: FolderNode, depth: number = 0) {
    const isOpen = expandedSet.has(folder.id)
    const hasChildren = (folderMap.children.get(folder.id) ?? []).length > 0
    const folderNotes = notes[folder.path] ?? []

    return (
      <div key={folder.id}>
        <div className="flex items-center gap-1.5 px-2 py-1 text-sm">
          <button
            data-folder-path={folder.path}
            onClick={() => toggleNode(folder.id)}
            className="flex min-w-0 flex-1 items-center gap-1 rounded text-left hover:bg-panel2/60"
            title={`${folder.path} — ${folder.noteCount} note(s)`}
          >
            {hasChildren ? (
              isOpen ? <ChevronDown size={12} className="shrink-0 text-fgf" /> : <ChevronRight size={12} className="shrink-0 text-fgf" />
            ) : (
              <div className="w-3 shrink-0" />
            )}
            {isOpen ? (
              <FolderOpen size={13} className="shrink-0 text-accent" />
            ) : (
              <Folder size={13} className="shrink-0 text-fgf" />
            )}
            <span className="truncate text-xs text-fgm hover:text-fg">{folder.name}</span>
          </button>
          <div className="shrink-0 text-[10.5px] text-fgf">{folder.noteCount}</div>
        </div>
        {isOpen && (
          <div className="ml-3.5 border-l border-line/60 pl-1">
            {hasChildren &&
              (folderMap.children.get(folder.id) ?? [])
                .map((id) => folderMap.map.get(id)!)
                .sort((a, b) => a.name.localeCompare(b.name))
                .map((child) => renderFolder(child, depth + 1))}
            {folderNotes.length > 0 && renderNotes(folderNotes)}
          </div>
        )}
      </div>
    )
  }

  return (
    <div data-testid="vault-tree" className={cn('px-1.5 py-1', className)}>
      {rootNotes.length > 0 && <div className="mb-1">{renderNotes(rootNotes)}</div>}
      {realFolders.length === 0 && rootNotes.length === 0 ? (
        <div className="px-2 py-4 text-xs text-fgf/60">No folders</div>
      ) : (
        rootFolders
          .slice()
          .sort((a, b) => a.name.localeCompare(b.name))
          .map((f) => renderFolder(f))
      )}
    </div>
  )
}
