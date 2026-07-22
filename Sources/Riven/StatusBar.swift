import AppKit

// Bottom status bar — a native port of riven's StatusBar. Left: workspace folder
// + git branch (with icons). Right: a settings gear. 25px, bg-2, hairline top,
// text-xs, tabular numerals — matching styles.css `.status-bar`.
final class StatusBarView: NSView, Themable {
    private let line = NSView()
    private let folderIcon = NSImageView()
    private let folderLabel = NSTextField(labelWithString: "")
    private let branchIcon = NSImageView()
    private let branchLabel = NSTextField(labelWithString: "")
    private let settings = NSButton()
    private let langLabel = NSTextField(labelWithString: "")
    private let usageIcon = NSImageView()
    private let usageLabel = NSTextField(labelWithString: "")
    private lazy var usageItem = item(usageIcon, usageLabel)
    private let accountIcon = NSImageView()
    private let accountLabel = NSTextField(labelWithString: "")
    private lazy var accountItem = item(accountIcon, accountLabel)
    var onSettings: (() -> Void)?

    override init(frame: NSRect) {
        super.init(frame: frame)
        wantsLayer = true
        layer?.backgroundColor = Theme.bg2.cgColor

        line.wantsLayer = true
        line.layer?.backgroundColor = Theme.hairline.cgColor
        line.translatesAutoresizingMaskIntoConstraints = false
        addSubview(line)

        folderIcon.image = symbol("folder", 12)
        let folderItem = item(folderIcon, folderLabel)
        branchIcon.image = symbol("arrow.triangle.branch", 12)
        let bItem = item(branchIcon, branchLabel)
        branchLabel.textColor = Theme.fg   // riven: .status-item.branch = --fg

        langLabel.font = UIScale.font(11)
        langLabel.textColor = Theme.fgDim

        settings.image = symbol("gearshape", 13)
        settings.isBordered = false
        settings.imagePosition = .imageOnly
        settings.target = self; settings.action = #selector(settingsClicked)
        settings.translatesAutoresizingMaskIntoConstraints = false
        (settings.cell as? NSButtonCell)?.highlightsBy = []

        let left = NSStackView(views: [folderItem, bItem])
        left.orientation = .horizontal; left.spacing = 14; left.alignment = .centerY
        left.translatesAutoresizingMaskIntoConstraints = false
        branchItemRef = bItem; bItem.isHidden = true

        usageIcon.image = symbol("gauge.with.dots.needle.33percent", 12) ?? symbol("gauge", 12)
        usageItem.isHidden = true   // shown once usage is known
        usageItem.translatesAutoresizingMaskIntoConstraints = false
        usageItem.addGestureRecognizer(NSClickGestureRecognizer(target: self, action: #selector(usageClicked)))

        accountIcon.image = symbol("person.crop.circle", 12)
        accountItem.isHidden = true   // shown when signed in
        accountItem.translatesAutoresizingMaskIntoConstraints = false
        accountItem.addGestureRecognizer(NSClickGestureRecognizer(target: self, action: #selector(settingsClicked)))

        // Right cluster: [lang · account · usage · settings] laid out right-to-left.
        let right = NSStackView(views: [langLabel, accountItem, usageItem, settings])
        right.orientation = .horizontal; right.spacing = 14; right.alignment = .centerY
        right.translatesAutoresizingMaskIntoConstraints = false

        addSubview(left); addSubview(right)
        NSLayoutConstraint.activate([
            line.leadingAnchor.constraint(equalTo: leadingAnchor),
            line.trailingAnchor.constraint(equalTo: trailingAnchor),
            line.topAnchor.constraint(equalTo: topAnchor),
            line.heightAnchor.constraint(equalToConstant: 1),
            left.leadingAnchor.constraint(equalTo: leadingAnchor, constant: 12),
            left.centerYAnchor.constraint(equalTo: centerYAnchor),
            right.trailingAnchor.constraint(equalTo: trailingAnchor, constant: -10),
            right.centerYAnchor.constraint(equalTo: centerYAnchor)
        ])
        Theme.register(self)
    }
    required init?(coder: NSCoder) { fatalError() }
    private var branchItemRef: NSView?

    private func item(_ icon: NSImageView, _ label: NSTextField) -> NSView {
        icon.translatesAutoresizingMaskIntoConstraints = false
        icon.contentTintColor = Theme.fgDim
        icon.widthAnchor.constraint(equalToConstant: 14).isActive = true
        icon.heightAnchor.constraint(equalToConstant: 14).isActive = true
        label.font = UIScale.font(11)
        label.textColor = Theme.fgDim
        let s = NSStackView(views: [icon, label])
        s.orientation = .horizontal; s.spacing = 5; s.alignment = .centerY
        return s
    }

    private func symbol(_ name: String, _ size: CGFloat) -> NSImage? {
        let cfg = NSImage.SymbolConfiguration(pointSize: size, weight: .regular)
        return NSImage(systemSymbolName: name, accessibilityDescription: nil)?.withSymbolConfiguration(cfg)
    }

    @objc private func settingsClicked() { onSettings?() }

    func setWorkspaceName(_ name: String?) { folderLabel.stringValue = name ?? "" }
    func setBranch(_ branch: String?) {
        if let b = branch, !b.isEmpty {
            branchLabel.stringValue = b
            branchItemRef?.isHidden = false
        } else {
            branchItemRef?.isHidden = true
        }
    }
    func setFileInfo(_ text: String) { langLabel.stringValue = text }
    // Show the signed-in riven account (GitHub username / name); hide when signed out.
    func setAccount(_ name: String?) {
        if let name, !name.isEmpty { accountLabel.stringValue = name; accountItem.isHidden = false }
        else { accountLabel.stringValue = ""; accountItem.isHidden = true }
    }

    private var usageLimits: Usage.Limits?
    private var usageToday: Usage.Today?
    private var usagePopover: NSPopover?
    private var usagePinned = false
    var onPin: (() -> Void)?   // "pin to sidebar" clicked in the popover

    // When pinned to the sidebar, the status-bar copy hides itself (riven behaviour).
    func setUsagePinned(_ pinned: Bool) {
        usagePinned = pinned
        if pinned { usagePopover?.close(); usageItem.isHidden = true }
        setUsage(limits: usageLimits, today: usageToday)
    }

    // Prefer riven's "session% · weekly%" (remaining, from the OAuth usage API);
    // fall back to today's estimated $cost (local logs); hide if neither is known.
    // Clicking the widget opens the detail popover (riven's .usage-pop).
    // Usage + settings live in the app header now — hide them here (folder/branch stay).
    private var controlsInHeader = false
    func moveControlsToHeader() { controlsInHeader = true; settings.isHidden = true; usageItem.isHidden = true }

    func setUsage(limits: Usage.Limits?, today: Usage.Today?) {
        usageLimits = limits; usageToday = today
        if controlsInHeader { usageItem.isHidden = true; return }
        if usagePinned { usageItem.isHidden = true; return }   // shown in the sidebar instead
        let s = limits?.sessionRemaining, w = limits?.weeklyRemaining
        if s != nil || w != nil {
            let str = NSMutableAttributedString()
            let f = UIScale.font(11)
            func pct(_ v: Int) { str.append(NSAttributedString(string: "\(v)%", attributes: [.font: f, .foregroundColor: remColor(v)])) }
            if let s { pct(s) }
            if let w {
                if s != nil { str.append(NSAttributedString(string: " · ", attributes: [.font: f, .foregroundColor: Theme.fgDim])) }
                pct(w)
            }
            usageLabel.attributedStringValue = str
            usageItem.isHidden = false
        } else if let c = today?.totalCost, c > 0 {
            usageLabel.attributedStringValue = NSAttributedString(string: String(format: "$%.2f", c),
                attributes: [.font: UIScale.font(11), .foregroundColor: Theme.fgDim])
            usageItem.isHidden = false
        } else {
            usageItem.isHidden = true
        }
        // Update an already-open popover in place.
        if usagePopover?.isShown == true { presentUsagePopover() }
    }
    private func remColor(_ v: Int) -> NSColor { v < 20 ? Theme.danger : v < 50 ? Theme.warning : Theme.accent }

    @objc private func usageClicked() {
        if usagePopover?.isShown == true { usagePopover?.close(); return }
        presentUsagePopover()
    }
    private func presentUsagePopover() {
        let pop = usagePopover ?? NSPopover()
        pop.behavior = .transient
        pop.contentViewController = NSViewController()
        pop.contentViewController?.view = UsageUI.content(limits: usageLimits, today: usageToday) { [weak self] in
            self?.usagePopover?.close()
            self?.onPin?()
        }
        usagePopover = pop
        if !pop.isShown { pop.show(relativeTo: usageItem.bounds, of: usageItem, preferredEdge: .maxY) }
    }

    // Re-apply fonts at the current UI zoom.
    func rebuildForScale() {
        folderLabel.font = UIScale.font(11)
        branchLabel.font = UIScale.font(11)
        langLabel.font = UIScale.font(11)
        setUsage(limits: usageLimits, today: usageToday)
    }

    func applyTheme() {
        layer?.backgroundColor = Theme.bg2.cgColor
        line.layer?.backgroundColor = Theme.hairline.cgColor
        folderIcon.contentTintColor = Theme.fgDim
        folderLabel.textColor = Theme.fgDim
        branchIcon.contentTintColor = Theme.fgDim
        branchLabel.textColor = Theme.fg
        langLabel.textColor = Theme.fgDim
        settings.contentTintColor = Theme.fgDim
        settings.image = symbol("gearshape", 13)
    }
}
