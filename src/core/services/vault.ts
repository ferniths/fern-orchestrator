import { createHash } from 'node:crypto'
import { accessSync, statSync } from 'node:fs'
import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises'
import { basename, dirname, extname, isAbsolute, join, relative, sep } from 'node:path'
import { watch, type FSWatcher } from 'chokidar'
import type { NoteMeta, Vault } from '@shared/domain'
import type { VaultNote } from '@shared/ipc'
import type { Repos } from '../db/repos'
import { AppError } from '../kernel/errors'

const MD = '.md'
const IGNORED_DIRS = new Set(['.obsidian', '.git', '.trash', 'node_modules', '.smart-env'])
const WIKI_LINK = /\[\[([^\]|#]+)(?:#[^\]|]*)?(?:\|([^\]]*))?\]\]/g
const MD_LINK = /(?<!!)\[[^\]]*\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g

export interface ParsedNote {
  frontmatter: Record<string, unknown>
  body: string
  title: string
  tags: string[]
}

/** Minimal frontmatter reader: scalars, inline lists, block lists, one nesting level. */
export function parseFrontmatter(raw: string): ParsedNote {
  const match = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/)
  if (!match) return { frontmatter: {}, body: raw, title: '', tags: extractInlineTags(raw) }

  const block = match[1] ?? ''
  const body = raw.slice(match[0].length)
  const frontmatter: Record<string, unknown> = {}
  let currentKey: string | null = null
  let currentList: string[] | null = null

  for (const line of block.split(/\r?\n/)) {
    if (!line.trim() || line.trim().startsWith('#')) continue
    const listItem = line.match(/^\s+-\s+(.*)$/)
    if (listItem && currentKey) {
      currentList ??= []
      currentList.push(stripQuotes(listItem[1] ?? ''))
      frontmatter[currentKey] = currentList
      continue
    }
    const kv = line.match(/^([A-Za-z0-9_ -]+):\s*(.*)$/)
    if (kv) {
      const key = (kv[1] ?? '').trim()
      const value = (kv[2] ?? '').trim()
      currentKey = key
      currentList = null
      if (value === '') {
        frontmatter[key] = {}
      } else if (value.startsWith('[') && value.endsWith(']')) {
        frontmatter[key] = value
          .slice(1, -1)
          .split(',')
          .map((v) => stripQuotes(v.trim()))
          .filter(Boolean)
      } else {
        frontmatter[key] = coerce(stripQuotes(value))
      }
      continue
    }
    const nested = line.match(/^\s+([A-Za-z0-9_ -]+):\s*(.*)$/)
    if (nested && currentKey && typeof frontmatter[currentKey] === 'object' && frontmatter[currentKey] !== null) {
      ;(frontmatter[currentKey] as Record<string, unknown>)[(nested[1] ?? '').trim()] = coerce(stripQuotes(nested[2] ?? ''))
    }
  }

  const fmTags = frontmatter.tags
  const tags = Array.isArray(fmTags) ? fmTags.map(String) : typeof fmTags === 'string' && fmTags ? fmTags.split(/[,\s]+/).filter(Boolean) : []
  return { frontmatter, body, title: String(frontmatter.title ?? ''), tags: [...new Set([...tags, ...extractInlineTags(body)])] }
}

function stripQuotes(v: string): string {
  const t = v.trim()
  if ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith("'") && t.endsWith("'"))) return t.slice(1, -1)
  return t
}

function coerce(v: string): unknown {
  if (v === 'true') return true
  if (v === 'false') return false
  if (v !== '' && !Number.isNaN(Number(v))) return Number(v)
  return v
}

function extractInlineTags(text: string): string[] {
  const out = new Set<string>()
  for (const m of text.matchAll(/(^|[\s(])#([A-Za-z][\w/-]*)/g)) {
    const tag = m[2]
    if (tag) out.add(tag)
  }
  return [...out]
}

export interface ExtractedLink {
  raw: string
  kind: 'wiki' | 'markdown'
}

export function extractLinks(body: string): ExtractedLink[] {
  const links: ExtractedLink[] = []
  for (const m of body.matchAll(WIKI_LINK)) {
    const target = (m[1] ?? '').trim()
    if (target) links.push({ raw: target, kind: 'wiki' })
  }
  for (const m of body.matchAll(MD_LINK)) {
    const target = (m[1] ?? '').trim()
    if (!target || /^(https?:|mailto:|tel:|data:|#)/i.test(target)) continue
    links.push({ raw: decodeURI(target), kind: 'markdown' })
  }
  return links
}

export interface IndexTargets {
  /** exact rel paths (normalized, lowercase keys) */
  byPath: Map<string, string>
  /** basename without extension → rel paths */
  byBase: Map<string, string[]>
}

function key(p: string): string {
  return p.replace(/\\/g, '/').toLowerCase()
}

/**
 * True only when `abs` resolves to a real child of `vaultPath`.
 * A plain `startsWith` check is not a containment test: `join(vault, '../sibling')`
 * still starts with the vault prefix, so `../../` escapes passed it.
 */
export function insideVault(vaultPath: string, abs: string): boolean {
  const rel = relative(vaultPath, abs)
  return rel !== '' && !rel.startsWith(`..${sep}`) && rel !== '..' && !isAbsolute(rel)
}

/**
 * Callers pass both forms over IPC: list/search results carry absolute paths,
 * backlink and broken-link entries carry vault-relative ones. Accepts either and
 * returns the normalized vault-relative POSIX path, or null when it escapes.
 */
export function toVaultRel(vaultPath: string, input: string): string | null {
  const posix = input.split('\\').join('/')
  const hasDrive = /^[a-zA-Z]:\//.test(posix)
  const abs = hasDrive ? posix : join(vaultPath, posix.replace(/^\/+/, ''))
  return insideVault(vaultPath, abs) ? relative(vaultPath, abs).split('\\').join('/') : null
}

/** Obsidian-style resolution: absolute → relative → basename. */
export function resolveLink(fromRel: string, raw: string, targets: IndexTargets): string | null {
  const cleaned = raw.split('#')[0]?.split('?')[0] ?? ''
  if (!cleaned) return null
  const normalized = cleaned.replace(/\\/g, '/')
  const fromDir = dirname(fromRel).replace(/\\/g, '/')
  const candidates = normalized.startsWith('/')
    ? [normalized.slice(1)]
    : [join(fromDir === '.' ? '' : fromDir, normalized).replace(/\\/g, '/'), normalized]

  for (const c of candidates) {
    const withExt = c.endsWith(MD) ? c : `${c}${MD}`
    const hit = targets.byPath.get(key(withExt))
    if (hit) return hit
  }
  const base = basename(cleaned, extname(cleaned)).toLowerCase()
  const matches = targets.byBase.get(base)
  if (matches && matches.length > 0) return matches[0] ?? null
  return null
}

export interface VaultIndexResult {
  notes: number
  links: number
  unresolved: number
  durationMs: number
}

export class VaultService {
  private readonly watchers = new Map<string, FSWatcher>()
  private readonly debounce = new Map<string, NodeJS.Timeout>()
  /** Serializes full re-index per vault so two concurrent index() calls cannot interleave. */
  private readonly indexChain = new Map<string, Promise<VaultIndexResult>>()
  private onNoteChanged: ((vaultId: string, relPath: string) => void) | null = null
  private onError: ((message: string, data: Record<string, unknown>) => void) | null = null
  private watchEnabled = true
  private debounceMs: number

  constructor(
    private readonly repos: Repos,
    private readonly options: { debounceMs?: number; watch?: boolean } = {},
  ) {
    this.debounceMs = options.debounceMs ?? 400
    this.watchEnabled = options.watch ?? true
  }

  /** Wiring for the app logger — indexing/watch failures must never vanish silently. */
  setErrorHandler(listener: (message: string, data: Record<string, unknown>) => void): void {
    this.onError = listener
  }

  private report(message: string, data: Record<string, unknown>): void {
    try {
      this.onError?.(message, data)
    } catch {
      /* a broken logger must not take the indexer down */
    }
  }

  /** Applies `obsidian.watch` / `obsidian.debounceMs` without a restart. */
  configure(next: { watch?: boolean; debounceMs?: number }): void {
    if (typeof next.debounceMs === 'number' && Number.isFinite(next.debounceMs)) {
      this.debounceMs = Math.max(50, Math.max(0, Math.round(next.debounceMs)))
    }
    if (typeof next.watch === 'boolean' && next.watch !== this.watchEnabled) {
      this.watchEnabled = next.watch
      if (this.watchEnabled) this.watchAll()
      else for (const id of [...this.watchers.keys()]) this.unwatch(id)
    }
  }

  isWatching(): boolean {
    return this.watchEnabled
  }

  onChange(listener: (vaultId: string, relPath: string) => void): void {
    this.onNoteChanged = listener
  }

  /* vault records ----------------------------------------------------------- */

  list(): Vault[] {
    return this.repos.vaults.listVaults()
  }

  get(id: string): Vault | null {
    return this.repos.vaults.getVault(id)
  }

  add(input: { name?: string; path: string }): Vault {
    const target = String(input.path ?? '').trim()
    if (!target) throw new AppError('invalid_argument', 'vault path is required')
    // Validate up front: a typo'd path used to create a "ready" vault with 0 notes.
    let st
    try {
      st = statSync(target)
    } catch (err) {
      throw new AppError('not_found', `vault directory does not exist: ${target}`, { cause: err })
    }
    if (!st.isDirectory()) throw new AppError('invalid_argument', `vault path is not a directory: ${target}`)

    const vault = this.repos.vaults.addVault({ ...input, path: target })
    if (vault.indexStatus === 'never') {
      // `void` here would turn any indexing failure into an unhandled rejection.
      this.index(vault.id).catch((err) => this.report('vault index failed', { vaultId: vault.id, error: String(err) }))
    }
    this.watch(vault.id)
    return vault
  }

  remove(id: string): boolean {
    this.unwatch(id)
    return this.repos.vaults.removeVault(id)
  }

  setDefault(id: string): Vault[] {
    return this.repos.vaults.setDefaultVault(id)
  }

  watchAll(): void {
    if (!this.watchEnabled) return
    for (const v of this.repos.vaults.listVaults()) if (v.enabled) this.watch(v.id)
  }

  dispose(): void {
    for (const id of [...this.watchers.keys()]) this.unwatch(id)
    for (const t of this.debounce.values()) clearTimeout(t)
    this.debounce.clear()
  }

  /* watching ---------------------------------------------------------------- */

  private watch(vaultId: string): void {
    const vault = this.repos.vaults.getVault(vaultId)
    if (!vault || !this.watchEnabled || this.watchers.has(vaultId)) return
    try {
      const watcher = watch(vault.path, {
        ignoreInitial: true,
        depth: 12,
        ignored: (p: string) => {
          const parts = p.split(/[\\/]/)
          return parts.some((part) => IGNORED_DIRS.has(part))
        },
      })
      const handle = (relPath: string, kind: 'upsert' | 'remove') => {
        const wait = this.debounceMs
        const token = `${vaultId}:${relPath}`
        const existing = this.debounce.get(token)
        if (existing) clearTimeout(existing)
        this.debounce.set(
          token,
          setTimeout(() => {
            this.debounce.delete(token)
            void this.handleWatchEvent(vaultId, relPath, kind)
          }, wait),
        )
      }
      watcher.on('add', (p) => p.endsWith(MD) && handle(relative(vault.path, p), 'upsert'))
      watcher.on('change', (p) => p.endsWith(MD) && handle(relative(vault.path, p), 'upsert'))
      watcher.on('unlink', (p) => p.endsWith(MD) && handle(relative(vault.path, p), 'remove'))
      this.watchers.set(vaultId, watcher)
    } catch {
      /* watching is best-effort; indexing still works on demand */
    }
  }

  private unwatch(vaultId: string): void {
    const w = this.watchers.get(vaultId)
    if (w) {
      void w.close()
      this.watchers.delete(vaultId)
    }
    // A debounced event queued before unwatch must not fire afterwards —
    // "watching is off" has to mean exactly that.
    for (const [token, timer] of this.debounce) {
      if (token.startsWith(`${vaultId}:`)) {
        clearTimeout(timer)
        this.debounce.delete(token)
      }
    }
  }

  private async handleWatchEvent(vaultId: string, relPath: string, kind: 'upsert' | 'remove'): Promise<void> {
    try {
      const vault = this.repos.vaults.getVault(vaultId)
      if (!vault) return
      const normalized = relPath.split(sep).join('/')
      if (kind === 'remove') {
        this.repos.vaults.deleteNote(vaultId, normalized)
        await this.reindexLinks(vault)
      } else {
        await this.indexFile(vault, normalized)
        // link targets may now resolve → refresh links of notes pointing at it
        await this.reindexLinks(vault)
      }
      this.refreshCounts(vaultId)
      this.onNoteChanged?.(vaultId, normalized)
    } catch (err) {
      this.report('vault watch handler failed', { vaultId, relPath, error: String(err) })
    }
  }

  /** Keeps `vault.noteCount`/`linkCount` truthful after incremental changes. */
  private refreshCounts(vaultId: string): void {
    try {
      const stats = this.repos.vaults.stats(vaultId)
      this.repos.vaults.updateVaultStatus(vaultId, { noteCount: stats.notes, linkCount: stats.links })
    } catch (err) {
      this.report('vault count refresh failed', { vaultId, error: String(err) })
    }
  }

  /* indexing ---------------------------------------------------------------- */

  async index(vaultId: string): Promise<VaultIndexResult> {
    // Two overlapping full indexes would interleave clearVaultIndex + rebuild
    // and leave nondeterministic counts, so runs are chained per vault.
    const previous = this.indexChain.get(vaultId) ?? Promise.resolve({ notes: 0, links: 0, unresolved: 0, durationMs: 0 })
    const run = previous.catch(() => undefined).then(() => this.buildIndex(vaultId))
    this.indexChain.set(vaultId, run)
    try {
      return await run
    } finally {
      if (this.indexChain.get(vaultId) === run) this.indexChain.delete(vaultId)
    }
  }

  private async buildIndex(vaultId: string): Promise<VaultIndexResult> {
    const started = Date.now()
    const vault = this.repos.vaults.getVault(vaultId)
    if (!vault) throw new AppError('not_found', `vault not found: ${vaultId}`)

    this.repos.vaults.updateVaultStatus(vaultId, { indexStatus: 'building', lastError: null })
    try {
      this.repos.vaults.clearVaultIndex(vaultId)
      const files = await this.listFiles(vault.path)

      const targets: IndexTargets = { byPath: new Map(), byBase: new Map() }
      for (const rel of files) {
        targets.byPath.set(key(rel), rel)
        const base = basename(rel, MD).toLowerCase()
        const arr = targets.byBase.get(base) ?? []
        arr.push(rel)
        targets.byBase.set(base, arr)
      }

      let linkCount = 0
      let unresolved = 0
      for (const rel of files) {
        const result = await this.indexFile(vault, rel, targets)
        linkCount += result.links
        unresolved += result.unresolved
      }

      const noteCount = this.repos.vaults.noteCount(vaultId)
      this.repos.vaults.updateVaultStatus(vaultId, {
        indexStatus: 'ready',
        noteCount,
        linkCount,
        lastIndexedAt: Date.now(),
        lastError: null,
      })
      return { notes: noteCount, links: linkCount, unresolved, durationMs: Date.now() - started }
    } catch (err) {
      this.repos.vaults.updateVaultStatus(vaultId, { indexStatus: 'failed', lastError: String(err) })
      throw AppError.from(err, 'vault_error')
    }
  }

  private async listFiles(root: string): Promise<string[]> {
    const out: string[] = []
    const walk = async (dir: string, depth: number): Promise<void> => {
      if (depth > 24) return
      let entries
      try {
        entries = await readdir(dir, { withFileTypes: true })
      } catch {
        return
      }
      for (const entry of entries) {
        if (entry.name.startsWith('.') && IGNORED_DIRS.has(entry.name)) continue
        const full = join(dir, entry.name)
        if (entry.isDirectory()) {
          if (IGNORED_DIRS.has(entry.name)) continue
          await walk(full, depth + 1)
        } else if (entry.name.endsWith(MD)) {
          out.push(relative(root, full).split(sep).join('/'))
        }
      }
    }
    await walk(root, 0)
    return out
  }

  private async indexFile(
    vault: Vault,
    relPath: string,
    targets?: IndexTargets,
  ): Promise<{ links: number; unresolved: number }> {
    const abs = join(vault.path, relPath)
    let raw: string
    let st
    try {
      raw = await readFile(abs, 'utf8')
      st = await stat(abs)
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code
      if (code === 'ENOENT' || code === 'ENOTDIR') {
        this.repos.vaults.deleteNote(vault.id, relPath)
        return { links: 0, unresolved: 0 }
      }
      // EACCES / EMFILE / antivirus locks are transient: dropping the row would
      // silently forget a note that is still on disk until the next full index.
      throw err
    }

    const parsed = parseFrontmatter(raw)
    const links = extractLinks(parsed.body)
    const ownTargets = targets ?? (await this.buildTargets(vault))
    const resolved = links.map((l) => ({ ...l, toRel: resolveLink(relPath, l.raw, ownTargets) }))

    const folder = dirname(relPath) === '.' ? '' : dirname(relPath).split(sep).join('/')
    const title = parsed.title || basename(relPath, MD)

    this.repos.vaults.upsertNote({
      vaultId: vault.id,
      path: abs,
      relPath,
      title,
      folder,
      tags: parsed.tags,
      links: links.map((l) => l.raw),
      unresolved: resolved.filter((r) => !r.toRel).map((r) => r.raw),
      frontmatter: parsed.frontmatter,
      contentHash: createHash('sha1').update(raw).digest('hex'),
      mtime: Math.floor(st.mtimeMs),
      size: st.size,
      content: parsed.body,
    })
    this.repos.vaults.replaceLinks(
      vault.id,
      relPath,
      // unresolved targets are stored as written so broken links stay detectable
      resolved.map((r) => ({ toRel: r.toRel ?? r.raw, toRaw: r.raw, kind: r.kind })),
    )
    return { links: links.length, unresolved: resolved.filter((r) => !r.toRel).length }
  }

  private async buildTargets(vault: Vault): Promise<IndexTargets> {
    const rows = this.repos.vaults.listNotes(vault.id, 100_000)
    const targets: IndexTargets = { byPath: new Map(), byBase: new Map() }
    for (const meta of rows) {
      const rel = meta.path.startsWith(vault.path) ? meta.path.slice(vault.path.length + 1).split(sep).join('/') : meta.path
      targets.byPath.set(key(rel), rel)
      const base = basename(rel, MD).toLowerCase()
      const arr = targets.byBase.get(base) ?? []
      arr.push(rel)
      targets.byBase.set(base, arr)
    }
    return targets
  }

  /**
   * Re-resolves every note's outgoing links after a target changed.
   *
   * Preserves each link's recorded wiki/markdown kind (re-deriving it from the
   * raw target is impossible, so the old code silently demoted every link to
   * `wiki`), and rewrites `notes.unresolved` as well — otherwise a note that
   * pointed at a missing target keeps showing it as broken after that target
   * appears. Returns the vault-wide link count for the vault status row.
   */
  private async reindexLinks(vault: Vault): Promise<number> {
    const targets = await this.buildTargets(vault)
    const kindByKey = new Map<string, string>()
    for (const row of this.repos.vaults.linkRows(vault.id)) kindByKey.set(row.from + ' ' + row.raw, row.kind)

    let linkTotal = 0
    for (const note of this.repos.vaults.listLinkData(vault.id)) {
      const resolved = note.links.map((raw) => ({ raw, toRel: resolveLink(note.rel, raw, targets) }))
      linkTotal += resolved.length
      this.repos.vaults.replaceLinks(
        vault.id,
        note.rel,
        resolved.map((r) => ({
          toRel: r.toRel ?? r.raw,
          toRaw: r.raw,
          kind: kindByKey.get(note.rel + ' ' + r.raw) === 'markdown' ? ('markdown' as const) : ('wiki' as const),
        })),
      )
      const unresolved = resolved.filter((r) => !r.toRel).map((r) => r.raw)
      const prev = note.unresolved
      if (unresolved.length !== prev.length || unresolved.some((u, i) => u !== prev[i])) {
        this.repos.vaults.setUnresolved(vault.id, note.rel, unresolved)
      }
    }
    return linkTotal
  }

  /* queries ----------------------------------------------------------------- */

  search(vaultId: string | undefined, query: string, limit = 50): NoteMeta[] {
    return this.repos.vaults.search(vaultId, query, limit)
  }

  backlinks(vaultId: string, relPath: string): NoteMeta[] {
    const vault = this.repos.vaults.getVault(vaultId)
    if (!vault) return []
    const rel = toVaultRel(vault.path, relPath)
    if (!rel) throw new AppError('permission_denied', 'path escapes vault')
    return this.repos.vaults.backlinks(vaultId, rel)
  }

  folders(vaultId: string) {
    return this.repos.vaults.folders(vaultId)
  }

  tags(vaultId: string) {
    return this.repos.vaults.tags(vaultId)
  }

  orphans(vaultId: string): NoteMeta[] {
    return this.repos.vaults.orphans(vaultId)
  }

  brokenLinks(vaultId: string): { from: string; target: string }[] {
    return this.repos.vaults.brokenLinks(vaultId)
  }

  recent(vaultId: string, limit = 25): NoteMeta[] {
    return this.repos.vaults.recent(vaultId, limit)
  }

  listNotes(vaultId: string, limit = 500): NoteMeta[] {
    return this.repos.vaults.listNotes(vaultId, limit)
  }

  graph(vaultId: string) {
    return this.repos.vaults.graph(vaultId)
  }

  async read(vaultId: string, relPath: string): Promise<VaultNote | null> {
    const vault = this.repos.vaults.getVault(vaultId)
    if (!vault) throw new AppError('not_found', `vault not found: ${vaultId}`)
    const normalized = toVaultRel(vault.path, relPath)
    if (!normalized) throw new AppError('permission_denied', 'path escapes vault')
    const abs = join(vault.path, normalized)
    try {
      const content = await readFile(abs, 'utf8')
      return this.repos.vaults.noteDetail(vault, normalized, content)
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code
      if (code !== 'ENOENT' && code !== 'ENOTDIR') this.report('vault read failed', { vaultId, relPath, error: String(err) })
      return null
    }
  }

  /** Score relatedness: shared links, shared tags, shared backlinks. */
  related(vaultId: string, relPath: string, limit = 10): { meta: NoteMeta; score: number }[] {
    const seedPath = this.relOf(vaultId, relPath)
    if (!seedPath) return []
    const seed = this.repos.vaults.getNoteRow(vaultId, seedPath)
    if (!seed) return []
    const seedTags = new Set<string>(JSON.parse(String(seed.tags || '[]')) as string[])
    const seedLinks = new Set(this.repos.vaults.outboundLinks(vaultId, seedPath))
    const backlinking = new Set(this.repos.vaults.backlinks(vaultId, seedPath).map((b) => b.path))

    const scored = new Map<string, number>()
    const bump = (rel: string, by: number) => scored.set(rel, (scored.get(rel) ?? 0) + by)

    for (const l of seedLinks) bump(l, 3)
    for (const b of backlinking) {
      const rel = this.relOf(vaultId, b)
      if (rel) bump(rel, 3)
    }

    const all = this.repos.vaults.listNotes(vaultId, 20_000)
    const out: { meta: NoteMeta; score: number }[] = []
    for (const meta of all) {
      const rel = this.relOf(vaultId, meta.path)
      if (!rel || rel === seedPath) continue
      let score = scored.get(rel) ?? 0
      for (const t of meta.tags) if (seedTags.has(t)) score += 1
      if (score > 0) out.push({ meta, score })
    }
    return out.sort((a, b) => b.score - a.score).slice(0, limit)
  }

  private relOf(vaultId: string, absOrRel: string): string | null {
    const vault = this.repos.vaults.getVault(vaultId)
    if (!vault) return null
    return toVaultRel(vault.path, absOrRel)
  }

  /* write operations -------------------------------------------------------- */

  async createNote(vaultId: string, relPath: string, content: string): Promise<NoteMeta> {
    const vault = this.require(vaultId)
    const normalized = this.safeRel(vault, relPath)
    const abs = join(vault.path, normalized)
    if (existsSafe(abs)) throw new AppError('conflict', `note already exists: ${normalized}`)
    await mkdir(dirname(abs), { recursive: true })
    await writeFile(abs, content, 'utf8')
    await this.indexFile(vault, normalized)
    await this.reindexLinks(vault)
    const row = this.repos.vaults.getNoteRow(vaultId, normalized)
    if (!row) throw new AppError('vault_error', 'note was written but not indexed')
    return this.repos.vaults.hydrateMeta(row, vault.path)
  }

  async updateNote(vaultId: string, relPath: string, content: string): Promise<NoteMeta> {
    const vault = this.require(vaultId)
    const normalized = this.safeRel(vault, relPath)
    const abs = join(vault.path, normalized)
    if (!existsSafe(abs)) throw new AppError('not_found', `note not found: ${normalized}`)
    await writeFile(abs, content, 'utf8')
    await this.indexFile(vault, normalized)
    await this.reindexLinks(vault)
    const row = this.repos.vaults.getNoteRow(vaultId, normalized)
    if (!row) throw new AppError('vault_error', 'note was written but not indexed')
    return this.repos.vaults.hydrateMeta(row, vault.path)
  }

  async deleteNote(vaultId: string, relPath: string): Promise<boolean> {
    const vault = this.require(vaultId)
    const normalized = this.safeRel(vault, relPath)
    const abs = join(vault.path, normalized)
    await rm(abs, { force: true })
    const removed = this.repos.vaults.deleteNote(vaultId, normalized)
    await this.reindexLinks(vault)
    return removed
  }

  async renameNote(vaultId: string, fromRel: string, toRel: string): Promise<NoteMeta> {
    const vault = this.require(vaultId)
    const from = this.safeRel(vault, fromRel)
    const to = this.safeRel(vault, toRel)
    const fromAbs = join(vault.path, from)
    const toAbs = join(vault.path, to)
    if (!existsSafe(fromAbs)) throw new AppError('not_found', `note not found: ${from}`)
    if (existsSafe(toAbs)) throw new AppError('conflict', `target already exists: ${to}`)
    await mkdir(dirname(toAbs), { recursive: true })
    await rename(fromAbs, toAbs)
    this.repos.vaults.deleteNote(vaultId, from)
    await this.indexFile(vault, to)
    await this.reindexLinks(vault)
    const row = this.repos.vaults.getNoteRow(vaultId, to)
    if (!row) throw new AppError('vault_error', 'note was renamed but not indexed')
    return this.repos.vaults.hydrateMeta(row, vault.path)
  }

  private require(vaultId: string): Vault {
    const vault = this.repos.vaults.getVault(vaultId)
    if (!vault) throw new AppError('not_found', `vault not found: ${vaultId}`)
    return vault
  }

  private safeRel(vault: Vault, relPath: string): string {
    const normalized = toVaultRel(vault.path, relPath)
    if (!normalized) throw new AppError('permission_denied', 'path escapes vault')
    if (!normalized.endsWith(MD)) throw new AppError('invalid_argument', 'only .md notes are supported')
    return normalized
  }
}

function existsSafe(p: string): boolean {
  try {
    accessSync(p)
    return true
  } catch {
    return false
  }
}
