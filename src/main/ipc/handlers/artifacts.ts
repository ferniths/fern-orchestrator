import type { Handlers } from '../router'
import type { AppContext } from '../../context'

export function artifactHandlers(ctx: AppContext): Handlers {
  return {
    'artifacts.list': (args) => ctx.repos.workers.listArtifacts(String(args[0])),
  }
}
