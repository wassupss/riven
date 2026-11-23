import { useCallback, useEffect, useRef, useState } from 'react'
import { LayoutGrid, MoreHorizontal, Move, PawPrint, RotateCcw } from 'lucide-react'
import { useT } from '../i18n'
import { onNest, requestPet } from '../lib/petCommand'
import {
  applyCommand,
  briefOf,
  normalizeNest,
  MAX_PETS,
  petSubtitle,
  petTitle,
  type Hatch,
  type NestBrief,
  type PetBrief,
  type PetCommand,
  type PetResult
} from '../state/pet'
import { customOf, designOf, isCustomId, motionOfSpecies, noteDesign, useCustomSpecies, type CustomSpecies } from '../state/petSpecies'
import PetMotionEditor, { useUndoable } from './PetMotionEditor'
import type { MotionSet, Situation } from '../lib/petMotion'
import { useSettings } from '../state/settings'
import { Button, Select, Switch } from './ui/Controls'
import { Creature } from './PetDevice'
import PetSpeciesSettings from './PetSpeciesSettings'
import PetLayoutEditor from './PetLayoutEditor'
import { useUI } from '../state/ui'
import { promptInput } from './promptInput'
import ContextMenu, { type MenuItem } from './ContextMenu'

// ---------------------------------------------------------------------------
// Settings > 리븐펫: the pets ("내 펫") and the keeper's own species ("내가 만든
// 종"). The pet's own panel (PetManage) offers the same actions with the same
// words in the same order; both end in applyCommand (state/pet.ts).
//
// Where the pet is on screen, its window owns the save, so a command is sent
// there (lib/petCommand) and the list follows the nest it announces. With the
// pet put away nothing owns it (the window showing it saved and let go of it),
// so the command is applied to pet.json here.
// ---------------------------------------------------------------------------

const FILE = 'pet.json'

async function readNest(): Promise<ReturnType<typeof normalizeNest>> {
  return normalizeNest(await window.api.config.load(FILE).catch(() => null), Date.now())
}

/** Draw a list's homemade species, which this window may never have loaded. */
function noteBriefs(b: NestBrief): void {
  for (const p of b.pets) if (p.custom && isCustomId(p.species)) noteDesign(p.species, p.custom)
}

/**
 * One pet's own motions (움직임), over its species': the shared editor, with
 * [저장] sending them where the nest lives. Frames belong to a homemade
 * species (the maker); a pet only has motion specs.
 */
function PetMotionPanel({
  pet,
  onSave,
  onClose
}: {
  pet: PetBrief
  onSave: (motion: MotionSet | null) => Promise<boolean>
  onClose: () => void
}): JSX.Element {
  const t = useT()
  const u = useUndoable<MotionSet | undefined>(pet.motion)
  const [sit, setSit] = useState<Situation>('idle')
  const [busy, setBusy] = useState(false)
  const [note, setNote] = useState<string | null>(null)
  useCustomSpecies((s) => s.rev)
  const sm = motionOfSpecies(pet.species)
  const photo = !!customOf(pet.species)?.photo
  // Another pet (or the same one started over): start from what it has.
  const { reset } = u
  useEffect(() => {
    reset(pet.motion)
    setNote(null)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pet.bornAt, reset])
  const dirty = JSON.stringify(u.value ?? null) !== JSON.stringify(pet.motion ?? null)
  const save = async (): Promise<void> => {
    setBusy(true)
    const ok = await onSave(u.value ?? null)
    setBusy(false)
    setNote(ok ? t('pet.mo.saved') : null)
  }
  return (
    <div className="pmo-panel">
      <PetMotionEditor
        species={pet.species}
        level={pet.level}
        photo={photo}
        base={sm?.specs}
        value={u.value}
        onChange={(m, k) => {
          u.set(m, k)
          setNote(null)
        }}
        canUndo={u.canUndo}
        onUndo={u.undo}
        situation={sit}
        onSituation={setSit}
        frames={sm?.frames}
      />
      <div className="pmk-row">
        <Button variant="ghost" disabled={!u.value} onClick={() => u.set(undefined)}>
          <RotateCcw size={14} /> {t('pet.mo.resetAll')}
        </Button>
        {note && <span className="pmk-note">{note}</span>}
        <span className="pm-gap" />
        <Button variant="ghost" onClick={onClose}>
          {t('pet.layout.close')}
        </Button>
        <Button variant="primary" disabled={!dirty || busy} onClick={() => void save()}>
          {t('pet.layout.save')}
        </Button>
      </div>
    </div>
  )
}

export default function PetNestSettings(): JSX.Element {
  const t = useT()
  const shown = useSettings((s) => s.settings.petShow)
  const [nest, setNest] = useState<NestBrief | null>(null)
  const [note, setNote] = useState<string | null>(null)
  const [pick, setPick] = useState<string>('')
  // The ⋯ menu of one pet: its less used actions (rename, start over, let go).
  const [menu, setMenu] = useState<{ x: number; y: number; i: number } | null>(null)
  const closeMenu = useCallback(() => setMenu(null), [])
  const own = useCustomSpecies((s) => s.own)
  // The decoration layout of the focused pet (주인공), open below the list.
  const [layoutOpen, setLayoutOpen] = useState(false)
  const layoutAsk = useUI((s) => s.petLayoutAsk)
  const layoutRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (layoutAsk) setLayoutOpen(true)
  }, [layoutAsk])
  useEffect(() => {
    if (layoutOpen) layoutRef.current?.scrollIntoView({ block: 'nearest' })
  }, [layoutOpen])
  // The motion editor (움직임) of the focused pet, the same way.
  const [motionOpen, setMotionOpen] = useState(false)
  const motionAsk = useUI((s) => s.petMotionAsk)
  const motionRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (motionAsk) setMotionOpen(true)
  }, [motionAsk])
  useEffect(() => {
    if (motionOpen) motionRef.current?.scrollIntoView({ block: 'nearest' })
  }, [motionOpen])

  const take = useCallback((b: NestBrief | null) => {
    if (!b) return
    noteBriefs(b)
    setNest(b)
  }, [])

  // The save first (instant, and right while the pet is put away), then the
  // live answer from the window showing it, and every change after that.
  // Once the live nest has been heard, it wins over the file (which can lag
  // the window's last change by a debounced save).
  const live = useRef(false)
  useEffect(() => {
    const off = onNest((b) => {
      live.current = true
      take(b)
    })
    void readNest().then((n) => {
      if (!live.current) take(briefOf(n))
    })
    if (shown) void requestPet(null).then((a) => a.nest && take(a.nest))
    return off
  }, [shown, take])

  const say = (result: PetResult): void =>
    setNote(
      result === 'full'
        ? t('pet.nest.full', { max: MAX_PETS })
        : result === 'none'
          ? t('pet.nest.noAnswer')
          : result === 'stale'
            ? t('pet.nest.stale')
            : null
    )

  /** Run a command where the nest lives; resolves what happened. */
  const run = async (cmd: PetCommand): Promise<PetResult> => {
    if (shown) {
      const a = await requestPet(cmd)
      take(a.nest)
      say(a.result)
      return a.result
    }
    const n = await readNest()
    const { nest: next, result } = applyCommand(n, cmd, Date.now())
    if (next !== n) await window.api.config.save(FILE, next)
    take(briefOf(next))
    say(result)
    return result
  }

  const ref = (i: number): { index: number; bornAt: number } => ({ index: i, bornAt: nest?.pets[i]?.bornAt ?? -1 })
  const rename = async (i: number): Promise<void> => {
    const p = nest?.pets[i]
    if (!p) return
    const v = await promptInput({ title: t('pet.renameTitle'), initial: p.name })
    if (v !== null) void run({ op: 'rename', ...ref(i), name: v })
  }
  const restart = (i: number): void => {
    const p = nest?.pets[i]
    if (p && window.confirm(t('pet.nest.restartConfirm', { name: petTitle(p, t) }))) void run({ op: 'restart', ...ref(i) })
  }
  const release = (i: number): void => {
    const p = nest?.pets[i]
    if (p && window.confirm(t('pet.nest.releaseConfirm', { name: petTitle(p, t) }))) void run({ op: 'release', ...ref(i) })
  }
  const hatchOf = (s: CustomSpecies | null | undefined): Hatch | null => (s ? { id: s.id, design: designOf(s) } : null)
  const adopt = (hatch: Hatch | null): Promise<PetResult> => run({ op: 'adopt', hatch })

  const count = nest?.pets.length ?? 0
  const full = count >= MAX_PETS
  return (
    <>
      <div className="section-label">{t('pet.nest.count', { n: count, max: MAX_PETS })}</div>
      {nest?.pets.map((p, i) => {
        const out = nest.shown.includes(p.bornAt)
        // The one pet left out stays out.
        const last = out && nest.shown.length <= 1
        return (
          <div key={`${p.bornAt}-${i}`} className={`set-row pm-item pet-nest-item${out ? '' : ' off'}`}>
            <div className="pm-pet">
              <Creature species={p.species} mood="ok" chewing={false} level={p.level} />
            </div>
            <div className="set-rowinfo">
              <span className="set-rowtitle" title={petTitle(p, t)}>
                {petTitle(p, t)}
              </span>
              <span className="set-rowdesc">
                <span className="pet-nest-sub">{petSubtitle(p, t)}</span>
                {i === nest.active ? (
                  <span className="pet-nest-shown" title={t('pet.nest.focusHint')}>
                    {t('pet.nest.focused')}
                  </span>
                ) : (
                  out && <span className="pet-nest-shown dim">{t('pet.nest.out')}</span>
                )}
              </span>
            </div>
            <div className="set-rowctl">
              {i === nest.active ? (
                <>
                  {/* On a narrow row these two keep only their icons (pet-maker.css). */}
                  <Button
                    className="pet-nest-icon"
                    title={t('pet.layout.open')}
                    aria-label={t('pet.layout.open')}
                    onClick={() => setLayoutOpen((o) => !o)}
                    aria-expanded={layoutOpen}
                  >
                    <LayoutGrid size={14} />
                    <span className="pet-nest-label">{t('pet.layout.open')}</span>
                  </Button>
                  <Button
                    className="pet-nest-icon"
                    title={t('pet.mo.open')}
                    aria-label={t('pet.mo.open')}
                    onClick={() => setMotionOpen((o) => !o)}
                    aria-expanded={motionOpen}
                  >
                    <Move size={14} />
                    <span className="pet-nest-label">{t('pet.mo.open')}</span>
                  </Button>
                </>
              ) : (
                <Button title={t('pet.nest.focusHint')} onClick={() => void run({ op: 'select', ...ref(i) })}>
                  {t('pet.nest.focus')}
                </Button>
              )}
              <Switch
                checked={out}
                disabled={last}
                label={t('pet.nest.showToggle')}
                title={last ? t('pet.nest.lastShown') : t('pet.nest.showToggle')}
                onChange={(on) => void run({ op: 'setShown', ...ref(i), on })}
              />
              <Button
                variant="ghost"
                className="pet-nest-more"
                aria-label={t('pet.nest.more')}
                title={t('pet.nest.more')}
                onClick={(e) => {
                  e.stopPropagation()
                  const r = e.currentTarget.getBoundingClientRect()
                  setMenu((m) => (m?.i === i ? null : { x: r.right - 180, y: r.bottom + 4, i }))
                }}
              >
                <MoreHorizontal size={16} />
              </Button>
            </div>
          </div>
        )
      })}
      <div className="set-row">
        <div className="set-rowinfo">
          <span className="set-rowtitle">{t('pet.nest.newPet')}</span>
          {full && <span className="set-rowdesc">{t('pet.nest.full', { max: MAX_PETS })}</span>}
        </div>
        <div className="set-rowctl">
          {own.length > 0 && (
            <Select aria-label={t('pet.nest.species')} value={pick} onChange={(e) => setPick(e.target.value)}>
              <option value="">{t('pet.nest.random')}</option>
              {own.map((o) => (
                <option key={o.id} value={o.id}>
                  {o.name}
                </option>
              ))}
            </Select>
          )}
          <Button
            variant="primary"
            disabled={full}
            onClick={() => void adopt(hatchOf(own.find((o) => o.id === pick)))}
          >
            <PawPrint size={14} /> {t('pet.nest.adopt')}
          </Button>
        </div>
      </div>
      {menu && nest?.pets[menu.i] && (
        <ContextMenu
          x={menu.x}
          y={menu.y}
          onClose={closeMenu}
          items={((): MenuItem[] => {
            const i = menu.i
            const items: MenuItem[] = [
              { label: t('pet.nest.rename'), onClick: () => void rename(i) },
              { label: t('pet.nest.restart'), onClick: () => restart(i) },
              { label: '', onClick: () => {}, separator: true }
            ]
            items.push(
              count <= 1
                ? { label: t('pet.nest.lastOne'), onClick: () => {}, info: true }
                : { label: t('pet.nest.release'), onClick: () => release(i), danger: true }
            )
            return items
          })()}
        />
      )}
      {note && <div className="set-note">{note}</div>}
      {layoutOpen && nest?.pets[nest.active] && (
        <div ref={layoutRef}>
          <div className="section-label">
            {t('pet.layout.title', { name: petTitle(nest.pets[nest.active], t) })}
          </div>
          <PetLayoutEditor
            pet={nest.pets[nest.active]}
            onClose={() => setLayoutOpen(false)}
            onSave={async (worn, layout) => (await run({ op: 'decor', ...ref(nest.active), worn, layout })) === 'ok'}
          />
        </div>
      )}
      {motionOpen && nest?.pets[nest.active] && (
        <div ref={motionRef}>
          <div className="section-label">{t('pet.mo.titleFor', { name: petTitle(nest.pets[nest.active], t) })}</div>
          <PetMotionPanel
            pet={nest.pets[nest.active]}
            onClose={() => setMotionOpen(false)}
            onSave={async (motion) => (await run({ op: 'motion', ...ref(nest.active), motion })) === 'ok'}
          />
        </div>
      )}

      <div className="section-label">{t('pet.species.custom')}</div>
      <PetSpeciesSettings
        full={full}
        onRaise={async (s) => {
          const r = await adopt(hatchOf(s))
          return r === 'ok' ? t('pet.maker.raised', { name: s.name }) : null
        }}
      />
    </>
  )
}
