import { useEffect, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { addTerminal } from '../dock/registry'
import { useUI } from '../state/ui'
import { useSettings, getSettings, type Settings } from '../state/settings'
import { THEMES, applyTheme } from '../state/themes'
import { CURATED_FONTS, injectFont } from '../state/fonts'
import { AI_PROVIDERS, getProvider } from '../state/aiProviders'
import { MCP_TOOL_LABELS } from '../state/mcpTools'
import { Button, NumberInput, Segmented, Select, Switch, TextArea, TextInput } from './ui/Controls'
import KeybindingsSettings from '../keybindings/KeybindingsSettings'
import AccountSettings from './AccountSettings'
import AboutTab from './AboutTab'
import { useT } from '../i18n'
import { SlidersHorizontal, Bot, Keyboard, User, Info, X, Trash2, Plus } from 'lucide-react'

// A monospace-font picker (curated list + import) sharing the standard controls.
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
    <div className="ui-fontfield">
      <Select
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
      </Select>
      <Button onClick={doImport} title={t('settings.importFontTitle')}>
        {t('settings.import')}
      </Button>
      {!current && <TextInput value={value} onChange={(e) => onChange(e.target.value)} />}
    </div>
  )
}

// Native settings row: a title + description on the left, control on the right.
function Row({ title, desc, children }: { title: string; desc?: string; children: ReactNode }): JSX.Element {
  return (
    <div className="set-row">
      <div className="set-rowinfo">
        <span className="set-rowtitle">{title}</span>
        {desc && <span className="set-rowdesc">{desc}</span>}
      </div>
      <div className="set-rowctl">{children}</div>
    </div>
  )
}

// A row whose control is a toggle switch.
function ToggleRow({
  title,
  desc,
  checked,
  onChange,
  disabled
}: {
  title: string
  desc?: string
  checked: boolean
  onChange: (v: boolean) => void
  disabled?: boolean
}): JSX.Element {
  return (
    <Row title={title} desc={desc}>
      <Switch checked={checked} onChange={onChange} disabled={disabled} />
    </Row>
  )
}

// The AI CLIs riven found on your PATH (native Settings › AI cliSection). Each row
// shows a version chip and an "update" button that runs `<cmd> update` in a fresh
// terminal, matching native runInTerminal.
function DetectedClis(): JSX.Element {
  const t = useT()
  const [clis, setClis] = useState<
    Array<{ name: string; cmd: string; path: string; version: string | null }> | null
  >(null)
  useEffect(() => {
    let alive = true
    window.api.chat.detectClis().then((r) => alive && setClis(r))
    return () => {
      alive = false
    }
  }, [])

  if (clis === null) return <div className="set-note">{t('settings.cliDetecting')}</div>
  if (clis.length === 0) return <div className="set-note">{t('settings.cliNone')}</div>
  return (
    <>
      {clis.map((c) => (
        <Row key={c.cmd} title={c.name} desc={c.path}>
          <span className="cli-chip ok">{c.version ? `v${c.version}` : t('settings.cliFound')}</span>
          <Button
            title={t('settings.cliUpdateDesc')}
            onClick={() => {
              addTerminal(`${c.cmd} update`)
              useUI.getState().setSettingsOpen(false)
            }}
          >
            {t('settings.cliUpdate')}
          </Button>
        </Row>
      ))}
      <div className="set-note">{t('settings.cliUpdateDesc')}</div>
    </>
  )
}

export default function SettingsModal(): JSX.Element | null {
  const t = useT()
  const open = useUI((s) => s.settingsOpen)
  const setOpen = useUI((s) => s.setSettingsOpen)
  const tab = useUI((s) => s.settingsTab)
  const setTab = (id: 'general' | 'ai' | 'keys' | 'account' | 'about'): void =>
    useUI.setState({ settingsTab: id })
  const settings = useSettings((s) => s.settings)
  const set = useSettings((s) => s.set)
  const reset = useSettings((s) => s.reset)
  const upd = <K extends keyof Settings>(k: K, v: Settings[K]): void =>
    set({ [k]: v } as Partial<Settings>)

  if (!open) return null

  const NAV: Array<{ id: typeof tab; label: string; icon: JSX.Element }> = [
    { id: 'general', label: t('settings.tab.general'), icon: <SlidersHorizontal size={15} /> },
    { id: 'ai', label: 'AI', icon: <Bot size={15} /> },
    { id: 'keys', label: t('settings.tab.keys'), icon: <Keyboard size={15} /> },
    { id: 'account', label: t('settings.tab.account'), icon: <User size={15} /> },
    { id: 'about', label: t('settings.tab.about'), icon: <Info size={15} /> }
  ]
  const sectionTitle = NAV.find((n) => n.id === tab)?.label ?? ''

  const provider = getProvider(settings.aiProvider)
  const modelInList = provider.models.includes(settings.aiCompleteModel)

  return createPortal(
    <div className="modal-overlay" onClick={() => setOpen(false)}>
      <div className="modal settings-modal native" onClick={(e) => e.stopPropagation()}>
        <nav className="settings-nav">
          <div className="settings-nav-title">{t('settings.title')}</div>
          {NAV.map((n) => (
            <button
              key={n.id}
              className={`settings-nav-item${tab === n.id ? ' active' : ''}`}
              onClick={() => setTab(n.id)}
            >
              <span className="settings-nav-icon">{n.icon}</span>
              {n.label}
            </button>
          ))}
        </nav>
        <div className="settings-main">
          <div className="settings-main-head">
            <span>{sectionTitle}</span>
            <button className="settings-close" title={t('common.close')} onClick={() => setOpen(false)}>
              <X size={16} />
            </button>
          </div>
          <div className="modal-body settings-body">
            {tab === 'general' && (
              <>
                <div className="section-label">{t('settings.appearance')}</div>
                <Row title={t('settings.language')} desc={t('settings.languageDesc')}>
                  <Segmented
                    value={settings.language}
                    onChange={(v) => upd('language', v)}
                    options={[
                      { value: 'ko', label: '한국어' },
                      { value: 'en', label: 'English' }
                    ]}
                  />
                </Row>
                <Row title={t('settings.uiScale')} desc={t('settings.uiScaleDesc')}>
                  <div className="ui-seg">
                    <button
                      className="ui-seg-btn"
                      onClick={() => {
                        const v = Math.max(0.7, Math.round((settings.uiScale - 0.1) * 10) / 10)
                        upd('uiScale', v)
                        window.api.setZoom(v)
                      }}
                    >
                      −
                    </button>
                    <button
                      className="ui-seg-btn"
                      onClick={() => {
                        upd('uiScale', 1)
                        window.api.setZoom(1)
                      }}
                    >
                      {Math.round(settings.uiScale * 100)}%
                    </button>
                    <button
                      className="ui-seg-btn"
                      onClick={() => {
                        const v = Math.min(1.6, Math.round((settings.uiScale + 0.1) * 10) / 10)
                        upd('uiScale', v)
                        window.api.setZoom(v)
                      }}
                    >
                      +
                    </button>
                  </div>
                </Row>

                <div className="section-label">{t('settings.theme')}</div>
                <div className="theme-swatches">
                  {THEMES.map((th) => (
                    <button
                      key={th.id}
                      className={`theme-swatch${settings.theme === th.id ? ' active' : ''}`}
                      title={th.name}
                      onClick={() => {
                        set({ theme: th.id })
                        applyTheme(th.id)
                      }}
                    >
                      <span className="theme-dot" style={{ background: th.swatch }} />
                      {th.name}
                    </button>
                  ))}
                </div>

                <div className="section-label">{t('settings.editor')}</div>
                <Row title={t('settings.fontFamily')} desc={t('settings.fontFamilyDesc')}>
                  <FontField value={settings.editorFontFamily} onChange={(v) => upd('editorFontFamily', v)} />
                </Row>
                <Row title={t('settings.fontSize')}>
                  <NumberInput
                    min={8}
                    max={32}
                    value={settings.editorFontSize}
                    onChange={(e) => upd('editorFontSize', Number(e.target.value))}
                  />
                </Row>
                <Row title={t('settings.tabSize')} desc={t('settings.tabSizeDesc')}>
                  <NumberInput
                    min={1}
                    max={8}
                    value={settings.editorTabSize}
                    onChange={(e) => upd('editorTabSize', Math.max(1, Math.min(8, Number(e.target.value))))}
                  />
                </Row>
                <ToggleRow
                  title={t('settings.wordWrap')}
                  desc={t('settings.wordWrapDesc')}
                  checked={settings.editorWordWrap}
                  onChange={(v) => upd('editorWordWrap', v)}
                />
                <ToggleRow
                  title={t('settings.minimap')}
                  desc={t('settings.minimapDesc')}
                  checked={settings.editorMinimap}
                  onChange={(v) => upd('editorMinimap', v)}
                />
                <ToggleRow
                  title={t('settings.ligatures')}
                  desc={t('settings.ligaturesDesc')}
                  checked={settings.editorLigatures}
                  onChange={(v) => upd('editorLigatures', v)}
                />
                <ToggleRow
                  title={t('settings.formatOnSave')}
                  desc={t('settings.formatOnSaveDesc')}
                  checked={settings.formatOnSave}
                  onChange={(v) => upd('formatOnSave', v)}
                />

                <div className="section-label">{t('settings.terminal')}</div>
                <Row title={t('settings.fontFamily')}>
                  <FontField
                    value={settings.terminalFontFamily}
                    onChange={(v) => upd('terminalFontFamily', v)}
                  />
                </Row>
                <Row title={t('settings.fontSize')}>
                  <NumberInput
                    min={8}
                    max={32}
                    value={settings.terminalFontSize}
                    onChange={(e) => upd('terminalFontSize', Number(e.target.value))}
                  />
                </Row>
                <Row title={t('settings.termColors')}>
                  <label className="ui-colorwell" title={t('settings.termBg')}>
                    <input
                      type="color"
                      value={settings.terminalBackground}
                      onChange={(e) => upd('terminalBackground', e.target.value)}
                    />
                  </label>
                  <label className="ui-colorwell" title={t('settings.termFg')}>
                    <input
                      type="color"
                      value={settings.terminalForeground}
                      onChange={(e) => upd('terminalForeground', e.target.value)}
                    />
                  </label>
                  <label className="ui-colorwell" title={t('settings.termCursor')}>
                    <input
                      type="color"
                      value={settings.terminalCursor}
                      onChange={(e) => upd('terminalCursor', e.target.value)}
                    />
                  </label>
                </Row>

                <div className="section-label">{t('settings.usageSection')}</div>
                <ToggleRow
                  title={t('settings.usageMode')}
                  desc={t('settings.usageModeDesc')}
                  checked={settings.usageShowUsed}
                  onChange={(v) => upd('usageShowUsed', v)}
                />

                <div className="section-label">{t('settings.browserSection')}</div>
                <Row title={t('settings.searchEngine')} desc={t('settings.searchEngineDesc')}>
                  <TextInput
                    className="set-grow"
                    value={settings.browserSearch}
                    onChange={(e) => upd('browserSearch', e.target.value)}
                  />
                </Row>

                <div className="section-label">{t('settings.notifySection')}</div>
                <ToggleRow
                  title={t('settings.notifications')}
                  desc={t('settings.notifyDesc')}
                  checked={settings.notifications}
                  onChange={(v) => upd('notifications', v)}
                />
                <ToggleRow
                  title={t('settings.crashReporting')}
                  desc={t('settings.crashDesc')}
                  checked={settings.crashReporting}
                  onChange={(v) => upd('crashReporting', v)}
                />

                <div className="section-label">{t('settings.advanced')}</div>
                <Row title={t('settings.configFile')} desc={t('settings.configFileDesc')}>
                  <Button onClick={() => window.api.config.reveal('settings.json')}>
                    {t('settings.openFile')}
                  </Button>
                </Row>
                <Row title={t('settings.resetAll')} desc={t('settings.resetAllDesc')}>
                  <Button
                    onClick={() => {
                      if (window.confirm(t('settings.resetConfirm'))) {
                        reset()
                        applyTheme(getSettings().theme)
                      }
                    }}
                  >
                    {t('settings.resetAll')}
                  </Button>
                </Row>
              </>
            )}

            {tab === 'ai' && (
              <>
                <div className="section-label">{t('settings.ai.agentSection')}</div>
                <ToggleRow
                  title={t('settings.agentChatUI')}
                  desc={t('settings.agentChatUIDesc')}
                  checked={settings.agentChatUI}
                  onChange={(v) => upd('agentChatUI', v)}
                />
                <ToggleRow
                  title={t('settings.chatSuggest')}
                  desc={t('settings.chatSuggestDesc')}
                  checked={settings.chatSuggest}
                  onChange={(v) => upd('chatSuggest', v)}
                />

                <div className="section-label">{t('settings.cliSection')}</div>
                <DetectedClis />

                <div className="section-label">{t('settings.agentDefaults')}</div>
                <Row title={t('settings.ai.defaultModel')} desc={t('settings.defaultModelDesc')}>
                  <Select
                    value={settings.defaultChatModel}
                    onChange={(e) => upd('defaultChatModel', e.target.value)}
                  >
                    <option value="default">default</option>
                    <option value="opus">opus</option>
                    <option value="sonnet">sonnet</option>
                    <option value="haiku">haiku</option>
                  </Select>
                </Row>
                <Row title={t('settings.ai.defaultMode')} desc={t('settings.defaultPermModeDesc')}>
                  <Select
                    value={settings.defaultPermissionMode}
                    onChange={(e) => upd('defaultPermissionMode', e.target.value)}
                  >
                    <option value="plan">{t('chat.mode.plan')}</option>
                    <option value="acceptEdits">{t('chat.mode.acceptEdits')}</option>
                    <option value="default">{t('chat.mode.ask')}</option>
                  </Select>
                </Row>

                <div className="section-label">{t('settings.promptSection')}</div>
                <div className="set-note">{t('settings.ai.globalPromptNote')}</div>
                <TextArea
                  rows={4}
                  value={settings.globalPrompt}
                  placeholder={t('settings.ai.globalPromptPlaceholder')}
                  onChange={(e) => upd('globalPrompt', e.target.value)}
                />

                <div className="section-label">{t('settings.snippets')}</div>
                <div className="set-note">{t('settings.snippetsHint')}</div>
                {settings.snippets.map((s, i) => (
                  <div className="snippet-row" key={i}>
                    <TextInput
                      className="snippet-prefix"
                      value={s.prefix}
                      placeholder={t('settings.snippetPrefix')}
                      onChange={(e) => {
                        const next = settings.snippets.map((x, j) =>
                          j === i ? { ...x, prefix: e.target.value } : x
                        )
                        upd('snippets', next)
                      }}
                    />
                    <TextArea
                      className="snippet-body"
                      rows={2}
                      value={s.body}
                      placeholder={t('settings.snippetBody')}
                      onChange={(e) => {
                        const next = settings.snippets.map((x, j) =>
                          j === i ? { ...x, body: e.target.value } : x
                        )
                        upd('snippets', next)
                      }}
                    />
                    <Button
                      variant="ghost"
                      title={t('common.close')}
                      onClick={() => upd('snippets', settings.snippets.filter((_, j) => j !== i))}
                    >
                      <Trash2 size={14} />
                    </Button>
                  </div>
                ))}
                <Button
                  onClick={() => upd('snippets', [...settings.snippets, { prefix: '', body: '' }])}
                >
                  <Plus size={13} /> {t('settings.addSnippet')}
                </Button>

                <div className="section-label">{t('settings.ai.mcpSection')}</div>
                <div className="set-note">{t('settings.ai.mcpNote')}</div>
                {MCP_TOOL_LABELS.map((tool) => (
                  <ToggleRow
                    key={tool.name}
                    title={settings.language === 'ko' ? tool.ko : tool.en}
                    desc={tool.name}
                    checked={!settings.mcpDisabledTools.includes(tool.name)}
                    onChange={(on) => {
                      const off = new Set(settings.mcpDisabledTools)
                      if (on) off.delete(tool.name)
                      else off.add(tool.name)
                      upd('mcpDisabledTools', [...off])
                    }}
                  />
                ))}

                <div className="section-label">{t('settings.ai.inlineSection')}</div>
                <ToggleRow
                  title={t('settings.ai.enable')}
                  desc={t('settings.ai.note1')}
                  checked={settings.aiComplete}
                  onChange={(v) => upd('aiComplete', v)}
                />
                <Row title={t('settings.ai.provider')}>
                  <Select
                    disabled={!settings.aiComplete}
                    value={settings.aiProvider}
                    onChange={(e) => {
                      const p = getProvider(e.target.value)
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
                  </Select>
                </Row>
                <Row title={t('settings.ai.model')}>
                  {provider.models.length > 0 ? (
                    <Select
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
                    </Select>
                  ) : null}
                  {(!modelInList || provider.models.length === 0) && (
                    <TextInput
                      disabled={!settings.aiComplete}
                      value={settings.aiCompleteModel}
                      placeholder="model"
                      onChange={(e) => upd('aiCompleteModel', e.target.value)}
                    />
                  )}
                </Row>
                <Row title={t('settings.ai.endpoint')}>
                  <TextInput
                    className="set-grow"
                    disabled={!settings.aiComplete}
                    value={settings.aiCompleteEndpoint}
                    onChange={(e) => upd('aiCompleteEndpoint', e.target.value)}
                  />
                </Row>
                {!provider.keyless && (
                  <Row title={t('settings.ai.apiKey')}>
                    <TextInput
                      className="set-grow"
                      type="password"
                      disabled={!settings.aiComplete}
                      value={settings.aiApiKey}
                      placeholder="sk-… / api key"
                      onChange={(e) => upd('aiApiKey', e.target.value)}
                    />
                  </Row>
                )}
                <div className="set-note">
                  {provider.keyless ? t('settings.ai.ollamaHint') : t('settings.ai.apiHint')}
                </div>
              </>
            )}

            {tab === 'account' && <AccountSettings />}
            {tab === 'keys' && <KeybindingsSettings />}
            {tab === 'about' && <AboutTab />}
          </div>
        </div>
      </div>
    </div>,
    document.body
  )
}
