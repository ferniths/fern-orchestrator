import { createHash } from 'node:crypto'
import { readFile, stat } from 'node:fs/promises'
import { basename, isAbsolute, relative, resolve } from 'node:path'
import type { Artifact, Worker, WorkerSession } from '@shared/domain'
import { EVENTS, type PublishPayload } from '../kernel/eventBus'
import type { DiffEntry } from './adapter'

/** Files larger than this keep their byte size but skip the sha256 checksum. */
export const CHECKSUM_SIZE_CAP = 512 * 1024

/**
 * `expectedArtifacts` are paths we stat on disk. Models also emit prose there
 * ("Confirmation of no pending TODOs"), which can never exist as a file and
 * makes an otherwise fine step fail as "missing expected artifacts". A name is
 * a candidate when it has no whitespace, or when its last segment carries an
 * extension; sentences are not.
 */
export function looksLikeArtifactPath(name: string): boolean {
  const trimmed = name.trim()
  if (!trimmed || trimmed.length > 200) return false
  if (!/\s/.test(trimmed)) return true
  return /\.[A-Za-z0-9]{1,10}$/.test(trimmed)
}

export interface ArtifactCollectorDeps {
  createArtifact(input: Partial<Artifact> & { jobId: string; name: string }): Artifact
  emit(type: string, payload?: PublishPayload): void
  warn?(message: string, data?: Record<string, unknown>): void
}

export interface CollectRequest {
  jobId: string
  loopIndex: number
  taskId: string | null
  workerId: string | null
  sessionId: string | null
  /** Absolute workspace root every artifact path is resolved against. */
  workspaceRoot: string
  expectedArtifacts: string[]
  diff: DiffEntry[]
  assistantText: string
}

export interface CollectResult {
  artifacts: Artifact[]
  artifactIds: string[]
  /** Workspace-relative (forward-slash) paths of artifacts found on disk. */
  filesTouched: string[]
  presentExpected: string[]
  missingExpected: string[]
  /** Paths rejected because they escape the workspace root. */
  rejectedPaths: string[]
  /** Diff entries that resolved inside the workspace but are not on disk. */
  unmatchedDiff: string[]
  diffStats: { additions: number; deletions: number; files: number }
  verdict: { ok: boolean; reason: string | null; note: string | null }
}

interface PendingRow {
  relPath: string
  kind: 'file' | 'modified_file'
  status: 'available' | 'missing'
  metadata: Record<string, unknown>
}

/** Workspace-relative path, or null when `target` escapes `root`. */
function safeRelative(root: string, target: string): string | null {
  if (typeof target !== 'string' || !target.trim()) return null
  const rel = relative(root, resolve(root, target))
  if (!rel || rel.startsWith('..') || isAbsolute(rel)) return null
  return rel.split(/[\\/]+/).filter(Boolean).join('/')
}

async function isRegularFile(abs: string): Promise<boolean> {
  try {
    return (await stat(abs)).isFile()
  } catch {
    return false
  }
}

async function checksumOf(abs: string, bytes: number): Promise<string | null> {
  if (bytes > CHECKSUM_SIZE_CAP) return null
  try {
    return createHash('sha256').update(await readFile(abs)).digest('hex')
  } catch {
    return null
  }
}

/**
 * What a verifier should tell the reviewer about one recorded artifact that is
 * back on disk. Existence alone is not evidence of the right content: a sibling
 * worker has overwritten an already-verified deliverable with different bytes,
 * and the reviewer then called it correct because it only ever saw
 * "PRESENT, N bytes". Returns null when the file is gone, so the caller can
 * report it as MISSING.
 */
export async function artifactDiskNote(
  abs: string,
  recorded: { bytes: number | null; checksum?: string | null; status: string },
): Promise<string | null> {
  let size: number
  try {
    size = (await stat(abs)).size
  } catch {
    return null
  }
  const diskChecksum = size <= CHECKSUM_SIZE_CAP ? await checksumOf(abs, size) : null
  const sizeChanged = recorded.bytes !== null && recorded.bytes !== size
  const hashChanged = Boolean(recorded.checksum && diskChecksum && recorded.checksum !== diskChecksum)
  if (sizeChanged || hashChanged) {
    const before = `${recorded.bytes} bytes${recorded.checksum ? `, sha256 ${recorded.checksum.slice(0, 12)}` : ''}`
    const after = `${size} bytes${diskChecksum ? `, sha256 ${diskChecksum.slice(0, 12)}` : ''}`
    return `CHANGED since verification (recorded ${before}; now ${after})`
  }
  return `PRESENT (${size} bytes, recorded ${recorded.status})`
}

function listMissing(names: string[]): string {
  return names.join(', ')
}

/**
 * Verifies a worker's promised deliverables and records one artifact row per
 * verified/attempted file. Rules:
 *
 * - `expectedArtifacts` declared → success requires at least one of them to
 *   exist in the workspace; zero present fails the worker, a partial set
 *   succeeds with a note listing the missing ones.
 * - no `expectedArtifacts` → at least one diff file on disk OR a non-empty
 *   assistant reply is enough evidence.
 * - paths escaping the workspace are never touched: skipped, noted in
 *   `rejectedPaths`, and counted as missing for verification.
 */
export async function collectWorkerArtifacts(
  deps: ArtifactCollectorDeps,
  req: CollectRequest,
): Promise<CollectResult> {
  const root = resolve(req.workspaceRoot)
  const rejectedPaths: string[] = []
  const unmatchedDiff: string[] = []
  const rows: PendingRow[] = []
  const seen = new Set<string>()

  /* diff entries → real files on disk ------------------------------------- */
  const diffStats = { additions: 0, deletions: 0, files: 0 }
  const diffByPath = new Map<string, { additions: number; deletions: number }>()
  for (const entry of req.diff ?? []) {
    const file = typeof entry?.file === 'string' ? entry.file : ''
    if (!file) continue
    const rel = safeRelative(root, file)
    if (!rel) {
      rejectedPaths.push(file)
      continue
    }
    if (!diffByPath.has(rel)) diffByPath.set(rel, { additions: 0, deletions: 0 })
    const acc = diffByPath.get(rel)!
    acc.additions += entry.additions ?? 0
    acc.deletions += entry.deletions ?? 0
  }
  for (const [rel, acc] of diffByPath) {
    const abs = resolve(root, rel)
    if (!(await isRegularFile(abs))) {
      unmatchedDiff.push(rel)
      continue
    }
    diffStats.additions += acc.additions
    diffStats.deletions += acc.deletions
    diffStats.files += 1
    seen.add(rel)
    rows.push({ relPath: rel, kind: 'modified_file', status: 'available', metadata: { ...acc, source: 'diff' } })
  }

  /* expected artifacts → present/missing rows ----------------------------- */
  const declared = [...new Set(req.expectedArtifacts ?? [])].filter(looksLikeArtifactPath)
  const presentExpected: string[] = []
  const missingExpected: string[] = []
  for (const name of declared) {
    const rel = safeRelative(root, name)
    if (!rel) {
      rejectedPaths.push(name)
      missingExpected.push(name)
      continue
    }
    const abs = resolve(root, rel)
    if (await isRegularFile(abs)) {
      presentExpected.push(rel)
      if (!seen.has(rel)) {
        seen.add(rel)
        rows.push({ relPath: rel, kind: 'file', status: 'available', metadata: { source: 'expected' } })
      }
    } else {
      missingExpected.push(rel)
      if (!seen.has(rel)) {
        seen.add(rel)
        rows.push({ relPath: rel, kind: 'file', status: 'missing', metadata: { source: 'expected' } })
      }
    }
  }

  /* materialize artifact rows --------------------------------------------- */
  const artifacts: Artifact[] = []
  for (const row of rows) {
    const abs = resolve(root, row.relPath)
    let bytes = 0
    let checksum: string | null = null
    if (row.status === 'available') {
      try {
        bytes = (await stat(abs)).size
      } catch {
        bytes = 0
      }
      checksum = await checksumOf(abs, bytes)
    }
    let artifact: Artifact
    try {
      artifact = deps.createArtifact({
        jobId: req.jobId,
        loopIndex: req.loopIndex,
        taskId: req.taskId,
        workerId: req.workerId,
        sessionId: req.sessionId,
        kind: row.kind,
        name: basename(row.relPath),
        path: row.relPath,
        bytes,
        checksum,
        status: row.status,
        metadata: row.metadata,
      })
    } catch (err) {
      deps.warn?.('artifact row insert failed', { path: row.relPath, error: String(err) })
      continue
    }
    artifacts.push(artifact)
    deps.emit(EVENTS.ARTIFACT_CREATED, {
      jobId: req.jobId,
      workerId: req.workerId,
      taskId: req.taskId ?? null,
      message: `artifact ${row.status}: ${artifact.name}`,
      severity: row.status === 'missing' ? 'warn' : 'info',
      data: {
        artifactId: artifact.id,
        kind: artifact.kind,
        name: artifact.name,
        path: artifact.path,
        status: artifact.status,
        sessionId: req.sessionId,
        bytes,
      },
    })
  }

  /* verdict ---------------------------------------------------------------- */
  const verdict: CollectResult['verdict'] = { ok: true, reason: null, note: null }
  if (declared.length > 0) {
    if (presentExpected.length === 0) {
      verdict.ok = false
      verdict.reason = `missing expected artifacts: ${listMissing(missingExpected)}`
    } else if (missingExpected.length > 0) {
      verdict.note = `missing expected artifacts: ${listMissing(missingExpected)}`
    }
  } else if (diffStats.files === 0 && !req.assistantText.trim()) {
    verdict.ok = false
    verdict.reason = 'worker produced no deliverables: no files on disk and no assistant output'
  }

  return {
    artifacts,
    artifactIds: artifacts.map((a) => a.id),
    filesTouched: artifacts.filter((a) => a.status === 'available').map((a) => a.path ?? '').filter(Boolean),
    presentExpected,
    missingExpected,
    rejectedPaths,
    unmatchedDiff,
    diffStats,
    verdict,
  }
}

export interface CollectionPersistDeps {
  getWorker(id: string): Worker | null
  updateWorker(id: string, patch: Partial<Worker>): Worker
  getSession(sessionId: string): WorkerSession | null
  upsertSession(input: Omit<WorkerSession, 'id' | 'createdAt' | 'updatedAt'> & { id?: string }): WorkerSession
}

/**
 * Writes the collected results back onto the worker row (`filesTouched`,
 * `artifacts`) and the session row (`diffStats`) instead of leaving them empty.
 */
export function persistCollection(
  deps: CollectionPersistDeps,
  req: { workerId: string; sessionId: string; result: CollectResult },
): void {
  const worker = deps.getWorker(req.workerId)
  if (worker) {
    deps.updateWorker(worker.id, { filesTouched: req.result.filesTouched, artifacts: req.result.artifactIds })
  }
  const session = deps.getSession(req.sessionId)
  if (session) {
    deps.upsertSession({
      sessionId: session.sessionId,
      workerId: session.workerId,
      serverId: session.serverId,
      parentSessionId: session.parentSessionId,
      jobId: session.jobId,
      projectId: session.projectId,
      title: session.title,
      directory: session.directory,
      modelId: session.modelId,
      providerId: session.providerId,
      opencodeAgent: session.opencodeAgent,
      depth: session.depth,
      status: session.status,
      summary: session.summary,
      diffStats: req.result.diffStats,
      lastEventAt: session.lastEventAt ?? Date.now(),
    })
  }
}
