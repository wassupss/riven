import { useEffect, useState } from 'react'
import { Check, CheckCheck } from 'lucide-react'
import type { RoleInfo } from '../../../../../main/db/types'
import type { DdlPlan } from '../../../../../main/db/ddl'
import { useT } from '../../../i18n'
import { Select } from '../../../components/ui/Controls'
import { errText } from './ConnectionForm'

// Bits shared by the privilege editors: the three-state cell, the grantee
// picker, the role list and the apply/status flow.

/** none -> granted -> WITH GRANT OPTION -> none. */
export type CellState = 0 | 1 | 2
export const nextCell = (s: CellState): CellState => ((s + 1) % 3) as CellState

export function PrivCell({ state, disabled, onClick }: { state: CellState; disabled?: boolean; onClick: () => void }): JSX.Element {
  const t = useT()
  return (
    <button
      className={`dbx-priv-cell${state === 1 ? ' on' : state === 2 ? ' opt' : ''}`}
      disabled={disabled}
      title={state === 2 ? t('db.r.withGrant') : state === 1 ? t('db.r.granted') : t('db.r.notGranted')}
      onClick={onClick}
    >
      {state === 2 ? <CheckCheck size={12} /> : state === 1 ? <Check size={12} /> : null}
    </button>
  )
}

/** Roles of a connection, read once per mount (and again on `reload`). */
export function useRoles(connId: string, reload = 0): { roles: RoleInfo[]; error?: string } {
  const [s, setS] = useState<{ roles: RoleInfo[]; error?: string }>({ roles: [] })
  useEffect(() => {
    let live = true
    window.api.db
      .roles(connId)
      .then((roles) => live && setS({ roles }))
      .catch((e) => live && setS({ roles: [], error: errText(e) }))
    return () => {
      live = false
    }
  }, [connId, reload])
  return s
}

/** A select that adds a role (or PUBLIC) not already in `taken`. */
export function RolePicker({
  roles,
  taken,
  placeholder,
  publicToo,
  systemToo,
  disabled,
  onPick
}: {
  roles: RoleInfo[]
  taken: string[]
  placeholder: string
  publicToo?: boolean
  /** Offer the predefined pg_* roles too (useful as memberships). */
  systemToo?: boolean
  disabled?: boolean
  onPick: (role: string) => void
}): JSX.Element {
  const names = [...(publicToo ? ['PUBLIC'] : []), ...roles.filter((r) => systemToo || !r.system).map((r) => r.name)].filter((n) => !taken.includes(n))
  return (
    <Select
      className="dbx-role-pick"
      value=""
      disabled={disabled || !names.length}
      onChange={(e) => e.target.value && onPick(e.target.value)}
    >
      <option value="">{placeholder}</option>
      {names.map((n) => (
        <option key={n} value={n}>
          {n}
        </option>
      ))}
    </Select>
  )
}

export interface ApplyState {
  busy: boolean
  status: { ok: boolean; text: string } | null
  setStatus: (s: { ok: boolean; text: string } | null) => void
  /** Runs `plan`, then `after`; reports the outcome in `status`. */
  run: (connId: string, db: string | undefined, plan: DdlPlan, after: () => void) => Promise<void>
}

export function useApply(): ApplyState {
  const t = useT()
  const [busy, setBusy] = useState(false)
  const [status, setStatus] = useState<{ ok: boolean; text: string } | null>(null)
  const run = async (connId: string, db: string | undefined, plan: DdlPlan, after: () => void): Promise<void> => {
    if (!plan.stmts.length) return
    setBusy(true)
    setStatus(null)
    try {
      await window.api.db.ddlApply(connId, db, plan)
      after()
      setStatus({ ok: true, text: t('db.d.applied', { n: plan.stmts.length }) })
    } catch (e) {
      setStatus({ ok: false, text: errText(e) })
    } finally {
      setBusy(false)
    }
  }
  return { busy, status, setStatus, run }
}
