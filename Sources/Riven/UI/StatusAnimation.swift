import AppKit

// 상태 애니메이션의 공용 부품. 워크스페이스 레일과 독 탭이 같은 구현을 쓰게 하려고
// 여기로 올렸다 (예전에는 레일에만 ShimmerLabel 이 있었고 탭은 점 하나 깜빡이는 게
// 전부라, 같은 상태가 자리마다 다른 언어로 보였다).
//
// 이 파일은 일부러 AppKit 만 쓴다 - Theme/UIScale 을 참조하지 않으므로 색·크기는
// 호출부가 넘긴다. 덕분에 bench/shimmer-bench.swift 가 앱 전체를 링크하지 않고도
// 실제 이 구현을 그대로 측정할 수 있다.

// ---------------------------------------------------------------------------
// 애니메이션 게이트
// ---------------------------------------------------------------------------

/// CALayer 애니메이션을 "지금 실제로 보이는 동안"에만 돌린다.
///
/// 켜 두기만 하면 CPU 를 안 먹는 게 아니다 - 창이 다른 창에 완전히 가려져 있어도
/// (occluded) 레이어가 살아 있으면 코어 애니메이션은 계속 프레임을 만든다. 그래서
/// 세 가지 경우에 무조건 멈춘다:
///   • 상태가 끝났을 때 (isOn = false)
///   • 뷰가 창에서 빠졌을 때 (패널 닫힘 / 워크스페이스 전환 / 탭 재생성)
///   • 창이 가려졌거나 최소화됐을 때 (occlusionState 에서 .visible 이 빠짐)
/// 다시 보이면 알아서 복구된다.
final class ViewAnimationGate {
    private weak var view: NSView?
    private let start: () -> Void
    private let stop: () -> Void
    private var token: NSObjectProtocol?
    private var running = false

    /// 이 프로세스에서 지금 실제로 돌고 있는 애니메이션 수 (벤치·디버그용).
    private(set) static var liveCount = 0

    init(view: NSView, start: @escaping () -> Void, stop: @escaping () -> Void) {
        self.view = view; self.start = start; self.stop = stop
    }
    deinit {
        if let token { NotificationCenter.default.removeObserver(token) }
        if running { Self.liveCount -= 1 }
    }

    /// 상태가 원하는 값 (busy 면 true). 실제 구동 여부는 가시성과 AND 로 정해진다.
    var isOn = false {
        didSet { guard isOn != oldValue else { return }; sync() }
    }

    /// 같은 "켜짐" 안에서 애니메이션 내용이 바뀌었을 때 (예: busy → waiting) 새로 건다.
    func restart() {
        guard running else { return }
        stop(); start()
    }

    /// 호스트 뷰의 viewDidMoveToWindow() 에서 부른다.
    func windowChanged() {
        if let token { NotificationCenter.default.removeObserver(token); self.token = nil }
        if let win = view?.window {
            token = NotificationCenter.default.addObserver(
                forName: NSWindow.didChangeOcclusionStateNotification, object: win,
                queue: .main) { [weak self] _ in self?.sync() }
        }
        sync()
    }

    private var visible: Bool {
        guard let view, let win = view.window else { return false }
        guard !view.isHiddenOrHasHiddenAncestor else { return false }
        return win.occlusionState.contains(.visible)
    }

    private func sync() {
        let want = isOn && visible
        guard want != running else { return }
        running = want
        Self.liveCount += want ? 1 : -1
        want ? start() : stop()
    }
}

// ---------------------------------------------------------------------------
// Shimmer
// ---------------------------------------------------------------------------

/// 글자 위를 밝은 띠가 왼쪽→오른쪽으로 훑고 지나가는 라벨. "이 팬이 지금 일하는 중"의
/// 공용 표현이다 (레일의 에이전트 행 + 독 탭 제목이 같은 것을 쓴다).
///
/// 그라디언트는 라벨 레이어의 알파 마스크라서 글자만 훑고 글자색을 그대로 물려받는다.
/// 타이머가 아니라 CAAnimation 이므로 메인 스레드를 깨우지 않는다.
final class ShimmerLabel: NSTextField {
    private let grad = CAGradientLayer()
    private lazy var gate = ViewAnimationGate(view: self,
                                              start: { [weak self] in self?.startShimmer() },
                                              stop: { [weak self] in self?.stopShimmer() })
    var shimmering: Bool {
        get { gate.isOn }
        set { gate.isOn = newValue }
    }

    override func viewDidMoveToWindow() {
        super.viewDidMoveToWindow()
        gate.windowChanged()
    }

    private func startShimmer() {
        wantsLayer = true
        grad.startPoint = CGPoint(x: 0, y: 0.5); grad.endPoint = CGPoint(x: 1, y: 0.5)
        let dim = NSColor.white.withAlphaComponent(0.35).cgColor   // alpha mask: only alpha matters
        grad.colors = [dim, NSColor.white.cgColor, dim]
        grad.locations = [0, 0.5, 1]
        grad.frame = bounds
        layer?.mask = grad
        let sweep = CABasicAnimation(keyPath: "locations")
        sweep.fromValue = [-1.0, -0.5, 0.0]; sweep.toValue = [1.0, 1.5, 2.0]
        sweep.duration = 1.4; sweep.repeatCount = .infinity
        grad.add(sweep, forKey: "shimmer")
    }
    private func stopShimmer() {
        grad.removeAllAnimations()
        layer?.mask = nil
    }
    override func layout() {
        super.layout()
        if shimmering { grad.frame = bounds }   // keep the mask sized to the (post-layout) label
    }
}

// ---------------------------------------------------------------------------
// Pulse dot
// ---------------------------------------------------------------------------

/// 상태 점. 색만 칠하거나(정적), 숨을 쉬듯 밝기를 오르내리게(ember 펌핑) 할 수 있다.
/// 독 탭의 "입력·승인 대기" 표시가 이걸 쓴다. 색은 호출부(AgentStatus)가 정한다.
final class StatusPulseDot: NSView {
    private lazy var gate = ViewAnimationGate(view: self,
                                              start: { [weak self] in self?.startPulse() },
                                              stop: { [weak self] in self?.stopPulse() })

    init(diameter: CGFloat) {
        super.init(frame: NSRect(x: 0, y: 0, width: diameter, height: diameter))
        wantsLayer = true
        translatesAutoresizingMaskIntoConstraints = false
        layer?.cornerRadius = diameter / 2
        widthAnchor.constraint(equalToConstant: diameter).isActive = true
        heightAnchor.constraint(equalToConstant: diameter).isActive = true
        isHidden = true
    }
    required init?(coder: NSCoder) { fatalError() }

    override func viewDidMoveToWindow() {
        super.viewDidMoveToWindow()
        gate.windowChanged()
    }

    /// color 가 nil 이면 점을 숨기고 애니메이션도 확실히 걷어낸다.
    func set(color: NSColor?, pulsing: Bool) {
        guard let color else {
            gate.isOn = false
            isHidden = true
            layer?.opacity = 1
            return
        }
        isHidden = false
        layer?.backgroundColor = color.cgColor
        gate.isOn = pulsing
        if !pulsing { layer?.opacity = 1 }
    }

    private func startPulse() {
        let a = CABasicAnimation(keyPath: "opacity")
        a.fromValue = 1; a.toValue = 0.3; a.duration = 1.1
        a.autoreverses = true; a.repeatCount = .infinity
        layer?.add(a, forKey: "pulse")
    }
    private func stopPulse() {
        layer?.removeAnimation(forKey: "pulse")
        layer?.opacity = 1
    }
}
