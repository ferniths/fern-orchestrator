# Fern Orchestrator

**Local-first AI automation command center.** A rough prompt becomes a refined brief, a structured master plan, a dependency-linked DAG of real OpenCode worker sessions, and then synthesis + review loops until the job passes — all on your machine.

<!-- Screenshot placeholder — no image shipped yet; drop a capture at docs/screenshots/README.png -->
![Screenshot placeholder](docs/screenshots/README.png)

## Features

- **Prompt → plan → DAG → workers → review**: refiner, planner (structured `json_schema` output), DAG compile with cycle detection, optional plan-approval gate, parallel workers, synthesizer, reviewer, N iteration loops with verdicts (`pass` / `fail` / `needs_more_work` / `stop`).
- **Two explicit AI planes**: control plane (direct OpenAI-compatible HTTP for refine/plan/review/synthesis) and worker plane (real `opencode serve` sessions with SSE streaming, transcripts, timeouts and retries).
- **Approval gates**: git commit / push, plan approval, manual gates — OpenCode permission prompts surface as dashboard approvals with diff view; nothing lands in git without a decision.
- **Providers & routing**: 9Router or any OpenAI-compatible endpoint (Ollama works), model discovery (`/v1/models`), health checks, role→model routes, fallback chains, per-role retry policy.
- **Jobs UI**: live status, job tabs (Plan, Workflow, Tasks, Workers, Timeline), DAG canvas, worker transcripts, artifacts, reviews, pause/resume/cancel, rerun a loop.
- **Projects & Git**: project registry, status, branches, worktrees, repository discovery.
- **Obsidian vault**: FTS5 full-text index, backlinks/orphans/related, folder tree, note CRUD, `chokidar` watcher, knowledge graph view.
- **Observability**: typed event bus with monotonic sequence + replay, activity timeline, global search, stats and token/cost usage per job/loop/task/worker.
- **Local-first**: SQLite (WAL) database, JSONL logs with secret redaction, encrypted keystore — no telemetry, nothing leaves the machine except calls you configure.

## Prerequisites

| Requirement | Notes |
|---|---|
| Node.js >= 22 + npm | `engines.node` in `package.json`; dev/test/build tooling |
| OpenCode CLI | tested against **1.18.33** — `npm i -g opencode-ai` (auto-discovered from PATH/npm/scoop, or set the path in Settings) |
| Git | project registration, status/worktrees, approval-gated commits |
| Optional: 9Router | OpenAI-compatible router with combo models (`/v1/models` discovery) |
| Optional: Ollama (or any OpenAI-compatible server) | add as an `openai_compatible` provider, e.g. `http://localhost:11434/v1` |

## Install

```powershell
npm install
npm run rebuild     # rebuild better-sqlite3 against Electron's ABI
```

## Commands

| Script | Command | What it does |
|---|---|---|
| dev | `npm run dev` | electron-vite dev server + Electron window |
| build | `npm run build` | build main/preload/renderer to `out/` |
| preview | `npm run preview` | preview the built app |
| typecheck | `npm run typecheck` | `tsc --noEmit` for `tsconfig.node.json` and `tsconfig.web.json` |
| lint | `npm run lint` | ESLint over the repo |
| format | `npm run format` | Prettier write |
| test | `npm run test` | Vitest run (unit + integration, `tests/**/*.test.ts`) |
| test:watch | `npm run test:watch` | Vitest watch mode |
| rebuild | `npm run rebuild` | `electron-rebuild -f -w better-sqlite3` |
| dist:win | `npm run dist:win` | build + electron-builder Windows package |
| dist:linux | `npm run dist:linux` | build + electron-builder Linux package |
| e2e:live | `npm run e2e:live` | end-to-end run against your **configured real provider** (`scripts/e2e-live.mjs`) — costs tokens, opt-in |

## Test

```powershell
npm run typecheck
npm run lint
npm run test
```

Tests run headless against a temp data directory: a mock OpenAI-compatible HTTP server for provider/structured-output behaviour, and `tests/fixtures/fake-opencode.mjs` as a stand-in `opencode serve` for adapter/SSE/pool/worker flows. `npm run e2e:live` is separate and uses real models.

## Configuration

- **Config file**: `<data dir>/config.json` — zod-validated, defaults written on first run, corrupt files fall back to defaults instead of bricking the app (`src/core/kernel/config.ts`).
- **Providers** (Providers page): type `nine_router` or `openai_compatible`, base URL, default/fallback model, timeout/retries, health + discovered models.
- **API keys**: stored **encrypted at rest** — AES-256-GCM in `keystore.bin` (mode 0600) next to the database; the database only holds an `apiKeyRef` pointer. Keys are masked in the UI, redacted in logs, never written to events/DB and **never committed** (`.env`/`.env.*` are gitignored, keystore/db files live outside the repo).
- **Model routes**: automatic (healthiest provider wins) or explicit role→model preferences, selected per job.
- **Permissions** (`permissions` in config): `gitCommit` / `gitPush` default to `ask` → dashboard approval; `vaultWrite` defaults to `allow`.
- **Environment overrides** (optional): `FERN_DATA_DIR` (data location), `FERN_LOG_LEVEL`, `FERN_OPENCODE_BIN`, `FERN_WORKER_CONCURRENCY`.
- **OpenCode**: per-server random password, injected `OPENCODE_CONFIG_CONTENT` / `OPENCODE_PERMISSION` / private `OPENCODE_CONFIG_DIR` — your own `~/.config/opencode` is never touched.

## How orchestration works

```
rough prompt
  → refiner (control plane, text)
  → planner (control plane, json_schema "job_plan")
  → compile DAG (tasks + workflow_nodes/edges, topological check)
  → [plan approval gate, optional]
  → scheduler: ready tasks → workers (real OpenCode sessions, parallel, per-task timeout/retry)
  → synthesizer (integration artifact)
  → reviewer (json_schema "job_review": pass | fail | needs_more_work | stop)
  → fail/needs_more_work && loop < N ? plan again with prior problems : final result
```

Git commit/push inside a worker triggers an approval (OpenCode permission → approval row → Approve/Deny with diff). Limits (concurrency, loops, subagent depth, runtime, token budget) are hard stops, not silent truncation. See [ARCHITECTURE.md](ARCHITECTURE.md) for the full state machine.

## UI overview

- **Pages**: Dashboard · Jobs · Projects · Providers · Knowledge · Activity · Settings (plus New job, Job detail).
- **Job detail tabs**: Plan · Workflow (DAG) · Tasks · Workers · Timeline.
- **Dashboard**: active jobs with live stage, provider/OpenCode health pills, pending approvals, stats.
- **Keyboard**: `Ctrl/Cmd+K` opens Activity (search landing); header search + `Enter` runs a global search across jobs/tasks/workers/artifacts/notes; `New job` is in the header.
- **Live updates**: the renderer is a projection of the typed event stream (buffered on connect); stats/health poll on a timer.

## Repository

- <https://github.com/ferniths/fern-orchestrator> (private)
- Design/ADR notes: [`docs/adr/`](docs/adr/); captured OpenAPI spec for the pinned OpenCode version: [`docs/openapi/opencode-1.18.33.json`](docs/openapi/opencode-1.18.33.json)

## License

MIT — see [LICENSE](LICENSE).

## Data & privacy

Local-first: no telemetry, no cloud sync. All state lives under one data directory — precedence `FERN_DATA_DIR` → Electron `userData` (`src/main/context.ts`), falling back to the platform convention (`src/core/platform/paths.ts`): `%APPDATA%\fern-orchestrator` on Windows, `~/Library/Application Support/fern-orchestrator` on macOS, `$XDG_CONFIG_HOME/fern-orchestrator` or `~/.config/fern-orchestrator` on Linux. It contains `config.json`, `fern.db` (SQLite), `keystore.bin`, `logs/`, `jobs/`, `opencode-bridge/` and `cache/`. The only network traffic is to the model providers you configure and the local OpenCode servers Fern itself starts on `127.0.0.1`.
