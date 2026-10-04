import type { Handlers } from '../router'
import { AppError, invalid, notFound } from '@core/kernel/errors'
import { basename, dirname, sep } from 'node:path'
import type { AppContext } from '../../context'

const toPosix = (p: string) => p.split('\\').join('/')

export function obsidianHandlers(ctx: AppContext): Handlers {
  const log = ctx.log('obsidian')

  const requireVaultId = (vaultId?: string): string => {
    const id = vaultId || ctx.config.get().obsidian.defaultVaultId || ctx.repos.vaults.defaultVault()?.id
    if (!id) throw notFound('vault')
    if (!ctx.repos.vaults.getVault(id)) throw notFound('vault', id)
    return id
  }

  const assertWritable = (): void => {
    const policy = ctx.config.get().permissions.vaultWrite
    if (policy === 'deny') throw new AppError('permission_denied', 'vault writes are disabled in settings')
    // 'ask' approval flow is enforced by the write-approval gate (Phase 5)
  }

  return {
    /* vaults ---------------------------------------------------------------- */

    'vaults.list': () => ctx.repos.vaults.listVaults(),

    'vaults.add': async (args) => {
      const input = args[0] as { name?: string; path: string }
      if (!input?.path?.trim()) throw invalid('vault path is required')
      const vault = ctx.vaults.add({ path: input.path.trim(), ...(input.name ? { name: input.name } : {}) })
      log.info('vault added', { id: vault.id, path: vault.path })
      ctx.emit('obsidian.note.changed', { message: `vault registered: ${vault.name}`, data: { vaultId: vault.id } })
      return vault
    },

    'vaults.remove': async (args) => {
      const id = String(args[0])
      const removed = ctx.vaults.remove(id)
      if (removed) {
        if (ctx.config.get().obsidian.defaultVaultId === id) await ctx.config.update({ obsidian: { defaultVaultId: null } })
        ctx.emit('obsidian.error', { message: 'vault removed', severity: 'warn', data: { vaultId: id } })
      }
      return removed
    },

    'vaults.setDefault': async (args) => {
      const id = String(args[0])
      const list = ctx.repos.vaults.setDefaultVault(id)
      await ctx.config.update({ obsidian: { defaultVaultId: id } })
      return list
    },

    'vaults.reindex': async (args) => {
      const id = requireVaultId(String(args[0] || '') || undefined)
      const result = await ctx.vaults.index(id)
      log.info('vault reindexed', { vaultId: id, ...result })
      ctx.emit('obsidian.indexed', {
        message: `indexed ${result.notes} notes (${result.durationMs}ms)`,
        data: { vaultId: id, ...result },
      })
      const vault = ctx.repos.vaults.getVault(id)
      if (!vault) throw notFound('vault', id)
      return vault
    },

    /* notes ------------------------------------------------------------------ */

    'notes.search': (args) => {
      const [query, opts] = args as [string, { vaultId?: string; limit?: number }?]
      const cfg = ctx.config.get()
      const vaultId = opts?.vaultId || cfg.obsidian.defaultVaultId || undefined
      const limit = opts?.limit ?? cfg.obsidian.searchLimit
      return ctx.repos.vaults.search(vaultId, String(query ?? ''), Math.min(limit, 200))
    },

    'notes.get': async (args) => {
      const [vaultId, relPath] = args as [string, string]
      const id = requireVaultId(vaultId)
      return ctx.vaults.read(id, toPosix(relPath))
    },

    'notes.create': async (args) => {
      const [vaultId, input] = args as [string, { path: string; content: string }]
      assertWritable()
      const id = requireVaultId(vaultId)
      const meta = await ctx.vaults.createNote(id, toPosix(input.path), input.content ?? '')
      ctx.emit('obsidian.note.changed', { message: `note created: ${meta.title}`, data: { vaultId: id, path: meta.path } })
      return meta
    },

    'notes.update': async (args) => {
      const [vaultId, relPath, input] = args as [string, string, { content: string }]
      assertWritable()
      const id = requireVaultId(vaultId)
      const meta = await ctx.vaults.updateNote(id, toPosix(relPath), input.content ?? '')
      ctx.emit('obsidian.note.changed', { message: `note updated: ${meta.title}`, data: { vaultId: id, path: meta.path } })
      return meta
    },

    'notes.delete': async (args) => {
      const [vaultId, relPath] = args as [string, string]
      assertWritable()
      const id = requireVaultId(vaultId)
      const removed = await ctx.vaults.deleteNote(id, toPosix(relPath))
      if (removed) ctx.emit('obsidian.note.changed', { message: `note deleted: ${relPath}`, severity: 'warn', data: { vaultId: id } })
      return removed
    },

    'notes.rename': async (args) => {
      const [vaultId, from, to] = args as [string, string, string]
      assertWritable()
      const id = requireVaultId(vaultId)
      const meta = await ctx.vaults.renameNote(id, toPosix(from), toPosix(to))
      ctx.emit('obsidian.note.changed', { message: `note renamed: ${meta.title}`, data: { vaultId: id, path: meta.path } })
      return meta
    },

    /* navigation --------------------------------------------------------------- */

    'notes.folders': (args) => ctx.vaults.folders(requireVaultId(args[0] as string | undefined)),

    'notes.tags': (args) => ctx.vaults.tags(requireVaultId(args[0] as string | undefined)),

    'notes.backlinks': (args) => {
      const [vaultId, relPath] = args as [string, string]
      return ctx.vaults.backlinks(requireVaultId(vaultId), toPosix(relPath))
    },

    'notes.related': (args) => {
      const [vaultId, relPath, limit] = args as [string, string, number?]
      return ctx.vaults.related(requireVaultId(vaultId), toPosix(relPath), limit ?? 10)
    },

    'notes.orphans': (args) => ctx.vaults.orphans(requireVaultId(args[0] as string | undefined)),

    'notes.brokenLinks': (args) => ctx.vaults.brokenLinks(requireVaultId(args[0] as string | undefined)),

    'notes.recent': (args) => {
      const [vaultId, limit] = args as [string?, number?]
      return ctx.vaults.recent(requireVaultId(vaultId), limit ?? 25)
    },

    'notes.list': (args) => {
      const [vaultId, limit] = args as [string?, number?]
      return ctx.vaults.listNotes(requireVaultId(vaultId), limit ?? 500)
    },

    'notes.graph': (args) => ctx.vaults.graph(requireVaultId(args[0] as string | undefined)),
  }
}

/** Small helpers re-exported for tests of path handling. */
export const notePath = {
  title: (relPath: string) => basename(relPath, '.md'),
  folder: (relPath: string) => {
    const d = dirname(toPosix(relPath))
    return d === '.' ? '' : d
  },
  join: (...parts: string[]) => parts.filter(Boolean).join(sep),
}
