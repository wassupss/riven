import { createPortal } from 'react-dom'
import { useUI } from '../state/ui'
import { useSettings, type Settings } from '../state/settings'
import { THEMES, applyTheme } from '../state/themes'
import { CURATED_FONTS, injectFont } from '../state/fonts'
import { AI_PROVIDERS, getProvider } from '../state/aiProviders'
import KeybindingsSettings from '../keybindings/KeybindingsSettings'
import AccountSettings from './AccountSettings'
import { useT } from '../i18n'

function FontField({ value, onChange }: { value: string; onChange: (v: string) => void }): JSX.Element {
  const t = useT()
  const imported = useSettings((s) => s.settings.importedFonts)
  const set = useSettings((s) => s.set)
  const options = [...CURATED_FONTS, ...imported.map((f) => f.family)]
  const current = options.find((o) => value.includes(o))

  const doImport = async (): Promise<void> => {
    const r = await window.api.workspace.importFont()
    if (!r) return
    injectFont(r.family, r.dataUrl)
    set({ importedFonts: [...imported.filter((f) => f.family !== r.family), r] })
    onChange(`"${r.family}", monospace`)
  }

  return (
    <div className="font-field">
      <select
        className="set-select"
        value={current ?? '__custom'}
        onChange={(e) => {
          if (e.target.value !== '__custom') onChange(`"${e.target.value}", monospace`)
        }}
      >
        {options.map((o) => (
          <option key={o} value={o}>
            {o}
          </option>
        ))}
        <option value="__custom">{t('settings.customFont')}</option>
      </select>
      <button className="btn-small" onClick={doImport} title={t('settings.importFontTitle')}>
        {t('settings.import')}
      </button>
      {!current && (
        <input className="url-input" value={value} onChange={(e) => onChange(e.target.value)} />
      )}
    </div>
  )
}

export default function SettingsModal(): JSX.Element | null {
  const t = useT()
  const open = useUI((s) => s.settingsOpen)
  const setOpen = useUI((s) => s.setSettingsOpen)
  const tab = useUI((s) => s.settingsTab)
  const setTab = (t: 'general' | 'ai' | 'keys' | 'account'): void => useUI.setState({ settingsTab: t })
  const settings = useSettings((s) => s.settings)
  const set = useSettings((s) => s.set)
  const reset = useSettings((s) => s.reset)
  const upd = <K extends keyof Settings>(k: K, v: Settings[K]): void => set({ [k]: v } as Partial<Settings>)

  if (!open) return null

  return createPortal(
    <div className="modal-overlay" onClick={() => setOpen(false)}>
      <div className="modal settings-modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <span>{t('settings.title')}</span>
          <button className="btn-small" onClick={() => setOpen(false)}>
            {t('common.close')}
          </button>
        </div>
        <div className="kb-tabs">
          <button className={`kb-tab${tab === 'general' ? ' active' : ''}`} onClick={() => setTab('general')}>
            {t('settings.tab.general')}
          </button>
          <button className={`kb-tab${tab === 'ai' ? ' active' : ''}`} onClick={() => setTab('ai')}>
            AI
          </button>
          <button className={`kb-tab${tab === 'keys' ? ' active' : ''}`} onClick={() => setTab('keys')}>
            {t('settings.tab.keys')}
          </button>
          <button
            className={`kb-tab${tab === 'account' ? ' active' : ''}`}
            onClick={() => setTab('account')}
          >
            {t('settings.tab.account')}
          </button>
        </div>

        <div className="modal-body settings-body">
          {tab === 'general' && (
            <>
              <div className="section-label">언어 / Language</div>
              <div className="set-row">
                <span className="set-label">{t('settings.language')}</span>
                <select
                  className="set-select"
                  value={settings.language}
                  onChange={(e) => upd('language', e.target.value as 'ko' | 'en')}
                >
                  <option value="ko">한국어</option>
                  <option value="en">English</option>
                </select>
              </div>

              <div className="section-label">{t('settings.theme')}</div>
              <div className="theme-swatches">
                {THEMES.map((t) => (
                  <button
                    key={t.id}
                    className={`theme-swatch${settings.theme === t.id ? ' active' : ''}`}
                    title={t.name}
                    onClick={() => {
                      set({ theme: t.id })
                      applyTheme(t.id)
                    }}
                  >
                    <span className="theme-dot" style={{ background: t.swatch }} />
                    {t.name}
                  </button>
                ))}
              </div>

              <div className="section-label">{t('settings.editor')}</div>
              <div className="set-row">
                <span className="set-label">{t('settings.font')}</span>
                <FontField value={settings.editorFontFamily} onChange={(v) => upd('editorFontFamily', v)} />
              </div>
              <div className="set-row">
                <span className="set-label">{t('settings.size')}</span>
                <input
                  className="url-input set-num"
                  type="number"
                  min={8}
                  max={32}
                  value={settings.editorFontSize}
                  onChange={(e) => upd('editorFontSize', Number(e.target.value))}
                />
              </div>
              <label className="set-row set-toggle">
                <input
                  type="checkbox"
                  checked={settings.formatOnSave}
                  onChange={(e) => upd('formatOnSave', e.target.checked)}
                />
                <span className="set-label">{t('settings.formatOnSave')}</span>
              </label>

              <div className="section-label">{t('settings.terminal')}</div>
              <div className="set-row">
                <span className="set-label">{t('settings.font')}</span>
                <FontField
                  value={settings.terminalFontFamily}
                  onChange={(v) => upd('terminalFontFamily', v)}
                />
              </div>
              <div className="set-row">
                <span className="set-label">{t('settings.size')}</span>
                <input
                  className="url-input set-num"
                  type="number"
                  min={8}
                  max={32}
                  value={settings.terminalFontSize}
                  onChange={(e) => upd('terminalFontSize', Number(e.target.value))}
                />
              </div>

              <div className="set-actions">
                <button className="btn-small" onClick={reset}>
                  {t('settings.resetDefaults')}
                </button>
              </div>
            </>
          )}

          {tab === 'ai' && (
            <>
              <div className="section-label">{t('settings.ai.inlineSection')}</div>
              <label className="set-row set-toggle">
                <input
                  type="checkbox"
                  checked={settings.aiComplete}
                  onChange={(e) => upd('aiComplete', e.target.checked)}
                />
                <span className="set-label">{t('settings.ai.enable')}</span>
              </label>
              <div className="set-note">{t('settings.ai.note1')}</div>
              {(() => {
                const provider = getProvider(settings.aiProvider)
                const modelInList = provider.models.includes(settings.aiCompleteModel)
                return (
                  <>
                    <div className="set-row">
                      <span className="set-label">{t('settings.ai.provider')}</span>
                      <select
                        className="set-select"
                        disabled={!settings.aiComplete}
                        value={settings.aiProvider}
                        onChange={(e) => {
                          const p = getProvider(e.target.value)
                          // Selecting a provider auto-fills its endpoint + default model.
                          set({
                            aiProvider: p.id,
                            aiCompleteEndpoint: p.endpoint,
                            aiCompleteModel: p.models[0] ?? settings.aiCompleteModel
                          })
                        }}
                      >
                        {AI_PROVIDERS.map((p) => (
                          <option key={p.id} value={p.id}>
                            {p.label}
                          </option>
                        ))}
                      </select>
                    </div>
                    <div className="set-row">
                      <span className="set-label">{t('settings.ai.model')}</span>
                      {provider.models.length > 0 ? (
                        <select
                          className="set-select"
                          disabled={!settings.aiComplete}
                          value={modelInList ? settings.aiCompleteModel : '__custom'}
                          onChange={(e) => {
                            if (e.target.value !== '__custom') upd('aiCompleteModel', e.target.value)
                          }}
                        >
                          {provider.models.map((m) => (
                            <option key={m} value={m}>
                              {m}
                            </option>
                          ))}
                          <option value="__custom">{t('settings.ai.customModel')}</option>
                        </select>
                      ) : null}
                      {(!modelInList || provider.models.length === 0) && (
                        <input
                          className="url-input"
                          disabled={!settings.aiComplete}
                          value={settings.aiCompleteModel}
                          placeholder="model"
                          onChange={(e) => upd('aiCompleteModel', e.target.value)}
                        />
                      )}
                    </div>
                    <div className="set-row">
                      <span className="set-label">{t('settings.ai.endpoint')}</span>
                      <input
                        className="url-input"
                        disabled={!settings.aiComplete}
                        value={settings.aiCompleteEndpoint}
                        onChange={(e) => upd('aiCompleteEndpoint', e.target.value)}
                      />
                    </div>
                    {!provider.keyless && (
                      <div className="set-row">
                        <span className="set-label">{t('settings.ai.apiKey')}</span>
                        <input
                          className="url-input"
                          type="password"
                          disabled={!settings.aiComplete}
                          value={settings.aiApiKey}
                          placeholder="sk-… / api key"
                          onChange={(e) => upd('aiApiKey', e.target.value)}
                        />
                      </div>
                    )}
                    <div className="set-note">
                      {provider.keyless
                        ? t('settings.ai.ollamaHint')
                        : t('settings.ai.apiHint')}
                    </div>
                  </>
                )
              })()}
            </>
          )}

          {tab === 'account' && <AccountSettings />}

          {tab === 'keys' && <KeybindingsSettings />}
        </div>
      </div>
    </div>,
    document.body
  )
}
