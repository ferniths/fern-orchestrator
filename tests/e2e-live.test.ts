import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createCoreContext, type AppContext } from '@core/kernel/appContext'
import { PLAN_JSON_SCHEMA, planDataSchema } from '@core/orchestration/plan'
import { providerHandlers } from '../src/main/ipc/handlers/providers'

const enabled = process.env.FERN_E2E === '1'
const providerUrl = process.env.FERN_E2E_PROVIDER_URL ?? 'http://127.0.0.1:20128/v1'
const apiKey = process.env.FERN_E2E_API_KEY ?? ''
const model = process.env.FERN_E2E_MODEL ?? ''

let ctx: AppContext
let dataDir: string

describe.skipIf(!enabled)('live provider E2E (spec section 68)', () => {
  beforeAll(async () => {
    if (!apiKey || !model) {
      throw new Error('FERN_E2E_API_KEY and FERN_E2E_MODEL must both be set (run via `npm run e2e:live`)')
    }

    dataDir = await mkdtemp(join(tmpdir(), 'fern-e2e-'))
    ctx = await createCoreContext({ dataDir, consoleLogs: false })

    const handlers = providerHandlers(ctx)
    const create = handlers['providers.create'] as (args: [
      Record<string, unknown>,
    ]) => Promise<{ id: string; name: string }>
    const provider = await create([
      {
        name: 'Live E2E',
        type: 'openai_compatible',
        baseUrl: providerUrl,
        defaultModel: model,
        apiKey,
      },
    ])
    expect(provider.id).toBeTruthy()
    console.log(`[e2e-live] registered provider ${provider.id} → ${providerUrl} (model ${model})`)
  }, 60_000)

  afterAll(async () => {
    await ctx?.shutdown()
    if (dataDir) await rm(dataDir, { recursive: true, force: true })
  })

  it('runs a real text completion through the control plane', async () => {
    const started = Date.now()
    const res = await ctx.ai.runText({
      role: 'refiner',
      messages: [{ role: 'user', content: 'Reply with exactly one word: ready' }],
      timeoutMs: 90_000,
    })
    const elapsedMs = Date.now() - started

    expect(res.text.trim().length).toBeGreaterThan(0)
    console.log(`[e2e-live] runText model=${res.modelId} elapsed=${elapsedMs}ms`)
    console.log(`[e2e-live] usage in=${res.usage.inputTokens} out=${res.usage.outputTokens}`)
    console.log(`[e2e-live] reply: ${JSON.stringify(res.text.slice(0, 300))}`)
  }, 120_000)

  it('produces a schema-valid job plan through runStructured', async () => {
    const started = Date.now()
    const res = await ctx.ai.runStructured({
      role: 'planner',
      messages: [
        {
          role: 'user',
          content:
            'Create a plan for: build a small CLI that converts a CSV file into a SQLite database. Keep it to a handful of steps.',
        },
      ],
      schema: planDataSchema,
      jsonSchema: PLAN_JSON_SCHEMA,
      maxAttempts: 4,
      timeoutMs: 120_000,
    })
    const elapsedMs = Date.now() - started
    const plan = planDataSchema.parse(res.data)

    expect(plan.steps.length).toBeGreaterThan(0)
    expect(plan.steps[0]!.prompt.length).toBeGreaterThan(0)
    expect(plan.summary.length).toBeGreaterThan(0)

    console.log(
      `[e2e-live] runStructured model=${res.modelId} elapsed=${elapsedMs}ms attempts=${res.attempts} repaired=${res.repaired}`,
    )
    console.log(`[e2e-live] usage in=${res.usage.inputTokens} out=${res.usage.outputTokens}`)
    console.log(`[e2e-live] plan steps: ${plan.steps.map((s) => `${s.id}:${s.role}`).join(', ')}`)
  }, 180_000)
})
