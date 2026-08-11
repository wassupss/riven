import AppKit
import WebKit

// A native dockview-style panel system (matches riven's dockview): panels live in
// tabbed groups; groups are arranged in a resizable NSSplitView tree. Tabs can be
// dragged between groups (center drop = add as tab) or onto a group's edge
// (drop = split in that direction). Every divider is drag-resizable. The initial
// arrangement is just a default; the user rearranges everything freely.

enum DockDir { case left, right, up, down, center }

// One panel: an id, a title, and the content view it hosts. Singleton panels
// (editor/search/git/preview/changes) have one instance; terminals are many.
final class DockPanel {
    let id: String
    var title: String
    var icon: NSImage?              // var: updated when a hand-typed pane turns out to run an agent
    let content: NSView
    let closable: Bool
    weak var group: DockGroup?
    var onClose: (() -> Void)?      // called when the tab's × is clicked
    var onActivate: (() -> Void)?   // called when this panel becomes visible
    /// 이 팬의 상태 - 레일·독 탭·조직도가 함께 읽는 단 하나의 저장소 ([[AgentStatus]]).
    /// 예전에는 badge 문자열이 저장소였는데, "attn" 하나에 승인 대기와 완료가 섞여 있어서
    /// 자리마다 다른 색으로 갈라졌다. 문자열은 아래 badge 로 계속 읽고 쓸 수 있다.
    var status: AgentStatus = .idle
    /// 예전 badge 문자열 호환 (nil | "busy" | "attn"). 승인 대기는 문자열로 표현되지
    /// 않으므로, 그 구분이 필요한 곳은 status 를 직접 본다.
    var badge: String? {
        get { status.badgeValue }
        set {
            // "attn" 을 다시 넣는 게 이미 켜져 있는 승인 대기를 완료로 덮지 않게 한다.
            if newValue == "attn", status == .waiting { return }
            status = AgentStatus(badge: newValue)
        }
    }
    var autoTitle: Bool = false     // follow the shell's OSC title (plain terminals only)
    // 이 패널이 실행한 에이전트 이름(없으면 일반 터미널). 세션 복원 때 같은 구성을
    // 다시 만들기 위해 기록해 둔다.
    var agentName: String?
    // 훅으로 판명된 에이전트 종류(손타이핑 claude/codex 등, agentName이 nil인 경우). 레일
    // 아이콘·탭 아이콘을 정하는 데 쓴다.
    var hookAgentKind: String?
    // True once this pane's agent process EXITED and it fell back to a plain shell (childExited
    // respawn). Such a pane is no longer an agent, so it drops out of the rail's agent list
    // until a new agent starts in it (cleared on the next hook).
    var agentExited: Bool = false
    // 에이전트 세션 id (Claude Code `--session-id`). 저장했다가 복원 때 `--resume <id>`로
    // 그 패널의 정확한 대화를 이어간다. (cwd 기반 --continue의 다중 패널 한계를 넘음)
    var sessionId: String?
    /// Chat panes only: the human-readable handle peers address it by, and the custom agent
    /// (.claude/agents) it runs as. Persisted in the layout snapshot so an agent group keeps its
    /// roles across a relaunch - restoring only the session id lost who each pane WAS.
    var chatNickname: String?
    var chatAgent: String?
    var chatGroup: String?      // agent-group name, shown in the title and kept across restarts
    var chatParent: String?     // nickname of the agent this one reports to (org chart / hierarchy)
    var chatModel: String?      // model this pane is pinned to ("opus"/"sonnet"/…), nil = 계정 기본
    /// 이 챗을 굴리는 CLI. 스냅샷에 적히므로 재기동해도 Codex 챗은 Codex 로 돌아온다.
    var chatKind: ChatAgentKind = .claude
    /// 이 팬의 아바타 키(역할 이름). 닉네임 → 커스텀 에이전트 순. 탭·레일·조직도가 같은
    /// 키를 써서 같은 얼굴을 그린다. 역할이 없는 팬은 nil (예전 아이콘 그대로).
    var avatarKey: String? { AgentAvatar.key(nickname: chatNickname, agent: chatAgent, kind: nil) }
    /// 사용자가 조직도에서 고른 아바타 ("글리프.색"). nil 이면 이름 해시 자동 배정.
    /// 레이아웃 스냅샷과 그룹 명단 양쪽에 저장돼서 재기동·재개 뒤에도 같은 얼굴이 나온다.
    var chatAvatar: String?

    init(id: String, title: String, icon: NSImage? = nil, content: NSView, closable: Bool = true) {
        self.id = id; self.title = title; self.icon = icon; self.content = content; self.closable = closable
    }
}

let dockPBType = NSPasteboard.PasteboardType("com.riven.dockpanel")

// 싱글턴 패널(에디터/search/git/preview/changes)이 워크스페이스 전환으로 독에서
// 분리될 때의 "자리" 기록. 돌아올 때 기본 위치가 아니라 이 자리로 복원한다 (#4).
// 그룹/스플릿 뷰는 detach 과정에서 사라질 수 있으므로(빈 그룹 정리), 살아있는
// 뷰 참조(weak)와 함께 그 자리의 이웃 패널 id들을 기록해 두고 복원 시 추적한다.
struct DockPlacement {
    weak var hostGroup: DockGroup?      // 다른 패널과 탭을 공유했다면 그 그룹
    var hostPanelIds: [String] = []     // hostGroup이 죽었을 때 같은 그룹을 찾을 동료 패널 id
    var tabIndex = 0                    // 그룹 내 탭 위치
    weak var parentSplit: NSSplitView?  // 홀로 그룹이었다면 그 그룹이 있던 split
    var indexInSplit = 0                // split 안에서의 자리
    var vertical = true                 // 분할 축 (세로 divider = 좌우 배치)
    var extent: CGFloat = 0             // 그 축에서 차지하던 크기
    weak var prevView: NSView?          // 앞쪽(왼/위) 형제 - 살아있으면 그 뒤에 복원
    var prevPanelIds: [String] = []     // 앞쪽 형제가 죽었을 때 추적할 그 안의 패널 id들
    weak var nextView: NSView?          // 뒤쪽(오른/아래) 형제 - 살아있으면 그 앞에 복원
    var nextPanelIds: [String] = []
    var parentExtents: [CGFloat] = []   // parentSplit의 모든 팬 크기 스냅샷 (이 팬 포함) - 복원 시
                                        // 형제까지 정확히 되돌려 왕복 시 크기가 누적으로 줄지 않게 (#3)
}

// A container whose single child (the root group or split) always fills it -
// robust against being added before the container has its real size, and against
// being reparented between workspaces.
final class DockContainer: NSView {
    weak var manager: DockManager?
    override func layout() {
        super.layout()
        // Both the group tree AND the empty overlay fill the container, regardless of
        // z-order (sizing only subviews.first left the group unsized when the overlay
        // sat first → the dock looked blank).
        subviews.forEach { $0.frame = bounds }
    }
    // The dock sits under the transparent titlebar (dock tabs at y=0); without this
    // a drag in the dock would move the WINDOW instead of the panel/divider.
    override var mouseDownCanMoveWindow: Bool { false }
    // ⌘⌥= - distribute all panes evenly (tmux's prefix+E / iTerm's arrange panes).
    // Handled here so the shortcut works whenever the dock is in the key window's
    // view tree; main.swift may ALSO bind a menu item to DockManager.distributeEvenly().
    override func performKeyEquivalent(with event: NSEvent) -> Bool {
        let mods = event.modifierFlags.intersection(.deviceIndependentFlagsMask)
        if mods == [.command, .option], event.charactersIgnoringModifiers == "=" {
            manager?.distributeEvenly()
            return true
        }
        return super.performKeyEquivalent(with: event)
    }
}

// Owns the group tree and all add/move/split/close operations.
final class DockManager {
    let container = DockContainer()
    private(set) weak var activeGroup: DockGroup?
    static weak var draggingPanel: DockPanel?
    var onActivePanel: ((DockPanel?) -> Void)?
    var onAddTerminal: (() -> Void)?   // empty-state "터미널 추가하기"
    var onOpenEditor: (() -> Void)?    // empty-state "코드 편집기 열기"
    private let emptyView = DockEmptyView()

    init() {
        container.manager = self
        container.wantsLayer = true
        container.layer?.backgroundColor = Theme.bg.cgColor
        emptyView.onAddTerminal = { [weak self] in self?.onAddTerminal?() }
        emptyView.onOpenEditor = { [weak self] in self?.onOpenEditor?() }
        emptyView.isHidden = true
        container.addSubview(emptyView)
        DockManager.installClickMonitor()
    }

    /// 클릭 지점이 웹뷰 안인지 (웹뷰는 포커스를 스스로 관리한다).
    static func isInsideWebView(_ v: NSView?) -> Bool {
        var cur: NSView? = v
        while let c = cur {
            if c is WKWebView { return true }
            cur = c.superview
        }
        return false
    }

    /// 이번 setActive가 마우스 클릭에서 왔는지 - onActivePanel 안에서만 유효.
    /// 클릭일 땐 앱이 강제 포커스를 걸지 않는다(트랜스크립트 텍스트 선택을 뺏지 않도록).
    private(set) var activationFromClick = false

    // 패널의 어느 지점을 클릭하든 그 패널이 활성화되어야 한다. 예전에는 터미널·챗만
    // mouseDown을 구현해 두어 노트/검색/깃/API 패널은 본문을 클릭해도 활성 링이 그대로였다.
    // 타입마다 심는 대신 창 전체에서 좌/우클릭을 한 번 관찰해 hitTest가 속한 DockGroup을
    // 활성화한다(이벤트는 그대로 흘려보내 드래그·선택에 영향 없음).
    private static var clickMonitor: Any?
    private static func installClickMonitor() {
        guard clickMonitor == nil else { return }
        clickMonitor = NSEvent.addLocalMonitorForEvents(matching: [.leftMouseDown, .rightMouseDown]) { e in
            guard let win = e.window, let root = win.contentView else { return e }
            var v: NSView? = root.hitTest(root.convert(e.locationInWindow, from: nil))
            while let cur = v {
                if let g = cur as? DockGroup {
                    if let mgr = g.manager, !g.panels.isEmpty {
                        mgr.setActive(g, fromClick: true)
                        // 클릭 지점이 스스로 포커스를 받지 못하는 곳(패널 여백·라벨 등)이면
                        // 창 포커스가 이전 패널에 남는다 → 이벤트 처리 후 확인해서 보정.
                        // 단, 웹뷰(브라우저·에디터)는 포커스를 자기가 비동기로 가져간다. 여기서
                        // 컨테이너를 first responder 로 만들면 그 포커스를 빼앗아 ⌘C 같은 표준
                        // 동작이 웹뷰에 닿지 않는다 (브라우저에서 복사가 안 되던 원인).
                        if DockManager.isInsideWebView(cur) { break }
                        DispatchQueue.main.async { [weak g] in
                            guard let g, let mgr = g.manager, mgr.activeGroup === g else { return }
                            if let fr = win.firstResponder as? NSView, fr.isDescendant(of: g) { return }
                            mgr.onActivePanel?(g.activePanel)
                        }
                    }
                    break
                }
                v = cur.superview
            }
            return e
        }
    }

    // Total panels across every group; drives the empty-state overlay.
    var totalPanels: Int { groups.reduce(0) { $0 + $1.panels.count } }

    // Show riven's empty workbench (wordmark + add-terminal / open-editor) when the
    // dock holds no panels; hide it otherwise. Keep the overlay the topmost subview.
    func refreshEmpty() {
        if totalPanels == 0 {
            emptyView.frame = container.bounds
            emptyView.isHidden = false
            container.addSubview(emptyView)       // topmost, covers the whole dock
        } else {
            // Remove entirely (not just hide) so it can never peek through split-divider
            // gaps or partially-covered regions between panels.
            emptyView.removeFromSuperview()
        }
    }

    // Scan ALL container subviews (not just .first) so the group tree is found even
    // when the empty overlay is z-ordered above it - otherwise totalPanels read 0 and
    // the empty screen wrongly covered a dock that actually had panels.
    var groups: [DockGroup] { container.subviews.flatMap { collect($0) } }
    private func collect(_ v: NSView?) -> [DockGroup] {
        guard let v else { return [] }
        if let g = v as? DockGroup { return [g] }
        if let s = v as? NSSplitView { return s.arrangedSubviews.flatMap { collect($0) } }
        return v.subviews.flatMap { collect($0) }
    }
    func panel(id: String) -> DockPanel? {
        for g in groups { if let p = g.panels.first(where: { $0.id == id }) { return p } }
        return nil
    }

    func setRoot(_ group: DockGroup) {
        container.subviews.filter { !($0 is DockEmptyView) }.forEach { $0.removeFromSuperview() }
        group.frame = container.bounds
        group.autoresizingMask = [.width, .height]
        group.manager = self
        container.addSubview(group, positioned: .below, relativeTo: emptyView)
        activeGroup = group
        refreshEmpty()
    }

    // Add a panel next to a reference group (split) or into a group as a tab.
    // `sizeHint` (points, along the split axis) gives the new pane a fixed initial
    // extent - used for aux side panels (search/git/preview/changes) and the editor,
    // which shouldn't take a bare 1/N share. Without a hint the new pane gets a fair
    // 1/N of its container (see rebalanceAfterInsert).
    @discardableResult
    func addPanel(_ panel: DockPanel, reference: DockGroup? = nil, direction: DockDir? = nil,
                  sizeHint: CGFloat? = nil, activate: Bool = true) -> DockGroup {
        // 빈 독에서는 방향 분할을 무시한다. 패널이 하나도 없는 상태에서 (빈) 기준 그룹
        // 옆으로 쪼개면 원래 자리가 빈 팬으로 남아 왼쪽은 공백, 새 패널은 오른쪽 절반만
        // 차지한다 - 첫 패널은 언제나 독 전체를 채워야 한다.
        if totalPanels == 0 {
            let g = container.subviews.compactMap({ $0 as? DockGroup }).first
                ?? { let g = DockGroup(); setRoot(g); return g }()
            g.manager = self
            g.add(panel); if activate { setActive(g) }; refreshEmpty(); return g
        }
        if let ref = reference, let dir = direction, dir != .center {
            let g = DockGroup(); g.manager = self
            split(ref, with: g, direction: dir, sizeHint: sizeHint)
            g.add(panel); if activate { setActive(g) }; return g
        }
        let g = reference ?? activeGroup ?? {
            let g = DockGroup(); setRoot(g); return g
        }()
        g.add(panel); if activate { setActive(g) }; refreshEmpty(); return g
    }

    func setActive(_ g: DockGroup, fromClick: Bool = false) {
        for grp in groups { grp.isActiveGroup = (grp === g) }
        activeGroup = g
        activationFromClick = fromClick
        onActivePanel?(g.activePanel)
        activationFromClick = false
    }

    // Split `group` in `direction`, placing `newGroup` next to it.
    //
    // Natural sizing model (tmux/iTerm/VS Code-like):
    // • If the group's parent split already runs along this axis, DON'T nest another
    //   split - insert the new pane as a direct sibling (flat tree) and rebalance
    //   THAT container: the newcomer gets a fair 1/N share (or its sizeHint) and the
    //   existing panes scale proportionally into the remainder. Repeated adds thus
    //   converge to evenly-sized siblings instead of ever-smaller slivers, while a
    //   user's manual ratios among the surviving panes are preserved. Only the
    //   affected container is touched; unrelated splits keep their sizes.
    // • Otherwise wrap group+newGroup in a fresh 2-pane split (preserving the exact
    //   slot `group` occupied in its parent) and give the new pane half - or its
    //   sizeHint when one is provided (aux side panels).
    private func split(_ group: DockGroup, with newGroup: DockGroup, direction: DockDir,
                       sizeHint: CGFloat? = nil) {
        let vertical = (direction == .left || direction == .right) // vertical divider ⇒ side-by-side
        let before = (direction == .left || direction == .up)      // new group first
        guard let parent = group.superview else { return }
        group.autoresizingMask = [.width, .height]
        newGroup.autoresizingMask = [.width, .height]

        // Same-axis parent: flatten (sibling insert + local rebalance).
        if let psv = parent as? NSSplitView, psv.isVertical == vertical {
            psv.layoutSubtreeIfNeeded()   // 프레임이 최신이어야 크기를 옳게 잰다
            let gIdx = psv.arrangedSubviews.firstIndex(of: group) ?? 0
            let oldExtents = psv.arrangedSubviews.map { extent($0, in: psv) }
            let at = before ? gIdx : gIdx + 1
            psv.insertArrangedSubview(newGroup, at: at)
            psv.adjustSubviews()   // lay out synchronously so the pane shows this frame
            rebalanceAfterInsert(psv, insertedAt: at, oldExtents: oldExtents, sizeHint: sizeHint)
            return
        }

        let sv = DockSplitView(); sv.isVertical = vertical; sv.dividerStyle = .thin
        let savedFrame = group.frame

        // Fresh 2-pane split: new pane gets its hint (if it sensibly fits), else half.
        // If the split has no real size yet (inserted before this layout pass resolved
        // its bounds - common for a `.down` split, whose height isn't known until the
        // parent re-lays out), setPosition against a 0 axis would collapse a pane to
        // near-zero ("확 줄어"). Defer to the next runloop so bounds are real.
        func sizeNewPane(_ split: NSSplitView) {
            let apply: () -> Void = {
                let t = split.isVertical ? split.bounds.width : split.bounds.height
                guard t > 0 else { return }
                if let hint = sizeHint, hint >= 80, t - hint >= 120 {
                    split.setPosition(before ? hint : t - split.dividerThickness - hint, ofDividerAt: 0)
                } else {
                    split.setPosition(t * 0.5, ofDividerAt: 0)
                }
            }
            let t = split.isVertical ? split.bounds.width : split.bounds.height
            if t > 0 { apply() }
            else { RLog.log("dock: split sized at 0 bounds → deferring"); DispatchQueue.main.async(execute: apply) }
        }

        if let psv = parent as? NSSplitView {
            // Capture ALL sibling extents (group included, at `idx`) BEFORE the swap, then
            // restore them so the new wrapper split inherits EXACTLY group's old slot and
            // every other pane keeps its width. The old code only pinned idx==0 / idx==last
            // via setPosition, so a MIDDLE group's new split collapsed to 0 width - the
            // ⌘⇧D / drag "확 줄어" bug (confirmed by a [519,524,0,527] tree dump).
            psv.layoutSubtreeIfNeeded()   // 프레임이 최신이어야 크기를 옳게 잰다
            let idx = psv.arrangedSubviews.firstIndex(of: group) ?? 0
            let oldExtents = psv.arrangedSubviews.map { extent($0, in: psv) }
            group.removeFromSuperview()
            addPair(sv, group, newGroup, before: before)
            psv.insertArrangedSubview(sv, at: idx)   // sv occupies group's former slot index
            psv.adjustSubviews()
            setExtents(psv, oldExtents)               // sv gets group's old extent; siblings unchanged
            sv.adjustSubviews(); sizeNewPane(sv)
        } else {
            group.removeFromSuperview()
            sv.frame = savedFrame; sv.autoresizingMask = [.width, .height]
            addPair(sv, group, newGroup, before: before)
            parent.addSubview(sv)
            sv.adjustSubviews(); sizeNewPane(sv)
        }
    }
    private func addPair(_ sv: NSSplitView, _ a: DockGroup, _ b: DockGroup, before: Bool) {
        if before { sv.addArrangedSubview(b); sv.addArrangedSubview(a) }
        else { sv.addArrangedSubview(a); sv.addArrangedSubview(b) }
    }

    // ---- pane sizing helpers ------------------------------------------------

    // A pane's extent along its split's axis.
    private func extent(_ v: NSView, in sv: NSSplitView) -> CGFloat {
        sv.isVertical ? v.frame.width : v.frame.height
    }
    // Set every pane's extent by walking the dividers left→right / top→bottom.
    // `extents` must have one entry per arranged subview; positions are cumulative
    // (divider i sits after panes 0…i plus the i dividers before it).
    /// 한 팬이 속한 split의 형제들을 같은 크기로 맞춘다. 연속으로 쪼개면 절반의 절반씩
    /// 줄어들어 3열이 140/63/134 처럼 들쭉날쭉해진다 - 그룹을 만들 때 균등하게 편다.
    func equalizeSiblings(of group: DockGroup?) {
        container.layoutSubtreeIfNeeded()
        guard let sv = group?.superview as? NSSplitView, sv.arrangedSubviews.count > 1 else { return }
        let total = sv.isVertical ? sv.bounds.width : sv.bounds.height
        let n = CGFloat(sv.arrangedSubviews.count)
        let each = max(1, (total - sv.dividerThickness * (n - 1)) / n)
        setExtents(sv, Array(repeating: each, count: sv.arrangedSubviews.count))
    }

    /// 이 팬이 속한 (좌우) 분할에서 그쪽이 화면의 대부분을 갖게 한다. 그룹을 만들면 설정
    /// 패널과 반반으로 나뉘어 정작 에이전트들이 절반 안에 갇히던 걸 막는다.
    func giveMajority(to group: DockGroup?, fraction: CGFloat) {
        container.layoutSubtreeIfNeeded()
        // 가장 바깥쪽의 좌우 2분할을 고른다 - 그룹 안쪽(리드 | 멤버영역)이 아니라 패널과
        // 그룹 전체를 가르는 경계여야 한다.
        var v: NSView? = group
        var target: (NSSplitView, Int)?
        while let cur = v, let sv = cur.superview as? NSSplitView {
            if sv.isVertical, sv.arrangedSubviews.count == 2,
               let idx = sv.arrangedSubviews.firstIndex(of: cur) { target = (sv, idx) }
            v = sv
        }
        if let (sv, idx) = target {
            let total = sv.bounds.width - sv.dividerThickness
            let mine = max(1, total * fraction), other = max(1, total - mine)
            setExtents(sv, idx == 0 ? [mine, other] : [other, mine])
        }
    }

    private func setExtents(_ sv: NSSplitView, _ extents: [CGFloat]) {
        guard extents.count == sv.arrangedSubviews.count, extents.count >= 2 else { return }
        var pos: CGFloat = 0
        for i in 0..<(extents.count - 1) {
            pos += extents[i]
            sv.setPosition(pos, ofDividerAt: i)
            pos += sv.dividerThickness
        }
    }
    // Scale `oldExtents` (one per current arranged subview) so they exactly fill the
    // split - used after a pane is removed so siblings absorb the freed space
    // proportionally (tmux/iTerm/VS Code close behavior).
    private func redistribute(_ sv: NSSplitView, oldExtents: [CGFloat]) {
        let n = sv.arrangedSubviews.count
        guard n >= 2, oldExtents.count == n else { return }
        let total = (sv.isVertical ? sv.bounds.width : sv.bounds.height) - CGFloat(n - 1) * sv.dividerThickness
        guard total > 0 else { return }
        // 측정값이 0인 형제(레이아웃 확정 전에 잰 값)를 그대로 비례 배분하면 0이 고착된다.
        // 최소폭을 바닥으로 깔고 나눈다.
        let minE: CGFloat = 80
        var base = oldExtents
        if total > minE * CGFloat(n) { base = base.map { max($0, minE) } }
        let sum = base.reduce(0, +)
        let target = sum > 0 ? base.map { $0 * total / sum }
                             : Array(repeating: total / CGFloat(n), count: n)
        setExtents(sv, target)
    }

    // After inserting a pane into an existing same-axis split: give the newcomer a
    // fair share of THIS container - its explicit sizeHint (aux panels / editor) or
    // total/N - and scale the pre-existing panes proportionally into the remainder.
    // A layout that was even stays exactly even (2nd terminal → 1/2 each, 3rd → 1/3
    // each), and a user's manual ratios among the old panes survive. `oldExtents`
    // must be captured BEFORE the insert (one entry per pre-insert arranged subview).
    private func rebalanceAfterInsert(_ sv: NSSplitView, insertedAt idx: Int,
                                      oldExtents: [CGFloat], sizeHint: CGFloat?) {
        let n = sv.arrangedSubviews.count            // includes the new pane
        guard n >= 2, idx < n, oldExtents.count == n - 1 else { return }
        let total = (sv.isVertical ? sv.bounds.width : sv.bounds.height) - CGFloat(n - 1) * sv.dividerThickness
        guard total > 0 else {
            // Bounds not resolved yet (e.g. a `.down` insert before layout) - retry next
            // runloop so the newcomer gets a fair share instead of a collapsed sliver.
            RLog.log("dock: rebalance at 0 bounds → deferring")
            DispatchQueue.main.async { [weak self] in
                self?.rebalanceAfterInsert(sv, insertedAt: idx, oldExtents: oldExtents, sizeHint: sizeHint)
            }
            return
        }
        let minPane: CGFloat = 80                    // matches DockSplitView's divider constraints
        let fair = total / CGFloat(n)
        var newExt = sizeHint ?? fair
        newExt = min(newExt, max(fair, total - CGFloat(n - 1) * minPane))  // leave siblings room
        newExt = max(newExt, min(fair, minPane))                            // never degenerate
        let remaining = max(0, total - newExt)
        let sum = oldExtents.reduce(0, +)
        var extents = sum > 0 ? oldExtents.map { $0 * remaining / sum }
                              : Array(repeating: remaining / CGFloat(n - 1), count: n - 1)
        extents.insert(newExt, at: idx)
        setExtents(sv, extents)
    }

    // Auto-arrange: resize every split in the tree so its sibling panes share the
    // space equally (recursively). Fixes the "repeated ⌘D keeps carving panes
    // smaller and smaller" drift. Bind from main.swift or press ⌘⌥= in the dock.
    func distributeEvenly() {
        guard let root = container.subviews.first(where: { !($0 is DockEmptyView) }) else { return }
        container.layoutSubtreeIfNeeded()
        distribute(root)
    }
    private func distribute(_ v: NSView) {
        guard let sv = v as? NSSplitView else { return }
        let n = sv.arrangedSubviews.count
        if n >= 2 {
            let total = (sv.isVertical ? sv.bounds.width : sv.bounds.height) - CGFloat(n - 1) * sv.dividerThickness
            if total > 0 { setExtents(sv, Array(repeating: total / CGFloat(n), count: n)) }
        }
        // Children got new frames from setPosition; lay them out before recursing so
        // nested splits compute their halves against the fresh bounds.
        for child in sv.arrangedSubviews { child.layoutSubtreeIfNeeded(); distribute(child) }
    }

    // Move an existing panel to `group` (center = tab, edge = split).
    func move(_ panel: DockPanel, toGroup group: DockGroup, region: DockDir) {
        let from = panel.group
        if region == .center {
            if from === group { return }
            from?.remove(panel, dispose: false)
            group.add(panel); setActive(group)
            cleanupEmpty(from)     // 탭으로 옮긴 경우에도 비워진 그룹은 즉시 접는다
        } else {
            // Splitting a group against a panel already alone in it is a no-op.
            if from === group && group.panels.count == 1 { return }
            from?.remove(panel, dispose: false)
            // Collapse the vacated group and give its space back BEFORE restructuring.
            // Doing it after split() measured the siblings while the freshly-inserted
            // split still had a 0 frame, so the proportional redistribute kept those
            // zeros and one pane swallowed the row (observed: [580,346,350,294] →
            // [0, 0, 990]). Settle layout so the split measures real frames.
            cleanupEmpty(from)
            container.layoutSubtreeIfNeeded()
            let g = DockGroup(); g.manager = self
            split(group, with: g, direction: region)
            g.add(panel); setActive(g)
        }
        // Full sweep, same as a close. cleanupEmpty only collapses the SOURCE group, and
        // split() may already have restructured the tree around it - so a panel that was
        // alone in its group (every aux panel: source control / changes / search / browser)
        // could leave its emptied group behind, keeping its width as a blank pane.
        normalizeTree()
        refreshEmpty()
    }

    // Split at the ROOT level: the dragged panel becomes a full-height column / full-
    // width row alongside the entire existing layout (VS Code / dockview edge-drop). This
    // is what makes "take one of 3 stacked rows and put it as a full 2nd column" work.
    func moveToRoot(_ panel: DockPanel, direction: DockDir) {
        guard direction != .center else { return }
        let from = panel.group
        if from === activeGroup && (from?.panels.count ?? 0) <= 1 && groups.count == 1 { return }
        from?.remove(panel, dispose: false)
        // move()와 같은 순서: 비워진 그룹을 먼저 접어 공간을 돌려주고, 레이아웃을 확정한
        // 뒤에 트리를 재구성한다. 재구성 후에 정리하면 아직 프레임이 확정되지 않은
        // 형제들의 크기를 재게 되어 빈 영역이 남는다.
        cleanupEmpty(from)
        container.layoutSubtreeIfNeeded()
        let newGroup = DockGroup(); newGroup.manager = self
        guard let root = container.subviews.first(where: { !($0 is DockEmptyView) }) else {
            newGroup.add(panel); setRoot(newGroup); setActive(newGroup); refreshEmpty(); return
        }
        let vertical = (direction == .left || direction == .right)   // vertical divider ⇒ columns
        let before = (direction == .left || direction == .up)
        // Root already splits along this axis → prepend/append the new full-height
        // column (full-width row) to it directly and rebalance, instead of wrapping
        // the whole tree in ANOTHER same-axis split that hands the newcomer 50%.
        if let rsv = root as? NSSplitView, rsv.isVertical == vertical {
            newGroup.autoresizingMask = [.width, .height]
            rsv.layoutSubtreeIfNeeded()   // 프레임 확정 후에 크기를 잰다
            let oldExtents = rsv.arrangedSubviews.map { extent($0, in: rsv) }
            let at = before ? 0 : rsv.arrangedSubviews.count
            rsv.insertArrangedSubview(newGroup, at: at)
            rsv.adjustSubviews()
            rebalanceAfterInsert(rsv, insertedAt: at, oldExtents: oldExtents, sizeHint: nil)
            newGroup.add(panel); setActive(newGroup)
            normalizeTree()   // 옮긴 뒤 빈 그룹/빈 분할이 남지 않게 (move와 동일)
            refreshEmpty()
            return
        }
        let sv = DockSplitView(); sv.isVertical = vertical; sv.dividerStyle = .thin
        let frame = container.bounds
        root.removeFromSuperview(); root.autoresizingMask = [.width, .height]
        newGroup.autoresizingMask = [.width, .height]
        if before { sv.addArrangedSubview(newGroup); sv.addArrangedSubview(root) }
        else { sv.addArrangedSubview(root); sv.addArrangedSubview(newGroup) }
        sv.frame = frame; sv.autoresizingMask = [.width, .height]
        container.addSubview(sv, positioned: .below, relativeTo: container.subviews.first { $0 is DockEmptyView })
        sv.adjustSubviews()
        let t = vertical ? sv.bounds.width : sv.bounds.height
        if t > 0 { sv.setPosition(t * 0.5, ofDividerAt: 0) }
        newGroup.add(panel); setActive(newGroup)
        normalizeTree()   // 옮긴 뒤 빈 그룹/빈 분할이 남지 않게 (move와 동일)
        refreshEmpty()
    }
    // Should this drop split the ROOT (full-height column / full-width row)?
    // Only when the POINTER itself sits in a thin gutter along the container's outer
    // edge (dockview/VS Code's dedicated root drop band). Judging by whether the
    // target GROUP touches the container edge was wrong: with 3 full-width stacked
    // rows every group borders the left/right edges, so an ordinary "split this
    // group" drop escalated to a root split and re-columned the whole dock.
    func isRootEdgeDrop(from view: NSView, point: NSPoint, direction: DockDir) -> Bool {
        let p = view.convert(point, to: container)
        let b = container.bounds
        let band: CGFloat = 16
        switch direction {
        case .left:   return p.x <= b.minX + band
        case .right:  return p.x >= b.maxX - band
        case .up:     return p.y >= b.maxY - band   // non-flipped: top = high y
        case .down:   return p.y <= b.minY + band
        case .center: return false
        }
    }

    func removePanel(_ panel: DockPanel) {
        let t0 = DispatchTime.now()
        defer {
            if DockManager.closeBench {
                let ms = Double(DispatchTime.now().uptimeNanoseconds - t0.uptimeNanoseconds) / 1e6
                RLog.log(String(format: "CLOSE 총 %.1fms (%@)", ms, panel.id))
            }
        }
        let g = panel.group
        // If closing this empties its group (the group will be removed), focus the
        // ADJACENT pane - the previous sibling, else the next - not `groups.first`.
        // e.g. ⌘D ×N then ⌘W should land on the pane opened just before, not pane 1.
        let focusAfter: DockGroup? = (g?.panels.count == 1) ? adjacentGroup(to: g!) : nil
        func phase(_ name: String, _ body: () -> Void) {
            guard DockManager.closeBench else { body(); return }
            let s = DispatchTime.now(); body()
            let ms = Double(DispatchTime.now().uptimeNanoseconds - s.uptimeNanoseconds) / 1e6
            RLog.log(String(format: "CLOSE   %@ %.1fms", name, ms))
        }
        phase("remove") { g?.remove(panel, dispose: true) }
        // 형제 크기를 재기 전에 프레임을 확정한다 - 확정 전 값(0)으로 비례 재분배하면
        // 닫은 자리가 공백으로 남는다 (move/moveToRoot에서 고친 것과 같은 원인).
        phase("layout") { container.layoutSubtreeIfNeeded() }
        phase("cleanupEmpty") { cleanupEmpty(g) }
        normalizeTree()   // 닫기 후 빈 그룹·0폭 팬이 남지 않게 정리 (#3)
        phase("refreshEmpty") { refreshEmpty() }
        phase("focus") {
            if let t = focusAfter, t.isDescendant(of: container), !t.panels.isEmpty {
                setActive(t)
            } else {
                focusSurvivor()   // fallback: don't leave the app focus-less
            }
        }
    }

    // The group spatially adjacent to `g` in its parent split - previous sibling first,
    // then next; a sibling that is a nested split resolves to its first leaf group.
    private func adjacentGroup(to g: DockGroup) -> DockGroup? {
        guard let sv = g.superview as? NSSplitView,
              let idx = sv.arrangedSubviews.firstIndex(of: g) else { return nil }
        for j in [idx - 1, idx + 1] where j >= 0 && j < sv.arrangedSubviews.count {
            if let grp = firstGroup(in: sv.arrangedSubviews[j]) { return grp }
        }
        return nil
    }
    private func firstGroup(in v: NSView) -> DockGroup? {
        if let g = v as? DockGroup { return g }
        if let sv = v as? NSSplitView {
            for c in sv.arrangedSubviews { if let g = firstGroup(in: c) { return g } }
        }
        return nil
    }

    // 닫기/분리 뒤의 안전망 (#3): cleanupEmpty는 방금 비워진 그룹만 국소적으로
    // 정리하므로, 트리 어딘가에 남은 빈 그룹(내용 없는 블록)과 0폭으로 짜부라진
    // 팬(비례 재분배는 0을 0으로 유지한다)을 전체 스윕으로 마저 고친다.
    static let closeBench = ProcessInfo.processInfo.environment["RIVEN_CLOSEBENCH"] != nil
    func normalizeTree() {
        let n0 = DispatchTime.now()
        defer {
            if DockManager.closeBench {
                let ms = Double(DispatchTime.now().uptimeNanoseconds - n0.uptimeNanoseconds) / 1e6
                RLog.log(String(format: "CLOSE   normalizeTree %.1fms", ms))
            }
        }
        container.layoutSubtreeIfNeeded()   // 크기를 재기 전에 프레임 확정
        var again = true
        while again {
            again = false
            // 1) 빈 그룹은 어디에 있든 접는다 - cleanupEmpty가 붕괴/승격까지 처리한다.
            for g in groups where g.panels.isEmpty && g.superview is NSSplitView {
                container.layoutSubtreeIfNeeded()   // 형제 크기를 재기 전에 프레임 확정
                cleanupEmpty(g); again = true; break
            }
            if again { continue }
            // 2) 자식이 모두 빠져나간 split은 자리를 차지한 채 남아 그 영역이 통째로
            //    공백이 된다(3열을 전부 다른 그룹으로 옮겼을 때). 제거하고 형제들이
            //    그 공간을 나눠 갖게 한다. 자식이 하나만 남았으면 그 자식을 승격한다.
            for sv in allSplits() {
                // 그룹도 split도 아닌 뷰가 팬으로 남아 있으면(정리 도중의 잔재) 자리를
                // 차지한 채 아무것도 그리지 않아 빈 영역이 된다 → 제거.
                if let stray = sv.arrangedSubviews.first(where: { !($0 is DockGroup) && !($0 is NSSplitView) }) {
                    let sibs = sv.arrangedSubviews.filter { $0 !== stray }.map { extent($0, in: sv) }
                    stray.removeFromSuperview()
                    if sv.arrangedSubviews.count >= 2 { redistribute(sv, oldExtents: sibs) }
                    again = true; break
                }
                if sv.arrangedSubviews.isEmpty {
                    if let psv = sv.superview as? NSSplitView {
                        let sibs = psv.arrangedSubviews.filter { $0 !== sv }.map { extent($0, in: psv) }
                        sv.removeFromSuperview()
                        if psv.arrangedSubviews.count >= 2 { redistribute(psv, oldExtents: sibs) }
                    } else { sv.removeFromSuperview() }
                    again = true; break
                }
                if sv.arrangedSubviews.count == 1, let only = sv.arrangedSubviews.first {
                    let frame = sv.frame
                    only.removeFromSuperview()
                    only.frame = frame; only.autoresizingMask = [.width, .height]
                    if let psv = sv.superview as? NSSplitView {
                        let idx = psv.arrangedSubviews.firstIndex(of: sv) ?? 0
                        let exts = psv.arrangedSubviews.map { extent($0, in: psv) }
                        sv.removeFromSuperview()
                        psv.insertArrangedSubview(only, at: idx)
                        setExtents(psv, exts)          // 바깥 형제 자리는 그대로
                    } else if let p = sv.superview {
                        sv.removeFromSuperview(); p.addSubview(only)
                    }
                    again = true; break
                }
            }
        }
        guard let root = container.subviews.first(where: { !($0 is DockEmptyView) }) else { return }
        container.layoutSubtreeIfNeeded()
        fillGaps(root)
        ensureMinExtents(root)
        dumpTree("normalized")   // 레이아웃 이상 재발 시 즉시 원인 확인용 (디버그 로그)
    }

    // 각 split의 팬 크기 합이 컨테이너를 정확히 채우도록 다시 맞춘다. 구조 정리 뒤에도
    // divider 위치가 예전 값으로 남아 합이 모자라면 그만큼이 빈 영역으로 보인다.
    // (구조가 아니라 '크기'가 원인인 공백을 없애는 마지막 단계.)
    private func fillGaps(_ v: NSView) {
        guard let sv = v as? NSSplitView else { return }
        let n = sv.arrangedSubviews.count
        if n >= 2 {
            let minE: CGFloat = 80
            let total = (sv.isVertical ? sv.bounds.width : sv.bounds.height) - CGFloat(n - 1) * sv.dividerThickness
            if total > minE {
                func measure() -> [CGFloat] { sv.arrangedSubviews.map { extent($0, in: sv) } }
                func broken(_ e: [CGFloat]) -> Bool {
                    e.contains { $0 < minE - 1 } || abs(e.reduce(0, +) - total) > 1
                }
                // 1단계: NSSplitView가 스스로 재분배하게 둔다. 구조가 막 바뀐 직후에는
                // 우리가 계산한 divider 위치가 제약에 걸려 그대로 반영되지 않는데,
                // adjustSubviews는 뷰가 자기 상태 기준으로 다시 채운다.
                if broken(measure()) {
                    sv.adjustSubviews()
                    sv.layoutSubtreeIfNeeded()
                }
                // 2단계: 그래도 0폭이거나 컨테이너를 못 채우면 균등 분배로 확정한다.
                // 사용자가 맞춰둔 비율은 잃지만, 빈 영역/0폭 열이 남는 것보다 낫다.
                if broken(measure()) {
                    setExtents(sv, Array(repeating: total / CGFloat(n), count: n))
                    sv.layoutSubtreeIfNeeded()
                }
            }
        }
        for c in sv.arrangedSubviews { c.layoutSubtreeIfNeeded(); fillGaps(c) }
    }
    // 현재 트리 상태를 디버그 로그로 남긴다 (레이아웃 이상 재발 시 원인 추적용).
    /// 레이아웃 이상을 쫓을 때만 켠다. 예전에는 패널을 닫거나 옮길 때마다 트리 전체를
    /// 문자열로 만들어 로그 파일에 적었다 - 눈에 보이는 값은 없고 비용만 있었다.
    static let treeDump = ProcessInfo.processInfo.environment["RIVEN_DOCKDUMP"] != nil

    func dumpTree(_ label: String) {
        guard DockManager.treeDump || DockManager.closeBench else { return }
        let d0 = DispatchTime.now()
        defer {
            if DockManager.closeBench {
                let ms = Double(DispatchTime.now().uptimeNanoseconds - d0.uptimeNanoseconds) / 1e6
                RLog.log(String(format: "CLOSE     dumpTree %.1fms", ms))
            }
        }
        func walk(_ v: NSView, _ d: Int) -> String {
            let pad = String(repeating: "  ", count: d)
            if let sv = v as? NSSplitView {
                let exts = sv.arrangedSubviews.map { Int(extent($0, in: sv)) }
                var out = "\(pad)split[\(sv.isVertical ? "H" : "V")] \(exts) frame=\(Int(sv.frame.width))x\(Int(sv.frame.height))\n"
                for c in sv.arrangedSubviews { out += walk(c, d + 1) }
                return out
            }
            if let g = v as? DockGroup {
                let ids = g.panels.map { $0.id }.joined(separator: ",")
                return "\(pad)group[\(ids.isEmpty ? "<EMPTY>" : ids)] \(Int(v.frame.width))x\(Int(v.frame.height))\n"
            }
            return "\(pad)STRAY \(type(of: v)) \(Int(v.frame.width))x\(Int(v.frame.height))\n"
        }
        guard let root = container.subviews.first(where: { !($0 is DockEmptyView) }) else { return }
        RLog.log("dock[\(label)] container=\(Int(container.bounds.width))x\(Int(container.bounds.height))\n" + walk(root, 0))
    }

    // 트리 안의 모든 NSSplitView (중첩 포함).
    private func allSplits(_ from: NSView? = nil) -> [NSSplitView] {
        var out: [NSSplitView] = []
        for c in (from ?? container).subviews {
            if let sv = c as? NSSplitView { out.append(sv); out += allSplits(sv) }
            else if !(c is DockGroup) { out += allSplits(c) }
        }
        return out
    }

    // 어떤 split의 팬이 사실상 0폭이면 최소 폭(80)으로 살리고, 부족분은 큰 팬들이
    // 비율대로 내놓는다 (붙어 있는 divider의 최소 제약과 같은 값).
    private func ensureMinExtents(_ v: NSView) {
        guard let sv = v as? NSSplitView else { return }
        let n = sv.arrangedSubviews.count
        let minE: CGFloat = 80
        if n >= 2 {
            let total = (sv.isVertical ? sv.bounds.width : sv.bounds.height) - CGFloat(n - 1) * sv.dividerThickness
            let exts = sv.arrangedSubviews.map { extent($0, in: sv) }
            if total > minE * CGFloat(n), exts.contains(where: { $0 < minE - 1 }) {
                var target = exts
                var need: CGFloat = 0
                for i in target.indices where target[i] < minE { need += minE - target[i]; target[i] = minE }
                let bigSum = exts.enumerated().filter { target[$0.offset] > minE }.map { $0.element }.reduce(0, +)
                if bigSum > 0 {
                    for i in target.indices where target[i] > minE { target[i] -= need * exts[i] / bigSum }
                }
                setExtents(sv, target)
            }
        }
        for c in sv.arrangedSubviews { c.layoutSubtreeIfNeeded(); ensureMinExtents(c) }
    }
    // After a close, make a group that still has panels active so its content takes
    // focus (via onActivePanel → onActivate). Prevents "focus vanished → ⌘W quits".
    func focusSurvivor() {
        // 트리에서 이미 떨어져 나간 그룹은 후보가 아니다 - 방금 비워져 제거된 그룹을
        // 그대로 활성으로 두면 링도 창 포커스도 어디에도 남지 않는다("포커스 사라짐").
        if let g = activeGroup, !g.panels.isEmpty, g.isDescendant(of: container) { setActive(g); return }
        if let g = groups.first(where: { !$0.panels.isEmpty }) { setActive(g) }
    }

    // Remove a panel from its group WITHOUT disposing it - used to move a shared
    // singleton panel (the editor) from one workspace's dock to another's.
    // `normalize`: 사용자가 패널을 닫거나 빼내는 경우 true - 닫기(removePanel)와 똑같이
    // 트리 전체를 정리해 빈 슬롯이 남지 않게 한다. 워크스페이스 전환처럼 싱글턴을 잠시
    // 옮기는 경우에는 false로 두어야 남은 팬 크기가 매 전환마다 흔들리지 않는다(#4).
    // 이 구분이 없어서 aux 패널(소스 컨트롤 등)을 닫으면 그 자리가 빈 영역으로 남았다.
    func detach(_ panel: DockPanel, normalize: Bool = false) {
        let g = panel.group
        g?.remove(panel, dispose: false)
        container.layoutSubtreeIfNeeded()
        cleanupEmpty(g)
        if normalize {
            normalizeTree()
            // 사용자가 닫은 경우(토글/메뉴)엔 removePanel과 똑같이 살아남은 팬으로 포커스를
            // 넘긴다. 예전엔 remove() 안의 setActive가 방금 빈 그룹을 활성으로 잡아둔 채
            // 끝나 활성 링과 창 포커스가 모두 사라졌다.
            focusSurvivor()
        }
        // NOTE: intentionally NO normalizeTree() here. detach runs on every workspace
        // switch (editor + each aux panel move out); a full-tree ensureMinExtents sweep
        // would resize the OUTGOING dock's surviving panes every time, so a workspace's
        // pane sizes drifted on each visit (#4). cleanupEmpty already handles the local
        // empty-group collapse. normalizeTree stays on the genuine-close path (removePanel).
        refreshEmpty()
    }

    // ---- 싱글턴 패널 위치 기억/복원 (#4) --------------------------------------
    // 워크스페이스 전환 시 분리된 싱글턴 패널의 마지막 자리 (panel id → 기록).
    // 독 자체가 워크스페이스마다 하나이므로 이 사전이 곧 워크스페이스별 기록이 된다.
    var savedPlacements: [String: DockPlacement] = [:]

    // 분리 직전의 자리를 기록한다. 반드시 detach보다 먼저 불러야 한다.
    func recordPlacement(of panel: DockPanel) {
        guard let g = panel.group, g.manager === self else { return }
        var pl = DockPlacement()
        pl.tabIndex = g.panels.firstIndex { $0 === panel } ?? 0
        if g.panels.count > 1 {   // 다른 패널과 탭을 공유하던 그룹
            pl.hostGroup = g
            pl.hostPanelIds = g.panels.filter { $0 !== panel }.map { $0.id }
        }
        if let sv = g.superview as? NSSplitView {
            pl.parentSplit = sv
            pl.vertical = sv.isVertical
            pl.extent = extent(g, in: sv)
            pl.parentExtents = sv.arrangedSubviews.map { extent($0, in: sv) }   // full snapshot for exact restore (#3)
            let idx = sv.arrangedSubviews.firstIndex(of: g) ?? 0
            pl.indexInSplit = idx
            if idx > 0 {
                let v = sv.arrangedSubviews[idx - 1]
                pl.prevView = v; pl.prevPanelIds = panelIds(in: v).filter { $0 != panel.id }
            }
            if idx + 1 < sv.arrangedSubviews.count {
                let v = sv.arrangedSubviews[idx + 1]
                pl.nextView = v; pl.nextPanelIds = panelIds(in: v).filter { $0 != panel.id }
            }
        }
        savedPlacements[panel.id] = pl
    }

    // 기록된 자리로 패널을 복원한다. 자리가 완전히 사라졌으면 false를 돌려주고
    // 호출자가 기본 위치로 붙인다 (충돌·크래시 없이 항상 안전하게 폴백).
    @discardableResult
    func restorePlacement(_ panel: DockPanel) -> Bool {
        guard let pl = savedPlacements.removeValue(forKey: panel.id) else { return false }
        // 빈 독이면 기억해 둔 자리(절반/사이드)로 되돌리지 않는다 - 옆자리가 전부 비어
        // 있어 화면 절반이 공백으로 남는다. addPanel의 전체 채우기 경로로 넘긴다.
        guard totalPanels > 0 else { return false }
        container.layoutSubtreeIfNeeded()
        // 1) 탭으로 있던 그룹이 아직 살아있으면 그 자리(탭 인덱스)로.
        if let host = resolveGroup(pl.hostGroup, pl.hostPanelIds) {
            host.insert(panel, at: pl.tabIndex)
            setActive(host); refreshEmpty(); return true
        }
        // 2) 부모 split이 살아있으면 원래 인덱스에 팬을 끼워 넣고 크기를 되살린다.
        if let sv = pl.parentSplit, sv.isDescendant(of: container) {
            let g = DockGroup(); g.manager = self
            insertPane(g, into: sv, at: pl.indexInSplit, extent: pl.extent)
            // 형제까지 기록된 정확한 크기로 되돌린다 - 팬이 나갔다 들어올 때 비례 재분배가
            // 미세하게 어긋나 왕복마다 조금씩 줄어들던 문제(#3)를 없앤다. 구조가 그대로면
            // (개수 일치) 스냅샷을 그대로 적용, 아니면 위의 비례 결과를 유지.
            if pl.parentExtents.count == sv.arrangedSubviews.count {
                setExtents(sv, pl.parentExtents)
            }
            g.add(panel); setActive(g); refreshEmpty(); return true
        }
        // 3) split이 붕괴됐으면 이웃(형제)을 찾아 그 옆에 복원한다. 이웃 뷰가 죽었으면
        //    그 안에 있던 패널 id로 현재 그룹을 추적한다.
        if let (anchor, before) = resolveAnchor(pl) {
            let g = DockGroup(); g.manager = self
            if let asv = anchor.superview as? NSSplitView, asv.isVertical == pl.vertical {
                // 같은 축의 split이 이미 있으면 중첩하지 말고 형제로 끼워 넣는다.
                let ai = asv.arrangedSubviews.firstIndex(of: anchor) ?? 0
                insertPane(g, into: asv, at: before ? ai : ai + 1, extent: pl.extent)
            } else {
                splitBeside(anchor, with: g, vertical: pl.vertical, before: before, extent: pl.extent)
            }
            g.add(panel); setActive(g); refreshEmpty(); return true
        }
        return false
    }

    private func resolveGroup(_ weakG: DockGroup?, _ panelIds: [String]) -> DockGroup? {
        if let g = weakG, g.isDescendant(of: container) { return g }
        for id in panelIds { if let g = panel(id: id)?.group, g.isDescendant(of: container) { return g } }
        return nil
    }
    private func resolveAnchor(_ pl: DockPlacement) -> (NSView, Bool)? {
        if let v = pl.prevView, v.isDescendant(of: container) { return (v, false) }   // 그 뒤에
        if let v = pl.nextView, v.isDescendant(of: container) { return (v, true) }    // 그 앞에
        for id in pl.prevPanelIds { if let g = panel(id: id)?.group, g.isDescendant(of: container) { return (g, false) } }
        for id in pl.nextPanelIds { if let g = panel(id: id)?.group, g.isDescendant(of: container) { return (g, true) } }
        return nil
    }
    private func panelIds(in v: NSView) -> [String] {
        collect(v).flatMap { $0.panels.map { $0.id } }
    }

    // split의 idx 자리에 새 팬을 끼워 넣고 기록된 extent를 되살린다. 나머지 형제는
    // 남은 공간을 원래 비율대로 나눠 갖는다.
    private func insertPane(_ g: DockGroup, into sv: NSSplitView, at index: Int, extent want: CGFloat) {
        let olds = sv.arrangedSubviews.map { extent($0, in: sv) }
        let idx = max(0, min(index, sv.arrangedSubviews.count))
        g.autoresizingMask = [.width, .height]
        sv.insertArrangedSubview(g, at: idx)
        sv.adjustSubviews()
        let n = sv.arrangedSubviews.count
        let total = (sv.isVertical ? sv.bounds.width : sv.bounds.height) - CGFloat(n - 1) * sv.dividerThickness
        guard total > 0, n >= 2 else { return }
        let e = min(max(80, want), max(80, total - CGFloat(n - 1) * 80))
        let sum = olds.reduce(0, +)
        var target: [CGFloat] = olds.map { sum > 0 ? $0 * (total - e) / sum : (total - e) / CGFloat(max(1, olds.count)) }
        target.insert(e, at: idx)
        setExtents(sv, target)
    }

    // 임의의 이웃 뷰(그룹 또는 중첩 split)를 감싸 새 그룹과 나란히 놓는다 -
    // 복원 시 원래 분할 구조를 재현하기 위한 split()의 일반화 버전.
    private func splitBeside(_ anchor: NSView, with g: DockGroup, vertical: Bool, before: Bool, extent want: CGFloat) {
        guard let parent = anchor.superview else { return }
        let sv = DockSplitView(); sv.isVertical = vertical; sv.dividerStyle = .thin
        let savedFrame = anchor.frame
        anchor.autoresizingMask = [.width, .height]
        g.autoresizingMask = [.width, .height]
        if let psv = parent as? NSSplitView {
            let idx = psv.arrangedSubviews.firstIndex(of: anchor) ?? 0
            let pExtents = psv.arrangedSubviews.map { extent($0, in: psv) }
            anchor.removeFromSuperview()
            if before { sv.addArrangedSubview(g); sv.addArrangedSubview(anchor) }
            else { sv.addArrangedSubview(anchor); sv.addArrangedSubview(g) }
            psv.insertArrangedSubview(sv, at: idx)
            psv.adjustSubviews()
            setExtents(psv, pExtents)   // 바깥 형제들의 자리는 그대로 유지
        } else {
            anchor.removeFromSuperview()
            sv.frame = savedFrame; sv.autoresizingMask = [.width, .height]
            if before { sv.addArrangedSubview(g); sv.addArrangedSubview(anchor) }
            else { sv.addArrangedSubview(anchor); sv.addArrangedSubview(g) }
            parent.addSubview(sv)
        }
        sv.adjustSubviews()
        let t = vertical ? sv.bounds.width : sv.bounds.height
        guard t > 0 else { return }
        let e = min(max(80, want), max(80, t - 80 - sv.dividerThickness))
        sv.setPosition(before ? e : t - e - sv.dividerThickness, ofDividerAt: 0)
    }

    // ---- 세션 저장/복원: 독 레이아웃 전체 스냅샷 --------------------------------
    // 스플릿 트리(축/각 팬의 크기)와 그룹(탭 구성/활성 탭)을 JSON-안전한 사전으로
    // 직렬화한다 (Settings가 JSONSerialization으로 저장하므로 값은 String/Int/Double/
    // Bool/배열/사전만). 패널 서술자: 터미널(id가 term-)은 "term:<에이전트 이름, 없으면
    // 빈 문자열>" - id 자체는 실행마다 달라져 의미가 없고 "무엇을 띄웠는지"만 기록한다.
    // 싱글턴(editor/search/git/preview/changes)은 id 그대로.
    func snapshot() -> [String: Any]? {
        guard let root = container.subviews.first(where: { !($0 is DockEmptyView) }) else { return nil }
        container.layoutSubtreeIfNeeded()   // 크기를 재기 전에 프레임 확정 (stale 프레임 금지)
        return snapshotNode(root)
    }
    private func snapshotNode(_ v: NSView) -> [String: Any]? {
        if let g = v as? DockGroup {
            guard !g.panels.isEmpty else { return nil }      // 빈 그룹은 저장하지 않는다
            let descs = g.panels.map { p -> String in
                // Native chat panes persist their session id so they resume on relaunch.
                if p.id.hasPrefix("chat-") {
                    // "chat:<sid>\t<nickname>\t<agent>\t<group>\t<parent>\t<model>\t<avatar>" - tabs
                    // are safe (ids/names can't contain them) and every shorter/older form still parses.
                    // and the old "chat:<sessionId>" form still parses.
                    // Always carry the role, even before the CLI has handed us a session id - a
                    // freshly created group saved at that moment used to come back as anonymous panes.
                    let sid = p.sessionId ?? ""
                    let nick = p.chatNickname ?? "", agent = p.chatAgent ?? ""
                    let group = p.chatGroup ?? "", parent = p.chatParent ?? ""
                    let model = p.chatModel ?? "", avatar = p.chatAvatar ?? ""
                    // 여덟 번째 칸: 어느 CLI 인가. Claude 는 빈 칸으로 둬서 예전 스냅샷과
                    // 바이트가 같게 유지된다 (읽는 쪽에서 빈 칸 = claude).
                    let kind = p.chatKind == .claude ? "" : p.chatKind.rawValue
                    if sid.isEmpty && nick.isEmpty && agent.isEmpty && group.isEmpty && model.isEmpty
                        && avatar.isEmpty && kind.isEmpty { return "chat" }
                    return "chat:\(sid)\t\(nick)\t\(agent)\t\(group)\t\(parent)\t\(model)\t\(avatar)\t\(kind)"
                }
                guard p.id.hasPrefix("term-") else { return p.id }
                // "term:<agent>" plus, if we own a resumable session id, "\t<sessionId>".
                let base = "term:\(p.agentName ?? "")"
                return p.sessionId.map { "\(base)\t\($0)" } ?? base
            }
            return ["type": "group", "panels": descs, "active": g.activeIndex]
        }
        guard let sv = v as? NSSplitView else { return nil }
        var children: [[String: Any]] = []
        var extents: [Double] = []
        for c in sv.arrangedSubviews {
            guard let node = snapshotNode(c) else { continue }   // 빈 자식은 건너뛴다
            children.append(node)
            extents.append(Double(extent(c, in: sv)))            // children과 1:1 정렬 유지
        }
        if children.isEmpty { return nil }
        if children.count == 1 { return children[0] }   // 자식 하나 → 무의미한 스플릿 없이 승격
        return ["type": "split", "vertical": sv.isVertical, "extents": extents, "children": children]
    }

    // 스냅샷으로 트리를 재구성한다. makePanel은 서술자 → 실제 패널(터미널 생성 /
    // 싱글턴 부착, main.swift가 공급); nil을 돌려주면(예: 더 이상 설치돼 있지 않은
    // 에이전트) 그 패널만 건너뛰고 나머지는 그대로 짓는다. 아무것도 못 지으면 false -
    // 호출자가 기본 레이아웃으로 폴백한다.
    @discardableResult
    func restore(_ snap: [String: Any], makePanel: (String) -> DockPanel?) -> Bool {
        guard let built = buildNode(snap, makePanel: makePanel) else { return false }
        container.subviews.filter { !($0 is DockEmptyView) }.forEach { $0.removeFromSuperview() }
        let root = built.view
        root.frame = container.bounds
        root.autoresizingMask = [.width, .height]
        container.addSubview(root, positioned: .below, relativeTo: emptyView)
        // 저장된 extents는 비율로 적용한다 - 창 크기가 그때와 다를 수 있다. 반드시
        // 프레임이 실제 크기를 가진 뒤에 재고/적용해야 한다: 갓 삽입된 트리에 stale
        // 프레임인 채 setPosition하면 팬이 짜부라진다 (#3에서 배운 순서).
        container.layoutSubtreeIfNeeded()
        applyRatios(built)
        normalizeTree()
        refreshEmpty()
        if let g = groups.first(where: { !$0.panels.isEmpty }) { setActive(g) }
        return true
    }
    // 복원 중간 표현: 뷰와 함께 "실제로 지은" 자식·extents를 들고 다닌다 - 스냅샷의
    // 일부 패널이 빠져도(에이전트 소멸) 크기를 엉뚱한 자식에 적용하지 않기 위해.
    private enum BuiltNode {
        case group(DockGroup)
        case split(DockSplitView, extents: [CGFloat], children: [BuiltNode])
        var view: NSView { switch self { case .group(let g): return g; case .split(let sv, _, _): return sv } }
    }
    private func buildNode(_ snap: [String: Any], makePanel: (String) -> DockPanel?) -> BuiltNode? {
        switch snap["type"] as? String {
        case "group":
            let g = DockGroup(); g.manager = self
            for desc in snap["panels"] as? [String] ?? [] {
                guard let p = makePanel(desc) else { continue }   // 못 만든 패널은 건너뛴다
                g.add(p)
            }
            guard !g.panels.isEmpty else { return nil }
            let active = snap["active"] as? Int ?? 0
            if g.panels.indices.contains(active) { g.select(id: g.panels[active].id) }
            return .group(g)
        case "split":
            let childSnaps = snap["children"] as? [[String: Any]] ?? []
            let saved = (snap["extents"] as? [Double])?.map { CGFloat($0) } ?? []
            var kids: [BuiltNode] = []
            var kidExtents: [CGFloat] = []
            for (i, cs) in childSnaps.enumerated() {
                guard let k = buildNode(cs, makePanel: makePanel) else { continue }
                kids.append(k)
                kidExtents.append(i < saved.count ? saved[i] : 0)
            }
            if kids.isEmpty { return nil }
            if kids.count == 1 { return kids[0] }   // 자식 하나만 살아남으면 스플릿 없이 승격
            let sv = DockSplitView(); sv.isVertical = (snap["vertical"] as? Bool) ?? true
            sv.dividerStyle = .thin
            for k in kids {
                k.view.autoresizingMask = [.width, .height]
                sv.addArrangedSubview(k.view)
            }
            // 자식이 하나라도 빠졌으면 저장된 크기 배열은 더 이상 맞지 않는다 → 기본 분배.
            let usable = (kids.count == childSnaps.count && saved.count == childSnaps.count) ? kidExtents : []
            return .split(sv, extents: usable, children: kids)
        default:
            return nil
        }
    }
    // 저장된 extents를 현재 크기에 대한 비율로 환산해 적용 (루트부터 재귀). 부모의
    // setPosition이 자식 프레임을 바꾸므로, 자식으로 내려가기 전에 레이아웃을 확정한다
    // (distributeEvenly와 같은 순서).
    private func applyRatios(_ node: BuiltNode) {
        guard case .split(let sv, let saved, let children) = node else { return }
        let n = sv.arrangedSubviews.count
        if saved.count == n, n >= 2 {
            let total = (sv.isVertical ? sv.bounds.width : sv.bounds.height) - CGFloat(n - 1) * sv.dividerThickness
            let sum = saved.reduce(0, +)
            if total > 0, sum > 0 { setExtents(sv, saved.map { $0 * total / sum }) }
        }
        for c in children { c.view.layoutSubtreeIfNeeded(); applyRatios(c) }
    }

    // While a tab is being dragged, cover every group with a transparent drop zone
    // (above the panel content, which would otherwise swallow the drag - WKWebView
    // and the Metal terminal don't forward dragging to their host group).
    func beginDrag() { groups.forEach { $0.showDropZone() } }
    func endDrag() { groups.forEach { $0.hideDropZone() } }

    // Collapse an emptied group: remove it, redistribute its freed space to the
    // sibling panes proportionally (tiling-terminal close: neighbors absorb the
    // space, no gaps / lopsided leftovers), and if its split parent is left with a
    // single child, hoist that child into the grandparent (keeps the tree tidy)
    // while preserving the exact slot the split occupied.
    func cleanupEmpty(_ group: DockGroup?) {
        guard let group, group.panels.isEmpty, let parent = group.superview else { return }
        guard let sv = parent as? NSSplitView else { return }  // never remove the root group
        // Capture sibling extents BEFORE removal so the freed space can be handed
        // out proportionally instead of whatever NSSplitView's implicit resize does.
        let siblingExtents = sv.arrangedSubviews.filter { $0 !== group }.map { extent($0, in: sv) }
        group.removeFromSuperview()
        if sv.arrangedSubviews.count >= 2 {
            redistribute(sv, oldExtents: siblingExtents)
            return
        }
        guard let survivor = sv.arrangedSubviews.first else { return }
        let grandparent = sv.superview
        let frame = sv.frame
        if let gsv = grandparent as? NSSplitView {
            // Record the grandparent's pane extents with sv still in place: the
            // survivor must take over EXACTLY sv's slot, so the outer siblings
            // don't shift at all on close.
            let idx = gsv.arrangedSubviews.firstIndex(of: sv) ?? 0
            let gExtents = gsv.arrangedSubviews.map { extent($0, in: gsv) }
            survivor.removeFromSuperview()
            survivor.frame = frame                     // pre-size to sv's slot…
            survivor.autoresizingMask = [.width, .height]
            sv.removeFromSuperview()
            gsv.insertArrangedSubview(survivor, at: idx)
            setExtents(gsv, gExtents)                  // …and pin every divider back
        } else if let gp = grandparent {
            survivor.removeFromSuperview()
            survivor.frame = frame; survivor.autoresizingMask = [.width, .height]
            sv.removeFromSuperview(); gp.addSubview(survivor)
        }
    }
}

// A tabbed group: a 30px dock-tab bar over the active panel's content. Acts as a
// drag destination so panels can be dropped in (tab) or on an edge (split).
final class DockGroup: NSView, Scalable {
    private(set) var panels: [DockPanel] = []
    private(set) var activeIndex = 0
    let tabBar = DockTabBar()
    let content = NSView()
    weak var manager: DockManager?
    private var dropZone: DockDropZone?
    var activePanel: DockPanel? { panels.indices.contains(activeIndex) ? panels[activeIndex] : nil }
    override var mouseDownCanMoveWindow: Bool { false }

    // The focused group gets an ember inset ring (riven's active-group frame) so
    // it's clear which panel keyboard shortcuts act on.
    // riven/dockview shows the focused group NOT with a border box, but by keeping
    // its active tab bright (accent underline + full-strength text) while inactive
    // groups' tabs dim. So just repaint the tab bar when active-ness changes.
    var isActiveGroup = false {
        didSet {
            guard isActiveGroup != oldValue else { return }
            // The focused group gets a subtle ember border (riven's active-group frame)
            // AND its active tab brightens (tab bar rebuild).
            // riven's .dv-active-group::after - an inset accent ring drawn ON TOP of the
            // content (a layer border on the group is hidden behind the panel content).
            borderOverlay.isHidden = !isActiveGroup
            tabBar.rebuild()
        }
    }
    // Non-interactive overlay carrying the active-group ring so it's never covered by
    // the panel content (WKWebView / Metal). Passes mouse events through.
    private let borderOverlay: PassthroughView = {
        let v = PassthroughView(); v.wantsLayer = true; v.isHidden = true
        v.layer?.borderWidth = 1
        v.layer?.borderColor = Theme.accent.withAlphaComponent(0.55).cgColor
        v.layer?.cornerRadius = 4
        return v
    }()

    // UI 배율을 따라간다 - 30 고정이던 시절엔 ⌘+로 글꼴만 커져서 탭 글자가 바 안에 갇혔다.
    static var tabBarHeight: CGFloat { UIScale.pt(30) }

    override init(frame: NSRect) {
        super.init(frame: frame)
        wantsLayer = true
        layer?.backgroundColor = Theme.bg.cgColor
        tabBar.group = self
        addSubview(tabBar); addSubview(content)
        addSubview(borderOverlay)   // always on top
        // Manual frame layout (see layout()) - deterministic, no constraint-timing
        // gaps that left `content` at zero size while a terminal surface was created.
        UIScale.register(self)
    }
    required init?(coder: NSCoder) { fatalError() }

    /// ⌘+/- 로 배율이 바뀌면 탭 높이·폰트가 함께 커져야 한다 (탭을 다시 만들고 재배치).
    func applyScale() { tabBar.rebuild(); needsLayout = true; layout() }

    // Drop zones cover the content during a drag so panel content (WKWebView /
    // Metal) can't swallow the drop. Added by the manager on drag start.
    func showDropZone() {
        hideDropZone()
        let z = DockDropZone(); z.group = self
        // Cover the WHOLE group (tab bar included) so a drop anywhere over the group -
        // not just its content area - registers (merging two panels was easy to miss
        // when the 30px tab strip wasn't a drop target).
        z.frame = bounds; z.autoresizingMask = [.width, .height]
        addSubview(z)   // topmost, above tabBar + content
        dropZone = z
    }
    func hideDropZone() { dropZone?.removeFromSuperview(); dropZone = nil }

    // Keep the active panel's content filling the content area. Panels are added
    // before the group has its real size (and the group is reparented between
    // workspaces), so frame-follow here is more reliable than autoresizing alone.
    // Non-flipped NSView: y=0 is the bottom, so the tab bar sits at the top (high y)
    // and the content fills below it.
    override func layout() {
        super.layout()
        let b = bounds
        tabBar.frame = NSRect(x: 0, y: b.height - DockGroup.tabBarHeight, width: b.width, height: DockGroup.tabBarHeight)
        content.frame = NSRect(x: 0, y: 0, width: b.width, height: max(0, b.height - DockGroup.tabBarHeight))
        // 숨겨 둔 팬도 같은 크기로 맞춰 둔다. 다시 보일 때 크기가 어긋난 채 한 프레임
        // 그려지지 않도록 (붙여 둔 채 숨기는 구조라 레이아웃이 자동으로 따라오지 않는다).
        for p in panels where p.content.superview === content { p.content.frame = content.bounds }
        dropZone?.frame = b
        borderOverlay.frame = b
    }

    func add(_ panel: DockPanel) {
        panel.group = self
        if !panels.contains(where: { $0.id == panel.id }) { panels.append(panel) }
        activeIndex = panels.firstIndex { $0.id == panel.id } ?? max(0, panels.count - 1)
        showActive(); tabBar.rebuild()
        manager?.refreshEmpty()   // any add path (incl. the default terminal via g.add) updates the empty overlay
    }
    // add와 같지만 탭을 특정 위치에 끼워 넣는다 - 워크스페이스 복귀 시 싱글턴
    // 패널의 탭 순서까지 복원하기 위해 (#4).
    func insert(_ panel: DockPanel, at index: Int) {
        panel.group = self
        if !panels.contains(where: { $0.id == panel.id }) {
            panels.insert(panel, at: max(0, min(index, panels.count)))
        }
        activeIndex = panels.firstIndex { $0.id == panel.id } ?? max(0, panels.count - 1)
        showActive(); tabBar.rebuild()
        manager?.refreshEmpty()
    }
    func remove(_ panel: DockPanel, dispose: Bool) {
        guard let idx = panels.firstIndex(where: { $0.id == panel.id }) else { return }
        let wasActive = idx == activeIndex
        func step(_ name: String, _ body: () -> Void) {
            guard DockManager.closeBench else { body(); return }
            let s = DispatchTime.now(); body()
            let ms = Double(DispatchTime.now().uptimeNanoseconds - s.uptimeNanoseconds) / 1e6
            RLog.log(String(format: "CLOSE     remove.%@ %.1fms", name, ms))
        }
        panels.remove(at: idx)
        // 닫힌 뷰는 감추기만 하고 실제로 떼는 건 다음 런루프로 미룬다. 떼는 순간 레이아웃
        // 엔진이 그 무거운 서브트리를 통째로 정리하느라 20~30ms 를 먹는데, 그 값을 클릭한
        // 순간에 치를 이유가 없다 (화면에는 이미 사라진 뒤다).
        step("detachView") {
            panel.content.isHidden = true
            let v = panel.content
            let oldContent = content   // this group's content view
            // 실제로 떼는 건 다음 런루프로 미룬다(닫을 때 무거운 서브트리 정리 비용을 클릭
            // 순간에 안 치르려고). 단, move() 는 그 사이 이 뷰를 새 그룹으로 옮겨 붙인다 —
            // 그때 지연됐던 이 제거가 터지면 새 그룹에서 뷰를 떼어 "패널 내부가 빈 화면"이
            // 됐다. 여전히 이 그룹의 content 에 붙어 있을 때만 뗀다 (옮겨졌으면 스킵).
            DispatchQueue.main.async { if v.superview === oldContent { v.removeFromSuperview() } }
        }
        if panel.group === self { panel.group = nil }
        step("onClose") { if dispose { panel.onClose?() } }
        let before = activeIndex
        activeIndex = min(activeIndex, panels.count - 1)
        // 보이던 탭을 닫았을 때만 다시 그린다. showActive 는 콘텐츠 뷰를 떼었다 붙이는데,
        // 채팅 기록이나 웹뷰가 든 팬은 그 재편입이 비싸다 - 뒤쪽 탭을 닫았을 뿐인데도
        // 매번 그 값을 치르고 있었다 (조직도 클릭 렉과 같은 원인).
        step("showActive") { if wasActive || activeIndex != before { showActive() } }
        step("tabBar") { tabBar.rebuild() }
        // 비어버린 그룹은 곧 트리에서 제거된다 - 여기서 활성으로 잡으면 호출자가 이웃으로
        // 포커스를 넘기기 전에 활성 링이 죽은 그룹에 묶인다. 남은 탭이 있을 때만 활성화.
        if !panels.isEmpty { manager?.setActive(self) }
        manager?.refreshEmpty()
    }
    func select(id: String) {
        guard let idx = panels.firstIndex(where: { $0.id == id }) else { return }
        // 이미 그 탭이면 화면을 다시 만들지 않는다. showActive 는 콘텐츠 뷰를 떼었다 붙이는데,
        // 채팅처럼 무거운 뷰는 그때마다 레이아웃 엔진에 통째로 다시 편입되어 100ms 넘게 든다.
        // (조직도에서 멤버 카드를 누를 때마다 렉이 걸리던 원인)
        if idx == activeIndex, activePanel?.content.superview === content {
            manager?.setActive(self)
            return
        }
        activeIndex = idx; showActive(); tabBar.rebuild(); manager?.setActive(self)
    }
    // 탭을 바꾸거나 닫을 때마다 콘텐츠 뷰를 떼었다 붙이면, 채팅 기록처럼 무거운 팬은 그
    // 재편입에만 70~100ms 가 든다 (탭 하나 닫는데 눈에 보이는 멈춤이 생긴다). 한 번 보여 준
    // 뷰는 계속 붙여 두고 보이기만 바꾼다 - 두 번째부터는 공짜다.
    // 아직 한 번도 안 보여 준 팬은 붙이지 않는다 (복원 직후 무거운 팬 여러 개를 한꺼번에
    // 붙이면 그만큼 기동이 느려진다).
    private func showActive() {
        // 이 그룹에서 빠져나간 뷰만 걷어낸다.
        let live = Set(panels.map { ObjectIdentifier($0.content) })
        for v in content.subviews where !live.contains(ObjectIdentifier(v)) && !(v is DockDropZone) {
            v.removeFromSuperview()
        }
        guard let p = activePanel else { return }
        if p.content.superview !== content {
            let v = p.content
            v.translatesAutoresizingMaskIntoConstraints = true
            v.frame = content.bounds
            v.autoresizingMask = [.width, .height]
            content.addSubview(v)
        }
        for other in panels where other !== p && other.content.superview === content {
            other.content.isHidden = true
        }
        p.content.isHidden = false
        // Keep the drop zone (if a drag is in progress) above the freshly shown content.
        if let z = dropZone { addSubview(z) }
        needsLayout = true          // frame the new content on the next layout pass
        if DockManager.closeBench {
            let s0 = DispatchTime.now(); p.onActivate?()
            let ms = Double(DispatchTime.now().uptimeNanoseconds - s0.uptimeNanoseconds) / 1e6
            RLog.log(String(format: "CLOSE       onActivate %.1fms attached=%@", ms,
                            p.content.superview === content ? "예" : "아니오"))
        } else { p.onActivate?() }
    }
}

// A transparent drop target laid over a group's content during a drag. Computes
// the drop region (center = add as tab; edge quarters = split) and, on drop, asks
// the manager to move the dragged panel here. Draws a translucent accent preview.
final class DockDropZone: NSView {
    weak var group: DockGroup?
    private var region: DockDir?             // nil = nothing shown yet
    // A single moved/resized overlay (dockview's `.dv-drop-target-selection`): it
    // slides + resizes between quadrants with a short ease-out instead of the old
    // draw-a-new-rect snap, so splitting reads as smooth.
    private let overlay = NSView()
    override init(frame: NSRect) {
        super.init(frame: frame); wantsLayer = true
        overlay.wantsLayer = true
        overlay.layer?.backgroundColor = Theme.accent.withAlphaComponent(0.28).cgColor
        overlay.layer?.borderColor = Theme.accent.withAlphaComponent(0.75).cgColor
        overlay.layer?.borderWidth = 1.5
        overlay.layer?.cornerRadius = 3
        overlay.isHidden = true
        addSubview(overlay)
        registerForDraggedTypes([dockPBType])
    }
    required init?(coder: NSCoder) { fatalError() }
    override func draggingEntered(_ s: NSDraggingInfo) -> NSDragOperation { update(s) }
    override func draggingUpdated(_ s: NSDraggingInfo) -> NSDragOperation { update(s) }
    override func draggingExited(_ s: NSDraggingInfo?) { hide() }
    private func hide() { overlay.isHidden = true; region = nil }
    private func update(_ s: NSDraggingInfo) -> NSDragOperation {
        guard DockManager.draggingPanel != nil else { return [] }
        let r = regionFor(convert(s.draggingLocation, from: nil))
        if r != region {
            region = r
            let target = frameFor(r)
            if overlay.isHidden { overlay.isHidden = false; overlay.frame = target }
            else {
                NSAnimationContext.runAnimationGroup { ctx in
                    ctx.duration = 0.09; ctx.allowsImplicitAnimation = true
                    ctx.timingFunction = CAMediaTimingFunction(name: .easeOut)
                    overlay.animator().frame = target
                }
            }
        }
        return .move
    }
    override func performDragOperation(_ s: NSDraggingInfo) -> Bool {
        guard let panel = DockManager.draggingPanel, let g = group else { return false }
        let pt = convert(s.draggingLocation, from: nil)
        let r = regionFor(pt)
        hide()
        // Root split (full-height column / full-width row) ONLY when the pointer is
        // in the container's thin outer gutter; every other edge drop splits/nests
        // WITHIN the target group's local container.
        if r != .center, let mgr = g.manager, mgr.isRootEdgeDrop(from: self, point: pt, direction: r) {
            mgr.moveToRoot(panel, direction: r)
        } else {
            g.manager?.move(panel, toGroup: g, region: r)
        }
        return true
    }
    // dockview's banded logic: fixed 20% edge bands, priority left→right→up→down,
    // center (drop-as-tab) is the whole middle 60% - bigger + direction is stable.
    private func regionFor(_ pt: NSPoint) -> DockDir {
        let w = bounds.width, h = bounds.height
        guard w > 0, h > 0 else { return .center }
        // 탭 바 위에 놓으면 언제나 "이 그룹의 탭으로 추가". 드롭존이 탭 바까지 덮는데
        // 탭 바는 그룹 최상단 한 줄이라 아래의 위쪽 가장자리 밴드(28%)에 항상 걸려서,
        // 탭에 떨어뜨려도 탭 추가가 아니라 위로 분할돼 버렸다.
        if pt.y >= h - DockGroup.tabBarHeight { return .center }
        let fx = pt.x / w, fy = pt.y / h, e: CGFloat = 0.28
        if fx < e { return .left }
        if fx > 1 - e { return .right }
        if fy > 1 - e { return .up }        // non-flipped: high fy = top
        if fy < e { return .down }
        return .center
    }
    private func frameFor(_ region: DockDir) -> NSRect {
        let b = bounds
        switch region {
        case .center: return b
        case .left:   return NSRect(x: b.minX, y: b.minY, width: b.width / 2, height: b.height)
        case .right:  return NSRect(x: b.midX, y: b.minY, width: b.width / 2, height: b.height)
        case .up:     return NSRect(x: b.minX, y: b.midY, width: b.width, height: b.height / 2)
        case .down:   return NSRect(x: b.minX, y: b.minY, width: b.width, height: b.height / 2)
        }
    }
}

// NSSplitView with draggable dividers (min 80px per pane) - its own delegate. The
// divider is a 6px grab strip (easy to hit, dockview-style) with a 1px hairline.
final class DockSplitView: NSSplitView, NSSplitViewDelegate {
    override init(frame: NSRect) { super.init(frame: frame); delegate = self; dividerStyle = .thin }
    required init?(coder: NSCoder) { fatalError() }
    override var mouseDownCanMoveWindow: Bool { false }   // divider drags must not move the window
    override func mouseDown(with event: NSEvent) {
        NotificationCenter.default.post(name: .rivenDividerDragBegan, object: nil)
        super.mouseDown(with: event)      // modal tracking loop: returns when the drag ends
        NotificationCenter.default.post(name: .rivenDividerDragEnded, object: nil)
    }
    override var dividerThickness: CGFloat { 6 }
    override func drawDivider(in rect: NSRect) {
        Theme.hairline.setFill()
        let line = isVertical
            ? NSRect(x: rect.midX - 0.5, y: rect.minY, width: 1, height: rect.height)
            : NSRect(x: rect.minX, y: rect.midY - 0.5, width: rect.width, height: 1)
        line.fill()
    }
    // Side-by-side (vertical divider) panes get a wider floor so content panels stay
    // usable when narrowed; stacked (horizontal divider) panes keep the smaller floor.
    private func minPane(_ v: NSSplitView) -> CGFloat { v.isVertical ? 140 : 80 }
    // 좌표는 split 전체 기준이므로 앞/뒤에 몇 개가 더 있는지까지 세어야 한다. 상수 하나만
    // 돌려주면 팬이 3개 이상일 때 두 번째 디바이더의 최소>최대가 되어(3열 = 140/63/134)
    // 균등 배치도 사용자의 드래그도 엉뚱한 곳에 붙는다.
    func splitView(_ v: NSSplitView, constrainMinCoordinate p: CGFloat, ofSubviewAt i: Int) -> CGFloat {
        let m = minPane(v)
        return CGFloat(i) * (m + v.dividerThickness) + m
    }
    func splitView(_ v: NSSplitView, constrainMaxCoordinate p: CGFloat, ofSubviewAt i: Int) -> CGFloat {
        let m = minPane(v), total = v.isVertical ? v.bounds.width : v.bounds.height
        let after = CGFloat(v.arrangedSubviews.count - 1 - i)
        // 자리가 근본적으로 모자라면 최소치를 지켜 범위가 뒤집히지 않게 한다.
        return max(CGFloat(i) * (m + v.dividerThickness) + m, total - after * (m + v.dividerThickness))
    }
    /// 나란히 놓을 수 있는 최대 열 수 (이보다 많으면 팬이 최소 폭에 걸려 쓸모없어진다).
    static func maxColumns(forWidth w: CGFloat) -> Int { max(1, Int(w / 150)) }
}

// riven's empty workbench (Workbench.tsx .dock-empty): shown when the dock holds no
// panels. A faint "riven" wordmark, a tagline, and two actions - add a terminal
// (accent-filled primary) or open the editor. Overlays the whole dock container.
final class DockEmptyView: NSView, Themable, Scalable {
    var onAddTerminal: (() -> Void)?
    var onOpenEditor: (() -> Void)?
    private let mark = NSTextField(labelWithString: "riven")
    private let tagline = NSTextField(labelWithString: t("empty.tagline"))
    private var addBtn: PadButton!
    private var editorBtn: PadButton!
    // Store + remove the observer token so it doesn't leak per recreation (#64).
    private var langObserver: NSObjectProtocol?
    deinit { if let o = langObserver { NotificationCenter.default.removeObserver(o) } }

    override init(frame: NSRect) {
        super.init(frame: frame)
        wantsLayer = true
        langObserver = NotificationCenter.default.addObserver(forName: .rivenLanguageChanged, object: nil, queue: .main) { [weak self] _ in
            self?.tagline.stringValue = t("empty.tagline")
            self?.addBtn.setTitle("  " + t("empty.addTerminal"))
            self?.editorBtn.setTitle("  " + t("empty.addEditor"))
        }

        // Faint oversized wordmark (riven: fg 22% blended into bg).
        mark.font = UIScale.font(44, .bold)
        mark.alignment = .center
        tagline.font = UIScale.font(UIScale.title)
        tagline.alignment = .center

        addBtn = PadButton(title: "  " + t("empty.addTerminal"), font: UIScale.font(UIScale.title),
                           textColor: Theme.accent, bg: Theme.accentMuted, border: Theme.accentBorder,
                           radius: 7, hPad: 14, height: 34)
        addBtn.onClick = { [weak self] in self?.onAddTerminal?() }
        editorBtn = PadButton(title: "  " + t("empty.addEditor"), font: UIScale.font(UIScale.title),
                              textColor: Theme.fg, bg: Theme.bg3, border: Theme.edge,
                              radius: 7, hPad: 14, height: 34)
        editorBtn.onClick = { [weak self] in self?.onOpenEditor?() }

        let actions = NSStackView(views: [addBtn, editorBtn])
        actions.orientation = .horizontal
        actions.spacing = 10

        let stack = NSStackView(views: [mark, tagline, actions])
        stack.orientation = .vertical
        stack.alignment = .centerX
        stack.spacing = 14
        stack.setCustomSpacing(20, after: tagline)
        stack.translatesAutoresizingMaskIntoConstraints = false
        addSubview(stack)
        NSLayoutConstraint.activate([
            stack.centerXAnchor.constraint(equalTo: centerXAnchor),
            stack.centerYAnchor.constraint(equalTo: centerYAnchor),
        ])
        applyTheme()
        Theme.register(self); UIScale.register(self)
    }
    required init?(coder: NSCoder) { fatalError() }

    func applyTheme() {
        layer?.backgroundColor = Theme.bg.cgColor
        // fg blended 22% into bg → a ghosted wordmark.
        mark.textColor = Theme.fg.blended(withFraction: 0.78, of: Theme.bg) ?? Theme.fgDim
        tagline.textColor = Theme.fgDim
    }
    func applyScale() { mark.font = UIScale.font(44, .bold); tagline.font = UIScale.font(UIScale.title) }
}
