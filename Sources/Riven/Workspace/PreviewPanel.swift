import AppKit
import WebKit

// Live preview sidebar panel — a native port of riven's PreviewPanel.tsx. A URL
// bar over a WKWebView, for previewing a local dev server. (riven's capture-to-
// Claude button depends on the agent contextBus, which isn't in the native app
// yet, so it's omitted rather than stubbed.)
final class PreviewPanel: NSView, Themable, WKScriptMessageHandler {
    var onFocused: (() -> Void)?   // page interaction → activate this dock group
    func userContentController(_ u: WKUserContentController, didReceive m: WKScriptMessage) {
        if m.name == "prevfocus" { onFocused?() }
    }
    private let urlField = NSTextField()
    private let openBtn = NSButton(title: "열기", target: nil, action: nil)
    private let captureBtn = NSButton()
    private let reloadBtn = NSButton()
    private let externalBtn = NSButton()
    private var web: WKWebView!
    private let emptyLabel = NSTextField(labelWithString: "미리볼 URL을 입력하세요")
    private var loadedURL: String?
    var onCapture: ((String) -> Void)?   // saved PNG path → send to the running agent

    override init(frame: NSRect) {
        super.init(frame: frame)
        wantsLayer = true
        layer?.backgroundColor = Theme.bg2.cgColor

        urlField.stringValue = "http://localhost:3000"
        urlField.placeholderString = "http://localhost:3000"
        urlField.font = .systemFont(ofSize: 12)
        urlField.bezelStyle = .roundedBezel
        urlField.target = self; urlField.action = #selector(openURL)
        urlField.translatesAutoresizingMaskIntoConstraints = false

        openBtn.target = self; openBtn.action = #selector(openURL)
        openBtn.bezelStyle = .roundRect; openBtn.controlSize = .small
        openBtn.font = .systemFont(ofSize: 11)
        openBtn.translatesAutoresizingMaskIntoConstraints = false

        // Capture the current view → PNG → send its path to the running agent (riven's
        // capture-to-Claude / contextBus.sendScreenshot).
        captureBtn.image = NSImage(systemSymbolName: "camera", accessibilityDescription: t("preview.capture"))
        captureBtn.image?.isTemplate = true; captureBtn.imagePosition = .imageOnly
        captureBtn.isBordered = false; captureBtn.contentTintColor = Theme.fgDim
        captureBtn.toolTip = t("preview.captureTitle")
        captureBtn.target = self; captureBtn.action = #selector(captureNow)
        captureBtn.translatesAutoresizingMaskIntoConstraints = false

        // Preview renders with WebKit (Safari's engine). Enable the Web Inspector so
        // right-click → "요소 정보 검사" opens dev tools.
        let cfg = WKWebViewConfiguration()
        cfg.preferences.setValue(true, forKey: "developerExtrasEnabled")
        // Interacting with the page (not just the tab) must focus this dock group — the
        // WKWebView swallows AppKit mouse events, so a tiny injected listener reports it.
        cfg.userContentController.add(self, name: "prevfocus")
        cfg.userContentController.addUserScript(WKUserScript(
            source: "document.addEventListener('mousedown',function(){window.webkit.messageHandlers.prevfocus.postMessage(1)},true);",
            injectionTime: .atDocumentStart, forMainFrameOnly: false))
        web = WKWebView(frame: .zero, configuration: cfg)
        // macOS 13.3+: this is what actually enables the Web Inspector (right-click →
        // "요소 정보 검사"). The older developerExtrasEnabled pref alone doesn't.
        if #available(macOS 13.3, *) { web.isInspectable = true }
        web.translatesAutoresizingMaskIntoConstraints = false
        web.isHidden = true

        // Reload + open-in-external-browser buttons (WebKit can't switch engines; this
        // opens the URL in the system's real browser — Chrome/Safari — for full dev tools).
        reloadBtn.image = NSImage(systemSymbolName: "arrow.clockwise", accessibilityDescription: "새로고침")
        reloadBtn.image?.isTemplate = true; reloadBtn.imagePosition = .imageOnly
        reloadBtn.isBordered = false; reloadBtn.contentTintColor = Theme.fgDim
        reloadBtn.toolTip = "새로고침 (⌘R)"
        reloadBtn.target = self; reloadBtn.action = #selector(reloadNow)
        reloadBtn.translatesAutoresizingMaskIntoConstraints = false
        externalBtn.image = NSImage(systemSymbolName: "arrow.up.forward.app", accessibilityDescription: "브라우저에서 열기")
        externalBtn.image?.isTemplate = true; externalBtn.imagePosition = .imageOnly
        externalBtn.isBordered = false; externalBtn.contentTintColor = Theme.fgDim
        externalBtn.toolTip = "기본 브라우저에서 열기"
        externalBtn.target = self; externalBtn.action = #selector(openExternal)
        externalBtn.translatesAutoresizingMaskIntoConstraints = false

        emptyLabel.font = .systemFont(ofSize: 11); emptyLabel.textColor = Theme.fgDim
        emptyLabel.alignment = .center
        emptyLabel.translatesAutoresizingMaskIntoConstraints = false

        addSubview(urlField); addSubview(reloadBtn); addSubview(externalBtn)
        addSubview(captureBtn); addSubview(openBtn); addSubview(web); addSubview(emptyLabel)
        NSLayoutConstraint.activate([
            urlField.leadingAnchor.constraint(equalTo: leadingAnchor, constant: 8),
            urlField.topAnchor.constraint(equalTo: topAnchor, constant: 8),
            urlField.trailingAnchor.constraint(equalTo: reloadBtn.leadingAnchor, constant: -6),
            reloadBtn.trailingAnchor.constraint(equalTo: externalBtn.leadingAnchor, constant: -6),
            reloadBtn.centerYAnchor.constraint(equalTo: urlField.centerYAnchor),
            reloadBtn.widthAnchor.constraint(equalToConstant: 22),
            externalBtn.trailingAnchor.constraint(equalTo: captureBtn.leadingAnchor, constant: -6),
            externalBtn.centerYAnchor.constraint(equalTo: urlField.centerYAnchor),
            externalBtn.widthAnchor.constraint(equalToConstant: 22),
            captureBtn.trailingAnchor.constraint(equalTo: openBtn.leadingAnchor, constant: -8),
            captureBtn.centerYAnchor.constraint(equalTo: urlField.centerYAnchor),
            captureBtn.widthAnchor.constraint(equalToConstant: 22),
            openBtn.trailingAnchor.constraint(equalTo: trailingAnchor, constant: -8),
            openBtn.centerYAnchor.constraint(equalTo: urlField.centerYAnchor),
            web.leadingAnchor.constraint(equalTo: leadingAnchor),
            web.trailingAnchor.constraint(equalTo: trailingAnchor),
            web.topAnchor.constraint(equalTo: urlField.bottomAnchor, constant: 8),
            web.bottomAnchor.constraint(equalTo: bottomAnchor),
            emptyLabel.centerXAnchor.constraint(equalTo: centerXAnchor),
            emptyLabel.centerYAnchor.constraint(equalTo: centerYAnchor)
        ])
        Theme.register(self)
    }
    required init?(coder: NSCoder) { fatalError() }

    func focusURL() { window?.makeFirstResponder(urlField) }
    // Open a URL programmatically (e.g. a dev server the script runner detected).
    func openURLString(_ s: String) { urlField.stringValue = s; openURL() }

    @objc private func openURL() {
        var s = urlField.stringValue.trimmingCharacters(in: .whitespaces)
        if s.isEmpty { return }
        if !s.contains("://") { s = "http://" + s }
        guard let url = URL(string: s) else { return }
        loadedURL = s
        web.isHidden = false; emptyLabel.isHidden = true
        web.load(URLRequest(url: url))
    }

    func reload() { if loadedURL != nil { web.reload() } }
    @objc private func reloadNow() { reload() }
    @objc private func openExternal() {
        guard let s = loadedURL, let url = URL(string: s) else { return }
        NSWorkspace.shared.open(url)
    }

    @objc private func captureNow() {
        guard loadedURL != nil else { NSSound.beep(); return }
        let cfg = WKSnapshotConfiguration()
        web.takeSnapshot(with: cfg) { [weak self] image, _ in
            guard let self, let image,
                  let tiff = image.tiffRepresentation, let rep = NSBitmapImageRep(data: tiff),
                  let png = rep.representation(using: .png, properties: [:]) else { return }
            let path = NSTemporaryDirectory() + "riven-capture-\(UUID().uuidString.prefix(8)).png"
            try? png.write(to: URL(fileURLWithPath: path))
            self.onCapture?(path)
        }
    }

    func applyTheme() {
        layer?.backgroundColor = Theme.bg2.cgColor
        urlField.textColor = Theme.fg
        emptyLabel.textColor = Theme.fgDim
    }
}
