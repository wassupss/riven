import { useState } from 'react'
import { createPortal } from 'react-dom'
import type { ConnectionConfig, ConnectionInfo, SslMode } from '../../../../../main/db/types'
import { useT } from '../../../i18n'
import { Button, NumberInput, Select, Switch, TextArea, TextInput } from '../../../components/ui/Controls'

const COLORS = ['', '#e5534b', '#e0823d', '#c69026', '#57ab5a', '#39c5cf', '#539bf5', '#b083f0']

type Isolation = NonNullable<NonNullable<ConnectionConfig['options']>['isolation']>

function blank(): ConnectionConfig {
  return { id: '', name: '', kind: 'postgres', host: 'localhost', port: 5432, user: 'postgres', database: 'postgres', readOnly: false }
}

// Add/edit one data source. The stored password is never sent to the renderer:
// an empty field on edit keeps it, "clear" removes it.
export default function ConnectionForm({
  initial,
  onClose,
  onSaved
}: {
  initial?: ConnectionInfo
  onClose: () => void
  onSaved: (c: ConnectionInfo) => void
}): JSX.Element {
  const t = useT()
  const [cfg, setCfg] = useState<ConnectionConfig>(() => {
    if (!initial) return blank()
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const { hasPassword, ...rest } = initial
    return rest
  })
  const [password, setPassword] = useState('')
  const [clearPw, setClearPw] = useState(false)
  const [busy, setBusy] = useState(false)
  const [status, setStatus] = useState<{ ok: boolean; text: string } | null>(null)

  const set = <K extends keyof ConnectionConfig>(k: K, v: ConnectionConfig[K]): void => setCfg((c) => ({ ...c, [k]: v }))
  const setSsl = (patch: Partial<NonNullable<ConnectionConfig['ssl']>>): void =>
    setCfg((c) => ({ ...c, ssl: { mode: 'disable', ...c.ssl, ...patch } }))
  const setOpt = (patch: Partial<NonNullable<ConnectionConfig['options']>>): void =>
    setCfg((c) => ({ ...c, options: { ...c.options, ...patch } }))

  // undefined keeps the stored one; null clears it; a string replaces it.
  const pwArg = (): string | null | undefined => (password ? password : clearPw ? null : undefined)

  const clean = (): ConnectionConfig => {
    const ssl = cfg.ssl && cfg.ssl.mode !== 'disable' ? cfg.ssl : undefined
    const o = cfg.options ?? {}
    const options =
      o.timeZone || o.isolation || o.startupScript?.trim()
        ? { timeZone: o.timeZone || undefined, isolation: o.isolation || undefined, startupScript: o.startupScript?.trim() || undefined }
        : undefined
    return { ...cfg, name: cfg.name.trim() || `${cfg.user}@${cfg.host}`, host: cfg.host.trim(), ssl, options }
  }

  const test = async (): Promise<void> => {
    setBusy(true)
    setStatus(null)
    try {
      const pw = pwArg()
      const v = await window.api.db.test(clean(), pw === null ? '' : pw)
      setStatus({ ok: true, text: v })
    } catch (e) {
      setStatus({ ok: false, text: errText(e) })
    } finally {
      setBusy(false)
    }
  }

  const save = async (): Promise<void> => {
    setBusy(true)
    try {
      onSaved(await window.api.db.save(clean(), pwArg()))
    } catch (e) {
      setStatus({ ok: false, text: errText(e) })
      setBusy(false)
    }
  }

  const ssl = cfg.ssl ?? { mode: 'disable' as SslMode }

  return createPortal(
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal dbx-form" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <span>{initial ? t('db.editConnection') : t('db.newConnection')}</span>
        </div>
        <div className="dbx-form-body">
          <Row label={t('db.f.name')}>
            <TextInput value={cfg.name} placeholder={`${cfg.user}@${cfg.host}`} onChange={(e) => set('name', e.target.value)} autoFocus />
          </Row>
          <Row label={t('db.f.kind')}>
            <Select value={cfg.kind} onChange={() => {}}>
              <option value="postgres">PostgreSQL</option>
            </Select>
          </Row>
          <Row label={t('db.f.host')}>
            <div className="dbx-form-pair">
              <TextInput value={cfg.host} onChange={(e) => set('host', e.target.value)} />
              <NumberInput
                className="dbx-form-port"
                value={cfg.port}
                min={1}
                max={65535}
                onChange={(e) => set('port', Number(e.target.value) || 0)}
              />
            </div>
          </Row>
          <Row label={t('db.f.user')}>
            <TextInput value={cfg.user} onChange={(e) => set('user', e.target.value)} />
          </Row>
          <Row label={t('db.f.password')}>
            <div className="dbx-form-pair">
              <TextInput
                type="password"
                value={password}
                disabled={clearPw}
                placeholder={initial?.hasPassword && !clearPw ? t('db.f.passwordKept') : ''}
                onChange={(e) => setPassword(e.target.value)}
              />
              {initial?.hasPassword && (
                <label className="dbx-form-inline">
                  <Switch checked={clearPw} onChange={(v) => { setClearPw(v); if (v) setPassword('') }} />
                  {t('db.f.clearPassword')}
                </label>
              )}
            </div>
          </Row>
          <Row label={t('db.f.database')}>
            <TextInput value={cfg.database} onChange={(e) => set('database', e.target.value)} />
          </Row>
          <Row label={t('db.f.readOnly')} hint={t('db.f.readOnlyHint')}>
            <Switch checked={cfg.readOnly} onChange={(v) => set('readOnly', v)} />
          </Row>
          <Row label={t('db.f.color')}>
            <div className="dbx-colors">
              {COLORS.map((c) => (
                <button
                  key={c || 'none'}
                  type="button"
                  className={`dbx-color${(cfg.color ?? '') === c ? ' on' : ''}`}
                  style={c ? { background: c } : undefined}
                  title={c || t('db.f.noColor')}
                  onClick={() => set('color', c || undefined)}
                />
              ))}
            </div>
          </Row>

          <div className="dbx-form-sect">SSL</div>
          <Row label={t('db.f.sslMode')}>
            <Select value={ssl.mode} onChange={(e) => setSsl({ mode: e.target.value as SslMode })}>
              <option value="disable">disable</option>
              <option value="require">require</option>
              <option value="verify-ca">verify-ca</option>
              <option value="verify-full">verify-full</option>
            </Select>
          </Row>
          {ssl.mode !== 'disable' && (
            <>
              <Row label={t('db.f.sslCa')}>
                <TextInput value={ssl.ca ?? ''} placeholder="~/certs/ca.pem" onChange={(e) => setSsl({ ca: e.target.value || undefined })} />
              </Row>
              <Row label={t('db.f.sslCert')}>
                <TextInput value={ssl.cert ?? ''} onChange={(e) => setSsl({ cert: e.target.value || undefined })} />
              </Row>
              <Row label={t('db.f.sslKey')}>
                <TextInput value={ssl.key ?? ''} onChange={(e) => setSsl({ key: e.target.value || undefined })} />
              </Row>
            </>
          )}

          <div className="dbx-form-sect">{t('db.f.options')}</div>
          <Row label={t('db.f.timeZone')}>
            <TextInput value={cfg.options?.timeZone ?? ''} placeholder="Asia/Seoul" onChange={(e) => setOpt({ timeZone: e.target.value })} />
          </Row>
          <Row label={t('db.f.isolation')}>
            <Select
              value={cfg.options?.isolation ?? ''}
              onChange={(e) => setOpt({ isolation: (e.target.value || undefined) as Isolation | undefined })}
            >
              <option value="">{t('db.f.serverDefault')}</option>
              <option value="read committed">read committed</option>
              <option value="repeatable read">repeatable read</option>
              <option value="serializable">serializable</option>
            </Select>
          </Row>
          <Row label={t('db.f.startup')} hint={t('db.f.startupHint')}>
            <TextArea
              rows={3}
              value={cfg.options?.startupScript ?? ''}
              placeholder="set search_path to app, public;"
              onChange={(e) => setOpt({ startupScript: e.target.value })}
            />
          </Row>
        </div>
        {status && <div className={`dbx-form-status${status.ok ? ' ok' : ' err'}`}>{status.text}</div>}
        <div className="dbx-form-foot">
          <Button variant="ghost" disabled={busy || !cfg.host} onClick={() => void test()}>
            {t('db.test')}
          </Button>
          <span className="dbx-spacer" />
          <Button onClick={onClose}>{t('common.cancel')}</Button>
          <Button variant="primary" disabled={busy || !cfg.host || !cfg.user} onClick={() => void save()}>
            {t('db.save')}
          </Button>
        </div>
      </div>
    </div>,
    document.body
  )
}

function Row({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }): JSX.Element {
  return (
    <div className="dbx-form-row">
      <div className="dbx-form-label">
        {label}
        {hint && <div className="dbx-form-hint">{hint}</div>}
      </div>
      <div className="dbx-form-ctl">{children}</div>
    </div>
  )
}

export function errText(e: unknown): string {
  const m = e instanceof Error ? e.message : String(e)
  // ipcRenderer.invoke wraps main-side errors: keep only the original message.
  return m.replace(/^Error invoking remote method '[^']+': (Error: )?/, '')
}
