import '../styles/pet-maker.css'
import { useEffect, useMemo, useState } from 'react'
import { useT } from '../i18n'
import {
  ASSISTANT_PERMISSIONS,
  ROLE_MAX,
  defaultAssistant,
  sanitizeAssistant,
  type AssistantConfig,
  type AssistantPermission
} from '../lib/petAssistant'
import type { PetBrief } from '../state/pet'
import { useSession, workspaceName, pathOf } from '../state/session'
import { Button, Segmented, Select, Switch, TextArea } from './ui/Controls'
import ModelOptions from './ModelOptions'

// ---------------------------------------------------------------------------
// Settings > 리븐펫 > a pet's 비서 설정 (펫 비서): whether talking to it goes to
// Claude, who it is (role), which model, which workspaces it may act in and
// how much it may do without asking. Opened from the pet's ⋯ menu, below
// the list, like the decoration layout, so the one-line rows stay as they
// are. Nothing runs from here: the session starts when the pet is first
// talked to (state/petAssistants).
// ---------------------------------------------------------------------------

export default function PetAssistantSettings({
  pet,
  onSave,
  onClose
}: {
  pet: PetBrief
  onSave: (cfg: AssistantConfig) => Promise<boolean>
  onClose: () => void
}): JSX.Element {
  const t = useT()
  const start = useMemo(() => pet.assistant ?? { ...defaultAssistant(), on: false }, [pet.assistant])
  const [cfg, setCfg] = useState<AssistantConfig>(start)
  const [busy, setBusy] = useState(false)
  const [note, setNote] = useState<string | null>(null)
  // Another pet (or the same one changed elsewhere): start from what it has.
  useEffect(() => {
    setCfg(start)
    setNote(null)
  }, [pet.bornAt, start])
  const open = useSession((s) => s.openWorkspaces)
  const names = useSession((s) => s.names)
  // The open workspaces, then any picked one that is not open now (kept, dimmed).
  const listed = useMemo(() => [...open, ...cfg.workspaces.filter((w) => !open.includes(w))], [open, cfg.workspaces])

  const set = (patch: Partial<AssistantConfig>): void => {
    setCfg((c) => ({ ...c, ...patch }))
    setNote(null)
  }
  const toggleWs = (w: string, on: boolean): void =>
    set({ workspaces: on ? [...cfg.workspaces.filter((x) => x !== w), w] : cfg.workspaces.filter((x) => x !== w) })

  const clean = sanitizeAssistant(cfg)
  const dirty = JSON.stringify(clean) !== JSON.stringify(sanitizeAssistant(start))
  // Picking workspaces with none picked is not a choice that can be saved.
  const nonePicked =!cfg.allWorkspaces && cfg.workspaces.length === 0
  const save = async (): Promise<void> => {
    if (!clean || nonePicked) return
    setBusy(true)
    const ok = await onSave(clean)
    setBusy(false)
    setNote(ok ? t('pet.assist.saved') : t('pet.nest.noAnswer'))
  }

  return (
    <div className="pas-panel">
      <div className="set-row">
        <div className="set-rowinfo">
          <span className="set-rowtitle">{t('pet.assist.useAs')}</span>
          <span className="set-rowdesc">{t('pet.assist.useAsDesc')}</span>
        </div>
        <div className="set-rowctl">
          <Switch checked={cfg.on} label={t('pet.assist.useAs')} onChange={(on) => set({ on })} />
        </div>
      </div>
      <fieldset className="pas-fields" disabled={!cfg.on}>
        <label className="pas-field">
          <span className="pas-label">{t('pet.assist.role')}</span>
          <TextArea
            className="pas-role"
            rows={3}
            maxLength={ROLE_MAX}
            value={cfg.role}
            placeholder={t('pet.assist.rolePlaceholder')}
            onChange={(e) => set({ role: e.target.value })}
          />
        </label>
        <div className="pas-grid">
          <label className="pas-field">
            <span className="pas-label">{t('pet.assist.model')}</span>
            <Select value={cfg.model} onChange={(e) => set({ model: e.target.value })}>
              <ModelOptions cli="claude" current={cfg.model} />
            </Select>
          </label>
          <label className="pas-field">
            <span className="pas-label">{t('pet.assist.permission')}</span>
            <Select value={cfg.permission} onChange={(e) => set({ permission: e.target.value as AssistantPermission })}>
              {ASSISTANT_PERMISSIONS.map((p) => (
                <option key={p} value={p}>
                  {t(`pet.assist.perm.${p}`)}
                </option>
              ))}
            </Select>
          </label>
        </div>
        <p className="pas-hint">{t(`pet.assist.permDesc.${cfg.permission}`)}</p>
        <div className="pas-field">
          <span className="pas-label">{t('pet.assist.scope')}</span>
          <Segmented
            value={cfg.allWorkspaces ? 'all' : 'some'}
            options={[
              { value: 'all', label: t('pet.assist.scopeAll') },
              { value: 'some', label: t('pet.assist.scopeSome') }
            ]}
            onChange={(v) => set({ allWorkspaces: v === 'all' })}
          />
        </div>
        {!cfg.allWorkspaces && (
          <div className="pas-ws">
            {listed.length === 0 && <p className="pas-hint">{t('pet.assist.noWorkspaces')}</p>}
            {listed.map((w) => {
              const on = cfg.workspaces.includes(w)
              const closed = !open.includes(w)
              return (
                <div key={w} className={`pas-ws-row${closed ? ' closed' : ''}`}>
                  <span className="pas-ws-text" title={pathOf(w)}>
                    <b>{workspaceName(w, names)}</b>
                    <span>{closed ? t('pet.assist.wsClosed') : pathOf(w)}</span>
                  </span>
                  <Switch checked={on} label={workspaceName(w, names)} onChange={(v) => toggleWs(w, v)} />
                </div>
              )
            })}
            {nonePicked && listed.length > 0 && <p className="pas-hint warn">{t('pet.assist.pickOne')}</p>}
          </div>
        )}
      </fieldset>
      <div className="pmk-row pas-actions">
        {note && <span className="pmk-note">{note}</span>}
        <span className="pm-gap" />
        <Button variant="ghost" onClick={onClose}>
          {t('pet.layout.close')}
        </Button>
        <Button variant="primary" disabled={!dirty || busy || nonePicked} onClick={() => void save()}>
          {t('pet.layout.save')}
        </Button>
      </div>
    </div>
  )
}
