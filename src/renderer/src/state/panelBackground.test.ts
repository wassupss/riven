import { describe, expect, it } from 'vitest'
import {
  PANEL_BG_DEFAULTS,
  bgActiveFor,
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
      filter: 'blur(8px)'
    })
    expect(panelBgView(on({ panelBgScope: 'panels', panelBgKinds: ['terminal', 'chat'] }))).toMatchObject({
      app: false,
      kinds: ['terminal', 'chat'],
      filter: 'none'
    })
    // Panels scope with nothing chosen shows nothing at all.
    expect(panelBgView(on({ panelBgScope: 'panels', panelBgKinds: [] })).image).toBeNull()
  })

  it('never syncs the file name to another machine', () => {
    const synced = pickSyncable({ ...DEFAULT_SETTINGS, ...on() })
    expect('panelBgImage' in synced).toBe(false)
    expect(synced.panelBgOpacity).toBe(PANEL_BG_DEFAULTS.panelBgOpacity)
  })
})
