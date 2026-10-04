import { useCallback, useEffect, useRef, useState } from 'react'
import type { ApiArgs, ApiChannel, ApiResult } from '@shared/ipc'

export class ApiError extends Error {
  constructor(
    message: string,
    readonly code?: string,
  ) {
    super(message)
    this.name = 'ApiError'
  }
}

/** Fire a typed IPC call; rejects with an ApiError carrying a stable code. */
export async function call<C extends ApiChannel>(channel: C, ...args: ApiArgs<C>): Promise<ApiResult<C>> {
  const res = await window.fern.invoke(channel, ...args)
  if (!res.ok) throw new ApiError(res.error, res.code)
  return res.data
}

export interface ApiState<T> {
  data: T | null
  loading: boolean
  error: string | null
  code: string | null
  reload: () => void
}

/**
 * Declarative data fetch keyed by the serialized arguments.
 * Refetches whenever the channel or its arguments change, plus manual reloads.
 */
export function useApi<C extends ApiChannel>(
  channel: C,
  args: ApiArgs<C>,
  options: { enabled?: boolean; pollMs?: number } = {},
): ApiState<ApiResult<C>> {
  const enabled = options.enabled ?? true
  const key = JSON.stringify([channel, args])
  const [data, setData] = useState<ApiResult<C> | null>(null)
  const [loading, setLoading] = useState(enabled)
  const [error, setError] = useState<string | null>(null)
  const [code, setCode] = useState<string | null>(null)
  const [tick, setTick] = useState(0)
  const alive = useRef(true)

  useEffect(() => {
    alive.current = true
    return () => {
      alive.current = false
    }
  }, [])

  useEffect(() => {
    if (!enabled) {
      setLoading(false)
      return
    }
    let cancelled = false
    setLoading(true)
    call(channel, ...args)
      .then((result) => {
        if (cancelled || !alive.current) return
        setData(result)
        setError(null)
        setCode(null)
      })
      .catch((err: unknown) => {
        if (cancelled || !alive.current) return
        const e = err as ApiError
        setError(e.message ?? String(err))
        setCode(e.code ?? 'internal')
      })
      .finally(() => {
        if (!cancelled && alive.current) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  

  }, [key, enabled, tick])

  const reload = useCallback(() => setTick((t) => t + 1), [])

  useEffect(() => {
    if (!options.pollMs || !enabled) return
    const id = setInterval(() => setTick((t) => t + 1), options.pollMs)
    return () => clearInterval(id)
  }, [options.pollMs, enabled])

  return { data, loading, error, code, reload }
}

/** One-shot imperative action with pending/error state. */
export function useAction<C extends ApiChannel>(channel: C) {
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const run = useCallback(
    async (...args: ApiArgs<C>): Promise<ApiResult<C> | null> => {
      setPending(true)
      setError(null)
      try {
        return await call(channel, ...args)
      } catch (err) {
        const e = err as ApiError
        setError(e.message)
        return null
      } finally {
        setPending(false)
      }
    },
    [channel],
  )

  return { run, pending, error, clearError: () => setError(null) }
}
