import Foundation

/// 메모 저장소 - 메모 하나가 실제 .md 파일 하나다.
///
/// 예전에는 워크스페이스마다 JSON 배열 하나에 제목·본문을 넣어 뒀다. 그래서 메모를 다른
/// 도구로 열거나, 그대로 문서로 넘기거나, 마크다운으로 미리 보는 게 전부 불가능했다.
/// 이제는 개인 메모도 워크스페이스 문서도 똑같이 "파일"이라, 미리보기·편집·에이전트 접근이
/// 한 가지 경로로 처리된다.
///
/// 두 갈래를 다룬다:
///   • 개인 메모 (`~/Library/Application Support/riven-native/notes/<enc-ws>/*.md`)
///     레포 밖이라 git status 에 뜨지 않고 에이전트의 `git add -A` 에도 안 걸린다.
///     저장 위치를 옮기지 않은 이유다 - 예전 주석의 판단을 그대로 지킨다.
///   • 워크스페이스 문서 (프로젝트 안의 .md) - 열어서 그 자리에서 고친다.
enum NoteScope: String, Codable {
    case personal    // riven 지원 폴더의 개인 메모
    case workspace   // 프로젝트 안의 .md 문서
}

struct Note: Equatable {
    var url: URL
    var scope: NoteScope
    /// 목록에 보일 제목. 본문 첫 `# 제목` 을 쓰고, 없으면 파일 이름.
    var title: String
    var updated: Date
    /// 이 메모가 마지막으로 에이전트 손을 탔는지 (패널에서 표시하고, 사용자가 보면 지운다).
    var agentTouched: Bool = false

    var id: String { url.path }
    /// 본문은 목록을 그릴 때 읽지 않는다 - 메모가 수백 개여도 목록은 파일 이름/시각만 본다.
    func read() -> String { (try? String(contentsOf: url, encoding: .utf8)) ?? "" }
}

enum NoteStore {
    // ---- 위치 ------------------------------------------------------------------

    /// 이 워크스페이스의 개인 메모 폴더.
    static func dir(_ ws: URL) -> URL {
        let enc = ws.path.map { $0.isLetter || $0.isNumber ? String($0) : "-" }.joined()
        let d = AgentHookServer.ensureSupportDir()
            .appendingPathComponent("notes", isDirectory: true)
            .appendingPathComponent(enc, isDirectory: true)
        try? FileManager.default.createDirectory(at: d, withIntermediateDirectories: true)
        return d
    }
    /// 예전 형식(JSON 배열) 파일.
    private static func legacyFile(_ ws: URL) -> URL {
        let enc = ws.path.map { $0.isLetter || $0.isNumber ? String($0) : "-" }.joined()
        return AgentHookServer.ensureSupportDir()
            .appendingPathComponent("notes", isDirectory: true)
            .appendingPathComponent("\(enc).json")
    }

    // ---- 읽기 ------------------------------------------------------------------

    /// 개인 메모 목록 (최근 수정 순).
    static func personal(_ ws: URL) -> [Note] {
        migrateIfNeeded(ws)
        let fm = FileManager.default
        let items = (try? fm.contentsOfDirectory(at: dir(ws), includingPropertiesForKeys: [.contentModificationDateKey],
                                                 options: [.skipsHiddenFiles])) ?? []
        return items.filter { $0.pathExtension.lowercased() == "md" }
            .map { note($0, scope: .personal) }
            .sorted { $0.updated > $1.updated }
    }

    /// 워크스페이스 안의 .md 문서. 목록은 얕게 훑는다 - 큰 레포에서 전부 뒤지면 패널을 열
    /// 때마다 디스크를 갈아 마신다. 무시 폴더는 건너뛰고 상한을 둔다.
    static func workspaceDocs(_ ws: URL, limit: Int = 200) -> [Note] {
        let skip: Set<String> = ["node_modules", ".git", ".build", "dist", "build", "vendor",
                                 "Pods", ".next", "target", ".venv", "venv"]
        let fm = FileManager.default
        guard let en = fm.enumerator(at: ws, includingPropertiesForKeys: [.contentModificationDateKey, .isDirectoryKey],
                                     options: [.skipsHiddenFiles]) else { return [] }
        var out: [Note] = []
        for case let u as URL in en {
            if (try? u.resourceValues(forKeys: [.isDirectoryKey]))?.isDirectory == true {
                if skip.contains(u.lastPathComponent) { en.skipDescendants() }
                continue
            }
            guard u.pathExtension.lowercased() == "md" else { continue }
            out.append(note(u, scope: .workspace))
            if out.count >= limit { break }
        }
        // riven_doc_write 는 <ws>/.claude/docs 에 쓴다. 위 열거는 .skipsHiddenFiles 라 점(.)으로
        // 시작하는 .claude 폴더를 못 봐서, 여기서 그 폴더만 따로 얕게 훑어 합친다.
        let docsDir = ws.appendingPathComponent(".claude/docs", isDirectory: true)
        if let extra = try? fm.contentsOfDirectory(at: docsDir, includingPropertiesForKeys: [.contentModificationDateKey],
                                                   options: [.skipsSubdirectoryDescendants]) {
            for u in extra where u.pathExtension.lowercased() == "md" {
                out.append(note(u, scope: .workspace))
            }
        }
        return out.sorted { $0.updated > $1.updated }
    }

    static func note(_ url: URL, scope: NoteScope) -> Note {
        let mtime = (try? url.resourceValues(forKeys: [.contentModificationDateKey]))?
            .contentModificationDate ?? Date.distantPast
        return Note(url: url, scope: scope, title: title(of: url), updated: mtime)
    }

    /// 제목 = 본문 첫 `# 제목`. 없으면 파일 이름. 파일 전체를 읽지 않고 앞부분만 본다.
    static func title(of url: URL) -> String {
        let name = url.deletingPathExtension().lastPathComponent
        guard let h = FileHandle(forReadingAtPath: url.path) else { return name }
        defer { try? h.close() }
        let head = (try? h.read(upToCount: 4096)) ?? Data()
        for line in String(decoding: head, as: UTF8.self).components(separatedBy: "\n").prefix(20) {
            let t0 = line.trimmingCharacters(in: .whitespaces)
            if t0.hasPrefix("# ") {
                let h1 = String(t0.dropFirst(2)).trimmingCharacters(in: .whitespaces)
                if !h1.isEmpty { return h1 }
            }
            if !t0.isEmpty && !t0.hasPrefix("#") { break }   // 첫 내용이 헤딩이 아니면 파일 이름을 쓴다
        }
        return name
    }

    // ---- 쓰기 ------------------------------------------------------------------

    /// 제목 + 본문을 하나의 마크다운 문서로 합친다. 제목은 첫 `# 헤딩` 으로 들어가므로
    /// 다른 도구에서 열어도 제목이 그대로 보인다.
    static func compose(title: String, body: String) -> String {
        let t0 = title.trimmingCharacters(in: .whitespacesAndNewlines)
        let b0 = body.trimmingCharacters(in: .newlines)
        guard !t0.isEmpty else { return b0.isEmpty ? "" : b0 + "\n" }
        return "# \(t0)\n\n" + (b0.isEmpty ? "" : b0 + "\n")
    }
    /// compose 의 반대 - 첫 `# 헤딩` 을 제목으로 떼어낸다.
    static func split(_ text: String) -> (title: String, body: String) {
        var lines = text.components(separatedBy: "\n")
        guard let first = lines.first?.trimmingCharacters(in: .whitespaces), first.hasPrefix("# ") else {
            return ("", text)
        }
        lines.removeFirst()
        while let l = lines.first, l.trimmingCharacters(in: .whitespaces).isEmpty { lines.removeFirst() }
        return (String(first.dropFirst(2)).trimmingCharacters(in: .whitespaces),
                lines.joined(separator: "\n"))
    }

    @discardableResult
    static func write(_ text: String, to url: URL, backup: Bool = true) -> Bool {
        // 덮어쓰기는 되돌릴 수 있어야 한다 - 이전 내용을 .bak 로 한 벌 남긴다.
        if backup, FileManager.default.fileExists(atPath: url.path) {
            let bak = url.appendingPathExtension("bak")
            try? FileManager.default.removeItem(at: bak)
            try? FileManager.default.copyItem(at: url, to: bak)
        }
        do { try text.write(to: url, atomically: true, encoding: .utf8); return true } catch { return false }
    }
    /// 백업본을 되돌린다 (에이전트가 덮어쓴 직후 "되돌리기").
    @discardableResult
    static func restoreBackup(_ url: URL) -> Bool {
        let bak = url.appendingPathExtension("bak")
        guard let text = try? String(contentsOf: bak, encoding: .utf8) else { return false }
        let ok = write(text, to: url, backup: false)
        if ok { try? FileManager.default.removeItem(at: bak) }
        return ok
    }
    static func hasBackup(_ url: URL) -> Bool {
        FileManager.default.fileExists(atPath: url.appendingPathExtension("bak").path)
    }

    /// 새 개인 메모 파일을 만든다. 파일 이름은 만들 때 한 번만 정한다 - 제목을 고칠 때마다
    /// 파일 이름이 따라 바뀌면 다른 도구에서 열어 둔 경로가 계속 깨진다.
    static func create(in ws: URL, title: String, body: String = "") -> Note {
        let base = slug(title).isEmpty ? "note-\(stamp())" : slug(title)
        var url = dir(ws).appendingPathComponent("\(base).md")
        var n = 2
        while FileManager.default.fileExists(atPath: url.path) {
            url = dir(ws).appendingPathComponent("\(base)-\(n).md"); n += 1
        }
        write(compose(title: title, body: body), to: url, backup: false)
        return note(url, scope: .personal)
    }

    static func delete(_ note: Note) {
        try? FileManager.default.removeItem(at: note.url)
        try? FileManager.default.removeItem(at: note.url.appendingPathExtension("bak"))
    }

    /// 이름/경로/제목 중 아무거나로 메모를 찾는다 (에이전트가 부르는 이름은 사람 말이다).
    static func find(_ needle: String, ws: URL) -> Note? {
        let q = needle.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !q.isEmpty else { return nil }
        if q.hasPrefix("/"), FileManager.default.fileExists(atPath: q) {
            let inWs = q.hasPrefix(ws.path)
            return note(URL(fileURLWithPath: q), scope: inWs ? .workspace : .personal)
        }
        let all = personal(ws) + workspaceDocs(ws)
        if let hit = all.first(where: { $0.title.caseInsensitiveCompare(q) == .orderedSame }) { return hit }
        if let hit = all.first(where: { $0.url.lastPathComponent.caseInsensitiveCompare(q) == .orderedSame }) { return hit }
        return all.first { $0.title.localizedCaseInsensitiveContains(q) }
    }

    // ---- 예전 JSON → .md 이사 ----------------------------------------------------

    /// 예전 형식이 남아 있으면 .md 로 옮긴다. 원본 JSON 은 지우지 않고 이름만 바꿔 둔다 -
    /// 옮기다 뭔가 잘못돼도 사용자의 메모가 사라지면 안 된다.
    static func migrateIfNeeded(_ ws: URL) {
        let legacy = legacyFile(ws)
        guard FileManager.default.fileExists(atPath: legacy.path),
              let data = try? Data(contentsOf: legacy) else { return }
        struct Legacy: Codable { var id: String; var title: String; var body: String; var updated: Date }
        let dec = JSONDecoder(); dec.dateDecodingStrategy = .iso8601
        guard let old = try? dec.decode([Legacy].self, from: data) else { return }
        for o in old {
            let base = slug(o.title).isEmpty ? "note-\(stamp(o.updated))" : slug(o.title)
            var url = dir(ws).appendingPathComponent("\(base).md")
            var n = 2
            while FileManager.default.fileExists(atPath: url.path) {
                url = dir(ws).appendingPathComponent("\(base)-\(n).md"); n += 1
            }
            guard write(compose(title: o.title, body: o.body), to: url, backup: false) else { continue }
            // 목록 정렬이 옮기기 전과 같도록 원래 수정 시각을 그대로 씌운다.
            try? FileManager.default.setAttributes([.modificationDate: o.updated], ofItemAtPath: url.path)
        }
        try? FileManager.default.moveItem(at: legacy, to: legacy.appendingPathExtension("migrated"))
    }

    // ---- 잡동사니 ---------------------------------------------------------------

    /// 파일 이름으로 쓸 수 있게 다듬는다. 한글은 그대로 둔다 (파일 이름에 문제없고, 알파벳만
    /// 남기면 한국어 제목이 전부 빈 문자열이 된다).
    static func slug(_ s: String) -> String {
        let bad = CharacterSet(charactersIn: "/\\:*?\"<>|\n\t").union(.controlCharacters)
        let cleaned = s.components(separatedBy: bad).joined(separator: " ")
            .trimmingCharacters(in: .whitespacesAndNewlines)
        return String(cleaned.prefix(60)).replacingOccurrences(of: " ", with: "-")
    }
    private static func stamp(_ d: Date = Date()) -> String {
        let f = DateFormatter(); f.dateFormat = "yyyyMMdd-HHmmss"; return f.string(from: d)
    }
}
