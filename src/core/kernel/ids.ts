import { randomBytes } from 'node:crypto'

const ALPHABET = '0123456789abcdefghijklmnopqrstuvwxyz'

/** Compact, sortable-ish, collision-resistant id with a type prefix (`job_k3f9…`). */
export function newId(prefix: string): string {
  const bytes = randomBytes(10)
  let out = ''
  for (const b of bytes) out += ALPHABET[b % ALPHABET.length]
  return `${prefix}_${out}`
}

export const now = (): number => Date.now()
