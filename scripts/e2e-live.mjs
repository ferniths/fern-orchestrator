import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const providerUrl = process.env.FERN_E2E_PROVIDER_URL ?? 'http://127.0.0.1:20128/v1'
const apiKey = process.env.FERN_E2E_API_KEY
const model = process.env.FERN_E2E_MODEL

if (!apiKey || !model) {
  console.log('')
  console.log('SKIPPED - live provider E2E (spec section 68) did not run.')
  console.log('Both FERN_E2E_API_KEY and FERN_E2E_MODEL are required; FERN_E2E_PROVIDER_URL')
  console.log(`defaults to ${providerUrl}.`)
  console.log('')
  console.log('PowerShell example:')
  console.log('  $env:FERN_E2E_API_KEY="sk-..."; $env:FERN_E2E_MODEL="some-model"; npm run e2e:live')
  console.log('')
  process.exit(0)
}

process.env.FERN_E2E = '1'
process.env.FERN_E2E_PROVIDER_URL = providerUrl

const vitestBin = join(root, 'node_modules', 'vitest', 'vitest.mjs')
if (!existsSync(vitestBin)) {
  console.error(`vitest not found at ${vitestBin} - run "npm install" first.`)
  process.exit(1)
}

console.log(`[e2e-live] running tests/e2e-live.test.ts against ${providerUrl} with model ${model}`)
const result = spawnSync(process.execPath, [vitestBin, 'run', 'tests/e2e-live.test.ts'], {
  cwd: root,
  stdio: 'inherit',
  env: process.env,
})
process.exit(result.status ?? 1)
