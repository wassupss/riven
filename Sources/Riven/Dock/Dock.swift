import AppKit

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
    let icon: NSImage?
    let content: NSView
    let closable: Bool
    weak var group: DockGroup?
    var onClose: (() -> Void)?      // called when the tab's × is clicked
    var onActivate: (() -> Void)?   // called when this panel becomes visible
    var badge: String?              // nil | "busy" (violet) | "attn" (amber pulse)
    var autoTitle: Bool = false     // follow the shell's OSC title (plain terminals only)

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
    weak var prevView: NSView?          // 앞쪽(왼/위) 형제 — 살아있으면 그 뒤에 복원
    var prevPanelIds: [String] = []     // 앞쪽 형제가 죽었을 때 추적할 그 안의 패널 id들
    weak var nextView: NSView?          // 뒤쪽(오른/아래) 형제 — 살아있으면 그 앞에 복원
    var nextPanelIds: [String] = []
    var parentExtents: [CGFloat] = []   // parentSplit의 모든 팬 크기 스냅샷 (이 팬 포함) — 복원 시
                                        // 형제까지 정확히 되돌려 왕복 시 크기가 누적으로 줄지 않게 (#3)
}

// A container whose single child (the root group or split) always fills it —
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
    // ⌘⌥= — distribute all panes evenly (tmux's prefix+E / iTerm's arrange panes).
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
    // when the empty overlay is z-ordered above it — otherwise totalPanels read 0 and
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
    // extent — used for aux side panels (search/git/preview/changes) and the editor,
    // which shouldn't take a bare 1/N share. Without a hint the new pane gets a fair
    // 1/N of its container (see rebalanceAfterInsert).
    @discardableResult
    func addPanel(_ panel: DockPanel, reference: DockGroup? = nil, direction: DockDir? = nil,
                  sizeHint: CGFloat? = nil) -> DockGroup {
        if let ref = reference, let dir = direction, dir != .center {
            let g = DockGroup(); g.manager = self
            split(ref, with: g, direction: dir, sizeHint: sizeHint)
            g.add(panel); setActive(g); return g
        }
        let g = reference ?? activeGroup ?? {
            let g = DockGroup(); setRoot(g); return g
        }()
        g.add(panel); setActive(g); refreshEmpty(); return g
    }

    func setActive(_ g: DockGroup) {
        for grp in groups { grp.isActiveGroup = (grp === g) }
        activeGroup = g
        onActivePanel?(g.activePanel)
    }

    // Split `group` in `direction`, placing `newGroup` next to it.
    //
    // Natural sizing model (tmux/iTerm/VS Code-like):
    // • If the group's parent split already runs along this axis, DON'T nest another
    //   split — insert the new pane as a direct sibling (flat tree) and rebalance
    //   THAT container: the newcomer gets a fair 1/N share (or its sizeHint) and the
    //   existing panes scale proportionally into the remainder. Repeated adds thus
    //   converge to evenly-sized siblings instead of ever-smaller slivers, while a
    //   user's manual ratios among the surviving panes are preserved. Only the
    //   affected container is touched; unrelated splits keep their sizes.
    // • Otherwise wrap group+newGroup in a fresh 2-pane split (preserving the exact
    //   slot `group` occupied in its parent) and give the new pane half — or its
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
        // its bounds — common for a `.down` split, whose height isn't known until the
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
            // via setPosition, so a MIDDLE group's new split collapsed to 0 width — the
            // ⌘⇧D / drag "확 줄어" bug (confirmed by a [519,524,0,527] tree dump).
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
    // split — used after a pane is removed so siblings absorb the freed space
    // proportionally (tmux/iTerm/VS Code close behavior).
    private func redistribute(_ sv: NSSplitView, oldExtents: [CGFloat]) {
        let n = sv.arrangedSubviews.count
        guard n >= 2, oldExtents.count == n else { return }
        let total = (sv.isVertical ? sv.bounds.width : sv.bounds.height) - CGFloat(n - 1) * sv.dividerThickness
        guard total > 0 else { return }
        let sum = oldExtents.reduce(0, +)
        let target = sum > 0 ? oldExtents.map { $0 * total / sum }
                             : Array(repeating: total / CGFloat(n), count: n)
        setExtents(sv, target)
    }

    // After inserting a pane into an existing same-axis split: give the newcomer a
    // fair share of THIS container — its explicit sizeHint (aux panels / editor) or
    // total/N — and scale the pre-existing panes proportionally into the remainder.
    // A layout that was even stays exactly even (2nd terminal → 1/2 each, 3rd → 1/3
    // each), and a user's manual ratios among the old panes survive. `oldExtents`
    // must be captured BEFORE the insert (one entry per pre-insert arranged subview).
    private func rebalanceAfterInsert(_ sv: NSSplitView, insertedAt idx: Int,
                                      oldExtents: [CGFloat], sizeHint: CGFloat?) {
        let n = sv.arrangedSubviews.count            // includes the new pane
        guard n >= 2, idx < n, oldExtents.count == n - 1 else { return }
        let total = (sv.isVertical ? sv.bounds.width : sv.bounds.height) - CGFloat(n - 1) * sv.dividerThickness
        guard total > 0 else {
            // Bounds not resolved yet (e.g. a `.down` insert before layout) — retry next
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
        } else {
            // Splitting a group against a panel already alone in it is a no-op.
            if from === group && group.panels.count == 1 { return }
            let g = DockGroup(); g.manager = self
            from?.remove(panel, dispose: false)
            split(group, with: g, direction: region)
            g.add(panel); setActive(g)
        }
        cleanupEmpty(from)
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
        let newGroup = DockGroup(); newGroup.manager = self
        guard let root = container.subviews.first(where: { !($0 is DockEmptyView) }) else {
            newGroup.add(panel); setRoot(newGroup); setActive(newGroup); cleanupEmpty(from); refreshEmpty(); return
        }
        let vertical = (direction == .left || direction == .right)   // vertical divider ⇒ columns
        let before = (direction == .left || direction == .up)
        // Root already splits along this axis → prepend/append the new full-height
        // column (full-width row) to it directly and rebalance, instead of wrapping
        // the whole tree in ANOTHER same-axis split that hands the newcomer 50%.
        if let rsv = root as? NSSplitView, rsv.isVertical == vertical {
            newGroup.autoresizingMask = [.width, .height]
            let oldExtents = rsv.arrangedSubviews.map { extent($0, in: rsv) }
            let at = before ? 0 : rsv.arrangedSubviews.count
            rsv.insertArrangedSubview(newGroup, at: at)
            rsv.adjustSubviews()
            rebalanceAfterInsert(rsv, insertedAt: at, oldExtents: oldExtents, sizeHint: nil)
            newGroup.add(panel); setActive(newGroup)
            cleanupEmpty(from)
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
        cleanupEmpty(from)
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
        let g = panel.group
        g?.remove(panel, dispose: true)
        cleanupEmpty(g)
        normalizeTree()   // 닫기 후 빈 그룹·0폭 팬이 남지 않게 정리 (#3)
        refreshEmpty()
        focusSurvivor()   // move focus to a remaining panel (don't leave the app focus-less)
    }

    // 닫기/분리 뒤의 안전망 (#3): cleanupEmpty는 방금 비워진 그룹만 국소적으로
    // 정리하므로, 트리 어딘가에 남은 빈 그룹(내용 없는 블록)과 0폭으로 짜부라진
    // 팬(비례 재분배는 0을 0으로 유지한다)을 전체 스윕으로 마저 고친다.
    func normalizeTree() {
        // 빈 그룹은 어디에 있든 접는다 — cleanupEmpty가 붕괴/승격까지 처리한다.
        var again = true
        while again {
            again = false
            for g in groups where g.panels.isEmpty && g.superview is NSSplitView {
                cleanupEmpty(g); again = true; break
            }
        }
        guard let root = container.subviews.first(where: { !($0 is DockEmptyView) }) else { return }
        container.layoutSubtreeIfNeeded()
        ensureMinExtents(root)
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
        if let g = activeGroup, !g.panels.isEmpty { setActive(g); return }
        if let g = groups.first(where: { !$0.panels.isEmpty }) { setActive(g) }
    }

    // Remove a panel from its group WITHOUT disposing it — used to move a shared
    // singleton panel (the editor) from one workspace's dock to another's.
    func detach(_ panel: DockPanel) {
        let g = panel.group
        g?.remove(panel, dispose: false)
        cleanupEmpty(g)
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
            // 형제까지 기록된 정확한 크기로 되돌린다 — 팬이 나갔다 들어올 때 비례 재분배가
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

    // 임의의 이웃 뷰(그룹 또는 중첩 split)를 감싸 새 그룹과 나란히 놓는다 —
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

    // While a tab is being dragged, cover every group with a transparent drop zone
    // (above the panel content, which would otherwise swallow the drag — WKWebView
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
final class DockGroup: NSView {
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
            // riven's .dv-active-group::after — an inset accent ring drawn ON TOP of the
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

    private let tabBarHeight: CGFloat = 30

    override init(frame: NSRect) {
        super.init(frame: frame)
        wantsLayer = true
        layer?.backgroundColor = Theme.bg.cgColor
        tabBar.group = self
        addSubview(tabBar); addSubview(content)
        addSubview(borderOverlay)   // always on top
        // Manual frame layout (see layout()) — deterministic, no constraint-timing
        // gaps that left `content` at zero size while a terminal surface was created.
    }
    required init?(coder: NSCoder) { fatalError() }

    // Drop zones cover the content during a drag so panel content (WKWebView /
    // Metal) can't swallow the drop. Added by the manager on drag start.
    func showDropZone() {
        hideDropZone()
        let z = DockDropZone(); z.group = self
        // Cover the WHOLE group (tab bar included) so a drop anywhere over the group —
        // not just its content area — registers (merging two panels was easy to miss
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
        tabBar.frame = NSRect(x: 0, y: b.height - tabBarHeight, width: b.width, height: tabBarHeight)
        content.frame = NSRect(x: 0, y: 0, width: b.width, height: max(0, b.height - tabBarHeight))
        activePanel?.content.frame = content.bounds
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
    // add와 같지만 탭을 특정 위치에 끼워 넣는다 — 워크스페이스 복귀 시 싱글턴
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
        panels.remove(at: idx)
        panel.content.removeFromSuperview()
        if panel.group === self { panel.group = nil }
        if dispose { panel.onClose?() }
        activeIndex = min(activeIndex, panels.count - 1)
        showActive(); tabBar.rebuild()
        manager?.setActive(self)
        manager?.refreshEmpty()
    }
    func select(id: String) {
        guard let idx = panels.firstIndex(where: { $0.id == id }) else { return }
        activeIndex = idx; showActive(); tabBar.rebuild(); manager?.setActive(self)
    }
    private func showActive() {
        content.subviews.forEach { $0.removeFromSuperview() }   // dropZone lives on the group, not content
        guard let p = activePanel else { return }
        let v = p.content
        v.translatesAutoresizingMaskIntoConstraints = true
        v.frame = content.bounds
        v.autoresizingMask = [.width, .height]
        content.addSubview(v)
        // Keep the drop zone (if a drag is in progress) above the freshly shown content.
        if let z = dropZone { addSubview(z) }
        needsLayout = true          // frame the new content on the next layout pass
        p.onActivate?()
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
    // center (drop-as-tab) is the whole middle 60% — bigger + direction is stable.
    private func regionFor(_ pt: NSPoint) -> DockDir {
        let w = bounds.width, h = bounds.height
        guard w > 0, h > 0 else { return .center }
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

// NSSplitView with draggable dividers (min 80px per pane) — its own delegate. The
// divider is a 6px grab strip (easy to hit, dockview-style) with a 1px hairline.
final class DockSplitView: NSSplitView, NSSplitViewDelegate {
    override init(frame: NSRect) { super.init(frame: frame); delegate = self; dividerStyle = .thin }
    required init?(coder: NSCoder) { fatalError() }
    override var mouseDownCanMoveWindow: Bool { false }   // divider drags must not move the window
    override var dividerThickness: CGFloat { 6 }
    override func drawDivider(in rect: NSRect) {
        Theme.hairline.setFill()
        let line = isVertical
            ? NSRect(x: rect.midX - 0.5, y: rect.minY, width: 1, height: rect.height)
            : NSRect(x: rect.minX, y: rect.midY - 0.5, width: rect.width, height: 1)
        line.fill()
    }
    func splitView(_ v: NSSplitView, constrainMinCoordinate p: CGFloat, ofSubviewAt i: Int) -> CGFloat { 80 }
    func splitView(_ v: NSSplitView, constrainMaxCoordinate p: CGFloat, ofSubviewAt i: Int) -> CGFloat {
        (v.isVertical ? v.bounds.width : v.bounds.height) - 80
    }
}

// riven's empty workbench (Workbench.tsx .dock-empty): shown when the dock holds no
// panels. A faint "riven" wordmark, a tagline, and two actions — add a terminal
// (accent-filled primary) or open the editor. Overlays the whole dock container.
final class DockEmptyView: NSView, Themable {
    var onAddTerminal: (() -> Void)?
    var onOpenEditor: (() -> Void)?
    private let mark = NSTextField(labelWithString: "riven")
    private let tagline = NSTextField(labelWithString: t("empty.tagline"))
    private var addBtn: PadButton!
    private var editorBtn: PadButton!

    override init(frame: NSRect) {
        super.init(frame: frame)
        wantsLayer = true
        NotificationCenter.default.addObserver(forName: .rivenLanguageChanged, object: nil, queue: .main) { [weak self] _ in
            self?.tagline.stringValue = t("empty.tagline")
            self?.addBtn.setTitle("  " + t("empty.addTerminal"))
            self?.editorBtn.setTitle("  " + t("empty.addEditor"))
        }

        // Faint oversized wordmark (riven: fg 22% blended into bg).
        mark.font = .systemFont(ofSize: 44, weight: .bold)
        mark.alignment = .center
        tagline.font = .systemFont(ofSize: 13)
        tagline.alignment = .center

        addBtn = PadButton(title: "  " + t("empty.addTerminal"), font: .systemFont(ofSize: 13),
                           textColor: Theme.accent, bg: Theme.accentMuted, border: Theme.accentBorder,
                           radius: 7, hPad: 14, height: 34)
        addBtn.onClick = { [weak self] in self?.onAddTerminal?() }
        editorBtn = PadButton(title: "  " + t("empty.addEditor"), font: .systemFont(ofSize: 13),
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
        Theme.register(self)
    }
    required init?(coder: NSCoder) { fatalError() }

    func applyTheme() {
        layer?.backgroundColor = Theme.bg.cgColor
        // fg blended 22% into bg → a ghosted wordmark.
        mark.textColor = Theme.fg.blended(withFraction: 0.78, of: Theme.bg) ?? Theme.fgDim
        tagline.textColor = Theme.fgDim
    }
}
