# Session Handoff — Harness Repair (2026-09-29)

## Mission
Own and repair the **automation harness** of Fern Orchestrator (this repo). A real user test showed a job stuck on "running" with no artifacts and only 1 worker ever invoked. Highest priority: a submitted job must produce real tasks → real OpenCode workers → real tool execution → real artifacts → real review, with **no fake success anywhere** (a DB row is not execution). Second: restore user-facing language selection (5 languages).

Commands: `npm run typecheck` · `npm run lint` · `npm run test` · `npm run build` · `npm run smoke`
No commits exist in this repo (everything untracked) — nothing was committed.

---

## 1. ROOT CAUSE (confirmed with a live capture — this was the bug)

The SSE parser never matched OpenCode 1.18.33's real payload shape, so **`sessionId` was always `null`** → `onIdle`/`onPartUpdated`/`onPermissionAsked` all returned early → **workers never completed**, no live transcript, no permission prompts. Meanwhile the model *did* real work (wrote `ice-outline.md` 13s after dispatch) — it was just never observed.

Real shape (captured from a live `opencode serve`, 111 frames):
```json
{"directory":"C:\\ws","project":"global",
 "payload":{"id":"evt_0ee84580d002C24OvOjR2t89lD","type":"session.idle",
            "properties":{"sessionID":"ses_f117bc07cffeNDu6dR408goOOI"}}}
```
Old parser only checked `payload.info.sessionID` / `payload.sessionID` / `payload.id` (an `evt_` id never starts with `ses`). **111/111 frames → `sessionId = null`.**

Evidence trail: app data dir is `C:\Users\Fern\AppData\Roaming\Fern Orchestrator` (NOT `fern-orchestrator`); `logs\2026-09-29.jsonl` ends at `worker dispatched` with no `worker completed`; `fern.db` job `job_yh4a30qnt6` stuck `running`, one worker `running`, `artifacts` table **empty**; earlier jobs `job_bssbsn52y3`/`job_3228ik0q28` cancelled by the user (same stall). Read `fern.db` with Node's `node:sqlite` `DatabaseSync` (better-sqlite3 in node_modules is Electron-ABI and fails under plain node).

Why tests stayed green: `tests/fixtures/fake-opencode.mjs` emitted the *retired* `info.sessionID` shape (fixture matched the bug), and the only `sessionId` assertion in the suite enshrined it.

Secondary discoveries: `permission.asked`/`message.part.updated`/`session.status` all carry their data under `properties` (OpenAPI documents it as `data`); events are double-emitted as a `sync` envelope (must be dropped); `server.connected`/`server.heartbeat` have no `directory` wrapper; 0/111 frames use an `event:` line.

---

## 2. WHAT WAS FIXED

**Phase 2a/2b — parsing (the unblock)**
- `src/core/opencode/events.ts` — `parseSseBlock`: unwraps `{directory, payload}`, reads inner `properties` **or** legacy `data`/flat fields into `NormalizedEvent.data`, extracts `sessionId` from all known locations, **drops `sync` envelopes** (they mirror already-delivered named events).
- `tests/fixtures/fake-opencode.mjs` — now emits real 1.18.33 shapes via an `evt()` helper (+ `message.part.updated` broadcast); later extended with real file creation (`FILE:<rel>` prompt markers), `broken-transcript` → HTTP 500, `no-output` → user-message-only, `subagent` title → returns a child session, `diff` returning files that exist on disk.
- `tests/opencode.test.ts` — parser tests now use **verbatim captured frames** + assertions that the stream yields non-null `sessionId`.

**Phase 2c — worker completion honesty + artifacts (agent)**
- `src/core/opencode/artifactCollector.ts` (new) + `workerManager.ts` rewrite:
  - `complete()` requires **evidence**: up to 3 transcript fetch attempts (650ms apart), then an assistant message with no `info.error`, else the worker **fails** (`transcript unavailable: …` / `worker produced no assistant output`). Never `succeeded` on empty output. In-flight `completing` guard prevents double-complete races.
  - Artifacts collected from `adapter.diff()` + `task.expectedArtifacts`, **verified on disk** (path-escape rejected, sha256 ≤512KB, `available` vs `missing`), linked job/loop/task/worker/session, `ARTIFACT_CREATED` emitted, `filesTouched`/`artifacts`/session `diffStats` persisted.
  - Verdict: all expected missing → worker `failed`; some missing → succeeded with `statusReason`; none declared → ≥1 diff file on disk **or** non-empty assistant reply.
  - Child sessions recorded with `parentSessionId` + `SUBAGENT_SPAWNED` emitted (post-completion).
  - `killSession` returns false when the abort failed; `decidePermission` only flips to `running` when the reply was delivered.

**Phase 2d — engine honesty + routing (agent)**
- `src/core/orchestration/engine.ts`: review-unavailable → **fail, never pass** (`unavailable: true`); integration errors surfaced (`PROVIDER_FAILED` + `loop.unresolved`); empty plan refused; **zero-work loop fails** (no success + no artifacts ⇒ job failed); `orphaned` workers settle the task; integration body reports captured output/artifacts instead of substituting plan objectives; `finish()` stats scoped to the finishing loop.
- Dispatch-time routing: `resolveDispatchRoute` + TTL-cached `routeCatalog` stamp `providerId`/`modelId`/`profileId`/systemPrompt/agent on the worker (previously all null → OpenCode silently picked its own model), with an explicit warning when nothing resolves.
- `tests/orchestration.test.ts`: `tasksCompleted` assertion 6→3 (cross-loop double count fixed).

**Phase 3 — output language (agent)**
- `domain.ts`: `OUTPUT_LANGUAGES`, `outputLanguageSchema`, `proseLanguageInstruction()`; job field `language` (nullable = follow global).
- `config.ts`: `general.language` (default `English`); Settings → General row **"Output language"**; New Job select; migration **`version: 3`** adds `automation_jobs.language`; `jobs.create` defaults from config.
- Labels ↔ values: `English (Default)`→`English`, `Japanese`→`Japanese`, `Brazilian`→`Portuguese (Brazil)`, `Spanish`→`Spanish`, `Jamaican Patois`→`Jamaican Patois`.
- `refiner.ts`: language-aware target (`refinerSystemPrompt(lang)`, `detectViolations(…, targetLanguage)`, `matchesOutputLanguage`) — English default stays **byte-identical** and still flags English→Spanish; non-English targets no longer fall back to the unrefined prompt.
- `plan.ts` `plannerSystemPrompt(language)`: **always-on parallelism guidance** (prefer independent steps so workers run concurrently) + prose-only language line; JSON keys/enums stay English.
- `controlPlane.ts`: `withOutputLanguage()` appends one instruction to the existing system message for `reviewer`/`final_reviewer`/`synthesizer`/etc. only when ≠ English (never adds messages).

**Phase 4 — health check + self-test (agent)**
- `src/core/orchestration/harnessHealth.ts` (`runHealthCheck`, 10 genuinely probed components: database, config, eventBus, schedulerDag, opencodeBinary, providerRoute, workspaceFs, artifactRecording, opencodeServer, workerManager) and `src/core/orchestration/selfTest.ts` (`runSelfTest`: prereqs → real pipeline → evidence → invariants `workersTerminal`/`taskTransitions`/`artifactOnDisk`/`noFakeSuccess` → cleanup).
- IPC: `harness.health`, `harness.selfTest`, `harness.selfTestCancel` (`src/main/ipc/handlers/harness.ts`); UI: Settings → Diagnostics → **Harness** panel.
- Honest SKIP/FAIL when prerequisites are missing — never a fake PASS.

**Phase 5 — smoke + regression (agent, was CANCELLED mid-flight but left working files)**
- `scripts/harness-smoke.mjs` (495 lines) + `package.json` `"smoke"` script: boots the real core context in a temp data dir, registers the real 9Router provider, starts a real `opencode serve`, drives a real job, prints a PASS/FAIL table. Uses a sync `module.registerHooks` loader (esbuild) to bridge .mjs → .ts with `@core/`/`@shared/` aliases.
- `tests/harness-regression.test.ts`: 3-worker parallel dispatch, engine-level artifact collection, `fail` verdict on a non-final loop, final-loop failure honesty, subagent child session, no-fake-success through the engine.

---

## 3. CURRENT STATE (verified by me at end of session)

| Gate | Result |
|---|---|
| `npm run typecheck` | ✅ clean |
| `npm run lint` | ✅ clean |
| `npm run test` | ✅ **199 passed / 8 skipped** (15 files; baseline was 131/8) |
| `npm run build` | ⚠️ **NOT run since the changes** (was green at the old baseline only) |
| `npm run smoke` | ❌ **FAIL — see §4.1** |
| Real CDP/QA UI check | ⚠️ not re-run since these changes |

New test files added this session: `tests/artifacts.test.ts`, `tests/engine-honesty.test.ts`, `tests/language.test.ts`, `tests/harness-selftest.test.ts`, `tests/harness-regression.test.ts`.

---

## 4. OPEN ITEMS (in priority order)

### 4.1 `npm run smoke` fails with `EPERM` — mostly an environment issue
```
PASS core context boots / opencode binary detected / provider registered (9Router, key stored)
PASS provider reachable (POST /chat/completions → 200)
FAIL unexpected error — EPERM rmSync ...\Temp\harness-smoke-workspace  (scripts/harness-smoke.mjs:304)
PASS no leftover opencode serve processes
RESULT: FAIL (5 passed, 0 skipped, 1 failed)
```
Cause: **5 leftover `opencode.exe` processes** from earlier repro/agent runs hold the workspace dir (PIDs at time of writing: `15284, 20112, 20352, 20572, 23260` — verify with `Get-Process opencode` before killing; only kill ones listening on the repro/smoke ports).
Next: kill those, then `rmSync` at `harness-smoke.mjs:304` (phase-4 workspace reset) should be made resilient (retry on EPERM ×3 with backoff, or `try/catch` + report) and re-run `npm run smoke`. The script still has to prove the full refine → plan → dispatch → artifact-on-disk chain — **this is the single most important remaining verification** (spec §2: reproduce first, then verify).

### 4.2 Run the captured frames through the shipped parser (2-minute proof)
`C:\Users\Fern\AppData\Local\Temp\opencode\reparse-shipped.ts` imports the real `src/core/opencode/events.ts` and re-parses all 111 captured production frames from `...\Temp\opencode\sse-capture.jsonl`. Expected: `sessionId NON-NULL: 111`, `session.idle → ses_f117…` ("would COMPLETE"). Run:
`node C:\Users\Fern\AppData\Local\Temp\opencode\reparse-shipped.ts` (may need `--experimental-strip-types`-free Node 26 default; if the `.ts` import fails, run it through `npx vitest` instead). This was written but **never executed**.

### 4.3 Build + UI verification
- `npm run build` (not run since the edits).
- Re-run the CDP QA harness: `node C:\Users\Fern\AppData\Local\Temp\opencode\qa-fern.mjs` (screenshots + 19 settings checks; last green run predates these changes). Specifically eyeball: Settings → General **Output language** select, New Job **Output language** select, Settings → Diagnostics → **Harness** panel (Run health check / Run self-test).

### 4.4 Verify the language feature end-to-end
Unit tests cover prompts/config/persistence, but nobody has visually confirmed the two selects or run a real job with `Japanese`/`Brazilian` selected to see refiner/plan/review prose actually change language.

### 4.5 Deferred / reported by agents (not blocking)
- `parentID` is still not passed at `adapter.createSession` dispatch time; `SUBAGENT_SPAWNED` fires post-completion only, not at spawn.
- `builtins.ts:14` seeded "Refiner" profile prompt still says "preserve the user's language / Never translate" — unused by `refinePrompt`, but wording is now inconsistent with the target-language feature.
- `workerManager.abort()` still returns `true` unconditionally (only `killSession` was fixed).
- 6 `it.skip` placeholders remain in `tests/scenarios.test.ts`.
- No git commits — consider an initial commit once green (ask the user first).

---

## 5. KEY MAP (for a fast restart)

- Parser / SSE: `src/core/opencode/events.ts` (fix), `serverPool.ts` (`beginEventLoop`, `buildPermissionEnv`, `buildConfigContent`), `adapter.ts` (prompt/messages/diff/children).
- Worker lifecycle: `src/core/opencode/workerManager.ts` (`dispatch`, `complete`, `settle`, `handleEvent`), `src/core/opencode/artifactCollector.ts`.
- Engine: `src/core/orchestration/engine.ts` (run → executeLoop → dispatchTask → integrateAndReview → review → finish), `scheduler.ts` (`pickReady`, `isLoopSettled`), `plan.ts` (schemas + `plannerSystemPrompt`), `refiner.ts`, `prompts.ts`.
- Routing: `resolveDispatchRoute` in `engine.ts`; control-plane route resolution in `controlPlane.ts`/router; `job.routeId`.
- Harness diagnostics: `src/core/orchestration/harnessHealth.ts`, `selfTest.ts`, `src/main/ipc/handlers/harness.ts`.
- Real evidence: `C:\Users\Fern\AppData\Roaming\Fern Orchestrator\{logs\*.jsonl, fern.db, jobs\}`; capture `C:\Users\Fern\AppData\Local\Temp\opencode\sse-capture.jsonl`; QA harness `...\Temp\opencode\qa-fern.mjs`.
- Spec still governs scope: the user's 45-section harness spec in the session (reproduce → trace → 3-worker parallel → subagents → tool/file verification → loops → OpenCode/9Router debugging → health → self-test → 5 languages → regression → final validation + report).
