import { createPortal } from 'react-dom'
import { useUI } from '../state/ui'
import { useSettings } from '../state/settings'
import { THEMES, applyTheme } from '../state/themes'

export default function SettingsModal(): JSX.Element | null {
  const open = useUI((s) => s.settingsOpen)
  const setOpen = useUI((s) => s.setSettingsOpen)
  const settings = useSettings((s) => s.settings)
  const set = useSettings((s) => s.set)
  const reset = useSettings((s) => s.reset)

  if (!open) return null

  return createPortal(
    <div className="modal-overlay" onClick={() => setOpen(false)}>
      <div className="modal settings-modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <span>설정</span>
          <button className="btn-small" onClick={() => setOpen(false)}>
            닫기
          </button>
        </div>
        <div className="modal-body settings-body">
          <div className="section-label">테마</div>
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

          <div className="section-label">에디터</div>
          <div className="set-row">
            <span className="set-label">폰트</span>
            <input
              className="url-input"
              value={settings.editorFontFamily}
              onChange={(e) => set({ editorFontFamily: e.target.value })}
            />
          </div>
          <div className="set-row">
            <span className="set-label">크기</span>
            <input
              className="url-input set-num"
              type="number"
              min={8}
              max={32}
              value={settings.editorFontSize}
              onChange={(e) => set({ editorFontSize: Number(e.target.value) })}
            />
          </div>

          <div className="section-label">터미널</div>
          <div className="set-row">
            <span className="set-label">폰트</span>
            <input
              className="url-input"
              value={settings.terminalFontFamily}
              onChange={(e) => set({ terminalFontFamily: e.target.value })}
            />
          </div>
          <div className="set-row">
            <span className="set-label">크기</span>
            <input
              className="url-input set-num"
              type="number"
              min={8}
              max={32}
              value={settings.terminalFontSize}
              onChange={(e) => set({ terminalFontSize: Number(e.target.value) })}
            />
          </div>
          <div className="set-row">
            <span className="set-label">배경색</span>
            <input
              type="color"
              value={settings.terminalBackground}
              onChange={(e) => set({ terminalBackground: e.target.value })}
            />
            <span className="set-hex">{settings.terminalBackground}</span>
          </div>
          <div className="set-row">
            <span className="set-label">글자색</span>
            <input
              type="color"
              value={settings.terminalForeground}
              onChange={(e) => set({ terminalForeground: e.target.value })}
            />
            <span className="set-hex">{settings.terminalForeground}</span>
          </div>
          <div className="set-row">
            <span className="set-label">커서색</span>
            <input
              type="color"
              value={settings.terminalCursor}
              onChange={(e) => set({ terminalCursor: e.target.value })}
            />
            <span className="set-hex">{settings.terminalCursor}</span>
          </div>

          <div className="set-actions">
            <button className="btn-small" onClick={reset}>
              기본값으로
            </button>
          </div>
        </div>
      </div>
    </div>,
    document.body
  )
}
