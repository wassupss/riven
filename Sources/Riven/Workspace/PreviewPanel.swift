import AppKit
import WebKit

// riven's browser panel.
//
// This started as a URL bar over a WKWebView for peeking at a dev server. That is not enough to
// actually work in: no history, no way to tell whether a page is still loading, one page at a time,
// no find, no downloads, and a target=_blank link silently did nothing. It is now a small but real
// browser (tabs, history, progress, find, zoom, downloads, persistent session) and it is also the
// surface an agent drives through the riven_browser_* tools.
//
// The panel keeps its old name because the dock, layout snapshots and the "preview" panel kind all
// refer to it; renaming would break restored layouts for no user-visible gain.

// MARK: - one tab

/// A single page: its web view plus the state the chrome renders. KVO tokens are stored so they
/// die with the tab (an explicit removeObserver that gets skipped on a close path is how these
/// leak, and a stale observer on a deallocated view crashes).
final class BrowserTab: NSObject {
    let web: WKWebView
    private(set) var title = ""
    private(set) var urlString = ""
    private(set) var progress: Double = 0
    private(set) var isLoading = false
    /// 시크릿 탭 — 방문 기록을 남기지 않는다.
    var isPrivate = false
    /// 이 탭의 마지막 로드 실패. 다음 탐색이 시작되면 지운다.
    var errorText: String?
    /// 어떤 프로필(로그인 묶음)로 여는지. 빈 문자열이면 기본.
    var profile = ""
    var onChange: (() -> Void)?
    private var tokens: [NSKeyValueObservation] = []

    init(configuration: WKWebViewConfiguration) {
        web = WKWebView(frame: .zero, configuration: configuration)
        super.init()
        web.translatesAutoresizingMaskIntoConstraints = false
        web.allowsBackForwardNavigationGestures = true       // two-finger swipe, like Safari
        web.isInspectable = true                             // right-click → 요소 정보 검사
        tokens = [
            web.observe(\.title, options: [.new]) { [weak self] w, _ in
                self?.title = w.title ?? ""; self?.onChange?()
            },
            web.observe(\.url, options: [.new]) { [weak self] w, _ in
                self?.urlString = w.url?.absoluteString ?? ""; self?.onChange?()
            },
            web.observe(\.estimatedProgress, options: [.new]) { [weak self] w, _ in
                self?.progress = w.estimatedProgress; self?.onChange?()
            },
            web.observe(\.isLoading, options: [.new]) { [weak self] w, _ in
                self?.isLoading = w.isLoading; self?.onChange?()
            },
            web.observe(\.canGoBack, options: [.new]) { [weak self] _, _ in self?.onChange?() },
            web.observe(\.canGoForward, options: [.new]) { [weak self] _, _ in self?.onChange?() },
        ]
    }
    deinit { tokens.forEach { $0.invalidate() } }

    /// 주소창에 친 것을 URL 로. 스킴이 없으면 http, 검색어처럼 보이면 검색으로 넘긴다.
    static func resolve(_ raw: String) -> URL? {
        let s = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !s.isEmpty else { return nil }
        if s.contains("://") { return URL(string: s) }
        if s.hasPrefix("localhost") || s.hasPrefix("127.0.0.1") { return URL(string: "http://" + s) }
        // 공백이 있거나 점이 없으면 주소가 아니라 검색어다.
        if s.contains(" ") || !s.contains(".") {
            let q = s.addingPercentEncoding(withAllowedCharacters: .urlQueryAllowed) ?? s
            return URL(string: "https://duckduckgo.com/?q=\(q)")
        }
        return URL(string: "https://" + s)
    }
    /// 짧은 탭 제목 (제목이 아직 없으면 호스트).
    var shortTitle: String {
        let base = title.isEmpty ? (URL(string: urlString)?.host ?? urlString) : title
        return base.count > 22 ? String(base.prefix(22)) + "…" : base
    }
}

// MARK: - tab strip

/// 브라우저 탭 줄. RivenTabStrip 과 같은 언어(밑줄형 + 기준선)를 쓰되, 브라우저 탭은 닫을 수
/// 있어야 해서 별도로 둔다. 탭이 하나뿐이면 줄 자체를 감춰 좁은 패널의 세로 공간을 아낀다.
final class BrowserTabStrip: NSView, Themable, Scalable {
    var onSelect: ((Int) -> Void)?
    var onClose: ((Int) -> Void)?
    var onNew: (() -> Void)?
    var onMenu: ((Int, NSEvent) -> Void)?
    private let stack = NSStackView()
    private let scroll = NSScrollView()
    private let newBtn = NSButton()
    private var items: [(title: String, url: String)] = []
    private var selected = 0

    override init(frame: NSRect) {
        super.init(frame: frame)
        wantsLayer = true
        stack.orientation = .horizontal; stack.spacing = 0; stack.alignment = .centerY
        stack.translatesAutoresizingMaskIntoConstraints = false
        scroll.documentView = stack
        scroll.drawsBackground = false
        scroll.hasHorizontalScroller = false; scroll.hasVerticalScroller = false
        scroll.translatesAutoresizingMaskIntoConstraints = false
        newBtn.image = NSImage(systemSymbolName: "plus", accessibilityDescription: t("browser.newTab"))
        newBtn.image?.isTemplate = true; newBtn.imagePosition = .imageOnly
        newBtn.isBordered = false; newBtn.toolTip = t("browser.newTab")
        newBtn.target = self; newBtn.action = #selector(newTapped)
        newBtn.translatesAutoresizingMaskIntoConstraints = false
        addSubview(scroll); addSubview(newBtn)
        NSLayoutConstraint.activate([
            scroll.leadingAnchor.constraint(equalTo: leadingAnchor),
            scroll.topAnchor.constraint(equalTo: topAnchor),
            scroll.bottomAnchor.constraint(equalTo: bottomAnchor),
            scroll.trailingAnchor.constraint(equalTo: newBtn.leadingAnchor, constant: -2),
            stack.topAnchor.constraint(equalTo: scroll.contentView.topAnchor),
            stack.leadingAnchor.constraint(equalTo: scroll.contentView.leadingAnchor),
            stack.heightAnchor.constraint(equalTo: scroll.heightAnchor),
            newBtn.trailingAnchor.constraint(equalTo: trailingAnchor, constant: -6),
            newBtn.centerYAnchor.constraint(equalTo: centerYAnchor),
            newBtn.widthAnchor.constraint(equalToConstant: UIScale.pt(20)),
            heightAnchor.constraint(equalToConstant: UIScale.pt(26)),
        ])
        Theme.register(self); UIScale.register(self)
    }
    required init?(coder: NSCoder) { fatalError() }

    func set(_ list: [(title: String, url: String)], selected sel: Int) {
        items = list; selected = sel
        stack.arrangedSubviews.forEach { $0.removeFromSuperview() }
        for (i, it) in list.enumerated() {
            stack.addArrangedSubview(makeTab(i, it, active: i == sel))
        }
        needsDisplay = true
    }
    private func makeTab(_ i: Int, _ it: (title: String, url: String), active: Bool) -> NSView {
        let row = TabCell()
        row.index = i
        row.onPick = { [weak self] in self?.onSelect?(i) }
        row.onClose = { [weak self] in self?.onClose?(i) }
        row.onMenu = { [weak self] e in self?.onMenu?(i, e) }
        row.configure(it.title, url: it.url, active: active, closable: true)
        return row
    }
    func applyTheme() { needsDisplay = true; set(items, selected: selected) }
    func applyScale() { set(items, selected: selected) }
    @objc private func newTapped() { onNew?() }
    /// 탭 줄은 툴바보다 한 톤 어둡다 (크롬·엣지와 같은 층 구분). 아래 기준선 한 줄.
    override func draw(_ dirty: NSRect) {
        Theme.bg3.setFill()
        bounds.fill()
        Theme.hairline.setFill()
        NSRect(x: 0, y: 0, width: bounds.width, height: 1).fill()
    }

    /// 한 칸: 파비콘 + 제목 + (마우스를 올리면) 닫기.
    private final class TabCell: NSView {
        var index = 0
        var onPick: (() -> Void)?
        var onClose: (() -> Void)?
        var onMenu: ((NSEvent) -> Void)?
        private let icon = NSImageView()
        private let label = NSTextField(labelWithString: "")
        private let close = NSButton()
        private var track: NSTrackingArea?
        private var active = false
        private var closable = false
        private var host = ""
        override init(frame: NSRect) {
            super.init(frame: frame)
            wantsLayer = true
            icon.imageScaling = .scaleProportionallyDown
            icon.translatesAutoresizingMaskIntoConstraints = false
            label.lineBreakMode = .byTruncatingTail
            label.translatesAutoresizingMaskIntoConstraints = false
            close.image = NSImage(systemSymbolName: "xmark", accessibilityDescription: t("browser.closeTab"))
            close.image?.isTemplate = true; close.imagePosition = .imageOnly
            close.isBordered = false; close.isHidden = true
            close.target = self; close.action = #selector(closeTapped)
            close.translatesAutoresizingMaskIntoConstraints = false
            addSubview(icon); addSubview(label); addSubview(close)
            NSLayoutConstraint.activate([
                icon.leadingAnchor.constraint(equalTo: leadingAnchor, constant: 9),
                icon.centerYAnchor.constraint(equalTo: centerYAnchor),
                icon.widthAnchor.constraint(equalToConstant: UIScale.pt(13)),
                icon.heightAnchor.constraint(equalToConstant: UIScale.pt(13)),
                label.leadingAnchor.constraint(equalTo: icon.trailingAnchor, constant: 6),
                label.centerYAnchor.constraint(equalTo: centerYAnchor),
                close.leadingAnchor.constraint(equalTo: label.trailingAnchor, constant: 4),
                close.trailingAnchor.constraint(equalTo: trailingAnchor, constant: -6),
                close.centerYAnchor.constraint(equalTo: centerYAnchor),
                close.widthAnchor.constraint(equalToConstant: 14),
                widthAnchor.constraint(lessThanOrEqualToConstant: UIScale.pt(170)),
            ])
        }
        required init?(coder: NSCoder) { fatalError() }
        func configure(_ name: String, url: String, active: Bool, closable: Bool) {
            self.active = active; self.closable = closable
            label.stringValue = name
            label.font = UIScale.font(UIScale.small, active ? .semibold : .regular)
            label.textColor = active ? Theme.fg : Theme.fgDim
            close.contentTintColor = Theme.fgDim
            setIcon(url)
            needsDisplay = true
        }
        /// 파비콘이 있으면 그걸, 없으면 호스트 색의 점을 보여주고 뒤늦게 도착하면 갈아 끼운다.
        private func setIcon(_ url: String) {
            let u = URL(string: url)
            host = u?.host ?? ""
            if let cached = BrowserStore.cachedIcon(host: host) { icon.image = cached; return }
            icon.image = Self.dot(BrowserStore.fallbackColor(host: host))
            guard let u else { return }
            let want = host
            BrowserStore.icon(for: u) { [weak self] img in
                guard let self, let img, self.host == want else { return }
                self.icon.image = img
            }
        }
        private static var dots: [String: NSImage] = [:]
        private static func dot(_ color: NSColor) -> NSImage {
            let key = color.description
            if let d = dots[key] { return d }
            let size = NSSize(width: 8, height: 8)
            let img = NSImage(size: size)
            img.lockFocus()
            color.setFill()
            NSBezierPath(ovalIn: NSRect(origin: .zero, size: size)).fill()
            img.unlockFocus()
            dots[key] = img
            return img
        }
        override func updateTrackingAreas() {
            super.updateTrackingAreas()
            if let t = track { removeTrackingArea(t) }
            let t = NSTrackingArea(rect: bounds, options: [.mouseEnteredAndExited, .activeInKeyWindow], owner: self)
            addTrackingArea(t); track = t
        }
        private var hot = false
        override func mouseEntered(with e: NSEvent) {
            close.isHidden = !closable; hot = true; needsDisplay = true
        }
        override func mouseExited(with e: NSEvent) {
            close.isHidden = true; hot = false; needsDisplay = true
        }
        override func mouseDown(with e: NSEvent) { onPick?() }
        override func rightMouseDown(with e: NSEvent) { onMenu?(e) }
        @objc private func closeTapped() { onClose?() }
        override func draw(_ dirty: NSRect) {
            // 활성 표시는 아래에 긋는다 — riven 의 패널 탭(RivenTabStrip·독 탭)이 아래에
            // 긋는데 브라우저 탭만 위에 그어서, 같은 화면에 두 규칙이 섞여 보였다.
            if hot && !active {
                Theme.fgDim.withAlphaComponent(0.07).setFill()
                NSRect(x: 0, y: 1, width: bounds.width, height: bounds.height - 1).fill()
            }
            guard active else { return }
            Theme.accent.setFill()
            NSRect(x: 0, y: 0, width: bounds.width, height: 2).fill()
        }
    }
}

// MARK: - 주소창 자동완성 목록
//
// 주소창 아래에 떠서 기록·북마크·열린 탭·검색을 한 줄씩 보여준다. 줄 수가 여덟 이하라
// NSTableView 대신 스택으로 둔다 (재사용 이득이 없고 코드가 절반이다).
final class SuggestList: NSView, Themable {
    var onPick: ((BrowserStore.Suggestion) -> Void)?
    private let stack = NSStackView()
    private var rows: [Row] = []
    private(set) var items: [BrowserStore.Suggestion] = []
    private(set) var highlighted = 0

    override init(frame: NSRect) {
        super.init(frame: frame)
        wantsLayer = true
        layer?.cornerRadius = 6
        layer?.borderWidth = 1
        stack.orientation = .vertical; stack.spacing = 0; stack.alignment = .leading
        stack.translatesAutoresizingMaskIntoConstraints = false
        addSubview(stack)
        NSLayoutConstraint.activate([
            stack.leadingAnchor.constraint(equalTo: leadingAnchor),
            stack.trailingAnchor.constraint(equalTo: trailingAnchor),
            stack.topAnchor.constraint(equalTo: topAnchor, constant: 4),
            stack.bottomAnchor.constraint(equalTo: bottomAnchor, constant: -4),
        ])
        Theme.register(self)
    }
    required init?(coder: NSCoder) { fatalError() }

    func show(_ list: [BrowserStore.Suggestion]) {
        items = list
        highlighted = 0
        rows.forEach { $0.removeFromSuperview() }
        rows = list.enumerated().map { i, s in
            let r = Row()
            r.configure(s, active: i == 0)
            r.onPick = { [weak self] in self?.onPick?(s) }
            r.onHover = { [weak self] in self?.highlight(i) }
            stack.addArrangedSubview(r)
            r.widthAnchor.constraint(equalTo: widthAnchor).isActive = true
            return r
        }
        isHidden = list.isEmpty
        applyTheme()
    }
    func hide() { isHidden = true; items = []; rows.forEach { $0.removeFromSuperview() }; rows = [] }
    func move(_ delta: Int) {
        guard !items.isEmpty else { return }
        highlight((highlighted + delta + items.count) % items.count)
    }
    private func highlight(_ i: Int) {
        highlighted = i
        for (j, r) in rows.enumerated() { r.configure(items[j], active: j == i) }
    }
    var current: BrowserStore.Suggestion? { items.indices.contains(highlighted) ? items[highlighted] : nil }

    func applyTheme() {
        layer?.backgroundColor = Theme.bg2.cgColor
        layer?.borderColor = Theme.hairline.cgColor
        for (j, r) in rows.enumerated() { r.configure(items[j], active: j == highlighted) }
    }

    /// 한 줄: 종류 아이콘 + 제목 + 주소.
    private final class Row: NSView {
        var onPick: (() -> Void)?
        var onHover: (() -> Void)?
        private let icon = NSImageView()
        private let title = NSTextField(labelWithString: "")
        private let sub = NSTextField(labelWithString: "")
        private var track: NSTrackingArea?
        override init(frame: NSRect) {
            super.init(frame: frame)
            wantsLayer = true
            [icon, title, sub].forEach {
                $0.translatesAutoresizingMaskIntoConstraints = false
                addSubview($0)
            }
            title.lineBreakMode = .byTruncatingTail
            sub.lineBreakMode = .byTruncatingMiddle
            NSLayoutConstraint.activate([
                heightAnchor.constraint(equalToConstant: UIScale.pt(24)),
                icon.leadingAnchor.constraint(equalTo: leadingAnchor, constant: 8),
                icon.centerYAnchor.constraint(equalTo: centerYAnchor),
                icon.widthAnchor.constraint(equalToConstant: UIScale.pt(12)),
                title.leadingAnchor.constraint(equalTo: icon.trailingAnchor, constant: 7),
                title.centerYAnchor.constraint(equalTo: centerYAnchor),
                sub.leadingAnchor.constraint(equalTo: title.trailingAnchor, constant: 8),
                sub.trailingAnchor.constraint(lessThanOrEqualTo: trailingAnchor, constant: -8),
                sub.centerYAnchor.constraint(equalTo: centerYAnchor),
            ])
            title.setContentCompressionResistancePriority(.defaultHigh, for: .horizontal)
        }
        required init?(coder: NSCoder) { fatalError() }
        func configure(_ s: BrowserStore.Suggestion, active: Bool) {
            let symbol: String
            switch s.kind {
            case .openTab:  symbol = "macwindow"
            case .bookmark: symbol = "star.fill"
            case .history:  symbol = "clock"
            case .search:   symbol = "magnifyingglass"
            }
            icon.image = NSImage(systemSymbolName: symbol, accessibilityDescription: nil)
            icon.image?.isTemplate = true
            icon.contentTintColor = s.kind == .bookmark ? Theme.accent : Theme.fgDim
            title.stringValue = s.kind == .search ? t("browser.searchFor", ["q": s.title]) : s.title
            title.font = UIScale.font(UIScale.small)
            title.textColor = Theme.fg
            sub.stringValue = s.kind == .search ? "" : s.url
            sub.font = UIScale.font(UIScale.caption)
            sub.textColor = Theme.fgDim
            layer?.backgroundColor = active ? Theme.accent.withAlphaComponent(0.18).cgColor : NSColor.clear.cgColor
        }
        override func updateTrackingAreas() {
            super.updateTrackingAreas()
            if let t = track { removeTrackingArea(t) }
            let t = NSTrackingArea(rect: bounds, options: [.mouseEnteredAndExited, .activeInKeyWindow], owner: self)
            addTrackingArea(t); track = t
        }
        override func mouseEntered(with e: NSEvent) { onHover?() }
        override func mouseDown(with e: NSEvent) { onPick?() }
    }
}

// MARK: - panel

final class PreviewPanel: NSView, Themable, Scalable, WKScriptMessageHandler,
                          WKNavigationDelegate, WKUIDelegate, WKDownloadDelegate,
                          NSTextFieldDelegate {
    var onFocused: (() -> Void)?   // page interaction → activate this dock group
    var onCapture: ((String) -> Void)?   // saved PNG path → send to the running agent
    /// 마지막 탭까지 닫혔다 → 이 패널을 닫아 달라 (독에서 빼는 건 앱이 한다).
    var onRequestClose: (() -> Void)?

    // ---- chrome ----
    private let backBtn = NSButton()
    private let fwdBtn = NSButton()
    private let stopBtn = NSButton()          // 로딩 중에는 ✕, 아니면 ⟳
    private let urlField = NSTextField()
    private let addressBar = NSView()         // 주소창 알약 (안에 입력칸 + 별)
    private let starBtn = NSButton()          // 북마크 켜고 끄기
    private let menuBtn = NSButton()          // ⋮ — 자주 안 쓰는 것들은 여기로
    private let suggest = SuggestList(frame: .zero)   // 주소창 자동완성
    private let console = BrowserConsole(frame: .zero)   // 개발자 도구 (콘솔)
    private var consoleHeight: NSLayoutConstraint!
    private var libraryPopover: NSPopover?
    private let downloadBtn = NSButton()          // 받는 게 있을 때만 보인다
    private var downloads: [DownloadItem] = []
    private var downloadsPopover: NSPopover?
    private let progress = NSView()
    private var progressWidth: NSLayoutConstraint!
    private var downloadWidth: NSLayoutConstraint!
    private let tabStrip = BrowserTabStrip(frame: .zero)
    private var tabStripHeight: NSLayoutConstraint!
    private let emptyLabel = NSTextField(labelWithString: t("preview.empty"))
    private let statusLabel = NSTextField(labelWithString: "")   // 다운로드 / 에이전트 동작 알림
    private var statusHeight: NSLayoutConstraint!
    // 찾기 줄 (⌘F)
    private let findField = NSTextField()
    private let findPrev = NSButton()
    private let findNext = NSButton()
    private let findDone = NSButton()
    private let findBar = NSView()
    private var findBarHeight: NSLayoutConstraint!

    // ---- tabs ----
    private var tabs: [BrowserTab] = []
    private var current = 0
    private let container = NSView()
    private var tab: BrowserTab? { tabs.indices.contains(current) ? tabs[current] : nil }
    /// 모든 탭이 같은 쿠키·세션을 쓰고 앱을 껐다 켜도 로그인이 유지된다 (기본 데이터 저장소).
    private static let processPool = WKProcessPool()

    // 프로필 — 같은 사이트에 계정 두 개로 동시에 들어가야 할 때가 있다 (회사 계정과 개인
    // 계정, 관리자와 일반 사용자). 저장소가 하나뿐이면 한쪽이 다른 쪽을 밀어낸다.
    // 이름마다 따로 저장소를 두고, 껐다 켜도 유지된다 (시크릿 탭은 메모리에만 남는 별개).
    private static var profileStores: [String: WKWebsiteDataStore] = [:]
    static func store(profile: String) -> WKWebsiteDataStore {
        guard !profile.isEmpty else { return .default() }
        if let s = profileStores[profile] { return s }
        // 이름 → 안정적인 UUID. 같은 이름이면 껐다 켜도 같은 저장소로 돌아온다.
        var h1: UInt64 = 0xcbf29ce484222325, h2: UInt64 = 0x9e3779b97f4a7c15
        for b in profile.utf8 {
            h1 = (h1 ^ UInt64(b)) &* 0x100000001b3
            h2 = (h2 &+ UInt64(b)) &* 0x9e3779b97f4a7c15
        }
        var bytes = [UInt8]()
        for shift in stride(from: 56, through: 0, by: -8) { bytes.append(UInt8((h1 >> UInt64(shift)) & 0xff)) }
        for shift in stride(from: 56, through: 0, by: -8) { bytes.append(UInt8((h2 >> UInt64(shift)) & 0xff)) }
        let uuid = UUID(uuid: (bytes[0], bytes[1], bytes[2], bytes[3], bytes[4], bytes[5], bytes[6], bytes[7],
                               bytes[8], bytes[9], bytes[10], bytes[11], bytes[12], bytes[13], bytes[14], bytes[15]))
        let s: WKWebsiteDataStore
        if #available(macOS 14.0, *) { s = WKWebsiteDataStore(forIdentifier: uuid) }
        else { s = .nonPersistent() }      // 예전 macOS 에서는 유지되지 않는다 (창을 닫으면 사라짐)
        profileStores[profile] = s
        return s
    }
    /// 이 브라우저에서 쓰인 프로필 이름들 (기본은 빈 문자열).
    private var knownProfiles: [String] { Array(Set(tabs.map { $0.profile })).sorted() }

    override init(frame: NSRect) {
        super.init(frame: frame)
        wantsLayer = true

        func icon(_ b: NSButton, _ symbol: String, _ tip: String, _ action: Selector) {
            b.image = NSImage(systemSymbolName: symbol, accessibilityDescription: tip)
            b.image?.isTemplate = true; b.imagePosition = .imageOnly
            b.isBordered = false; b.contentTintColor = Theme.fgDim
            b.toolTip = tip
            b.target = self; b.action = action
            b.translatesAutoresizingMaskIntoConstraints = false
        }
        icon(backBtn, "chevron.left", t("browser.back"), #selector(goBack))
        icon(fwdBtn, "chevron.right", t("browser.forward"), #selector(goForward))
        icon(stopBtn, "arrow.clockwise", t("preview.reload"), #selector(reloadOrStop))
        icon(starBtn, "star", t("browser.bookmark"), #selector(toggleBookmark))
        icon(downloadBtn, "arrow.down.circle", t("browser.downloads"), #selector(showDownloads))
        downloadBtn.isHidden = true
        icon(menuBtn, "ellipsis", t("browser.more"), #selector(showMenu))

        urlField.placeholderString = t("browser.urlPlaceholder")
        urlField.font = UIScale.font(UIScale.small)
        // 테두리는 알약(addressBar)이 그린다 — 입력칸에 또 테두리가 있으면 이중으로 보인다.
        urlField.isBordered = false
        urlField.drawsBackground = false
        urlField.focusRingType = .none
        urlField.target = self; urlField.action = #selector(openURL)
        urlField.delegate = self
        urlField.translatesAutoresizingMaskIntoConstraints = false

        suggest.isHidden = true
        suggest.onPick = { [weak self] s in self?.commitSuggestion(s) }
        suggest.translatesAutoresizingMaskIntoConstraints = false

        progress.wantsLayer = true
        progress.translatesAutoresizingMaskIntoConstraints = false
        progress.isHidden = true

        tabStrip.onSelect = { [weak self] i in self?.select(i) }
        tabStrip.onClose = { [weak self] i in self?.closeTab(i) }
        tabStrip.onNew = { [weak self] in self?.newTab(nil, activate: true) }
        tabStrip.onMenu = { [weak self] i, e in self?.showTabMenu(i, e) }
        tabStrip.translatesAutoresizingMaskIntoConstraints = false

        container.translatesAutoresizingMaskIntoConstraints = false

        emptyLabel.font = UIScale.font(UIScale.small); emptyLabel.textColor = Theme.fgDim
        emptyLabel.alignment = .center
        emptyLabel.maximumNumberOfLines = 3
        emptyLabel.lineBreakMode = .byWordWrapping
        emptyLabel.translatesAutoresizingMaskIntoConstraints = false

        statusLabel.font = UIScale.font(UIScale.caption); statusLabel.textColor = Theme.fgDim
        statusLabel.lineBreakMode = .byTruncatingMiddle
        statusLabel.translatesAutoresizingMaskIntoConstraints = false

        buildFindBar()

        addressBar.wantsLayer = true
        addressBar.translatesAutoresizingMaskIntoConstraints = false
        addressBar.addSubview(urlField)
        addressBar.addSubview(starBtn)
        [backBtn, fwdBtn, stopBtn, addressBar, downloadBtn, menuBtn,
         progress, tabStrip, findBar, container, emptyLabel, statusLabel,
         suggest, console].forEach { addSubview($0) }
        console.translatesAutoresizingMaskIntoConstraints = false
        console.isHidden = true
        console.onClose = { [weak self] in self?.toggleConsole(false) }
        console.onEval = { [weak self] js, done in self?.agentEval(js, done) }

        let pad: CGFloat = 8
        progressWidth = progress.widthAnchor.constraint(equalToConstant: 0)
        tabStripHeight = tabStrip.heightAnchor.constraint(equalToConstant: UIScale.pt(30))
        statusHeight = statusLabel.heightAnchor.constraint(equalToConstant: 0)
        consoleHeight = console.heightAnchor.constraint(equalToConstant: 0)
        // 숨겨도 자리는 남는다 — 폭까지 0 으로 접어야 주소창이 그만큼 넓어진다.
        downloadWidth = downloadBtn.widthAnchor.constraint(equalToConstant: 0)
        // 크롬·브레이브·엣지와 같은 순서: 탭 줄이 맨 위, 그 아래에 이동 버튼 + 주소창.
        // 예전에는 주소창이 위, 탭이 아래여서 브라우저를 쓰던 감각과 어긋났다.
        // 오른쪽에 아이콘을 다 늘어놓지도 않는다 — 캡처·검사·확대·외부 열기는 ⋮ 안으로.
        NSLayoutConstraint.activate([
            tabStrip.leadingAnchor.constraint(equalTo: leadingAnchor),
            tabStrip.trailingAnchor.constraint(equalTo: trailingAnchor),
            tabStrip.topAnchor.constraint(equalTo: topAnchor),
            tabStripHeight,

            backBtn.leadingAnchor.constraint(equalTo: leadingAnchor, constant: pad),
            backBtn.topAnchor.constraint(equalTo: tabStrip.bottomAnchor, constant: 6),
            backBtn.widthAnchor.constraint(equalToConstant: UIScale.pt(22)),
            backBtn.heightAnchor.constraint(equalToConstant: UIScale.pt(22)),
            fwdBtn.leadingAnchor.constraint(equalTo: backBtn.trailingAnchor, constant: 2),
            fwdBtn.centerYAnchor.constraint(equalTo: backBtn.centerYAnchor),
            fwdBtn.widthAnchor.constraint(equalToConstant: UIScale.pt(22)),
            stopBtn.leadingAnchor.constraint(equalTo: fwdBtn.trailingAnchor, constant: 2),
            stopBtn.centerYAnchor.constraint(equalTo: backBtn.centerYAnchor),
            stopBtn.widthAnchor.constraint(equalToConstant: UIScale.pt(22)),

            // 주소창은 한 덩어리: 안쪽 오른쪽 끝에 별이 들어간다 (크롬과 같은 자리).
            addressBar.leadingAnchor.constraint(equalTo: stopBtn.trailingAnchor, constant: 6),
            addressBar.centerYAnchor.constraint(equalTo: backBtn.centerYAnchor),
            addressBar.heightAnchor.constraint(equalToConstant: UIScale.pt(26)),
            addressBar.trailingAnchor.constraint(equalTo: downloadBtn.leadingAnchor, constant: -4),
            urlField.leadingAnchor.constraint(equalTo: addressBar.leadingAnchor, constant: 9),
            urlField.centerYAnchor.constraint(equalTo: addressBar.centerYAnchor),
            urlField.trailingAnchor.constraint(equalTo: starBtn.leadingAnchor, constant: -4),
            starBtn.trailingAnchor.constraint(equalTo: addressBar.trailingAnchor, constant: -6),
            starBtn.centerYAnchor.constraint(equalTo: addressBar.centerYAnchor),
            starBtn.widthAnchor.constraint(equalToConstant: UIScale.pt(16)),

            // 받는 중일 때만 나타난다 (크롬의 내려받기 표시와 같은 자리).
            downloadBtn.trailingAnchor.constraint(equalTo: menuBtn.leadingAnchor, constant: -2),
            downloadBtn.centerYAnchor.constraint(equalTo: backBtn.centerYAnchor),
            downloadWidth,
            menuBtn.trailingAnchor.constraint(equalTo: trailingAnchor, constant: -pad),
            menuBtn.centerYAnchor.constraint(equalTo: backBtn.centerYAnchor),
            menuBtn.widthAnchor.constraint(equalToConstant: UIScale.pt(22)),

            // 자동완성은 주소창 바로 아래에 떠서 페이지를 덮는다 (레이아웃을 밀지 않는다).
            suggest.leadingAnchor.constraint(equalTo: addressBar.leadingAnchor),
            suggest.trailingAnchor.constraint(equalTo: addressBar.trailingAnchor),
            suggest.topAnchor.constraint(equalTo: addressBar.bottomAnchor, constant: 2),

            progress.leadingAnchor.constraint(equalTo: leadingAnchor),
            progress.topAnchor.constraint(equalTo: backBtn.bottomAnchor, constant: 6),
            progress.heightAnchor.constraint(equalToConstant: 2),
            progressWidth,

            findBar.leadingAnchor.constraint(equalTo: leadingAnchor),
            findBar.trailingAnchor.constraint(equalTo: trailingAnchor),
            findBar.topAnchor.constraint(equalTo: progress.bottomAnchor),

            container.leadingAnchor.constraint(equalTo: leadingAnchor),
            container.trailingAnchor.constraint(equalTo: trailingAnchor),
            container.topAnchor.constraint(equalTo: findBar.bottomAnchor),
            container.bottomAnchor.constraint(equalTo: console.topAnchor),
            console.leadingAnchor.constraint(equalTo: leadingAnchor),
            console.trailingAnchor.constraint(equalTo: trailingAnchor),
            console.bottomAnchor.constraint(equalTo: statusLabel.topAnchor),
            consoleHeight,

            statusLabel.leadingAnchor.constraint(equalTo: leadingAnchor, constant: pad),
            statusLabel.trailingAnchor.constraint(equalTo: trailingAnchor, constant: -pad),
            statusLabel.bottomAnchor.constraint(equalTo: bottomAnchor),
            statusHeight,

            emptyLabel.leadingAnchor.constraint(greaterThanOrEqualTo: leadingAnchor, constant: 16),
            emptyLabel.trailingAnchor.constraint(lessThanOrEqualTo: trailingAnchor, constant: -16),
            emptyLabel.centerXAnchor.constraint(equalTo: centerXAnchor),
            emptyLabel.centerYAnchor.constraint(equalTo: container.centerYAnchor),
        ])
        applyTheme(); applyScale()
        Theme.register(self); UIScale.register(self)
        langObserver = NotificationCenter.default.addObserver(forName: .rivenLanguageChanged, object: nil, queue: .main) { [weak self] _ in
            self?.relabel()
        }
        newTab(nil, activate: true)     // 빈 탭 하나로 시작 (주소창만 보이는 상태)
        refreshChrome()
    }
    required init?(coder: NSCoder) { fatalError() }
    private var langObserver: NSObjectProtocol?
    deinit { if let o = langObserver { NotificationCenter.default.removeObserver(o) } }

    // MARK: - tabs

    private func makeConfiguration(isPrivate: Bool = false, profile: String = "") -> WKWebViewConfiguration {
        let cfg = WKWebViewConfiguration()
        cfg.processPool = Self.processPool
        // 시크릿 탭은 메모리에만 남는 저장소를 쓴다 — 탭을 닫으면 쿠키·로그인이 함께 사라진다.
        // 프로필을 주면 그 이름의 저장소를 쓴다 (같은 사이트에 계정 두 개로 동시에 들어가기).
        cfg.websiteDataStore = isPrivate ? .nonPersistent() : Self.store(profile: profile)
        cfg.preferences.setValue(true, forKey: "developerExtrasEnabled")
        cfg.preferences.javaScriptCanOpenWindowsAutomatically = true
        // 동영상·지도의 전체화면 버튼. 켜지 않으면 requestFullscreen 자체가 없어서
        // 페이지의 전체화면 버튼이 아무 반응도 하지 않는다.
        cfg.preferences.isElementFullscreenEnabled = true
        // 일부 사이트는 UA 에 Safari 토큰이 없으면 "지원하지 않는 브라우저" 로 막는다.
        // UA 를 통째로 바꾸면 다른 게 깨지므로, 기본 UA 뒤에 붙는 이 값만 채운다.
        cfg.applicationNameForUserAgent = "Version/17.0 Safari/605.1.15"
        // 페이지를 클릭하면 이 독 그룹이 활성화되어야 한다 — WKWebView 가 AppKit 마우스
        // 이벤트를 삼키므로 작은 스크립트가 대신 알려준다.
        cfg.userContentController.add(self, name: "prevfocus")
        // 콘솔: 페이지의 console 출력·오류를 riven 으로 보낸다.
        cfg.userContentController.add(self, name: "rivenconsole")
        cfg.userContentController.addUserScript(WKUserScript(
            source: BrowserConsole.hookScript, injectionTime: .atDocumentStart, forMainFrameOnly: false))
        cfg.userContentController.addUserScript(WKUserScript(
            source: "document.addEventListener('mousedown',function(){window.webkit.messageHandlers.prevfocus.postMessage(1)},true);",
            injectionTime: .atDocumentStart, forMainFrameOnly: false))
        return cfg
    }

    @discardableResult
    private func newTab(_ url: URL?, activate: Bool, configuration: WKWebViewConfiguration? = nil,
                        isPrivate: Bool = false, profile: String = "") -> BrowserTab {
        let tb = BrowserTab(configuration: configuration ?? makeConfiguration(isPrivate: isPrivate, profile: profile))
        tb.isPrivate = isPrivate
        tb.profile = profile
        tb.web.navigationDelegate = self
        tb.web.uiDelegate = self
        tb.onChange = { [weak self] in self?.tabChanged(tb) }
        tabs.append(tb)
        container.addSubview(tb.web)
        NSLayoutConstraint.activate([
            tb.web.leadingAnchor.constraint(equalTo: container.leadingAnchor),
            tb.web.trailingAnchor.constraint(equalTo: container.trailingAnchor),
            tb.web.topAnchor.constraint(equalTo: container.topAnchor),
            tb.web.bottomAnchor.constraint(equalTo: container.bottomAnchor),
        ])
        if let url { Self.load(url, into: tb.web) }
        if activate { select(tabs.count - 1) } else { tb.web.isHidden = true; refreshTabStrip() }
        return tb
    }

    private func select(_ i: Int) {
        guard tabs.indices.contains(i) else { return }
        current = i
        for (j, t) in tabs.enumerated() { t.web.isHidden = (j != i) }
        refreshChrome(); refreshTabStrip()
    }

    /// 방금 닫은 탭들 (⌘⇧T 로 되돌린다). 실수로 닫는 일이 잦아 열 개까지 쌓아 둔다.
    private var closedURLs: [String] = []

    private func closeTab(_ i: Int) {
        guard tabs.indices.contains(i) else { return }
        if tabs.count == 1 {
            rememberURL()          // 마지막으로 보던 탭은 남겨 둔다 (다시 열면 그대로)
            onRequestClose?()
            return
        }
        let tb = tabs.remove(at: i)
        if let u = tb.web.url?.absoluteString, !u.isEmpty, !tb.isPrivate {
            closedURLs.append(u)
            if closedURLs.count > 10 { closedURLs.removeFirst() }
        }
        tb.web.stopLoading()
        tb.web.removeFromSuperview()
        if current >= tabs.count { current = tabs.count - 1 }
        select(current)
    }

    private func tabChanged(_ changed: BrowserTab) {
        guard let cur = tab, cur === changed else { refreshTabStrip(); return }
        refreshChrome(); refreshTabStrip()
    }

    private func refreshTabStrip() {
        tabStrip.set(tabs.map { (title: ($0.profile.isEmpty ? "" : "[\($0.profile)] ")
                                        + ($0.shortTitle.isEmpty ? t("browser.newTabTitle") : $0.shortTitle),
                                 url: $0.web.url?.absoluteString ?? "") },
                     selected: current)
        // 탭 줄은 늘 보인다 (크롬·엣지처럼). 하나일 때만 감추면 탭이 생길 때마다 아래
        // 내용이 밀려 내려가 화면이 덜컹거린다.
        let h = UIScale.pt(30)
        if tabStripHeight.constant != h { tabStripHeight.constant = h }
        tabStrip.isHidden = false
    }

    /// 주소창·버튼·진행 막대를 현재 탭 상태에 맞춘다. KVO 로만 불린다 (폴링 타이머 없음).
    private func refreshChrome() {
        guard let tb = tab else { return }
        if window?.firstResponder !== urlField.currentEditor() {
            urlField.stringValue = tb.urlString
        }
        backBtn.isEnabled = tb.web.canGoBack
        fwdBtn.isEnabled = tb.web.canGoForward
        backBtn.alphaValue = tb.web.canGoBack ? 1 : 0.35
        fwdBtn.alphaValue = tb.web.canGoForward ? 1 : 0.35
        refreshStar()
        stopBtn.image = NSImage(systemSymbolName: tb.isLoading ? "xmark" : "arrow.clockwise",
                                accessibilityDescription: tb.isLoading ? t("browser.stop") : t("preview.reload"))
        stopBtn.image?.isTemplate = true
        stopBtn.toolTip = tb.isLoading ? t("browser.stop") : t("preview.reload")
        // 로드 실패 메시지가 있으면 그게 먼저다. 예전에는 이 줄이 주소가 있다는 이유로
        // 오류를 바로 지워서, 인증서 오류·DNS 실패에 아무 표시도 남지 않았다.
        if let err = tb.errorText {
            emptyLabel.stringValue = err
            emptyLabel.isHidden = false
        } else {
            emptyLabel.stringValue = t("preview.empty")
            emptyLabel.isHidden = !tb.urlString.isEmpty
        }
        // 진행 막대: 로딩 중에만 보이고, 끝나면 사라진다.
        progress.isHidden = !tb.isLoading
        progressWidth.constant = tb.isLoading ? bounds.width * CGFloat(max(0.05, tb.progress)) : 0
    }
    override func layout() {
        super.layout()
        if let tb = tab, tb.isLoading { progressWidth.constant = bounds.width * CGFloat(max(0.05, tb.progress)) }
    }

    private func relabel() {
        backBtn.toolTip = t("browser.back"); fwdBtn.toolTip = t("browser.forward")
        menuBtn.toolTip = t("browser.more")
        urlField.placeholderString = t("browser.urlPlaceholder")
        if tab?.urlString.isEmpty != false { emptyLabel.stringValue = t("preview.empty") }
        refreshChrome(); refreshTabStrip()
    }

    // MARK: - find bar (⌘F)

    private func buildFindBar() {
        findBar.wantsLayer = true
        findBar.translatesAutoresizingMaskIntoConstraints = false
        findField.placeholderString = t("browser.find")
        findField.bezelStyle = .roundedBezel
        findField.font = UIScale.font(UIScale.body)
        findField.target = self; findField.action = #selector(findNextTapped)
        findField.translatesAutoresizingMaskIntoConstraints = false
        func mini(_ b: NSButton, _ symbol: String, _ action: Selector) {
            b.image = NSImage(systemSymbolName: symbol, accessibilityDescription: nil)
            b.image?.isTemplate = true; b.imagePosition = .imageOnly
            b.isBordered = false; b.contentTintColor = Theme.fgDim
            b.target = self; b.action = action
            b.translatesAutoresizingMaskIntoConstraints = false
        }
        mini(findPrev, "chevron.up", #selector(findPrevTapped))
        mini(findNext, "chevron.down", #selector(findNextTapped))
        mini(findDone, "xmark", #selector(hideFind))
        [findField, findPrev, findNext, findDone].forEach { findBar.addSubview($0) }
        findBarHeight = findBar.heightAnchor.constraint(equalToConstant: 0)
        NSLayoutConstraint.activate([
            findBarHeight,
            findField.leadingAnchor.constraint(equalTo: findBar.leadingAnchor, constant: 8),
            findField.centerYAnchor.constraint(equalTo: findBar.centerYAnchor),
            findField.trailingAnchor.constraint(equalTo: findPrev.leadingAnchor, constant: -6),
            findPrev.trailingAnchor.constraint(equalTo: findNext.leadingAnchor, constant: -2),
            findPrev.centerYAnchor.constraint(equalTo: findBar.centerYAnchor),
            findNext.trailingAnchor.constraint(equalTo: findDone.leadingAnchor, constant: -6),
            findNext.centerYAnchor.constraint(equalTo: findBar.centerYAnchor),
            findDone.trailingAnchor.constraint(equalTo: findBar.trailingAnchor, constant: -8),
            findDone.centerYAnchor.constraint(equalTo: findBar.centerYAnchor),
        ])
        findBar.isHidden = true
    }
    /// ⌘F. 이미 열려 있으면 입력창으로 포커스만 옮긴다.
    func showFind() {
        findBar.isHidden = false
        findBarHeight.constant = UIScale.pt(30)
        window?.makeFirstResponder(findField)
    }
    @objc private func hideFind() {
        findBar.isHidden = true
        findBarHeight.constant = 0
        tab?.web.evaluateJavaScript("getSelection().removeAllRanges()")
        window?.makeFirstResponder(tab?.web)
    }
    @objc private func findNextTapped() { runFind(forward: true) }
    @objc private func findPrevTapped() { runFind(forward: false) }
    private func runFind(forward: Bool) {
        let q = findField.stringValue
        guard !q.isEmpty, let web = tab?.web else { return }
        let cfg = WKFindConfiguration()
        cfg.backwards = !forward
        cfg.wraps = true
        cfg.caseSensitive = false
        web.find(q, configuration: cfg) { [weak self] result in
            if !result.matchFound { self?.setStatus(t("browser.findNone", ["q": q])) }
            else { self?.setStatus(nil) }
        }
    }

    // MARK: - toolbar actions

    @objc private func goBack() { tab?.web.goBack() }
    @objc private func goForward() { tab?.web.goForward() }
    /// ⌘⇧R — 캐시를 무시하고 다시 받는다. 개발 중에 바뀐 자산이 안 보일 때 쓰는 그 키다.
    func hardReload() {
        guard let web = tab?.web else { return }
        web.reloadFromOrigin()
        setStatus(t("browser.hardReloaded"))
    }

    /// 이 프로필의 캐시를 지운다 (쿠키·로그인은 그대로).
    func clearCache() {
        let types: Set<String> = [WKWebsiteDataTypeDiskCache, WKWebsiteDataTypeMemoryCache,
                                  WKWebsiteDataTypeOfflineWebApplicationCache]
        let store = tab?.web.configuration.websiteDataStore ?? .default()
        store.removeData(ofTypes: types, modifiedSince: .distantPast) { [weak self] in
            self?.setStatus(t("browser.cacheCleared"))
            self?.tab?.web.reloadFromOrigin()
        }
    }

    /// 쿠키·로컬 저장소까지 — 이 프로필에서 로그아웃된다. 되돌릴 수 없어 먼저 묻는다.
    func clearSiteData() {
        let a = NSAlert()
        a.messageText = t("browser.clearDataConfirm")
        a.informativeText = t("browser.clearDataDetail")
        a.addButton(withTitle: t("browser.clearDataGo"))
        a.addButton(withTitle: t("common.cancel"))
        guard a.runModal() == .alertFirstButtonReturn else { return }
        let store = tab?.web.configuration.websiteDataStore ?? .default()
        store.removeData(ofTypes: WKWebsiteDataStore.allWebsiteDataTypes(),
                         modifiedSince: .distantPast) { [weak self] in
            self?.setStatus(t("browser.dataCleared"))
            self?.tab?.web.reload()
        }
    }

    @objc private func reloadOrStop() {
        guard let tb = tab else { return }
        if tb.isLoading { tb.web.stopLoading() } else if !tb.urlString.isEmpty { tb.web.reload() }
    }
    func controlTextDidEndEditing(_ obj: Notification) {
        if (obj.object as? NSTextField) === urlField { suggest.hide(); styleAddressBar() }
    }
    @objc private func openURL() {
        guard let url = BrowserTab.resolve(urlField.stringValue) else { return }
        load(url)
    }
    private func load(_ url: URL) {
        if tabs.isEmpty { newTab(url, activate: true); return }
        emptyLabel.isHidden = true
        tab?.errorText = nil
        tab?.web.isHidden = false
        Self.load(url, into: tab?.web)
    }
    /// file:// 은 그냥 load(URLRequest:) 로는 열리지 않는다 — WebKit 이 읽기 권한을 따로
    /// 요구한다. dist/index.html, 커버리지 리포트, 로컬 PDF 를 열려면 이 경로가 필요하다.
    static func load(_ url: URL, into web: WKWebView?) {
        guard let web else { return }
        if url.isFileURL {
            let dir = url.hasDirectoryPath ? url : url.deletingLastPathComponent()
            web.loadFileURL(url, allowingReadAccessTo: dir)
        } else {
            web.load(URLRequest(url: url))
        }
    }
    @objc private func openExternal() {
        guard let s = tab?.urlString, let url = URL(string: s) else { return }
        NSWorkspace.shared.open(url)
    }
    /// 개발자 도구. WKWebView 에 공개 API 가 없어 비공개 인스펙터를 호출하는 대신, 사용자가
    /// 쓰는 경로(우클릭 → 요소 정보 검사)를 안내한다. isInspectable 은 켜져 있다.
    /// 개발자 도구 = Safari Web Inspector. 요소·네트워크·소스·콘솔이 다 들어 있는 그 도구다
    /// (WKWebView 를 쓰는 네이티브 앱이 쓸 수 있는 진짜 개발자 도구).
    ///
    /// 여는 공개 API 는 없다 — isInspectable 을 켜면 페이지 오른쪽 클릭 → "요소 정보 검사"
    /// 로 열 수 있고, 메뉴·단축키로 열려면 _WKInspector 를 거쳐야 한다. 언젠가 사라질 수 있는
    /// 길이라, 안 되면 조용히 실패하지 않고 오른쪽 클릭으로 열라고 알려 준다.
    /// 개발자 도구.
    ///
    /// Safari Web Inspector 를 쓰려면 페이지에서 오른쪽 클릭 → "요소 정보 검사" 다 (isInspectable
    /// 이 켜져 있어 요소·네트워크·소스·콘솔이 그대로 열린다). 메뉴·단축키로 여는 공개 API 는
    /// 없고, _WKInspector 로 여는 비공개 길은 실제로 해 보니 창이 뜨지 않았다 — 게다가 예전에는
    /// 그 호출이 앱을 죽였다 (하드닝 런타임에 allow-jit 이 없어서. 그건 별도로 고쳤다).
    /// 그래서 여기서는 확실히 되는 것만 한다: riven 안의 콘솔 서랍을 열고, 전체 도구를 여는
    /// 방법을 알려 준다.
    @objc private func openInspector() {
        toggleConsole(true)
        setStatus(t("browser.inspectHint"))
    }

    /// 콘솔만 빠르게 (riven 안에 붙는 가벼운 서랍). 페이지 오류를 흘려보며 작업할 때 쓴다.
    @objc private func toggleConsoleDrawer() { toggleConsole(!consoleOpen) }
    private var consoleOpen: Bool { consoleHeight.constant > 0 }
    private func toggleConsole(_ open: Bool) {
        consoleHeight.constant = open ? UIScale.pt(180) : 0
        console.isHidden = !open
        if open {
            console.applyTheme()
            console.focusInput()
        } else {
            focusWeb()
        }
    }
    @objc private func zoomIn() { setZoom((tab?.web.pageZoom ?? 1) + 0.1) }
    @objc private func zoomOut() { setZoom((tab?.web.pageZoom ?? 1) - 0.1) }
    func resetZoom() { setZoom(1) }
    private func setZoom(_ z: CGFloat) {
        guard let web = tab?.web else { return }
        web.pageZoom = min(3, max(0.4, z))
        BrowserStore.setZoom(Double(web.pageZoom), for: web.url)   // 사이트별로 기억한다
        setStatus(t("browser.zoomAt", ["p": String(Int(web.pageZoom * 100))]))
    }

    /// 상태 줄 (다운로드·에이전트 동작·찾기 결과). nil 이면 감춘다.
    private func setStatus(_ text: String?) {
        guard let text, !text.isEmpty else {
            statusLabel.stringValue = ""; statusHeight.constant = 0; return
        }
        statusLabel.stringValue = text
        statusHeight.constant = UIScale.pt(18)
    }

    // MARK: - public API (main.swift / commands)

    func focusURL() { window?.makeFirstResponder(urlField) }
    /// 프로그램에서 URL 을 연다 (스크립트 러너가 찾은 개발 서버 등).
    func openURLString(_ s: String) {
        guard let url = BrowserTab.resolve(s) else { return }
        urlField.stringValue = url.absoluteString
        load(url)
    }
    func reload() { tab?.web.reload() }
    func newTabAndOpen(_ s: String) {
        guard let url = BrowserTab.resolve(s) else { return }
        newTab(url, activate: true)
    }

    // MARK: - navigation delegate

    func userContentController(_ u: WKUserContentController, didReceive m: WKScriptMessage) {
        if m.name == "prevfocus" { onFocused?(); return }
        guard m.name == "rivenconsole", let d = m.body as? [String: Any],
              let text = d["text"] as? String else { return }
        let level: BrowserConsole.Level
        switch d["level"] as? String {
        case "error": level = .error
        case "warn": level = .warn
        default: level = .log
        }
        console.add(level, text)
    }
    func webView(_ webView: WKWebView, didStartProvisionalNavigation navigation: WKNavigation!) {
        if webView === tab?.web, consoleOpen { console.pageChanged(webView.url?.absoluteString ?? "") }
        setStatus(nil)
        tabs.first { $0.web === webView }?.errorText = nil    // 새로 시도하니 지난 오류는 지운다
        refreshChrome()
    }
    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        tabs.first { $0.web === webView }?.errorText = nil
        let z = CGFloat(BrowserStore.zoom(for: webView.url))
        if abs(webView.pageZoom - z) > 0.01 { webView.pageZoom = z }   // 지난번 확대를 되살린다
        refreshChrome()
        rememberURL()
        if let tb = tabs.first(where: { $0.web === webView }) {
            BrowserStore.recordVisit(url: webView.url, title: tb.shortTitle, isPrivate: tb.isPrivate)
        }
    }

    /// 탭 오른쪽 클릭 — 브라우저에서 늘 하는 것들.
    private func showTabMenu(_ i: Int, _ e: NSEvent) {
        guard tabs.indices.contains(i) else { return }
        let menu = NSMenu()
        func add(_ title: String, _ enabled: Bool = true, _ body: @escaping () -> Void) {
            let item = NSMenuItem(title: title, action: #selector(runMenuAction(_:)), keyEquivalent: "")
            item.target = self
            item.isEnabled = enabled
            item.representedObject = body as Any
            menu.addItem(item)
        }
        let tb = tabs[i]
        add(t("browser.reloadTab")) { tb.web.reload() }
        add(t("browser.newPrivateTab")) { [weak self] in
            self?.newTab(tb.web.url, activate: true, isPrivate: true)
        }
        add(t("browser.duplicateTab")) { [weak self] in
            if let u = tb.web.url { self?.newTab(u, activate: true) }
        }
        menu.addItem(.separator())
        add(t("browser.copyAddress"), tb.web.url != nil) {
            NSPasteboard.general.clearContents()
            NSPasteboard.general.setString(tb.web.url?.absoluteString ?? "", forType: .string)
        }
        add(t("browser.viewSource"), tb.web.url != nil) { [weak self] in self?.viewSource(tb) }
        menu.addItem(.separator())
        // 프로필: 같은 사이트를 다른 계정으로 하나 더 연다.
        let profiles = ["", "A", "B", "C"]
        for name in profiles where name != tb.profile {
            let label = name.isEmpty ? t("browser.profileDefault") : t("browser.profileNamed", ["n": name])
            add(t("browser.openInProfile", ["p": label]), tb.web.url != nil) { [weak self] in
                if let u = tb.web.url { self?.newTab(u, activate: true, profile: name) }
            }
        }
        menu.addItem(.separator())
        add(t("browser.closeTab"), tabs.count > 1) { [weak self] in self?.closeTab(i) }
        add(t("browser.closeOthers"), tabs.count > 1) { [weak self] in
            guard let self else { return }
            for j in self.tabs.indices.reversed() where j != i { self.closeTab(j) }
        }
        add(t("browser.closeRight"), i < tabs.count - 1) { [weak self] in
            guard let self else { return }
            for j in self.tabs.indices.reversed() where j > i { self.closeTab(j) }
        }
        NSMenu.popUpContextMenu(menu, with: e, for: tabStrip)
    }
    @objc private func runMenuAction(_ sender: NSMenuItem) {
        (sender.representedObject as? () -> Void)?()
    }

    /// 소스 보기 — WKWebView 에는 공개 개발자 도구 API 가 없어서, 받은 HTML 을 새 탭에
    /// 글자 그대로 띄운다 (브라우저의 view-source: 와 같은 결과).
    private func viewSource(_ tb: BrowserTab) {
        guard let url = tb.web.url else { return }
        URLSession.shared.dataTask(with: url) { [weak self] data, _, _ in
            guard let data, let text = String(data: data, encoding: .utf8) else { return }
            DispatchQueue.main.async {
                guard let self else { return }
                let tab = self.newTab(nil, activate: true)
                let escaped = text
                    .replacingOccurrences(of: "&", with: "&amp;")
                    .replacingOccurrences(of: "<", with: "&lt;")
                    .replacingOccurrences(of: ">", with: "&gt;")
                let bg = Theme.isLight ? "#fff" : "#1a1c20"
                let fg = Theme.isLight ? "#222" : "#e3e5ea"
                tab.web.loadHTMLString(
                    "<html><head><meta charset=\"utf-8\"><title>source: \(url.host ?? "")</title></head>"
                    + "<body style=\"background:\(bg);color:\(fg);margin:0\">"
                    + "<pre style=\"white-space:pre-wrap;word-break:break-all;padding:12px;"
                    + "font:12px ui-monospace,SFMono-Regular,Menlo,monospace\">\(escaped)</pre></body></html>",
                    baseURL: nil)
            }
        }.resume()
    }

    /// ⌘⇧T — 마지막으로 닫은 탭을 되살린다.
    private func reopenClosedTab() {
        guard let u = closedURLs.popLast(), let url = URL(string: u) else { return }
        newTab(url, activate: true)
    }

    // MARK: - 기록·북마크 보기 (⌘Y)
    //
    // 모아 둔 게 있어도 볼 방법이 없으면 없는 것과 같다. 주소창 아래에 뜨는 목록과 같은
    // 표현을 쓰되, 여기서는 지우기까지 된다.
    private func showLibrary() {
        let panel = LibraryView(frame: NSRect(x: 0, y: 0, width: 420, height: 360))
        panel.onOpen = { [weak self] url in
            self?.libraryPopover?.close()
            if let u = URL(string: url) { self?.newTab(u, activate: true) }
        }
        panel.reload()
        let pop = NSPopover()
        pop.behavior = .transient
        pop.contentViewController = NSViewController()
        pop.contentViewController?.view = panel
        pop.show(relativeTo: starBtn.bounds, of: starBtn, preferredEdge: .maxY)
        libraryPopover = pop
    }

    /// 페이지가 카메라·마이크를 요청할 때. 어느 사이트가 무엇을 달라는지 밝히고 묻는다
    /// (WKWebView 는 기본이 거부라, 이걸 넣지 않으면 화상회의 페이지가 그냥 안 된다).
    func webView(_ webView: WKWebView, requestMediaCapturePermissionFor origin: WKSecurityOrigin,
                 initiatedByFrame frame: WKFrameInfo, type: WKMediaCaptureType,
                 decisionHandler: @escaping (WKPermissionDecision) -> Void) {
        let host = origin.host.isEmpty ? t("browser.thisPage") : origin.host
        let what: String
        switch type {
        case .camera: what = t("browser.camera")
        case .microphone: what = t("browser.microphone")
        default: what = t("browser.cameraAndMic")
        }
        let a = NSAlert()
        a.messageText = t("browser.mediaAsk", ["h": host, "w": what])
        a.addButton(withTitle: t("browser.allow"))
        a.addButton(withTitle: t("common.cancel"))
        decisionHandler(a.runModal() == .alertFirstButtonReturn ? .grant : .deny)
    }

    // MARK: - 인증서
    //
    // 자체 서명·만료된 인증서를 만나면 지금까지 아무 일도 일어나지 않았다 (화면은 이전
    // 페이지 그대로, 오류 표시도 없음). 개발 서버는 자체 서명이 흔해서 그냥 막으면 못 쓴다.
    // 그래서 한 번 물어보고, 사용자가 계속하겠다고 하면 그 호스트를 기억한다.
    func webView(_ webView: WKWebView, didReceive challenge: URLAuthenticationChallenge,
                 completionHandler: @escaping (URLSession.AuthChallengeDisposition, URLCredential?) -> Void) {
        guard challenge.protectionSpace.authenticationMethod == NSURLAuthenticationMethodServerTrust,
              let trust = challenge.protectionSpace.serverTrust else {
            completionHandler(.performDefaultHandling, nil); return
        }
        let host = challenge.protectionSpace.host
        if Self.trustedHosts.contains(host) {
            completionHandler(.useCredential, URLCredential(trust: trust)); return
        }
        // 정상 인증서면 물어볼 것도 없다.
        var error: CFError?
        if SecTrustEvaluateWithError(trust, &error) {
            completionHandler(.performDefaultHandling, nil); return
        }
        // 테스트에서는 창을 띄우지 않고 정해진 답을 쓴다 (모달이라 벤치가 멈춘다).
        if let auto = ProcessInfo.processInfo.environment["RIVEN_CERTAUTO"] {
            if auto == "allow" {
                Self.trustedHosts.insert(host)
                completionHandler(.useCredential, URLCredential(trust: trust))
            } else {
                declineCert(host, on: webView, completionHandler)
            }
            return
        }
        let a = NSAlert()
        a.messageText = t("browser.certTitle", ["h": host])
        a.informativeText = t("browser.certBody", ["msg": (error as Error?)?.localizedDescription ?? ""])
        a.addButton(withTitle: t("browser.certProceed"))
        a.addButton(withTitle: t("common.cancel"))
        if a.runModal() == .alertFirstButtonReturn {
            Self.trustedHosts.insert(host)
            completionHandler(.useCredential, URLCredential(trust: trust))
        } else {
            declineCert(host, on: webView, completionHandler)
        }
    }
    /// 그만두기를 골랐을 때. 취소는 NSURLErrorCancelled 로 와서 오류 표시에서 걸러지므로
    /// (그러면 화면에 아무 일도 안 일어난 것처럼 보인다) 여기서 직접 남긴다.
    private func declineCert(_ host: String, on webView: WKWebView,
                             _ completionHandler: @escaping (URLSession.AuthChallengeDisposition, URLCredential?) -> Void) {
        tabs.first { $0.web === webView }?.errorText = t("browser.certBlocked", ["h": host])
        completionHandler(.cancelAuthenticationChallenge, nil)
        DispatchQueue.main.async { [weak self] in self?.refreshChrome() }
    }
    /// 사용자가 계속하기로 한 호스트 (이 실행 동안만 — 껐다 켜면 다시 묻는다).
    private static var trustedHosts: Set<String> = []

    // MARK: - 주소창 자동완성 / 북마크

    func controlTextDidChange(_ obj: Notification) {
        guard (obj.object as? NSTextField) === urlField else { return }
        refreshSuggestions()
    }
    func controlTextDidBeginEditing(_ obj: Notification) {
        if (obj.object as? NSTextField) === urlField { styleAddressBar() }
    }
    private func refreshSuggestions() {
        let open = tabs.enumerated().compactMap { i, t -> (title: String, url: String)? in
            guard i != current, let u = t.web.url?.absoluteString, !u.isEmpty else { return nil }
            return (t.shortTitle, u)
        }
        suggest.show(BrowserStore.suggest(urlField.stringValue, openTabs: open))
    }
    /// 위·아래로 고르고 Enter 로 연다. Esc 는 목록만 닫는다 (패널을 닫지 않는다).
    func control(_ control: NSControl, textView: NSTextView, doCommandBy sel: Selector) -> Bool {
        guard control === urlField, !suggest.isHidden else { return false }
        switch sel {
        case #selector(NSResponder.moveDown(_:)):   suggest.move(1); return true
        case #selector(NSResponder.moveUp(_:)):     suggest.move(-1); return true
        case #selector(NSResponder.cancelOperation(_:)): suggest.hide(); return true
        case #selector(NSResponder.insertNewline(_:)):
            if let s = suggest.current { commitSuggestion(s); return true }
            return false
        default: return false
        }
    }
    private func commitSuggestion(_ s: BrowserStore.Suggestion) {
        suggest.hide()
        if s.kind == .openTab, let i = tabs.firstIndex(where: { $0.web.url?.absoluteString == s.url }) {
            select(i); focusWeb(); return          // 이미 열어 둔 탭이면 새로 열지 않고 그리로 간다
        }
        urlField.stringValue = s.url
        if let u = URL(string: s.url) { load(u) }
    }
    @objc private func toggleBookmark() {
        guard let u = tab?.web.url else { return }
        let added = BrowserStore.toggleBookmark(url: u, title: tab?.shortTitle ?? "")
        refreshStar()
        setStatus(added ? t("browser.bookmarkAdded") : t("browser.bookmarkRemoved"))
    }
    private func refreshStar() {
        let on = BrowserStore.isBookmarked(tab?.web.url)
        starBtn.image = NSImage(systemSymbolName: on ? "star.fill" : "star", accessibilityDescription: t("browser.bookmark"))
        starBtn.image?.isTemplate = true
        starBtn.contentTintColor = on ? Theme.accent : Theme.fgDim
    }

    /// 마지막으로 본 주소를 워크스페이스별로 기억한다. 예전에는 아무것도 저장하지 않아서
    /// riven 을 닫았다 열면 늘 처음 상태(하드코딩된 localhost:3000)로 돌아갔다.
    /// 열어 둔 탭 전부를 워크스페이스별로 기억한다. 예전에는 주소 하나만 남겨서, 껐다 켜면
    /// 탭이 전부 사라지고 마지막에 보던 페이지 하나만 돌아왔다.
    private func rememberURL() {
        guard let ws = workspaceKey else { return }
        // "프로필\t주소" 로 적는다. 주소만 남기면 껐다 켰을 때 계정 A 로 보던 탭이
        // 기본 계정으로 돌아와, 같은 사이트에 두 계정으로 들어가 있던 상태가 무너진다.
        let urls = tabs.compactMap { tb -> String? in
            guard !tb.isPrivate, let u = tb.web.url?.absoluteString,   // 시크릿 탭은 남기지 않는다
                  !u.isEmpty, !u.hasPrefix("about:") else { return nil }
            return tb.profile.isEmpty ? u : tb.profile + "\t" + u
        }
        guard !urls.isEmpty else { return }
        var map = Settings.shared.object("browserTabs") as? [String: [String]] ?? [:]
        guard map[ws] != urls else { return }
        map[ws] = urls
        Settings.shared.set("browserTabs", map)

        // 활성 탭 번호도 (범위를 벗어나면 복원할 때 첫 탭으로 떨어진다).
        var actives = Settings.shared.object("browserActiveTab") as? [String: Int] ?? [:]
        if actives[ws] != current { actives[ws] = current; Settings.shared.set("browserActiveTab", actives) }
    }
    /// 저장해 둔 탭들을 되살린다 (패널이 워크스페이스에 붙을 때).
    func restoreLastURL() {
        guard let ws = workspaceKey, tab?.web.url == nil else { return }
        var urls = (Settings.shared.object("browserTabs") as? [String: [String]] ?? [:])[ws] ?? []
        if urls.isEmpty {   // 예전 형식 (주소 하나)
            let old = (Settings.shared.object("browserURLs") as? [String: String] ?? [:])[ws]
            urls = old.map { [$0] } ?? []
        }
        guard !urls.isEmpty else { return }
        for (i, raw) in urls.enumerated() {
            let parts = raw.split(separator: "\t", maxSplits: 1).map(String.init)
            let profile = parts.count == 2 ? parts[0] : ""
            guard let url = BrowserTab.resolve(parts.last ?? raw) else { continue }
            // 첫 탭도 프로필이 있으면 새로 만들어야 한다 (이미 만들어진 탭은 기본 저장소다).
            if i == 0, profile.isEmpty, let first = tab { Self.load(url, into: first.web) }
            else { newTab(url, activate: false, profile: profile) }
        }
        let want = (Settings.shared.object("browserActiveTab") as? [String: Int] ?? [:])[ws] ?? 0
        select(min(max(0, want), tabs.count - 1))
    }
    /// 어느 워크스페이스의 브라우저인지 (주소 기억의 키).
    private var workspaceKey: String? { workspaceRoot?.path }
    /// 주소창 알약. 포커스가 가면 테두리를 강조한다 (크롬처럼).
    private func styleAddressBar() {
        addressBar.layer?.cornerRadius = UIScale.pt(13)
        let focused = window?.firstResponder === urlField.currentEditor()
        addressBar.layer?.backgroundColor = Theme.bg2.cgColor
        addressBar.layer?.borderWidth = 1
        addressBar.layer?.borderColor = (focused ? Theme.accent : Theme.hairline).cgColor
    }

    /// 이 패널이 포커스를 받으면 웹뷰가 받아야 한다 (선택·복사·키보드 스크롤).
    func focusWeb() { if let w = tab?.web { window?.makeFirstResponder(w) } }

    /// 벤치용: 현재 웹뷰.
    func debugWebView() -> WKWebView? { tab?.web }
    /// 벤치용: 페이지 전체를 선택하고 웹뷰에 포커스를 준다.
    func debugSelectAll(_ done: @escaping (Bool) -> Void) {
        guard let w = tab?.web else { done(false); return }
        w.evaluateJavaScript("document.getSelection().selectAllChildren(document.body); document.getSelection().toString().length") { v, _ in
            done((v as? Int ?? 0) > 0)
        }
    }
    /// 벤치용: 지금 주소.
    /// 벤치용: 사람이 친 것처럼 주소창에 넣고 자동완성을 띄운다.
    func debugType(_ s: String) {
        window?.makeFirstResponder(urlField)
        urlField.stringValue = s
        refreshSuggestions()
    }
    func debugShowLibrary() { suggest.hide(); showLibrary() }
    func debugDownloads() -> String {
        downloads.map { "\($0.name):\($0.failed ?? ($0.done ? "done" : "\(Int($0.fraction*100))%"))" }
            .joined(separator: " | ") + (downloadBtn.isHidden ? " [버튼 숨김]" : " [버튼 보임]")
    }
    func debugDownloadsShot(_ path: String) {
        showDownloads()
        guard let v = downloadsPopover?.contentViewController?.view else { return }
        v.layoutSubtreeIfNeeded()
        guard let rep = v.bitmapImageRepForCachingDisplay(in: v.bounds) else { return }
        v.cacheDisplay(in: v.bounds, to: rep)
        if let d = rep.representation(using: .png, properties: [:]) { try? d.write(to: URL(fileURLWithPath: path)) }
    }
    func debugZoom() -> CGFloat { tab?.web.pageZoom ?? 0 }
    func debugFrames() -> String {
        let w = tab?.web
        return "패널=\(Int(bounds.width))x\(Int(bounds.height))"
            + " 탭줄=\(Int(tabStrip.frame.height))"
            + " 주소=\(Int(addressBar.frame.minY))~\(Int(addressBar.frame.maxY))"
            + " 컨테이너=\(Int(container.frame.minY))~\(Int(container.frame.maxY))"
            + " 웹뷰=\(w.map { "\(Int($0.frame.width))x\(Int($0.frame.height)) 숨김=\($0.isHidden)" } ?? "없음")"
    }
    func debugConsole() -> BrowserConsole { console }
    func debugOpenDevTools() { openInspector() }
    func debugToggleConsole(_ open: Bool) { toggleConsole(open) }
    func debugError() -> String { tab?.errorText ?? "(오류표시 없음)" }
    func debugTabURLs() -> [String] { tabs.map { $0.web.url?.absoluteString ?? "-" } }
    /// ⌘W (메뉴에서 들어온다 — 메뉴 단축키가 뷰보다 먼저 잡힌다).
    func closeActiveTab() { closeTab(current) }

    /// 벤치용: ⌘W 를 누른 것과 같은 경로.
    func debugCommandW() { closeActiveTab() }
    func debugActiveTab() -> Int { current }
    func debugEval(_ js: String, _ done: @escaping (String) -> Void) { agentEval(js, done) }
    func debugSetZoom(_ z: CGFloat) { setZoom(z) }
    func debugTabMenu(_ i: Int) -> [String] {
        // 메뉴를 실제로 띄우지 않고 항목만 확인한다 (팝업은 모달 루프라 벤치가 멈춘다).
        guard tabs.indices.contains(i) else { return [] }
        let tb = tabs[i]
        return [t("browser.reloadTab"), t("browser.duplicateTab"), t("browser.copyAddress"),
                t("browser.viewSource"), t("browser.closeTab"),
                tabs.count > 1 ? t("browser.closeOthers") : "-",
                i < tabs.count - 1 ? t("browser.closeRight") : "-"]
            + [tb.web.url?.host ?? "?"]
    }
    func debugViewSource(_ i: Int) { if tabs.indices.contains(i) { viewSource(tabs[i]) } }
    /// 팝오버는 자기 창에 그려져 부모 창 캡처에 안 잡힌다 — 뷰를 직접 찍는다.
    func debugLibraryShot(_ path: String) {
        guard let v = libraryPopover?.contentViewController?.view else { return }
        v.layoutSubtreeIfNeeded()
        guard let rep = v.bitmapImageRepForCachingDisplay(in: v.bounds) else { return }
        v.cacheDisplay(in: v.bounds, to: rep)
        if let d = rep.representation(using: .png, properties: [:]) {
            try? d.write(to: URL(fileURLWithPath: path))
        }
    }
    func debugSuggestions() -> String {
        suggest.items.map { "\($0.kind)/\($0.title)" }.joined(separator: " | ")
    }
    func debugURL() -> String { tab?.web.url?.absoluteString ?? "(없음)" }
    /// 이 패널이 붙은 워크스페이스. 주소를 워크스페이스별로 기억하려고 앱이 채워 준다.
    var workspaceRoot: URL?
    private func showLoadError(_ error: Error, on webView: WKWebView? = nil) {
        let e = error as NSError
        if e.domain == "WebKitErrorDomain" && e.code == 102 { return }   // 리다이렉트로 끊긴 것 — 실패가 아니다
        if e.domain == NSURLErrorDomain && e.code == NSURLErrorCancelled { return }
        let target = webView.flatMap { w in tabs.first { $0.web === w } } ?? tab
        target?.errorText = t("preview.loadFailed", ["msg": e.localizedDescription])
        refreshChrome()
    }
    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
        showLoadError(error, on: webView); return
    }
    func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
        showLoadError(error, on: webView); return
    }
    /// 다운로드로 응답이 오면 WKDownload 로 넘긴다 (예전에는 아무 일도 일어나지 않았다).
    func webView(_ webView: WKWebView, decidePolicyFor navigationResponse: WKNavigationResponse,
                 decisionHandler: @escaping (WKNavigationResponsePolicy) -> Void) {
        decisionHandler(navigationResponse.canShowMIMEType ? .allow : .download)
    }
    func webView(_ webView: WKWebView, navigationAction: WKNavigationAction, didBecome download: WKDownload) {
        download.delegate = self
    }
    func webView(_ webView: WKWebView, navigationResponse: WKNavigationResponse, didBecome download: WKDownload) {
        download.delegate = self
    }

    // MARK: - UI delegate (new windows, JS dialogs)

    /// target=_blank / window.open → 새 탭. 예전에는 nil 을 돌려줘서 링크가 아무 반응도 없었다.
    func webView(_ webView: WKWebView, createWebViewWith configuration: WKWebViewConfiguration,
                 for navigationAction: WKNavigationAction, windowFeatures: WKWindowFeatures) -> WKWebView? {
        // 새 탭은 요청된 설정을 그대로 써야 opener 관계가 유지된다.
        let tb = newTab(nil, activate: true, configuration: configuration)
        if let url = navigationAction.request.url, navigationAction.targetFrame == nil {
            tb.web.load(URLRequest(url: url))
        }
        return tb.web
    }
    func webViewDidClose(_ webView: WKWebView) {
        if let i = tabs.firstIndex(where: { $0.web === webView }) { closeTab(i) }
    }
    func webView(_ webView: WKWebView, runJavaScriptAlertPanelWithMessage message: String,
                 initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping () -> Void) {
        let a = NSAlert(); a.messageText = message; a.addButton(withTitle: t("common.ok"))
        a.runModal(); completionHandler()
    }
    func webView(_ webView: WKWebView, runJavaScriptConfirmPanelWithMessage message: String,
                 initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping (Bool) -> Void) {
        let a = NSAlert(); a.messageText = message
        a.addButton(withTitle: t("common.confirm")); a.addButton(withTitle: t("common.cancel"))
        completionHandler(a.runModal() == .alertFirstButtonReturn)
    }
    func webView(_ webView: WKWebView, runJavaScriptTextInputPanelWithPrompt prompt: String,
                 defaultText: String?, initiatedByFrame frame: WKFrameInfo,
                 completionHandler: @escaping (String?) -> Void) {
        let a = NSAlert(); a.messageText = prompt
        a.addButton(withTitle: t("common.ok")); a.addButton(withTitle: t("common.cancel"))
        let field = NSTextField(frame: NSRect(x: 0, y: 0, width: 240, height: 24))
        field.stringValue = defaultText ?? ""
        a.accessoryView = field
        completionHandler(a.runModal() == .alertFirstButtonReturn ? field.stringValue : nil)
    }
    func webView(_ webView: WKWebView, runOpenPanelWith parameters: WKOpenPanelParameters,
                 initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping ([URL]?) -> Void) {
        let p = NSOpenPanel()
        p.allowsMultipleSelection = parameters.allowsMultipleSelection
        p.canChooseDirectories = parameters.allowsDirectories
        p.canChooseFiles = true
        completionHandler(p.runModal() == .OK ? p.urls : nil)
    }

    // MARK: - downloads

    func download(_ download: WKDownload, decideDestinationUsing response: URLResponse,
                  suggestedFilename: String, completionHandler: @escaping (URL?) -> Void) {
        // 내려받기 폴더에 못 쓰는 경우가 있다 (macOS 가 폴더 접근을 아직 허락하지 않았을 때).
        // 그냥 실패시키면 "Cannot create file" 만 남아 왜 안 되는지 알 수 없으므로,
        // 임시 폴더로 받아 두고 어디에 뒀는지 알려 준다.
        // 테스트에서 받을 곳을 바꿔 끼운다 (실사용에는 이 변수가 없다).
        let override = ProcessInfo.processInfo.environment["RIVEN_DLDIR"].map { URL(fileURLWithPath: $0) }
        let home = override ?? FileManager.default.urls(for: .downloadsDirectory, in: .userDomainMask).first
        var dir = home ?? URL(fileURLWithPath: NSTemporaryDirectory())
        var fellBack = false
        // isWritableFile 은 POSIX 권한만 본다. macOS 가 폴더 접근을 막고 있으면 그건 통과하고
        // 실제 쓰기에서 "Cannot create file" 로 죽는다 — 그래서 진짜로 파일을 하나 만들어 본다.
        if forceTempDownloadDir || !Self.canWrite(dir) {
            dir = URL(fileURLWithPath: NSTemporaryDirectory())
            fellBack = true
        }
        var dest = dir.appendingPathComponent(suggestedFilename)
        var n = 1
        while FileManager.default.fileExists(atPath: dest.path) {   // 덮어쓰지 않는다
            let base = (suggestedFilename as NSString).deletingPathExtension
            let ext = (suggestedFilename as NSString).pathExtension
            dest = dir.appendingPathComponent(ext.isEmpty ? "\(base) \(n)" : "\(base) \(n).\(ext)")
            n += 1
        }
        let item = DownloadItem(name: dest.lastPathComponent, dest: dest, progress: download.progress)
        downloadItems[ObjectIdentifier(download)] = item
        downloads.insert(item, at: 0)
        refreshDownloadButton()
        setStatus(fellBack ? t("browser.downloadingTemp", ["f": dest.lastPathComponent])
                           : t("browser.downloading", ["f": dest.lastPathComponent]))
        completionHandler(dest)
    }
    func downloadDidFinish(_ download: WKDownload) {
        let item = downloadItems.removeValue(forKey: ObjectIdentifier(download))
        item?.finish()
        // 예전에는 다 받으면 Finder 가 앞으로 튀어나왔다 — 일하다 창이 바뀌는 건 방해라
        // 알림만 남기고, 열지 말지는 목록에서 고르게 한다.
        setStatus(t("browser.downloaded", ["f": item?.name ?? ""]))
        refreshDownloadButton()
    }
    func download(_ download: WKDownload, didFailWithError error: Error, resumeData: Data?) {
        let item = downloadItems.removeValue(forKey: ObjectIdentifier(download))
        // 파일을 못 만들어 실패했으면 임시 폴더로 한 번 더 해 본다. 내려받기 폴더에
        // 쓸 수 있는지는 미리 알 수 없다 — 권한을 POSIX 로 물으면 된다고 나오는데 실제
        // 쓰기에서 막히는 경우가 있어서(그럼 "Cannot create file" 만 남는다), 겪은 뒤에
        // 옮기는 게 확실하다.
        let createFailed = error.localizedDescription.lowercased().contains("cannot create file")
        if createFailed, let req = download.originalRequest, !retriedDownloads.contains(req.url?.absoluteString ?? "") {
            retriedDownloads.insert(req.url?.absoluteString ?? "")
            downloads.removeAll { $0 === item }
            forceTempDownloadDir = true
            setStatus(t("browser.downloadRetryTemp"))
            tab?.web.startDownload(using: req) { [weak self] d in
                d.delegate = self
            }
            return
        }
        item?.fail(error.localizedDescription)
        setStatus(t("browser.downloadFailed", ["msg": error.localizedDescription]))
        refreshDownloadButton()
    }
    /// 같은 주소로 무한히 다시 시도하지 않도록.
    private var retriedDownloads: Set<String> = []
    /// 한 번 막히면 이 세션에서는 계속 임시 폴더로 받는다.
    private var forceTempDownloadDir = false
    private var downloadItems: [ObjectIdentifier: DownloadItem] = [:]

    private static func canWrite(_ dir: URL) -> Bool {
        let probe = dir.appendingPathComponent(".riven-write-probe-\(getpid())")
        guard FileManager.default.createFile(atPath: probe.path, contents: nil) else { return false }
        try? FileManager.default.removeItem(at: probe)
        return true
    }

    private func refreshDownloadButton() {
        downloadBtn.isHidden = downloads.isEmpty
        downloadWidth.constant = downloads.isEmpty ? 0 : UIScale.pt(22)
        let running = downloads.contains { !$0.done && $0.failed == nil }
        downloadBtn.contentTintColor = running ? Theme.accent : Theme.fgDim
    }
    /// ⋮ — 브라우저마다 있는 그 메뉴. 늘 쓰는 것(뒤로·앞으로·새로고침·주소·별)만 밖에 두고
    /// 나머지는 여기 넣는다. 아이콘을 여섯 개씩 늘어놓으면 무엇이 중요한지 알 수 없다.
    @objc private func showMenu() {
        let menu = buildMenu()
        let p = NSPoint(x: 0, y: menuBtn.bounds.height + 4)
        menu.popUp(positioning: nil, at: p, in: menuBtn)
    }
    private func buildMenu() -> NSMenu {
        let menu = NSMenu()
        func add(_ title: String, _ key: String = "", _ mods: NSEvent.ModifierFlags = .command,
                 _ enabled: Bool = true, _ body: @escaping () -> Void) {
            let item = NSMenuItem(title: title, action: #selector(runMenuAction(_:)), keyEquivalent: key)
            item.keyEquivalentModifierMask = mods
            item.target = self
            item.isEnabled = enabled
            item.representedObject = body as Any
            menu.addItem(item)
        }
        add(t("browser.newTab"), "t") { [weak self] in self?.newTab(nil, activate: true) }
        add(t("browser.privateTabMenu"), "n", [.command, .shift]) { [weak self] in
            self?.newTab(nil, activate: true, isPrivate: true)
            self?.setStatus(t("browser.privateTab"))
        }
        menu.addItem(.separator())
        add(t("browser.history") + " · " + t("browser.bookmarks"), "y") { [weak self] in self?.showLibrary() }
        add(t("browser.downloads"), "", [], !downloads.isEmpty) { [weak self] in self?.showDownloads() }
        add(t("browser.find"), "f") { [weak self] in self?.showFind() }
        menu.addItem(.separator())
        add(t("preview.reload"), "r") { [weak self] in self?.tab?.web.reload() }
        add(t("browser.hardReload"), "r", [.command, .shift]) { [weak self] in self?.hardReload() }
        add(t("browser.clearCache"), "", []) { [weak self] in self?.clearCache() }
        add(t("browser.clearData"), "", []) { [weak self] in self?.clearSiteData() }
        menu.addItem(.separator())
        add(t("browser.zoomIn"), "+") { [weak self] in self?.zoomIn() }
        add(t("browser.zoomOut"), "-") { [weak self] in self?.zoomOut() }
        add(t("browser.zoomReset"), "0") { [weak self] in self?.resetZoom() }
        menu.addItem(.separator())
        add(t("preview.captureTitle"), "", []) { [weak self] in self?.captureNow() }
        add(t("browser.viewSource"), "", [], tab != nil) { [weak self] in
            if let tb = self?.tab { self?.viewSource(tb) }
        }
        add(t("browser.inspect"), "i", [.command, .option]) { [weak self] in self?.openInspector() }
        add(t("browser.consoleDrawer"), "c", [.command, .option]) { [weak self] in self?.toggleConsoleDrawer() }
        add(t("preview.openExternal"), "", [], tab?.web.url != nil) { [weak self] in self?.openExternal() }
        return menu
    }
    func debugMenu() -> String {
        buildMenu().items.map { $0.isSeparatorItem ? "—" : ($0.title + ($0.isEnabled ? "" : "(꺼짐)")) }
            .joined(separator: " / ")
    }

    @objc private func showDownloads() {
        let v = DownloadsView(frame: NSRect(x: 0, y: 0, width: 340, height: 260))
        v.items = downloads
        v.onOpen = { NSWorkspace.shared.open($0.dest) }
        v.onReveal = { NSWorkspace.shared.activateFileViewerSelecting([$0.dest]) }
        v.onClear = { [weak self] in
            self?.downloads.removeAll { $0.done || $0.failed != nil }
            self?.refreshDownloadButton()
            self?.downloadsPopover?.close()
        }
        let pop = NSPopover()
        pop.behavior = .transient
        pop.contentViewController = NSViewController()
        pop.contentViewController?.view = v
        pop.show(relativeTo: downloadBtn.bounds, of: downloadBtn, preferredEdge: .maxY)
        downloadsPopover = pop
    }

    // MARK: - capture

    @objc private func captureNow() {
        capture { [weak self] path in
            guard let path else { NSSound.beep(); return }
            self?.onCapture?(path)
        }
    }
    /// 한 장 찍어 PNG 경로를 돌려준다 (riven_screenshot).
    func capture(_ done: @escaping (String?) -> Void) {
        guard let web = tab?.web, !(tab?.urlString.isEmpty ?? true) else { done(nil); return }
        web.takeSnapshot(with: WKSnapshotConfiguration()) { image, _ in
            guard let image, let tiff = image.tiffRepresentation, let rep = NSBitmapImageRep(data: tiff),
                  let png = rep.representation(using: .png, properties: [:]) else { done(nil); return }
            let path = NSTemporaryDirectory() + "riven-capture-\(UUID().uuidString.prefix(8)).png"
            do { try png.write(to: URL(fileURLWithPath: path)); done(path) } catch { done(nil) }
        }
    }

    /// 브라우저 단축키. 패널(또는 그 안의 웹뷰)에 포커스가 있을 때만 잡는다.
    /// ⌘+/− 는 riven 전체 UI 배율이라 건드리지 않는다 — 페이지 확대는 툴바 버튼으로.
    override func performKeyEquivalent(with event: NSEvent) -> Bool {
        guard let win = window, let fr = win.firstResponder as? NSView, fr.isDescendant(of: self) || fr === self
        else { return super.performKeyEquivalent(with: event) }
        let cmd = event.modifierFlags.contains(.command)
        let shift = event.modifierFlags.contains(.shift)
        let opt = event.modifierFlags.contains(.option)
        switch event.charactersIgnoringModifiers?.lowercased() {
        // 브라우저에서 손에 익은 키들.
        case "r" where cmd && shift: hardReload(); return true          // 캐시 무시하고 새로고침
        case "r" where cmd: tab?.web.reload(); return true
        case "[" where cmd, "\u{1c}" where cmd:                         // ⌘[ · ⌘←
            if tab?.web.canGoBack == true { tab?.web.goBack() }
            return true
        case "]" where cmd, "\u{1d}" where cmd:                         // ⌘] · ⌘→
            if tab?.web.canGoForward == true { tab?.web.goForward() }
            return true
        case "i" where cmd && opt: openInspector(); return true         // 개발자 도구 (Web Inspector)
        case "c" where cmd && opt: toggleConsoleDrawer(); return true   // riven 콘솔 서랍
        case "." where cmd: tab?.web.stopLoading(); return true         // 멈춤
        case "f" where cmd: showFind(); return true
        case "l" where cmd: focusURL(); return true
        case "t" where cmd && event.modifierFlags.contains(.shift): reopenClosedTab(); return true
        case "t" where cmd: newTab(nil, activate: true); return true
        case "n" where cmd && event.modifierFlags.contains(.shift):
            newTab(nil, activate: true, isPrivate: true)
            setStatus(t("browser.privateTab"))
            return true
        // ⌘W: 브라우저 탭을 닫는다. 마지막 탭이면 패널이 닫힌다 — 브라우저에서 마지막
        // 탭을 닫으면 창이 닫히는 것과 같다. 예전에는 탭이 하나면 아무 일도 없었다.
        case "w" where cmd: closeTab(current); return true
        case "y" where cmd: showLibrary(); return true
        default:
            // ⌘1..⌘8 → 그 번호의 탭, ⌘9 → 마지막 탭 (크롬과 같다). 터미널은 ⌃1..9 라 겹치지 않는다.
            if cmd, let ch = event.charactersIgnoringModifiers, ch.count == 1,
               let n = Int(ch), n >= 1, n <= 9, !tabs.isEmpty {
                select(n == 9 ? tabs.count - 1 : min(n - 1, tabs.count - 1))
                return true
            }
            // ⌥⌘→ / ⌥⌘← → 다음·이전 탭
            if cmd, opt, let ch = event.charactersIgnoringModifiers, tabs.count > 1 {
                if ch == "\u{1d}" { select((current + 1) % tabs.count); return true }
                if ch == "\u{1c}" { select((current - 1 + tabs.count) % tabs.count); return true }
            }
            return super.performKeyEquivalent(with: event)
        }
    }
    override func cancelOperation(_ sender: Any?) {
        if !findBar.isHidden { hideFind() }
    }

    // MARK: - agent control (riven_browser_*)
    //
    // 에이전트가 부르는 것들. 전부 메인 스레드에서만 돌고(WKWebView 요구), 무엇을 했는지
    // 패널 상태 줄에 남긴다 — mcp__riven__ 도구는 자동 승인이라, 사용자가 화면만 봐도 무슨
    // 일이 일어났는지 알 수 있어야 한다.
    private func note(_ text: String) { setStatus("🤖 " + text); agentLog.append(text) }
    /// 벤치용: 에이전트가 이 패널에 실제로 시킨 동작들.
    private(set) var agentLog: [String] = []
    func debugAgentLog() -> String { agentLog.joined(separator: " / ") }
    /// 자바스크립트 문자열 인자를 안전하게 넘기려고 callAsyncJavaScript 를 쓴다 (셀렉터에
    /// 따옴표가 있어도 코드가 깨지거나 주입되지 않는다).
    private func run(_ body: String, _ args: [String: Any], _ done: @escaping (String) -> Void) {
        guard let web = tab?.web else { done("no page open"); return }
        web.callAsyncJavaScript(body, arguments: args, in: nil, in: .page) { result in
            switch result {
            case .success(let v):
                if v is NSNull { done("ok") } else { done(Self.describe(v)) }
            case .failure(let e): done("error: \(e.localizedDescription)")
            }
        }
    }
    private static func describe(_ v: Any?) -> String {
        guard let v else { return "ok" }
        if let s = v as? String { return s }
        if let d = try? JSONSerialization.data(withJSONObject: v, options: [.fragmentsAllowed]),
           let s = String(data: d, encoding: .utf8) { return s }
        return "\(v)"
    }
    /// 에이전트에게 돌려주는 텍스트는 잘라서 준다 — 페이지 전체가 컨텍스트를 다 먹지 않게.
    private static func clip(_ s: String, _ limit: Int = 8000) -> String {
        s.count <= limit ? s : String(s.prefix(limit)) + "\n…(truncated, \(s.count) chars total)"
    }

    func agentNavigate(_ urlString: String, newTab wantsNew: Bool, profile: String = "") -> String {
        guard let url = BrowserTab.resolve(urlString) else { return "invalid url: \(urlString)" }
        // 프로필을 주면 언제나 새 탭이다 — 로그인 묶음이 다르니 지금 탭을 재사용할 수 없다.
        if wantsNew || !profile.isEmpty { newTab(url, activate: true, profile: profile) }
        else { urlField.stringValue = url.absoluteString; load(url) }
        note(t("browser.agent.navigate", ["u": url.absoluteString]))
        return "navigating to \(url.absoluteString)"
    }
    func agentState() -> String {
        guard let tb = tab else { return "no tab" }
        var out = ["url: \(tb.urlString.isEmpty ? "(blank)" : tb.urlString)",
                   "title: \(tb.title)",
                   "loading: \(tb.isLoading)",
                   "canGoBack: \(tb.web.canGoBack)  canGoForward: \(tb.web.canGoForward)",
                   "zoom: \(Int(tb.web.pageZoom * 100))%"]
        if tabs.count > 1 {
            out.append("tabs:")
            for (i, other) in tabs.enumerated() {
                let tag = other.isPrivate ? " (private)" : (other.profile.isEmpty ? "" : " (profile \(other.profile))")
                out.append("  [\(i)]\(i == current ? "*" : " ") \(other.title) \(other.urlString)\(tag)")
            }
        }
        return out.joined(separator: "\n")
    }
    /// 탭 고르기·닫기. 여러 페이지를 오가며 확인할 때 이게 없으면 매번 새로 열어야 했다.
    func agentTab(_ action: String, index: Int?) -> String {
        switch action.lowercased() {
        case "select":
            guard let i = index, tabs.indices.contains(i) else { return "no tab at index \(index.map(String.init) ?? "-")" }
            select(i)
            note(t("browser.agent.tabSelect", ["n": String(i)]))
            return "switched to tab \(i): \(tabs[i].urlString)"
        case "close":
            let i = index ?? current
            guard tabs.indices.contains(i) else { return "no tab at index \(i)" }
            guard tabs.count > 1 else { return "cannot close the last tab" }
            let gone = tabs[i].urlString
            closeTab(i)
            note(t("browser.agent.tabClose", ["n": String(i)]))
            return "closed tab \(i) (\(gone)); now on tab \(current)"
        default:
            return "unknown tab action: \(action) (use select or close)"
        }
    }
    func agentGo(_ action: String) -> String {
        guard let tb = tab else { return "no tab" }
        switch action.lowercased() {
        case "back":
            guard tb.web.canGoBack else { return "cannot go back" }
            tb.web.goBack(); note(t("browser.agent.back")); return "went back"
        case "forward":
            guard tb.web.canGoForward else { return "cannot go forward" }
            tb.web.goForward(); note(t("browser.agent.forward")); return "went forward"
        case "reload":
            tb.web.reload(); note(t("browser.agent.reload")); return "reloading"
        case "stop":
            tb.web.stopLoading(); note(t("browser.agent.stop")); return "stopped"
        default: return "unknown action: \(action) (use back | forward | reload | stop)"
        }
    }
    func agentRead(selector: String?, html: Bool, _ done: @escaping (String) -> Void) {
        note(selector.map { t("browser.agent.read", ["s": $0]) } ?? t("browser.agent.readPage"))
        let body = """
        const el = sel ? document.querySelector(sel) : document.body;
        if (!el) return "no element matched: " + sel;
        return asHtml ? el.outerHTML : el.innerText;
        """
        run(body, ["sel": selector ?? NSNull(), "asHtml": html]) { done(Self.clip($0)) }
    }
    func agentClick(_ selector: String, _ done: @escaping (String) -> Void) {
        note(t("browser.agent.click", ["s": selector]))
        let body = """
        const el = document.querySelector(sel);
        if (!el) return "no element matched: " + sel;
        el.scrollIntoView({block: "center"});
        el.click();
        return "clicked " + (el.tagName||"").toLowerCase() + (el.id ? "#" + el.id : "");
        """
        run(body, ["sel": selector], done)
    }
    func agentFill(_ selector: String, _ value: String, submit: Bool, _ done: @escaping (String) -> Void) {
        // 값 자체는 남기지 않는다 (비밀번호·토큰일 수 있다). 어디에 채웠는지만 보인다.
        note(t("browser.agent.fill", ["s": selector]))
        let body = """
        const el = document.querySelector(sel);
        if (!el) return "no element matched: " + sel;
        el.focus();
        const setter = Object.getOwnPropertyDescriptor(el.constructor.prototype, "value");
        if (setter && setter.set) { setter.set.call(el, val); } else { el.value = val; }
        el.dispatchEvent(new Event("input", {bubbles: true}));
        el.dispatchEvent(new Event("change", {bubbles: true}));
        if (doSubmit) { const f = el.form; if (f) { f.requestSubmit ? f.requestSubmit() : f.submit(); } }
        return "filled " + sel + (doSubmit ? " and submitted" : "");
        """
        run(body, ["sel": selector, "val": value, "doSubmit": submit], done)
    }
    /// 요소가 나타날 때까지 기다린다. 타이머를 붙들지 않고 asyncAfter 체인으로 폴링하다가
    /// 마감시각을 넘기면 스스로 끝난다 (남는 타이머 없음).
    func agentWait(_ selector: String, timeoutMs: Int, _ done: @escaping (String) -> Void) {
        note(t("browser.agent.wait", ["s": selector]))
        let deadline = Date().addingTimeInterval(Double(min(max(timeoutMs, 100), 60_000)) / 1000)
        func poll() {
            run("return !!document.querySelector(sel);", ["sel": selector]) { [weak self] r in
                if r == "true" { done("found \(selector)"); return }
                guard Date() < deadline else { done("timed out waiting for \(selector)"); return }
                guard self != nil else { done("panel closed"); return }
                DispatchQueue.main.asyncAfter(deadline: .now() + 0.25) { poll() }
            }
        }
        poll()
    }
    func agentScroll(selector: String?, y: Double?, _ done: @escaping (String) -> Void) {
        note(t("browser.agent.scroll"))
        let body = """
        if (sel) {
          const el = document.querySelector(sel);
          if (!el) return "no element matched: " + sel;
          el.scrollIntoView({block: "center", behavior: "instant"});
          return "scrolled to " + sel;
        }
        window.scrollTo({top: dy === null ? document.body.scrollHeight : dy, behavior: "instant"});
        return "scrolled to y=" + window.scrollY;
        """
        run(body, ["sel": selector ?? NSNull(), "dy": y ?? NSNull()], done)
    }
    func agentEval(_ js: String, _ done: @escaping (String) -> Void) {
        note(t("browser.agent.eval"))
        run("return (function(){ \(js) \n})();", [:]) { done(Self.clip($0)) }
    }
    /// 지금 페이지의 출처 (eval 승인을 이 출처에 한정하기 위해).
    var currentOrigin: String {
        guard let u = URL(string: tab?.urlString ?? "") , let h = u.host else { return "" }
        return "\(u.scheme ?? "https")://\(h)"
    }

    func applyTheme() {
        styleAddressBar()
        layer?.backgroundColor = Theme.bg2.cgColor
        urlField.textColor = Theme.fg
        findField.textColor = Theme.fg
        emptyLabel.textColor = Theme.fgDim
        statusLabel.textColor = Theme.fgDim
        progress.layer?.backgroundColor = Theme.accent.cgColor
        findBar.layer?.backgroundColor = Theme.bg3.cgColor
        [backBtn, fwdBtn, stopBtn, menuBtn, downloadBtn,
         findPrev, findNext, findDone].forEach { $0.contentTintColor = Theme.fgDim }
        urlField.textColor = Theme.fg
    }
    func applyScale() {
        urlField.font = UIScale.font(UIScale.body)
        findField.font = UIScale.font(UIScale.body)
        emptyLabel.font = UIScale.font(UIScale.small)
        statusLabel.font = UIScale.font(UIScale.caption)
    }
}
