import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { Trash2 } from 'lucide-react'
import { useOutput, initOutputCapture, LSP_CHANNEL } from '../../state/outputLog'
import { useT } from '../../i18n'
import '../../styles/output-panel.css'

// VS Code-style Output view: pick a channel, watch its log stream. Sources are the
// language server (window/logMessage) and our tsc/eslint diagnostics runs.
export default function OutputPanel({ workspace }: { workspace: string }): JSX.Element {
  void workspace
  const t = useT()
  useOutput((s) => s.version) // re-render on any append
  const channels = useOutput((s) => s.channels)
  const clear = useOutput((s) => s.clear)
  const ensure = useOutput((s) => s.ensure)
  const [channel, setChannel] = useState(LSP_CHANNEL)
  const bodyRef = useRef<HTMLPreElement>(null)

  useEffect(() => {
    initOutputCapture()
    ensure(LSP_CHANNEL)
  }, [ensure])

  const names = Object.keys(channels)
  if (names.length && !names.includes(channel)) {
    // Selected channel vanished (cleared list) — fall back to the first available.
    setChannel(names[0])
  }
  const lines = channels[channel] ?? []

  // Auto-scroll to the newest line (only when already near the bottom).
  useLayoutEffect(() => {
    const el = bodyRef.current
    if (!el) return
    const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 60
    if (nearBottom) el.scrollTop = el.scrollHeight
  }, [lines])

  return (
    <div className="out-panel">
      <div className="out-toolbar">
        <select className="out-channel" value={channel} onChange={(e) => setChannel(e.target.value)}>
          {(names.length ? names : [LSP_CHANNEL]).map((n) => (
            <option key={n} value={n}>
              {n}
            </option>
          ))}
        </select>
        <div className="out-spacer" />
        <button className="out-clear" title={t('output.clear')} onClick={() => clear(channel)}>
          <Trash2 size={13} />
        </button>
      </div>
      <pre className="out-body" ref={bodyRef}>
        {lines.length ? lines.join('\n') : <span className="out-empty">{t('output.empty')}</span>}
      </pre>
    </div>
  )
}
