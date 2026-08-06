import AppKit

// 워크스페이스별 메모 + 문서 패널.
//
// 메모 하나 = .md 파일 하나다 ([[NoteStore]]). 예전에는 JSON 배열 한 덩어리에 제목·본문을
// 넣어 뒀는데, 그러면 마크다운으로 미리 보거나 다른 도구로 넘기거나 에이전트가 문서를
// 남기는 게 전부 막힌다. 저장 위치는 예전 그대로 riven 지원 폴더다 (레포 안에 두면 git
// status 에 뜨고 에이전트의 `git add -A` 에 딸려 들어간다).
//
// 목록은 두 갈래를 보여 준다: 개인 메모, 그리고 워크스페이스 안의 .md 문서. 둘 다 같은
// 편집기·미리보기로 열린다.
//
// 저장은 디바운스(타이핑마다 디스크를 때리지 않게)하고, 선택 변경·워크스페이스 전환·앱
// 종료 때 강제로 흘려보낸다.

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
    private let revealButton = NSButton(title: "", target: nil, action: nil) // Finder 에서 보기
    private let revertButton = NSButton(title: "", target: nil, action: nil) // 에이전트 덮어쓰기 되돌리기
    private let savedLabel = NSTextField(labelWithString: "")
    private let sourceTabs = RivenTabStrip(frame: .zero)                     // 메모 / 문서
    private let modeTabs = RivenTabStrip(frame: .zero)                       // 편집 / 미리보기
    private let listScroll = NSScrollView()
    private let listStack = FlippedStack()
    private let titleField = NSTextField()
    private let body = NSTextView()
    private let bodyScroll = NSScrollView()
    private let preview = MarkdownView(frame: .zero)

    private var workspace: URL?
    private var personal: [Note] = []
    private var docs: [Note] = []
    private var selectedURL: URL?
    private var saveTimer: Timer?
    /// 에이전트가 만들거나 고친 메모 — 목록과 상세에 표시했다가 사용자가 열어 보면 지운다.
    private var agentTouched: Set<String> = []

    /// 워크스페이스 문서 탭을 보고 있는지 (0 = 메모, 1 = 문서).
    private var showingDocs = false
    private var previewing = false
    private var showingDetail = false

    override init(frame: NSRect) {
        super.init(frame: frame)
        wantsLayer = true
        layer?.backgroundColor = Theme.bg2.cgColor

        titleLabel.font = UIScale.font(UIScale.body, .medium)
        titleLabel.translatesAutoresizingMaskIntoConstraints = false
        savedLabel.font = UIScale.font(UIScale.small)
        savedLabel.translatesAutoresizingMaskIntoConstraints = false

        addButton.target = self; addButton.action = #selector(newNote)
        addButton.isBordered = false; addButton.font = UIScale.font(UIScale.title)
        addButton.toolTip = t("notes.new")
        addButton.translatesAutoresizingMaskIntoConstraints = false

        func iconButton(_ b: NSButton, _ symbol: String, _ tip: String, _ action: Selector) {
            b.target = self; b.action = action
            b.isBordered = false; b.imagePosition = .imageOnly
            b.image = NSImage(systemSymbolName: symbol, accessibilityDescription: tip)?
                .withSymbolConfiguration(.init(pointSize: UIScale.pt(11), weight: .regular))
            b.toolTip = tip
            b.translatesAutoresizingMaskIntoConstraints = false
        }
        iconButton(deleteButton, "trash", t("notes.delete"), #selector(deleteSelected))
        iconButton(revealButton, "folder", t("notes.reveal"), #selector(revealSelected))
        iconButton(revertButton, "arrow.uturn.backward", t("notes.revert"), #selector(revertSelected))

        backButton.target = self; backButton.action = #selector(showList)
        backButton.isBordered = false; backButton.imagePosition = .imageLeading
        backButton.image = NSImage(systemSymbolName: "chevron.left", accessibilityDescription: t("notes.back"))?
            .withSymbolConfiguration(.init(pointSize: UIScale.pt(10), weight: .semibold))
        backButton.title = " " + t("notes.back")
        backButton.font = UIScale.font(UIScale.small)
        backButton.translatesAutoresizingMaskIntoConstraints = false

        sourceTabs.tabs = [(t("notes.tabNotes"), nil), (t("notes.tabDocs"), nil)]
        sourceTabs.onSelect = { [weak self] i in self?.sourcePicked(i) }
        sourceTabs.translatesAutoresizingMaskIntoConstraints = false
        modeTabs.tabs = [(t("notes.edit"), nil), (t("notes.preview"), nil)]
        modeTabs.onSelect = { [weak self] i in self?.modePicked(i) }
        modeTabs.translatesAutoresizingMaskIntoConstraints = false

        listStack.orientation = .vertical; listStack.spacing = 0; listStack.alignment = .leading
        listStack.translatesAutoresizingMaskIntoConstraints = false
        listScroll.documentView = listStack
        listScroll.drawsBackground = false; listScroll.hasVerticalScroller = true
        listScroll.autohidesScrollers = true
        listScroll.translatesAutoresizingMaskIntoConstraints = false

        titleField.placeholderString = t("notes.titlePlaceholder")
        titleField.font = UIScale.font(UIScale.title, .semibold)
        titleField.isBordered = false; titleField.drawsBackground = false
        titleField.focusRingType = .none
        titleField.delegate = self
        titleField.translatesAutoresizingMaskIntoConstraints = false

        body.font = UIScale.mono(UIScale.prose)      // 마크다운 원문이므로 고정폭이 읽기 좋다
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
        preview.translatesAutoresizingMaskIntoConstraints = false

        [titleLabel, addButton, deleteButton, revealButton, revertButton, backButton, savedLabel,
         sourceTabs, listScroll, titleField, modeTabs, bodyScroll, preview].forEach { addSubview($0) }
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
            revealButton.trailingAnchor.constraint(equalTo: deleteButton.leadingAnchor, constant: -6),
            revealButton.centerYAnchor.constraint(equalTo: titleLabel.centerYAnchor),
            revealButton.widthAnchor.constraint(equalToConstant: UIScale.pt(20)),
            revertButton.trailingAnchor.constraint(equalTo: revealButton.leadingAnchor, constant: -6),
            revertButton.centerYAnchor.constraint(equalTo: titleLabel.centerYAnchor),
            revertButton.widthAnchor.constraint(equalToConstant: UIScale.pt(20)),
            savedLabel.trailingAnchor.constraint(equalTo: revertButton.leadingAnchor, constant: -8),
            savedLabel.centerYAnchor.constraint(equalTo: titleLabel.centerYAnchor),

            sourceTabs.leadingAnchor.constraint(equalTo: leadingAnchor, constant: 8),
            sourceTabs.trailingAnchor.constraint(equalTo: trailingAnchor, constant: -8),
            sourceTabs.topAnchor.constraint(equalTo: titleLabel.bottomAnchor, constant: 6),

            listScroll.leadingAnchor.constraint(equalTo: leadingAnchor),
            listScroll.trailingAnchor.constraint(equalTo: trailingAnchor),
            listScroll.topAnchor.constraint(equalTo: sourceTabs.bottomAnchor, constant: 2),
            listScroll.bottomAnchor.constraint(equalTo: bottomAnchor),
            listStack.topAnchor.constraint(equalTo: listScroll.contentView.topAnchor),
            listStack.leadingAnchor.constraint(equalTo: listScroll.contentView.leadingAnchor),
            listStack.widthAnchor.constraint(equalTo: listScroll.contentView.widthAnchor),

            titleField.leadingAnchor.constraint(equalTo: leadingAnchor, constant: 12),
            titleField.trailingAnchor.constraint(equalTo: trailingAnchor, constant: -10),
            titleField.topAnchor.constraint(equalTo: titleLabel.bottomAnchor, constant: 10),
            modeTabs.leadingAnchor.constraint(equalTo: leadingAnchor, constant: 8),
            modeTabs.trailingAnchor.constraint(equalTo: trailingAnchor, constant: -8),
            modeTabs.topAnchor.constraint(equalTo: titleField.bottomAnchor, constant: 4),
            bodyScroll.leadingAnchor.constraint(equalTo: leadingAnchor, constant: 4),
            bodyScroll.trailingAnchor.constraint(equalTo: trailingAnchor),
            bodyScroll.topAnchor.constraint(equalTo: modeTabs.bottomAnchor, constant: 2),
            bodyScroll.bottomAnchor.constraint(equalTo: bottomAnchor),
            preview.leadingAnchor.constraint(equalTo: leadingAnchor),
            preview.trailingAnchor.constraint(equalTo: trailingAnchor),
            preview.topAnchor.constraint(equalTo: modeTabs.bottomAnchor, constant: 2),
            preview.bottomAnchor.constraint(equalTo: bottomAnchor),
        ])
        applyTheme()
        setMode(detail: false)   // open on the list
        Theme.register(self); UIScale.register(self)
        langObserver = NotificationCenter.default.addObserver(forName: .rivenLanguageChanged, object: nil, queue: .main) { [weak self] _ in
            guard let self else { return }
            self.titleLabel.stringValue = t("title.notes")
            self.titleField.placeholderString = t("notes.titlePlaceholder")
            self.sourceTabs.tabs = [(t("notes.tabNotes"), nil), (t("notes.tabDocs"), nil)]
            self.modeTabs.tabs = [(t("notes.edit"), nil), (t("notes.preview"), nil)]
            self.renderList()
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
        revealButton.contentTintColor = Theme.fgDim
        revertButton.contentTintColor = Theme.warning
        titleField.textColor = Theme.fg
        body.textColor = Theme.fg
        body.insertionPointColor = Theme.fg
        renderList()
    }
    func applyScale() {
        titleLabel.font = UIScale.font(UIScale.body, .medium)
        savedLabel.font = UIScale.font(UIScale.small)
        addButton.font = UIScale.font(UIScale.title)
        titleField.font = UIScale.font(UIScale.title, .semibold)
        body.font = UIScale.mono(UIScale.prose)
        renderList()
    }

    // ---- workspace ----
    func setWorkspace(_ url: URL) {
        guard workspace != url else { return }
        flush()
        workspace = url
        selectedURL = nil
        reload()
        loadSelectionIntoEditor()
        setMode(detail: false)
    }

    /// 목록을 디스크에서 다시 읽는다.
    ///
    /// 개인 메모는 폴더 하나라 바로 읽는다 (1ms 미만). 워크스페이스 문서 훑기는 트리가
    /// 크면 수백 ms 가 걸려서 (여러 워크트리가 있는 폴더에서 229ms 를 쟀다) 메인 스레드에서
    /// 하면 패널을 열거나 에이전트가 문서를 쓸 때마다 화면이 멈춘다. 백그라운드에서 읽고
    /// 도착하면 그린다. 그동안은 직전 목록을 그대로 두고 "찾는 중" 만 알린다.
    func reload(force: Bool = false) {
        guard let ws = workspace else { personal = []; docs = []; renderList(); return }
        personal = NoteStore.personal(ws)
        renderList()
        guard showingDocs else { return }
        // 방금 훑었으면 다시 훑지 않는다. 목록을 여러 번 새로 그리는 경로가 많다
        // (패널 열기 → 탭 전환 → 에이전트 쓰기 알림이 잇달아 온다).
        if !force, let at = lastDocScan, Date().timeIntervalSince(at) < 3, !docs.isEmpty { return }
        scanDocs(ws)
    }
    private var lastDocScan: Date?
    private var docScanToken = 0
    private(set) var scanningDocs = false
    private func scanDocs(_ ws: URL) {
        docScanToken += 1
        let token = docScanToken
        scanningDocs = true
        if docs.isEmpty { renderList() }        // "찾는 중" 을 보여 준다
        DispatchQueue.global(qos: .userInitiated).async {
            let found = NoteStore.workspaceDocs(ws)
            DispatchQueue.main.async { [weak self] in
                guard let self, self.docScanToken == token, self.workspace == ws else { return }
                self.docs = found
                self.scanningDocs = false
                self.lastDocScan = Date()
                if self.showingDocs { self.renderList() }
            }
        }
    }

    private var visibleNotes: [Note] { showingDocs ? docs : personal }
    private var selected: Note? {
        guard let u = selectedURL else { return nil }
        let all = personal + docs
        return all.first { $0.url == u } ?? (FileManager.default.fileExists(atPath: u.path)
            ? NoteStore.note(u, scope: u.path.hasPrefix(workspace?.path ?? "\u{0}") ? .workspace : .personal)
            : nil)
    }

    // ---- master ⇄ detail ----
    private func setMode(detail: Bool) {
        showingDetail = detail
        listScroll.isHidden = detail
        sourceTabs.isHidden = detail
        titleField.isHidden = !detail
        modeTabs.isHidden = !detail
        bodyScroll.isHidden = !detail || previewing
        preview.isHidden = !detail || !previewing
        backButton.isHidden = !detail
        deleteButton.isHidden = !detail
        revealButton.isHidden = !detail
        revertButton.isHidden = !detail || !(selected.map { NoteStore.hasBackup($0.url) } ?? false)
        addButton.isHidden = detail
        savedLabel.isHidden = !detail
        titleLabel.isHidden = detail          // the back button + note title field carry the header in detail
        titleLabel.stringValue = t("title.notes")
    }
    @objc private func showList() {
        flush()
        setMode(detail: false)
        reload()
    }
    private func sourcePicked(_ i: Int) {
        showingDocs = (i == 1)
        reload()
    }
    private func modePicked(_ i: Int) {
        previewing = (i == 1)
        if previewing {
            flush()                                    // 미리보기는 지금 쓴 내용을 보여 줘야 한다
            // 제목은 위 입력줄이 이미 보여준다. 여기서 compose 로 다시 넣으면 같은 제목이
            // H1 로 한 번 더 그려져 "제목이 두 개"처럼 보인다.
            preview.setMarkdown(body.string)
        }
        setMode(detail: showingDetail)
    }

    // ---- list ----
    /// 마지막으로 그린 목록의 지문. 같은 목록을 또 그리지 않기 위한 것 — 문서 100여 개면
    /// 줄을 새로 만드는 데만 40ms 가 든다. 목록을 새로 그리는 경로가 여럿이라 (패널 열기,
    /// 탭 전환, 에이전트 알림, 저장) 그때마다 값을 치르고 있었다.
    private var renderedKey = ""

    private func renderList() {
        let notes = visibleNotes
        let key = "\(showingDocs)|\(scanningDocs)|" + notes.map { "\($0.url.path)\t\($0.title)\t\($0.updated.timeIntervalSince1970)" }
            .joined(separator: "\n")
        guard key != renderedKey else { return }
        renderedKey = key
        listStack.arrangedSubviews.forEach { $0.removeFromSuperview() }
        guard !notes.isEmpty else {
            let hint = NSTextField(labelWithString: showingDocs
                                   ? (scanningDocs ? t("notes.scanning") : t("notes.noDocs"))
                                   : t("notes.empty"))
            hint.font = UIScale.font(UIScale.body); hint.textColor = Theme.fgDim
            hint.lineBreakMode = .byWordWrapping; hint.maximumNumberOfLines = 3
            hint.translatesAutoresizingMaskIntoConstraints = false
            let c = NSView(); c.addSubview(hint)
            NSLayoutConstraint.activate([
                hint.leadingAnchor.constraint(equalTo: c.leadingAnchor, constant: 12),
                hint.trailingAnchor.constraint(lessThanOrEqualTo: c.trailingAnchor, constant: -12),
                hint.topAnchor.constraint(equalTo: c.topAnchor, constant: 10),
                hint.bottomAnchor.constraint(equalTo: c.bottomAnchor, constant: -10)])
            listStack.addArrangedSubview(c)
            c.widthAnchor.constraint(equalTo: listStack.widthAnchor).isActive = true
            return
        }
        for n in notes {
            let row = noteRow(n)
            listStack.addArrangedSubview(row)
            row.widthAnchor.constraint(equalTo: listStack.widthAnchor).isActive = true
        }
    }
    private func noteRow(_ n: Note) -> NSView {
        let row = NoteRow()
        row.wantsLayer = true
        let isSel = (n.url == selectedURL)
        row.layer?.backgroundColor = isSel ? Theme.hover.cgColor : NSColor.clear.cgColor
        row.onSelect = { [weak self] in self?.select(n.url) }
        row.translatesAutoresizingMaskIntoConstraints = false

        let name = NSTextField(labelWithString: n.title)
        name.font = UIScale.font(UIScale.title, isSel ? .semibold : .regular)
        name.textColor = Theme.fg
        name.lineBreakMode = .byTruncatingTail
        name.translatesAutoresizingMaskIntoConstraints = false
        let time = NSTextField(labelWithString: ago(n.updated))
        time.font = UIScale.font(UIScale.small); time.textColor = Theme.fgDim
        time.setContentHuggingPriority(.required, for: .horizontal)
        time.translatesAutoresizingMaskIntoConstraints = false

        row.addSubview(name); row.addSubview(time)
        var cons: [NSLayoutConstraint] = [
            row.heightAnchor.constraint(equalToConstant: UIMetrics.rowHCompact),
            name.centerYAnchor.constraint(equalTo: row.centerYAnchor),
            time.leadingAnchor.constraint(greaterThanOrEqualTo: name.trailingAnchor, constant: 6),
            time.trailingAnchor.constraint(equalTo: row.trailingAnchor, constant: -10),
            time.centerYAnchor.constraint(equalTo: row.centerYAnchor)
        ]
        // 에이전트가 쓴 메모에는 점을 찍는다 — 목록만 보고도 "내가 안 쓴 게 생겼다"가 보여야 한다.
        if agentTouched.contains(n.url.path) {
            let dot = NSView(); dot.wantsLayer = true
            dot.layer?.backgroundColor = Theme.accent.cgColor
            dot.layer?.cornerRadius = UIScale.pt(3)
            dot.translatesAutoresizingMaskIntoConstraints = false
            dot.toolTip = t("notes.byAgent")
            row.addSubview(dot)
            cons += [
                dot.leadingAnchor.constraint(equalTo: row.leadingAnchor, constant: 6),
                dot.centerYAnchor.constraint(equalTo: row.centerYAnchor),
                dot.widthAnchor.constraint(equalToConstant: UIScale.pt(6)),
                dot.heightAnchor.constraint(equalToConstant: UIScale.pt(6)),
                name.leadingAnchor.constraint(equalTo: dot.trailingAnchor, constant: 5),
            ]
        } else {
            cons.append(name.leadingAnchor.constraint(equalTo: row.leadingAnchor, constant: 12))
        }
        NSLayoutConstraint.activate(cons)
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
    private func select(_ url: URL) {
        flush()                       // don't lose edits to the note we're leaving
        selectedURL = url
        agentTouched.remove(url.path)  // 열어 봤으면 "새로 생김" 표시는 지운다
        loadSelectionIntoEditor()
        setMode(detail: true)
        if previewing { modePicked(1) } else { window?.makeFirstResponder(body) }
    }
    private func loadSelectionIntoEditor() {
        guard let n = selected else {
            titleField.stringValue = ""; body.string = ""
            titleField.isEditable = false; body.isEditable = false
            savedLabel.stringValue = ""
            return
        }
        let (title, text) = NoteStore.split(n.read())
        titleField.stringValue = title
        body.string = text
        titleField.isEditable = true; body.isEditable = true
        savedLabel.stringValue = t("notes.savedAt", ["t": ago(n.updated)])
        if previewing { preview.setMarkdown(text) }
    }
    @objc private func newNote() {
        guard let ws = workspace else { return }
        flush()
        showingDocs = false; sourceTabs.select(0)
        let n = NoteStore.create(in: ws, title: "")
        personal.insert(n, at: 0)
        selectedURL = n.url
        loadSelectionIntoEditor()
        previewing = false; modeTabs.select(0)
        setMode(detail: true)
        window?.makeFirstResponder(titleField)
    }
    @objc private func deleteSelected() {
        guard let n = selected else { return }
        saveTimer?.invalidate(); saveTimer = nil
        // 워크스페이스 문서는 사용자의 소스 파일이다 — 패널에서 지우지 않고 목록에서만 뺀다.
        if n.scope == .workspace {
            selectedURL = nil
            loadSelectionIntoEditor(); setMode(detail: false); reload()
            return
        }
        NoteStore.delete(n)
        selectedURL = nil
        loadSelectionIntoEditor()
        setMode(detail: false)
        reload()
    }
    @objc private func revealSelected() {
        guard let n = selected else { return }
        NSWorkspace.shared.activateFileViewerSelecting([n.url])
    }
    @objc private func revertSelected() {
        guard let n = selected, NoteStore.restoreBackup(n.url) else { return }
        saveTimer?.invalidate(); saveTimer = nil
        loadSelectionIntoEditor()
        if previewing { preview.setMarkdown(NoteStore.compose(title: titleField.stringValue, body: body.string)) }
        setMode(detail: true)
        reload()
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
        guard let n = selected, titleField.isEditable else { return }
        let text = NoteStore.compose(title: titleField.stringValue, body: body.string)
        guard text != n.read() else { return }
        // 사람이 저장할 때는 .bak 를 남기지 않는다 (매 타이핑마다 백업이 도는 건 낭비고,
        // 편집기에는 실행 취소가 있다). .bak 는 에이전트 덮어쓰기 전용이다.
        NoteStore.write(text, to: n.url, backup: false)
        savedLabel.stringValue = t("notes.savedAt", ["t": t("time.now")])
        reload()
    }

    // ---- 바깥에서 들어오는 변경 (에이전트 / 탐색기) ----

    /// 특정 .md 파일을 이 패널에서 연다 (탐색기의 "메모로 열기", 에이전트가 쓴 메모 보여주기).
    /// 벤치용: 미리보기에 제목이 두 번 나오는지 (제목 필드 + 본문 H1).
    func debugPreviewHasTitleTwice() -> Bool {
        let title = titleField.stringValue.trimmingCharacters(in: .whitespaces)
        guard !title.isEmpty else { return false }
        return preview.debugText().hasPrefix("# " + title)
    }
    /// 벤치용: 지금 열려 있는 문서 경로.
    func debugCurrentPath() -> String { selectedURL?.lastPathComponent ?? "(없음)" }

    func open(_ url: URL) {
        flush()
        let inWs = workspace.map { url.path.hasPrefix($0.path) } ?? false
        if inWs != showingDocs { showingDocs = inWs; sourceTabs.select(inWs ? 1 : 0) }
        reload()
        select(url)
    }

    /// 검증용: 편집 ↔ 미리보기 전환 (탭을 누른 것과 같은 경로).
    func debugSetPreview(_ on: Bool) {
        modeTabs.select(on ? 1 : 0)
        modePicked(on ? 1 : 0)
    }
    /// 검증용: 목록으로 (뒤로 버튼과 같은 경로). docs = 워크스페이스 문서 탭.
    func debugShowList(docs: Bool = false) {
        showList()
        sourceTabs.select(docs ? 1 : 0)
        sourcePicked(docs ? 1 : 0)
    }

    /// 에이전트가 메모를 만들거나 고쳤다. 목록을 다시 읽고 표시를 남긴다.
    /// 지금 그 메모를 열어 둔 상태면 편집기 내용도 새로 읽는다 (사용자가 보던 화면이
    /// 디스크와 어긋나지 않게).
    func debugDocCount() -> Int { docs.count }
    func noteChangedByAgent(_ url: URL) {
        agentTouched.insert(url.path)
        reload(force: true)      // 방금 쓴 문서가 목록에 바로 보여야 한다
        // 에이전트가 쓴 문서를 바로 펼친다. 예전에는 목록만 갱신해서 패널만 열리고
        // 정작 무엇을 썼는지 사용자가 다시 찾아 들어가야 했다.
        if selectedURL != url { open(url); return }
        if selectedURL == url {
            saveTimer?.invalidate(); saveTimer = nil
            loadSelectionIntoEditor()
            if previewing { preview.setMarkdown(body.string) }
        }
        setMode(detail: showingDetail)   // 되돌리기 버튼 노출 갱신
    }
}
