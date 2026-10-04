import { statSync } from 'node:fs'
import { basename } from 'node:path'
import type { GitWorktree, Project } from '@shared/domain'
import type { Handlers } from '../router'
import { AppError, invalid, notFound } from '@core/kernel/errors'
import * as git from '@core/services/git'
import { validateProjectPath } from '@core/services/projectPath'
import type { AppContext } from '../../context'

function assertDir(path: string): void {
  if (!path?.trim()) throw invalid('project path is required')
  try {
    if (!statSync(path).isDirectory()) throw invalid(`not a directory: ${path}`)
  } catch (err) {
    if (err instanceof AppError) throw err
    throw invalid(`path does not exist: ${path}`)
  }
}

function toWorktreeRecord(project: Project, w: git.WorktreeInfo): GitWorktree {
  const id = `wt_${Buffer.from(w.path).toString('hex').slice(0, 16)}`
  const t = Date.now()
  return {
    id,
    projectId: project.id,
    path: w.path,
    branch: w.branch,
    workerId: null,
    detached: w.detached,
    status: w.isMain ? 'active' : 'active',
    createdAt: t,
    updatedAt: t,
  }
}

export function projectHandlers(ctx: AppContext): Handlers {
  const log = ctx.log('git')

  return {
    'projects.list': () => ctx.repos.projects.list(),

    'projects.get': (args) => ctx.repos.projects.get(String(args[0])),

    'projects.create': async (args) => {
      const input = args[0] as Partial<Project> & { name: string; path: string }
      assertDir(input.path)
      const normalized = input.path.replace(/[\\/]+$/, '')
      const existing = ctx.repos.projects.getByPath(normalized)
      if (existing) throw new AppError('conflict', `project already registered: ${existing.name}`)

      const project = ctx.repos.projects.create({
        ...input,
        path: normalized,
        name: input.name?.trim() || basename(normalized),
      })
      ctx.emit('project.updated', { projectId: project.id, message: `project registered: ${project.name}` })
      log.info('project created', { id: project.id, path: project.path })
      return project
    },

    'projects.update': async (args) => {
      const [id, patch] = args as [string, Partial<Project>]
      const project = ctx.repos.projects.get(id)
      if (!project) throw notFound('project', id)
      if (patch.path && patch.path !== project.path) assertDir(patch.path)
      const next = ctx.repos.projects.update(id, patch)
      ctx.emit('project.updated', { projectId: id, message: `project updated: ${next.name}` })
      return next
    },

    'projects.delete': async (args) => {
      const id = String(args[0])
      const removed = ctx.repos.projects.delete(id)
      if (removed) ctx.emit('project.updated', { projectId: id, message: 'project removed', severity: 'warn' })
      return removed
    },

    'projects.gitStatus': async (args) => {
      const project = ctx.repos.projects.get(String(args[0]))
      if (!project) throw notFound('project', String(args[0]))
      return git.status(project.path)
    },

    'projects.worktrees': async (args) => {
      const project = ctx.repos.projects.get(String(args[0]))
      if (!project) throw notFound('project', String(args[0]))
      try {
        const list = await git.listWorktrees(project.path)
        return list.map((w) => toWorktreeRecord(project, w))
      } catch {
        return [] as GitWorktree[]
      }
    },

    'projects.createWorktree': async (args) => {
      const [projectId, opts] = args as [string, { branch: string; path?: string }]
      const project = ctx.repos.projects.get(projectId)
      if (!project) throw notFound('project', projectId)
      if (!opts.branch?.trim()) throw invalid('branch name is required')
      const created = await git.createWorktree(project.path, opts.branch, opts.path)
      const record = toWorktreeRecord(project, created)
      ctx.repos.projects.upsertWorktree(record)
      log.info('worktree created', { branch: opts.branch, path: record.path })
      return record
    },

    'projects.removeWorktree': async (args) => {
      const worktreeId = String(args[0])
      const row = ctx.db.get<{ project_id: string; path: string }>('SELECT project_id, path FROM git_worktrees WHERE id = ?', worktreeId)
      if (!row) throw notFound('worktree', worktreeId)
      const project = ctx.repos.projects.get(row.project_id)
      if (!project) throw notFound('project', row.project_id)
      await git.removeWorktree(project.path, row.path)
      return ctx.repos.projects.removeWorktree(worktreeId)
    },

    'projects.discover': (args) => {
      const opts = (args[0] ?? {}) as { roots?: string[] }
      const cfg = ctx.config.get().git
      const roots = opts.roots?.length ? opts.roots : cfg.searchPaths
      const found = git.discoverRepos({
        ...(roots.length ? { roots } : {}),
        ignore: cfg.ignore,
        maxDepth: cfg.maxDiscoveryDepth,
      })
      return found.map((path) => ({ path, registered: Boolean(ctx.repos.projects.getByPath(path)) }))
    },

    'projects.validate': (args) => validateProjectPath(String(args[0] ?? '')),
  } as Handlers
}
