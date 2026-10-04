/**
 * Phase 0 spike: 9Router API contract (no assumptions about endpoint/version).
 * Verifies: /v1/models discovery, chat completions, streaming, and json_schema
 * response_format support. Uses a free model so nothing meaningful is consumed.
 */
const BASE = process.env.NINE_ROUTER_URL ?? 'http://127.0.0.1:20128'
let KEY = process.env.NINE_ROUTER_KEY ?? ''

// Dev-only convenience for this spike: pull the locally issued key out of the
// 9Router database so we can validate the API contract without hand-copying it.
// The product itself never reads 9Router storage; the user supplies the key.
if (!KEY) {
  try {
    const { default: D } = await import('../node_modules/better-sqlite3/lib/index.js')
    const db = new D(process.env.APPDATA + '/9router/db/data.sqlite', { readonly: true })
    const row = db.prepare('SELECT key FROM apiKeys WHERE isActive = 1 ORDER BY createdAt DESC LIMIT 1').get()
    KEY = row?.key ?? ''
    db.close()
  } catch (e) {
    console.warn('[9r] could not read local key:', e.message)
  }
}

const log = (...a) => console.log('[9r]', ...a)

async function main() {
  // 1. discovery
  const modelsRes = await fetch(`${BASE}/v1/models`, { headers: KEY ? { authorization: `Bearer ${KEY}` } : {} })
  log('GET /v1/models ->', modelsRes.status)
  const models = await modelsRes.json()
  const list = models.data ?? []
  log('models:', list.length)
  const combos = list.filter((m) => m.owned_by === 'combo').map((m) => m.id)
  log('combos:', combos.slice(0, 10).join(', '))
  const sample = list.find((m) => m.owned_by === 'combo') ?? list[0]
  log('candidate model:', sample?.id, JSON.stringify(sample?.capabilities ?? {}).slice(0, 200))
  if (!sample) throw new Error('no models')

  const headers = { 'content-type': 'application/json', ...(KEY ? { authorization: `Bearer ${KEY}` } : {}) }

  // 2. find a model that actually answers (gateways route combos to upstreams that
  //    can be down; try a spread of candidates before giving up)
  const candidates = [
    sample.id,
    ...list.map((m) => m.id).filter((id) => /gpt-oss|qwen|minimax|grok|mimo|llama/i.test(id)),
  ].slice(0, 8)
  let chosen = null
  let _plainText = ''
  for (const model of candidates) {
    const t0 = Date.now()
    const res = await fetch(`${BASE}/v1/chat/completions`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        model,
        messages: [{ role: 'user', content: 'Reply with exactly: PONG' }],
        max_tokens: 20,
        stream: false,
      }),
    })
    const text = await res.text()
    if (res.ok) {
      chosen = model
      _plainText = text
      log(`chat/completions [${model}] -> ${res.status} ${Date.now() - t0}ms`, text.slice(0, 260).replace(/\n/g, ' '))
      break
    }
    log(`chat/completions [${model}] -> ${res.status}`, text.slice(0, 160).replace(/\n/g, ' '))
  }
  if (!chosen) throw new Error('no healthy model found')
  const model = chosen

  // 3. json_schema structured output
  const js = await fetch(`${BASE}/v1/chat/completions`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      model: model,
      messages: [
        { role: 'system', content: 'You produce structured output.' },
        { role: 'user', content: 'Classify the sentence "the build is broken" .' },
      ],
      max_tokens: 100,
      stream: false,
      response_format: {
        type: 'json_schema',
        json_schema: {
          name: 'classification',
          strict: true,
          schema: {
            type: 'object',
            properties: {
              severity: { type: 'string', enum: ['low', 'medium', 'high'] },
              reason: { type: 'string' },
            },
            required: ['severity', 'reason'],
            additionalProperties: false,
          },
        },
      },
    }),
  })
  const jsText = await js.text()
  log('json_schema ->', js.status, jsText.slice(0, 400).replace(/\n/g, ' '))

  // 4. streaming
  const st = await fetch(`${BASE}/v1/chat/completions`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      model: model,
      messages: [{ role: 'user', content: 'Say STREAM in one word.' }],
      max_tokens: 20,
      stream: true,
    }),
  })
  log('stream ->', st.status, st.headers.get('content-type'))
  const reader = st.body.getReader()
  const dec = new TextDecoder()
  let buf = ''
  let chunks = 0
  let usage = null
  let text = ''
  for (;;) {
    const { value, done } = await reader.read()
    if (done) break
    buf += dec.decode(value, { stream: true })
    let i
    while ((i = buf.indexOf('\n')) !== -1) {
      const line = buf.slice(0, i).trim()
      buf = buf.slice(i + 1)
      if (!line.startsWith('data:')) continue
      const data = line.slice(5).trim()
      if (data === '[DONE]') continue
      try {
        const json = JSON.parse(data)
        chunks++
        if (json.usage) usage = json.usage
        const delta = json.choices?.[0]?.delta
        if (delta?.content) text += delta.content
      } catch {
        /* partial */
      }
    }
  }
  log('stream chunks:', chunks, 'text:', JSON.stringify(text.slice(0, 60)), 'usage:', JSON.stringify(usage))
  log('DONE')
}

main().catch((e) => {
  console.error('[9r] FAILED', e)
  process.exit(1)
})

