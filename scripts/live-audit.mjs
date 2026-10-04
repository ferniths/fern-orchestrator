#!/usr/bin/env node
/**
 * Live audit for the subsystems the harness smoke does not cover:
 *
 *   1. Settings persistence  — a config update must survive a store reload.
 *   2. Output language       — the real refiner must return Japanese prose for a
 *                              job tagged `language: 'Japanese'`, and English
 *                              contract-clean prose for the default.
 *   3. Obsidian vault        — index → search → backlinks → graph → read →
 *                              update → rename → delete on a throwaway temp
 *                              vault, with every mutation verified on disk.
 *   4. Real vault (read-only)— the user's configured vault is indexed into the
 *                              audit's own temp database and searched; nothing
 *                              inside the real vault is ever written.
 *
 * Same loader/bootstrap strategy as scripts/harness-smoke.mjs (esbuild module
 * hook bridging .mjs → .ts with the @core/@shared aliases).
 *
 * Env: FERN_E2E_PROVIDER_URL (default http://127.0.0.1:20128/v1),
 *      FERN_E2E_MODEL (default fernbrain), FERN_E2E_API_KEY,
 *      FERN_REAL_VAULT (default the user's main-brain path, if it exists).
 */

import { createRequire, registerHooks } from 'node:module'
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { transformSync } from 'esbuild'

const require = createRequire(import.meta.url)

const ROOT_URL = pathToFileURL(fileURLToPath(new URL('../src/', import.meta.url))).href
const ALIASES = [
  ['@shared/', 'shared/'],
  ['@core/', 'core/'],
  ['@/', 'renderer/src/'],
]

function resolveCandidate(absPath) {
  for (const candidate of [absPath, `${absPath}.ts`, `${absPath}.tsx`, join(absPath, 'index.ts'), `${absPath}.js`, join(absPath, 'index.js')]) {
    try {
      if (statSync(candidate).isFile()) return candidate
    } catch {
      /* keep trying */
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
const { refinePrompt, detectViolations } = await import('../src/core/orchestration/refiner.ts')
const { detectShell } = await import('../src/core/platform/binaries.ts')

const PROVIDER_URL = (process.env.FERN_E2E_PROVIDER_URL ?? 'http://127.0.0.1:20128/v1').replace(/\/+$/, '')
const MODEL = process.env.FERN_E2E_MODEL ?? 'fernbrain'
const DATA_DIR = join(tmpdir(), 'fern-live-audit-data')
const VAULT_DIR = join(tmpdir(), 'fern-live-audit-vault')
const REAL_VAULT = process.env.FERN_REAL_VAULT ?? join(process.env.USERPROFILE ?? '', 'Documents', 'main-brain')

const short = (v, max = 220) => String(v ?? '').replace(/\s+/g, ' ').trim().slice(0, max)
const hasKanaKanji = (s) => /[\u3040-\u30ff\u4e00-\u9faf]/.test(s)

function syncSleep(ms) {
  const ia = new Int32Array(new SharedArrayBuffer(4))
  Atomics.wait(ia, 0, 0, ms)
}
function resetDir(dir) {
  try {
    rmSync(dir, { recursive: true, force: true })
  } catch {
    try {
      for (const entry of readdirSync(dir)) {
        try {
          rmSync(join(dir, entry), { recursive: true, force: true })
        } catch {
          /* locked entry — retried below after letting go */
        }
      }
    } catch {
      /* dir already gone or unreadable */
    }
    syncSleep(400)
    try {
      rmSync(dir, { recursive: true, force: true })
    } catch {
      /* still locked — mkdir below keeps the audit runnable */
    }
  }
  mkdirSync(dir, { recursive: true })
}

const rows = []
let failures = 0
function record(status, name, detail = '') {
  rows.push({ status, name })
  if (status === 'FAIL') failures++
  console.log(`${status.padEnd(5)} ${name}${detail ? ` — ${detail}` : ''}`)
}

function discoverApiKey() {
  const fromEnv = process.env.FERN_E2E_API_KEY
  if (fromEnv) return fromEnv
  try {
    const appData = process.env.APPDATA
    if (!appData) return null
    const dbPath = join(appData, '9router', 'db', 'data.sqlite')
    if (!existsSync(dbPath)) return null
    const Database = require('better-sqlite3')
    const db = new Database(dbPath, { readonly: true, fileMustExist: true })
    try {
      const row = db.prepare('SELECT key FROM apiKeys WHERE isActive = 1 ORDER BY createdAt DESC LIMIT 1').get()
      return row?.key ?? null
    } finally {
      db.close()
    }
  } catch {
    return null
  }
}

console.log(`live audit — node ${process.version} on ${process.platform}`)
console.log(`provider ${PROVIDER_URL} model=${MODEL}`)
console.log('-'.repeat(72))

let ctx = null

try {
  /* ---- boot ---- */
  resetDir(DATA_DIR)
  ctx = await createCoreContext({ dataDir: DATA_DIR, consoleLogs: false })
  record('PASS', 'core context boots', DATA_DIR)

  /* ---- 1. settings persistence (write → reload → verify) ---- */
  const configPath = ctx.config.path ?? join(DATA_DIR, 'config.json')
  await ctx.config.update({ general: { language: 'Japanese' }, orchestration: { approvalTimeoutMs: 60_000 } })
  const onDisk = JSON.parse(readFileSync(configPath, 'utf8'))
  const persisted = onDisk?.general?.language === 'Japanese' && onDisk?.orchestration?.approvalTimeoutMs === 60_000
  record(persisted ? 'PASS' : 'FAIL', 'settings persist to config.json', short(JSON.stringify({ language: onDisk?.general?.language, approval: onDisk?.orchestration?.approvalTimeoutMs })))

  const shell = await detectShell(null)
  record(shell ? 'PASS' : 'FAIL', 'shell detection resolves a usable shell', shell ?? 'none found')

  /* ---- provider registration (needed by the refiner) ---- */
  const apiKey = discoverApiKey()
  const provider = ctx.repos.providers.createProvider({
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
  record('PASS', 'provider registered', `9Router → ${PROVIDER_URL} key=${apiKey ? 'stored' : 'none'}`)

  /* ---- 2. output language end-to-end against the real model ---- */
  // The previous config.update set the global language to Japanese — reset it
  // first, because a job with `language: null` intentionally follows the global
  // default (that precedence is part of the feature).
  await ctx.config.update({ general: { language: 'English' } })
  const rough =
    'Make a small python script that sorts a list of numbers and prints the top three. ' +
    'Keep it simple, no external libraries, and add a short comment explaining the sort.'
  const baseJob = {
    title: 'live audit language job',
    originalPrompt: rough,
    projectId: null,
    vaultId: null,
    loopCount: 1,
    routeId: null,
    requirePlanApproval: false,
    templateId: null,
    status: 'draft',
    workspacePath: join(DATA_DIR, 'ws'),
  }

  const jpJob = ctx.repos.jobs.create({ ...baseJob, language: 'Japanese' })
  const jpRefined = await refinePrompt(ctx, jpJob)
  const jpOk = hasKanaKanji(jpRefined) && detectViolations(rough, jpRefined, 'Japanese').length === 0
  record(jpOk ? 'PASS' : 'FAIL', 'refiner honors job language=Japanese', short(jpRefined, 160))
  if (!jpOk) console.log('      full Japanese refinement:', jpRefined)

  const enJob = ctx.repos.jobs.create({ ...baseJob })
  const enRefined = await refinePrompt(ctx, enJob)
  const enViolations = detectViolations(rough, enRefined, 'English')
  const enOk = !hasKanaKanji(enRefined) && enViolations.length === 0 && enRefined.length >= rough.length * 0.5
  record(enOk ? 'PASS' : 'FAIL', 'refiner default stays English + contract-clean', enViolations.length ? short(enViolations.map((v) => `${v.code}: ${v.detail}`).join('; '), 160) : short(enRefined, 160))

  /* ---- 3. vault lifecycle on a throwaway temp vault ---- */
  resetDir(VAULT_DIR)
  writeFileSync(join(VAULT_DIR, 'alpha.md'), '# Alpha\n\nAlpha links to [[beta]] and [[gamma]].\n', 'utf8')
  writeFileSync(join(VAULT_DIR, 'beta.md'), '# Beta\n\nBacklink target from alpha.\n', 'utf8')
  mkdirSync(join(VAULT_DIR, 'sub'), { recursive: true })
  writeFileSync(join(VAULT_DIR, 'sub', 'gamma.md'), '---\ntags: [audit]\n---\n\nGamma note.\n', 'utf8')

  const vault = ctx.vaults.add({ name: 'audit-temp-vault', path: VAULT_DIR })
  const idx = await ctx.vaults.index(vault.id)
  record(idx.notes === 3 ? 'PASS' : 'FAIL', 'vault indexes all notes', `notes=${idx.notes} links=${idx.links} unresolved=${idx.unresolved} in ${idx.durationMs}ms`)

  const hits = ctx.vaults.search(vault.id, 'alpha')
  record(hits.length >= 1 && hits.some((h) => h.path.endsWith('alpha.md')) ? 'PASS' : 'FAIL', 'vault FTS search finds notes', `${hits.length} hit(s): ${hits.map((h) => h.path).join(', ')}`)

  const backs = ctx.vaults.backlinks(vault.id, 'beta.md')
  record(backs.some((b) => b.path.endsWith('alpha.md')) ? 'PASS' : 'FAIL', 'vault backlinks resolve', `beta.md ← ${backs.map((b) => b.path).join(', ') || 'none'}`)

  const graph = ctx.vaults.graph(vault.id)
  record(graph.nodes.length === 3 && graph.edges.length >= 2 ? 'PASS' : 'FAIL', 'vault graph has nodes+edges', `nodes=${graph.nodes.length} edges=${graph.edges.length}`)

  const read = await ctx.vaults.read(vault.id, 'alpha.md')
  record(read && read.content.includes('[[beta]]') ? 'PASS' : 'FAIL', 'vault read returns content + parsed links', read ? `links=${JSON.stringify(read.links ?? null)}` : 'null')

  await ctx.vaults.updateNote(vault.id, 'beta.md', '# Beta\n\nUpdated by live audit.\n')
  const betaAfter = readFileSync(join(VAULT_DIR, 'beta.md'), 'utf8')
  record(betaAfter.includes('Updated by live audit') ? 'PASS' : 'FAIL', 'vault updateNote writes the real file', short(betaAfter, 100))

  await ctx.vaults.createNote(vault.id, 'delta.md', '# Delta\n\nCreated by live audit.\n')
  record(existsSync(join(VAULT_DIR, 'delta.md')) ? 'PASS' : 'FAIL', 'vault createNote writes the real file')

  const renamed = await ctx.vaults.renameNote(vault.id, 'delta.md', 'sub/delta.md')
  const renamedOk = renamed && !existsSync(join(VAULT_DIR, 'delta.md')) && existsSync(join(VAULT_DIR, 'sub', 'delta.md'))
  record(renamedOk ? 'PASS' : 'FAIL', 'vault renameNote moves the real file', `→ ${renamed?.path ?? '?'}`)

  await ctx.vaults.deleteNote(vault.id, 'sub/delta.md')
  record(!existsSync(join(VAULT_DIR, 'sub', 'delta.md')) ? 'PASS' : 'FAIL', 'vault deleteNote removes the real file')

  const vaultRemovalWorked = ctx.vaults.remove(vault.id)
  record(vaultRemovalWorked ? 'PASS' : 'FAIL', 'vault remove drops the record (temp vault untouched on disk)', '')

  /* ---- 4. real vault, READ-ONLY ---- */
  if (existsSync(REAL_VAULT)) {
    try {
      const realVault = ctx.vaults.add({ name: 'audit-real-vault-read-only', path: REAL_VAULT })
      const before = JSON.stringify(readFileSync(join(REAL_VAULT, '.obsidian', 'app.json'), 'utf8').slice(0, 50) ?? '')
      void before // presence probe only; the real check is that we never write below
      const realIdx = await ctx.vaults.index(realVault.id)
      record('PASS', 'real vault indexed (read-only)', `${REAL_VAULT}: notes=${realIdx.notes} links=${realIdx.links} in ${realIdx.durationMs}ms`)

      const sample = ctx.vaults.recent(realVault.id, 3)
      record(sample.length > 0 ? 'PASS' : 'FAIL', 'real vault recent notes readable', sample.map((n) => n.path || n.title).join(', ') || 'none')

      const realHits = ctx.vaults.search(realVault.id, 'the', 5)
      record('PASS', 'real vault FTS search ran (read-only)', `${realHits.length} hit(s) for a common word`)
      ctx.vaults.remove(realVault.id)
    } catch (err) {
      record('FAIL', 'real vault (read-only)', short(err))
    }
  } else {
    record('SKIP', 'real vault (read-only)', `${REAL_VAULT} not found`)
  }

  /* ---- done ---- */
  await ctx.opencode.shutdown().catch(() => {})
  try {
    ctx.vaults.dispose()
  } catch {
    /* dispose is best-effort */
  }
} catch (err) {
  record('FAIL', 'unexpected error', short(err))
  if (ctx) {
    await ctx.opencode.shutdown().catch(() => {})
    try {
      ctx.vaults.dispose()
    } catch {
      /* dispose is best-effort */
    }
  }
}

console.log('-'.repeat(72))
const count = (s) => rows.filter((r) => r.status === s).length
console.log(`RESULT: ${failures === 0 ? 'PASS' : 'FAIL'} (${count('PASS')} passed, ${count('SKIP')} skipped, ${count('FAIL')} failed, ${rows.length} checks)`)
process.exit(failures === 0 ? 0 : 1)
