import Foundation

// Codex 페인이 재시작 후에도 같은 대화로 돌아오게 하는 최소한의 장부.
//
// Claude 는 riven 이 세션 id 를 골라 줄 수 있다 (`--session-id <uuid>`). Codex 에는
// 그런 플래그가 없다 — id 는 Codex 가 정하고, `codex resume <id>` 로만 되돌아간다.
// 그래서 방향이 반대다: riven 이 id 를 주는 게 아니라 받아 적는다.
//
// 받아 적을 자리는 이미 있었다. SessionStart 훅 payload 에 `session_id` 가 실려 오고,
// 그 훅은 페인의 환경(RIVEN_PANE_SESSION)을 물려받으므로 어느 페인의 것인지도 안다.
// 여기서는 그 둘을 짝지어 디스크에 남길 뿐이다.
enum CodexSessions {

    /// 페인 UUID → Codex 세션 id. 셸 심(shim)도 읽어야 해서 파일 하나에 페인 하나씩 둔다
    /// (JSON 한 덩어리로 두면 셸에서 읽기 위해 파서가 필요하다).
    private static var dir: URL {
        let d = AppPaths.support("codex-sessions")
        try? FileManager.default.createDirectory(at: d, withIntermediateDirectories: true)
        return d
    }

    /// 이 페인이 쓰는 파일 경로. 셸 심에 환경변수로 그대로 넘긴다.
    static func path(forPane pane: String) -> String? {
        guard UUID(uuidString: pane) != nil else { return nil }   // 파일 이름이 되므로 검증
        return dir.appendingPathComponent(pane).path
    }

    /// SessionStart 에서 알게 된 Codex 세션 id 를 적어 둔다.
    static func record(pane: String, sessionId: String) {
        guard let p = path(forPane: pane), UUID(uuidString: sessionId) != nil else { return }
        let existing = try? String(contentsOfFile: p, encoding: .utf8)
        guard existing?.trimmingCharacters(in: .whitespacesAndNewlines) != sessionId else { return }
        try? sessionId.write(toFile: p, atomically: true, encoding: .utf8)
        RLog.log("codex session: pane \(pane.prefix(8)) → \(sessionId.prefix(8))")
    }

    /// 이 페인이 이어 갈 Codex 세션 id (없으면 nil → 새 대화).
    static func sessionId(forPane pane: String) -> String? {
        guard let p = path(forPane: pane),
              let s = try? String(contentsOfFile: p, encoding: .utf8) else { return nil }
        let id = s.trimmingCharacters(in: .whitespacesAndNewlines)
        return UUID(uuidString: id) != nil ? id : nil
    }

    /// 페인이 닫히면 장부에서도 지운다 — 닫은 대화가 새 페인에 되살아나면 안 된다
    /// (Claude 쪽에서 "폴더의 최신 대화" 를 주워 오다 겪은 것과 같은 실수).
    static func forget(pane: String) {
        guard let p = path(forPane: pane) else { return }
        try? FileManager.default.removeItem(atPath: p)
    }
}
