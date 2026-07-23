import AppKit
import WebKit

// Monaco editor hosted in a WKWebView, with a native <-> web message bridge for
// file open/save + dirty state. This is the "editor stays Monaco" half of the
// hybrid — riven's editor assets reused as-is instead of reimplemented natively.
final class EditorView: NSView, WKScriptMessageHandler, WKNavigationDelegate {
    private var web: WKWebView!
    private var ready = false
    private var pending: (path: String, content: String)?
    var onSave: ((String, String) -> Void)?
    var onDirty: ((String, Bool) -> Void)?
    var onLSP: ((_ id: Int, _ method: String, _ path: String, _ params: [String: Any]) -> Void)?
    var onLSPSync: ((_ path: String, _ version: Int, _ text: String) -> Void)?
    var onAI: ((_ prefix: String, _ suffix: String) -> Void)?
    var onFocused: (() -> Void)?   // Monaco gained focus → activate the editor's dock group
    var onAgentRevert: ((_ path: String, _ newAfter: String) -> Void)?  // hunk reverted in the editor
    var onSendToAgent: ((_ file: String, _ start: Int, _ end: Int, _ text: String) -> Void)?  // ⌘L
    var onOpenDef: ((_ path: String, _ line: Int, _ column: Int) -> Void)?  // cross-file go-to-definition
    var onCloseTab: ((String) -> Void)?   // tab ✕ clicked in a WebView split group (last instance)
    var onActiveTab: ((String) -> Void)?  // tab clicked in a WebView split group → sync native active tab

    override init(frame: NSRect) {
        super.init(frame: frame)
        let cfg = WKWebViewConfiguration()
        cfg.userContentController.add(self, name: "riven")
        // Capture JS console + uncaught errors so a broken editor can be diagnosed.
        cfg.userContentController.add(self, name: "log")
        cfg.userContentController.addUserScript(WKUserScript(source: """
            (function(){var p=function(k){return function(){try{window.webkit.messageHandlers.log.postMessage(k+': '+Array.from(arguments).join(' '))}catch(e){}}};
            console.log=p('log');console.warn=p('warn');console.error=p('err');
            window.onerror=function(m,s,l,c){try{window.webkit.messageHandlers.log.postMessage('ONERROR: '+m+' @'+l+':'+c)}catch(e){}};})();
            """, injectionTime: .atDocumentStart, forMainFrameOnly: false))
        web = WKWebView(frame: bounds, configuration: cfg)
        web.autoresizingMask = [.width, .height]
        web.navigationDelegate = self
        web.setValue(false, forKey: "drawsBackground")
        if #available(macOS 13.3, *) { web.isInspectable = true }   // allow Web Inspector profiling
        addSubview(web)

        // Load the editor assets from file://. NOTE: this gives the page a null/opaque
        // origin, so Monaco can't spawn its Web Workers and falls back to the main thread.
        // Serving over a real origin (custom scheme / loopback http) DOES spawn the workers,
        // but WKWebView won't let a worker's fetch() load its sub-modules ("URL is not
        // valid"), so the workers still can't function AND the language workers spawning
        // over a real origin clobbered Shiki's syntax colors. file:// is the working state.
        if let htmlURL = Bundle.riven.url(forResource: "editor", withExtension: "html", subdirectory: "Resources")
            ?? Bundle.riven.url(forResource: "editor", withExtension: "html") {
            web.loadFileURL(htmlURL, allowingReadAccessTo: htmlURL.deletingLastPathComponent())
        }
        observeFontSize()
    }
    required init?(coder: NSCoder) { fatalError() }

    // The file the editor should currently be showing. Re-pushed whenever Monaco
    // (re)signals ready — critical because moving the WKWebView into the dock the
    // first time reloads the page, which would otherwise drop the open file.
    private var currentOpen: (path: String, content: String)?

    // Open a file in the editor (queued until Monaco signals ready).
    func open(path: String, content: String) {
        currentOpen = (path, content)
        if ready { push(path: path, content: content) }
        else { pending = (path, content) }
    }
    private func push(path: String, content: String) {
        let p = jsString(path), c = jsString(content)
        web.evaluateJavaScript("window.rivenOpen(\(p), \(c))", completionHandler: nil)
    }
    // Move the cursor to (line, column) — 1-based — and center it. The reveal is
    // queued a beat after open() so Monaco's model/layout exists first.
    func reveal(path: String, line: Int, column: Int) {
        web.evaluateJavaScript("window.rivenReveal(\(jsString(path)), \(line), \(column))", completionHandler: nil)
    }
    func markSaved(path: String) {
        web.evaluateJavaScript("window.rivenSaved(\(jsString(path)))", completionHandler: nil)
    }
    func close(path: String) {
        web.evaluateJavaScript("window.rivenClose(\(jsString(path)))", completionHandler: nil)
    }
    // 이미지 파일을 에디터 탭 안의 뷰어로 연다 (src는 data: URL — 웹뷰가 임의 경로의
    // file:// 이미지를 못 읽기 때문).
    func openImage(path: String, src: String) {
        web.evaluateJavaScript("window.rivenOpenImage && window.rivenOpenImage(\(jsString(path)), \(jsString(src)))", completionHandler: nil)
    }
    // 이미 연 이미지 탭으로 전환.
    func showImageTab(path: String) {
        web.evaluateJavaScript("window.rivenShowImage && window.rivenShowImage(\(jsString(path)))", completionHandler: nil)
    }
    // Add a tab chip + model without switching the visible tab or focus (used to
    // restore a workspace's inactive tabs on switch without stealing the active view).
    func openBackground(path: String, content: String) {
        let p = jsString(path), c = jsString(content)
        web.evaluateJavaScript("window.rivenOpenBackground && window.rivenOpenBackground(\(p), \(c))", completionHandler: nil)
    }
    // DEBUG: overwrite the active editor's buffer (used by RIVEN_SAVETEST).
    func debugSetValue(_ text: String) {
        web.evaluateJavaScript("editor && editor.getModel() && editor.getModel().setValue(\(jsString(text)))", completionHandler: nil)
    }
    // Split the editor: add a Monaco group beside (dir "right") or below (dir "down")
    // the current one (VS Code ⌘\ / ⌥⌘\).
    func splitEditor(_ dir: String = "right") {
        web.evaluateJavaScript("window.rivenSplitEditor && window.rivenSplitEditor(\(jsString(dir)))", completionHandler: nil)
    }
    // Switch Monaco's syntax theme (shiki name) + the page background + accent (active-tab
    // underline / drop indicator) to match a riven color theme. Safe before ready.
    func setEditorTheme(shiki: String, bg: String, accent: String, accent2: String) {
        web.evaluateJavaScript("window.rivenSetTheme(\(jsString(shiki)), \(jsString(bg)), \(jsString(accent)), \(jsString(accent2)))", completionHandler: nil)
    }
    // Live-set the Monaco font size (⌘+/⌘-/⌘0). Stashed so it survives a WKWebView
    // reload (re-applied on "ready") — this also keeps the peek/references list sized.
    // 초기값은 설정(editorFontSize)에서 읽는다 — 예전에는 12로 고정이라 설정이 무시됐다.
    private var fontSize = UIScale.editorFontSize
    func setFontSize(_ size: Int) {
        fontSize = size
        web.evaluateJavaScript("window.rivenSetFontSize && window.rivenSetFontSize(\(size))", completionHandler: nil)
    }
    // 설정 → 일반 → 에디터 폰트 크기 변경을 즉시 반영 (재시작 불필요).
    private func observeFontSize() {
        NotificationCenter.default.addObserver(forName: .rivenFontSizeChanged, object: nil, queue: .main) { [weak self] _ in
            self?.setFontSize(UIScale.editorFontSize)
        }
    }
    // Toggle format-on-save (riven's formatOnSave setting). Stashed so it survives a
    // WKWebView reload (re-applied on "ready").
    private var formatOnSave = false
    func setFormatOnSave(_ on: Bool) {
        formatOnSave = on
        web.evaluateJavaScript("window.rivenSetFormatOnSave && window.rivenSetFormatOnSave(\(on))", completionHandler: nil)
    }
    // Apply an editor keymap preset (vscode/jetbrains/sublime) to Monaco.
    private var editorKeymap = "vscode"
    func setEditorKeymap(_ preset: String) {
        editorKeymap = preset
        web.evaluateJavaScript("window.rivenSetEditorKeymap && window.rivenSetEditorKeymap(\(jsString(preset)))", completionHandler: nil)
    }
    // Per-command editor key overrides ({commandId: chord}).
    private var editorKeys: [String: String] = [:]
    func setEditorKeys(_ overrides: [String: String]) {
        editorKeys = overrides
        let json = String(data: (try? JSONSerialization.data(withJSONObject: overrides)) ?? Data("{}".utf8), encoding: .utf8) ?? "{}"
        web.evaluateJavaScript("window.rivenSetEditorKeys && window.rivenSetEditorKeys(\(json))", completionHandler: nil)
    }
    // Push the editor-scoped i18n dict (rebuilt for the current language) into the WebView.
    private static let i18nKeys = ["editor.emptyTitle", "editor.prevChange", "editor.nextChange",
        "editor.accept", "editor.revert", "editor.revertThisChange", "editor.snippet", "editor.changeWord"]
    func pushI18n() {
        var dict: [String: String] = [:]
        for k in EditorView.i18nKeys { dict[k] = t(k) }
        let json = String(data: (try? JSONSerialization.data(withJSONObject: dict)) ?? Data("{}".utf8), encoding: .utf8) ?? "{}"
        web.evaluateJavaScript("window.rivenSetI18n && window.rivenSetI18n(\(json))", completionHandler: nil)
    }

    // User snippets (array of {prefix, body}) → Monaco completion provider.
    private var snippets: [[String: String]] = []
    func setSnippets(_ list: [[String: String]]) {
        snippets = list
        let json = String(data: (try? JSONSerialization.data(withJSONObject: list)) ?? Data("[]".utf8), encoding: .utf8) ?? "[]"
        web.evaluateJavaScript("window.rivenSetSnippets && window.rivenSetSnippets(\(json))", completionHandler: nil)
    }
    // DEBUG: snapshot the editor WebView to a PNG (bypasses screen-recording perms).
    func debugSnapshot(to path: String) {
        // Log the FULL ancestor chain so we can tell if the editor is on-screen + unclipped.
        var chain = "", v: NSView? = self
        while let cur = v { chain += "\(type(of: cur))\(cur.frame.size)<\(cur.isHidden ? "HIDDEN" : "vis")> "; v = cur.superview }
        let inWindow = window != nil ? convert(bounds, to: nil) : .zero
        RLog.log("EDCHAIN winRect=\(inWindow) winBounds=\(window?.contentView?.bounds ?? .zero) chain=\(chain)")
        let cfg = WKSnapshotConfiguration()
        web.takeSnapshot(with: cfg) { img, err in
            RLog.log("SNAPSHOT size=\(img?.size ?? .zero) webFrame=\(self.web.frame) hidden=\(self.web.isHidden) winw=\(self.window != nil) err=\(String(describing: err))")
            guard let img, let tiff = img.tiffRepresentation, let rep = NSBitmapImageRep(data: tiff),
                  let png = rep.representation(using: .png, properties: [:]) else { return }
            try? png.write(to: URL(fileURLWithPath: path))
        }
    }
    // Give the Monaco editor keyboard focus (⌘E). Focus the WKWebView first so
    // key events route into it, then focus Monaco's textarea.
    func focusEditor() {
        window?.makeFirstResponder(web)
        web.evaluateJavaScript("editor && editor.focus()", completionHandler: nil)
    }
    // Cycle open tabs within the active Monaco group (issue #8: native-owned
    // ⌘⇧[ / ⌘⇧]). Native decides WHEN to send these (e.g. only when the editor is
    // focused, see isEditorFocused()); this just drives the WebView mechanism.
    func nextTab() {
        web.evaluateJavaScript("window.rivenNextTab && window.rivenNextTab()", completionHandler: nil)
    }
    func prevTab() {
        web.evaluateJavaScript("window.rivenPrevTab && window.rivenPrevTab()", completionHandler: nil)
    }
    // Whether this editor's WKWebView currently holds key focus. WKWebView's actual
    // first responder is an internal content view, not `web` itself, so check the
    // whole responder chain via isDescendant(of:) rather than direct equality.
    func isEditorFocused() -> Bool {
        guard let responder = window?.firstResponder as? NSView else { return false }
        return responder === web || responder.isDescendant(of: web)
    }
    // Show the empty state (no active file) — used when switching to a workspace
    // that has no open tabs.
    func showEmpty() {
        web.evaluateJavaScript("window.rivenShowEmpty()", completionHandler: nil)
    }
    // Ask Monaco to save this path (posts a 'save' message back with content) —
    // works even when the WKWebView doesn't hold key focus (⌘S from anywhere).
    func requestSave(path: String) {
        web.evaluateJavaScript("window.rivenRequestSave(\(jsString(path)))", completionHandler: nil)
    }
    // Trigger AI completion: gather cursor context in Monaco (→ onAI).
    func triggerAI() {
        web.evaluateJavaScript("window.rivenTriggerAI()", completionHandler: nil)
    }
    // AI ghost completion at the cursor (Tab accepts).
    func suggest(_ text: String) {
        web.evaluateJavaScript("window.rivenSuggest(\(jsString(text)))", completionHandler: nil)
    }
    // Agent diff review: pass before/after so Monaco computes hunks itself (green
    // added lines, red deleted view-zones, per-hunk revert). riven's MonacoEditorPane.
    func agentDiff(path: String, before: String, after: String) {
        web.evaluateJavaScript("window.rivenAgentDiff(\(jsString(path)), \(jsString(before)), \(jsString(after)))", completionHandler: nil)
    }
    func clearAgentDiff(path: String) {
        web.evaluateJavaScript("window.rivenClearAgentDiff(\(jsString(path)))", completionHandler: nil)
    }
    // Inline git blame: map of line number -> annotation text.
    func setBlame(path: String, map: [Int: String]) {
        let obj = Dictionary(uniqueKeysWithValues: map.map { (String($0.key), $0.value) })
        let json = String(data: try! JSONSerialization.data(withJSONObject: obj), encoding: .utf8)!
        web.evaluateJavaScript("window.rivenSetBlame(\(jsString(path)), \(json))", completionHandler: nil)
    }

    // A (re)load resets readiness so opens queue until Monaco signals ready again.
    func webView(_ w: WKWebView, didStartProvisionalNavigation n: WKNavigation!) { ready = false }

    // web -> native
    func userContentController(_ u: WKUserContentController, didReceive msg: WKScriptMessage) {
        if msg.name == "log" { RLog.log("WEB \(msg.body)"); return }
        guard let body = msg.body as? [String: Any], let type = body["type"] as? String else { return }
        switch type {
        case "ready":
            ready = true
            setEditorTheme(shiki: Theme.current.shiki, bg: Theme.current.bg, accent: Theme.current.accent, accent2: Theme.current.accent2)
            setFontSize(fontSize)
            setFormatOnSave(formatOnSave)
            setEditorKeymap(editorKeymap)
            setEditorKeys(editorKeys)
            setSnippets(snippets)
            pushI18n()
            // Re-push the current file (survives a WKWebView reload from being
            // reparented into the dock). Falls back to any queued open.
            if let c = currentOpen { push(path: c.path, content: c.content) }
            else if let p = pending { push(path: p.path, content: p.content) }
            pending = nil
        case "save":
            if let path = body["path"] as? String, let content = body["content"] as? String {
                onSave?(path, content)
            }
        case "dirty":
            if let path = body["path"] as? String, let d = body["dirty"] as? Bool {
                onDirty?(path, d)
            }
        case "lsp":
            if let id = body["id"] as? Int, let method = body["method"] as? String,
               let path = body["path"] as? String, let params = body["params"] as? [String: Any] {
                onLSP?(id, method, path, params)
            }
        case "lspSync":
            if let path = body["path"] as? String, let v = body["version"] as? Int, let text = body["text"] as? String {
                onLSPSync?(path, v, text)
            }
        case "ai":
            if let prefix = body["prefix"] as? String, let suffix = body["suffix"] as? String {
                onAI?(prefix, suffix)
            }
        case "focus":
            onFocused?()
        case "closeTab":
            if let path = body["path"] as? String { onCloseTab?(path) }
        case "activeTab":
            if let path = body["path"] as? String { onActiveTab?(path) }
        case "agentRevert":
            if let path = body["path"] as? String, let newAfter = body["newAfter"] as? String {
                onAgentRevert?(path, newAfter)
            }
        case "sendToAgent":
            if let file = body["file"] as? String, let text = body["text"] as? String,
               let s = body["startLine"] as? Int, let e = body["endLine"] as? Int {
                onSendToAgent?(file, s, e, text)
            }
        case "openDef":
            if let path = body["path"] as? String {
                onOpenDef?(path, body["line"] as? Int ?? 1, body["column"] as? Int ?? 1)
            }
        default: break
        }
    }

    // Reply to an LSP request from Monaco with the server's result. Wrap in an
    // array so JSONSerialization accepts non-object top levels (a bare string /
    // number / null LSP result would otherwise throw an Obj-C exception). JS
    // unwraps [0].
    func lspRespond(id: Int, result: Any?) {
        let wrapped: [Any] = [result ?? NSNull()]
        let json = String(data: (try? JSONSerialization.data(withJSONObject: wrapped)) ?? Data("[null]".utf8), encoding: .utf8) ?? "[null]"
        web.evaluateJavaScript("window.rivenLSPResponse(\(id), (\(json))[0])", completionHandler: nil)
    }
    // Push diagnostics to Monaco as markers.
    func setDiagnostics(path: String, diags: [[String: Any]]) {
        let json = String(data: (try? JSONSerialization.data(withJSONObject: diags)) ?? Data("[]".utf8), encoding: .utf8) ?? "[]"
        web.evaluateJavaScript("window.rivenDiagnostics(\(jsString(path)), \(json))", completionHandler: nil)
    }

    private func jsString(_ s: String) -> String {
        let data = try! JSONSerialization.data(withJSONObject: [s])
        let json = String(data: data, encoding: .utf8)!
        return String(json.dropFirst().dropLast()) // strip the [ ]
    }
}

