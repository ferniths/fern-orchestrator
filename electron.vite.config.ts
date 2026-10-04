import { resolve } from 'node:path'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

const r = (p: string) => resolve(__dirname, p)

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    resolve: {
      alias: {
        '@core': r('src/core'),
        '@shared': r('src/shared'),
      },
    },
    build: {
      rollupOptions: {
        input: { index: r('src/main/index.ts') },
      },
    },
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    resolve: {
      alias: { '@shared': r('src/shared') },
    },
    build: {
      rollupOptions: {
        input: { index: r('src/preload/index.ts') },
      },
    },
  },
  renderer: {
    resolve: {
      alias: {
        '@': r('src/renderer/src'),
        '@shared': r('src/shared'),
      },
    },
    plugins: [react(), tailwindcss()],
  },
})
