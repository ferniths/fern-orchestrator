import { createServer } from 'node:http'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, isAbsolute, join, resolve, sep } from 'node:path'

// Fake `opencode serve` used by pool/worker/engine integration tests.
// Understands the same CLI flags the real binary gets: --port, --hostname.
const args = process.argv.slice(2)
const portArg = args.indexOf('--port')
const port = Number(portArg >= 0 ? args[portArg + 1] : 0) || 0
const host = args.includes('--hostname') ? args[args.indexOf('--hostname') + 1] : '127.0.0.1'

let sessionCounter = 0
let childCounter = 0
const events = []
const sseClients = new Set()
// Sessions created over POST /session, keyed by id: {title, files, children}.
// Titles steer per-session behaviour (transcript shape, subagent children) so
// tests can exercise failure paths without a second fixture.
const sessions = new Map()
// Every prompt body POSTed by the harness, so tests can assert what the model
// was actually told (e.g. that the workspace path is stated explicitly).
const prompts = []
// Tests that assert timeouts/aborts disable completion events via FAKE_OC_IDLE=0.
const idleEnabled = process.env.FAKE_OC_IDLE !== '0'
// `FAKE_OC_UNIQUE_SESSIONS=1` mints process-unique session ids. Two fixture
// processes serving two workspaces for one app would otherwise hand the same
// `ses_<n>` to two different workers and cross-wire their events. Unset keeps
// the original `ses_<n>` / `ses_child_<n>` sequence byte-for-byte.
const uniqueSessions = process.env.FAKE_OC_UNIQUE_SESSIONS === '1'
const pidTag = `${process.pid}_`

function sessionIdFor(n) {
  return uniqueSessions ? `ses_${pidTag}${n}` : `ses_${n}`
}

function childIdFor(n) {
  return uniqueSessions ? `ses_child_${pidTag}${n}` : `ses_child_${n}`
}

// Delay knob: pushes the part broadcast and session.idle out so a test can
// observe several in-flight workers at one poll instant. Unset or 0 keeps the
// original 60ms/120ms timings byte-for-byte.
const idleDelay = Math.max(0, Number(process.env.FAKE_OC_IDLE_DELAY_MS ?? '0') || 0)

function sessionInfo(id) {
  return sessions.get(id)
}

function sessionTitle(id) {
  return sessions.get(id)?.title ?? ''
}

/**
 * Prompt text may carry `FILE:<relpath>` markers; the fake agent really writes
 * those files into its cwd (= the worker workspace) so artifact existence
 * checks in the harness are genuine, not mocked.
 */
function writeMarkedFiles(sid, text) {
  const written = []
  const re = /\bFILE:([^\s,]+)/g
  let m
  while ((m = re.exec(String(text ?? '')))) {
    const rel = m[1]
    if (!rel || isAbsolute(rel) || rel.includes('..')) continue
    const abs = resolve(process.cwd(), rel)
    if (!abs.startsWith(process.cwd() + sep)) continue
    try {
      mkdirSync(dirname(abs), { recursive: true })
      writeFileSync(abs, `artifact ${rel}\nwritten by fake-opencode\n`, 'utf8')
      written.push(rel)
    } catch {
      /* best effort */
    }
  }
  if (written.length && sessions.has(sid)) {
    const s = sessions.get(sid)
    s.files.push(...written)
    // Report these as real write-tool calls in the transcript. Without them the
    // harness cannot tell a worker that actually wrote a file from one that
    // only claimed to — which is exactly the fabrication it has to catch.
    if (!Array.isArray(s.writes)) s.writes = []
    for (const rel of written) s.writes.push({ id: `prt_w_${s.writes.length}_${rel}`, tool: 'write', status: 'completed' })
  }
  return written
}

function broadcast(payload) {
  const line = `data: ${JSON.stringify(payload)}\n\n`
  for (const client of sseClients) {
    try {
      client.write(line)
    } catch {
      sseClients.delete(client)
    }
  }
}

// Real OpenCode 1.18.33 shape: the global stream wraps every event as
// {directory, payload:{id:"evt_…", type, properties:{sessionID, …}}}.
// Keeping this faithful matters — an older `info.sessionID` shape here let the
// suite stay green while production workers never completed.
let evtCounter = 0
function evt(type, properties) {
  return {
    directory: process.cwd(),
    project: 'global',
    payload: { id: `evt_${Date.now().toString(16)}${String(++evtCounter).padStart(4, '0')}`, type, properties },
  }
}

const server = createServer((req, res) => {
  const chunks = []
  req.on('data', (c) => chunks.push(c))
  req.on('end', () => {
    const url = req.url ?? '/'
    const path = url.split('?')[0]
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : {}

    const json = (code, value) => {
      res.writeHead(code, { 'content-type': 'application/json' })
      res.end(value === undefined ? '' : JSON.stringify(value))
    }

    if (path === '/global/health') return json(200, { ok: true })
    if (path === '/config') return json(200, { meta: { version: '1.18.33-fake' } })
    if (path === '/session' && req.method === 'GET') return json(200, [{ id: 'ses_1', title: 'demo', directory: process.cwd() }])
    if (path === '/session' && req.method === 'POST') {
      sessionCounter++
      const id = sessionIdFor(sessionCounter + 1)
      sessions.set(id, { title: body.title ?? '', files: [], children: null })
      return json(200, { id, title: body.title ?? 'untitled', directory: process.cwd() })
    }
    if (/^\/session\/[^/]+\/prompt_async$/.test(path)) {
      const sid = path.split('/')[2]
      for (const p of body.parts ?? []) if (p.type === 'text') prompts.push({ sessionId: sid, text: String(p.text ?? '') })
      writeMarkedFiles(sid, body.parts?.[0]?.text)
      res.writeHead(204)
      res.end()
      if (idleEnabled) {
        setTimeout(() => {
          broadcast(
            evt('message.part.updated', {
              sessionID: sid,
              time: Date.now(),
              part: { id: `prt_${sid}`, type: 'text', text: 'done: implemented the step', sessionID: sid },
            }),
          )
        }, 60 + idleDelay)
        setTimeout(() => broadcast(evt('session.idle', { sessionID: sid })), 120 + idleDelay)
      }
      return
    }
    if (/^\/session\/[^/]+\/message$/.test(path) && req.method === 'POST') {
      const sid = path.split('/')[2]
      for (const p of body.parts ?? []) if (p.type === 'text') prompts.push({ sessionId: sid, text: String(p.text ?? '') })
      json(200, { info: { id: `msg_${Date.now()}`, role: 'assistant', sessionID: sid }, parts: [{ type: 'text', text: 'worker finished' }] })
      if (idleEnabled) setTimeout(() => broadcast(evt('session.idle', { sessionID: sid })), 120 + idleDelay)
      return
    }
    if (path === '/__prompts') return json(200, prompts)
    if (/^\/session\/[^/]+\/abort$/.test(path)) return json(200, true)
    if (/^\/session\/[^/]+\/children$/.test(path)) {
      const sid = path.split('/')[2]
      const info = sessionInfo(sid)
      // Sessions titled with "subagent" report one cached child; everything
      // else (including the static ses_1) has no children.
      if (info && info.title.includes('subagent')) {
        if (!info.children) {
          childCounter++
          info.children = [
            {
              id: childIdFor(childCounter),
              title: 'subagent helper',
              directory: process.cwd(),
              parentID: sid,
              time: { created: Date.now(), updated: Date.now() },
            },
          ]
        }
        return json(200, info.children)
      }
      return json(200, [])
    }
    if (/^\/session\/[^/]+\/message$/.test(path) && req.method === 'GET') {
      const sid = path.split('/')[2]
      const title = sessionTitle(sid)
      // "broken-transcript": the transcript endpoint keeps erroring, so the
      // harness must settle the worker as failed — never a fake success.
      if (title.includes('broken-transcript')) return json(500, { error: 'transcript backend unavailable' })
      // "no-output": the session answers but never produced an assistant message.
      if (title.includes('no-output')) {
        return json(200, [{ info: { id: 'msg_user', role: 'user', sessionID: sid }, parts: [{ type: 'text', text: 'hi' }] }])
      }
      const writes = (sessionInfo(sid)?.writes ?? []).map((w) => ({ id: w.id, type: 'tool', tool: w.tool, status: w.status, sessionID: sid }))
      return json(200, [
        { info: { id: 'msg_1', role: 'user', sessionID: sid }, parts: [{ type: 'text', text: 'hi' }] },
        {
          info: { id: 'msg_2', role: 'assistant', sessionID: sid, tokens: { input: 10, output: 5 }, cost: 0.001 },
          parts: [...writes, { type: 'text', text: 'done: implemented the step' }],
        },
      ])
    }
    if (/^\/session\/[^/]+\/diff$/.test(path)) {
      const sid = path.split('/')[2]
      // a.txt keeps the adapter contract; files written via `FILE:` markers are
      // included only when they really exist in the server's cwd (workspace).
      const out = [{ file: 'a.txt', additions: 2, deletions: 1 }]
      for (const rel of sessions.get(sid)?.files ?? []) {
        const abs = join(process.cwd(), rel)
        if (!existsSync(abs)) continue
        let additions = 1
        try {
          additions = Math.max(1, readFileSync(abs, 'utf8').split('\n').filter(Boolean).length)
        } catch {
          /* keep 1 */
        }
        out.push({ file: rel, additions, deletions: 0 })
      }
      return json(200, out)
    }
    if (path === '/permission' && req.method === 'GET') {
      return json(200, [{ id: 'per_1', type: 'bash', pattern: 'git commit*', title: 'Commit changes' }])
    }
    if (/^\/permission\/[^/]+\/reply$/.test(path)) return json(200, true)
    if (path === '/__sse_drop') {
      // Abruptly destroys every open SSE socket so clients observe a stream
      // error (not a clean end) and must reconnect.
      for (const client of [...sseClients]) {
        sseClients.delete(client)
        try {
          client.destroy()
        } catch {
          /* already gone */
        }
      }
      return json(200, true)
    }
    if (path === '/agent') return json(200, [{ name: 'build', mode: 'primary', description: 'builder' }])
    if (path === '/global/event' || path === '/event') {
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' })
      const payload = [
        evt('session.created', { sessionID: 'ses_1', info: { id: 'ses_1', title: 'demo' } }),
        evt('permission.asked', { id: 'per_1', sessionID: 'ses_1', permission: 'bash', patterns: ['git commit*'] }),
        evt('session.idle', { sessionID: 'ses_1' }),
      ]
      for (const p of payload) res.write(`data: ${JSON.stringify(p)}\n\n`)
      events.push(...payload)
      sseClients.add(res)
      const ping = setInterval(() => res.write(`data: ${JSON.stringify(evt('server.heartbeat', {}))}\n\n`), 500)
      res.on('close', () => {
        clearInterval(ping)
        sseClients.delete(res)
      })
      return
    }
    json(404, { error: 'not found' })
  })
})

server.listen(port, host, () => {
  const addr = server.address()
  console.log(`fake-opencode listening ${typeof addr === 'object' && addr ? addr.port : port}`)
})

process.on('SIGTERM', () => process.exit(0))
process.on('SIGINT', () => process.exit(0))
