import { execFile, spawn } from 'node:child_process'
import { existsSync, readFileSync, statSync } from 'node:fs'
import { delimiter, dirname, join, normalize, sep } from 'node:path'
import { promisify } from 'node:util'
import { AppError, type ErrorCode as AppErrorCode } from '../kernel/errors'

const exec = promisify(execFile)

export interface BinaryInfo {
  path: string
  version: string | null
}

/* ============================================================================
 * Structured process launching.
 *
 * Node ≥18.20/20.12 refuses to spawn `.cmd`/`.bat` files directly (the
 * CVE-2024-27980 mitigation throws `EINVAL`). The correct handling is:
 *   1. resolve the shim to the real executable it invokes when possible, then
 *      spawn it with structured argv (no shell, no quoting), or
 *   2. when the shim cannot be resolved, run it through `cmd.exe` explicitly.
 * Never hand a `.cmd` path straight to spawn — that is the `spawn EINVAL` bug.
 * ==========================================================================*/

export interface LaunchPlan {
  /** Executable to actually spawn. */
  file: string
  /** Structured argv (never concatenated into a shell string). */
  argv: string[]
  /** True when the target is an unresolvable batch file that needs cmd.exe. */
  shell: boolean
}

function isBatchFile(p: string): boolean {
  return /\.(cmd|bat)$/i.test(p)
}

/**
 * Parses an npm-style `.cmd` wrapper and returns the executable it invokes.
 * e.g. `"%dp0%\node_modules\opencode-ai\bin\opencode.exe"   %*` → that exe.
 * Returns null when no referenced target exists on disk.
 */
export function resolveCmdTarget(cmdPath: string): string | null {
  let text: string
  try {
    text = readFileSync(cmdPath, 'utf8')
  } catch {
    return null
  }
  const dp0 = dirname(cmdPath) + sep
  const seen = new Set<string>()
  for (const match of text.matchAll(/"?%~?dp0%([^"\s]*)"?.*$/gim)) {
    const suffix = (match[1] ?? '').replace(/^[\\/]/, '')
    if (!suffix) continue
    const target = normalize(dp0 + suffix)
    if (seen.has(target)) continue
    seen.add(target)
    try {
      if (statSync(target).isFile()) return target
    } catch {
      /* try the next candidate */
    }
  }
  return null
}

/** Validates the pieces of a launch before any process is created. */
export function planLaunch(bin: string, args: string[]): LaunchPlan {
  if (typeof bin !== 'string' || bin.trim() === '') {
    throw new AppError('invalid_argument', 'executable path is empty')
  }
  for (const [i, arg] of args.entries()) {
    if (typeof arg !== 'string') {
      throw new AppError('invalid_argument', `argument #${i} is ${arg === undefined ? 'undefined' : typeof arg}, expected a string`)
    }
  }
  if (!existsSync(bin)) {
    throw new AppError('not_found', `executable not found: ${bin}`)
  }
  if (process.platform === 'win32' && isBatchFile(bin)) {
    const resolved = resolveCmdTarget(bin)
    if (resolved && existsSync(resolved)) return { file: resolved, argv: args, shell: false }
    return { file: bin, argv: args, shell: true }
  }
  return { file: bin, argv: args, shell: false }
}

function assertCwd(cwd?: string): void {
  if (!cwd) return
  if (!existsSync(cwd)) throw new AppError('not_found', `working directory does not exist: ${cwd}`)
  try {
    if (!statSync(cwd).isDirectory()) throw new AppError('invalid_argument', `working directory is not a directory: ${cwd}`)
  } catch (err) {
    if (err instanceof AppError) throw err
    throw new AppError('not_found', `working directory is not accessible: ${cwd}`)
  }
}

export interface RunOptions {
  cwd?: string
  timeoutMs?: number
  maxBuffer?: number
  env?: NodeJS.ProcessEnv
  /** Error code used when the process exits non-zero (default: `internal`). */
  errorCode?: AppErrorCode
}

/** Fallback for batch files we could not resolve: run through cmd.exe. */
function runViaCmd(bin: string, args: string[], opts: RunOptions): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    // `cmd /d /s /c` with a single pre-quoted command line — args are quoted
    // individually because they are internal constants, never user prose.
    const quoted = [bin, ...args].map((a) => (/[ \t"&|<>^%]/.test(a) ? `"${a.replace(/"/g, '""')}"` : a)).join(' ')
    const child = spawn(process.env.ComSpec ?? 'cmd.exe', ['/d', '/s', '/c', quoted], {
      cwd: opts.cwd,
      env: opts.env ?? process.env,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    const timer = setTimeout(() => {
      child.kill()
      reject(new AppError('timeout', `command timed out after ${opts.timeoutMs ?? 15_000}ms: ${bin}`))
    }, opts.timeoutMs ?? 15_000)
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', (c: string) => (stdout += c))
    child.stderr.on('data', (c: string) => (stderr += c))
    child.on('error', (err) => {
      clearTimeout(timer)
      reject(new AppError(opts.errorCode ?? 'internal', `failed to launch ${bin}: ${String(err)}`))
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      if (code === 0) resolve({ stdout, stderr })
      else reject(new AppError(opts.errorCode ?? 'internal', `${bin} exited with code ${code}: ${(stderr || stdout).trim().slice(0, 400)}`))
    })
  })
}

/**
 * Runs an executable with structured arguments and returns stdout.
 * Throws an actionable AppError for missing binaries, missing cwd, non-zero
 * exits and timeouts — never a bare `spawn EINVAL`.
 */
export async function runProcess(bin: string, args: string[], opts: RunOptions = {}): Promise<string> {
  assertCwd(opts.cwd)
  const plan = planLaunch(bin, args)
  if (plan.shell) {
    const { stdout } = await runViaCmd(plan.file, plan.argv, opts)
    return stdout.trim()
  }
  try {
    const { stdout } = await exec(plan.file, plan.argv, {
      ...(opts.cwd ? { cwd: opts.cwd } : {}),
      ...(opts.env ? { env: opts.env } : {}),
      windowsHide: true,
      timeout: opts.timeoutMs ?? 15_000,
      maxBuffer: opts.maxBuffer ?? 4 * 1024 * 1024,
    })
    return stdout.trim()
  } catch (err) {
    const e = err as { code?: unknown; killed?: boolean; stderr?: string; message?: string }
    if (e.killed) throw new AppError('timeout', `${bin} timed out after ${opts.timeoutMs ?? 15_000}ms`)
    if (e.code === 'ENOENT') throw new AppError('not_found', `executable not found: ${bin}`)
    throw new AppError(opts.errorCode ?? 'internal', `${bin} failed: ${(e.stderr || e.message || String(err)).trim().slice(0, 400)}`)
  }
}

function isExecutable(p: string): boolean {
  try {
    const s = statSync(p)
    return s.isFile()
  } catch {
    return false
  }
}

function pathDirs(): string[] {
  const raw = process.env.PATH ?? process.env.Path ?? ''
  return raw.split(delimiter).filter(Boolean)
}

function candidatesFor(name: string): string[] {
  const exts = process.platform === 'win32' ? ['.exe', '.cmd', '.bat', ''] : ['']
  const out: string[] = []
  for (const dir of pathDirs()) {
    for (const ext of exts) out.push(join(dir, name + ext))
  }
  return out
}

/** Resolve an executable from PATH (cross-platform, no shell involved). */
export function which(name: string): string | null {
  for (const candidate of candidatesFor(name)) {
    if (existsSync(candidate) && isExecutable(candidate)) return candidate
  }
  return null
}

/** Runs `bin --version`: `ok` means the process actually started and exited 0. */
async function probe(bin: string, args: string[]): Promise<{ ok: boolean; version: string | null }> {
  try {
    const out = await runProcess(bin, args)
    const m = out.match(/\d+\.\d+(\.\d+)?([-\w.]+)?/)
    return { ok: true, version: m ? m[0] : out.split('\n')[0]?.slice(0, 60) || null }
  } catch {
    return { ok: false, version: null }
  }
}

async function versionOf(bin: string, args: string[]): Promise<string | null> {
  return (await probe(bin, args)).version
}

export interface OpencodeDetection {
  path: string | null
  version: string | null
  source: 'path' | 'npm' | 'scoop' | 'manual' | null
  /** Why detection failed when `path` is null (actionable, safe to show). */
  error?: string | null
}

interface Candidate {
  path: string
  source: OpencodeDetection['source']
}

/** Platform-specific binary names installed by the `opencode-ai` npm package. */
function npmPlatformCandidates(npmRoot: string): Candidate[] {
  const platform = process.platform === 'win32' ? 'windows' : process.platform === 'darwin' ? 'darwin' : 'linux'
  const arch = process.arch
  const bin = platform === 'windows' ? join('bin', 'opencode.exe') : join('bin', 'opencode')
  const names = [`opencode-${platform}-${arch}`, `opencode-${platform}-${arch}-baseline`]
  if (platform === 'linux') names.push(`opencode-${platform}-${arch}-musl`, `opencode-${platform}-${arch}-baseline-musl`)
  const out: Candidate[] = []
  for (const name of names) {
    out.push({ path: join(npmRoot, 'npm', 'node_modules', 'opencode-ai', 'node_modules', name, bin), source: 'npm' })
  }
  return out
}

/**
 * Find a **working** OpenCode binary without touching the user's config.
 * Every candidate is validated with a real `--version` run: a broken shim
 * (e.g. an npm install that skipped postinstall and left a text placeholder
 * named `opencode.exe`) is skipped with its error recorded, never returned.
 * Precedence: explicit override → PATH → npm global (incl. platform packages)
 * → scoop.
 */
export async function detectOpencode(override?: string | null): Promise<OpencodeDetection> {
  const candidates: Candidate[] = []
  if (override) {
    const expanded = override.replace(/^~(?=\/|\\)/, process.env.USERPROFILE ?? process.env.HOME ?? '~')
    candidates.push({ path: expanded, source: 'manual' })
  }
  const fromPath = which('opencode')
  if (fromPath) candidates.push({ path: fromPath, source: 'path' })

  const npmRoots = [process.env.APPDATA, process.env.LIBRARY_PATH].filter(Boolean) as string[]
  for (const root of npmRoots) {
    for (const rel of ['opencode.exe', 'opencode.cmd', 'opencode']) {
      candidates.push({ path: join(root, 'npm', rel), source: 'npm' })
    }
    candidates.push({ path: join(root, 'npm', 'node_modules', 'opencode-ai', 'bin', process.platform === 'win32' ? 'opencode.exe' : 'opencode'), source: 'npm' })
    candidates.push(...npmPlatformCandidates(root))
  }

  const scoop = join(process.env.USERPROFILE ?? '', 'scoop', 'shims', process.platform === 'win32' ? 'opencode.exe' : 'opencode')
  candidates.push({ path: scoop, source: 'scoop' })

  const failures: string[] = []
  const tried = new Set<string>()
  for (const candidate of candidates) {
    if (tried.has(candidate.path)) continue
    tried.add(candidate.path)
    if (!existsSync(candidate.path)) continue
    const result = await probe(candidate.path, ['--version'])
    if (result.ok) return { path: candidate.path, version: result.version, source: candidate.source }
    failures.push(`${candidate.path} (failed to run --version)`)
  }

  const detail = failures.length
    ? `no working OpenCode binary — tried ${failures.join('; ')}`
    : 'OpenCode binary not found — install opencode or set its path in Settings → OpenCode'
  return { path: null, version: null, source: null, error: detail }
}

export interface GitDetection {
  path: string | null
  version: string | null
}

export async function detectGit(): Promise<GitDetection> {
  const fromPath = which('git')
  if (!fromPath) return { path: null, version: null }
  return { path: fromPath, version: await versionOf(fromPath, ['--version']) }
}

/**
 * Shell OpenCode's `bash` tool should run through.
 *
 * On Windows OpenCode falls back to PowerShell 5.1, which rejects `&&` — a
 * syntax every model reaches for first — so the command dies with a parser
 * error while the tool still reports "completed" (exit 1 is only visible in
 * `metadata.exit`). Verified by running the same `echo a > f && echo b > g`
 * through a real `opencode serve`: no override → exit 1, no files; `shell`
 * set to Git Bash → exit 0, both files created.
 *
 * Returns null when nothing suitable is found (or on POSIX, where OpenCode's
 * default is already a POSIX shell) and the caller should omit the setting.
 */
export async function detectShell(override?: string | null): Promise<string | null> {
  if (process.platform !== 'win32') return null
  const candidates: string[] = []
  const explicit = override?.trim()
  if (explicit) candidates.push(explicit.replace(/^~(?=\/|\\)/, process.env.USERPROFILE ?? process.env.HOME ?? '~'))
  else {
    // POSIX-capable shells first: models write bash, and bash never emits the
    // `&&` parser error that PowerShell 5.1 does.
    const programFiles = [process.env.ProgramFiles, process.env['ProgramFiles(x86)']].filter(Boolean) as string[]
    for (const root of programFiles) candidates.push(join(root, 'Git', 'bin', 'bash.exe'))
    for (const name of ['bash', 'pwsh']) {
      const found = which(name)
      if (found) candidates.push(found)
    }
  }
  const tried = new Set<string>()
  for (const candidate of candidates) {
    if (!candidate || tried.has(candidate)) continue
    tried.add(candidate)
    if (!existsSync(candidate)) continue
    if ((await probe(candidate, ['--version'])).ok) return candidate
  }
  return null
}

export async function requireGit(): Promise<string> {
  const { path } = await detectGit()
  if (!path) throw new AppError('unavailable', 'git executable not found on PATH')
  return path
}

export { runProcess as run }
