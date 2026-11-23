import { announceNest, servePet } from '../lib/petCommand'
import { useUI } from '../state/ui'
import PetManage from './PetManage'
import { isPageHidden } from '../lib/windowVisibility'
import '../styles/pet.css'
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties } from 'react'
import {
  BarChart3,
  BookOpen,
  ExternalLink,
  EyeOff,
  Clock,
  Coffee,
  Heart,
  ListTree,
  MessageCircle,
  PawPrint,
  Pin,
  Swords,
  Trophy,
  X
} from 'lucide-react'
import { useT, type TFn } from '../i18n'
import { fmtTokens, tightestLimit, useUsage } from '../state/usage'
import { useRoster, workspaceOfPane } from '../state/roster'
import { onCliTurnDone } from '../state/cliTurnBus'
import { useSession, workspaceName } from '../state/session'
import { useAgentEdits } from '../state/agentEdits'
import { answer as talkAnswer } from '../state/petTalk'
import { getActiveApi } from '../dock/registry'
import { useSettings } from '../state/settings'
import { promptInput } from './promptInput'
import { chordFromEvent } from '../keybindings/keys'
import { petKeyChords } from '../keybindings/petKeys'
import { MIMES, frameDrawings, outfitPixels, photoDrawing, pixelsOf, runPaths, runsOf, SPRITE_SIZE, type Run } from './petSprites'
import { motionAnimation, motionCss, motionName, situationOf, type MotionSet, type Situation } from '../lib/petMotion'
import { holdMotion, releaseMotion } from '../lib/petMotionStyle'
import type { FrameMap } from '../lib/petFrames'
import {
  awardsOf,
  dietOf,
  briefOf,
  foodTokens,
  foodTotals,
  feedFrame,
  progressOf,
  wantsBreak,
  workStreakMs,
  BREAK_MIN_MS,
  BREAK_MS,
  BREAK_NAG_EVERY_MS,
  outfitOf,
  prizesOf,
  usePet,
  MAX_PETS,
  PRIZES,
  type Accessory,
  type Mood,
  speciesName,
  type Species
} from '../state/pet'
import { STATS, XP_TOKENS, decorationsOf, nextDecoration, statsOf, topStat } from '../state/petLevel'
import { layoutKey, type DecorLayout } from '../state/petLayout'
import { customOf, hslOf, isCustomId, motionOfSpecies, useCustomSpecies, type CustomDesign } from '../state/petSpecies'
import { PHOTO_DOT } from './petCustomArt'
import { cardOf, encodeCard, fight, isUpset, noteCard, readCode, type BattleCard, type Bout } from '../state/petBattle'

// ---------------------------------------------------------------------------
// 리븐펫: a virtual pet that floats over the workbench, or lives in its own
// window out on the desktop (src-tauri services/pet.rs; settings.petOnTop
// decides whether that window floats above other apps).
//
// Deliberately NOT a dock panel: a pet you have to open a tab for is a pet you
// forget about. It is just the creature on a transparent background: click to
// pat it, right-click for its menu, and every screen opens in a card beside it.
// The keyboard shortcuts press three keys (A walks the menu, B runs it, C backs
// out), so it can be worked without a pointer too.
//
// The levels live in state/pet.ts and state/petLevel.ts (pure + unit-tested)
// and the art in petSprites.ts. This file is the pet on screen: wiring,
// dragging, the screens.
//
// XP comes from the per-account `usage.today` through foodTotals, driven by the
// shared usage poll; the little chew it does is triggered by an actual gain, so
// it works the same in both windows. Nothing animates while nobody is looking.
// ---------------------------------------------------------------------------

const TICK_MS = 15_000
const CHEW_MS = 1600
const FLASH_MS = 1800
const MARGIN = 12

type ScreenMode =
  | 'char'
  | 'clock'
  | 'stats'
  | 'graph'
  | 'awards'
  | 'album'
  | 'manage'
  | 'talk'
  | 'battle'

/** A friend's pet against ours, played back one blow at a time. */
interface Duel {
  mine: BattleCard
  foe: BattleCard
  bout: Bout
}
type DuelResult = 'win' | 'loss' | 'draw'
// Slow enough to follow who hit whom, quick enough that 30 blows is not a wait.
const BLOW_MS = 650

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
// An answer is a sentence, not a mood, give it time to be read.
const ANSWER_MS = 7000
/** How long the line it says on opening the menu stays up. */
const MENU_HI_MS = 4000
const MENU_HI_COUNT = 6
/** .pet-menu's width (pet.css). */
const MENU_W = 172

// How long the screen announces the icon you just moved to before going back to
// showing the pet's name.
const PICK_MS = 1600
// How long a pat (or a level up) keeps it smiling.
const HAPPY_MS = 4000
// On a break the pet suggests something to do with it, a new one this often.
const TIP_MS = 60_000
const TIP_COUNT = 5
const NAG_COUNT = 4
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

// A glyph grid to <rect> dots, for the small props (what the watched pane is doing).
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

/**
 * The colours of a species made from a photo, as the CSS variables pet.css
 * reads (.pet-sp-custom). The face is drawn light on a dark body and dark on
 * a light one, or a black cat would have no eyes.
 */
export function customVars(d: CustomDesign): CSSProperties {
  const dark = hslOf(d.colors.body).l < 0.32
  // A faithful picture's own colours, one variable each (.pet-px-A.. in pet.css).
  const photo: Record<string, string> = {}
  d.photo?.palette.forEach((c, i) => (photo[`--pp-${PHOTO_DOT[i]}`] = c))
  return {
    ...photo,
    '--pc-b': d.colors.body,
    '--pc-n': d.colors.shade,
    '--pc-k': d.colors.highlight,
    '--pc-c': d.colors.accent,
    '--pc-v': d.colors.white,
    '--pc-e': dark ? '#f3f1ee' : '#211d26',
    '--pc-m': dark ? '#f08a9a' : '#6e1f2a'
  } as CSSProperties
}

// The creature itself: one <rect> per lit dot, no anti-aliasing.
export function Creature({
  species,
  mood,
  chewing,
  flavor,
  cheer,
  level = 0,
  outfit: wearing,
  layout,
  still,
  situation,
  motions,
  frames,
  replay
}: {
  species: Species
  mood: Mood
  chewing: boolean
  flavor?: string
  /** A level up: it hops and a ring of dots bursts round it. */
  cheer?: boolean
  /** Its level, for the decorations it has earned by it (decorationsOf). */
  level?: number
  /** What it has on (outfitOf). */
  outfit?: Accessory[]
  /** Where the keeper put its decorations (state/petLayout.ts); automatic where absent. */
  layout?: DecorLayout
  /** Never moves about (the layout editor draws handles over it). */
  still?: boolean
  /**
   * What it is going through (lib/petMotion.ts situationOf). Left out, it is
   * read off cheer, chewing and the mood, as it always was.
   */
  situation?: Situation
  /** Its own motions: a situation with one here runs it instead of pet.css's. */
  motions?: MotionSet
  /** A picture's frames per situation (lib/petFrames.ts), shown in turn. */
  frames?: FrameMap
  /** Bumped to start its motion over (the editor's play button). */
  replay?: number
}): JSX.Element {
  // A species made from a photo: its design, which can change under the same
  // id (edited in settings), so the memos below are keyed on it too.
  useCustomSpecies((s) => s.rev)
  const design = isCustomId(species) ? customOf(species) : null
  // A faithful picture is drawn on its own grid (32, 48 or 64 dots across
  // the same 32 css pixels), not as dots on the shared 32 grid below.
  const photo = useMemo(
    () => (design?.photo ? photoDrawing(species) : null),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [species, design]
  )
  // Same-coloured neighbours in a row share one rect: the drawn grid is four
  // times the dots, and this keeps the rect count near what it was.
  const runs = useMemo(
    () => (photo ? [] : runsOf(pixelsOf(mood, species))),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [mood, species, design, photo]
  )
  const wearingKey = wearing?.join(',')
  // Decorations change only every ten levels: key the layout on those, not the level.
  const decorKey = decorationsOf(level).join(',')
  // Placed once per change of what it wears, its tier or the layout; never per frame.
  const placeKey = layoutKey(layout)
  const outfit = useMemo(() => {
    const { back, front } = outfitPixels(species, wearing ?? [], level, layout)
    return { back: runsOf(back), front: runsOf(front) }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [species, decorKey, wearingKey, design, placeKey])
  // Every animation here runs on an HTML box, never on something inside an
  // <svg>: animating the insides of an svg kept WebKit's GPU process at ~130MB
  // for as long as the pet was on screen (~11MB this way, measured). So the
  // twinkling accent dots ('a') are drawn on layers of their own. The shine
  // behind it twinkles out of step, every second dot half a beat behind, so it
  // glitters rather than blinks.
  const layers = useMemo(() => {
    const still = (list: typeof runs): typeof runs => list.filter((d) => d.ch !== 'a')
    const lit = (list: typeof runs): typeof runs => list.filter((d) => d.ch === 'a')
    return {
      auraStill: still(outfit.back),
      auraLitA: outfit.back.filter((d, i) => d.ch === 'a' && i % 2 === 0),
      auraLitB: outfit.back.filter((d, i) => d.ch === 'a' && i % 2 === 1),
      bodyStill: still(runs),
      bodyLit: lit(runs)
    }
  }, [runs, outfit])
  // A faithful picture has many more runs (its 16 colours break rows up), so
  // its runs are drawn as one <path> per colour instead: a dozen or so nodes
  // instead of several hundred (or, at 64, a couple of thousand) rects.
  // Whole-dot rectangles in whole grid units, so crispEdges draws them
  // exactly as the rects would be.
  const asPaths = !!design?.photo
  const pathsOf = (list: Run[]): JSX.Element[] =>
    runPaths(list).map(({ ch, d }) => <path key={ch} className={`pet-px pet-px-${ch}`} d={d} />)
  // The picture itself, in a nested svg whose viewBox is its own grid scaled
  // to the 32 of the plate: every coordinate stays a whole dot of its grid
  // (no 0.5 or 0.667 in the paths), and neighbouring colours share exact
  // edges, so there are no seams between them. At 64 a dot is half a css
  // pixel, one device pixel on a Retina screen. Made once per design.
  const picture = useMemo(
    () =>
      photo ? (
        <svg
          key="picture"
          x="0"
          y="0"
          width={SPRITE_SIZE}
          height={SPRITE_SIZE}
          viewBox={`0 0 ${photo.size} ${photo.size}`}
          shapeRendering="crispEdges"
        >
          {pathsOf(runsOf(photo.picture))}
        </svg>
      ) : null,
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [photo]
  )
  const dots = (list: typeof runs): JSX.Element[] =>
    asPaths
      ? pathsOf(list)
      : list.map((d) => (
          <rect
            key={`${d.x},${d.y}`}
            className={`pet-px pet-px-${d.ch}`}
            x={d.x}
            y={d.y}
            width={d.w}
            height="1"
          />
        ))
  // One full-box svg on the shared 32-dot grid; every layer letterboxes the same
  // way, so stacked layers line up dot for dot.
  const plate = (children: JSX.Element | JSX.Element[], extra?: string): JSX.Element => (
    <svg
      className={`pet-layer${extra ? ` ${extra}` : ''}`}
      viewBox={`0 0 ${SPRITE_SIZE} ${SPRITE_SIZE}`}
      shapeRendering="crispEdges"
      aria-hidden="true"
    >
      {children}
    </svg>
  )
  // A twinkle is a two-frame reel: the dots, and below them the same dots at
  // 15% (fill-opacity), slid up into view and back with a translate. Fading the
  // layer with opacity instead (or scaling it away) kept WebKit's GPU process at
  // ~130MB the whole time it ran; a translate of a layer that stays on screen is
  // composited for free (measured ~11MB).
  const twinkle = (rects: JSX.Element[], alt?: boolean): JSX.Element | null =>
    rects.length > 0 ? (
      <div className={`pet-tw${alt ? ' alt' : ''}`}>
        <div className="pet-tw-reel">
          {plate(rects)}
          {plate(rects, 'pet-tw-dim')}
        </div>
      </div>
    ) : null
  // A faithful picture has no face, so its mood is in how it moves (pet.css,
  // .pet-pm). Not while a level up is moving it.
  const moves = !!design?.photo && !cheer && !still
  // A situation with a motion of its own: one @keyframes rule per spec, made
  // when the spec changes and put in this document; CSS runs it. Inline, so
  // it wins over the pet.css classes, which still apply wherever there is none
  // (and .pet-asleep / reduced motion, being !important, still stop it).
  const sit: Situation | null = still
    ? null
    : (situation ?? (cheer ? 'levelup' : chewing ? 'eat' : mood === 'happy' ? 'happy' : mood === 'ok' ? 'idle' : null))
  const spec = sit ? motions?.[sit] : undefined
  const motion = useMemo(() => {
    if (!spec) return null
    const name = motionName(spec)
    return { name, css: motionCss(spec, name), anim: motionAnimation(spec, name) }
  }, [spec])
  const lcd = useRef<HTMLDivElement>(null)
  useLayoutEffect(() => {
    const doc = lcd.current?.ownerDocument
    if (!motion || !doc) return
    holdMotion(doc, motion.name, motion.css)
    return () => releaseMotion(doc, motion.name)
  }, [motion])
  // A picture's frames for this situation: worked out once per design and
  // frame list (frameDrawings caches), then a reel of whole pictures slid a
  // picture at a time by CSS steps() (pet.css .pet-fr): no timer, no render.
  const frameSet = sit && design?.photo ? frames?.[sit] : undefined
  const reel = useMemo(
    () =>
      frameSet && design
        ? frameDrawings(design, frameSet.frames).map((f, i) => (
            <svg
              key={i}
              className="pet-layer"
              style={{ top: `${i * 100}%` }}
              viewBox={`0 0 ${SPRITE_SIZE} ${SPRITE_SIZE}`}
              shapeRendering="crispEdges"
              aria-hidden="true"
            >
              <svg x="0" y="0" width={SPRITE_SIZE} height={SPRITE_SIZE} viewBox={`0 0 ${f.size} ${f.size}`} shapeRendering="crispEdges">
                {pathsOf(runsOf(f.picture))}
              </svg>
            </svg>
          ))
        : null,
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [frameSet, design]
  )
  const body = reel ? (
    <div className="pet-fr">
      <div
        className="pet-fr-reel"
        style={{ animation: `pet-fr-${reel.length} ${Math.round((reel.length * 1000) / frameSet!.fps)}ms steps(${reel.length}, end) infinite` }}
      >
        {reel}
      </div>
    </div>
  ) : (
    plate(picture ? [picture, ...dots(layers.bodyStill)] : dots(layers.bodyStill), 'pet-body')
  )
  return (
    <div
      ref={lcd}
      className={`pet-lcd pet-sp-${design ? 'custom' : species} pet-m-${mood}${flavor ? ` pet-diet-${flavor}` : ''}${cheer ? ' cheer' : ''}${design?.photo ? ' pet-photo' : ''}${moves ? ' pet-pm' : ''}`}
      style={design ? customVars(design) : undefined}
      aria-hidden="true"
    >
      <div
        key={replay}
        className={`pet-sprite${chewing ? ' chew' : ''}`}
        style={motion ? { animation: motion.anim } : undefined}
      >
        {/* Its shine and glow behind it, left to twinkle, and the rest on top of it. */}
        {layers.auraStill.length > 0 && plate(dots(layers.auraStill))}
        {twinkle(dots(layers.auraLitA))}
        {twinkle(dots(layers.auraLitB), true)}
        {body}
        {twinkle(dots(layers.bodyLit))}
        {outfit.front.length > 0 && plate(dots(outfit.front))}
      </div>
      {chewing && (
        <div className="pet-crumbs">
          {plate([
            <rect key="a" className="pet-px pet-px-a" x="26" y="4" width="2" height="2" />,
            <rect key="b" className="pet-px pet-px-a" x="4" y="2" width="2" height="2" />
          ])}
        </div>
      )}
      {/* A level up: a ring of dots bursts outward for a moment. */}
      {cheer && (
        <div className="pet-burst">
          {twinkle(
            [
              [16, 0],
              [28, 4],
              [30, 16],
              [26, 28],
              [16, 30],
              [4, 26],
              [0, 16],
              [4, 4]
            ].map(([x, y]) => (
              <rect key={`${x},${y}`} className="pet-px pet-px-a" x={x} y={y} width="2" height="2" />
            ))
          )}
        </div>
      )}
    </div>
  )
}

// A handheld-style segmented gauge: ten dots, lit left to right, and the number.
function Gauge({ label, value, max }: { label: string; value: number; max: number }): JSX.Element {
  const lit = Math.round(Math.min(1, Math.max(0, value / Math.max(1, max))) * 10)
  return (
    <div className="pet-gauge" title={`${label} ${value}`}>
      <span className="pet-gauge-label">{label}</span>
      <span className="pet-gauge-cells">
        {Array.from({ length: 10 }, (_, i) => (
          <i key={i} className={`pet-cell${i < lit ? ' on' : ''}`} />
        ))}
      </span>
      <b className="pet-gauge-num">{value}</b>
    </div>
  )
}

export default function PetDevice({ detached }: { detached?: boolean }): JSX.Element | null {
  const t = useT()
  const show = useSettings((s) => s.settings.petShow)
  const pos = useSettings((s) => s.settings.petPos)
  const savedOnTop = useSettings((s) => s.settings.petOnTop)
  // Same story for the break interval: the app relays changes to the pet window.
  const savedBreakMin = useSettings((s) => s.settings.petBreakMin)
  const [breakMin, setBreakMin] = useState(savedBreakMin)
  useEffect(() => setBreakMin(savedBreakMin), [savedBreakMin])
  useEffect(() => window.api.pet.onBreak(setBreakMin), [])
  const nagMs = breakMin * 60_000
  // In its own window the live answer comes from main, not from this window's
  // settings snapshot: the pet window is not allowed to write settings.json
  // (two writers, last one wins).
  const [winOnTop, setWinOnTop] = useState(false)
  const onTop = detached ? winOnTop : savedOnTop
  const setSettings = useSettings((s) => s.set)
  // The pet's right-click menu.
  const [menu, setMenu] = useState(false)
  // The pet's box when the menu opened, in the app window: the menu sits beside
  // it (right, or left when there is no room) so it never covers the pet.
  const [menuAt, setMenuAt] = useState<DOMRect | null>(null)
  /** The floating window's width before the menu widened it, and the pet's
   *  own width inside it (it fills the window, so it is pinned meanwhile), CSS px. */
  const baseW = useRef<{ win: number; dev: number } | null>(null)
  /** The menu's height there: the device grows to it so the window does too. */
  const [menuH, setMenuH] = useState(0)
  const menuRef = useRef<HTMLDivElement>(null)
  /** The card a screen of the pet's opens in, beside it like the menu. */
  const cardRef = useRef<HTMLDivElement>(null)
  /** Where that card hangs in the app: left of the pet when the right has no
   *  room, and below its top edge when there is no room above. */
  const [cardSide, setCardSide] = useState<{ left: boolean; down: boolean }>({ left: false, down: false })
  /** What the pet said on opening the menu, so closing it can take that back. */
  const menuHi = useRef<string | null>(null)
  /** When a drag last ended: the click that follows a drag is not a pat. */
  const dragEndAt = useRef(0)
  /** Hand-dragging the detached pet (see pet:dragStart in main). */
  const hand = useRef<{ sx: number; sy: number; on: boolean; raf: number } | null>(null)
  const menuLeave = useRef<ReturnType<typeof setInterval> | null>(null)

  const pet = usePet((s) => s.pet)
  const loaded = usePet((s) => s.loaded)
  const load = usePet((s) => s.load)
  const tick = usePet((s) => s.tick)
  const sample = usePet((s) => s.sample)
  const takeBreak = usePet((s) => s.takeBreak)
  const pets = usePet((s) => s.pets)
  const active = usePet((s) => s.active)
  const apply = usePet((s) => s.apply)
  const recordBattle = usePet((s) => s.recordBattle)
  const wear = usePet((s) => s.wear)
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
  // Settings > 리븐펫 looks after the pets too, from another window when the
  // pet lives in its own: it asks here (lib/petCommand), and this window answers
  // with the nest as it is after the command. A new pet comes out at once.
  useEffect(() => {
    if (!loaded) return
    return servePet((cmd) => {
      const result = cmd ? usePet.getState().apply(cmd) : 'ok'
      if (cmd?.op === 'adopt' && result === 'ok') setMode('char')
      return { result, nest: briefOf(usePet.getState()) }
    })
  }, [loaded])
  // And tells everyone listening (a Settings list) whenever the nest changes:
  // a pet out, a name, a level. Compared as text, since the pets themselves
  // change on every gain.
  const lastBrief = useRef('')
  useEffect(() => {
    if (!loaded) return
    const brief = briefOf({ pets, active })
    const text = JSON.stringify(brief)
    if (text === lastBrief.current) return
    lastBrief.current = text
    announceNest(brief)
  }, [loaded, pets, active])
  // Which function the A key's highlight is on (null when none is): the keyboard
  // walks the same list the right-click menu shows.
  const [sel, setSel] = useState<number | null>(null)
  // What the last press in the pet's own panel did, when it is worth a word.
  const [manageNote, setManageNote] = useState<string | null>(null)
  // A break in progress: when it began and the work streak it interrupted. Its
  // clock ticks once a second, and only while there is a break.
  const [resting, setResting] = useState<{ from: number; worked: number } | null>(null)
  const [restNow, setRestNow] = useState(0)
  const lastNag = useRef(0)
  // The ask field stays open across answers. Answering sends the screen back to
  // the pet, that is the point, you watch it answer, and closing the field with
  // it meant every follow-up question needed the menu again.
  const [talking, setTalking] = useState(false)
  // The screen's top line: the name of whatever is under the pointer. A label,
  // not a voice.
  const [flash, setFlash] = useState<string | null>(null)
  // What the pet is actually saying, answers, and news from the workspaces.
  const [speech, setSpeech] = useState<string | null>(null)
  // Re-rendered on the tick, so the clock, the break and the plan limit stay
  // current without a timer of their own.
  const [nowTick, setNowTick] = useState(() => Date.now())
  const justLeveled = usePet((s) => s.justLeveled)
  const ackLevel = usePet((s) => s.ackLevel)
  // A level up being celebrated, and a pat being enjoyed: both make it smile.
  const [cheer, setCheer] = useState(false)
  const [patted, setPatted] = useState(false)
  // A friend battle: the fight, how far through it the playback is, and once it
  // is over, how it went and whether it went on the record (once a day a friend).
  const [duel, setDuel] = useState<Duel | null>(null)
  const [step, setStep] = useState(0)
  const [outcome, setOutcome] = useState<{ result: DuelResult; counted: boolean } | null>(null)
  // Dragging never goes through React. A pointermove that re-renders the device
  // has to rebuild a hundred-odd <rect> dots before the pixel moves, which is
  // exactly the lag you feel in the hand; instead the node is moved directly and
  // the final position is written to settings once, on release.
  const drag = useRef<{ dx: number; dy: number; sx: number; sy: number; x: number; y: number; moved: boolean } | null>(
    null
  )
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

  // Battle playback: one blow per beat, and the record written exactly once, at
  // the end. Holds still while nobody is looking, like everything else here.
  useEffect(() => {
    if (!duel || outcome || !awake) return
    if (step < duel.bout.blows.length) {
      const id = setTimeout(() => setStep((n) => n + 1), BLOW_MS)
      return () => clearTimeout(id)
    }
    const w = duel.bout.winner
    const result: DuelResult = w === null ? 'draw' : w === 0 ? 'win' : 'loss'
    setOutcome({ result, counted: recordBattle(duel.foe.bornAt, result, isUpset(duel.mine, duel.foe)) })
  }, [duel, step, outcome, awake, recordBattle])

  useEffect(() => {
    if (!show && !detached) return
    void load()
    // Not showing it any more: save, and forget the loaded nest, so showing it
    // again reads pet.json afresh (the pet's own window or Settings may have
    // changed it meanwhile).
    return usePet.getState().unload
  }, [show, detached, load])

  // The species the keeper made from photos (made in Settings, in the app's
  // window): this window reads the shared file, and hears when it changes.
  const loadSpecies = useCustomSpecies((s) => s.load)
  const ownSpecies = useCustomSpecies((s) => s.own)
  const speciesLoaded = useCustomSpecies((s) => s.loaded)
  const syncCustom = usePet((s) => s.syncCustom)
  useEffect(() => {
    if (!show && !detached) return
    void loadSpecies()
  }, [show, detached, loadSpecies])
  // Opening the pet panel reads the file again, in case the message from
  // the other window never came (a window that was asleep, another engine).
  useEffect(() => {
    if (mode === 'manage') void loadSpecies()
  }, [mode, loadSpecies])
  // An edited species shows on the pets of it at once; a deleted one leaves
  // them as they were (their own snapshot).
  useEffect(() => {
    if (speciesLoaded && loaded) syncCustom(ownSpecies)
  }, [ownSpecies, speciesLoaded, loaded, syncCustom])

  // The three keys, reachable from riven's keyboard shortcuts. The press is
  // relayed through main, so it works whether the device is in the app window or
  // out on the desktop, and the pet window answers its own keys when focused.
  // The handlers are declared far below, past an early return, so the listener
  // reaches them through a ref: a hook may NOT sit on the far side of a `return`
  // (React counts hooks per render, the in-app device crashed on being hidden).
  const keysRef = useRef<Record<'a' | 'b' | 'c', () => void>>({
    a: NOOP,
    b: NOOP,
    c: NOOP
  })
  useEffect(() => {
    const off = window.api.pet.onPress((k) => keysRef.current[k]?.())
    // riven's window owns the keymap; this window has none, so when the floating
    // pet itself has focus it matches the same chords directly, from the same
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

  // Keep the on-top switch honest about whether the window is actually floating.
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
      const next = !isPageHidden() && document.hasFocus()
      awakeRef.current = next
      setAwake(next)
    }
    compute()
    // The floating window is deliberately never focused (showInactive), so for it
    // "awake" is just "is this window visible", otherwise the desk pet would sit
    // frozen forever while you work in another app, which is exactly when you
    // want to see it.
    const computeDetached = (): void => {
      const next = !isPageHidden()
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

  // The clock and the seasonal events only need a look while someone is looking.
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

  // A level up: it hops, a ring of dots bursts round it, and it says so.
  useEffect(() => {
    if (!justLeveled) return
    ackLevel()
    setCheer(true)
    setFlash(t('pet.levelUp', { n: justLeveled }))
    later(() => setCheer(false), 2600)
    later(() => setFlash(null), 2600)
  }, [justLeveled, ackLevel, later, t])

  // A prize just unlocked (an award that comes with something to wear). The
  // first look at each pet only takes stock, so switching pets or loading the
  // save never announces what was already there.
  const prizeKey = useMemo(() => prizesOf(pet).join(','), [pet])
  const seenPrizes = useRef<{ pet: number; ids: string } | null>(null)
  useEffect(() => {
    const seen = seenPrizes.current
    seenPrizes.current = { pet: pet.bornAt, ids: prizeKey }
    if (!loaded || !seen || seen.pet !== pet.bornAt) return
    const before = new Set(seen.ids.split(','))
    const fresh = prizeKey.split(',').find((id) => id && !before.has(id))
    if (!fresh) return
    setFlash(t('pet.prizeNew', { item: t(`pet.acc.${fresh}`) }))
    later(() => setFlash(null), 2600)
  }, [prizeKey, pet.bornAt, loaded, later, t])

  // XP from the usage totals. Ignored until the save is loaded, so the first
  // sample can't credit a pet that is about to be replaced by the stored one.
  useEffect(() => {
    if (!loaded) return
    // One counter per account AND model, so the pet's diet records which model
    // actually paid for the work (see foodTotals).
    let totals = foodTotals(accounts)
    if (!Object.keys(totals).length && fallbackToday) totals = foodTotals([{ id: 'claude', today: fallbackToday }])
    if (Object.keys(totals).length) sample(totals)
  }, [loaded, accounts, fallbackToday, sample])

  // A little chew whenever XP actually lands: true in both windows, unlike the
  // chat stream (which only reaches the window that started the turn).
  const lastMeal = useRef(0)
  const mealOf = useRef(active)
  useEffect(() => {
    if (!pet.lastFedAt || pet.lastFedAt === lastMeal.current) return
    // Picking another pet out of the nest shows ITS last gain, not a new one.
    const first = lastMeal.current === 0 || mealOf.current !== active
    lastMeal.current = pet.lastFedAt
    mealOf.current = active
    if (first) return // the gain that came out of the save file, not a fresh one
    setChewing(true)
    later(() => setChewing(false), CHEW_MS)
  }, [pet.lastFedAt, active, later])

  // ---- reacting to the work ----
  //
  // Chat events arrive for EVERY pane in every workspace, dozens per turn. Two
  // rules keep that from turning the pet into a strobe:
  //
  //  · a tool is mimed only when it comes from the pane you are actually looking
  //    at, a mime needs one subject, and that is the one you can follow;
  //  · a turn ENDING is announced wherever it happened, because that is the bit
  //    you want while looking away. It is announced once, in words, naming the
  //    workspace, and only for panes you are not already watching.
  //
  // Everything else is absorbed by the busy count above.
  const busyRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  useEffect(() => {
    if (detached) return
    const watchingPane = (key: string): { ws: string | null; watching: boolean } => {
      const ws = workspaceOfPane(key)
      return { ws, watching: useSession.getState().activeWorkspace === ws && getActiveApi()?.activePanel?.id === key }
    }
    const onTool = (key: string, name: string): void => {
      if (!watchingPane(key).watching || !awakeRef.current || mimeRef.current) return
      const mime = mimeOf(name)
      if (!mime) return
      setMime(mime)
      mimeRef.current = true
      later(() => {
        setMime(null)
        mimeRef.current = false
      }, MIME_MS)
    }
    const onTurnDone = (key: string, error: boolean): void => {
      const { ws, watching } = watchingPane(key)
      // Tokens have just been spent: ask usage now rather than waiting the poll.
      useUsage.getState().refresh()
      const where = workspaceName(ws ?? '', useSession.getState().names)
      if (!where) return
      const entry: Finished = { workspace: where, title: key, at: Date.now(), failed: error }
      setRecent((r) => [entry, ...r].slice(0, RECENT_KEEP))
      // Saying "done" about the pane you are staring at is noise.
      if (watching && !error) return
      speak(t(error ? 'pet.notice.failed' : 'pet.notice.done', { where }), NOTICE_MS)
    }
    const offChat = window.api.chat.onEvent((e) => {
      if (e.kind === 'tool') onTool(e.key, e.name)
      else if (e.kind === 'turnDone') onTurnDone(e.key, !!e.error)
    })
    // The CLI chat: its tool calls arrive as transcript items, its turn end
    // from the hub (a stopped turn is not news).
    const offCli = window.api.cliChat.onEvent((e) => {
      if (e.kind !== 'items' || e.reset) return
      const items = (e as unknown as { items: Array<{ kind: string; name?: string }> }).items
      const tool = items.filter((i) => i.kind === 'tool').pop()
      if (tool?.name) onTool(e.key, tool.name)
    })
    const offCliDone = onCliTurnDone((key, done) => {
      if (!done.interrupted) onTurnDone(key, !!done.error)
    })
    return () => {
      offChat()
      offCli()
      offCliDone()
    }
  }, [detached, later, t])

  // The pet has no screen of its own, so anything that needs one (a menu
  // screen, a battle, a question) opens one in a card beside it; once that is
  // done with, the card folds away and it is just the pet again.
  const peek = mode !== 'char' || !!resting || talking

  // ---- break time ----
  // Long enough at it and the pet asks you to step away, again every
  // BREAK_NAG_EVERY_MS until you do. The streak lives in the save (see earn), so
  // both windows agree on it; this only decides when to say so.
  const needBreak = loaded && !resting && wantsBreak(pet, nowTick, nagMs)
  useEffect(() => {
    if (!needBreak || (!show && !detached)) return
    const now = Date.now()
    if (now - lastNag.current < BREAK_NAG_EVERY_MS) return
    lastNag.current = now
    const msg = t(`pet.break.nag.${Math.floor(Math.random() * NAG_COUNT)}`, {
      n: Math.floor(workStreakMs(pet, now) / 60_000)
    })
    setSpeech(msg)
    later(() => setSpeech((v) => (v === msg ? null : v)), ANSWER_MS)
  }, [needBreak, nowTick, show, detached, pet, later, t])

  // The break's clock: a tip a minute, and the end when the time is up.
  useEffect(() => {
    if (!resting) return
    const step = (): void => {
      const now = Date.now()
      setRestNow(now)
      if (now - resting.from >= BREAK_MS) {
        takeBreak(resting.worked, now - resting.from, nagMs)
        setResting(null)
        lastNag.current = now
        setSpeech(t('pet.break.done'))
        later(() => setSpeech((v) => (v === t('pet.break.done') ? null : v)), ANSWER_MS * 2)
        return
      }
      const tip = Math.floor((now - resting.from) / TIP_MS)
      setSpeech(t(`pet.break.tip.${tip % TIP_COUNT}`))
    }
    step()
    const id = setInterval(step, 1000)
    return () => clearInterval(id)
  }, [resting, takeBreak, nagMs, later, t])

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
    // With the menu open the window also widens to the right to hold it, and
    // gives the width back once, when it closes.
    const send = (): void => {
      // The question field focuses itself before the window has grown, and the
      // page scrolls to it: that crops the top and reads the bottom short.
      // Nothing in this window is meant to scroll, so undo it before measuring.
      for (let p = el.parentElement; p; p = p.parentElement) if (p.scrollTop || p.scrollLeft) p.scrollTo(0, 0)
      const h = Math.ceil(el.getBoundingClientRect().bottom) + 6
      const base = baseW.current
      const beside = menu ? menuRef.current : peek ? cardRef.current : null
      if (beside && base) return void window.api.pet.resize(h, base.win + beside.offsetWidth + 6)
      if (!beside && base) {
        baseW.current = null
        return void window.api.pet.resize(h, base.win)
      }
      void window.api.pet.resize(h)
    }
    send()
    // Measure again on the next frame as well: a change is measured the
    // instant it renders, and the sprite and font work that follows can still
    // move the bottom edge: folding back up left the window at the folded
    // height with the case cut off.
    const frame = requestAnimationFrame(send)
    const ro = new ResizeObserver(send)
    ro.observe(el)
    // And whenever the window itself changes size. The device's own box does not
    // change when the WINDOW does, so the observer above never fires for it,
    // which left any window that ended up too small staying too small. Asking
    // for a height it already has is a no-op in main, so this cannot loop.
    window.addEventListener('resize', send)
    return () => {
      cancelAnimationFrame(frame)
      ro.disconnect()
      window.removeEventListener('resize', send)
    }
  }, [detached, mode, resting, talking, menu, peek, menuH])

  // In its own window the menu (or a screen's card) hangs beside the device,
  // bottoms aligned, so the device is made at least as tall as it to keep it
  // inside the window. The window's own width is noted first, to give back.
  useLayoutEffect(() => {
    const beside = menu ? menuRef.current : peek ? cardRef.current : null
    if (detached && beside && !baseW.current && ref.current) {
      baseW.current = { win: window.innerWidth, dev: ref.current.offsetWidth }
    }
    setMenuH(detached && beside ? beside.offsetHeight : 0)
    if (!detached || !beside) return
    // The card is as tall as its page, so it changes with the page and with what
    // the page holds (a chat growing): follow it, or the window crops it.
    const ro = new ResizeObserver(() => setMenuH(beside.offsetHeight))
    ro.observe(beside)
    return () => ro.disconnect()
  }, [menu, peek, detached, mode, talking, resting])

  // In the app the card opens to the pet's right, or its left when the window has
  // no room there; bottoms aligned, or tops when there is no room above.
  useLayoutEffect(() => {
    if (detached || !peek || menu) return
    const el = ref.current
    const card = cardRef.current
    if (!el || !card) return
    const r = el.getBoundingClientRect()
    const left = r.right + 6 + card.offsetWidth > window.innerWidth - 8
    const down = r.bottom - card.offsetHeight < 8
    setCardSide((v) => (v.left === left && v.down === down ? v : { left, down }))
  }, [detached, peek, menu, pos, mode, talking])

  // The menu closes on Esc, a press anywhere else, or riven losing focus. The
  // floating window never has focus (so no Esc, no blur): there it also closes
  // when the pointer leaves the pet (see onPointerLeave below).
  useEffect(() => {
    if (!menu) return
    const key = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setMenu(false)
    }
    const down = (e: PointerEvent): void => {
      if (!ref.current?.contains(e.target as Node)) setMenu(false)
    }
    const blur = (): void => setMenu(false)
    window.addEventListener('keydown', key)
    window.addEventListener('pointerdown', down, { capture: true })
    if (!detached) window.addEventListener('blur', blur)
    return () => {
      window.removeEventListener('keydown', key)
      window.removeEventListener('pointerdown', down, { capture: true })
      window.removeEventListener('blur', blur)
      if (menuLeave.current) clearInterval(menuLeave.current)
      menuLeave.current = null
      const hi = menuHi.current
      menuHi.current = null
      if (hi) setSpeech((v) => (v === hi ? null : v))
    }
  }, [menu, detached])

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
    // looks, clamping and the next drag both measure the same rect.
    el.style.left = `${x}px`
    el.style.top = `${y}px`
    el.style.right = 'auto'
    el.style.bottom = 'auto'
  }, [])

  // Dragging listens on the WINDOW, not on the device.
  //
  // With the listeners on the element, a release the element never saw, the
  // pointer left it, capture was refused, the window lost focus, left the drag
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
      // A few pixels of wobble is still a click (a pat), not a drag.
      if (!d.moved && Math.abs(e.clientX - d.sx) < 4 && Math.abs(e.clientY - d.sy) < 4) return
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
    if (d?.moved) {
      dragEndAt.current = Date.now()
      setSettings({ petPos: { x: d.x, y: d.y } })
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [setSettings, stopDrag])

  const onPointerDown = (e: React.PointerEvent): void => {
    // Buttons and the text field act; everything else is a drag handle. (Detached,
    // the OS drags the window for us, see -webkit-app-region in the stylesheet.)
    if (detached || e.button !== 0) return
    if ((e.target as HTMLElement).closest('button, input, form, .pet-menu, .pet-card')) return
    const el = ref.current
    if (!el) return
    const r = el.getBoundingClientRect()
    drag.current = {
      dx: e.clientX - r.left,
      dy: e.clientY - r.top,
      sx: e.clientX,
      sy: e.clientY,
      x: r.left,
      y: r.top,
      moved: false
    }
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
  // The tightest plan window across the accounts, the one that will bite first.
  const limit = useMemo(() => {
    const all = accounts.map(tightestLimit).filter((l): l is NonNullable<typeof l> => !!l)
    if (!all.length) return null
    return all.reduce((worst, l) => (l.usedPct > worst.usedPct ? l : worst))
  }, [accounts])

  const growth = useMemo(() => progressOf(pet.xp), [pet.xp])
  const mood: Mood = patted || cheer ? 'happy' : 'ok'
  // How it moves now (lib/petMotion.ts): an agent waiting for you, one at
  // work, a break, a pat. Its own motions over its species'; a situation with
  // neither moves as pet.css always had it.
  const waiting = useMemo(() => Object.values(live).some((l) => l.attention === 'needs_input'), [live])
  const situation = situationOf({ cheer, chewing: chewing && awake, patted, resting: !!resting, waiting, working: busy.length > 0 })
  useCustomSpecies((s) => s.rev)
  const speciesMotion = motionOfSpecies(pet.species)
  const motions = useMemo(
    () => (speciesMotion?.specs || pet.motion ? { ...speciesMotion?.specs, ...pet.motion } : undefined),
    [speciesMotion, pet.motion]
  )
  const diet = useMemo(() => dietOf(pet), [pet])
  const stats = useMemo(
    () => statsOf(growth.level, pet.species, pet.diet, customOf(pet.species) ?? pet.custom),
    [growth.level, pet.species, pet.diet, pet.custom]
  )
  const awards = useMemo(() => awardsOf(pet), [pet])
  const outfit = useMemo(() => outfitOf(pet.worn), [pet.worn])

  if (!show && !detached) {
    // Put away: a shortcut must not act on a pet that is not on screen, so the
    // relayed presses land on nothing.
    keysRef.current = { a: NOOP, b: NOOP, c: NOOP }
    return null
  }

  // Unnamed: the screen shows what it is rather than the words "no name".
  const name = pet.name || null

  // One short line, the most pressing thing first, in the balloon over the pet.
  const bubble =
    speech ??
    (limit && limit.usedPct >= 90
      ? t('pet.say.limit', { left: Math.max(0, 100 - Math.round(limit.usedPct)) })
      : needBreak
        ? t('pet.say.break')
        : busy.length >= 4
          ? t('pet.say.swamped', { n: busy.length })
          : null)

  const doRename = async (): Promise<void> => {
    // In its own window the pet cannot focus itself (by design, see pet.ts), so
    // it borrows the keyboard for the prompt and gives it straight back.
    if (detached) await window.api.pet.focusable(true)
    try {
      const v = await promptInput({ title: t('pet.renameTitle'), initial: pet.name })
      if (v !== null) apply({ op: 'rename', index: active, bornAt: pet.bornAt, name: v })
    } finally {
      if (detached) void window.api.pet.focusable(false)
    }
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
  /** What it says when the menu opens. */
  const menuLine = (): string => t(`pet.menuHi.${Math.floor(Math.random() * MENU_HI_COUNT)}`)
  const startBreak = (): void => {
    const now = Date.now()
    leaveDuel()
    setTalking(false)
    setMode('char')
    setResting({ from: now, worked: workStreakMs(pet, now) })
    setRestNow(now)
  }
  /** Cut a break short: a minute or more still counts for something. */
  const endBreak = (): void => {
    if (!resting) return
    const rested = Date.now() - resting.from
    takeBreak(resting.worked, rested, nagMs)
    setResting(null)
    if (rested >= BREAK_MIN_MS) lastNag.current = Date.now()
    speak(t(rested >= BREAK_MIN_MS ? 'pet.break.short' : 'pet.break.cancel'))
  }
  // ---- friend battles ----
  // No server: you send your code, your friend sends theirs, and each side
  // pastes the other's. The same two codes make the same fight on both machines.
  const copyCode = async (): Promise<void> => {
    await window.api.pet.copy(encodeCard(cardOf(pet)))
    say(t('pet.battle.copied'))
  }
  const pasteCode = async (): Promise<void> => {
    const mine = cardOf(pet)
    // The pasted code needs a keyboard, which the floating pet borrows (see doRename).
    if (detached) await window.api.pet.focusable(true)
    let text: string | null
    try {
      text = await promptInput({ title: t('pet.battle.pasteTitle'), initial: '' })
    } finally {
      if (detached) void window.api.pet.focusable(false)
    }
    if (!text?.trim()) return
    const read = readCode(text)
    if ('error' in read) return speak(t(read.error === 'newer' ? 'pet.battle.newer' : 'pet.battle.bad'))
    const foe = read.card
    // A friend's animal made from a photo is drawn from the design in its code.
    noteCard(foe)
    // A friend's pet, never one of your own: a pet is known by its birthday.
    if (pets.some((p) => Math.floor(p.bornAt) === foe.bornAt)) return speak(t('pet.battle.own'))
    setSpeech(null)
    setOutcome(null)
    setStep(0)
    setDuel({ mine, foe, bout: fight(mine, foe) })
  }
  /** Out of the arena, back to the battle menu. */
  const leaveDuel = (): void => {
    setDuel(null)
    setOutcome(null)
    setStep(0)
  }

  // ---- the functions ----
  //
  // Everything the pet can do, as the right-click menu lists it (the first
  // CARE as its row of buttons). The break button lights by itself when it is
  // time for one; `on` marks the screen you are looking at.
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
      id: 'graph',
      label: t('pet.mode.graph'),
      node: <BarChart3 size={11} />,
      on: mode === 'graph',
      run: () => openScreen('graph')
    },
    {
      id: 'rest',
      label: t('pet.break'),
      node: <Coffee size={11} />,
      alert: needBreak,
      on: !!resting,
      run: () => (resting ? endBreak() : startBreak())
    },
    {
      id: 'pet',
      label: t('pet.pet'),
      node: <Heart size={11} />,
      run: () => {
        setPatted(true)
        later(() => setPatted(false), HAPPY_MS)
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
      id: 'battle',
      label: t('pet.mode.battle'),
      node: <Swords size={11} />,
      on: mode === 'battle',
      run: () => openScreen('battle')
    },
    {
      id: 'clock',
      label: t('pet.mode.clock'),
      node: <Clock size={11} />,
      on: mode === 'clock',
      run: () => openScreen('clock')
    },
    {
      id: 'talk',
      label: t('pet.talk.label'),
      node: <MessageCircle size={11} />,
      on: mode === 'talk',
      run: () => openScreen('talk')
    },
    {
      id: 'manage',
      label: t('pet.nest.title'),
      node: <PawPrint size={11} />,
      on: mode === 'manage',
      run: () => openScreen('manage')
    }
  ]
  /** How many of the icons make the row of buttons at the top of the menu. */
  const CARE = 3

  /** Open a screen. The ask field belongs to the talk screen and follows it. */
  const openScreen = (m: ScreenMode): void => {
    setTalking(m === 'talk')
    leaveDuel()
    setManageNote(null)
    setMode(m)
  }

  /** Out of whatever screen is up, and nothing left being said. */
  const backHome = (): void => {
    setSpeech(null)
    if (resting) endBreak()
    setTalking(false)
    leaveDuel()
    setMode('char')
  }

  // ---- the three keys ----
  // The keyboard's way in (see the shortcuts, above): A walks the functions,
  // B runs the one it is on (or shows the clock), C backs out.
  const METER_PAGES: ScreenMode[] = ['stats', 'awards']
  const pressA = (): void => {
    if (mode === 'battle') return void copyCode()
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
    if (mode === 'battle') {
      // Mid-fight, B skips to the end; otherwise it takes the next friend's code.
      if (duel && !outcome) return setStep(duel.bout.blows.length)
      return void pasteCode()
    }
    if (sel === null) return setMode(mode === 'clock' ? 'char' : 'clock')
    icons[sel].run()
  }
  const pressC = (): void => {
    // C is "never mind": it also shuts the pet up, so a long answer can be
    // dismissed instead of waited out.
    setSpeech(null)
    if (resting) return endBreak()
    if (mode === 'battle' && duel) return leaveDuel()
    if (mode !== 'char') {
      setTalking(false)
      setMode('char')
      return
    }
    setTalking(false)
    setSel(null)
  }
  keysRef.current = { a: pressA, b: pressB, c: pressC }

  // ---- looking after the pets (the pet panel, PetManage) ----
  const ref0 = (i: number): { index: number; bornAt: number } => ({ index: i, bornAt: pets[i]?.bornAt ?? -1 })
  const toggleWhere = (): void =>
    void (detached ? window.api.pet.dock() : setSettings({ petDetached: true }))
  // Main lifts the window and tells the app to remember it (see PetHost).
  const setOnTopNow = (on: boolean): void => void window.api.pet.askOnTop(on)
  const hide = (): void => void (detached ? window.api.pet.hide() : setSettings({ petShow: false }))
  const openSettings = (): void => {
    if (detached) void window.api.pet.openSettings('pet')
    else useUI.getState().openSettings('pet')
  }
  // The decoration layout lives in Settings > 리븐펫 (it needs room and a keyboard).
  const openLayout = (): void => {
    if (detached) void window.api.pet.openSettings('pet-layout')
    else useUI.getState().openPetLayout()
  }
  // And the pet's motion editor (움직임).
  const openMotion = (): void => {
    if (detached) void window.api.pet.openSettings('pet-motion')
    else useUI.getState().openPetMotion()
  }
  // So does the species maker (a modal over Settings).
  const openMaker = (): void => {
    if (detached) void window.api.pet.openSettings('pet-maker')
    else useUI.getState().openPetMaker()
  }
  const nestNote = (result: string): void =>
    setManageNote(result === 'full' ? t('pet.nest.full', { max: MAX_PETS }) : null)
  // Ask it something. Every answer is read off what riven already knows, so it
  // costs nothing and cannot invent anything (see state/petTalk.ts).
  const ask = (question: string): void => {
    const q = question.trim()
    if (!q) return
    // It answers by SAYING it, the screen goes back to the pet and the balloon
    // carries the reply. A transcript would just be a small chat window, and
    // there is a real one of those two panes away.
    const said = talkAnswer(q, {
      pet,
      now: Date.now(),
      busy,
      recent,
      todayTokens: accounts.reduce((n, a) => n + foodTokens(a.today), 0),
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

  // Seven calendar days, worked or not (see feedFrame): plotting only the days
  // with XP in them drew one fat bar for a new pet and put distant days next to
  // each other. The scale is printed, because a bar chart with no numbers on a
  // 160-pixel screen says nothing.
  const graph = feedFrame(pet.history, nowTick)
  const peak = Math.max(1, ...graph.map((d) => d.xp))
  const weekTotal = graph.reduce((n, d) => n + d.xp, 0)

  // On a break the foot says how to cut it short, and the count so far.
  const restLeft = resting ? Math.max(0, BREAK_MS - (restNow - resting.from)) : 0
  const footer = resting
    ? t('pet.break.hint', { n: pet.plays })
    : growth.toNext > 0
      ? t('pet.toLevel', { lv: growth.level, n: growth.toNext })
      : t('pet.maxLevel', { lv: growth.level })
  const nextDecor = nextDecoration(growth.level)
  const statMax = stats[topStat(stats)]

  // Asking puts the screen back on the pet (the reply is a balloon), but the chat
  // card stays up for the next question: keep its title, and the X on it.
  const chatCard = talking
  const screen = (
    <div className="pet-screen">
      {/* Nothing is printed over the picture but a single line, and only when
          there is something to say. */}
      {(mode !== 'char' || flash || resting || chatCard) && (
        <div className="pet-screen-top">
          <span>{mode !== 'char' ? t(`pet.mode.${mode}`) : chatCard ? t('pet.mode.talk') : ''}</span>
          <span className={`pet-screen-mood mood-${mood}`}>
            {flash ??
              (resting
                ? t('pet.break.left', {
                    t: `${Math.floor(restLeft / 60_000)}:${String(Math.floor((restLeft % 60_000) / 1000)).padStart(2, '0')}`
                  })
                : '')}
          </span>
          {/* The way out of whatever is up, on the title of the thing itself,
              where you are already looking. */}
          {(mode !== 'char' || resting || chatCard) && (
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

      {mode === 'stats' && (
        <dl className="pet-rows">
          <div className="pet-meters">
            {STATS.map((k) => (
              <Gauge key={k} label={t(`pet.stat.${k}`)} value={stats[k]} max={statMax} />
            ))}
          </div>
          <div>
            <dt>{t('pet.stat.name')}</dt>
            <dd>{name ?? t('pet.default.name')}</dd>
          </div>
          <div>
            <dt>{t('pet.stat.species')}</dt>
            <dd>{speciesName(pet.species, t, customOf(pet.species) ?? pet.custom)}</dd>
          </div>
          <div>
            <dt>{t('pet.stat.level')}</dt>
            <dd>{footer}</dd>
          </div>
          <div>
            <dt>{t('pet.stat.decor')}</dt>
            <dd>
              {nextDecor
                ? t('pet.decor.next', { item: t(`pet.decor.${nextDecor.id}`), lv: nextDecor.level })
                : t('pet.decor.all')}
            </dd>
          </div>
          <div>
            <dt>{t('pet.stat.xp')}</dt>
            <dd>{pet.xp.toLocaleString()}</dd>
          </div>
          <div>
            <dt>{t('pet.stat.tokens')}</dt>
            <dd>{fmtTokens(pet.totalTokens)}</dd>
          </div>
          <div>
            <dt>{t('pet.stat.age')}</dt>
            <dd>{dur(t, Date.now() - pet.bornAt)}</dd>
          </div>
          <div>
            <dt>{t('pet.stat.lastGain')}</dt>
            <dd>{pet.lastFedAt ? dur(t, Date.now() - pet.lastFedAt) : t('pet.never')}</dd>
          </div>
          <div>
            <dt>{t('pet.stat.breaks')}</dt>
            <dd>{pet.plays ? t('pet.stat.breaksValue', { n: pet.plays, asked: pet.wins }) : t('pet.never')}</dd>
          </div>
          <div>
            <dt>{t('pet.battle.record')}</dt>
            <dd>
              {pet.battles
                ? t('pet.battle.recordValue', { n: pet.battles, w: pet.battleWins })
                : t('pet.never')}
            </dd>
          </div>
          {limit && (
            <div>
              <dt>{t('pet.stat.limit')}</dt>
              <dd className={limit.usedPct >= 90 ? 'warn' : undefined}>
                {t('pet.stat.limitValue', {
                  left: Math.max(0, 100 - Math.round(limit.usedPct)),
                  in: limit.resetsAt ? dur(t, new Date(limit.resetsAt).getTime() - nowTick) : '-'
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
                className={`pet-bar${d.today ? ' today' : ''}${d.xp === 0 ? ' none' : ''}`}
                title={t('pet.graph.day', { day: d.day, n: d.xp })}
              >
                {/* A day with nothing in it gets a floor, not a bar: the gap has
                    to be visible or the chart lies about the week. */}
                <i style={{ height: d.xp ? `${Math.max(8, (d.xp / peak) * 100)}%` : '1px' }} />
                <span>{Number(d.day.slice(8))}</span>
              </div>
            ))}
          </div>
          <div className="pet-graph-foot">
            {weekTotal === 0
              ? t('pet.graph.empty')
              : t('pet.graph.today', { n: graph[graph.length - 1].xp })}
          </div>
          <p className="pet-note">{t('pet.hint', { n: XP_TOKENS.toLocaleString() })}</p>
        </div>
      )}

      {mode === 'awards' && (
        <div className="pet-awards">
          {awards.map((a) => {
            // An award with a prize: once earned, a click puts it on (or takes it off).
            const prize = PRIZES.find((p) => p.award === a.id)
            const item = prize ? t(`pet.acc.${prize.id}`) : ''
            const on = !!prize && pet.worn.includes(prize.id)
            const wearable = !!prize && a.done
            return (
              <div
                key={a.id}
                className={`pet-award${a.done ? ' done' : ''}${a.event ? ' event' : ''}${wearable ? ' prize' : ''}${on ? ' worn' : ''}`}
                title={
                  !prize
                    ? t(`pet.award.${a.id}`)
                    : wearable
                      ? t(on ? 'pet.prizeOff' : 'pet.prizeOn', { item })
                      : t('pet.prizeLocked', { item })
                }
                onClick={wearable ? () => wear(prize.id) : undefined}
              >
                <i />
                <span>{t(`pet.award.${a.id}`)}</span>
                {item && <em>{on ? `[${item}]` : item}</em>}
              </div>
            )
          })}
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
                {speciesName(a.species, t, a.speciesName ? { name: a.speciesName } : customOf(a.species))} ·{' '}
                {t('pet.level', { n: a.level })} · {fmtTokens(a.tokens)} · {dur(t, a.ageMs)}
              </span>
            </div>
          ))}
        </div>
      )}

      {mode === 'battle' && !duel && (
        <div className="pet-rows pet-settings">
          <button type="button" data-row="copy" className="pet-row" onClick={() => void copyCode()}>
            <span>{t('pet.battle.copy')}</span>
            <b>A</b>
          </button>
          <button type="button" data-row="paste" className="pet-row" onClick={() => void pasteCode()}>
            <span>{t('pet.battle.paste')}</span>
            <b>B</b>
          </button>
          <div className="pet-row">
            <span>{t('pet.battle.record')}</span>
            <b>
              {pet.battles
                ? t('pet.battle.recordValue', { n: pet.battles, w: pet.battleWins })
                : t('pet.never')}
            </b>
          </div>
          <p className="pet-note">{t('pet.battle.hint')}</p>
        </div>
      )}

      {mode === 'battle' && duel && (() => {
        const blow = step > 0 ? duel.bout.blows[step - 1] : null
        const hp = blow?.hp ?? [duel.bout.fighters[0].hp, duel.bout.fighters[1].hp]
        // Faces change only once it is over: the winner beams, the loser sulks.
        const winner = outcome && outcome.result !== 'draw' ? duel.bout.winner : null
        const side = (i: 0 | 1, c: BattleCard): JSX.Element => {
          const swung = blow && blow.by === i
          const hit = blow && blow.by !== i && !blow.miss
          const pct = Math.round((hp[i] / duel.bout.fighters[i].hp) * 100)
          return (
            <div className={`pet-fighter side-${i}`}>
              <span className="pet-fighter-name">
                {c.name || speciesName(c.species, t, c.custom ?? customOf(c.species))} {t('pet.level', { n: c.level })}
              </span>
              <i className="pet-hp">
                <i style={{ width: `${pct}%` }} className={pct <= 25 ? 'low' : undefined} />
              </i>
              <div
                key={step}
                className={`pet-fighter-body${swung ? ' swing' : ''}${hit ? ' hit' : ''}`}
              >
                <Creature
                  species={c.species}
                  mood={winner === null ? 'ok' : winner === i ? 'happy' : 'sad'}
                  chewing={false}
                  level={c.level}
                  outfit={outfitOf(c.worn ?? [])}
                />
              </div>
              {hit && (
                <b key={`d${step}`} className={`pet-dmg${blow.crit ? ' crit' : ''}`}>
                  -{blow.dmg}
                </b>
              )}
              {blow && blow.miss && blow.by !== i && (
                <b key={`m${step}`} className="pet-dmg miss">
                  {t('pet.battle.miss')}
                </b>
              )}
            </div>
          )
        }
        return (
          <div className="pet-arena">
            <div className="pet-arena-row">
              {side(0, duel.mine)}
              {side(1, duel.foe)}
            </div>
            <div className="pet-arena-foot">
              {outcome
                ? `${t(`pet.battle.${outcome.result}`)}${outcome.counted ? '' : ` · ${t('pet.battle.notCounted')}`}`
                : blow?.crit
                  ? t('pet.battle.crit')
                  : t('pet.battle.turn', { n: step, of: duel.bout.blows.length })}
            </div>
          </div>
        )
      })()}

    </div>
  )

  // The ask field, under the talk screen.
  const askForm = talking && (
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
        // The pet is a drag handle; the field must not be one.
        onPointerDown={(e) => e.stopPropagation()}
      />
    </form>
  )

  /** A menu entry does its thing and the menu goes away. */
  const pick = (run: () => void) => (): void => {
    setMenu(false)
    run()
  }
  const care = icons.slice(0, CARE)
  const pages = icons.slice(CARE)

  // In the app the menu opens beside the pet, bottoms aligned: to its right, or
  // its left when the window has no room there. Its own window widens instead
  // (see pet:resize above and .pet-detached .pet-menu).
  const menuStyle: CSSProperties | undefined =
    detached || !menuAt
      ? undefined
      : {
          position: 'fixed',
          transform: 'none',
          margin: 0,
          left:
            menuAt.right + 6 + MENU_W <= window.innerWidth - 8 ? menuAt.right + 6 : Math.max(8, menuAt.left - 6 - MENU_W),
          top: 'auto',
          bottom: Math.max(8, window.innerHeight - menuAt.bottom),
          maxHeight: Math.max(120, menuAt.bottom - 8),
          overflowY: 'auto'
        }
  // Right-click on the pet: every function, as a plain list.
  const menuBox = menu && (
    <div ref={menuRef} className="pet-menu" role="menu" style={menuStyle} onContextMenu={(e) => e.preventDefault()}>
      <div className="pet-menu-care">
        {care.map((ic) => (
          <button
            key={ic.id}
            type="button"
            data-ic={ic.id}
            className={`pet-ic${ic.alert ? ' alert' : ''}`}
            title={ic.label}
            aria-label={ic.label}
            onClick={pick(ic.run)}
          >
            {ic.node}
          </button>
        ))}
      </div>
      {pages.map((ic) => (
        <button key={ic.id} type="button" role="menuitem" className="pet-menu-item" onClick={pick(ic.run)}>
          {ic.node}
          <span>{ic.label}</span>
        </button>
      ))}
      <div className="pet-menu-sep" />
      {detached && (
        <button
          type="button"
          role="menuitemcheckbox"
          aria-checked={onTop}
          className={`pet-menu-item${onTop ? ' on' : ''}`}
          onClick={pick(() => setOnTopNow(!onTop))}
        >
          <Pin size={11} />
          <span>{t('pet.onTop')}</span>
        </button>
      )}
      <button type="button" role="menuitem" className="pet-menu-item" onClick={pick(toggleWhere)}>
        <ExternalLink size={11} />
        <span>{detached ? t('pet.menu.putBack') : t('pet.menu.popOut')}</span>
      </button>
      <button type="button" role="menuitem" className="pet-menu-item" onClick={pick(hide)}>
        <EyeOff size={11} />
        <span>{t('pet.hide')}</span>
      </button>
    </div>
  )

  // A screen of the pet's, in a card beside it styled like the menu; folded
  // away again with its ✕ (or C). The menu takes its place while it is open.
  const cardBox = peek && !menu && (
    <div
      ref={cardRef}
      className={`pet-card${mode === 'manage' ? ' manage' : ''}${!detached && cardSide.left ? ' left' : ''}${!detached && cardSide.down ? ' down' : ''}`}
    >
      {mode === 'manage' ? (
        <PetManage
          nest={briefOf({ pets, active })}
          detached={!!detached}
          onTop={onTop}
          own={ownSpecies}
          note={manageNote}
          onClose={backHome}
          onSelect={(i) => {
            setManageNote(null)
            apply({ op: 'select', ...ref0(i) })
          }}
          onRename={() => void doRename()}
          onRestart={() => nestNote(apply({ op: 'restart', ...ref0(active) }))}
          onRelease={() => nestNote(apply({ op: 'release', ...ref0(active) }))}
          onAdopt={(hatch) => nestNote(apply({ op: 'adopt', hatch }))}
          onWhere={toggleWhere}
          onOnTop={setOnTopNow}
          onHide={hide}
          onOpenSettings={openSettings}
          onLayout={openLayout}
          onMotion={openMotion}
          onMakeSpecies={openMaker}
        />
      ) : (
        <div className="pet-card-body">
          {screen}
          {askForm}
        </div>
      )}
    </div>
  )

  // Dragging the floating pet by hand (see pet:dragStart in main): it is not
  // an OS drag region, so it can still be clicked and right-clicked.
  const onBareDown = (e: React.PointerEvent<HTMLDivElement>): void => {
    if (!detached || e.button !== 0) return
    e.currentTarget.setPointerCapture(e.pointerId)
    hand.current = { sx: e.screenX, sy: e.screenY, on: false, raf: 0 }
  }
  const onBareMove = (e: React.PointerEvent<HTMLDivElement>): void => {
    const h = hand.current
    if (!h) return
    if (!h.on) {
      if (Math.abs(e.screenX - h.sx) < 4 && Math.abs(e.screenY - h.sy) < 4) return
      h.on = true
      window.api.pet.dragStart()
    }
    if (h.raf) return
    h.raf = requestAnimationFrame(() => {
      h.raf = 0
      window.api.pet.dragMove()
    })
  }
  const onBareUp = (): void => {
    const h = hand.current
    hand.current = null
    if (!h?.on) return
    if (h.raf) cancelAnimationFrame(h.raf)
    window.api.pet.dragMove()
    window.api.pet.dragEnd()
    dragEndAt.current = Date.now()
  }

  return (
    <div
      ref={ref}
      className={[
        'pet-device',
        awake ? '' : 'pet-asleep',
        detached ? 'pet-detached' : '',
        menu || cardBox ? 'pet-side-open' : ''
      ]
        .filter(Boolean)
        .join(' ')}
      style={
        detached
          ? (menu || cardBox) && baseW.current
            ? { width: baseW.current.dev, minHeight: menuH } /* the menu or card hangs to its right */
            : undefined /* detached fills its window */
          : pos
            ? { left: pos.x, top: pos.y, right: 'auto', bottom: 'auto' }
            : undefined /* parked bottom-right */
      }
      onPointerDown={onPointerDown}
      onContextMenu={(e) => {
        e.preventDefault()
        if (menu) return setMenu(false)
        const el = ref.current
        if (!el) return
        setMenuAt((el.querySelector('.pet-bare') ?? el).getBoundingClientRect())
        if (detached && !baseW.current) baseW.current = { win: window.innerWidth, dev: el.offsetWidth }
        const hi = menuLine()
        menuHi.current = hi
        speak(hi, MENU_HI_MS)
        setMenu(true)
      }}
      // The floating window never gets focus, so no Esc and no blur reach it:
      // leaving it is how the menu closes there. A pointerleave alone is not
      // proof: macOS sends them while the pointer is still on the menu, and
      // closing on those made the menu vanish under the cursor. So the leave
      // only starts asking main where the pointer is, and the menu closes once
      // it has been outside the window for two checks in a row.
      onPointerEnter={() => {
        if (menuLeave.current) clearInterval(menuLeave.current)
        menuLeave.current = null
      }}
      onPointerLeave={() => {
        if (!detached || !menu || menuLeave.current) return
        let out = 0
        menuLeave.current = setInterval(() => {
          void window.api.pet.cursorInside().then((inside) => {
            out = inside ? 0 : out + 1
            if (out >= 2) setMenu(false)
          })
        }, 200)
      }}
    >
      {menuBox}
      {cardBox}
      {/* What it is saying, above the pet and in readable type: the balloon is
          the only thing it can speak with. */}
      {bubble && (
        <div className="pet-balloon" key={bubble}>
          {bubble}
        </div>
      )}
      {/* Just the pet. Click it to pat it; right-click for everything else. */}
      <div
        className="pet-bare"
        role="button"
        title={t('pet.bare.hint')}
        onClick={() => {
          if (Date.now() - dragEndAt.current < 300) return
          icons.find((ic) => ic.id === 'pet')?.run()
        }}
        onPointerDown={onBareDown}
        onPointerMove={onBareMove}
        onPointerUp={onBareUp}
        onPointerCancel={onBareUp}
      >
        <Creature
          species={pet.species}
          mood={mood}
          chewing={chewing && awake}
          flavor={diet.total > 0 ? diet.top : undefined}
          cheer={cheer}
          level={growth.level}
          outfit={outfit}
          layout={pet.layout}
          situation={situation}
          motions={motions}
          frames={speciesMotion?.frames}
        />
        {/* What the pane you are watching is doing, acted out. */}
        {mime && <Glyph rows={MIMES[mime]} className={`pet-mime ${mime}`} />}
      </div>
    </div>
  )
}
