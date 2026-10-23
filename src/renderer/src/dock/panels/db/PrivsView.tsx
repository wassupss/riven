import { useT } from '../../../i18n'
import { useDb, type PrivsTab } from '../../../state/db'
import GrantsEditor from './GrantsEditor'
import DefaultPrivsEditor from './DefaultPrivsEditor'

// Privileges of a database or a schema: its own GRANT matrix, then the default
// privileges that apply to objects created in it later.
export default function PrivsView({ tab }: { tab: PrivsTab }): JSX.Element {
  const t = useT()
  const conn = useDb((s) => s.connections.find((c) => c.id === tab.connId))
  const openRoles = useDb((s) => s.openRoles)
  const readOnly = !!conn?.readOnly
  return (
    <div className="dbx-obj">
      <div className="dbx-obj-head">
        <span className="dbx-obj-title">{tab.name}</span>
        <span className="dbx-kind">{t(`db.r.kind.${tab.scope}`)}</span>
        <span className="dbx-spacer" />
        <button className="dbx-link" onClick={() => openRoles(tab.connId, tab.db)}>
          {t('db.r.roles')}
        </button>
      </div>
      <div className="dbx-obj-body dbx-privs-page">
        <div className="dbx-form-sect">{t('db.r.privileges')}</div>
        <GrantsEditor connId={tab.connId} db={tab.db} target={{ kind: tab.scope, schema: '', name: tab.name }} readOnly={readOnly} />
        <div className="dbx-form-sect">{t('db.r.defaults')}</div>
        <DefaultPrivsEditor connId={tab.connId} db={tab.db} schema={tab.scope === 'schema' ? tab.name : undefined} readOnly={readOnly} />
      </div>
    </div>
  )
}
