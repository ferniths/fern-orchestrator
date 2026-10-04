# Progress save — Fern Orchestrator audit / stabilization

> Session handoff file. Read this first when resuming. Companion to `HANDOFF.md`
> (which covers the original engineering audit). This file tracks the
> **debugging + stabilization pass** that followed it: what was proven, what was
> fixed, what is half-fixed, and what is next.

---

## 0.1 Continuation session (2026-10-04) — recovery + backlog verification

Recovered the interrupted OpenCode session `ses_f01d55204ffelNX8wJrpVLWdSO`
("Full codebase audit and execution debugging", 2026-10-02 → 2026-10-03, 742
messages) from `%USERPROFILE%\.local\share\opencode\opencode.db`. It died at
14:17 UTC on 2026-10-03 while running the **first-ever `npm run smoke:parallel`**
(the asserted 3-worker mode had just been written, never observed). Its DB rows
proved the run actually completed PASS (job `job_jrm895olpd` completed, 3 tasks
succeeded incl. one honest failure→retry on `parallel-c.txt`, 3 files on disk,
3 sessions) — but the continuation verified everything live anyway.

Verified this session (all real execution):

- `npm run smoke:parallel` → **PASS 13/13, peak 3 live workers in flight**,
  deliverables intact, no clobber, no leftover processes (run 30).
- `node scripts/live-audit.mjs` (NEW audit script) → **PASS 19/19**:
  settings persist to `config.json` (write → reload → verify); refiner honors
  `language: 'Japanese'` with real Japanese prose AND stays contract-clean
  English by default (global↔job precedence included); vault lifecycle
  (index → FTS search → backlinks → graph → read → update → create → rename →
  delete) verified on a temp vault at the FILESYSTEM level; the real vault
  `C:\Users\Fern\Documents\main-brain` indexed **read-only** (1446 notes,
  19,773 links) and searched without a single write.
- `npm run build` → 0 (was not re-run since the language/parallel changes —
  now green). Standard `npm run smoke` (run 31) → PASS 14/14.
- UI asks re-audited: **System Status widget is gone** (no matches anywhere),
  search input reserves a 36px icon gutter (`.input-icon`, styles.css:207),
  project picker (`ProjectPickerDialog`) is wired New Job → `jobs.create`
  validation → engine workspace resolution (validated, fails loudly),
  `spawn EINVAL` fix confirmed in `binaries.ts` (`resolveCmdTarget` unwraps the
  npm `.cmd` shim; cmd.exe fallback) — exercised live by every smoke run.
- Engine honesty re-read end-to-end: review-unavailable → fail (never pass),
  zero-work loop → job fail, partial-miss → retryable fail, `succeeded` settled
  in exactly one place in `workerManager.settleCompletion` behind an evidence
  chain (transcript fetch → assistant message → artifact verdict on disk).

New tool: `scripts/live-audit.mjs` — subsystem audit for everything the smoke
doesn't cover (settings, language, vault). Run it after touching any of those.

Remaining untouched (still §5): subagent depth/roll-up (#3), live git-approval
expiry exercise, UI QA via CDP. Nothing in this continuation changed app code —
it was a verification + tooling pass; the only new file is the audit script.

---

## 0. Operating context (reproduce this state)

- Working dir: `C:\Users\Fern\Desktop\dashboard` (git repo, **nothing committed** — everything untracked).
- Gates: `npm run typecheck` · `npm run lint` · `npm run test` · `npm run build` · `npm run smoke`
- **Current gate status: ALL GREEN** — typecheck=0, lint=0, build=0,
  `npm run test` → **255 passed, 2 skipped (257 total, 17 files)**.
- **Smoke: 8 consecutive PASS 14/14 (runs 22–29)** — see §3.
- **§4 Step 2 (approval expiry) is DONE** — `orchestration.approvalTimeoutMs`
  (default 15 min, 0 = never) + `WorkerManager.sweepExpiredApprovals()`.
- User directive: *"Continue if you have next steps, or stop and ask for
  clarification if you are unsure how to proceed."*
- Model/provider: 9Router `http://127.0.0.1:20128/v1`, model `fernbrain`.
  Proven UP (HTTP 200). OpenCode v1.18.34 (npm `opencode-ai`), binary at
  `%APPDATA%\npm\opencode.cmd` → 180,599,176-byte real binary after running
  `postinstall.mjs`.
- App data: `C:\Users\Fern\AppData\Roaming\Fern Orchestrator`
- Smoke data: `C:\Users\Fern\AppData\Local\Temp\harness-smoke-data` (`fern.db`)
- Smoke workspace: `C:\Users\Fern\AppData\Local\Temp\harness-smoke-workspace`
- OpenCode own DB: `C:\Users\Fern\.local\share\opencode\opencode.db`
  (tables `part`, `message`, `session`, `session_message`, `session_input`)
- `pwsh` NOT installed. Git bash at `C:\Program Files\Git\bin\bash.exe`.

### Debug scripts (keep — they are the evidence pipeline)

All in `C:\Users\Fern\AppData\Local\Temp\opencode\`:

| script | purpose |
|---|---|
| `schema.mjs` | dumps sqlite table/column list for any db (edit path) |
| `dump-smoke-fail.mjs` | job + tasks + workers + events for the latest smoke job |
| `dump-sess.mjs <sessionId>` | **the key one** — all parts of an OpenCode session: every `tool` call with input/output, every text part, `step-finish` reason (`stop` vs `tool-calls`) + token counts |
| `dump-inputs.mjs`, `dump-msg.mjs`, `dump-ctx.mjs`, `dump-smoke2.mjs`, `dump-finish.mjs` | older session/ctx dumps |
| `shell-probe.mjs` | shell detection probes (args: `none\|bash\|cmd\|pwsh\|git\|gitbash`) |
| `ctx-probe.mjs`, `prompt-probe.mjs` (`PROBE_PROMPT` env with `{work}` placeholder) | prompt/env probes |
| `proxy.mjs` | logging proxy 20128→20129 (`PROXY_LOG`) |
| `inspect-sys.mjs` | inspects OpenCode system prompt/`<env>` block |

> PowerShell quoting mangles inline `node -e` and here-strings containing
> backticks — **always write a temp `.mjs` file instead**.

---

## 1. Root causes proven (all with real execution, not reasoning)

### #1 — placeholder npm binary *(FIXED, verified)*
`opencode.exe` was a 479-byte placeholder. Ran `postinstall.mjs` → real
180,599,176-byte binary, `--version` → v1.18.34.

### #2 — tool-state evidence lost *(FIXED, verified by tests)*
OpenCode marks tool parts `completed` even when the tool errored, so
`messagesToTranscript` showed green tools. Fixed via `OcToolState` +
`toolStateError()`/`toolPartStatus()`; error now surfaces `state.error`, or
falls back to `exit N: <output>` when `state.error` is absent and `exit !== 0`.
Transcript rows now read `tool (status) — error`.

### #3 — `&&` invalid in PowerShell 5.1 *(FIXED, empirically proven)*
With no shell override, OpenCode's bash tool runs **PowerShell 5.1** →
`ParserError: The token '&&' is not a valid statement separator` (exit 1, tool
still reports `completed`). With `shell` → Git Bash: exit 0, files created.

### #4 — POSIX paths outside the workspace *(FIXED, empirically proven)*
OpenCode's system `<env>` block reports **`Workspace root folder: /`** when the
workspace is **not** a git repo (it reports the real path when it is). The model
then writes `/c/Users/...` or `/C:/Users/...`; `path.win32.resolve('/C:/...')`
→ `C:\C:\...`, `/c/...` → `C:\c\...`. The `write` tool reports *completed* while
the file lands at `C:\c\Users\...`. Fixed by naming the absolute Windows path
at the top of every worker prompt.

### #5 — model fabricates tool results *(MITIGATED, still the dominant flake)*
Model settles with `finish=stop`, ~40–200 tokens, **zero tool calls** (or one
tool call for a two-file task), asserting *"File created … verified via `type`"*
where no such call exists. Harness never fakes success (artifact check catches
it), but smoke goes red. **This is now the only remaining source of flake.**

### #6 — refiner accepted a *truncated* prompt *(FIXED)*
Smoke prompt ends with *"Reply with DONE when both files exist."* → refiner
returned the single word **`DONE`**. Passed every structural check; planner then
invented a `Verify DONE state` task whose `expected_artifacts` were prose
sentences → guaranteed `missing expected artifacts` failure.

### #7 — planner wrote prose into `expectedArtifacts` *(FIXED)*
Model emits `"Confirmation of no pending TODOs"`, `"List of top-level files in
workspace"` — sentences that can never exist as files. `artifactCollector` stats
them as paths → guaranteed miss.

### #8 — refiner accepted a *completion report* as the prompt *(FIXED, this session)*
Refiner output was literally:
> `Created harness-smoke-test.txt with exact content HARNESS_SMOKE_TEST_OK and summary.md with a brief description of the action in the workspace directory. DONE`

That's an **answer**, not a request. The planner inherited a report and built a
verification-only plan. Not caught by any existing check.

### #9 — retries re-dispatch the identical prompt *(FIXED, this session)*
`dispatchTask` creates a fresh worker/session with `taskPrompt` unchanged. The
model repeats the exact same mistake because it is never told attempt 1 failed
or *which* file was missing. Observed: attempt 2 reported `summary.md` created
again, failed with the same `missing expected artifacts: summary.md`.

### #10 — partial miss settled `succeeded`, so no retry ever ran *(FIXED, **now tested + smoke-proven**)*
Collector contract (pinned by `tests/artifacts.test.ts:127`): **partial miss →
`verdict.ok = true` + `note` only**; only *all* missing → `ok=false` + reason.
Consequence: worker settles `succeeded` with `statusReason="missing expected
artifacts: summary.md"`, `pickRetries` ignores it (`task.status !== 'failed'`),
and the job only dies later at **final review**. My retry-feedback (#9) was
therefore unreachable in exactly the case it was built for.

**Fixed** in `settleCompletion` (see §2): fail while attempts remain, fall
through to `succeeded`+note on the last attempt. Verified by
`tests/worker.test.ts` → *"fails a partial delivery so it retries, but stops
retrying on the last attempt"*, and **live in smoke run 14** (`summary.md
attempt 1 failed (missing) → attempt 2 succeeded`).

> Gotcha when writing that test: `dispatch()` bumps `attempt` at
> `workerManager.ts:341`, and workers are created with `attempt: 0`
> (`domain.ts:404`). So attempt-1 behaviour = leave `attempt` unset;
> last-attempt behaviour = pass `attempt: 1`. Setting `attempt: 1` for a
> first-attempt worker silently makes it attempt 2.

### #11 — `external_directory` permission not covered → headless approval hang *(FIXED, verified)*
`buildPermissionEnv` only covered `read/edit/glob/grep/list/bash/task`. OpenCode
defaults any uncovered key to **`ask`**, so a worker touching an unrecognised
path (`C:\Users\Fern\...`) raised an approval prompt with nobody to answer it →
worker parked in `waiting_approval` until `taskTimeoutMs` (30 min) → smoke
burned its whole 334s budget (run 11). Expanded to every OpenCode 1.18 key;
git gating preserved. Note: `Approval.expiresAt` exists in the schema but
**nothing ever sets or sweeps it** — `status: 'expired'` is dead code, so an
unanswered *intentional* ask (git gate) still holds budget until task timeout.

### #12 — sibling worker overwrites another task's finished deliverable *(FIXED, smoke-proven)*
Run 13: task A settled `succeeded` with correct content, then task B
(`summary.md`) wrote `"smoke test marker"` **into `harness-smoke-test.txt`**,
erasing A's work. Two-part fix:
- `siblingArtifactNote(worker)` in `dispatch()` names the other tasks' files
  explicitly ("do not create, modify or truncate"), instead of the vague
  "only touch your files" rule the model ignored.
- `reviewEvidence` now recomputes sha256 per file artifact and reports
  **`CHANGED since verification`** when it diverges from the checksum recorded
  at settle time — the reviewer previously only ever saw `PRESENT (N bytes)`
  and happily declared wrong content "correct".

### #13 — model-fusion "panel" prose overrode the model's own tool output *(MITIGATED, then hardened structurally)*
Runs 15 and 20: the worker **globbed and saw the file absent**, then trusted
fusion-panel reasoning ("Consensus: both files were created") and reported it
created — run 15 with zero write calls, run 20 after a `read` of the *other*
file only. Two layers of response:

1. **Prompt** — `dispatch()` now states that listing/reading a file does not
   create it, that only a write/bash call *in this session* can, and that every
   listed file must have just been created by the model's own call.
2. **Structural diagnosis (the durable part)** — `settleCompletion` now inspects
   the transcript's tool inputs:
   - no write-class tool at all → `no write tool was ever called — <files>
     does not exist (a claim is not a file)`
   - write tools ran, but never aimed at a promised file → `never called a
     write tool for <file> — <file> does not exist`

   Tool entries now carry `input` (from `part.state.input`), so the failure
   reason names **which** file the next attempt must write instead of the
   generic `missing expected artifacts: …`, which told the retry nothing.
   Observed effect: after this, runs 22–24 passed 3/3.

The model's fabrication itself is not cured — it is now *diagnosed precisely*,
which is what makes the retry able to act.

### #14 — `fake-opencode` emitted no tool parts *(FIXED — tests were green on a lie)*
The fixture wrote `FILE:` markers without ever broadcasting a tool part, so
every transcript in the suite had **zero tool evidence**. The harness looked
like it was verifying tool calls while actually verifying nothing. Now records
per-session `writes` and returns them as real `{type:'tool', tool:'write',
status:'completed'}` parts on `GET /session/:id/message`. Two tests had to be
rewritten because they had been asserting the *generic* wording that only
appeared in the absence of tool evidence.

### #15 — an unanswered approval parked a worker for `taskTimeoutMs` *(FIXED, not yet hit live)*
`Approval.expiresAt` existed in the schema but was never written, nothing swept
it, and `status:'expired'` was dead code. So an unattended `ask` (git gate,
vault write, any intercepted permission) held a worker in `waiting_approval` —
and the concurrency budget with it — until the 30-minute task timeout. This was
derived from reading the code, **not** from a live failure; smoke never trips it
because everything is `allow` in the smoke env.

Now:
- `orchestration.approvalTimeoutMs` (default **15 min**, `0` = never) written as
  `expiresAt` at `createApproval` time in `onPermissionAsked`.
- `WorkerManager.sweepExpiredApprovals()` → `listExpiredApprovals()` (pending +
  `expires_at <= now`) → `expireApproval()` (guarded `WHERE status='pending'`,
  so it cannot overwrite a click) → **rejects on the OpenCode side** via
  `decidePermission(id, false, note)` → worker `running` + `statusReason:
  'approval timed out — rejected'`. Emits `approval.resolved`.
- Polled from a `setInterval(15s)` started in the `WorkerManager` constructor,
  `unref()`d so it can never hold the process open, cleared in `shutdown()`.
- **Plan approvals deliberately never expire** (`expiresAt: null`): they are a
  human decision, not a gate on a running worker.
- `decidePermission` now returns `boolean` (whether the reply actually landed) —
  that is how the sweep distinguishes "resumed" from "reject not delivered".

Caveat: if the OpenCode session is already gone the reject cannot be delivered,
the worker stays `waiting_approval` with an explicit statusReason, and only the
task timeout reclaims it. Acceptable — there is no session to resume anyway.

---

## 2. What was changed (file by file)

### `src/core/platform/binaries.ts`
- `detectShell(override?)` — win32 only. Order: explicit override → Git Bash →
  `pwsh` on PATH → probe `--version`. POSIX returns `null`. Never returns an
  unusable shell.
- Existing: `LaunchPlan`/`planLaunch()`, `resolveCmdTarget()`, `assertCwd`,
  `runProcess`, `probe()`, `detectOpencode()` (real `--version` validation),
  `which`, `detectGit`, `requireGit`.

### `src/core/kernel/config.ts`
- `opencode.shell: z.string().nullable().default(null)` (fix #3 config side).
- `orchestration.approvalTimeoutMs: z.number().int().min(0).default(15 * 60_000)`
  (fix #15; `0` = never expire).

### `src/core/db/repos/workers.ts`
- **NEW `listExpiredApprovals(at = Date.now())`** — pending rows with
  `expires_at IS NOT NULL AND expires_at <= ?`.
- **NEW `expireApproval(id, note)`** — returns `null` if the row is not pending
  (so a sweep can never overwrite a UI decision), updates with
  `WHERE id = ? AND status = 'pending'` for the same reason.

### `src/core/opencode/serverPool.ts`
- `buildConfigContent(..., shell?)` → emits `...(shell ? { shell } : {})`.
- `start()` resolves `await detectShell(cfg.opencode.shell)`, warns if an
  explicit override was unusable, feeds it into `OPENCODE_CONFIG_CONTENT`.
- **`buildPermissionEnv` expanded (fix #11)** — pattern maps
  `read/edit/glob/grep/list/bash/task/external_directory` → `{'*':'allow'}`;
  flat actions `webfetch/websearch/todowrite/question/doom_loop` → `'allow'`;
  git gating (`git commit*/git push*/chained` → configured action) unchanged.

### `src/core/opencode/workerManager.ts` (heaviest edits)
1. `messagesToTranscript` — `tool (status) — error`; live tool parts recorded;
   transcript upsert by id.
2. `dispatch()` prompt is now **4 blocks** (was 1 sentence):
   - `Workspace directory (create files here, using this exact Windows path): <dir>` (fix #4)
   - `Do the work with your tools (write/bash) … if you never called a tool, you created nothing.` (fix #5)
   - **NEW** expected-artifact checklist via `expectedArtifactChecklist(worker)` —
     `- <file>` lines from `task.expectedArtifacts`, so the model has something
     to check off instead of trusting itself (fix #5/#10, anti-fabrication).
   - **NEW** prior-failure note via `priorFailureNote(worker)` —
     `A previous attempt at this exact task failed: <reason>.` +
     `The files it reported were not found on disk. Verify each expected file
     exists with a real tool call …` (fix #9).
3. **NEW (unverified)** in `settleCompletion`, right after `!collected.verdict.ok`:
   ```ts
   const task = this.ctx.repos.jobs.getTask(worker.taskId)
   const attemptsLeft = task ? worker.attempt < task.retryPolicy.maxAttempts : false
   if (collected.missingExpected.length > 0 && attemptsLeft) {
     this.fail(workerId, `missing expected artifacts: ${collected.missingExpected.join(', ')}`, { summary })
     return
   }
   ```
   Intent: turn a partial miss into a **retryable failure while attempts
   remain**, without touching the pinned collector verdict; on the last allowed
   attempt it falls through to the old `succeeded` + note path and lets the
   reviewer adjudicate. **Now covered by a unit test and by smoke run 14.**
4. **NEW** `siblingArtifactNote(worker)` (fix #12) — lists files owned by
   *other* tasks of the same job/loop as off-limits, inserted right after the
   expected-artifact checklist.
5. **NEW anti-fusion prompt lines** (fix #13) — *"Listing or reading a file does
   not create it: only a write/bash call in this session can create a file"* +
   *"every file in the list below must have been created by your own
   write/bash call — if you did not just create it, it does not exist."*
6. **NEW per-file failure diagnosis** (fix #13, structural) — `WRITE_TOOLS` set,
   `noWriteReason()`, `neverTargeted(entries, missing)`. Both the
   `!verdict.ok` branch and the partial-miss branch use it:
   ```ts
   const attemptedWrite = entries.some(e => e.role === 'tool' && WRITE_TOOLS.has(e.tool?.name?.toLowerCase()))
   const neverTried = missing.length > 0 && !attemptedWrite
   const untargeted = neverTried ? [] : neverTargeted(entries, missing)
   const why = neverTried ? noWriteReason(missing)
           : untargeted.length ? `never called a write tool for ${untargeted.join(', ')} — …`
           : null   // null → fall through to the original wording
   ```
   `neverTargeted` matches write-tool `input` against `filePath|file|path|filename`
   on both the full path and the basename (normalized, case-insensitive).
7. **Tool parts now record `input`** in `messagesToTranscript` and in the live
   `onPartUpdated` append — this is what makes `neverTargeted` possible.
8. **NEW (fix #15)** `onPermissionAsked` writes
   `expiresAt: Date.now() + cfg.orchestration.approvalTimeoutMs` (null when the
   timeout is 0).
9. **NEW (fix #15)** `sweepExpiredApprovals(at = Date.now())` → expires past-due
   pending approvals, rejects them on the OpenCode side, moves a
   `waiting_approval` worker to `running` with `statusReason`, emits
   `approval.resolved`. Driven by a `setInterval(15_000)` in the constructor
   (`unref()`d, cleared in `shutdown()`) behind the `autoSweep` test hook.
10. `decidePermission()` now **returns `boolean`** = whether the reply landed
    (was `Promise<void>`); callers in IPC ignore it, the sweep depends on it.

> ⚠ **Self-inflicted, fixed**: a PowerShell `-replace` on `workerManager.ts`
> collapsed `{` + first statement onto the signature line of `priorFailureNote`
> and `dispatch` (valid JS, so typecheck/lint both passed). Search for `\{    `
> if you suspect this again. Same class of bug left a dangling `.catch(...)`
> in `tests/worker.test.ts` — always use the `edit` tool on source, never
> `Get-Content -Raw` + `-replace`.

### `src/core/opencode/artifactCollector.ts`
- **NEW** `looksLikeArtifactPath(name)` (exported):
  no whitespace → keep; whitespace → keep only if last segment carries an
  extension (`/\.[A-Za-z0-9]{1,10}$/`); length>200 / empty / newline → drop.
- `declared` now `.filter(looksLikeArtifactPath)` (fix #7 at the stat layer).
- **NEW (fix #12)** exported `artifactDiskNote(abs, recorded)` → stat + sha256
  on disk, returns `CHANGED since verification (recorded …; now …)` when size or
  hash diverges from what was recorded at settle time, `PRESENT (N bytes,
  recorded <status>)` when unchanged, `null` when the file is gone (caller
  reports MISSING). Honours the existing `CHECKSUM_SIZE_CAP` (512KB).
- **Collector verdict logic untouched** (partial = `ok` + note, all = `ok=false`).

### `src/core/orchestration/plan.ts`
- `looksLikeArtifactPath` **re-exported from `artifactCollector`** (single source
  of truth; I initially duplicated it here, then moved it).
- `compilePlan()` → `expectedArtifacts: step.expectedArtifacts.filter(looksLikeArtifactPath)` (fix #7 at compile layer).
- `PLAN_JSON_SCHEMA.expectedArtifacts` gained a `description` telling the model
  these are file paths, never sentences.

### `src/core/orchestration/refiner.ts`
- `RefinerViolation.code` union extended twice:
  `'truncated'` (fix #6) and `'answered'` (fix #8).
- **`truncated`** check:
  ```ts
  const requestedTranslation = targetLanguage !== 'English' && !languageSwitched(original, text, targetLanguage)
  const source = original.trim()
  if (!requestedTranslation && source.length >= 40) {
    const severelyShort = text.length < source.length * 0.3
    const degenerate = text.length < 60 || text.split(/\s+/).length < 6 || lexicalOverlap(source, text) < 0.2
    if (severelyShort && degenerate) push({ code: 'truncated', … })
  }
  ```
  **Gotcha discovered the hard way:** `lexicalOverlap` alone does NOT catch
  `DONE`, because `DONE` appears *inside* the original prompt ("Reply with
  DONE…") → overlap = 1.0. Also `languageSwitched()` returns `true` for `DONE`
  (0 English markers), so gating on `languageSwitched === false` silently
  disabled the check. Hence: absolute floor (`<60` chars **or** `<6` words)
  AND an explicit `requestedTranslation` exemption for non-English targets.
- **`answered`** check — `COMPLETION_CLAIM` regex, anchored at start:
  `created|built|made|completed|finished|implemented|resolved|verified|installed|executed|wrote|tested|fixed|updated|configured|deployed|deleted|removed|added|ran|done|all done|the (files?|work|task|request) (has|have) been`.
  Imperative requests (`Create…`, `Add…`, `Fix…`) must **not** match — covered by
  a dedicated test.

### `src/core/orchestration/engine.ts` (read closely + edited this round)
- **Edit (#12)**: `reviewEvidence` file loop now calls `artifactDiskNote(abs, a)`
  and prints `MISSING on disk (recorded …)` when it returns null; imports it
  from `../opencode/artifactCollector`.
  **Watch**: an earlier edit merged two `import` lines → `TS1005` at
  `engine.ts(2,33)`.
- `dispatchTask` (line ~398): `attempt = task.attempt + 1`, worker created with
  `attempt: task.attempt`, `taskPrompt: task.prompt` — **this is where #9 lived**;
  the fix went into `workerManager.dispatch` instead (both IPC `retry()` and
  engine path funnel through it).
- Tick loop (line ~332-389): `succeeded`→task succeeded; `failed|timed_out|aborted|orphaned`
  → `willRetry = task.attempt < task.retryPolicy.maxAttempts` → `failed — retrying`;
  then `pickRetries()` → `ready`; `isLoopSettled()` breaks.
- Default `retryPolicy.maxAttempts = 2` (`src/shared/domain.ts:158`);
  planner writes `maxAttempts: 3` (`plan.ts:164`, `engine.ts:759`).

### `src/renderer/src/pages/SettingsPage.tsx`
- New `NumberRow` "Approval timeout (minutes)" in the Orchestration section
  (writes `orchestration.approvalTimeoutMs`, `min 0`, hint explains `0` =
  wait forever). `Cfg.orchestration` type extended.

### Tests added (all currently passing)
- `tests/worker.test.ts`
  - `states the exact workspace path in the prompt the model receives`
    (fetches `GET /__prompts` from the fake server); also asserts the #13 line
    *"only a write/bash call in this session can create a file"*.
  - `lists the expected artifacts and the previous failure in the prompt`
    (seeds a failed sibling worker on the same task; asserts `- summary.md`,
    `- notes/report.md`, the prior-failure sentence, and that the checklist comes
    before the body).
  - `names the other tasks files as off-limits so a worker cannot clobber a
    sibling deliverable` (#12) — asserts the off-limits block contains the
    sibling file and that the own file sits *before* it, in the checklist.
  - `fails a partial delivery so it retries, but stops retrying on the last
    attempt` (#10) — attempt 1 → `failed` with the per-file reason; attempt 2 →
    `succeeded`. **Gotcha**: leave `attempt` unset for attempt 1 (`dispatch`
    bumps it at `workerManager.ts:341`, workers are created at `attempt: 0`).
  - `fails a worker that produced none of its expected artifacts` — now asserts
    `no write tool was ever called` (changed under #14).
  - `names the promised file that no write tool ever targeted` (#13) — writes
    `decoy.md` while promising `wanted.md` → `never called a write tool for
    wanted.md — wanted.md does not exist`.
  - **5 approval-expiry tests (#15)**: `gives every permission approval a
    deadline` (asserts `expiresAt - createdAt === 15 * 60_000`), `rejects an
    unanswered approval once its deadline passes` (asserts `status: 'expired'`,
    `decisionNote`, worker back to `running` with the timeout reason),
    `never expires an approval without a deadline`, `does not expire an
    approval someone already decided`, `selects only pending approvals whose
    deadline has passed`.
    **Test hook**: `ctx.opencode.autoSweep = false` in `beforeAll` — the 15s
    background poll would otherwise race the tests for the same rows.
- `tests/artifacts.test.ts` (#12)
  - `artifactDiskNote`: unchanged file → `PRESENT (21 bytes, recorded present)`;
    rewritten → `CHANGED since verification … 17 bytes`; deleted → `null`.
    **Byte counts are exact**: `HARNESS_SMOKE_TEST_OK` is 21, not 20.
- `tests/opencode.test.ts`
  - shell override emitted only when resolved; PowerShell-5.1-safe shell on
    win32, nothing on POSIX; **permission-key coverage** (#11) — asserts every
    OpenCode key is covered and that `bash` is asserted via its `'*'` entry
    only, since it also carries the git gates.
- `tests/refiner.test.ts`
  - `rejects a refinement that collapsed to a fragment of the original` → `DONE`
    must yield `truncated`.
  - `still accepts a tightened or translated refinement` → tightened English +
    a Japanese translation of the same long prompt must both return `[]`.
  - `rejects a completion report instead of a restated request` → `answered`.
  - `keeps imperative requests that share the same verbs` → `Create`/`Add`/`Fix`
    return `[]`.
- `tests/orchestration.test.ts`
  - `drops prose that the model wrote into expectedArtifacts` →
    `['report.md','Confirmation of no pending TODOs','List of top-level files in workspace','src/app.ts']`
    → `['report.md','src/app.ts']`.

### Fixture
- `tests/fixtures/fake-opencode.mjs`: `prompts[]` array, records text parts on
  both `/message` POST and `/prompt_async`, serves `GET /__prompts`.
- **NEW (#14)** `writeMarkedFiles()` now records per-session `writes[]`, and
  `GET /session/:id/message` returns them as real tool parts
  (`{type:'tool', tool:'write', status:'completed'}`). Before this the fixture
  emitted **no tool parts at all**, so the suite exercised tool-evidence code
  paths with nothing to verify — two assertions had to change because they had
  been passing on that absence.

---

## 3. Smoke history (the real scoreboard)

| # | result | what it proved |
|---|---|---|
| 1 | PASS 14/14 | shell + workspace-path fixes hold |
| 2 | FAIL | marker task, **zero-tool-call fabrication** (#5) |
| 3 | PASS 14/14 | attempt 2 recovered (before #9/#10 existed) |
| 4 | PASS 14/14 | |
| 5 | FAIL `missing expected artifacts: summary.md` | planner prose artifacts (#7) + refiner `DONE` (#6) |
| 6 | PASS 14/14 | #6/#7 fixes hold; **attempt 2 recovered** — first live evidence #9 mattered |
| 7 | FAIL `final review verdict "fail" — … summary.md missing` | refiner returned a **completion report** (#8); partial miss never retried (#10) |
| 8 | PASS 14/14 | `attempt 2` in the check line — #9 feedback worked live |
| 9 | FAIL `final review verdict "fail" — … summary.md missing on disk` | #10: partial miss → `succeeded` → no retry → review caught it |
| 10 | FAIL (0-byte file) | sibling clobber — worker B truncated A's deliverable (#12) |
| 11 | FAIL timed out after 334s | `external_directory` defaulted to `ask` → headless approval hang (#11) |
| 12 | PASS 14/14 (111s) | #11 permission-env fix verified live |
| 13 | FAIL 13/14 `got "smoke test marker"` | sibling clobber again — vague "only touch your files" rule ignored (#12) |
| 14 | PASS 14/14 (128s) | **#10 retry live**: `summary.md attempt 1 failed (missing) → attempt 2 succeeded` |
| 15 | FAIL `final review verdict "fail" — summary.md missing` | #13: model globbed, saw it absent, trusted fusion-panel prose, `DONE` with zero writes — **reviewer caught it honestly** |
| 16 | PASS 14/14 (149s) | #13 prompt mitigation holds |
| 17 | PASS 14/14 (181s, 3 workers) | **#12 sibling guard live** — 3 workers, correct content survived |
| 18 | PASS 14/14 (149s) | 3 consecutive PASS (16, 17, 18) |
| 19 | PASS 14/14 (91s) | |
| 20 | FAIL `1 task(s) ended the final loop unresolved` | #13 again: attempt 1 zero tools, attempt 2 globbed `No files found` then claimed creation; **honest** — task failed, never faked |
| 21 | FAIL `final review verdict "fail" — summary.md missing` | attempt 2 `read` the marker file only, claimed both; fell through to `succeeded` on the **last** attempt (maxAttempts=2), reviewer caught it |
| 22 | PASS 14/14 (117s) | first run with per-file diagnosis (#13 structural) |
| 23 | PASS 14/14 (182s, retry in prompt) | |
| 24 | PASS 14/14 (195s) | 3 consecutive PASS (22, 23, 24) |
| 25 | PASS 14/14 (250s) | |
| 26 | PASS 14/14 (229s, 2 tasks) | |
| 27 | PASS 14/14 (96s, 2 tasks) | |
| 28 | PASS 14/14 (153s) | **7 consecutive (22–28)** — flake rate over |
| 29 | PASS 14/14 (177s) | first run after approval expiry landed — **8 consecutive (22–29)** |

Pattern: **the harness is never dishonest** — every failure above is a real
missing/corrupted file reported as missing/corrupted, and in runs 10, 13, 15 it
was caught by the *application* (retry/verdict), not by the model. The residual
flake is 100% model behaviour (#5/#13), now mitigated at three layers:
prompt rule → partial-miss retry → reviewer evidence.

---

## 4. Immediate next steps (do these first, in order)

### Step 1 — DONE: smoke flake measurement
Runs 22–29 are **8 consecutive PASS 14/14** (96s–250s), gates all green at
**255 passed / 2 skipped (257)**. Prior scoreboard was 9 PASS / 15 FAIL over
runs 1–21, so the fix set held. Treat smoke as "reliably green" and stop using
it as the primary activity — but keep running it after each §5 item:
```powershell
npm run smoke
```
On FAIL: `dump-smoke-fail.mjs` then `dump-sess.mjs <sessionId>`, read the
`TOOL … | input=` lines. If the reason is the generic
`missing expected artifacts: …`, `neverTargeted()` failed to match the tool
input shape — check what `part.state.input` actually holds for that tool.

Known residual risk (honest, not a bug): when `attempt == maxAttempts` (2) the
partial-miss branch deliberately falls through to `succeeded` and lets the final
reviewer adjudicate (run 21). A two-strike model failure therefore surfaces as
`final review verdict "fail"` rather than a task failure. Options if it returns:
raise `retryPolicy.maxAttempts`, or hard-fail the last-attempt partial miss.

### Step 2 — DONE: approval expiry (#15)
`orchestration.approvalTimeoutMs` (15 min default, `0` = never) → `expiresAt`
written per permission approval → `sweepExpiredApprovals()` rejects it on the
OpenCode side and releases the worker. Plan approvals intentionally never
expire. 5 new tests; verified green in the full suite. **Not exercised live** —
smoke runs everything `allow`, so no approval is ever raised. To watch it work
end-to-end: set `permissions.gitCommit: 'ask'`, run a job that commits, and let
the approval time out (or set `approvalTimeoutMs: 1` for a quick look).

### Step 3 — start the §5 backlog
§5 progress: **#2 parallel smoke DONE** (run 30, PASS 13/13, peak 3 workers),
**#6 settings end-to-end DONE** (live-audit write→reload→verify), language
end-to-end DONE (live-audit, real Japanese refinement), **#8 vault DONE**
(live-audit, full CRUD + read-only main-brain index). Remaining: #4 review/
repair loop live exercise, #1 scheduler deep audit (code-read done, logic
sound), #5 providers deep audit, #3 subagents. The audit script for #6/#8:
`node scripts/live-audit.mjs`.

---

## 5. Remaining audit backlog (after smoke is reliably green)

Nothing below has been audited yet in this pass — treat as unverified:

1. **Scheduler / concurrency** — `pickReady` budget vs
   `orchestration.limits.maxConcurrentWorkers`; starvation; `TICK_MS` spin.
2. **3-worker parallel smoke** — spec asks for a dedicated parallel test. The
   job does now reach 2–3 concurrent workers organically (runs 17, 22–24), but
   there is no *asserted* parallel check and budget is still 360000ms.
3. **Subagents** — `recordChildSessions` is visibility-only; verify depth limits,
   workspace isolation, transcript roll-up.
4. **Review / repair loop** — `loopCount > 1` path, `needs_more_work` vs `fail`,
   whether review evidence (`reviewEvidence` on-disk stat + `toolFindings` from
   transcripts) is actually reaching the reviewer in live runs.
5. **Providers / model routing** — `resolveDispatchRoute`, fallback model, the
   "no provider/model resolved" warn path, per-role `model_routes`.
6. **Settings must actually work** — `opencode.shell` UI row is written but I
   have not verified an end-to-end Settings save→effective change.
7. **Language** — 5-language selection end-to-end (job-level `language` vs
   global `general.language`), refiner target-language path in a *live* run.
8. **Obsidian vault** — configurable path, never hardcoded
   (`C:\Users\Fern\Documents\main-brain`).
9. **Git commit/push approval gate** — approvals table round-trip.
10. **UI QA** — remove the **System Status** widget; fix the **top-left search**
    spacing (`src/renderer`).
11. **Honesty sweeps** — `engine-honesty.test.ts` covers a lot; look for any
    remaining place where a DB row implies execution (spec priority #1).

---

## 6. Known constraints / do-not-break list

- **Pinned**: collector verdict — *all* expected missing → `ok=false` +
  `reason: "missing expected artifacts: …"`; *partial* → `ok=true` + `note`
  only (`tests/artifacts.test.ts:127`). The #10 change deliberately lives
  **above** this contract (in `workerManager.settleCompletion`), not in it.
- Artifact kind filtering uses `Boolean(a.path)`, **not** `kind === 'file'`.
- `minimalEnv` in tests skips `OPENCODE_CONFIG_CONTENT`, so shell config can
  never perturb unit tests.
- OpenCode REST needs Basic auth: header
  `'Basic ' + Buffer.from('opencode:' + OPENCODE_SERVER_PASSWORD).toString('base64')`;
  the `messages` GET must include it (401 otherwise).
- 7 `OpenCode.exe` desktop processes may be running — **leave them alone**.
- Never commit unless explicitly asked. Nothing has been committed so far.

---

## 7. Quick reference — key file:line

| what | where |
|---|---|
| shell detection | `src/core/platform/binaries.ts` ~L314 |
| shell → config | `src/core/opencode/serverPool.ts` (`buildConfigContent` ~L130, `start()` ~L306) |
| worker prompt blocks | `src/core/opencode/workerManager.ts` `dispatch()` ~L400 |
| expected checklist | `workerManager.ts` `expectedArtifactChecklist()` |
| sibling off-limits list (#12) | `workerManager.ts` `siblingArtifactNote()` |
| retry feedback | `workerManager.ts` `priorFailureNote()` |
| per-file failure diagnosis (#13) | `workerManager.ts` `WRITE_TOOLS`, `noWriteReason()`, `neverTargeted()` (top of file) |
| partial-miss retry (#10) | `workerManager.ts` `settleCompletion()` after `!collected.verdict.ok` |
| permission env (#11) | `src/core/opencode/serverPool.ts` `buildPermissionEnv()` |
| approval deadline (#15) | `workerManager.ts` `onPermissionAsked()` (`expiresAt`) → `sweepExpiredApprovals()` → `repos/workers.ts` `listExpiredApprovals()`/`expireApproval()` |
| approval timeout config (#15) | `src/core/kernel/config.ts` `orchestration.approvalTimeoutMs`; UI row in `SettingsPage.tsx` |
| verdict rules | `src/core/opencode/artifactCollector.ts` ~L226-238 |
| path filter | `artifactCollector.ts` `looksLikeArtifactPath()` (top of file) |
| on-disk evidence (#12) | `artifactCollector.ts` `artifactDiskNote()` |
| reviewer evidence | `src/core/orchestration/engine.ts` `reviewEvidence()` ~L653 |
| plan artifact filter | `src/core/orchestration/plan.ts` `compilePlan()` ~L289 |
| refiner violations | `src/core/orchestration/refiner.ts` `detectViolations()` ~L239 |
| retry scheduling | `src/core/orchestration/scheduler.ts` `pickRetries()` |
| engine tick / retry | `src/core/orchestration/engine.ts` ~L332-389, `dispatchTask` ~L398 |
| fake OpenCode fixture (#14) | `tests/fixtures/fake-opencode.mjs` `writeMarkedFiles()` + `GET /session/:id/message` |
