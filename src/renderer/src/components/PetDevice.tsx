import '../styles/pet.css'
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import {
  Award,
  BarChart3,
  BookOpen,
  ChevronLeft,
  ChevronRight,
  CornerDownLeft,
  ExternalLink,
  EyeOff,
  Gamepad2,
  Heart,
  ListTree,
  Maximize2,
  Minimize2,
  Pencil,
  Pill,
  Settings,
  Smile,
  Trash2,
  Utensils,
  X
} from 'lucide-react'
import { useT, type TFn } from '../i18n'
import { fmtTokens, useUsage } from '../state/usage'
import { useSettings, type PetChrome } from '../state/settings'
import { promptInput } from './promptInput'
import { ARROW_LEFT, ARROW_RIGHT, CROSS, POOP, ZZZ, pixelsOf, SPRITE_SIZE } from './petSprites'
import {
  awardsOf,
  dietOf,
  flushPetSave,
  freshByFlavor,
  growthOf,
  isNight,
  moodOf,
  usePet,
  HUNGRY_AT,
  KIBBLE_TOKENS,
  MAX_POOPS,
  type Form,
  type Mood,
  type Stage
} from '../state/pet'

// ---------------------------------------------------------------------------
// 리븐펫 — a handheld virtual pet that floats over the workbench, or lives in its
// own always-on-top window outside it (see src/main/pet.ts).
//
// Deliberately NOT a dock panel: a pet you have to open a tab for is a pet you
// forget to feed. Three levels of chrome — the whole handheld, its screen alone,
// or nothing but the creature on a transparent background.
//
// The economy lives in state/pet.ts (pure + unit-tested) and the art in
// petSprites.ts. This file is the device: wiring, dragging, and the screens.
//
// Feeding reads the summed per-account `usage.today` through freshTokens, driven
// by the shared usage poll — chewing is triggered by an actual feed, so it works
// the same in both windows. Nothing animates while nobody is looking; hunger is
// charged on waking, because decay() replays the elapsed time in one step.
// ---------------------------------------------------------------------------

const TICK_MS = 15_000
const CHEW_MS = 1600
const FLASH_MS = 1800
const MARGIN = 12

type ScreenMode = 'char' | 'clock' | 'stats' | 'graph' | 'awards' | 'album' | 'settings'
const GRAPH_DAYS = 7

// How long the screen announces the icon you just moved to before going back to
// showing the pet's name.
const PICK_MS = 1600

// Korean marks the subject with 이 after a final consonant and 가 otherwise —
// "아이가 됐다", "청소년이 됐다". Left alone for anything that isn't Hangul, so
// the English strings pass through untouched.
const subject = (word: string): string => {
  const code = word.charCodeAt(word.length - 1)
  if (Number.isNaN(code) || code < 0xac00 || code > 0xd7a3) return word
  return word + ((code - 0xac00) % 28 === 0 ? '가' : '이')
}

const dur = (t: TFn, ms: number): string => {
  const total = Math.floor(Math.max(0, ms) / 60_000)
  if (total < 1) return t('pet.dur.now')
  const d = Math.floor(total / 1440)
  const h = Math.floor((total % 1440) / 60)
  const m = total % 60
  if (d) return h ? `${t('pet.dur.d', { n: d })} ${t('pet.dur.h', { n: h })}` : t('pet.dur.d', { n: d })
  if (h) return m ? `${t('pet.dur.h', { n: h })} ${t('pet.dur.m', { n: m })}` : t('pet.dur.h', { n: h })
  return t('pet.dur.m', { n: total })
}

// A glyph grid → <rect> dots, for the small props (droppings, medicine, arrows).
function Glyph({ rows, className }: { rows: string[]; className?: string }): JSX.Element {
  const w = rows[0].length
  return (
    <svg
      className={`pet-glyph ${className ?? ''}`}
      viewBox={`0 0 ${w} ${rows.length}`}
      shapeRendering="crispEdges"
      aria-hidden="true"
    >
      {rows.flatMap((row, y) =>
        row.split('').map((ch, x) =>
          ch === '.' ? null : (
            <rect key={`${x},${y}`} className="pet-px pet-px-p" x={x} y={y} width="1" height="1" />
          )
        )
      )}
    </svg>
  )
}

// The creature itself: one <rect> per lit dot, no anti-aliasing.
function Creature({
  stage,
  form,
  mood,
  chewing,
  flavor,
  evolving
}: {
  stage: Stage
  form: Form
  mood: Mood
  chewing: boolean
  flavor?: string
  evolving?: boolean
}): JSX.Element {
  const dots = useMemo(() => pixelsOf(stage, form, mood), [stage, form, mood])
  return (
    <svg
      className={`pet-lcd pet-s-${stage} pet-f-${form} pet-m-${mood}${flavor ? ` pet-diet-${flavor}` : ''}${evolving ? ' evolving' : ''}`}
      viewBox={`0 0 ${SPRITE_SIZE} ${SPRITE_SIZE}`}
      shapeRendering="crispEdges"
      aria-hidden="true"
    >
      <g className={`pet-sprite${chewing ? ' chew' : ''}`}>
        {dots.map((d) => (
          <rect
            key={`${d.x},${d.y}`}
            className={`pet-px pet-px-${d.ch}`}
            x={d.x}
            y={d.y}
            width="1"
            height="1"
          />
        ))}
      </g>
      {chewing && (
        <g className="pet-crumbs">
          <rect className="pet-px pet-px-a" x="13" y="2" width="1" height="1" />
          <rect className="pet-px pet-px-a" x="2" y="1" width="1" height="1" />
        </g>
      )}
      {/* Growing up: a ring of dots bursts outward for a moment. */}
      {evolving && (
        <g className="pet-burst">
          {[
            [8, 0],
            [14, 2],
            [15, 8],
            [13, 14],
            [8, 15],
            [2, 13],
            [0, 8],
            [2, 2]
          ].map(([x, y]) => (
            <rect key={`${x},${y}`} className="pet-px pet-px-a" x={x} y={y} width="1" height="1" />
          ))}
        </g>
      )}
    </svg>
  )
}

// A handheld-style segmented gauge: ten dots, lit left to right.
function Gauge({ label, value, tone }: { label: string; value: number; tone: string }): JSX.Element {
  const lit = Math.round(Math.min(100, Math.max(0, value)) / 10)
  return (
    <div className="pet-gauge" title={`${label} ${Math.round(value)}%`}>
      <span className="pet-gauge-label">{label}</span>
      <span className="pet-gauge-cells">
        {Array.from({ length: 10 }, (_, i) => (
          <i key={i} className={`pet-cell tone-${tone}${i < lit ? ' on' : ''}`} />
        ))}
      </span>
    </div>
  )
}

export default function PetDevice({ detached }: { detached?: boolean }): JSX.Element | null {
  const t = useT()
  const show = useSettings((s) => s.settings.petShow)
  const pos = useSettings((s) => s.settings.petPos)
  const savedChrome = useSettings((s) => s.settings.petChrome)
  const setSettings = useSettings((s) => s.set)
  // The floating window keeps its own chrome level in memory: it must not write
  // settings.json behind the app's back (two writers, last one wins).
  const [winChrome, setWinChrome] = useState<PetChrome>('full')
  const chrome = detached ? winChrome : savedChrome
  const setChrome = (c: PetChrome): void => {
    if (detached) setWinChrome(c)
    else setSettings({ petChrome: c })
  }

  const pet = usePet((s) => s.pet)
  const loaded = usePet((s) => s.loaded)
  const load = usePet((s) => s.load)
  const tick = usePet((s) => s.tick)
  const sample = usePet((s) => s.sample)
  const patHead = usePet((s) => s.patHead)
  const cleanUp = usePet((s) => s.cleanUp)
  const giveMedicine = usePet((s) => s.giveMedicine)
  const playRound = usePet((s) => s.playRound)
  const rename = usePet((s) => s.rename)
  const reset = usePet((s) => s.reset)
  const accounts = useUsage((s) => s.accounts)
  const fallbackToday = useUsage((s) => s.today)
  const acquire = useUsage((s) => s.acquire)
  const release = useUsage((s) => s.release)

  const ref = useRef<HTMLDivElement>(null)
  const [awake, setAwake] = useState(true)
  const [chewing, setChewing] = useState(false)
  const [mode, setMode] = useState<ScreenMode>('char')
  // Which LCD icon the highlight is on — null when none is, which is how a real
  // one idles. The settings screen has its own row cursor.
  const [sel, setSel] = useState<number | null>(null)
  const [row, setRow] = useState(0)
  const [guessing, setGuessing] = useState(false)
  const [flash, setFlash] = useState<string | null>(null)
  // Re-rendered on the tick, so the pet nods off and wakes up on the hour
  // without a timer of its own.
  const [nowTick, setNowTick] = useState(() => Date.now())
  const justEvolved = usePet((s) => s.justEvolved)
  const ackEvolution = usePet((s) => s.ackEvolution)
  const [evolving, setEvolving] = useState(false)
  // Dragging never goes through React. A pointermove that re-renders the device
  // has to rebuild a hundred-odd <rect> dots before the pixel moves, which is
  // exactly the lag you feel in the hand; instead the node is moved directly and
  // the final position is written to settings once, on release.
  const drag = useRef<{ dx: number; dy: number; x: number; y: number; moved: boolean } | null>(null)
  const timers = useRef<Array<ReturnType<typeof setTimeout>>>([])

  const later = useCallback((fn: () => void, ms: number): void => {
    timers.current.push(setTimeout(fn, ms))
  }, [])
  useEffect(
    () => () => {
      timers.current.forEach(clearTimeout)
      timers.current = []
    },
    []
  )

  useEffect(() => {
    if (!show && !detached) return
    void load()
    return flushPetSave
  }, [show, detached, load])

  // Join the shared usage poll while on screen (it already skips a hidden window).
  useEffect(() => {
    if (!show && !detached) return
    acquire()
    return release
  }, [show, detached, acquire, release])

  useEffect(() => {
    const compute = (): void => setAwake(document.visibilityState === 'visible' && document.hasFocus())
    compute()
    // The floating window is deliberately never focused (showInactive), so for it
    // "awake" is just "is this window visible" — otherwise the desk pet would sit
    // frozen forever while you work in another app, which is exactly when you
    // want to see it.
    const computeDetached = (): void => setAwake(document.visibilityState === 'visible')
    const fn = detached ? computeDetached : compute
    fn()
    window.addEventListener('focus', fn)
    window.addEventListener('blur', fn)
    document.addEventListener('visibilitychange', fn)
    return () => {
      window.removeEventListener('focus', fn)
      window.removeEventListener('blur', fn)
      document.removeEventListener('visibilitychange', fn)
    }
  }, [detached])

  // Hunger/mood only need recomputing while someone is looking: decay() charges
  // for the whole gap in one call when the window comes back.
  useEffect(() => {
    if (!awake || !loaded) return
    tick()
    setNowTick(Date.now())
    const id = setInterval(() => {
      tick()
      setNowTick(Date.now())
    }, TICK_MS)
    return () => clearInterval(id)
  }, [awake, loaded, tick])

  // Growing up is the one moment worth interrupting for.
  useEffect(() => {
    if (!justEvolved) return
    ackEvolution()
    // The egg it was born as is bookkeeping, not an event.
    if (justEvolved.stage === 'egg') return
    setEvolving(true)
    setFlash(t('pet.evolved', { stage: subject(t(`pet.stage.${justEvolved.stage}`)) }))
    later(() => setEvolving(false), 2600)
    later(() => setFlash(null), 2600)
  }, [justEvolved, ackEvolution, later, t])

  // Feed from the usage totals. Ignored until the save is loaded, so the first
  // sample can't feed a pet that is about to be replaced by the stored one.
  useEffect(() => {
    if (!loaded) return
    // One counter per account AND model, so the pet's diet records which model
    // actually paid for each meal (see flavorOf).
    const totals: Record<string, number> = {}
    const add = (id: string, today: Parameters<typeof freshByFlavor>[0]): void => {
      for (const [flavor, fresh] of Object.entries(freshByFlavor(today))) totals[`${id}::${flavor}`] = fresh
    }
    for (const a of accounts) if (a.today) add(a.id, a.today)
    if (!Object.keys(totals).length && fallbackToday) add('claude', fallbackToday)
    if (Object.keys(totals).length) sample(totals)
  }, [loaded, accounts, fallbackToday, sample])

  // Chew whenever a meal actually lands — true in both windows, unlike the chat
  // stream (which only reaches the window that started the turn).
  const lastMeal = useRef(0)
  useEffect(() => {
    if (!pet.lastFedAt || pet.lastFedAt === lastMeal.current) return
    const first = lastMeal.current === 0
    lastMeal.current = pet.lastFedAt
    if (first) return // the meal that came out of the save file, not a fresh one
    setChewing(true)
    later(() => setChewing(false), CHEW_MS)
  }, [pet.lastFedAt, later])

  // A finished turn means tokens have just been spent: ask usage now instead of
  // waiting out the poll. (Only the app window receives chat events.)
  useEffect(() => {
    if (detached) return
    return window.api.chat.onEvent((e) => {
      if (e.kind === 'turnDone') useUsage.getState().refresh()
    })
  }, [detached])

  // ---- the floating window: keep it sized to the device ----
  useLayoutEffect(() => {
    if (!detached) return
    const el = ref.current
    if (!el) return
    // The device's BOTTOM edge in page coordinates, which already includes the
    // window's top padding, plus the matching padding below it. Measuring the
    // document instead would read back the viewport we just set and creep the
    // window taller on every pass; measuring only the element's height would cut
    // the case off, which is what it used to do.
    const send = (): void =>
      void window.api.pet.resize(Math.ceil(el.getBoundingClientRect().bottom) + 6)
    send()
    const ro = new ResizeObserver(send)
    ro.observe(el)
    return () => ro.disconnect()
  }, [detached, chrome, mode, guessing])

  // ---- in-app dragging ----
  const clamp = useCallback((x: number, y: number): { x: number; y: number } => {
    const el = ref.current
    const w = el?.offsetWidth ?? 190
    const h = el?.offsetHeight ?? 260
    return {
      x: Math.min(Math.max(MARGIN, x), Math.max(MARGIN, window.innerWidth - w - MARGIN)),
      y: Math.min(Math.max(MARGIN, y), Math.max(MARGIN, window.innerHeight - h - MARGIN))
    }
  }, [])

  useEffect(() => {
    if (detached) return
    const reclamp = (): void => {
      const p = useSettings.getState().settings.petPos
      if (!p) return
      const c = clamp(p.x, p.y)
      if (c.x !== p.x || c.y !== p.y) setSettings({ petPos: c })
    }
    window.addEventListener('resize', reclamp)
    // Also when the DEVICE grows (a taller screen, the buttons coming back):
    // parked at the bottom edge it would otherwise hang off it.
    const ro = ref.current ? new ResizeObserver(reclamp) : null
    if (ref.current) ro?.observe(ref.current)
    return () => {
      window.removeEventListener('resize', reclamp)
      ro?.disconnect()
    }
  }, [detached, clamp, setSettings])

  const place = useCallback((x: number, y: number): void => {
    const el = ref.current
    if (!el) return
    // Left/top rather than a transform, so the element's own box is where it
    // looks — clamping and the next drag both measure the same rect.
    el.style.left = `${x}px`
    el.style.top = `${y}px`
    el.style.right = 'auto'
    el.style.bottom = 'auto'
  }, [])

  const onPointerDown = (e: React.PointerEvent): void => {
    // Buttons act; everything else is a drag handle. (Detached, the OS drags the
    // window for us — see -webkit-app-region in the stylesheet.)
    if (detached || e.button !== 0 || (e.target as HTMLElement).closest('button')) return
    const el = ref.current
    if (!el) return
    const r = el.getBoundingClientRect()
    drag.current = { dx: e.clientX - r.left, dy: e.clientY - r.top, x: r.left, y: r.top, moved: false }
    el.classList.add('pet-dragging')
    place(r.left, r.top)
    el.setPointerCapture(e.pointerId)
  }
  const onPointerMove = (e: React.PointerEvent): void => {
    const d = drag.current
    if (!d) return
    d.moved = true
    const p = clamp(e.clientX - d.dx, e.clientY - d.dy)
    d.x = p.x
    d.y = p.y
    place(p.x, p.y)
  }
  const endDrag = (e: React.PointerEvent): void => {
    const d = drag.current
    if (!d) return
    drag.current = null
    ref.current?.classList.remove('pet-dragging')
    try {
      ref.current?.releasePointerCapture(e.pointerId)
    } catch {
      /* the capture is already gone */
    }
    // One settings write per drag, at the end.
    if (d.moved) setSettings({ petPos: { x: d.x, y: d.y } })
  }

  const growth = useMemo(() => growthOf(pet, Date.now()), [pet])
  // Sleep is a property of the clock, not of the pet: the logic layer stays free
  // of "what time is it" and the device decides (see isNight).
  const sleeping = isNight(nowTick) && !pet.sick && growth.stage !== 'egg'
  const mood: Mood = sleeping ? 'asleep' : moodOf(pet)
  const diet = useMemo(() => dietOf(pet), [pet])
  const awards = useMemo(() => awardsOf(pet, nowTick), [pet, nowTick])

  if (!show && !detached) return null

  // Unnamed: the screen shows what it is rather than the words "no name".
  const name = pet.name || null
  const stageLabel =
    growth.form === 'base'
      ? t(`pet.stage.${growth.stage}`)
      : `${t(`pet.stage.${growth.stage}`)} · ${t(`pet.form.${growth.form}`)}`

  // One short line, the most pressing thing first. Deliberately absent in 'bare'
  // (that mode is the creature and nothing else).
  const bubble = sleeping
    ? t('pet.say.sleep')
    : pet.sick
      ? t('pet.say.sick')
      : chewing
        ? t('pet.say.eat')
        : pet.poops >= MAX_POOPS
          ? t('pet.say.dirty')
          : pet.fullness < HUNGRY_AT
            ? t('pet.say.hungry')
            : pet.mood < 45
              ? t('pet.say.bored')
              : null

  // ---- the icon menu ----
  // The real thing prints its functions around the screen and you pick one with
  // the three buttons. Everything the device can do lives here: nothing is
  // hidden behind a hover any more.
  interface Icon {
    id: string
    label: string
    node: JSX.Element
    run: () => void
    dim?: boolean
    on?: boolean
  }

  const doRename = async (): Promise<void> => {
    const v = await promptInput({ title: t('pet.renameTitle'), initial: pet.name })
    if (v !== null) rename(v.trim())
  }
  const say = (msg: string, ms = FLASH_MS): void => {
    setFlash(msg)
    later(() => setFlash((f) => (f === msg ? null : f)), ms)
  }
  const doGuess = (guess: 'left' | 'right'): void => {
    const r = playRound(guess)
    setGuessing(false)
    if (!r) return say(t('pet.play.declined'))
    say(r.win ? t('pet.play.win') : t('pet.play.lose'))
  }
  // ---- the menu strip, and the three keys that drive it ----
  //
  // The functions live on the SCREEN, as a strip of segments along its foot —
  // not as buttons on the case. The whole device is worked with three keys:
  //   A  moves the highlight along the strip
  //   B  runs whatever is highlighted, or opens its screen; with nothing
  //      highlighted it shows the clock
  //   C  clears the highlight, and backs out of whatever screen you are in
  // A segment lights by itself when the pet wants that thing — a mess to clear,
  // medicine — so the strip doubles as the alarm.
  interface Icon {
    id: string
    label: string
    node: JSX.Element
    /** Lit because it is asking for this right now. */
    alert?: boolean
    run: () => void
  }

  const needs = pet.sick || pet.poops > 0 || pet.fullness < HUNGRY_AT
  const icons: Icon[] = [
    { id: 'feed', label: t('pet.mode.graph'), node: <Utensils size={11} />, run: () => setMode('graph') },
    {
      id: 'play',
      label: t('pet.play'),
      node: <Gamepad2 size={11} />,
      run: () => {
        if (growth.stage === 'egg') return say(t('pet.say.egg'))
        if (sleeping) return say(t('pet.say.sleep'))
        setMode('char')
        setGuessing(true)
      }
    },
    {
      id: 'clean',
      label: t('pet.clean'),
      node: <Trash2 size={11} />,
      alert: pet.poops > 0,
      run: () => {
        if (pet.poops === 0) return say(t('pet.say.alreadyClean'))
        cleanUp()
        say(t('pet.cleaned'))
      }
    },
    {
      id: 'medicine',
      label: t('pet.medicine'),
      node: <Pill size={11} />,
      alert: pet.sick,
      run: () => {
        if (!pet.sick) return say(t('pet.say.notIll'))
        giveMedicine()
        say(t('pet.cured'))
      }
    },
    {
      id: 'pet',
      label: t('pet.pet'),
      node: <Heart size={11} />,
      run: () => {
        if (growth.stage === 'egg') return say(t('pet.say.egg'))
        if (sleeping) return say(t('pet.say.sleep'))
        patHead()
        say(t('pet.patted'))
      }
    },
    { id: 'meter', label: t('pet.mode.stats'), node: <ListTree size={11} />, run: () => setMode('stats') },
    { id: 'album', label: t('pet.mode.album'), node: <BookOpen size={11} />, run: () => setMode('album') },
    { id: 'settings', label: t('pet.settings'), node: <Settings size={11} />, run: () => setMode('settings') }
  ]

  // The meter is one icon with several pages: press A inside it to turn the
  // page, C to come out.
  const METER_PAGES: ScreenMode[] = ['stats', 'awards']
  const SETTING_ROWS = 5

  const pressA = (): void => {
    if (guessing) return doGuess('left')
    if (mode === 'settings') return setRow((r) => (r + 1) % SETTING_ROWS)
    if (METER_PAGES.includes(mode)) {
      const next = METER_PAGES[(METER_PAGES.indexOf(mode) + 1) % METER_PAGES.length]
      return setMode(next)
    }
    if (mode !== 'char') return setMode('char')
    const next = sel === null ? 0 : (sel + 1) % icons.length
    setSel(next)
    say(icons[next].label, PICK_MS)
  }
  const pressB = (): void => {
    if (guessing) return doGuess('right')
    if (mode === 'settings') return runSetting(row)
    if (sel === null) return setMode(mode === 'clock' ? 'char' : 'clock')
    icons[sel].run()
  }
  const pressC = (): void => {
    if (guessing) return setGuessing(false)
    if (mode !== 'char') {
      setMode('char')
      return
    }
    setSel(null)
  }

  // The setup list. B runs whatever the cursor is on; the size row steps through
  // the three levels rather than offering three targets, because there is no
  // pointer here — only A, B and C.
  const settingRows: Array<{ id: string; label: string; value: string; danger?: boolean }> = [
    { id: 'name', label: t('pet.settings.name'), value: pet.name || t('pet.settings.noName') },
    {
      id: 'where',
      label: t('pet.settings.where'),
      value: detached ? t('pet.settings.outside') : t('pet.settings.inside')
    },
    { id: 'size', label: t('pet.settings.size'), value: t(`pet.size.${chrome}`) },
    { id: 'hide', label: t('pet.settings.hide'), value: t('pet.settings.hideDo') },
    { id: 'restart', label: t('pet.settings.restart'), value: t('pet.settings.restartDo'), danger: true }
  ]
  const NEXT_SIZE: Record<PetChrome, PetChrome> = { full: 'screen', screen: 'bare', bare: 'full' }
  const runSetting = (i: number): void => {
    switch (settingRows[i]?.id) {
      case 'name':
        return void doRename()
      case 'where':
        return void (detached ? window.api.pet.close() : setSettings({ petDetached: true }))
      case 'size':
        return setChrome(NEXT_SIZE[chrome])
      case 'hide':
        return void (detached ? window.api.pet.hide() : setSettings({ petShow: false }))
      case 'restart':
        if (window.confirm(t('pet.resetConfirm'))) reset()
        return
    }
  }
  const clockTime = new Date(nowTick).toLocaleTimeString(undefined, {
    hour: '2-digit',
    minute: '2-digit'
  })

  const graph = pet.history.slice(-GRAPH_DAYS)
  const peak = Math.max(1, ...graph.map((d) => d.kibble))

  // The screen carries the readout: a real handheld prints nothing outside the
  // glass but its maker's name.
  const footer = guessing
    ? t('pet.play.hint')
    : growth.toNext > 0
      ? t('pet.toNext', { n: growth.toNext })
      : t('pet.grown')

  // Drawn on the glass, not on the case, and not clickable: the three keys are
  // the only way to work it.
  const iconRow = (from: number, to: number): JSX.Element => (
    <div className="pet-icons" aria-hidden="true">
      {icons.slice(from, to).map((ic, i) => (
        <span
          key={ic.id}
          data-ic={ic.id}
          className={['pet-ic', ic.alert ? 'alert' : '', sel === from + i ? 'picked' : '']
            .filter(Boolean)
            .join(' ')}
          title={ic.label}
        >
          {ic.node}
        </span>
      ))}
    </div>
  )

  const screen = (
    <div className="pet-screen">
      {/* Nothing is printed over the picture but a single line, and only when
          there is something to say. */}
      {(mode !== 'char' || flash || guessing) && (
        <div className="pet-screen-top">
          <span>{mode === 'char' ? '' : t(`pet.mode.${mode}`)}</span>
          <span className={`pet-screen-mood mood-${mood}`}>
            {flash ?? (guessing ? t('pet.play.pick') : '')}
          </span>
        </div>
      )}

      {mode === 'char' && (
        <div className="pet-yard">
          {bubble && !guessing && <div className="pet-bubble">{bubble}</div>}
          {guessing && <Glyph rows={ARROW_LEFT} className="pet-arrow left" />}
          <Creature
            stage={growth.stage}
            form={growth.form}
            mood={mood}
            chewing={chewing && awake && !sleeping}
            flavor={diet.total > 0 ? diet.top : undefined}
            evolving={evolving}
          />
          {sleeping && <Glyph rows={ZZZ} className="pet-zzz" />}
          {guessing && <Glyph rows={ARROW_RIGHT} className="pet-arrow right" />}
          {/* The floor: what it has left lying around, and whether it needs a doctor. */}
          <div className="pet-floor">
            {pet.sick && <Glyph rows={CROSS} className="pet-cross" />}
            {Array.from({ length: Math.min(MAX_POOPS, pet.poops) }, (_, i) => (
              <Glyph key={i} rows={POOP} className="pet-poop" />
            ))}
          </div>
        </div>
      )}

      {mode === 'stats' && (
        <dl className="pet-rows">
          <div className="pet-meters">
            <Gauge label={t('pet.gauge.fullness')} value={pet.fullness} tone="food" />
            <Gauge label={t('pet.gauge.mood')} value={pet.mood} tone="mood" />
          </div>
          <div>
            <dt>{t('pet.stat.name')}</dt>
            <dd>{name ?? t('pet.settings.noName')}</dd>
          </div>
          <div>
            <dt>{t('pet.stat.stage')}</dt>
            <dd>{stageLabel}</dd>
          </div>
          <div>
            <dt>{t('pet.stat.next')}</dt>
            <dd>{footer}</dd>
          </div>
          <div>
            <dt>{t('pet.stat.tokens')}</dt>
            <dd>{fmtTokens(pet.totalTokens)}</dd>
          </div>
          <div>
            <dt>{t('pet.stat.kibble')}</dt>
            <dd>{pet.xp}</dd>
          </div>
          <div>
            <dt>{t('pet.stat.age')}</dt>
            <dd>{dur(t, Date.now() - pet.bornAt)}</dd>
          </div>
          <div>
            <dt>{t('pet.stat.neglect')}</dt>
            <dd className={pet.neglectMs >= 60_000 ? 'warn' : undefined}>
              {pet.neglectMs >= 60_000 ? dur(t, pet.neglectMs) : t('pet.stat.noNeglect')}
            </dd>
          </div>
          <div>
            <dt>{t('pet.stat.lastMeal')}</dt>
            <dd>{pet.lastFedAt ? dur(t, Date.now() - pet.lastFedAt) : t('pet.never')}</dd>
          </div>
          <div>
            <dt>{t('pet.stat.games')}</dt>
            <dd>{pet.plays ? t('pet.stat.gamesValue', { w: pet.wins, n: pet.plays }) : t('pet.never')}</dd>
          </div>
          <div>
            <dt>{t('pet.stat.diet')}</dt>
            <dd>
              {diet.total > 0
                ? t('pet.stat.dietValue', {
                    flavor: t(`pet.flavor.${diet.top}`),
                    pct: Math.round(diet.share * 100)
                  })
                : t('pet.never')}
            </dd>
          </div>
          {pet.evolutions.length > 0 && (
            <div>
              <dt>{t('pet.stat.story')}</dt>
              <dd>{pet.evolutions.map((e) => t(`pet.stage.${e.stage}`)).join(' → ')}</dd>
            </div>
          )}
        </dl>
      )}

      {mode === 'graph' && (
        <div className="pet-graph">
          {graph.length === 0 && <p className="pet-empty">{t('pet.graph.empty')}</p>}
          {graph.map((d) => (
            <div key={d.day} className="pet-bar" title={`${d.day} · ${d.kibble}`}>
              <i style={{ height: `${Math.max(6, (d.kibble / peak) * 100)}%` }} />
              <span>{d.day.slice(8)}</span>
            </div>
          ))}
        </div>
      )}

      {mode === 'awards' && (
        <div className="pet-awards">
          {awards.map((a) => (
            <div key={a.id} className={`pet-award${a.done ? ' done' : ''}`} title={t(`pet.award.${a.id}`)}>
              <i />
              <span>{t(`pet.award.${a.id}`)}</span>
            </div>
          ))}
        </div>
      )}

      {mode === 'settings' && (
        <div className="pet-rows pet-settings">
          {settingRows.map((r, i) => (
            <div
              key={r.id}
              data-row={r.id}
              className={`pet-row${row === i ? ' picked' : ''}${r.danger ? ' danger' : ''}`}
            >
              <span>{r.label}</span>
              <b>{r.value}</b>
            </div>
          ))}
          <p className="pet-note">{t('pet.hint', { n: KIBBLE_TOKENS.toLocaleString() })}</p>
        </div>
      )}

      {mode === 'clock' && (
        <div className="pet-clock">
          <b>{clockTime}</b>
          <span>{t('pet.clock.age', { age: dur(t, Date.now() - pet.bornAt) })}</span>
        </div>
      )}

      {mode === 'album' && (
        <div className="pet-album">
          {pet.album.length === 0 && <p className="pet-empty">{t('pet.album.empty')}</p>}
          {[...pet.album].reverse().map((a) => (
            <div key={a.endedAt} className="pet-album-row">
              <b>{a.name || t('pet.default.name')}</b>
              <span>
                {a.form === 'base' ? t(`pet.stage.${a.stage}`) : t(`pet.form.${a.form}`)} · {a.xp}
                {t('pet.album.kibble')} · {dur(t, a.ageMs)}
              </span>
            </div>
          ))}
        </div>
      )}

      {/* The menu: one strip along the foot of the screen, walked with A. */}
      {iconRow(0, 8)}
    </div>
  )

  // A, B, C. While the guessing game is up, A and B are the two directions.
  const keys = (
    <>
      <button
        className="pet-key"
        data-key="a"
        onClick={pressA}
        title={guessing ? t('pet.play.left') : t('pet.key.select')}
      />
      <button
        className="pet-key"
        data-key="b"
        onClick={pressB}
        title={
          guessing
            ? t('pet.play.right')
            : sel === null
              ? t('pet.key.clock')
              : `${t('pet.key.confirm')} · ${icons[sel].label}`
        }
      />
      <button className="pet-key" data-key="c" onClick={pressC} title={t('pet.key.back')} />
    </>
  )

  return (
    <div
      ref={ref}
      className={[
        'pet-device',
        `pet-chrome-${chrome}`,
        awake ? '' : 'pet-asleep',
        detached ? 'pet-detached' : ''
      ]
        .filter(Boolean)
        .join(' ')}
      style={
        detached || !pos
          ? undefined /* detached fills its window; otherwise parked bottom-right */
          : { left: pos.x, top: pos.y, right: 'auto', bottom: 'auto' }
      }
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={endDrag}
      onPointerCancel={endDrag}
    >
      {chrome === 'bare' ? (
        <>
          {/* With every scrap of UI hidden there is nothing left to press, so
              this one control — and only this one — waits under the pointer. */}
          <div className="pet-tools">
            <button className="pet-icon" title={t('pet.size.full')} onClick={() => setChrome('full')}>
              <Maximize2 size={12} />
            </button>
            <button
              className="pet-icon"
              title={t('pet.settings.hideDo')}
              onClick={() =>
                detached ? void window.api.pet.hide() : setSettings({ petShow: false })
              }
            >
              <X size={12} />
            </button>
          </div>
          {/* With the case hidden there are no buttons to press, so the pet
              itself is the way back — click it and the device returns. */}
          <div
            className="pet-bare"
            role="button"
            title={t('pet.size.full')}
            onClick={() => setChrome('full')}
          >
            <Creature
              stage={growth.stage}
              form={growth.form}
              mood={mood}
              chewing={chewing && awake && !sleeping}
              flavor={diet.total > 0 ? diet.top : undefined}
              evolving={evolving}
            />
            {sleeping && <Glyph rows={ZZZ} className="pet-zzz" />}
            {(pet.sick || pet.poops > 0) && (
              <div className="pet-floor">
                {pet.sick && <Glyph rows={CROSS} className="pet-cross" />}
                {Array.from({ length: Math.min(MAX_POOPS, pet.poops) }, (_, i) => (
                  <Glyph key={i} rows={POOP} className="pet-poop" />
                ))}
              </div>
            )}
          </div>
        </>
      ) : chrome === 'screen' ? (
        // The glass and the three buttons: no case, but every function is still
        // reachable — A walks the icons, B runs one, C backs out.
        <div className="pet-mini">
          <div className="pet-bezel">{screen}</div>
          <div className="pet-pad">{keys}</div>
        </div>
      ) : (
        // The whole unit: a little desk terminal — screen, a deck with the name
        // and a power lamp, and the three keys off to one side.
        <div className="pet-unit">
          <div className="pet-case">
            <div className="pet-bezel">{screen}</div>
            <div className="pet-deck">
              <span className="pet-logo">{t('pet.title')}</span>
              <span className="pet-led" aria-hidden="true" />
              <div className="pet-pad">{keys}</div>
            </div>
          </div>
          <div className="pet-stand" aria-hidden="true">
            <i />
          </div>
        </div>
      )}
    </div>
  )
}
