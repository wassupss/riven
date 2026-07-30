import AppKit

// Native chat panel: drives `claude` headless (ClaudeChatSession, subscription auth) and
// renders a rich custom chat — not the terminal TUI, not a WebView. Each user turn produces
// a TurnBlock with a thinking/writing/elapsed header + token usage; main-thread tokens stream
// with a smooth typewriter reveal interleaved with tool lines (edits show a diff); sub-agents
// get their own lane. A permission-mode selector — cyclable with Shift+Tab like the CLI —
// includes an interactive "승인 요청" mode that pops an approval card per tool call. A
// scrollable slash-command popup autocompletes `/` commands.
final class ChatPanel: NSView, Themable, Scalable, NSTextFieldDelegate {
    private let scroll = NSScrollView()                   // conversation
    private let stack = FlippedStack()
    private let subSide = NSScrollView()                  // right side: sub-agent panes
    private var subWidthShown: NSLayoutConstraint!        // sub area = 45% (when sub-agents run)
    private var subWidthHidden: NSLayoutConstraint!       // sub area = 0 (default)
    private let subStack = FlippedStack()
    private let input = NSTextField()
    private let sendButton = NSButton()
    private let modePopup = NSPopUpButton(frame: .zero, pullsDown: false)
    private let composer = NSVisualEffectView()          // glass composer row (mode | input | send)
    private let modeChip = NSView()                      // pill behind the compact mode popup
    private let hairline = NSView()
    private let slash = SlashPopup()
    private var slashHeight: NSLayoutConstraint!

    private var session: ClaudeChatSession?
    private var workspace: URL?
    private var current: TurnBlock?
    private var subToPane: [String: SubagentPane] = [:]   // sub-agent id → its split pane
    private var turnStart: Date?
    private var flushTimer: Timer?
    private var model: String?
    private var commands: [SlashCommand] = []
    private var lastScaleFactor: CGFloat = 1
    private var pendingResume: String?                   // resume this session id on next bind
    // Approvals/choices are shown ONE AT A TIME (others queue); the elapsed timer is paused
    // while any is pending, since the agent is idle waiting on the user.
    private var approvalQueue: [() -> Void] = []
    private var approvalActive = false
    private var pauseStart: Date?
    private var pausedTotal: TimeInterval = 0

    // UI labels. The approval hook is ALWAYS installed and fires for BOTH main- and sub-agent
    // tools (verified), so riven's per-mode policy covers sub-agents too. CLI mode is "plan"
    // for 계획, else "default" (the hook governs). Switching is a live control message.
    //   계획      — read-only planning
    //   승인 요청 — ask per gated tool (cards)
    //   자동 실행 — auto-run everything, no cards (main + sub)
    private let modes: [(String, String)] = [("계획", "plan"), ("승인 요청", "default"), ("자동 실행", "auto")]
    private var modeIndex: Int { max(0, modePopup.indexOfSelectedItem) }
    private var cliMode: String { modeIndex == 0 ? "plan" : "default" }

    var onFocused: (() -> Void)?
    var onOpenFile: ((URL) -> Void)?
    var onOpenFileAt: ((URL, Int) -> Void)?
    var onShowEdit: ((URL, String, String) -> Void)?
    // Rail/tab integration (mirrors agent terminal panes): busy while a turn runs, attention
    // while awaiting approval, and a title from the first message.
    var onBusyChange: ((Bool) -> Void)?
    var onAttention: ((Bool) -> Void)?
    var onTitle: ((String) -> Void)?
    var onSessionId: ((String) -> Void)?    // report the CLI session id so the pane can be resumed on relaunch
    var onOpenSettings: (() -> Void)?       // /config
    private let attnRing = AttnRingView(frame: .zero)
    // busy = static ring, attn = travelling ember, nil = none (mirrors TerminalView).
    func setRingState(_ badge: String?) {
        switch badge { case "attn": attnRing.state = .attn; case "busy": attnRing.state = .busy; default: attnRing.state = .none }
    }
    private var titleSet = false

    override init(frame: NSRect) {
        super.init(frame: frame)
        wantsLayer = true
        layer?.backgroundColor = Theme.bg.cgColor

        stack.orientation = .vertical; stack.spacing = 16; stack.alignment = .leading
        stack.edgeInsets = NSEdgeInsets(top: 12, left: 12, bottom: 12, right: 12)
        stack.translatesAutoresizingMaskIntoConstraints = false
        scroll.documentView = stack
        scroll.hasVerticalScroller = true; scroll.hasHorizontalScroller = false
        scroll.drawsBackground = false; scroll.autohidesScrollers = true
        scroll.scrollerStyle = .overlay   // floating scroller — never steals content width (no reflow on click/scroll)
        scroll.translatesAutoresizingMaskIntoConstraints = false

        // Sub-agents render as EQUAL columns (riven-style panes) in a right-side area. It's laid
        // out with a plain width constraint (NOT an NSSplitView) — the split view was toggling
        // itself back on click/relayout, leaving ghost empty columns. Deterministic width = no
        // ghosts, no flatten-on-click. Hidden (width 0) until a sub-agent starts.
        subStack.orientation = .horizontal; subStack.spacing = 1; subStack.alignment = .top
        subStack.distribution = .fillEqually        // columns share the sub area equally
        subStack.translatesAutoresizingMaskIntoConstraints = false
        subSide.documentView = subStack
        subSide.hasHorizontalScroller = false; subSide.hasVerticalScroller = false
        subSide.drawsBackground = false
        subSide.translatesAutoresizingMaskIntoConstraints = false
        subSide.isHidden = true

        hairline.wantsLayer = true; hairline.layer?.backgroundColor = Theme.hairline.cgColor
        hairline.isHidden = true          // glass composer has its own border → no separate rule
        hairline.translatesAutoresizingMaskIntoConstraints = false

        // Glass composer: ONE row — compact mode chip | borderless input | accent send pill —
        // on a blurred, hairline-bordered card floating above the chat background.
        composer.material = .hudWindow
        composer.blendingMode = .withinWindow
        composer.state = .active
        composer.wantsLayer = true
        composer.layer?.cornerRadius = 10
        composer.layer?.borderWidth = 1
        composer.layer?.masksToBounds = true
        composer.translatesAutoresizingMaskIntoConstraints = false

        modeChip.wantsLayer = true
        modeChip.layer?.cornerRadius = UIScale.pt(24) / 2
        modeChip.translatesAutoresizingMaskIntoConstraints = false

        // modePopup stays the single source of truth for the mode (index read via modeIndex,
        // set by cycleMode/approval cards) — just restyled compact & borderless inside the chip,
        // so its title updates itself on every selectItem(at:).
        modePopup.addItems(withTitles: modes.map { $0.0 })
        modePopup.selectItem(at: 1)                    // 승인 요청 default
        modePopup.font = UIScale.font(10, .medium)
        modePopup.controlSize = .small
        modePopup.isBordered = false
        modePopup.toolTip = "권한 모드 (Shift+Tab 으로 전환)"
        modePopup.target = self; modePopup.action = #selector(modeChanged)
        modePopup.translatesAutoresizingMaskIntoConstraints = false

        input.placeholderString = "Claude에게 메시지…  ( / 명령 · Shift+Tab 모드 )"
        input.font = UIScale.font(12); input.textColor = Theme.fg
        input.focusRingType = .none
        input.isBezeled = false; input.drawsBackground = false   // naked field on the glass
        input.delegate = self
        input.target = self; input.action = #selector(sendFromInput)
        input.translatesAutoresizingMaskIntoConstraints = false

        sendButton.title = "보내기"
        sendButton.isBordered = false
        sendButton.wantsLayer = true
        sendButton.layer?.cornerRadius = UIScale.pt(26) / 2
        sendButton.font = UIScale.font(11, .semibold)
        sendButton.target = self; sendButton.action = #selector(sendFromInput)
        sendButton.translatesAutoresizingMaskIntoConstraints = false

        slash.translatesAutoresizingMaskIntoConstraints = false

        modeChip.addSubview(modePopup)
        [modeChip, input, sendButton].forEach { composer.addSubview($0) }
        [scroll, subSide, hairline, composer, slash].forEach { addSubview($0) }
        applyComposerTheme()
        slashHeight = slash.heightAnchor.constraint(equalToConstant: 0)
        subWidthShown = subSide.widthAnchor.constraint(equalTo: widthAnchor, multiplier: 0.45)
        subWidthHidden = subSide.widthAnchor.constraint(equalToConstant: 0)
        NSLayoutConstraint.activate([
            // conversation (left) | sub-agent area (right), sized by subWidthHidden/Shown
            scroll.topAnchor.constraint(equalTo: topAnchor),
            scroll.leadingAnchor.constraint(equalTo: leadingAnchor),
            scroll.bottomAnchor.constraint(equalTo: hairline.topAnchor),
            scroll.trailingAnchor.constraint(equalTo: subSide.leadingAnchor),
            subSide.topAnchor.constraint(equalTo: topAnchor),
            subSide.trailingAnchor.constraint(equalTo: trailingAnchor),
            subSide.bottomAnchor.constraint(equalTo: hairline.topAnchor),
            subWidthHidden,
            stack.topAnchor.constraint(equalTo: scroll.contentView.topAnchor),
            stack.leadingAnchor.constraint(equalTo: scroll.contentView.leadingAnchor),
            stack.widthAnchor.constraint(equalTo: scroll.contentView.widthAnchor),   // clip width → no h-overflow jitter
            subStack.topAnchor.constraint(equalTo: subSide.contentView.topAnchor),
            subStack.leadingAnchor.constraint(equalTo: subSide.contentView.leadingAnchor),
            subStack.widthAnchor.constraint(equalTo: subSide.contentView.widthAnchor),      // fill width (no h-scroll)
            subStack.heightAnchor.constraint(equalTo: subSide.contentView.heightAnchor),    // columns fill clip height
            hairline.leadingAnchor.constraint(equalTo: leadingAnchor),
            hairline.trailingAnchor.constraint(equalTo: trailingAnchor),
            hairline.heightAnchor.constraint(equalToConstant: 1),
            hairline.bottomAnchor.constraint(equalTo: composer.topAnchor, constant: -10),
            // composer glass card, inset from the panel edges
            composer.leadingAnchor.constraint(equalTo: leadingAnchor, constant: 12),
            composer.trailingAnchor.constraint(equalTo: trailingAnchor, constant: -12),
            composer.bottomAnchor.constraint(equalTo: bottomAnchor, constant: -12),
            composer.heightAnchor.constraint(equalToConstant: UIScale.pt(44)),
            // one aligned row: chip | input | send, all vertically centered
            modeChip.leadingAnchor.constraint(equalTo: composer.leadingAnchor, constant: 8),
            modeChip.centerYAnchor.constraint(equalTo: composer.centerYAnchor),
            modeChip.heightAnchor.constraint(equalToConstant: UIScale.pt(24)),
            modePopup.leadingAnchor.constraint(equalTo: modeChip.leadingAnchor, constant: 8),
            modePopup.trailingAnchor.constraint(equalTo: modeChip.trailingAnchor, constant: -4),
            modePopup.centerYAnchor.constraint(equalTo: modeChip.centerYAnchor),
            input.leadingAnchor.constraint(equalTo: modeChip.trailingAnchor, constant: 10),
            input.centerYAnchor.constraint(equalTo: composer.centerYAnchor),
            input.trailingAnchor.constraint(equalTo: sendButton.leadingAnchor, constant: -10),
            sendButton.trailingAnchor.constraint(equalTo: composer.trailingAnchor, constant: -8),
            sendButton.centerYAnchor.constraint(equalTo: composer.centerYAnchor),
            sendButton.heightAnchor.constraint(equalToConstant: UIScale.pt(26)),
            sendButton.widthAnchor.constraint(greaterThanOrEqualToConstant: UIScale.pt(64)),
            // slash popup floats just above the composer card
            slash.leadingAnchor.constraint(equalTo: composer.leadingAnchor),
            slash.trailingAnchor.constraint(equalTo: composer.trailingAnchor),
            slash.bottomAnchor.constraint(equalTo: composer.topAnchor, constant: -6),
            slashHeight
        ])
        ChatText.openInEditor = { [weak self] url in self?.onOpenFile?(url) }
        ChatText.showEdit = { [weak self] url, o, n in self?.onShowEdit?(url, o, n) }
        // Same travelling-ember state ring as agent terminal panes, driven by setRingState.
        attnRing.frame = bounds; attnRing.autoresizingMask = [.width, .height]
        addSubview(attnRing)
        lastScaleFactor = UIScale.pt(100) / 100        // capture current factor for later ratios
        registerForDraggedTypes([.fileURL, .string])   // drag a file → path, or selected text → snippet
        Theme.register(self)
        UIScale.register(self)
    }
    required init?(coder: NSCoder) { fatalError() }

    func applyTheme() {
        layer?.backgroundColor = Theme.bg.cgColor
        hairline.layer?.backgroundColor = Theme.hairline.cgColor
        applyComposerTheme()
    }
    // Glass + chip + send-pill colors, all Theme tokens (re-applied on theme switch). The
    // effect view's appearance follows the riven theme, not the system, so the blur matches.
    private func applyComposerTheme() {
        composer.appearance = NSAppearance(named: Theme.isLight ? .aqua : .darkAqua)
        composer.layer?.borderColor = Theme.edge.cgColor
        modeChip.layer?.backgroundColor = Theme.hover.cgColor
        input.textColor = Theme.fg
        sendButton.layer?.backgroundColor = Theme.accentMuted.cgColor
        sendButton.layer?.borderWidth = 1
        sendButton.layer?.borderColor = Theme.accentBorder.cgColor
        let ps = NSMutableParagraphStyle(); ps.alignment = .center
        sendButton.attributedTitle = NSAttributedString(
            string: "보내기",
            attributes: [.foregroundColor: Theme.accent,
                         .font: sendButton.font ?? UIScale.font(11, .semibold),
                         .paragraphStyle: ps])
    }

    // ⌘+/⌘−/⌘0: rescale every font in the panel (incl. already-rendered messages) by the
    // ratio of the new factor to the last one — no need to know each view's base size.
    func applyScale() {
        let factor = UIScale.pt(100) / 100
        let ratio = factor / max(lastScaleFactor, 0.01)
        lastScaleFactor = factor
        guard abs(ratio - 1) > 0.001 else { return }
        ChatPanel.rescale(self, ratio)
    }
    private static func rescale(_ v: NSView, _ ratio: CGFloat) {
        if let tf = v as? NSTextField {
            // Snapshot BEFORE touching .font, else a plain label's attributedStringValue would
            // already reflect the new font and get scaled a second time.
            let snap = tf.attributedStringValue
            if let f = tf.font { tf.font = f.withSize(f.pointSize * ratio) }
            if snap.length > 0 {
                let m = NSMutableAttributedString(attributedString: snap)
                m.enumerateAttribute(.font, in: NSRange(location: 0, length: m.length)) { val, r, _ in
                    if let f = val as? NSFont { m.addAttribute(.font, value: f.withSize(f.pointSize * ratio), range: r) }
                }
                tf.attributedStringValue = m
            }
        } else if let c = v as? NSControl, let f = c.font {
            c.font = f.withSize(f.pointSize * ratio)
        }
        v.subviews.forEach { rescale($0, ratio) }
    }

    // Focus-follows-click, like riven's other panes.
    override func mouseDown(with e: NSEvent) {
        onFocused?()
        focusInput()
        super.mouseDown(with: e)
    }
    // Put the cursor in the message field. `force` overrides the guard that normally keeps an
    // open approval card focused (used right after a choice is made).
    func focusInput(force: Bool = false) {
        if !force, let card = window?.firstResponder as? ApprovalCard, card.isDescendant(of: self) { return }
        window?.makeFirstResponder(input)
    }
    // Catch-all: whenever anything makes the PANEL itself first responder (tab click, restore,
    // directional nav), forward the cursor into the message field.
    override var acceptsFirstResponder: Bool { true }
    override func becomeFirstResponder() -> Bool {
        if let card = window?.firstResponder as? ApprovalCard, card.isDescendant(of: self) { return true }
        return window?.makeFirstResponder(input) ?? false
    }

    // ---- image / file drag-and-drop → insert path into the message ----
    override func draggingEntered(_ s: NSDraggingInfo) -> NSDragOperation {
        let pb = s.draggingPasteboard
        return (pb.canReadObject(forClasses: [NSURL.self], options: nil) || pb.string(forType: .string) != nil) ? .copy : []
    }
    override func prepareForDragOperation(_ s: NSDraggingInfo) -> Bool { true }
    override func performDragOperation(_ s: NSDraggingInfo) -> Bool {
        let pb = s.draggingPasteboard
        var insert = ""
        if let urls = pb.readObjects(forClasses: [NSURL.self], options: nil) as? [URL], !urls.isEmpty {
            insert = urls.map { $0.path.contains(" ") ? "\"\($0.path)\"" : $0.path }.joined(separator: " ")
        } else if let text = pb.string(forType: .string), !text.isEmpty {
            // Dragged text (e.g. a code selection from the editor) → a fenced snippet to discuss.
            insert = text.contains("\n") ? "\n```\n\(text)\n```\n" : text
        }
        guard !insert.isEmpty else { return false }
        input.stringValue = input.stringValue.isEmpty ? insert : input.stringValue + " " + insert
        window?.makeFirstResponder(input)
        input.currentEditor()?.selectedRange = NSRange(location: input.stringValue.count, length: 0)
        return true
    }

    // Shift+Tab cycles the permission mode, but only while the chat has keyboard focus so it
    // doesn't hijack Tab elsewhere in the window.
    override func performKeyEquivalent(with event: NSEvent) -> Bool {
        if event.keyCode == 48, event.modifierFlags.contains(.shift), chatHasFocus() {
            cycleMode(); return true
        }
        return super.performKeyEquivalent(with: event)
    }
    private func chatHasFocus() -> Bool {
        guard let fr = window?.firstResponder as? NSView else { return false }
        var v: NSView? = fr
        while let cur = v { if cur === self { return true }; v = cur.superview }
        return false
    }
    // Toggle the sub-agent area by swapping its width constraint (0 ↔ 45%). Deterministic —
    // no NSSplitView to ghost/flatten on relayout.
    private func showSubSide(_ show: Bool) {
        guard subSide.isHidden == show else { return }   // only on a real transition
        subSide.isHidden = !show
        subWidthHidden.isActive = !show
        subWidthShown.isActive = show
        layoutSubtreeIfNeeded()
    }

    // Bind to a workspace: (re)start the claude session rooted there. `resume` reopens a past
    // session id (for per-pane session resume).
    func bind(workspace url: URL, resume: String? = nil) {
        pendingResume = resume
        setWorkspace(url)
    }
    func setWorkspace(_ url: URL) {
        guard workspace != url else { return }
        workspace = url
        session?.stop(); session = nil
        current = nil; clearSubagents(); stopFlush()
        stack.arrangedSubviews.forEach { $0.removeFromSuperview() }
        commands = ChatPanel.discoverCommands(cwd: url.path)
        guard let cmd = AgentDiscovery.claudeCmd() else {
            addSystem("claude CLI를 찾을 수 없습니다. 터미널에서 `claude` 로그인 여부를 확인하세요.")
            return
        }
        let resume = pendingResume; pendingResume = nil
        startSession(cmd: cmd, cwd: url.path, resume: resume)
        if let resume { loadHistory(cwd: url.path, sessionId: resume) }   // replay prior conversation
    }
    // Stop the underlying process when the pane is closed.
    func teardown() { session?.stop(); session = nil; stopFlush() }

    // A short, CLI-like title from the first message (a heuristic — no extra model call/tokens;
    // a true summary would cost a small request).
    static func shortTitle(_ s: String) -> String {
        var t = s.replacingOccurrences(of: "\n", with: " ").trimmingCharacters(in: .whitespaces)
        if let r = t.range(of: "[.?!。？！]", options: .regularExpression) { t = String(t[..<r.lowerBound]) }
        return t.count > 24 ? String(t.prefix(24)) + "…" : t
    }

    // Render the resumed session's prior turns so the conversation is visible (the CLI restores
    // context but doesn't re-emit past messages, so the panel would otherwise look empty).
    private func loadHistory(cwd: String, sessionId: String) {
        let enc = cwd.map { $0.isLetter || $0.isNumber ? String($0) : "-" }.joined()
        let url = FileManager.default.homeDirectoryForCurrentUser
            .appendingPathComponent(".claude/projects/\(enc)/\(sessionId).jsonl")
        guard let text = try? String(contentsOf: url, encoding: .utf8) else { return }
        for line in text.split(separator: "\n") {
            guard let d = line.data(using: .utf8),
                  let o = try? JSONSerialization.jsonObject(with: d) as? [String: Any],
                  let type = o["type"] as? String, let msg = o["message"] as? [String: Any] else { continue }
            let s = ChatPanel.contentText(msg["content"]).trimmingCharacters(in: .whitespacesAndNewlines)
            if s.isEmpty { continue }
            if type == "user" {
                if s.hasPrefix("/") || s.hasPrefix("<") { continue }   // slash cmd / injected context
                addUser(s)
            } else if type == "assistant" {
                for v in ChatText.render(s) {
                    v.translatesAutoresizingMaskIntoConstraints = false
                    stack.addArrangedSubview(v)
                    v.widthAnchor.constraint(equalTo: stack.widthAnchor, constant: -24).isActive = true
                }
            }
        }
        addSystem("— 이전 세션에서 이어짐 —")
        scrollSoon()
    }
    private static func contentText(_ c: Any?) -> String {
        if let s = c as? String { return s }
        if let arr = c as? [[String: Any]] {
            return arr.compactMap { $0["type"] as? String == "text" ? $0["text"] as? String : nil }.joined(separator: "\n")
        }
        return ""
    }

    // Switch THIS pane to a past session in place (no new pane) — replaces the transcript and
    // resumes the chosen session id.
    func switchSession(to sid: String) {
        guard let url = workspace, let cmd = AgentDiscovery.claudeCmd() else { return }
        session?.stop(); session = nil
        current = nil; clearSubagents(); stopFlush(); turnStart = nil; queuedMessages.removeAll(); titleSet = false
        approvalQueue.removeAll(); approvalActive = false
        stack.arrangedSubviews.forEach { $0.removeFromSuperview() }
        startSession(cmd: cmd, cwd: url.path, resume: sid)
        loadHistory(cwd: url.path, sessionId: sid)
        onSessionId?(sid)
    }
    // This workspace's past sessions (newest first) with a title from the first user message.
    private func listSessions() -> [(id: String, title: String, date: String)] {
        guard let cwd = workspace?.path else { return [] }
        let enc = cwd.map { $0.isLetter || $0.isNumber ? String($0) : "-" }.joined()
        let dir = FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent(".claude/projects/\(enc)")
        guard let files = try? FileManager.default.contentsOfDirectory(at: dir, includingPropertiesForKeys: [.contentModificationDateKey]) else { return [] }
        let fmt = DateFormatter(); fmt.dateFormat = "MM/dd HH:mm"
        return files.filter { $0.pathExtension == "jsonl" }.compactMap { url -> (String, String, Date)? in
            let m = (try? url.resourceValues(forKeys: [.contentModificationDateKey]))?.contentModificationDate ?? .distantPast
            return (url.deletingPathExtension().lastPathComponent, sessionTitle(url), m)
        }.sorted { $0.2 > $1.2 }.prefix(12).map { (id: $0.0, title: $0.1, date: fmt.string(from: $0.2)) }
    }
    private func sessionTitle(_ url: URL) -> String {
        guard let text = try? String(contentsOf: url, encoding: .utf8) else { return "" }
        for line in text.split(separator: "\n").prefix(60) {
            guard let d = line.data(using: .utf8),
                  let o = try? JSONSerialization.jsonObject(with: d) as? [String: Any],
                  o["type"] as? String == "user", let msg = o["message"] as? [String: Any] else { continue }
            let s = ChatPanel.contentText(msg["content"]).trimmingCharacters(in: .whitespacesAndNewlines).replacingOccurrences(of: "\n", with: " ")
            if s.isEmpty || s.hasPrefix("/") || s.hasPrefix("<") { continue }
            return String(s.prefix(40))
        }
        return ""
    }
    // Show a standalone arrow-select card in the transcript (not part of a turn's approval flow).
    private func presentChoice(_ title: String, options: [(String, () -> Void)]) {
        let block = newBlock(); current = block
        let card = block.addApproval(title, "", nil, nil, options: options)
        scrollSoon()
        DispatchQueue.main.async { [weak self, weak card] in if let card { self?.window?.makeFirstResponder(card) } }
    }

    private func startSession(cmd: String, cwd: String, resume: String?) {
        // Always install the approval hook; gate the risky tools through it (safe read-only
        // tools auto-run). riven's per-mode policy in requestPermission() decides allow/prompt.
        let s = ClaudeChatSession(command: cmd, cwd: cwd, resume: resume,
            permissionMode: cliMode, allowedTools: "Read,Grep,Glob,LS,Task,TodoWrite", interactive: true)
        s?.onInit = { [weak self] sid, model in self?.model = model; self?.onSessionId?(sid) }
        s?.onTextDelta = { [weak self] t in self?.current?.bufferText(t) }
        s?.onMainTool = { [weak self] name, detail, code, path in self?.current?.addTool(name, detail, code, path); self?.scrollSoon() }
        s?.onSubagentStart = { [weak self] id, type, desc in self?.addSubagentPane(id, type: type, desc: desc) }
        s?.onSubagentTool = { [weak self] pid, name, detail, code, path in self?.subToPane[pid]?.addTool(name, detail, code, path) }
        s?.onSubagentText = { [weak self] pid, text in self?.subToPane[pid]?.addText(text) }
        s?.onSubagentDone = { [weak self] id, result in self?.subToPane[id]?.finish(result) }
        s?.onTurnDone = { [weak self] cost, _, usage in self?.endTurn(cost: cost, usage: usage) }
        s?.onExit = { [weak self] code in if code != 0 { self?.addSystem("세션 종료(code \(code)). 로그인/권한을 확인하세요.") } }
        s?.onPermissionRequest = { [weak self] id, name, detail, code, path in self?.requestPermission(id, name, detail, code, path) }
        s?.onToolRequest = { [weak self] id, tool, args in self?.handleTool(id, tool, args) }
        session = s
        if s == nil { addSystem("세션을 시작하지 못했습니다.") }
    }

    // ---- permission / choice cards (per-mode policy, applied live) ----
    private func requestPermission(_ id: String, _ name: String, _ detail: String, _ code: String?, _ path: String?) {
        // riven's own tools run in-app (choice card / preview / api) — never gate them.
        if name.hasPrefix("mcp__riven__") { session?.respond(id, allow: true); return }
        // ExitPlanMode: the agent is presenting a plan and asking to proceed — an arrow-select
        // choice regardless of the current permission mode.
        if name == "ExitPlanMode" {
            enqueueChoice(title: "이 계획대로 진행할까요?", detail: "", code: code, path: nil, options: [
                ("진행", { [weak self] in self?.session?.respond(id, allow: true) }),
                ("계획 수정", { [weak self] in self?.session?.respond(id, allow: false) })
            ])
            return
        }
        let approve: (String, () -> Void) = ("승인", { [weak self] in self?.session?.respond(id, allow: true) })
        let alwaysAuto: (String, () -> Void) = ("이 세션 자동 실행", { [weak self] in
            self?.modePopup.selectItem(at: 2); self?.modeChanged(); self?.session?.respond(id, allow: true) })
        let deny: (String, () -> Void) = ("거부", { [weak self] in self?.session?.respond(id, allow: false) })
        switch modeIndex {
        case 1:  enqueueChoice(title: "권한 요청 · \(name)", detail: detail, code: code, path: path,   // 승인 요청
                               options: [approve, alwaysAuto, deny])
        case 2:  session?.respond(id, allow: true)          // 자동 실행 — everything (main + sub)
        default: session?.respond(id, allow: false)         // 계획 — no edits expected
        }
    }
    // ---- riven tools (MCP) ----
    var onOpenBrowser: ((String) -> Void)?
    var onScreenshot: ((String?, @escaping (String?) -> Void) -> Void)?
    var onApiRequest: ((_ method: String, _ url: String, _ headers: String, _ body: String) -> Void)?
    var onPanels: (() -> String)?
    var onOpenPanel: ((String) -> String)?
    var onClosePanel: ((String) -> String)?
    var onWorkspaces: (() -> String)?
    var onOpenWorkspace: ((String) -> String)?

    private func handleTool(_ id: String, _ tool: String, _ args: [String: Any]) {
        func s(_ k: String) -> String { args[k] as? String ?? "" }
        switch tool {
        case "ask_user":
            presentAsk(id, s("question"), args["options"] as? [String] ?? [])
        case "riven_open_file":
            let p = s("path")
            let line = (args["line"] as? NSNumber)?.intValue ?? (args["line"] as? Int) ?? 1
            onOpenFileAt?(URL(fileURLWithPath: p), line)
            addSystem("📄 에디터에 열었습니다: \(p)")
            session?.respondTool(id, "opened \(p) in riven editor")
        case "riven_open_browser":
            onOpenBrowser?(s("url"))
            addSystem("🌐 미리보기 패널에 열었습니다: \(s("url"))")
            session?.respondTool(id, "opened \(s("url")) in riven preview panel")
        case "riven_screenshot":
            let url = args["url"] as? String
            addSystem("📸 스크린샷 캡처 중…")
            if let onScreenshot {
                onScreenshot(url) { [weak self] path in
                    self?.session?.respondTool(id, path.map { "screenshot saved to \($0) (read it with the Read tool)" } ?? "screenshot failed")
                }
            } else { session?.respondTool(id, "screenshot unavailable") }
        case "riven_api_request":
            // Show it in the API panel AND return the body to the agent.
            let hdrs = (args["headers"] as? [String: Any])?.map { "\($0.key): \($0.value)" }.joined(separator: "\n") ?? ""
            onApiRequest?(s("method").isEmpty ? "GET" : s("method"), s("url"), hdrs, s("body"))
            addSystem("↗ API 패널: \(s("method")) \(s("url"))")
            apiRequest(args) { [weak self] result in self?.session?.respondTool(id, result) }
        case "riven_panels":
            session?.respondTool(id, onPanels?() ?? "(no panels)")
        case "riven_open_panel":
            session?.respondTool(id, onOpenPanel?(s("kind")) ?? "unavailable")
        case "riven_close_panel":
            session?.respondTool(id, onClosePanel?(s("id")) ?? "unavailable")
        case "riven_workspaces":
            session?.respondTool(id, onWorkspaces?() ?? "(none)")
        case "riven_open_workspace":
            session?.respondTool(id, onOpenWorkspace?(s("path")) ?? "unavailable")
        default:
            session?.respondTool(id, "unknown tool: \(tool)")
        }
    }
    // In-process HTTP for the api-test tool.
    private func apiRequest(_ args: [String: Any], _ done: @escaping (String) -> Void) {
        guard let s = args["url"] as? String, let url = URL(string: s) else { done("invalid url"); return }
        var req = URLRequest(url: url)
        req.httpMethod = (args["method"] as? String ?? "GET").uppercased()
        if let h = args["headers"] as? [String: Any] { for (k, v) in h { req.setValue("\(v)", forHTTPHeaderField: k) } }
        if let b = args["body"] as? String { req.httpBody = b.data(using: .utf8) }
        req.timeoutInterval = 30
        addSystem("↗ \(req.httpMethod ?? "GET") \(s)")
        URLSession.shared.dataTask(with: req) { data, resp, err in
            var out = ""
            if let err { out = "request failed: \(err.localizedDescription)" }
            else if let http = resp as? HTTPURLResponse {
                let headers = http.allHeaderFields.map { "\($0.key): \($0.value)" }.sorted().joined(separator: "\n")
                var body = data.flatMap { String(data: $0, encoding: .utf8) } ?? ""
                if body.count > 4000 { body = String(body.prefix(4000)) + "\n…(truncated)" }
                out = "HTTP \(http.statusCode)\n\(headers)\n\n\(body)"
            }
            DispatchQueue.main.async { done(out) }
        }.resume()
    }
    // The agent called ask_user — show its options as an arrow-select choice card.
    private func presentAsk(_ id: String, _ question: String, _ options: [String]) {
        let opts: [(String, () -> Void)] = options.map { opt in
            (opt, { [weak self] in self?.session?.respondTool(id, opt) })
        }
        enqueueChoice(title: question, detail: "", code: nil, path: nil, options: opts)
    }

    // Serialize prompts: enqueue a card; only one is shown at a time so focus is unambiguous.
    private func enqueueChoice(title: String, detail: String, code: String?, path: String?,
                              options: [(String, () -> Void)]) {
        // each option runs its action, then advances the queue
        let wrapped = options.map { (label, action) -> (String, () -> Void) in
            (label, { [weak self] in action(); self?.advanceApprovals() })
        }
        approvalQueue.append { [weak self] in
            guard let self else { return }
            let block = self.current ?? { let b = self.newBlock(); self.current = b; return b }()
            let card = block.addApproval(title, detail, code, path, options: wrapped)
            self.scrollSoon()
            // Focus the card FIRST so ←→/Enter drive it immediately (approval before typing).
            DispatchQueue.main.async { [weak self, weak card] in
                if let card { self?.window?.makeFirstResponder(card) }
            }
        }
        if !approvalActive { startApprovals() }
    }
    private func startApprovals() {
        guard !approvalActive, !approvalQueue.isEmpty else { return }
        approvalActive = true
        pauseStart = Date()                 // pause the elapsed timer
        current?.setWaiting(true)
        onAttention?(true)                  // rail/tab: needs input
        approvalQueue.removeFirst()()
    }
    private func advanceApprovals() {
        if !approvalQueue.isEmpty {
            approvalQueue.removeFirst()()   // next card grabs focus itself
            return
        }
        approvalActive = false
        if let ps = pauseStart { pausedTotal += Date().timeIntervalSince(ps); pauseStart = nil }
        current?.setWaiting(false)
        onAttention?(false)
        focusInput(force: true)             // back to the message field
    }

    // Live mode switch: no restart, so an in-flight turn keeps running.
    @objc private func modeChanged() {
        session?.setPermissionMode(cliMode)
        addSystem("권한 모드: \(modes[modeIndex].0)")
    }
    private func cycleMode() {
        modePopup.selectItem(at: (modeIndex + 1) % modes.count)
        modeChanged()
    }

    // ---- send / turn lifecycle ----
    @objc private func sendFromInput() {
        if !slash.isHidden { acceptSlash(); return }
        let text = input.stringValue.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty, session != nil else { return }
        input.stringValue = ""; hideSlash()
        if text.hasPrefix("/"), handleSlash(text) { return }   // riven-handled slash commands
        if !titleSet { titleSet = true; onTitle?(ChatPanel.shortTitle(text)) }   // rail/tab title
        addUser(text)
        // A turn is still running (or awaiting approval): QUEUE this message instead of
        // clobbering the live turn's state — sending mid-turn wiped sub-agents and wedged the
        // session. It's sent when the current turn finishes.
        if turnStart != nil { queuedMessages.append(text); return }
        beginTurn(text)
    }
    private var queuedMessages: [String] = []
    var onResumeRequest: (() -> Void)?
    private var lastUsage: ChatUsage?

    // Handle riven's client-side slash commands; return true if consumed. Others (custom
    // commands, passthrough built-ins) return false and go to the CLI as a normal message.
    private func handleSlash(_ text: String) -> Bool {
        let cmd = String(text.dropFirst()).split(separator: " ").first.map(String.init) ?? ""
        switch cmd {
        case "clear":
            stack.arrangedSubviews.forEach { $0.removeFromSuperview() }
            current = nil; clearSubagents(); stopFlush(); turnStart = nil; queuedMessages.removeAll()
            return true
        case "resume":
            let sessions = listSessions()
            if sessions.isEmpty { addSystem("이 워크스페이스에 이전 세션이 없습니다."); return true }
            let opts: [(String, () -> Void)] = sessions.map { s in
                let label = (s.title.isEmpty ? String(s.id.prefix(8)) : s.title) + "  ·  " + s.date
                return (label, { [weak self] in self?.switchSession(to: s.id) })
            }
            presentChoice("이어서 열 세션 선택", options: opts)
            return true
        case "model":
            pickModel(); return true
        case "cost", "context":
            if let u = lastUsage {
                addSystem("최근 턴 · ↑\(ChatText.tokens(u.input + u.cacheWrite)) ↓\(ChatText.tokens(u.output)) 토큰 · 캐시 \(ChatText.tokens(u.cacheRead))")
            } else { addSystem("아직 사용량 정보가 없습니다.") }
            return true
        case "compact":
            addSystem("컨텍스트는 한도에 가까워지면 자동으로 압축됩니다. headless 세션에선 수동 /compact 이 지원되지 않습니다.")
            return true
        case "mcp":
            let servers = session?.mcpServers ?? []
            let riven = (session?.toolList ?? []).filter { $0.hasPrefix("mcp__riven__") }
            var lines = ["연결된 MCP 서버:"]
            lines += servers.isEmpty ? ["· (없음)"] : servers.map { "· \($0.name) — \($0.status)" }
            if !riven.isEmpty { lines.append("· riven (내장) — \(riven.map { $0.replacingOccurrences(of: "mcp__riven__", with: "") }.joined(separator: ", "))") }
            addSystem(lines.joined(separator: "\n"))
            return true
        case "config":
            onOpenSettings?(); return true
        case "permissions":
            addSystem("권한 모드: \(modes[modeIndex].0) — Shift+Tab 또는 하단 모드 셀렉터로 전환 (계획/승인 요청/자동 실행).")
            return true
        case "status":
            var s = ["모델: \(model ?? "?")", "권한: \(modes[modeIndex].0)"]
            if let u = lastUsage { s.append("최근 턴 ↑\(ChatText.tokens(u.input + u.cacheWrite)) ↓\(ChatText.tokens(u.output))") }
            if let sid = session?.sessionId { s.append("세션 \(sid.prefix(8))") }
            addSystem(s.joined(separator: " · ")); return true
        case "init":
            sendPrompt("이 프로젝트를 분석해서 CLAUDE.md 파일을 생성하거나 업데이트해줘."); return true
        case "review":
            sendPrompt("최근 변경사항(git diff)을 리뷰해서 버그와 개선점을 알려줘."); return true
        case "agents":
            addSystem("서브에이전트는 Task 도구로 자동 실행되며, 실행 중이면 오른쪽에 컬럼으로 표시됩니다.")
            return true
        case "help":
            addSystem("리븐 네이티브 채팅 · /clear 지우기 · /resume 이전세션 · /model 모델 · /cost·/status 사용량 · /mcp 서버 · /config 설정 · /init·/review 실행 · Shift+Tab 권한모드")
            return true
        default:
            return false      // pass through to the CLI (custom commands etc.)
        }
    }
    // Send an expanded prompt as if the user typed it (for /init, /review).
    private func sendPrompt(_ text: String) {
        if !titleSet { titleSet = true; onTitle?(ChatPanel.shortTitle(text)) }
        addUser(text)
        if turnStart != nil { queuedMessages.append(text) } else { beginTurn(text) }
    }
    // Live model switch (control channel) via a small menu — the CLI accepts aliases.
    private func pickModel() {
        let models: [(String, String)] = [("기본", "default"), ("Opus", "opus"), ("Sonnet", "sonnet"), ("Haiku", "haiku")]
        let menu = NSMenu()
        for (label, id) in models {
            let item = NSMenuItem(title: label, action: #selector(pickModelItem(_:)), keyEquivalent: "")
            item.target = self; item.representedObject = id
            menu.addItem(item)
        }
        // Pop up near the composer, in this view's coordinate space.
        let anchor = convert(input.frame.origin, from: input.superview)
        menu.popUp(positioning: nil, at: anchor, in: self)
    }
    @objc private func pickModelItem(_ item: NSMenuItem) {
        guard let id = item.representedObject as? String else { return }
        session?.setModel(id)
        addSystem("모델: \(item.title)")
        focusInput(force: true)
    }
    private func beginTurn(_ text: String) {
        clearSubagents()               // fresh turn → clear the previous turn's sub-agent panes
        current = newBlock()
        current?.startWorking()
        turnStart = Date(); pausedTotal = 0; pauseStart = nil; startFlush()
        onBusyChange?(true)
        session?.send(text)
        scrollSoon()
    }
    private func newBlock() -> TurnBlock {
        let block = TurnBlock()
        block.translatesAutoresizingMaskIntoConstraints = false
        stack.addArrangedSubview(block)
        block.widthAnchor.constraint(equalTo: stack.widthAnchor, constant: -24).isActive = true
        return block
    }

    // ---- sub-agent panes (right split, one column each — a nested riven-style pane layout) ----
    private func addSubagentPane(_ id: String, type: String, desc: String) {
        let pane = SubagentPane(type: type, desc: desc)
        pane.translatesAutoresizingMaskIntoConstraints = false
        pane.onClose = { [weak self, weak pane] in
            guard let self, let pane else { return }
            subToPane[id] = nil
            pane.removeFromSuperview()
            if subToPane.isEmpty { showSubSide(false) }
        }
        subStack.addArrangedSubview(pane)
        pane.heightAnchor.constraint(equalTo: subStack.heightAnchor).isActive = true   // fillEqually sets width
        subToPane[id] = pane
        showSubSide(true)
    }
    private func clearSubagents() {
        subStack.arrangedSubviews.forEach { $0.removeFromSuperview() }
        subToPane.removeAll()
        showSubSide(false)
    }

    private func startFlush() {
        flushTimer?.invalidate()
        flushTimer = Timer.scheduledTimer(withTimeInterval: 0.05, repeats: true) { [weak self] _ in
            guard let self, let block = self.current, let start = self.turnStart else { return }
            let grew = block.flush()
            block.tick(Int(Date().timeIntervalSince(start) - self.pausedTotal))   // exclude approval wait
            if grew { self.scrollToBottom() }
        }
    }
    private func stopFlush() { flushTimer?.invalidate(); flushTimer = nil }

    private func endTurn(cost: Double?, usage: ChatUsage?) {
        let secs = turnStart.map { Int(Date().timeIntervalSince($0) - pausedTotal) } ?? 0
        stopFlush()
        lastUsage = usage
        let block = current
        block?.finish(secs: secs, cost: cost, usage: usage, model: model)
        turnStart = nil
        scrollToBottom()
        // Show how much of the plan quota is used (account 5-hour / weekly window, from the
        // OAuth usage API) — updates after each turn so you can watch it climb.
        Usage.limits { lim in
            DispatchQueue.main.async {
                block?.setQuota(sessionUsed: lim.sessionRemaining.map { 100 - $0 },
                                weeklyUsed: lim.weeklyRemaining.map { 100 - $0 })
            }
        }
        // Send the next queued user message (typed while this turn was running).
        if !queuedMessages.isEmpty { beginTurn(queuedMessages.removeFirst()) }
        else { onBusyChange?(false) }
        // NOTE: no plan-quota % here. The OAuth usage API gives only account-wide 5-hour/weekly
        // utilization (e.g. 36%/9%), which is NOT this turn's share and reads as misleading next
        // to a 5k-token turn. Per-turn quota % isn't derivable (no absolute budget from the API).
    }

    // ---- stack helpers ----
    private func addUser(_ text: String) {
        let v = UserBubble(text: text)
        v.translatesAutoresizingMaskIntoConstraints = false
        stack.addArrangedSubview(v)
        v.widthAnchor.constraint(equalTo: stack.widthAnchor, constant: -24).isActive = true
        scrollSoon()
    }
    private func addSystem(_ text: String) {
        let l = NSTextField(wrappingLabelWithString: text)
        l.font = UIScale.font(10); l.textColor = Theme.fgDim
        l.translatesAutoresizingMaskIntoConstraints = false
        stack.addArrangedSubview(l)
        l.widthAnchor.constraint(equalTo: stack.widthAnchor, constant: -24).isActive = true
        scrollSoon()
    }
    private func scrollSoon() { DispatchQueue.main.async { [weak self] in self?.scrollToBottom() } }
    // Pin the clip view to the very bottom of the (flipped) document so streaming stays in view.
    private func scrollToBottom() {
        layoutSubtreeIfNeeded()
        let clip = scroll.contentView
        let y = max(0, stack.frame.height - clip.bounds.height)
        clip.setBoundsOrigin(NSPoint(x: 0, y: y))
        scroll.reflectScrolledClipView(clip)
    }

    // ---- slash-command autocomplete ----
    func controlTextDidChange(_ obj: Notification) {
        let s = input.stringValue
        guard s.hasPrefix("/"), !s.contains(" ") else { hideSlash(); return }
        let q = String(s.dropFirst()).lowercased()
        let matches = commands.filter { q.isEmpty || $0.name.lowercased().hasPrefix(q) }
        if matches.isEmpty { hideSlash() } else { showSlash(matches) }
    }
    // Route Shift+Tab (mode cycle) and, when the popup is up, arrows / Enter / Esc.
    func control(_ control: NSControl, textView: NSTextView, doCommandBy sel: Selector) -> Bool {
        if sel == #selector(NSResponder.insertBacktab(_:)) { cycleMode(); return true }
        guard !slash.isHidden else { return false }
        switch sel {
        case #selector(NSResponder.moveUp(_:)):          slash.move(-1); return true
        case #selector(NSResponder.moveDown(_:)):        slash.move(1);  return true
        case #selector(NSResponder.insertNewline(_:)):   acceptSlash();  return true
        case #selector(NSResponder.cancelOperation(_:)): hideSlash();    return true
        default: return false
        }
    }
    private func showSlash(_ list: [SlashCommand]) {
        slash.set(list)
        slashHeight.constant = min(CGFloat(list.count) * SlashPopup.rowH + 8, 220)
        slash.isHidden = false
    }
    private func hideSlash() { slash.isHidden = true; slashHeight.constant = 0 }
    private func acceptSlash() {
        if let cmd = slash.current() { input.stringValue = "/" + cmd.name }   // no trailing space
        hideSlash()
        window?.makeFirstResponder(input)
        input.currentEditor()?.selectedRange = NSRange(location: input.stringValue.count, length: 0)
    }

    // Claude Code's standard slash commands (for CLI-parity autocomplete) + custom commands
    // from .claude/commands. riven handles the useful ones itself (see handleSlash); the rest
    // pass through to the CLI (custom commands run; a few TUI-only built-ins may report back).
    private static let builtins: [SlashCommand] = [
        .init(name: "clear", desc: "대화 지우기"),
        .init(name: "compact", desc: "대화 압축"),
        .init(name: "context", desc: "컨텍스트 사용량"),
        .init(name: "cost", desc: "토큰 사용량"),
        .init(name: "config", desc: "설정"),
        .init(name: "help", desc: "도움말"),
        .init(name: "init", desc: "CLAUDE.md 생성"),
        .init(name: "mcp", desc: "MCP 서버"),
        .init(name: "memory", desc: "메모리 편집"),
        .init(name: "model", desc: "모델 변경"),
        .init(name: "permissions", desc: "권한 설정"),
        .init(name: "resume", desc: "이전 세션 열기"),
        .init(name: "review", desc: "코드 리뷰"),
        .init(name: "agents", desc: "서브에이전트"),
        .init(name: "status", desc: "상태")
    ]
    private static func discoverCommands(cwd: String) -> [SlashCommand] {
        var out = builtins
        let fm = FileManager.default
        let home = fm.homeDirectoryForCurrentUser.path
        for root in ["\(cwd)/.claude/commands", "\(home)/.claude/commands"] {
            let rootURL = URL(fileURLWithPath: root)
            guard let e = fm.enumerator(at: rootURL, includingPropertiesForKeys: nil) else { continue }
            for case let url as URL in e where url.pathExtension == "md" {
                // namespace by subdir: commands/foo/bar.md → /foo:bar (matches Claude Code)
                let rel = url.deletingPathExtension().path.replacingOccurrences(of: root + "/", with: "")
                let name = rel.replacingOccurrences(of: "/", with: ":")
                if out.contains(where: { $0.name == name }) { continue }
                out.append(SlashCommand(name: name, desc: describe(url)))
            }
        }
        return out
    }
    // Prefer YAML frontmatter `description` (+ `argument-hint`); else the first prose line.
    private static func describe(_ url: URL) -> String {
        guard let text = try? String(contentsOf: url, encoding: .utf8) else { return "사용자 명령" }
        var desc = "", hint = ""
        let lines = text.components(separatedBy: "\n")
        if lines.first == "---" {
            for l in lines.dropFirst() {
                if l == "---" { break }
                if l.hasPrefix("description:") { desc = String(l.dropFirst(12)).trimmingCharacters(in: .whitespaces.union(CharacterSet(charactersIn: "\"'"))) }
                if l.hasPrefix("argument-hint:") { hint = String(l.dropFirst(14)).trimmingCharacters(in: .whitespaces.union(CharacterSet(charactersIn: "\"'"))) }
            }
        }
        if desc.isEmpty {
            desc = lines.first(where: { !$0.isEmpty && $0 != "---" })
                .map { $0.replacingOccurrences(of: "#", with: "").trimmingCharacters(in: .whitespaces) } ?? "사용자 명령"
        }
        let full = hint.isEmpty ? desc : "\(hint)  —  \(desc)"
        return String(full.prefix(60))
    }
}
