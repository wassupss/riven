import AppKit

// 기록·북마크를 보고 지우는 창 (⌘Y).
//
// 모아 두기만 하고 볼 방법이 없으면 없는 것과 같다. 팝오버 하나에 두 목록을 얹고, 위에
// 검색 한 줄을 둔다 — 브라우저에서 기록을 여는 이유는 대개 "그거 뭐였더라" 라서, 목록을
// 훑는 것보다 치는 게 빠르다.
final class LibraryView: NSView, Themable {
    var onOpen: ((String) -> Void)?

    private enum Mode { case history, bookmarks }
    private var mode: Mode = .history
    private let tabs = RivenTabStrip(frame: .zero)
    private let search = NSTextField()
    private let scroll = NSScrollView()
    private let stack = NSStackView()
    private let empty = NSTextField(labelWithString: "")

    override init(frame: NSRect) {
        super.init(frame: frame)
        wantsLayer = true

        tabs.tabs = [(t("browser.history"), nil), (t("browser.bookmarks"), nil)]
        tabs.onSelect = { [weak self] i in
            self?.mode = (i == 0) ? .history : .bookmarks
            self?.reload()
        }
        tabs.translatesAutoresizingMaskIntoConstraints = false

        search.placeholderString = t("browser.libSearch")
        search.font = UIScale.font(UIScale.small)
        search.bezelStyle = .roundedBezel
        search.target = self; search.action = #selector(reloadFromSearch)
        search.delegate = self
        search.translatesAutoresizingMaskIntoConstraints = false

        stack.orientation = .vertical; stack.spacing = 0; stack.alignment = .leading
        stack.translatesAutoresizingMaskIntoConstraints = false
        // 뒤집힌 컨테이너에 담아야 줄이 위에서부터 쌓인다. 그냥 두면 목록이 짧을 때
        // 바닥에 붙어 뜬다 (AppKit 좌표가 아래에서 위로 가므로).
        let doc = FlippedView()
        doc.translatesAutoresizingMaskIntoConstraints = false
        doc.addSubview(stack)
        scroll.documentView = doc
        scroll.drawsBackground = false
        scroll.hasVerticalScroller = true
        scroll.translatesAutoresizingMaskIntoConstraints = false

        empty.font = UIScale.font(UIScale.small)
        empty.alignment = .center
        empty.translatesAutoresizingMaskIntoConstraints = false

        [tabs, search, scroll, empty].forEach { addSubview($0) }
        NSLayoutConstraint.activate([
            tabs.leadingAnchor.constraint(equalTo: leadingAnchor),
            tabs.trailingAnchor.constraint(equalTo: trailingAnchor),
            tabs.topAnchor.constraint(equalTo: topAnchor),
            search.leadingAnchor.constraint(equalTo: leadingAnchor, constant: 10),
            search.trailingAnchor.constraint(equalTo: trailingAnchor, constant: -10),
            search.topAnchor.constraint(equalTo: tabs.bottomAnchor, constant: 8),
            scroll.leadingAnchor.constraint(equalTo: leadingAnchor),
            scroll.trailingAnchor.constraint(equalTo: trailingAnchor),
            scroll.topAnchor.constraint(equalTo: search.bottomAnchor, constant: 6),
            scroll.bottomAnchor.constraint(equalTo: bottomAnchor, constant: -8),
            doc.topAnchor.constraint(equalTo: scroll.contentView.topAnchor),
            doc.leadingAnchor.constraint(equalTo: scroll.contentView.leadingAnchor),
            doc.widthAnchor.constraint(equalTo: scroll.widthAnchor),
            stack.topAnchor.constraint(equalTo: doc.topAnchor),
            stack.leadingAnchor.constraint(equalTo: doc.leadingAnchor),
            stack.trailingAnchor.constraint(equalTo: doc.trailingAnchor),
            stack.bottomAnchor.constraint(equalTo: doc.bottomAnchor),
            empty.centerXAnchor.constraint(equalTo: centerXAnchor),
            empty.centerYAnchor.constraint(equalTo: scroll.centerYAnchor),
        ])
        Theme.register(self)
    }
    required init?(coder: NSCoder) { fatalError() }

    @objc private func reloadFromSearch() { reload() }

    func reload() {
        let q = search.stringValue.trimmingCharacters(in: .whitespaces).lowercased()
        stack.arrangedSubviews.forEach { $0.removeFromSuperview() }

        let rows: [(title: String, url: String, note: String)]
        switch mode {
        case .history:
            rows = BrowserStore.history(limit: 300)
                .filter { q.isEmpty || $0.title.lowercased().contains(q) || $0.url.lowercased().contains(q) }
                .map { ($0.title.isEmpty ? $0.url : $0.title, $0.url, Self.ago($0.last)) }
        case .bookmarks:
            rows = BrowserStore.bookmarks()
                .filter { q.isEmpty || $0.title.lowercased().contains(q) || $0.url.lowercased().contains(q) }
                .map { ($0.title, $0.url, $0.folder) }
        }
        empty.stringValue = q.isEmpty
            ? (mode == .history ? t("browser.noHistory") : t("browser.noBookmarks"))
            : t("browser.noMatch")
        empty.textColor = Theme.fgDim
        empty.isHidden = !rows.isEmpty

        for r in rows {
            let row = Row()
            row.configure(r.title, url: r.url, note: r.note)
            row.onOpen = { [weak self] in self?.onOpen?(r.url) }
            row.onRemove = { [weak self] in
                guard let self else { return }
                if self.mode == .history { BrowserStore.removeHistory(url: r.url) }
                else { BrowserStore.removeBookmark(url: r.url) }
                self.reload()
            }
            stack.addArrangedSubview(row)
            row.widthAnchor.constraint(equalTo: stack.widthAnchor).isActive = true
        }
    }

    /// "3분 전" 처럼. 날짜를 통째로 보여 주면 목록이 시끄럽다.
    private static func ago(_ d: Date) -> String {
        let s = Int(Date().timeIntervalSince(d))
        if s < 60 { return t("time.justNow") }
        if s < 3600 { return t("time.minsAgo", ["n": String(s / 60)]) }
        if s < 86_400 { return t("time.hoursAgo", ["n": String(s / 3600)]) }
        return t("time.daysAgo", ["n": String(s / 86_400)])
    }

    func applyTheme() {
        layer?.backgroundColor = Theme.bg.cgColor
        empty.textColor = Theme.fgDim
        reload()
    }

    /// 한 줄: 파비콘 + 제목 + 시간/폴더 + (올리면) 지우기.
    private final class Row: NSView {
        var onOpen: (() -> Void)?
        var onRemove: (() -> Void)?
        private let icon = NSImageView()
        private let title = NSTextField(labelWithString: "")
        private let sub = NSTextField(labelWithString: "")
        private let note = NSTextField(labelWithString: "")
        private let del = NSButton()
        private var track: NSTrackingArea?

        override init(frame: NSRect) {
            super.init(frame: frame)
            wantsLayer = true
            del.image = NSImage(systemSymbolName: "xmark", accessibilityDescription: t("common.delete"))
            del.image?.isTemplate = true; del.imagePosition = .imageOnly
            del.isBordered = false; del.isHidden = true
            del.target = self; del.action = #selector(removeTapped)
            [icon, title, sub, note, del].forEach {
                $0.translatesAutoresizingMaskIntoConstraints = false
                addSubview($0)
            }
            title.lineBreakMode = .byTruncatingTail
            sub.lineBreakMode = .byTruncatingMiddle
            NSLayoutConstraint.activate([
                heightAnchor.constraint(equalToConstant: UIScale.pt(34)),
                icon.leadingAnchor.constraint(equalTo: leadingAnchor, constant: 10),
                icon.centerYAnchor.constraint(equalTo: centerYAnchor),
                icon.widthAnchor.constraint(equalToConstant: UIScale.pt(14)),
                icon.heightAnchor.constraint(equalToConstant: UIScale.pt(14)),
                title.leadingAnchor.constraint(equalTo: icon.trailingAnchor, constant: 8),
                title.topAnchor.constraint(equalTo: topAnchor, constant: 4),
                title.trailingAnchor.constraint(lessThanOrEqualTo: note.leadingAnchor, constant: -6),
                sub.leadingAnchor.constraint(equalTo: title.leadingAnchor),
                sub.topAnchor.constraint(equalTo: title.bottomAnchor, constant: 1),
                sub.trailingAnchor.constraint(lessThanOrEqualTo: note.leadingAnchor, constant: -6),
                note.trailingAnchor.constraint(equalTo: del.leadingAnchor, constant: -6),
                note.centerYAnchor.constraint(equalTo: centerYAnchor),
                del.trailingAnchor.constraint(equalTo: trailingAnchor, constant: -8),
                del.centerYAnchor.constraint(equalTo: centerYAnchor),
                del.widthAnchor.constraint(equalToConstant: 14),
            ])
        }
        required init?(coder: NSCoder) { fatalError() }

        func configure(_ name: String, url: String, note noteText: String) {
            title.stringValue = name
            title.font = UIScale.font(UIScale.small)
            title.textColor = Theme.fg
            sub.stringValue = url
            sub.font = UIScale.font(UIScale.caption)
            sub.textColor = Theme.fgDim
            note.stringValue = noteText
            note.font = UIScale.font(UIScale.caption)
            note.textColor = Theme.fgDim
            del.contentTintColor = Theme.fgDim
            let host = URL(string: url)?.host ?? ""
            if let img = BrowserStore.cachedIcon(host: host) {
                icon.image = img
            } else {
                icon.image = NSImage(systemSymbolName: "globe", accessibilityDescription: nil)
                icon.image?.isTemplate = true
                icon.contentTintColor = BrowserStore.fallbackColor(host: host)
            }
        }
        override func updateTrackingAreas() {
            super.updateTrackingAreas()
            if let t = track { removeTrackingArea(t) }
            let t = NSTrackingArea(rect: bounds, options: [.mouseEnteredAndExited, .activeInKeyWindow], owner: self)
            addTrackingArea(t); track = t
        }
        override func mouseEntered(with e: NSEvent) {
            del.isHidden = false
            layer?.backgroundColor = Theme.bg2.cgColor
        }
        override func mouseExited(with e: NSEvent) {
            del.isHidden = true
            layer?.backgroundColor = NSColor.clear.cgColor
        }
        override func mouseDown(with e: NSEvent) { onOpen?() }
        @objc private func removeTapped() { onRemove?() }
    }
}

/// 위에서 아래로 쌓이는 스크롤 문서 뷰.
final class FlippedView: NSView {
    override var isFlipped: Bool { true }
}

extension LibraryView: NSTextFieldDelegate {
    func controlTextDidChange(_ obj: Notification) { reload() }
}
