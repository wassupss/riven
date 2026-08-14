import Foundation

// "다음 작업 제안"(ghost text) 전용 초경량 생성기.
//
// 일회성 `claude -p` 는 매번 Node 콜드 스타트라 ~7초가 걸렸다. 대신 claude haiku stream-json
// 세션을 하나 살려 두고 재사용한다(웜) → 첫 호출만 느리고 이후는 추론만(~1-2초).
//
// 성능 안전장치:
//   - 앱 전체에서 프로세스 하나만 (패널마다 X).
//   - 90초 유휴 시 자동 종료 → 유휴 프로세스가 남지 않는다.
//   - 요청 N회마다 재시작 → 세션 맥락이 무한정 쌓이지 않게.
//   - 전역 MCP·훅 없음(빈 MCP + strict) → Bun 워커 스핀 없음.
//
// codex 지원: 이 생성기는 메인 에이전트와 독립이라, codex 대화에서도 동일하게 haiku 로 한 줄을
// 뽑는다(claude CLI 가 설치돼 있으면). 없으면 조용히 아무 것도 안 한다.
final class SuggestionService {
    static let shared = SuggestionService()
    private init() {}

    private var proc: Process?
    private var inPipe: Pipe?
    private var outBuf = Data()
    private var acc = ""                       // 현재 요청의 assistant 텍스트 누적
    private var pending: ((String) -> Void)?
    private var busy = false
    private var reqCount = 0
    private var idleTimer: Timer?
    private static let idleSeconds: TimeInterval = 120   // 유휴 2분 뒤 종료 (작업 리듬 동안 웜 유지)
    private static let restartEvery = 12       // 이 횟수마다 세션 재시작(맥락 정리)

    /// 제안 요청. 켜져 있고 claude 가 있을 때만. 겹친 요청은 무시(한 번에 하나).
    func suggest(user: String, answer: String, done: @escaping (String) -> Void) {
        guard Settings.shared.bool("chatSuggest", false),
              let cmd = AgentDiscovery.claudeCmd() else { return }
        let ans = answer.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !ans.isEmpty, !busy else { return }
        ensureWarm(cmd)
        guard let inPipe else { return }
        busy = true; acc = ""; pending = done; reqCount += 1
        // 형식 규칙은 시스템 프롬프트(spawn 시)에 두고, 여기선 마지막 대화만 준다. 대화형 세션은
        // -p 와 달리 규칙을 안 주면 장황하게 답해서(테스트로 확인) 시스템 프롬프트가 필수였다.
        let prompt = "사용자: \(user.prefix(400))\n에이전트: \(ans.prefix(1200))\n사용자가 다음에 칠 메시지:"
        let msg: [String: Any] = ["type": "user",
                                  "message": ["role": "user", "content": prompt],
                                  "parent_tool_use_id": NSNull()]
        if let d = try? JSONSerialization.data(withJSONObject: msg) {
            var line = d; line.append(0x0a)
            // 세션이 죽어 있으면 broken pipe - 던지는 API 로 받아 조용히 재시도 대상만 정리.
            do { try inPipe.fileHandleForWriting.write(contentsOf: line) }
            catch { teardown(); busy = false; pending = nil }
        }
        scheduleIdle()
    }

    /// 사용자가 타이핑을 시작했거나 새 턴이 시작됨 - 지금 요청 결과는 버린다(세션은 유지).
    func cancel() { pending = nil; busy = false }

    private func ensureWarm(_ cmd: String) {
        if let p = proc, p.isRunning { return }
        teardown()
        let p = Process()
        p.executableURL = URL(fileURLWithPath: cmd)
        let sysp = "너는 자동완성이다. 사용자가 다음에 칠 지시를 예측해 무조건 한 줄, 40자 이내, "
                 + "그 문장만 출력한다. 사용자의 언어로, 명령형. 설명·인사·따옴표 금지. 없으면 빈 줄."
        p.arguments = ["--input-format", "stream-json", "--output-format", "stream-json", "--verbose",
                       "--model", "haiku", "--strict-mcp-config", "--mcp-config", "{\"mcpServers\":{}}",
                       "--append-system-prompt", sysp]
        let inP = Pipe(), outP = Pipe()
        p.standardInput = inP; p.standardOutput = outP; p.standardError = FileHandle.nullDevice
        outP.fileHandleForReading.readabilityHandler = { [weak self] h in
            let d = h.availableData
            if d.isEmpty { return }
            DispatchQueue.main.async { self?.feed(d) }
        }
        p.terminationHandler = { [weak self] _ in
            DispatchQueue.main.async { self?.proc = nil; self?.inPipe = nil; self?.busy = false }
        }
        do { try p.run() } catch { return }
        proc = p; inPipe = inP; reqCount = 0; outBuf = Data()
    }

    private func feed(_ d: Data) {
        outBuf.append(d)
        while let nl = outBuf.firstIndex(of: 0x0a) {
            let lineData = outBuf.subdata(in: outBuf.startIndex..<nl)
            outBuf.removeSubrange(outBuf.startIndex...nl)
            guard let o = try? JSONSerialization.jsonObject(with: lineData) as? [String: Any],
                  let type = o["type"] as? String else { continue }
            if type == "assistant", let m = o["message"] as? [String: Any] {
                acc += SuggestionService.textOf(m["content"])
            } else if type == "result" {
                finishRequest()
            }
        }
    }

    private func finishRequest() {
        var line = acc.trimmingCharacters(in: .whitespacesAndNewlines)
        line = line.components(separatedBy: "\n").first ?? line
        if line.count > 1, line.hasPrefix("\""), line.hasSuffix("\"") { line = String(line.dropFirst().dropLast()) }
        let cb = pending; pending = nil; busy = false; acc = ""
        if line.count >= 1, line.count <= 80 { cb?(line) }
        if reqCount >= SuggestionService.restartEvery { teardown() }   // 맥락 누적 방지
    }

    private func scheduleIdle() {
        idleTimer?.invalidate()
        idleTimer = Timer.scheduledTimer(withTimeInterval: SuggestionService.idleSeconds, repeats: false) { [weak self] _ in
            self?.teardown()   // 유휴 프로세스를 남기지 않는다
        }
    }

    private func teardown() {
        idleTimer?.invalidate(); idleTimer = nil
        if let p = proc { p.terminationHandler = nil; p.terminate() }
        proc = nil; inPipe = nil; outBuf = Data(); busy = false; reqCount = 0
    }

    private static func textOf(_ content: Any?) -> String {
        if let s = content as? String { return s }
        if let arr = content as? [[String: Any]] {
            return arr.compactMap { ($0["type"] as? String) == "text" ? $0["text"] as? String : nil }.joined()
        }
        return ""
    }
}
