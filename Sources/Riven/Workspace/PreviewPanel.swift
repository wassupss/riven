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
    var onChange: (() -> Void)?
    private var tokens: [NSKeyValueObservation] = []

    init(configuration: WKWebViewConfiguration) {
        web = WKWebView(frame: .zero, configuration: configuration)
        super.init()
        web.translatesAutoresizingMaskIntoConstraints = false
        web.allowsBackForwardNavigationGestures = true       // two-finger swipe, like Safari
        web.isInspectable = true                             // right-click → 요소 정보 검사
        // Some sites gate features on a real browser UA; the default WKWebView UA is close enough
        // but omits a Safari token, which a few dev servers sniff for.
        web.customUserAgent = nil
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
    private let stack = NSStackView()
    private let scroll = NSScrollView()
    private let newBtn = NSButton()
    private var titles: [String] = []
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

    func set(_ list: [String], selected sel: Int) {
        titles = list; selected = sel
        stack.arrangedSubviews.forEach { $0.removeFromSuperview() }
        for (i, name) in list.enumerated() {
            stack.addArrangedSubview(makeTab(i, name, active: i == sel))
        }
        needsDisplay = true
    }
    private func makeTab(_ i: Int, _ name: String, active: Bool) -> NSView {
        let row = TabCell()
        row.index = i
        row.onPick = { [weak self] in self?.onSelect?(i) }
        row.onClose = { [weak self] in self?.onClose?(i) }
        row.configure(name, active: active, closable: titles.count > 1)
        return row
    }
    func applyTheme() { needsDisplay = true; set(titles, selected: selected) }
    func applyScale() { set(titles, selected: selected) }
    @objc private func newTapped() { onNew?() }
    /// 기준선 + 활성 탭 밑줄 (RivenTabStrip 과 같은 표현).
    override func draw(_ dirty: NSRect) {
        Theme.hairline.setFill()
        NSRect(x: 0, y: bounds.height - 1, width: bounds.width, height: 1).fill()
    }

    /// 한 칸: 제목 + (마우스를 올리면) 닫기.
    private final class TabCell: NSView {
        var index = 0
        var onPick: (() -> Void)?
        var onClose: (() -> Void)?
        private let label = NSTextField(labelWithString: "")
        private let close = NSButton()
        private var track: NSTrackingArea?
        private var active = false
        private var closable = false
        override init(frame: NSRect) {
            super.init(frame: frame)
            wantsLayer = true
            label.lineBreakMode = .byTruncatingTail
            label.translatesAutoresizingMaskIntoConstraints = false
            close.image = NSImage(systemSymbolName: "xmark", accessibilityDescription: t("browser.closeTab"))
            close.image?.isTemplate = true; close.imagePosition = .imageOnly
            close.isBordered = false; close.isHidden = true
            close.target = self; close.action = #selector(closeTapped)
            close.translatesAutoresizingMaskIntoConstraints = false
            addSubview(label); addSubview(close)
            NSLayoutConstraint.activate([
                label.leadingAnchor.constraint(equalTo: leadingAnchor, constant: 10),
                label.centerYAnchor.constraint(equalTo: centerYAnchor),
                close.leadingAnchor.constraint(equalTo: label.trailingAnchor, constant: 4),
                close.trailingAnchor.constraint(equalTo: trailingAnchor, constant: -6),
                close.centerYAnchor.constraint(equalTo: centerYAnchor),
                close.widthAnchor.constraint(equalToConstant: 14),
                widthAnchor.constraint(lessThanOrEqualToConstant: UIScale.pt(170)),
            ])
        }
        required init?(coder: NSCoder) { fatalError() }
        func configure(_ name: String, active: Bool, closable: Bool) {
            self.active = active; self.closable = closable
            label.stringValue = name
            label.font = UIScale.font(UIScale.small, active ? .semibold : .regular)
            label.textColor = active ? Theme.fg : Theme.fgDim
            close.contentTintColor = Theme.fgDim
            needsDisplay = true
        }
        override func updateTrackingAreas() {
            super.updateTrackingAreas()
            if let t = track { removeTrackingArea(t) }
            let t = NSTrackingArea(rect: bounds, options: [.mouseEnteredAndExited, .activeInKeyWindow], owner: self)
            addTrackingArea(t); track = t
        }
        override func mouseEntered(with e: NSEvent) { close.isHidden = !closable }
        override func mouseExited(with e: NSEvent) { close.isHidden = true }
        override func mouseDown(with e: NSEvent) { onPick?() }
        @objc private func closeTapped() { onClose?() }
        override func draw(_ dirty: NSRect) {
            if active {
                Theme.accent.setFill()
                NSRect(x: 0, y: bounds.height - 2, width: bounds.width, height: 2).fill()
            }
        }
    }
}

// MARK: - panel

final class PreviewPanel: NSView, Themable, Scalable, WKScriptMessageHandler,
                          WKNavigationDelegate, WKUIDelegate, WKDownloadDelegate {
    var onFocused: (() -> Void)?   // page interaction → activate this dock group
    var onCapture: ((String) -> Void)?   // saved PNG path → send to the running agent

    // ---- chrome ----
    private let backBtn = NSButton()
    private let fwdBtn = NSButton()
    private let stopBtn = NSButton()          // 로딩 중에는 ✕, 아니면 ⟳
    private let urlField = NSTextField()
    private let captureBtn = NSButton()
    private let externalBtn = NSButton()
    private let inspectBtn = NSButton()
    private let zoomOutBtn = NSButton()
    private let zoomInBtn = NSButton()
    private let progress = NSView()
    private var progressWidth: NSLayoutConstraint!
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
        icon(captureBtn, "camera", t("preview.captureTitle"), #selector(captureNow))
        icon(externalBtn, "arrow.up.forward.app", t("preview.openExternal"), #selector(openExternal))
        icon(inspectBtn, "curlybraces", t("browser.inspect"), #selector(openInspector))
        icon(zoomOutBtn, "minus.magnifyingglass", t("browser.zoomOut"), #selector(zoomOut))
        icon(zoomInBtn, "plus.magnifyingglass", t("browser.zoomIn"), #selector(zoomIn))

        urlField.placeholderString = t("browser.urlPlaceholder")
        urlField.font = UIScale.font(UIScale.body)
        urlField.bezelStyle = .roundedBezel
        urlField.target = self; urlField.action = #selector(openURL)
        urlField.translatesAutoresizingMaskIntoConstraints = false

        progress.wantsLayer = true
        progress.translatesAutoresizingMaskIntoConstraints = false
        progress.isHidden = true

        tabStrip.onSelect = { [weak self] i in self?.select(i) }
        tabStrip.onClose = { [weak self] i in self?.closeTab(i) }
        tabStrip.onNew = { [weak self] in self?.newTab(nil, activate: true) }
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

        [backBtn, fwdBtn, stopBtn, urlField, zoomOutBtn, zoomInBtn, captureBtn, inspectBtn,
         externalBtn, progress, tabStrip, findBar, container, emptyLabel, statusLabel].forEach { addSubview($0) }

        let pad: CGFloat = 8
        progressWidth = progress.widthAnchor.constraint(equalToConstant: 0)
        tabStripHeight = tabStrip.heightAnchor.constraint(equalToConstant: 0)
        statusHeight = statusLabel.heightAnchor.constraint(equalToConstant: 0)
        NSLayoutConstraint.activate([
            backBtn.leadingAnchor.constraint(equalTo: leadingAnchor, constant: pad),
            backBtn.topAnchor.constraint(equalTo: topAnchor, constant: pad),
            backBtn.widthAnchor.constraint(equalToConstant: UIScale.pt(20)),
            fwdBtn.leadingAnchor.constraint(equalTo: backBtn.trailingAnchor, constant: 2),
            fwdBtn.centerYAnchor.constraint(equalTo: backBtn.centerYAnchor),
            fwdBtn.widthAnchor.constraint(equalToConstant: UIScale.pt(20)),
            stopBtn.leadingAnchor.constraint(equalTo: fwdBtn.trailingAnchor, constant: 2),
            stopBtn.centerYAnchor.constraint(equalTo: backBtn.centerYAnchor),
            stopBtn.widthAnchor.constraint(equalToConstant: UIScale.pt(20)),
            urlField.leadingAnchor.constraint(equalTo: stopBtn.trailingAnchor, constant: 6),
            urlField.centerYAnchor.constraint(equalTo: backBtn.centerYAnchor),
            urlField.trailingAnchor.constraint(equalTo: zoomOutBtn.leadingAnchor, constant: -6),
            zoomOutBtn.trailingAnchor.constraint(equalTo: zoomInBtn.leadingAnchor, constant: -2),
            zoomOutBtn.centerYAnchor.constraint(equalTo: backBtn.centerYAnchor),
            zoomOutBtn.widthAnchor.constraint(equalToConstant: UIScale.pt(20)),
            zoomInBtn.trailingAnchor.constraint(equalTo: captureBtn.leadingAnchor, constant: -4),
            zoomInBtn.centerYAnchor.constraint(equalTo: backBtn.centerYAnchor),
            zoomInBtn.widthAnchor.constraint(equalToConstant: UIScale.pt(20)),
            captureBtn.trailingAnchor.constraint(equalTo: inspectBtn.leadingAnchor, constant: -4),
            captureBtn.centerYAnchor.constraint(equalTo: backBtn.centerYAnchor),
            captureBtn.widthAnchor.constraint(equalToConstant: UIScale.pt(20)),
            inspectBtn.trailingAnchor.constraint(equalTo: externalBtn.leadingAnchor, constant: -4),
            inspectBtn.centerYAnchor.constraint(equalTo: backBtn.centerYAnchor),
            inspectBtn.widthAnchor.constraint(equalToConstant: UIScale.pt(20)),
            externalBtn.trailingAnchor.constraint(equalTo: trailingAnchor, constant: -pad),
            externalBtn.centerYAnchor.constraint(equalTo: backBtn.centerYAnchor),
            externalBtn.widthAnchor.constraint(equalToConstant: UIScale.pt(20)),

            progress.leadingAnchor.constraint(equalTo: leadingAnchor),
            progress.topAnchor.constraint(equalTo: urlField.bottomAnchor, constant: 6),
            progress.heightAnchor.constraint(equalToConstant: 2),
            progressWidth,

            tabStrip.leadingAnchor.constraint(equalTo: leadingAnchor),
            tabStrip.trailingAnchor.constraint(equalTo: trailingAnchor),
            tabStrip.topAnchor.constraint(equalTo: progress.bottomAnchor),
            tabStripHeight,

            findBar.leadingAnchor.constraint(equalTo: leadingAnchor),
            findBar.trailingAnchor.constraint(equalTo: trailingAnchor),
            findBar.topAnchor.constraint(equalTo: tabStrip.bottomAnchor),

            container.leadingAnchor.constraint(equalTo: leadingAnchor),
            container.trailingAnchor.constraint(equalTo: trailingAnchor),
            container.topAnchor.constraint(equalTo: findBar.bottomAnchor),
            container.bottomAnchor.constraint(equalTo: statusLabel.topAnchor),

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

    private func makeConfiguration() -> WKWebViewConfiguration {
        let cfg = WKWebViewConfiguration()
        cfg.processPool = Self.processPool
        cfg.websiteDataStore = .default()          // 쿠키·로컬스토리지가 디스크에 남는다
        cfg.preferences.setValue(true, forKey: "developerExtrasEnabled")
        cfg.preferences.javaScriptCanOpenWindowsAutomatically = true
        // 페이지를 클릭하면 이 독 그룹이 활성화되어야 한다 — WKWebView 가 AppKit 마우스
        // 이벤트를 삼키므로 작은 스크립트가 대신 알려준다.
        cfg.userContentController.add(self, name: "prevfocus")
        cfg.userContentController.addUserScript(WKUserScript(
            source: "document.addEventListener('mousedown',function(){window.webkit.messageHandlers.prevfocus.postMessage(1)},true);",
            injectionTime: .atDocumentStart, forMainFrameOnly: false))
        return cfg
    }

    @discardableResult
    private func newTab(_ url: URL?, activate: Bool, configuration: WKWebViewConfiguration? = nil) -> BrowserTab {
        let tb = BrowserTab(configuration: configuration ?? makeConfiguration())
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
        if let url { tb.web.load(URLRequest(url: url)) }
        if activate { select(tabs.count - 1) } else { tb.web.isHidden = true; refreshTabStrip() }
        return tb
    }

    private func select(_ i: Int) {
        guard tabs.indices.contains(i) else { return }
        current = i
        for (j, t) in tabs.enumerated() { t.web.isHidden = (j != i) }
        refreshChrome(); refreshTabStrip()
    }

    private func closeTab(_ i: Int) {
        guard tabs.count > 1, tabs.indices.contains(i) else { return }
        let tb = tabs.remove(at: i)
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
        tabStrip.set(tabs.map { $0.shortTitle.isEmpty ? t("browser.newTabTitle") : $0.shortTitle },
                     selected: current)
        // 탭이 하나면 줄을 감춘다 — 좁은 패널에서 세로 공간이 아깝다.
        let h = tabs.count > 1 ? UIScale.pt(26) : 0
        if tabStripHeight.constant != h { tabStripHeight.constant = h }
        tabStrip.isHidden = tabs.count <= 1
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
        stopBtn.image = NSImage(systemSymbolName: tb.isLoading ? "xmark" : "arrow.clockwise",
                                accessibilityDescription: tb.isLoading ? t("browser.stop") : t("preview.reload"))
        stopBtn.image?.isTemplate = true
        stopBtn.toolTip = tb.isLoading ? t("browser.stop") : t("preview.reload")
        emptyLabel.isHidden = !tb.urlString.isEmpty
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
        externalBtn.toolTip = t("preview.openExternal"); inspectBtn.toolTip = t("browser.inspect")
        zoomInBtn.toolTip = t("browser.zoomIn"); zoomOutBtn.toolTip = t("browser.zoomOut")
        captureBtn.toolTip = t("preview.captureTitle")
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
    @objc private func reloadOrStop() {
        guard let tb = tab else { return }
        if tb.isLoading { tb.web.stopLoading() } else if !tb.urlString.isEmpty { tb.web.reload() }
    }
    @objc private func openURL() {
        guard let url = BrowserTab.resolve(urlField.stringValue) else { return }
        load(url)
    }
    private func load(_ url: URL) {
        if tabs.isEmpty { newTab(url, activate: true); return }
        emptyLabel.isHidden = true
        tab?.web.isHidden = false
        tab?.web.load(URLRequest(url: url))
    }
    @objc private func openExternal() {
        guard let s = tab?.urlString, let url = URL(string: s) else { return }
        NSWorkspace.shared.open(url)
    }
    /// 개발자 도구. WKWebView 에 공개 API 가 없어 비공개 인스펙터를 호출하는 대신, 사용자가
    /// 쓰는 경로(우클릭 → 요소 정보 검사)를 안내한다. isInspectable 은 켜져 있다.
    @objc private func openInspector() {
        setStatus(t("browser.inspectHint"))
    }
    @objc private func zoomIn() { setZoom((tab?.web.pageZoom ?? 1) + 0.1) }
    @objc private func zoomOut() { setZoom((tab?.web.pageZoom ?? 1) - 0.1) }
    func resetZoom() { setZoom(1) }
    private func setZoom(_ z: CGFloat) {
        guard let web = tab?.web else { return }
        web.pageZoom = min(3, max(0.4, z))
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
        if m.name == "prevfocus" { onFocused?() }
    }
    func webView(_ webView: WKWebView, didStartProvisionalNavigation navigation: WKNavigation!) {
        setStatus(nil)
        refreshChrome()
    }
    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) { refreshChrome() }
    private func showLoadError(_ error: Error) {
        let e = error as NSError
        if e.domain == "WebKitErrorDomain" && e.code == 102 { return }   // 리다이렉트로 끊긴 것 — 실패가 아니다
        if e.domain == NSURLErrorDomain && e.code == NSURLErrorCancelled { return }
        emptyLabel.stringValue = t("preview.loadFailed", ["msg": e.localizedDescription])
        emptyLabel.isHidden = false
        refreshChrome()
    }
    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
        showLoadError(error)
    }
    func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
        showLoadError(error)
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
        let dir = FileManager.default.urls(for: .downloadsDirectory, in: .userDomainMask).first
            ?? URL(fileURLWithPath: NSTemporaryDirectory())
        var dest = dir.appendingPathComponent(suggestedFilename)
        var n = 1
        while FileManager.default.fileExists(atPath: dest.path) {   // 덮어쓰지 않는다
            let base = (suggestedFilename as NSString).deletingPathExtension
            let ext = (suggestedFilename as NSString).pathExtension
            dest = dir.appendingPathComponent(ext.isEmpty ? "\(base) \(n)" : "\(base) \(n).\(ext)")
            n += 1
        }
        downloadDest[ObjectIdentifier(download)] = dest
        setStatus(t("browser.downloading", ["f": dest.lastPathComponent]))
        completionHandler(dest)
    }
    func downloadDidFinish(_ download: WKDownload) {
        let dest = downloadDest.removeValue(forKey: ObjectIdentifier(download))
        setStatus(t("browser.downloaded", ["f": dest?.lastPathComponent ?? ""]))
        if let dest { NSWorkspace.shared.activateFileViewerSelecting([dest]) }
    }
    func download(_ download: WKDownload, didFailWithError error: Error, resumeData: Data?) {
        downloadDest.removeValue(forKey: ObjectIdentifier(download))
        setStatus(t("browser.downloadFailed", ["msg": error.localizedDescription]))
    }
    private var downloadDest: [ObjectIdentifier: URL] = [:]

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
        switch event.charactersIgnoringModifiers?.lowercased() {
        case "f" where cmd: showFind(); return true
        case "l" where cmd: focusURL(); return true
        case "t" where cmd: newTab(nil, activate: true); return true
        case "w" where cmd && tabs.count > 1: closeTab(current); return true
        default: return super.performKeyEquivalent(with: event)
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

    func agentNavigate(_ urlString: String, newTab wantsNew: Bool) -> String {
        guard let url = BrowserTab.resolve(urlString) else { return "invalid url: \(urlString)" }
        if wantsNew { newTab(url, activate: true) } else { urlField.stringValue = url.absoluteString; load(url) }
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
                out.append("  [\(i)]\(i == current ? "*" : " ") \(other.title) \(other.urlString)")
            }
        }
        return out.joined(separator: "\n")
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
        layer?.backgroundColor = Theme.bg2.cgColor
        urlField.textColor = Theme.fg
        findField.textColor = Theme.fg
        emptyLabel.textColor = Theme.fgDim
        statusLabel.textColor = Theme.fgDim
        progress.layer?.backgroundColor = Theme.accent.cgColor
        findBar.layer?.backgroundColor = Theme.bg3.cgColor
        [backBtn, fwdBtn, stopBtn, captureBtn, externalBtn, inspectBtn, zoomInBtn, zoomOutBtn,
         findPrev, findNext, findDone].forEach { $0.contentTintColor = Theme.fgDim }
    }
    func applyScale() {
        urlField.font = UIScale.font(UIScale.body)
        findField.font = UIScale.font(UIScale.body)
        emptyLabel.font = UIScale.font(UIScale.small)
        statusLabel.font = UIScale.font(UIScale.caption)
    }
}
