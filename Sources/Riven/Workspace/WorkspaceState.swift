import AppKit

// Per-workspace state. Each workspace owns its own dock (like riven, which mounts
// one dockview per workspace) — the terminals and editor panel live inside it, so
// switching projects swaps the whole panel layout without tearing down terminals.
// libghostty surfaces are never recreated (that crashes); the TerminalViews inside
// this dock persist and are only reparented when the workspace's dock swaps in/out.
final class WorkspaceState {
    let url: URL
    var openTabs: [String] = []          // editor file paths, in order
    var activeTab: String?
    var openAux: Set<String> = []        // which aux panels (search/git/preview/changes/api) were open
    var dock: DockManager?               // this workspace's panel layout
    var terminalSeq = 0                  // for unique term-N panel ids
    // Id of the panel that was focused when we last switched away. dock.restore rebuilds
    // the group tree (dropping the live activeGroup), so we re-select this panel's group and
    // focus it on return — otherwise focus lands on the first pane every time.
    var activePanelId: String?
    // 이전 세션의 독 레이아웃 스냅샷 (DockManager.snapshot() 형식: 스플릿 트리 +
    // 팬 크기 + 탭 구성). 이 워크스페이스의 독을 처음 만들 때 restore()로 그대로
    // 재현하고 비운다. nil이면 복원할 레이아웃이 없다.
    var pendingLayout: [String: Any]?
    // Layout captured when leaving this workspace, WITH the shared editor/aux panels still in
    // place. Used only when saving the session: an inactive workspace's live dock is missing those
    // singletons (they follow the active workspace), so snapshotting it at quit would persist a
    // layout with the editor slot gone.
    var savedLayout: [String: Any]?
    // This workspace's OWN editor panel. Its content is `editorHost`, an empty container the shared
    // editor view (one WKWebView for the app) is moved into when this workspace is shown. Panels
    // used to be a single shared instance detached from one dock and re-inserted into another on
    // every switch — profiling showed that detach/cleanupEmpty + restorePlacement dance was the
    // remaining switch cost. Now the tree never changes; only the webview is re-parented.
    var editorPanel: DockPanel?
    let editorHost = NSView()
    /// This workspace's aux panels (search/git/preview/api/changes/notes). Each hosts an empty
    /// container; the shared panel view is moved in when this workspace is shown.
    var auxPanels: [String: DockPanel] = [:]
    /// 이 워크스페이스의 브라우저. 하나를 워크스페이스끼리 돌려 쓰면, 다른 워크스페이스의
    /// 에이전트가 MCP 로 페이지를 열었을 때 지금 보고 있는 워크스페이스에서 열린다 —
    /// 실제로 그렇게 남의 화면에 페이지가 떴다. 브라우저는 워크스페이스마다 따로 둔다.
    var preview: PreviewPanel?
    /// 이 워크스페이스의 메모/문서 패널. 브라우저와 같은 이유로 워크스페이스마다 따로 둔다 —
    /// 하나를 돌려 쓰면 다른 워크스페이스의 에이전트가 쓴 문서가 지금 보고 있는 쪽에 떴다.
    var notes: NotesPanel?
    /// API 패널과 에이전트 그룹 패널도 워크스페이스마다. 요청 기록도 그룹 명단도 그
    /// 프로젝트의 것이라, 하나를 돌려 쓰면 남의 워크스페이스 내용이 보인다.
    var api: APIClientPanel?
    var team: AgentGroupPanel?
    /// 탐색기·검색·소스컨트롤·변경사항도 워크스페이스마다. 내용이 섞이지는 않았지만
    /// (워크스페이스를 옮길 때 루트만 다시 가리켰다) 펼쳐 둔 폴더·검색어·고른 diff 가
    /// 매번 날아갔다 — 그것도 그 워크스페이스의 상태다.
    /// 전부 처음 필요할 때 만든다. 열어 본 적 없는 워크스페이스는 아무것도 만들지 않는다.
    var explorer: FileTreeView?
    var search: SearchPanel?
    var git: SourceControlView?
    var changes: ChangesPanel?
    /// 마지막으로 이 워크스페이스를 본 시각. 오래 안 본 곳의 패널은 놓아준다.
    var lastUsed = Date()

    /// 이 워크스페이스의 보조 패널들을 놓아준다. 독의 자리(auxPanels)와 호스트는 그대로
    /// 두므로, 다시 돌아오면 그 자리에 새로 만들어 끼운다 — 사용자 눈에는 열려 있던 패널이
    /// 그대로 있다. 채팅·터미널 팬은 살아 있는 세션이라 절대 건드리지 않는다.
    var hasPanels: Bool {
        preview != nil || notes != nil || api != nil || team != nil
            || explorer != nil || search != nil || git != nil || changes != nil
    }

    func releasePanels() {
        for v in [preview as NSView?, notes, api, team, explorer, search, git, changes] {
            v?.removeFromSuperview()
        }
        preview = nil; notes = nil; api = nil; team = nil
        explorer = nil; search = nil; git = nil; changes = nil
    }
    var auxHosts: [String: NSView] = [:]
    func auxHost(_ id: String) -> NSView {
        if let v = auxHosts[id] { return v }
        let v = NSView(); v.autoresizingMask = [.width, .height]
        auxHosts[id] = v
        return v
    }
    // 구버전 세션("terminals" 키)의 터미널 구성(에이전트 이름 또는 "" = 일반 터미널).
    // pendingLayout이 없을 때만 쓰는 하위 호환 폴백 — 새 세션은 layout으로만 저장한다.
    var pendingTerminals: [String]?

    init(url: URL) { self.url = url }
}
