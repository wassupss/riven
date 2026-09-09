// What a file is, for deciding whether the editor shows Monaco or a viewer.
//
// Extension-based on purpose: it needs to be known BEFORE the file is read, so
// a 200MB video is never slurped into a string. Anything not listed here is
// treated as text, which is the existing behaviour.

export type MediaKind = 'image' | 'video' | 'audio' | 'pdf' | 'text'

const BY_EXT: Record<string, MediaKind> = {
  // Images Chromium can decode. (No .tiff/.psd — Chromium won't render them.)
  png: 'image',
  jpg: 'image',
  jpeg: 'image',
  gif: 'image',
  webp: 'image',
  bmp: 'image',
  ico: 'image',
  avif: 'image',
  // SVG is both text and an image; the editor's tab strip offers a source toggle.
  svg: 'image',
  mp4: 'video',
  webm: 'video',
  mov: 'video',
  m4v: 'video',
  ogv: 'video',
  mp3: 'audio',
  wav: 'audio',
  m4a: 'audio',
  aac: 'audio',
  flac: 'audio',
  ogg: 'audio',
  pdf: 'pdf'
}

export function mediaKind(filePath: string): MediaKind {
  const i = filePath.lastIndexOf('.')
  if (i < 0) return 'text'
  return BY_EXT[filePath.slice(i + 1).toLowerCase()] ?? 'text'
}

// An SVG can be shown as a picture OR edited as markup, so the editor keeps the
// source route available for it.
export function isTextEditable(filePath: string): boolean {
  const k = mediaKind(filePath)
  return k === 'text' || filePath.toLowerCase().endsWith('.svg')
}

export function isMarkdown(filePath: string): boolean {
  return /\.(md|markdown|mdx)$/i.test(filePath)
}

// Prose files worth pulling into notes. Narrower than "text": source code is
// text too, but importing a .ts file as a note helps nobody.
const DOC_EXT = new Set(['md', 'markdown', 'mdx', 'txt', 'text', 'rst', 'adoc', 'org'])

export function isDocFile(filePath: string): boolean {
  const base = filePath.split('/').pop() ?? filePath
  const dot = base.lastIndexOf('.')
  return dot > 0 && DOC_EXT.has(base.slice(dot + 1).toLowerCase())
}

// The URL the renderer uses to load a workspace file as media. Served by main
// (see src/main/media.ts) rather than file://, which a page on http://localhost
// (dev) is not allowed to read.
export function mediaUrl(absPath: string): string {
  return `riven-media://local/${encodeURIComponent(absPath)}`
}
