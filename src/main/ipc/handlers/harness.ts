import { AppError } from '@core/kernel/errors'
import { runHealthCheck } from '@core/orchestration/harnessHealth'
import { runSelfTest, type SelfTestRunOptions } from '@core/orchestration/selfTest'
import type { AppContext } from '../../context'
import type { Handlers } from '../router'

/** Harness channels: live component health check + end-to-end self-test. */
export function harnessHandlers(ctx: AppContext): Handlers {
  const log = ctx.log('orchestration')
  /** The single in-flight self-test (also the cancel target). */
  let activeRun: AbortController | null = null

  return {
    'harness.health': async () => {
      const report = await runHealthCheck(ctx)
      log.info('health check finished', { status: report.status, durationMs: report.durationMs })
      return report
    },

    'harness.selfTest': async (args) => {
      const opts = (args[0] ?? {}) as { mode?: 'diagnostics' | 'selfTest'; timeoutMs?: number }
      if (activeRun) throw new AppError('conflict', 'a harness self-test is already running')

      const controller = new AbortController()
      activeRun = controller
      try {
        const runOpts: SelfTestRunOptions = { mode: opts.mode ?? 'selfTest', signal: controller.signal }
        if (opts.timeoutMs && opts.timeoutMs > 0) runOpts.timeoutMs = opts.timeoutMs
        const report = await runSelfTest(ctx, runOpts)
        log.info('self-test finished', { mode: report.mode, status: report.status, durationMs: report.durationMs, reason: report.reason })
        return report
      } finally {
        activeRun = null
      }
    },

    'harness.selfTestCancel': () => {
      if (!activeRun) return false
      activeRun.abort()
      log.info('self-test cancel requested')
      return true
    },
  }
}
