import { useSession } from '../state/session'
import { useUI } from '../state/ui'
import { addTerminal, togglePanel, popoutActive } from '../dock/registry'

export default function Toolbar(): JSX.Element {
  const hasWs = useSession((s) => s.activeWorkspace != null)
  const toggleExplorer = useUI((s) => s.toggleExplorer)

  return (
    <div className="toolbar">
      <button className="tb-btn primary" disabled={!hasWs} title="새 터미널 (⌘T)" onClick={() => addTerminal()}>
        <span className="tb-plus">＋</span> 터미널
      </button>

      <span className="tb-sep" />

      <button className="tb-btn" disabled={!hasWs} title="탐색기 (⌘B)" onClick={() => toggleExplorer()}>
        탐색기
      </button>
      <button className="tb-btn" disabled={!hasWs} title="검색 (⌘⇧F)" onClick={() => togglePanel('search')}>
        검색
      </button>
      <button className="tb-btn" disabled={!hasWs} title="Git (⌘⇧G)" onClick={() => togglePanel('git')}>
        Git
      </button>
      <button className="tb-btn" disabled={!hasWs} title="설치된 CLI 실행 (⌘⇧L)" onClick={() => togglePanel('cli')}>
        CLI
      </button>
      <button className="tb-btn" disabled={!hasWs} title="코드 편집기 (파일 선택 시 자동)" onClick={() => togglePanel('editor')}>
        코드
      </button>
      <button className="tb-btn" disabled={!hasWs} title="프리뷰 (⌘⇧V)" onClick={() => togglePanel('preview')}>
        프리뷰
      </button>

      <span className="tb-sep" />

      <button className="tb-btn icon" disabled={!hasWs} title="현재 패널을 새 창으로 (⌘⇧P)" onClick={() => popoutActive()}>
        ⧉
      </button>
    </div>
  )
}
