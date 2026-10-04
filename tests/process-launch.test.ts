import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { detectOpencode, planLaunch, resolveCmdTarget, runProcess } from '@core/platform/binaries'
import { AppError } from '@core/kernel/errors'

/**
 * Process-launch regression suite for the `spawn EINVAL` class of bugs.
 *
 * Node ≥18.20/20.12 refuses to spawn `.cmd`/`.bat` files directly (throws
 * EINVAL). The launch plan must either resolve a shim to the executable it
 * invokes or explicitly opt into a shell — never hand a batch file to spawn.
 * These tests pin that invariant, plus the validation errors a broken
 * configuration must produce (missing binary, missing cwd, bad argv).
 */

const isWin = process.platform === 'win32'
let sandbox: string

beforeAll(() => {
  sandbox = mkdtempSync(join(tmpdir(), 'fern-launch-'))
})

afterAll(() => {
  try {
    rmSync(sandbox, { recursive: true, force: true })
  } catch {
    /* best effort */
  }
})

describe('planLaunch', () => {
  it('runs a known-safe executable with structured argv', async () => {
    const out = await runProcess(process.execPath, ['-e', 'process.stdout.write("launch-ok")'])
    expect(out).toBe('launch-ok')
  })

  it('rejects a missing executable with not_found (never EINVAL)', () => {
    const missing = join(sandbox, 'definitely-not-here' + (isWin ? '.exe' : ''))
    expect(() => planLaunch(missing, ['--version'])).toThrowError(
      expect.objectContaining({ code: 'not_found' }) as unknown as Error,
    )
    try {
      planLaunch(missing, [])
      expect.unreachable('should have thrown')
    } catch (err) {
      expect(AppError.from(err).message).toContain('executable not found')
      expect(AppError.from(err).message).not.toContain('EINVAL')
    }
  })

  it('rejects an empty executable path and non-string arguments', () => {
    expect(() => planLaunch('   ', [])).toThrowError(expect.objectContaining({ code: 'invalid_argument' }) as unknown as Error)
    expect(() => planLaunch(process.execPath, [undefined as unknown as string])).toThrowError(
      expect.objectContaining({ code: 'invalid_argument' }) as unknown as Error,
    )
  })

  it('rejects a missing working directory before spawning anything', async () => {
    const missingCwd = join(sandbox, 'no-such-cwd')
    await expect(runProcess(process.execPath, ['-e', '1'], { cwd: missingCwd })).rejects.toThrowError(/working directory does not exist/)
  })

  it.skipIf(!isWin)('never plans a direct (shell:false) spawn of a .cmd file — that is the EINVAL bug', () => {
    const cmdPath = join(sandbox, 'shim.cmd')
    writeFileSync(cmdPath, '@echo off\r\n"%dp0%\\target.exe" %*\r\n', 'utf8')
    writeFileSync(join(sandbox, 'target.exe'), 'not a real exe, but it exists', 'utf8')

    const resolved = planLaunch(cmdPath, ['serve'])
    // Resolved to the underlying target: structured argv, no shell.
    expect(resolved.shell).toBe(false)
    expect(resolved.file).toBe(join(sandbox, 'target.exe'))
    expect(resolved.file.toLowerCase().endsWith('.cmd')).toBe(false)
    expect(resolved.argv).toEqual(['serve'])

    // An unresolvable shim must opt into the shell explicitly.
    const bare = join(sandbox, 'bare.cmd')
    writeFileSync(bare, '@echo off\r\nnode -e "process.stdout.write(1)"\r\n', 'utf8')
    const fallback = planLaunch(bare, [])
    expect(fallback.shell).toBe(true)

    // The invariant: a .cmd file is only ever launched through cmd.exe.
    if (!fallback.shell) expect(fallback.file.toLowerCase().endsWith('.cmd')).toBe(false)
  })

  it.skipIf(!isWin)('resolveCmdTarget parses npm-style %dp0% wrappers', () => {
    const dir = mkdtempSync(join(tmpdir(), 'fern-cmd-'))
    try {
      const cmd = join(dir, 'tool.cmd')
      mkdirSync(join(dir, 'bin'), { recursive: true })
      writeFileSync(join(dir, 'bin', 'tool.exe'), 'x', 'utf8')
      writeFileSync(
        cmd,
        ['@ECHO off', 'GOTO start', ':find_dp0', 'SET dp0=%~dp0', 'EXIT /b', ':start', 'SETLOCAL', 'CALL :find_dp0', '"%dp0%\\bin\\tool.exe"   %*'].join('\r\n'),
        'utf8',
      )
      expect(resolveCmdTarget(cmd)).toBe(join(dir, 'bin', 'tool.exe'))
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it.skipIf(!isWin)('runs a batch shim end-to-end through the launch plan', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'fern-shim-run-'))
    try {
      const cmd = join(dir, 'echoer.cmd')
      writeFileSync(cmd, `@echo off\r\n"${process.execPath}" -e "process.stdout.write('shim-ran')"\r\n`, 'utf8')
      const out = await runProcess(cmd, [])
      expect(out).toBe('shim-ran')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('detectOpencode', () => {
  it('skips a configured binary that exists but cannot run, and reports why', async () => {
    const broken = join(sandbox, 'broken-opencode' + (isWin ? '.exe' : ''))
    // A file that exists but is not an executable: the probe must fail closed.
    writeFileSync(broken, 'this is not an executable\n', 'utf8')

    const detection = await detectOpencode(broken)
    // It must never be reported as the working binary.
    expect(detection.path).not.toBe(broken)
    if (detection.path === null) {
      expect(detection.error).toBeTruthy()
      expect(detection.error).toContain(broken)
    } else {
      // A later candidate (PATH/npm) validated with a real --version run.
      expect(detection.version).toBeTruthy()
    }
  }, 30_000)

  it('returns an actionable error when nothing on the system can run', async () => {
    const saved = { PATH: process.env.PATH, APPDATA: process.env.APPDATA, LIBRARY_PATH: process.env.LIBRARY_PATH, USERPROFILE: process.env.USERPROFILE }
    const ghost = mkdtempSync(join(tmpdir(), 'fern-nooc-'))
    try {
      process.env.PATH = ghost
      process.env.APPDATA = join(ghost, 'appdata')
      delete process.env.LIBRARY_PATH
      const missing = join(ghost, 'opencode' + (isWin ? '.exe' : ''))
      const detection = await detectOpencode(missing)
      expect(detection.path).toBeNull()
      expect(detection.version).toBeNull()
      expect(detection.error).toMatch(/OpenCode binary not found|no working OpenCode binary/)
    } finally {
      process.env.PATH = saved.PATH
      if (saved.APPDATA === undefined) delete process.env.APPDATA
      else process.env.APPDATA = saved.APPDATA
      if (saved.LIBRARY_PATH === undefined) delete process.env.LIBRARY_PATH
      else process.env.LIBRARY_PATH = saved.LIBRARY_PATH
      if (saved.USERPROFILE === undefined) delete process.env.USERPROFILE
      else process.env.USERPROFILE = saved.USERPROFILE
      rmSync(ghost, { recursive: true, force: true })
    }
  }, 30_000)
})
