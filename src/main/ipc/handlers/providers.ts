import type { AgentProfile, ModelRoute, ProviderConnection } from '@shared/domain'
import type { Handlers } from '../router'
import { AppError, invalid, notFound } from '@core/kernel/errors'
import { Keystore } from '@core/security/keystore'
import { fetchModels } from '@core/ai/models'
import { BUILTIN_PROFILES } from '@core/config/builtins'
import type { AppContext } from '../../context'

export function providerHandlers(ctx: AppContext): Handlers {
  const log = ctx.log('provider')

  const keyRef = (providerId: string): string => Keystore.refFor('provider', providerId)
  const readKey = (providerId: string): string | null => ctx.keystore.get(keyRef(providerId))

  return {
    'providers.list': () => ctx.repos.providers.listProviders(),

    'providers.create': async (args) => {
      const input = args[0] as Partial<ProviderConnection> & { name: string; baseUrl: string; apiKey?: string }
      if (!input?.name?.trim()) throw invalid('provider name is required')
      if (!input.baseUrl?.trim()) throw invalid('provider base URL is required')

      const provider = ctx.repos.providers.createProvider({ ...input, apiKeyRef: null })
      if (input.apiKey) {
        ctx.keystore.set(keyRef(provider.id), input.apiKey)
        ctx.repos.providers.updateProvider(provider.id, { apiKeyRef: keyRef(provider.id) })
      }
      ctx.ai.invalidateCatalog(provider.id)
      // Not `provider.connected`: nothing has been dialled yet. The user still
      // has to hit Test connection before any health claim is true.
      ctx.emit('provider.added', { message: `provider added: ${provider.name} (not yet tested)` })
      log.info('provider created', { id: provider.id, baseUrl: provider.baseUrl })
      return ctx.repos.providers.getProvider(provider.id) ?? provider
    },

    'providers.update': async (args) => {
      const [id, patch] = args as [string, Partial<ProviderConnection> & { apiKey?: string }]
      const current = ctx.repos.providers.getProvider(id)
      if (!current) throw notFound('provider', id)
      const { apiKey, ...rest } = patch
      const next = ctx.repos.providers.updateProvider(id, rest)
      if (apiKey !== undefined) {
        if (apiKey) {
          ctx.keystore.set(keyRef(id), apiKey)
          ctx.repos.providers.updateProvider(id, { apiKeyRef: keyRef(id) })
        } else {
          ctx.keystore.delete(keyRef(id))
          ctx.repos.providers.updateProvider(id, { apiKeyRef: null })
        }
      }
      // Editing baseUrl/model invalidates discovery — without this the 10-minute
      // catalog cache keeps serving the previous model list.
      ctx.ai.invalidateCatalog(id)
      return ctx.repos.providers.getProvider(id) ?? next
    },

    'providers.delete': async (args) => {
      const id = String(args[0])
      const removed = ctx.repos.providers.deleteProvider(id)
      ctx.keystore.delete(keyRef(id))
      ctx.ai.invalidateCatalog(id)
      if (removed) ctx.emit('provider.failed', { message: 'provider removed', severity: 'warn' })
      return removed
    },

    'providers.hasKey': (args) => ctx.keystore.has(keyRef(String(args[0]))),

    'providers.models': async (args) => {
      const provider = ctx.repos.providers.getProvider(String(args[0]))
      if (!provider) throw notFound('provider', String(args[0]))
      const { models } = await fetchModels(provider, readKey(provider.id))
      return models.map((m) => ({ ...m, providerId: provider.id }))
    },

    'providers.test': async (args) => {
      const provider = ctx.repos.providers.getProvider(String(args[0]))
      if (!provider) throw notFound('provider', String(args[0]))
      const key = readKey(provider.id)
      try {
        const { models, latencyMs } = await fetchModels(provider, key)
        // Reachable is not the same as usable: an empty model list means the
        // endpoint answered but has nothing to route to, so do not claim healthy.
        const empty = models.length === 0
        const health: ProviderConnection['health'] = {
          status: empty ? 'degraded' : 'healthy',
          latencyMs,
          checkedAt: Date.now(),
          modelCount: models.length,
          lastError: empty ? 'reachable but the endpoint returned 0 models' : null,
          lastSuccessAt: Date.now(),
        }
        ctx.repos.providers.updateProvider(provider.id, { health })
        ctx.ai.invalidateCatalog(provider.id)
        ctx.emit(empty ? 'provider.failed' : 'provider.health', {
          message: empty ? `${provider.name}: reachable but returned 0 models` : `${provider.name} healthy (${models.length} models)`,
          severity: empty ? 'warn' : 'info',
        })
        return {
          ok: !empty,
          latencyMs,
          message: empty ? 'reachable, but 0 models returned' : `${models.length} models`,
          models: models.map((m) => ({ ...m, providerId: provider.id })),
        }
      } catch (err) {
        const e = AppError.from(err, 'provider_error')
        const health: ProviderConnection['health'] = {
          // An auth failure still proves the endpoint answered — that is
          // "reachable but failing", not "unreachable".
          status: e.code === 'unavailable' ? 'unreachable' : e.code === 'timeout' || e.code === 'provider_auth' ? 'degraded' : 'unreachable',
          latencyMs: null,
          checkedAt: Date.now(),
          modelCount: null,
          lastError: e.message,
          lastSuccessAt: provider.health.lastSuccessAt,
        }
        ctx.repos.providers.updateProvider(provider.id, { health })
        ctx.emit('provider.failed', { message: `${provider.name}: ${e.message}`, severity: 'error' })
        log.warn('provider test failed', { id: provider.id, error: e.message })
        return { ok: false, latencyMs: null, message: e.message, models: [] }
      }
    },

    /* model routes ---------------------------------------------------------- */

    'routes.list': () => ctx.repos.providers.listRoutes(),

    'routes.save': (args) => ctx.repos.providers.saveRoute(args[0] as Partial<ModelRoute> & { name: string }),

    'routes.delete': (args) => ctx.repos.providers.deleteRoute(String(args[0])),

    /* agent profiles --------------------------------------------------------- */

    'agents.list': () => ctx.repos.providers.listProfiles(),

    'agents.save': (args) => ctx.repos.providers.saveProfile(args[0] as Partial<AgentProfile> & { name: string; role: AgentProfile['role'] }),

    'agents.delete': (args) => ctx.repos.providers.deleteProfile(String(args[0])),

    'agents.resetBuiltins': () => ctx.repos.providers.resetBuiltinProfiles(BUILTIN_PROFILES),
  }
}

/** Idempotent: ensures built-in profiles exist on first boot. */
export function seedBuiltins(ctx: AppContext): void {
  if (ctx.repos.providers.listProfiles().length > 0) return
  ctx.repos.providers.resetBuiltinProfiles(BUILTIN_PROFILES)
  ctx.log('app').info('seeded built-in agent profiles', { count: BUILTIN_PROFILES.length })
}
