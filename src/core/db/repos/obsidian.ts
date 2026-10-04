import type { NoteMeta, Vault } from '@shared/domain'
import { vaultSchema } from '@shared/domain'
import { join } from 'node:path'
import { newId, now } from '../../kernel/ids'
import type { Db } from '../db'
import { bool, flag, j, num, nullableNum, nullableStr, str, type Row } from './helpers'
import type { GraphData, VaultNote } from '@shared/ipc'

function toVault(row: Row): Vault {
  return vaultSchema.parse({
    id: row.id,
    name: row.name,
    path: row.path,
    enabled: bool(row.enabled),
    lastIndexedAt: nullableNum(row.last_indexed_at),
    noteCount: num(row.note_count),
    linkCount: num(row.link_count),
    indexStatus: row.index_status,
    lastError: row.last_error,
    isDefault: bool(row.is_default),
    createdAt: num(row.created_at),
    updatedAt: num(row.updated_at),
  })
}

function toMeta(row: Row, vaultPath?: string): NoteMeta {
  return {
    path: vaultPath ? join(vaultPath, str(row.rel_path)) : str(row.path),
    title: str(row.title),
    folder: str(row.folder),
    tags: j(row.tags, []),
    links: j(row.links, []),
    backlinks: [],
    unresolved: j(row.unresolved, []),
    size: num(row.size),
    mtime: num(row.mtime),
    hasFrontmatter: bool(row.has_frontmatter),
  }
}

/** FTS5 accepts user input — quoting turns arbitrary text into safe literal terms. */
export function toFtsQuery(input: string): string {
  const terms = input
    .replace(/["]/g, ' ')
    .split(/\s+/)
    .map((t) => t.trim())
    .filter((t) => t.length > 0)
    .slice(0, 12)
  if (terms.length === 0) return '""'
  return terms.map((t, i) => (i === terms.length - 1 ? `"${t}"*` : `"${t}"`)).join(' AND ')
}

export class VaultRepo {
  constructor(private readonly db: Db) {}

  /* vaults ------------------------------------------------------------------ */

  listVaults(): Vault[] {
    return this.db.all<Row>('SELECT * FROM vaults ORDER BY is_default DESC, name').map(toVault)
  }

  getVault(id: string): Vault | null {
    const row = this.db.get<Row>('SELECT * FROM vaults WHERE id = ?', id)
    return row ? toVault(row) : null
  }

  getVaultByPath(path: string): Vault | null {
    const row = this.db.get<Row>('SELECT * FROM vaults WHERE path = ?', path)
    return row ? toVault(row) : null
  }

  defaultVault(): Vault | null {
    const row = this.db.get<Row>('SELECT * FROM vaults WHERE is_default = 1 LIMIT 1')
    return row ? toVault(row) : this.listVaults()[0] ?? null
  }

  addVault(input: { name?: string; path: string; isDefault?: boolean }): Vault {
    const existing = this.getVaultByPath(input.path)
    if (existing) return existing
    const t = now()
    const entity = vaultSchema.parse({
      id: newId('vlt'),
      name: input.name ?? input.path.split(/[\\/]/).filter(Boolean).pop() ?? 'Vault',
      path: input.path,
      enabled: true,
      isDefault: input.isDefault ?? this.listVaults().length === 0,
      createdAt: t,
      updatedAt: t,
    })
    if (entity.isDefault) this.db.run('UPDATE vaults SET is_default = 0')
    this.db.run(
      `INSERT INTO vaults (id, name, path, enabled, last_indexed_at, note_count, link_count, index_status, last_error, is_default, created_at, updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
      entity.id,
      entity.name,
      entity.path,
      flag(entity.enabled),
      entity.lastIndexedAt,
      entity.noteCount,
      entity.linkCount,
      entity.indexStatus,
      entity.lastError,
      flag(entity.isDefault),
      entity.createdAt,
      entity.updatedAt,
    )
    return entity
  }

  removeVault(id: string): boolean {
    let removed = false
    this.db.tx(() => {
      removed = this.db.run('DELETE FROM vaults WHERE id = ?', id).changes > 0
      // `notes` cascades via FK, but `note_links` and `notes_fts` have none —
      // without this they leak and later inflate global stats.
      this.db.run('DELETE FROM note_links WHERE vault_id = ?', id)
      this.db.run('DELETE FROM notes_fts WHERE vault_id = ?', id)
      this.db.run('DELETE FROM notes WHERE vault_id = ?', id)
    })
    return removed
  }

  setDefaultVault(id: string): Vault[] {
    this.db.tx(() => {
      this.db.run('UPDATE vaults SET is_default = 0')
      this.db.run('UPDATE vaults SET is_default = 1, updated_at = ? WHERE id = ?', now(), id)
    })
    return this.listVaults()
  }

  updateVaultStatus(id: string, patch: Partial<Pick<Vault, 'indexStatus' | 'noteCount' | 'linkCount' | 'lastIndexedAt' | 'lastError'>>): void {
    const current = this.getVault(id)
    if (!current) return
    const next = { ...current, ...patch, updatedAt: now() }
    this.db.run(
      'UPDATE vaults SET index_status = ?, note_count = ?, link_count = ?, last_indexed_at = ?, last_error = ?, updated_at = ? WHERE id = ?',
      next.indexStatus,
      next.noteCount,
      next.linkCount,
      next.lastIndexedAt,
      next.lastError,
      next.updatedAt,
      id,
    )
  }

  /* notes ------------------------------------------------------------------- */

  upsertNote(input: {
    vaultId: string
    path: string
    relPath: string
    title: string
    folder: string
    tags: string[]
    links: string[]
    unresolved: string[]
    frontmatter: Record<string, unknown>
    contentHash: string
    mtime: number
    size: number
    content: string
  }): void {
    const t = now()
    const id = newId('nte')
    this.db.run(
      `INSERT INTO notes (id, vault_id, path, rel_path, title, folder, tags, links, unresolved, frontmatter, has_frontmatter, content_hash, mtime, size, indexed_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
       ON CONFLICT(vault_id, rel_path) DO UPDATE SET
         path=excluded.path, title=excluded.title, folder=excluded.folder, tags=excluded.tags,
         links=excluded.links, unresolved=excluded.unresolved, frontmatter=excluded.frontmatter,
         has_frontmatter=excluded.has_frontmatter, content_hash=excluded.content_hash,
         mtime=excluded.mtime, size=excluded.size, indexed_at=excluded.indexed_at`,
      id,
      input.vaultId,
      input.path,
      input.relPath,
      input.title,
      input.folder,
      JSON.stringify(input.tags),
      JSON.stringify(input.links),
      JSON.stringify(input.unresolved),
      JSON.stringify(input.frontmatter ?? {}),
      Object.keys(input.frontmatter ?? {}).length > 0 ? 1 : 0,
      input.contentHash,
      input.mtime,
      input.size,
      t,
    )

    this.db.run("DELETE FROM notes_fts WHERE vault_id = ? AND rel_path = ?", input.vaultId, input.relPath)
    this.db.run(
      'INSERT INTO notes_fts (rel_path, vault_id, title, folder, tags, content) VALUES (?,?,?,?,?,?)',
      input.relPath,
      input.vaultId,
      input.title,
      input.folder,
      input.tags.join(' '),
      input.content,
    )
  }

  replaceLinks(
    vaultId: string,
    fromRel: string,
    links: { toRel: string; toRaw: string; kind: 'wiki' | 'markdown' }[],
  ): void {
    this.db.run('DELETE FROM note_links WHERE vault_id = ? AND from_rel = ?', vaultId, fromRel)
    for (const l of links) {
      this.db.run(
        'INSERT OR REPLACE INTO note_links (vault_id, from_rel, to_rel, to_raw, kind) VALUES (?,?,?,?,?)',
        vaultId,
        fromRel,
        l.toRel,
        l.toRaw,
        l.kind,
      )
    }
  }

  /** Raw link targets per note — no hydration, so a full-vault refresh stays O(n) queries total. */
  listLinkData(vaultId: string): { rel: string; links: string[]; unresolved: string[] }[] {
    return this.db
      .all<Row>('SELECT rel_path, links, unresolved FROM notes WHERE vault_id = ?', vaultId)
      .map((r) => ({ rel: str(r.rel_path), links: j<string[]>(r.links, []), unresolved: j<string[]>(r.unresolved, []) }))
  }

  /** Every stored link row, so a refresh can preserve the recorded `wiki`/`markdown` kind. */
  linkRows(vaultId: string): { from: string; to: string; raw: string; kind: string }[] {
    return this.db
      .all<Row>('SELECT from_rel, to_rel, to_raw, kind FROM note_links WHERE vault_id = ?', vaultId)
      .map((r) => ({ from: str(r.from_rel), to: str(r.to_rel), raw: str(r.to_raw), kind: str(r.kind) }))
  }

  /** Recomputes one note's unresolved-link list without rewriting the whole row. */
  setUnresolved(vaultId: string, relPath: string, unresolved: string[]): void {
    this.db.run('UPDATE notes SET unresolved = ? WHERE vault_id = ? AND rel_path = ?', JSON.stringify(unresolved), vaultId, relPath)
  }

  deleteNote(vaultId: string, relPath: string): boolean {
    const changes = this.db.run('DELETE FROM notes WHERE vault_id = ? AND rel_path = ?', vaultId, relPath).changes
    this.db.run('DELETE FROM notes_fts WHERE vault_id = ? AND rel_path = ?', vaultId, relPath)
    this.db.run('DELETE FROM note_links WHERE vault_id = ? AND from_rel = ?', vaultId, relPath)
    return changes > 0
  }

  clearVaultIndex(vaultId: string): void {
    this.db.tx(() => {
      this.db.run('DELETE FROM notes WHERE vault_id = ?', vaultId)
      this.db.run('DELETE FROM note_links WHERE vault_id = ?', vaultId)
      this.db.run('DELETE FROM notes_fts WHERE vault_id = ?', vaultId)
    })
  }

  getNoteRow(vaultId: string, relPath: string): Row | null {
    return this.db.get<Row>('SELECT * FROM notes WHERE vault_id = ? AND rel_path = ?', vaultId, relPath) ?? null
  }

  listNotes(vaultId: string, limit = 500): NoteMeta[] {
    const vault = this.getVault(vaultId)
    return this.db
      .all<Row>('SELECT * FROM notes WHERE vault_id = ? ORDER BY rel_path LIMIT ?', vaultId, limit)
      .map((r) => this.hydrateMeta(r, vault?.path))
  }

  hydrateMeta(row: Row, vaultPath?: string): NoteMeta {
    const rel = str(row.rel_path)
    const vaultId = str(row.vault_id)
    const backlinks = this.db.all<Row>('SELECT from_rel FROM note_links WHERE vault_id = ? AND to_rel = ?', vaultId, rel)
    return {
      ...toMeta(row, vaultPath),
      backlinks: backlinks.map((b) => str(b.from_rel)),
    }
  }

  search(vaultId: string | undefined, query: string, limit = 50): NoteMeta[] {
    const fts = toFtsQuery(query)
    const rows = vaultId
      ? this.db.all<Row>(
          `SELECT n.*, bm25(notes_fts) AS rank FROM notes_fts JOIN notes n ON n.vault_id = notes_fts.vault_id AND n.rel_path = notes_fts.rel_path
           WHERE notes_fts MATCH ? AND n.vault_id = ? ORDER BY rank LIMIT ?`,
          fts,
          vaultId,
          limit,
        )
      : this.db.all<Row>(
          `SELECT n.*, bm25(notes_fts) AS rank FROM notes_fts JOIN notes n ON n.vault_id = notes_fts.vault_id AND n.rel_path = notes_fts.rel_path
           WHERE notes_fts MATCH ? ORDER BY rank LIMIT ?`,
          fts,
          limit,
        )
    return rows.map((r) => this.hydrateMeta(r))
  }

  searchRaw(vaultId: string | undefined, query: string, limit = 50): { meta: NoteMeta; snippet: string }[] {
    const fts = toFtsQuery(query)
    const rows = vaultId
      ? this.db.all<Row>(
          `SELECT n.*, snippet(notes_fts, 5, '[', ']', '…', 12) AS snip, bm25(notes_fts) AS rank
           FROM notes_fts JOIN notes n ON n.vault_id = notes_fts.vault_id AND n.rel_path = notes_fts.rel_path
           WHERE notes_fts MATCH ? AND n.vault_id = ? ORDER BY rank LIMIT ?`,
          fts,
          vaultId,
          limit,
        )
      : this.db.all<Row>(
          `SELECT n.*, snippet(notes_fts, 5, '[', ']', '…', 12) AS snip, bm25(notes_fts) AS rank
           FROM notes_fts JOIN notes n ON n.vault_id = notes_fts.vault_id AND n.rel_path = notes_fts.rel_path
           WHERE notes_fts MATCH ? ORDER BY rank LIMIT ?`,
          fts,
          limit,
        )
    return rows.map((r) => ({ meta: this.hydrateMeta(r), snippet: str(r.snip) }))
  }

  backlinks(vaultId: string, relPath: string): NoteMeta[] {
    const rows = this.db.all<Row>(
      `SELECT n.* FROM note_links l JOIN notes n ON n.vault_id = l.vault_id AND n.rel_path = l.from_rel
       WHERE l.vault_id = ? AND l.to_rel = ?`,
      vaultId,
      relPath,
    )
    return rows.map((r) => this.hydrateMeta(r))
  }

  outboundLinks(vaultId: string, relPath: string): string[] {
    return this.db
      .all<Row>('SELECT to_rel FROM note_links WHERE vault_id = ? AND from_rel = ?', vaultId, relPath)
      .map((r) => str(r.to_rel))
  }

  folders(vaultId: string): { path: string; name: string; noteCount: number; depth: number }[] {
    const rows = this.db.all<Row>('SELECT folder, COUNT(*) AS c FROM notes WHERE vault_id = ? GROUP BY folder', vaultId)
    const map = new Map<string, number>()
    for (const r of rows) {
      const folder = str(r.folder)
      map.set(folder, num(r.c))
      // count descendants into each ancestor folder
      const parts = folder.split('/').filter(Boolean)
      for (let i = 1; i < parts.length; i++) {
        const ancestor = parts.slice(0, i).join('/')
        map.set(ancestor, (map.get(ancestor) ?? 0) + num(r.c))
      }
    }
    return [...map.entries()]
      .map(([path, count]) => ({
        path,
        name: path === '' ? '(root)' : (path.split('/').pop() ?? path),
        noteCount: count,
        depth: path === '' ? 0 : path.split('/').length,
      }))
      .sort((a, b) => a.path.localeCompare(b.path))
  }

  tags(vaultId: string): { tag: string; count: number }[] {
    const rows = this.db.all<Row>('SELECT tags FROM notes WHERE vault_id = ?', vaultId)
    const counts = new Map<string, number>()
    for (const r of rows) {
      for (const tag of j<string[]>(r.tags, [])) counts.set(tag, (counts.get(tag) ?? 0) + 1)
    }
    return [...counts.entries()].map(([tag, count]) => ({ tag, count })).sort((a, b) => b.count - a.count)
  }

  orphans(vaultId: string): NoteMeta[] {
    const rows = this.db.all<Row>(
      `SELECT n.* FROM notes n WHERE n.vault_id = ?
         AND NOT EXISTS (SELECT 1 FROM note_links l WHERE l.vault_id = n.vault_id AND l.from_rel = n.rel_path)
         AND NOT EXISTS (SELECT 1 FROM note_links l WHERE l.vault_id = n.vault_id AND l.to_rel = n.rel_path)`,
      vaultId,
    )
    return rows.map((r) => this.hydrateMeta(r))
  }

  brokenLinks(vaultId: string): { from: string; target: string }[] {
    return this.db
      .all<Row>(
        `SELECT l.from_rel, l.to_rel FROM note_links l
         WHERE l.vault_id = ? AND NOT EXISTS (SELECT 1 FROM notes n WHERE n.vault_id = l.vault_id AND n.rel_path = l.to_rel)`,
        vaultId,
      )
      .map((r) => ({ from: str(r.from_rel), target: str(r.to_rel) }))
  }

  graph(vaultId: string, limit = 3000): GraphData {
    const notes = this.db.all<Row>('SELECT rel_path, title, folder, tags FROM notes WHERE vault_id = ? LIMIT ?', vaultId, limit)
    const links = this.db.all<Row>('SELECT from_rel, to_rel, kind FROM note_links WHERE vault_id = ?', vaultId)
    const degree = new Map<string, number>()
    const edges: GraphData['edges'] = []
    const existing = new Set(notes.map((n) => str(n.rel_path)))
    for (const l of links) {
      const from = str(l.from_rel)
      const to = str(l.to_rel)
      // Both ends must be in the node set: the node list is LIMIT-bounded, so
      // checking only `to` would emit edges pointing at nodes that were cut.
      if (!existing.has(to) || !existing.has(from)) continue
      degree.set(from, (degree.get(from) ?? 0) + 1)
      degree.set(to, (degree.get(to) ?? 0) + 1)
      edges.push({ source: from, target: to, kind: str(l.kind) === 'markdown' ? 'markdown' : 'wiki' })
    }
    const nodes = notes.map((n) => {
      const rel = str(n.rel_path)
      const d = degree.get(rel) ?? 0
      return { id: rel, label: str(n.title) || rel, folder: str(n.folder), tags: j(n.tags, []), degree: d, orphans: d === 0 }
    })
    return { nodes, edges }
  }

  recent(vaultId: string, limit = 25): NoteMeta[] {
    return this.db
      .all<Row>('SELECT * FROM notes WHERE vault_id = ? ORDER BY mtime DESC LIMIT ?', vaultId, limit)
      .map((r) => this.hydrateMeta(r))
  }

  /** Build the full in-memory note payload (content read by the caller from disk). */
  noteDetail(vault: Vault, relPath: string, content: string): VaultNote | null {
    const row = this.getNoteRow(vault.id, relPath)
    if (!row) return null
    const meta = this.hydrateMeta(row, vault.path)
    return {
      path: meta.path,
      title: meta.title,
      folder: meta.folder,
      content,
      tags: meta.tags,
      frontmatter: j(row.frontmatter, {}),
      links: meta.links,
      backlinks: meta.backlinks,
      unresolved: meta.unresolved,
      mtime: meta.mtime,
      size: meta.size,
    }
  }

  stats(vaultId?: string): { notes: number; links: number; lastIndexedAt: number | null } {
    const row = vaultId
      ? this.db.get<Row>('SELECT COUNT(*) AS n FROM notes WHERE vault_id = ?', vaultId)
      : this.db.get<Row>('SELECT COUNT(*) AS n FROM notes')
    const links = vaultId
      ? this.db.get<Row>('SELECT COUNT(*) AS n FROM note_links WHERE vault_id = ?', vaultId)
      : this.db.get<Row>('SELECT COUNT(*) AS n FROM note_links')
    const vault = vaultId ? this.getVault(vaultId) : this.defaultVault()
    return { notes: num(row?.n), links: num(links?.n), lastIndexedAt: vault?.lastIndexedAt ?? null }
  }

  vaultPath(vaultId: string): string | null {
    return nullableStr(this.db.get<Row>('SELECT path FROM vaults WHERE id = ?', vaultId)?.path)
  }

  noteCount(vaultId: string): number {
    return num(this.db.get<Row>('SELECT COUNT(*) AS c FROM notes WHERE vault_id = ?', vaultId)?.c)
  }
}
