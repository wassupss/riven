import '../styles/pet-maker.css'
import {
  useDeferredValue,
  useEffect,
  useMemo,
  useRef,
  useState,
  type DragEvent as ReactDragEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
  type RefObject
} from 'react'
import { createPortal } from 'react-dom'
import {
  ArrowLeft,
  ArrowRight,
  Check,
  ChevronDown,
  ChevronRight,
  Copy,
  Eraser,
  ImagePlus,
  LayoutGrid,
  Move,
  PawPrint,
  Plus,
  RotateCcw,
  Smile,
  SquareDashed,
  Trash2,
  Undo2,
  X
} from 'lucide-react'
import { useT } from '../i18n'
import { useHost } from '../lib/hostWindow'
import { useUI } from '../state/ui'
import { MAX_PETS } from '../state/pet'
import { Button, NumberInput, Segmented, Switch, TextInput } from './ui/Controls'
import { Creature } from './PetDevice'
import PetPixelEditor from './PetPixelEditor'
import PetMotionEditor, { useUndoable } from './PetMotionEditor'
import PetAiAsk from './PetAiAsk'
import { gridRows, rgbaOfDoc } from '../lib/petAiPixels'
import { pngOf, scaleFor } from '../lib/petAi'
import {
  DEFAULT_FPS,
  FRAME_LIMITS,
  FRAMES_SYSTEM,
  buildFramesPrompt,
  cellsOfRows,
  finishPhotoFrames,
  packMotion,
  parseFramesAnswer,
  rebaseRows,
  rowsOfCells,
  type FrameMap,
  type FrameSet
} from '../lib/petFrames'
import type { MotionSet, Situation } from '../lib/petMotion'
import {
  ART,
  MIN_CELLS,
  NAME_MAX,
  PHOTO,
  PHOTO_MAX_COLORS,
  PHOTO_SIZES,
  type PhotoArt,
  ROLE_COLOR,
  buildOfDesign,
  cellsOf,
  hexToRgb,
  familyOfDesign,
  forgetDesign,
  minPhotoCells,
  newCustomId,
  noteDesign,
  photoDimsOf,
  type PhotoDims,
  sanitizeDesign,
  useCustomSpecies,
  type CustomDesign,
  type CustomSpecies,
  type PhotoSize,
  type Role
} from '../state/petSpecies'
import {
  DEFAULT_TOLERANCE,
  WORK,
  autoCrop,
  backgroundMask,
  clampCrop,
  cropSquare,
  designFromPicture,
  faithfulDesignFromPhoto,
  finishPhoto,
  foregroundOf,
  paintBrush,
  type BrushMode,
  type Crop,
  type Rgba
} from '../lib/petPhoto'
import { blankDoc, countDots, docOfPhoto, photoOfDoc, type PixelDoc } from '../lib/pixelEdit'
import { nextName } from '../lib/petMaker'

// ---------------------------------------------------------------------------
// The species maker, in a modal of its own (opened from Settings > 리븐펫 and
// from the pet's panel). Two screens:
//
//   start: [사진으로 만들기] (pick, drop or paste) or [빈 캔버스에 그리기].
//   edit:  the pixel editor in the middle (toolbar, canvas, palette, AI line),
//          a side column with the live preview and, for a photo, the
//          collapsible "사진 변환" (crop, background, colours, resolution),
//          and a bottom bar with the name, [취소] and [저장].
//
// A photo is turned into dots live: every change to the conversion remakes
// the picture, unless it was drawn on, when it asks once in place first.
// Everything runs here, on this machine: the photo goes no further than a
// canvas; only the design is saved (userData/store/pet-species.json), in the
// same shape as before. A species made before the faithful picture is still
// edited as its 12x12, in the same modal.
// ---------------------------------------------------------------------------

/** The longest side a picked photo is kept at: plenty for a 128 square crop. */
const MAX_SIDE = 1024
const DRAFT_ID = 'u-draft'

/** Read an image file into RGBA, scaled down to MAX_SIDE. */
async function readImage(file: File): Promise<Rgba> {
  const url = URL.createObjectURL(file)
  try {
    const img = new Image()
    img.src = url
    await img.decode()
    const k = Math.min(1, MAX_SIDE / Math.max(img.naturalWidth, img.naturalHeight))
    const w = Math.max(1, Math.round(img.naturalWidth * k))
    const h = Math.max(1, Math.round(img.naturalHeight * k))
    const c = document.createElement('canvas')
    c.width = w
    c.height = h
    const ctx = c.getContext('2d', { willReadFrequently: true })!
    ctx.drawImage(img, 0, 0, w, h)
    const data = ctx.getImageData(0, 0, w, h)
    return { width: w, height: h, data: data.data }
  } finally {
    URL.revokeObjectURL(url)
  }
}

/** Paint an RGBA buffer onto a canvas, optionally tinting the removed part. */
function draw(canvas: HTMLCanvasElement | null, img: Rgba, fg?: Uint8Array): void {
  if (!canvas) return
  canvas.width = img.width
  canvas.height = img.height
  const ctx = canvas.getContext('2d')
  if (!ctx) return
  const out = ctx.createImageData(img.width, img.height)
  for (let i = 0; i < img.width * img.height; i++) {
    const p = i * 4
    const gone = fg && !fg[i]
    out.data[p] = gone ? (img.data[p] + 255) / 2 : img.data[p]
    out.data[p + 1] = gone ? img.data[p + 1] / 2 : img.data[p + 1]
    out.data[p + 2] = gone ? (img.data[p + 2] + 255) / 2 : img.data[p + 2]
    out.data[p + 3] = gone ? 255 : img.data[p + 3]
  }
  ctx.putImageData(out, 0, 0)
}

/** The first image among dropped or pasted files. */
const firstImage = (files: FileList | File[] | null | undefined): File | undefined =>
  Array.from(files ?? []).find((f) => f.type.startsWith('image/'))

/** The faithful picture's colour choices: fewer reads flatter, more reads closer. */
const COLOR_COUNTS = [8, 12, 16]

/** The cut-out brush's radius on the WORK square. */
const BRUSH_SIZES = { s: 3, m: 6, l: 10 } as const
type BrushSize = keyof typeof BRUSH_SIZES

/** The colours a blank canvas starts with (a new colour can be added up to 16). */
const STARTER = ['#2d2a32', '#ffffff', '#f2c38b', '#c47a45', '#f49ac1', '#6fa8dc', '#8bc34a', '#ffd54f']

/** A blank canvas of `n` dots: a picture with nothing drawn yet (its 12x12 is made from it on save). */
function blankDesign(dims: PhotoDims): CustomDesign {
  const doc = blankDoc(dims.w, dims.h, STARTER)
  return {
    name: '',
    colors: { body: '#f2c38b', shade: '#c47a45', highlight: '#fbe3c4', accent: '#6fa8dc', white: '#ffffff' },
    art: Array(ART).fill('.'.repeat(ART)),
    face: { x: 3, y: 3 },
    noFace: true,
    photo: photoOfDoc(doc)
  }
}

/**
 * A faithful-picture draft as it would be kept: the picture tidied of unused
 * colours, and (when the picture was drawn on) its 12x12 made again from it,
 * so the battle family and build follow what was drawn. Null when it is too
 * small to keep.
 */
function composePhoto(d: CustomDesign, redrawn: boolean, name: string): CustomDesign | null {
  return composeWithFrames(d, redrawn, name, undefined)?.design ?? null
}

/**
 * composePhoto for a picture with frames: the palette tidied over the picture
 * and its frames together (finishPhotoFrames), so the frames still index it.
 * With no frames it is exactly composePhoto (finishPhoto).
 */
function composeWithFrames(
  d: CustomDesign,
  redrawn: boolean,
  name: string,
  frames: FrameMap | undefined
): { design: CustomDesign; frames: FrameMap | undefined } | null {
  const p = d.photo
  if (!p) {
    const design = sanitizeDesign({ ...d, name })
    return design ? { design, frames: undefined } : null
  }
  const fin = frames
    ? finishPhotoFrames(p.rows, p.palette, frames)
    : (() => {
        const photo = finishPhoto(
          p.rows.map((r) => [...r]),
          p.palette
        )
        return photo ? { photo, frames: undefined } : null
      })()
  if (!fin) return null
  const photo = fin.photo
  const made = redrawn ? designFromPicture(photo, name) : null
  // A picture too thin for a 12x12 of its own keeps the one it had (if any).
  const base = made && cellsOf(made.art) >= MIN_CELLS ? made : d
  if (cellsOf(base.art) < MIN_CELLS) return null
  const design = sanitizeDesign({ ...base, name, noFace: true, photo })
  return design ? { design, frames: fin.frames } : null
}

/** The picture and every frame put on the palette `to` (by colour; what `to` lacks is appended). */
function rebaseAll(
  rows: string[],
  frames: FrameMap | undefined,
  from: string[],
  to: string[]
): { rows: string[]; frames: FrameMap | undefined; palette: string[] } {
  const list: string[][] = [rows]
  const where: Array<[Situation, number]> = []
  for (const [s, f] of Object.entries(frames ?? {}) as Array<[Situation, FrameSet]>)
    f.frames.forEach((g, i) => {
      list.push(g)
      where.push([s, i])
    })
  const r = rebaseRows(list, from, to)
  let out: FrameMap | undefined
  if (frames) {
    out = {}
    for (const [s, f] of Object.entries(frames) as Array<[Situation, FrameSet]>) out[s] = { fps: f.fps, frames: [...f.frames] }
    where.forEach(([s, i], k) => (out![s]!.frames[i] = r.grids[k + 1]))
  }
  return { rows: r.grids[0], frames: out, palette: r.palette }
}

const samePalette = (a: string[], b: string[]): boolean => a.length === b.length && a.every((c, i) => c === b[i])

/** A frame (or the picture) as a small canvas. */
function FrameThumb({ rows, palette, label }: { rows: string[]; palette: string[]; label: string }): JSX.Element {
  const ref = useRef<HTMLCanvasElement>(null)
  const h = rows.length
  const w = rows[0]?.length ?? 0
  useEffect(() => {
    const ctx = ref.current?.getContext('2d')
    if (!ctx) return
    const img = ctx.createImageData(w, h)
    img.data.set(rgbaOfDoc({ w, h, cells: cellsOfRows(rows), palette }, hexToRgb))
    ctx.putImageData(img, 0, 0)
  }, [rows, palette, w, h])
  return <canvas ref={ref} width={w} height={h} className="pm-pixels pmo-thumb-img" aria-label={label} />
}

/** A pet of the design, as a small picture, with what its level has earned it. */
export function SpeciesPreview({ id, level = 1 }: { id: string; level?: number }): JSX.Element {
  return (
    <div className="pm-pet">
      <Creature species={id as `u-${string}`} mood="happy" chewing={false} level={level} />
    </div>
  )
}

/** The largest square a box has room for (it must not be sized by what it holds). */
function useFitSquare(): [RefObject<HTMLDivElement>, number] {
  const ref = useRef<HTMLDivElement>(null)
  const [fit, setFit] = useState(240)
  useEffect(() => {
    const el = ref.current
    if (!el) return
    const ro = new ResizeObserver(() => setFit(Math.max(96, Math.floor(Math.min(el.clientWidth, el.clientHeight)) - 2)))
    ro.observe(el)
    return () => ro.disconnect()
  }, [])
  return [ref, fit]
}

/** A question asked in place, with a safe [취소] and the action it asks about. */
function InlineAsk({ text, yes, onYes, onNo }: { text: string; yes: string; onYes: () => void; onNo: () => void }): JSX.Element {
  const t = useT()
  return (
    <div className="pmx-ask" role="alert">
      <p>{text}</p>
      <div className="pmx-ask-row">
        <Button variant="ghost" onClick={onNo}>
          {t('pet.maker.cancel')}
        </Button>
        <Button variant="primary" onClick={onYes}>
          {yes}
        </Button>
      </div>
    </div>
  )
}

type Screen = 'start' | 'edit'
type View = 'crop' | 'cutout'
/** A tool of the 12x12 editor (species made before the faithful picture): a role, the eraser or the face. */
type Tool = Role | 'erase' | 'face' | 'move'

/** The whole picture moved by whole cells; what leaves the edge is dropped (the face is moved and kept on the grid by the caller). */
const shiftArt = (art: string[], dx: number, dy: number): string[] =>
  art.map((_, y) => {
    const sy = y - dy
    if (sy < 0 || sy >= ART) return '.'.repeat(ART)
    let row = ''
    for (let x = 0; x < ART; x++) {
      const sx = x - dx
      row += sx < 0 || sx >= ART ? '.' : art[sy][sx]
    }
    return row
  })
/** What the bottom bar offers once the species is saved. */
type After = null | 'saved' | 'raised'

export default function PetMaker({
  editing,
  taken,
  full,
  onRaise,
  onClose
}: {
  /** The species to edit, or null for a new one. */
  editing: CustomSpecies | null
  /** The keeper's species' names, for the name a new one starts with. */
  taken: string[]
  /** The nest has no room for another pet. */
  full: boolean
  /** Raise a pet of the species; resolves what to say, or null when it did not happen. */
  onRaise: (s: CustomSpecies) => Promise<string | null>
  onClose: () => void
}): JSX.Element {
  const t = useT()
  const host = useHost()
  const put = useCustomSpecies((s) => s.put)
  const [screen, setScreen] = useState<Screen>(editing ? 'edit' : 'start')
  // The species this maker writes to: the one opened, or the one it saved.
  const [target, setTarget] = useState<CustomSpecies | null>(editing)
  const [name, setName] = useState(() => editing?.name ?? nextName(taken, (n) => t('pet.maker.defaultName', { n })))

  // ---- the photo and its conversion ----
  const [source, setSource] = useState<Rgba | null>(null)
  const [crop, setCrop] = useState<Crop>({ x: 0, y: 0, size: 1 })
  const [tolerance, setTolerance] = useState(DEFAULT_TOLERANCE)
  const brush = useRef(new Uint8Array(WORK * WORK))
  const [brushRev, setBrushRev] = useState(0)
  const [brushMode, setBrushMode] = useState<BrushMode>('keep')
  const [brushSize, setBrushSize] = useState<BrushSize>('m')
  const [view, setView] = useState<View>('crop')
  const [convOpen, setConvOpen] = useState(true)
  const [colorCount, setColorCount] = useState<number>(PHOTO_MAX_COLORS)
  // The picture's grid: more dots, more detail in the same 32 css pixels.
  const [res, setRes] = useState<PhotoDims>(editing?.photo ? photoDimsOf(editing.photo) : { w: PHOTO, h: PHOTO })
  // Bumped to remake the picture from the photo when nothing else changed ("덮어쓰기", "사진대로 되돌리기").
  const [regen, setRegen] = useState(0)

  // ---- the picture ----
  const [draft, setDraft] = useState<CustomDesign | null>(editing ? sanitizeDesign(editing) : null)
  const [seed, setSeed] = useState<{ gen: number; doc: PixelDoc } | null>(
    editing?.photo ? { gen: 0, doc: docOfPhoto(editing.photo) } : null
  )
  // Hand work that remaking the picture would throw away (a saved picture counts).
  const [edited, setEdited] = useState(!!editing?.photo)
  const editedRef = useRef(edited)
  editedRef.current = edited
  // The picture was drawn on since it was made, so its 12x12 is made again from it.
  const [redrawn, setRedrawn] = useState(false)
  // Started on a blank canvas (its size can still be chosen).
  const [blank, setBlank] = useState(false)
  const [tool, setTool] = useState<Tool>('b')

  // ---- 움직임: motion specs and frames ----
  const motion = useUndoable<MotionSet | undefined>(editing?.motion?.specs)
  const framesU = useUndoable<FrameMap | undefined>(editing?.motion?.frames)
  const [moOpen, setMoOpen] = useState(false)
  const [moSit, setMoSit] = useState<Situation>('idle')
  // The frame of moSit on the canvas, or null for the picture itself.
  const [frameSel, setFrameSel] = useState<number | null>(null)
  const [onionOn, setOnionOn] = useState(true)

  // ---- the questions and what happened ----
  // "직접 그린 내용이 사라져요", asked in place before the picture is remade.
  const [ask, setAsk] = useState<{ run: () => void } | null>(null)
  const [closeAsk, setCloseAsk] = useState(false)
  // Changed since it was opened or saved.
  const [dirty, setDirty] = useState(false)
  const [after, setAfter] = useState<After>(null)
  const [note, setNote] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [photoError, setPhotoError] = useState<string | null>(null)
  const [dragOver, setDragOver] = useState(false)

  const fileRef = useRef<HTMLInputElement>(null)
  const photoRef = useRef<HTMLCanvasElement>(null)
  const cutRef = useRef<HTMLCanvasElement>(null)
  const photoBox = useRef<HTMLDivElement>(null)

  const touch = (): void => {
    setDirty(true)
    setAfter(null)
    setNote(null)
    setCloseAsk(false)
  }

  // ---- the conversion, live: deferred, so a drag stays smooth while it catches up ----
  // The photo and its crop travel together, so a new photo is never cut with the old one's crop.
  const framed = useMemo(() => (source ? { source, crop } : null), [source, crop])
  const lazyFramed = useDeferredValue(framed)
  const lazyTol = useDeferredValue(tolerance)
  const lazyBrush = useDeferredValue(brushRev)
  const sq = useMemo(() => (lazyFramed ? cropSquare(lazyFramed.source, lazyFramed.crop) : null), [lazyFramed])
  const bg = useMemo(() => (sq ? backgroundMask(sq, lazyTol) : null), [sq, lazyTol])
  const fg = useMemo(
    () => (bg ? foregroundOf(bg, brush.current) : null),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [bg, lazyBrush]
  )
  const made = useMemo(
    () => (sq && fg ? faithfulDesignFromPhoto(sq, fg, '', colorCount, res) : null),
    [sq, fg, colorCount, res]
  )

  const startPicture = (d: CustomDesign, drawn: boolean): void => {
    if (!d.photo) return
    // A new picture (its size can differ): the frames drawn on the old one go.
    framesU.reset(undefined)
    setFrameSel(null)
    setDraft(d)
    setSeed((s) => ({ gen: (s?.gen ?? 0) + 1, doc: docOfPhoto(d.photo!) }))
    setEdited(false)
    setRedrawn(drawn)
    setError(null)
  }

  // The photo's picture follows the conversion until it is drawn on.
  useEffect(() => {
    if (!source || editedRef.current) return
    if (!made) return setPhotoError(t('pet.maker.nothingLeft'))
    setPhotoError(null)
    startPicture(made, false)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [made, regen])

  useEffect(() => {
    if (screen === 'edit' && convOpen && view === 'crop' && source) draw(photoRef.current, source)
  }, [screen, convOpen, view, source])
  useEffect(() => {
    if (screen === 'edit' && convOpen && view === 'cutout' && sq && fg) draw(cutRef.current, sq, fg)
  }, [screen, convOpen, view, sq, fg])

  // The draft as it would be saved, drawn by the same Creature as any pet
  // under a throwaway id. Deferred: remaking a drawn picture's 12x12 waits
  // for a quiet moment, never a stroke.
  const lazyDraft = useDeferredValue(draft)
  const lazyFrames = useDeferredValue(framesU.value)
  const previewSet = useMemo(
    () => (lazyDraft ? composeWithFrames(lazyDraft, redrawn, '-', lazyFrames) : null),
    [lazyDraft, redrawn, lazyFrames]
  )
  const preview = previewSet?.design ?? null
  useEffect(() => {
    if (preview) noteDesign(DRAFT_ID, preview)
  }, [preview])
  useEffect(() => () => forgetDesign(DRAFT_ID), [])

  // ---- asking before hand work goes ----
  /** Run `change` now, or once "덮어쓰기" is pressed when the picture was drawn on. */
  const guarded = (change: () => void): void => {
    if (editedRef.current) setAsk({ run: change })
    else {
      change()
      touch()
    }
  }
  const overwrite = (): void => {
    const run = ask?.run
    setAsk(null)
    setEdited(false)
    editedRef.current = false
    run?.()
    setRegen((n) => n + 1)
    touch()
  }

  // ---- picking a photo ----
  const pick = async (file: File | undefined): Promise<void> => {
    if (!file) return
    setError(null)
    let img: Rgba
    try {
      img = await readImage(file)
    } catch {
      return setError(t('pet.maker.badImage'))
    }
    const use = (): void => {
      brush.current = new Uint8Array(WORK * WORK)
      setBrushRev((n) => n + 1)
      setSource(img)
      setCrop(autoCrop(img))
      setView('crop')
      setConvOpen(true)
      setBlank(false)
      setScreen('edit')
    }
    guarded(use)
  }
  const toBlank = (size: PhotoDims = { w: PHOTO, h: PHOTO }): void => {
    setSource(null)
    setBlank(true)
    setRes(size)
    startPicture(blankDesign(size), true)
    setScreen('edit')
  }

  // Pasting an image on the start screen picks it.
  useEffect(() => {
    if (screen !== 'start') return
    const onPaste = (e: ClipboardEvent): void => {
      const f = firstImage(e.clipboardData?.files)
      if (!f) return
      e.preventDefault()
      void pick(f)
    }
    window.addEventListener('paste', onPaste)
    return () => window.removeEventListener('paste', onPaste)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [screen])
  const onDragOver = (e: ReactDragEvent): void => {
    if (!e.dataTransfer.types.includes('Files')) return
    e.preventDefault()
    setDragOver(true)
  }
  const onDrop = (e: ReactDragEvent): void => {
    e.preventDefault()
    setDragOver(false)
    void pick(firstImage(e.dataTransfer.files))
  }

  // ---- the crop square on the thumbnail: drag it, drag its corner, or scroll ----
  const dragCrop = useRef<{ mode: 'move' | 'size'; sx: number; sy: number; from: Crop } | null>(null)
  const askFirst = (): boolean => {
    if (!editedRef.current) return false
    setAsk((a) => a ?? { run: () => undefined })
    return true
  }
  const onCropDown = (e: ReactPointerEvent<HTMLElement>, mode: 'move' | 'size'): void => {
    e.stopPropagation()
    if (askFirst()) return
    e.currentTarget.setPointerCapture(e.pointerId)
    dragCrop.current = { mode, sx: e.clientX, sy: e.clientY, from: crop }
  }
  const onCropMove = (e: ReactPointerEvent): void => {
    const d = dragCrop.current
    if (!d || !source || !photoBox.current) return
    const k = source.width / photoBox.current.clientWidth
    const dx = (e.clientX - d.sx) * k
    const dy = (e.clientY - d.sy) * k
    const next =
      d.mode === 'move'
        ? { ...d.from, x: d.from.x + dx, y: d.from.y + dy }
        : { ...d.from, size: d.from.size + Math.max(dx, dy) }
    setCrop(clampCrop(next, source.width, source.height))
    touch()
  }
  const onCropWheel = (deltaY: number): void => {
    if (!source || askFirst()) return
    const size = crop.size * (deltaY > 0 ? 1.06 : 0.94)
    const cx = crop.x + crop.size / 2
    const cy = crop.y + crop.size / 2
    setCrop(clampCrop({ size, x: cx - size / 2, y: cy - size / 2 }, source.width, source.height))
    touch()
  }

  // ---- the cut-out brush on the thumbnail ----
  const painting = useRef(false)
  const paintAt = (e: ReactPointerEvent<HTMLCanvasElement>): void => {
    const r = e.currentTarget.getBoundingClientRect()
    const x = ((e.clientX - r.left) / r.width) * WORK
    const y = ((e.clientY - r.top) / r.height) * WORK
    paintBrush(brush.current, WORK, x, y, BRUSH_SIZES[brushSize], brushMode)
    setBrushRev((n) => n + 1)
    touch()
  }

  // ---- the 12x12 editor (species made before the faithful picture) ----
  const [gridRef, gridFit] = useFitSquare()
  const drawing = useRef(false)
  // A move in progress: where the drag began, and the picture and face as they were then.
  const moveRef = useRef<{ x: number; y: number; cell: number; art: string[]; face: { x: number; y: number }; dx: number; dy: number } | null>(null)
  const applyTool = (e: ReactPointerEvent<HTMLDivElement>): void => {
    const r = e.currentTarget.getBoundingClientRect()
    const x = Math.floor(((e.clientX - r.left) / r.width) * ART)
    const y = Math.floor(((e.clientY - r.top) / r.height) * ART)
    if (!draft || x < 0 || y < 0 || x >= ART || y >= ART) return
    if (tool === 'face') {
      const face = { x: Math.max(0, Math.min(ART - 6, x - 2)), y: Math.max(0, Math.min(ART - 4, y - 1)) }
      if (face.x !== draft.face.x || face.y !== draft.face.y) {
        setDraft({ ...draft, face })
        touch()
      }
      return
    }
    const ch = tool === 'erase' ? '.' : tool
    if (draft.art[y][x] === ch) return
    const art = draft.art.map((row, j) => (j === y ? row.slice(0, x) + ch + row.slice(x + 1) : row))
    setDraft({ ...draft, art })
    touch()
  }

  const reseed = (doc: PixelDoc): void => setSeed((s) => ({ gen: (s?.gen ?? 0) + 1, doc }))
  const onPicture = (doc: PixelDoc): void => {
    const old = draft?.photo
    if (!draft || !old) return
    const frames = framesU.value
    if (frameSel !== null) {
      // A frame was drawn on: it goes into its set; the picture and the other
      // frames follow any change to the shared palette.
      const set = frames?.[moSit]
      if (!set) return
      const r = samePalette(old.palette, doc.palette)
        ? { rows: old.rows, frames, palette: doc.palette }
        : rebaseAll(old.rows, frames, old.palette, doc.palette)
      const next: FrameMap = { ...(r.frames ?? {}) }
      const cur = next[moSit] ?? set
      next[moSit] = { fps: cur.fps, frames: cur.frames.map((g, i) => (i === frameSel ? rowsOfCells(doc.w, doc.h, doc.cells) : g)) }
      framesU.replace(next)
      setDraft({ ...draft, photo: { ...old, rows: r.rows, palette: r.palette } })
      if (r.palette.length !== doc.palette.length) reseed({ ...doc, palette: r.palette })
    } else {
      let photo: PhotoArt = photoOfDoc(doc)
      if (frames && !samePalette(old.palette, doc.palette)) {
        const r = rebaseAll(photo.rows, frames, old.palette, doc.palette)
        framesU.replace(r.frames)
        if (r.palette.length !== doc.palette.length) {
          photo = { ...photo, palette: r.palette }
          reseed({ ...doc, palette: r.palette })
        }
      }
      setDraft({ ...draft, photo })
      setRedrawn(true)
    }
    setEdited(true)
    setError(null)
    touch()
  }

  // ---- the frame strip ----
  const frameSet = framesU.value?.[moSit]
  const frameCount = frameSet?.frames.length ?? 0
  /** Put frame `i` of `sit` (null: the picture) on the canvas. */
  const showFrame = (i: number | null, sit: Situation = moSit, fm: FrameMap | undefined = framesU.value): void => {
    const p = draft?.photo
    if (!p) return
    const rows = i === null ? p.rows : fm?.[sit]?.frames[i]
    if (!rows) return
    setFrameSel(i)
    reseed({ w: rows[0]?.length ?? 0, h: rows.length, cells: cellsOfRows(rows), palette: [...p.palette] })
  }
  const pickSituation = (s: Situation): void => {
    setMoSit(s)
    if (frameSel !== null) showFrame(null, s)
  }
  /** The frames of moSit replaced (null: none), as one undo step, then frame `select` shown. */
  const putFrames = (set: FrameSet | null, select: number | null, key: string | null = null): void => {
    const next: FrameMap = { ...(framesU.value ?? {}) }
    if (set) next[moSit] = set
    else delete next[moSit]
    const fm = Object.keys(next).length ? next : undefined
    framesU.set(fm, key)
    setEdited(true)
    touch()
    if (select !== frameSel || key === null) showFrame(select, moSit, fm)
  }
  const addFrame = (): void => {
    const p = draft?.photo
    if (!p) return
    if (!frameSet) return putFrames({ fps: DEFAULT_FPS, frames: [p.rows, p.rows] }, 0)
    if (frameCount >= FRAME_LIMITS.count.max) return
    putFrames({ ...frameSet, frames: [...frameSet.frames, p.rows] }, frameCount)
  }
  const dupFrame = (): void => {
    if (!frameSet || frameSel === null || frameCount >= FRAME_LIMITS.count.max) return
    const frames = [...frameSet.frames]
    frames.splice(frameSel + 1, 0, frameSet.frames[frameSel])
    putFrames({ ...frameSet, frames }, frameSel + 1)
  }
  const dropFrame = (): void => {
    if (!frameSet || frameSel === null) return
    const frames = frameSet.frames.filter((_, i) => i !== frameSel)
    // Fewer than two is no animation: the set goes.
    if (frames.length < FRAME_LIMITS.count.min) return putFrames(null, null)
    putFrames({ ...frameSet, frames }, Math.max(0, frameSel - 1))
  }
  const moveFrame = (dir: -1 | 1): void => {
    if (!frameSet || frameSel === null) return
    const j = frameSel + dir
    if (j < 0 || j >= frameCount) return
    const frames = [...frameSet.frames]
    ;[frames[frameSel], frames[j]] = [frames[j], frames[frameSel]]
    putFrames({ ...frameSet, frames }, j)
  }
  const undoFrames = (): void => {
    framesU.undo()
    // What the canvas showed may be gone: back to the picture.
    showFrame(null)
    touch()
  }
  const onion = useMemo((): PixelDoc | null => {
    const p = draft?.photo
    if (!onionOn || frameSel === null || !p || !frameSet) return null
    const rows = frameSel === 0 ? p.rows : frameSet.frames[frameSel - 1]
    return rows ? { w: rows[0]?.length ?? 0, h: rows.length, cells: cellsOfRows(rows), palette: p.palette } : null
  }, [onionOn, frameSel, frameSet, draft?.photo])

  // ---- save, and what comes next ----
  const save = (): void => {
    if (!draft) return
    const nm = name.trim() || nextName(taken, (n) => t('pet.maker.defaultName', { n }))
    let design: CustomDesign | null
    let frames: FrameMap | undefined
    if (draft.photo) {
      // The picture and its frames share at most 16 colours (a frame can bring its own).
      const used = framesU.value ? finishPhotoFrames(draft.photo.rows, draft.photo.palette, framesU.value) : null
      if (used && used.photo.palette.length > PHOTO_MAX_COLORS) return setError(t('pet.fr.tooManyColors', { max: PHOTO_MAX_COLORS }))
      const made = composeWithFrames(draft, redrawn, nm, framesU.value)
      design = made?.design ?? null
      frames = made?.frames
      if (!design?.photo) {
        const dims = photoDimsOf(draft.photo)
        const min = minPhotoCells(dims.w, dims.h)
        const n = countDots(docOfPhoto(draft.photo).cells)
        // Enough dots, but too thin a shape for the 12x12 the battle side reads.
        return setError(n < min ? t('pet.px.tooSmall', { n, min }) : t('pet.px.tooThin'))
      }
    } else {
      design = cellsOf(draft.art) >= MIN_CELLS ? sanitizeDesign({ ...draft, name: nm }) : null
      if (!design) return setError(t('pet.maker.tooSmall'))
    }
    const now = Date.now()
    const moved = packMotion({ v: 1, ...(motion.value ? { specs: motion.value } : {}), ...(frames ? { frames } : {}) })
    const s: CustomSpecies = {
      ...design,
      id: target?.id ?? newCustomId(now),
      createdAt: target?.createdAt ?? now,
      updatedAt: now,
      ...(moved ? { motion: moved } : {})
    }
    put(s)
    setTarget(s)
    setName(nm)
    setError(null)
    setDirty(false)
    setCloseAsk(false)
    setAfter('saved')
    setNote(t('pet.maker.saved', { name: nm }))
  }
  const raise = async (): Promise<void> => {
    if (!target) return
    const said = await onRaise(target)
    if (said === null) return setError(t('pet.maker.raiseFailed'))
    setNote(said)
    setAfter('raised')
  }
  const toLayout = (): void => {
    onClose()
    useUI.getState().openPetLayout()
  }

  // ---- closing: Escape, the X, [취소]; unsaved work asks first ----
  const requestClose = (): void => {
    if (dirty) setCloseAsk(true)
    else onClose()
  }
  const closeRef = useRef(requestClose)
  closeRef.current = requestClose
  useEffect(() => {
    // Settings (under this) closes on Escape too; it leaves the key to this while it is open.
    useUI.setState({ petMakerOpen: true })
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape') return
      e.stopPropagation()
      closeRef.current()
    }
    window.addEventListener('keydown', onKey, true)
    return () => {
      window.removeEventListener('keydown', onKey, true)
      useUI.setState({ petMakerOpen: false })
    }
  }, [])

  // ---- what is shown ----
  const family = preview ? familyOfDesign(preview) : null
  const build = preview ? buildOfDesign(preview) : 0
  const familyLine = family && (
    <p className="pmk-note">
      {t('pet.maker.family', { family: t(`pet.maker.family.${family}`) })} ·{' '}
      {t(`pet.maker.build.${build > 0.33 ? 'round' : build < -0.33 ? 'lanky' : 'even'}`)}
    </p>
  )
  const previews = (real?: ReactNode): JSX.Element => (
    <section className="pmk-sec">
      <h4 className="pmk-sec-title">{t('pet.maker.preview')}</h4>
      <div className="pmk-previews">
        {real && (
          <figure>
            <div className="pmk-real">{real}</div>
            <figcaption>{t('pet.px.realSize')}</figcaption>
          </figure>
        )}
        {preview && (
          <>
            <figure>
              <SpeciesPreview id={DRAFT_ID} />
              <figcaption>{t('pet.level', { n: 1 })}</figcaption>
            </figure>
            <figure>
              <SpeciesPreview id={DRAFT_ID} level={50} />
              <figcaption>{t('pet.maker.decorated')}</figcaption>
            </figure>
          </>
        )}
      </div>
      {familyLine}
    </section>
  )
  const overwriteAsk = ask && (
    <InlineAsk text={t('pet.maker.overwriteAsk')} yes={t('pet.maker.overwrite')} onYes={overwrite} onNo={() => setAsk(null)} />
  )

  const photoSection = source && (
    <section className="pmk-sec">
      <button type="button" className="pmk-sec-head" aria-expanded={convOpen} onClick={() => setConvOpen((o) => !o)}>
        {convOpen ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
        <span>{t('pet.maker.convert')}</span>
      </button>
      {convOpen && (
        <>
          {overwriteAsk}
          <fieldset className="pmk-fields" disabled={!!ask}>
            <Segmented<View>
              value={view}
              onChange={setView}
              options={[
                { value: 'crop', label: t('pet.maker.view.crop') },
                { value: 'cutout', label: t('pet.maker.view.cutout') }
              ]}
            />
            <div className="pmk-thumb">
              {view === 'crop' ? (
                <div
                  ref={photoBox}
                  className="pm-photo"
                  style={{
                    aspectRatio: `${source.width} / ${source.height}`,
                    // A tall photo is narrowed so it is never taller than the square.
                    width: source.height > source.width ? `${(100 * source.width) / source.height}%` : '100%'
                  }}
                  onWheel={(e) => onCropWheel(e.deltaY)}
                >
                  <canvas ref={photoRef} className="pm-canvas" />
                  <div
                    className="pm-crop"
                    onPointerDown={(e) => onCropDown(e, 'move')}
                    onPointerMove={onCropMove}
                    onPointerUp={() => (dragCrop.current = null)}
                    style={{
                      left: `${(crop.x / source.width) * 100}%`,
                      top: `${(crop.y / source.height) * 100}%`,
                      width: `${(crop.size / source.width) * 100}%`,
                      height: `${(crop.size / source.height) * 100}%`
                    }}
                  >
                    <span
                      className="pm-crop-handle"
                      aria-hidden="true"
                      onPointerDown={(e) => onCropDown(e, 'size')}
                      onPointerMove={onCropMove}
                      onPointerUp={() => (dragCrop.current = null)}
                    />
                  </div>
                </div>
              ) : (
                <canvas
                  ref={cutRef}
                  className="pm-canvas pm-square painting"
                  onPointerDown={(e) => {
                    if (askFirst()) return
                    painting.current = true
                    e.currentTarget.setPointerCapture(e.pointerId)
                    paintAt(e)
                  }}
                  onPointerMove={(e) => painting.current && paintAt(e)}
                  onPointerUp={() => (painting.current = false)}
                />
              )}
            </div>
            <p className="pmk-note">{t(view === 'crop' ? 'pet.maker.cropHint' : 'pet.maker.cutoutHint')}</p>
            {view === 'cutout' && (
              <div className="pmk-row">
                <Segmented<BrushMode>
                  value={brushMode}
                  onChange={setBrushMode}
                  options={[
                    { value: 'keep', label: t('pet.maker.brush.keep') },
                    { value: 'erase', label: t('pet.maker.brush.erase') }
                  ]}
                />
                <Segmented<BrushSize>
                  value={brushSize}
                  onChange={setBrushSize}
                  options={(['s', 'm', 'l'] as BrushSize[]).map((v) => ({
                    value: v,
                    label: <span className="pmx-dot" title={t('pet.maker.brushSize')} style={{ width: BRUSH_SIZES[v], height: BRUSH_SIZES[v] }} />
                  }))}
                />
              </div>
            )}
            <label className="pmk-field pmk-slider">
              <span>
                {t('pet.maker.tolerance')} <b>{tolerance}</b>
              </span>
              <input
                type="range"
                min={0}
                max={60}
                value={tolerance}
                onChange={(e) => {
                  const v = Number(e.target.value)
                  guarded(() => setTolerance(v))
                }}
              />
            </label>
            <div className="pmk-field">
              <span>{t('pet.maker.colorCount')}</span>
              <Segmented<string>
                value={String(colorCount)}
                onChange={(v) => guarded(() => setColorCount(Number(v)))}
                options={COLOR_COUNTS.map((n) => ({ value: String(n), label: String(n) }))}
              />
            </div>
            <div className="pmk-field">
              <span>{t('pet.maker.width')}</span>
              <Segmented<string>
                value={String(res.w)}
                onChange={(v) => guarded(() => setRes({ ...res, w: Number(v) }))}
                options={PHOTO_SIZES.map((n) => ({ value: String(n), label: String(n) }))}
              />
            </div>
            <div className="pmk-field">
              <span>{t('pet.maker.height')}</span>
              <Segmented<string>
                value={String(res.h)}
                onChange={(v) => guarded(() => setRes({ ...res, h: Number(v) }))}
                options={PHOTO_SIZES.map((n) => ({ value: String(n), label: String(n) }))}
              />
            </div>
            {photoError && <p className="pm-error">{photoError}</p>}
            <div className="pmk-row">
              <Button onClick={() => fileRef.current?.click()}>
                <ImagePlus size={14} /> {t('pet.maker.pickOther')}
              </Button>
              {edited && (
                <Button variant="ghost" onClick={() => guarded(() => undefined)}>
                  <RotateCcw size={14} /> {t('pet.maker.revert')}
                </Button>
              )}
            </div>
          </fieldset>
        </>
      )}
    </section>
  )

  // A blank canvas can still change its size (which clears it, so it asks once drawn on).
  const canvasSection = blank && (
    <section className="pmk-sec">
      <h4 className="pmk-sec-title">{t('pet.maker.canvasSize')}</h4>
      {overwriteAsk}
      <fieldset className="pmk-fields" disabled={!!ask}>
        <div className="pmk-field">
          <span>{t('pet.maker.width')}</span>
          <Segmented<string>
            value={String(res.w)}
            onChange={(v) => guarded(() => toBlank({ w: Number(v), h: res.h }))}
            options={PHOTO_SIZES.map((n) => ({ value: String(n), label: String(n) }))}
          />
        </div>
        <div className="pmk-field">
          <span>{t('pet.maker.height')}</span>
          <Segmented<string>
            value={String(res.h)}
            onChange={(v) => guarded(() => toBlank({ w: res.w, h: Number(v) }))}
            options={PHOTO_SIZES.map((n) => ({ value: String(n), label: String(n) }))}
          />
        </div>
      </fieldset>
    </section>
  )

  // 움직임: the situations' motions and, for a picture, its frames.
  const frameStrip = draft?.photo && (
    <div className="pmo-frames">
      <div className="pmo-frames-head">
        <b>{t('pet.fr.title')}</b>
        <span className="pmk-note">{t('pet.fr.hint', { min: FRAME_LIMITS.count.min, max: FRAME_LIMITS.count.max })}</span>
      </div>
      <div className="pmo-strip" role="listbox" aria-label={t('pet.fr.title')}>
        <button
          type="button"
          role="option"
          aria-selected={frameSel === null}
          className={`pmo-thumb${frameSel === null ? ' on' : ''}`}
          onClick={() => showFrame(null)}
        >
          <FrameThumb rows={draft.photo.rows} palette={draft.photo.palette} label={t('pet.fr.picture')} />
          <span>{t('pet.fr.picture')}</span>
        </button>
        {frameSet?.frames.map((rows, i) => (
          <button
            key={i}
            type="button"
            role="option"
            aria-selected={frameSel === i}
            className={`pmo-thumb${frameSel === i ? ' on' : ''}`}
            onClick={() => showFrame(i)}
          >
            <FrameThumb rows={rows} palette={draft.photo!.palette} label={t('pet.fr.n', { n: i + 1 })} />
            <span>{i + 1}</span>
          </button>
        ))}
      </div>
      <div className="pmk-row pmo-frame-btns">
        <Button disabled={frameCount >= FRAME_LIMITS.count.max} onClick={addFrame} title={t('pet.fr.add')}>
          <Plus size={14} /> {t('pet.fr.add')}
        </Button>
        <button type="button" className="pmx-btn" disabled={frameSel === null || frameCount >= FRAME_LIMITS.count.max} title={t('pet.fr.dup')} aria-label={t('pet.fr.dup')} onClick={dupFrame}>
          <Copy size={14} />
        </button>
        <button type="button" className="pmx-btn" disabled={frameSel === null || frameSel === 0} title={t('pet.fr.left')} aria-label={t('pet.fr.left')} onClick={() => moveFrame(-1)}>
          <ArrowLeft size={14} />
        </button>
        <button type="button" className="pmx-btn" disabled={frameSel === null || frameSel >= frameCount - 1} title={t('pet.fr.right')} aria-label={t('pet.fr.right')} onClick={() => moveFrame(1)}>
          <ArrowRight size={14} />
        </button>
        <button type="button" className="pmx-btn" disabled={frameSel === null} title={t('pet.fr.drop')} aria-label={t('pet.fr.drop')} onClick={dropFrame}>
          <Trash2 size={14} />
        </button>
        <button type="button" className="pmx-btn" disabled={!framesU.canUndo} title={t('pet.fr.undo')} aria-label={t('pet.fr.undo')} onClick={undoFrames}>
          <Undo2 size={14} />
        </button>
      </div>
      {frameSet && (
        <div className="pmk-row">
          <label className="pmo-field inline">
            <span>{t('pet.fr.fps')}</span>
            <NumberInput
              className="pmo-num"
              min={FRAME_LIMITS.fps.min}
              max={FRAME_LIMITS.fps.max}
              value={frameSet.fps}
              onChange={(e) => {
                const v = Math.round(Number(e.target.value))
                if (!e.target.value || !Number.isFinite(v)) return
                putFrames({ ...frameSet, fps: Math.max(FRAME_LIMITS.fps.min, Math.min(FRAME_LIMITS.fps.max, v)) }, frameSel, 'fps')
              }}
            />
          </label>
          <span className="pm-gap" />
          <span className="pmk-note">{t('pet.fr.onion')}</span>
          <Switch checked={onionOn} onChange={setOnionOn} />
        </div>
      )}
      {frameSel !== null && <p className="pmk-note">{t('pet.fr.editing', { n: frameSel + 1, sit: t(`pet.mo.sit.${moSit}`) })}</p>}
      <PetAiAsk<{ palette: string[]; frames: Uint8Array[]; fps: number }>
        compact
        title={t('pet.fr.aiTitle')}
        placeholder={t('pet.fr.aiHint')}
        build={(q) => {
          const p = draft.photo!
          const doc: PixelDoc = { w: photoDimsOf(p).w, h: p.rows.length, cells: cellsOfRows(p.rows), palette: p.palette }
          const scale = scaleFor(Math.max(doc.w, doc.h))
          return { system: FRAMES_SYSTEM, prompt: buildFramesPrompt(doc, gridRows(doc), q, scale), images: [pngOf(doc.w, doc.h, rgbaOfDoc(doc, hexToRgb), scale)] }
        }}
        check={(text) => {
          const p = draft.photo!
          const r = parseFramesAnswer(text, { w: photoDimsOf(p).w, h: p.rows.length, cells: cellsOfRows(p.rows), palette: p.palette })
          if (r.ok) return { ok: true, result: { palette: r.palette, frames: r.frames, fps: r.fps } }
          return r.frame ? { ok: false, reason: 'pet.fr.err.frame', vars: { n: r.frame, why: t(r.reason, r.vars) } } : r
        }}
        preview={(r) => (
          <div className="pmo-strip">
            {r.frames.map((cells, i) => (
              <span key={i} className="pmo-thumb">
                <FrameThumb rows={rowsOfCells(photoDimsOf(draft.photo!).w, draft.photo!.rows.length, cells)} palette={r.palette} label={t('pet.fr.n', { n: i + 1 })} />
                <span>{i + 1}</span>
              </span>
            ))}
          </div>
        )}
        onApply={(r) => {
          const p = draft.photo!
          const { w, h } = photoDimsOf(p)
          // The answer's palette is the picture's with any new colours after it.
          setDraft({ ...draft, photo: { ...p, palette: r.palette } })
          const next: FrameMap = { ...(framesU.value ?? {}), [moSit]: { fps: r.fps, frames: r.frames.map((c) => rowsOfCells(w, h, c)) } }
          framesU.set(next)
          setEdited(true)
          touch()
          setFrameSel(null)
          reseed({ w, h, cells: cellsOfRows(p.rows), palette: r.palette })
        }}
      />
    </div>
  )
  const motionSection = draft && (
    <section className="pmk-sec">
      <button
        type="button"
        className="pmk-sec-head"
        aria-expanded={moOpen}
        onClick={() => {
          // Folding it away puts the picture back on the canvas.
          if (moOpen && frameSel !== null) showFrame(null)
          setMoOpen((o) => !o)
        }}
      >
        {moOpen ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
        <span>{t('pet.mo.title')}</span>
      </button>
      {moOpen && (
        <PetMotionEditor
          species={DRAFT_ID as `u-${string}`}
          photo={!!draft.photo}
          value={motion.value}
          onChange={(m, k) => {
            motion.set(m, k)
            touch()
          }}
          canUndo={motion.canUndo}
          onUndo={() => {
            motion.undo()
            touch()
          }}
          situation={moSit}
          onSituation={pickSituation}
          frames={previewSet?.frames}
        >
          {frameStrip}
        </PetMotionEditor>
      )}
    </section>
  )

  const legacy = screen === 'edit' && draft && !draft.photo && (
    <>
      <div className="pmk-main">
        <div className="pmx-bar" role="toolbar" aria-label={t('pet.px.tools')}>
          {(['b', 's', 'h', 'a', 'w'] as Role[]).map((r) => (
            <span key={r} className={`pm-tool${tool === r ? ' on' : ''}`}>
              <button
                type="button"
                className="pm-swatch"
                title={t(`pet.maker.role.${r}`)}
                aria-label={t(`pet.maker.role.${r}`)}
                aria-pressed={tool === r}
                style={{ background: draft.colors[ROLE_COLOR[r]] }}
                onClick={() => setTool(r)}
              />
              <input
                type="color"
                className="pm-color"
                title={t(`pet.maker.role.${r}`)}
                value={draft.colors[ROLE_COLOR[r]]}
                onChange={(e) => {
                  setDraft({ ...draft, colors: { ...draft.colors, [ROLE_COLOR[r]]: e.target.value.toLowerCase() } })
                  touch()
                }}
              />
            </span>
          ))}
          <span className="pmx-sep" />
          <button
            type="button"
            className={`pmx-btn${tool === 'move' ? ' on' : ''}`}
            aria-pressed={tool === 'move'}
            aria-label={t('pet.maker.tool.move')}
            title={`${t('pet.maker.tool.move')}\n${t('pet.maker.moveHint')}`}
            onClick={() => setTool('move')}
          >
            <Move size={15} />
          </button>
          <button
            type="button"
            className={`pmx-btn${tool === 'erase' ? ' on' : ''}`}
            aria-pressed={tool === 'erase'}
            aria-label={t('pet.maker.role.erase')}
            title={t('pet.maker.role.erase')}
            onClick={() => setTool('erase')}
          >
            <Eraser size={15} />
          </button>
          {!draft.noFace && (
            <button
              type="button"
              className={`pmx-btn${tool === 'face' ? ' on' : ''}`}
              aria-pressed={tool === 'face'}
              aria-label={t('pet.maker.tool.face')}
              title={`${t('pet.maker.tool.face')}\n${t('pet.maker.faceHint')}`}
              onClick={() => setTool('face')}
            >
              <Smile size={15} />
            </button>
          )}
        </div>
        <div ref={gridRef} className="pmk-stage">
          <div
            className={`pm-grid${tool === 'face' ? ' face-tool' : ''}`}
            style={{ width: gridFit, height: gridFit }}
            onPointerDown={(e) => {
              drawing.current = true
              e.currentTarget.setPointerCapture(e.pointerId)
              if (tool === 'move') {
                if (draft) {
                  const r = e.currentTarget.getBoundingClientRect()
                  moveRef.current = { x: e.clientX, y: e.clientY, cell: r.width / ART, art: draft.art, face: draft.face, dx: 0, dy: 0 }
                }
                return
              }
              applyTool(e)
            }}
            onPointerMove={(e) => {
              if (!drawing.current) return
              const m = moveRef.current
              if (tool !== 'move') return applyTool(e)
              if (!m || !draft) return
              // Measured from where the drag began, so the picture never drifts from the pointer.
              const dx = Math.round((e.clientX - m.x) / m.cell)
              const dy = Math.round((e.clientY - m.y) / m.cell)
              if (dx === m.dx && dy === m.dy) return
              m.dx = dx
              m.dy = dy
              const face = { x: Math.max(0, Math.min(ART - 6, m.face.x + dx)), y: Math.max(0, Math.min(ART - 4, m.face.y + dy)) }
              setDraft({ ...draft, art: shiftArt(m.art, dx, dy), face })
              touch()
            }}
            onPointerUp={() => {
              drawing.current = false
              moveRef.current = null
            }}
          >
            {draft.art.map((row, y) =>
              [...row].map((ch, x) => (
                <i
                  key={`${x},${y}`}
                  className={ch === '.' ? 'empty' : undefined}
                  style={ch === '.' ? undefined : { background: draft.colors[ROLE_COLOR[ch as Role]] }}
                />
              ))
            )}
            {!draft.noFace && (
              <b
                className="pm-face"
                style={{
                  left: `${(draft.face.x / ART) * 100}%`,
                  top: `${(draft.face.y / ART) * 100}%`,
                  width: `${(6 / ART) * 100}%`,
                  height: `${(4 / ART) * 100}%`
                }}
              />
            )}
          </div>
        </div>
      </div>
      <aside className="pmk-side">
        {previews()}
        <section className="pmk-sec">
          <div className="pmk-field" title={t('pet.maker.noFaceDesc')}>
            <span>{t('pet.maker.noFace')}</span>
            <Switch
              checked={draft.noFace}
              onChange={(v) => {
                setDraft({ ...draft, noFace: v })
                if (v && tool === 'face') setTool('b')
                touch()
              }}
            />
          </div>
        </section>
        {motionSection}
      </aside>
    </>
  )

  const footer = (
    <div className="pmk-foot">
      <label className="pmk-name">
        <span>{t('pet.maker.name')}</span>
        <TextInput
          value={name}
          maxLength={NAME_MAX}
          placeholder={t('pet.maker.namePh')}
          onChange={(e) => {
            setName(e.target.value)
            touch()
          }}
        />
      </label>
      {error ? (
        <p className="pm-error pmk-msg">{error}</p>
      ) : (
        note && (
          <p className="pmk-msg pmk-ok">
            <Check size={14} /> {note}
          </p>
        )
      )}
      <span className="pm-gap" />
      {closeAsk ? (
        <>
          <span className="pmk-msg">{t('pet.maker.closeAsk')}</span>
          <Button variant="ghost" onClick={() => setCloseAsk(false)}>
            {t('pet.maker.keepEditing')}
          </Button>
          <Button onClick={onClose}>{t('pet.maker.closeDiscard')}</Button>
        </>
      ) : after === 'saved' && !dirty ? (
        <>
          <Button variant="ghost" onClick={onClose}>
            {t('common.close')}
          </Button>
          <Button variant="primary" disabled={full} title={full ? t('pet.nest.full', { max: MAX_PETS }) : undefined} onClick={() => void raise()}>
            <PawPrint size={14} /> {t('pet.maker.raiseNow')}
          </Button>
        </>
      ) : after === 'raised' && !dirty ? (
        <>
          <Button variant="ghost" onClick={onClose}>
            {t('common.close')}
          </Button>
          <Button variant="primary" onClick={toLayout}>
            <LayoutGrid size={14} /> {t('pet.layout.open')}
          </Button>
        </>
      ) : (
        <>
          <Button variant="ghost" onClick={requestClose}>
            {t('pet.maker.cancel')}
          </Button>
          <Button variant="primary" disabled={!draft} onClick={save}>
            {t('pet.maker.save')}
          </Button>
        </>
      )}
    </div>
  )

  return createPortal(
    <div className="modal-overlay pmk-overlay">
      <div
        className={`modal pmk${screen === 'start' ? ' start' : ''}`}
        role="dialog"
        aria-modal="true"
        aria-label={target ? t('pet.maker.editTitle', { name: target.name }) : t('pet.maker.create')}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="modal-header">
          <span>{target ? t('pet.maker.editTitle', { name: target.name }) : t('pet.maker.create')}</span>
          <button type="button" className="pmx-btn" title={t('common.close')} aria-label={t('common.close')} onClick={requestClose}>
            <X size={15} />
          </button>
        </div>
        <input
          ref={fileRef}
          type="file"
          accept="image/*"
          hidden
          onChange={(e) => {
            void pick(e.target.files?.[0])
            e.target.value = ''
          }}
        />

        {screen === 'start' ? (
          <div
            className={`pmk-start${dragOver ? ' drag' : ''}`}
            onDragOver={onDragOver}
            onDragLeave={() => setDragOver(false)}
            onDrop={onDrop}
          >
            <div className="pmk-choices">
              <button type="button" className="pmk-choice" onClick={() => fileRef.current?.click()}>
                <ImagePlus size={30} />
                <b>{t('pet.maker.fromPhoto')}</b>
                <span>{t('pet.maker.fromPhotoHint')}</span>
              </button>
              <button type="button" className="pmk-choice" onClick={() => toBlank()}>
                <SquareDashed size={30} />
                <b>{t('pet.maker.fromBlank')}</b>
                <span>{t('pet.maker.fromBlankHint')}</span>
              </button>
            </div>
            {error && <p className="pm-error">{error}</p>}
          </div>
        ) : (
          <>
            <div className={`pmk-body${moOpen ? ' wide-side' : ''}`}>
              {draft?.photo && seed && (
                <PetPixelEditor
                  seed={seed}
                  onChange={onPicture}
                  onion={onion}
                  photo={source ? sq : null}
                  side={({ real, status }) => (
                    <>
                      {previews(real)}
                      {status}
                      {photoSection}
                      {canvasSection}
                      {motionSection}
                    </>
                  )}
                />
              )}
              {legacy}
            </div>
            {footer}
          </>
        )}
      </div>
    </div>,
    host.doc.body
  )
}
