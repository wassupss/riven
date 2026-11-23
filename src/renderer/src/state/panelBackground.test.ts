import { describe, expect, it } from 'vitest'
import {
  PANEL_BG_ANCHORS,
  PANEL_BG_DEFAULTS,
  bgActiveFor,
  clampPos,
  dragDelta,
  drawnSize,
  placementCss,
  isBgName,
  panelBgView,
  samePanelBg,
  sanitizePanelBg,
  type PanelBgSettings
} from './panelBackground'
import { DEFAULT_SETTINGS, migrateLegacy, type Settings } from './settings'
import { pickSyncable } from './settingsSync'

const IMG = 'bg-0123456789abcdef.png'
const on = (p: Partial<PanelBgSettings> = {}): PanelBgSettings => ({ ...PANEL_BG_DEFAULTS, panelBgImage: IMG, ...p })

describe('panel background settings', () => {
  it('is off by default, and an old settings.json stays off', () => {
    expect(DEFAULT_SETTINGS.panelBgImage).toBe('')
    expect(panelBgView(DEFAULT_SETTINGS).image).toBeNull()
    // A settings.json written before the feature has none of the keys.
    const old = { ...DEFAULT_SETTINGS } as Partial<Settings>
    for (const k of Object.keys(PANEL_BG_DEFAULTS)) delete (old as Record<string, unknown>)[k]
    const merged = migrateLegacy({ ...DEFAULT_SETTINGS, ...old } as Settings)
    expect(samePanelBg(merged, PANEL_BG_DEFAULTS)).toBe(true)
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

  it('sanitizes broken or hand-edited values back to safe ones', () => {
    const s = sanitizePanelBg({
      panelBgImage: '../../secret.png',
      panelBgOpacity: 7,
      panelBgBlur: -3,
      panelBgScope: 'everywhere',
      panelBgKinds: ['terminal', 'git', 3, 'chat']
    })
    expect(s).toEqual({
      ...PANEL_BG_DEFAULTS,
      panelBgImage: '',
      panelBgOpacity: 1,
      panelBgBlur: 0,
      panelBgScope: 'app',
      panelBgKinds: ['terminal', 'chat']
    })
    expect(sanitizePanelBg({ panelBgOpacity: 0, panelBgBlur: 999.4 })).toMatchObject({
      panelBgOpacity: 0.05,
      panelBgBlur: 40
    })
    expect(sanitizePanelBg({ panelBgOpacity: Number.NaN, panelBgKinds: 'terminal' })).toMatchObject({
      panelBgOpacity: PANEL_BG_DEFAULTS.panelBgOpacity,
      panelBgKinds: PANEL_BG_DEFAULTS.panelBgKinds
    })
    // migrateLegacy applies it to what is loaded or pulled.
    const m = migrateLegacy({ ...DEFAULT_SETTINGS, panelBgImage: 'nope', panelBgBlur: 100 } as Settings)
    expect(m.panelBgImage).toBe('')
    expect(m.panelBgBlur).toBe(40)
  })

  it('decides which panels see through', () => {
    expect(bgActiveFor(PANEL_BG_DEFAULTS, 'terminal')).toBe(false)
    expect(bgActiveFor(on(), 'terminal')).toBe(true)
    expect(bgActiveFor(on(), 'git')).toBe(false)
    const panels = on({ panelBgScope: 'panels', panelBgKinds: ['editor'] })
    expect(bgActiveFor(panels, 'editor')).toBe(true)
    expect(bgActiveFor(panels, 'terminal')).toBe(false)
  })

  it('maps to the page view', () => {
    expect(panelBgView(on({ panelBgOpacity: 0.3, panelBgBlur: 8 }))).toEqual({
      image: IMG,
      app: true,
      kinds: [],
      tint: 0.7,
      filter: 'blur(8px)',
      // The default placement is the first version's: cover, centred.
      size: 'cover',
      pos: '50% 50%',
      repeat: 'no-repeat',
      origin: 'border-box'
    })
    expect(panelBgView(on({ panelBgScope: 'panels', panelBgKinds: ['terminal', 'chat'] }))).toMatchObject({
      app: false,
      kinds: ['terminal', 'chat'],
      filter: 'none'
    })
    // Panels scope with nothing chosen shows nothing at all.
    expect(panelBgView(on({ panelBgScope: 'panels', panelBgKinds: [] })).image).toBeNull()
  })

  it('keeps cover/centre for settings saved before placement existed', () => {
    const old = { ...DEFAULT_SETTINGS, panelBgImage: IMG } as Partial<Settings>
    for (const k of ['panelBgFit', 'panelBgSize', 'panelBgX', 'panelBgY']) delete (old as Record<string, unknown>)[k]
    const m = migrateLegacy(old as Settings)
    expect(m).toMatchObject({ panelBgFit: 'cover', panelBgX: 50, panelBgY: 50 })
    expect(panelBgView(m)).toMatchObject({ size: 'cover', pos: '50% 50%', repeat: 'no-repeat' })
  })

  it('validates and clamps placement', () => {
    expect(
      sanitizePanelBg({ panelBgFit: 'stretch', panelBgSize: 0, panelBgX: -20, panelBgY: 140 })
    ).toMatchObject({ panelBgFit: 'cover', panelBgSize: 5, panelBgX: 0, panelBgY: 100 })
    expect(sanitizePanelBg({ panelBgSize: 999, panelBgX: '30', panelBgY: Number.NaN })).toMatchObject({
      panelBgSize: 150,
      panelBgX: 50,
      panelBgY: 50
    })
    expect(sanitizePanelBg({ panelBgFit: 'tile', panelBgSize: 33.333, panelBgX: 12.345 })).toMatchObject({
      panelBgFit: 'tile',
      panelBgSize: 33.3,
      panelBgX: 12.3
    })
    const m = migrateLegacy({ ...DEFAULT_SETTINGS, panelBgFit: 'zoom', panelBgX: 500 } as unknown as Settings)
    expect(m.panelBgFit).toBe('cover')
    expect(m.panelBgX).toBe(100)
  })

  it('maps placement to CSS', () => {
    const p = { panelBgSize: 40, panelBgX: 0, panelBgY: 100 }
    expect(placementCss({ ...p, panelBgFit: 'cover' })).toEqual({
      size: 'cover',
      pos: '0% 100%',
      repeat: 'no-repeat',
      origin: 'border-box'
    })
    expect(placementCss({ ...p, panelBgFit: 'contain' })).toMatchObject({ size: 'contain', origin: 'content-box' })
    expect(placementCss({ ...p, panelBgFit: 'size' })).toMatchObject({
      size: '40% auto',
      repeat: 'no-repeat',
      origin: 'content-box'
    })
    expect(placementCss({ ...p, panelBgFit: 'tile' })).toMatchObject({ size: '40% auto', repeat: 'repeat' })
    expect(panelBgView(on({ panelBgFit: 'size', panelBgSize: 25, panelBgX: 100, panelBgY: 0 }))).toMatchObject({
      size: '25% auto',
      pos: '100% 0%'
    })
    expect(PANEL_BG_ANCHORS).toHaveLength(9)
    expect(PANEL_BG_ANCHORS[0]).toEqual([0, 0])
    expect(PANEL_BG_ANCHORS[4]).toEqual([50, 50])
    expect(PANEL_BG_ANCHORS[8]).toEqual([100, 100])
  })

  it('turns a drag into a position change', () => {
    // 200x100 area, 400x200 image: cover scales it to fill.
    expect(drawnSize('cover', 40, 200, 100, 400, 100)).toEqual({ w: 400, h: 100 })
    expect(drawnSize('contain', 40, 200, 100, 400, 100)).toEqual({ w: 200, h: 50 })
    expect(drawnSize('size', 25, 200, 100, 400, 200)).toEqual({ w: 50, h: 25 })
    // Small image: 150px of free room, so 75px right is +50%.
    expect(dragDelta(75, 200, 50)).toBe(50)
    // Larger than the area: dragging right shows more of its left, % goes down.
    expect(dragDelta(100, 200, 400)).toBe(-50)
    // Exactly the area's size: nowhere to go.
    expect(dragDelta(30, 200, 200)).toBe(0)
    expect(clampPos(-3)).toBe(0)
    expect(clampPos(103)).toBe(100)
    expect(clampPos(33.333)).toBe(33.3)
  })

  it('never syncs the file name to another machine', () => {
    const synced = pickSyncable({ ...DEFAULT_SETTINGS, ...on() })
    expect('panelBgImage' in synced).toBe(false)
    expect(synced.panelBgOpacity).toBe(PANEL_BG_DEFAULTS.panelBgOpacity)
  })
})
