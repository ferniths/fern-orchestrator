import { app } from 'electron'
import { createCoreContext, type AppContext } from '@core/kernel/appContext'

export type { AppContext } from '@core/kernel/appContext'

/** Resolve the Electron-owned data directory, then build the shared context. */
export async function createContext(): Promise<AppContext> {
  const dataDir = process.env.FERN_DATA_DIR?.trim() || app.getPath('userData')
  return createCoreContext({ dataDir })
}
