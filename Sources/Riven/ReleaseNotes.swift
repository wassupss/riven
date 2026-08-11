import AppKit

// 업데이트한 뒤 처음 켤 때 "새로워진 점" 을 보여 준다.
//
// 규칙 두 가지가 이 기능의 전부다.
//
//  1. **버전이 실제로 바뀌었을 때만.** 마지막으로 본 버전을 적어 두고 지금 버전과 다를
//     때만 띄운다. 같은 버전을 다시 켜는 것은 업데이트가 아니다.
//  2. **새로 설치한 사람에게는 보여 주지 않는다.** 적어 둔 버전이 아예 없으면 처음
//     쓰는 사람이다 - 써 본 적 없는 앱의 "무엇이 바뀌었나" 는 읽을 수 있는 글이 아니다.
//     이때는 조용히 지금 버전만 적어 두고 넘어간다.
//
// 본문은 앱 안에 넣어 나간다. 실행 시점에 네트워크를 타면 느리고, 오프라인이면 안 뜨고,
// 실패 처리까지 필요해진다 - 파일 하나 읽는 것으로 끝나는 편이 낫다.
enum ReleaseNotes {

    private static let seenKey = "lastSeenVersion"

    static var currentVersion: String {
        Bundle.main.infoDictionary?["CFBundleShortVersionString"] as? String ?? "0.0.1"
    }

    /// 이 버전의 노트 본문 (언어에 맞는 것, 없으면 다른 언어라도).
    static func body() -> String? {
        let langs = I18n.current == .ko ? ["ko", "en"] : ["en", "ko"]
        for lang in langs {
            if let url = Bundle.riven.url(forResource: "release-notes.\(lang)", withExtension: "md",
                                          subdirectory: "Resources"),
               let s = try? String(contentsOf: url, encoding: .utf8),
               !s.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                return s
            }
        }
        return nil
    }

    /// 켤 때 한 번 부른다. 띄웠으면 true.
    @discardableResult
    static func showIfUpdated(over parent: NSWindow?) -> Bool {
        let seen = Settings.shared.string(seenKey, "")
        let now = currentVersion
        guard seen != now else { return false }
        // 처음 쓰는 사람: 조용히 기록만 하고 넘어간다.
        guard !seen.isEmpty else { Settings.shared.set(seenKey, now); return false }
        Settings.shared.set(seenKey, now)
        guard let text = body() else { return false }
        show(text, over: parent)
        return true
    }

    /// 설정에서 다시 열 때 (버전 기록은 건드리지 않는다).
    static func showNow(over parent: NSWindow?) {
        guard let text = body() else { return }
        show(text, over: parent)
    }

    private static var window: NSWindow?
    /// 벤치용: 지금 떠 있는 창.
    static var debugWindow: NSWindow? { window }

    private static func show(_ text: String, over parent: NSWindow?) {
        window?.close()
        let w = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 560, height: 620),
                         styleMask: [.titled, .closable, .fullSizeContentView],
                         backing: .buffered, defer: false)
        w.titlebarAppearsTransparent = true
        w.titleVisibility = .hidden
        w.isMovableByWindowBackground = true
        w.backgroundColor = Theme.bg
        w.title = t("notes.whatsNew")
        w.isReleasedWhenClosed = false        // 참조를 우리가 들고 있으므로 해제되면 안 된다

        let root = NSView()
        // 배경을 창 색에만 맡기지 않는다 - 투명한 스크롤 위에 글자만 얹히면 테마에 따라
        // 대비가 무너진다. 뷰가 자기 배경을 들고 있으면 어디에 올려도 같게 보인다.
        root.wantsLayer = true
        root.layer?.backgroundColor = Theme.bg.cgColor
        root.translatesAutoresizingMaskIntoConstraints = false

        let title = NSTextField(labelWithString: t("notes.whatsNew"))
        title.font = UIScale.font(UIScale.title + 4, .bold)
        title.textColor = Theme.fg
        title.translatesAutoresizingMaskIntoConstraints = false
        let ver = NSTextField(labelWithString: "v\(currentVersion)")
        ver.font = UIScale.font(UIScale.small)
        ver.textColor = Theme.fgDim
        ver.translatesAutoresizingMaskIntoConstraints = false

        let md = MarkdownView()
        md.setMarkdown(text, force: true)
        md.translatesAutoresizingMaskIntoConstraints = false

        let ok = PadButton(title: t("common.close"), font: UIScale.font(UIScale.body, .medium),
                           textColor: Theme.bg, bg: Theme.accent, border: .clear,
                           radius: 7, hPad: 18, height: 30)
        ok.onClick = { window?.close(); window = nil }

        [title, ver, md, ok].forEach { root.addSubview($0) }
        NSLayoutConstraint.activate([
            // 제목 줄은 신호등 버튼과 겹치지 않게 내려 둔다 (타이틀바를 투명하게 썼다).
            title.leadingAnchor.constraint(equalTo: root.leadingAnchor, constant: 22),
            title.topAnchor.constraint(equalTo: root.topAnchor, constant: 34),
            ver.leadingAnchor.constraint(equalTo: title.trailingAnchor, constant: 8),
            ver.lastBaselineAnchor.constraint(equalTo: title.lastBaselineAnchor),
            md.leadingAnchor.constraint(equalTo: root.leadingAnchor, constant: 10),
            md.trailingAnchor.constraint(equalTo: root.trailingAnchor, constant: -10),
            md.topAnchor.constraint(equalTo: title.bottomAnchor, constant: 10),
            md.bottomAnchor.constraint(equalTo: ok.topAnchor, constant: -12),
            ok.trailingAnchor.constraint(equalTo: root.trailingAnchor, constant: -22),
            ok.bottomAnchor.constraint(equalTo: root.bottomAnchor, constant: -18),
        ])
        w.contentView = root
        window = w
        // 창 안의 시트로 띄우지 않는다 - 시트는 그 창을 막아 버려서, 읽는 동안 아무것도
        // 못 하게 된다. 따로 뜨는 창이면 옆에 두고 계속 일할 수 있다.
        if let parent { w.center(); w.setFrameOrigin(NSPoint(
            x: parent.frame.midX - w.frame.width / 2,
            y: parent.frame.midY - w.frame.height / 2)) }
        else { w.center() }
        w.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: false)
    }
}
