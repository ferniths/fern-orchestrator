#!/usr/bin/env node
/**
 * End-to-end smoke for the repaired automation harness.
 *
 * Boots the real core context (fresh temp data dir), registers the real
 * provider, runs a real `opencode serve` lifecycle, then drives a real job
 * through refine → plan → dispatch → integrate → review and verifies the
 * deliverable on disk. Prints a PASS/FAIL table; exit code 1 means at least
 * one required check failed.
 *
 * Node cannot import the TypeScript sources directly from a plain .mjs file
 * (extensionless relative specifiers resolve to nothing), so this script
 * installs a tiny sync module hook (resolve + load) that maps the @core/,
 * @shared/ and @/ aliases, appends .ts/.js for extensionless imports and
 * transpiles TypeScript with esbuild before Node sees it. That is the third
 * path this smoke takes: direct import failed, the vitest fallback was not
 * needed, and the loader hook bridged .mjs → .ts instead.
 *
 * Env:
 *   FERN_E2E_API_KEY        provider API key (falls back to the local 9router store)
 *   SMOKE_NO_KEY_DISCOVERY  set to 1 to skip the local key store lookup
 *   FERN_E2E_PROVIDER_URL   default http://127.0.0.1:20128/v1
 *   FERN_E2E_MODEL          default fernbrain
 *   SMOKE_TIMEOUT_MS        overall budget, default 360000 (600000 with --parallel)
 *   SMOKE_MIN_PARALLEL      workers that must overlap in --parallel, default 3
 *
 * Modes:
 *   (default)     one LLM-written plan → refine → dispatch → review (14 checks)
 *   --parallel    pre-approves a 3-task plan so three workers are dispatched in
 *                 the same tick, then asserts the overlap and that no worker
 *                 clobbered another's deliverable. Same script, own budget.
 */

import { createRequire, registerHooks } from 'node:module'
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { transformSync } from 'esbuild'

const require = createRequire(import.meta.url)

/* -------------------------------------------------------------------------- */
/* .mjs → .ts loader hook                                                     */
/* -------------------------------------------------------------------------- */

const ROOT_URL = pathToFileURL(fileURLToPath(new URL('../src/', import.meta.url))).href
const ALIASES = [
  ['@shared/', 'shared/'],
  ['@core/', 'core/'],
  ['@/', 'renderer/src/'],
]

function resolveCandidate(absPath) {
  const candidates = [
    absPath,
    `${absPath}.ts`,
    `${absPath}.tsx`,
    join(absPath, 'index.ts'),
    `${absPath}.js`,
    join(absPath, 'index.js'),
  ]
  for (const candidate of candidates) {
    try {
      if (statSync(candidate).isFile()) return candidate
    } catch {
      // Missing candidate: keep trying.
    }
  }
  return null
}

registerHooks({
  resolve(specifier, context, nextResolve) {
    let rewritten = null
    for (const [prefix, target] of ALIASES) {
      if (specifier.startsWith(prefix)) {
        rewritten = ROOT_URL + target + specifier.slice(prefix.length)
        break
      }
    }
    const isRelative = specifier.startsWith('./') || specifier.startsWith('../')
    if (!rewritten && !isRelative) return nextResolve(specifier, context)

    let url
    try {
      url = rewritten ?? new URL(specifier, context.parentURL).href
    } catch {
      return nextResolve(specifier, context)
    }
    const hit = resolveCandidate(fileURLToPath(url))
    if (!hit) {
      const err = new Error(`Cannot find module '${specifier}' from '${context.parentURL ?? '<entry>'}'`)
      err.code = 'ERR_MODULE_NOT_FOUND'
      throw err
    }
    const hitUrl = pathToFileURL(hit).href
    if (hit.endsWith('.ts') || hit.endsWith('.tsx')) return { url: hitUrl, format: 'module', shortCircuit: true }
    return { url: hitUrl, shortCircuit: true }
  },
  load(url, context, nextLoad) {
    if (url.endsWith('.ts') || url.endsWith('.tsx')) {
      const source = readFileSync(fileURLToPath(url), 'utf8')
      const out = transformSync(source, {
        loader: url.endsWith('.tsx') ? 'tsx' : 'ts',
        format: 'esm',
        target: 'node20',
        sourcefile: url,
      })
      return { format: 'module', source: out.code, shortCircuit: true }
    }
    return nextLoad(url, context)
  },
})

const { createCoreContext } = await import('../src/core/kernel/appContext.ts')
const { Keystore } = await import('../src/core/security/keystore.ts')
const { BUILTIN_PROFILES } = await import('../src/core/config/builtins.ts')
const { isTaskTerminal } = await import('../src/core/orchestration/scheduler.ts')

/* -------------------------------------------------------------------------- */
/* Config                                                                     */
/* -------------------------------------------------------------------------- */

const PROVIDER_URL = (process.env.FERN_E2E_PROVIDER_URL ?? 'http://127.0.0.1:20128/v1').replace(/\/+$/, '')
const MODEL = process.env.FERN_E2E_MODEL ?? 'fernbrain'
const PARALLEL = process.argv.includes('--parallel') || process.env.SMOKE_PARALLEL === '1'
const MIN_PARALLEL = Number(process.env.SMOKE_MIN_PARALLEL ?? '3')
const SMOKE_TIMEOUT_MS =
  Number(process.env.SMOKE_TIMEOUT_MS ?? (PARALLEL ? '600000' : '360000')) || (PARALLEL ? 600000 : 360000)
const PROBE_TIMEOUT_MS = 15_000
const IDLE_WORKER = ['queued', 'starting', 'running', 'waiting_approval']

const DATA_DIR = join(tmpdir(), 'harness-smoke-data')
const WORKSPACE = join(tmpdir(), 'harness-smoke-workspace')
const MARKER_FILE = 'harness-smoke-test.txt'
const MARKER_CONTENT = 'HARNESS_SMOKE_TEST_OK'

const SMOKE_PROMPT = [
  'Run this small end-to-end task.',
  `In the workspace directory create a file named ${MARKER_FILE} whose entire content is exactly ${MARKER_CONTENT} (no quotes, no extra text; a trailing newline is fine).`,
  'Also create summary.md in the workspace directory with one short line describing what you did.',
  'Reply with DONE when both files exist.',
].join(' ')

/** One file per task: three workers writing at once is the sibling-clobber test. */
const PARALLEL_FILES = [
  ['parallel-a.txt', 'PARALLEL_A_OK'],
  ['parallel-b.txt', 'PARALLEL_B_OK'],
  ['parallel-c.txt', 'PARALLEL_C_OK'],
]

const deadline = Date.now() + SMOKE_TIMEOUT_MS

/* -------------------------------------------------------------------------- */
/* Table                                                                      */
/* -------------------------------------------------------------------------- */

const rows = []
let failures = 0
/** Highest number of concurrently live workers seen during the job loop. */
let maxLiveWorkers = 0

function record(status, name, detail = '') {
  rows.push({ status, name, detail })
  if (status === 'FAIL') failures++
  console.log(`${status.padEnd(5)} ${name}${detail ? ` — ${detail}` : ''}`)
}

const short = (value, max = 200) => String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, max)
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const remaining = () => Math.max(0, deadline - Date.now())

/** Blocking sleep for the sync reset helper below. */
function syncSleep(ms) {
  const ia = new Int32Array(new SharedArrayBuffer(4))
  Atomics.wait(ia, 0, 0, ms)
}

/**
 * Reset a directory, tolerating Windows EPERM: a previous `opencode serve`
 * that still has the dir as its cwd keeps a handle on it. Retry, and between
 * attempts clear whatever entries are removable so a single locked subdir
 * never aborts the whole smoke run.
 */
function resetDir(dir) {
  let lastErr = null
  for (let attempt = 1; attempt <= 6; attempt++) {
    try {
      rmSync(dir, { recursive: true, force: true })
      mkdirSync(dir, { recursive: true })
      return
    } catch (err) {
      lastErr = err
      try {
        for (const entry of readdirSync(dir)) {
          try {
            rmSync(join(dir, entry), { recursive: true, force: true })
          } catch {
            /* locked entry — next attempt may catch it unlocked */
          }
        }
      } catch {
        /* dir already gone or unreadable */
      }
      syncSleep(500 * attempt)
    }
  }
  mkdirSync(dir, { recursive: true })
  if (lastErr) record('WARN', `reset ${dir}`, short(lastErr.message))
}

function printResult() {
  console.log('-'.repeat(72))
  const count = (status) => rows.filter((r) => r.status === status).length
  const result = failures === 0 ? 'PASS' : 'FAIL'
  console.log(
    `RESULT: ${result} (${count('PASS')} passed, ${count('SKIP')} skipped, ${count('WARN')} warnings, ${count('FAIL')} failed, ${rows.length} checks)`,
  )
}

function alive(pid) {
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    return Boolean(err && err.code === 'EPERM')
  }
}

async function waitForPidsDead(pids, timeoutMs) {
  const until = Date.now() + timeoutMs
  let left = pids.filter(alive)
  while (left.length > 0 && Date.now() < until) {
    await sleep(200)
    left = left.filter(alive)
  }
  return left
}

/* -------------------------------------------------------------------------- */
/* Provider probe + key discovery                                             */
/* -------------------------------------------------------------------------- */

function discoverApiKey() {
  const fromEnv = process.env.FERN_E2E_API_KEY || process.env.SMOKE_API_KEY
  if (fromEnv) return { key: fromEnv, source: 'env FERN_E2E_API_KEY' }
  if (process.env.SMOKE_NO_KEY_DISCOVERY === '1') return { key: null, source: 'discovery disabled' }
  try {
    const appData = process.env.APPDATA
    if (!appData) return { key: null, source: 'none' }
    const dbPath = join(appData, '9router', 'db', 'data.sqlite')
    if (!existsSync(dbPath)) return { key: null, source: 'none' }
    const Database = require('better-sqlite3')
    const db = new Database(dbPath, { readonly: true, fileMustExist: true })
    try {
      const row = db.prepare('SELECT key FROM apiKeys WHERE isActive = 1 ORDER BY createdAt DESC LIMIT 1').get()
      if (row && row.key) return { key: row.key, source: 'local 9router store' }
    } finally {
      db.close()
    }
  } catch {
    // Best effort: a locked/absent store only means "no key", not an error.
  }
  return { key: null, source: 'none' }
}

async function probeProvider(apiKey) {
  if (!apiKey) return { ok: false, skip: 'no API key (set FERN_E2E_API_KEY)' }
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), Math.min(PROBE_TIMEOUT_MS, Math.max(1_000, remaining())))
  try {
    const res = await fetch(`${PROVIDER_URL}/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({
        model: MODEL,
        messages: [{ role: 'user', content: 'Reply with the single word: ok' }],
        max_tokens: 8,
      }),
      signal: controller.signal,
    })
    const text = await res.text()
    if (res.ok) return { ok: true, detail: `POST /chat/completions → HTTP ${res.status}` }
    return { ok: false, skip: `HTTP ${res.status}: ${short(text, 120)}` }
  } catch (err) {
    return { ok: false, skip: `unreachable: ${short(err && err.message ? err.message : err, 120)}` }
  } finally {
    clearTimeout(timer)
  }
}

/* -------------------------------------------------------------------------- */
/* Main                                                                       */
/* -------------------------------------------------------------------------- */

console.log(`harness smoke — node ${process.version} on ${process.platform}`)
console.log(`provider ${PROVIDER_URL} model=${MODEL} budget=${SMOKE_TIMEOUT_MS}ms`)
console.log('-'.repeat(72))

let ctx = null
let jobId = null

try {
  /* ---- phase 0: provider probe (before the context, so a dead provider ---- */
  /*                 still gets honest SKIP rows below).                     */
  const { key: apiKey, source: keySource } = discoverApiKey()
  const probe = await probeProvider(apiKey)

  /* ---- phase 1: core context ---- */
  resetDir(DATA_DIR)
  try {
    ctx = await createCoreContext({ dataDir: DATA_DIR, consoleLogs: false })
    record('PASS', 'core context boots', `schema ready at ${DATA_DIR}`)
  } catch (err) {
    record('FAIL', 'core context boots', short(err && err.message ? err.message : err))
    throw err
  }

  /* ---- phase 2: opencode detection ---- */
  try {
    const detection = await ctx.opencode.detect()
    record(
      detection.detected ? 'PASS' : 'FAIL',
      'opencode binary detected',
      detection.path ? `${detection.path}${detection.version ? ` v${detection.version}` : ''}` : 'not found on PATH',
    )
  } catch (err) {
    record('FAIL', 'opencode binary detected', short(err && err.message ? err.message : err))
  }

  /* ---- phase 3: provider registration ---- */
  let provider = null
  try {
    provider = ctx.repos.providers.createProvider({
      name: '9Router',
      type: 'openai_compatible',
      baseUrl: PROVIDER_URL,
      defaultModel: MODEL,
      apiKeyRef: null,
    })
    if (apiKey) {
      const ref = Keystore.refFor('provider', provider.id)
      ctx.keystore.set(ref, apiKey)
      ctx.repos.providers.updateProvider(provider.id, { apiKeyRef: ref })
    }
    record(
      'PASS',
      'provider registered',
      `9Router → ${PROVIDER_URL} model=${MODEL} key=${apiKey ? `stored (${keySource})` : 'none'}`,
    )
  } catch (err) {
    record('FAIL', 'provider registered', short(err && err.message ? err.message : err))
  }
  record(probe.ok ? 'PASS' : 'SKIP', 'provider reachable', probe.ok ? probe.detail : probe.skip)

  // The Electron shell seeds these on boot; the headless context does not.
  ctx.repos.providers.resetBuiltinProfiles(BUILTIN_PROFILES)

  /* ---- phase 4: workspace ---- */
  resetDir(WORKSPACE)
  writeFileSync(join(WORKSPACE, 'README.md'), '# harness smoke sandbox\n', 'utf8')

  /* ---- phase 5: real opencode server start/stop ---- */
  try {
    const server = await ctx.opencode.startServer({ directory: WORKSPACE })
    const stopped = await ctx.opencode.stopServer(server.id)
    const ok = server.status === 'ready' && stopped && server.pid
    record(
      ok ? 'PASS' : 'FAIL',
      'opencode server start/stop lifecycle',
      `started pid=${server.pid ?? 'null'} status=${server.status}, stop=${stopped ? 'ok' : 'FAILED'}`,
    )
  } catch (err) {
    record('FAIL', 'opencode server start/stop lifecycle', short(err && err.message ? err.message : err))
  }

  /* ---- phase 6: the job ---- */
  const job = PARALLEL ? createParallelJob(WORKSPACE) : createSingleJob(WORKSPACE)
  jobId = job.id
  const startedAt = Date.now()
  ctx.engine.start(jobId)

  let current = null
  let timedOut = false
  let heartbeat = 0
  for (;;) {
    current = ctx.repos.jobs.get(jobId)
    if (current && ['completed', 'failed', 'cancelled'].includes(current.status)) break
    if (remaining() < 15_000) {
      timedOut = true
      break
    }
    const liveWorkers = ctx.repos.workers.listWorkers(jobId).filter((w) => IDLE_WORKER.includes(w.status)).length
    maxLiveWorkers = Math.max(maxLiveWorkers, liveWorkers)
    if (Date.now() - heartbeat >= 10_000) {
      heartbeat = Date.now()
      console.log(`… running (${Math.round((Date.now() - startedAt) / 1000)}s status=${current?.status ?? '?'} liveWorkers=${liveWorkers})`)
    }
    await sleep(400)
  }

  if (PARALLEL) {
    record(
      maxLiveWorkers >= MIN_PARALLEL ? 'PASS' : 'FAIL',
      'workers ran concurrently',
      `peak ${maxLiveWorkers} live worker(s) in flight (required ${MIN_PARALLEL})`,
    )
  }

  if (timedOut) {
    record(
      'FAIL',
      'job reached a terminal state',
      `timed out after ${Math.round((Date.now() - startedAt) / 1000)}s (status=${current?.status ?? '?'} reason=${short(current?.statusReason, 80)})`,
    )
  } else {
    const elapsed = Math.round((Date.now() - startedAt) / 1000)
    record('PASS', 'job reached a terminal state', `status=${current.status} in ${elapsed}s`)

    if (current.status === 'completed') {
      record('PASS', 'job completed', `loop ${current.currentLoop}/${current.loopCount}`)
      if (PARALLEL) await verifyParallelJob(current)
      else await verifyJob(current)
    } else if (!probe.ok) {
      record(
        'PASS',
        'job fails honestly when provider unreachable',
        `status=${current.status} error=${short(current.error ?? current.statusReason, 160)}`,
      )
    } else {
      record(
        'FAIL',
        'job completed',
        `status=${current.status} error=${short(current.error ?? current.statusReason, 200)}`,
      )
    }
  }
} catch (err) {
  record('FAIL', 'unexpected error', short(err && err.stack ? err.stack : err, 300))
} finally {
  /* ---- phase 7: shutdown + leftover process check ---- */
  if (ctx) {
    try {
      if (jobId && ctx.engine.isRunning(jobId)) ctx.engine.cancel(jobId)
    } catch {
      // Cancellation is best effort; shutdown below stops everything anyway.
    }
    const pids = ctx.opencode
      .listServers()
      .map((s) => s.pid)
      .filter((pid) => Number.isInteger(pid) && pid > 0)
    try {
      await ctx.shutdown()
    } catch (err) {
      record('FAIL', 'context shutdown', short(err && err.message ? err.message : err))
    }
    const leftover = await waitForPidsDead(pids, 8_000)
    record(
      leftover.length === 0 ? 'PASS' : 'FAIL',
      'no leftover opencode serve processes',
      pids.length > 0
        ? `checked ${pids.length} pid(s); ${leftover.length === 0 ? 'all stopped' : `still alive: ${leftover.join(', ')}`}`
        : 'no server was ever started',
    )
  } else {
    record('SKIP', 'no leftover opencode serve processes', 'context did not boot')
  }
}

/* -------------------------------------------------------------------------- */
/* Job construction                                                           */
/* -------------------------------------------------------------------------- */

function createSingleJob(workspace) {
  return ctx.repos.jobs.create({
    title: 'harness smoke job',
    originalPrompt: SMOKE_PROMPT,
    projectId: null,
    vaultId: null,
    loopCount: 1,
    routeId: null,
    requirePlanApproval: false,
    templateId: null,
    status: 'draft',
    workspacePath: workspace,
  })
}

/**
 * Three independent tasks with a pre-approved plan, so the planner never gets
 * a chance to collapse them into one — `engine.run` only plans when
 * `planApprovedAt` is unset, which is exactly how `jobs.plan.set` behaves.
 */
function createParallelJob(workspace) {
  const job = ctx.repos.jobs.create({
    title: 'harness smoke parallel job',
    originalPrompt: 'Run three independent steps that each create their own file.',
    projectId: null,
    vaultId: null,
    loopCount: 1,
    routeId: null,
    requirePlanApproval: false,
    templateId: null,
    status: 'draft',
    workspacePath: workspace,
  })
  for (const [file, content] of PARALLEL_FILES) {
    ctx.repos.jobs.createTask({
      jobId: job.id,
      loopIndex: 1,
      title: `Create ${file}`,
      role: 'coder',
      objective: `Create ${file} with its exact content`,
      prompt: [
        `Create a file named ${file} in the workspace directory whose entire content is exactly ${content} (no quotes, no extra text).`,
        'Create no other file and touch no other file.',
        `Reply with DONE when ${file} exists.`,
      ].join(' '),
      expectedArtifacts: [file],
    })
  }
  ctx.repos.jobs.update(job.id, { planApprovedAt: Date.now() })
  return ctx.repos.jobs.get(job.id)
}

/* -------------------------------------------------------------------------- */
/* Job verification (only reached for a completed job)                        */
/* -------------------------------------------------------------------------- */

async function verifyParallelJob(job) {
  const workspace = job.workspacePath || WORKSPACE

  const tasks = ctx.repos.jobs.listTasks(job.id, job.currentLoop || 1)
  const unsettled = tasks.filter((t) => !isTaskTerminal(t))
  record(
    unsettled.length === 0 ? 'PASS' : 'FAIL',
    'all tasks terminal',
    `${tasks.length} task(s): ${tasks.map((t) => `${short(t.title, 30)}=${t.status}`).join(', ')}`,
  )

  const wrong = []
  for (const [file, content] of PARALLEL_FILES) {
    const path = join(workspace, file)
    if (!existsSync(path)) wrong.push(`${file}: missing`)
    else {
      const got = readFileSync(path, 'utf8').trim()
      if (got !== content) wrong.push(`${file}: got "${short(got, 40)}"`)
    }
  }
  record(
    wrong.length === 0 ? 'PASS' : 'FAIL',
    'parallel deliverables intact',
    wrong.length === 0
      ? `${PARALLEL_FILES.length}/${PARALLEL_FILES.length} files exact — no worker clobbered another`
      : wrong.join('; '),
  )

  const workers = ctx.repos.workers.listWorkers(job.id)
  await verifyTranscript(workers.filter((w) => w.status === 'succeeded'))

  const live = workers.filter((w) => IDLE_WORKER.includes(w.status))
  record(
    live.length === 0 ? 'PASS' : 'FAIL',
    'no live workers left',
    `${workers.length} worker(s), ${live.length} still live`,
  )
}

async function verifyJob(job) {
  const workspace = job.workspacePath || WORKSPACE

  const tasks = ctx.repos.jobs.listTasks(job.id, job.currentLoop || 1)
  const unsettled = tasks.filter((t) => !isTaskTerminal(t))
  record(
    unsettled.length === 0 ? 'PASS' : 'FAIL',
    'all tasks terminal',
    tasks.length === 0
      ? 'no tasks were created'
      : `${tasks.length} task(s): ${tasks.map((t) => `${short(t.title, 30)}=${t.status}`).join(', ')}${unsettled.length ? `, ${unsettled.length} unsettled` : ''}`,
  )

  const workers = ctx.repos.workers.listWorkers(job.id)
  const succeeded = workers.filter((w) => w.status === 'succeeded')
  await verifyTranscript(succeeded)

  const artifactRows = ctx.repos.workers.listArtifacts(job.id).filter((a) => a.path)
  const onDisk = artifactRows.filter((a) => existsSync(join(workspace, a.path)))
  record(
    onDisk.length > 0 ? 'PASS' : 'FAIL',
    'artifact file exists on disk',
    artifactRows.length === 0
      ? 'no artifact rows with a file path'
      : `${onDisk.length}/${artifactRows.length} artifact file(s) found (e.g. ${onDisk[0]?.path ?? 'none'})`,
  )

  const markerPath = join(workspace, MARKER_FILE)
  if (!existsSync(markerPath)) {
    record('FAIL', `${MARKER_FILE} content matches`, `not found at ${markerPath}`)
  } else {
    const content = readFileSync(markerPath, 'utf8').trim()
    record(
      content === MARKER_CONTENT ? 'PASS' : 'FAIL',
      `${MARKER_FILE} content matches`,
      content === MARKER_CONTENT ? `"${MARKER_CONTENT}"` : `got "${short(content, 80)}"`,
    )
  }

  const summaryPath = join(workspace, 'summary.md')
  record(existsSync(summaryPath) ? 'PASS' : 'WARN', 'summary.md present', existsSync(summaryPath) ? summaryPath : 'not written by this run (non-blocking)')

  const live = workers.filter((w) => IDLE_WORKER.includes(w.status))
  record(
    live.length === 0 ? 'PASS' : 'FAIL',
    'no live workers left',
    workers.length === 0 ? 'no workers ran' : `${workers.length} worker(s), ${live.length} still live`,
  )
}

async function verifyTranscript(succeeded) {
  if (succeeded.length === 0) {
    record('FAIL', 'worker transcript has assistant output', 'no worker succeeded')
    return
  }
  let lastDetail = ''
  for (const worker of succeeded.slice(0, 3)) {
    try {
      const entries = await ctx.opencode.transcriptFor(worker.id)
      const hasAssistant = entries.some((entry) => entry.role === 'assistant')
      lastDetail = `${short(worker.name, 40)}: ${entries.length} entries${hasAssistant ? '' : ', no assistant entry'}`
      if (hasAssistant) {
        record('PASS', 'worker transcript has assistant output', lastDetail)
        return
      }
    } catch (err) {
      lastDetail = `${short(worker.name, 40)}: transcript error ${short(err && err.message ? err.message : err, 80)}`
    }
  }
  record('FAIL', 'worker transcript has assistant output', lastDetail || 'no transcript checked')
}

/* -------------------------------------------------------------------------- */

printResult()
process.exit(failures > 0 ? 1 : 0)
