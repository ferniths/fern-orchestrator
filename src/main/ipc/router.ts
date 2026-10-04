import { ipcMain } from 'electron'
import { fail, ok, IPC_PREFIX, type ApiArgs, type ApiChannel, type ApiResult } from '@shared/ipc'
import { AppError } from '@core/kernel/errors'

export type Handlers = {
  [C in ApiChannel]?: (args: ApiArgs<C>) => Promise<ApiResult<C>> | ApiResult<C>
}

/**
 * Registers one `ipcMain.handle` per channel. Handlers never throw across the
 * boundary: any error becomes a typed `{ ok: false }` envelope with a stable code.
 */
export function registerIpc(handlers: Handlers): void {
  for (const [channel, handler] of Object.entries(handlers)) {
    if (!handler) continue
    const name = IPC_PREFIX + channel
    ipcMain.removeHandler(name)
    ipcMain.handle(name, async (_event, ...args: unknown[]) => {
      try {
        const data = await (handler as (a: unknown[]) => unknown)(args)
        return ok(data)
      } catch (err) {
        const e = AppError.from(err)
        return fail(e.message, e.code)
      }
    })
  }
}
