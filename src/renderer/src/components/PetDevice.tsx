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
  MessageCircle,
  Trash2,
  Trophy,
  Utensils,
  X
} from 'lucide-react'
import { useT, type TFn } from '../i18n'
import { fmtTokens, tightestLimit, useUsage } from '../state/usage'
import { useRoster, workspaceOfPane } from '../state/roster'
import { useSession, workspaceName } from '../state/session'
import { useAgentEdits } from '../state/agentEdits'
import { answer as talkAnswer } from '../state/petTalk'
import { getActiveApi } from '../dock/registry'
import { useSettings, type PetChrome } from '../state/settings'
import { promptInput } from './promptInput'
import { chordFromEvent } from '../keybindings/keys'
import { petKeyChords } from '../keybindings/petKeys'
import { ARROW_LEFT, ARROW_RIGHT, CROSS, MIMES, POOP, ZZZ, pixelsOf, SPRITE_SIZE } from './petSprites'
import {
  awardsOf,
  dietOf,
  flushPetSave,
  freshByFlavor,
  freshTokens,
  feedFrame,
  growthOf,
  isNight,
  moodOf,
  usePet,
  HUNGRY_AT,
  KIBBLE_TOKENS,
  MAX_POOPS,
  type Form,
  type Mood,
  type Species,
  type Stage
} from '../state/pet'

// ---------------------------------------------------------------------------
// 리븐펫 — a handheld virtual pet that floats over the workbench, or lives in its
// own window out on the desktop (see src/main/pet.ts; settings.petOnTop decides
// whether that window floats above other apps).
//
// Deliberately NOT a dock panel: a pet you have to open a tab for is a pet you
// forget to feed. Three levels of chrome — the whole handheld, its screen alone,
// or nothing but the creature on a transparent background.
//
// Two ways to work it, on purpose. The three keys on the case do what they did on
// the handheld this borrows its shape from (A walks the menu, B runs it, C backs
// out) and are what the keyboard shortcuts press; the same segments are also
// buttons, so anything is one press away for a pointer.
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

type ScreenMode = 'char' | 'clock' | 'stats' | 'graph' | 'awards' | 'album' | 'settings' | 'talk'

/** A turn that finished somewhere, kept just long enough to be asked about. */
interface Finished {
  workspace: string
  title: string
  at: number
  failed: boolean
}
const RECENT_KEEP = 8
// One announcement at a time, and never the same turn twice.
const NOTICE_MS = 4000
// An answer is a sentence, not a mood — give it time to be read.
const ANSWER_MS = 7000

// How long the screen announces the icon you just moved to before going back to
// showing the pet's name.
const PICK_MS = 1600
// The guessing game's reveal: long enough to see which way the pet went.
const REVEAL_MS = 1800
const NOOP = (): void => {}
// A mime is held this long and never queued: one turn fires dozens of tools.
const MIME_MS = 1400

// Which tools are worth acting out. Anything else is left to the busy count.
function mimeOf(tool: string): string | null {
  const n = tool.toLowerCase()
  if (n.includes('read') || n.includes('notebook')) return 'read'
  if (n.includes('edit') || n.includes('write')) return 'write'
  if (n.includes('bash') || n.includes('terminal')) return 'run'
  if (n.includes('grep') || n.includes('glob') || n.includes('search')) return 'search'
  if (n.includes('web') || n.includes('fetch')) return 'web'
  return null
}

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
  species,
  mood,
  chewing,
  flavor,
  evolving
}: {
  stage: Stage
  form: Form
  species: Species
  mood: Mood
  chewing: boolean
  flavor?: string
  evolving?: boolean
}): JSX.Element {
  const dots = useMemo(() => pixelsOf(stage, form, mood, species), [stage, form, mood, species])
  return (
    <svg
      className={`pet-lcd pet-s-${stage} pet-f-${form} pet-sp-${species} pet-m-${mood}${flavor ? ` pet-diet-${flavor}` : ''}${evolving ? ' evolving' : ''}`}
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
  const savedOnTop = useSettings((s) => s.settings.petOnTop)
  // In its own window the live answer comes from main, not from this window's
  // settings snapshot — same reason as winChrome below: the pet window is not
  // allowed to write settings.json.
  const [winOnTop, setWinOnTop] = useState(false)
  const onTop = detached ? winOnTop : savedOnTop
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
  // What the workspaces are doing right now. The roster is app-wide on purpose:
  // a turn running in a workspace that is not on screen is exactly the one worth
  // telling you about.
  const live = useRoster((s) => s.live)
  const wsNames = useSession((s) => s.names)
  const editedToday = useAgentEdits((s) => s.timeline)
  const [recent, setRecent] = useState<Finished[]>([])
  const accounts = useUsage((s) => s.accounts)
  const fallbackToday = useUsage((s) => s.today)
  const acquire = useUsage((s) => s.acquire)
  const release = useUsage((s) => s.release)

  const ref = useRef<HTMLDivElement>(null)
  const [awake, setAwake] = useState(true)
  const awakeRef = useRef(true)
  const [chewing, setChewing] = useState(false)
  // What the pet is miming right now (the tool the watched pane just ran).
  const [mime, setMime] = useState<string | null>(null)
  const mimeRef = useRef(false)
  const [mode, setMode] = useState<ScreenMode>('char')
  // Which LCD icon the A key's highlight is on — null when none is, which is how
  // a real one idles. The setup screen has its own row cursor. (The strip is also
  // clickable; the highlight is only for working it from the keys.)
  const [sel, setSel] = useState<number | null>(null)
  const [row, setRow] = useState(0)
  const [guessing, setGuessing] = useState(false)
  // Which way the pet actually went, shown for a beat after you guess: without
  // the reveal the game is an invisible coin toss.
  const [revealed, setRevealed] = useState<'left' | 'right' | null>(null)
  // The ask field stays open across answers. Answering sends the screen back to
  // the pet — that is the point, you watch it answer — and closing the field with
  // it meant every follow-up question needed the menu again.
  const [talking, setTalking] = useState(false)
  // The screen's top line: the name of whatever is under the pointer. A label,
  // not a voice.
  const [flash, setFlash] = useState<string | null>(null)
  // What the pet is actually saying — answers, and news from the workspaces.
  const [speech, setSpeech] = useState<string | null>(null)
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

  // The three keys, reachable from riven's keyboard shortcuts. The press is
  // relayed through main, so it works whether the device is in the app window or
  // out on the desktop — and the pet window answers its own keys when focused.
  // The handlers are declared far below, past an early return, so the listener
  // reaches them through a ref: a hook may NOT sit on the far side of a `return`
  // (React counts hooks per render — the in-app device crashed on being hidden).
  const keysRef = useRef<Record<'a' | 'b' | 'c', () => void>>({
    a: NOOP,
    b: NOOP,
    c: NOOP
  })
  useEffect(() => {
    const off = window.api.pet.onPress((k) => keysRef.current[k]?.())
    // riven's window owns the keymap; this window has none, so when the floating
    // pet itself has focus it matches the same chords directly — from the same
    // overrides file, or a rebind would work in one window and not the other.
    let chords: Record<string, 'a' | 'b' | 'c'> = {}
    if (detached) void petKeyChords().then((c) => (chords = c))
    const local = (e: KeyboardEvent): void => {
      const hit = chords[chordFromEvent(e)]
      if (!hit) return
      e.preventDefault()
      keysRef.current[hit]()
    }
    if (detached) window.addEventListener('keydown', local, { capture: true })
    return () => {
      off()
      if (detached) window.removeEventListener('keydown', local, { capture: true })
    }
  }, [detached])

  // Keep the setup row honest about whether the window is actually floating.
  useEffect(() => {
    if (!detached) return
    void window.api.pet.isOnTop().then(setWinOnTop)
    return window.api.pet.onOnTop(setWinOnTop)
  }, [detached])

  // Join the shared usage poll while on screen (it already skips a hidden window).
  useEffect(() => {
    if (!show && !detached) return
    acquire()
    return release
  }, [show, detached, acquire, release])

  useEffect(() => {
    const compute = (): void => {
      const next = document.visibilityState === 'visible' && document.hasFocus()
      awakeRef.current = next
      setAwake(next)
    }
    compute()
    // The floating window is deliberately never focused (showInactive), so for it
    // "awake" is just "is this window visible" — otherwise the desk pet would sit
    // frozen forever while you work in another app, which is exactly when you
    // want to see it.
    const computeDetached = (): void => {
      const next = document.visibilityState === 'visible'
      awakeRef.current = next
      setAwake(next)
    }
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

  // ---- reacting to the work ----
  //
  // Chat events arrive for EVERY pane in every workspace, dozens per turn. Two
  // rules keep that from turning the pet into a strobe:
  //
  //  · a tool is mimed only when it comes from the pane you are actually looking
  //    at — a mime needs one subject, and that is the one you can follow;
  //  · a turn ENDING is announced wherever it happened, because that is the bit
  //    you want while looking away. It is announced once, in words, naming the
  //    workspace, and only for panes you are not already watching.
  //
  // Everything else is absorbed by the busy count above.
  const busyRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  useEffect(() => {
    if (detached) return
    return window.api.chat.onEvent((e) => {
      const ws = workspaceOfPane(e.key)
      const watching =
        useSession.getState().activeWorkspace === ws && getActiveApi()?.activePanel?.id === e.key

      if (e.kind === 'tool') {
        if (!watching || !awakeRef.current || mimeRef.current) return
        const mime = mimeOf(e.name)
        if (!mime) return
        setMime(mime)
        mimeRef.current = true
        later(() => {
          setMime(null)
          mimeRef.current = false
        }, MIME_MS)
        return
      }

      if (e.kind !== 'turnDone') return
      // Tokens have just been spent: ask usage now rather than waiting the poll.
      useUsage.getState().refresh()
      const where = workspaceName(ws ?? '', useSession.getState().names)
      if (!where) return
      const entry: Finished = { workspace: where, title: e.key, at: Date.now(), failed: !!e.error }
      setRecent((r) => [entry, ...r].slice(0, RECENT_KEEP))
      // Saying "done" about the pane you are staring at is noise.
      if (watching && !e.error) return
      speak(t(e.error ? 'pet.notice.failed' : 'pet.notice.done', { where }), NOTICE_MS)
    })
  }, [detached, later, t])

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
    // Measure again on the next frame as well: a chrome change is measured the
    // instant it renders, and the sprite//font work that follows can still move
    // the bottom edge — folding back up left the window at the folded height
    // with the case cut off.
    const frame = requestAnimationFrame(send)
    const ro = new ResizeObserver(send)
    ro.observe(el)
    // And whenever the window itself changes size. The device's own box does not
    // change when the WINDOW does, so the observer above never fires for it —
    // which left any window that ended up too small staying too small. Asking
    // for a height it already has is a no-op in main, so this cannot loop.
    window.addEventListener('resize', send)
    return () => {
      cancelAnimationFrame(frame)
      ro.disconnect()
      window.removeEventListener('resize', send)
    }
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
      // Never while it is in hand: clamping a stale stored position mid-drag
      // would yank it out from under the pointer.
      if (drag.current) return
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

  // Dragging listens on the WINDOW, not on the device.
  //
  // With the listeners on the element, a release the element never saw — the
  // pointer left it, capture was refused, the window lost focus — left the drag
  // armed. After that the pet was still stuck to the pointer, so moving the
  // mouse anywhere near it made it flee. A drag now ends on the first of:
  // pointerup anywhere, pointercancel, the window blurring, or a move that
  // arrives with no button held.
  const stopDrag = useCallback(() => {
    window.removeEventListener('pointermove', onWinMove)
    window.removeEventListener('pointerup', onWinUp)
    window.removeEventListener('pointercancel', onWinUp)
    window.removeEventListener('blur', onWinUp)
    ref.current?.classList.remove('pet-dragging')
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const onWinMove = useCallback(
    (e: PointerEvent) => {
      const d = drag.current
      if (!d) return stopDrag()
      // The button came up somewhere we never heard about.
      if (e.buttons === 0) return onWinUp()
      d.moved = true
      const p = clamp(e.clientX - d.dx, e.clientY - d.dy)
      d.x = p.x
      d.y = p.y
      place(p.x, p.y)
      // eslint-disable-next-line react-hooks/exhaustive-deps
    },
    [clamp, place, stopDrag]
  )

  const onWinUp = useCallback(() => {
    const d = drag.current
    drag.current = null
    stopDrag()
    // One settings write per drag, at the end.
    if (d?.moved) setSettings({ petPos: { x: d.x, y: d.y } })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [setSettings, stopDrag])

  const onPointerDown = (e: React.PointerEvent): void => {
    // Buttons and the text field act; everything else is a drag handle. (Detached,
    // the OS drags the window for us — see -webkit-app-region in the stylesheet.)
    if (detached || e.button !== 0) return
    if ((e.target as HTMLElement).closest('button, input, form')) return
    const el = ref.current
    if (!el) return
    const r = el.getBoundingClientRect()
    drag.current = { dx: e.clientX - r.left, dy: e.clientY - r.top, x: r.left, y: r.top, moved: false }
    el.classList.add('pet-dragging')
    place(r.left, r.top)
    window.addEventListener('pointermove', onWinMove)
    window.addEventListener('pointerup', onWinUp)
    window.addEventListener('pointercancel', onWinUp)
    window.addEventListener('blur', onWinUp)
  }

  // A drag must not outlive the component.
  useEffect(() => stopDrag, [stopDrag])

  // ONE aggregate, never a feed: how many agent panes are working, and where.
  // With four workspaces × four panes this still says something; a per-event
  // animation would just be a seizure.
  const busy = useMemo(
    () =>
      Object.entries(live)
        .filter(([, l]) => l.busy)
        .map(([key]) => ({
          workspace: workspaceName(workspaceOfPane(key) ?? '', wsNames),
          title: live[key]?.tabTitle ?? key
        }))
        .filter((b) => b.workspace),
    [live, wsNames]
  )
  // The tightest plan window across the accounts — the one that will bite first.
  const limit = useMemo(() => {
    const all = accounts.map(tightestLimit).filter((l): l is NonNullable<typeof l> => !!l)
    if (!all.length) return null
    return all.reduce((worst, l) => (l.usedPct > worst.usedPct ? l : worst))
  }, [accounts])

  const growth = useMemo(() => growthOf(pet, Date.now()), [pet])
  // Sleep is a property of the clock, not of the pet: the logic layer stays free
  // of "what time is it" and the device decides (see isNight).
  const sleeping = isNight(nowTick) && !pet.sick && growth.stage !== 'egg'
  const mood: Mood = sleeping ? 'asleep' : moodOf(pet)
  const diet = useMemo(() => dietOf(pet), [pet])
  const awards = useMemo(() => awardsOf(pet, nowTick), [pet, nowTick])

  if (!show && !detached) {
    // Put away: a shortcut must not go on feeding and cleaning a pet that is not
    // on screen, so the relayed presses land on nothing.
    keysRef.current = { a: NOOP, b: NOOP, c: NOOP }
    return null
  }

  // Unnamed: the screen shows what it is rather than the words "no name".
  const name = pet.name || null
  const stageLabel =
    growth.form === 'base'
      ? t(`pet.stage.${growth.stage}`)
      : `${t(`pet.stage.${growth.stage}`)} · ${t(`pet.form.${growth.form}`)}`

  // One short line, the most pressing thing first. Deliberately absent in 'bare'
  // (that mode is the creature and nothing else).
  const bubble =
    speech ??
    (sleeping
    ? t('pet.say.sleep')
    : pet.sick
      ? t('pet.say.sick')
      : limit && limit.usedPct >= 90
        ? t('pet.say.limit', { left: Math.max(0, 100 - Math.round(limit.usedPct)) })
        : busy.length >= 4
          ? t('pet.say.swamped', { n: busy.length })
          : chewing
            ? t('pet.say.eat')
            : pet.poops >= MAX_POOPS
              ? t('pet.say.dirty')
            : pet.fullness < HUNGRY_AT
              ? t('pet.say.hungry')
              : pet.mood < 45
                ? t('pet.say.bored')
                : null)

  const doRename = async (): Promise<void> => {
    const v = await promptInput({ title: t('pet.renameTitle'), initial: pet.name })
    if (v !== null) rename(v.trim())
  }
  const say = (msg: string, ms = FLASH_MS): void => {
    setFlash(msg)
    later(() => setFlash((f) => (f === msg ? null : f)), ms)
  }
  /** The pet speaks: it goes in the balloon, where it can be read. */
  const speak = (msg: string, ms = ANSWER_MS): void => {
    setSpeech(msg)
    later(() => setSpeech((v) => (v === msg ? null : v)), ms)
  }
  const doGuess = (guess: 'left' | 'right'): void => {
    const r = playRound(guess)
    setGuessing(false)
    if (!r) return speak(t('pet.play.declined'))
    // The pet picks a side and you guess it — so SHOW the side it picked. Without
    // this the game was "press either arrow, read win or lose", which is a coin
    // toss with extra steps. The pet leans that way, the arrow it chose lights
    // up, and only then does the result land.
    setRevealed(r.petPick)
    later(() => setRevealed(null), REVEAL_MS)
    say(
      `${t(`pet.play.went.${r.petPick}`)} · ${r.win ? t('pet.play.win') : t('pet.play.lose')}`,
      REVEAL_MS
    )
  }
  // ---- the menu strip ----
  //
  // The functions live on the SCREEN, as a strip of segments along its foot, and
  // you press the one you want. It used to be three buttons in the manner of the
  // handheld it was modelled on — A to walk a highlight, B to confirm, C to back
  // out — which is authentic and awful: three presses to clean up after a pet
  // that is right there on your desk. This is not that device, so a segment is
  // just a button, and the screen it opens closes with the ✕ on its own title.
  //
  // A segment lights by itself when the pet wants that thing — a mess to clear,
  // medicine — so the strip doubles as the alarm; `on` marks the screen you are
  // looking at.
  interface Icon {
    id: string
    label: string
    node: JSX.Element
    /** Lit because it is asking for this right now. */
    alert?: boolean
    /** This is the screen currently up. */
    on?: boolean
    run: () => void
  }

  const icons: Icon[] = [
    {
      id: 'feed',
      label: t('pet.mode.graph'),
      node: <Utensils size={11} />,
      on: mode === 'graph',
      run: () => openScreen('graph')
    },
    {
      id: 'play',
      label: t('pet.play'),
      node: <Gamepad2 size={11} />,
      on: guessing,
      run: () => {
        if (growth.stage === 'egg') return speak(t('pet.say.egg'))
        if (sleeping) return speak(t('pet.say.sleep'))
        setMode('char')
        setRevealed(null)
        setGuessing(true)
      }
    },
    {
      id: 'clean',
      label: t('pet.clean'),
      node: <Trash2 size={11} />,
      alert: pet.poops > 0,
      run: () => {
        if (pet.poops === 0) return speak(t('pet.say.alreadyClean'))
        cleanUp()
        speak(t('pet.cleaned'))
      }
    },
    {
      id: 'medicine',
      label: t('pet.medicine'),
      node: <Pill size={11} />,
      alert: pet.sick,
      run: () => {
        if (!pet.sick) return speak(t('pet.say.notIll'))
        giveMedicine()
        speak(t('pet.cured'))
      }
    },
    {
      id: 'pet',
      label: t('pet.pet'),
      node: <Heart size={11} />,
      run: () => {
        if (growth.stage === 'egg') return speak(t('pet.say.egg'))
        if (sleeping) return speak(t('pet.say.sleep'))
        patHead()
        speak(t('pet.patted'))
      }
    },
    {
      id: 'meter',
      label: t('pet.mode.stats'),
      node: <ListTree size={11} />,
      on: mode === 'stats',
      run: () => openScreen('stats')
    },
    {
      id: 'awards',
      label: t('pet.mode.awards'),
      node: <Trophy size={11} />,
      on: mode === 'awards',
      run: () => openScreen('awards')
    },
    {
      id: 'album',
      label: t('pet.mode.album'),
      node: <BookOpen size={11} />,
      on: mode === 'album',
      run: () => openScreen('album')
    },
    {
      id: 'talk',
      label: t('pet.talk.label'),
      node: <MessageCircle size={11} />,
      on: mode === 'talk',
      run: () => openScreen('talk')
    },
    {
      id: 'settings',
      label: t('pet.settings'),
      node: <Settings size={11} />,
      on: mode === 'settings',
      run: () => openScreen('settings')
    }
  ]

  /** Open a screen. The ask field belongs to the talk screen and follows it. */
  const openScreen = (m: ScreenMode): void => {
    setTalking(m === 'talk')
    setMode(m)
  }

  /** Out of whatever screen is up, and nothing left being said. */
  const backHome = (): void => {
    setSpeech(null)
    setGuessing(false)
    setTalking(false)
    setMode('char')
  }

  // ---- the three keys ----
  // They work the device the way the handheld did — A walks the highlight along
  // the strip, B runs what it is on, C backs out — and they are the keyboard's
  // way in too (see the shortcuts, above). Pressing a segment directly does the
  // same thing in one press; both are here on purpose.
  const METER_PAGES: ScreenMode[] = ['stats', 'awards']
  const pressA = (): void => {
    if (guessing) return doGuess('left')
    if (mode === 'settings') return setRow((r) => (r + 1) % settingRows.length)
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
    if (mode === 'settings') return runSetting(settingRows[row]?.id ?? '')
    if (sel === null) return setMode(mode === 'clock' ? 'char' : 'clock')
    icons[sel].run()
  }
  const pressC = (): void => {
    // C is "never mind": it also shuts the pet up, so a long answer can be
    // dismissed instead of waited out.
    setSpeech(null)
    if (guessing) return setGuessing(false)
    if (mode !== 'char') {
      setTalking(false)
      setMode('char')
      return
    }
    setTalking(false)
    setSel(null)
  }
  keysRef.current = { a: pressA, b: pressB, c: pressC }

  // The setup list: one row, one press. The size row steps through the three
  // levels instead of offering three targets — it is 200 pixels wide.
  const settingRows: Array<{
    id: string
    label: string
    value: string
    danger?: boolean
    on?: boolean
  }> = [
    { id: 'name', label: t('pet.settings.name'), value: pet.name || t('pet.settings.noName') },
    {
      id: 'where',
      label: t('pet.settings.where'),
      value: detached ? t('pet.settings.outside') : t('pet.settings.inside')
    },
    // Only its own window can float above other apps; inside riven it is part of
    // the window and there is nothing to lift.
    ...(detached
      ? [
          {
            id: 'ontop',
            label: t('pet.settings.onTop'),
            value: onTop ? t('pet.settings.onTopOn') : t('pet.settings.onTopOff'),
            on: onTop
          }
        ]
      : []),
    { id: 'size', label: t('pet.settings.size'), value: t(`pet.size.${chrome}`) },
    { id: 'hide', label: t('pet.settings.hide'), value: t('pet.settings.hideDo') },
    { id: 'restart', label: t('pet.settings.restart'), value: t('pet.settings.restartDo'), danger: true }
  ]
  const NEXT_SIZE: Record<PetChrome, PetChrome> = { full: 'screen', screen: 'bare', bare: 'full' }
  const runSetting = (id: string): void => {
    switch (id) {
      case 'name':
        return void doRename()
      case 'where':
        return void (detached ? window.api.pet.close() : setSettings({ petDetached: true }))
      case 'ontop':
        // Main lifts the window and tells the app to remember it (see PetHost).
        return void window.api.pet.askOnTop(!onTop)
      case 'size':
        return setChrome(NEXT_SIZE[chrome])
      case 'hide':
        return void (detached ? window.api.pet.hide() : setSettings({ petShow: false }))
      case 'restart':
        if (window.confirm(t('pet.resetConfirm'))) reset()
        return
    }
  }
  // Ask it something. Every answer is read off what riven already knows, so it
  // costs nothing and cannot invent anything (see state/petTalk.ts).
  const ask = (question: string): void => {
    const q = question.trim()
    if (!q) return
    // It answers by SAYING it — the screen goes back to the pet and the balloon
    // carries the reply. A transcript would just be a small chat window, and
    // there is a real one of those two panes away.
    const said = talkAnswer(q, {
      pet,
      now: Date.now(),
      busy,
      recent,
      todayTokens: accounts.reduce((n, a) => n + freshTokens(a.today), 0),
      limit,
      editedFiles: new Set(editedToday.map((e) => e.path)).size,
      dur: (ms) => dur(t, ms),
      fmt: fmtTokens,
      t
    })
    setMode('char')
    speak(said.text)
  }

  const clockTime = new Date(nowTick).toLocaleTimeString(undefined, {
    hour: '2-digit',
    minute: '2-digit'
  })

  // Seven calendar days, fed or not (see feedFrame): plotting only the days with
  // a meal in them drew one fat bar for a new pet and put distant days next to
  // each other. The scale is printed, because a bar chart with no numbers on a
  // 160-pixel screen says nothing.
  const graph = feedFrame(pet.history, nowTick)
  const peak = Math.max(1, ...graph.map((d) => d.kibble))
  const weekTotal = graph.reduce((n, d) => n + d.kibble, 0)

  // The screen carries the readout: a real handheld prints nothing outside the
  // glass but its maker's name.
  // While the game is up, the foot carries your record with it: the pick itself is
  // an even fifty-fifty (that is the game), so what makes it a game rather than a
  // coin toss is seeing the pet commit to a side and watching the tally move.
  const footer = guessing
    ? pet.plays > 0
      ? `${t('pet.play.hint')} · ${t('pet.stat.gamesValue', { w: pet.wins, n: pet.plays })}`
      : t('pet.play.hint')
    : growth.toNext > 0
      ? t('pet.toNext', { n: growth.toNext })
      : t('pet.grown')

  // Drawn on the glass, and each segment is the button for its own function:
  // point at it to see what it is, press it to do it.
  const iconRow = (from: number, to: number): JSX.Element => (
    <div className="pet-icons">
      {icons.slice(from, to).map((ic, i) => (
        <button
          key={ic.id}
          type="button"
          data-ic={ic.id}
          className={[
            'pet-ic',
            ic.alert ? 'alert' : '',
            ic.on ? 'on' : '',
            sel === from + i ? 'picked' : ''
          ]
            .filter(Boolean)
            .join(' ')}
          title={ic.label}
          aria-label={ic.label}
          onClick={ic.run}
          onPointerEnter={() => say(ic.label, PICK_MS)}
        >
          {ic.node}
        </button>
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
          {/* The way out of whatever is up — on the title of the thing itself,
              where you are already looking. */}
          {(mode !== 'char' || guessing) && (
            <button
              type="button"
              className="pet-back"
              data-key="back"
              title={t('pet.back')}
              aria-label={t('pet.back')}
              onClick={backHome}
            >
              <X size={9} />
            </button>
          )}
        </div>
      )}

      {mode === 'char' && (
        <div className="pet-yard">
          {/* Pick a side by pressing that side (or with the A / B keys). */}
          {guessing && (
            <button
              type="button"
              className="pet-guess left"
              data-guess="left"
              title={t('pet.play.left')}
              aria-label={t('pet.play.left')}
              onClick={() => doGuess('left')}
            >
              <Glyph rows={ARROW_LEFT} className="pet-arrow left" />
            </button>
          )}
          {/* The reveal: the side the pet actually went. */}
          {revealed === 'left' && <Glyph rows={ARROW_LEFT} className="pet-arrow left went" />}
          <div className={`pet-actor${revealed ? ` went-${revealed}` : ''}`}>
            <Creature
              stage={growth.stage}
              form={growth.form}
              species={pet.species}
              mood={mood}
              chewing={chewing && awake && !sleeping}
              flavor={diet.total > 0 ? diet.top : undefined}
              evolving={evolving}
            />
          </div>
          {sleeping && <Glyph rows={ZZZ} className="pet-zzz" />}
          {/* What the pane you are watching is doing, acted out. */}
          {mime && !sleeping && <Glyph rows={MIMES[mime]} className={`pet-mime ${mime}`} />}
          {guessing && (
            <button
              type="button"
              className="pet-guess right"
              data-guess="right"
              title={t('pet.play.right')}
              aria-label={t('pet.play.right')}
              onClick={() => doGuess('right')}
            >
              <Glyph rows={ARROW_RIGHT} className="pet-arrow right" />
            </button>
          )}
          {revealed === 'right' && <Glyph rows={ARROW_RIGHT} className="pet-arrow right went" />}
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
            <dt>{t('pet.stat.species')}</dt>
            <dd>{t(`pet.species.${pet.species}`)}</dd>
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
          {limit && (
            <div>
              <dt>{t('pet.stat.limit')}</dt>
              <dd className={limit.usedPct >= 90 ? 'warn' : undefined}>
                {t('pet.stat.limitValue', {
                  left: Math.max(0, 100 - Math.round(limit.usedPct)),
                  in: limit.resetsAt ? dur(t, new Date(limit.resetsAt).getTime() - nowTick) : '—'
                })}
              </dd>
            </div>
          )}
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
          <div className="pet-graph-head">
            {/* "peak 1" on an empty week would be a number made up out of the
                clamp below; say nothing until there is something to scale. */}
            <span>{weekTotal > 0 ? t('pet.graph.peak', { n: peak }) : ''}</span>
            <span>{t('pet.graph.week', { n: weekTotal })}</span>
          </div>
          <div className="pet-bars">
            {graph.map((d) => (
              <div
                key={d.day}
                className={`pet-bar${d.today ? ' today' : ''}${d.kibble === 0 ? ' none' : ''}`}
                title={t('pet.graph.day', { day: d.day, n: d.kibble })}
              >
                {/* A day with nothing in it gets a floor, not a bar: the gap has
                    to be visible or the chart lies about how it was fed. */}
                <i style={{ height: d.kibble ? `${Math.max(8, (d.kibble / peak) * 100)}%` : '1px' }} />
                <span>{Number(d.day.slice(8))}</span>
              </div>
            ))}
          </div>
          <div className="pet-graph-foot">
            {weekTotal === 0
              ? t('pet.graph.empty')
              : t('pet.graph.today', { n: graph[graph.length - 1].kibble })}
          </div>
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
          {settingRows.map((r) => (
            <button
              key={r.id}
              type="button"
              data-row={r.id}
              className={`pet-row${r.on ? ' on' : ''}${r.danger ? ' danger' : ''}`}
              onClick={() => runSetting(r.id)}
            >
              <span>{r.label}</span>
              <b>{r.value}</b>
            </button>
          ))}
          <p className="pet-note">{t('pet.hint', { n: KIBBLE_TOKENS.toLocaleString() })}</p>
        </div>
      )}

      {mode === 'talk' && (
        <div className="pet-talk">
          <p className="pet-empty">{t('pet.talk.prompt')}</p>
        </div>
      )}

      {mode === 'clock' && (
        <div className="pet-clock">
          <b>{clockTime}</b>
          <span>{t('pet.clock.age', { age: dur(t, Date.now() - pet.bornAt) })}</span>
          {limit?.resetsAt && (
            <span>
              {t('pet.clock.reset', { in: dur(t, new Date(limit.resetsAt).getTime() - nowTick) })}
            </span>
          )}
        </div>
      )}

      {mode === 'album' && (
        <div className="pet-album">
          {pet.album.length === 0 && <p className="pet-empty">{t('pet.album.empty')}</p>}
          {[...pet.album].reverse().map((a) => (
            <div key={a.endedAt} className="pet-album-row">
              <b>{a.name || t('pet.default.name')}</b>
              <span>
                {t(`pet.species.${a.species}`)} ·{' '}
                {a.form === 'base' ? t(`pet.stage.${a.stage}`) : t(`pet.form.${a.form}`)} · {a.xp}
                {t('pet.album.kibble')} · {dur(t, a.ageMs)}
              </span>
            </div>
          ))}
        </div>
      )}

      {/* The menu: one strip along the foot of the screen. */}
      {iconRow(0, icons.length)}
    </div>
  )

  // A, B, C. While the guessing game is up, A and B are the two sides.
  const keys = (
    <div className="pet-pad">
      <button
        type="button"
        className="pet-key"
        data-key="a"
        onClick={pressA}
        title={guessing ? t('pet.play.left') : t('pet.key.select')}
      >
        <span className="pet-key-cap">A</span>
      </button>
      <button
        type="button"
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
      >
        <span className="pet-key-cap">B</span>
      </button>
      <button
        type="button"
        className="pet-key"
        data-key="c"
        onClick={pressC}
        title={t('pet.key.back')}
      >
        <span className="pet-key-cap">C</span>
      </button>
    </div>
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
    >
      {/* What it is saying, above the device and in readable type. Inside the
          glass it was eight pixels tall and nobody could read it. Shown in every
          size — with the case hidden the balloon is the ONLY thing it can speak
          with, so leaving it out there made the pet mute. */}
      {bubble && !guessing && (
        <div className="pet-balloon" key={bubble}>
          {bubble}
        </div>
      )}
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
              species={pet.species}
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
        // The glass alone: no case, but every function is still on it — the strip
        // along its foot is the menu.
        <div className="pet-mini">
          <div className="pet-bezel">{screen}</div>
          {keys}
        </div>
      ) : (
        // The whole unit: a little desk terminal — screen, and a deck with the
        // name, a power lamp and the clock.
        <div className="pet-unit">
          <div className="pet-case">
            <div className="pet-bezel">{screen}</div>
            {talking && (
              <form
                className="pet-ask"
                onSubmit={(e) => {
                  e.preventDefault()
                  const el = e.currentTarget.elements.namedItem('q') as HTMLInputElement
                  ask(el.value)
                  el.value = ''
                }}
              >
                <input
                  name="q"
                  autoFocus
                  autoComplete="off"
                  placeholder={t('pet.talk.placeholder')}
                  // The device is a drag handle; the field must not be one.
                  onPointerDown={(e) => e.stopPropagation()}
                />
                {/* The field outlives the answer on purpose (you watch the pet
                    reply on its own screen), so it needs a way out of its own —
                    by then there is no screen title to carry one. */}
                <button
                  type="button"
                  className="pet-ask-x"
                  data-key="ask-close"
                  title={t('pet.back')}
                  aria-label={t('pet.back')}
                  onClick={() => setTalking(false)}
                >
                  <X size={9} />
                </button>
              </form>
            )}
            {/* The deck: name, power lamp, and a clock — which a desk terminal
                has on its face anyway, and pressing it opens the one screen with
                no icon of its own. The keys sit under it, centred. */}
            <div className="pet-deck">
              <span className="pet-logo">{t('pet.title')}</span>
              <span className="pet-led" aria-hidden="true" />
              <button
                type="button"
                className={`pet-clock-btn${mode === 'clock' ? ' on' : ''}`}
                data-ic="clock"
                title={t('pet.mode.clock')}
                onClick={() => setMode(mode === 'clock' ? 'char' : 'clock')}
              >
                {clockTime}
              </button>
            </div>
            {keys}
          </div>
          <div className="pet-stand" aria-hidden="true">
            <i />
          </div>
        </div>
      )}
    </div>
  )
}
