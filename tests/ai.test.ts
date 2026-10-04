import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { z } from 'zod'
import { providerConnectionSchema, modelRouteSchema, type ProviderConnection } from '../src/shared/domain'
import { complete } from '../src/core/ai/chat'
import { completeJson } from '../src/core/ai/structured'
import { extractJson } from '../src/core/ai/json'
import { resolveModel } from '../src/core/ai/router'
import { AppError } from '../src/core/kernel/errors'

type Mode = 'ok' | 'reasoning' | 'rate' | 'garbage_then_ok' | 'always_garbage' | 'five_hundred'

const state: { mode: Mode; calls: number; lastBody: Record<string, unknown> | null } = {
  mode: 'ok',
  calls: 0,
  lastBody: null,
}

let server: Server
let baseUrl = ''

function chatReply(content: string | null, extra: Record<string, unknown> = {}) {
  return JSON.stringify({
    id: 'cmpl-1',
    model: 'test-model',
    choices: [{ message: { role: 'assistant', content, ...(extra.reasoning ? { reasoning_content: extra.reasoning } : {}) }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 11, completion_tokens: 7 },
  })
}

beforeAll(async () => {
  server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const chunks: Buffer[] = []
    req.on('data', (c: Buffer) => chunks.push(c))
    req.on('end', () => {
      const path = req.url ?? ''
      if (path.endsWith('/models')) {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ data: [{ id: 'test-model' }, { id: 'other-model' }] }))
        return
      }
      if (path.endsWith('/chat/completions')) {
        state.calls++
        state.lastBody = chunks.length ? (JSON.parse(Buffer.concat(chunks).toString()) as Record<string, unknown>) : null
        if (state.mode === 'rate') {
          res.writeHead(429, { 'content-type': 'application/json' })
          res.end(JSON.stringify({ error: { message: 'slow down' } }))
          return
        }
        if (state.mode === 'five_hundred') {
          res.writeHead(503, { 'content-type': 'application/json' })
          res.end('upstream exploded')
          return
        }
        if (state.mode === 'reasoning') {
          res.writeHead(200, { 'content-type': 'application/json' })
          res.end(chatReply(null, { reasoning: '{"answer":42}' }))
          return
        }
        if (state.mode === 'garbage_then_ok') {
          res.writeHead(200, { 'content-type': 'application/json' })
          res.end(state.calls === 1 ? chatReply('sorry, here are some thoughts instead of JSON') : chatReply('{"answer":42}'))
          return
        }
        if (state.mode === 'always_garbage') {
          res.writeHead(200, { 'content-type': 'application/json' })
          res.end(chatReply('definitely not json'))
          return
        }
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(chatReply('{"answer":42}'))
        return
      }
      res.writeHead(404)
      res.end()
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  const port = typeof address === 'object' && address ? address.port : 0
  baseUrl = `http://127.0.0.1:${port}/v1`
})

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()))
})

beforeEach(() => {
  state.mode = 'ok'
  state.calls = 0
  state.lastBody = null
})

function provider(overrides: Partial<ProviderConnection> = {}): ProviderConnection {
  return providerConnectionSchema.parse({
    id: 'prv_test',
    name: 'Mock',
    type: 'openai_compatible',
    baseUrl: baseUrl || 'http://127.0.0.1:9/v1',
    defaultModel: 'test-model',
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  })
}

const answerSchema = z.object({ answer: z.number() })

describe('complete()', () => {
  it('returns text, usage and the model actually served', async () => {
    const res = await complete(provider(), 'key-1', { messages: [{ role: 'user', content: 'hi' }] })
    expect(res.text).toBe('{"answer":42}')
    expect(res.modelId).toBe('test-model')
    expect(res.usage.inputTokens).toBe(11)
    expect(res.usage.outputTokens).toBe(7)
    expect(state.lastBody).toMatchObject({ model: 'test-model', stream: false })
  })

  it('sends the bearer token and json_schema response format when asked', async () => {
    await complete(provider(), 'key-1', {
      messages: [{ role: 'user', content: 'hi' }],
      jsonSchema: { name: 'answer', schema: { type: 'object' } },
    })
    expect(state.lastBody).toMatchObject({ response_format: { type: 'json_schema' } })
  })

  it('reads JSON out of reasoning_content when content is null', async () => {
    state.mode = 'reasoning'
    const res = await complete(provider(), null, { messages: [{ role: 'user', content: 'hi' }] })
    expect(res.text).toBe('{"answer":42}')
  })

  it('classifies 429 as rate_limited', async () => {
    state.mode = 'rate'
    await expect(complete(provider(), null, { messages: [{ role: 'user', content: 'hi' }] })).rejects.toMatchObject({
      code: 'rate_limited',
    })
  })

  it('classifies 5xx as provider_error', async () => {
    state.mode = 'five_hundred'
    await expect(complete(provider(), null, { messages: [{ role: 'user', content: 'hi' }] })).rejects.toMatchObject({
      code: 'provider_error',
    })
  })

  it('rejects when the provider returns non-JSON', async () => {
    const broken = provider({ baseUrl: 'http://127.0.0.1:1/v1' })
    await expect(complete(broken, null, { messages: [{ role: 'user', content: 'hi' }], timeoutMs: 500 })).rejects.toBeInstanceOf(AppError)
  })
})

describe('completeJson()', () => {
  it('validates a well-formed payload on the first attempt', async () => {
    const res = await completeJson(provider(), null, {
      messages: [{ role: 'user', content: 'hi' }],
      schema: answerSchema,
      jsonSchema: { name: 'answer', schema: { type: 'object', properties: { answer: { type: 'number' } } } },
    })
    expect(res.data).toEqual({ answer: 42 })
    expect(res.attempts).toBe(1)
    expect(res.repaired).toBe(false)
    expect(res.usage.inputTokens).toBe(11)
  })

  it('repairs a malformed reply with a second call', async () => {
    state.mode = 'garbage_then_ok'
    const res = await completeJson(provider(), null, {
      messages: [{ role: 'user', content: 'hi' }],
      schema: answerSchema,
      jsonSchema: { name: 'answer', schema: { type: 'object' } },
    })
    expect(res.data).toEqual({ answer: 42 })
    expect(res.attempts).toBe(2)
    expect(res.repaired).toBe(true)
    expect(res.usage.inputTokens).toBe(22)
  })

  it('gives up with invalid_response when every attempt is garbage', async () => {
    state.mode = 'always_garbage'
    await expect(
      completeJson(provider(), null, {
        messages: [{ role: 'user', content: 'hi' }],
        schema: answerSchema,
        jsonSchema: { name: 'answer', schema: { type: 'object' } },
        maxAttempts: 2,
      }),
    ).rejects.toMatchObject({ code: 'invalid_response' })
    expect(state.calls).toBe(2)
  })

  it('fails when JSON parses but violates the schema', async () => {
    state.mode = 'ok'
    await expect(
      completeJson(provider(), null, {
        messages: [{ role: 'user', content: 'hi' }],
        schema: z.object({ totally_different: z.string() }),
        jsonSchema: { name: 'answer', schema: { type: 'object' } },
        maxAttempts: 1,
      }),
    ).rejects.toMatchObject({ code: 'invalid_response' })
  })
})

describe('extractJson()', () => {
  it('parses bare JSON', () => expect(extractJson('{"a":1}')).toEqual({ a: 1 }))
  it('parses fenced JSON', () => expect(extractJson('```json\n{"a":1}\n```')).toEqual({ a: 1 }))
  it('parses JSON wrapped in prose', () => expect(extractJson('Sure! Here you go: {"a":1} — done.')).toEqual({ a: 1 }))
  it('parses arrays', () => expect(extractJson('items: [1,2,3] end')).toEqual([1, 2, 3]))
  it('throws invalid_response when there is no JSON', () => expect(() => extractJson('no json here')).toThrow(AppError))
})

describe('resolveModel()', () => {
  const healthy = provider({ id: 'prv_a', name: 'Alpha', defaultModel: 'alpha-main', health: { ...provider().health, status: 'healthy' } })
  const unreachable = provider({
    id: 'prv_b',
    name: 'Beta',
    defaultModel: 'beta-main',
    fallbackModel: 'beta-backup',
    health: { ...provider().health, status: 'unreachable' },
  })

  it('returns null with no providers', () => {
    expect(resolveModel({ role: 'planner', route: null, providers: [], catalog: new Map() })).toBeNull()
  })

  it('picks the healthiest provider automatically', () => {
    const decision = resolveModel({ role: 'planner', route: null, providers: [unreachable, healthy], catalog: new Map() })
    expect(decision?.primary).toMatchObject({ providerId: 'prv_a', modelId: 'alpha-main' })
    expect(decision?.fallbacks.length).toBeGreaterThan(0)
  })

  it('honours an explicit route preference for the role', () => {
    const route = modelRouteSchema.parse({
      id: 'rte_1',
      name: 'Explicit',
      strategy: 'explicit',
      isDefault: false,
      createdAt: 1,
      updatedAt: 1,
      preferences: [{ role: 'planner', modelId: 'other-model', fallbackModelId: null, providerId: 'prv_a' }],
    })
    const catalog = new Map([['prv_a', [{ id: 'other-model', providerId: 'prv_a', contextWindow: null, maxOutput: null, reasoning: null, toolCalls: null, vision: null, isCombo: false }]]])
    const decision = resolveModel({ role: 'planner', route, providers: [healthy], catalog })
    expect(decision?.primary).toMatchObject({ providerId: 'prv_a', modelId: 'other-model' })
    expect(decision?.routeId).toBe('rte_1')
  })

  it('lets a direct override win over the route', () => {
    const route = modelRouteSchema.parse({
      id: 'rte_1',
      name: 'Explicit',
      strategy: 'explicit',
      isDefault: false,
      createdAt: 1,
      updatedAt: 1,
      preferences: [{ role: 'coder', modelId: null, fallbackModelId: null, providerId: 'prv_a' }],
    })
    const decision = resolveModel({
      role: 'coder',
      route,
      providers: [healthy],
      catalog: new Map(),
      override: { providerId: null, modelId: 'override-model' },
    })
    expect(decision?.primary.modelId).toBe('override-model')
    expect(decision?.primary.reason).toContain('override')
  })

  it('includes the connection fallback model in the chain', () => {
    const decision = resolveModel({ role: 'tester', route: null, providers: [unreachable, healthy], catalog: new Map() })
    const ids = [decision!.primary, ...decision!.fallbacks].map((t) => t.modelId)
    expect(ids).toContain('alpha-main')
  })

  it('ignores disabled providers', () => {
    expect(resolveModel({ role: 'planner', route: null, providers: [{ ...healthy, enabled: false }], catalog: new Map() })).toBeNull()
  })
})
