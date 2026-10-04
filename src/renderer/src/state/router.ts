import { create } from 'zustand'

function readHash(): string {
  const raw = window.location.hash.replace(/^#/, '')
  return raw.startsWith('/') ? raw : `/${raw.replace(/^\/+/, '')}`
}

interface RouterState {
  path: string
  navigate: (path: string, opts?: { replace?: boolean }) => void
}

export const useRouter = create<RouterState>((set) => ({
  path: typeof window === 'undefined' ? '/' : readHash() || '/',
  navigate: (path, opts) => {
    const target = path.startsWith('/') ? path : `/${path}`
    if (opts?.replace) window.history.replaceState(null, '', `#${target}`)
    else window.location.hash = target
    set({ path: target })
  },
}))

if (typeof window !== 'undefined') {
  window.addEventListener('hashchange', () => useRouter.setState({ path: readHash() }))
}

function safeDecode(value: string): string {
  try {
    return decodeURIComponent(value)
  } catch {
    return value
  }
}

/** Match `/jobs/:id` style patterns; returns null when the route does not apply. */
export function matchRoute(pattern: string, path: string): Record<string, string> | null {
  const hashIndex = path.indexOf('#')
  const withoutHash = hashIndex === -1 ? path : path.slice(0, hashIndex)
  const qIndex = withoutHash.indexOf('?')
  const pathname = qIndex === -1 ? withoutHash : withoutHash.slice(0, qIndex)
  const query = qIndex === -1 ? '' : withoutHash.slice(qIndex + 1)

  const p = pattern.split('/').filter(Boolean)
  const a = pathname.split('/').filter(Boolean)
  if (p.length !== a.length) return null
  const params: Record<string, string> = {}
  for (let i = 0; i < p.length; i++) {
    const seg = p[i]!
    const val = a[i]!
    if (seg.startsWith(':')) params[seg.slice(1)] = safeDecode(val)
    else if (seg !== val) return null
  }
  for (const pair of query.split('&')) {
    if (!pair) continue
    const eq = pair.indexOf('=')
    const key = safeDecode(eq === -1 ? pair : pair.slice(0, eq))
    if (!key || key in params) continue
    params[key] = safeDecode(eq === -1 ? '' : pair.slice(eq + 1))
  }
  return params
}

/** Resolve the current path against a table of patterns, in order. */
export function resolveRoute<T extends string>(
  path: string,
  patterns: readonly T[],
): { pattern: T; params: Record<string, string> } | null {
  for (const pattern of patterns) {
    const params = matchRoute(pattern, path)
    if (params) return { pattern, params }
  }
  return null
}
