import { contextBridge, ipcRenderer } from 'electron'
import { BUFFERED_EVENTS_CHANNEL, EVENT_CHANNEL, IPC_PREFIX, type FernBridge } from '@shared/ipc'
import type { ApiArgs, ApiChannel, IpcResult, ApiResult } from '@shared/ipc'
import type { AppEvent } from '@shared/domain'

const ERROR_NO_HANDLER = /No handler registered|could not be found/i

const bridge: FernBridge = {
  async invoke<C extends ApiChannel>(channel: C, ...args: ApiArgs<C>): Promise<IpcResult<ApiResult<C>>> {
    try {
      return (await ipcRenderer.invoke(IPC_PREFIX + channel, ...args)) as IpcResult<ApiResult<C>>
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      if (ERROR_NO_HANDLER.test(message)) {
        return { ok: false, error: `${channel} is not available yet`, code: 'not_implemented' }
      }
      return { ok: false, error: message, code: 'internal' }
    }
  },

  onEvent(listener: (event: AppEvent) => void): () => void {
    const handler = (_event: Electron.IpcRendererEvent, payload: AppEvent): void => listener(payload)
    ipcRenderer.on(EVENT_CHANNEL, handler)
    return () => ipcRenderer.off(EVENT_CHANNEL, handler)
  },

  onBufferedEvents(listener: (events: AppEvent[]) => void): () => void {
    const handler = (_event: Electron.IpcRendererEvent, payload: AppEvent[]): void => listener(payload)
    ipcRenderer.on(BUFFERED_EVENTS_CHANNEL, handler)
    return () => ipcRenderer.off(BUFFERED_EVENTS_CHANNEL, handler)
  },
}

contextBridge.exposeInMainWorld('fern', bridge)
