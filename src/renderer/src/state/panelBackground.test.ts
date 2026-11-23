import { describe, expect, it } from 'vitest'
import {
  LEGACY_BG_KEYS,
  PANEL_BG_ANCHORS,
  PANEL_BG_KINDS,
  PANEL_BG_KIND_LABEL,
  PANEL_BG_LOOK,
  bgVars,
  clampPos,
  dragDelta,
  drawnSize,
  isBgName,
  migrateLegacyBg,
  placementCss,
  referencedBackgrounds,
  resolveBg,
  sanitizeBg,
  sanitizeKindBgs,
  sanitizePaneBg,
  withKindBg,
  type PanelBg
} from './panelBackground'
import { DEFAULT_SETTINGS, migrateLegacy, type Settings } from './settings'
import { pickSyncable } from './settingsSync'
import { DICT } from '../i18n'

const IMG = 'bg-0123456789abcdef.png'
const IMG2 = 'bg-1111111111111111.jpg'
const IMG3 = 'bg-2222222222222222.webp'
const bg = (p: Partial<PanelBg> = {}): PanelBg => ({ ...PANEL_BG_LOOK, image: IMG, ...p })
const url = (n: string): string => `riven-media://bg/${n}`

// What settings.json looked like with the first version's single background.
const legacy = (p: Record<string, unknown>): Settings => {
  const s: Record<string, unknown> = { ...DEFAULT_SETTINGS, ...p }
  delete s.panelBgs
  return s as unknown as Settings
}

describe('panel background values', () => {
  it('is off by default', () => {
    expect(DEFAULT_SETTINGS.panelBgs).toEqual({})
    expect(resolveBg(DEFAULT_SETTINGS.panelBgs, 'terminal', undefined)).toBeNull()
  })

  it('accepts only the names main hands out', () => {
    expect(isBgName(IMG)).toBe(true)
    for (const bad of [
      '',
      'bg-0123456789abcdef.svg',
      '../bg-0123456789abcdef.png',
      'bg-0123456789ABCDEF.png',
      'bg-0123456789abcdef.png.tmp',
      '/etc/passwd',
      'settings.json',
      'x") ; background: url("http://evil'
    ])
      expect(isBgName(bad)).toBe(false)
  })

  it('sanitizes broken or hand-edited values', () => {
    expect(sanitizeBg({ image: '../../secret.png' })).toBeNull()
    expect(sanitizeBg('nope')).toBeNull()
    expect(sanitizeBg({ image: IMG, opacity: 7, blur: -3, fit: 'stretch', size: 0, x: -20, y: 140 })).toEqual({
      image: IMG,
      opacity: 1,
      blur: 0,
      fit: 'cover',
      size: 5,
      x: 0,
      y: 100
    })
    expect(sanitizeBg({ image: IMG, opacity: Number.NaN, blur: 999.4, size: 999, x: '30' })).toMatchObject({
      opacity: PANEL_BG_LOOK.opacity,
      blur: 40,
      size: 150,
      x: 50
    })
    expect(sanitizeBg({ image: IMG, fit: 'tile', size: 33.333, x: 12.345 })).toMatchObject({
      fit: 'tile',
      size: 33.3,
      x: 12.3
    })
    // Unknown kinds and imageless entries are dropped.
    expect(sanitizeKindBgs({ terminal: bg(), launcher: bg(), editor: { image: '' }, git: bg({ image: IMG2 }) })).toEqual({
      terminal: bg(),
      git: bg({ image: IMG2 })
    })
    expect(sanitizeKindBgs(null)).toEqual({})
    expect(sanitizePaneBg('none')).toBe('none')
    expect(sanitizePaneBg(bg())).toEqual(bg())
    expect(sanitizePaneBg('off')).toBeUndefined()
    expect(sanitizePaneBg({ image: 'x' })).toBeUndefined()
  })

  it('resolves panel override > kind default > nothing', () => {
    const kinds = { terminal: bg(), editor: bg({ image: IMG2 }) }
    expect(resolveBg(kinds, 'terminal', undefined)).toEqual(bg())
    expect(resolveBg(kinds, 'terminal', bg({ image: IMG3, x: 0 }))).toEqual(bg({ image: IMG3, x: 0 }))
    expect(resolveBg(kinds, 'terminal', 'none')).toBeNull()
    expect(resolveBg(kinds, 'chat', undefined)).toBeNull()
    // An override works in a kind with no default, and a broken one falls back.
    expect(resolveBg(kinds, 'chat', bg())).toEqual(bg())
    expect(resolveBg(kinds, 'editor', { image: 'broken' })).toEqual(bg({ image: IMG2 }))
    // Not a known kind: only an override shows.
    expect(resolveBg(kinds, 'launcher', undefined)).toBeNull()
  })

  it('replaces or removes one kind default', () => {
    const kinds = { terminal: bg() }
    expect(withKindBg(kinds, 'editor', bg({ image: IMG2 }))).toEqual({ terminal: bg(), editor: bg({ image: IMG2 }) })
    expect(withKindBg(kinds, 'terminal', null)).toEqual({})
    expect(kinds).toEqual({ terminal: bg() })
  })

  it('maps a background to its panel CSS variables', () => {
    expect(bgVars(bg({ opacity: 0.3, blur: 8 }), url)).toEqual({
      '--pbg-image': `url("riven-media://bg/${IMG}")`,
      '--pbg-tint': '0.7',
      '--pbg-filter': 'blur(8px)',
      // The default placement is the first version's: cover, centred.
      '--pbg-size': 'cover',
      '--pbg-pos': '50% 50%',
      '--pbg-repeat': 'no-repeat',
      '--pbg-origin': 'border-box'
    })
    expect(bgVars(bg({ fit: 'size', size: 25, x: 100, y: 0 }), url)).toMatchObject({
      '--pbg-filter': 'none',
      '--pbg-size': '25% auto',
      '--pbg-pos': '100% 0%',
      '--pbg-origin': 'content-box'
    })
  })

  it('maps placement to CSS', () => {
    const p = { size: 40, x: 0, y: 100 }
    expect(placementCss({ ...p, fit: 'cover' })).toEqual({
      size: 'cover',
      pos: '0% 100%',
      repeat: 'no-repeat',
      origin: 'border-box'
    })
    expect(placementCss({ ...p, fit: 'contain' })).toMatchObject({ size: 'contain', origin: 'content-box' })
    expect(placementCss({ ...p, fit: 'size' })).toMatchObject({ size: '40% auto', repeat: 'no-repeat' })
    expect(placementCss({ ...p, fit: 'tile' })).toMatchObject({ size: '40% auto', repeat: 'repeat' })
    expect(PANEL_BG_ANCHORS).toHaveLength(9)
    expect(PANEL_BG_ANCHORS[0]).toEqual([0, 0])
    expect(PANEL_BG_ANCHORS[4]).toEqual([50, 50])
    expect(PANEL_BG_ANCHORS[8]).toEqual([100, 100])
  })

  it('turns a drag into a position change', () => {
    expect(drawnSize('cover', 40, 200, 100, 400, 100)).toEqual({ w: 400, h: 100 })
    expect(drawnSize('contain', 40, 200, 100, 400, 100)).toEqual({ w: 200, h: 50 })
    expect(drawnSize('size', 25, 200, 100, 400, 200)).toEqual({ w: 50, h: 25 })
    expect(dragDelta(75, 200, 50)).toBe(50)
    expect(dragDelta(100, 200, 400)).toBe(-50)
    expect(dragDelta(30, 200, 200)).toBe(0)
    expect(clampPos(-3)).toBe(0)
    expect(clampPos(103)).toBe(100)
    expect(clampPos(33.333)).toBe(33.3)
  })

  it('names every kind in both languages', () => {
    for (const k of PANEL_BG_KINDS) {
      const e = DICT[PANEL_BG_KIND_LABEL[k]]
      expect(e?.ko, k).toBeTruthy()
      expect(e?.en, k).toBeTruthy()
    }
  })

  it('never syncs backgrounds to another machine', () => {
    const synced = pickSyncable({ ...DEFAULT_SETTINGS, panelBgs: { terminal: bg() } })
    expect('panelBgs' in synced).toBe(false)
  })
})

describe('migrating the single background', () => {
  it('leaves settings without the old keys alone', () => {
    const s = { ...DEFAULT_SETTINGS, panelBgs: { git: bg() } }
    expect(migrateLegacy(s).panelBgs).toEqual({ git: bg() })
    const plain = { theme: 'x' }
    expect(migrateLegacyBg(plain)).toBe(plain)
  })

  it('turns whole-app scope into defaults for the kinds that showed it', () => {
    const m = migrateLegacy(
      legacy({
        panelBgImage: IMG,
        panelBgOpacity: 0.6,
        panelBgBlur: 12,
        panelBgScope: 'app',
        panelBgKinds: ['terminal'],
        panelBgFit: 'tile',
        panelBgSize: 20,
        panelBgX: 10,
        panelBgY: 90
      })
    )
    const want = { image: IMG, opacity: 0.6, blur: 12, fit: 'tile', size: 20, x: 10, y: 90 }
    expect(m.panelBgs).toEqual({ terminal: want, editor: want, chat: want })
    for (const k of LEGACY_BG_KEYS) expect(k in m, k).toBe(false)
  })

  it('turns per-panel scope into defaults for the chosen kinds only', () => {
    const m = migrateLegacy(
      legacy({ panelBgImage: IMG, panelBgScope: 'panels', panelBgKinds: ['editor', 'chat', 'git', 3] })
    )
    expect(Object.keys(m.panelBgs).sort()).toEqual(['chat', 'editor'])
    // Saved before placement existed: cover, centred, default strength.
    expect(m.panelBgs.editor).toEqual(bg())
    expect(migrateLegacy(legacy({ panelBgImage: IMG, panelBgScope: 'panels', panelBgKinds: [] })).panelBgs).toEqual({})
  })

  it('reads a missing scope as whole app, the old default', () => {
    expect(Object.keys(migrateLegacy(legacy({ panelBgImage: IMG })).panelBgs).sort()).toEqual([
      'chat',
      'editor',
      'terminal'
    ])
  })

  it('drops the old keys when there was no usable image', () => {
    for (const image of ['', 'nope', '../x.png', undefined]) {
      const m = migrateLegacy(legacy({ panelBgImage: image, panelBgOpacity: 0.9, panelBgScope: 'panels' }))
      expect(m.panelBgs).toEqual({})
      for (const k of LEGACY_BG_KEYS) expect(k in m, k).toBe(false)
    }
  })

  it('never overwrites a default that already exists', () => {
    const m = migrateLegacy({
      ...legacy({ panelBgImage: IMG }),
      panelBgs: { terminal: bg({ image: IMG2 }) }
    } as Settings)
    expect(m.panelBgs.terminal).toEqual(bg({ image: IMG2 }))
    expect(m.panelBgs.editor).toEqual(bg())
  })

  it('a cloud row from an older build (no image) changes nothing local', () => {
    const local = { ...DEFAULT_SETTINGS, panelBgs: { git: bg() } }
    const m = migrateLegacy({ ...local, panelBgOpacity: 0.9, panelBgScope: 'app' } as Settings)
    expect(m.panelBgs).toEqual({ git: bg() })
    expect('panelBgOpacity' in m).toBe(false)
  })

  it('cleans broken kind defaults on load', () => {
    const m = migrateLegacy({ ...DEFAULT_SETTINGS, panelBgs: { terminal: { image: 'x' }, nope: bg() } } as unknown as Settings)
    expect(m.panelBgs).toEqual({})
    expect(migrateLegacy({ ...DEFAULT_SETTINGS, panelBgs: null } as unknown as Settings).panelBgs).toEqual({})
  })
})

describe('which stored backgrounds are in use', () => {
  it('collects kind defaults and every pane override in every workspace', () => {
    const kinds = { terminal: bg(), editor: bg({ image: IMG2 }) }
    const sessions = {
      '/a': { panes: { 'term-1': { bg: bg({ image: IMG3 }) }, 'chat-x': { model: 'm' }, git: { bg: 'none' } } },
      // A workspace that is not on screen: its saved panes still count.
      '/b': { panes: { 'term-9': { bg: bg({ image: 'bg-3333333333333333.gif' }) } } },
      '/c': {}
    }
    expect(referencedBackgrounds(kinds, sessions)).toEqual([
      IMG,
      IMG2,
      IMG3,
      'bg-3333333333333333.gif'
    ])
  })

  it('dedupes, and keeps a valid name even in an otherwise broken entry', () => {
    const sessions = {
      '/a': { panes: { p1: { bg: { image: IMG, opacity: 'loud' } }, p2: { bg: bg() } } }
    }
    expect(referencedBackgrounds({ terminal: { image: IMG, fit: 42 } }, sessions)).toEqual([IMG])
  })

  it('ignores what cannot name a stored file', () => {
    const sessions = {
      '/a': { panes: { p1: { bg: { image: '../../etc/passwd' } }, p2: null, p3: { bg: 'none' } } },
      '/b': null,
      '/c': { panes: 'x' }
    } as unknown as Record<string, { panes?: Record<string, unknown> }>
    expect(referencedBackgrounds(null, sessions)).toEqual([])
    expect(referencedBackgrounds({ terminal: 'x' }, {})).toEqual([])
  })
})
