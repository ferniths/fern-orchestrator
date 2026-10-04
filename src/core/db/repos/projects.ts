import type { GitWorktree, Project } from '@shared/domain'
import { projectSchema } from '@shared/domain'
import { newId, now } from '../../kernel/ids'
import type { Db } from '../db'
import { bool, flag, j, num, nullableNum, nullableStr, str, w, type Row } from './helpers'

function toProject(row: Row): Project {
  return projectSchema.parse({
    id: row.id,
    name: row.name,
    path: row.path,
    description: row.description,
    instructions: row.instructions,
    vaultId: row.vault_id,
    workspaceStrategy: row.workspace_strategy,
    defaultModel: row.default_model,
    enabled: bool(row.enabled),
    lastOpenedAt: nullableNum(row.last_opened_at),
    metadata: j(row.metadata, {}),
    createdAt: num(row.created_at),
    updatedAt: num(row.updated_at),
  })
}

function toWorktree(row: Row): GitWorktree {
  return {
    id: str(row.id),
    projectId: str(row.project_id),
    path: str(row.path),
    branch: str(row.branch),
    workerId: nullableStr(row.worker_id),
    detached: bool(row.detached),
    status: str(row.status) as GitWorktree['status'],
    createdAt: num(row.created_at),
    updatedAt: num(row.updated_at),
  }
}

export class ProjectRepo {
  constructor(private readonly db: Db) {}

  list(): Project[] {
    return this.db.all<Row>('SELECT * FROM projects ORDER BY name COLLATE NOCASE').map(toProject)
  }

  get(id: string): Project | null {
    const row = this.db.get<Row>('SELECT * FROM projects WHERE id = ?', id)
    return row ? toProject(row) : null
  }

  getByPath(path: string): Project | null {
    const row = this.db.get<Row>('SELECT * FROM projects WHERE path = ?', path)
    return row ? toProject(row) : null
  }

  create(input: Partial<Project> & { name: string; path: string }): Project {
    const base = projectSchema.parse({ ...input, id: newId('prj'), createdAt: now(), updatedAt: now() })
    this.db.run(
      `INSERT INTO projects (id, name, path, description, instructions, vault_id, workspace_strategy, default_model, enabled, last_opened_at, metadata, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      base.id,
      base.name,
      base.path,
      base.description,
      base.instructions,
      base.vaultId,
      base.workspaceStrategy,
      base.defaultModel,
      flag(base.enabled),
      base.lastOpenedAt,
      w(base.metadata),
      base.createdAt,
      base.updatedAt,
    )
    return base
  }

  update(id: string, patch: Partial<Project>): Project {
    const current = this.get(id)
    if (!current) throw new Error(`project not found: ${id}`)
    const next = projectSchema.parse({ ...current, ...patch, id, updatedAt: now() })
    this.db.run(
      `UPDATE projects SET name=?, path=?, description=?, instructions=?, vault_id=?, workspace_strategy=?, default_model=?, enabled=?, last_opened_at=?, metadata=?, updated_at=? WHERE id=?`,
      next.name,
      next.path,
      next.description,
      next.instructions,
      next.vaultId,
      next.workspaceStrategy,
      next.defaultModel,
      flag(next.enabled),
      next.lastOpenedAt,
      w(next.metadata),
      next.updatedAt,
      id,
    )
    return next
  }

  touch(id: string): void {
    this.db.run('UPDATE projects SET last_opened_at = ?, updated_at = ? WHERE id = ?', now(), now(), id)
  }

  delete(id: string): boolean {
    return this.db.run('DELETE FROM projects WHERE id = ?', id).changes > 0
  }

  listWorktrees(projectId: string): GitWorktree[] {
    return this.db
      .all<Row>('SELECT * FROM git_worktrees WHERE project_id = ? ORDER BY created_at', projectId)
      .map(toWorktree)
  }

  upsertWorktree(input: Omit<GitWorktree, 'createdAt' | 'updatedAt'>): GitWorktree {
    const t = now()
    const existing = this.db.get<Row>('SELECT * FROM git_worktrees WHERE id = ?', input.id)
    const node: GitWorktree = { ...input, createdAt: existing ? num(existing.created_at) : t, updatedAt: t }
    if (existing) {
      this.db.run(
        'UPDATE git_worktrees SET project_id=?, path=?, branch=?, worker_id=?, detached=?, status=?, updated_at=? WHERE id=?',
        node.projectId,
        node.path,
        node.branch,
        node.workerId,
        flag(node.detached),
        node.status,
        node.updatedAt,
        node.id,
      )
    } else {
      this.db.run(
        'INSERT INTO git_worktrees (id, project_id, path, branch, worker_id, detached, status, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?)',
        node.id,
        node.projectId,
        node.path,
        node.branch,
        node.workerId,
        flag(node.detached),
        node.status,
        node.createdAt,
        node.updatedAt,
      )
    }
    return node
  }

  removeWorktree(id: string): boolean {
    return this.db.run('DELETE FROM git_worktrees WHERE id = ?', id).changes > 0
  }
}
