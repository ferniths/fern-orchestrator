# End-to-end testing

## Scenario tests (spec §67)

`tests/scenarios.test.ts` covers the spec §67 scenario list at unit/integration
level: no Electron, no external network, no process spawns. Loopback mock
OpenAI-compatible servers stand in for providers. Scenarios that require live
processes (OpenCode sessions, worktrees, restart reconciliation) are present as
`it.skip` entries so the intent stays visible; they are covered by
`tests/orchestration.test.ts`, `tests/worker.test.ts`, `tests/git-gate.test.ts`
and `tests/opencode.test.ts`, or by work owned elsewhere.

```powershell
npx vitest run tests/scenarios.test.ts
```

## Live provider E2E (spec §68)

Runs the real control plane (provider registration through the keystore →
`ctx.ai.runText` → `ctx.ai.runStructured` with the `job_plan` schema) against a
real OpenAI-compatible provider. No Electron binary is involved.

```powershell
$env:FERN_E2E_API_KEY = "sk-..."
$env:FERN_E2E_MODEL = "your-model-id"
# optional, defaults to the local 9Router
$env:FERN_E2E_PROVIDER_URL = "http://127.0.0.1:20128/v1"
npm run e2e:live
```

`scripts/e2e-live.mjs` prints `SKIPPED` and exits `0` when `FERN_E2E_API_KEY`
or `FERN_E2E_MODEL` is missing; otherwise it sets `FERN_E2E=1` and runs
`tests/e2e-live.test.ts` under vitest. Without `FERN_E2E=1` the test file is
skipped by default, so `npm test` never hits the network.

## Packaging (spec §68)

```powershell
npm run build            # electron-vite build → out/main, out/preload, out/renderer
npm run dist:win         # build + NSIS installer into release/
npx electron-builder build --dir --win   # unpacked directory build (fast validation)
```

Configuration lives in `electron-builder.yml` (`appId` `dev.fern.orchestrator`,
output `release/`, asar enabled, NSIS per-machine off). No code-signing
certificates are configured.
