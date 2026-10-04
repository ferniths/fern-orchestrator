import type { Handlers } from '../router'
import { notFound } from '@core/kernel/errors'
import type { AppContext } from '../../context'

export function opencodeHandlers(ctx: AppContext): Handlers {
  const log = ctx.log('opencode')

  return {
    'opencode.detect': () => ctx.opencode.detect(),

    'opencode.servers': () => ctx.opencode.listServers(),

    'opencode.startServer': async (args) => {
      const opts = (args[0] ?? {}) as { directory?: string }
      return ctx.opencode.startServer(opts)
    },

    'opencode.stopServer': async (args) => {
      const id = String(args[0])
      const removed = await ctx.opencode.stopServer(id)
      if (!removed) throw notFound('opencode server', id)
      return true
    },

    'opencode.agents': () => ctx.opencode.agents(),

    'opencode.sessions': async (args) => ctx.opencode.sessions(args[0] as string | undefined),

    'opencode.transcript': async (args) => ctx.opencode.nativeTranscript(String(args[0]), String(args[1])),

    'opencode.killSession': async (args) => {
      const [serverId, sessionId] = [String(args[0]), String(args[1])]
      log.info('session kill requested', { serverId, sessionId })
      return ctx.opencode.killSession(serverId, sessionId)
    },
  }
}
