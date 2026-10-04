import { existsSync, readdirSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { GitStatus } from '@shared/domain'
import { AppError } from '../kernel/errors'
import { requireGit, runProcess, which } from '../platform/binaries'

export interface GitRunOptions {
  cwd?: string
  timeoutMs?: number
}

export async function git(args: string[], options: GitRunOptions = {}): Promise<string> {
  const bin = await requireGit()
  try {
    // Structured argv — never a concatenated shell string (command-injection safe).
    return await runProcess(bin, args, {
      cwd: options.cwd,
      timeoutMs: options.timeoutMs ?? 20_000,
      maxBuffer: 16 * 1024 * 1024,
      errorCode: 'git_error',
    })
  } catch (err) {
    const e = AppError.from(err, 'git_error')
    if (e.code === 'timeout') throw new AppError('timeout', `git ${args[0]} timed out`, { details: { args } })
    throw new AppError('git_error', e.message.replace(/^.*?failed: /, '').trim().slice(0, 500) || 'git failed', {
      details: { args: args.slice(0, 4) },
    })
  }
}

export async function gitOk(args: string[], options: GitRunOptions = {}): Promise<string | null> {
  try {
    return await git(args, options)
  } catch {
    return null
  }
}

export function isGitRepo(dir: string): boolean {
  try {
    return statSync(join(dir, '.git')).isFile() || statSync(join(dir, '.git')).isDirectory()
  } catch {
    return false
  }
}

export async function hasIdentity(dir: string): Promise<boolean> {
  const [name, email] = await Promise.all([gitOk(['config', 'user.name'], { cwd: dir }), gitOk(['config', 'user.email'], { cwd: dir })])
  return Boolean(name?.trim() && email?.trim())
}

export interface ParsedPorcelainV2 {
  branch: string | null
  detached: boolean
  ahead: number
  behind: number
  staged: string[]
  unstaged: string[]
  untracked: string[]
  conflicted: string[]
}

/**
 * Returns the remainder of a `--porcelain=v2` record after `fields` fixed
 * columns (i.e. after `fields` spaces). v2 leaves pathnames unquoted, so a
 * path may contain spaces and can only be recovered by counting columns.
 */
function afterColumns(line: string, fields: number): string {
  let idx = -1
  for (let i = 0; i < fields; i++) {
    idx = line.indexOf(' ', idx + 1)
    if (idx < 0) return ''
  }
  return line.slice(idx + 1)
}

/**
 * Parses `git status --porcelain=v2` output.
 *
 * Record shapes (columns are single-space separated, the path is the tail):
 *   `1 <XY> <sub> <mH> <mI> <mW> <hH> <hI> <path>`            — ordinary
 *   `2 <XY> <sub> <mH> <mI> <mW> <hH> <hI> <X> <path>\t<orig>` — renamed/copied
 *   `u <XY> <sub> <m1> <m2> <m3> <mW> <h1> <h2> <h3> <path>`   — unmerged
 *   `? <path>` / `! <path>`                                     — untracked/ignored
 */
export function parsePorcelainV2(raw: string): ParsedPorcelainV2 {
  const out: ParsedPorcelainV2 = {
    branch: null,
    detached: false,
    ahead: 0,
    behind: 0,
    staged: [],
    unstaged: [],
    untracked: [],
    conflicted: [],
  }

  for (const line of raw.split('\n')) {
    if (!line) continue
    if (line.startsWith('# branch.head ')) {
      const head = line.slice('# branch.head '.length)
      if (head === '(detached)') {
        out.detached = true
        out.branch = null
      } else {
        out.branch = head
      }
      continue
    }
    if (line.startsWith('# branch.ab ')) {
      const m = line.match(/\+(\d+)\s+-(\d+)/)
      if (m) {
        out.ahead = Number(m[1])
        out.behind = Number(m[2])
      }
      continue
    }
    if (line.startsWith('? ') || line.startsWith('! ')) {
      if (line.startsWith('? ')) out.untracked.push(line.slice(2))
      continue
    }
    if (line.startsWith('u ')) {
      const path = afterColumns(line, 10)
      if (path) out.conflicted.push(path)
      continue
    }
    if (line.startsWith('1 ') || line.startsWith('2 ')) {
      const renamed = line.startsWith('2 ')
      const xy = line.slice(2, 4)
      const tail = afterColumns(line, renamed ? 9 : 8)
      if (!tail) continue
      // Renamed records carry `path<TAB>origPath`; the current path is first.
      const path = (renamed ? tail.split('\t')[0] : tail) || ''
      if (!path) continue
      const x = xy[0]
      const y = xy[1]
      if (x && x !== '.') out.staged.push(path)
      if (y && y !== '.') out.unstaged.push(path)
    }
  }
  return out
}

/** Full working-tree status for the Projects screen and pre-commit checks. */
export async function status(dir: string): Promise<GitStatus> {
  if (!which('git')) {
    return emptyStatus(dir, false)
  }
  if (!isGitRepo(dir)) {
    return emptyStatus(dir, false)
  }

  const root = (await gitOk(['rev-parse', '--show-toplevel'], { cwd: dir }))?.trim() ?? dir
  let raw = ''
  try {
    raw = await git(['status', '--porcelain=v2', '--branch', '--untracked-files=all'], { cwd: root })
  } catch {
    return emptyStatus(root, true)
  }

  const parsed = parsePorcelainV2(raw)
  return {
    repoRoot: root,
    branch: parsed.branch,
    detached: parsed.detached,
    ahead: parsed.ahead,
    behind: parsed.behind,
    staged: parsed.staged,
    unstaged: parsed.unstaged,
    untracked: parsed.untracked,
    conflicted: parsed.conflicted,
    isRepo: true,
    hasIdentity: await hasIdentity(root),
  }
}

function emptyStatus(dir: string, isRepo: boolean): GitStatus {
  return {
    repoRoot: dir,
    branch: null,
    detached: false,
    ahead: 0,
    behind: 0,
    staged: [],
    unstaged: [],
    untracked: [],
    conflicted: [],
    isRepo,
    hasIdentity: false,
  }
}

export async function currentBranch(dir: string): Promise<string | null> {
  const out = await gitOk(['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: dir })
  const name = out?.trim()
  return name && name !== 'HEAD' ? name : null
}

/* ============================================================================
 * Discovery — find repositories under configured roots (depth-limited).
 * ==========================================================================*/

export interface DiscoverOptions {
  roots?: string[]
  ignore?: string[]
  maxDepth?: number
  limit?: number
}

export function discoverRepos(options: DiscoverOptions = {}): string[] {
  const roots = options.roots?.filter((r) => r && existsSync(r)) ?? [homedir()]
  const ignore = new Set(options.ignore ?? ['node_modules', '.venv', 'venv', 'dist', 'build', 'target', '.cache', 'AppData'])
  const maxDepth = options.maxDepth ?? 4
  const limit = options.limit ?? 200
  const found: string[] = []

  const walk = (dir: string, depth: number): void => {
    if (found.length >= limit || depth > maxDepth) return
    if (isGitRepo(dir)) {
      found.push(dir)
      return // do not descend into nested repos (worktrees live outside by convention)
    }
    let entries: string[]
    try {
      entries = readdirSync(dir)
    } catch {
      return
    }
    for (const entry of entries) {
      if (found.length >= limit) return
      if (entry.startsWith('.') && depth > 0) continue
      if (ignore.has(entry)) continue
      const full = join(dir, entry)
      try {
        if (statSync(full).isDirectory()) walk(full, depth + 1)
      } catch {
        /* permission errors are expected */
      }
    }
  }

  for (const root of roots) walk(root, 0)
  return found
}

/* ============================================================================
 * Worktrees
 * ==========================================================================*/

export interface WorktreeInfo {
  path: string
  branch: string
  detached: boolean
  isMain: boolean
}

export async function listWorktrees(dir: string): Promise<WorktreeInfo[]> {
  const out = await git(['worktree', 'list', '--porcelain'], { cwd: dir })
  const blocks = out.split('\n\n').filter(Boolean)
  const mainRoot = (await gitOk(['rev-parse', '--show-toplevel'], { cwd: dir }))?.trim()
  return blocks.map((block) => {
    const lines = block.split('\n')
    const path = lines[0]?.replace('worktree ', '') ?? ''
    const branchLine = lines.find((l) => l.startsWith('branch '))
    const detached = lines.includes('detached')
    const branch = branchLine ? branchLine.replace('branch refs/heads/', '') : ''
    return { path, branch, detached, isMain: path === mainRoot }
  })
}

export async function createWorktree(repoDir: string, branch: string, targetPath?: string): Promise<WorktreeInfo> {
  const args = ['worktree', 'add']
  if (targetPath) {
    args.push(targetPath, '-b', branch)
  } else {
    args.push('-b', branch)
  }
  await git(args, { cwd: repoDir })
  const list = await listWorktrees(repoDir)
  const created = list.find((w) => w.branch === branch)
  if (!created) throw new AppError('git_error', `worktree created but not found for branch ${branch}`)
  return created
}

export async function removeWorktree(repoDir: string, worktreePath: string): Promise<void> {
  await git(['worktree', 'remove', '--force', worktreePath], { cwd: repoDir })
  await gitOk(['worktree', 'prune'], { cwd: repoDir })
}

/** Splits a unified diff into per-file additions/deletions. Handles new (`--- /dev/null`) and deleted (`+++ /dev/null`) files. */
export function parseDiffFiles(
  raw: string,
  statusMap: Map<string, string> = new Map(),
): { path: string; additions: number; deletions: number; status: string }[] {
  const files: { path: string; additions: number; deletions: number; status: string }[] = []
  let current: { path: string; additions: number; deletions: number; status: string } | null = null
  let pendingPath: string | null = null
  for (const line of raw.split('\n')) {
    if (line.startsWith('--- ')) {
      const p = line.slice(4).trim()
      pendingPath = p === '/dev/null' ? null : p.replace(/^a\//, '')
      current = null
    } else if (line.startsWith('+++ ')) {
      const p = line.slice(4).trim()
      if (p === '/dev/null') {
        // Deleted file: the only path we have comes from the `--- a/…` line.
        if (pendingPath) {
          current = { path: pendingPath, additions: 0, deletions: 0, status: statusMap.get(pendingPath) ?? 'M' }
          files.push(current)
        }
      } else {
        const path = p.replace(/^b\//, '')
        current = { path, additions: 0, deletions: 0, status: statusMap.get(path) ?? 'M' }
        files.push(current)
      }
      pendingPath = null
    } else if (current && line.startsWith('+')) {
      current.additions++
    } else if (current && line.startsWith('-')) {
      current.deletions++
    }
  }
  return files
}

export async function diffSummary(dir: string, staged = true): Promise<{ raw: string; files: { path: string; additions: number; deletions: number; status: string }[] }> {
  const raw = (await gitOk(staged ? ['diff', '--cached'] : ['diff'], { cwd: dir })) ?? ''
  const nameOut = (await gitOk(staged ? ['diff', '--cached', '--name-status'] : ['diff', '--name-status'], { cwd: dir })) ?? ''
  const statusMap = new Map<string, string>()
  for (const line of nameOut.split('\n')) {
    if (!line.trim()) continue
    const [code, ...rest] = line.split('\t')
    statusMap.set(rest[rest.length - 1] ?? '', code ?? '')
  }
  return { raw, files: parseDiffFiles(raw, statusMap) }
}

/**
 * What a `git push` would publish: the diff of every local commit that the
 * upstream branch does not have yet. Returns null when there is no upstream
 * configured (the caller falls back to the staged working-tree diff).
 */
export async function diffAgainstUpstream(dir: string): Promise<{ raw: string; files: { path: string; additions: number; deletions: number; status: string }[] } | null> {
  const upstream = (await gitOk(['rev-parse', '--abbrev-ref', '@{upstream}'], { cwd: dir }))?.trim()
  if (!upstream) return null
  const raw = (await gitOk(['diff', `${upstream}...HEAD`], { cwd: dir })) ?? ''
  if (!raw.trim()) return { raw: '', files: [] }
  return { raw, files: parseDiffFiles(raw) }
}

export async function commit(dir: string, message: string, allowEmpty = false): Promise<string> {
  const args = ['commit', '-m', message]
  if (allowEmpty) args.push('--allow-empty')
  await git(args, { cwd: dir })
  return (await gitOk(['rev-parse', 'HEAD'], { cwd: dir }))?.trim() ?? ''
}

export async function push(dir: string, remote = 'origin', branch?: string): Promise<void> {
  const args = ['push', remote]
  if (branch) args.push(branch)
  await git(args, { cwd: dir, timeoutMs: 120_000 })
}

/* ============================================================================
 * Approval gate — chained git command inspection (pure, no I/O)
 * ==========================================================================*/

export interface ChainedGitVerdict {
  /** Approval gate the command must route through, when it reaches git state. */
  kind: 'git_commit' | 'git_push' | null
  /** Every git subcommand found, in order of first appearance. */
  verbs: string[]
}

const CHAIN_SPLIT = /&&|\|\||;|\||\r?\n/
const ENV_ASSIGN = /^[A-Za-z_][A-Za-z0-9_]*=/
const SHELL_WRAPPERS = new Set(['command', 'doas', 'env', 'nice', 'nohup', 'sudo', 'time', 'xargs'])
/** `$(…)` and backtick substitutions — their body runs as its own command line. */
const COMMAND_SUBSTITUTION = /\$\(([^()]*)\)|`([^`]*)`/g
const SUBSTITUTION_DEPTH = 10

function commandSubstitutions(segment: string): string[] {
  const out: string[] = []
  for (const match of segment.matchAll(COMMAND_SUBSTITUTION)) {
    const inner = match[1] ?? match[2] ?? ''
    if (inner) out.push(inner)
  }
  return out
}

function gitVerbsIn(segment: string): string[] {
  const tokens = segment.trim().split(/\s+/).filter(Boolean)
  const verbs: string[] = []
  for (let i = 0; i < tokens.length; i++) {
    if (tokens[i] !== 'git') continue
    const prev = i > 0 ? (tokens[i - 1] ?? null) : null
    if (prev !== null && !ENV_ASSIGN.test(prev) && !SHELL_WRAPPERS.has(prev)) continue
    let j = i + 1
    while (j < tokens.length) {
      const token = tokens[j]!
      if (token === '-C' || token === '-c' || token === '--git-dir' || token === '--work-tree') {
        j += 2
        continue
      }
      if (token.startsWith('-')) {
        j += 1
        continue
      }
      break
    }
    const verb = tokens[j]
    if (verb) verbs.push(verb)
  }
  return verbs
}

/**
 * Finds git subcommands anywhere in a (possibly chained) bash string so forms
 * like `echo ok && git commit -am x` cannot slip past prefix-matched
 * permission rules. Splits on chain separators (`&&`, `||`, `;`, `|`, newline)
 * with or without surrounding spaces, recurses into `$(…)`/backtick command
 * substitutions, and unwraps shell wrappers/env prefixes. `kind` gates
 * commit/push; other verbs are reported for approval detail.
 */
export function interceptChainedGit(command: string): ChainedGitVerdict {
  const verbs: string[] = []
  const scan = (input: string, depth: number): void => {
    if (depth > SUBSTITUTION_DEPTH) return
    for (const segment of input.split(CHAIN_SPLIT)) {
      for (const inner of commandSubstitutions(segment)) scan(inner, depth + 1)
      for (const verb of gitVerbsIn(segment)) {
        if (!verbs.includes(verb)) verbs.push(verb)
      }
    }
  }
  scan(command, 0)
  const kind = verbs.includes('commit') ? 'git_commit' : verbs.includes('push') ? 'git_push' : null
  return { kind, verbs }
}
