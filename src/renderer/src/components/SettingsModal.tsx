import type { CliUpdateState } from '../../../preload/index'
import { Loader2 } from 'lucide-react'
import { useEffect, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { addTerminal } from '../dock/registry'
import { useUI, type SettingsTab } from '../state/ui'
import { useSettings, getSettings, claudeConfigDirFor, type Settings } from '../state/settings'
import { THEMES, applyTheme } from '../state/themes'
import { CURATED_FONTS, injectFont } from '../state/fonts'
import { MCP_TOOL_LABELS } from '../state/mcpTools'
import { Button, NumberInput, Segmented, Select, Switch, TextArea, TextInput } from './ui/Controls'
import KeybindingsSettings from '../keybindings/KeybindingsSettings'
import AccountSettings from './AccountSettings'
import AboutTab from './AboutTab'
import OsPermissions from './OsPermissions'
import ModelOptions from './ModelOptions'
import { useT } from '../i18n'
import { BUILTIN_TOOLS } from '../lib/tools'
import {
  SlidersHorizontal,
  Bot,
  Keyboard,
  User,
  Info,
  FileCode,
  TerminalSquare,
  Bell,
  ShieldCheck,
  Egg,
  X,
  Trash2,
  Plus
} from 'lucide-react'

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
  // Bumped after an update runs, to re-read the versions.
  const [rev, setRev] = useState(0)
  const [restart, setRestart] = useState<{ restarted: number; busy: number } | null>(null)
  // Updates run in main (see agentChat runCliUpdate), so their state outlives
  // this window: closing settings mid-update and coming back shows it still
  // going, or how it ended.
  const [updates, setUpdates] = useState<Record<string, CliUpdateState>>({})
  useEffect(() => {
    let alive = true
    window.api.chat.detectClis().then((r) => alive && setClis(r))
    return () => {
      alive = false
    }
  }, [rev])
  useEffect(() => {
    void window.api.cli.updateStatus().then((list) => {
      setUpdates(Object.fromEntries(list.map((u) => [u.cmd, u])))
    })
    return window.api.cli.onUpdate((u) => {
      setUpdates((cur) => ({ ...cur, [u.cmd]: u }))
      if (u.status !== 'running') setRev((n) => n + 1)
    })
  }, [])

  if (clis === null) return <div className="set-note">{t('settings.cliDetecting')}</div>
  if (clis.length === 0) return <div className="set-note">{t('settings.cliNone')}</div>
  return (
    <>
      {clis.map((c) => {
        const u = updates[c.cmd]
        const running = u?.status === 'running'
        return (
          <div key={c.cmd}>
            <Row title={c.name} desc={c.path}>
              <span className="cli-chip ok">{c.version ? `v${c.version}` : t('settings.cliFound')}</span>
              <Button
                title={t('settings.cliUpdateDesc')}
                disabled={running}
                onClick={() => void window.api.cli.update(c.cmd as 'claude' | 'codex')}
              >
                {running ? (
                  <>
                    <Loader2 size={12} className="spin" /> {t('settings.cliUpdating')}
                  </>
                ) : (
                  t('settings.cliUpdate')
                )}
              </Button>
            </Row>
            {u && u.status !== 'running' && (
              <div className={u.status === 'failed' ? 'set-note mcp-error' : 'set-note'}>
                {u.status === 'failed'
                  ? t('settings.cliUpdateFailed', { why: u.output.split('\n').slice(-3).join(' ') })
                  : u.from && u.to && u.from !== u.to
                    ? t('settings.cliUpdated', { from: u.from, to: u.to })
                    : t('settings.cliUpToDate', { v: u.to ?? '' })}
                {u.status === 'done' && (u.restarted > 0 || u.deferred > 0)
                  ? ' · ' +
                    t('settings.cliRestarted', { n: String(u.restarted) }) +
                    (u.deferred > 0 ? ' · ' + t('settings.cliRestartBusy', { n: String(u.deferred) }) : '')
                  : ''}
              </div>
            )}
          </div>
        )
      })}
      {/* After an update the panes on that CLI are restarted automatically. This
          is for the other cases — a CLI updated outside riven, say. It replaces
          each pane's process and resumes the same conversation, in place. */}
      <Row title={t('settings.cliRestart')} desc={t('settings.cliRestartDesc')}>
        <Button
          onClick={() => {
            setRev((n) => n + 1)
            void window.api.chat.restart().then(setRestart)
          }}
        >
          {t('settings.cliRestart')}
        </Button>
      </Row>
      {restart && (
        <div className="set-note">
          {t('settings.cliRestarted', { n: String(restart.restarted) })}
          {restart.busy > 0 ? ' · ' + t('settings.cliRestartBusy', { n: String(restart.busy) }) : ''}
        </div>
      )}
      <div className="set-note">{t('settings.cliUpdateDesc')}</div>
    </>
  )
}

export default function SettingsModal(): JSX.Element | null {
  const t = useT()
  const open = useUI((s) => s.settingsOpen)
  const setOpen = useUI((s) => s.setSettingsOpen)
  const tab = useUI((s) => s.settingsTab)
  const setTab = (id: SettingsTab): void => useUI.setState({ settingsTab: id })
  const settings = useSettings((s) => s.settings)
  const set = useSettings((s) => s.set)
  const reset = useSettings((s) => s.reset)
  const upd = <K extends keyof Settings>(k: K, v: Settings[K]): void =>
    set({ [k]: v } as Partial<Settings>)

  // Escape closes it. Every other overlay in riven does (the palette, the quick
  // panel, a context menu), and a settings window that ignores the key people
  // reach for reads as stuck.
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        e.stopPropagation()
        setOpen(false)
      }
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [open, setOpen])

  if (!open) return null

  // One subject per tab. It was all one "general" page, which scrolled through
  // appearance, editor, terminal, usage, pet, browser, power and notifications
  // — a page that long reads as a pile, and the things in it read as fewer than
  // they are, because nothing is where you would go looking for it.
  const NAV: Array<{ id: SettingsTab; label: string; icon: JSX.Element }> = [
    { id: 'general', label: t('settings.tab.general'), icon: <SlidersHorizontal size={15} /> },
    { id: 'editor', label: t('settings.tab.editor'), icon: <FileCode size={15} /> },
    { id: 'terminal', label: t('settings.tab.terminal'), icon: <TerminalSquare size={15} /> },
    { id: 'ai', label: 'AI', icon: <Bot size={15} /> },
    { id: 'perm', label: t('settings.tab.perm'), icon: <ShieldCheck size={15} /> },
    { id: 'notify', label: t('settings.tab.notify'), icon: <Bell size={15} /> },
    { id: 'pet', label: t('pet.title'), icon: <Egg size={15} /> },
    { id: 'keys', label: t('settings.tab.keys'), icon: <Keyboard size={15} /> },
    { id: 'account', label: t('settings.tab.account'), icon: <User size={15} /> },
    { id: 'about', label: t('settings.tab.about'), icon: <Info size={15} /> }
  ]
  const sectionTitle = NAV.find((n) => n.id === tab)?.label ?? ''

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

                <div className="section-label">{t('settings.powerSection')}</div>
                <ToggleRow
                  title={t('settings.keepAwake')}
                  desc={t('settings.keepAwakeDesc')}
                  checked={settings.keepAwake}
                  onChange={(v) => upd('keepAwake', v)}
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
            {tab === 'editor' && (
              <>
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

              </>
            )}
            {tab === 'terminal' && (
              <>
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
                <Row title={t('settings.termCursorStyle')}>
                  <select
                    className="ui-select"
                    value={settings.terminalCursorStyle}
                    onChange={(e) => upd('terminalCursorStyle', e.target.value as 'block')}
                  >
                    <option value="block">{t('settings.cursorBlock')}</option>
                    <option value="bar">{t('settings.cursorBar')}</option>
                    <option value="underline">{t('settings.cursorUnderline')}</option>
                  </select>
                </Row>
                <ToggleRow
                  title={t('settings.termCursorBlink')}
                  checked={settings.terminalCursorBlink}
                  onChange={(v) => upd('terminalCursorBlink', v)}
                />
                <Row title={t('settings.termScrollback')} desc={t('settings.termScrollbackDesc')}>
                  <NumberInput
                    min={200}
                    max={100000}
                    step={500}
                    value={settings.terminalScrollback}
                    onChange={(e) => upd('terminalScrollback', Number(e.target.value))}
                  />
                </Row>
                <ToggleRow
                  title={t('settings.termCopyOnSelect')}
                  desc={t('settings.termCopyOnSelectDesc')}
                  checked={settings.terminalCopyOnSelect}
                  onChange={(v) => upd('terminalCopyOnSelect', v)}
                />
                <ToggleRow
                  title={t('settings.termRightClickPaste')}
                  desc={t('settings.termRightClickPasteDesc')}
                  checked={settings.terminalRightClickPaste}
                  onChange={(v) => upd('terminalRightClickPaste', v)}
                />
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

              </>
            )}
            {tab === 'notify' && (
              <>
                <div className="section-label">{t('settings.notifySection')}</div>
                <ToggleRow
                  title={t('settings.notifications')}
                  desc={t('settings.notifyDesc')}
                  checked={settings.notifications}
                  onChange={(v) => upd('notifications', v)}
                />
                {/* Which events are worth interrupting for. Nested under the
                    master switch, and disabled with it, so the relationship is
                    visible rather than something to discover. */}
                <ToggleRow
                  title={t('settings.notifyDone')}
                  checked={settings.notifyOnDone}
                  disabled={!settings.notifications}
                  onChange={(v) => upd('notifyOnDone', v)}
                />
                <ToggleRow
                  title={t('settings.notifyNeedsInput')}
                  checked={settings.notifyOnNeedsInput}
                  disabled={!settings.notifications}
                  onChange={(v) => upd('notifyOnNeedsInput', v)}
                />
                <ToggleRow
                  title={t('settings.notifyFailure')}
                  checked={settings.notifyOnFailure}
                  disabled={!settings.notifications}
                  onChange={(v) => upd('notifyOnFailure', v)}
                />
                <ToggleRow
                  title={t('settings.crashReporting')}
                  desc={t('settings.crashDesc')}
                  checked={settings.crashReporting}
                  onChange={(v) => upd('crashReporting', v)}
                />

              </>
            )}
            {tab === 'pet' && (
              <>
                <div className="section-label">{t('pet.title')}</div>
                <ToggleRow
                  title={t('settings.petShow')}
                  desc={t('settings.petShowDesc')}
                  checked={settings.petShow}
                  onChange={(v) => upd('petShow', v)}
                />
                {settings.petShow && (
                  <ToggleRow
                    title={t('settings.petDetached')}
                    desc={t('settings.petDetachedDesc')}
                    checked={settings.petDetached}
                    onChange={(v) => upd('petDetached', v)}
                  />
                )}
                {/* Only its own window can be lifted above other apps. */}
                {settings.petShow && settings.petDetached && (
                  <ToggleRow
                    title={t('settings.petOnTop')}
                    desc={t('settings.petOnTopDesc')}
                    checked={settings.petOnTop}
                    onChange={(v) => upd('petOnTop', v)}
                  />
                )}

              </>
            )}

            {tab === 'perm' && (
              <>
                {/* The OS first: a tool that is pre-approved in riven still does
                    nothing if macOS has not granted the app the right to do it,
                    and that failure is silent everywhere else. */}
                <div className="section-label">{t('settings.perm.osSection')}</div>
                <OsPermissions />

                <div className="section-label">{t('settings.perm.modeSection')}</div>
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

                {/* Pre-approval, not prohibition: a tool switched off here is
                    simply not in --allowedTools, so the CLI asks before using
                    it. "Let it read, ask me before it writes" was not
                    expressible at all before — the list was hardcoded. */}
                <div className="section-label">{t('settings.perm.toolsSection')}</div>
                <div className="set-note">{t('settings.perm.toolsDesc')}</div>
                {BUILTIN_TOOLS.map((name) => (
                  <ToggleRow
                    key={name}
                    title={name}
                    checked={!settings.deniedTools.includes(name)}
                    onChange={(v) =>
                      upd(
                        'deniedTools',
                        v
                          ? settings.deniedTools.filter((x) => x !== name)
                          : [...settings.deniedTools, name]
                      )
                    }
                  />
                ))}

                <div className="section-label">{t('settings.perm.confirmSection')}</div>
                <ToggleRow
                  title={t('settings.perm.confirmClose')}
                  desc={t('settings.perm.confirmCloseDesc')}
                  checked={settings.confirmCloseBusy}
                  onChange={(v) => upd('confirmCloseBusy', v)}
                />
                <ToggleRow
                  title={t('settings.perm.confirmDelete')}
                  desc={t('settings.perm.confirmDeleteDesc')}
                  checked={settings.confirmDeleteSession}
                  onChange={(v) => upd('confirmDeleteSession', v)}
                />
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
                    <ModelOptions
                      cli="claude"
                      configDir={claudeConfigDirFor(null)}
                      current={settings.defaultChatModel}
                    />
                  </Select>
                </Row>
                <Row title={t('settings.autocompact')} desc={t('settings.autocompactDesc')}>
                  <Select value={settings.autocompact} onChange={(e) => upd('autocompact', e.target.value)}>
                    <option value="150000">150K</option>
                    <option value="200000">{t('settings.autocompactRecommended', { n: '200K' })}</option>
                    <option value="300000">300K</option>
                    <option value="500000">500K</option>
                    <option value="auto">{t('settings.autocompactAuto')}</option>
                  </Select>
                </Row>
                <ToggleRow
                  title={t('settings.autoTitle')}
                  desc={t('settings.autoTitleDesc')}
                  checked={settings.autoTitle}
                  onChange={(v) => upd('autoTitle', v)}
                />

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
