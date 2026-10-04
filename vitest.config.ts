import { resolve } from 'node:path'
import { defineConfig } from 'vitest/config'

const r = (p: string): string => resolve(__dirname, p)

export default defineConfig({
  resolve: {
    alias: {
      '@core': r('src/core'),
      '@shared': r('src/shared'),
      '@': r('src/renderer/src'),
    },
  },
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    pool: 'forks',
    testTimeout: 30_000,
    hookTimeout: 30_000,
    reporters: ['default'],
  },
})
