import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createCoreContext, type AppContext } from '@core/kernel/appContext'
import { appConfigSchema } from '@core/kernel/config'
import type { NormalizedEvent } from '@core/opencode/events'
import { buildPermissionEnv } from '@core/opencode/serverPool'
import { interceptChainedGit } from '@core/services/git'

let ctx: AppContext
let dataDir: string

function bashRules(cfg = appConfigSchema.parse({})): Record<string, string> {
  const env = buildPermissionEnv(cfg)
  return (JSON.parse(env.OPENCODE_PERMISSION!) as { bash: Record<string, string> }).bash
}

function event(partial: Partial<NormalizedEvent> & { type: string; sessionId: string }): NormalizedEvent {
  return { data: {}, directory: null, at: Date.now(), ...partial }
}

beforeAll(async () => {
  dataDir = await mkdtemp(join(tmpdir(), 'fern-gate-'))
  ctx = await createCoreContext({ dataDir, consoleLogs: false })
})

afterAll(async () => {
  await ctx?.shutdown()
  await rm(dataDir, { recursive: true, force: true })
})

describe('interceptChainedGit', () => {
  it('ignores commands that never reach git', () => {
    expect(interceptChainedGit('ls -la')).toEqual({ kind: null, verbs: [] })
    expect(interceptChainedGit('npm test && npm run build')).toEqual({ kind: null, verbs: [] })
    expect(interceptChainedGit('echo git commit')).toEqual({ kind: null, verbs: [] })
    expect(interceptChainedGit('echo "git commit"')).toEqual({ kind: null, verbs: [] })
  })

  it('ignores read-only git commands', () => {
    expect(interceptChainedGit('git status').kind).toBeNull()
    expect(interceptChainedGit('git log --oneline | grep fix').kind).toBeNull()
    expect(interceptChainedGit('git pull && git status').kind).toBeNull()
  })

  it('detects a plain git commit', () => {
    expect(interceptChainedGit('git commit -m x')).toEqual({ kind: 'git_commit', verbs: ['commit'] })
    expect(interceptChainedGit('FOO=bar git commit --allow-empty -m x')).toEqual({ kind: 'git_commit', verbs: ['commit'] })
    expect(interceptChainedGit('sudo git -C repo commit -m x')).toEqual({ kind: 'git_commit', verbs: ['commit'] })
  })

  it('detects commit hidden behind an && chain', () => {
    expect(interceptChainedGit('echo a && git commit -am x')).toEqual({ kind: 'git_commit', verbs: ['commit'] })
    expect(interceptChainedGit('git add .\ngit commit -m x')).toEqual({ kind: 'git_commit', verbs: ['add', 'commit'] })
    expect(interceptChainedGit('git commit -m x || echo failed')).toEqual({ kind: 'git_commit', verbs: ['commit'] })
  })

  it('detects push and captures every git verb in the chain', () => {
    expect(interceptChainedGit('git add . && git push')).toEqual({ kind: 'git_push', verbs: ['add', 'push'] })
    expect(interceptChainedGit('echo pushing | git push origin main')).toEqual({ kind: 'git_push', verbs: ['push'] })
    expect(interceptChainedGit('git add -A ; git commit -m "wip" ; git push')).toEqual({
      kind: 'git_commit',
      verbs: ['add', 'commit', 'push'],
    })
  })

  it('reports other mutating verbs without inventing a gate kind', () => {
    expect(interceptChainedGit('git reset --hard HEAD~1')).toEqual({ kind: null, verbs: ['reset'] })
    expect(interceptChainedGit('git merge feature && git push')).toEqual({ kind: 'git_push', verbs: ['merge', 'push'] })
  })

  it('detects git glued to a chain separator without spaces', () => {
    expect(interceptChainedGit('echo&&git commit -am x')).toEqual({ kind: 'git_commit', verbs: ['commit'] })
    expect(interceptChainedGit('git add .&&git push')).toEqual({ kind: 'git_push', verbs: ['add', 'push'] })
    expect(interceptChainedGit('echo;git commit -m x')).toEqual({ kind: 'git_commit', verbs: ['commit'] })
    expect(interceptChainedGit('echo|git push')).toEqual({ kind: 'git_push', verbs: ['push'] })
    expect(interceptChainedGit('false||git commit -m x')).toEqual({ kind: 'git_commit', verbs: ['commit'] })
  })

  it('detects git inside $() and backtick command substitutions', () => {
    expect(interceptChainedGit('$(git commit -m x)')).toEqual({ kind: 'git_commit', verbs: ['commit'] })
    expect(interceptChainedGit('echo $(git push origin main)')).toEqual({ kind: 'git_push', verbs: ['push'] })
    expect(interceptChainedGit('echo `git commit -m x`')).toEqual({ kind: 'git_commit', verbs: ['commit'] })
    expect(interceptChainedGit('msg="$(git rev-parse HEAD)"')).toEqual({ kind: null, verbs: ['rev-parse'] })
    expect(interceptChainedGit('echo "$(git commit -am x)" && git push')).toEqual({ kind: 'git_commit', verbs: ['commit', 'push'] })
  })
})

describe('buildPermissionEnv', () => {
  it('asks for plain and chained git commit/push by default', () => {
    const bash = bashRules()
    expect(bash['*']).toBe('allow')
    expect(bash['git commit*']).toBe('ask')
    expect(bash['git push*']).toBe('ask')
    expect(bash['* git commit*']).toBe('ask')
    expect(bash['* git push*']).toBe('ask')
    expect(bash['* git -C * commit*']).toBe('ask')
    expect(bash['* git -C * push*']).toBe('ask')
  })

  it('gates chained forms with the strictest of both git policies', () => {
    const bash = bashRules(appConfigSchema.parse({ permissions: { gitCommit: 'allow', gitPush: 'deny' } }))
    expect(bash['git commit*']).toBe('allow')
    expect(bash['git push*']).toBe('deny')
    expect(bash['* git commit*']).toBe('deny')
    expect(bash['* git push*']).toBe('deny')
  })

  it('keeps the catch-all first so last-match-wins resolves git rules', () => {
    const keys = Object.keys(bashRules())
    expect(keys[0]).toBe('*')
    expect(keys.indexOf('git commit*')).toBeGreaterThan(0)
    expect(keys.indexOf('* git commit*')).toBeGreaterThan(keys.indexOf('*'))
  })

  it('drops chained rules when interception is disabled', () => {
    const bash = bashRules(appConfigSchema.parse({ permissions: { interceptChainedGit: false } }))
    expect(bash['* git commit*']).toBeUndefined()
    expect(bash['* git push*']).toBeUndefined()
    expect(bash['git commit*']).toBe('ask')
    expect(bash['git push*']).toBe('ask')
  })
})

describe('WorkerManager chained-git backstop', () => {
  it('creates a git_commit approval for a chained commit command', () => {
    ctx.opencode.handleEvent(
      'srv_test',
      event({
        type: 'permission.asked',
        sessionId: 'ses_gate_1',
        data: {
          permission: {
            id: 'per_gate_1',
            type: 'bash',
            pattern: 'echo a && git commit -am x',
            sessionID: 'ses_gate_1',
            title: 'Run command',
          },
        },
      }),
    )

    const approval = ctx.repos.workers.listApprovals('pending').find((a) => a.opencodePermissionId === 'per_gate_1')
    expect(approval).toBeTruthy()
    expect(approval?.kind).toBe('git_commit')
    expect(approval?.detail).toContain('git commit -am x')
    expect(approval?.jobId).toBeNull()
  })

  it('labels the native OpenCode payload shape as git_push', () => {
    ctx.opencode.handleEvent(
      'srv_test',
      event({
        type: 'permission.asked',
        sessionId: 'ses_gate_2',
        data: {
          id: 'per_gate_2',
          sessionID: 'ses_gate_2',
          permission: 'bash',
          patterns: ['*'],
          metadata: { command: 'git add . && git push' },
          always: ['*'],
          tool: { messageID: 'msg_1', callID: 'call_1' },
        },
      }),
    )

    const approval = ctx.repos.workers.listApprovals('pending').find((a) => a.opencodePermissionId === 'per_gate_2')
    expect(approval).toBeTruthy()
    expect(approval?.kind).toBe('git_push')
    expect(approval?.title).toBe('git push needs approval')
    expect(approval?.detail).toContain('git add . && git push')
  })

  it('leaves non-git permission prompts as manual gates', () => {
    ctx.opencode.handleEvent(
      'srv_test',
      event({
        type: 'permission.asked',
        sessionId: 'ses_gate_3',
        data: { permission: { id: 'per_gate_3', type: 'bash', pattern: 'ls -la', sessionID: 'ses_gate_3' } },
      }),
    )

    const approval = ctx.repos.workers.listApprovals('pending').find((a) => a.opencodePermissionId === 'per_gate_3')
    expect(approval).toBeTruthy()
    expect(approval?.kind).toBe('manual_gate')
  })
})
