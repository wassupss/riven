import AppKit

// The usage popover (riven's .usage-pop): session/weekly remaining bars with reset
// times, today's per-model spend, and a "pin to sidebar" button. Presented from the
// status-bar usage widget. Also builds the compact pinned sidebar view.
enum UsageUI {
    static func remColor(_ v: Int) -> NSColor { v < 20 ? Theme.danger : v < 50 ? Theme.warning : Theme.accent }

    // "resets in {t}" text from an ISO timestamp (riven resetIn()).
    /// Date 판. Codex 의 resets_at 은 epoch 초라 ISO 문자열로 되돌릴 이유가 없다.
    static func resetIn(_ date: Date?) -> String? {
        guard let date else { return nil }
        let ms = date.timeIntervalSinceNow
        guard ms > 0 else { return nil }
        let h = Int(ms / 3600)
        if h >= 24 { return "\(Int((Double(h)/24).rounded()))일 후 초기화" }
        if h >= 1 { return "\(h)시간 \(Int((ms.truncatingRemainder(dividingBy: 3600))/60))분 후 초기화" }
        return "\(max(1, Int(ms/60)))분 후 초기화"
    }

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
        lab.font = UIScale.font(UIScale.small); lab.textColor = Theme.fgDim
        let pct = NSTextField(labelWithString: "\(rem)%")
        pct.font = UIScale.font(UIScale.small); pct.textColor = color; pct.alignment = .right
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
            r.font = UIScale.font(UIScale.caption); r.textColor = Theme.fgDim
            col.addArrangedSubview(r)
        }
        return col
    }

    // Compact content for the pinned sidebar strip (riven's UsagePinned): just the
    // header + the two remaining-limit bars + a today one-liner. No per-model rows,
    // so it fits the fixed sidebar strip without clipping.
    static func pinnedContent(limits: Usage.Limits?, today: Usage.Today?,
                              codexLimits: CodexUsage.Limits? = nil,
                              onUnpin: @escaping () -> Void) -> NSView {
        let stack = NSStackView()
        stack.orientation = .vertical; stack.spacing = 7; stack.alignment = .leading
        stack.edgeInsets = NSEdgeInsets(top: 6, left: 12, bottom: 8, right: 12)
        stack.translatesAutoresizingMaskIntoConstraints = false
        if let s = bar("세션 (5시간)", limits?.sessionRemaining, resetIn(limits?.sessionResetsAt)) { stack.addArrangedSubview(s) }
        if let w = bar("주간 (7일)", limits?.weeklyRemaining, resetIn(limits?.weeklyResetsAt)) { stack.addArrangedSubview(w) }
        // Codex 는 창이 하나뿐이라 막대 하나로 족하다. 라벨에 CLI 이름을 넣어 두지 않으면
        // Claude 의 세 번째 창처럼 읽힌다.
        if let cx = codexLimits,
           let b = bar("Codex (\(CodexUsage.windowLabel(cx.windowMinutes)))",
                       cx.remainingPercent, resetIn(cx.resetsAt)) {
            stack.addArrangedSubview(b)
        }
        if let today, today.totalTokens > 0 {
            let t = NSTextField(labelWithString: "오늘 · $\(String(format: "%.2f", today.totalCost)) · \(Usage.fmtTokens(today.totalTokens))")
            t.font = UIScale.font(UIScale.caption); t.textColor = Theme.fgDim
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
        l.font = UIScale.font(UIScale.caption, .semibold); l.textColor = Theme.fgDim
        return l
    }

    // Build the popover body. `onPin` is called when the pin button is clicked.
    static func content(limits: Usage.Limits?, today: Usage.Today?,
                        freshness: String? = nil,
                        codexLimits: CodexUsage.Limits? = nil,
                        codexToday: CodexUsage.Today = CodexUsage.Today(),
                        onReload: (() -> Void)? = nil, onPin: @escaping () -> Void) -> NSView {
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
        pin.isBordered = false; pin.font = UIScale.font(UIScale.caption); pin.contentTintColor = Theme.fgDim
        let pinHandler = PinTarget(onPin); pin.target = pinHandler; pin.action = #selector(PinTarget.fire)
        objc_setAssociatedObject(pin, &PinTarget.key, pinHandler, .OBJC_ASSOCIATION_RETAIN)
        // 새로고침: 턴이 끝날 때 자동으로 갱신되지만, 지금 당장 확인하고 싶을 때가 있다.
        let reload = NSButton(title: "", target: nil, action: nil)
        reload.image = NSImage(systemSymbolName: "arrow.clockwise", accessibilityDescription: t("common.refresh"))?
            .withSymbolConfiguration(.init(pointSize: 10, weight: .regular))
        reload.imagePosition = .imageOnly
        reload.isBordered = false; reload.contentTintColor = Theme.fgDim
        reload.toolTip = t("common.refresh")
        if let onReload {
            let h = PinTarget(onReload); reload.target = h; reload.action = #selector(PinTarget.fire)
            objc_setAssociatedObject(reload, &PinTarget.key2, h, .OBJC_ASSOCIATION_RETAIN)
        } else { reload.isHidden = true }
        let headRow = NSStackView(views: [title, NSView(), reload, pin])
        headRow.orientation = .horizontal
        (headRow.arrangedSubviews[1]).setContentHuggingPriority(.defaultLow, for: .horizontal)
        headRow.translatesAutoresizingMaskIntoConstraints = false
        stack.addArrangedSubview(headRow)
        // 언제 것인지 · 왜 못 갱신했는지. 숫자만 보여 주면 멈춰 있어도 알 수가 없다.
        if let freshness {
            let f = NSTextField(labelWithString: freshness)
            f.font = UIScale.font(UIScale.caption)
            f.textColor = freshness.contains("·") ? Theme.warning : Theme.fgDim
            f.lineBreakMode = .byWordWrapping
            f.maximumNumberOfLines = 2
            f.preferredMaxLayoutWidth = 220
            stack.addArrangedSubview(f)
        }

        if let s = bar("세션 (5시간)", limits?.sessionRemaining, resetIn(limits?.sessionResetsAt)) {
            stack.addArrangedSubview(s); s.widthAnchor.constraint(equalTo: stack.widthAnchor, constant: -24).isActive = true
        }
        if let w = bar("주간 (7일)", limits?.weeklyRemaining, resetIn(limits?.weeklyResetsAt)) {
            stack.addArrangedSubview(w); w.widthAnchor.constraint(equalTo: stack.widthAnchor, constant: -24).isActive = true
        }

        // Codex 는 창이 하나뿐이고 방향도 반대(쓴 %)라 Claude 표에 섞지 않는다. 남은 비율로
        // 뒤집는 일은 [[CodexUsage]] 가 이미 해 뒀다 — 화면에서는 두 CLI 가 같은 방향이다.
        if let cx = codexLimits {
            stack.addArrangedSubview(head(t("usage.codexTitle")))
            let label = t("usage.codexWindow", ["w": CodexUsage.windowLabel(cx.windowMinutes)])
            if let b = bar(label, cx.remainingPercent, resetIn(cx.resetsAt)) {
                stack.addArrangedSubview(b)
                b.widthAnchor.constraint(equalTo: stack.widthAnchor, constant: -24).isActive = true
            }
        }

        if let today, today.totalTokens > 0 {
            // 이 숫자·금액은 Claude 로그만의 것이다. 바로 아래에 Codex 줄이 붙기 때문에
            // "오늘 사용량" 이라고만 적으면 합계로 읽힌다.
            stack.addArrangedSubview(head("오늘 · Claude · $\(String(format: "%.2f", today.totalCost)) · \(Usage.fmtTokens(today.totalTokens))"))
            for m in today.perModel.prefix(6) {
                let name = NSTextField(labelWithString: m.name)
                name.font = UIScale.mono(UIScale.caption, .regular); name.textColor = Theme.fgDim
                name.lineBreakMode = .byTruncatingTail
                let tok = NSTextField(labelWithString: Usage.fmtTokens(m.input + m.output + m.cacheWrite + m.cacheRead))
                tok.font = UIScale.font(UIScale.small); tok.textColor = Theme.fgDim
                let cost = NSTextField(labelWithString: "$\(String(format: "%.2f", m.cost))")
                cost.font = UIScale.font(UIScale.small); cost.textColor = Theme.fg; cost.alignment = .right
                let sp = NSView(); sp.setContentHuggingPriority(.defaultLow, for: .horizontal)
                let r = NSStackView(views: [name, sp, tok, cost])
                r.orientation = .horizontal; r.spacing = 10
                r.translatesAutoresizingMaskIntoConstraints = false
                r.widthAnchor.constraint(equalToConstant: 220).isActive = true
                stack.addArrangedSubview(r)
            }
        }
        // Codex 턴은 모델별 표에 못 섞는다 — 비용을 추정할 가격표가 없다(구독). 토큰과
        // 턴 수만 사실대로 적는다. 값을 모르는 칸에 0 을 적으면 안 쓴 것처럼 읽힌다.
        if codexToday.turns > 0 {
            let line = NSTextField(labelWithString: t("usage.todayCodex", [
                "tok": Usage.fmtTokens(codexToday.totalTokens), "n": String(codexToday.turns)]))
            line.font = UIScale.font(UIScale.small); line.textColor = Theme.fgDim
            stack.addArrangedSubview(line)
        }

        // 두 CLI 의 출처가 다르다: 금액 추정은 Claude 쪽에만 해당하고, Codex 는 구독이라
        // 가격표가 없어 토큰만 센다.
        let note = NSTextField(labelWithString: codexToday.turns > 0
            ? "각 CLI 로컬 로그 기반 · 금액은 Claude API 가격 추정"
            : "Claude Code 로컬 로그 기반 · API 가격 추정")
        note.font = UIScale.font(UIScale.caption); note.textColor = Theme.fgDim
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
    static var key2 = 0
    private let action: () -> Void
    init(_ action: @escaping () -> Void) { self.action = action }
    @objc func fire() { action() }
}
