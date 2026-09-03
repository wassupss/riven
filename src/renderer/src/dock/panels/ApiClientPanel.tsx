import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import '../../styles/api-panel.css'
import { useT } from '../../i18n'
import { highlightCode } from '../../components/highlight'

// =============================================================================
// APIClientPanel — a Postman-like HTTP client.
//
// Everything persists to localStorage (no IPC). Requests go out via the
// existing bridge: window.api.api.request({ method, url, headers, body }).
// The UI is split into a left sidebar (History / Collections / Env) and a main
// area (method+url+send, request-builder tabs, response viewer).
// =============================================================================

interface ApiResponse {
  ok: boolean
  status: number
  statusText: string
  headers: Record<string, string>
  body: string
  timeMs: number
  contentType: string
  error?: string
}

type KV = { id: string; key: string; value: string; enabled: boolean }
type BodyType = 'none' | 'json' | 'form' | 'raw'
type AuthType = 'none' | 'bearer' | 'basic' | 'apikey'

interface AuthState {
  type: AuthType
  token: string
  user: string
  pass: string
  apiKeyName: string
  apiKeyValue: string
}

interface RequestState {
  method: string
  url: string
  params: KV[]
  headers: KV[]
  bodyType: BodyType
  bodyJson: string
  bodyRaw: string
  bodyForm: KV[]
  auth: AuthState
}

interface SavedRequest {
  id: string
  name: string
  req: RequestState
}

interface HistoryItem {
  id: string
  method: string
  url: string
  status: number
  ok: boolean
  timeMs: number
  ts: number
  req: RequestState
}

const METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS']
const LS_HISTORY = 'apiclient.history.v1'
const LS_SAVED = 'apiclient.saved.v1'
const LS_ENV = 'apiclient.env.v1'
const HISTORY_MAX = 25

let idSeq = 0
const uid = (): string => `k${Date.now().toString(36)}${(idSeq++).toString(36)}`

const emptyAuth = (): AuthState => ({
  type: 'none',
  token: '',
  user: '',
  pass: '',
  apiKeyName: '',
  apiKeyValue: ''
})

const blankRequest = (): RequestState => ({
  method: 'GET',
  url: '',
  params: [],
  headers: [],
  bodyType: 'none',
  bodyJson: '',
  bodyRaw: '',
  bodyForm: [],
  auth: emptyAuth()
})

// ---- URL <-> query-param synchronization ------------------------------------

const parseQuery = (url: string): { base: string; params: KV[] } => {
  const qi = url.indexOf('?')
  if (qi < 0) return { base: url, params: [] }
  const base = url.slice(0, qi)
  const params: KV[] = []
  for (const pair of url.slice(qi + 1).split('&')) {
    if (!pair) continue
    const eq = pair.indexOf('=')
    const rawK = eq < 0 ? pair : pair.slice(0, eq)
    const rawV = eq < 0 ? '' : pair.slice(eq + 1)
    const dec = (s: string): string => {
      try {
        return decodeURIComponent(s.replace(/\+/g, ' '))
      } catch {
        return s
      }
    }
    params.push({ id: uid(), key: dec(rawK), value: dec(rawV), enabled: true })
  }
  return { base, params }
}

const buildUrl = (base: string, params: KV[]): string => {
  const active = params.filter((p) => p.enabled && p.key.trim())
  if (!active.length) return base
  const qs = active
    .map((p) => `${encodeURIComponent(p.key)}=${encodeURIComponent(p.value)}`)
    .join('&')
  return `${base}?${qs}`
}

// ---- localStorage helpers ---------------------------------------------------

function loadLS<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key)
    return raw ? (JSON.parse(raw) as T) : fallback
  } catch {
    return fallback
  }
}
function saveLS(key: string, value: unknown): void {
  try {
    localStorage.setItem(key, JSON.stringify(value))
  } catch {
    /* quota / private mode — ignore */
  }
}

const methodClass = (m: string): string => `m-${m.toLowerCase()}`
const fmtSize = (bytes: number): string =>
  bytes < 1024 ? `${bytes} B` : `${(bytes / 1024).toFixed(bytes < 1024 * 10 ? 2 : 1)} KB`
const fmtTime = (ts: number): string => {
  const d = new Date(ts)
  return `${d.toLocaleDateString()} ${d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`
}

// =============================================================================
// Reusable key/value editor (module-level so it keeps focus across renders).
// Renders one phantom trailing row; typing into it appends a real row.
// =============================================================================

function KVEditor({
  rows,
  onChange,
  hasEnable = true,
  keyPlaceholder,
  valuePlaceholder
}: {
  rows: KV[]
  onChange: (rows: KV[]) => void
  hasEnable?: boolean
  keyPlaceholder?: string
  valuePlaceholder?: string
}): JSX.Element {
  const t = useT()
  const kp = keyPlaceholder ?? t('api.kvKey')
  const vp = valuePlaceholder ?? t('api.kvValue')
  const setCell = (i: number, patch: Partial<KV>): void => {
    if (i === rows.length) {
      onChange([...rows, { id: uid(), key: '', value: '', enabled: true, ...patch }])
    } else {
      onChange(rows.map((r, j) => (j === i ? { ...r, ...patch } : r)))
    }
  }
  const removeRow = (i: number): void => onChange(rows.filter((_, j) => j !== i))
  const display = [...rows, { id: '__phantom__', key: '', value: '', enabled: true }]

  return (
    <div className="apc-kv">
      {display.map((r, i) => {
        const phantom = i === rows.length
        const dis = hasEnable && !phantom && !r.enabled
        return (
          <div className="apc-kv-row" key={r.id}>
            {hasEnable && (
              <input
                type="checkbox"
                className="apc-kv-chk"
                checked={r.enabled}
                disabled={phantom}
                title={t('api.kvEnabled')}
                onChange={(e) => setCell(i, { enabled: e.target.checked })}
              />
            )}
            <input
              className={`apc-kv-in${dis ? ' disabled' : ''}`}
              placeholder={kp}
              value={r.key}
              spellCheck={false}
              onChange={(e) => setCell(i, { key: e.target.value })}
            />
            <input
              className={`apc-kv-in${dis ? ' disabled' : ''}`}
              placeholder={vp}
              value={r.value}
              spellCheck={false}
              onChange={(e) => setCell(i, { value: e.target.value })}
            />
            <button
              className="apc-kv-x"
              disabled={phantom}
              title={t('api.kvRemove')}
              onClick={() => removeRow(i)}
            >
              ×
            </button>
          </div>
        )
      })}
    </div>
  )
}

// =============================================================================

export default function ApiClientPanel(): JSX.Element {
  const t = useT()

  // ---- request state -------------------------------------------------------
  const [method, setMethod] = useState('GET')
  const [url, setUrl] = useState('')
  const [params, setParams] = useState<KV[]>([])
  const [headers, setHeaders] = useState<KV[]>([])
  const [bodyType, setBodyType] = useState<BodyType>('none')
  const [bodyJson, setBodyJson] = useState('')
  const [bodyRaw, setBodyRaw] = useState('')
  const [bodyForm, setBodyForm] = useState<KV[]>([])
  const [auth, setAuth] = useState<AuthState>(emptyAuth)
  const [reqTab, setReqTab] = useState<'params' | 'headers' | 'body' | 'auth'>('params')
  const [jsonMsg, setJsonMsg] = useState<{ ok: boolean; text: string } | null>(null)

  // ---- response state ------------------------------------------------------
  const [res, setRes] = useState<ApiResponse | null>(null)
  const [sending, setSending] = useState(false)
  const [resTab, setResTab] = useState<'body' | 'headers' | 'raw'>('body')
  const [prettyView, setPrettyView] = useState(true)
  const [copied, setCopied] = useState(false)

  // ---- persisted collections ----------------------------------------------
  const [history, setHistory] = useState<HistoryItem[]>(() => loadLS<HistoryItem[]>(LS_HISTORY, []))
  const [saved, setSaved] = useState<SavedRequest[]>(() => loadLS<SavedRequest[]>(LS_SAVED, []))
  const [envVars, setEnvVars] = useState<KV[]>(() => loadLS<KV[]>(LS_ENV, []))
  const [open, setOpen] = useState({ history: true, saved: true, env: false })

  useEffect(() => saveLS(LS_HISTORY, history), [history])
  useEffect(() => saveLS(LS_SAVED, saved), [saved])
  useEffect(() => saveLS(LS_ENV, envVars), [envVars])

  // ---- URL / params two-way sync -------------------------------------------
  const onUrlChange = (v: string): void => {
    setUrl(v)
    setParams(parseQuery(v).params)
  }
  const onParamsChange = (next: KV[]): void => {
    setParams(next)
    const base = url.indexOf('?') >= 0 ? url.slice(0, url.indexOf('?')) : url
    setUrl(buildUrl(base, next))
  }

  // ---- gather current request into a serializable snapshot -----------------
  const snapshot = useCallback(
    (): RequestState => ({
      method,
      url,
      params,
      headers,
      bodyType,
      bodyJson,
      bodyRaw,
      bodyForm,
      auth
    }),
    [method, url, params, headers, bodyType, bodyJson, bodyRaw, bodyForm, auth]
  )

  const loadRequest = (r: RequestState): void => {
    setMethod(r.method || 'GET')
    setUrl(r.url || '')
    setParams((r.params ?? []).map((p) => ({ ...p, id: uid() })))
    setHeaders((r.headers ?? []).map((h) => ({ ...h, id: uid() })))
    setBodyType(r.bodyType || 'none')
    setBodyJson(r.bodyJson || '')
    setBodyRaw(r.bodyRaw || '')
    setBodyForm((r.bodyForm ?? []).map((f) => ({ ...f, id: uid() })))
    setAuth({ ...emptyAuth(), ...(r.auth ?? {}) })
    setJsonMsg(null)
  }

  // ---- env variable substitution: {{name}} ---------------------------------
  const envMap = useMemo(() => {
    const m: Record<string, string> = {}
    for (const v of envVars) if (v.enabled && v.key.trim()) m[v.key.trim()] = v.value
    return m
  }, [envVars])

  const subst = useCallback(
    (s: string): string =>
      s.replace(/\{\{\s*([\w.-]+)\s*\}\}/g, (m, name) => (name in envMap ? envMap[name] : m)),
    [envMap]
  )

  // ---- build outgoing headers (rows + body content-type + auth) -------------
  const buildOutgoingHeaders = (): Record<string, string> => {
    const out: Record<string, string> = {}
    for (const h of headers) {
      if (h.enabled && h.key.trim()) out[h.key.trim()] = subst(h.value)
    }
    const hasCT = Object.keys(out).some((k) => k.toLowerCase() === 'content-type')
    if (!hasCT) {
      if (bodyType === 'json') out['Content-Type'] = 'application/json'
      else if (bodyType === 'form') out['Content-Type'] = 'application/x-www-form-urlencoded'
    }
    // auth merges last (wins over manual rows for the relevant header)
    if (auth.type === 'bearer' && auth.token.trim()) {
      out['Authorization'] = `Bearer ${subst(auth.token.trim())}`
    } else if (auth.type === 'basic' && (auth.user || auth.pass)) {
      try {
        out['Authorization'] = `Basic ${btoa(`${subst(auth.user)}:${subst(auth.pass)}`)}`
      } catch {
        /* non-latin credentials — skip encoding */
      }
    } else if (auth.type === 'apikey' && auth.apiKeyName.trim()) {
      out[auth.apiKeyName.trim()] = subst(auth.apiKeyValue)
    }
    return out
  }

  const buildBody = (): string | undefined => {
    if (method === 'GET' || method === 'HEAD') return undefined
    if (bodyType === 'json') return bodyJson ? subst(bodyJson) : undefined
    if (bodyType === 'raw') return bodyRaw ? subst(bodyRaw) : undefined
    if (bodyType === 'form') {
      const active = bodyForm.filter((f) => f.enabled && f.key.trim())
      if (!active.length) return undefined
      return active
        .map((f) => `${encodeURIComponent(f.key)}=${encodeURIComponent(subst(f.value))}`)
        .join('&')
    }
    return undefined
  }

  // ---- send ----------------------------------------------------------------
  const send = useCallback(async (): Promise<void> => {
    const finalUrl = subst(url.trim())
    if (!finalUrl) return
    setSending(true)
    setRes(null)
    setCopied(false)
    const snap = snapshot()
    const r: ApiResponse = await window.api.api.request({
      method,
      url: finalUrl,
      headers: buildOutgoingHeaders(),
      body: buildBody()
    })
    setRes(r)
    setResTab('body')
    setSending(false)
    setHistory((prev) => {
      const item: HistoryItem = {
        id: uid(),
        method,
        url: url.trim(),
        status: r.status,
        ok: r.ok && !r.error,
        timeMs: r.timeMs,
        ts: Date.now(),
        req: snap
      }
      return [item, ...prev].slice(0, HISTORY_MAX)
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [method, url, headers, bodyType, bodyJson, bodyRaw, bodyForm, auth, subst, snapshot])

  // Cmd/Ctrl+Enter sends from anywhere in the panel.
  const rootRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const el = rootRef.current
    if (!el) return
    const onKey = (e: KeyboardEvent): void => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
        e.preventDefault()
        void send()
      }
    }
    el.addEventListener('keydown', onKey)
    return () => el.removeEventListener('keydown', onKey)
  }, [send])

  // ---- JSON format / validate ----------------------------------------------
  const formatJson = (): void => {
    try {
      const parsed = JSON.parse(bodyJson)
      setBodyJson(JSON.stringify(parsed, null, 2))
      setJsonMsg({ ok: true, text: t('api.jsonValid', 'Valid JSON') })
    } catch (err) {
      setJsonMsg({ ok: false, text: (err as Error).message })
    }
  }

  // ---- save current request as a collection entry --------------------------
  const saveCurrent = (): void => {
    const name = window.prompt(t('api.saveName', 'Save request as:'), url.trim() || 'Request')
    if (!name) return
    setSaved((prev) => [{ id: uid(), name: name.trim(), req: snapshot() }, ...prev])
    setOpen((o) => ({ ...o, saved: true }))
  }

  // ---- response derived values ---------------------------------------------
  const pretty = useMemo(() => {
    if (!res?.body) return ''
    if (res.contentType.includes('json')) {
      try {
        return JSON.stringify(JSON.parse(res.body), null, 2)
      } catch {
        /* not valid json */
      }
    }
    return res.body
  }, [res])

  const bodySize = useMemo(() => {
    if (!res?.body) return 0
    try {
      return new TextEncoder().encode(res.body).length
    } catch {
      return res.body.length
    }
  }, [res])

  const statusClass = res
    ? res.error || res.status >= 400
      ? 'err'
      : res.status >= 300
        ? 'warn'
        : 'ok'
    : ''

  const copyBody = async (): Promise<void> => {
    if (!res) return
    try {
      await navigator.clipboard.writeText(prettyView ? pretty : res.body)
      setCopied(true)
      setTimeout(() => setCopied(false), 1200)
    } catch {
      /* clipboard blocked — ignore */
    }
  }

  const rawDump = useMemo(() => {
    if (!res) return ''
    if (res.error) return res.error
    const head = `${res.status} ${res.statusText}\n`
    const hs = Object.entries(res.headers)
      .map(([k, v]) => `${k}: ${v}`)
      .join('\n')
    return `${head}${hs}\n\n${res.body}`
  }, [res])

  const bodyCount =
    (bodyType !== 'none' &&
      (bodyType === 'json'
        ? bodyJson.length > 0
        : bodyType === 'raw'
          ? bodyRaw.length > 0
          : bodyForm.some((f) => f.key.trim()))) ||
    false

  const enabledHeaderCount = headers.filter((h) => h.enabled && h.key.trim()).length
  const enabledParamCount = params.filter((p) => p.enabled && p.key.trim()).length

  // ==========================================================================
  return (
    <div className="apc-root" ref={rootRef}>
      {/* ---------------- sidebar ---------------- */}
      <aside className="apc-side">
        <div className="apc-side-scroll">
          {/* History */}
          <div className="apc-section">
            <button
              className={`apc-section-head${open.history ? ' open' : ''}`}
              onClick={() => setOpen((o) => ({ ...o, history: !o.history }))}
            >
              <span className="apc-caret">▶</span>
              {t('api.history', 'History')}
              <span className="apc-section-count">{history.length}</span>
            </button>
            {open.history && (
              <div className="apc-section-body">
                {history.length === 0 ? (
                  <div className="apc-empty">{t('api.noHistory', 'No requests yet')}</div>
                ) : (
                  history.map((h) => (
                    <div
                      key={h.id}
                      className="apc-list-item"
                      title={h.url}
                      onClick={() => loadRequest(h.req)}
                    >
                      <div className="apc-list-main">
                        <div className="apc-list-top">
                          <span className={`apc-method-badge ${methodClass(h.method)}`}>
                            {h.method}
                          </span>
                          <span className="apc-list-url">{h.url}</span>
                        </div>
                        <div className="apc-list-sub">
                          <span
                            className={`apc-status-dot ${
                              h.ok ? 'ok' : h.status >= 300 && h.status < 400 ? 'warn' : 'err'
                            }`}
                          >
                            {h.status || '—'}
                          </span>
                          <span>{h.timeMs}ms</span>
                          <span>{fmtTime(h.ts)}</span>
                        </div>
                      </div>
                    </div>
                  ))
                )}
              </div>
            )}
            {history.length > 0 && (
              <div className="apc-side-actions">
                <button className="btn-small" onClick={() => setHistory([])}>
                  {t('api.clear', 'Clear')}
                </button>
              </div>
            )}
          </div>

          {/* Collections */}
          <div className="apc-section">
            <button
              className={`apc-section-head${open.saved ? ' open' : ''}`}
              onClick={() => setOpen((o) => ({ ...o, saved: !o.saved }))}
            >
              <span className="apc-caret">▶</span>
              {t('api.collections', 'Collections')}
              <span className="apc-section-count">{saved.length}</span>
            </button>
            {open.saved && (
              <div className="apc-section-body">
                {saved.length === 0 ? (
                  <div className="apc-empty">{t('api.noSaved', 'Nothing saved')}</div>
                ) : (
                  saved.map((s) => (
                    <div
                      key={s.id}
                      className="apc-list-item"
                      title={s.req.url}
                      onClick={() => loadRequest(s.req)}
                    >
                      <div className="apc-list-main">
                        <div className="apc-list-top">
                          <span className={`apc-method-badge ${methodClass(s.req.method)}`}>
                            {s.req.method}
                          </span>
                          <span className="apc-list-url">{s.name}</span>
                        </div>
                        <div className="apc-list-sub">
                          <span className="apc-list-url">{s.req.url}</span>
                        </div>
                      </div>
                      <button
                        className="apc-icon-btn"
                        title={t('api.delete', 'Delete')}
                        onClick={(e) => {
                          e.stopPropagation()
                          setSaved((prev) => prev.filter((x) => x.id !== s.id))
                        }}
                      >
                        ×
                      </button>
                    </div>
                  ))
                )}
              </div>
            )}
            <div className="apc-side-actions">
              <button className="btn-small primary" onClick={saveCurrent}>
                {t('api.saveCurrent', 'Save current')}
              </button>
            </div>
          </div>

          {/* Environment */}
          <div className="apc-section">
            <button
              className={`apc-section-head${open.env ? ' open' : ''}`}
              onClick={() => setOpen((o) => ({ ...o, env: !o.env }))}
            >
              <span className="apc-caret">▶</span>
              {t('api.env', 'Environment')}
              <span className="apc-section-count">{envVars.filter((v) => v.key.trim()).length}</span>
            </button>
            {open.env && (
              <div className="apc-section-body">
                <div className="apc-env-body">
                  <div className="apc-env-hint">
                    {t('api.envHint', 'Use {{name}} in URL, headers, or body.')}
                  </div>
                  <KVEditor rows={envVars} onChange={setEnvVars} hasEnable keyPlaceholder="name" />
                </div>
              </div>
            )}
          </div>
        </div>
      </aside>

      {/* ---------------- main ---------------- */}
      <div className="apc-main">
        <div className="apc-urlbar">
          <select
            className="ui-select apc-method-sel"
            value={method}
            onChange={(e) => setMethod(e.target.value)}
          >
            {METHODS.map((m) => (
              <option key={m} value={m}>
                {m}
              </option>
            ))}
          </select>
          <input
            className="ui-input apc-url"
            value={url}
            placeholder="https://api.example.com/path?query={{token}}"
            spellCheck={false}
            onChange={(e) => onUrlChange(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') void send()
            }}
          />
          <button
            className="btn-small primary apc-send"
            disabled={sending || !url.trim()}
            onClick={() => void send()}
          >
            {sending ? t('api.sending') : t('api.send')}
          </button>
        </div>

        {/* request builder tabs */}
        <div className="apc-reqtabs">
          <button
            className={`apc-tab${reqTab === 'params' ? ' active' : ''}`}
            onClick={() => setReqTab('params')}
          >
            {t('api.params', 'Params')}
            {enabledParamCount > 0 && <span className="apc-badge">{enabledParamCount}</span>}
          </button>
          <button
            className={`apc-tab${reqTab === 'headers' ? ' active' : ''}`}
            onClick={() => setReqTab('headers')}
          >
            {t('api.headers')}
            {enabledHeaderCount > 0 && <span className="apc-badge">{enabledHeaderCount}</span>}
          </button>
          <button
            className={`apc-tab${reqTab === 'body' ? ' active' : ''}`}
            onClick={() => setReqTab('body')}
          >
            {t('api.body')}
            {bodyCount && <span className="apc-dot" />}
          </button>
          <button
            className={`apc-tab${reqTab === 'auth' ? ' active' : ''}`}
            onClick={() => setReqTab('auth')}
          >
            {t('api.auth', 'Auth')}
            {auth.type !== 'none' && <span className="apc-dot" />}
          </button>
        </div>

        <div className="apc-reqpanel">
          {reqTab === 'params' && <KVEditor rows={params} onChange={onParamsChange} />}

          {reqTab === 'headers' && <KVEditor rows={headers} onChange={setHeaders} />}

          {reqTab === 'body' && (
            <div>
              <div className="apc-body-modes">
                {(['none', 'json', 'form', 'raw'] as BodyType[]).map((bt) => (
                  <label key={bt} className={`apc-radio${bodyType === bt ? ' on' : ''}`}>
                    <input
                      type="radio"
                      name="apc-bodytype"
                      checked={bodyType === bt}
                      onChange={() => setBodyType(bt)}
                    />
                    {bt === 'none'
                      ? t('api.bodyNone', 'none')
                      : bt === 'json'
                        ? 'JSON'
                        : bt === 'form'
                          ? 'form-urlencoded'
                          : t('api.bodyRaw', 'raw')}
                  </label>
                ))}
              </div>

              {bodyType === 'none' && (
                <div className="apc-hint">{t('api.bodyNoneHint', 'This request has no body.')}</div>
              )}

              {bodyType === 'json' && (
                <>
                  <div className="apc-row-actions">
                    <button className="btn-small apc-mini" onClick={formatJson}>
                      {t('api.formatJson', 'Format / validate')}
                    </button>
                    {jsonMsg && (
                      <span className={jsonMsg.ok ? 'apc-json-ok' : 'apc-json-err'}>
                        {jsonMsg.text}
                      </span>
                    )}
                  </div>
                  <textarea
                    className="apc-code-area"
                    value={bodyJson}
                    placeholder={'{\n  "key": "value"\n}'}
                    spellCheck={false}
                    onChange={(e) => {
                      setBodyJson(e.target.value)
                      if (jsonMsg) setJsonMsg(null)
                    }}
                  />
                </>
              )}

              {bodyType === 'form' && <KVEditor rows={bodyForm} onChange={setBodyForm} />}

              {bodyType === 'raw' && (
                <textarea
                  className="apc-code-area"
                  value={bodyRaw}
                  placeholder={t('api.rawPlaceholder', 'Raw request body…')}
                  spellCheck={false}
                  onChange={(e) => setBodyRaw(e.target.value)}
                />
              )}
            </div>
          )}

          {reqTab === 'auth' && (
            <div className="apc-auth-grid">
              <div className="apc-field">
                <span className="apc-flabel">{t('api.authType', 'Type')}</span>
                <select
                  className="ui-select"
                  value={auth.type}
                  onChange={(e) => setAuth((a) => ({ ...a, type: e.target.value as AuthType }))}
                >
                  <option value="none">{t('api.authNone', 'No Auth')}</option>
                  <option value="bearer">Bearer Token</option>
                  <option value="basic">Basic Auth</option>
                  <option value="apikey">API Key</option>
                </select>
              </div>

              {auth.type === 'bearer' && (
                <div className="apc-field">
                  <span className="apc-flabel">{t('api.token')}</span>
                  <input
                    className="ui-input"
                    value={auth.token}
                    placeholder="token"
                    spellCheck={false}
                    onChange={(e) => setAuth((a) => ({ ...a, token: e.target.value }))}
                  />
                </div>
              )}

              {auth.type === 'basic' && (
                <>
                  <div className="apc-field">
                    <span className="apc-flabel">{t('api.username', 'Username')}</span>
                    <input
                      className="ui-input"
                      value={auth.user}
                      spellCheck={false}
                      onChange={(e) => setAuth((a) => ({ ...a, user: e.target.value }))}
                    />
                  </div>
                  <div className="apc-field">
                    <span className="apc-flabel">{t('api.password', 'Password')}</span>
                    <input
                      className="ui-input"
                      type="password"
                      value={auth.pass}
                      onChange={(e) => setAuth((a) => ({ ...a, pass: e.target.value }))}
                    />
                  </div>
                </>
              )}

              {auth.type === 'apikey' && (
                <>
                  <div className="apc-field">
                    <span className="apc-flabel">{t('api.headerName', 'Header name')}</span>
                    <input
                      className="ui-input"
                      value={auth.apiKeyName}
                      placeholder="X-API-Key"
                      spellCheck={false}
                      onChange={(e) => setAuth((a) => ({ ...a, apiKeyName: e.target.value }))}
                    />
                  </div>
                  <div className="apc-field">
                    <span className="apc-flabel">{t('api.headerValue', 'Value')}</span>
                    <input
                      className="ui-input"
                      value={auth.apiKeyValue}
                      spellCheck={false}
                      onChange={(e) => setAuth((a) => ({ ...a, apiKeyValue: e.target.value }))}
                    />
                  </div>
                </>
              )}
            </div>
          )}
        </div>

        {/* response viewer */}
        <div className="apc-res">
          {!res ? (
            <div className="apc-res-empty">
              {sending
                ? t('api.sending')
                : t('api.responseHint', 'Send a request to see the response.')}
            </div>
          ) : (
            <>
              <div className="apc-res-head">
                <span className={`apc-status ${statusClass}`}>
                  {res.error ? t('api.failed') : `${res.status} ${res.statusText}`}
                </span>
                {!res.error && (
                  <>
                    <span className="apc-meta">
                      {t('api.time', 'Time')}: <b>{res.timeMs}ms</b>
                    </span>
                    <span className="apc-meta">
                      {t('api.size', 'Size')}: <b>{fmtSize(bodySize)}</b>
                    </span>
                  </>
                )}
                <div className="apc-res-tabs">
                  {resTab === 'body' && !res.error && (
                    <div className="apc-res-actions">
                      <button
                        className="apc-res-tab"
                        onClick={() => setPrettyView((p) => !p)}
                        title={t('api.togglePretty', 'Toggle pretty / raw')}
                      >
                        {prettyView ? t('api.pretty', 'Pretty') : t('api.raw', 'Raw')}
                      </button>
                      <button className="apc-res-tab" onClick={() => void copyBody()}>
                        {copied ? t('api.copied', 'Copied') : t('api.copy', 'Copy')}
                      </button>
                    </div>
                  )}
                  <button
                    className={`apc-res-tab${resTab === 'body' ? ' active' : ''}`}
                    onClick={() => setResTab('body')}
                  >
                    {t('api.body')}
                  </button>
                  <button
                    className={`apc-res-tab${resTab === 'headers' ? ' active' : ''}`}
                    onClick={() => setResTab('headers')}
                  >
                    {t('api.headers')} ({Object.keys(res.headers).length})
                  </button>
                  <button
                    className={`apc-res-tab${resTab === 'raw' ? ' active' : ''}`}
                    onClick={() => setResTab('raw')}
                  >
                    {t('api.raw', 'Raw')}
                  </button>
                </div>
              </div>

              {res.error ? (
                <pre className="apc-res-body">
                  <span className="tok-c">{res.error}</span>
                </pre>
              ) : resTab === 'headers' ? (
                <div className="apc-hdr-list">
                  {Object.entries(res.headers).map(([k, v]) => (
                    <div className="apc-hdr-row" key={k}>
                      <span className="apc-hdr-k">{k}:</span>
                      <span className="apc-hdr-v">{v}</span>
                    </div>
                  ))}
                </div>
              ) : resTab === 'raw' ? (
                <pre className="apc-res-body">{rawDump}</pre>
              ) : (
                <pre className="apc-res-body">
                  {prettyView ? <code>{highlightCode(pretty)}</code> : res.body}
                </pre>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  )
}
