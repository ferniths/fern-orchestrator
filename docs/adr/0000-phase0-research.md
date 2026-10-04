# ADR 0000 — Phase 0 research findings (verified against this machine)

Status: Accepted · 2026-09-28 · spikes: `scripts/spike-db.mjs`, `scripts/spike-opencode.mjs`, `scripts/spike-9router.mjs`

## Environment

| Item | Value |
|---|---|
| Node (plain) | v26.7.0 |
| Electron bundled Node | v24.21.0 |
| OpenCode | 1.18.33 (npm global, `%APPDATA%\npm\node_modules\opencode-ai\bin\opencode.exe`) |
| 9Router | 0.5.81, `http://127.0.0.1:20128`, SQLite at `%APPDATA%\9router\db\data.sqlite`, key in `apiKeys` table |
| Vault | 1446 md / 8.6 MB / 120 dirs |

## ADR-1: better-sqlite3 + FTS5 is viable

`better-sqlite3@13` loads under **both** Node 26 and Electron 44 after `electron-rebuild`
(the addon is N-API based, so the same build serves both), and SQLite 3.53.4 ships **FTS5**.
Decision: better-sqlite3 (synchronous API suits transactional orchestration state) + FTS5 for vault search.

## ADR-2: OpenCode integration contract (installed API ≠ current docs)

Verified against a real `opencode serve` with an injected config and a local mock provider:

- **Server**: `opencode serve --port N --hostname 127.0.0.1`, basic auth via
  `OPENCODE_SERVER_USERNAME/PASSWORD`, health at `GET /global/health`, spec at `GET /doc`
  (**JSON**, 162 paths; saved to `docs/openapi/opencode-1.18.33.json` — the adapter is built
  from *this*, not from website docs, which have drifted).
- **Config injection works and is enough**: `OPENCODE_CONFIG_CONTENT` (adds our provider +
  `subagent_depth`), `OPENCODE_PERMISSION` (permission rules), `OPENCODE_CONFIG_DIR`
  (private `agents/` + `plugins/`). The injected provider showed up in `GET /provider`
  `connected: [...,"mock"]` and global config was untouched.
- **Permission gate is real**: with `bash: {"*":"allow","git commit*":"ask"}`, a worker's
  `git commit` produced event **`permission.asked`** and the tool stayed pending (no commit
  happened) until we replied.
  - Event payload: `{id, sessionID, permission:"bash", patterns:[...], metadata:{command}, always:[...], tool:{messageID,callID}}`
  - Reply: `POST /session/{sessionID}/permissions/{permissionID}` `{response:"once"|"always"|"reject"}` → `200 true`
  - Also available: `GET /permission` (pending list), `POST /permission/{requestID}/reply` `{reply,message}`
  - After `once`, the command executed and the commit landed.
- **Sessions**: `POST /session {title}` → `{id, projectID, directory, parentID?}`;
  `POST /session/{id}/prompt_async` (204) for non-blocking prompts;
  `POST /session/{id}/message` body supports `model{providerID,modelID}`, `agent`,
  `system`, `tools`, **`format` (OutputFormat — structured output exists in this build)**,
  `parts[]`.
- **Events actually emitted**: `server.connected`, `server.heartbeat`, `session.created`,
  `session.updated`, `session.status`, `session.idle`, `session.diff`, `message.updated`,
  `message.part.updated`, `message.part.delta`, `permission.asked`, `permission.replied`,
  `file.watcher.updated`, `plugin.added`, `catalog.updated`, `reference.updated`,
  `integration.updated`. (Docs list `permission.updated` — **not** what this build emits.)
- **Usage flows through**: assistant messages carry `{tokens:{total,input,output,reasoning,cache}, cost}`.
- **Agents discovered**: `build`, `plan`, `general`, `explore`, `summary`, `title`, `compaction`.
- **Git commit required local `user.name/email`** (global config is unset on this machine) —
  projects must be verified for committable identity before approval flows.

## ADR-3: 9Router is a normal OpenAI-compatible provider, with quirks

- `GET /v1/models` (119–129 models, `owned_by:"combo"` for combos, capability metadata) needs no key;
  `POST /v1/chat/completions` **requires** `Authorization: Bearer <key>` (401 otherwise).
- Streaming (`text/event-stream`, `[DONE]` terminator) and `usage` on the final chunk work.
- **`response_format: {type:"json_schema"}` returns 200 but a reasoning model put the JSON into
  `message.reasoning_content` and left `message.content: null`.**
  → Control-plane client must read `content ?? reasoning_content ?? reasoning ?? ""`, extract JSON
  defensively, and run a validate→repair→retry loop. Never trust a single field.
- Combo models can503 when their upstream is down; model list is dynamic (129→119 between calls).
  → Health/fallback classification must treat `5xx` as *provider failure*, distinct from rate-limit
  and from *model unavailable*.

## Decisions carried forward

1. One managed `opencode serve` per workspace root (+ one shared core server), random password,
   private `OPENCODE_CONFIG_DIR` — never edit the user's `~/.config/opencode`.
2. Approval gate = native `permission` rules answered by the dashboard (+ optional plugin backstop
   for chained commands such as `git add . && git commit`).
3. Control plane (refiner/planner/reviewer/synthesizer) talks to providers directly with
   defensive structured-output parsing; workers are real OpenCode sessions.
4. Everything API-shaped is generated/validated from the live `/doc` spec at startup; drift is a
   surfaced error, not a silent break.
