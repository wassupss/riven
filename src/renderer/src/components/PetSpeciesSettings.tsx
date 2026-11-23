import '../styles/pet-maker.css'
import { useEffect, useState } from 'react'
import { Pencil, Trash2, PawPrint, Plus } from 'lucide-react'
import { useT } from '../i18n'
import { useUI } from '../state/ui'
import { Button } from './ui/Controls'
import PetMaker, { SpeciesPreview } from './PetMaker'
import { MAX_CUSTOM, familyOfDesign, useCustomSpecies, type CustomSpecies } from '../state/petSpecies'

// ---------------------------------------------------------------------------
// Settings > 리븐펫 > 내가 만든 종: the keeper's own species, a button that
// makes a new one, and the maker (PetMaker.tsx, a modal of its own) opened on
// a new one or on one of the list. "펫 받기" on one is the same new pet as the
// nest's own button, of that species (PetNestSettings runs it and says what
// happened). The pet's panel asks for a new one through useUI.petMakerAsk.
// ---------------------------------------------------------------------------

export default function PetSpeciesSettings({
  full,
  onRaise
}: {
  /** The nest has no room for another pet. */
  full: boolean
  onRaise: (s: CustomSpecies) => Promise<string | null>
}): JSX.Element {
  const t = useT()
  const own = useCustomSpecies((s) => s.own)
  const load = useCustomSpecies((s) => s.load)
  const remove = useCustomSpecies((s) => s.remove)
  const loaded = useCustomSpecies((s) => s.loaded)
  // null: none open; 'new': making one; otherwise the one being edited.
  const [making, setMaking] = useState<'new' | CustomSpecies | null>(null)
  // What the last "펫 받기" press did, said under the list.
  const [raised, setRaised] = useState<string | null>(null)
  useEffect(() => void load(), [load])
  const raise = (s: CustomSpecies): void => void onRaise(s).then(setRaised)
  const canMake = loaded && own.length < MAX_CUSTOM

  // "새 펫 종 만들기" from the pet's panel: taken once, so Settings opened later does not reopen it.
  const asked = useUI((s) => s.petMakerAsk)
  useEffect(() => {
    if (!asked || !loaded) return
    useUI.setState({ petMakerAsk: false })
    if (own.length < MAX_CUSTOM) setMaking((m) => m ?? 'new')
  }, [asked, loaded, own.length])

  return (
    <>
      <div className="set-row">
        <div className="set-rowinfo">
          <span className="set-rowdesc">{t('pet.maker.sectionDesc')}</span>
          {own.length >= MAX_CUSTOM && <span className="set-rowdesc">{t('pet.maker.limit', { n: MAX_CUSTOM })}</span>}
        </div>
        <div className="set-rowctl">
          <Button variant="primary" onClick={() => setMaking('new')} disabled={!canMake}>
            <Plus size={14} /> {t('pet.maker.create')}
          </Button>
        </div>
      </div>
      {loaded && own.length === 0 && <div className="set-note">{t('pet.maker.empty')}</div>}
      {own.map((s) => (
        <div key={s.id} className="set-row pm-item">
          <SpeciesPreview id={s.id} />
          <div className="set-rowinfo">
            <span className="set-rowtitle">{s.name}</span>
            <span className="set-rowdesc">{t(`pet.maker.family.${familyOfDesign(s)}`)}</span>
          </div>
          <div className="set-rowctl">
            <Button disabled={full} onClick={() => raise(s)}>
              <PawPrint size={14} /> {t('pet.nest.adopt')}
            </Button>
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
      {raised && <div className="set-note">{raised}</div>}
      {making && (
        <PetMaker
          key={making === 'new' ? 'new' : making.id}
          editing={making === 'new' ? null : making}
          taken={own.map((s) => s.name)}
          full={full}
          onRaise={onRaise}
          onClose={() => setMaking(null)}
        />
      )}
    </>
  )
}
