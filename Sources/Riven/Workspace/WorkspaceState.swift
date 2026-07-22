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

    init(url: URL) { self.url = url }
}
