import AppKit

// ⌘⇧P command palette (matches riven's Palette): fuzzy-filter registered
// commands, ↑/↓ move, ↵ run, esc close.
struct Command { let title: String; let hint: String; let run: () -> Void }

final class CommandPalette: NSPanel, NSTableViewDataSource, NSTableViewDelegate, NSTextFieldDelegate {
    private let field = NSTextField()
    private let table = NSTableView()
    private var all: [Command] = []
    private var filtered: [Command] = []

    init() {
        super.init(contentRect: NSRect(x: 0, y: 0, width: 560, height: 360),
                   styleMask: [.titled, .fullSizeContentView], backing: .buffered, defer: false)
        isFloatingPanel = true; titlebarAppearsTransparent = true; titleVisibility = .hidden
        isMovableByWindowBackground = true; backgroundColor = Theme.bg2; hasShadow = true

        let content = NSView(frame: contentView!.bounds); content.autoresizingMask = [.width, .height]
        field.placeholderString = "명령 실행…"
        field.font = .systemFont(ofSize: 15); field.textColor = Theme.fg
        field.backgroundColor = Theme.bg2; field.isBordered = false; field.focusRingType = .none
        field.delegate = self
        field.frame = NSRect(x: 14, y: 316, width: 532, height: 34); field.autoresizingMask = [.width, .minYMargin]

        let col = NSTableColumn(identifier: .init("c")); col.resizingMask = .autoresizingMask
        table.addTableColumn(col); table.headerView = nil; table.backgroundColor = Theme.bg2
        table.rowSizeStyle = .medium; table.dataSource = self; table.delegate = self
        table.target = self; table.action = #selector(runSelected)
        let scroll = NSScrollView(frame: NSRect(x: 0, y: 0, width: 560, height: 310))
        scroll.documentView = table; scroll.drawsBackground = false; scroll.autoresizingMask = [.width, .height]
        let sep = NSView(frame: NSRect(x: 0, y: 310, width: 560, height: 1)); sep.wantsLayer = true
        sep.layer?.backgroundColor = Theme.border.cgColor; sep.autoresizingMask = [.width, .minYMargin]
        content.addSubview(scroll); content.addSubview(sep); content.addSubview(field)
        contentView = content
        installGlass(on: self, content: content)
    }

    func show(commands: [Command], over parent: NSWindow) {
        all = commands; filtered = commands
        table.reloadData(); field.stringValue = ""
        let f = parent.frame
        setFrameTopLeftPoint(NSPoint(x: f.midX - 280, y: f.midY + 200))
        clampToWindow(self, parent: parent)
        parent.addChildWindow(self, ordered: .above)
        makeKeyAndOrderFront(nil); makeFirstResponder(field)
        if !filtered.isEmpty { table.selectRowIndexes([0], byExtendingSelection: false) }
    }
    func dismiss() { parent?.removeChildWindow(self); orderOut(nil) }

    private func filter(_ q: String) {
        if q.isEmpty { filtered = all } else {
            let ql = q.lowercased()
            filtered = all.filter { $0.title.lowercased().contains(ql) }
        }
        table.reloadData()
        if !filtered.isEmpty { table.selectRowIndexes([0], byExtendingSelection: false) }
    }
    @objc private func runSelected() {
        let r = table.selectedRow
        guard r >= 0, r < filtered.count else { return }
        let cmd = filtered[r]; dismiss(); cmd.run()
    }

    func numberOfRows(in t: NSTableView) -> Int { filtered.count }
    func tableView(_ t: NSTableView, viewFor col: NSTableColumn?, row: Int) -> NSView? {
        let id = NSUserInterfaceItemIdentifier("c")
        let cell = (t.makeView(withIdentifier: id, owner: self) as? NSTableCellView) ?? {
            let c = NSTableCellView(); c.identifier = id
            let tf = NSTextField(labelWithString: ""); tf.translatesAutoresizingMaskIntoConstraints = false
            c.addSubview(tf); c.textField = tf
            NSLayoutConstraint.activate([tf.leadingAnchor.constraint(equalTo: c.leadingAnchor, constant: 12),
                tf.centerYAnchor.constraint(equalTo: c.centerYAnchor),
                tf.trailingAnchor.constraint(equalTo: c.trailingAnchor, constant: -12)])
            return c
        }()
        let cmd = filtered[row]
        let s = NSMutableAttributedString(string: cmd.title, attributes: [.foregroundColor: Theme.fg, .font: NSFont.systemFont(ofSize: 13)])
        if !cmd.hint.isEmpty {
            s.append(NSAttributedString(string: "   \(cmd.hint)", attributes: [.foregroundColor: Theme.fgDim, .font: NSFont.systemFont(ofSize: 11)]))
        }
        cell.textField?.attributedStringValue = s
        return cell
    }

    func controlTextDidChange(_ obj: Notification) { filter(field.stringValue) }
    func control(_ c: NSControl, textView: NSTextView, doCommandBy sel: Selector) -> Bool {
        switch sel {
        case #selector(NSResponder.cancelOperation(_:)): dismiss(); return true
        case #selector(NSResponder.insertNewline(_:)): runSelected(); return true
        case #selector(NSResponder.moveDown(_:)):
            let r = min(table.selectedRow + 1, filtered.count - 1)
            if r >= 0 { table.selectRowIndexes([r], byExtendingSelection: false); table.scrollRowToVisible(r) }
            return true
        case #selector(NSResponder.moveUp(_:)):
            let r = max(table.selectedRow - 1, 0)
            table.selectRowIndexes([r], byExtendingSelection: false); table.scrollRowToVisible(r); return true
        default: return false
        }
    }
}
