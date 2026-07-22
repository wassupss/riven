import Foundation

// Find-in-files over a workspace — a direct port of riven's main/search.ts.
// Node-based file walk (no ripgrep dep): skips ignored dirs, binary and large
// files, and caps results. Runs off the main thread.
enum Search {
    struct Match {
        let file: String
        let line: Int      // 1-based
        let column: Int    // 1-based
        let text: String
        let matchStart: Int
        let matchLength: Int
    }
    struct Result { let matches: [Match]; let truncated: Bool }

    private static let ignoredDirs: Set<String> = [".git", "node_modules", "out", "dist", ".cache", ".riven"]
    private static let maxFileBytes = 1_000_000
    private static let maxResults = 600
    private static let maxPerFile = 50

    private static func walk(_ dir: URL, _ visit: (URL) -> Bool) {
        let fm = FileManager.default
        guard let entries = try? fm.contentsOfDirectory(at: dir,
            includingPropertiesForKeys: [.isDirectoryKey], options: []) else { return }
        for e in entries {
            let name = e.lastPathComponent
            if name == ".DS_Store" || ignoredDirs.contains(name) { continue }
            let isDir = (try? e.resourceValues(forKeys: [.isDirectoryKey]))?.isDirectory ?? false
            if isDir { walk(e, visit) }
            else if !visit(e) { return }   // visit returns false to stop early
        }
    }

    // Find literal `query` in every text file under `root`.
    static func inFiles(root: URL, query: String, caseSensitive: Bool = false) -> Result {
        var matches: [Match] = []
        if query.isEmpty { return Result(matches: [], truncated: false) }
        let needle = caseSensitive ? query : query.lowercased()
        var truncated = false

        walk(root) { file in
            if matches.count >= maxResults { truncated = true; return false }
            guard let attrs = try? FileManager.default.attributesOfItem(atPath: file.path),
                  let size = attrs[.size] as? Int, size <= maxFileBytes else { return true }
            guard let data = try? Data(contentsOf: file), !data.contains(0),
                  let content = String(data: data, encoding: .utf8) else { return true }

            var perFile = 0
            let lines = content.split(separator: "\n", omittingEmptySubsequences: false)
            for (i, raw) in lines.enumerated() {
                if perFile >= maxPerFile { break }
                let line = String(raw)
                let hay = caseSensitive ? line : line.lowercased()
                guard let r = hay.range(of: needle) else { continue }
                let idx = hay.distance(from: hay.startIndex, to: r.lowerBound)
                matches.append(Match(
                    file: file.path, line: i + 1, column: idx + 1,
                    text: line.count > 240 ? String(line.prefix(240)) : line,
                    matchStart: idx, matchLength: query.count))
                perFile += 1
                if matches.count >= maxResults { truncated = true; return false }
            }
            return true
        }
        return Result(matches: matches, truncated: truncated)
    }

    // Literal find-and-replace across the workspace (writes atomically). Returns
    // (files changed, total replacements). Mirrors riven's search:replaceInFiles.
    static func replaceInFiles(root: URL, query: String, replacement: String, caseSensitive: Bool = false) -> (files: Int, replacements: Int) {
        if query.isEmpty { return (0, 0) }
        var files = 0, replacements = 0
        let opts: String.CompareOptions = caseSensitive ? [.literal] : [.literal, .caseInsensitive]

        walk(root) { file in
            guard let attrs = try? FileManager.default.attributesOfItem(atPath: file.path),
                  let size = attrs[.size] as? Int, size <= maxFileBytes else { return true }
            guard let data = try? Data(contentsOf: file), !data.contains(0),
                  let content = String(data: data, encoding: .utf8) else { return true }

            // Count occurrences first (literal, honoring case option).
            var count = 0
            var searchStart = content.startIndex
            while let r = content.range(of: query, options: opts, range: searchStart..<content.endIndex) {
                count += 1; searchStart = r.upperBound
            }
            if count == 0 { return true }

            let next = content.replacingOccurrences(of: query, with: replacement, options: opts)
            let tmp = file.path + ".tmp"
            do {
                try next.write(toFile: tmp, atomically: false, encoding: .utf8)
                _ = try FileManager.default.replaceItemAt(file, withItemAt: URL(fileURLWithPath: tmp))
                files += 1; replacements += count
            } catch { try? FileManager.default.removeItem(atPath: tmp) }
            return true
        }
        return (files, replacements)
    }
}
