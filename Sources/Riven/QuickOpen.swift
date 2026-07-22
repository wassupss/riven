import AppKit

// ⌘P quick-open palette (matches riven): fuzzy-filter workspace files, ↑/↓ to
// move, ↵ to open, esc to close. A floating panel over the window.
final class QuickOpenPanel: NSPanel, NSTableViewDataSource, NSTableViewDelegate {
    private let field = NSTextField()
    private let table = NSTableView()
    private var allFiles: [String] = []      // relative paths
    private var filtered: [String] = []
    private var workspace: URL?
    var onOpen: ((URL) -> Void)?

    init() {
        super.init(contentRect: NSRect(x: 0, y: 0, width: 620, height: 380),
                   styleMask: [.titled, .fullSizeContentView], backing: .buffered, defer: false)
        isFloatingPanel = true
        titlebarAppearsTransparent = true
        titleVisibility = .hidden
        isMovableByWindowBackground = true
        backgroundColor = Theme.bg2
        hasShadow = true

        let content = NSView(frame: contentView!.bounds)
        content.autoresizingMask = [.width, .height]
        content.wantsLayer = true
        content.layer?.backgroundColor = Theme.bg2.cgColor

        // Search input (riven .palette-input: 44px, transparent, hairline bottom).
        field.placeholderString = "파일 검색…"
        field.font = .systemFont(ofSize: 15)
        field.textColor = Theme.fg
        field.drawsBackground = false
        field.isBordered = false
        field.focusRingType = .none
        field.delegate = self
        field.frame = NSRect(x: 16, y: 336, width: 588, height: 34)
        field.autoresizingMask = [.width, .minYMargin]
        (field.cell as? NSTextFieldCell)?.usesSingleLineMode = true

        let sep = NSView(frame: NSRect(x: 0, y: 335, width: 620, height: 1))
        sep.wantsLayer = true; sep.layer?.backgroundColor = Theme.hairline.cgColor
        sep.autoresizingMask = [.width, .minYMargin]

        let col = NSTableColumn(identifier: .init("f"))
        col.resizingMask = .autoresizingMask
        col.width = 608; col.minWidth = 300          // fill the panel width
        table.addTableColumn(col)
        table.headerView = nil
        table.backgroundColor = .clear
        table.rowHeight = 30
        table.intercellSpacing = NSSize(width: 0, height: 1)
        table.dataSource = self
        table.delegate = self
        table.target = self
        table.selectionHighlightStyle = .regular   // AccentRowView draws the muted fill
        table.doubleAction = #selector(openSelected)
        table.action = #selector(openSelected)

        let scroll = NSScrollView(frame: NSRect(x: 0, y: 0, width: 620, height: 335))
        scroll.documentView = table
        scroll.drawsBackground = false
        scroll.autoresizingMask = [.width, .height]
        scroll.automaticallyAdjustsContentInsets = false
        scroll.contentInsets = NSEdgeInsets(top: 6, left: 6, bottom: 6, right: 6)

        content.addSubview(scroll); content.addSubview(sep); content.addSubview(field)
        contentView = content
        installGlass(on: self, content: content)
    }

    func show(workspace: URL, over parent: NSWindow) {
        self.workspace = workspace
        indexFiles(workspace)
        filtered = Array(allFiles.prefix(200))
        table.reloadData()
        field.stringValue = ""
        let f = parent.frame
        // Near the top of the window (riven palette-overlay: padding-top 12vh).
        setFrameTopLeftPoint(NSPoint(x: f.midX - 310, y: f.maxY - f.height * 0.12))
        clampToWindow(self, parent: parent)
        parent.addChildWindow(self, ordered: .above)
        makeKeyAndOrderFront(nil)
        makeFirstResponder(field)
        if !filtered.isEmpty { table.selectRowIndexes([0], byExtendingSelection: false) }
    }

    private func indexFiles(_ root: URL) {
        allFiles = []
        let ignored: Set<String> = [".git","node_modules",".build","DerivedData","dist","out",".next",".venv","venv","target"]
        let fm = FileManager.default
        guard let en = fm.enumerator(at: root, includingPropertiesForKeys: [.isDirectoryKey],
            options: [.skipsHiddenFiles]) else { return }
        var count = 0
        for case let url as URL in en {
            if ignored.contains(url.lastPathComponent) { en.skipDescendants(); continue }
            let isDir = (try? url.resourceValues(forKeys: [.isDirectoryKey]))?.isDirectory ?? false
            if !isDir {
                allFiles.append(String(url.path.dropFirst(root.path.count + 1)))
                count += 1; if count > 20000 { break }
            }
        }
    }

    // Simple subsequence fuzzy match + rank by match compactness.
    private func filter(_ q: String) {
        if q.isEmpty { filtered = Array(allFiles.prefix(200)); table.reloadData(); return }
        let ql = q.lowercased()
        var scored: [(String, Int)] = []
        for path in allFiles {
            if let score = fuzzy(ql, path.lowercased()) { scored.append((path, score)) }
        }
        scored.sort { $0.1 < $1.1 }
        filtered = scored.prefix(200).map { $0.0 }
        table.reloadData()
        if !filtered.isEmpty { table.selectRowIndexes([0], byExtendingSelection: false) }
    }

    private func fuzzy(_ needle: String, _ hay: String) -> Int? {
        var hi = hay.startIndex, first: Int? = nil, last = 0, idx = 0
        for ch in needle {
            guard let f = hay[hi...].firstIndex(of: ch) else { return nil }
            let d = hay.distance(from: hay.startIndex, to: f)
            if first == nil { first = d }
            last = d
            hi = hay.index(after: f)
            idx += 1
        }
        // prefer matches near the filename (end) and compact spans
        return (last - (first ?? 0)) + (hay.count - last)
    }

    @objc private func openSelected() {
        let row = table.selectedRow
        guard row >= 0, row < filtered.count, let ws = workspace else { return }
        onOpen?(ws.appendingPathComponent(filtered[row]))
        dismiss()
    }
    func dismiss() { parent?.removeChildWindow(self); orderOut(nil) }

    // table
    func numberOfRows(in t: NSTableView) -> Int { filtered.count }
    func tableView(_ t: NSTableView, rowViewForRow row: Int) -> NSTableRowView? {
        let id = NSUserInterfaceItemIdentifier("qorow")
        return (t.makeView(withIdentifier: id, owner: self) as? AccentRowView) ?? {
            let r = AccentRowView(); r.identifier = id; return r
        }()
    }
    func tableView(_ t: NSTableView, viewFor col: NSTableColumn?, row: Int) -> NSView? {
        let id = NSUserInterfaceItemIdentifier("qocell")
        let cell = (t.makeView(withIdentifier: id, owner: self) as? FileResultRow) ?? {
            let c = FileResultRow(); c.identifier = id; return c
        }()
        let path = filtered[row]
        cell.configure(name: (path as NSString).lastPathComponent,
                       dir: (path as NSString).deletingLastPathComponent)
        return cell
    }
}

// A quick-open result row: file icon + basename + dimmed relative dir (riven's
// .palette-item with FileIcon + label + sub).
private final class FileResultRow: NSView {
    private let icon = NSImageView()
    private let name = NSTextField(labelWithString: "")
    private let dir = NSTextField(labelWithString: "")
    override init(frame: NSRect) {
        super.init(frame: frame)
        icon.translatesAutoresizingMaskIntoConstraints = false
        icon.imageScaling = .scaleProportionallyUpOrDown
        name.font = .systemFont(ofSize: 13); name.textColor = Theme.fg
        name.translatesAutoresizingMaskIntoConstraints = false
        dir.font = .monospacedSystemFont(ofSize: 10, weight: .regular); dir.textColor = Theme.fgDim
        dir.lineBreakMode = .byTruncatingMiddle
        dir.translatesAutoresizingMaskIntoConstraints = false
        addSubview(icon); addSubview(name); addSubview(dir)
        NSLayoutConstraint.activate([
            icon.leadingAnchor.constraint(equalTo: leadingAnchor, constant: 14),
            icon.centerYAnchor.constraint(equalTo: centerYAnchor),
            icon.widthAnchor.constraint(equalToConstant: 15),
            icon.heightAnchor.constraint(equalToConstant: 15),
            name.leadingAnchor.constraint(equalTo: icon.trailingAnchor, constant: 9),
            name.centerYAnchor.constraint(equalTo: centerYAnchor),
            dir.leadingAnchor.constraint(equalTo: name.trailingAnchor, constant: 10),
            dir.trailingAnchor.constraint(lessThanOrEqualTo: trailingAnchor, constant: -14),
            dir.centerYAnchor.constraint(equalTo: centerYAnchor)
        ])
        name.setContentHuggingPriority(.required, for: .horizontal)
    }
    required init?(coder: NSCoder) { fatalError() }
    func configure(name n: String, dir d: String) {
        icon.image = FileIcon.image(name: n, isDir: false, open: false)
        name.stringValue = n
        dir.stringValue = d
    }
}

extension QuickOpenPanel: NSTextFieldDelegate {
    func controlTextDidChange(_ obj: Notification) { filter(field.stringValue) }
    func control(_ c: NSControl, textView: NSTextView, doCommandBy sel: Selector) -> Bool {
        switch sel {
        case #selector(NSResponder.cancelOperation(_:)): dismiss(); return true
        case #selector(NSResponder.insertNewline(_:)): openSelected(); return true
        case #selector(NSResponder.moveDown(_:)):
            let r = min(table.selectedRow + 1, filtered.count - 1)
            if r >= 0 { table.selectRowIndexes([r], byExtendingSelection: false); table.scrollRowToVisible(r) }
            return true
        case #selector(NSResponder.moveUp(_:)):
            let r = max(table.selectedRow - 1, 0)
            table.selectRowIndexes([r], byExtendingSelection: false); table.scrollRowToVisible(r)
            return true
        default: return false
        }
    }
}
