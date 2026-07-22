import AppKit

// ⌘O quick panel (matches riven's QuickPanel): a keyboard-driven list of "add panel"
// actions — new terminal, panels, explorer toggle — with an icon + label + hint per
// row, a title header and a footer hint. ↑/↓ move, ↵ run, esc close. NOT a folder
// picker (riven's ⌘O is the add-panel dialog; folder-open lives on the workspace +).
struct QuickAction { let title: String; let hint: String; let symbol: String; let run: () -> Void }

final class QuickPanel: NSPanel, NSTableViewDataSource, NSTableViewDelegate {
    private let table = NSTableView()
    private let titleLabel = NSTextField(labelWithString: "")
    private var actions: [QuickAction] = []

    init() {
        super.init(contentRect: NSRect(x: 0, y: 0, width: 420, height: 300),
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

        // Title header (riven .qp-title: uppercase, letter-spaced, dim).
        titleLabel.stringValue = t("toolbar.addPanel")
        titleLabel.font = .systemFont(ofSize: 11, weight: .medium)
        titleLabel.textColor = Theme.fgDim
        titleLabel.frame = NSRect(x: 16, y: 268, width: 340, height: 20)
        titleLabel.autoresizingMask = [.width, .minYMargin]
        content.addSubview(titleLabel)

        let col = NSTableColumn(identifier: .init("a"))
        col.resizingMask = .autoresizingMask
        col.width = 408; col.minWidth = 200          // fill the panel (else hints overlap labels)
        table.addTableColumn(col)
        table.headerView = nil
        table.backgroundColor = .clear
        table.rowHeight = 34
        table.intercellSpacing = NSSize(width: 0, height: 2)
        table.dataSource = self
        table.delegate = self
        table.target = self
        table.action = #selector(runSelected)
        table.selectionHighlightStyle = .regular   // AccentRowView draws the muted fill
        let scroll = NSScrollView(frame: NSRect(x: 0, y: 30, width: 420, height: 236))
        scroll.documentView = table
        scroll.drawsBackground = false
        scroll.autoresizingMask = [.width, .height]
        scroll.automaticallyAdjustsContentInsets = false
        scroll.contentInsets = NSEdgeInsets(top: 0, left: 6, bottom: 0, right: 6)
        content.addSubview(scroll)

        // Footer hint.
        let hair = NSView(frame: NSRect(x: 0, y: 29, width: 420, height: 1))
        hair.wantsLayer = true; hair.layer?.backgroundColor = Theme.hairline.cgColor
        hair.autoresizingMask = [.width, .maxYMargin]
        content.addSubview(hair)
        let foot = NSTextField(labelWithString: "↑↓ 이동 · ↵ 실행 · esc 닫기")
        foot.font = .systemFont(ofSize: 11); foot.textColor = Theme.fgDim
        foot.frame = NSRect(x: 14, y: 7, width: 400, height: 16)
        foot.autoresizingMask = [.width, .maxYMargin]
        content.addSubview(foot)

        contentView = content
        installGlass(on: self, content: content)
    }

    func show(actions: [QuickAction], title: String? = nil, over parent: NSWindow) {
        if let title { titleLabel.stringValue = title }
        self.actions = actions
        table.reloadData()
        let f = parent.frame
        setFrameTopLeftPoint(NSPoint(x: f.midX - 210, y: f.maxY - 120))
        clampToWindow(self, parent: parent)
        parent.addChildWindow(self, ordered: .above)
        makeKeyAndOrderFront(nil)
        makeFirstResponder(self)
        if !actions.isEmpty { table.selectRowIndexes([0], byExtendingSelection: false) }
    }
    func dismiss() { parent?.removeChildWindow(self); orderOut(nil) }

    @objc private func runSelected() {
        let r = table.selectedRow
        guard r >= 0, r < actions.count else { return }
        let a = actions[r]; dismiss(); a.run()
    }

    // Keyboard nav handled here (the panel is first responder — no search field).
    override func keyDown(with event: NSEvent) {
        switch event.keyCode {
        case 53: dismiss()                                   // esc
        case 36, 76: runSelected()                           // return / enter
        case 125: move(1)                                    // down
        case 126: move(-1)                                   // up
        default: super.keyDown(with: event)
        }
    }
    override func cancelOperation(_ sender: Any?) { dismiss() }
    private func move(_ d: Int) {
        guard !actions.isEmpty else { return }
        let r = max(0, min(actions.count - 1, table.selectedRow + d))
        table.selectRowIndexes([r], byExtendingSelection: false)
        table.scrollRowToVisible(r)
    }

    func numberOfRows(in t: NSTableView) -> Int { actions.count }
    func tableView(_ t: NSTableView, rowViewForRow row: Int) -> NSTableRowView? {
        let id = NSUserInterfaceItemIdentifier("qprow")
        return (t.makeView(withIdentifier: id, owner: self) as? AccentRowView) ?? {
            let r = AccentRowView(); r.identifier = id; return r
        }()
    }
    func tableView(_ t: NSTableView, viewFor col: NSTableColumn?, row: Int) -> NSView? {
        let id = NSUserInterfaceItemIdentifier("qpcell")
        let cell = (t.makeView(withIdentifier: id, owner: self) as? QuickRow) ?? {
            let c = QuickRow(); c.identifier = id; return c
        }()
        let a = actions[row]
        cell.configure(symbol: a.symbol, title: a.title, hint: a.hint)
        return cell
    }
}

// A table row whose selection is riven's accent-muted fill (rounded), not the
// system blue highlight. Shared by the quick panel + quick-open palette.
final class AccentRowView: NSTableRowView {
    override func drawSelection(in dirtyRect: NSRect) {
        guard isSelected else { return }
        let r = bounds.insetBy(dx: 4, dy: 0)
        Theme.accentMuted.setFill()
        NSBezierPath(roundedRect: r, xRadius: 6, yRadius: 6).fill()
    }
    override var isEmphasized: Bool { get { false } set {} }
}

private final class QuickRow: NSView {
    private let icon = NSImageView()
    private let label = NSTextField(labelWithString: "")
    private let hint = NSTextField(labelWithString: "")
    override init(frame: NSRect) {
        super.init(frame: frame)
        icon.translatesAutoresizingMaskIntoConstraints = false
        icon.contentTintColor = Theme.fgDim
        label.font = .systemFont(ofSize: 13); label.textColor = Theme.fg
        label.translatesAutoresizingMaskIntoConstraints = false
        hint.font = .monospacedSystemFont(ofSize: 11, weight: .regular); hint.textColor = Theme.fgDim
        hint.translatesAutoresizingMaskIntoConstraints = false
        addSubview(icon); addSubview(label); addSubview(hint)
        NSLayoutConstraint.activate([
            icon.leadingAnchor.constraint(equalTo: leadingAnchor, constant: 14),
            icon.centerYAnchor.constraint(equalTo: centerYAnchor),
            icon.widthAnchor.constraint(equalToConstant: 16),
            icon.heightAnchor.constraint(equalToConstant: 16),
            label.leadingAnchor.constraint(equalTo: icon.trailingAnchor, constant: 10),
            label.centerYAnchor.constraint(equalTo: centerYAnchor),
            hint.trailingAnchor.constraint(equalTo: trailingAnchor, constant: -16),
            hint.centerYAnchor.constraint(equalTo: centerYAnchor)
        ])
    }
    required init?(coder: NSCoder) { fatalError() }
    func configure(symbol: String, title: String, hint hintText: String) {
        icon.image = NSImage(systemSymbolName: symbol, accessibilityDescription: nil)?
            .withSymbolConfiguration(.init(pointSize: 13, weight: .regular))
        label.stringValue = title
        hint.stringValue = hintText
    }
}
