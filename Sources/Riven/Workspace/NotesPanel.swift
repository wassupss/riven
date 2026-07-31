import AppKit

// Per-workspace private notes — a LIST of notes (title + body + last-saved time), not one
// scratchpad. Each workspace gets its own list.
//
// Storage is riven's own support dir keyed by the workspace path, NOT a file inside the
// project: a note in the working tree would show up in git status, get committed by an
// agent's `git add -A`, and be shared with the team. These are personal notes, so they stay
// out of the repository entirely.
//
// Saves are debounced (typing shouldn't hit the disk on every keystroke) and flushed on
// selection change / workspace switch / app termination so nothing is lost.
struct Note: Codable {
    var id: String
    var title: String
    var body: String
    var updated: Date
    /// The title to show — falls back to the body's first line, then a placeholder.
    var displayTitle: String {
        let t0 = title.trimmingCharacters(in: .whitespacesAndNewlines)
        if !t0.isEmpty { return t0 }
        let firstLine = body.split(separator: "\n").first.map(String.init)?
            .trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        return firstLine.isEmpty ? t("notes.untitled") : firstLine
    }
}

// A clickable list row (mirrors RailRow — NSView has no built-in click callback).
final class NoteRow: NSView {
    var onSelect: (() -> Void)?
    override func mouseDown(with event: NSEvent) { onSelect?() }
}

final class NotesPanel: NSView, Themable, Scalable, NSTextViewDelegate, NSTextFieldDelegate {
    private let titleLabel = NSTextField(labelWithString: t("title.notes"))
    private let addButton = NSButton(title: "+", target: nil, action: nil)
    private let deleteButton = NSButton(title: "", target: nil, action: nil)
    private let backButton = NSButton(title: "", target: nil, action: nil)   // detail → list
    private let savedLabel = NSTextField(labelWithString: "")
    private let listScroll = NSScrollView()
    private let listStack = FlippedStack()
    private let titleField = NSTextField()
    private let body = NSTextView()
    private let bodyScroll = NSScrollView()

    private var workspace: URL?
    private var notes: [Note] = []
    private var selectedId: String?
    private var saveTimer: Timer?

    override init(frame: NSRect) {
        super.init(frame: frame)
        wantsLayer = true
        layer?.backgroundColor = Theme.bg2.cgColor

        titleLabel.font = UIScale.font(UIScale.body, .medium)
        titleLabel.translatesAutoresizingMaskIntoConstraints = false
        savedLabel.font = UIScale.font(UIScale.caption)
        savedLabel.translatesAutoresizingMaskIntoConstraints = false

        addButton.target = self; addButton.action = #selector(newNote)
        addButton.isBordered = false; addButton.font = UIScale.font(UIScale.title)
        addButton.toolTip = t("notes.new")
        addButton.translatesAutoresizingMaskIntoConstraints = false

        deleteButton.target = self; deleteButton.action = #selector(deleteSelected)
        deleteButton.isBordered = false; deleteButton.imagePosition = .imageOnly
        deleteButton.image = NSImage(systemSymbolName: "trash", accessibilityDescription: t("notes.delete"))?
            .withSymbolConfiguration(.init(pointSize: UIScale.pt(11), weight: .regular))
        deleteButton.toolTip = t("notes.delete")
        deleteButton.translatesAutoresizingMaskIntoConstraints = false

        backButton.target = self; backButton.action = #selector(showList)
        backButton.isBordered = false; backButton.imagePosition = .imageLeading
        backButton.image = NSImage(systemSymbolName: "chevron.left", accessibilityDescription: t("notes.back"))?
            .withSymbolConfiguration(.init(pointSize: UIScale.pt(10), weight: .semibold))
        backButton.title = " " + t("notes.back")
        backButton.font = UIScale.font(UIScale.small)
        backButton.translatesAutoresizingMaskIntoConstraints = false

        listStack.orientation = .vertical; listStack.spacing = 0; listStack.alignment = .leading
        listStack.translatesAutoresizingMaskIntoConstraints = false
        listScroll.documentView = listStack
        listScroll.drawsBackground = false; listScroll.hasVerticalScroller = true
        listScroll.autohidesScrollers = true
        listScroll.translatesAutoresizingMaskIntoConstraints = false


        titleField.placeholderString = t("notes.titlePlaceholder")
        titleField.font = UIScale.font(UIScale.body, .semibold)
        titleField.isBordered = false; titleField.drawsBackground = false
        titleField.focusRingType = .none
        titleField.delegate = self
        titleField.translatesAutoresizingMaskIntoConstraints = false

        body.font = UIScale.font(UIScale.body)
        body.isRichText = false; body.allowsUndo = true; body.drawsBackground = false
        body.delegate = self
        body.textContainerInset = NSSize(width: 8, height: 8)
        body.isVerticallyResizable = true; body.isHorizontallyResizable = false
        body.autoresizingMask = [.width]
        body.textContainer?.widthTracksTextView = true
        bodyScroll.documentView = body
        bodyScroll.drawsBackground = false; bodyScroll.hasVerticalScroller = true
        bodyScroll.autohidesScrollers = true
        bodyScroll.translatesAutoresizingMaskIntoConstraints = false

        [titleLabel, addButton, deleteButton, backButton, savedLabel, listScroll, titleField, bodyScroll].forEach { addSubview($0) }
        // Restore the user's split (fraction of panel height); applied once we have a real height.
        // List on top, editor below. A plain height ratio (not an NSSplitView) — deterministic and
        // it can't ghost/flatten on relayout, the failure the sub-agent split used to hit.
        NSLayoutConstraint.activate([
            backButton.leadingAnchor.constraint(equalTo: leadingAnchor, constant: 8),
            backButton.centerYAnchor.constraint(equalTo: titleLabel.centerYAnchor),
            titleLabel.leadingAnchor.constraint(equalTo: leadingAnchor, constant: 12),
            titleLabel.topAnchor.constraint(equalTo: topAnchor, constant: 8),
            addButton.leadingAnchor.constraint(equalTo: titleLabel.trailingAnchor, constant: 6),
            addButton.centerYAnchor.constraint(equalTo: titleLabel.centerYAnchor),
            addButton.widthAnchor.constraint(equalToConstant: UIScale.pt(20)),
            deleteButton.trailingAnchor.constraint(equalTo: trailingAnchor, constant: -10),
            deleteButton.centerYAnchor.constraint(equalTo: titleLabel.centerYAnchor),
            deleteButton.widthAnchor.constraint(equalToConstant: UIScale.pt(20)),
            savedLabel.trailingAnchor.constraint(equalTo: deleteButton.leadingAnchor, constant: -8),
            savedLabel.centerYAnchor.constraint(equalTo: titleLabel.centerYAnchor),

            listScroll.leadingAnchor.constraint(equalTo: leadingAnchor),
            listScroll.trailingAnchor.constraint(equalTo: trailingAnchor),
            listScroll.topAnchor.constraint(equalTo: titleLabel.bottomAnchor, constant: 8),
            listScroll.bottomAnchor.constraint(equalTo: bottomAnchor),
            listStack.topAnchor.constraint(equalTo: listScroll.contentView.topAnchor),
            listStack.leadingAnchor.constraint(equalTo: listScroll.contentView.leadingAnchor),
            listStack.widthAnchor.constraint(equalTo: listScroll.contentView.widthAnchor),

            titleField.leadingAnchor.constraint(equalTo: leadingAnchor, constant: 12),
            titleField.trailingAnchor.constraint(equalTo: trailingAnchor, constant: -10),
            titleField.topAnchor.constraint(equalTo: titleLabel.bottomAnchor, constant: 10),
            bodyScroll.leadingAnchor.constraint(equalTo: leadingAnchor, constant: 4),
            bodyScroll.trailingAnchor.constraint(equalTo: trailingAnchor),
            bodyScroll.topAnchor.constraint(equalTo: titleField.bottomAnchor, constant: 4),
            bodyScroll.bottomAnchor.constraint(equalTo: bottomAnchor)
        ])
        applyTheme()
        setMode(detail: false)   // open on the list
        Theme.register(self); UIScale.register(self)
        langObserver = NotificationCenter.default.addObserver(forName: .rivenLanguageChanged, object: nil, queue: .main) { [weak self] _ in
            self?.titleLabel.stringValue = t("title.notes")
            self?.titleField.placeholderString = t("notes.titlePlaceholder")
            self?.renderList()
        }
    }
    required init?(coder: NSCoder) { fatalError() }

    private var langObserver: NSObjectProtocol?
    deinit {
        if let o = langObserver { NotificationCenter.default.removeObserver(o) }
        saveTimer?.invalidate()
    }

    func applyTheme() {
        layer?.backgroundColor = Theme.bg2.cgColor
        titleLabel.textColor = Theme.fg
        savedLabel.textColor = Theme.fgDim
        addButton.contentTintColor = Theme.fgDim
        deleteButton.contentTintColor = Theme.fgDim
        titleField.textColor = Theme.fg
        body.textColor = Theme.fg
        body.insertionPointColor = Theme.fg
        renderList()
    }
    func applyScale() {
        titleLabel.font = UIScale.font(UIScale.body, .medium)
        savedLabel.font = UIScale.font(UIScale.caption)
        addButton.font = UIScale.font(UIScale.title)
        titleField.font = UIScale.font(UIScale.body, .semibold)
        body.font = UIScale.font(UIScale.body)
        renderList()
    }

    // ---- workspace ----
    func setWorkspace(_ url: URL) {
        guard workspace != url else { return }
        flush()
        workspace = url
        notes = NotesPanel.load(url)
        selectedId = nil
        loadSelectionIntoEditor()
        setMode(detail: false)
        renderList()
    }

    // ---- master ⇄ detail ----
    // The panel shows EITHER the list or one note, swapped by selection / the back button. A fixed
    // top-bottom split made both halves too short in a narrow dock panel; this uses the full height.
    private var showingDetail = false
    private func setMode(detail: Bool) {
        showingDetail = detail
        listScroll.isHidden = detail
        titleField.isHidden = !detail; bodyScroll.isHidden = !detail
        backButton.isHidden = !detail
        deleteButton.isHidden = !detail
        addButton.isHidden = detail
        savedLabel.isHidden = !detail
        titleLabel.stringValue = detail ? (selected?.displayTitle ?? t("title.notes")) : t("title.notes")
        titleLabel.isHidden = detail          // the back button + note title field carry the header in detail
    }
    @objc private func showList() {
        flush()
        setMode(detail: false)
        renderList()
    }

    // ---- list ----
    private func renderList() {
        listStack.arrangedSubviews.forEach { $0.removeFromSuperview() }
        guard !notes.isEmpty else {
            let hint = NSTextField(labelWithString: t("notes.empty"))
            hint.font = UIScale.font(UIScale.small); hint.textColor = Theme.fgDim
            hint.translatesAutoresizingMaskIntoConstraints = false
            let c = NSView(); c.addSubview(hint)
            NSLayoutConstraint.activate([
                hint.leadingAnchor.constraint(equalTo: c.leadingAnchor, constant: 12),
                hint.topAnchor.constraint(equalTo: c.topAnchor, constant: 10),
                hint.bottomAnchor.constraint(equalTo: c.bottomAnchor, constant: -10)])
            listStack.addArrangedSubview(c)
            c.widthAnchor.constraint(equalTo: listStack.widthAnchor).isActive = true
            return
        }
        for n in notes.sorted(by: { $0.updated > $1.updated }) {   // newest first
            let row = noteRow(n)
            listStack.addArrangedSubview(row)
            row.widthAnchor.constraint(equalTo: listStack.widthAnchor).isActive = true
        }
    }
    private func noteRow(_ n: Note) -> NSView {
        let row = NoteRow()
        row.wantsLayer = true
        let isSel = (n.id == selectedId)
        row.layer?.backgroundColor = isSel ? Theme.hover.cgColor : NSColor.clear.cgColor
        row.onSelect = { [weak self] in self?.select(n.id) }
        row.translatesAutoresizingMaskIntoConstraints = false

        let name = NSTextField(labelWithString: n.displayTitle)
        name.font = UIScale.font(UIScale.body, isSel ? .semibold : .regular)
        name.textColor = Theme.fg
        name.lineBreakMode = .byTruncatingTail
        name.translatesAutoresizingMaskIntoConstraints = false
        let time = NSTextField(labelWithString: ago(n.updated))
        time.font = UIScale.font(UIScale.caption); time.textColor = Theme.fgDim
        time.setContentHuggingPriority(.required, for: .horizontal)
        time.translatesAutoresizingMaskIntoConstraints = false

        row.addSubview(name); row.addSubview(time)
        NSLayoutConstraint.activate([
            row.heightAnchor.constraint(equalToConstant: UIScale.pt(26)),
            name.leadingAnchor.constraint(equalTo: row.leadingAnchor, constant: 12),
            name.centerYAnchor.constraint(equalTo: row.centerYAnchor),
            time.leadingAnchor.constraint(greaterThanOrEqualTo: name.trailingAnchor, constant: 6),
            time.trailingAnchor.constraint(equalTo: row.trailingAnchor, constant: -10),
            time.centerYAnchor.constraint(equalTo: row.centerYAnchor)
        ])
        return row
    }
    private func ago(_ date: Date) -> String {
        let s = Int(-date.timeIntervalSinceNow)
        if s < 5 { return t("time.now") }
        if s < 60 { return t("time.sec", ["n": s]) }
        if s < 3600 { return t("time.min", ["n": s / 60]) }
        if s < 86400 { return t("time.hour", ["n": s / 3600]) }
        return t("time.day", ["n": s / 86400])
    }

    // ---- selection / editing ----
    private func select(_ id: String) {
        flush()                       // don't lose edits to the note we're leaving
        selectedId = id
        loadSelectionIntoEditor()
        setMode(detail: true)         // clicking a row opens it full-height
        window?.makeFirstResponder(body)
    }
    private var selected: Note? { notes.first { $0.id == selectedId } }
    private func loadSelectionIntoEditor() {
        let n = selected
        titleField.stringValue = n?.title ?? ""
        body.string = n?.body ?? ""
        let editable = (n != nil)
        titleField.isEditable = editable; body.isEditable = editable
        deleteButton.isHidden = !editable
        savedLabel.stringValue = n.map { t("notes.savedAt", ["t": ago($0.updated)]) } ?? ""
    }
    @objc private func newNote() {
        flush()
        let n = Note(id: UUID().uuidString, title: "", body: "", updated: Date())
        notes.append(n)
        selectedId = n.id
        loadSelectionIntoEditor()
        setMode(detail: true)
        window?.makeFirstResponder(titleField)
        persist()
    }
    @objc private func deleteSelected() {
        guard let id = selectedId else { return }
        saveTimer?.invalidate(); saveTimer = nil
        notes.removeAll { $0.id == id }
        selectedId = nil
        loadSelectionIntoEditor()
        persist()
        setMode(detail: false)        // deleting returns you to the list
        renderList()
    }
    func textDidChange(_ notification: Notification) { touch() }
    func controlTextDidChange(_ obj: Notification) { touch() }
    private func touch() {
        savedLabel.stringValue = t("notes.editing")
        saveTimer?.invalidate()
        saveTimer = Timer.scheduledTimer(withTimeInterval: 0.8, repeats: false) { [weak self] _ in self?.flush() }
    }

    /// Write pending edits to disk now (debounce cancelled). Safe when nothing changed.
    func flush() {
        saveTimer?.invalidate(); saveTimer = nil
        guard let id = selectedId, let i = notes.firstIndex(where: { $0.id == id }) else { return }
        let newTitle = titleField.stringValue, newBody = body.string
        guard notes[i].title != newTitle || notes[i].body != newBody else { return }
        notes[i].title = newTitle; notes[i].body = newBody; notes[i].updated = Date()
        persist()
        savedLabel.stringValue = t("notes.savedAt", ["t": t("time.now")])
        renderList()   // title/time in the list follow the edit
    }
    private func persist() {
        guard let ws = workspace else { return }
        NotesPanel.save(notes, for: ws)
    }

    // ---- storage (riven's support dir, keyed by workspace path) ----
    private static func fileURL(_ ws: URL) -> URL {
        let dir = AgentHookServer.ensureSupportDir().appendingPathComponent("notes", isDirectory: true)
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        // Same path-encoding scheme the CLI uses for its project dirs: every non-alphanumeric → "-".
        let enc = ws.path.map { $0.isLetter || $0.isNumber ? String($0) : "-" }.joined()
        return dir.appendingPathComponent("\(enc).json")
    }
    static func load(_ ws: URL) -> [Note] {
        guard let d = try? Data(contentsOf: fileURL(ws)) else { return [] }
        let dec = JSONDecoder(); dec.dateDecodingStrategy = .iso8601
        return (try? dec.decode([Note].self, from: d)) ?? []
    }
    static func save(_ notes: [Note], for ws: URL) {
        let url = fileURL(ws)
        // Drop fully-empty notes so an accidental "+" doesn't leave clutter behind.
        let keep = notes.filter { !($0.title.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
                                    && $0.body.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty) }
        if keep.isEmpty { try? FileManager.default.removeItem(at: url); return }
        let enc = JSONEncoder(); enc.dateEncodingStrategy = .iso8601; enc.outputFormatting = [.prettyPrinted]
        if let d = try? enc.encode(keep) { try? d.write(to: url, options: .atomic) }
    }
}
