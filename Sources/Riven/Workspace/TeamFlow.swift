import Foundation

// 그룹이 "지금" 어떻게 돌아가는지를 담는 두 가지 값 - 조직도가 이걸 그린다.
//
// 조직도는 구조(누가 누구에게 보고하는가)만 보여 줬다. 여러 에이전트를 동시에 돌릴 때
// 정작 알고 싶은 건 구조가 아니라 흐름과 상태다: 지금 누가 누구에게 일을 넘겼고, 누가
// 붙잡혀 있는가. 그 둘을 여기서 정의하고, OrgChartView 가 렌더링만 맡는다.

/// 에이전트 한 명이 지금 무엇을 하고 있는가.
///
/// busy 불리언 하나로는 병렬 실행에서 제일 중요한 걸 못 읽는다: 승인을 기다리며 멈춰
/// 있는 에이전트와 도구를 돌리는 에이전트가 똑같은 점 하나로 보였다. 앞의 것은 사람이
/// 병목이고 뒤의 것은 그냥 기다리면 된다 - 조직도만 보고 구분되어야 한다.
enum AgentRunState: Equatable {
    /// 턴이 없다.
    case idle
    /// 턴 진행 중, 모델이 생성하는 중.
    case thinking
    /// 도구 실행 중 (연관값은 도구 이름).
    case tool(String)
    /// 승인 대기 - 에이전트가 아니라 사람이 병목이다.
    case waiting

    var isLive: Bool { self != .idle }
}

/// 위임 한 건. `from` 이 nil 이면 사용자가 팀 입력줄에서 직접 보낸 것이다.
struct TeamFlow {
    let id: Int
    let group: String
    let from: String?
    let to: String
    /// ChatPanel.shortTitle 로 줄인 요청 한 줄.
    let summary: String
    let start: Date
    /// 답이 온 시각. nil 이면 아직 진행 중.
    var end: Date?
    var ok = true

    /// 완료 직후의 역방향 반짝임 길이.
    static let pulse: TimeInterval = 0.45
    /// 완료 연출(반짝임 + 페이드)이 전부 끝나는 데 걸리는 시간.
    static let outro: TimeInterval = 1.1

    /// 이 시각이 지나면 화면에서 지워도 된다.
    func expired(_ now: Date) -> Bool {
        guard let end else { return false }
        return now.timeIntervalSince(end) > Self.outro
    }
    /// 완료 연출의 진행도 (0 = 방금 끝남, 1 = 다 사라짐). 진행 중이면 nil.
    func outroProgress(_ now: Date) -> Double? {
        guard let end else { return nil }
        return min(1, max(0, now.timeIntervalSince(end) / Self.outro))
    }
}

/// 경과 시간을 상태 칩에 넣을 짧은 문자열로 ("8s", "1m 20s").
func teamElapsed(_ since: Date, _ now: Date) -> String {
    let s = max(0, Int(now.timeIntervalSince(since)))
    return s < 60 ? "\(s)s" : "\(s / 60)m \(s % 60)s"
}
