import { describe, expect, it, vi } from 'vitest'
import type { AppContext } from '../src/core/kernel/appContext'
import type { AutomationJob } from '../src/shared/domain'
import { REFINER_SYSTEM_PROMPT, detectViolations, languageSwitched, refinePrompt, refinerSystemPrompt, scriptProfile } from '../src/core/orchestration/refiner'

const ORIGINAL = 'Build a small dashboard that lists my notes and lets me filter them by tag.'

function job(overrides: Partial<AutomationJob> = {}): AutomationJob {
  return {
    id: 'job_refine_1',
    originalPrompt: ORIGINAL,
    refinedPrompt: '',
    routeId: null,
    ...overrides,
  } as AutomationJob
}

function fakeCtx(replies: string[]): { ctx: AppContext; calls: string[] } {
  const calls: string[] = []
  const ctx = {
    ai: {
      runText: vi.fn(async (args: { messages: { role: string; content: string }[] }) => {
        calls.push(args.messages.map((m) => m.content).join('\n'))
        const reply = replies[Math.min(calls.length - 1, replies.length - 1)]
        return { text: reply, modelId: 'm', providerId: 'p', usage: { inputTokens: 1, outputTokens: 1 } }
      }),
    },
    log: () => ({ info: () => {}, warn: () => {}, error: () => {}, debug: () => {} }),
  }
  return { ctx: ctx as unknown as AppContext, calls }
}

describe('refiner contract', () => {
  it('accepts a natural-language refinement', () => {
    const good = 'Build a small dashboard that lists my notes and lets me filter them by tag, with a search box above the list.'
    expect(detectViolations(ORIGINAL, good)).toEqual([])
  })

  it('rejects fenced code blocks', () => {
    const bad = 'Here is the refined prompt:\n```ts\nconst x = 1\n```\nDo the thing.'
    const codes = detectViolations(ORIGINAL, bad).map((v) => v.code)
    expect(codes).toContain('code_fence')
  })

  it('rejects shell command lines', () => {
    const bad = 'Set up the project:\nnpm install\nnpm run build\nThen continue.'
    expect(detectViolations(ORIGINAL, bad).map((v) => v.code)).toContain('shell')
  })

  it('rejects shell prompt markers', () => {
    expect(detectViolations(ORIGINAL, '$ npm test && git push').map((v) => v.code)).toContain('shell')
  })

  it('rejects JSON payloads', () => {
    const bad = '{"steps":[{"id":"s1","role":"coder"}]}'
    expect(detectViolations(ORIGINAL, bad).map((v) => v.code)).toContain('json')
  })

  it('rejects source code', () => {
    const bad = 'import { useState } from "react"\nexport function App() { return null }'
    expect(detectViolations(ORIGINAL, bad).map((v) => v.code)).toContain('code')
  })

  it('rejects worker/task decomposition', () => {
    const bad = 'Split this into Worker A and Worker B with dependsOn edges between them, then route the plan.'
    expect(detectViolations(ORIGINAL, bad).map((v) => v.code)).toContain('plan')
  })

  it('rejects diff hunks', () => {
    const bad = 'Apply this:\n@@ -1,3 +1,4 @@\n-old\n+new\nDone when tests pass.'
    expect(detectViolations(ORIGINAL, bad).map((v) => v.code)).toContain('patch')
  })

  it('keeps legitimate technical terminology', () => {
    const good =
      'Update the dashboard so the notes list reads from package.json config, then make sure the git history stays clean.'
    expect(detectViolations(ORIGINAL, good)).toEqual([])
  })

  it('rejects a refinement that collapsed to a fragment of the original', () => {
    // Observed end-to-end: a prompt ending in "Reply with DONE when both files
    // exist." came back as the single word DONE and poisoned the whole plan.
    const original =
      'Run this small end-to-end task. In the workspace directory create a file named harness-smoke-test.txt whose entire content is exactly HARNESS_SMOKE_TEST_OK (no quotes, no extra text; a trailing newline is fine). Also create summary.md in the workspace directory with one short line describing what you did. Reply with DONE when both files exist.'
    const codes = detectViolations(original, 'DONE').map((v) => v.code)
    expect(codes).toContain('truncated')
  })

  it('rejects a completion report instead of a restated request', () => {
    const claim = 'Created harness-smoke-test.txt with exact content HARNESS_SMOKE_TEST_OK and summary.md with a brief description of the action in the workspace directory. DONE'
    expect(detectViolations('Create the smoke files and reply when both exist.', claim).map((v) => v.code)).toContain('answered')
    expect(detectViolations(ORIGINAL, 'Done — the dashboard lists and filters the notes.').map((v) => v.code)).toContain('answered')
  })

  it('keeps imperative requests that share the same verbs', () => {
    expect(detectViolations(ORIGINAL, 'Create a small dashboard that lists my notes and lets me filter them by tag.')).toEqual([])
    expect(detectViolations(ORIGINAL, 'Add a search box above the notes list.')).toEqual([])
    expect(detectViolations(ORIGINAL, 'Fix the filter so tag selection survives a refresh.')).toEqual([])
  })

  it('still accepts a tightened or translated refinement', () => {
    const long =
      'Run this small end-to-end task. In the workspace directory create a file named harness-smoke-test.txt whose entire content is exactly HARNESS_SMOKE_TEST_OK (no quotes, no extra text; a trailing newline is fine). Also create summary.md in the workspace directory with one short line describing what you did. Reply with DONE when both files exist.'
    const tightened = 'Create harness-smoke-test.txt in the workspace directory containing exactly HARNESS_SMOKE_TEST_OK with a trailing newline, and create summary.md with one short line describing what you did.'
    expect(detectViolations(long, tightened)).toEqual([])
    expect(detectViolations(long, 'ワークスペースに HARNESS_SMOKE_TEST_OK を含むファイルと summary.md を作成してください。', 'Japanese')).toEqual([])
  })
})

describe('language preservation', () => {
  it('profiles scripts', () => {
    const ja = scriptProfile('ダッシュボードを作る')
    expect(ja.scripts.kana).toBeGreaterThan(0)
    expect(scriptProfile('plain english text').nonAsciiLetters).toBe(0)
  })

  it('flags an English → other-language switch', () => {
    expect(languageSwitched(ORIGINAL, 'Construye un panel pequeño que liste mis notas y me permita filtrarlas por etiqueta.')).toBe(true)
    expect(languageSwitched(ORIGINAL, 'Build a small dashboard that lists my notes.')).toBe(false)
  })

  it('flags a non-Latin original that came back in English', () => {
    const original = 'タグでフィルターできるノート一覧のダッシュボードを作ってください。'
    expect(languageSwitched(original, 'Build a dashboard that lists notes filtered by tag.')).toBe(true)
    expect(languageSwitched(original, original)).toBe(false)
  })

  it('flags a Cyrillic original translated away', () => {
    const original = 'Сделай панель, которая показывает мои заметки и фильтрует их по тегу.'
    expect(languageSwitched(original, 'Make a panel that shows my notes and filters them by tag.')).toBe(true)
    expect(languageSwitched(original, 'Сделай панель для заметок с фильтром по тегу.')).toBe(false)
  })
})

describe('target output language', () => {
  const JAPANESE = 'タグで絞り込めるノート一覧の小さなダッシュボードを作ってください。'
  const SPANISH = 'Construye un panel pequeño que liste mis notas y me permita filtrarlas por etiqueta.'
  const JAPANESE_ORIGINAL = 'タグでフィルターできるノート一覧のダッシュボードを作ってください。'

  it('accepts output written in the requested target language', () => {
    expect(detectViolations(ORIGINAL, JAPANESE, 'Japanese')).toEqual([])
    expect(detectViolations(ORIGINAL, SPANISH, 'Spanish')).toEqual([])
    expect(languageSwitched(ORIGINAL, JAPANESE, 'Japanese')).toBe(false)
    expect(languageSwitched(ORIGINAL, SPANISH, 'Spanish')).toBe(false)
  })

  it('still flags a language change when the target is the default English', () => {
    expect(detectViolations(ORIGINAL, SPANISH, 'English').map((v) => v.code)).toContain('language')
    expect(detectViolations(ORIGINAL, SPANISH).map((v) => v.code)).toContain('language')
    expect(detectViolations(ORIGINAL, JAPANESE, 'English').map((v) => v.code)).toContain('language')
    expect(languageSwitched(JAPANESE_ORIGINAL, 'Build a dashboard that lists notes filtered by tag.', 'Japanese')).toBe(true)
    expect(languageSwitched(JAPANESE_ORIGINAL, JAPANESE_ORIGINAL, 'Japanese')).toBe(false)
  })

  it('keeps the default English system prompt byte-identical', () => {
    expect(refinerSystemPrompt('English')).toBe(REFINER_SYSTEM_PROMPT)
    expect(refinerSystemPrompt('')).toBe(REFINER_SYSTEM_PROMPT)
    const japanese = refinerSystemPrompt('Japanese')
    expect(japanese).toContain(REFINER_SYSTEM_PROMPT)
    expect(japanese).toContain('write the refined request in Japanese')
    expect(japanese).toContain('supersedes rule 5')
  })

  it('asks for and accepts a Japanese refinement of an English request', async () => {
    const { ctx, calls } = fakeCtx([JAPANESE])
    const out = await refinePrompt(ctx, job({ language: 'Japanese' }))
    expect(out).toBe(JAPANESE)
    expect(calls).toHaveLength(1)
    expect(calls[0]).toContain('write the refined request in Japanese')
    expect(calls[0]).toContain(ORIGINAL)
  })

  it('repairs into the requested language instead of the original one', async () => {
    const bad = '```ts\nconst x = 1\n```'
    const { ctx, calls } = fakeCtx([bad, JAPANESE])
    const out = await refinePrompt(ctx, job({ language: 'Japanese' }))
    expect(out).toBe(JAPANESE)
    expect(calls).toHaveLength(2)
    expect(calls[1]).toContain('written in Japanese')
    expect(calls[1]).not.toContain('same language as the original request')
  })

  it('defaults to English preservation when no target language is set', async () => {
    const translated = 'Creez un petit tableau de bord qui liste mes notes.'
    const good = 'Build a small dashboard that lists my notes and lets me filter them by tag.'
    const { ctx, calls } = fakeCtx([translated, good])
    const out = await refinePrompt(ctx, job())
    expect(out).toBe(good)
    expect(calls[1]).toContain('same language as the original request')
  })
})

describe('refinePrompt', () => {
  it('ships a specialist system prompt that forbids code and answers', () => {
    expect(REFINER_SYSTEM_PROMPT).toContain('prompt refinement specialist')
    expect(REFINER_SYSTEM_PROMPT).toContain('Preserve the user')
    expect(REFINER_SYSTEM_PROMPT).not.toContain('acceptance criteria')
  })

  it('returns a valid refinement on the first attempt', async () => {
    const good = 'Build a small dashboard that lists my notes and lets me filter them by tag.'
    const { ctx, calls } = fakeCtx([good])
    const out = await refinePrompt(ctx, job())
    expect(out).toBe(good)
    expect(calls).toHaveLength(1)
    expect(calls[0]).toContain('prompt refinement specialist')
    expect(calls[0]).toContain(ORIGINAL)
  })

  it('regenerates when the model answers with an implementation plan', async () => {
    const bad = 'Create Worker A to run npm install and Create Worker B to edit src/app.ts, then dependsOn s1.'
    const good = 'Build a small dashboard that lists my notes and lets me filter them by tag.'
    const { ctx, calls } = fakeCtx([bad, good])
    const out = await refinePrompt(ctx, job())
    expect(out).toBe(good)
    expect(calls).toHaveLength(2)
    expect(calls[1]).toContain('violated the refinement contract')
  })

  it('falls back to the original prompt when every attempt is malformed', async () => {
    const bad = '```js\nrun it\n```'
    const { ctx, calls } = fakeCtx([bad])
    const out = await refinePrompt(ctx, job())
    expect(out).toBe(ORIGINAL)
    expect(calls).toHaveLength(3)
  })

  it('never returns a translation of the original', async () => {
    const translated = 'Creez un petit tableau de bord qui liste mes notes.'
    const good = 'Build a small dashboard that lists my notes and lets me filter them by tag.'
    const { ctx } = fakeCtx([translated, good])
    const out = await refinePrompt(ctx, job())
    expect(out).toBe(good)
  })
})
