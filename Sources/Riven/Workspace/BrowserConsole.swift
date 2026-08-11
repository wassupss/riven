import AppKit

// 브라우저 개발자 도구 (콘솔).
//
// WKWebView 에는 개발자 도구를 여는 공개 API 가 없다. 그래서 지금까지 "개발자 도구" 메뉴는
// 안내문 한 줄만 띄웠고, 그게 전부였다 - 도구가 아니라 알림이었다.
// 대신 브라우저가 실제로 해 주는 일을 여기서 한다: 페이지의 console 출력과 오류를 모아 보여
// 주고, 그 페이지 문맥에서 코드를 실행해 결과를 돌려준다. 크롬 콘솔 탭과 같은 쓰임새다.
// (요소 검사는 페이지에서 오른쪽 클릭 → "요소 정보 검사" 로 Web Inspector 가 열린다.)
final class BrowserConsole: NSView, Themable {
    /// 입력한 코드를 페이지에서 실행해 달라. 결과 문자열을 돌려준다.
    var onEval: ((_ js: String, _ done: @escaping (String) -> Void) -> Void)?
    var onClose: (() -> Void)?

    enum Level { case log, warn, error, input, result }

    private let stack = NSStackView()
    private let scroll = NSScrollView()
    private let input = NSTextField()
    private let title = NSTextField(labelWithString: t("browser.console"))
    private let clearBtn = NSButton()
    private let closeBtn = NSButton()
    private var history: [String] = []
    private var historyIndex = 0
    /// 줄이 무한정 쌓이면 스크롤이 무거워진다. 오래된 것부터 버린다.
    private let maxLines = 500

    override init(frame: NSRect) {
        super.init(frame: frame)
        wantsLayer = true

        title.font = UIScale.font(UIScale.caption, .semibold)
        title.translatesAutoresizingMaskIntoConstraints = false
        for (b, symbol, sel) in [(clearBtn, "trash", #selector(clearTapped)),
                                 (closeBtn, "xmark", #selector(closeTapped))] {
            b.image = NSImage(systemSymbolName: symbol, accessibilityDescription: nil)
            b.image?.isTemplate = true
            b.imagePosition = .imageOnly; b.isBordered = false
            b.target = self; b.action = sel
            b.translatesAutoresizingMaskIntoConstraints = false
        }
        clearBtn.toolTip = t("browser.consoleClear")
        closeBtn.toolTip = t("common.close")

        stack.orientation = .vertical; stack.spacing = 1; stack.alignment = .leading
        stack.translatesAutoresizingMaskIntoConstraints = false
        let doc = FlippedView()
        doc.translatesAutoresizingMaskIntoConstraints = false
        doc.addSubview(stack)
        scroll.documentView = doc
        scroll.drawsBackground = false
        scroll.hasVerticalScroller = true
        scroll.translatesAutoresizingMaskIntoConstraints = false

        input.placeholderString = t("browser.consolePlaceholder")
        input.font = UIScale.mono(UIScale.small)
        input.isBordered = false
        input.drawsBackground = false
        input.focusRingType = .none
        input.target = self; input.action = #selector(runInput)
        input.delegate = self
        input.translatesAutoresizingMaskIntoConstraints = false

        [title, clearBtn, closeBtn, scroll, input].forEach { addSubview($0) }
        NSLayoutConstraint.activate([
            title.leadingAnchor.constraint(equalTo: leadingAnchor, constant: 10),
            title.topAnchor.constraint(equalTo: topAnchor, constant: 5),
            closeBtn.trailingAnchor.constraint(equalTo: trailingAnchor, constant: -8),
            closeBtn.centerYAnchor.constraint(equalTo: title.centerYAnchor),
            closeBtn.widthAnchor.constraint(equalToConstant: 14),
            clearBtn.trailingAnchor.constraint(equalTo: closeBtn.leadingAnchor, constant: -8),
            clearBtn.centerYAnchor.constraint(equalTo: title.centerYAnchor),
            clearBtn.widthAnchor.constraint(equalToConstant: 14),
            scroll.leadingAnchor.constraint(equalTo: leadingAnchor),
            scroll.trailingAnchor.constraint(equalTo: trailingAnchor),
            scroll.topAnchor.constraint(equalTo: title.bottomAnchor, constant: 4),
            scroll.bottomAnchor.constraint(equalTo: input.topAnchor, constant: -4),
            doc.topAnchor.constraint(equalTo: scroll.contentView.topAnchor),
            doc.leadingAnchor.constraint(equalTo: scroll.contentView.leadingAnchor),
            doc.widthAnchor.constraint(equalTo: scroll.contentView.widthAnchor),
            stack.topAnchor.constraint(equalTo: doc.topAnchor),
            stack.leadingAnchor.constraint(equalTo: doc.leadingAnchor),
            stack.trailingAnchor.constraint(equalTo: doc.trailingAnchor),
            stack.bottomAnchor.constraint(equalTo: doc.bottomAnchor),
            input.leadingAnchor.constraint(equalTo: leadingAnchor, constant: 10),
            input.trailingAnchor.constraint(equalTo: trailingAnchor, constant: -10),
            input.bottomAnchor.constraint(equalTo: bottomAnchor, constant: -6),
        ])
        Theme.register(self)
    }
    required init?(coder: NSCoder) { fatalError() }

    func focusInput() { window?.makeFirstResponder(input) }

    @objc private func clearTapped() { clear() }
    @objc private func closeTapped() { onClose?() }

    func clear() {
        stack.arrangedSubviews.forEach { $0.removeFromSuperview() }
    }
    /// 페이지가 새 문서를 열면 콘솔도 비운다 (크롬의 "탐색 시 지우기" 기본 동작).
    func pageChanged(_ url: String) {
        clear()
        add(.log, "→ " + url)
    }

    func add(_ level: Level, _ text: String) {
        let line = NSTextField(labelWithString: text)
        line.font = UIScale.mono(UIScale.caption)
        line.lineBreakMode = .byWordWrapping
        line.maximumNumberOfLines = 8
        line.textColor = color(level)
        line.translatesAutoresizingMaskIntoConstraints = false
        line.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
        stack.addArrangedSubview(line)
        line.widthAnchor.constraint(equalTo: stack.widthAnchor, constant: -16).isActive = true
        if stack.arrangedSubviews.count > maxLines {
            stack.arrangedSubviews.first?.removeFromSuperview()
        }
        DispatchQueue.main.async { [weak self] in self?.scrollToEnd() }
    }
    private func scrollToEnd() {
        guard let doc = scroll.documentView else { return }
        scroll.contentView.scroll(to: NSPoint(x: 0, y: max(0, doc.bounds.height - scroll.contentSize.height)))
        scroll.reflectScrolledClipView(scroll.contentView)
    }
    private func color(_ l: Level) -> NSColor {
        switch l {
        case .log: return Theme.fgDim
        case .warn: return Theme.warning
        case .error: return Theme.danger
        case .input: return Theme.accent
        case .result: return Theme.fg
        }
    }

    @objc private func runInput() {
        let js = input.stringValue.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !js.isEmpty else { return }
        input.stringValue = ""
        history.append(js); historyIndex = history.count
        add(.input, "› " + js)
        // 사용자가 콘솔에 치는 건 식(expression)이다. return 을 붙여 값을 돌려받는다.
        let wrapped = js.contains("return") ? js : "return (\(js));"
        onEval?(wrapped) { [weak self] result in
            self?.add(.result, result)
        }
    }

    /// 벤치용: 지금까지 쌓인 줄.
    func debugLines() -> [String] {
        stack.arrangedSubviews.compactMap { ($0 as? NSTextField)?.stringValue }
    }
    func debugRun(_ js: String) {
        input.stringValue = js
        runInput()
    }

    func applyTheme() {
        layer?.backgroundColor = Theme.bg2.cgColor
        title.textColor = Theme.fgDim
        clearBtn.contentTintColor = Theme.fgDim
        closeBtn.contentTintColor = Theme.fgDim
        input.textColor = Theme.fg
    }

    /// 페이지에 심는 스크립트: console 출력과 오류를 riven 으로 보낸다.
    /// 브라우저 콘솔이 잡아 주는 것과 같은 것들 - log/warn/error, 던져진 예외, 처리되지 않은
    /// 프로미스 거절. (원래 console 도 그대로 두어 Safari Web Inspector 로 봐도 똑같다.)
    static let hookScript = """
    (function(){
      if (window.__rivenConsole) return; window.__rivenConsole = 1;
      function send(level, args) {
        try {
          var parts = [];
          for (var i = 0; i < args.length; i++) {
            var a = args[i];
            if (a instanceof Error) { parts.push(a.message + (a.stack ? "\\n" + a.stack : "")); }
            else if (typeof a === "object" && a !== null) {
              try { parts.push(JSON.stringify(a)); } catch (e) { parts.push(String(a)); }
            } else { parts.push(String(a)); }
          }
          window.webkit.messageHandlers.rivenconsole.postMessage(
            { level: level, text: parts.join(" ").slice(0, 4000) });
        } catch (e) {}
      }
      ["log", "info", "debug", "warn", "error"].forEach(function(name){
        var orig = console[name];
        console[name] = function(){ send(name === "info" || name === "debug" ? "log" : name, arguments);
                                    if (orig) orig.apply(console, arguments); };
      });
      window.addEventListener("error", function(e){
        send("error", [e.message + " (" + (e.filename || "") + ":" + (e.lineno || 0) + ")"]);
      });
      window.addEventListener("unhandledrejection", function(e){
        send("error", ["Unhandled promise rejection: " + (e.reason && e.reason.message ? e.reason.message : String(e.reason))]);
      });
    })();
    """
}

extension BrowserConsole: NSTextFieldDelegate {
    /// 위·아래로 지난 입력을 되돌려 본다 (콘솔에서 늘 하는 것).
    func control(_ control: NSControl, textView: NSTextView, doCommandBy sel: Selector) -> Bool {
        guard control === input, !history.isEmpty else { return false }
        switch sel {
        case #selector(NSResponder.moveUp(_:)):
            historyIndex = max(0, historyIndex - 1)
            input.stringValue = history[min(historyIndex, history.count - 1)]
            return true
        case #selector(NSResponder.moveDown(_:)):
            historyIndex = min(history.count, historyIndex + 1)
            input.stringValue = historyIndex >= history.count ? "" : history[historyIndex]
            return true
        default: return false
        }
    }
}
