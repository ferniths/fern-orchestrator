import { describe, expect, it } from 'vitest'
import { isAbsolute, join, sep } from 'node:path'
import { insideVault, toVaultRel } from '@core/services/vault'

const vault = join(sep === '\\' ? 'C:\\vault-root' : '/opt', 'vault')
const posix = (p: string) => p.split('\\').join('/')

describe('insideVault', () => {
  it('accepts real children', () => {
    expect(insideVault(vault, join(vault, 'notes', 'a.md'))).toBe(true)
  })

  it('rejects the vault root itself', () => {
    expect(insideVault(vault, vault)).toBe(false)
  })

  it('rejects traversal escapes', () => {
    expect(insideVault(vault, join(vault, '..', 'outside.md'))).toBe(false)
    expect(insideVault(vault, join(vault, 'notes', '..', '..', 'outside.md'))).toBe(false)
  })

  it('rejects siblings sharing the vault prefix', () => {
    expect(insideVault(vault, `${vault}-evil${sep}x.md`)).toBe(false)
  })
})

describe('toVaultRel', () => {
  it('accepts absolute paths inside the vault', () => {
    expect(toVaultRel(vault, join(vault, 'notes', 'a.md'))).toBe('notes/a.md')
  })

  it('accepts forward-slash absolute paths', () => {
    expect(toVaultRel(vault, posix(join(vault, 'notes', 'a.md')))).toBe('notes/a.md')
  })

  it('accepts vault-relative paths unchanged', () => {
    expect(toVaultRel(vault, 'notes/a.md')).toBe('notes/a.md')
    expect(toVaultRel(vault, 'notes\\a.md')).toBe('notes/a.md')
  })

  it('normalizes inner traversal that stays inside', () => {
    expect(toVaultRel(vault, 'notes/sub/../a.md')).toBe('notes/a.md')
  })

  it('treats leading-slash input as vault-relative', () => {
    expect(toVaultRel(vault, '/notes/a.md')).toBe('notes/a.md')
  })

  it('accepts filenames that start with dots', () => {
    expect(toVaultRel(vault, join(vault, '....md'))).toBe('....md')
    expect(toVaultRel(vault, '....md')).toBe('....md')
  })

  it('rejects relative escapes', () => {
    expect(toVaultRel(vault, '../outside.md')).toBeNull()
    expect(toVaultRel(vault, 'notes/../../outside.md')).toBeNull()
  })

  it('rejects absolute paths outside the vault', () => {
    const outside = join(vault, '..', 'outside.md')
    expect(isAbsolute(outside)).toBe(true)
    expect(toVaultRel(vault, outside)).toBeNull()
    expect(toVaultRel(vault, posix(outside))).toBeNull()
  })

  it('rejects the vault root', () => {
    expect(toVaultRel(vault, vault)).toBeNull()
  })
})
