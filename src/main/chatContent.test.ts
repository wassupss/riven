import { describe, it, expect } from 'vitest'
import { userContent, isUsableImage, MAX_IMAGE_BASE64 } from './chatContent'

const png = { mediaType: 'image/png', data: 'iVBORw0KGgo=', name: 'a.png' }

describe('userContent', () => {
  // Every message without an attachment must go out exactly as it did before.
  it('is the plain string when nothing is attached', () => {
    expect(userContent('hello')).toBe('hello')
    expect(userContent('hello', [])).toBe('hello')
  })

  it('sends text then images as content blocks', () => {
    expect(userContent('what is this?', [png])).toEqual([
      { type: 'text', text: 'what is this?' },
      { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'iVBORw0KGgo=' } }
    ])
  })

  // Dropping a screenshot and pressing Enter with nothing typed is a real use.
  it('sends an image alone when there is no text', () => {
    expect(userContent('   ', [png])).toEqual([
      { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'iVBORw0KGgo=' } }
    ])
  })

  it('keeps several images in the order they were attached', () => {
    const out = userContent('compare', [png, { ...png, mediaType: 'image/jpeg', data: 'SGVsbG8=' }])
    expect(Array.isArray(out) && out.map((b) => b.type)).toEqual(['text', 'image', 'image'])
  })

  it('falls back to plain text if every attachment is unusable', () => {
    expect(userContent('hi', [{ mediaType: 'image/heic', data: 'x' }])).toBe('hi')
  })
})

describe('isUsableImage', () => {
  it('accepts the four formats the API takes', () => {
    for (const t of ['image/png', 'image/jpeg', 'image/gif', 'image/webp']) {
      expect(isUsableImage({ mediaType: t, data: 'x' })).toBe(true)
    }
  })

  // Rejected here rather than by the model call after the user pressed send.
  it('rejects formats the API does not accept', () => {
    expect(isUsableImage({ mediaType: 'image/svg+xml', data: 'x' })).toBe(false)
    expect(isUsableImage({ mediaType: 'image/heic', data: 'x' })).toBe(false)
  })

  it('rejects an image over the 5 MB ceiling', () => {
    expect(isUsableImage({ mediaType: 'image/png', data: 'x'.repeat(MAX_IMAGE_BASE64 + 1) })).toBe(false)
    expect(isUsableImage({ mediaType: 'image/png', data: 'x'.repeat(MAX_IMAGE_BASE64) })).toBe(true)
  })

  it('rejects empty or missing data', () => {
    expect(isUsableImage({ mediaType: 'image/png', data: '' })).toBe(false)
    expect(isUsableImage(null)).toBe(false)
  })
})
