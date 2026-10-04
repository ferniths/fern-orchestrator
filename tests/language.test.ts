import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { appConfigSchema, ConfigStore } from '@core/kernel/config'
import { createCoreContext, type AppContext } from '@core/kernel/appContext'
import {
  OUTPUT_LANGUAGES,
  agentRoleSchema,
  automationJobSchema,
  outputLanguageSchema,
  proseLanguageInstruction,
} from '@shared/domain'
import {
  PLAN_JSON_SCHEMA,
  REVIEW_JSON_SCHEMA,
  planDataSchema,
  plannerSystemPrompt,
  reviewDataSchema,
} from '@core/orchestration/plan'
import { planUserPrompt } from '@core/orchestration/prompts'

/* -------------------------------------------------------------------------- */
/* Fake OpenAI-compatible provider                                            */
/* -------------------------------------------------------------------------- */

interface CapturedRequest {
  path: string
  body: {
    messages?: { role: string; content: string }[]
    response_format?: { json_schema?: { name?: string } }
  }
}

const captured: CapturedRequest[] = []

function chatReply(content: string): string {
  return JSON.stringify({
    id: 'cmpl-1',
    model: 'test-model',
    choices: [{ message: { role: 'assistant', content }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 11, completion_tokens: 7 },
  })
}

/** Messages of the last request the control plane sent. */
function lastMessages(): { role: string; content: string }[] {
  expect(captured.length).toBeGreaterThan(0)
  return captured[captured.length - 1]?.body.messages ?? []
}

function lastSystemContent(): string {
  const messages = lastMessages()
  expect(messages[0]?.role).toBe('system')
  return messages[0]?.content ?? ''
}

let server: Server
let baseUrl = ''
let ctx: AppContext
let dataDir: string

beforeAll(async () => {
  server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const chunks: Buffer[] = []
    req.on('data', (c: Buffer) => chunks.push(c))
    req.on('end', () => {
      try {
        const path = req.url ?? ''
        if (path.endsWith('/models')) {
          res.writeHead(200, { 'content-type': 'application/json' })
          res.end(JSON.stringify({ data: [{ id: 'test-model' }] }))
          return
        }
        if (path.endsWith('/chat/completions')) {
          let body: CapturedRequest['body'] = {}
          if (chunks.length) body = JSON.parse(Buffer.concat(chunks).toString()) as CapturedRequest['body']
          captured.push({ path, body })
          res.writeHead(200, { 'content-type': 'application/json' })
          if (body.response_format?.json_schema?.name === 'job_review') {
            res.end(chatReply(JSON.stringify({ verdict: 'pass', summary: 'looks good', problems: [], changes: [] })))
            return
          }
          res.end(chatReply('plain reply'))
          return
        }
        res.writeHead(404)
        res.end()
      } catch (err) {
        res.writeHead(500, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ error: String(err) }))
      }
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  const port = typeof address === 'object' && address ? address.port : 0
  baseUrl = `http://127.0.0.1:${port}/v1`

  dataDir = await mkdtemp(join(tmpdir(), 'fern-lang-'))
  ctx = await createCoreContext({ dataDir, consoleLogs: false })
  ctx.repos.providers.createProvider({
    name: 'Mock OpenAI',
    type: 'openai_compatible',
    baseUrl,
    defaultModel: 'test-model',
  })
}, 30_000)

afterAll(async () => {
  await ctx?.shutdown()
  server?.closeAllConnections?.()
  await new Promise<void>((resolve) => server?.close(() => resolve()))
  if (dataDir) await rm(dataDir, { recursive: true, force: true })
}, 30_000)

beforeEach(() => {
  captured.length = 0
})

afterEach(async () => {
  await ctx.config.update({ general: { language: 'English' } })
})

/* -------------------------------------------------------------------------- */
/* Config                                                                      */
/* -------------------------------------------------------------------------- */

describe('config output language', () => {
  it('defaults to English and accepts exactly the five canonical values', () => {
    expect(appConfigSchema.parse({}).general.language).toBe('English')
    expect(OUTPUT_LANGUAGES).toEqual(['English', 'Japanese', 'Portuguese (Brazil)', 'Spanish', 'Jamaican Patois'])
    for (const value of OUTPUT_LANGUAGES) {
      expect(appConfigSchema.safeParse({ general: { language: value } }).success).toBe(true)
      expect(outputLanguageSchema.safeParse(value).success).toBe(true)
    }
  })

  it('rejects values outside the enum', () => {
    expect(outputLanguageSchema.safeParse('French').success).toBe(false)
    expect(appConfigSchema.safeParse({ general: { language: 'French' } }).success).toBe(false)
  })

  it('round-trips a language change through ConfigStore', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'fern-cfg-'))
    const file = join(dir, 'config.json')
    const store = new ConfigStore(file)
    await store.update({ general: { language: 'Portuguese (Brazil)' } })

    const reloaded = await ConfigStore.load(file)
    expect(reloaded.get().general.language).toBe('Portuguese (Brazil)')
    // Sibling settings survive the same load.
    expect(reloaded.get().general.minimizeToTray).toBe(true)
    expect(reloaded.get().appearance.theme).toBe('dark')
    await reloaded.flush()
    await rm(dir, { recursive: true, force: true })
  })

  it('rejects an unknown language through the settings store', async () => {
    await expect(ctx.config.update({ general: { language: 'Klingon' } })).rejects.toThrow()
    expect(ctx.config.get().general.language).toBe('English')
  })
})

/* -------------------------------------------------------------------------- */
/* jobs.create                                                                 */
/* -------------------------------------------------------------------------- */

describe('jobs.create language', () => {
  it('defaults from the global setting and honours an explicit override', async () => {
    const handlers = await import('../src/main/ipc/handlers/jobs').then((m) => m.jobHandlers(ctx))
    const create = handlers['jobs.create'] as (args: [
      { prompt: string; language?: string },
    ]) => Promise<{ id: string; language: string | null }>

    await ctx.config.update({ general: { language: 'Japanese' } })

    const defaulted = await create([{ prompt: 'Build a small CLI that renames photos by capture date' }])
    expect(defaulted.language).toBe('Japanese')
    // Persisted, not just returned: the DB row survives a re-read.
    expect(ctx.repos.jobs.get(defaulted.id)?.language).toBe('Japanese')

    const overridden = await create([{ prompt: 'Build a small CLI that renames photos by capture date', language: 'Spanish' }])
    expect(overridden.language).toBe('Spanish')
    expect(ctx.repos.jobs.get(overridden.id)?.language).toBe('Spanish')

    await expect(create([{ prompt: 'Build a small CLI', language: 'French' }])).rejects.toThrow(/unsupported output language/)
  })

  it('stores null when no override and no global language apply', () => {
    const job = automationJobSchema.parse({
      id: 'job_lang_default',
      title: 'no override',
      originalPrompt: 'do the thing',
      createdAt: 1,
      updatedAt: 1,
    })
    expect(job.language).toBeNull()
  })
})

/* -------------------------------------------------------------------------- */
/* Planner prompts                                                             */
/* -------------------------------------------------------------------------- */

describe('planner prompt language', () => {
  it('contains the language line only when the target is not English', () => {
    const english = plannerSystemPrompt('English')
    expect(english).not.toContain('Write the user-facing prose fields')
    expect(english).not.toContain('summary, title, objective')

    for (const language of OUTPUT_LANGUAGES.filter((l) => l !== 'English')) {
      const prompt = plannerSystemPrompt(language)
      expect(prompt).toContain(
        `Write the user-facing prose fields (summary, title, objective, rationale, risks, acceptance) in ${language}`,
      )
    }
  })

  it('always asks for independent steps so several workers can run in parallel', () => {
    for (const language of OUTPUT_LANGUAGES) {
      const prompt = plannerSystemPrompt(language)
      expect(prompt).toContain('Prefer independent steps')
      expect(prompt).toContain('dependsOn edge only when a step truly consumes')
      expect(prompt).toContain('several workers execute in parallel')
    }
  })

  it('localizes prose only — keys, enums and worker instructions stay English', () => {
    const prompt = plannerSystemPrompt('Japanese')
    expect(prompt).toContain('role and complexity enum values')
    expect(prompt).toContain('worker instruction field `prompt` in English')
    expect(prompt).toContain('worker task instructions are never localized')
  })

  it('adds the same guidance to the user prompt only for a non-English target', () => {
    const job = automationJobSchema.parse({
      id: 'job_lang_plan',
      title: 'plan language',
      originalPrompt: 'build a dashboard',
      createdAt: 1,
      updatedAt: 1,
    })
    const english = planUserPrompt(job, 1)
    expect(planUserPrompt(job, 1, undefined, undefined, 'English')).toBe(english)
    expect(english).not.toContain('prose fields')
    expect(english).toContain('Produce the step DAG as JSON.')

    const japanese = planUserPrompt(job, 1, undefined, undefined, 'Japanese')
    expect(japanese).toContain('in Japanese')
    expect(japanese).toContain('`prompt` worker instruction in English')
    expect(japanese).toContain('Produce the step DAG as JSON.')
  })
})

/* -------------------------------------------------------------------------- */
/* Structured JSON contracts                                                   */
/* -------------------------------------------------------------------------- */

describe('structured output contracts', () => {
  it('keeps the plan JSON schema keys, enums and minItems unchanged', () => {
    const schema = PLAN_JSON_SCHEMA.schema
    expect(Object.keys(schema.properties)).toEqual(['summary', 'risks', 'acceptance', 'steps'])
    expect(schema.required).toEqual(['summary', 'risks', 'acceptance', 'steps'])
    expect(schema.additionalProperties).toBe(false)

    const steps = schema.properties.steps
    expect(steps.minItems).toBe(1)
    expect(Object.keys(steps.items.properties)).toEqual([
      'id',
      'title',
      'role',
      'dependsOn',
      'objective',
      'prompt',
      'expectedArtifacts',
      'successCriteria',
      'rationale',
      'complexity',
      'timeoutMinutes',
    ])
    expect(steps.items.required).toEqual([
      'id',
      'title',
      'role',
      'dependsOn',
      'objective',
      'prompt',
      'expectedArtifacts',
      'successCriteria',
      'rationale',
      'complexity',
      'timeoutMinutes',
    ])
    expect(steps.items.properties.role.enum).toEqual([...agentRoleSchema.options])
    expect(steps.items.properties.complexity.enum).toEqual(['low', 'medium', 'high'])
    expect(steps.items.additionalProperties).toBe(false)
  })

  it('keeps the review JSON schema unchanged', () => {
    expect(REVIEW_JSON_SCHEMA.name).toBe('job_review')
    expect(REVIEW_JSON_SCHEMA.schema.required).toEqual(['verdict', 'summary', 'problems', 'changes'])
    expect(REVIEW_JSON_SCHEMA.schema.properties.verdict.enum).toEqual(['pass', 'fail', 'needs_more_work', 'stop'])
    expect(REVIEW_JSON_SCHEMA.schema.additionalProperties).toBe(false)
  })

  it('never lets a localized value into an enum-constrained field', () => {
    const parsed = planDataSchema.safeParse({
      summary: '要約',
      steps: [{ id: 's1', title: '作業', role: '日本語', prompt: 'worker instruction' }],
    })
    expect(parsed.success).toBe(false)

    expect(
      reviewDataSchema.safeParse({ verdict: '合格', summary: 's', problems: [], changes: [] }).success,
    ).toBe(false)
  })
})

/* -------------------------------------------------------------------------- */
/* Control plane                                                               */
/* -------------------------------------------------------------------------- */

describe('control plane output language', () => {
  it('appends the instruction for synthesizer runs when the job language is not English', async () => {
    const job = ctx.repos.jobs.create({ title: 'japanese job', originalPrompt: 'build a dashboard', language: 'Japanese' })
    await ctx.ai.runText({
      role: 'synthesizer',
      jobId: job.id,
      messages: [
        { role: 'system', content: 'SYS' },
        { role: 'user', content: 'go' },
      ],
    })

    const messages = lastMessages()
    expect(messages).toHaveLength(2)
    expect(messages.map((m) => m.role)).toEqual(['system', 'user'])
    expect(messages[0]?.content).toBe(
      'SYS\n\nWrite all human-readable prose (summaries, problems, changes) in Japanese. Keep JSON keys and enum values exactly as specified.',
    )
    expect(messages[1]?.content).toBe('go')
  })

  it('appends nothing when the job language is English', async () => {
    const job = ctx.repos.jobs.create({ title: 'english job', originalPrompt: 'build a dashboard', language: 'English' })
    await ctx.ai.runText({
      role: 'synthesizer',
      jobId: job.id,
      messages: [
        { role: 'system', content: 'SYS' },
        { role: 'user', content: 'go' },
      ],
    })

    expect(lastMessages()).toHaveLength(2)
    expect(lastSystemContent()).toBe('SYS')
  })

  it('appends the instruction for structured reviewer runs', async () => {
    const job = ctx.repos.jobs.create({ title: 'spanish job', originalPrompt: 'build a dashboard', language: 'Spanish' })
    await ctx.ai.runStructured({
      role: 'reviewer',
      jobId: job.id,
      schema: reviewDataSchema,
      jsonSchema: REVIEW_JSON_SCHEMA,
      messages: [
        { role: 'system', content: 'SYS-R' },
        { role: 'user', content: 'judge' },
      ],
    })

    const content = lastSystemContent()
    expect(content).toContain('Write all human-readable prose (summaries, problems, changes) in Spanish.')
    expect(content).toContain('Keep JSON keys and enum values exactly as specified.')
    expect(content.startsWith('SYS-R\n\n')).toBe(true)
    expect(lastMessages()[1]?.content).toBe('judge')
  })

  it('falls back to the global setting when the job has no per-job override', async () => {
    await ctx.config.update({ general: { language: 'Portuguese (Brazil)' } })
    const job = ctx.repos.jobs.create({ title: 'legacy job', originalPrompt: 'build a dashboard' })
    expect(job.language).toBeNull()

    await ctx.ai.runText({
      role: 'final_reviewer',
      jobId: job.id,
      messages: [
        { role: 'system', content: 'SYS' },
        { role: 'user', content: 'go' },
      ],
    })
    expect(lastSystemContent()).toContain('Portuguese (Brazil)')
  })

  it('leaves runs without a job id on the global language', async () => {
    await ctx.ai.runText({
      role: 'synthesizer',
      messages: [
        { role: 'system', content: 'SYS' },
        { role: 'user', content: 'go' },
      ],
    })
    // Global language is English after the afterEach reset.
    expect(lastSystemContent()).toBe('SYS')
  })
})

/* -------------------------------------------------------------------------- */
/* Shared helper                                                               */
/* -------------------------------------------------------------------------- */

describe('proseLanguageInstruction', () => {
  it('is null for English so default prompts stay byte-identical', () => {
    expect(proseLanguageInstruction('English')).toBeNull()
    expect(proseLanguageInstruction(null)).toBeNull()
    expect(proseLanguageInstruction(undefined)).toBeNull()
  })

  it('names the language for every other value', () => {
    for (const language of OUTPUT_LANGUAGES.filter((l) => l !== 'English')) {
      const instruction = proseLanguageInstruction(language)
      expect(instruction).toContain(language)
      expect(instruction).toContain('Keep JSON keys and enum values exactly as specified.')
    }
  })
})
