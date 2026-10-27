import { useMemo, useState } from 'react'
import { createPortal } from 'react-dom'
import { useHost } from '../../../lib/hostWindow'
import { planText, type DdlPlan } from '../../../../../main/db/ddl'
import { useT } from '../../../i18n'
import { Button, Select, Switch, TextArea, TextInput } from '../../../components/ui/Controls'
import { Row, errText } from './ConnectionForm'
import { invalidateCompletion } from './sqlComplete'

export type FieldValue = string | boolean

export interface DdlField {
  key: string
  label: string
  kind: 'text' | 'switch' | 'select' | 'sql'
  hint?: string
  placeholder?: string
  options?: Array<{ value: string; label: string }>
  /** Height of an sql field (default 8). */
  rows?: number
}

export interface DdlAction {
  title: string
  connId: string
  /** Database the statements run on. */
  db?: string
  fields: DdlField[]
  initial?: Record<string, FieldValue>
  /** The plan for the current values, or null while they're incomplete. */
  build: (v: Record<string, FieldValue>) => DdlPlan | null
  /** A name the user must type before a destructive action applies. */
  confirm?: string
  danger?: boolean
  applyLabel?: string
  onDone: (v: Record<string, FieldValue>) => void
}

// One object action (create, rename, drop, truncate, refresh): a few fields, the
// SQL they make, and Apply. Drops ask for the object's name to be typed.
export default function DdlDialog({ action, onClose }: { action: DdlAction; onClose: () => void }): JSX.Element {
  const t = useT()
  const host = useHost() // a popped-out panel's window, not always main's
  const [v, setV] = useState<Record<string, FieldValue>>(() => {
    const init: Record<string, FieldValue> = {}
    for (const f of action.fields) init[f.key] = f.kind === 'switch' ? false : f.kind === 'select' ? (f.options?.[0]?.value ?? '') : ''
    return { ...init, ...action.initial }
  })
  const [typed, setTyped] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const plan = useMemo(() => {
    try {
      return action.build(v)
    } catch {
      return null
    }
  }, [action, v])
  const confirmed = !action.confirm || typed === action.confirm
  const set = (k: string, x: FieldValue): void => setV((p) => ({ ...p, [k]: x }))

  const apply = async (): Promise<void> => {
    if (!plan || !confirmed) return
    setBusy(true)
    setError(null)
    try {
      await window.api.db.ddlApply(action.connId, action.db, plan)
      invalidateCompletion(action.connId)
      action.onDone(v)
      onClose()
    } catch (e) {
      setError(errText(e))
      setBusy(false)
    }
  }

  return createPortal(
    <div className="modal-overlay" onClick={onClose}>
      <div
        className="modal dbx-form dbx-ddl"
        onClick={(e) => e.stopPropagation()}
        onKeyDown={(e) => {
          if (e.key === 'Escape') onClose()
          else if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) void apply()
        }}
      >
        <div className="modal-header">
          <span>{action.title}</span>
        </div>
        <div className="dbx-form-body">
          {action.fields.map((f, i) => (
            <Row key={f.key} label={f.label} hint={f.hint}>
              {f.kind === 'switch' ? (
                <Switch checked={!!v[f.key]} onChange={(x) => set(f.key, x)} />
              ) : f.kind === 'select' ? (
                <Select value={String(v[f.key])} onChange={(e) => set(f.key, e.target.value)}>
                  {f.options?.map((o) => (
                    <option key={o.value} value={o.value}>
                      {o.label}
                    </option>
                  ))}
                </Select>
              ) : f.kind === 'sql' ? (
                <TextArea
                  className="dbx-ddl-sql"
                  rows={f.rows ?? 8}
                  spellCheck={false}
                  value={String(v[f.key])}
                  placeholder={f.placeholder}
                  autoFocus={i === 0}
                  onChange={(e) => set(f.key, e.target.value)}
                />
              ) : (
                <TextInput
                  value={String(v[f.key])}
                  placeholder={f.placeholder}
                  spellCheck={false}
                  autoFocus={i === 0}
                  onChange={(e) => set(f.key, e.target.value)}
                  onKeyDown={(e) => e.key === 'Enter' && !action.confirm && void apply()}
                />
              )}
            </Row>
          ))}
          {action.confirm && (
            <Row label={t('db.d.typeToConfirm')} hint={action.confirm}>
              <TextInput
                value={typed}
                placeholder={action.confirm}
                spellCheck={false}
                autoFocus={!action.fields.length}
                onChange={(e) => setTyped(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && void apply()}
              />
            </Row>
          )}
          <div className="dbx-form-sect">SQL</div>
          <pre className="dbx-ddl-preview">{plan ? planText(plan) : t('db.d.incomplete')}</pre>
        </div>
        {error && <div className="dbx-form-status err">{error}</div>}
        <div className="dbx-form-foot">
          <span className="dbx-spacer" />
          <Button variant="ghost" onClick={onClose}>
            {t('db.cancel')}
          </Button>
          <Button
            variant="primary"
            className={action.danger ? 'dbx-danger-btn' : undefined}
            disabled={busy || !plan || !confirmed}
            onClick={() => void apply()}
          >
            {busy ? t('db.d.applying') : (action.applyLabel ?? t('db.d.apply'))}
          </Button>
        </div>
      </div>
    </div>,
    host.doc.body
  )
}
