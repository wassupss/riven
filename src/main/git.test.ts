import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { execFileSync } from 'child_process'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { removeUntracked, stashList } from './git'

let base: string
let repo: string
let outside: string

beforeEach(() => {
  base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'riven-git-test-')))
  repo = path.join(base, 'repo')
  outside = path.join(base, 'outside')
  fs.mkdirSync(repo)
  fs.mkdirSync(outside)
  fs.writeFileSync(path.join(outside, 'keep.txt'), 'k')
})

afterEach(() => {
  fs.rmSync(base, { recursive: true, force: true })
})

const gitIn = (args: string[]): string =>
  execFileSync('git', ['-C', repo, '-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false', ...args], {
    encoding: 'utf8'
  })

describe('stashList', () => {
  // %00 is for-each-ref's NUL; git log's pretty format (stash list) needs %x00,
  // otherwise the line never splits and every subject is empty.
  it('returns each stash ref with its subject', async () => {
    gitIn(['init', '-q', '-b', 'main'])
    fs.writeFileSync(path.join(repo, 'a.txt'), '1')
    gitIn(['add', 'a.txt'])
    gitIn(['commit', '-q', '-m', 'first'])
    fs.writeFileSync(path.join(repo, 'a.txt'), '2')
    gitIn(['stash', 'push', '-q'])
    fs.writeFileSync(path.join(repo, 'a.txt'), '3')
    gitIn(['stash', 'push', '-q', '-m', 'my stash title'])
    const list = await stashList(repo)
    expect(list).toHaveLength(2)
    expect(list[0]).toEqual({ ref: 'stash@{0}', subject: 'On main: my stash title' })
    expect(list[1].ref).toBe('stash@{1}')
    expect(list[1].subject).toMatch(/^WIP on main: /)
  })

  it('is empty outside a repository', async () => {
    expect(await stashList(outside)).toEqual([])
  })
})

describe('removeUntracked', () => {
  it('removes an untracked folder as git names it (dir/) with everything in it', async () => {
    fs.mkdirSync(path.join(repo, 'newdir/sub'), { recursive: true })
    fs.writeFileSync(path.join(repo, 'newdir/sub/a.txt'), 'a')
    // A symlink inside must be removed, not followed.
    fs.symlinkSync(outside, path.join(repo, 'newdir/link'))
    expect(await removeUntracked(repo, 'newdir/')).toEqual({ ok: true })
    expect(fs.existsSync(path.join(repo, 'newdir'))).toBe(false)
    expect(fs.existsSync(path.join(outside, 'keep.txt'))).toBe(true)
  })

  it('removes a symlink to a folder named with a trailing slash, not its target', async () => {
    fs.symlinkSync(outside, path.join(repo, 'ln'))
    expect(await removeUntracked(repo, 'ln/')).toEqual({ ok: true })
    expect(() => fs.lstatSync(path.join(repo, 'ln'))).toThrow()
    expect(fs.existsSync(path.join(outside, 'keep.txt'))).toBe(true)
  })

  it('removes a file and treats an already missing path as done', async () => {
    fs.writeFileSync(path.join(repo, 'f.txt'), 'f')
    expect(await removeUntracked(repo, 'f.txt')).toEqual({ ok: true })
    expect(fs.existsSync(path.join(repo, 'f.txt'))).toBe(false)
    expect(await removeUntracked(repo, 'gone.txt')).toEqual({ ok: true })
    expect(await removeUntracked(repo, 'nodir/gone.txt')).toEqual({ ok: true })
  })

  it('refuses the repo itself and anything outside it', async () => {
    for (const rel of ['', '.', './', '../outside', 'a/../../outside', outside, '/etc']) {
      const r = await removeUntracked(repo, rel)
      expect(r.ok, rel).toBe(false)
      expect(r.error).toMatch(/not inside the repository/)
    }
    expect(fs.existsSync(repo)).toBe(true)
    expect(fs.existsSync(path.join(outside, 'keep.txt'))).toBe(true)
  })

  it('refuses a path reached through a symlinked parent folder', async () => {
    fs.symlinkSync(outside, path.join(repo, 'ln'))
    const r = await removeUntracked(repo, 'ln/keep.txt')
    expect(r.ok).toBe(false)
    expect(fs.existsSync(path.join(outside, 'keep.txt'))).toBe(true)
  })

  it('reports a failed delete as ok:false', async () => {
    fs.mkdirSync(path.join(repo, 'locked'))
    fs.writeFileSync(path.join(repo, 'locked/f.txt'), 'f')
    fs.chmodSync(path.join(repo, 'locked'), 0o500)
    try {
      const r = await removeUntracked(repo, 'locked/f.txt')
      if (process.getuid?.() === 0) return // root ignores the permission bits
      expect(r.ok).toBe(false)
      expect(r.error).toBeTruthy()
    } finally {
      fs.chmodSync(path.join(repo, 'locked'), 0o700)
    }
  })
})
