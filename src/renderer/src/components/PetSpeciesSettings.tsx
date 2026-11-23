import '../styles/pet-maker.css'
import { useEffect, useMemo, useRef, useState, type HTMLAttributes, type PointerEvent as ReactPointerEvent } from 'react'
import { Pencil, Trash2, ImagePlus } from 'lucide-react'
import { useT } from '../i18n'
import { Button, Segmented, Switch, TextInput } from './ui/Controls'
import { Creature } from './PetDevice'
import {
  ART,
  MAX_CUSTOM,
  MIN_CELLS,
  NAME_MAX,
  PHOTO,
  PHOTO_CHARS,
  PHOTO_MAX_COLORS,
  ROLE_COLOR,
  buildOfDesign,
  cellsOf,
  familyOfDesign,
  forgetDesign,
  hexToRgb,
  newCustomId,
  noteDesign,
  sanitizeDesign,
  useCustomSpecies,
  type CustomDesign,
  type CustomSpecies,
  type PhotoArt,
  type Role
} from '../state/petSpecies'
import {
  WORK,
  backgroundMask,
  cropSquare,
  defaultCrop,
  faithfulDesignFromPhoto,
  foregroundOf,
  paintBrush,
  photoArtOf,
  type BrushMode,
  type Rgba
} from '../lib/petPhoto'

// ---------------------------------------------------------------------------
// Settings > RivenPet > species from photos: the list of the keeper's own
// species, and the maker that turns a photo into one (lib/petPhoto.ts does the
// pixels, petCustomArt.ts the bodies). Everything runs here, on this machine:
// the photo is read from the file the user picks and goes no further than a
// canvas; only the design is saved (userData/store/pet-species.json): the
// 32x32 faithful picture and the 12x12 made beside it. A species made before
// the faithful picture is still edited as its 12x12.
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

/** The faithful picture's colour choices: fewer reads flatter, more reads closer. */
const COLOR_COUNTS = [8, 12, 16]

/** A faithful picture on a 32x32 canvas (scaled up, pixelated, by CSS). */
function PhotoCanvas({
  photo,
  className,
  ...rest
}: { photo: PhotoArt; className: string } & HTMLAttributes<HTMLCanvasElement>): JSX.Element {
  const ref = useRef<HTMLCanvasElement>(null)
  useEffect(() => {
    const ctx = ref.current?.getContext('2d')
    if (!ctx) return
    const img = ctx.createImageData(PHOTO, PHOTO)
    const rgb = photo.palette.map(hexToRgb)
    photo.rows.forEach((row, y) =>
      [...row].forEach((ch, x) => {
        if (ch === '.') return
        const c = rgb[PHOTO_CHARS.indexOf(ch)]
        const o = (y * PHOTO + x) * 4
        img.data[o] = c[0]
        img.data[o + 1] = c[1]
        img.data[o + 2] = c[2]
        img.data[o + 3] = 255
      })
    )
    ctx.putImageData(img, 0, 0)
  }, [photo])
  return <canvas ref={ref} width={PHOTO} height={PHOTO} className={`pm-canvas pm-square pm-pixels ${className}`} {...rest} />
}

/** A pet of the design, as a small picture. */
function Preview({ id, stage, form = 'base' }: { id: string; stage: 'egg' | 'hatchling' | 'child' | 'teen' | 'adult'; form?: 'base' | 'sturdy' }): JSX.Element {
  return (
    <div className="pm-pet">
      <Creature stage={stage} form={form} species={id as `u-${string}`} mood="happy" chewing={false} />
    </div>
  )
}

type Step = 'photo' | 'cutout' | 'dots'
/** A role of the 12x12, the eraser, the face, or (on a faithful picture) a palette index. */
type Tool = Role | 'erase' | 'face' | number

function Maker({ editing, onDone }: { editing: CustomSpecies | null; onDone: () => void }): JSX.Element {
  const t = useT()
  const put = useCustomSpecies((s) => s.put)
  const [step, setStep] = useState<Step>(editing ? 'dots' : 'photo')
  const [source, setSource] = useState<Rgba | null>(null)
  const [crop, setCrop] = useState({ x: 0, y: 0, size: 1 })
  const [error, setError] = useState<string | null>(null)
  const [tolerance, setTolerance] = useState(18)
  const [brushMode, setBrushMode] = useState<'off' | BrushMode>('off')
  const [brushSize, setBrushSize] = useState(5)
  const brush = useRef(new Uint8Array(WORK * WORK))
  const [brushRev, setBrushRev] = useState(0)
  const [draft, setDraft] = useState<CustomDesign | null>(editing ? sanitizeDesign(editing) : null)
  const [tool, setTool] = useState<Tool>(editing?.photo ? 0 : 'b')
  const [colorCount, setColorCount] = useState<number>(PHOTO_MAX_COLORS)
  const fileRef = useRef<HTMLInputElement>(null)
  const photoRef = useRef<HTMLCanvasElement>(null)
  const cutRef = useRef<HTMLCanvasElement>(null)

  // The square crop, at the working size.
  const sq = useMemo(() => (source ? cropSquare(source, crop) : null), [source, crop])
  const bg = useMemo(() => (sq ? backgroundMask(sq, tolerance) : null), [sq, tolerance])
  const fg = useMemo(
    () => (bg ? foregroundOf(bg, brush.current) : null),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [bg, brushRev]
  )
  // What the cut-out would make, shown live beside it.
  const live = useMemo(
    () => (sq && fg && step === 'cutout' ? photoArtOf(sq, fg, colorCount) : null),
    [sq, fg, step, colorCount]
  )

  useEffect(() => {
    if (step === 'photo' && source) draw(photoRef.current, source)
  }, [step, source])
  useEffect(() => {
    if (step === 'cutout' && sq && fg) draw(cutRef.current, sq, fg)
  }, [step, sq, fg])

  // The draft as it would be saved (a name is not needed to look at it), drawn
  // by the same Creature as any pet under a throwaway id.
  const preview = useMemo(
    () => (draft ? sanitizeDesign({ ...draft, name: draft.name.trim() || '-' }) : null),
    [draft]
  )
  useEffect(() => {
    if (preview) noteDesign(DRAFT_ID, preview)
  }, [preview])
  useEffect(() => () => forgetDesign(DRAFT_ID), [])

  const pick = async (file: File | undefined): Promise<void> => {
    if (!file) return
    setError(null)
    try {
      const img = await readImage(file)
      setSource(img)
      setCrop(defaultCrop(img.width, img.height))
      brush.current = new Uint8Array(WORK * WORK)
      setBrushRev((n) => n + 1)
    } catch {
      setError(t('pet.maker.badImage'))
    }
  }

  // ---- crop: drag the square, wheel or slider to size it ----
  const dragCrop = useRef<{ sx: number; sy: number; x: number; y: number } | null>(null)
  const photoBox = useRef<HTMLDivElement>(null)
  // Screen pixels to photo pixels.
  const scaleOf = (): number => (source && photoBox.current ? source.width / photoBox.current.clientWidth : 1)
  const clampCrop = (c: { x: number; y: number; size: number }): typeof c => {
    if (!source) return c
    const size = Math.max(16, Math.min(Math.max(source.width, source.height), c.size))
    return {
      size,
      x: Math.max(-size / 2, Math.min(source.width - size / 2, c.x)),
      y: Math.max(-size / 2, Math.min(source.height - size / 2, c.y))
    }
  }
  const onCropDown = (e: ReactPointerEvent): void => {
    ;(e.target as HTMLElement).setPointerCapture(e.pointerId)
    dragCrop.current = { sx: e.clientX, sy: e.clientY, x: crop.x, y: crop.y }
  }
  const onCropMove = (e: ReactPointerEvent): void => {
    const d = dragCrop.current
    if (!d) return
    const k = scaleOf()
    setCrop(clampCrop({ size: crop.size, x: d.x + (e.clientX - d.sx) * k, y: d.y + (e.clientY - d.sy) * k }))
  }
  const resize = (size: number): void => {
    const cx = crop.x + crop.size / 2
    const cy = crop.y + crop.size / 2
    setCrop(clampCrop({ size, x: cx - size / 2, y: cy - size / 2 }))
  }

  // ---- cut-out brush ----
  const painting = useRef(false)
  const paintAt = (e: ReactPointerEvent<HTMLCanvasElement>): void => {
    if (brushMode === 'off') return
    const r = e.currentTarget.getBoundingClientRect()
    const x = ((e.clientX - r.left) / r.width) * WORK
    const y = ((e.clientY - r.top) / r.height) * WORK
    paintBrush(brush.current, WORK, x, y, brushSize, brushMode)
    setBrushRev((n) => n + 1)
  }

  // ---- dot editor ----
  const drawing = useRef(false)
  const cellAt = (e: ReactPointerEvent<HTMLElement>, n = ART): { x: number; y: number } | null => {
    const r = e.currentTarget.getBoundingClientRect()
    const x = Math.floor(((e.clientX - r.left) / r.width) * n)
    const y = Math.floor(((e.clientY - r.top) / r.height) * n)
    return x >= 0 && y >= 0 && x < n && y < n ? { x, y } : null
  }
  // On a faithful picture the brush is one of its colours, or the eraser.
  const applyPhotoTool = (e: ReactPointerEvent<HTMLElement>): void => {
    const c = cellAt(e, PHOTO)
    const photo = draft?.photo
    if (!c || !draft || !photo) return
    const ch = typeof tool === 'number' ? (PHOTO_CHARS[tool] ?? '.') : '.'
    if (photo.rows[c.y][c.x] === ch) return
    const rows = photo.rows.map((row, y) => (y === c.y ? row.slice(0, c.x) + ch + row.slice(c.x + 1) : row))
    setDraft({ ...draft, photo: { ...photo, rows } })
  }
  const applyTool = (e: ReactPointerEvent<HTMLDivElement>): void => {
    const c = cellAt(e)
    if (!c || !draft || typeof tool === 'number') return
    if (tool === 'face') {
      const face = { x: Math.max(0, Math.min(ART - 6, c.x - 2)), y: Math.max(0, Math.min(ART - 4, c.y - 1)) }
      if (face.x !== draft.face.x || face.y !== draft.face.y) setDraft({ ...draft, face })
      return
    }
    const ch = tool === 'erase' ? '.' : tool
    if (draft.art[c.y][c.x] === ch) return
    const art = draft.art.map((row, y) => (y === c.y ? row.slice(0, c.x) + ch + row.slice(c.x + 1) : row))
    setDraft({ ...draft, art })
  }

  // New species are faithful pictures (with their 12x12 made beside them).
  const toDots = (count = colorCount): void => {
    if (!sq || !fg) return
    const d = faithfulDesignFromPhoto(sq, fg, draft?.name ?? '', count)
    if (!d) return setError(t('pet.maker.nothingLeft'))
    setError(null)
    setDraft({ ...d, name: draft?.name ?? '' })
    setTool(0)
    setStep('dots')
  }

  const save = (): void => {
    if (!draft) return
    if (cellsOf(draft.art) < MIN_CELLS) return setError(t('pet.maker.tooSmall'))
    const name = draft.name.trim() || t('pet.species.custom')
    const clean = sanitizeDesign({ ...draft, name })
    // A picture painted down to a speck would be dropped by sanitizeDesign.
    if (!clean || (draft.photo && !clean.photo)) return setError(t('pet.maker.tooSmall'))
    const now = Date.now()
    put({ ...clean, id: editing?.id ?? newCustomId(now), createdAt: editing?.createdAt ?? now, updatedAt: now })
    onDone()
  }

  const ready = !!preview
  const family = preview ? familyOfDesign(preview) : null
  const build = preview ? buildOfDesign(preview) : 0

  return (
    <div className="pm">
      <Segmented<Step>
        value={step}
        onChange={(s) => {
          if (s === 'dots' && step !== 'dots' && source) return toDots()
          if (s !== 'dots' || draft) setStep(s)
        }}
        options={[
          { value: 'photo', label: t('pet.maker.step.photo') },
          { value: 'cutout', label: t('pet.maker.step.cutout') },
          { value: 'dots', label: t('pet.maker.step.dots') }
        ]}
      />
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

      {step === 'photo' && (
        <div className="pm-body">
          <div className="pm-stage">
            {source ? (
              <div
                ref={photoBox}
                className="pm-photo"
                style={{
                  aspectRatio: `${source.width} / ${source.height}`,
                  // A tall photo is narrowed so it is never taller than the square.
                  width: source.height > source.width ? `${(100 * source.width) / source.height}%` : '100%'
                }}
              >
                <canvas ref={photoRef} className="pm-canvas" />
                <div
                  className="pm-crop"
                  onPointerDown={onCropDown}
                  onPointerMove={onCropMove}
                  onPointerUp={() => (dragCrop.current = null)}
                  onWheel={(e) => resize(crop.size * (e.deltaY > 0 ? 1.06 : 0.94))}
                  style={{
                    left: `${(crop.x / source.width) * 100}%`,
                    top: `${(crop.y / source.height) * 100}%`,
                    width: `${(crop.size / source.width) * 100}%`,
                    height: `${(crop.size / source.height) * 100}%`
                  }}
                />
              </div>
            ) : (
              <button type="button" className="pm-drop" onClick={() => fileRef.current?.click()}>
                <ImagePlus size={22} />
                <span>{t('pet.maker.pick')}</span>
              </button>
            )}
          </div>
          <div className="pm-side">
            <p className="set-note">{source ? t('pet.maker.cropHint') : t('pet.maker.pickHint')}</p>
            {source && (
              <label className="pm-field">
                <span>{t('pet.maker.cropSize')}</span>
                <input
                  type="range"
                  min={16}
                  max={Math.max(source.width, source.height)}
                  value={Math.round(crop.size)}
                  onChange={(e) => resize(Number(e.target.value))}
                />
              </label>
            )}
            {source && (
              <Button onClick={() => fileRef.current?.click()}>{t('pet.maker.pickOther')}</Button>
            )}
          </div>
        </div>
      )}

      {step === 'cutout' && (
        <div className="pm-body">
          <div className="pm-stage">
            {sq ? (
              <canvas
                ref={cutRef}
                className={`pm-canvas pm-square${brushMode !== 'off' ? ' painting' : ''}`}
                onPointerDown={(e) => {
                  painting.current = true
                  e.currentTarget.setPointerCapture(e.pointerId)
                  paintAt(e)
                }}
                onPointerMove={(e) => painting.current && paintAt(e)}
                onPointerUp={() => (painting.current = false)}
              />
            ) : (
              <button type="button" className="pm-drop" onClick={() => fileRef.current?.click()}>
                <ImagePlus size={22} />
                <span>{t('pet.maker.pick')}</span>
              </button>
            )}
          </div>
          <div className="pm-side">
            <p className="set-note">{t('pet.maker.cutoutHint')}</p>
            <label className="pm-field" title={t('pet.maker.toleranceDesc')}>
              <span>
                {t('pet.maker.tolerance')} <b>{tolerance}</b>
              </span>
              <input type="range" min={0} max={60} value={tolerance} onChange={(e) => setTolerance(Number(e.target.value))} />
            </label>
            <div className="pm-field">
              <span>{t('pet.maker.brush')}</span>
              <Segmented<'off' | BrushMode>
                value={brushMode}
                onChange={setBrushMode}
                options={[
                  { value: 'off', label: t('pet.maker.brush.off') },
                  { value: 'keep', label: t('pet.maker.brush.keep') },
                  { value: 'erase', label: t('pet.maker.brush.erase') }
                ]}
              />
            </div>
            <label className="pm-field">
              <span>
                {t('pet.maker.brushSize')} <b>{brushSize}</b>
              </span>
              <input type="range" min={1} max={16} value={brushSize} onChange={(e) => setBrushSize(Number(e.target.value))} />
            </label>
            {live && <PhotoCanvas photo={live} className="pm-mini-photo" aria-hidden="true" />}
          </div>
        </div>
      )}

      {step === 'dots' && draft?.photo && (
        <div className="pm-body">
          <div className="pm-stage">
            <PhotoCanvas
              photo={draft.photo}
              className="pm-edit"
              onPointerDown={(e) => {
                drawing.current = true
                e.currentTarget.setPointerCapture(e.pointerId)
                applyPhotoTool(e)
              }}
              onPointerMove={(e) => drawing.current && applyPhotoTool(e)}
              onPointerUp={() => (drawing.current = false)}
            />
          </div>
          <div className="pm-side">
            <label className="pm-field">
              <span>{t('pet.maker.name')}</span>
              <TextInput
                value={draft.name}
                maxLength={NAME_MAX}
                placeholder={t('pet.maker.namePh')}
                onChange={(e) => setDraft({ ...draft, name: e.target.value })}
              />
            </label>
            {source && (
              <div className="pm-field" title={t('pet.maker.colorCountDesc')}>
                <span>{t('pet.maker.colorCount')}</span>
                <Segmented<string>
                  value={String(colorCount)}
                  onChange={(v) => {
                    setColorCount(Number(v))
                    toDots(Number(v))
                  }}
                  options={COLOR_COUNTS.map((n) => ({ value: String(n), label: String(n) }))}
                />
              </div>
            )}
            <div className="pm-field">
              <span>{t('pet.maker.colors')}</span>
              <div className="pm-tools pm-wrap">
                {draft.photo.palette.map((c, i) => (
                  <span key={i} className={`pm-tool${tool === i ? ' on' : ''}`}>
                    <button
                      type="button"
                      className="pm-swatch"
                      title={t('pet.maker.photoColor', { n: i + 1 })}
                      aria-label={t('pet.maker.photoColor', { n: i + 1 })}
                      style={{ background: c }}
                      onClick={() => setTool(i)}
                    />
                    <input
                      type="color"
                      className="pm-color"
                      title={t('pet.maker.photoColor', { n: i + 1 })}
                      value={c}
                      onChange={(e) => {
                        const photo = draft.photo
                        if (!photo) return
                        const palette = photo.palette.map((p, k) => (k === i ? e.target.value.toLowerCase() : p))
                        setDraft({ ...draft, photo: { ...photo, palette } })
                      }}
                    />
                  </span>
                ))}
              </div>
              <Segmented<'erase'>
                // A colour picked above leaves this off.
                value={tool as 'erase'}
                onChange={setTool}
                options={[{ value: 'erase', label: t('pet.maker.role.erase') }]}
              />
            </div>
            <p className="set-note">{t('pet.maker.photoHint')}</p>
            {family && (
              <p className="set-note">
                {t('pet.maker.family', { family: t(`pet.maker.family.${family}`) })} ·{' '}
                {t(`pet.maker.build.${build > 0.33 ? 'round' : build < -0.33 ? 'lanky' : 'even'}`)}
              </p>
            )}
          </div>
        </div>
      )}

      {step === 'dots' && draft && !draft.photo && (
        <div className="pm-body">
          <div className="pm-stage">
            <div
              className={`pm-grid${tool === 'face' ? ' face-tool' : ''}`}
              onPointerDown={(e) => {
                drawing.current = true
                e.currentTarget.setPointerCapture(e.pointerId)
                applyTool(e)
              }}
              onPointerMove={(e) => drawing.current && applyTool(e)}
              onPointerUp={() => (drawing.current = false)}
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
          <div className="pm-side">
            <label className="pm-field">
              <span>{t('pet.maker.name')}</span>
              <TextInput
                value={draft.name}
                maxLength={NAME_MAX}
                placeholder={t('pet.maker.namePh')}
                onChange={(e) => setDraft({ ...draft, name: e.target.value })}
              />
            </label>
            <div className="pm-field">
              <span>{t('pet.maker.colors')}</span>
              <div className="pm-tools">
                {(['b', 's', 'h', 'a', 'w'] as Role[]).map((r) => (
                  <span key={r} className={`pm-tool${tool === r ? ' on' : ''}`}>
                    <button
                      type="button"
                      className="pm-swatch"
                      title={t(`pet.maker.role.${r}`)}
                      aria-label={t(`pet.maker.role.${r}`)}
                      style={{ background: draft.colors[ROLE_COLOR[r]] }}
                      onClick={() => setTool(r)}
                    />
                    <input
                      type="color"
                      className="pm-color"
                      title={t(`pet.maker.role.${r}`)}
                      value={draft.colors[ROLE_COLOR[r]]}
                      onChange={(e) =>
                        setDraft({ ...draft, colors: { ...draft.colors, [ROLE_COLOR[r]]: e.target.value.toLowerCase() } })
                      }
                    />
                  </span>
                ))}
              </div>
              <Segmented<'erase' | 'face'>
                // A colour picked above leaves both of these off.
                value={tool as 'erase' | 'face'}
                onChange={setTool}
                options={[
                  { value: 'erase', label: t('pet.maker.role.erase') },
                  { value: 'face', label: t('pet.maker.tool.face') }
                ]}
              />
            </div>
            <div className="pm-field pm-switch" title={t('pet.maker.noFaceDesc')}>
              <span>{t('pet.maker.noFace')}</span>
              <Switch checked={draft.noFace} onChange={(v) => setDraft({ ...draft, noFace: v })} />
            </div>
            {!draft.noFace && <p className="set-note">{t('pet.maker.faceHint')}</p>}
            {family && (
              <p className="set-note">
                {t('pet.maker.family', { family: t(`pet.maker.family.${family}`) })} ·{' '}
                {t(`pet.maker.build.${build > 0.33 ? 'round' : build < -0.33 ? 'lanky' : 'even'}`)}
              </p>
            )}
          </div>
        </div>
      )}

      {step === 'dots' && draft && ready && (
        <div className="pm-stages">
          <span className="pm-label">{t('pet.maker.stages')}</span>
          <div className="pm-row">
            <Preview id={DRAFT_ID} stage="egg" />
            <Preview id={DRAFT_ID} stage="hatchling" />
            <Preview id={DRAFT_ID} stage="child" />
            <Preview id={DRAFT_ID} stage="teen" />
            <Preview id={DRAFT_ID} stage="adult" form="sturdy" />
          </div>
        </div>
      )}

      {error && <p className="pm-error">{error}</p>}

      <div className="pm-foot">
        <Button variant="ghost" onClick={onDone}>
          {t('pet.maker.cancel')}
        </Button>
        <span className="pm-gap" />
        {step !== 'photo' && (step === 'cutout' || source) && (
          <Button onClick={() => setStep(step === 'dots' ? 'cutout' : 'photo')}>{t('pet.maker.back')}</Button>
        )}
        {step === 'dots' && !source && (
          <Button onClick={() => setStep('photo')}>{t('pet.maker.redo')}</Button>
        )}
        {step === 'photo' && (
          <Button variant="primary" disabled={!source} onClick={() => setStep('cutout')}>
            {t('pet.maker.next')}
          </Button>
        )}
        {step === 'cutout' && (
          <Button variant="primary" disabled={!fg} onClick={() => toDots()}>
            {t('pet.maker.next')}
          </Button>
        )}
        {step === 'dots' && (
          <Button variant="primary" disabled={!ready} onClick={save}>
            {t('pet.maker.save')}
          </Button>
        )}
      </div>
    </div>
  )
}

/** Settings > RivenPet: the keeper's own species, and the way to make one. */
export default function PetSpeciesSettings(): JSX.Element {
  const t = useT()
  const own = useCustomSpecies((s) => s.own)
  const load = useCustomSpecies((s) => s.load)
  const remove = useCustomSpecies((s) => s.remove)
  const loaded = useCustomSpecies((s) => s.loaded)
  // null: the list; 'new': making one; otherwise the one being edited.
  const [making, setMaking] = useState<'new' | CustomSpecies | null>(null)
  useEffect(() => void load(), [load])

  if (making)
    return <Maker key={making === 'new' ? 'new' : making.id} editing={making === 'new' ? null : making} onDone={() => setMaking(null)} />

  return (
    <>
      <div className="set-note">{t('pet.maker.sectionDesc')}</div>
      {own.length === 0 && <div className="set-note">{t('pet.maker.empty')}</div>}
      {own.map((s) => (
        <div key={s.id} className="set-row pm-item">
          <Preview id={s.id} stage="adult" form="sturdy" />
          <div className="set-rowinfo">
            <span className="set-rowtitle">{s.name}</span>
            <span className="set-rowdesc">{t(`pet.maker.family.${familyOfDesign(s)}`)}</span>
          </div>
          <div className="set-rowctl">
            <Button variant="ghost" title={t('pet.maker.edit')} aria-label={t('pet.maker.edit')} onClick={() => setMaking(s)}>
              <Pencil size={14} />
            </Button>
            <Button
              variant="ghost"
              title={t('pet.maker.delete')}
              aria-label={t('pet.maker.delete')}
              onClick={() => {
                if (window.confirm(t('pet.maker.deleteConfirm', { name: s.name }))) remove(s.id)
              }}
            >
              <Trash2 size={14} />
            </Button>
          </div>
        </div>
      ))}
      <div className="set-row">
        <div className="set-rowinfo">
          <span className="set-rowtitle">{t('pet.maker.create')}</span>
          <span className="set-rowdesc">
            {own.length >= MAX_CUSTOM ? t('pet.maker.limit', { n: MAX_CUSTOM }) : t('pet.maker.hatchHint')}
          </span>
        </div>
        <div className="set-rowctl">
          <Button onClick={() => setMaking('new')} disabled={!loaded || own.length >= MAX_CUSTOM}>
            <ImagePlus size={14} /> {t('pet.maker.create')}
          </Button>
        </div>
      </div>
    </>
  )
}
