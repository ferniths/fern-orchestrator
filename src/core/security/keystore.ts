import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto'
import { chmodSync, copyFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { AppError } from '../kernel/errors'

/**
 * Local secret store (API keys).
 *
 * Design: a 32-byte master key is generated once and kept in a mode-0600 file
 * next to the database. Entries are AES-256-GCM encrypted with a fresh IV each.
 * The OS account boundary is the security boundary — this protects keys from
 * casual disclosure in logs/backups, not from an attacker with the user's login.
 * Nothing ever leaves the machine and plaintext never touches the database.
 */
interface KeyFile {
  v: 1
  key: string
  entries: Record<string, string>
}

const B64 = 'base64'

export class Keystore {
  private data: KeyFile
  private readonly cache = new Map<string, string>()
  private chain: Promise<void> = Promise.resolve()

  constructor(private readonly filePath: string) {
    this.data = Keystore.load(filePath)
  }

  private static load(filePath: string): KeyFile {
    try {
      const raw = readFileSync(filePath, 'utf8')
      const parsed = JSON.parse(raw) as KeyFile
      if (parsed.v === 1 && typeof parsed.key === 'string' && parsed.entries) return parsed
    } catch {
      /* missing or corrupt → rotate to a fresh key file */
    }
    // A file that *existed* but could not be parsed would otherwise be silently
    // overwritten on the next write, destroying every stored key forever.
    // Keep the bytes around so the keys stay recoverable.
    try {
      if (readFileSync(filePath).length > 0) copyFileSync(filePath, `${filePath}.corrupt-${Date.now()}`)
    } catch {
      /* missing → nothing to preserve */
    }
    return { v: 1, key: randomBytes(32).toString(B64), entries: {} }
  }

  private secret(): Buffer {
    return Buffer.from(this.data.key, B64)
  }

  has(ref: string): boolean {
    return Boolean(this.data.entries[ref]) || this.cache.has(ref)
  }

  refs(): string[] {
    return Object.keys(this.data.entries)
  }

  get(ref: string): string | null {
    const cached = this.cache.get(ref)
    if (cached !== undefined) return cached
    const envelope = this.data.entries[ref]
    if (!envelope) return null
    try {
      const [ivHex, tagHex, ctHex] = envelope.split(':')
      if (!ivHex || !tagHex || !ctHex) return null
      const decipher = createDecipheriv('aes-256-gcm', this.secret(), Buffer.from(ivHex, 'hex'))
      decipher.setAuthTag(Buffer.from(tagHex, 'hex'))
      const plain = Buffer.concat([decipher.update(Buffer.from(ctHex, 'hex')), decipher.final()]).toString('utf8')
      this.cache.set(ref, plain)
      return plain
    } catch (err) {
      throw new AppError('internal', `secret ${ref} could not be decrypted`, { cause: err })
    }
  }

  set(ref: string, value: string): void {
    if (!value) {
      this.delete(ref)
      return
    }
    const iv = randomBytes(12)
    const cipher = createCipheriv('aes-256-gcm', this.secret(), iv)
    const ct = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()])
    const tag = cipher.getAuthTag()
    this.data.entries[ref] = [iv.toString('hex'), tag.toString('hex'), ct.toString('hex')].join(':')
    this.cache.set(ref, value)
    this.persist()
  }

  delete(ref: string): void {
    delete this.data.entries[ref]
    this.cache.delete(ref)
    this.persist()
  }

  /** Stable, non-reversible reference for a secret (used as the DB column value). */
  static refFor(scope: string, id: string): string {
    return `${scope}_${createHash('sha256').update(`${scope}:${id}`).digest('hex').slice(0, 16)}`
  }

  private persist(): void {
    const payload = JSON.stringify(this.data)
    // A rejected write must not poison the queue: without the leading catch,
    // every later set()/delete() would silently skip and the keys would only
    // be reported lost at shutdown. The catch on the *previous* link keeps the
    // chain usable while this link's rejection still reaches flush().
    this.chain = this.chain
      .catch(() => undefined)
      .then(() => {
        try {
          mkdirSync(dirname(this.filePath), { recursive: true })
          writeFileSync(this.filePath, payload, { encoding: 'utf8', mode: 0o600 })
          try {
            chmodSync(this.filePath, 0o600)
          } catch {
            /* Windows ignores POSIX modes */
          }
        } catch (err) {
          throw new AppError('internal', 'failed to persist keystore', { cause: err })
        }
      })
  }

  async flush(): Promise<void> {
    await this.chain
  }
}
