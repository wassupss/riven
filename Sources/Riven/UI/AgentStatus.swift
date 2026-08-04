import AppKit

/// 에이전트 팬 하나의 상태 — 레일 / 독 탭 / 조직도가 공유하는 단 하나의 어휘.
///
/// 예전에는 자리마다 어휘가 달랐다. 팬은 badge("busy"/"attn") 문자열, 레일은 PaneActivity,
/// 조직도는 AgentRunState. 그래서 같은 순간이 레일에서는 초록 체크, 탭에서는 액센트 점,
/// 조직도에서는 경고색 칩으로 보였다. 저장은 [[DockPanel.status]] 한 곳에서 하고, 세 군데는
/// 모두 여기 정의된 색·동작만 쓴다.
///
/// 조직도 칩(AgentGroupPanel.chipStyle)의 색과 일부러 같은 값을 쓴다:
///   idle → Theme.fgDim / thinking → Theme.accent / waiting → Theme.warning.
/// 칩의 `tool` 만 Theme.info 로 갈라지는데, 그건 busy 의 하위 상태를 더 자세히 보여 주는
/// 것이라 어긋남이 아니다 (조직도는 카드가 커서 그만큼 더 말할 수 있다).
enum AgentStatus: Equatable {
    /// 턴이 없다.
    case idle
    /// 일하는 중 — 제목이 shimmer 한다.
    case busy
    /// 승인·입력 대기. 사람이 병목이다 — 어디서 보든 Theme.warning 한 가지 색.
    case waiting
    /// 끝났는데 아직 안 본 상태 (완료 알림).
    case done

    /// 이 상태를 나타내는 색. 색의 의미는 자리와 무관하게 하나다.
    var color: NSColor {
        switch self {
        case .idle:    return Theme.fgDim
        case .busy:    return Theme.accent
        case .waiting: return Theme.warning
        case .done:    return Theme.success
        }
    }
    /// 제목이 훑리는가 (작업 중 표현).
    var shimmers: Bool { self == .busy }
    /// 점이 숨을 쉬는가 (사람을 부르는 표현).
    var pulses: Bool { self == .waiting || self == .done }
    /// 탭에 점을 띄우는가. busy 는 제목 shimmer 로 이미 말하고 있으므로 점을 겹치지 않는다.
    var showsTabDot: Bool { pulses }

    // ---- 예전 badge 문자열과의 호환 --------------------------------------------
    // 터미널 팬(AttnRing/TerminalView.setRingState)과 레이아웃 스냅샷이 아직 문자열을
    // 쓴다. 저장은 status 로 하고 badge 는 그 위의 얇은 표시로 남긴다.
    init(badge: String?) {
        switch badge {
        case "busy": self = .busy
        case "attn": self = .done      // 문자열만으로는 승인 대기와 완료가 구분되지 않는다
        default:     self = .idle
        }
    }
    var badgeValue: String? {
        switch self {
        case .idle:              return nil
        case .busy:              return "busy"
        case .waiting, .done:    return "attn"
        }
    }

    /// 조직도가 쓰는 세부 상태 → 공용 상태. tool/thinking 은 둘 다 "일하는 중"이다.
    init(run: AgentRunState) {
        switch run {
        case .idle:            self = .idle
        case .thinking, .tool: self = .busy
        case .waiting:         self = .waiting
        }
    }
}
