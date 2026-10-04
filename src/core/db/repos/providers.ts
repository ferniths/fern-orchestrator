import type { AgentProfile, ModelRoute, ProviderConnection } from '@shared/domain'
import { agentProfileSchema, modelRouteSchema, providerConnectionSchema } from '@shared/domain'
import { newId, now } from '../../kernel/ids'
import type { Db } from '../db'
import { bool, flag, j, num, nullableStr, str, type Row } from './helpers'

function toProvider(row: Row): ProviderConnection {
  return providerConnectionSchema.parse({
    id: row.id,
    name: row.name,
    type: row.type,
    baseUrl: row.base_url,
    apiKeyRef: row.api_key_ref,
    defaultModel: row.default_model,
    fallbackModel: row.fallback_model,
    combo: row.combo,
    customHeaders: j(row.custom_headers, {}),
    timeoutMs: num(row.timeout_ms),
    maxRetries: num(row.max_retries),
    streaming: bool(row.streaming),
    enabled: bool(row.enabled),
    health: j(row.health, {}),
    createdAt: num(row.created_at),
    updatedAt: num(row.updated_at),
  })
}

function toRoute(row: Row): ModelRoute {
  return modelRouteSchema.parse({
    id: row.id,
    name: row.name,
    strategy: row.strategy,
    preferences: j(row.preferences, []),
    isDefault: bool(row.is_default),
    createdAt: num(row.created_at),
    updatedAt: num(row.updated_at),
  })
}

function toProfile(row: Row): AgentProfile {
  return agentProfileSchema.parse({
    id: row.id,
    name: row.name,
    role: row.role,
    description: row.description,
    systemPrompt: row.system_prompt,
    opencodeAgent: row.opencode_agent,
    modelPreference: row.model_preference ? j(row.model_preference, null) : null,
    fallbackModel: row.fallback_model,
    allowedTools: row.allowed_tools === null || row.allowed_tools === undefined ? null : j(row.allowed_tools, null),
    timeoutMs: num(row.timeout_ms),
    retryPolicy: j(row.retry_policy, {}),
    outputFormat: row.output_format,
    priority: num(row.priority),
    builtIn: bool(row.built_in),
    enabled: bool(row.enabled),
    createdAt: num(row.created_at),
    updatedAt: num(row.updated_at),
  })
}

export class ProviderRepo {
  constructor(private readonly db: Db) {}

  listProviders(): ProviderConnection[] {
    return this.db.all<Row>('SELECT * FROM providers ORDER BY name').map(toProvider)
  }

  getProvider(id: string): ProviderConnection | null {
    const row = this.db.get<Row>('SELECT * FROM providers WHERE id = ?', id)
    return row ? toProvider(row) : null
  }

  createProvider(input: Partial<ProviderConnection> & { name: string; baseUrl: string }): ProviderConnection {
    const t = now()
    const entity = providerConnectionSchema.parse({ ...input, id: newId('prv'), createdAt: t, updatedAt: t })
    this.db.run(
      `INSERT INTO providers (id, name, type, base_url, api_key_ref, default_model, fallback_model, combo, custom_headers, timeout_ms, max_retries, streaming, enabled, health, created_at, updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      entity.id,
      entity.name,
      entity.type,
      entity.baseUrl,
      entity.apiKeyRef,
      entity.defaultModel,
      entity.fallbackModel,
      entity.combo,
      JSON.stringify(entity.customHeaders),
      entity.timeoutMs,
      entity.maxRetries,
      flag(entity.streaming),
      flag(entity.enabled),
      JSON.stringify(entity.health),
      entity.createdAt,
      entity.updatedAt,
    )
    return entity
  }

  updateProvider(id: string, patch: Partial<ProviderConnection>): ProviderConnection {
    const current = this.getProvider(id)
    if (!current) throw new Error(`provider not found: ${id}`)
    const next = providerConnectionSchema.parse({ ...current, ...patch, id, updatedAt: now() })
    this.db.run(
      `UPDATE providers SET name=?, type=?, base_url=?, api_key_ref=?, default_model=?, fallback_model=?, combo=?, custom_headers=?, timeout_ms=?, max_retries=?, streaming=?, enabled=?, health=?, updated_at=? WHERE id=?`,
      next.name,
      next.type,
      next.baseUrl,
      next.apiKeyRef,
      next.defaultModel,
      next.fallbackModel,
      next.combo,
      JSON.stringify(next.customHeaders),
      next.timeoutMs,
      next.maxRetries,
      flag(next.streaming),
      flag(next.enabled),
      JSON.stringify(next.health),
      next.updatedAt,
      id,
    )
    return next
  }

  setProviderHealth(
    id: string,
    health: ProviderConnection['health'],
  ): void {
    this.db.run('UPDATE providers SET health = ?, updated_at = ? WHERE id = ?', JSON.stringify(health), now(), id)
  }

  deleteProvider(id: string): boolean {
    return this.db.run('DELETE FROM providers WHERE id = ?', id).changes > 0
  }

  /* routes ---------------------------------------------------------------- */

  listRoutes(): ModelRoute[] {
    return this.db.all<Row>('SELECT * FROM model_routes ORDER BY is_default DESC, name').map(toRoute)
  }

  getRoute(id: string): ModelRoute | null {
    const row = this.db.get<Row>('SELECT * FROM model_routes WHERE id = ?', id)
    return row ? toRoute(row) : null
  }

  getDefaultRoute(): ModelRoute | null {
    const row = this.db.get<Row>('SELECT * FROM model_routes WHERE is_default = 1 LIMIT 1')
    return row ? toRoute(row) : null
  }

  saveRoute(input: Partial<ModelRoute> & { name: string }): ModelRoute {
    const t = now()
    const existing = input.id ? this.getRoute(input.id) : this.db.get<Row>('SELECT * FROM model_routes WHERE name = ?', input.name)
    const id = existing?.id ?? input.id ?? newId('rte')
    const entity = modelRouteSchema.parse({ ...(existing ?? {}), ...input, id, createdAt: existing?.createdAt ?? t, updatedAt: t })

    if (entity.isDefault) this.db.run('UPDATE model_routes SET is_default = 0')
    this.db.run(
      `INSERT INTO model_routes (id, name, strategy, preferences, is_default, created_at, updated_at)
       VALUES (?,?,?,?,?,?,?)
       ON CONFLICT(id) DO UPDATE SET name=excluded.name, strategy=excluded.strategy, preferences=excluded.preferences, is_default=excluded.is_default, updated_at=excluded.updated_at`,
      entity.id,
      entity.name,
      entity.strategy,
      JSON.stringify(entity.preferences),
      flag(entity.isDefault),
      entity.createdAt,
      entity.updatedAt,
    )
    return entity
  }

  deleteRoute(id: string): boolean {
    return this.db.run('DELETE FROM model_routes WHERE id = ?', id).changes > 0
  }

  /* agent profiles -------------------------------------------------------- */

  listProfiles(): AgentProfile[] {
    return this.db.all<Row>('SELECT * FROM agent_profiles ORDER BY built_in DESC, name').map(toProfile)
  }

  getProfile(id: string): AgentProfile | null {
    const row = this.db.get<Row>('SELECT * FROM agent_profiles WHERE id = ?', id)
    return row ? toProfile(row) : null
  }

  getProfileByName(name: string): AgentProfile | null {
    const row = this.db.get<Row>('SELECT * FROM agent_profiles WHERE name = ?', name)
    return row ? toProfile(row) : null
  }

  saveProfile(input: Partial<AgentProfile> & { name: string; role: AgentProfile['role'] }): AgentProfile {
    const t = now()
    const existing = input.id ? this.getProfile(input.id) : this.getProfileByName(input.name)
    const id = existing?.id ?? input.id ?? newId('agp')
    const entity = agentProfileSchema.parse({ ...(existing ?? {}), ...input, id, createdAt: existing?.createdAt ?? t, updatedAt: t })
    this.db.run(
      `INSERT INTO agent_profiles (id, name, role, description, system_prompt, opencode_agent, model_preference, fallback_model, allowed_tools, timeout_ms, retry_policy, output_format, priority, built_in, enabled, created_at, updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
       ON CONFLICT(id) DO UPDATE SET name=excluded.name, role=excluded.role, description=excluded.description,
         system_prompt=excluded.system_prompt, opencode_agent=excluded.opencode_agent, model_preference=excluded.model_preference,
         fallback_model=excluded.fallback_model, allowed_tools=excluded.allowed_tools, timeout_ms=excluded.timeout_ms,
         retry_policy=excluded.retry_policy, output_format=excluded.output_format, priority=excluded.priority,
         enabled=excluded.enabled, updated_at=excluded.updated_at`,
      entity.id,
      entity.name,
      entity.role,
      entity.description,
      entity.systemPrompt,
      entity.opencodeAgent,
      entity.modelPreference ? JSON.stringify(entity.modelPreference) : null,
      entity.fallbackModel,
      entity.allowedTools ? JSON.stringify(entity.allowedTools) : null,
      entity.timeoutMs,
      JSON.stringify(entity.retryPolicy),
      entity.outputFormat,
      entity.priority,
      flag(entity.builtIn),
      flag(entity.enabled),
      entity.createdAt,
      entity.updatedAt,
    )
    return entity
  }

  deleteProfile(id: string): boolean {
    return this.db.run('DELETE FROM agent_profiles WHERE id = ?', id).changes > 0
  }

  resetBuiltinProfiles(builtins: (Partial<AgentProfile> & { name: string; role: AgentProfile['role'] })[]): AgentProfile[] {
    return this.db.tx(() => {
      for (const b of builtins) this.saveProfile({ ...b, builtIn: true })
      return this.listProfiles()
    })
  }

  /** Providers that carry a usable key reference (UI shows "needs key" otherwise). */
  providersWithKeys(): Set<string> {
    const rows = this.db.all<Row>("SELECT id FROM providers WHERE api_key_ref IS NOT NULL AND api_key_ref != ''")
    return new Set(rows.map((r) => str(r.id)))
  }

  providerCount(): { total: number; enabled: number } {
    const row = this.db.get<Row>('SELECT COUNT(*) AS total, SUM(enabled) AS enabled FROM providers')
    return { total: num(row?.total), enabled: num(row?.enabled) }
  }

  /** Routes referencing a provider, used before deleting a provider. */
  routesForProvider(providerId: string): ModelRoute[] {
    return this.db
      .all<Row>(
        `SELECT r.* FROM model_routes r, json_each(r.preferences) p
         WHERE json_extract(p.value, '$.providerId') = ?
           OR EXISTS (SELECT 1 FROM providers pr WHERE pr.id = r.id)`,
        providerId,
      )
      .map(toRoute)
  }

  getBuiltinProfile(name: string): AgentProfile | null {
    return this.getProfileByName(name)
  }

  routeCount(): number {
    return num(this.db.get<Row>('SELECT COUNT(*) AS c FROM model_routes')?.c)
  }

  healthSummary(): { configured: number; healthy: number } {
    const rows = this.db.all<Row>('SELECT health FROM providers')
    let healthy = 0
    for (const r of rows) {
      const h = j<{ status?: string }>(r.health, {})
      if (h.status === 'healthy') healthy++
    }
    return { configured: rows.length, healthy }
  }

  getPreferredModel(profile: AgentProfile): { providerId: string | null; modelId: string | null } {
    if (profile.modelPreference?.modelId) {
      return { providerId: profile.modelPreference.providerId, modelId: profile.modelPreference.modelId }
    }
    const route = this.getDefaultRoute()
    if (!route) return { providerId: null, modelId: null }
    const pref = route.preferences.find((p) => p.role === profile.role)
    if (pref?.modelId) return { providerId: pref.providerId, modelId: pref.modelId }
    return { providerId: pref?.providerId ?? null, modelId: null }
  }

  providerRef(id: string): string | null {
    return nullableStr(this.db.get<Row>('SELECT api_key_ref FROM providers WHERE id = ?', id)?.api_key_ref)
  }
}
