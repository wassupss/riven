import { useCallback, useEffect, useRef, useState } from 'react'
import { PawPrint, Pencil, RotateCcw, Undo2 } from 'lucide-react'
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
  type PetCommand,
  type PetResult
} from '../state/pet'
import { designOf, isCustomId, noteDesign, useCustomSpecies, type CustomSpecies } from '../state/petSpecies'
import { useSettings } from '../state/settings'
import { Button, Select } from './ui/Controls'
import { Creature } from './PetDevice'
import PetSpeciesSettings from './PetSpeciesSettings'
import { promptInput } from './promptInput'

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

export default function PetNestSettings(): JSX.Element {
  const t = useT()
  const shown = useSettings((s) => s.settings.petShow)
  const [nest, setNest] = useState<NestBrief | null>(null)
  const [note, setNote] = useState<string | null>(null)
  const [pick, setPick] = useState<string>('')
  const own = useCustomSpecies((s) => s.own)

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
      {nest?.pets.map((p, i) => (
        <div key={`${p.bornAt}-${i}`} className="set-row pm-item pet-nest-item">
          <div className="pm-pet">
            <Creature species={p.species} mood="ok" chewing={false} level={p.level} />
          </div>
          <div className="set-rowinfo">
            <span className="set-rowtitle">{petTitle(p, t)}</span>
            <span className="set-rowdesc">{petSubtitle(p, t)}</span>
          </div>
          <div className="set-rowctl">
            {i === nest.active ? (
              <span className="pet-nest-shown">{t('pet.nest.shown')}</span>
            ) : (
              <Button onClick={() => void run({ op: 'select', ...ref(i) })}>{t('pet.nest.show')}</Button>
            )}
            <Button onClick={() => void rename(i)}>
              <Pencil size={14} /> {t('pet.nest.rename')}
            </Button>
            <Button onClick={() => restart(i)}>
              <RotateCcw size={14} /> {t('pet.nest.restart')}
            </Button>
            <Button
              disabled={count <= 1}
              title={count <= 1 ? t('pet.nest.lastOne') : undefined}
              onClick={() => release(i)}
            >
              <Undo2 size={14} /> {t('pet.nest.release')}
            </Button>
          </div>
        </div>
      ))}
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
      {note && <div className="set-note">{note}</div>}

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
