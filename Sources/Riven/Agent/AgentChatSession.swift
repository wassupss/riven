import Foundation

// 네이티브 챗 패널이 에이전트에게 기대하는 것 - CLI 가 무엇이든 이만큼이면 된다.
//
// [[ChatPanel]] 은 오랫동안 [[ClaudeChatSession]] 을 직접 들고 있었다. Codex 를 같은
// 패널로 몰려면 둘 중 하나를 골라야 했다: 패널을 CLI 마다 하나씩 복제하거나, 패널이
// 기대하는 것을 이름 붙여 두 세션이 그 이름을 만족하게 하거나. 후자다 - 승인 카드,
// 스트리밍, 변경사항 연동, 턴 배지는 전부 CLI 와 무관한 riven 의 것이다.
//
// Claude 에만 있는 것(서브에이전트, riven MCP 도구 호출, 권한 모드 전환)은 여기서
// 선택 사항이다. Codex 는 기본 구현으로 조용히 넘긴다 - "지원하지 않음" 을 표현하려고
// 패널 쪽에 if 를 심으면, CLI 가 하나 더 늘 때마다 그 if 가 자란다.
protocol AgentChatSession: AnyObject {
    var isAlive: Bool { get }
    /// 이 대화의 id (Claude: session id, Codex: thread id). 재시작 후 이어 붙일 때 쓴다.
    var sessionId: String? { get }
    /// 이 프로세스를 스폰할 때의 CLI 버전. 실행 중 CLI 가 자동 업데이트되면 현재 버전과
    /// 달라지고, 그때 "현재 버전으로 재시작(대화 이어받기)" 을 제안한다. 못 알면 nil.
    var spawnVersion: String? { get }
    /// init 이벤트가 알려 준 도구 목록 / MCP 서버 (상태 줄에 그대로 나온다).
    var toolList: [String] { get }
    var mcpServers: [(name: String, status: String)] { get }

    func send(_ text: String)
    func interrupt()
    func stop()
    func setModel(_ model: String)
    func setPermissionMode(_ mode: String)
    /// 승인 카드의 답.
    func respond(_ id: String, allow: Bool)
    /// riven 도구 호출의 결과를 에이전트에게 돌려준다. 지원하지 않으면 false.
    @discardableResult func respondTool(_ id: String, _ result: String) -> Bool

    // 콜백은 전부 메인 스레드로 온다.
    var onInit: ((_ sessionId: String, _ model: String?) -> Void)? { get set }
    var onTextDelta: ((String) -> Void)? { get set }
    var onLiveUsage: ((Int, Int, Bool) -> Void)? { get set }   // 실시간 토큰 (input, output, isMessageStart)
    var onMainTool: ((_ name: String, _ detail: String, _ code: String?, _ path: String?) -> Void)? { get set }
    var onFileEdited: ((_ path: String) -> Void)? { get set }
    var onTurnDone: ((_ costUSD: Double?, _ sessionId: String?, _ usage: ChatUsage?, _ error: String?) -> Void)? { get set }
    var onExit: ((_ code: Int32) -> Void)? { get set }
    var onPermissionRequest: ((_ id: String, _ name: String, _ detail: String, _ code: String?, _ path: String?) -> Void)? { get set }

    // ---- Claude 에만 있는 것 (기본 구현으로 넘어간다) ----
    var onSubagentStart: ((_ id: String, _ type: String, _ desc: String) -> Void)? { get set }
    var onSubagentText: ((_ parentId: String, _ text: String) -> Void)? { get set }
    var onSubagentTool: ((_ parentId: String, _ name: String, _ detail: String, _ code: String?, _ path: String?) -> Void)? { get set }
    var onSubagentToolResult: ((_ parentId: String, _ text: String, _ isError: Bool) -> Void)? { get set }
    var onSubagentDone: ((_ id: String, _ result: String) -> Void)? { get set }
    var onToolRequest: ((_ id: String, _ tool: String, _ args: [String: Any]) -> Void)? { get set }
    var onAskExpired: ((_ id: String, _ reason: String) -> Void)? { get set }
}

/// 어떤 CLI 가 이 챗을 굴리는가. 세션 스냅샷에도 적히므로 문자열 값은 바꾸지 않는다.
enum ChatAgentKind: String {
    case claude
    case codex

    var displayName: String { self == .claude ? "Claude Code" : "Codex" }
    /// 브랜드가 읽히는 글리프. Claude 의 asterisk 가 Anthropic 마크로 읽히는 것과 같은
    /// 자리다 - camera.aperture 는 6방향 회전 대칭 매듭이라 OpenAI 마크와 인상이 같고,
    /// 11pt(탭·레일 실제 크기)에서도 뭉개지지 않는다. `</>` 는 "코드" 일 뿐 Codex 가 아니었다.
    var symbol: String { self == .claude ? "asterisk" : "camera.aperture" }
}

// Codex 는 버전 추적을 하지 않는다 (이 기능은 Claude CLI 자동업데이트 대응이다). 기본 nil.
extension AgentChatSession { var spawnVersion: String? { nil } }
extension ClaudeChatSession: AgentChatSession {}
