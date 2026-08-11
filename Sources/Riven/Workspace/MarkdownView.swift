import AppKit

/// 마크다운 미리보기 - 채팅 대화가 쓰는 블록 렌더러([[ChatText]])를 그대로 재사용한다.
///
/// WKWebView 를 하나 더 띄우지 않은 이유:
///   • 메모리. 이 앱에는 이미 에디터(Monaco)가 웹뷰를 하나 물고 있고, 패널마다 웹뷰를 더
///     붙이면 패널을 열어 둘수록 비용이 는다. 미리보기 하나 보자고 웹 렌더러를 통째로
///     띄우는 건 과하다.
///   • 일관성. 채팅에 보이는 표·코드블록·제목이 메모에서도 똑같이 보인다. 테마·UI 배율도
///     이미 그쪽에 맞춰져 있어서 따로 CSS 를 관리할 필요가 없다.
///   • 즉시성. 웹뷰는 로드 왕복이 있어서 편집 ↔ 미리보기를 오갈 때 한 박자 늦다.
///
/// 대신 포기한 것: 이미지, 인용문, 수평선, 중첩 목록, 체크박스는 그리지 못한다 (문단으로
/// 떨어진다). 메모 미리보기에는 충분하고, 더 필요해지면 그때 웹뷰를 검토하는 게 맞다.
final class MarkdownView: NSView, Themable, Scalable {
    private let scroll = NSScrollView()
    private let stack = FlippedStack()
    private var text = ""

    override init(frame: NSRect) {
        super.init(frame: frame)
        stack.orientation = .vertical
        stack.alignment = .leading
        stack.spacing = UIScale.pt(6)
        stack.edgeInsets = NSEdgeInsets(top: 10, left: 12, bottom: 14, right: 12)
        stack.translatesAutoresizingMaskIntoConstraints = false
        scroll.documentView = stack
        scroll.drawsBackground = false
        scroll.hasVerticalScroller = true
        scroll.translatesAutoresizingMaskIntoConstraints = false
        addSubview(scroll)
        NSLayoutConstraint.activate([
            scroll.leadingAnchor.constraint(equalTo: leadingAnchor),
            scroll.trailingAnchor.constraint(equalTo: trailingAnchor),
            scroll.topAnchor.constraint(equalTo: topAnchor),
            scroll.bottomAnchor.constraint(equalTo: bottomAnchor),
            stack.topAnchor.constraint(equalTo: scroll.contentView.topAnchor),
            stack.leadingAnchor.constraint(equalTo: scroll.contentView.leadingAnchor),
            stack.widthAnchor.constraint(equalTo: scroll.contentView.widthAnchor),
        ])
        Theme.register(self); UIScale.register(self)
    }
    required init?(coder: NSCoder) { fatalError() }

    /// 같은 내용이면 다시 그리지 않는다 - 편집 ↔ 미리보기를 오갈 때마다 뷰 수십 개를
    /// 새로 만들 이유가 없다.
    /// 벤치용: 지금 렌더링에 들어간 원문.
    func debugText() -> String { text }

    func setMarkdown(_ s: String, force: Bool = false) {
        guard force || s != text else { return }
        text = s
        rebuild()
    }

    private func rebuild() {
        stack.arrangedSubviews.forEach { $0.removeFromSuperview() }
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else {
            let empty = NSTextField(labelWithString: t("notes.previewEmpty"))
            empty.font = UIScale.font(UIScale.small); empty.textColor = Theme.fgDim
            stack.addArrangedSubview(empty)
            return
        }
        // bullet: false - 대화의 ⏺ 표식은 메모에는 필요 없다.
        for v in ChatText.render(trimmed, bullet: false) {
            stripChatActions(v)
            stack.addArrangedSubview(v)
        }
    }

    /// 코드블록에 붙는 "에디터에서 보기" 버튼을 떼어낸다.
    ///
    /// 그 버튼은 자기 위의 ChatPanel 을 찾아 동작하는데 메모 패널에는 ChatPanel 이 없어서
    /// 눌러도 아무 일이 없고(죽은 버튼), 좁은 패널에서는 언어 라벨 위에 겹쳐 그려진다.
    /// ChatViews 를 고치는 대신 여기서 걷어낸다 - 대화 쪽 동작은 그대로 두고 메모에서만
    /// 빼는 게 맞고, 만에 하나 저쪽 구조가 바뀌어도 버튼이 다시 보일 뿐 깨지지는 않는다.
    private func stripChatActions(_ v: NSView) {
        for sub in v.subviews {
            if sub is ClosureButton { sub.removeFromSuperview(); continue }
            stripChatActions(sub)
        }
    }

    func applyTheme() { rebuild() }
    func applyScale() { rebuild() }
}
