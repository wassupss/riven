import AppKit

// Native chat panel: drives `claude` headless (ClaudeChatSession, subscription auth) and
// renders a rich custom chat — not the terminal TUI, not a WebView. Each user turn produces
// a TurnBlock with a thinking/writing/elapsed header + token usage; main-thread tokens stream
// with a smooth typewriter reveal interleaved with tool lines (edits show a diff); sub-agents
// get their own lane. A permission-mode selector — cyclable with Shift+Tab like the CLI —
// includes an interactive "승인 요청" mode that pops an approval card per tool call. A
// scrollable slash-command popup autocompletes `/` commands.
final class ChatPanel: NSView, Themable, Scalable {
    private let scroll = NSScrollView()                   // conversation
    /// 계획 모드 결과 배지 — CLI가 ~/.claude/plans/<slug>.md 로 저장한 계획의 제목을
    /// 대화 오른쪽 위에 살짝 겹쳐 띄운다. 계획대로 작업이 도는 동안 계속 보인다.
    private let planBadge = PlanBadge()
    private var planPath: String?
    private let stack = FlippedStack()
    private let subSide = NSScrollView()                  // right side: sub-agent panes
    private var subWidthShown: NSLayoutConstraint!        // sub area = 45% (when sub-agents run)
    private var subWidthHidden: NSLayoutConstraint!       // sub area = 0 (default)
    private let subStack = FlippedStack()
    private let input = ChatInput.make()
    private lazy var inputScroll = InputScroll(input)     // grows 1→6 lines, then scrolls
    private let sendButton = CircleButton()               // circular ↑ / ■ (send / stop), accent
    private let plusButton = CircleButton()               // circular + (attach a file path)
    private let modePopup = NSPopUpButton(frame: .zero, pullsDown: false)
    private let composer = NSVisualEffectView()          // glass composer card (input on top, action row below)
    private let modeChip = NSView()                      // pill behind the compact mode popup
    private let hairline = NSView()
    private let slash = SlashPopup()
    private var slashHeight: NSLayoutConstraint!
    private var stackWidth: NSLayoutConstraint!        // transcript width = clip width
    private var frozenWidth: NSLayoutConstraint?       // pinned while a divider is being dragged

    private var session: ClaudeChatSession?
    private var workspace: URL?
    private var current: TurnBlock?
    private var subToPane: [String: SubagentPane] = [:]   // sub-agent id → its split pane
    private var turnStart: Date?
    private var flushTimer: Timer?
    private var model: String?
    /// Model this pane was started with ("opus"/"sonnet"/... , nil = account default). Set before
    /// the session starts (agent groups pick one per agent) and persisted with the layout.
    var preferredModel: String?
    private var commands: [SlashCommand] = []
    private var lastScaleFactor: CGFloat = 1
    private var pendingResume: String?                   // resume this session id on next bind
    var agentPersona: String?                            // run this pane as `claude --agent <name>`
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
    // Computed, not stored: the labels must follow a live language switch.
    private var modes: [(String, String)] { [(t("chat.mode.plan"), "plan"), (t("chat.mode.ask"), "default"), (t("chat.mode.auto"), "auto")] }
    private var modeIndex: Int { max(0, modePopup.indexOfSelectedItem) }
    private var cliMode: String { modeIndex == 0 ? "plan" : "default" }

    var onFocused: (() -> Void)?
    var onOpenFile: ((URL) -> Void)?
    var onOpenFileAt: ((URL, Int) -> Void)?
    var onEditedFile: ((String) -> Void)?   // agent edited a file → record it in the Changes panel
    var onListAgents: (() -> [String])?         // .claude/agents names (project + user)
    var onOpenAgentChat: ((String?) -> Void)?   // open a NEW chat pane running `claude --agent <name>`
    var onAgentPanes: (() -> String)?                                     // peers this agent can talk to
    var onAskAgent: ((String, String, @escaping (String) -> Void) -> Void)?  // delegate work to a peer
    /// Fan out to several peers at once; the callback fires when every one of them has answered.
    var onAskAgents: (([(agent: String, message: String)], @escaping ([(String, String)]) -> Void) -> Void)?
    var onOpenSubagentPane: ((_ id: String, _ view: NSView, _ title: String) -> Void)?   // place as a dock panel
    var onCloseSubagentPanes: ((_ ids: [String]) -> Void)?
    var onShowEdit: ((URL, String, String) -> Void)?
    // Rail/tab integration (mirrors agent terminal panes): busy while a turn runs, attention
    // while awaiting approval, and a title from the first message.
    var onBusyChange: ((Bool) -> Void)?
    var onAttention: ((Bool) -> Void)?
    var onTitle: ((String) -> Void)?
    var onSessionId: ((String) -> Void)?    // report the CLI session id so the pane can be resumed on relaunch
    var onOpenSettings: (() -> Void)?       // /config
    private let attnRing = AttnRingView(frame: .zero)
    // Live-edge scrolling (shadcn MessageScroller behavior): only auto-follow the bottom while the
    // reader is AT the bottom; if they scroll up to read, stop yanking and show a jump-to-latest pill.
    private let jumpButton = CircleButton()
    private var stickToBottom = true
    // busy = static ring, attn = travelling ember, nil = none (mirrors TerminalView).
    func setRingState(_ badge: String?) {
        switch badge { case "attn": attnRing.state = .attn; case "busy": attnRing.state = .busy; default: attnRing.state = .none }
    }
    private var titleSet = false
    private var sessionId: String?          // current CLI session id (for reading the AI title)
    private var aiTitleSet = false          // once the CLI's summarized title is applied, stop overriding

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
        modeChip.layer?.cornerRadius = UIScale.pt(28) / 2   // same height as the +/send circles
        modeChip.translatesAutoresizingMaskIntoConstraints = false

        // modePopup stays the single source of truth for the mode (index read via modeIndex,
        // set by cycleMode/approval cards) — just restyled compact & borderless inside the chip,
        // so its title updates itself on every selectItem(at:).
        modePopup.addItems(withTitles: modes.map { $0.0 })
        // Restore the last-used permission mode (persisted globally) — before it always reset to
        // "승인 요청" on every new/reopened pane. Read BEFORE bind() so startSession picks it up.
        modePopup.selectItem(at: min(max(Settings.shared.int("chatPermMode", 1), 0), modes.count - 1))
        modePopup.font = UIScale.font(UIScale.caption, .medium)
        modePopup.controlSize = .small
        modePopup.isBordered = false
        modePopup.toolTip = t("chat.mode.tip")
        modePopup.target = self; modePopup.action = #selector(modeChanged)
        modePopup.translatesAutoresizingMaskIntoConstraints = false

        input.placeholder = t("chat.placeholder")
        input.onSubmit = { [weak self] in self?.sendFromInput() }
        input.onTextChange = { [weak self] in self?.inputChanged() }
        input.onKey = { [weak self] sel in self?.inputKey(sel) ?? false }
        input.onFocus = { [weak self] in self?.onFocused?() }   // clicking the input clears the "done" ember

        // Circular ↑ send button (shadcn message-scroller style) — no "보내기" text pill.
        // CircleButton keeps it a perfect circle; sizes match the mode chip via `rowH`.
        sendButton.isBordered = false; sendButton.bezelStyle = .regularSquare
        sendButton.imagePosition = .imageOnly
        sendButton.wantsLayer = true                        // layer must exist before styleSendButton sets bg
        sendButton.target = self; sendButton.action = #selector(sendOrStop)
        sendButton.translatesAutoresizingMaskIntoConstraints = false
        // Circular + button on the left of the action row — attaches a file path to the message.
        plusButton.isBordered = false; plusButton.bezelStyle = .regularSquare
        plusButton.imagePosition = .imageOnly
        plusButton.wantsLayer = true
        plusButton.toolTip = t("chat.attachFile")
        plusButton.target = self; plusButton.action = #selector(attachFile)
        plusButton.translatesAutoresizingMaskIntoConstraints = false

        slash.translatesAutoresizingMaskIntoConstraints = false

        // Jump-to-latest pill: a small circular ↓ that floats above the composer, shown only when
        // the reader has scrolled up off the live edge. Click → snap to bottom + resume following.
        jumpButton.bezelStyle = .regularSquare; jumpButton.isBordered = false
        jumpButton.wantsLayer = true
        jumpButton.imagePosition = .imageOnly
        jumpButton.toolTip = t("chat.toBottom")
        jumpButton.target = self; jumpButton.action = #selector(jumpToLatest)
        jumpButton.isHidden = true
        jumpButton.translatesAutoresizingMaskIntoConstraints = false

        modeChip.addSubview(modePopup)
        [modeChip, plusButton, inputScroll, sendButton].forEach { composer.addSubview($0) }
        [scroll, subSide, hairline, composer, slash, jumpButton, planBadge].forEach { addSubview($0) }
        planBadge.isHidden = true
        planBadge.onOpen = { [weak self] in
            guard let self, let p = self.planPath else { return }
            self.onOpenFile?(URL(fileURLWithPath: p))
        }
        applyComposerTheme()
        stackWidth = stack.widthAnchor.constraint(equalTo: scroll.contentView.widthAnchor)
        slashHeight = slash.heightAnchor.constraint(equalToConstant: 0)
        subWidthShown = subSide.widthAnchor.constraint(equalTo: widthAnchor, multiplier: 0.45)
        subWidthHidden = subSide.widthAnchor.constraint(equalToConstant: 0)
        NSLayoutConstraint.activate([
            // conversation (left) | sub-agent area (right), sized by subWidthHidden/Shown
            // 대화 오른쪽 위에 살짝 걸치게 (CLI의 계획 배지와 같은 자리).
            planBadge.trailingAnchor.constraint(equalTo: scroll.trailingAnchor, constant: -10),
            planBadge.topAnchor.constraint(equalTo: topAnchor, constant: 6),
            planBadge.widthAnchor.constraint(lessThanOrEqualTo: widthAnchor, multiplier: 0.6),
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
            stackWidth,   // clip width → no h-overflow jitter (pinned during live resize)
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
            // shadcn message-scroller composer: TWO rows in a rounded card — the multiline input on
            // top, an action row below (mode chip + "+" on the left, circular ↑ send on the right).
            // Floor only; the composer HUGS the input via the equality top/bottom pins + the input's
            // high vertical content hugging (kept at its intrinsic 1–6 line size).
            composer.heightAnchor.constraint(greaterThanOrEqualToConstant: UIScale.pt(72)),
            // row 1: input, full width, top of the card
            inputScroll.topAnchor.constraint(equalTo: composer.topAnchor, constant: 10),
            inputScroll.leadingAnchor.constraint(equalTo: composer.leadingAnchor, constant: 12),
            inputScroll.trailingAnchor.constraint(equalTo: composer.trailingAnchor, constant: -12),
            inputScroll.bottomAnchor.constraint(equalTo: sendButton.topAnchor, constant: -8),
            // row 2 (bottom): mode chip + "+" left, send right — ALL the same height (rowH=28) and
            // vertically centered on one line, so the circles and the chip line up.
            modeChip.leadingAnchor.constraint(equalTo: composer.leadingAnchor, constant: 8),
            modeChip.centerYAnchor.constraint(equalTo: sendButton.centerYAnchor),
            modeChip.heightAnchor.constraint(equalToConstant: UIScale.pt(28)),
            modePopup.leadingAnchor.constraint(equalTo: modeChip.leadingAnchor, constant: 8),
            modePopup.trailingAnchor.constraint(equalTo: modeChip.trailingAnchor, constant: -4),
            modePopup.centerYAnchor.constraint(equalTo: modeChip.centerYAnchor),
            plusButton.leadingAnchor.constraint(equalTo: modeChip.trailingAnchor, constant: 6),
            plusButton.centerYAnchor.constraint(equalTo: sendButton.centerYAnchor),
            plusButton.widthAnchor.constraint(equalToConstant: UIScale.pt(28)),
            plusButton.heightAnchor.constraint(equalToConstant: UIScale.pt(28)),
            sendButton.trailingAnchor.constraint(equalTo: composer.trailingAnchor, constant: -8),
            sendButton.bottomAnchor.constraint(equalTo: composer.bottomAnchor, constant: -8),
            sendButton.heightAnchor.constraint(equalToConstant: UIScale.pt(28)),
            sendButton.widthAnchor.constraint(equalToConstant: UIScale.pt(28)),
            // slash popup floats just above the composer card
            slash.leadingAnchor.constraint(equalTo: composer.leadingAnchor),
            slash.trailingAnchor.constraint(equalTo: composer.trailingAnchor),
            slash.bottomAnchor.constraint(equalTo: composer.topAnchor, constant: -6),
            slashHeight,
            // jump pill floats centered just above the composer
            jumpButton.centerXAnchor.constraint(equalTo: scroll.centerXAnchor),
            jumpButton.bottomAnchor.constraint(equalTo: hairline.topAnchor, constant: -10),
            jumpButton.widthAnchor.constraint(equalToConstant: UIScale.pt(30)),
            jumpButton.heightAnchor.constraint(equalToConstant: UIScale.pt(30))
        ])
        // Follow user scrolling: update stick + pill visibility whenever the clip moves.
        scroll.contentView.postsBoundsChangedNotifications = true
        NotificationCenter.default.addObserver(self, selector: #selector(clipMoved),
            name: NSView.boundsDidChangeNotification, object: scroll.contentView)
        // Same travelling-ember state ring as agent terminal panes, driven by setRingState.
        attnRing.frame = bounds; attnRing.autoresizingMask = [.width, .height]
        addSubview(attnRing)
        lastScaleFactor = UIScale.pt(100) / 100        // capture current factor for later ratios
        registerForDraggedTypes([.fileURL, .string])   // drag a file → path, or selected text → snippet
        Theme.register(self)
        UIScale.register(self)
        // Live language switch: re-label the chrome that was built once at init (the transcript
        // keeps the language each message was written in, like the rest of the app).
        NotificationCenter.default.addObserver(forName: .rivenLanguageChanged, object: nil, queue: .main) { [weak self] _ in
            self?.relocalize()
        }
        // A divider drag re-wraps every rendered message on every frame (~15ms measured). Freeze the
        // transcript width for the drag and reflow once when it ends.
        NotificationCenter.default.addObserver(forName: .rivenDividerDragBegan, object: nil, queue: .main) { [weak self] _ in
            self?.freezeTranscriptWidth()
        }
        NotificationCenter.default.addObserver(forName: .rivenDividerDragEnded, object: nil, queue: .main) { [weak self] _ in
            self?.thawTranscriptWidth()
        }
    }
    required init?(coder: NSCoder) { fatalError() }
    deinit { NotificationCenter.default.removeObserver(self) }

    private func relocalize() {
        input.placeholder = t("chat.placeholder")
        plusButton.toolTip = t("chat.attachFile")
        jumpButton.toolTip = t("chat.toBottom")
        modePopup.toolTip = t("chat.mode.tip")
        let sel = modeIndex
        modePopup.removeAllItems()
        modePopup.addItems(withTitles: modes.map { $0.0 })
        modePopup.selectItem(at: min(sel, modes.count - 1))
        commands = workspace.map { ChatPanel.discoverCommands(cwd: $0.path) } ?? commands
        styleSendButton()
    }

    // Shown again (workspace switched back): catch the typewriter up to everything buffered while
    // offscreen and pin to the bottom — the flush timer does no UI work while window == nil.
    // A drag changes our width every frame, and each rendered message is a wrapping label whose
    // height must be recomputed — measured at ~15ms/frame with a restored transcript, i.e. the whole
    // 60fps budget. The text can't reflow usefully mid-drag anyway, so freeze the document while the
    // divider is moving and do ONE layout when the user lets go.
    private func freezeTranscriptWidth() {
        guard frozenWidth == nil, stack.frame.width > 1, window != nil else { return }
        stackWidth.isActive = false
        let w = stack.widthAnchor.constraint(equalToConstant: stack.frame.width)
        w.isActive = true; frozenWidth = w
    }
    private func thawTranscriptWidth() {
        guard let w = frozenWidth else { return }
        w.isActive = false; frozenWidth = nil
        stackWidth.isActive = true
        layoutSubtreeIfNeeded()
        if stickToBottom { scrollToBottom() }
    }
    override func viewWillStartLiveResize() {
        super.viewWillStartLiveResize()
        guard frozenWidth == nil, stack.frame.width > 1 else { return }
        stackWidth.isActive = false                       // stop tracking the clip width…
        let w = stack.widthAnchor.constraint(equalToConstant: stack.frame.width)
        w.isActive = true; frozenWidth = w                // …and hold the current one instead
    }
    override func viewDidEndLiveResize() {
        super.viewDidEndLiveResize()
        guard let w = frozenWidth else { return }
        w.isActive = false; frozenWidth = nil
        stackWidth.isActive = true                        // one reflow, at the final width
        layoutSubtreeIfNeeded()
        if stickToBottom { scrollToBottom() }
    }
    override func viewDidMoveToWindow() {
        super.viewDidMoveToWindow()
        guard window != nil else { return }
        while current?.flush() == true {}   // reveal any text buffered offscreen (bounded by content)
        scrollToBottom()
        // The dock lays out AFTER this callback, so the height used above can be stale — which
        // intermittently left the transcript scrolled up after a workspace switch. Re-pin to the
        // bottom on the next runloop (and once more) when the geometry is final.
        DispatchQueue.main.async { [weak self] in self?.scrollToBottom() }
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.05) { [weak self] in self?.scrollToBottom() }
    }

    func applyTheme() {
        layer?.backgroundColor = Theme.bg.cgColor
        hairline.layer?.backgroundColor = Theme.hairline.cgColor
        applyComposerTheme()
    }
    // Glass + chip + send-pill colors, all Theme tokens (re-applied on theme switch). The
    // effect view's appearance follows the riven theme, not the system, so the blur matches.
    private var running = false
    private func applyComposerTheme() {
        composer.appearance = NSAppearance(named: Theme.isLight ? .aqua : .darkAqua)
        composer.layer?.borderColor = Theme.edge.cgColor
        modeChip.layer?.backgroundColor = Theme.hover.cgColor
        input.textColor = Theme.fg
        jumpButton.fillColor = Theme.hover
        jumpButton.strokeColor = Theme.edge
        jumpButton.strokeWidth = 1
        jumpButton.contentTintColor = Theme.fg
        plusButton.fillColor = Theme.hover
        plusButton.strokeColor = Theme.edge
        plusButton.strokeWidth = 1
        plusButton.contentTintColor = Theme.fg
        scaleIcons()   // sets +, ↑, ↓ images at the current zoom (also (re)styles the send button)
    }
    // Send pill ⇄ stop pill: while a turn runs the button interrupts (danger tint, "중단").
    private func setRunning(_ r: Bool) { running = r; styleSendButton() }
    private func styleSendButton() {
        let stop = running
        // Circular accent button: ↑ to send, ■ to stop while a turn runs.
        sendButton.fillColor = stop ? Theme.danger : Theme.accent
        sendButton.image = NSImage(systemSymbolName: stop ? "stop.fill" : "arrow.up",
                                   accessibilityDescription: stop ? t("chat.stop") : t("chat.send"))?
            .withSymbolConfiguration(.init(pointSize: UIScale.pt(stop ? 10 : 13), weight: .semibold))
        // Contrast against the fill by its luminance — a flat .white vanished on light accents
        // (e.g. the "void" theme's near-white accent left the arrow invisible).
        sendButton.contentTintColor = ChatPanel.onColor(stop ? Theme.danger : Theme.accent)
    }
    // The composer's SF-symbol icons have an explicit point size, so they must be re-set on ⌘+/−
    // (unlike text, which the tree walk handles). Keeps the +, ↑ and ↓ glyphs in step with the zoom.
    private func scaleIcons() {
        plusButton.image = NSImage(systemSymbolName: "plus", accessibilityDescription: t("chat.attach"))?
            .withSymbolConfiguration(.init(pointSize: UIScale.pt(12), weight: .semibold))
        jumpButton.image = NSImage(systemSymbolName: "arrow.down", accessibilityDescription: t("chat.toBottom"))?
            .withSymbolConfiguration(.init(pointSize: UIScale.pt(12), weight: .semibold))
        styleSendButton()
    }
    // Pick black or white for whichever reads on top of `bg`.
    static func onColor(_ bg: NSColor) -> NSColor {
        let c = bg.usingColorSpace(.sRGB) ?? bg
        let lum = 0.299 * c.redComponent + 0.587 * c.greenComponent + 0.114 * c.blueComponent
        return lum > 0.6 ? .black : .white
    }

    // ⌘+/⌘−/⌘0: rescale every font in the panel (incl. already-rendered messages) by the ratio of
    // the new factor to the last one. Applied IMMEDIATELY (not debounced): the old 0.12s debounce
    // left a window where content rendered between the zoom and the deferred rescale was scaled off
    // the wrong base — so freshly-typed messages ended up a different size than older ones. The
    // transcript is capped at 150 views, so an immediate walk is cheap enough for key auto-repeat.
    func applyScale() {
        let factor = UIScale.pt(100) / 100
        let ratio = factor / max(lastScaleFactor, 0.01)
        lastScaleFactor = factor
        guard abs(ratio - 1) > 0.001 else { return }
        ChatPanel.rescale(self, ratio)
        scaleIcons()                          // composer icons have fixed point sizes
        inputScroll.invalidateIntrinsicContentSize()   // grow the composer for the new input font
    }
    private static func rescale(_ v: NSView, _ ratio: CGFloat) {
        if let tv = v as? NSTextView {
            // NSTextView (the multiline composer) isn't an NSControl, so it was silently skipped —
            // that's why ⌘+/− didn't grow the input. Scale its font and re-measure its height.
            if let f = tv.font { tv.font = f.withSize(f.pointSize * ratio) }
            tv.invalidateIntrinsicContentSize()
            tv.needsDisplay = true
        } else if let tf = v as? NSTextField {
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
    /// 답을 기다리는 카드가 떠 있으면 입력창이 아니라 그 카드로 포커스를 준다. 패널을 클릭해
    /// 활성화했을 때 카드가 아니라 입력창이 잡혀서, 카드가 보이는데도 ←→/Enter 가 먹지 않던
    /// 문제를 없앤다.
    func focusPending() {
        if let card = pendingCard, card.window != nil, card.acceptsFirstResponder {
            window?.makeFirstResponder(card)
            return
        }
        focusInput()
    }
    private weak var pendingCard: ApprovalCard?

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
        input.setSelectedRange(NSRange(location: input.string.count, length: 0))
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
        pendingHistory = []; loadEarlierBtn = nil        // reset the transcript pager
        commands = ChatPanel.discoverCommands(cwd: url.path)
        guard let cmd = AgentDiscovery.claudeCmd() else {
            addSystem(t("chat.noCLI"))
            return
        }
        // The CLI updates itself on the user's own schedule (riven never changes that setting), but
        // riven parses its stream format — so tell the user WHEN it changed, once per new version.
        if let prev = AgentDiscovery.claudeVersionChange(), let now = AgentDiscovery.claudeVersion() {
            addSystem(t("chat.cliChanged", ["prev": prev, "now": now]))
        }
        let resume = pendingResume; pendingResume = nil
        startSession(cmd: cmd, cwd: url.path, resume: resume)
        if let resume {
            loadHistory(cwd: url.path, sessionId: resume)   // replay prior conversation
            sessionId = resume; titleSet = true; refreshAITitle()   // show the CLI's summarized title
        }
    }
    // Stop the underlying process when the pane is closed.
    func teardown() { session?.stop(); session = nil; stopFlush() }

    /// Shown when a group is created: the team roster, so the user (and the agent, since it's in the
    /// transcript) knows who can be delegated to by name.
    func noteTeam(_ group: String, _ names: [String]) {
        addSystem(t("team.created", ["group": group, "names": names.joined(separator: ", ")]))
    }
    /// Another agent delegates work to THIS pane. The message is shown like a user message (so the
    /// hand-off is visible and steerable), and `done` fires with the answer when the turn ends —
    /// queued behind any turn already running, exactly like a message the user types.
    func ask(_ text: String, done: @escaping (String) -> Void) {
        guard session != nil, session?.isAlive != false else { done("agent session is not running"); return }
        askWaiters.append(done)
        let bubble = addUser(text)
        if !titleSet { titleSet = true; onTitle?(ChatPanel.shortTitle(text)) }
        if turnStart != nil { bubble.setQueued(true); queuedMessages.append((text, bubble)) }
        else { beginTurn(text, bubble: bubble) }
    }
    /// Human-readable handle other agents address this pane by (riven_ask_agent). Falls back to the
    /// custom-agent name — "chat-90690212265" is a dock id, not something an agent should have to use.
    var nickname: String?
    /// Agent-group this pane belongs to (nil = standalone chat).
    var groupName: String?
    /// Nickname of the agent this one reports to — the group's org chart / who to escalate to.
    var parentName: String?
    /// This pane's role (nickname › custom agent) and whether it's mid-turn — for riven_agents().
    var agentRole: String { nickname ?? agentPersona ?? "Claude" }
    var isBusy: Bool { turnStart != nil }

    /// 조직도의 상태 칩이 읽는 값. busy 하나로는 "승인을 기다리며 멈춰 있음"과 "도구를 돌리는
    /// 중"이 구분되지 않는데, 병렬로 여러 명을 돌릴 때 정작 사람이 움직여야 하는 건 전자다.
    /// 승인 대기는 추론이 아니라 실제 권한 요청 이벤트(onPermissionRequest → 승인 카드)에서 온다.
    var runState: AgentRunState {
        if approvalActive { return .waiting }
        guard turnStart != nil else { return .idle }
        if let liveTool { return .tool(liveTool) }
        return .thinking
    }
    /// 지금 상태가 시작된 시각. 승인 대기 동안 멈춘 시간은 빼서, 칩의 초가 대화 헤더의
    /// 경과 시간과 어긋나지 않게 한다.
    var runStateSince: Date? {
        guard turnStart != nil, !approvalActive else { return nil }
        return turnStart?.addingTimeInterval(pausedTotal)
    }
    /// 마지막으로 시작된 도구. 어시스턴트 텍스트가 다시 흐르기 시작하면 도구가 끝난 것이므로
    /// 비운다 (도구 종료 이벤트가 따로 오지 않는다).
    private var liveTool: String?

    // ---- code-block actions (called by a code block's button via enclosingChatPanel) ----
    func openCodeInEditor(_ code: String, path: String?) {
        if let path { onOpenFile?(URL(fileURLWithPath: path)); return }
        let tmp = NSTemporaryDirectory() + "riven-snippet-\(abs(code.hashValue)).txt"
        try? code.write(toFile: tmp, atomically: true, encoding: .utf8)
        onOpenFile?(URL(fileURLWithPath: tmp))
    }
    // Reconstruct old/new from our "- …/+ …" diff text and ask the editor to show it inline.
    func showEditFromDiff(_ diff: String, path: String) {
        let lines = diff.components(separatedBy: "\n")
        let old = lines.filter { $0.hasPrefix("- ") }.map { String($0.dropFirst(2)) }.joined(separator: "\n")
        let new = lines.filter { $0.hasPrefix("+ ") }.map { String($0.dropFirst(2)) }.joined(separator: "\n")
        onShowEdit?(URL(fileURLWithPath: path), old, new)
    }

    // A short, CLI-like title from the first message (a heuristic — no extra model call/tokens;
    // a true summary would cost a small request).
    static func shortTitle(_ s: String) -> String {
        var t = s.replacingOccurrences(of: "\n", with: " ").trimmingCharacters(in: .whitespaces)
        if let r = t.range(of: "[.?!。？！]", options: .regularExpression) { t = String(t[..<r.lowerBound]) }
        return t.count > 24 ? String(t.prefix(24)) + "…" : t
    }
    // The CLI writes an AI-summarized title into the transcript as an `ai-title` entry — read the
    // latest one so the pane shows the same concise title the CLI does, instead of the raw first
    // message. Tail-read only (the entry is rewritten each turn, so the last one is near the end).
    static func latestAITitle(cwd: String, sessionId: String) -> String? {
        let enc = cwd.map { $0.isLetter || $0.isNumber ? String($0) : "-" }.joined()
        let url = FileManager.default.homeDirectoryForCurrentUser
            .appendingPathComponent(".claude/projects/\(enc)/\(sessionId).jsonl")
        guard let fh = try? FileHandle(forReadingFrom: url) else { return nil }
        defer { try? fh.close() }
        let size = (try? fh.seekToEnd()) ?? 0
        let window: UInt64 = 256 * 1024
        try? fh.seek(toOffset: size > window ? size - window : 0)
        guard let data = try? fh.readToEnd(), let text = String(data: data, encoding: .utf8) else { return nil }
        var title: String?
        for line in text.split(separator: "\n", omittingEmptySubsequences: true) {
            guard line.contains("ai-title"), let d = line.data(using: .utf8),
                  let o = try? JSONSerialization.jsonObject(with: d) as? [String: Any],
                  o["type"] as? String == "ai-title" else { continue }
            if let t = (o["aiTitle"] as? String)?.trimmingCharacters(in: .whitespacesAndNewlines), !t.isEmpty { title = t }
        }
        return title
    }
    // Adopt the CLI's summarized title once it has produced one.
    //
    // The CLI writes the `ai-title` transcript entry ASYNCHRONOUSLY, shortly AFTER the turn's
    // result event — so reading once at endTurn usually missed it and the pane kept the raw
    // first-message title until the next turn ("타이틀 자동 생성이 안 된다"). Re-check a few times
    // with a backoff and stop as soon as the title changes.
    private var lastAITitle: String?
    /// ExitPlanMode 직후 CLI가 쓴 계획 파일을 집는다. 파일이 쓰이는 타이밍이 도구 이벤트보다
    /// 살짝 늦을 수 있어 0.4/1/2초로 재시도한다.
    private func pickUpPlanFile(attempt: Int) {
        DispatchQueue.global(qos: .utility).async { [weak self] in
            let dir = (NSHomeDirectory() as NSString).appendingPathComponent(".claude/plans")
            let fm = FileManager.default
            let files = (try? fm.contentsOfDirectory(atPath: dir))?.filter { $0.hasSuffix(".md") } ?? []
            let newest = files.map { (dir as NSString).appendingPathComponent($0) }
                .compactMap { path -> (String, Date)? in
                    guard let d = (try? fm.attributesOfItem(atPath: path))?[.modificationDate] as? Date else { return nil }
                    return (path, d)
                }
                .max(by: { $0.1 < $1.1 })
            // 방금(2분 이내) 쓰인 것만 이번 계획으로 인정한다.
            guard let newest, Date().timeIntervalSince(newest.1) < 120 else {
                let delays: [Double] = [0.4, 1, 2]
                guard attempt < delays.count else { return }
                DispatchQueue.main.asyncAfter(deadline: .now() + delays[attempt]) {
                    self?.pickUpPlanFile(attempt: attempt + 1)
                }
                return
            }
            let title = ChatPanel.planTitle(of: newest.0)
            DispatchQueue.main.async {
                guard let self else { return }
                self.planPath = newest.0
                self.planBadge.show(title: title, file: (newest.0 as NSString).lastPathComponent)
                // 세션에 묶어 저장한다 — 재기동해서 이 대화를 이어받으면 배지도 같이 돌아온다.
                if let sid = self.sessionId { Settings.shared.set("plan.\(sid)", newest.0) }
            }
        }
    }
    /// 이 세션에 붙어 있던 계획 배지를 되살린다 (파일이 아직 있을 때만).
    private func restorePlanBadge(_ sid: String) {
        let path = Settings.shared.string("plan.\(sid)", "")
        guard !path.isEmpty, FileManager.default.fileExists(atPath: path) else { return }
        planPath = path
        planBadge.show(title: ChatPanel.planTitle(of: path), file: (path as NSString).lastPathComponent)
    }

    /// 계획 파일의 제목: 첫 H1, 없으면 파일명.
    static func planTitle(of path: String) -> String {
        guard let text = try? String(contentsOfFile: path, encoding: .utf8) else {
            return (path as NSString).deletingPathExtension as NSString as String
        }
        for line in text.split(separator: "\n", maxSplits: 40, omittingEmptySubsequences: true) {
            let l = line.trimmingCharacters(in: .whitespaces)
            if l.hasPrefix("#") { return l.drop(while: { $0 == "#" }).trimmingCharacters(in: .whitespaces) }
        }
        return ((path as NSString).lastPathComponent as NSString).deletingPathExtension
    }

    private func refreshAITitle(attempt: Int = 0) {
        guard let cwd = workspace?.path, let sid = sessionId else { return }
        DispatchQueue.global(qos: .utility).async { [weak self] in
            let found = ChatPanel.latestAITitle(cwd: cwd, sessionId: sid)
            DispatchQueue.main.async {
                guard let self, self.sessionId == sid else { return }
                if let t = found, t != self.lastAITitle {
                    self.lastAITitle = t
                    self.aiTitleSet = true
                    self.onTitle?(t)
                    return                       // got it — stop polling
                }
                // Not written yet: 1s, 3s, 6s. Cheap (a 256KB tail read off the main thread).
                let delays: [Double] = [1, 2, 3]
                guard attempt < delays.count else { return }
                DispatchQueue.main.asyncAfter(deadline: .now() + delays[attempt]) { [weak self] in
                    self?.refreshAITitle(attempt: attempt + 1)
                }
            }
        }
    }

    // Render the resumed session's prior turns so the conversation is visible (the CLI restores
    // context but doesn't re-emit past messages, so the panel would otherwise look empty).
    private func loadHistory(cwd: String, sessionId: String) {
        let enc = cwd.map { $0.isLetter || $0.isNumber ? String($0) : "-" }.joined()
        let url = FileManager.default.homeDirectoryForCurrentUser
            .appendingPathComponent(".claude/projects/\(enc)/\(sessionId).jsonl")
        guard let text = try? String(contentsOf: url, encoding: .utf8) else { return }
        var msgs: [(user: Bool, text: String)] = []
        for line in text.split(separator: "\n", omittingEmptySubsequences: true) {
            guard let d = line.data(using: .utf8),
                  let o = try? JSONSerialization.jsonObject(with: d) as? [String: Any],
                  let type = o["type"] as? String, let msg = o["message"] as? [String: Any] else { continue }
            let s = ChatPanel.contentText(msg["content"]).trimmingCharacters(in: .whitespacesAndNewlines)
            if s.isEmpty { continue }
            if type == "user" { if s.hasPrefix("/") || s.hasPrefix("<") { continue }; msgs.append((true, s)) }
            else if type == "assistant" { msgs.append((false, s)) }
        }
        // Render only the LAST N messages; keep the older ones as data behind a "load earlier"
        // pager. Rendering the WHOLE conversation exploded on launch — a big session = thousands of
        // autolayout views, and DockManager.restore()'s synchronous constraint pass pegged the CPU
        // (profiled). Paging keeps the live view count bounded no matter how long the history is.
        let cap = 50
        if msgs.count > cap {
            pendingHistory = Array(msgs.dropLast(cap))   // older, oldest-first
            msgs = Array(msgs.suffix(cap))
            addLoadEarlierButton()
        }
        renderMessages(msgs, atTop: false)
        addSystem(t("chat.resumed"))
        scrollSoon()
    }
    // ---- transcript paging (see loadHistory) ----
    private var pendingHistory: [(user: Bool, text: String)] = []   // older msgs not yet rendered
    private var loadEarlierBtn: NSView?
    private func renderMessages(_ msgs: [(user: Bool, text: String)], atTop: Bool) {
        var idx = atTop ? (loadEarlierBtn != nil ? 1 : 0) : stack.arrangedSubviews.count
        for m in msgs {
            let views: [NSView] = m.user ? [UserBubble(text: m.text)] : ChatText.render(m.text)
            for v in views {
                v.translatesAutoresizingMaskIntoConstraints = false
                stack.insertArrangedSubview(v, at: min(idx, stack.arrangedSubviews.count)); idx += 1
                v.widthAnchor.constraint(equalTo: stack.widthAnchor, constant: -24).isActive = true
            }
        }
    }
    // A non-interactive marker at the very top telling the reader there's more above; scrolling to
    // the top auto-loads it (see clipMoved). Not a button — the load is scroll-driven.
    private func addLoadEarlierButton() {
        let l = NSTextField(labelWithString: t("chat.olderNote", ["n": pendingHistory.count]))
        l.font = UIScale.font(UIScale.caption); l.textColor = Theme.fgDim; l.alignment = .center
        l.translatesAutoresizingMaskIntoConstraints = false
        stack.insertArrangedSubview(l, at: 0)
        l.widthAnchor.constraint(equalTo: stack.widthAnchor, constant: -24).isActive = true
        loadEarlierBtn = l
    }
    private var loadingEarlier = false
    // Prepend the previous batch ABOVE the current view, keeping the reader's position stable
    // (anchor by document-height delta) — so auto-loading never yanks the scroll.
    // Load one small batch per runloop turn. Rendering 50 messages at once — markdown parsing and
    // syntax highlighting for each — froze the main thread; the "scrolling up lags" report. Small
    // chunks keep each turn short, and the scroll stays anchored after every chunk.
    private static let pageBatch = 12
    @objc private func loadEarlier() {
        guard !pendingHistory.isEmpty, !loadingEarlier else { return }
        loadingEarlier = true
        let batch = Array(pendingHistory.suffix(ChatPanel.pageBatch))
        pendingHistory.removeLast(batch.count)
        layoutSubtreeIfNeeded()
        let oldH = stack.frame.height, oldY = scroll.contentView.bounds.origin.y
        loadEarlierBtn?.removeFromSuperview(); loadEarlierBtn = nil
        if !pendingHistory.isEmpty { addLoadEarlierButton() }
        renderMessages(batch, atTop: true)
        trimBottomIfNeeded()
        layoutSubtreeIfNeeded()
        let dy = stack.frame.height - oldH
        scroll.contentView.setBoundsOrigin(NSPoint(x: 0, y: oldY + dy))
        scroll.reflectScrolledClipView(scroll.contentView)
        // Release the guard on the NEXT turn, not via defer: defer would clear it inside this call,
        // and the setBoundsOrigin above posts a bounds change that re-enters clipMoved immediately.
        DispatchQueue.main.async { [weak self] in self?.loadingEarlier = false }
    }
    // Paging upward used to grow the rendered stack without limit (trimTranscript only runs when a
    // NEW turn starts), so after a few loads every layout pass walked hundreds of extra views. Drop
    // views from the BOTTOM once the window is full — they're re-rendered from the session when the
    // reader scrolls back down.
    private func trimBottomIfNeeded() {
        let maxViews = 120
        var subs = stack.arrangedSubviews
        guard subs.count > maxViews else { return }
        var drop = subs.count - maxViews
        while drop > 0, let last = subs.last {
            if last === current { break }          // never drop the live turn
            last.removeFromSuperview()
            subs.removeLast(); drop -= 1
        }
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
        current = nil; clearSubagents(); stopFlush(); turnStart = nil; liveTool = nil; queuedMessages.removeAll(); titleSet = false
        approvalQueue.removeAll(); approvalActive = false
        stack.arrangedSubviews.forEach { $0.removeFromSuperview() }
        pendingHistory = []; loadEarlierBtn = nil
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
        // Prefer the CLI's AI-summarized title (matches the /resume list Claude shows).
        let sid = url.deletingPathExtension().lastPathComponent
        if let cwd = workspace?.path, let t = ChatPanel.latestAITitle(cwd: cwd, sessionId: sid) { return t }
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
    /// riven's OWN choice cards (session picker, agent picker…). Unlike a permission prompt these
    /// are dismissible, so they always get 기타(직접 입력) — hand it back to the composer — and 취소,
    /// plus Esc. Without them a card was a dead end you couldn't back out of.
    private func presentChoice(_ title: String, options: [(String, () -> Void)], allowOther: Bool = true) {
        let block = newBlock(); current = block
        var opts = options
        if allowOther {
            opts.append((t("chat.other"), { [weak self] in self?.focusInput(force: true) }))
        }
        opts.append((t("chat.cancel"), { }))
        let card = block.addApproval(title, "", nil, nil, options: opts)
        card.onCancel = { [weak self, weak card] in
            card?.dismiss(t("chat.cancel"))
            self?.focusInput(force: true)
        }
        scrollSoon()
        DispatchQueue.main.async { [weak self, weak card] in if let card { self?.window?.makeFirstResponder(card) } }
    }

    private func startSession(cmd: String, cwd: String, resume: String?) {
        // Always install the approval hook; gate the risky tools through it (safe read-only
        // tools auto-run). riven's per-mode policy in requestPermission() decides allow/prompt.
        let s = ClaudeChatSession(command: cmd, cwd: cwd, resume: resume,
            permissionMode: cliMode, allowedTools: "Read,Grep,Glob,LS,Task,TodoWrite", interactive: true,
            agentName: agentPersona, model: preferredModel)
        s?.onInit = { [weak self] sid, model in
            self?.model = model; self?.sessionId = sid; self?.onSessionId?(sid)
            self?.restorePlanBadge(sid)
        }
        s?.onTextDelta = { [weak self] t in
            self?.liveTool = nil                      // 텍스트가 다시 흐른다 = 도구는 끝났다
            self?.current?.bufferText(t); self?.turnText += t
        }
        s?.onMainTool = { [weak self] name, detail, code, path in
            self?.liveTool = name
            self?.current?.addTool(name, detail, code, path); self?.autoScrollSoon()
            // 계획 모드를 빠져나오는 순간 CLI가 계획 .md 를 쓴다 — 조금 기다렸다 집어서 배지로.
            if name == "ExitPlanMode" { self?.pickUpPlanFile(attempt: 0) }
        }
        s?.onSubagentStart = { [weak self] id, type, desc in self?.addSubagentPane(id, type: type, desc: desc) }
        s?.onSubagentTool = { [weak self] pid, name, detail, code, path in self?.subToPane[pid]?.addTool(name, detail, code, path) }
        s?.onSubagentText = { [weak self] pid, text in self?.subToPane[pid]?.addText(text) }
        s?.onSubagentDone = { [weak self] id, result in self?.subToPane[id]?.finish(result) }
        s?.onFileEdited = { [weak self] path in self?.onEditedFile?(path) }
        s?.onTurnDone = { [weak self] cost, _, usage, error in self?.endTurn(cost: cost, usage: usage, error: error) }
        s?.onExit = { [weak self] code in
            guard let self else { return }
            // If the process dies mid-turn (crash, 529 that killed the stream, kill) the result
            // event never arrives — so WITHOUT this the flush timer runs FOREVER at 20fps doing a
            // full-transcript layout, which pegs the main thread (the reported "even the shimmer
            // can't animate" lag). End the turn so the timer stops.
            if self.turnStart != nil { self.endTurn(cost: nil, usage: nil, error: code != 0 ? t("chat.sessionCrashed", ["c": code]) : nil) }
            if code != 0 { self.addSystem(t("chat.sessionExit", ["c": code])) }
        }
        s?.onPermissionRequest = { [weak self] id, name, detail, code, path in self?.requestPermission(id, name, detail, code, path) }
        s?.onToolRequest = { [weak self] id, tool, args in self?.handleTool(id, tool, args) }
        session = s
        if s == nil { addSystem(t("chat.sessionStartFailed")) }
    }

    // ---- permission / choice cards (per-mode policy, applied live) ----
    private func requestPermission(_ id: String, _ name: String, _ detail: String, _ code: String?, _ path: String?) {
        // riven's own tools run in-app (choice card / preview / api) — never gate them.
        if name.hasPrefix("mcp__riven__") { session?.respond(id, allow: true); return }
        // ExitPlanMode: the agent is presenting a plan and asking to proceed — an arrow-select
        // choice regardless of the current permission mode.
        if name == "ExitPlanMode" {
            enqueueChoice(title: t("chat.planProceed"), detail: "", code: code, path: nil, options: [
                (t("chat.planGo"), { [weak self] in self?.session?.respond(id, allow: true) }),
                (t("chat.planRevise"), { [weak self] in self?.session?.respond(id, allow: false) })
            ])
            return
        }
        let approve: (String, () -> Void) = (t("chat.approve"), { [weak self] in self?.session?.respond(id, allow: true) })
        let alwaysAuto: (String, () -> Void) = (t("chat.autoThisSession"), { [weak self] in
            self?.modePopup.selectItem(at: 2); self?.modeChanged(); self?.session?.respond(id, allow: true) })
        let deny: (String, () -> Void) = (t("chat.deny"), { [weak self] in self?.session?.respond(id, allow: false) })
        switch modeIndex {
        case 1:  enqueueChoice(title: t("chat.permReq", ["name": name]), detail: detail, code: code, path: path,   // 승인 요청
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
        // 답은 "물어본" 세션에게 돌려줘야 한다. self.session 을 클릭/완료 시점에 다시 읽으면,
        // 그 사이 세션이 바뀌었을 때(대화 재개·다른 세션으로 전환·크래시 후 재기동) 엉뚱한
        // 서버로 가고 원래 요청자는 영영 기다린다 — "선택했는데 아무 일도 안 일어남".
        let asker = session
        func reply(_ text: String) {
            // 이미 만료·취소된 요청이면 조용히 사라지지 않고 대화에 남긴다 — 예전엔 카드를
            // 눌러도 아무 일이 없어서 클릭이 씹힌 건지 알 수 없었다.
            if asker?.respondTool(id, text) != true { addSystem(t("chat.tool.expired")) }
        }
        switch tool {
        case "ask_user":
            presentAsk(id, s("question"), args["options"] as? [String] ?? [], reply)
        case "riven_open_file":
            let p = s("path")
            let line = (args["line"] as? NSNumber)?.intValue ?? (args["line"] as? Int) ?? 1
            onOpenFileAt?(URL(fileURLWithPath: p), line)
            addSystem(t("chat.openedEditor", ["p": p]))
            session?.respondTool(id, "opened \(p) in riven editor")
        case "riven_open_browser":
            onOpenBrowser?(s("url"))
            addSystem(t("chat.openedPreview", ["u": s("url")]))
            session?.respondTool(id, "opened \(s("url")) in riven preview panel")
        case "riven_screenshot":
            let url = args["url"] as? String
            addSystem(t("chat.capturing"))
            if let onScreenshot {
                onScreenshot(url) { [weak self] path in
                    reply(path.map { "screenshot saved to \($0) (read it with the Read tool)" } ?? "screenshot failed")
                }
            } else { session?.respondTool(id, "screenshot unavailable") }
        case "riven_api_request":
            // Show it in the API panel AND return the body to the agent.
            let hdrs = (args["headers"] as? [String: Any])?.map { "\($0.key): \($0.value)" }.joined(separator: "\n") ?? ""
            onApiRequest?(s("method").isEmpty ? "GET" : s("method"), s("url"), hdrs, s("body"))
            addSystem(t("chat.apiPanel", ["s": s("method") + " " + s("url")]))
            apiRequest(args) { result in reply(result) }
        case "riven_panels":
            session?.respondTool(id, onPanels?() ?? "(no panels)")
        case "riven_open_panel":
            session?.respondTool(id, onOpenPanel?(s("kind")) ?? "unavailable")
        case "riven_close_panel":
            session?.respondTool(id, onClosePanel?(s("id")) ?? "unavailable")
        case "riven_agents":
            session?.respondTool(id, onAgentPanes?() ?? "(unavailable)")
        case "riven_ask_agent":
            let target = s("agent"), msg = s("message")
            let wait = (args["wait"] as? Bool) ?? true
            addSystem("→ \(target): \(ChatPanel.shortTitle(msg))")
            if let onAskAgent {
                onAskAgent(target, msg) { [weak self] answer in
                    guard let self else { return }
                    self.addSystem("← \(target)")
                    // wait=false 였으면 도구 호출은 이미 끝났다 → 답을 대화로 밀어 넣는다.
                    if wait { reply(answer) } else { self.deliverPeerAnswer(from: target, answer) }
                }
                if !wait { reply(t("chat.delegated", ["a": target])) }
            } else { session?.respondTool(id, "agent messaging unavailable") }
        case "riven_ask_agents":
            // 한 번에 여러 명 — 전원이 동시에 시작하고, 마지막 한 명이 끝나면 한꺼번에 돌려준다.
            let tasks: [(agent: String, message: String)] = (args["tasks"] as? [[String: Any]] ?? []).compactMap {
                guard let a = $0["agent"] as? String, let m = $0["message"] as? String else { return nil }
                return (agent: a, message: m)
            }
            guard !tasks.isEmpty, let onAskAgents else {
                session?.respondTool(id, tasks.isEmpty ? "tasks must be a non-empty array of {agent, message}"
                                                       : "agent messaging unavailable")
                return
            }
            let waitAll = (args["wait"] as? Bool) ?? true
            addSystem("⇉ " + tasks.map { $0.agent }.joined(separator: ", "))
            onAskAgents(tasks) { [weak self] answers in
                guard let self else { return }
                self.addSystem("← " + answers.map { $0.0 }.joined(separator: ", "))
                let joined = answers.map { "## \($0.0)\n\($0.1)" }.joined(separator: "\n\n")
                if waitAll { reply(joined) } else { self.deliverPeerAnswer(from: answers.map { $0.0 }.joined(separator: ", "), joined) }
            }
            if !waitAll { reply(t("chat.delegated", ["a": tasks.map { $0.agent }.joined(separator: ", ")])) }
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
    private func presentAsk(_ id: String, _ question: String, _ options: [String],
                            _ reply: @escaping (String) -> Void) {
        let opts: [(String, () -> Void)] = options.map { opt in (opt, { reply(opt) }) }
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
            self.pendingCard = card
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
        pendingCard = nil
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
        Settings.shared.set("chatPermMode", modeIndex)   // persist so it survives reopen/relaunch
        addSystem(t("chat.mode.now", ["m": modes[modeIndex].0]))
    }
    private func cycleMode() {
        modePopup.selectItem(at: (modeIndex + 1) % modes.count)
        modeChanged()
    }

    // ---- send / turn lifecycle ----
    // Interrupt the running turn (Esc / the stop button) — like the CLI's Esc.
    private var interrupted = false
    private func interruptTurn() {
        guard turnStart != nil else { return }
        interrupted = true                 // suppress the error line for the result WE cancelled
        session?.interrupt()
        // Like the CLI: the interrupted message returns to the input for editing/resending. Remove
        // its bubble from the transcript and put the text back (don't clobber anything typed since).
        if let text = currentTurnText {
            currentTurnBubble?.removeFromSuperview()
            let typed = input.stringValue.trimmingCharacters(in: .whitespacesAndNewlines)
            input.stringValue = typed.isEmpty ? text : (text + "\n" + typed)
            input.window?.makeFirstResponder(input)
        }
        currentTurnText = nil; currentTurnBubble = nil
        queuedMessages.forEach { $0.bubble.setQueued(false) }   // un-mark cancelled queued msgs
        queuedMessages.removeAll()            // stop = cancel everything pending
        addSystem(t("chat.interrupted"))
        // the CLI emits a result → endTurn finalizes the UI (busy off, times, etc.)
    }
    @objc private func sendOrStop() { if turnStart != nil { interruptTurn() } else { sendFromInput() } }
    // "+" — attach file path(s) to the message (the agent reads them). Same intent as a drag-drop.
    @objc private func attachFile() {
        let panel = NSOpenPanel()
        panel.canChooseFiles = true; panel.canChooseDirectories = true; panel.allowsMultipleSelection = true
        panel.begin { [weak self] resp in
            guard let self, resp == .OK, !panel.urls.isEmpty else { return }
            // One path per line so each wraps and the input GROWS (up to 6 lines, then scrolls) —
            // before, paths were joined on one line and, without a relayout, the composer stayed a
            // single line so the text was clipped / looked like it collided with the mode select.
            let paths = panel.urls.map { $0.path }.joined(separator: "\n")
            let cur = self.input.stringValue
            self.input.stringValue = cur.isEmpty ? paths : (cur + "\n" + paths)
            self.inputScroll.invalidateIntrinsicContentSize()
            self.composer.layoutSubtreeIfNeeded()               // grow the composer now
            self.window?.makeFirstResponder(self.input)
            self.input.setSelectedRange(NSRange(location: self.input.string.count, length: 0))
            self.input.scrollRangeToVisible(self.input.selectedRange())   // keep the end visible
        }
    }
    @objc private func sendFromInput() {
        if !slash.isHidden { acceptSlash(); return }
        let text = input.stringValue.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty, session != nil else { return }
        input.stringValue = ""; hideSlash()
        if text.hasPrefix("/"), handleSlash(text) { return }   // riven-handled slash commands
        if !titleSet { titleSet = true; onTitle?(ChatPanel.shortTitle(text)) }   // rail/tab title
        let bubble = addUser(text)
        // A turn is still running (or awaiting approval): QUEUE this message (shown dimmed +
        // "대기 중", like the CLI acknowledging it) and send it when the current turn finishes.
        if turnStart != nil { bubble.setQueued(true); queuedMessages.append((text, bubble)); return }
        beginTurn(text, bubble: bubble)
    }
    private var queuedMessages: [(text: String, bubble: UserBubble)] = []
    var onResumeRequest: (() -> Void)?
    private var lastUsage: ChatUsage?

    // Handle riven's client-side slash commands; return true if consumed. Others (custom
    // commands, passthrough built-ins) return false and go to the CLI as a normal message.
    // ---- richer slash-command reports -------------------------------------------------
    // /cost — the account's PLAN usage (the same OAuth endpoint the header widget uses), refreshed
    // on demand, plus this session's last turn. It used to print only the last turn's tokens.
    private func showUsage() {
        addSystem(t("chat.usage.loading"))
        Usage.limits { [weak self] lim in
            DispatchQueue.main.async {
                guard let self else { return }
                var lines: [String] = []
                func bar(_ remaining: Int) -> String {
                    let used = max(0, min(100, 100 - remaining))
                    let filled = Int((Double(used) / 10).rounded())
                    return String(repeating: "█", count: filled) + String(repeating: "░", count: 10 - filled) + "  \(used)%"
                }
                if let s5 = lim.sessionRemaining {
                    var l = "\(t("chat.usage.session"))  \(bar(s5))"
                    if let r = lim.sessionResetsAt { l += "   (\(t("chat.usage.resets", ["t": ChatPanel.shortTime(r)])))" }
                    lines.append(l)
                }
                if let w = lim.weeklyRemaining {
                    var l = "\(t("chat.usage.week"))      \(bar(w))"
                    if let r = lim.weeklyResetsAt { l += "   (\(t("chat.usage.resets", ["t": ChatPanel.shortTime(r)])))" }
                    lines.append(l)
                }
                if lines.isEmpty { lines.append(t("chat.usage.unavailable")) }
                if let u = self.lastUsage {
                    lines.append("")
                    lines.append("\(t("chat.usage.turn"))  ↑\(ChatText.tokens(u.input + u.cacheWrite)) ↓\(ChatText.tokens(u.output))  ·  cache \(ChatText.tokens(u.cacheRead))")
                }
                self.addReport(t("chat.usage.title"), lines)
            }
        }
    }
    // /mcp — which servers are connected and WHAT they give the agent, not just a name list.
    private func showMCP() {
        let servers = session?.mcpServers ?? []
        let tools = session?.toolList ?? []
        var lines: [String] = []
        for srv in servers.sorted(by: { $0.name < $1.name }) {
            let mine = tools.filter { $0.hasPrefix("mcp__\(srv.name)__") }
                .map { $0.replacingOccurrences(of: "mcp__\(srv.name)__", with: "") }
            let mark = srv.status == "connected" ? "●" : "○"
            var line = "\(mark) \(srv.name)"
            if srv.status != "connected" { line += "  · \(t("chat.mcp.needsAuth"))" }
            else if !mine.isEmpty { line += "  · \(t("chat.mcp.tools", ["n": mine.count]))" }
            lines.append(line)
            if !mine.isEmpty { lines.append("   " + mine.sorted().joined(separator: ", ")) }
        }
        if servers.isEmpty { lines.append(t("chat.mcp.none")) }
        self.addReport(t("chat.mcp.title"), lines)
    }
    // /status — what this pane is actually running.
    private func showStatus() {
        var lines: [String] = []
        lines.append("\(t("chat.status.model", ["m": ChatPanel.modelLabel(model)]))   [\(model ?? "?")]")
        lines.append("\(t("chat.perm.title")): \(modes[modeIndex].0)")
        if let ws = workspace { lines.append("\(t("chat.status.workspace")): \(ws.path)") }
        if let sid = session?.sessionId { lines.append("\(t("chat.status.session", ["id": String(sid.prefix(8))]))") }
        if let v = AgentDiscovery.claudeVersion() { lines.append("\(t("chat.status.cli")): \(v)") }
        let tools = session?.toolList ?? []
        if !tools.isEmpty {
            let mcp = tools.filter { $0.hasPrefix("mcp__") }.count
            lines.append("\(t("chat.status.tools")): \(tools.count)  (MCP \(mcp))")
        }
        if let u = lastUsage {
            lines.append("\(t("chat.usage.turn")): ↑\(ChatText.tokens(u.input + u.cacheWrite)) ↓\(ChatText.tokens(u.output))")
        }
        addReport(t("chat.status.title"), lines)
    }
    /// A titled, monospaced block — readable columns instead of one dim run-on line.
    private func addReport(_ title: String, _ lines: [String]) {
        let head = NSTextField(labelWithString: title)
        head.font = UIScale.font(UIScale.body, .semibold); head.textColor = Theme.fg
        head.translatesAutoresizingMaskIntoConstraints = false
        stack.addArrangedSubview(head)
        head.widthAnchor.constraint(equalTo: stack.widthAnchor, constant: -24).isActive = true
        let body = NSTextField(wrappingLabelWithString: lines.joined(separator: "\n"))
        body.font = UIScale.mono(UIScale.small); body.textColor = Theme.fgDim; body.isSelectable = true
        body.translatesAutoresizingMaskIntoConstraints = false
        stack.addArrangedSubview(body)
        body.widthAnchor.constraint(equalTo: stack.widthAnchor, constant: -24).isActive = true
        scrollSoon()
    }
    /// "2026-08-04T09:00:00Z" → "09:00" (local), for reset times.
    static func shortTime(_ iso: String) -> String {
        let f = ISO8601DateFormatter(); f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        let d = f.date(from: iso) ?? ISO8601DateFormatter().date(from: iso)
        guard let d else { return iso }
        let out = DateFormatter(); out.dateFormat = "M/d HH:mm"
        return out.string(from: d)
    }

    private func handleSlash(_ text: String) -> Bool {
        let cmd = String(text.dropFirst()).split(separator: " ").first.map(String.init) ?? ""
        switch cmd {
        case "clear":
            stack.arrangedSubviews.forEach { $0.removeFromSuperview() }
            pendingHistory = []; loadEarlierBtn = nil
            current = nil; clearSubagents(); stopFlush(); turnStart = nil; liveTool = nil; queuedMessages.removeAll()
            return true
        case "resume":
            let sessions = listSessions()
            if sessions.isEmpty { addSystem(t("chat.sessions.none")); return true }
            let opts: [(String, () -> Void)] = sessions.map { s in
                let label = (s.title.isEmpty ? String(s.id.prefix(8)) : s.title) + "  ·  " + s.date
                return (label, { [weak self] in self?.switchSession(to: s.id) })
            }
            presentChoice(t("chat.sessions.pick"), options: opts, allowOther: false)
            return true
        case "model":
            pickModel(); return true
        case "cost", "context", "usage":
            showUsage(); return true
        case "mcp":
            showMCP(); return true
        case "config":
            onOpenSettings?(); return true
        case "permissions":
            // Not a paragraph of prose — a picker that actually switches the mode.
            let descs = [t("chat.perm.planDesc"), t("chat.perm.askDesc"), t("chat.perm.autoDesc")]
            let opts: [(String, () -> Void)] = modes.enumerated().map { i, m in
                ("\(m.0) · \(descs[i])", { [weak self] in
                    self?.modePopup.selectItem(at: i); self?.modeChanged()
                })
            }
            presentChoice(t("chat.perm.pick"), options: opts, allowOther: false)
            return true
        case "status":
            showStatus(); return true
        case "update":
            guard let cmd = AgentDiscovery.claudeCmd() else { addSystem(t("chat.noCLIShort")); return true }
            addSystem(t("chat.updating"))
            DispatchQueue.global(qos: .userInitiated).async { [weak self] in
                let p = Process(); p.executableURL = URL(fileURLWithPath: cmd); p.arguments = ["update"]
                let pipe = Pipe(); p.standardOutput = pipe; p.standardError = pipe
                var out = ""
                if (try? p.run()) != nil {
                    let d = pipe.fileHandleForReading.readDataToEndOfFile(); p.waitUntilExit()
                    out = String(data: d, encoding: .utf8)?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
                } else { out = t("chat.runFailed") }
                DispatchQueue.main.async {
                    self?.addSystem(out.isEmpty ? t("chat.updateDone") : out)
                    self?.addSystem(t("chat.updateApplies"))
                }
            }
            return true
        case "init":
            sendPrompt(t("chat.prompt.init")); return true
        case "review":
            sendPrompt(t("chat.prompt.review")); return true
        case "agents":
            // Actually open the chosen agent in its own pane (it used to just print a sentence).
            let names = onListAgents?() ?? []
            var opts: [(String, () -> Void)] = [(t("chat.agents.default"), { [weak self] in self?.onOpenAgentChat?(nil) })]
            opts += names.map { n in (n, { [weak self] in self?.onOpenAgentChat?(n) }) }
            if names.isEmpty { addSystem(t("chat.agents.none")) }
            presentChoice(t("chat.agents.pick"), options: opts, allowOther: false)
            return true
        case "help":
            addSystem(t("chat.help"))
            return true
        default:
            return false      // pass through to the CLI (custom commands etc.)
        }
    }
    // Send an expanded prompt as if the user typed it (for /init, /review).
    private func sendPrompt(_ text: String) {
        if !titleSet { titleSet = true; onTitle?(ChatPanel.shortTitle(text)) }
        let b = addUser(text)
        if turnStart != nil { b.setQueued(true); queuedMessages.append((text, b)) } else { beginTurn(text, bubble: b) }
    }
    // Live model switch (control channel) via a small menu — the CLI accepts aliases.
    // The menu names the VERSION each alias maps to and marks the one currently running: a resumed
    // session keeps the model it was created with, so "기본" is not necessarily what this pane runs
    // (that's why a resumed pane could sit on an older Opus while new chats start on Opus 5).
    private func pickModel() {
        let models = ChatPanel.selectableModels
        let menu = NSMenu()
        let header = NSMenuItem(title: t("chat.model.now", ["m": ChatPanel.modelLabel(model)]), action: nil, keyEquivalent: "")
        header.isEnabled = false
        menu.addItem(header); menu.addItem(.separator())
        let cur = (model ?? "").lowercased()
        for (label, id) in models {
            let item = NSMenuItem(title: label, action: #selector(pickModelItem(_:)), keyEquivalent: "")
            item.target = self; item.representedObject = id
            if id != "default", cur.contains(id) { item.state = .on }   // mark the running model
            menu.addItem(item)
        }
        // Pop up near the composer, in this view's coordinate space.
        let anchor = convert(inputScroll.frame.origin, from: inputScroll.superview)
        menu.popUp(positioning: nil, at: anchor, in: self)
    }
    /// The models a pane can be pinned to — one source for the ⌥ menu and the agent-group cards.
    static var selectableModels: [(String, String)] {
        [(t("chat.model.default"), "default"), ("Fable 5", "fable"), ("Opus 5", "opus"),
         ("Sonnet 5", "sonnet"), ("Haiku 4.5", "haiku")]
    }

    // Human-readable model name from the CLI's id (e.g. "claude-opus-5[1m]" → "Opus 5 (1m)").
    static func modelLabel(_ id: String?) -> String {
        guard var s = id, !s.isEmpty else { return "?" }
        var suffix = ""
        if let r = s.range(of: "[", options: .literal) {          // context-window tag like [1m]
            suffix = " (" + s[r.upperBound...].replacingOccurrences(of: "]", with: "") + ")"
            s = String(s[..<r.lowerBound])
        }
        s = s.replacingOccurrences(of: "claude-", with: "")
        let parts = s.split(separator: "-").map(String.init)
        guard let family = parts.first else { return id ?? "?" }
        let ver = parts.dropFirst().filter { $0.allSatisfy { $0.isNumber } }.joined(separator: ".")
        let name = family.prefix(1).uppercased() + family.dropFirst()
        return (ver.isEmpty ? name : "\(name) \(ver)") + suffix
    }
    /// 실행 중인 세션의 모델을 바꾸고, 그 선택을 팬에 기록한다 (레이아웃과 함께 저장되어
    /// 다음 실행에도 유지된다). 조직도 편집·모델 메뉴가 공유하는 하나의 경로.
    func applyModel(_ id: String?) {
        preferredModel = id
        session?.setModel(id ?? "default")
        let label = ChatPanel.selectableModels.first { $0.1 == (id ?? "default") }?.0 ?? "?"
        addSystem(t("chat.model.set", ["m": label]))
    }
    /// 벤치용: 선택 카드를 하나 띄운다.
    func debugPresentChoice(_ options: [String]) {
        enqueueChoice(title: "테스트 선택", detail: "", code: nil, path: nil,
                      options: options.map { o in (o, {}) })
    }

    /// 비동기로 넘긴 일의 답이 도착했을 때 — 대화에 넣고 모델에게도 새 턴으로 전달한다.
    /// (도구 호출은 이미 끝났으므로 결과를 돌려줄 곳이 없다. 사람이 말한 것처럼 넣어 준다.)
    func deliverPeerAnswer(from agent: String, _ answer: String) {
        let text = t("chat.peerAnswer", ["a": agent]) + "\n\n" + answer
        ask(text) { _ in }
    }

    /// 앱이 이 팬의 대화에 한 줄 남긴다 (그룹 복구 안내 등).
    func noteSystem(_ text: String) { addSystem(text) }
    /// 조직도에서 닉네임을 바꿨을 때 — 대화에도 남겨 동료가 새 이름을 알 수 있게 한다.
    func applyNickname(_ name: String) {
        guard name != nickname else { return }
        nickname = name
        addSystem(t("team.renamed", ["name": name]))
    }

    @objc private func pickModelItem(_ item: NSMenuItem) {
        guard let id = item.representedObject as? String else { return }
        session?.setModel(id)
        addSystem(t("chat.model.set", ["m": item.title]))
        focusInput(force: true)
    }
    private func beginTurn(_ text: String, bubble: UserBubble? = nil) {
        // Dead session (crashed / bad resume / exited) → don't start a turn that can never complete
        // (it would hang on "생각 중" forever). Surface it and offer recovery.
        if session == nil || session?.isAlive == false {
            bubble?.setQueued(false)
            addError(t("chat.sessionEnded"))
            setRunning(false); onBusyChange?(false)
            return
        }
        // Do NOT close the previous turn's sub-agent panels here — the user wants to keep viewing
        // them (and closing them while one was still running lost visibility). They're real dock
        // panels now: they stay open until the user closes them (or the workspace changes).
        currentTurnText = text; currentTurnBubble = bubble   // for interrupt → restore to input
        turnText = ""
        current = newBlock()
        current?.startWorking()
        turnStart = Date(); pausedTotal = 0; pauseStart = nil; liveTool = nil; startFlush()
        setRunning(true)
        onBusyChange?(true)
        session?.send(text)
        scrollSoon()
    }
    private var currentTurnText: String?
    private var turnText = ""                                   // assistant text of the running turn
    private var askWaiters: [(String) -> Void] = []             // agents waiting on this pane's answer
    private var currentTurnBubble: UserBubble?
    private func newBlock() -> TurnBlock {
        trimTranscript()               // bound the rendered view count before adding a new turn
        let block = TurnBlock()
        block.translatesAutoresizingMaskIntoConstraints = false
        stack.addArrangedSubview(block)
        block.widthAnchor.constraint(equalTo: stack.widthAnchor, constant: -24).isActive = true
        return block
    }
    // Keep the rendered transcript bounded: full relayouts/rescales (mode change, ⌘+/−, scroll,
    // theme) walk every view, so an unbounded transcript makes those O(n) ops lag. Old messages
    // stay in the CLI session/context — only their VIEWS are dropped.
    private func trimTranscript() {
        // Bound the LIVE view count: autolayout over the transcript is superlinear, so an unbounded
        // stack pegs the CPU on every relayout (profiled — a huge restored stack froze launch).
        let cap = 80
        let subs = stack.arrangedSubviews
        guard subs.count > cap else { return }
        for v in subs.prefix(subs.count - cap) where v !== current { v.removeFromSuperview() }
    }

    // ---- sub-agent panes ----
    // Each sub-agent opens as a REAL dock panel (main.swift places it via onOpenSubagentPane), so it
    // resizes / moves / tabs exactly like every other panel — instead of the old fixed left/right
    // split that couldn't be positioned. This panel only owns the SubagentPane VIEW; the dock owns
    // its placement.
    private func addSubagentPane(_ id: String, type: String, desc: String) {
        let pane = SubagentPane(type: type, desc: desc)
        pane.onClose = { [weak self] in self?.subToPane[id] = nil; self?.onCloseSubagentPanes?([id]) }
        subToPane[id] = pane
        onOpenSubagentPane?(id, pane, type.isEmpty ? "Sub-agent" : type)
    }
    private func clearSubagents() {
        let ids = Array(subToPane.keys)
        subToPane.removeAll()
        if !ids.isEmpty { onCloseSubagentPanes?(ids) }
    }
    // The user closed a sub-agent's dock panel directly — drop our view reference.
    func clearSubagentRef(_ id: String) { subToPane[id] = nil }

    private func startFlush() {
        flushTimer?.invalidate()
        flushTimer = Timer.scheduledTimer(withTimeInterval: 0.05, repeats: true) { [weak self] _ in
            guard let self, let block = self.current, let start = self.turnStart else { return }
            // OFFSCREEN (a chat pane whose workspace isn't the active one) → do NO UI work: skip the
            // typewriter reveal, the elapsed relabel, and above all the scroll (which forces a full
            // layout of the whole transcript). The session keeps buffering text; it's revealed when
            // the pane is shown again. Without this, every background agent's flush pegged the main
            // thread at 20fps, which is why even the foreground shimmer couldn't animate.
            guard self.window != nil else { return }
            let grew = block.flush()
            block.tick(Int(Date().timeIntervalSince(start) - self.pausedTotal))   // exclude approval wait
            if grew { self.autoScroll() }
        }
    }
    private func stopFlush() { flushTimer?.invalidate(); flushTimer = nil }

    private func endTurn(cost: Double?, usage: ChatUsage?, error: String? = nil) {
        let secs = turnStart.map { Int(Date().timeIntervalSince($0) - pausedTotal) } ?? 0
        stopFlush()
        lastUsage = usage
        let block = current
        block?.finish(secs: secs, cost: cost, usage: usage, model: model)
        turnStart = nil; liveTool = nil
        // Surface a failed turn (529 Overloaded, max-turns, etc.) instead of silently "완료" —
        // unless WE interrupted it (interruptTurn already printed ⏹ 중단됨).
        if let error, !interrupted { addError(t("chat.error", ["e": error])) }
        interrupted = false
        autoScroll()
        // Show how much of the plan quota is used (account 5-hour / weekly window, from the
        // OAuth usage API) — updates after each turn so you can watch it climb.
        Usage.limits { lim in
            DispatchQueue.main.async {
                block?.setQuota(sessionUsed: lim.sessionRemaining.map { 100 - $0 },
                                weeklyUsed: lim.weeklyRemaining.map { 100 - $0 })
            }
        }
        // Hand this turn's answer to any agent that delegated work here (riven_ask_agent).
        if !askWaiters.isEmpty {
            let answer = turnText.trimmingCharacters(in: .whitespacesAndNewlines)
            let waiters = askWaiters; askWaiters.removeAll()
            waiters.forEach { $0(answer.isEmpty ? (error ?? "(no answer)") : answer) }
        }
        refreshAITitle()   // adopt the CLI's summarized title if it produced one this turn
        // Send the next queued user message (typed while this turn was running).
        if !queuedMessages.isEmpty { let q = queuedMessages.removeFirst(); q.bubble.setQueued(false); beginTurn(q.text, bubble: q.bubble) }
        else { setRunning(false); onBusyChange?(false) }
        // NOTE: no plan-quota % here. The OAuth usage API gives only account-wide 5-hour/weekly
        // utilization (e.g. 36%/9%), which is NOT this turn's share and reads as misleading next
        // to a 5k-token turn. Per-turn quota % isn't derivable (no absolute budget from the API).
    }

    // ---- stack helpers ----
    @discardableResult private func addUser(_ text: String) -> UserBubble {
        let v = UserBubble(text: text)
        v.translatesAutoresizingMaskIntoConstraints = false
        stack.addArrangedSubview(v)
        v.widthAnchor.constraint(equalTo: stack.widthAnchor, constant: -24).isActive = true
        scrollSoon()
        return v
    }
    private func addSystem(_ text: String) {
        let l = NSTextField(wrappingLabelWithString: text)
        l.font = UIScale.font(UIScale.caption); l.textColor = Theme.fgDim
        l.translatesAutoresizingMaskIntoConstraints = false
        stack.addArrangedSubview(l)
        l.widthAnchor.constraint(equalTo: stack.widthAnchor, constant: -24).isActive = true
        scrollSoon()
    }
    // A visible, danger-tinted line for turn failures (529, etc.) — not the dim system gray.
    private func addError(_ text: String) {
        let l = NSTextField(wrappingLabelWithString: text)
        l.font = UIScale.font(UIScale.small, .medium); l.textColor = Theme.danger; l.isSelectable = true
        l.translatesAutoresizingMaskIntoConstraints = false
        stack.addArrangedSubview(l)
        l.widthAnchor.constraint(equalTo: stack.widthAnchor, constant: -24).isActive = true
        scrollSoon()
    }
    private func scrollSoon() { DispatchQueue.main.async { [weak self] in self?.scrollToBottom() } }
    // FORCED pin to the live edge (user sent / resumed / tapped the pill): also resumes following.
    private func scrollToBottom() {
        guard window != nil else { return }   // offscreen: don't force a layout; viewDidMoveToWindow handles it
        layoutSubtreeIfNeeded()
        let clip = scroll.contentView
        let y = max(0, stack.frame.height - clip.bounds.height)
        clip.setBoundsOrigin(NSPoint(x: 0, y: y))
        scroll.reflectScrolledClipView(clip)
        stickToBottom = true
        jumpButton.isHidden = true
    }
    // AUTO scroll (streaming / turn end / tool lines): follow the bottom ONLY while the reader is at
    // the live edge. If they scrolled up to read, don't yank — just surface the jump pill.
    private func autoScroll() {
        if stickToBottom { scrollToBottom() }
        else { jumpButton.isHidden = isAtBottom() }
    }
    private func autoScrollSoon() { DispatchQueue.main.async { [weak self] in self?.autoScroll() } }
    private func isAtBottom() -> Bool {
        let clip = scroll.contentView
        let maxY = max(0, stack.frame.height - clip.bounds.height)
        return clip.bounds.origin.y >= maxY - UIScale.pt(24)   // within a hair of the edge counts
    }
    @objc private func clipMoved() {
        stickToBottom = isAtBottom()
        jumpButton.isHidden = stickToBottom
        // Infinite scroll: reaching the TOP auto-loads the previous batch (no button). After a load
        // the content grows above and the position is preserved, so this won't re-trigger until the
        // reader scrolls up to the new top again.
        if !loadingEarlier, !pendingHistory.isEmpty, scroll.contentView.bounds.origin.y < UIScale.pt(220) {
            loadEarlier()
        }
    }
    @objc private func jumpToLatest() { scrollToBottom() }

    // ---- slash-command autocomplete (driven by ChatInput's onTextChange/onKey) ----
    private func inputChanged() {
        let s = input.stringValue
        guard s.hasPrefix("/"), !s.contains(" "), !s.contains("\n") else { hideSlash(); return }
        let q = String(s.dropFirst()).lowercased()
        let matches = commands.filter { q.isEmpty || $0.name.lowercased().hasPrefix(q) }
        if matches.isEmpty { hideSlash() } else { showSlash(matches) }
    }
    // Shift+Tab (mode cycle) any time; when the popup is up: arrows / Enter / Esc. Return true
    // if consumed (so ChatInput doesn't also act on the key).
    private func inputKey(_ sel: Selector) -> Bool {
        if sel == #selector(NSResponder.insertBacktab(_:)) { cycleMode(); return true }
        if !slash.isHidden {
            switch sel {
            case #selector(NSResponder.moveUp(_:)):          slash.move(-1); return true
            case #selector(NSResponder.moveDown(_:)):        slash.move(1);  return true
            case #selector(NSResponder.insertNewline(_:)):   acceptSlash();  return true
            case #selector(NSResponder.cancelOperation(_:)): hideSlash();    return true
            default: return false
            }
        }
        // Esc with no popup → interrupt the running turn (like the CLI).
        if sel == #selector(NSResponder.cancelOperation(_:)), turnStart != nil { interruptTurn(); return true }
        return false
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
        input.setSelectedRange(NSRange(location: input.string.count, length: 0))
    }

    // Claude Code's standard slash commands (for CLI-parity autocomplete) + custom commands
    // from .claude/commands. riven handles the useful ones itself (see handleSlash); the rest
    // pass through to the CLI (custom commands run; a few TUI-only built-ins may report back).
    // Only commands that DO something. /compact and /memory were removed: headless sessions don't
    // support manual compaction, and memory editing has no UI here — printing "not supported" is
    // worse than not offering it.
    private static let builtins: [SlashCommand] = [
        .init(name: "clear", desc: t("chat.cmd.clear")),
        .init(name: "resume", desc: t("chat.cmd.resume")),
        .init(name: "agents", desc: t("chat.cmd.agents")),
        .init(name: "model", desc: t("chat.cmd.model")),
        .init(name: "permissions", desc: t("chat.cmd.permissions")),
        .init(name: "cost", desc: t("chat.cmd.cost")),
        .init(name: "status", desc: t("chat.cmd.status")),
        .init(name: "mcp", desc: t("chat.cmd.mcp")),
        .init(name: "init", desc: t("chat.cmd.init")),
        .init(name: "review", desc: t("chat.cmd.review")),
        .init(name: "config", desc: t("chat.cmd.config")),
        .init(name: "update", desc: t("chat.cmd.update")),
        .init(name: "help", desc: t("chat.cmd.help"))
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
        guard let text = try? String(contentsOf: url, encoding: .utf8) else { return t("chat.cmd.user") }
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
                .map { $0.replacingOccurrences(of: "#", with: "").trimmingCharacters(in: .whitespaces) } ?? t("chat.cmd.user")
        }
        let full = hint.isEmpty ? desc : "\(hint)  ·  \(desc)"
        return String(full.prefix(60))
    }
}
