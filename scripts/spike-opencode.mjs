/**
 * Phase 0 spike: prove the OpenCode integration contract.
 *
 * Validates, against the REAL installed `opencode serve`:
 *   1. binary discovery + server boot with injected config (OPENCODE_CONFIG_CONTENT / OPENCODE_PERMISSION)
 *   2. basic-auth + /global/health + /doc
 *   3. SSE /event event names (session.status, session.idle, permission.updated, ...)
 *   4. session create -> prompt_async -> assistant message with usage
 *   5. bash tool -> `git commit` raises permission.asked -> we reply -> command runs
 *
 * Model traffic goes to a local mock OpenAI-compatible provider, so nothing costs tokens.
 */
import { spawn } from 'node:child_process'
import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'

const log = (...a) => console.log('[spike]', ...a)
const fail = (msg) => {
  console.error('[spike] FAILED:', msg)
  process.exit(1)
}

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = http.createServer()
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address()
      srv.close(() => resolve(port))
    })
    srv.on('error', reject)
  })
}

/* ------------------------------------------------------------------ mock provider */

function createMockProvider(port) {
  let requestCount = 0
  const server = http.createServer((req, res) => {
    let body = ''
    req.on('data', (c) => (body += c))
    req.on('end', () => {
      if (req.method === 'GET' && req.url.startsWith('/v1/models')) {
        res.setHeader('content-type', 'application/json')
        res.end(JSON.stringify({ object: 'list', data: [{ id: 'test-model', object: 'model' }] }))
        return
      }
      if (!req.url.includes('/chat/completions')) {
        res.statusCode = 404
        res.end('{}')
        return
      }
      const parsed = JSON.parse(body || '{}')
      requestCount++
      const messages = parsed.messages ?? []
      const sawToolResult = messages.some((m) => m.role === 'tool')
      const alreadyToolCalled = messages.some((m) => m.role === 'assistant' && Array.isArray(m.tool_calls) && m.tool_calls.length > 0)
      const wantsCommit =
        requestCount <= 3 &&
        !sawToolResult &&
        !alreadyToolCalled &&
        messages.some((m) => typeof m.content === 'string' && m.content.includes('SPIKE_COMMIT_REQUEST'))

      const chunks = []
      if (wantsCommit && !sawToolResult) {
        chunks.push({
          index: 0,
          delta: {
            role: 'assistant',
            tool_calls: [
              {
                index: 0,
                id: 'call_spike_1',
                type: 'function',
                function: {
                  name: 'bash',
                  arguments: JSON.stringify({ command: 'git commit --allow-empty -m "spike commit"' }),
                },
              },
            ],
          },
          finish_reason: null,
        })
        chunks.push({ index: 0, delta: {}, finish_reason: 'tool_calls' })
      } else {
        const text = sawToolResult ? 'SPIKE_RESULT: tool executed' : 'SPIKE_TEXT: hello from mock'
        chunks.push({ index: 0, delta: { role: 'assistant', content: text }, finish_reason: null })
        chunks.push({ index: 0, delta: {}, finish_reason: 'stop' })
      }

      const payload = {
        id: 'chatcmpl-spike',
        object: 'chat.completion.chunk',
        created: Math.floor(Date.now() / 1000),
        model: parsed.model ?? 'test-model',
        choices: [],
      }

      if (parsed.stream === false) {
        res.setHeader('content-type', 'application/json')
        res.end(
          JSON.stringify({
            ...payload,
            object: 'chat.completion',
            choices: [{ index: 0, message: { role: 'assistant', content: chunks[0].delta.content ?? '' }, finish_reason: 'stop' }],
            usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
          }),
        )
        return
      }

      res.setHeader('content-type', 'text/event-stream')
      res.setHeader('cache-control', 'no-cache')
      chunks.forEach((choice, i) => {
        const body = { ...payload, choices: [choice] }
        if (i === chunks.length - 1) body.usage = { prompt_tokens: 42, completion_tokens: 7, total_tokens: 49 }
        res.write(`data: ${JSON.stringify(body)}\n\n`)
      })
      res.write('data: [DONE]\n\n')
      res.end()
    })
  })
  return new Promise((resolve) => server.listen(port, '127.0.0.1', () => resolve(server)))
}

/* ------------------------------------------------------------------ sse */

function subscribeSse(url, auth, onEvent) {
  const ctrl = new AbortController()
  const run = async () => {
    try {
      const res = await fetch(url, { headers: { authorization: auth, accept: 'text/event-stream' }, signal: ctrl.signal })
      const reader = res.body.getReader()
      const decoder = new TextDecoder()
      let buf = ''
      for (;;) {
        const { value, done } = await reader.read()
        if (done) break
        buf += decoder.decode(value, { stream: true })
        let idx
        while ((idx = buf.indexOf('\n\n')) !== -1) {
          const block = buf.slice(0, idx)
          buf = buf.slice(idx + 2)
          for (const line of block.split('\n')) {
            if (line.startsWith('data:')) {
              const raw = line.slice(5).trim()
              if (!raw || raw === '[DONE]') continue
              try {
                onEvent(JSON.parse(raw))
              } catch {
                /* ignore malformed */
              }
            }
          }
        }
      }
    } catch (e) {
      if (!ctrl.signal.aborted) console.warn('[spike] sse closed:', e.message)
    }
  }
  run()
  return () => ctrl.abort()
}

/* ------------------------------------------------------------------ main */

async function main() {
  const workdir = path.join(os.tmpdir(), 'fern-spike-' + Date.now())
  fs.mkdirSync(workdir, { recursive: true })

  const mockPort = await freePort()
  const serverPort = await freePort()
  const mock = await createMockProvider(mockPort)

  // git repo workspace
  await import('node:child_process').then(({ execSync }) => {
    execSync('git init -q', { cwd: workdir })
    execSync('git config user.email spike@local', { cwd: workdir })
    execSync('git config user.name spike', { cwd: workdir })
    execSync('git config commit.gpgsign false', { cwd: workdir })
  })
  fs.writeFileSync(path.join(workdir, 'readme.md'), 'spike\n')

  const exe = process.platform === 'win32' ? path.join(process.env.APPDATA, 'npm', 'node_modules', 'opencode-ai', 'bin', 'opencode.exe') : 'opencode'
  const password = 'spike-secret'
  const config = {
    model: 'mock/test-model',
    small_model: 'mock/test-model',
    provider: {
      mock: {
        npm: '@ai-sdk/openai-compatible',
        name: 'Mock Provider',
        options: { baseURL: `http://127.0.0.1:${mockPort}/v1`, apiKey: 'spike' },
        models: {
          'test-model': { name: 'Test Model', tool_call: true, limit: { context: 200000, output: 8000 } },
        },
      },
    },
    subagent_depth: 1,
    autoupdate: false,
  }
  const permissions = {
    bash: { '*': 'allow', 'git commit*': 'ask', 'git push*': 'ask' },
  }

  log('spawning opencode serve on', serverPort, 'cwd', workdir)
  const child = spawn(exe, ['serve', '--port', String(serverPort), '--hostname', '127.0.0.1'], {
    cwd: workdir,
    env: {
      ...process.env,
      OPENCODE_SERVER_PASSWORD: password,
      OPENCODE_SERVER_USERNAME: 'opencode',
      OPENCODE_CONFIG_CONTENT: JSON.stringify(config),
      OPENCODE_PERMISSION: JSON.stringify(permissions),
      OPENCODE_DISABLE_AUTOUPDATE: '1',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  child.stdout.on('data', (d) => process.stdout.write('[oc:out] ' + d))
  child.stderr.on('data', (d) => process.stderr.write('[oc:err] ' + d))

  const base = `http://127.0.0.1:${serverPort}`
  const auth = 'Basic ' + Buffer.from('opencode:' + password).toString('base64')
  const api = async (method, p, body) => {
    const res = await fetch(base + p, {
      method,
      headers: { authorization: auth, 'content-type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
    })
    const text = await res.text()
    let json
    try {
      json = JSON.parse(text)
    } catch {
      json = text
    }
    return { status: res.status, json }
  }

  // 1. health
  const deadline = Date.now() + 60000
  let health = null
  while (Date.now() < deadline) {
    try {
      const r = await api('GET', '/global/health')
      if (r.status === 200) {
        health = r.json
        break
      }
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 400))
  }
  if (!health) fail('server never became healthy')
  log('health:', JSON.stringify(health))

  // 2. openapi doc
  const doc = await api('GET', '/doc')
  log('/doc status:', doc.status, 'is-json:', typeof doc.json === 'object')
  const spec = typeof doc.json === 'object' ? doc.json : null
  const paths = spec?.paths ? Object.keys(spec.paths) : []
  log('openapi paths:', paths.length, 'sample:', paths.filter((p) => p.includes('permission') || p.includes('/session')).slice(0, 12).join(' '))
  if (spec) {
    const out = path.join(process.cwd(), 'docs', 'openapi')
    fs.mkdirSync(out, { recursive: true })
    fs.writeFileSync(path.join(out, 'opencode-1.18.33.json'), JSON.stringify(spec, null, 2))
    log('spec written to docs/openapi/opencode-1.18.33.json')
    for (const p of paths.filter((x) => x.includes('permission'))) {
      const ops = spec.paths[p]
      for (const [method, op] of Object.entries(ops)) {
        const schema = op?.requestBody?.content?.['application/json']?.schema
        log(`  ${method.toUpperCase()} ${p} -> ${JSON.stringify(schema ?? op?.responses?.['200']?.content?.['application/json']?.schema ?? {}).slice(0, 300)}`)
      }
    }
    const promptSchema = spec.paths['/session/{sessionID}/prompt_async'] ?? spec.paths['/session/{sessionID}/message']
    if (promptSchema) {
      const s = promptSchema.post?.requestBody?.content?.['application/json']?.schema
      log('prompt body keys:', JSON.stringify(Object.keys(s?.properties ?? {})))
      if (s?.properties?.format) log('prompt format schema:', JSON.stringify(s.properties.format).slice(0, 300))
    }
  }

  // 3. agents + providers (config injection proof)
  const agents = await api('GET', '/agent')
  log('agents:', Array.isArray(agents.json) ? agents.json.map((a) => `${a.name}(${a.mode})`).join(', ') : agents.status)
  const providers = await api('GET', '/provider')
  log('provider connected:', JSON.stringify(providers.json?.connected ?? providers.status))

  // 4. SSE
  const events = []
  let sawPermission = null
  const stop = subscribeSse(`${base}/event`, auth, (ev) => {
    events.push(ev.type)
    if (ev.type === 'permission.asked' || ev.type === 'permission.updated') sawPermission = { ...ev.properties, event: ev.type }
    if (ev.type === 'session.error') console.error('[spike] session.error', JSON.stringify(ev.properties))
  })

  // 5. session + prompt
  const session = await api('POST', '/session', { title: '[SPIKE] approval flow' })
  if (session.status !== 200) fail('session create failed: ' + JSON.stringify(session.json))
  log('session:', session.json.id, 'dir:', session.json.directory)

  const promptRes = await api('POST', `/session/${session.json.id}/prompt_async`, {
    model: { providerID: 'mock', modelID: 'test-model' },
    agent: 'build',
    parts: [
      {
        type: 'text',
        text: 'SPIKE_COMMIT_REQUEST\n\nPlease commit the current state with an empty commit so I can verify the approval gate.',
      },
    ],
  })
  log('prompt_async status:', promptRes.status)

  // 6. wait for permission or idle
  const waitStart = Date.now()
  while (Date.now() - waitStart < 60000 && !sawPermission) {
    await new Promise((r) => setTimeout(r, 200))
  }
  if (sawPermission) {
    log('permission event:', sawPermission.event, JSON.stringify(sawPermission))
    const attempts = [
      `/session/${session.json.id}/permissions/${sawPermission.id}`,
      `/permission/${sawPermission.id}/reply`,
    ]
    let replied = false
    for (const p of attempts) {
      const reply = await api('POST', p, { response: 'once' })
      log(`reply ${p} -> ${reply.status} ${JSON.stringify(reply.json).slice(0, 120)}`)
      if (reply.status === 200) {
        replied = true
        break
      }
    }
    if (!replied) log('WARNING: no reply endpoint accepted the approval')
  } else {
    log('NO permission event observed (unexpected)')
  }

  // 7. wait idle
  const idleStart = Date.now()
  let idle = false
  while (Date.now() - idleStart < 60000) {
    const st = await api('GET', '/session/status')
    const s = st.json?.[session.json.id]
    if (s && s.type === 'idle') {
      idle = true
      break
    }
    await new Promise((r) => setTimeout(r, 300))
  }
  log('idle:', idle)

  // 8. messages + usage
  const msgs = await api('GET', `/session/${session.json.id}/message`)
  const list = Array.isArray(msgs.json) ? msgs.json : []
  for (const m of list) {
    const i = m.info
    log(
      `message ${i.role} model=${i.modelID ?? '-'} tokens=${i.tokens ? JSON.stringify(i.tokens) : '-'} error=${i.error ? JSON.stringify(i.error) : '-'}`,
    )
    for (const p of m.parts ?? []) {
      if (p.type === 'text') log('   text:', p.text.slice(0, 200))
      if (p.type === 'tool') log('   tool:', p.tool, p.state?.status, (p.state?.output ?? '').slice(0, 120))
    }
  }

  // 9. diff + children
  const diff = await api('GET', `/session/${session.json.id}/diff`)
  log('diff status:', diff.status, JSON.stringify(diff.json).slice(0, 200))

  // 10. git state (did the commit happen?)
  const { execSync } = await import('node:child_process')
  try {
    const head = execSync('git log --oneline -1', { cwd: workdir }).toString().trim()
    log('git head:', head)
  } catch (e) {
    log('git log failed:', e.message.split('\n')[0])
  }

  log('event types seen:', [...new Set(events)].join(', '))

  stop()
  await new Promise((resolve) => {
    child.once('exit', resolve)
    child.kill()
    setTimeout(resolve, 5000)
  })
  mock.close()
  for (let i = 0; i < 5; i++) {
    try {
      fs.rmSync(workdir, { recursive: true, force: true })
      break
    } catch {
      await new Promise((r) => setTimeout(r, 500))
    }
  }
  log('DONE')
  process.exit(0)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})

