import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { git, parsePorcelainV2, status } from '@core/services/git'

const SAMPLE = [
  '# branch.oid 7f86b98cefcaf857907a85393b51395a3ae16b7b',
  '# branch.head main',
  '# branch.ab +2 -1',
  '1 .M N... 100644 100644 100644 587be6b4c3f93f93c489c0111bba5596147a26cb 587be6b4c3f93f93c489c0111bba5596147a26cb a b.txt',
  '1 M. N... 100644 100644 100644 587be6b4c3f93f93c489c0111bba5596147a26cb 587be6b4c3f93f93c489c0111bba5596147a26cb staged file.md',
  '1 MM N... 100644 100644 100644 587be6b4c3f93f93c489c0111bba5596147a26cb 587be6b4c3f93f93c489c0111bba5596147a26cb both stages.txt',
  "2 R. N... 100644 100644 100644 975fbec8256d3e8a3797e7a3611380f27c49f4ac 975fbec8256d3e8a3797e7a3611380f27c49f4ac R100 renamed file.txt\tname-with-'quote'.txt",
  'u UU N... 100644 100644 100644 100644 aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb cccccccccccccccccccccccccccccccccccccccc conflicted file.txt',
  '? new file.txt',
  '! ignored.log',
].join('\n')

describe('parsePorcelainV2', () => {
  it('reads branch, ahead/behind and detached state', () => {
    const out = parsePorcelainV2(SAMPLE)
    expect(out.branch).toBe('main')
    expect(out.detached).toBe(false)
    expect(out.ahead).toBe(2)
    expect(out.behind).toBe(1)

    const detached = parsePorcelainV2('# branch.head (detached)\n1 .M N... 100644 100644 100644 h h x.txt')
    expect(detached.branch).toBeNull()
    expect(detached.detached).toBe(true)
  })

  it('extracts paths verbatim, including spaces, instead of the mode/hash columns', () => {
    const out = parsePorcelainV2(SAMPLE)
    expect(out.unstaged).toEqual(['a b.txt', 'both stages.txt'])
    expect(out.staged).toEqual(['staged file.md', 'both stages.txt', "renamed file.txt"])
    expect(out.untracked).toEqual(['new file.txt'])
    expect(out.conflicted).toEqual(['conflicted file.txt'])
  })

  it('takes the current path of a rename (tab-separated) and drops the origin path', () => {
    const out = parsePorcelainV2(SAMPLE)
    expect(out.staged).toContain("renamed file.txt")
    expect(out.staged.join('\n')).not.toContain('name-with-')
  })

  it('ignores headers and empty lines', () => {
    const out = parsePorcelainV2('\n# branch.head main\n')
    expect(out.staged).toEqual([])
    expect(out.unstaged).toEqual([])
    expect(out.untracked).toEqual([])
  })
})

describe('status() against a real repository', () => {
  let dir: string

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'fern-gitstatus-'))
    await git(['init', '-q'], { cwd: dir })
    await git(['config', 'user.email', 'test@example.com'], { cwd: dir })
    await git(['config', 'user.name', 'test'], { cwd: dir })
    await writeFile(join(dir, 'a b.txt'), 'one\n')
    await writeFile(join(dir, 'keep.txt'), 'keep\n')
    await git(['add', '-A'], { cwd: dir })
    await git(['commit', '-qm', 'init'], { cwd: dir })
  })

  afterAll(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  it('reports modified, renamed and untracked files by real path', async () => {
    await writeFile(join(dir, 'a b.txt'), 'two\n')
    await writeFile(join(dir, 'brand new.txt'), 'new\n')
    // Staged rename: a plain fs rename would only show delete + untracked.
    await git(['mv', 'keep.txt', 'kept renamed.txt'], { cwd: dir })

    const st = await status(dir)
    expect(st.isRepo).toBe(true)
    expect(st.unstaged).toContain('a b.txt')
    expect(st.untracked).toContain('brand new.txt')
    expect(st.staged).toContain('kept renamed.txt')

    // No column debris: every entry must look like a path, not `N... 100644 …`.
    for (const p of [...st.staged, ...st.unstaged, ...st.untracked]) {
      expect(p).not.toMatch(/^(1|2|u) /)
      expect(p).not.toContain('N...')
      expect(p).not.toMatch(/\b[0-9a-f]{40}\b/)
    }
  })

  it('reports a clean tree when nothing changed', async () => {
    await git(['add', '-A'], { cwd: dir })
    await git(['commit', '-qm', 'second'], { cwd: dir })
    const st = await status(dir)
    expect(st.staged).toEqual([])
    expect(st.unstaged).toEqual([])
    expect(st.untracked).toEqual([])
    expect(st.branch).toBeTruthy()
  })
})
