import type { FernBridge } from '@shared/ipc'

declare global {
  interface Window {
    fern: FernBridge
  }
}

export {}
