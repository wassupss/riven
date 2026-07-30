import AppKit

// ---- persisted request model ------------------------------------------------
struct APIAuth: Codable {
    var type: String = "none"   // none | bearer | basic
    var token: String = ""
    var user: String = ""
    var pass: String = ""
}
struct APIRequestData: Codable {
    var method = "GET"
    var url = ""
    var params = ""
    var headers = ""
    var body = ""
    var auth = APIAuth()
    var name = ""       // saved-collection label
    var at: Double = 0  // epoch seconds (history ordering)
}

// JSON-backed persistence in the shared Settings store.
private enum APIStore {
    static func list(_ key: String) -> [APIRequestData] {
        let s = Settings.shared.string(key, "[]")
        return (try? JSONDecoder().decode([APIRequestData].self, from: Data(s.utf8))) ?? []
    }
    static func setList(_ key: String, _ v: [APIRequestData]) {
        if let d = try? JSONEncoder().encode(v), let s = String(data: d, encoding: .utf8) {
            Settings.shared.set(key, s)
        }
    }
    static func envs() -> [String: String] {
        let s = Settings.shared.string("api.environments", "{}")
        return (try? JSONDecoder().decode([String: String].self, from: Data(s.utf8))) ?? [:]
    }
    static func setEnvs(_ v: [String: String]) {
        if let d = try? JSONEncoder().encode(v), let s = String(data: d, encoding: .utf8) {
            Settings.shared.set("api.environments", s)
        }
    }
}

// A discovered local service (listening port + owner label).
private struct Service { let port: Int; let label: String }

// NSTextView with a gray placeholder drawn while empty (NSTextView has no native one).
final class HintTextView: NSTextView {
    var hint = "" { didSet { needsDisplay = true } }
    override func draw(_ dirtyRect: NSRect) {
        super.draw(dirtyRect)
        guard string.isEmpty, !hint.isEmpty else { return }
        let attrs: [NSAttributedString.Key: Any] = [
            .font: font ?? UIScale.font(12),
            .foregroundColor: Theme.fgDim.withAlphaComponent(0.55),
        ]
        (hint as NSString).draw(at: NSPoint(x: textContainerInset.width + 5, y: textContainerInset.height + 1),
                                withAttributes: attrs)
    }
}

// Postman-style key/value table (Params, Headers). Exposes a `string` property in
// the same "key: value\n…" shape the rest of the panel already uses, so it drops in
// wherever a text editor was. Always keeps one trailing empty row to add to.
final class KVEditor: NSView, Themable, Scalable, NSTextFieldDelegate {
    var onChange: (() -> Void)?
    var keyPlaceholder = "Key"; var valuePlaceholder = "Value"
    private let stack = FlippedStack()
    private let scroll = NSScrollView()
    private final class Row { let key = NSTextField(); let value = NSTextField(); let del = NSButton(); let box = NSView() }
    private var rows: [Row] = []

    override init(frame: NSRect) {
        super.init(frame: frame)
        stack.orientation = .vertical; stack.alignment = .leading; stack.spacing = 4
        stack.translatesAutoresizingMaskIntoConstraints = false
        scroll.documentView = stack; scroll.drawsBackground = false; scroll.hasVerticalScroller = true
        scroll.translatesAutoresizingMaskIntoConstraints = false
        addSubview(scroll)
        NSLayoutConstraint.activate([
            scroll.topAnchor.constraint(equalTo: topAnchor), scroll.bottomAnchor.constraint(equalTo: bottomAnchor),
            scroll.leadingAnchor.constraint(equalTo: leadingAnchor), scroll.trailingAnchor.constraint(equalTo: trailingAnchor),
            stack.topAnchor.constraint(equalTo: scroll.contentView.topAnchor),
            stack.leadingAnchor.constraint(equalTo: scroll.contentView.leadingAnchor),
            stack.widthAnchor.constraint(equalTo: scroll.widthAnchor),
        ])
        addRow()   // start with one empty row
        Theme.register(self); UIScale.register(self)
    }
    required init?(coder: NSCoder) { fatalError() }

    var string: String {
        get {
            rows.compactMap { r in
                let k = r.key.stringValue.trimmingCharacters(in: .whitespaces)
                guard !k.isEmpty else { return nil }
                return "\(k): \(r.value.stringValue.trimmingCharacters(in: .whitespaces))"
            }.joined(separator: "\n")
        }
        set {
            rows.forEach { $0.box.removeFromSuperview() }; rows = []
            for line in newValue.split(separator: "\n") {
                let s = line.trimmingCharacters(in: .whitespaces); if s.isEmpty { continue }
                let sep = [s.firstIndex(of: "="), s.firstIndex(of: ":")].compactMap { $0 }.min()
                let k = sep.map { String(s[..<$0]) } ?? s
                let v = sep.map { String(s[s.index(after: $0)...]) } ?? ""
                addRow(k.trimmingCharacters(in: .whitespaces), v.trimmingCharacters(in: .whitespaces))
            }
            addRow()   // trailing empty row
        }
    }

    private func field(_ tf: NSTextField, _ ph: String) {
        tf.placeholderString = ph; tf.font = UIScale.mono(11, .regular); tf.textColor = Theme.fg
        tf.backgroundColor = Theme.bg; tf.isBordered = false; tf.bezelStyle = .roundedBezel
        tf.translatesAutoresizingMaskIntoConstraints = false
        tf.delegate = self
        tf.target = self; tf.action = #selector(fieldEdited(_:))
    }
    @discardableResult private func addRow(_ k: String = "", _ v: String = "") -> Row {
        let r = Row()
        field(r.key, keyPlaceholder); r.key.stringValue = k
        field(r.value, valuePlaceholder); r.value.stringValue = v
        r.del.image = NSImage(systemSymbolName: "xmark.circle.fill", accessibilityDescription: nil)
        r.del.image?.isTemplate = true; r.del.imagePosition = .imageOnly; r.del.isBordered = false
        r.del.contentTintColor = Theme.fgDim; r.del.target = self; r.del.action = #selector(deleteRow(_:))
        r.del.translatesAutoresizingMaskIntoConstraints = false
        let h = NSStackView(views: [r.key, r.value, r.del]); h.orientation = .horizontal; h.spacing = 5
        h.distribution = .fill; h.translatesAutoresizingMaskIntoConstraints = false
        r.box.addSubview(h); r.box.translatesAutoresizingMaskIntoConstraints = false
        NSLayoutConstraint.activate([
            h.topAnchor.constraint(equalTo: r.box.topAnchor), h.bottomAnchor.constraint(equalTo: r.box.bottomAnchor),
            h.leadingAnchor.constraint(equalTo: r.box.leadingAnchor, constant: 2),
            h.trailingAnchor.constraint(equalTo: r.box.trailingAnchor, constant: -2),
            r.key.widthAnchor.constraint(equalTo: r.value.widthAnchor),   // key/value share width
            r.del.widthAnchor.constraint(equalToConstant: 18),
            r.box.heightAnchor.constraint(equalToConstant: 24),
        ])
        stack.addArrangedSubview(r.box)
        // Full-width rows. Guard the cross-view constraint: addArrangedSubview normally makes
        // r.box a subview of `stack` (shared ancestor), but a crash was recorded here
        // ("no common ancestor") — activating with no shared ancestor throws an NSException
        // that takes down the app. Only activate once the relationship is actually in place;
        // worst case a row is slightly misaligned instead of the whole app crashing.
        if r.box.superview === stack {
            r.box.widthAnchor.constraint(equalTo: stack.widthAnchor).isActive = true
        }
        rows.append(r)
        return r
    }
    @objc private func deleteRow(_ sender: NSButton) {
        guard let r = rows.first(where: { $0.del === sender }) else { return }
        r.box.removeFromSuperview(); rows.removeAll { $0 === r }
        if rows.isEmpty { addRow() }
        onChange?()
    }
    @objc private func fieldEdited(_ sender: NSTextField) {
        // typing in the last row spawns a new trailing empty row
        if let last = rows.last, sender === last.key || sender === last.value,
           !last.key.stringValue.isEmpty || !last.value.stringValue.isEmpty { addRow() }
        onChange?()
    }
    // NSTextField.action only fires on Enter/blur; observe live edits too.
    func controlTextDidChange(_ obj: Notification) { if let tf = obj.object as? NSTextField { fieldEdited(tf) } }

    func applyTheme() {
        for r in rows {
            for f in [r.key, r.value] { f.textColor = Theme.fg; f.backgroundColor = Theme.bg }
            r.del.contentTintColor = Theme.fgDim
        }
    }
    func applyScale() { for r in rows { r.key.font = UIScale.mono(11, .regular); r.value.font = UIScale.mono(11, .regular) } }
}

// Full-featured native REST client that docks like the other aux panels.
// Service auto-discovery (lsof + docker), Params/Auth/Headers/Body tabs with live
// count badges, response Body/Headers split, request history, saved collections,
// {{env}} variables and cURL import. URLSession under the hood; no dependencies.
final class APIClientPanel: NSView, Themable, Scalable, NSTextViewDelegate {
    // toolbar
    private let servicesBtn = NSButton()
    private let templatesBtn = NSButton()
    private let envBtn = NSButton()
    private let historyBtn = NSButton()
    private let savedBtn = NSButton()
    private let importBtn = NSButton()
    // request line
    private let methodDot = NSView()
    private let method = NSPopUpButton(frame: .zero, pullsDown: false)
    private let urlField = NSTextField()
    private let sendBtn = NSButton(title: "Send", target: nil, action: nil)
    // request tabs
    private let tabs = NSSegmentedControl(labels: ["Params", "Auth", "Headers", "Body"],
                                          trackingMode: .selectOne, target: nil, action: nil)
    private let paramsKV = KVEditor()
    private let headersKV = KVEditor()
    private let bodyView = HintTextView()
    private var bodyScroll: NSScrollView!
    // auth tab
    private let authBox = NSView()
    private let authType = NSPopUpButton(frame: .zero, pullsDown: false)
    private let tokenField = NSTextField()
    private let userField = NSTextField()
    private let passField = NSSecureTextField()
    // response
    private let split = NSSplitView()
    private let statusLabel = NSTextField(labelWithString: t("api.hint.send"))
    private let respTabs = NSSegmentedControl(labels: ["Body", "Headers"],
                                              trackingMode: .selectOne, target: nil, action: nil)
    private let responseView = NSTextView()
    private let copyBtn = NSButton()
    private var responseScroll: NSScrollView!
    private var respBody = ""
    private var respHeaders = ""

    private var task: URLSessionDataTask?
    private var envPopover: NSPopover?
    private var langObserver: NSObjectProtocol?
    deinit { if let o = langObserver { NotificationCenter.default.removeObserver(o) } }

    override init(frame: NSRect) {
        super.init(frame: frame)
        wantsLayer = true
        layer?.backgroundColor = Theme.bg2.cgColor

        // --- toolbar: services / env pickers + history / saved / import ---
        styleToolButton(servicesBtn, symbol: "bolt.horizontal.circle", title: " " + t("api.services"), action: #selector(showServices))
        styleToolButton(templatesBtn, symbol: "square.grid.2x2", title: " " + t("api.templates"), action: #selector(showTemplates))
        styleToolButton(envBtn, symbol: "globe", title: " " + t("api.env"), action: #selector(showEnvMenu))
        styleIconButton(historyBtn, symbol: "clock.arrow.circlepath", tip: t("api.history"), action: #selector(showHistory))
        styleIconButton(savedBtn, symbol: "star", tip: t("api.saved"), action: #selector(showSaved))
        styleIconButton(importBtn, symbol: "square.and.arrow.down", tip: t("api.importCurl"), action: #selector(importCurl))
        let spacer = NSView(); spacer.setContentHuggingPriority(.init(1), for: .horizontal)
        let toolbar = NSStackView(views: [servicesBtn, templatesBtn, envBtn, spacer, historyBtn, savedBtn, importBtn])
        toolbar.orientation = .horizontal; toolbar.spacing = 4
        toolbar.translatesAutoresizingMaskIntoConstraints = false
        refreshEnvTitle()

        // --- request line: method ▾ | URL | Send ---
        method.addItems(withTitles: ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"])
        method.font = UIScale.font(12)
        method.target = self; method.action = #selector(methodChanged)
        method.translatesAutoresizingMaskIntoConstraints = false
        methodDot.wantsLayer = true; methodDot.layer?.cornerRadius = 4
        methodDot.translatesAutoresizingMaskIntoConstraints = false
        urlField.placeholderString = "{{base_url}}/v1/…"
        urlField.stringValue = "http://localhost:3000/"
        urlField.font = UIScale.mono(12, .regular)
        urlField.bezelStyle = .roundedBezel
        urlField.target = self; urlField.action = #selector(send)
        urlField.translatesAutoresizingMaskIntoConstraints = false
        sendBtn.bezelStyle = .roundRect; sendBtn.keyEquivalent = "\r"
        sendBtn.font = UIScale.font(12, .medium)
        sendBtn.target = self; sendBtn.action = #selector(send)
        sendBtn.translatesAutoresizingMaskIntoConstraints = false

        // --- request tabs ---
        tabs.selectedSegment = 3
        tabs.segmentStyle = .rounded
        tabs.segmentDistribution = .fillEqually   // share width + truncate instead of clipping when narrow
        tabs.target = self; tabs.action = #selector(switchTab)
        tabs.translatesAutoresizingMaskIntoConstraints = false
        bodyScroll = editor(bodyView, mono: true, hint: t("api.hint.body"))
        paramsKV.keyPlaceholder = "Key"; paramsKV.valuePlaceholder = "Value"
        headersKV.keyPlaceholder = "Header"; headersKV.valuePlaceholder = "Value"
        paramsKV.onChange = { [weak self] in self?.refreshBadges() }
        headersKV.onChange = { [weak self] in self?.refreshBadges() }
        buildAuthBox()

        let reqBox = NSView()
        reqBox.addSubview(tabs)
        for v in [paramsKV, headersKV, bodyScroll!, authBox] { reqBox.addSubview(v) }
        NSLayoutConstraint.activate([
            tabs.topAnchor.constraint(equalTo: reqBox.topAnchor, constant: 6),
            tabs.leadingAnchor.constraint(equalTo: reqBox.leadingAnchor, constant: 8),
            tabs.trailingAnchor.constraint(equalTo: reqBox.trailingAnchor, constant: -8),
        ])
        for v in [paramsKV, headersKV, bodyScroll!, authBox] {
            v.translatesAutoresizingMaskIntoConstraints = false
            NSLayoutConstraint.activate([
                v.topAnchor.constraint(equalTo: tabs.bottomAnchor, constant: 6),
                v.leadingAnchor.constraint(equalTo: reqBox.leadingAnchor, constant: 8),
                v.trailingAnchor.constraint(equalTo: reqBox.trailingAnchor, constant: -8),
                v.bottomAnchor.constraint(equalTo: reqBox.bottomAnchor, constant: -8),
            ])
        }

        // --- response ---
        let respBox = NSView()
        statusLabel.font = UIScale.font(11, .medium)
        statusLabel.textColor = Theme.fgDim
        statusLabel.translatesAutoresizingMaskIntoConstraints = false
        respTabs.selectedSegment = 0
        respTabs.segmentStyle = .rounded
        respTabs.target = self; respTabs.action = #selector(switchRespTab)
        respTabs.translatesAutoresizingMaskIntoConstraints = false
        responseScroll = editor(responseView, mono: true, hint: "")
        responseView.isEditable = false
        styleIconButton(copyBtn, symbol: "doc.on.doc", tip: t("common.copy"), action: #selector(copyResponse))
        respBox.addSubview(statusLabel); respBox.addSubview(respTabs); respBox.addSubview(responseScroll); respBox.addSubview(copyBtn)
        NSLayoutConstraint.activate([
            statusLabel.topAnchor.constraint(equalTo: respBox.topAnchor, constant: 6),
            statusLabel.leadingAnchor.constraint(equalTo: respBox.leadingAnchor, constant: 10),
            respTabs.topAnchor.constraint(equalTo: statusLabel.bottomAnchor, constant: 6),
            respTabs.leadingAnchor.constraint(equalTo: respBox.leadingAnchor, constant: 8),
            copyBtn.centerYAnchor.constraint(equalTo: respTabs.centerYAnchor),
            copyBtn.trailingAnchor.constraint(equalTo: respBox.trailingAnchor, constant: -10),
            responseScroll.topAnchor.constraint(equalTo: respTabs.bottomAnchor, constant: 6),
            responseScroll.leadingAnchor.constraint(equalTo: respBox.leadingAnchor, constant: 8),
            responseScroll.trailingAnchor.constraint(equalTo: respBox.trailingAnchor, constant: -8),
            responseScroll.bottomAnchor.constraint(equalTo: respBox.bottomAnchor, constant: -8),
        ])

        split.isVertical = false; split.dividerStyle = .thin
        split.translatesAutoresizingMaskIntoConstraints = false
        split.addArrangedSubview(reqBox); split.addArrangedSubview(respBox)
        // Initial ~50/50 via a low-priority height ratio; user drags override it and
        // window resizes keep the proportion — no setPosition feedback loop.
        let reqRatio = reqBox.heightAnchor.constraint(equalTo: split.heightAnchor, multiplier: 0.5)
        reqRatio.priority = .defaultLow; reqRatio.isActive = true

        addSubview(toolbar); addSubview(methodDot); addSubview(method); addSubview(urlField); addSubview(sendBtn); addSubview(split)
        NSLayoutConstraint.activate([
            toolbar.leadingAnchor.constraint(equalTo: leadingAnchor, constant: 8),
            toolbar.trailingAnchor.constraint(equalTo: trailingAnchor, constant: -8),
            toolbar.topAnchor.constraint(equalTo: topAnchor, constant: 8),
            toolbar.heightAnchor.constraint(equalToConstant: 22),
            methodDot.leadingAnchor.constraint(equalTo: leadingAnchor, constant: 8),
            methodDot.centerYAnchor.constraint(equalTo: method.centerYAnchor),
            methodDot.widthAnchor.constraint(equalToConstant: 8), methodDot.heightAnchor.constraint(equalToConstant: 8),
            method.leadingAnchor.constraint(equalTo: methodDot.trailingAnchor, constant: 6),
            method.topAnchor.constraint(equalTo: toolbar.bottomAnchor, constant: 8),
            method.widthAnchor.constraint(equalToConstant: 84),
            urlField.leadingAnchor.constraint(equalTo: method.trailingAnchor, constant: 6),
            urlField.centerYAnchor.constraint(equalTo: method.centerYAnchor),
            urlField.trailingAnchor.constraint(equalTo: sendBtn.leadingAnchor, constant: -6),
            sendBtn.trailingAnchor.constraint(equalTo: trailingAnchor, constant: -8),
            sendBtn.centerYAnchor.constraint(equalTo: method.centerYAnchor),
            sendBtn.widthAnchor.constraint(equalToConstant: 60),
            split.leadingAnchor.constraint(equalTo: leadingAnchor),
            split.trailingAnchor.constraint(equalTo: trailingAnchor),
            split.topAnchor.constraint(equalTo: method.bottomAnchor, constant: 8),
            split.bottomAnchor.constraint(equalTo: bottomAnchor),
        ])
        switchTab(); refreshBadges(); updateMethodDot()
        Theme.register(self); UIScale.register(self)
        langObserver = NotificationCenter.default.addObserver(forName: .rivenLanguageChanged, object: nil, queue: .main) { [weak self] _ in self?.localize() }
    }
    required init?(coder: NSCoder) { fatalError() }

    func focusURL() { window?.makeFirstResponder(urlField) }

    // Re-apply localized chrome on a language switch (menus/prompts read t() fresh).
    private func localize() {
        servicesBtn.title = " " + t("api.services"); templatesBtn.title = " " + t("api.templates")
        historyBtn.toolTip = t("api.history"); savedBtn.toolTip = t("api.saved"); importBtn.toolTip = t("api.importCurl")
        bodyView.hint = t("api.hint.body")
        refreshEnvTitle()
        if task == nil, respBody.isEmpty { statusLabel.stringValue = t("api.hint.send") }
    }


    // MARK: - builders

    private func styleToolButton(_ b: NSButton, symbol: String, title: String, action: Selector) {
        b.image = NSImage(systemSymbolName: symbol, accessibilityDescription: nil)
        b.imagePosition = .imageLeading
        b.title = title
        b.font = UIScale.font(11)
        b.bezelStyle = .roundRect; b.controlSize = .small
        b.contentTintColor = Theme.fgDim
        b.target = self; b.action = action
        b.translatesAutoresizingMaskIntoConstraints = false
    }
    private func styleIconButton(_ b: NSButton, symbol: String, tip: String, action: Selector) {
        b.image = NSImage(systemSymbolName: symbol, accessibilityDescription: tip)
        b.image?.isTemplate = true; b.imagePosition = .imageOnly
        b.isBordered = false; b.contentTintColor = Theme.fgDim
        b.toolTip = tip
        b.target = self; b.action = action
        b.translatesAutoresizingMaskIntoConstraints = false
        b.widthAnchor.constraint(equalToConstant: 22).isActive = true
    }

    private func editor(_ tv: NSTextView, mono: Bool, hint: String) -> NSScrollView {
        tv.isRichText = false
        tv.font = mono ? UIScale.mono(12, .regular) : UIScale.font(12)
        tv.textColor = Theme.fg; tv.backgroundColor = Theme.bg; tv.drawsBackground = true
        tv.insertionPointColor = Theme.fg
        tv.isAutomaticQuoteSubstitutionEnabled = false
        tv.isAutomaticDashSubstitutionEnabled = false
        tv.isAutomaticSpellingCorrectionEnabled = false
        tv.textContainerInset = NSSize(width: 4, height: 4)
        tv.isVerticallyResizable = true; tv.isHorizontallyResizable = false
        tv.textContainer?.widthTracksTextView = true
        tv.autoresizingMask = [.width]
        tv.delegate = self
        if let h = tv as? HintTextView { h.hint = hint }
        let scroll = NSScrollView()
        scroll.hasVerticalScroller = true; scroll.drawsBackground = true
        scroll.backgroundColor = Theme.bg; scroll.borderType = .noBorder
        scroll.documentView = tv
        scroll.wantsLayer = true; scroll.layer?.cornerRadius = 5
        scroll.translatesAutoresizingMaskIntoConstraints = false
        return scroll
    }

    private func buildAuthBox() {
        authType.addItems(withTitles: ["None", "Bearer", "Basic"])
        authType.font = UIScale.font(12)
        authType.target = self; authType.action = #selector(authTypeChanged)
        authType.translatesAutoresizingMaskIntoConstraints = false
        for (f, ph) in [(tokenField, t("api.auth.token")), (userField, t("api.auth.user"))] {
            f.placeholderString = ph; f.font = UIScale.mono(12, .regular)
            f.bezelStyle = .roundedBezel; f.translatesAutoresizingMaskIntoConstraints = false
            f.target = self; f.action = #selector(authFieldChanged)
        }
        passField.placeholderString = t("api.auth.pass"); passField.font = UIScale.mono(12, .regular)
        passField.bezelStyle = .roundedBezel; passField.translatesAutoresizingMaskIntoConstraints = false
        passField.target = self; passField.action = #selector(authFieldChanged)
        let label = NSTextField(labelWithString: t("api.auth.label")); label.font = UIScale.font(11); label.textColor = Theme.fgDim
        label.translatesAutoresizingMaskIntoConstraints = false
        for v in [label, authType, tokenField, userField, passField] { authBox.addSubview(v) }
        NSLayoutConstraint.activate([
            label.topAnchor.constraint(equalTo: authBox.topAnchor, constant: 6),
            label.leadingAnchor.constraint(equalTo: authBox.leadingAnchor, constant: 2),
            authType.centerYAnchor.constraint(equalTo: label.centerYAnchor),
            authType.leadingAnchor.constraint(equalTo: label.trailingAnchor, constant: 8),
            authType.widthAnchor.constraint(equalToConstant: 110),
            tokenField.topAnchor.constraint(equalTo: label.bottomAnchor, constant: 8),
            tokenField.leadingAnchor.constraint(equalTo: authBox.leadingAnchor, constant: 2),
            tokenField.trailingAnchor.constraint(equalTo: authBox.trailingAnchor, constant: -2),
            userField.topAnchor.constraint(equalTo: label.bottomAnchor, constant: 8),
            userField.leadingAnchor.constraint(equalTo: authBox.leadingAnchor, constant: 2),
            userField.trailingAnchor.constraint(equalTo: authBox.trailingAnchor, constant: -2),
            passField.topAnchor.constraint(equalTo: userField.bottomAnchor, constant: 6),
            passField.leadingAnchor.constraint(equalTo: authBox.leadingAnchor, constant: 2),
            passField.trailingAnchor.constraint(equalTo: authBox.trailingAnchor, constant: -2),
        ])
        authTypeChanged()
    }

    // MARK: - tabs / badges

    // Postman-style method color: GET green, POST orange, PUT blue, PATCH purple, DELETE red.
    @objc private func methodChanged() { updateMethodDot() }
    private func updateMethodDot() {
        let c: NSColor
        switch method.titleOfSelectedItem {
        case "GET": c = Theme.hex("#4caf50")
        case "POST": c = Theme.hex("#fb8c00")
        case "PUT": c = Theme.hex("#42a5f5")
        case "PATCH": c = Theme.hex("#ab47bc")
        case "DELETE": c = Theme.hex("#ef5350")
        default: c = Theme.fgDim
        }
        methodDot.layer?.backgroundColor = c.cgColor
    }
    @objc private func switchTab() {
        let sel = tabs.selectedSegment
        paramsKV.isHidden = sel != 0
        authBox.isHidden = sel != 1
        headersKV.isHidden = sel != 2
        bodyScroll.isHidden = sel != 3
    }
    @objc private func switchRespTab() {
        responseView.string = respTabs.selectedSegment == 0 ? respBody : respHeaders
    }
    @objc private func copyResponse() {
        let text = responseView.string
        guard !text.isEmpty else { NSSound.beep(); return }
        NSPasteboard.general.clearContents(); NSPasteboard.general.setString(text, forType: .string)
        copyBtn.image = NSImage(systemSymbolName: "checkmark", accessibilityDescription: nil); copyBtn.image?.isTemplate = true
        DispatchQueue.main.asyncAfter(deadline: .now() + 1.0) { [weak self] in
            self?.copyBtn.image = NSImage(systemSymbolName: "doc.on.doc", accessibilityDescription: nil)
            self?.copyBtn.image?.isTemplate = true
        }
    }
    @objc private func authTypeChanged() {
        let t = authType.titleOfSelectedItem ?? "None"
        tokenField.isHidden = t != "Bearer"
        userField.isHidden = t != "Basic"; passField.isHidden = t != "Basic"
        refreshBadges()
    }
    @objc private func authFieldChanged() { refreshBadges() }

    func textDidChange(_ notification: Notification) { refreshBadges() }

    // Live count badges on the tab labels so it's obvious what's populated + used.
    private func refreshBadges() {
        let p = pairs(paramsKV.string).count
        let h = pairs(headersKV.string).count
        let bodyOn = !bodyView.string.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
        let authOn = (authType.titleOfSelectedItem ?? "None") != "None"
        tabs.setLabel(p > 0 ? "Params \(p)" : "Params", forSegment: 0)
        tabs.setLabel(authOn ? "Auth ●" : "Auth", forSegment: 1)
        tabs.setLabel(h > 0 ? "Headers \(h)" : "Headers", forSegment: 2)
        tabs.setLabel(bodyOn ? "Body ✓" : "Body", forSegment: 3)
    }

    // MARK: - env

    private func activeEnvName() -> String { Settings.shared.string("api.activeEnv", "") }
    private func refreshEnvTitle() {
        let n = activeEnvName()
        envBtn.title = n.isEmpty ? " " + t("api.env") : " " + n
    }
    // {{key}} → active environment value.
    private func subst(_ s: String) -> String {
        let env = pairsDict(APIStore.envs()[activeEnvName()] ?? "")
        guard !env.isEmpty, s.contains("{{") else { return s }
        var out = s
        for (k, v) in env { out = out.replacingOccurrences(of: "{{\(k)}}", with: v) }
        return out
    }

    // MARK: - parsing helpers

    private func pairs(_ text: String) -> [(String, String)] {
        text.split(separator: "\n").compactMap { raw in
            let line = raw.trimmingCharacters(in: .whitespaces)
            if line.isEmpty || line.hasPrefix("#") { return nil }
            let idx = [line.firstIndex(of: "="), line.firstIndex(of: ":")].compactMap { $0 }.min()
            guard let i = idx else { return (line, "") }
            let k = line[..<i].trimmingCharacters(in: .whitespaces)
            let v = line[line.index(after: i)...].trimmingCharacters(in: .whitespaces)
            return k.isEmpty ? nil : (k, v)
        }
    }
    private func pairsDict(_ text: String) -> [String: String] {
        var d: [String: String] = [:]; for (k, v) in pairs(text) { d[k] = v }; return d
    }

    // MARK: - send

    @objc private func send() {
        task?.cancel()
        var raw = subst(urlField.stringValue).trimmingCharacters(in: .whitespaces)
        if raw.isEmpty { NSSound.beep(); return }
        if !raw.contains("://") { raw = "http://" + raw }
        guard var comps = URLComponents(string: raw) else { setStatus(t("api.status.badURL"), bad: true); return }
        let params = pairs(subst(paramsKV.string))
        if !params.isEmpty {
            var items = comps.queryItems ?? []
            items.append(contentsOf: params.map { URLQueryItem(name: $0.0, value: $0.1) })
            comps.queryItems = items
        }
        guard let url = comps.url else { setStatus(t("api.status.badURL"), bad: true); return }

        var req = URLRequest(url: url)
        req.httpMethod = method.titleOfSelectedItem ?? "GET"
        var setKeys = Set<String>()
        for (k, v) in pairs(subst(headersKV.string)) {
            req.setValue(v, forHTTPHeaderField: k); setKeys.insert(k.lowercased())
        }
        // auth → Authorization (unless the user already set one explicitly)
        if !setKeys.contains("authorization") {
            switch authType.titleOfSelectedItem {
            case "Bearer":
                let tok = subst(tokenField.stringValue)
                if !tok.isEmpty { req.setValue("Bearer \(tok)", forHTTPHeaderField: "Authorization") }
            case "Basic":
                let creds = "\(subst(userField.stringValue)):\(subst(passField.stringValue))"
                if let d = creds.data(using: .utf8) {
                    req.setValue("Basic \(d.base64EncodedString())", forHTTPHeaderField: "Authorization")
                }
            default: break
            }
        }
        let body = subst(bodyView.string).trimmingCharacters(in: .whitespacesAndNewlines)
        if !["GET", "HEAD"].contains(req.httpMethod ?? "") && !body.isEmpty {
            req.httpBody = body.data(using: .utf8)
            if !setKeys.contains("content-type"), body.hasPrefix("{") || body.hasPrefix("[") {
                req.setValue("application/json", forHTTPHeaderField: "Content-Type")
            }
        }

        recordHistory()
        setStatus(t("api.status.sending"), bad: false)
        responseView.string = ""; respBody = ""; respHeaders = ""
        sendBtn.isEnabled = false
        let started = ProcessInfo.processInfo.systemUptime
        task = URLSession.shared.dataTask(with: req) { [weak self] data, resp, err in
            let ms = Int((ProcessInfo.processInfo.systemUptime - started) * 1000)
            DispatchQueue.main.async {
                guard let self else { return }
                self.sendBtn.isEnabled = true
                if let err = err as NSError?, err.code != NSURLErrorCancelled {
                    self.setStatus(t("api.status.failed", ["ms": ms]), bad: true)
                    self.respBody = err.localizedDescription; self.responseView.string = self.respBody
                    return
                }
                guard let http = resp as? HTTPURLResponse else { return }
                self.showResponse(http, data ?? Data(), ms: ms)
            }
        }
        task?.resume()
    }

    private func showResponse(_ http: HTTPURLResponse, _ data: Data, ms: Int) {
        let ok = (200..<400).contains(http.statusCode)
        setStatus("\(http.statusCode) \(reason(http.statusCode)) · \(ms)ms · \(byteSize(data.count))", bad: !ok)
        var text = String(data: data, encoding: .utf8) ?? "<\(data.count) bytes binary>"
        if let obj = try? JSONSerialization.jsonObject(with: data),
           let pretty = try? JSONSerialization.data(withJSONObject: obj,
                            options: [.prettyPrinted, .sortedKeys, .withoutEscapingSlashes]),
           let s = String(data: pretty, encoding: .utf8) { text = s }
        respBody = text
        respHeaders = http.allHeaderFields
            .map { "\($0.key): \($0.value)" }.sorted().joined(separator: "\n")
        responseView.string = respTabs.selectedSegment == 0 ? respBody : respHeaders
    }

    private func setStatus(_ s: String, bad: Bool) {
        statusLabel.stringValue = s
        statusLabel.textColor = bad ? Theme.hex("#ef5350") : Theme.fgDim
    }
    private func reason(_ code: Int) -> String {
        let m: [Int: String] = [200: "OK", 201: "Created", 202: "Accepted", 204: "No Content",
            301: "Moved Permanently", 302: "Found", 304: "Not Modified", 307: "Temporary Redirect",
            400: "Bad Request", 401: "Unauthorized", 403: "Forbidden", 404: "Not Found",
            405: "Method Not Allowed", 409: "Conflict", 422: "Unprocessable", 429: "Too Many Requests",
            500: "Server Error", 502: "Bad Gateway", 503: "Service Unavailable"]
        return m[code] ?? HTTPURLResponse.localizedString(forStatusCode: code).capitalized
    }
    private func byteSize(_ n: Int) -> String {
        if n < 1024 { return "\(n)B" }
        if n < 1024 * 1024 { return String(format: "%.1fKB", Double(n) / 1024) }
        return String(format: "%.1fMB", Double(n) / (1024 * 1024))
    }

    // MARK: - snapshot / load

    private func snapshot() -> APIRequestData {
        APIRequestData(method: method.titleOfSelectedItem ?? "GET", url: urlField.stringValue,
                       params: paramsKV.string, headers: headersKV.string, body: bodyView.string,
                       auth: APIAuth(type: (authType.titleOfSelectedItem ?? "None").lowercased(),
                                     token: tokenField.stringValue, user: userField.stringValue, pass: passField.stringValue),
                       at: Date().timeIntervalSince1970)
    }
    // Programmatic entry for the native chat's riven_api_request tool: fill the fields and fire.
    func run(method m: String, url: String, headers: String = "", body: String = "") {
        var r = APIRequestData(); r.method = m.uppercased(); r.url = url; r.headers = headers; r.body = body
        load(r)
        send()
    }
    private func load(_ r: APIRequestData) {
        method.selectItem(withTitle: r.method)
        urlField.stringValue = r.url
        paramsKV.string = r.params; headersKV.string = r.headers; bodyView.string = r.body
        authType.selectItem(withTitle: r.auth.type.capitalized == "None" ? "None" : r.auth.type.capitalized)
        tokenField.stringValue = r.auth.token; userField.stringValue = r.auth.user; passField.stringValue = r.auth.pass
        authTypeChanged(); refreshBadges(); updateMethodDot()
    }

    private func recordHistory() {
        var h = APIStore.list("api.history")
        let snap = snapshot()
        h.removeAll { $0.method == snap.method && $0.url == snap.url && $0.body == snap.body }
        h.insert(snap, at: 0)
        if h.count > 40 { h = Array(h.prefix(40)) }
        APIStore.setList("api.history", h)
    }

    // MARK: - menus

    private func popMenu(_ menu: NSMenu, under b: NSButton) {
        menu.popUp(positioning: nil, at: NSPoint(x: 0, y: b.bounds.height + 4), in: b)
    }

    @objc private func showHistory() {
        let menu = NSMenu()
        let h = APIStore.list("api.history")
        if h.isEmpty { menu.addItem(disabled(t("api.history.empty"))) }
        for (i, r) in h.enumerated() {
            let it = NSMenuItem(title: "\(r.method)  \(short(r.url))", action: #selector(pickHistory(_:)), keyEquivalent: "")
            it.target = self; it.tag = i; menu.addItem(it)
        }
        popMenu(menu, under: historyBtn)
    }
    @objc private func pickHistory(_ s: NSMenuItem) {
        let h = APIStore.list("api.history"); guard s.tag < h.count else { return }; load(h[s.tag])
    }

    @objc private func showSaved() {
        let menu = NSMenu()
        let item = NSMenuItem(title: t("api.saveCurrent"), action: #selector(saveCurrent), keyEquivalent: "")
        item.target = self; menu.addItem(item); menu.addItem(.separator())
        let saved = APIStore.list("api.collections")
        if saved.isEmpty { menu.addItem(disabled(t("api.saved.empty"))) }
        for (i, r) in saved.enumerated() {
            let label = r.name.isEmpty ? "\(r.method) \(short(r.url))" : r.name
            let it = NSMenuItem(title: label, action: #selector(pickSaved(_:)), keyEquivalent: "")
            it.target = self; it.tag = i
            let del = NSMenuItem(title: t("common.delete"), action: #selector(deleteSaved(_:)), keyEquivalent: "")
            del.target = self; del.tag = i
            let sub = NSMenu(); sub.addItem(del); it.submenu = sub
            menu.addItem(it)
        }
        popMenu(menu, under: savedBtn)
    }
    @objc private func saveCurrent() {
        let name = prompt(title: t("api.save.title"), message: t("api.save.msg"), initial: short(urlField.stringValue))
        guard let name, !name.isEmpty else { return }
        var saved = APIStore.list("api.collections")
        var snap = snapshot(); snap.name = name
        saved.insert(snap, at: 0); APIStore.setList("api.collections", saved)
    }
    @objc private func pickSaved(_ s: NSMenuItem) {
        let saved = APIStore.list("api.collections"); guard s.tag < saved.count else { return }; load(saved[s.tag])
    }
    @objc private func deleteSaved(_ s: NSMenuItem) {
        var saved = APIStore.list("api.collections"); guard s.tag < saved.count else { return }
        saved.remove(at: s.tag); APIStore.setList("api.collections", saved)
    }

    // MARK: - templates

    private struct Template {
        let name: String
        var method = "GET"
        var headers = ""
        var body = ""
        var auth = APIAuth()
        var focus = 3   // request tab to reveal after applying (0=Params 1=Auth 2=Headers 3=Body)
    }
    private let jsonBody = "{\n  \n}"
    private var templates: [Template] {
        [
            Template(name: "GET · JSON 응답", method: "GET", headers: "Accept: application/json", focus: 2),
            Template(name: "POST · JSON 본문", method: "POST", headers: "Content-Type: application/json", body: jsonBody),
            Template(name: "PUT · JSON 본문", method: "PUT", headers: "Content-Type: application/json", body: jsonBody),
            Template(name: "PATCH · JSON 본문", method: "PATCH", headers: "Content-Type: application/json", body: jsonBody),
            Template(name: "DELETE 요청", method: "DELETE", focus: 2),
            Template(name: "폼 (x-www-form-urlencoded)", method: "POST",
                     headers: "Content-Type: application/x-www-form-urlencoded", body: "key=value&key2=value2"),
            Template(name: "멀티파트 폼 업로드", method: "POST",
                     headers: "Content-Type: multipart/form-data", body: ""),
            Template(name: "GraphQL 쿼리", method: "POST", headers: "Content-Type: application/json",
                     body: "{\n  \"query\": \"query {\\n  \\n}\",\n  \"variables\": {}\n}"),
            Template(name: "Bearer 토큰 인증", method: "GET", auth: APIAuth(type: "bearer"), focus: 1),
            Template(name: "Basic 인증", method: "GET", auth: APIAuth(type: "basic"), focus: 1),
        ]
    }
    @objc private func showTemplates() {
        let menu = NSMenu()
        for (i, tpl) in templates.enumerated() {
            let it = NSMenuItem(title: tpl.name, action: #selector(pickTemplate(_:)), keyEquivalent: "")
            it.target = self; it.tag = i; menu.addItem(it)
        }
        popMenu(menu, under: templatesBtn)
    }
    // Apply a template: set the method, MERGE its headers (never clobber ones you set),
    // fill an empty body with the skeleton, and set auth. URL / params are preserved.
    @objc private func pickTemplate(_ s: NSMenuItem) {
        guard s.tag < templates.count else { return }
        let tpl = templates[s.tag]
        method.selectItem(withTitle: tpl.method)
        if !tpl.headers.isEmpty {
            var lines = headersKV.string.split(separator: "\n", omittingEmptySubsequences: false).map(String.init)
            let existing = Set(pairs(headersKV.string).map { $0.0.lowercased() })
            for h in tpl.headers.split(separator: "\n").map(String.init) {
                let key = h.split(separator: ":").first.map { $0.trimmingCharacters(in: .whitespaces).lowercased() } ?? ""
                if !existing.contains(key) { lines.append(h) }
            }
            headersKV.string = lines.filter { !$0.trimmingCharacters(in: .whitespaces).isEmpty }.joined(separator: "\n")
        }
        if !tpl.body.isEmpty, bodyView.string.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            bodyView.string = tpl.body
        }
        if tpl.auth.type != "none" {
            authType.selectItem(withTitle: tpl.auth.type.capitalized); authTypeChanged()
        }
        tabs.selectedSegment = tpl.focus; switchTab(); refreshBadges(); updateMethodDot()
    }

    // MARK: - environments

    @objc private func showEnvMenu() {
        let menu = NSMenu()
        let none = NSMenuItem(title: t("api.env.none"), action: #selector(pickEnv(_:)), keyEquivalent: "")
        none.target = self; none.representedObject = ""; none.state = activeEnvName().isEmpty ? .on : .off
        menu.addItem(none)
        for name in APIStore.envs().keys.sorted() {
            let it = NSMenuItem(title: name, action: #selector(pickEnv(_:)), keyEquivalent: "")
            it.target = self; it.representedObject = name; it.state = name == activeEnvName() ? .on : .off
            menu.addItem(it)
        }
        menu.addItem(.separator())
        let edit = NSMenuItem(title: t("api.env.edit"), action: #selector(editEnv), keyEquivalent: "")
        edit.target = self; menu.addItem(edit)
        popMenu(menu, under: envBtn)
    }
    @objc private func pickEnv(_ s: NSMenuItem) {
        Settings.shared.set("api.activeEnv", (s.representedObject as? String) ?? ""); refreshEnvTitle()
    }
    @objc private func editEnv() {
        let name = prompt(title: t("api.env.promptTitle"), message: t("api.env.promptMsg"), initial: activeEnvName())
        guard let name, !name.isEmpty else { return }
        // popover with a key=value editor for this env
        let vc = NSViewController(); let root = NSView(frame: NSRect(x: 0, y: 0, width: 320, height: 220))
        let tv = NSTextView(frame: .zero)
        _ = editorStyle(tv)
        tv.string = APIStore.envs()[name] ?? "base_url=http://localhost:3000"
        let sc = NSScrollView(frame: NSRect(x: 10, y: 40, width: 300, height: 168))
        sc.hasVerticalScroller = true; sc.documentView = tv; sc.borderType = .bezelBorder
        let hint = NSTextField(labelWithString: t("api.env.hint"))
        hint.font = UIScale.font(10); hint.textColor = Theme.fgDim
        hint.frame = NSRect(x: 10, y: 12, width: 230, height: 14)
        let title = NSTextField(labelWithString: t("api.env.varsTitle", ["name": name]))
        title.font = UIScale.font(12, .semibold); title.frame = NSRect(x: 10, y: 194, width: 300, height: 18)
        let save = NSButton(title: t("common.save"), target: self, action: #selector(closeEnvPopover))
        save.bezelStyle = .roundRect; save.frame = NSRect(x: 250, y: 8, width: 60, height: 26); save.keyEquivalent = "\r"
        root.addSubview(title); root.addSubview(sc); root.addSubview(hint); root.addSubview(save)
        vc.view = root
        envEditTarget = (name, tv)
        let pop = NSPopover(); pop.contentViewController = vc; pop.behavior = .transient
        envPopover = pop
        pop.show(relativeTo: envBtn.bounds, of: envBtn, preferredEdge: .maxY)
    }
    private var envEditTarget: (name: String, tv: NSTextView)?
    @objc private func closeEnvPopover() {
        if let (name, tv) = envEditTarget {
            var e = APIStore.envs(); e[name] = tv.string; APIStore.setEnvs(e)
            Settings.shared.set("api.activeEnv", name); refreshEnvTitle()
        }
        envPopover?.close(); envPopover = nil; envEditTarget = nil
    }
    @discardableResult private func editorStyle(_ tv: NSTextView) -> NSTextView {
        tv.isRichText = false; tv.font = UIScale.mono(12, .regular)
        tv.isVerticallyResizable = true; tv.isHorizontallyResizable = false
        tv.autoresizingMask = [.width]; tv.textContainer?.widthTracksTextView = true
        tv.isAutomaticQuoteSubstitutionEnabled = false
        return tv
    }

    // MARK: - service discovery

    @objc private func showServices() {
        servicesBtn.title = " " + t("api.scanning")
        DispatchQueue.global(qos: .userInitiated).async { [weak self] in
            let svcs = self?.scanServices() ?? []
            DispatchQueue.main.async { self?.presentServices(svcs) }
        }
    }
    private func presentServices(_ svcs: [Service]) {
        refreshEnvTitle(); servicesBtn.title = " " + t("api.services")
        let menu = NSMenu()
        if svcs.isEmpty { menu.addItem(disabled(t("api.services.empty"))) }
        for s in svcs {
            let it = NSMenuItem(title: "  :\(s.port)   \(s.label)", action: #selector(pickService(_:)), keyEquivalent: "")
            it.target = self; it.tag = s.port; menu.addItem(it)
        }
        popMenu(menu, under: servicesBtn)
    }
    @objc private func pickService(_ s: NSMenuItem) {
        var path = "/"
        if let comps = URLComponents(string: subst(urlField.stringValue)), !comps.path.isEmpty { path = comps.path }
        urlField.stringValue = "http://localhost:\(s.tag)\(path)"
    }

    // lsof LISTEN ports + owning process, enriched with docker container names.
    private func scanServices() -> [Service] {
        var byPort: [Int: String] = [:]
        if let out = run("/usr/sbin/lsof", ["-nP", "-iTCP", "-sTCP:LISTEN"]) {
            for line in out.split(separator: "\n").dropFirst() {
                let cols = line.split(separator: " ", omittingEmptySubsequences: true)
                guard let cmd = cols.first,
                      let r = line.range(of: #":(\d+) \(LISTEN\)"#, options: .regularExpression) else { continue }
                let port = Int(line[r].dropFirst().prefix { $0.isNumber }) ?? 0
                guard port > 0, port < 65000 else { continue }
                if byPort[port] == nil { byPort[port] = String(cmd) }
            }
        }
        let dockerNames = dockerPortNames()
        let services = byPort.map { (port, cmd) -> Service in
            if let name = dockerNames[port] { return Service(port: port, label: "docker · \(name)") }
            let c = cmd.hasPrefix("com.docker") ? "docker" : cmd
            return Service(port: port, label: c)
        }
        return services.sorted { $0.port < $1.port }
    }
    // host-port → container name, from `docker ps` (best effort; skipped if docker absent).
    private func dockerPortNames() -> [Int: String] {
        let paths = ["/usr/local/bin/docker", "/opt/homebrew/bin/docker", "/usr/bin/docker"]
        guard let docker = paths.first(where: { FileManager.default.isExecutableFile(atPath: $0) }),
              let out = run(docker, ["ps", "--format", "{{.Names}}\t{{.Ports}}"]) else { return [:] }
        var map: [Int: String] = [:]
        for line in out.split(separator: "\n") {
            let parts = line.split(separator: "\t", maxSplits: 1)
            guard parts.count == 2 else { continue }
            let name = String(parts[0])
            // "0.0.0.0:15432->5432/tcp, [::]:15432->..." → capture host ports before "->"
            for m in matches(#"(\d+)->"#, in: String(parts[1])) { if let p = Int(m) { map[p] = name } }
        }
        return map
    }

    // MARK: - cURL import

    @objc private func importCurl() {
        guard let s = NSPasteboard.general.string(forType: .string), s.contains("curl") else {
            setStatus(t("api.curl.none"), bad: true); return
        }
        guard let r = parseCurl(s) else { setStatus(t("api.curl.parseFail"), bad: true); return }
        load(r); setStatus(t("api.curl.imported"), bad: false)
    }
    private func parseCurl(_ s: String) -> APIRequestData? {
        let toks = tokenizeShell(s)
        guard toks.first == "curl" || toks.contains("curl") else { return nil }
        var r = APIRequestData()
        var headerLines: [String] = []; var i = 0
        let t = Array(toks.drop { $0 != "curl" }.dropFirst())
        while i < t.count {
            let a = t[i]
            switch a {
            case "-X", "--request": i += 1; if i < t.count { r.method = t[i].uppercased() }
            case "-H", "--header": i += 1; if i < t.count { headerLines.append(t[i]) }
            case "-d", "--data", "--data-raw", "--data-binary", "--data-urlencode":
                i += 1; if i < t.count { r.body = t[i]; if r.method == "GET" { r.method = "POST" } }
            case "-u", "--user":
                i += 1; if i < t.count { let p = t[i].split(separator: ":", maxSplits: 1)
                    r.auth = APIAuth(type: "basic", token: "", user: String(p.first ?? ""), pass: p.count > 1 ? String(p[1]) : "") }
            case "--url": i += 1; if i < t.count { r.url = t[i] }
            default: if a.hasPrefix("http://") || a.hasPrefix("https://") { r.url = a }
            }
            i += 1
        }
        r.headers = headerLines.joined(separator: "\n")
        return r.url.isEmpty ? nil : r
    }

    // MARK: - small utils

    private func run(_ launch: String, _ args: [String]) -> String? {
        let p = Process(); p.launchPath = launch; p.arguments = args
        let pipe = Pipe(); p.standardOutput = pipe; p.standardError = FileHandle.nullDevice
        guard (try? p.run()) != nil else { return nil }
        let data = pipe.fileHandleForReading.readDataToEndOfFile(); p.waitUntilExit()
        return String(data: data, encoding: .utf8)
    }
    private func matches(_ pattern: String, in s: String) -> [String] {
        guard let re = try? NSRegularExpression(pattern: pattern) else { return [] }
        return re.matches(in: s, range: NSRange(s.startIndex..., in: s)).compactMap {
            Range($0.range(at: 1), in: s).map { String(s[$0]) }
        }
    }
    // shell-ish tokenizer honoring ' and " quotes and backslash-newline continuations.
    private func tokenizeShell(_ s: String) -> [String] {
        var toks: [String] = []; var cur = ""; var quote: Character?; var has = false
        var it = s.makeIterator()
        while let c = it.next() {
            if let q = quote {
                if c == q { quote = nil } else { cur.append(c); has = true }
            } else if c == "'" || c == "\"" { quote = c; has = true
            } else if c == "\\" { if let n = it.next(), n != "\n" { cur.append(n); has = true }
            } else if c == " " || c == "\n" || c == "\t" {
                if has { toks.append(cur); cur = ""; has = false }
            } else { cur.append(c); has = true }
        }
        if has { toks.append(cur) }
        return toks
    }
    private func short(_ s: String) -> String { s.count > 42 ? String(s.prefix(40)) + "…" : s }
    private func disabled(_ t: String) -> NSMenuItem { let i = NSMenuItem(title: t, action: nil, keyEquivalent: ""); i.isEnabled = false; return i }
    private func prompt(title: String, message: String, initial: String) -> String? {
        let a = NSAlert(); a.messageText = title; a.informativeText = message
        a.addButton(withTitle: t("common.confirm")); a.addButton(withTitle: t("common.cancel"))
        let tf = NSTextField(frame: NSRect(x: 0, y: 0, width: 240, height: 24)); tf.stringValue = initial
        a.accessoryView = tf; a.window.initialFirstResponder = tf
        return a.runModal() == .alertFirstButtonReturn ? tf.stringValue : nil
    }

    func applyTheme() {
        layer?.backgroundColor = Theme.bg2.cgColor
        urlField.textColor = Theme.fg
        for tv in [bodyView, responseView] {
            tv.textColor = Theme.fg; tv.backgroundColor = Theme.bg; tv.insertionPointColor = Theme.fg
        }
        for s in [bodyScroll, responseScroll] { s?.backgroundColor = Theme.bg }
        for b in [servicesBtn, templatesBtn, envBtn, historyBtn, savedBtn, importBtn, copyBtn] { b.contentTintColor = Theme.fgDim }
    }
    func applyScale() {
        method.font = UIScale.font(12); urlField.font = UIScale.mono(12, .regular); sendBtn.font = UIScale.font(12, .medium)
        tabs.font = UIScale.font(11); respTabs.font = UIScale.font(11); statusLabel.font = UIScale.font(11, .medium)
        authType.font = UIScale.font(12)
        for f in [tokenField, userField, passField] { f.font = UIScale.mono(12, .regular) }
        bodyView.font = UIScale.mono(12); responseView.font = UIScale.mono(12)
        for b in [servicesBtn, templatesBtn, envBtn] { b.font = UIScale.font(11) }
        refreshBadges()
    }
}
