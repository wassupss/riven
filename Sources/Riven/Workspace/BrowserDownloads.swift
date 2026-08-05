import AppKit
import WebKit

// 내려받기 목록.
//
// 지금까지는 상태 줄에 한 줄 뜨고 끝났고, 다 받으면 Finder 가 앞으로 튀어나왔다 — 일하다가
// 창이 바뀌는 건 방해다. 대신 주소창 옆에 받는 중 표시를 두고, 눌러야 목록이 열리게 한다.
final class DownloadItem: NSObject {
    let name: String
    let dest: URL
    private(set) var done = false
    private(set) var failed: String?
    private(set) var fraction: Double = 0
    var onChange: (() -> Void)?
    private var token: NSKeyValueObservation?

    init(name: String, dest: URL, progress: Progress?) {
        self.name = name
        self.dest = dest
        super.init()
        token = progress?.observe(\.fractionCompleted, options: [.new]) { [weak self] p, _ in
            DispatchQueue.main.async {
                self?.fraction = p.fractionCompleted
                self?.onChange?()
            }
        }
    }
    deinit { token?.invalidate() }

    func finish() { done = true; fraction = 1; onChange?() }
    func fail(_ message: String) { failed = message; onChange?() }
}

/// 받은 것들 목록 (팝오버 안에 들어간다).
final class DownloadsView: NSView, Themable {
    var items: [DownloadItem] = [] { didSet { reload() } }
    var onReveal: ((DownloadItem) -> Void)?
    var onOpen: ((DownloadItem) -> Void)?
    var onClear: (() -> Void)?

    private let stack = NSStackView()
    private let empty = NSTextField(labelWithString: t("browser.noDownloads"))
    private let clear = NSButton()

    override init(frame: NSRect) {
        super.init(frame: frame)
        wantsLayer = true
        stack.orientation = .vertical; stack.spacing = 0; stack.alignment = .leading
        stack.translatesAutoresizingMaskIntoConstraints = false
        empty.font = UIScale.font(UIScale.small)
        empty.translatesAutoresizingMaskIntoConstraints = false
        clear.title = t("browser.clearDownloads")
        clear.font = UIScale.font(UIScale.caption)
        clear.isBordered = false
        clear.target = self; clear.action = #selector(clearTapped)
        clear.translatesAutoresizingMaskIntoConstraints = false
        [stack, empty, clear].forEach { addSubview($0) }
        NSLayoutConstraint.activate([
            stack.leadingAnchor.constraint(equalTo: leadingAnchor),
            stack.trailingAnchor.constraint(equalTo: trailingAnchor),
            stack.topAnchor.constraint(equalTo: topAnchor, constant: 6),
            empty.centerXAnchor.constraint(equalTo: centerXAnchor),
            empty.centerYAnchor.constraint(equalTo: centerYAnchor),
            clear.trailingAnchor.constraint(equalTo: trailingAnchor, constant: -8),
            clear.bottomAnchor.constraint(equalTo: bottomAnchor, constant: -4),
        ])
        Theme.register(self)
    }
    required init?(coder: NSCoder) { fatalError() }

    @objc private func clearTapped() { onClear?() }

    private func reload() {
        stack.arrangedSubviews.forEach { $0.removeFromSuperview() }
        empty.isHidden = !items.isEmpty
        empty.textColor = Theme.fgDim
        clear.isHidden = items.isEmpty
        clear.contentTintColor = Theme.fgDim
        for it in items {
            let row = Row()
            row.configure(it)
            row.onOpen = { [weak self] in self?.onOpen?(it) }
            row.onReveal = { [weak self] in self?.onReveal?(it) }
            it.onChange = { [weak row] in row?.configure(it) }
            stack.addArrangedSubview(row)
            row.widthAnchor.constraint(equalTo: stack.widthAnchor).isActive = true
        }
    }
    func applyTheme() {
        layer?.backgroundColor = Theme.bg.cgColor
        reload()
    }

    /// 한 줄: 파일 이름 + 진행 막대(받는 중) 또는 상태 + Finder 버튼.
    private final class Row: NSView {
        var onOpen: (() -> Void)?
        var onReveal: (() -> Void)?
        private let name = NSTextField(labelWithString: "")
        private let state = NSTextField(labelWithString: "")
        private let bar = NSView()
        private var barWidth: NSLayoutConstraint!
        private let reveal = NSButton()

        override init(frame: NSRect) {
            super.init(frame: frame)
            wantsLayer = true
            bar.wantsLayer = true
            reveal.image = NSImage(systemSymbolName: "folder", accessibilityDescription: t("browser.revealInFinder"))
            reveal.image?.isTemplate = true; reveal.imagePosition = .imageOnly
            reveal.isBordered = false
            reveal.toolTip = t("browser.revealInFinder")
            reveal.target = self; reveal.action = #selector(revealTapped)
            [name, state, bar, reveal].forEach {
                $0.translatesAutoresizingMaskIntoConstraints = false
                addSubview($0)
            }
            name.lineBreakMode = .byTruncatingMiddle
            barWidth = bar.widthAnchor.constraint(equalToConstant: 0)
            NSLayoutConstraint.activate([
                heightAnchor.constraint(equalToConstant: UIScale.pt(38)),
                name.leadingAnchor.constraint(equalTo: leadingAnchor, constant: 10),
                name.topAnchor.constraint(equalTo: topAnchor, constant: 5),
                name.trailingAnchor.constraint(lessThanOrEqualTo: reveal.leadingAnchor, constant: -6),
                state.leadingAnchor.constraint(equalTo: name.leadingAnchor),
                state.topAnchor.constraint(equalTo: name.bottomAnchor, constant: 2),
                bar.leadingAnchor.constraint(equalTo: name.leadingAnchor),
                bar.bottomAnchor.constraint(equalTo: bottomAnchor, constant: -4),
                bar.heightAnchor.constraint(equalToConstant: 2),
                barWidth,
                reveal.trailingAnchor.constraint(equalTo: trailingAnchor, constant: -8),
                reveal.centerYAnchor.constraint(equalTo: centerYAnchor),
                reveal.widthAnchor.constraint(equalToConstant: 16),
            ])
        }
        required init?(coder: NSCoder) { fatalError() }

        func configure(_ it: DownloadItem) {
            name.stringValue = it.name
            name.font = UIScale.font(UIScale.small)
            name.textColor = Theme.fg
            state.font = UIScale.font(UIScale.caption)
            reveal.contentTintColor = Theme.fgDim
            if let f = it.failed {
                state.stringValue = f
                state.textColor = Theme.danger
                bar.isHidden = true
            } else if it.done {
                state.stringValue = t("browser.downloadDone")
                state.textColor = Theme.fgDim
                bar.isHidden = true
            } else {
                state.stringValue = "\(Int(it.fraction * 100))%"
                state.textColor = Theme.fgDim
                bar.isHidden = false
                bar.layer?.backgroundColor = Theme.accent.cgColor
                barWidth.constant = max(2, bounds.width * CGFloat(it.fraction))
            }
        }
        override func mouseDown(with e: NSEvent) { onOpen?() }
        @objc private func revealTapped() { onReveal?() }
    }
}
