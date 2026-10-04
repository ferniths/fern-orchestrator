export function cn(...parts: (string | false | null | undefined)[]): string {
  return parts.filter(Boolean).join(' ')
}

export function timeAgo(ts: number | null | undefined): string {
  if (!ts) return '—'
  const diff = Date.now() - ts
  if (diff < 0) return 'just now'
  const s = Math.floor(diff / 1000)
  if (s < 45) return `${s}s ago`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m ago`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h}h ago`
  const d = Math.floor(h / 24)
  if (d < 30) return `${d}d ago`
  return new Date(ts).toLocaleDateString()
}

export function clockTime(ts: number | null | undefined): string {
  if (!ts) return '—'
  return new Date(ts).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', second: '2-digit' })
}

export function fullTime(ts: number | null | undefined): string {
  if (!ts) return '—'
  return new Date(ts).toLocaleString()
}

export function duration(ms: number | null | undefined): string {
  if (ms == null || ms <= 0) return '—'
  const s = Math.floor(ms / 1000)
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m ${s % 60}s`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h}h ${m % 60}m`
  return `${Math.floor(h / 24)}d ${h % 24}h`
}

export function bytes(n: number | null | undefined): string {
  if (n == null || n <= 0) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB']
  let v = n
  let i = 0
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024
    i++
  }
  return `${v.toFixed(v < 10 && i > 0 ? 1 : 0)} ${units[i]}`
}

export function tokens(n: number | null | undefined): string {
  if (!n) return '0'
  if (n < 1000) return String(n)
  if (n < 1_000_000) return `${(n / 1000).toFixed(n < 10_000 ? 1 : 0)}k`
  return `${(n / 1_000_000).toFixed(1)}M`
}

export function money(n: number | null | undefined): string {
  if (!n) return '$0'
  if (n < 0.01) return `$${n.toFixed(4)}`
  return `$${n.toFixed(2)}`
}

export function shortId(id: string | null | undefined): string {
  if (!id) return '—'
  const parts = id.split('_')
  const tail = parts[parts.length - 1] ?? id
  return parts.length > 1 ? `${parts[0]}_${tail.slice(0, 6)}` : tail.slice(0, 10)
}

export function truncate(s: string | null | undefined, max = 120): string {
  if (!s) return ''
  return s.length > max ? `${s.slice(0, max - 1)}…` : s
}

/** Best-effort guess of a project/language from paths, for list glyphs. */
export function kindGlyph(kind: string): string {
  const map: Record<string, string> = {
    task: '▢',
    gate: '◈',
    condition: '⑂',
    integration: '⧉',
    review: '◎',
    final: '◆',
    research: '⌕',
    implementation: '✎',
    validation: '✓',
  }
  return map[kind] ?? '▢'
}
