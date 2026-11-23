import { useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react'
import '../styles/pet-maker.css'
import { ArrowDownToLine, ArrowUpToLine, Eye, EyeOff, Redo2, RotateCcw, Save, Undo2, Wand2, X } from 'lucide-react'
import { useT } from '../i18n'
import { Button } from './ui/Controls'
import { Creature } from './PetDevice'
import PetAiAsk from './PetAiAsk'
import { faceBoxOf, outfitPieces, pixelsOf, SPRITE_SIZE, type OutfitPiece } from './petSprites'
import { PHOTO_DOT } from './petCustomArt'
import { outfitOf, PRIZES, slotOf, type Accessory, type PetBrief } from '../state/pet'
import { layoutKey, setOverride, toggleWornList, toRel, type DecorLayout } from '../state/petLayout'
import { customOf, hexToRgb } from '../state/petSpecies'
import { emptyHistory, pushHistory, redo, undo, type History } from '../lib/pixelEdit'
import { pngOf, scaleFor } from '../lib/petAi'
import { LAYOUT_SYSTEM, buildLayoutPrompt, layoutGrid, parseLayoutAnswer, rgbaOfDots, type LayoutItem } from '../lib/petAiLayout'

// ---------------------------------------------------------------------------
// 장식 배치: the shown pet, large, with every decoration it has (its level's,
// and the keepsakes it has won), each one shown or hidden, dragged somewhere
// else, in front of it or behind it. Only what differs from the automatic
// placement is kept (state/petLayout.ts); "자동 배치로 되돌리기" drops it all.
// Edits are a draft with undo until saved; saving goes where the nest lives
// (the window showing the pet, or pet.json), like every other pet command.
// ---------------------------------------------------------------------------

interface Draft {
  worn: Accessory[]
  layout: DecorLayout | undefined
}

const same = (a: Draft, b: Draft): boolean => a.worn.join(',') === b.worn.join(',') && layoutKey(a.layout) === layoutKey(b.layout)

/** A photo species' dot colours, for the picture the AI gets. */
function colourOfFor(species: string): (ch: string) => string | undefined {
  const d = customOf(species as `u-${string}`)
  const pal = d?.photo?.palette
  return (ch) => {
    const i = PHOTO_DOT.indexOf(ch)
    return pal && i >= 0 ? pal[i] : undefined
  }
}

export default function PetLayoutEditor({
  pet,
  onSave,
  onClose
}: {
  pet: PetBrief
  /** Save what it wears and the layout (null: all automatic); resolves whether it was taken. */
  onSave: (worn: Accessory[], layout: DecorLayout | null) => Promise<boolean>
  onClose: () => void
}): JSX.Element {
  const t = useT()
  const saved: Draft = useMemo(() => ({ worn: pet.worn, layout: pet.layout }), [pet.worn, pet.layout])
  const [draft, setDraft] = useState<Draft>(saved)
  const [history, setHistory] = useState<History<Draft>>(emptyHistory)
  const [sel, setSel] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const draftRef = useRef(draft)
  draftRef.current = draft
  // Another pet (or the same one started over): start from what it has.
  const bornAt = pet.bornAt
  useEffect(() => {
    setDraft({ worn: pet.worn, layout: pet.layout })
    setHistory(emptyHistory())
    setSel(null)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bornAt])

  const wornKey = draft.worn.join(',')
  const lKey = layoutKey(draft.layout)
  const placed = useMemo(
    () => outfitPieces(pet.species, outfitOf(draft.worn), pet.level, draft.layout),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [pet.species, pet.level, wornKey, lKey, pet.custom]
  )

  /** A change as one undo step (a drag passes the state it started from). */
  const change = (next: Draft, before: Draft = draft): void => {
    if (same(next, before)) return setDraft(next)
    setHistory((h) => pushHistory(h, before))
    setDraft(next)
  }
  const step = (dir: 'undo' | 'redo'): void => {
    const r = (dir === 'undo' ? undo : redo)(history, draft)
    if (!r) return
    setHistory(r.history)
    setDraft(r.state)
  }
  const patch = (key: string, p: Parameters<typeof setOverride>[2]): void =>
    change({ ...draft, layout: setOverride(draft.layout, key, p) })

  // ---- dragging a piece over the big pet ----
  const stage = useRef<HTMLDivElement>(null)
  const drag = useRef<{ key: string; sx: number; sy: number; x0: number; y0: number; before: Draft; piece: OutfitPiece; last: string } | null>(null)
  const onDown = (e: ReactPointerEvent<HTMLButtonElement>, p: OutfitPiece): void => {
    if (e.button !== 0 || !p.box) return
    e.preventDefault()
    e.currentTarget.setPointerCapture(e.pointerId)
    setSel(p.key)
    drag.current = { key: p.key, sx: e.clientX, sy: e.clientY, x0: p.box.x, y0: p.box.y, before: draft, piece: p, last: '' }
  }
  const onMove = (e: ReactPointerEvent<HTMLButtonElement>): void => {
    const d = drag.current
    const el = stage.current
    if (!d || !el) return
    const cell = el.clientWidth / SPRITE_SIZE
    const dx = Math.round((e.clientX - d.sx) / cell)
    const dy = Math.round((e.clientY - d.sy) / cell)
    const w = d.piece.size.w
    const h = d.piece.size.h
    const x = Math.max(0, Math.min(SPRITE_SIZE - w, d.x0 + dx))
    const y = Math.max(0, Math.min(SPRITE_SIZE - h, d.y0 + dy))
    const at = `${x},${y}`
    if (at === d.last || (!d.last && dx === 0 && dy === 0)) return
    d.last = at
    // Live while dragging; one undo step when it is let go.
    const rel = toRel({ x, y }, { w, h }, placed.bbox)
    setDraft((cur) => ({ ...cur, layout: setOverride(cur.layout, d.key, { x: rel.x, y: rel.y }) }))
  }
  const onUp = (): void => {
    const d = drag.current
    drag.current = null
    if (!d || !d.last) return
    if (!same(draftRef.current, d.before)) setHistory((h) => pushHistory(h, d.before))
  }
  // Arrow keys nudge the selected piece a dot (Shift: four).
  const nudge = (p: OutfitPiece, dx: number, dy: number): void => {
    if (!p.box) return
    const x = Math.max(0, Math.min(SPRITE_SIZE - p.size.w, p.box.x + dx))
    const y = Math.max(0, Math.min(SPRITE_SIZE - p.size.h, p.box.y + dy))
    const rel = toRel({ x, y }, p.size, placed.bbox)
    patch(p.key, { x: rel.x, y: rel.y })
  }

  // ---- the list: its level's decorations, then every keepsake it has won ----
  const byItem = new Map<string, OutfitPiece[]>()
  for (const p of placed.pieces) byItem.set(`${p.kind}:${p.item}`, [...(byItem.get(`${p.kind}:${p.item}`) ?? []), p])
  const decorRows = [...byItem.entries()].filter(([k]) => k.startsWith('decor:'))
  const won = PRIZES.map((p) => p.id).filter((id) => pet.prizes.includes(id) || draft.worn.includes(id))
  const nameOf = (p: { kind: string; item: string }): string => t(p.kind === 'acc' ? `pet.acc.${p.item}` : `pet.decor.${p.item}`)

  const pieceTools = (p: OutfitPiece, showEye: boolean): JSX.Element => (
    <>
      {showEye && (
        <button
          type="button"
          className={`pmx-btn${p.hidden ? '' : ' on'}`}
          aria-pressed={!p.hidden}
          title={t(p.hidden ? 'pet.layout.show' : 'pet.layout.hide')}
          aria-label={t(p.hidden ? 'pet.layout.show' : 'pet.layout.hide')}
          onClick={() => patch(p.key, { hidden: p.hidden ? undefined : true })}
        >
          {p.hidden ? <EyeOff size={14} /> : <Eye size={14} />}
        </button>
      )}
      {p.movable && (
        <button
          type="button"
          className="pmx-btn"
          disabled={p.hidden}
          title={t(p.layer === 'front' ? 'pet.layout.toBack' : 'pet.layout.toFront')}
          aria-label={t(p.layer === 'front' ? 'pet.layout.toBack' : 'pet.layout.toFront')}
          onClick={() => patch(p.key, { z: p.layer === 'front' ? 'back' : 'front' })}
        >
          {p.layer === 'front' ? <ArrowUpToLine size={14} /> : <ArrowDownToLine size={14} />}
        </button>
      )}
      {p.movable && (
        <button
          type="button"
          className="pmx-btn"
          disabled={!draft.layout?.[p.key] || !!(draft.layout?.[p.key]?.hidden && Object.keys(draft.layout[p.key]).length === 1)}
          title={t('pet.layout.resetOne')}
          aria-label={t('pet.layout.resetOne')}
          onClick={() => {
            const o = draft.layout?.[p.key]
            patch(p.key, o?.hidden ? { x: undefined, y: undefined, z: undefined } : null)
          }}
        >
          <RotateCcw size={14} />
        </button>
      )}
    </>
  )
  const subRows = (pieces: OutfitPiece[]): JSX.Element[] =>
    pieces.map((p) => (
      <div key={p.key} className={`ple-row sub${sel === p.key ? ' on' : ''}`} onClick={() => setSel(p.key)}>
        <span className="ple-name">
          {nameOf(p)} {(p.index ?? 0) + 1}
          {p.moved && <em>{t('pet.layout.moved')}</em>}
        </span>
        <span className="ple-tools">{pieceTools(p, true)}</span>
      </div>
    ))

  // ---- the AI: the pet as text and a picture, the pieces with their sizes ----
  const items: LayoutItem[] = placed.pieces
    .filter((p) => p.movable && p.box)
    .map((p) => ({
      id: p.key,
      name: `${nameOf(p)}${p.index !== null ? ` ${p.index + 1}` : ''}`,
      w: p.size.w,
      h: p.size.h,
      x: p.box!.x,
      y: p.box!.y,
      z: p.layer,
      hidden: p.hidden
    }))
  const buildAi = (q: string): { system: string; prompt: string; images: string[] } => {
    const body = pixelsOf('ok', pet.species)
    const grid = layoutGrid(body, faceBoxOf(pet.species))
    const scale = scaleFor(SPRITE_SIZE)
    const back = placed.pieces.filter((p) => p.layer === 'back').flatMap((p) => p.dots)
    const front = placed.pieces.filter((p) => p.layer === 'front').flatMap((p) => p.dots)
    const rgba = rgbaOfDots([back, body, front], colourOfFor(pet.species), hexToRgb)
    return { system: LAYOUT_SYSTEM, prompt: buildLayoutPrompt({ grid, items, request: q, scale }), images: [pngOf(SPRITE_SIZE, SPRITE_SIZE, rgba, scale)] }
  }

  const dirty = !same(draft, saved)
  const selPiece = placed.pieces.find((p) => p.key === sel) ?? null
  const save = async (): Promise<void> => {
    setBusy(true)
    const ok = await onSave(draft.worn, draft.layout ?? null)
    setBusy(false)
    if (ok) setHistory(emptyHistory())
  }

  return (
    <div className="ple">
      <div className="ple-bar">
        <button type="button" className="pmx-btn" disabled={!history.past.length} title={`${t('pet.px.undo')} (⌘Z)`} aria-label={t('pet.px.undo')} onClick={() => step('undo')}>
          <Undo2 size={15} />
        </button>
        <button type="button" className="pmx-btn" disabled={!history.future.length} title={`${t('pet.px.redo')} (⇧⌘Z)`} aria-label={t('pet.px.redo')} onClick={() => step('redo')}>
          <Redo2 size={15} />
        </button>
        <Button disabled={!draft.layout} onClick={() => change({ ...draft, layout: undefined })}>
          <Wand2 size={14} /> {t('pet.layout.auto')}
        </Button>
        <span className="pm-gap" />
        <Button variant="primary" disabled={!dirty || busy} onClick={() => void save()}>
          <Save size={14} /> {t('pet.layout.save')}
        </Button>
        <Button variant="ghost" onClick={onClose}>
          <X size={14} /> {t('pet.layout.close')}
        </Button>
      </div>
      <div className="pm-body">
        <div className="pm-stage">
          <div
            ref={stage}
            className="ple-stage"
            tabIndex={0}
            aria-label={t('pet.layout.stage')}
            onKeyDown={(e) => {
              const mod = e.metaKey || e.ctrlKey
              if (mod && e.key.toLowerCase() === 'z') {
                // Its own undo, not the pixel editor's (which listens on the window) if that is open too.
                e.preventDefault()
                e.stopPropagation()
                return step(e.shiftKey ? 'redo' : 'undo')
              }
              if (!selPiece) return
              const k = e.shiftKey ? 4 : 1
              const d = { ArrowLeft: [-k, 0], ArrowRight: [k, 0], ArrowUp: [0, -k], ArrowDown: [0, k] }[e.key]
              if (!d) return
              e.preventDefault()
              nudge(selPiece, d[0], d[1])
            }}
          >
            <Creature species={pet.species} mood="ok" chewing={false} level={pet.level} outfit={outfitOf(draft.worn)} layout={draft.layout} still />
            <div className="ple-handles">
              {placed.pieces
                .filter((p) => p.movable && p.box)
                .map((p) => (
                  <button
                    key={p.key}
                    type="button"
                    className={`ple-handle${sel === p.key ? ' on' : ''}${p.moved ? ' moved' : ''}`}
                    title={nameOf(p)}
                    aria-label={nameOf(p)}
                    style={{
                      left: `${(p.box!.x / SPRITE_SIZE) * 100}%`,
                      top: `${(p.box!.y / SPRITE_SIZE) * 100}%`,
                      width: `${(p.box!.w / SPRITE_SIZE) * 100}%`,
                      height: `${(p.box!.h / SPRITE_SIZE) * 100}%`
                    }}
                    onPointerDown={(e) => onDown(e, p)}
                    onPointerMove={onMove}
                    onPointerUp={onUp}
                    onPointerCancel={onUp}
                  />
                ))}
            </div>
          </div>
          <p className="set-note">{t('pet.layout.hint')}</p>
        </div>
        <div className="pm-side">
          <div className="ple-list">
            {!decorRows.length && !won.length && <p className="set-note">{t('pet.layout.none')}</p>}
            {decorRows.map(([k, pieces]) =>
              pieces.length === 1 ? (
                <div key={k} className={`ple-row${sel === pieces[0].key ? ' on' : ''}`} onClick={() => setSel(pieces[0].key)}>
                  <span className="ple-name">
                    {nameOf(pieces[0])}
                    {pieces[0].moved && <em>{t('pet.layout.moved')}</em>}
                  </span>
                  <span className="ple-tools">{pieceTools(pieces[0], true)}</span>
                </div>
              ) : (
                <div key={k} className="ple-group">
                  <div className="ple-row head">
                    <span className="ple-name">{nameOf(pieces[0])}</span>
                  </div>
                  {subRows(pieces)}
                </div>
              )
            )}
            {won.map((id) => {
              const wearing = draft.worn.includes(id)
              const pieces = wearing ? (byItem.get(`acc:${id}`) ?? []) : []
              const one = pieces.length === 1 ? pieces[0] : null
              // Its eye puts it on or takes it off (one per slot); a worn one the AI hid is shown again first.
              const shown = wearing && !one?.hidden
              const toggle = (): void => {
                if (one?.hidden) return patch(one.key, { hidden: undefined })
                change({ ...draft, worn: toggleWornList(draft.worn, pet.prizes, id, slotOf) })
              }
              return (
                <div key={id} className="ple-group">
                  <div className={`ple-row${one && sel === one.key ? ' on' : ''}`} onClick={() => one && setSel(one.key)}>
                    <span className="ple-name">
                      {t(`pet.acc.${id}`)}
                      {one?.moved && <em>{t('pet.layout.moved')}</em>}
                      {!wearing && <em>{t('pet.layout.notWorn')}</em>}
                    </span>
                    <span className="ple-tools">
                      <button
                        type="button"
                        className={`pmx-btn${shown ? ' on' : ''}`}
                        aria-pressed={shown}
                        title={t(shown ? 'pet.layout.takeOff' : 'pet.layout.putOn')}
                        aria-label={t(shown ? 'pet.layout.takeOff' : 'pet.layout.putOn')}
                        onClick={(e) => {
                          e.stopPropagation()
                          toggle()
                        }}
                      >
                        {shown ? <Eye size={14} /> : <EyeOff size={14} />}
                      </button>
                      {one && pieceTools(one, false)}
                    </span>
                  </div>
                  {pieces.length > 1 && subRows(pieces)}
                </div>
              )
            })}
          </div>
          <PetAiAsk<{ layout: DecorLayout | undefined }>
            title={t('pet.layout.ai')}
            placeholder={t('pet.layout.aiHint')}
            disabled={!items.length}
            build={buildAi}
            check={(text) => {
              const r = parseLayoutAnswer(text, items, placed.bbox, draft.layout)
              return r.ok ? { ok: true, result: { layout: r.layout } } : r
            }}
            preview={(r) => (
              <div className="pai-compare">
                <figure>
                  <div className="ple-mini">
                    <Creature species={pet.species} mood="ok" chewing={false} level={pet.level} outfit={outfitOf(draft.worn)} layout={draft.layout} still />
                  </div>
                  <figcaption>{t('pet.ai.now')}</figcaption>
                </figure>
                <figure>
                  <div className="ple-mini">
                    <Creature species={pet.species} mood="ok" chewing={false} level={pet.level} outfit={outfitOf(draft.worn)} layout={r.layout} still />
                  </div>
                  <figcaption>{t('pet.ai.after')}</figcaption>
                </figure>
              </div>
            )}
            onApply={(r) => change({ ...draft, layout: r.layout })}
          />
        </div>
      </div>
    </div>
  )
}
