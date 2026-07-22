import AppKit

// The usage popover (riven's .usage-pop): session/weekly remaining bars with reset
// times, today's per-model spend, and a "pin to sidebar" button. Presented from the
// status-bar usage widget. Also builds the compact pinned sidebar view.
enum UsageUI {
    static func remColor(_ v: Int) -> NSColor { v < 20 ? Theme.danger : v < 50 ? Theme.warning : Theme.accent }

    // "resets in {t}" text from an ISO timestamp (riven resetIn()).
    static func resetIn(_ iso: String?) -> String? {
        guard let iso, let date = ISO8601DateFormatter().date(from: iso) ?? {
            let f = ISO8601DateFormatter(); f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]; return f.date(from: iso)
        }() else { return nil }
        let ms = date.timeIntervalSinceNow
        guard ms > 0 else { return nil }
        let h = Int(ms / 3600)
        if h >= 24 { return "\(Int((Double(h)/24).rounded()))일 후 초기화" }
        if h >= 1 { return "\(h)시간 \(Int((ms.truncatingRemainder(dividingBy: 3600))/60))분 후 초기화" }
        return "\(max(1, Int(ms/60)))분 후 초기화"
    }

    // ---- one remaining-limit bar (label · pct · track/fill · reset) ----
    private static func bar(_ label: String, _ rem: Int?, _ resets: String?) -> NSView? {
        guard let rem else { return nil }
        let color = remColor(rem)
        let top = NSStackView()
        top.orientation = .horizontal; top.distribution = .fill
        let lab = NSTextField(labelWithString: label)
        lab.font = .systemFont(ofSize: 11); lab.textColor = Theme.fgDim
        let pct = NSTextField(labelWithString: "\(rem)%")
        pct.font = .systemFont(ofSize: 11); pct.textColor = color; pct.alignment = .right
        let spacer = NSView(); spacer.setContentHuggingPriority(.defaultLow, for: .horizontal)
        top.addArrangedSubview(lab); top.addArrangedSubview(spacer); top.addArrangedSubview(pct)

        let track = NSView(); track.wantsLayer = true
        track.layer?.backgroundColor = Theme.hoverStrong.cgColor
        track.layer?.cornerRadius = 2.5
        track.translatesAutoresizingMaskIntoConstraints = false
        let fill = NSView(); fill.wantsLayer = true
        fill.layer?.backgroundColor = color.cgColor; fill.layer?.cornerRadius = 2.5
        fill.translatesAutoresizingMaskIntoConstraints = false
        track.addSubview(fill)
        NSLayoutConstraint.activate([
            track.heightAnchor.constraint(equalToConstant: 5),
            fill.leadingAnchor.constraint(equalTo: track.leadingAnchor),
            fill.topAnchor.constraint(equalTo: track.topAnchor),
            fill.bottomAnchor.constraint(equalTo: track.bottomAnchor),
            fill.widthAnchor.constraint(equalTo: track.widthAnchor, multiplier: max(0.01, CGFloat(rem)/100.0))
        ])
        let col = NSStackView(views: [top, track])
        col.orientation = .vertical; col.spacing = 4; col.alignment = .leading
        top.translatesAutoresizingMaskIntoConstraints = false
        top.widthAnchor.constraint(equalTo: col.widthAnchor).isActive = true
        track.widthAnchor.constraint(equalTo: col.widthAnchor).isActive = true
        if let resets {
            let r = NSTextField(labelWithString: resets)
            r.font = .systemFont(ofSize: 10); r.textColor = Theme.fgDim
            col.addArrangedSubview(r)
        }
        return col
    }

    // Compact content for the pinned sidebar strip (riven's UsagePinned): just the
    // header + the two remaining-limit bars + a today one-liner. No per-model rows,
    // so it fits the fixed sidebar strip without clipping.
    static func pinnedContent(limits: Usage.Limits?, today: Usage.Today?, onUnpin: @escaping () -> Void) -> NSView {
        let stack = NSStackView()
        stack.orientation = .vertical; stack.spacing = 7; stack.alignment = .leading
        stack.edgeInsets = NSEdgeInsets(top: 6, left: 12, bottom: 8, right: 12)
        stack.translatesAutoresizingMaskIntoConstraints = false
        if let s = bar("세션 (5시간)", limits?.sessionRemaining, resetIn(limits?.sessionResetsAt)) { stack.addArrangedSubview(s) }
        if let w = bar("주간 (7일)", limits?.weeklyRemaining, resetIn(limits?.weeklyResetsAt)) { stack.addArrangedSubview(w) }
        if let today, today.totalTokens > 0 {
            let t = NSTextField(labelWithString: "오늘 · $\(String(format: "%.2f", today.totalCost)) · \(Usage.fmtTokens(today.totalTokens))")
            t.font = .systemFont(ofSize: 10); t.textColor = Theme.fgDim
            stack.addArrangedSubview(t)
        }
        // Each bar's inner rows constrain to the stack width.
        for v in stack.arrangedSubviews {
            v.translatesAutoresizingMaskIntoConstraints = false
            v.widthAnchor.constraint(equalTo: stack.widthAnchor, constant: -24).isActive = true
        }
        return stack
    }

    private static func head(_ text: String) -> NSTextField {
        let l = NSTextField(labelWithString: text.uppercased())
        l.font = .systemFont(ofSize: 10, weight: .semibold); l.textColor = Theme.fgDim
        return l
    }

    // Build the popover body. `onPin` is called when the pin button is clicked.
    static func content(limits: Usage.Limits?, today: Usage.Today?, onPin: @escaping () -> Void) -> NSView {
        let stack = NSStackView()
        stack.orientation = .vertical; stack.spacing = 8; stack.alignment = .leading
        stack.edgeInsets = NSEdgeInsets(top: 10, left: 12, bottom: 10, right: 12)
        stack.translatesAutoresizingMaskIntoConstraints = false

        // Header row: title + pin button.
        let title = head("남은 한도 (Claude)")
        let pin = NSButton(title: " 사이드바에 고정", target: nil, action: nil)
        pin.image = NSImage(systemSymbolName: "pin", accessibilityDescription: nil)?
            .withSymbolConfiguration(.init(pointSize: 10, weight: .regular))
        pin.imagePosition = .imageLeading
        pin.isBordered = false; pin.font = .systemFont(ofSize: 10); pin.contentTintColor = Theme.fgDim
        let pinHandler = PinTarget(onPin); pin.target = pinHandler; pin.action = #selector(PinTarget.fire)
        objc_setAssociatedObject(pin, &PinTarget.key, pinHandler, .OBJC_ASSOCIATION_RETAIN)
        let headRow = NSStackView(views: [title, NSView(), pin])
        headRow.orientation = .horizontal
        (headRow.arrangedSubviews[1]).setContentHuggingPriority(.defaultLow, for: .horizontal)
        headRow.translatesAutoresizingMaskIntoConstraints = false
        stack.addArrangedSubview(headRow)

        if let s = bar("세션 (5시간)", limits?.sessionRemaining, resetIn(limits?.sessionResetsAt)) {
            stack.addArrangedSubview(s); s.widthAnchor.constraint(equalTo: stack.widthAnchor, constant: -24).isActive = true
        }
        if let w = bar("주간 (7일)", limits?.weeklyRemaining, resetIn(limits?.weeklyResetsAt)) {
            stack.addArrangedSubview(w); w.widthAnchor.constraint(equalTo: stack.widthAnchor, constant: -24).isActive = true
        }

        if let today, today.totalTokens > 0 {
            stack.addArrangedSubview(head("오늘 사용량 — $\(String(format: "%.2f", today.totalCost)) · \(Usage.fmtTokens(today.totalTokens))"))
            for m in today.perModel.prefix(6) {
                let name = NSTextField(labelWithString: m.name)
                name.font = .monospacedSystemFont(ofSize: 10, weight: .regular); name.textColor = Theme.fgDim
                name.lineBreakMode = .byTruncatingTail
                let tok = NSTextField(labelWithString: Usage.fmtTokens(m.input + m.output + m.cacheWrite + m.cacheRead))
                tok.font = .systemFont(ofSize: 11); tok.textColor = Theme.fgDim
                let cost = NSTextField(labelWithString: "$\(String(format: "%.2f", m.cost))")
                cost.font = .systemFont(ofSize: 11); cost.textColor = Theme.fg; cost.alignment = .right
                let sp = NSView(); sp.setContentHuggingPriority(.defaultLow, for: .horizontal)
                let r = NSStackView(views: [name, sp, tok, cost])
                r.orientation = .horizontal; r.spacing = 10
                r.translatesAutoresizingMaskIntoConstraints = false
                r.widthAnchor.constraint(equalToConstant: 220).isActive = true
                stack.addArrangedSubview(r)
            }
        }
        let note = NSTextField(labelWithString: "Claude Code 로컬 로그 기반 · API 가격 추정")
        note.font = .systemFont(ofSize: 10); note.textColor = Theme.fgDim
        stack.addArrangedSubview(note)

        headRow.widthAnchor.constraint(equalTo: stack.widthAnchor, constant: -24).isActive = true

        let container = NSView()
        container.addSubview(stack)
        NSLayoutConstraint.activate([
            stack.topAnchor.constraint(equalTo: container.topAnchor),
            stack.bottomAnchor.constraint(equalTo: container.bottomAnchor),
            stack.leadingAnchor.constraint(equalTo: container.leadingAnchor),
            stack.trailingAnchor.constraint(equalTo: container.trailingAnchor),
            container.widthAnchor.constraint(equalToConstant: 244)
        ])
        return container
    }
}

private final class PinTarget: NSObject {
    static var key = 0
    private let action: () -> Void
    init(_ action: @escaping () -> Void) { self.action = action }
    @objc func fire() { action() }
}
