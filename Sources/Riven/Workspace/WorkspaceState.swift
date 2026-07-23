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
    var openAux: Set<String> = []        // which aux panels (search/git/preview/changes) were open
    var dock: DockManager?               // this workspace's panel layout
    var terminalSeq = 0                  // for unique term-N panel ids
    // 이전 세션의 독 레이아웃 스냅샷 (DockManager.snapshot() 형식: 스플릿 트리 +
    // 팬 크기 + 탭 구성). 이 워크스페이스의 독을 처음 만들 때 restore()로 그대로
    // 재현하고 비운다. nil이면 복원할 레이아웃이 없다.
    var pendingLayout: [String: Any]?
    // 구버전 세션("terminals" 키)의 터미널 구성(에이전트 이름 또는 "" = 일반 터미널).
    // pendingLayout이 없을 때만 쓰는 하위 호환 폴백 — 새 세션은 layout으로만 저장한다.
    var pendingTerminals: [String]?

    init(url: URL) { self.url = url }
}
