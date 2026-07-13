import { useRef, useState } from 'react'
import { useSession } from '../../state/session'
import { contextBus } from '../../bridge/contextBus'

export default function PreviewPanel({ workspace }: { workspace: string }): JSX.Element {
  const previewUrl = useSession((s) => s.sessions[workspace]?.previewUrl ?? '')
  const patch = useSession((s) => s.patch)
  const [urlInput, setUrlInput] = useState(previewUrl || 'http://localhost:3000')
  const webviewRef = useRef<HTMLElement & { capturePage: () => Promise<{ toDataURL: () => string }> }>(
    null
  )

  const open = (url: string): void => patch(workspace, { previewUrl: url })

  const captureToClaude = async (): Promise<void> => {
    const wv = webviewRef.current
    if (!wv) return
    const img = await wv.capturePage()
    const saved = await window.api.bridge.saveCapture(workspace, img.toDataURL())
    contextBus.sendScreenshot(workspace, saved)
  }

  return (
    <div className="preview-panel">
      <div className="preview-bar">
        <input
          className="url-input"
          value={urlInput}
          onChange={(e) => setUrlInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') open(urlInput)
          }}
          placeholder="http://localhost:3000"
        />
        <button className="btn-small" onClick={() => open(urlInput)}>
          열기
        </button>
        <button
          className="btn-small"
          disabled={!previewUrl || !contextBus.hasSink(workspace)}
          title="현재 화면을 캡처해 claude에 전달"
          onClick={captureToClaude}
        >
          ➤ 캡처
        </button>
      </div>
      {previewUrl ? (
        // @ts-expect-error webview is an Electron intrinsic element
        <webview ref={webviewRef} src={previewUrl} className="preview-webview" />
      ) : (
        <div className="empty-hint center">실행 중인 서버 주소를 열어 미리 봐.</div>
      )}
    </div>
  )
}
