import AppKit

// A file-system entry for the explorer outline view.
final class FileNode {
    let url: URL
    let isDir: Bool
    var children: [FileNode]?   // lazily loaded for dirs
    var isPlaceholder = false   // the transient "new file/folder" inline-edit row
    init(url: URL, isDir: Bool) { self.url = url; self.isDir = isDir }

    var name: String { url.lastPathComponent }

    private static let ignored: Set<String> = [
        ".git", "node_modules", ".build", "DerivedData", ".DS_Store",
        "dist", "out", ".next", ".venv", "venv", "target", ".cache"
    ]

    func loadChildren() -> [FileNode] {
        if let c = children { return c }
        let fm = FileManager.default
        let items = (try? fm.contentsOfDirectory(at: url,
            includingPropertiesForKeys: [.isDirectoryKey], options: [.skipsHiddenFiles])) ?? []
        let nodes = items
            .filter { !FileNode.ignored.contains($0.lastPathComponent) }
            .map { FileNode(url: $0, isDir: (try? $0.resourceValues(forKeys: [.isDirectoryKey]))?.isDirectory ?? false) }
            .sorted { a, b in
                if a.isDir != b.isDir { return a.isDir }
                return a.name.localizedCaseInsensitiveCompare(b.name) == .orderedAscending
            }
        children = nodes
        return nodes
    }
}

// The explorer sidebar: an NSOutlineView driven by FileNode. Clicking a file
// notifies onOpenFile(url).
final class FileTreeView: NSView, NSOutlineViewDataSource, NSOutlineViewDelegate, Themable {
    private let scroll = NSScrollView()
    private let outline = RivenOutlineView()
    private var root: FileNode?
    private var gitStatus: [String: Git.Status] = [:]
    var onOpenFile: ((URL) -> Void)?
    var onChanged: (() -> Void)?                 // FS mutated → refresh git etc.
    var onFileDeleted: ((URL) -> Void)?          // close its tab if open
    var onFileRenamed: ((URL, URL) -> Void)?     // (old, new) → update open tab

    func setGitStatus(_ s: [String: Git.Status]) {
        gitStatus = s
        outline.reloadData()
    }

    override init(frame: NSRect) {
        super.init(frame: frame)
        wantsLayer = true
        layer?.backgroundColor = Theme.bg2.cgColor
        let col = NSTableColumn(identifier: .init("name"))
        col.resizingMask = .autoresizingMask
        outline.addTableColumn(col)
        outline.outlineTableColumn = col
        outline.headerView = nil
        outline.rowSizeStyle = .small
        outline.backgroundColor = Theme.bg2
        outline.dataSource = self
        outline.delegate = self
        outline.target = self
        outline.action = #selector(clicked)
        outline.onMenu = { [weak self] row in self?.contextMenu(row: row) }
        // .plain (NOT .sourceList): source-list forces a translucent system
        // material that renders light and ignores backgroundColor.
        outline.style = .plain
        outline.selectionHighlightStyle = .regular
        outline.indentationPerLevel = 10
        outline.intercellSpacing = NSSize(width: 0, height: 0)

        scroll.documentView = outline
        scroll.hasVerticalScroller = true
        scroll.drawsBackground = true
        scroll.backgroundColor = Theme.bg2
        scroll.frame = NSRect(x: 0, y: 0, width: bounds.width, height: bounds.height - Self.headerH)
        scroll.autoresizingMask = [.width, .height]
        addSubview(scroll)

        buildHeader()
        Theme.register(self)
        NotificationCenter.default.addObserver(forName: .rivenLanguageChanged, object: nil, queue: .main) { [weak self] _ in
            self?.headerTitle.stringValue = t("title.explorer")
            self?.relocalizeToolbar()
        }
    }
    private func relocalizeToolbar() {
        let tips = [t("explorer.newFile"), t("explorer.newFolder"), t("common.refresh"), t("explorer.collapseAll")]
        for (b, tip) in zip(toolButtons, tips) { b.toolTip = tip }
    }
    required init?(coder: NSCoder) { fatalError() }

    // VSCode-style explorer header: a "탐색기" label + new-file / new-folder /
    // refresh / collapse-all icon buttons (riven's ExplorerPanel toolbar).
    private static let headerH: CGFloat = 30
    private let header = NSView()
    private let headerTitle = NSTextField(labelWithString: t("title.explorer"))
    private var toolButtons: [NSButton] = []
    private func buildHeader() {
        header.wantsLayer = true
        header.frame = NSRect(x: 0, y: bounds.height - Self.headerH, width: bounds.width, height: Self.headerH)
        header.autoresizingMask = [.width, .minYMargin]   // pin to the top
        addSubview(header)

        headerTitle.font = UIScale.font(11, .semibold)
        headerTitle.textColor = Theme.fgDim
        headerTitle.translatesAutoresizingMaskIntoConstraints = false
        header.addSubview(headerTitle)

        func button(_ symbol: String, _ tip: String, _ sel: Selector) -> NSButton {
            let b = NSButton()
            b.bezelStyle = .regularSquare
            b.isBordered = false
            b.imagePosition = .imageOnly
            b.image = NSImage(systemSymbolName: symbol, accessibilityDescription: tip)
            b.image?.isTemplate = true
            b.contentTintColor = Theme.fgDim
            b.toolTip = tip
            b.target = self
            b.action = sel
            b.translatesAutoresizingMaskIntoConstraints = false
            b.widthAnchor.constraint(equalToConstant: 22).isActive = true
            b.heightAnchor.constraint(equalToConstant: 22).isActive = true
            toolButtons.append(b)
            return b
        }
        let bar = NSStackView(views: [
            button("doc.badge.plus", t("explorer.newFile"), #selector(tbNewFile)),
            button("folder.badge.plus", t("explorer.newFolder"), #selector(tbNewFolder)),
            button("arrow.clockwise", t("common.refresh"), #selector(tbRefresh)),
            button("chevron.up.chevron.down", t("explorer.collapseAll"), #selector(tbCollapseAll)),
        ])
        bar.orientation = .horizontal
        bar.spacing = 2
        bar.translatesAutoresizingMaskIntoConstraints = false
        header.addSubview(bar)
        NSLayoutConstraint.activate([
            headerTitle.leadingAnchor.constraint(equalTo: header.leadingAnchor, constant: 12),
            headerTitle.centerYAnchor.constraint(equalTo: header.centerYAnchor),
            bar.trailingAnchor.constraint(equalTo: header.trailingAnchor, constant: -6),
            bar.centerYAnchor.constraint(equalTo: header.centerYAnchor),
        ])
    }

    // The dir new items are created in: the selected folder (or a selected file's
    // folder), falling back to the workspace root.
    private func selectedTargetNode() -> FileNode? {
        let row = outline.selectedRow
        return row >= 0 ? outline.item(atRow: row) as? FileNode : nil
    }
    @objc private func tbNewFile() { beginCreate(isDir: false) }
    @objc private func tbNewFolder() { beginCreate(isDir: true) }
    @objc private func tbRefresh() { reload(under: nil) }

    // ---- VSCode-style inline create (no modal dialog) ----
    // A transient empty row appears in the tree under the target folder; typing a name
    // and pressing Enter (or clicking away) creates it, Escape/empty cancels it.
    private var creatingParent: FileNode?     // nil = workspace root
    private var creatingIsDir = false
    private lazy var placeholder: FileNode = {
        let n = FileNode(url: URL(fileURLWithPath: "/__riven_new__"), isDir: false); n.isPlaceholder = true; return n
    }()
    private weak var editingField: NSTextField?

    func beginCreate(isDir: Bool) {
        cancelInlineEdit(reload: false)
        let target = selectedTargetNode()
        let parent: FileNode? = target.map { $0.isDir ? $0 : (outline.parent(forItem: $0) as? FileNode ?? root) } ?? nil
        creatingParent = parent
        creatingIsDir = isDir
        let container = parent ?? root
        guard let container else { return }
        _ = container.loadChildren()
        if container.children == nil { container.children = [] }
        container.children?.insert(placeholder, at: 0)
        if let parent {
            outline.expandItem(parent)
            outline.reloadItem(parent, reloadChildren: true)
            outline.expandItem(parent)
        } else {
            outline.reloadData()
        }
        let row = outline.row(forItem: placeholder)
        if row >= 0 { outline.scrollRowToVisible(row) }
    }

    @objc private func commitInlineEdit(_ sender: NSTextField) {
        let name = sender.stringValue.trimmingCharacters(in: .whitespacesAndNewlines)
        let parent = creatingParent, isDir = creatingIsDir
        finishInline()
        guard !name.isEmpty, let dir = (parent ?? root)?.url else { reloadContainer(parent); return }
        let url = dir.appendingPathComponent(name)
        if isDir {
            try? FileManager.default.createDirectory(at: url, withIntermediateDirectories: true)
            reloadContainer(parent)
        } else if FileManager.default.createFile(atPath: url.path, contents: Data()) {
            reloadContainer(parent); onOpenFile?(url)
        } else {
            reloadContainer(parent)
        }
        onChanged?()
    }
    private func cancelInlineEdit(reload: Bool = true) {
        let container = creatingParent ?? root
        guard container?.children?.contains(where: { $0 === placeholder }) == true else { return }
        let parent = creatingParent
        finishInline()
        if reload { reloadContainer(parent) }
    }
    private func finishInline() {
        (creatingParent ?? root)?.children?.removeAll { $0 === placeholder }
        editingField = nil
    }
    private func reloadContainer(_ parent: FileNode?) {
        if let parent { parent.children = nil; outline.reloadItem(parent, reloadChildren: true); outline.expandItem(parent) }
        else { root?.children = nil; outline.reloadData() }
    }
    @objc private func tbCollapseAll() {
        outline.collapseItem(nil, collapseChildren: true)
    }

    func applyTheme() {
        layer?.backgroundColor = Theme.bg2.cgColor
        outline.backgroundColor = Theme.bg2
        scroll.backgroundColor = Theme.bg2
        header.layer?.backgroundColor = Theme.bg2.cgColor
        headerTitle.textColor = Theme.fgDim
        toolButtons.forEach { $0.contentTintColor = Theme.fgDim }
        outline.reloadData()   // row cells recolor from the current palette
    }

    // Re-lay-out the tree at the current UI zoom (row font + height read UIScale).
    func rebuildForScale() {
        headerTitle.font = UIScale.font(11, .semibold)
        outline.reloadData()
    }

    func setRoot(_ url: URL) {
        root = FileNode(url: url, isDir: true)
        outline.reloadData()
    }

    // Reveal a file: expand every ancestor folder and select+scroll to its row so the
    // explorer follows the active editor tab (riven's reveal-in-explorer).
    func reveal(_ url: URL) {
        guard let root else { return }
        let rootPath = root.url.path
        guard url.path.hasPrefix(rootPath + "/") else { return }
        let comps = url.path.dropFirst(rootPath.count + 1).split(separator: "/").map(String.init)
        var node = root
        for comp in comps {
            outline.expandItem(node)
            guard let next = node.loadChildren().first(where: { $0.name == comp }) else { return }
            node = next
        }
        let row = outline.row(forItem: node)
        if row >= 0 {
            outline.selectRowIndexes([row], byExtendingSelection: false)
            outline.scrollRowToVisible(row)
        }
    }

    @objc private func clicked() {
        let row = outline.clickedRow
        RLog.log("explorer clicked row=\(row)")
        guard let node = outline.item(atRow: row) as? FileNode else {
            RLog.log("explorer: no node at row \(row)"); return
        }
        if node.isDir {
            if outline.isItemExpanded(node) { outline.collapseItem(node) } else { outline.expandItem(node) }
            outline.reloadItem(node, reloadChildren: false)  // refresh the chevron ▸/▾
        } else {
            RLog.log("explorer: open file \(node.url.lastPathComponent)")
            onOpenFile?(node.url)
        }
    }

    // ---- Right-click context menu (riven Explorer parity) ----
    private func contextMenu(row: Int) -> NSMenu? {
        guard root != nil else { return nil }
        let node = outline.item(atRow: row) as? FileNode   // nil = empty area → act on root
        let menu = NSMenu()
        func add(_ title: String, _ sel: Selector) {
            let it = NSMenuItem(title: title, action: sel, keyEquivalent: "")
            it.target = self; it.representedObject = node; menu.addItem(it)
        }
        add("새 파일", #selector(ctxNewFile(_:)))
        add("새 폴더", #selector(ctxNewFolder(_:)))
        if node != nil {
            menu.addItem(.separator())
            add("이름 변경", #selector(ctxRename(_:)))
            add("삭제", #selector(ctxDelete(_:)))
            menu.addItem(.separator())
            add("Finder에서 보기", #selector(ctxReveal(_:)))
            add("경로 복사", #selector(ctxCopyPath(_:)))
        }
        return menu
    }

    // The directory a new entry should be created in (the node itself if a folder,
    // else its parent; the workspace root when clicking empty space).
    private func targetDir(for node: FileNode?) -> URL {
        guard let node else { return root!.url }
        return node.isDir ? node.url : node.url.deletingLastPathComponent()
    }
    // FileNode whose child cache must be invalidated after a change inside `dir`.
    private func nodeForDir(_ node: FileNode?) -> FileNode? {
        guard let node else { return nil }               // nil → root
        return node.isDir ? node : (outline.parent(forItem: node) as? FileNode)
    }
    private func reload(under parent: FileNode?) {
        if let parent {
            parent.children = nil
            outline.reloadItem(parent, reloadChildren: true)
            outline.expandItem(parent)
        } else {
            root?.children = nil
            outline.reloadData()
        }
        onChanged?()
    }

    @objc private func ctxNewFile(_ s: NSMenuItem) { selectMenuNode(s); beginCreate(isDir: false) }
    @objc private func ctxNewFolder(_ s: NSMenuItem) { selectMenuNode(s); beginCreate(isDir: true) }
    private func selectMenuNode(_ s: NSMenuItem) {
        guard let node = s.representedObject as? FileNode else { return }
        let row = outline.row(forItem: node)
        if row >= 0 { outline.selectRowIndexes([row], byExtendingSelection: false) }
    }
    @objc private func ctxRename(_ s: NSMenuItem) {
        guard let node = s.representedObject as? FileNode,
              let name = prompt(title: "이름 변경", placeholder: "새 이름", initial: node.name),
              !name.isEmpty, name != node.name else { return }
        let dst = node.url.deletingLastPathComponent().appendingPathComponent(name)
        do {
            try FileManager.default.moveItem(at: node.url, to: dst)
            onFileRenamed?(node.url, dst)
            reload(under: outline.parent(forItem: node) as? FileNode)
        } catch { NSSound.beep() }
    }
    @objc private func ctxDelete(_ s: NSMenuItem) {
        guard let node = s.representedObject as? FileNode else { return }
        let a = NSAlert()
        a.messageText = "\(node.name) 삭제"
        a.informativeText = "휴지통으로 이동합니다."
        a.addButton(withTitle: "삭제"); a.addButton(withTitle: "취소")
        a.alertStyle = .warning
        guard a.runModal() == .alertFirstButtonReturn else { return }
        do {
            try FileManager.default.trashItem(at: node.url, resultingItemURL: nil)
            onFileDeleted?(node.url)
            reload(under: outline.parent(forItem: node) as? FileNode)
        } catch { NSSound.beep() }
    }
    @objc private func ctxReveal(_ s: NSMenuItem) {
        guard let node = s.representedObject as? FileNode else { return }
        NSWorkspace.shared.activateFileViewerSelecting([node.url])
    }
    @objc private func ctxCopyPath(_ s: NSMenuItem) {
        guard let node = s.representedObject as? FileNode else { return }
        NSPasteboard.general.clearContents()
        NSPasteboard.general.setString(node.url.path, forType: .string)
    }

    // A small modal text prompt (native NSAlert with an accessory text field).
    private func prompt(title: String, placeholder: String, initial: String = "") -> String? {
        let a = NSAlert()
        a.messageText = title
        a.addButton(withTitle: "확인"); a.addButton(withTitle: "취소")
        let field = NSTextField(frame: NSRect(x: 0, y: 0, width: 240, height: 24))
        field.placeholderString = placeholder
        field.stringValue = initial
        a.accessoryView = field
        a.window.initialFirstResponder = field
        return a.runModal() == .alertFirstButtonReturn ? field.stringValue : nil
    }

    // data source
    func outlineView(_ ov: NSOutlineView, numberOfChildrenOfItem item: Any?) -> Int {
        if item == nil { return root?.loadChildren().count ?? 0 }
        return (item as? FileNode)?.loadChildren().count ?? 0
    }
    func outlineView(_ ov: NSOutlineView, child index: Int, ofItem item: Any?) -> Any {
        let parent = (item as? FileNode) ?? root!
        return parent.loadChildren()[index]
    }
    func outlineView(_ ov: NSOutlineView, isItemExpandable item: Any) -> Bool {
        (item as? FileNode)?.isDir ?? false
    }
    // Fixed 22px rows (riven .tree-row height).
    func outlineView(_ ov: NSOutlineView, heightOfRowByItem item: Any) -> CGFloat { UIScale.pt(22) }

    // Selected rows use riven's accent-muted fill instead of the system highlight.
    func outlineView(_ ov: NSOutlineView, rowViewForItem item: Any) -> NSTableRowView? {
        let id = NSUserInterfaceItemIdentifier("row")
        return (ov.makeView(withIdentifier: id, owner: self) as? ExplorerRowView) ?? {
            let r = ExplorerRowView(); r.identifier = id; return r
        }()
    }

    func outlineView(_ ov: NSOutlineView, viewFor col: NSTableColumn?, item: Any) -> NSView? {
        let node = item as! FileNode
        let id = NSUserInterfaceItemIdentifier("cell")
        let cell = (ov.makeView(withIdentifier: id, owner: self) as? ExplorerCell) ?? {
            let c = ExplorerCell(); c.identifier = id; return c
        }()

        // Inline new-file / new-folder editor row (VSCode-style — no modal dialog).
        if node.isPlaceholder {
            let dir = creatingIsDir
            cell.chevron.image = nil
            cell.icon.image = FileIcon.image(name: "x", isDir: dir, open: false)
            cell.label.isHidden = true; cell.badge.isHidden = true
            cell.field.isHidden = false
            cell.field.stringValue = ""
            cell.field.delegate = self
            cell.field.target = self; cell.field.action = #selector(commitInlineEdit(_:))
            editingField = cell.field
            DispatchQueue.main.async { [weak self] in
                self?.window?.makeFirstResponder(cell.field)
            }
            return cell
        }

        cell.label.isHidden = false; cell.field.isHidden = true
        let expanded = ov.isItemExpanded(node)
        // VSCode chevron: right when collapsed, down when expanded (files have none).
        cell.chevron.image = node.isDir
            ? NSImage(systemSymbolName: expanded ? "chevron.down" : "chevron.right", accessibilityDescription: nil)
            : nil
        cell.chevron.contentTintColor = Theme.fgDim
        cell.icon.image = FileIcon.image(name: node.name, isDir: node.isDir, open: expanded)
        cell.label.stringValue = node.name

        // Git working-tree decoration (matches riven Explorer): colour the label + a
        // single-letter badge, using riven's exact category → colour mapping.
        let cat = gitCategory(node)
        if let cat, !node.isDir {
            cell.label.textColor = cat.color
            cell.badge.stringValue = cat.letter
            cell.badge.textColor = cat.color
            cell.badge.isHidden = false
        } else if node.isDir, gitContainsChange(node.url.path) {
            cell.label.textColor = Theme.fg
            cell.badge.isHidden = true
        } else {
            cell.label.textColor = node.isDir ? Theme.fg : Theme.hex("#c9c9d0")
            cell.badge.isHidden = true
        }
        return cell
    }

    // riven's GitCat → (badge letter, colour). renamed/untracked are green.
    private struct GitCat { let letter: String; let color: NSColor }
    private func gitCategory(_ node: FileNode) -> GitCat? {
        guard let st = gitStatus[node.url.path] else { return nil }
        switch st {
        case .modified:  return GitCat(letter: "M", color: Theme.gitModified)
        case .added:     return GitCat(letter: "A", color: Theme.gitAdded)
        case .untracked: return GitCat(letter: "U", color: Theme.gitUntracked)
        case .renamed:   return GitCat(letter: "R", color: Theme.gitRenamed)
        case .deleted:   return GitCat(letter: "D", color: Theme.gitDeleted)
        }
    }
    private func gitContainsChange(_ dirPath: String) -> Bool {
        gitStatus.keys.contains { $0.hasPrefix(dirPath + "/") }
    }
}

// Inline-edit field: Enter commits (its action), Escape cancels, blur commits (VSCode).
extension FileTreeView: NSTextFieldDelegate {
    func control(_ control: NSControl, textView: NSTextView, doCommandBy selector: Selector) -> Bool {
        if selector == #selector(NSResponder.cancelOperation(_:)) {
            cancelInlineEdit()
            window?.makeFirstResponder(outline)
            return true
        }
        return false
    }
    func controlTextDidEndEditing(_ obj: Notification) {
        guard let field = obj.object as? NSTextField, field === editingField else { return }
        commitInlineEdit(field)   // blur / Tab commits like riven
    }
}

// An explorer row cell: [chevron 16 | colored file icon 16 | label | git badge].
// Mirrors riven's .ex-twist / .ex-icon / .ex-label / .ex-git-badge row (22px tall).
// The chevron is a VSCode-style SF-Symbol chevron (right → rotates to down when open).
// `field` is an editable text field shown ONLY for the inline new-file/rename row.
final class ExplorerCell: NSView {
    let chevron = NSImageView()
    let icon = NSImageView()
    let label = NSTextField(labelWithString: "")
    let field = NSTextField()          // inline-edit input (hidden except while creating/renaming)
    let badge = NSTextField(labelWithString: "")   // git status letter (M/A/U/D/R/!)
    override init(frame: NSRect) {
        super.init(frame: frame)
        chevron.translatesAutoresizingMaskIntoConstraints = false
        chevron.imageScaling = .scaleProportionallyDown
        chevron.symbolConfiguration = .init(pointSize: 9, weight: .semibold)
        icon.translatesAutoresizingMaskIntoConstraints = false
        icon.imageScaling = .scaleProportionallyUpOrDown
        label.font = UIScale.font(12); label.lineBreakMode = .byTruncatingTail
        label.translatesAutoresizingMaskIntoConstraints = false
        badge.font = UIScale.mono(9, .bold); badge.alignment = .center
        badge.setContentHuggingPriority(.required, for: .horizontal)
        badge.setContentCompressionResistancePriority(.required, for: .horizontal)
        badge.translatesAutoresizingMaskIntoConstraints = false
        field.font = UIScale.font(12); field.isBezeled = true; field.bezelStyle = .squareBezel
        field.focusRingType = .none; field.isHidden = true
        field.translatesAutoresizingMaskIntoConstraints = false
        addSubview(chevron); addSubview(icon); addSubview(label); addSubview(badge); addSubview(field)
        NSLayoutConstraint.activate([
            chevron.leadingAnchor.constraint(equalTo: leadingAnchor, constant: 0),
            chevron.centerYAnchor.constraint(equalTo: centerYAnchor),
            chevron.widthAnchor.constraint(equalToConstant: 14),
            icon.leadingAnchor.constraint(equalTo: chevron.trailingAnchor, constant: 2),
            icon.centerYAnchor.constraint(equalTo: centerYAnchor),
            icon.widthAnchor.constraint(equalToConstant: 15),
            icon.heightAnchor.constraint(equalToConstant: 15),
            label.leadingAnchor.constraint(equalTo: icon.trailingAnchor, constant: 5),
            label.centerYAnchor.constraint(equalTo: centerYAnchor),
            label.trailingAnchor.constraint(lessThanOrEqualTo: badge.leadingAnchor, constant: -4),
            badge.trailingAnchor.constraint(equalTo: trailingAnchor, constant: -8),
            badge.centerYAnchor.constraint(equalTo: centerYAnchor),
            field.leadingAnchor.constraint(equalTo: icon.trailingAnchor, constant: 4),
            field.trailingAnchor.constraint(equalTo: trailingAnchor, constant: -6),
            field.centerYAnchor.constraint(equalTo: centerYAnchor),
            field.heightAnchor.constraint(equalToConstant: UIScale.pt(18))
        ])
    }
    required init?(coder: NSCoder) { fatalError() }
}

// Row view that paints riven's accent-muted selection + hover fill.
final class ExplorerRowView: NSTableRowView {
    override func drawSelection(in dirtyRect: NSRect) {
        guard isSelected else { return }
        Theme.accentMuted.setFill()
        bounds.fill()
    }
}

// NSOutlineView that hides the system disclosure triangle (we draw our own
// chevron in the cell, matching riven) and paints the themed background.
final class RivenOutlineView: NSOutlineView {
    override func frameOfOutlineCell(atRow row: Int) -> NSRect { .zero }
    var onMenu: ((_ row: Int) -> NSMenu?)?
    override func menu(for event: NSEvent) -> NSMenu? {
        let pt = convert(event.locationInWindow, from: nil)
        let row = self.row(at: pt)
        if row >= 0 { selectRowIndexes([row], byExtendingSelection: false) }
        return onMenu?(row)
    }
}
