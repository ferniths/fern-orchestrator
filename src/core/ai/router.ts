import type { AgentRole, ModelInfo, ModelRoute, ProviderConnection } from '@shared/domain'

export interface RouteTarget {
  providerId: string
  modelId: string
  reason: string
}

export interface RouteDecision {
  primary: RouteTarget
  /** Ordered fallbacks tried when the primary fails with a retryable error. */
  fallbacks: RouteTarget[]
  routeId: string | null
}

export interface ResolveInput {
  role: AgentRole
  route: ModelRoute | null
  providers: ProviderConnection[]
  /** providerId → models discovered from that provider. */
  catalog: Map<string, ModelInfo[]>
  /** Direct override from a task / agent profile (providerId and/or modelId). */
  override?: { providerId?: string | null; modelId?: string | null } | null
  complexity?: 'low' | 'medium' | 'high'
}

const HEALTH_ORDER: Record<ProviderConnection['health']['status'], number> = {
  healthy: 0,
  degraded: 1,
  unknown: 2,
  unreachable: 3,
}

function usable(providers: ProviderConnection[]): ProviderConnection[] {
  return providers.filter((p) => p.enabled)
}

function splitModelId(value: string, providers: ProviderConnection[]): { providerId: string | null; modelId: string } {
  const idx = value.indexOf('/')
  if (idx > 0) {
    const prefix = value.slice(0, idx)
    if (providers.some((p) => p.id === prefix || p.name === prefix)) {
      return { providerId: providers.find((p) => p.id === prefix || p.name === prefix)?.id ?? null, modelId: value.slice(idx + 1) }
    }
  }
  return { providerId: null, modelId: value }
}

/** Locates which provider serves a given model id (exact default, catalog, or suffix match). */
function locateModel(modelId: string, providers: ProviderConnection[], catalog: Map<string, ModelInfo[]>): { providerId: string; modelId: string } | null {
  const { providerId, modelId: bare } = splitModelId(modelId, providers)
  if (providerId) {
    const p = providers.find((x) => x.id === providerId)
    if (p) return { providerId: p.id, modelId: bare }
  }
  for (const p of providers) {
    if (p.defaultModel === bare || p.defaultModel === modelId) return { providerId: p.id, modelId: bare }
    if (p.fallbackModel === bare || p.fallbackModel === modelId) return { providerId: p.id, modelId: bare }
    const models = catalog.get(p.id) ?? []
    const hit =
      models.find((m) => m.id === modelId || m.id === bare) ??
      // Boundary-qualified suffix only: a bare `endsWith(bare)` would let `a3`
      // resolve to `llama3` and silently route to the wrong model.
      models.find((m) => m.id.endsWith(`/${bare}`) || m.id.endsWith(`:${bare}`))
    if (hit) return { providerId: p.id, modelId: hit.id }
  }
  return null
}

function bestProvider(providers: ProviderConnection[]): ProviderConnection | null {
  const list = usable(providers)
  if (list.length === 0) return null
  return [...list].sort((a, b) => HEALTH_ORDER[a.health.status] - HEALTH_ORDER[b.health.status])[0] ?? null
}

function defaultModelFor(provider: ProviderConnection, catalog: Map<string, ModelInfo[]>): string | null {
  if (provider.defaultModel) return provider.defaultModel
  const models = catalog.get(provider.id) ?? []
  return models[0]?.id ?? null
}

/**
 * Resolves the concrete provider/model for an agent role.
 * Precedence: explicit override → route preference for the role → route default/automatic.
 * Returns null when no usable provider is configured (callers surface onboarding instead).
 */
export function resolveModel(input: ResolveInput): RouteDecision | null {
  const providers = usable(input.providers)
  if (providers.length === 0) return null
  const route = input.route
  const reasonParts: string[] = []

  /* 1. direct override ------------------------------------------------- */
  if (input.override && (input.override.modelId || input.override.providerId)) {
    const scoped = input.override.providerId ? providers.filter((p) => p.id === input.override!.providerId) : providers
    const modelId = input.override.modelId
    if (modelId) {
      const located = locateModel(modelId, scoped.length ? scoped : providers, input.catalog)
      if (located) {
        reasonParts.push(`override ${located.modelId}`)
        return build(located.providerId, located.modelId, reasonParts.join(', '), providers, input.catalog, route?.id ?? null)
      }
      // Trust an explicit override even when it is not in the discovered catalog
      // (combos and freshly published models routinely are not listed yet).
      const p = scoped[0] ?? bestProvider(providers)
      if (p) {
        reasonParts.push(`override ${modelId}`)
        return build(p.id, modelId, reasonParts.join(', '), providers, input.catalog, route?.id ?? null)
      }
    }
    const p = scoped[0] ?? bestProvider(providers)
    if (p) {
      const fallback = defaultModelFor(p, input.catalog)
      if (fallback) {
        reasonParts.push(`override provider ${p.name}`)
        return build(p.id, fallback, reasonParts.join(', '), providers, input.catalog, route?.id ?? null)
      }
    }
  }

  /* 2. explicit route preference for this role ------------------------- */
  if (route && route.strategy === 'explicit') {
    const pref = route.preferences.find((p) => p.role === input.role)
    if (pref) {
      const scoped = pref.providerId ? providers.filter((p) => p.id === pref.providerId) : providers
      if (pref.modelId) {
        const located = locateModel(pref.modelId, scoped.length ? scoped : providers, input.catalog)
        if (located) {
          reasonParts.push(`route "${route.name}" → ${input.role}`)
          return build(located.providerId, located.modelId, reasonParts.join(' '), providers, input.catalog, route.id)
        }
      } else if (scoped[0]) {
        const model = defaultModelFor(scoped[0], input.catalog)
        if (model) {
          reasonParts.push(`route "${route.name}" → ${input.role} (provider default)`)
          return build(scoped[0].id, model, reasonParts.join(' '), providers, input.catalog, route.id)
        }
      }
      if (pref.fallbackModelId) {
        const located = locateModel(pref.fallbackModelId, providers, input.catalog)
        if (located) {
          reasonParts.push(`route fallback for ${input.role}`)
          return build(located.providerId, located.modelId, reasonParts.join(' '), providers, input.catalog, route.id)
        }
      }
    }
  }

  /* 3. automatic: healthiest provider with a usable default ------------- */
  const primary = bestProvider(providers)
  if (!primary) return null
  const model = defaultModelFor(primary, input.catalog)
  if (!model) return null
  reasonParts.push(`automatic (${primary.health.status})`)
  if (route) reasonParts.push(`route "${route.name}"`)
  return build(primary.id, model, reasonParts.join(' · '), providers, input.catalog, route?.id ?? null)
}

function build(
  providerId: string,
  modelId: string,
  reason: string,
  providers: ProviderConnection[],
  catalog: Map<string, ModelInfo[]>,
  routeId: string | null,
): RouteDecision {
  const primary: RouteTarget = { providerId, modelId, reason }
  const primaryProvider = providers.find((p) => p.id === providerId)
  const fallbacks: RouteTarget[] = []
  // Key must be a single-element array: `new Set(string)` iterates characters,
  // which made every primary target look unseen and duplicated it as its own first fallback.
  const seen = new Set([`${providerId}/${modelId}`])

  const push = (p: ProviderConnection, m: string | null, why: string) => {
    const target = m ?? defaultModelFor(p, catalog)
    if (!target) return
    const key = `${p.id}/${target}`
    if (seen.has(key)) return
    seen.add(key)
    fallbacks.push({ providerId: p.id, modelId: target, reason: why })
  }

  if (primaryProvider?.fallbackModel) push(primaryProvider, primaryProvider.fallbackModel, 'connection fallback')
  for (const p of [...providers].sort((a, b) => HEALTH_ORDER[a.health.status] - HEALTH_ORDER[b.health.status])) {
    if (fallbacks.length >= 3) break
    push(p, null, `alternate provider ${p.name}`)
  }

  return { primary, fallbacks, routeId }
}
