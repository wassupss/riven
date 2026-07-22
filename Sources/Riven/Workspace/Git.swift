import Foundation

// Minimal git helper (shell-out), mirroring riven's git.ts logic: current branch
// + porcelain status parsed with -z (handles non-ASCII / Korean paths).
enum Git {
    @discardableResult
    private static func run(_ args: [String], cwd: String) -> String? {
        let p = Process()
        p.executableURL = URL(fileURLWithPath: "/usr/bin/env")
        p.arguments = ["git"] + args
        p.currentDirectoryURL = URL(fileURLWithPath: cwd)
        let pipe = Pipe(); p.standardOutput = pipe; p.standardError = Pipe()
        do { try p.run() } catch { return nil }
        let data = pipe.fileHandleForReading.readDataToEndOfFile()
        p.waitUntilExit()
        guard p.terminationStatus == 0 else { return nil }
        return String(data: data, encoding: .utf8)
    }

    static func branch(cwd: String) -> String? {
        // symbolic-ref works on an unborn branch (fresh git init); SHA fallback.
        if let b = run(["symbolic-ref", "--short", "HEAD"], cwd: cwd)?
            .trimmingCharacters(in: .whitespacesAndNewlines), !b.isEmpty { return b }
        return run(["rev-parse", "--short", "HEAD"], cwd: cwd)?
            .trimmingCharacters(in: .whitespacesAndNewlines)
    }

    // Inline blame: line number -> (author, relative time, summary). Parsed from
    // `blame --line-porcelain`. Matches riven's GitLens-style inline annotation.
    struct BlameLine { let author: String; let time: Int; let summary: String }
    static func blame(file: String) -> [Int: BlameLine] {
        let dir = (file as NSString).deletingLastPathComponent
        let name = (file as NSString).lastPathComponent
        guard let out = run(["blame", "--line-porcelain", "--", name], cwd: dir) else { return [:] }
        var meta: [String: (author: String, time: Int, summary: String)] = [:]
        var lines: [Int: BlameLine] = [:]
        var hash = "", finalLine = 0
        for raw in out.components(separatedBy: "\n") {
            if let m = raw.range(of: #"^[0-9a-f]{40} \d+ (\d+)"#, options: .regularExpression) {
                let parts = raw[m].components(separatedBy: " ")
                hash = parts[0]; finalLine = Int(parts[2]) ?? 0
                if meta[hash] == nil { meta[hash] = ("", 0, "") }
            } else if raw.hasPrefix("author ") { meta[hash]?.author = String(raw.dropFirst(7)) }
            else if raw.hasPrefix("author-time ") { meta[hash]?.time = Int(raw.dropFirst(12)) ?? 0 }
            else if raw.hasPrefix("summary ") { meta[hash]?.summary = String(raw.dropFirst(8)) }
            else if raw.hasPrefix("\t") {
                if !hash.allSatisfy({ $0 == "0" }), let m = meta[hash] {
                    lines[finalLine] = BlameLine(author: m.author, time: m.time, summary: m.summary)
                }
            }
        }
        return lines
    }

    // Run a git command, returning success + stderr (for stage/commit/etc.).
    @discardableResult
    static func runResult(_ args: [String], cwd: String) -> (ok: Bool, error: String) {
        let p = Process()
        p.executableURL = URL(fileURLWithPath: "/usr/bin/env")
        p.arguments = ["git"] + args
        p.currentDirectoryURL = URL(fileURLWithPath: cwd)
        let err = Pipe(); p.standardOutput = Pipe(); p.standardError = err
        do { try p.run() } catch { return (false, "\(error)") }
        let e = err.fileHandleForReading.readDataToEndOfFile()
        p.waitUntilExit()
        return (p.terminationStatus == 0, String(data: e, encoding: .utf8) ?? "")
    }

    // ---- Git panel model (port of riven's git:status) ----
    struct GitFile { let path: String; let x: Character; let y: Character
        let staged: Bool; let unstaged: Bool; let untracked: Bool }
    struct GitStatus {
        var branch: String?; var isRepo: Bool; var ahead: Int; var behind: Int
        var hasUpstream: Bool; var files: [GitFile]
    }

    static func detailedStatus(cwd: String) -> GitStatus {
        guard run(["rev-parse", "--is-inside-work-tree"], cwd: cwd) != nil else {
            return GitStatus(branch: nil, isRepo: false, ahead: 0, behind: 0, hasUpstream: false, files: [])
        }
        let br = branch(cwd: cwd)
        var files: [GitFile] = []
        if let out = run(["status", "--porcelain=v1", "-z"], cwd: cwd) {
            let records = out.components(separatedBy: "\0")
            var i = 0
            while i < records.count {
                let entry = records[i]
                if entry.count < 4 { i += 1; continue }
                let x = entry[entry.startIndex]
                let y = entry[entry.index(entry.startIndex, offsetBy: 1)]
                let p = String(entry.dropFirst(3))
                if x == "R" || x == "C" || y == "R" || y == "C" { i += 1 } // consume source path
                let untracked = x == "?" && y == "?"
                files.append(GitFile(path: p, x: x, y: y,
                    staged: !untracked && x != " ",
                    unstaged: untracked || y != " ",
                    untracked: untracked))
                i += 1
            }
        }
        var ahead = 0, behind = 0, hasUpstream = false
        if let lr = run(["rev-list", "--left-right", "--count", "@{upstream}...HEAD"], cwd: cwd) {
            let nums = lr.trimmingCharacters(in: .whitespacesAndNewlines)
                .split(whereSeparator: { $0 == " " || $0 == "\t" }).compactMap { Int($0) }
            if nums.count == 2 { behind = nums[0]; ahead = nums[1]; hasUpstream = true }
        }
        return GitStatus(branch: br, isRepo: true, ahead: ahead, behind: behind, hasUpstream: hasUpstream, files: files)
    }

    static func stage(cwd: String, rel: String) -> (ok: Bool, error: String) { runResult(["add", "--", rel], cwd: cwd) }
    static func unstage(cwd: String, rel: String) -> (ok: Bool, error: String) { runResult(["reset", "-q", "HEAD", "--", rel], cwd: cwd) }
    static func stageAll(cwd: String) -> (ok: Bool, error: String) { runResult(["add", "-A"], cwd: cwd) }
    static func commit(cwd: String, message: String) -> (ok: Bool, error: String) { runResult(["commit", "-m", message], cwd: cwd) }
    static func push(cwd: String) -> (ok: Bool, error: String) { runResult(["push"], cwd: cwd) }
    static func pull(cwd: String) -> (ok: Bool, error: String) { runResult(["pull", "--ff-only"], cwd: cwd) }
    static func discard(cwd: String, rel: String, untracked: Bool) -> (ok: Bool, error: String) {
        if untracked { try? FileManager.default.removeItem(atPath: URL(fileURLWithPath: cwd).appendingPathComponent(rel).path); return (true, "") }
        _ = runResult(["reset", "-q", "HEAD", "--", rel], cwd: cwd)   // unstage if staged
        return runResult(["checkout", "--", rel], cwd: cwd)
    }

    // The file's HEAD contents (baseline for the diff view). nil if not tracked.
    static func showFile(cwd: String, rel: String) -> String? {
        run(["show", "HEAD:./\(rel)"], cwd: cwd)
    }

    // Changed line ranges vs HEAD (for highlighting on open): [[startLine, endLine], …]
    // Parsed from `diff -U0` @@ hunk headers (new-file line spans).
    // Added / removed line counts vs HEAD (for the Changes panel stats).
    static func numstat(cwd: String, rel: String) -> (added: Int, removed: Int) {
        guard let out = run(["diff", "HEAD", "--numstat", "--", rel], cwd: cwd),
              let line = out.split(separator: "\n").first else { return (0, 0) }
        let cols = line.split(whereSeparator: { $0 == "\t" })
        guard cols.count >= 2 else { return (0, 0) }
        return (Int(cols[0]) ?? 0, Int(cols[1]) ?? 0)
    }
    static func changedLineRanges(cwd: String, rel: String) -> [[Int]] {
        guard let out = run(["diff", "-U0", "--", rel], cwd: cwd) else { return [] }
        var ranges: [[Int]] = []
        for line in out.components(separatedBy: "\n") where line.hasPrefix("@@") {
            // @@ -a,b +c,d @@  → new side is +c,d
            if let plus = line.range(of: #"\+(\d+)(,(\d+))?"#, options: .regularExpression) {
                let seg = String(line[plus]).dropFirst()  // drop '+'
                let parts = seg.split(separator: ",")
                let start = Int(parts[0]) ?? 0
                let count = parts.count > 1 ? (Int(parts[1]) ?? 1) : 1
                if start > 0 && count > 0 { ranges.append([start, start + count - 1]) }
            }
        }
        return ranges
    }

    enum Status: String { case modified, added, untracked, deleted, renamed }

    // Returns absolute path -> status. Parsed from `status --porcelain=v1 -z`.
    static func status(cwd: String) -> [String: Status] {
        guard run(["rev-parse", "--is-inside-work-tree"], cwd: cwd) != nil,
              let out = run(["status", "--porcelain=v1", "-z"], cwd: cwd) else { return [:] }
        var result: [String: Status] = [:]
        let records = out.components(separatedBy: "\0")
        var i = 0
        while i < records.count {
            let entry = records[i]
            if entry.count < 4 { i += 1; continue }
            let x = entry[entry.startIndex]
            let y = entry[entry.index(entry.startIndex, offsetBy: 1)]
            let rel = String(entry.dropFirst(3))
            if x == "R" || x == "C" || y == "R" || y == "C" { i += 1 } // consume source path
            let abs = URL(fileURLWithPath: cwd).appendingPathComponent(rel).path
            let st: Status
            if x == "?" && y == "?" { st = .untracked }
            else if x == "D" || y == "D" { st = .deleted }
            else if x == "R" { st = .renamed }
            else if x == "A" { st = .added }
            else { st = .modified }
            result[abs] = st
            i += 1
        }
        return result
    }
}
