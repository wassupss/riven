import { afterEach, describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, unlinkSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { binIdentity } from './shellPath'

const dirs: string[] = []
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

describe('binIdentity', () => {
  it('changes when an update re-points the symlink (native installer)', async () => {
    const d = mkdtempSync(join(tmpdir(), 'riven-bin-'))
    dirs.push(d)
    mkdirSync(join(d, 'versions'))
    writeFileSync(join(d, 'versions', '2.1.280'), '#!/bin/sh\n')
    writeFileSync(join(d, 'versions', '2.1.290'), '#!/bin/sh\n')
    const link = join(d, 'claude')
    symlinkSync(join(d, 'versions', '2.1.280'), link)
    const before = await binIdentity(link)
    unlinkSync(link)
    symlinkSync(join(d, 'versions', '2.1.290'), link)
    expect(await binIdentity(link)).not.toBe(before)
  })

  it('changes when an update rewrites the file in place (npm)', async () => {
    const d = mkdtempSync(join(tmpdir(), 'riven-bin-'))
    dirs.push(d)
    const file = join(d, 'cli.js')
    writeFileSync(file, 'v1')
    utimesSync(file, new Date(1_000_000), new Date(1_000_000))
    const before = await binIdentity(file)
    writeFileSync(file, 'v2')
    utimesSync(file, new Date(2_000_000), new Date(2_000_000))
    expect(await binIdentity(file)).not.toBe(before)
  })

  it('is the same for the same build, and null for nothing', async () => {
    const d = mkdtempSync(join(tmpdir(), 'riven-bin-'))
    dirs.push(d)
    writeFileSync(join(d, 'x'), 'same')
    expect(await binIdentity(join(d, 'x'))).toBe(await binIdentity(join(d, 'x')))
    expect(await binIdentity(null)).toBeNull()
    expect(await binIdentity(join(d, 'missing'))).toBeNull()
  })
})
