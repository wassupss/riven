import { describe, it, expect } from 'vitest'
import { mediaKind, isTextEditable, isMarkdown, isDocFile, mediaUrl } from './mediaKind'
import { score } from './fuzzy'

describe('mediaKind', () => {
  it('classifies by extension, case-insensitively', () => {
    expect(mediaKind('a/b/shot.PNG')).toBe('image')
    expect(mediaKind('clip.mp4')).toBe('video')
    expect(mediaKind('song.flac')).toBe('audio')
    expect(mediaKind('spec.pdf')).toBe('pdf')
  })

  it('falls back to text for unknown or extensionless files', () => {
    expect(mediaKind('Makefile')).toBe('text')
    expect(mediaKind('src/index.ts')).toBe('text')
  })

  it('keeps SVG editable as source while rendering it as an image', () => {
    expect(mediaKind('icon.svg')).toBe('image')
    expect(isTextEditable('icon.svg')).toBe(true)
    expect(isTextEditable('icon.png')).toBe(false)
    expect(isTextEditable('index.ts')).toBe(true)
  })

  it('recognises markdown', () => {
    expect(isMarkdown('README.md')).toBe(true)
    expect(isMarkdown('doc.MARKDOWN')).toBe(true)
    expect(isMarkdown('page.mdx')).toBe(true)
    expect(isMarkdown('notes.txt')).toBe(false)
  })

  it('escapes the path so spaces and # survive the URL', () => {
    expect(mediaUrl('/a b/c#d.png')).toBe('riven-media://local/%2Fa%20b%2Fc%23d.png')
  })
})

describe('isDocFile', () => {
  it('accepts prose extensions only', () => {
    expect(isDocFile('docs/design.md')).toBe(true)
    expect(isDocFile('NOTES.TXT')).toBe(true)
    expect(isDocFile('src/app.ts')).toBe(false)
    expect(isDocFile('image.png')).toBe(false)
  })

  it('rejects dotfiles and extensionless files', () => {
    expect(isDocFile('.gitignore')).toBe(false)
    expect(isDocFile('LICENSE')).toBe(false)
  })
})

describe('score', () => {
  it('requires the query chars in order', () => {
    expect(score('docs/design.md', 'dsm')).toBeGreaterThanOrEqual(0)
    expect(score('docs/design.md', 'zq')).toBe(-1)
  })

  it('prefers a match starting at a path separator', () => {
    expect(score('a/readme.md', 'readme')).toBeGreaterThan(score('axreadme.md', 'readme'))
  })

  it('prefers the shorter path when the match is otherwise equal', () => {
    expect(score('readme.md', 'readme')).toBeGreaterThan(score('docs/deep/readme.md', 'readme'))
  })
})
