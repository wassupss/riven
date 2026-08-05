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
