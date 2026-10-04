export interface Migration {
  version: number
  name: string
  sql: string
}

/**
 * Linear, append-only migrations. Never edit an applied migration — add a new one.
 * Each migration runs inside a transaction with foreign keys preserved.
 *
 * Column naming: snake_case in SQL, camelCase in TypeScript. Repositories own the
 * mapping so a schema change never leaks into the UI or the orchestration engine.
 */
export const migrations: Migration[] = [
  {
    version: 1,
    name: 'init',
    sql: `
      CREATE TABLE projects (
        id                TEXT PRIMARY KEY,
        name              TEXT NOT NULL,
        path              TEXT NOT NULL UNIQUE,
        description       TEXT NOT NULL DEFAULT '',
        instructions      TEXT NOT NULL DEFAULT '',
        vault_id          TEXT,
        workspace_strategy TEXT NOT NULL DEFAULT 'shared',
        default_model     TEXT,
        enabled           INTEGER NOT NULL DEFAULT 1,
        last_opened_at    INTEGER,
        metadata          TEXT NOT NULL DEFAULT '{}',
        created_at        INTEGER NOT NULL,
        updated_at        INTEGER NOT NULL
      );

      CREATE TABLE git_worktrees (
        id          TEXT PRIMARY KEY,
        project_id  TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        path        TEXT NOT NULL,
        branch      TEXT NOT NULL,
        worker_id   TEXT,
        detached    INTEGER NOT NULL DEFAULT 0,
        status      TEXT NOT NULL DEFAULT 'active',
        created_at  INTEGER NOT NULL,
        updated_at  INTEGER NOT NULL
      );
      CREATE INDEX idx_worktrees_project ON git_worktrees(project_id);

      CREATE TABLE providers (
        id                TEXT PRIMARY KEY,
        name              TEXT NOT NULL,
        type              TEXT NOT NULL DEFAULT 'openai_compatible',
        base_url          TEXT NOT NULL,
        api_key_ref       TEXT,
        default_model     TEXT NOT NULL DEFAULT '',
        fallback_model    TEXT,
        combo             TEXT,
        custom_headers    TEXT NOT NULL DEFAULT '{}',
        timeout_ms        INTEGER NOT NULL DEFAULT 120000,
        max_retries       INTEGER NOT NULL DEFAULT 2,
        streaming         INTEGER NOT NULL DEFAULT 1,
        enabled           INTEGER NOT NULL DEFAULT 1,
        health            TEXT NOT NULL DEFAULT '{}',
        created_at        INTEGER NOT NULL,
        updated_at        INTEGER NOT NULL
      );

      CREATE TABLE model_routes (
        id            TEXT PRIMARY KEY,
        name          TEXT NOT NULL UNIQUE,
        strategy      TEXT NOT NULL DEFAULT 'automatic',
        preferences   TEXT NOT NULL DEFAULT '[]',
        is_default    INTEGER NOT NULL DEFAULT 0,
        created_at    INTEGER NOT NULL,
        updated_at    INTEGER NOT NULL
      );

      CREATE TABLE agent_profiles (
        id                TEXT PRIMARY KEY,
        name              TEXT NOT NULL UNIQUE,
        role              TEXT NOT NULL,
        description       TEXT NOT NULL DEFAULT '',
        system_prompt     TEXT NOT NULL DEFAULT '',
        opencode_agent    TEXT,
        model_preference  TEXT,
        fallback_model    TEXT,
        allowed_tools     TEXT,
        timeout_ms        INTEGER NOT NULL DEFAULT 900000,
        retry_policy      TEXT NOT NULL DEFAULT '{}',
        output_format     TEXT NOT NULL DEFAULT 'text',
        priority          INTEGER NOT NULL DEFAULT 50,
        built_in          INTEGER NOT NULL DEFAULT 0,
        enabled           INTEGER NOT NULL DEFAULT 1,
        created_at        INTEGER NOT NULL,
        updated_at        INTEGER NOT NULL
      );

      CREATE TABLE automation_jobs (
        id                   TEXT PRIMARY KEY,
        title                TEXT NOT NULL,
        original_prompt      TEXT NOT NULL,
        refined_prompt       TEXT NOT NULL DEFAULT '',
        plan_text            TEXT NOT NULL DEFAULT '',
        plan_json            TEXT NOT NULL DEFAULT '{}',
        project_id           TEXT REFERENCES projects(id) ON DELETE SET NULL,
        vault_id             TEXT,
        status               TEXT NOT NULL DEFAULT 'draft',
        status_reason        TEXT,
        loop_count           INTEGER NOT NULL DEFAULT 1,
        current_loop         INTEGER NOT NULL DEFAULT 0,
        route_id             TEXT,
        template_id          TEXT,
        require_plan_approval INTEGER NOT NULL DEFAULT 0,
        plan_approved_at     INTEGER,
        plan_submitted_at    INTEGER,
        workspace_path       TEXT,
        settings             TEXT NOT NULL DEFAULT '{}',
        stats                TEXT NOT NULL DEFAULT '{}',
        error                TEXT,
        created_at           INTEGER NOT NULL,
        started_at           INTEGER,
        completed_at         INTEGER,
        updated_at           INTEGER NOT NULL
      );
      CREATE INDEX idx_jobs_status ON automation_jobs(status, created_at DESC);
      CREATE INDEX idx_jobs_project ON automation_jobs(project_id);

      CREATE TABLE job_loops (
        id                TEXT PRIMARY KEY,
        job_id            TEXT NOT NULL REFERENCES automation_jobs(id) ON DELETE CASCADE,
        loop_index        INTEGER NOT NULL,
        status            TEXT NOT NULL DEFAULT 'planning',
        plan_summary      TEXT NOT NULL DEFAULT '',
        review_summary    TEXT NOT NULL DEFAULT '',
        verdict           TEXT NOT NULL DEFAULT 'pending',
        problems          TEXT NOT NULL DEFAULT '[]',
        changes           TEXT NOT NULL DEFAULT '[]',
        unresolved        TEXT NOT NULL DEFAULT '[]',
        artifacts_produced INTEGER NOT NULL DEFAULT 0,
        duration_ms       INTEGER NOT NULL DEFAULT 0,
        stats             TEXT NOT NULL DEFAULT '{}',
        started_at        INTEGER,
        completed_at      INTEGER,
        created_at        INTEGER NOT NULL,
        updated_at        INTEGER NOT NULL
      );
      CREATE UNIQUE INDEX idx_loops_job_index ON job_loops(job_id, loop_index);

      CREATE TABLE workflow_nodes (
        id          TEXT PRIMARY KEY,
        job_id      TEXT NOT NULL REFERENCES automation_jobs(id) ON DELETE CASCADE,
        loop_index  INTEGER NOT NULL DEFAULT 0,
        node_id     TEXT NOT NULL,
        task_id     TEXT,
        kind        TEXT NOT NULL,
        label       TEXT NOT NULL,
        detail      TEXT NOT NULL DEFAULT '',
        rationale   TEXT NOT NULL DEFAULT '',
        state       TEXT NOT NULL DEFAULT 'pending',
        priority    INTEGER NOT NULL DEFAULT 50,
        timeout_ms  INTEGER NOT NULL DEFAULT 1800000,
        condition   TEXT,
        pos_x       REAL NOT NULL DEFAULT 0,
        pos_y       REAL NOT NULL DEFAULT 0,
        created_at  INTEGER NOT NULL,
        updated_at  INTEGER NOT NULL
      );
      CREATE UNIQUE INDEX idx_nodes_job_node ON workflow_nodes(job_id, node_id);

      CREATE TABLE workflow_edges (
        id             TEXT PRIMARY KEY,
        job_id         TEXT NOT NULL REFERENCES automation_jobs(id) ON DELETE CASCADE,
        loop_index     INTEGER NOT NULL DEFAULT 0,
        source_node_id TEXT NOT NULL,
        target_node_id TEXT NOT NULL,
        kind           TEXT NOT NULL DEFAULT 'dependency',
        label          TEXT NOT NULL DEFAULT '',
        created_at     INTEGER NOT NULL,
        updated_at     INTEGER NOT NULL
      );
      CREATE INDEX idx_edges_job ON workflow_edges(job_id);

      CREATE TABLE tasks (
        id                TEXT PRIMARY KEY,
        job_id            TEXT NOT NULL REFERENCES automation_jobs(id) ON DELETE CASCADE,
        loop_index        INTEGER NOT NULL DEFAULT 0,
        node_id           TEXT,
        parent_id         TEXT,
        title             TEXT NOT NULL,
        objective         TEXT NOT NULL DEFAULT '',
        role              TEXT NOT NULL DEFAULT 'coder',
        profile_id        TEXT,
        model_id          TEXT,
        provider_id       TEXT,
        opencode_agent    TEXT,
        system_prompt     TEXT NOT NULL DEFAULT '',
        prompt            TEXT NOT NULL DEFAULT '',
        dependency_ids    TEXT NOT NULL DEFAULT '[]',
        expected_artifacts TEXT NOT NULL DEFAULT '[]',
        success_criteria  TEXT NOT NULL DEFAULT '[]',
        status            TEXT NOT NULL DEFAULT 'pending',
        status_reason     TEXT,
        priority          INTEGER NOT NULL DEFAULT 50,
        timeout_ms        INTEGER NOT NULL DEFAULT 1800000,
        retry_policy      TEXT NOT NULL DEFAULT '{}',
        attempt           INTEGER NOT NULL DEFAULT 0,
        rationale         TEXT NOT NULL DEFAULT '',
        complexity        TEXT NOT NULL DEFAULT 'medium',
        artifacts         TEXT NOT NULL DEFAULT '[]',
        result_summary    TEXT NOT NULL DEFAULT '',
        error             TEXT,
        created_at        INTEGER NOT NULL,
        started_at        INTEGER,
        completed_at      INTEGER,
        updated_at        INTEGER NOT NULL
      );
      CREATE INDEX idx_tasks_job ON tasks(job_id, id);
      CREATE INDEX idx_tasks_status ON tasks(job_id, status);

      CREATE TABLE workers (
        id                 TEXT PRIMARY KEY,
        job_id             TEXT NOT NULL REFERENCES automation_jobs(id) ON DELETE CASCADE,
        loop_index         INTEGER NOT NULL DEFAULT 0,
        task_id            TEXT NOT NULL,
        name               TEXT NOT NULL,
        role               TEXT NOT NULL DEFAULT 'coder',
        objective          TEXT NOT NULL DEFAULT '',
        system_prompt      TEXT NOT NULL DEFAULT '',
        task_prompt        TEXT NOT NULL DEFAULT '',
        model_id           TEXT,
        provider_id        TEXT,
        opencode_agent     TEXT,
        profile_id         TEXT,
        workspace_path     TEXT NOT NULL DEFAULT '',
        project_id         TEXT,
        parent_worker_id   TEXT,
        parent_session_id  TEXT,
        session_id         TEXT,
        server_id          TEXT,
        depth              INTEGER NOT NULL DEFAULT 0,
        status             TEXT NOT NULL DEFAULT 'queued',
        status_reason      TEXT,
        attempt            INTEGER NOT NULL DEFAULT 0,
        timeout_ms         INTEGER NOT NULL DEFAULT 1800000,
        files_touched      TEXT NOT NULL DEFAULT '[]',
        artifacts          TEXT NOT NULL DEFAULT '[]',
        usage              TEXT NOT NULL DEFAULT '{}',
        error              TEXT,
        created_at         INTEGER NOT NULL,
        queued_at          INTEGER,
        started_at         INTEGER,
        completed_at       INTEGER
      );
      CREATE INDEX idx_workers_job ON workers(job_id, status);
      CREATE INDEX idx_workers_task ON workers(task_id);
      CREATE INDEX idx_workers_session ON workers(session_id);

      CREATE TABLE sessions (
        session_id         TEXT PRIMARY KEY,
        worker_id          TEXT,
        server_id          TEXT NOT NULL DEFAULT '',
        parent_session_id  TEXT,
        job_id             TEXT,
        project_id         TEXT,
        title              TEXT NOT NULL DEFAULT '',
        directory          TEXT NOT NULL DEFAULT '',
        model_id           TEXT,
        provider_id        TEXT,
        opencode_agent     TEXT,
        depth              INTEGER NOT NULL DEFAULT 0,
        status             TEXT NOT NULL DEFAULT 'active',
        summary            TEXT NOT NULL DEFAULT '',
        diff_stats         TEXT NOT NULL DEFAULT '{}',
        last_event_at      INTEGER,
        created_at         INTEGER NOT NULL,
        updated_at         INTEGER NOT NULL
      );
      CREATE INDEX idx_sessions_job ON sessions(job_id);

      CREATE TABLE artifacts (
        id           TEXT PRIMARY KEY,
        job_id       TEXT NOT NULL REFERENCES automation_jobs(id) ON DELETE CASCADE,
        loop_index   INTEGER NOT NULL DEFAULT 0,
        task_id      TEXT,
        worker_id    TEXT,
        session_id   TEXT,
        kind         TEXT NOT NULL DEFAULT 'file',
        name         TEXT NOT NULL,
        path         TEXT,
        content      TEXT,
        mime_type    TEXT NOT NULL DEFAULT 'text/plain',
        bytes        INTEGER NOT NULL DEFAULT 0,
        checksum     TEXT,
        status       TEXT NOT NULL DEFAULT 'available',
        metadata     TEXT NOT NULL DEFAULT '{}',
        created_at   INTEGER NOT NULL,
        updated_at   INTEGER NOT NULL
      );
      CREATE INDEX idx_artifacts_job ON artifacts(job_id, created_at DESC);

      CREATE TABLE reviews (
        id                 TEXT PRIMARY KEY,
        job_id             TEXT NOT NULL REFERENCES automation_jobs(id) ON DELETE CASCADE,
        loop_index         INTEGER NOT NULL DEFAULT 0,
        kind               TEXT NOT NULL DEFAULT 'loop',
        target_id          TEXT,
        reviewer_role      TEXT NOT NULL DEFAULT 'reviewer',
        reviewer_worker_id TEXT,
        criteria           TEXT NOT NULL DEFAULT '[]',
        verdict            TEXT NOT NULL DEFAULT 'pending',
        summary            TEXT NOT NULL DEFAULT '',
        findings           TEXT NOT NULL DEFAULT '[]',
        artifact_ids       TEXT NOT NULL DEFAULT '[]',
        model_id           TEXT,
        duration_ms        INTEGER NOT NULL DEFAULT 0,
        created_at         INTEGER NOT NULL,
        updated_at         INTEGER NOT NULL
      );
      CREATE INDEX idx_reviews_job ON reviews(job_id, created_at DESC);

      CREATE TABLE approvals (
        id                   TEXT PRIMARY KEY,
        job_id               TEXT REFERENCES automation_jobs(id) ON DELETE CASCADE,
        kind                 TEXT NOT NULL,
        title                TEXT NOT NULL DEFAULT '',
        detail               TEXT NOT NULL DEFAULT '',
        status               TEXT NOT NULL DEFAULT 'pending',
        opencode_permission_id TEXT,
        session_id           TEXT,
        worker_id            TEXT,
        payload              TEXT NOT NULL DEFAULT '{}',
        diff                 TEXT NOT NULL DEFAULT '',
        decided_at           INTEGER,
        decision_note        TEXT,
        expires_at           INTEGER,
        created_at           INTEGER NOT NULL,
        updated_at           INTEGER NOT NULL
      );
      CREATE INDEX idx_approvals_status ON approvals(status, created_at DESC);
      CREATE INDEX idx_approvals_permission ON approvals(opencode_permission_id);

      CREATE TABLE usage_records (
        id             TEXT PRIMARY KEY,
        job_id         TEXT,
        loop_index     INTEGER,
        task_id        TEXT,
        worker_id      TEXT,
        provider_id    TEXT NOT NULL DEFAULT '',
        model_id       TEXT NOT NULL DEFAULT '',
        input_tokens   INTEGER NOT NULL DEFAULT 0,
        output_tokens  INTEGER NOT NULL DEFAULT 0,
        cache_read_tokens INTEGER NOT NULL DEFAULT 0,
        cost_usd       REAL NOT NULL DEFAULT 0,
        latency_ms     INTEGER NOT NULL DEFAULT 0,
        request_id     TEXT,
        source         TEXT NOT NULL DEFAULT 'unknown',
        at             INTEGER NOT NULL,
        created_at     INTEGER NOT NULL,
        updated_at     INTEGER NOT NULL
      );
      CREATE INDEX idx_usage_job ON usage_records(job_id, at);
      CREATE INDEX idx_usage_at ON usage_records(at);

      CREATE TABLE events (
        seq        INTEGER PRIMARY KEY AUTOINCREMENT,
        ts         INTEGER NOT NULL,
        type       TEXT NOT NULL,
        severity   TEXT NOT NULL DEFAULT 'info',
        job_id     TEXT,
        worker_id  TEXT,
        task_id    TEXT,
        project_id TEXT,
        message    TEXT NOT NULL DEFAULT '',
        data       TEXT NOT NULL DEFAULT '{}'
      );
      CREATE INDEX idx_events_ts ON events(ts DESC);
      CREATE INDEX idx_events_job ON events(job_id, ts DESC);

      CREATE TABLE vaults (
        id               TEXT PRIMARY KEY,
        name             TEXT NOT NULL,
        path             TEXT NOT NULL UNIQUE,
        enabled          INTEGER NOT NULL DEFAULT 1,
        last_indexed_at  INTEGER,
        note_count       INTEGER NOT NULL DEFAULT 0,
        link_count       INTEGER NOT NULL DEFAULT 0,
        index_status     TEXT NOT NULL DEFAULT 'never',
        last_error       TEXT,
        is_default       INTEGER NOT NULL DEFAULT 0,
        created_at       INTEGER NOT NULL,
        updated_at       INTEGER NOT NULL
      );

      CREATE TABLE notes (
        id             TEXT PRIMARY KEY,
        vault_id       TEXT NOT NULL REFERENCES vaults(id) ON DELETE CASCADE,
        path           TEXT NOT NULL,
        rel_path       TEXT NOT NULL,
        title          TEXT NOT NULL DEFAULT '',
        folder         TEXT NOT NULL DEFAULT '',
        tags           TEXT NOT NULL DEFAULT '[]',
        links          TEXT NOT NULL DEFAULT '[]',
        unresolved     TEXT NOT NULL DEFAULT '[]',
        frontmatter    TEXT NOT NULL DEFAULT '{}',
        has_frontmatter INTEGER NOT NULL DEFAULT 0,
        content_hash   TEXT NOT NULL DEFAULT '',
        mtime          INTEGER NOT NULL DEFAULT 0,
        size           INTEGER NOT NULL DEFAULT 0,
        indexed_at     INTEGER NOT NULL DEFAULT 0
      );
      CREATE UNIQUE INDEX idx_notes_vault_rel ON notes(vault_id, rel_path);
      CREATE INDEX idx_notes_folder ON notes(vault_id, folder);

      CREATE TABLE note_links (
        vault_id  TEXT NOT NULL,
        from_rel  TEXT NOT NULL,
        to_rel    TEXT NOT NULL,
        to_raw    TEXT NOT NULL DEFAULT '',
        kind      TEXT NOT NULL DEFAULT 'wiki',
        PRIMARY KEY (vault_id, from_rel, to_rel, kind)
      );
      CREATE INDEX idx_links_from ON note_links(vault_id, from_rel);
      CREATE INDEX idx_links_to ON note_links(vault_id, to_rel);

      CREATE VIRTUAL TABLE notes_fts USING fts5(
        rel_path UNINDEXED,
        vault_id UNINDEXED,
        title,
        folder,
        tags,
        content,
        tokenize = 'unicode61 remove_diacritics 2'
      );

      CREATE TABLE templates (
        id          TEXT PRIMARY KEY,
        name        TEXT NOT NULL UNIQUE,
        description TEXT NOT NULL DEFAULT '',
        body        TEXT NOT NULL DEFAULT '{}',
        created_at  INTEGER NOT NULL,
        updated_at  INTEGER NOT NULL
      );

      CREATE TABLE notifications (
        id         TEXT PRIMARY KEY,
        kind       TEXT NOT NULL,
        title      TEXT NOT NULL,
        body       TEXT NOT NULL DEFAULT '',
        severity   TEXT NOT NULL DEFAULT 'info',
        job_id     TEXT,
        action     TEXT,
        read_at    INTEGER,
        created_at INTEGER NOT NULL
      );
      CREATE INDEX idx_notifications_read ON notifications(read_at, created_at DESC);
    `,
  },
  {
    version: 2,
    name: 'workers_updated_at',
    sql: `
        ALTER TABLE workers ADD COLUMN updated_at INTEGER;
        UPDATE workers SET updated_at = created_at WHERE updated_at IS NULL;
    `,
  },
  {
    version: 3,
    name: 'jobs_output_language',
    // Nullable on purpose: NULL means "no per-job override — follow the global
    // Settings → General language", so changing the global still affects jobs
    // created before the setting existed.
    sql: `
        ALTER TABLE automation_jobs ADD COLUMN language TEXT;
    `,
  },
]
