import { useEffect, useState } from 'react'
import { PawPrint, EyeOff, ImagePlus, LayoutGrid, Move, Pencil, RotateCcw, Settings, Undo2, X } from 'lucide-react'
import { useT } from '../i18n'
import { MAX_PETS, petSubtitle, petTitle, type Hatch, type NestBrief } from '../state/pet'
import { designOf, type CustomSpecies } from '../state/petSpecies'
import { Creature } from './PetDevice'

// ---------------------------------------------------------------------------
// The pet's own control panel ("내 펫"), opened from its right-click menu in the
// card beside it. Everything about keeping the pets is here as plain buttons:
// which one is out, rename, start over (back to level 1), let go, a new pet
// (random or one of the keeper's own species), where it lives, on top, hide. Settings > 리븐펫 lists
// the same things with the same words in the same order (PetNestSettings).
//
// The actions on a pet act on the one that is out: show another one first to
// look after it. Starting over and letting go ask once, in place.
// ---------------------------------------------------------------------------

type Danger = 'restart' | 'release'

export default function PetManage({
  nest,
  detached,
  onTop,
  own,
  note,
  onClose,
  onSelect,
  onRename,
  onRestart,
  onRelease,
  onAdopt,
  onWhere,
  onOnTop,
  onHide,
  onOpenSettings,
  onLayout,
  onMotion,
  onMakeSpecies
}: {
  nest: NestBrief
  detached: boolean
  onTop: boolean
  own: CustomSpecies[]
  /** A word on what the last press did (a full nest...), or nothing. */
  note: string | null
  onClose: () => void
  onSelect: (i: number) => void
  onRename: () => void
  onRestart: () => void
  onRelease: () => void
  onAdopt: (hatch: Hatch | null) => void
  onWhere: (ownWindow: boolean) => void
  onOnTop: (on: boolean) => void
  onHide: () => void
  onOpenSettings: () => void
  /** The decoration layout of the one that is out (opens in Settings). */
  onLayout: () => void
  /** How the one that is out moves (opens in Settings). */
  onMotion: () => void
  /** The species maker (opens over Settings). */
  onMakeSpecies: () => void
}): JSX.Element {
  const t = useT()
  const [asking, setAsking] = useState<Danger | null>(null)
  // What the next pet will be: a random draw (null), or one of the keeper's own.
  const [pick, setPick] = useState<string | null>(null)
  const chosen = own.find((o) => o.id === pick) ?? null
  const shown = nest.pets[nest.active]
  // A question about one pet is not carried over to another (switched from
  // Settings meanwhile).
  const shownAt = shown?.bornAt
  useEffect(() => setAsking(null), [shownAt])
  const full = nest.pets.length >= MAX_PETS
  const confirm = (): void => {
    if (asking === 'restart') onRestart()
    if (asking === 'release') onRelease()
    setAsking(null)
  }

  return (
    <div className="pet-manage">
      <div className="pet-manage-head">
        <b>{t('pet.nest.count', { n: nest.pets.length, max: MAX_PETS })}</b>
        <button type="button" className="pet-back" title={t('pet.back')} aria-label={t('pet.back')} onClick={onClose}>
          <X size={12} />
        </button>
      </div>

      <div className="pet-nest-list">
        {nest.pets.map((p, i) => (
          <div key={`${p.bornAt}-${i}`} className={`pet-nest-row${i === nest.active ? ' on' : ''}`}>
            <span className="pet-mini">
              <Creature species={p.species} mood="ok" chewing={false} level={p.level} />
            </span>
            <span className="pet-nest-text">
              <b>{petTitle(p, t)}</b>
              <span>{petSubtitle(p, t)}</span>
            </span>
            {i === nest.active ? (
              <span className="pet-tag">{t('pet.nest.shown')}</span>
            ) : (
              <button type="button" className="pet-btn small" onClick={() => onSelect(i)}>
                {t('pet.nest.show')}
              </button>
            )}
          </div>
        ))}
      </div>

      {/* What you can do with the one that is out. */}
      {asking ? (
        <div className="pet-confirm">
          <p>
            {t(asking === 'restart' ? 'pet.nest.restartConfirm' : 'pet.nest.releaseConfirm', {
              name: shown ? petTitle(shown, t) : ''
            })}
          </p>
          <div className="pet-btns">
            <button type="button" className="pet-btn danger" onClick={confirm}>
              {t(asking === 'restart' ? 'pet.nest.restart' : 'pet.nest.release')}
            </button>
            <button type="button" className="pet-btn" onClick={() => setAsking(null)}>
              {t('common.cancel')}
            </button>
          </div>
        </div>
      ) : (
        <div className="pet-btns three">
          <button type="button" className="pet-btn" onClick={onRename}>
            <Pencil size={12} />
            <span>{t('pet.nest.rename')}</span>
          </button>
          <button type="button" className="pet-btn" onClick={() => setAsking('restart')}>
            <RotateCcw size={12} />
            <span>{t('pet.nest.restart')}</span>
          </button>
          <button
            type="button"
            className="pet-btn"
            disabled={nest.pets.length <= 1}
            title={nest.pets.length <= 1 ? t('pet.nest.lastOne') : undefined}
            onClick={() => setAsking('release')}
          >
            <Undo2 size={12} />
            <span>{t('pet.nest.release')}</span>
          </button>
        </div>
      )}
      <div className="pet-btns two">
        <button type="button" className="pet-btn" onClick={onLayout}>
          <LayoutGrid size={12} />
          <span>{t('pet.layout.open')}</span>
        </button>
        <button type="button" className="pet-btn" onClick={onMotion}>
          <Move size={12} />
          <span>{t('pet.mo.open')}</span>
        </button>
      </div>

      <div className="pet-manage-label">{t('pet.nest.newPet')}</div>
      {own.length > 0 && (
        <div className="pet-chips" role="radiogroup" aria-label={t('pet.nest.species')}>
          <button
            type="button"
            role="radio"
            aria-checked={!chosen}
            className={`pet-chip${!chosen ? ' on' : ''}`}
            onClick={() => setPick(null)}
          >
            {t('pet.nest.random')}
          </button>
          {own.map((o) => (
            <button
              key={o.id}
              type="button"
              role="radio"
              aria-checked={chosen?.id === o.id}
              className={`pet-chip${chosen?.id === o.id ? ' on' : ''}`}
              onClick={() => setPick(o.id)}
            >
              {o.name}
            </button>
          ))}
        </div>
      )}
      <button
        type="button"
        className="pet-btn primary wide"
        disabled={full}
        onClick={() => onAdopt(chosen ? { id: chosen.id, design: designOf(chosen) } : null)}
      >
        <PawPrint size={12} />
        <span>{t('pet.nest.adopt')}</span>
      </button>
      <button type="button" className="pet-btn wide" onClick={onMakeSpecies}>
        <ImagePlus size={12} />
        <span>{t('pet.maker.create')}</span>
      </button>
      {full && <p className="pet-manage-note">{t('pet.nest.full', { max: MAX_PETS })}</p>}
      {note && <p className="pet-manage-note">{note}</p>}

      <div className="pet-manage-label">{t('pet.display')}</div>
      <div className="pet-manage-line">
        <span>{t('pet.where')}</span>
        <div className="pet-chips" role="radiogroup" aria-label={t('pet.where')}>
          <button
            type="button"
            role="radio"
            aria-checked={!detached}
            className={`pet-chip${!detached ? ' on' : ''}`}
            onClick={() => detached && onWhere(false)}
          >
            {t('pet.where.inside')}
          </button>
          <button
            type="button"
            role="radio"
            aria-checked={detached}
            className={`pet-chip${detached ? ' on' : ''}`}
            onClick={() => !detached && onWhere(true)}
          >
            {t('pet.where.outside')}
          </button>
        </div>
      </div>
      {/* Only its own window can float above other apps. */}
      {detached && (
        <div className="pet-manage-line">
          <span>{t('pet.onTop')}</span>
          <button
            type="button"
            role="switch"
            aria-checked={onTop}
            aria-label={t('pet.onTop')}
            className={`pet-switch${onTop ? ' on' : ''}`}
            onClick={() => onOnTop(!onTop)}
          >
            <i />
          </button>
        </div>
      )}
      <div className="pet-btns two">
        <button type="button" className="pet-btn" onClick={onHide}>
          <EyeOff size={12} />
          <span>{t('pet.hide')}</span>
        </button>
        <button type="button" className="pet-btn" onClick={onOpenSettings}>
          <Settings size={12} />
          <span>{t('pet.openSettings')}</span>
        </button>
      </div>
    </div>
  )
}
