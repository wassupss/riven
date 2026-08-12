import Foundation

// Find-in-files over a workspace. Primary backend is `git grep` (respects .gitignore
// and skips untracked-ignored dirs like .build / node_modules, exactly like VSCode's
// ripgrep-based search); falls back to a Swift file walk for non-git folders. Supports
// case-sensitive, whole-word, and regex, off the main thread.
enum Search {
    struct Match {
        let file: String
        let line: Int      // 1-based
        let column: Int    // 1-based
        let text: String
        let matchStart: Int    // char index into `text` of the highlight
        let matchLength: Int
    }
    struct Result { let matches: [Match]; let truncated: Bool }
    struct Options {
        var caseSensitive = false
        var wholeWord = false
        var regex = false
    }

    // Walk fallback ignores (git grep handles this itself via .gitignore). Kept broad so a
    // non-git folder still doesn't drown in build output.
    private static let ignoredDirs: Set<String> = [
        ".git", "node_modules", "out", "dist", ".cache", ".riven", ".build", "build",
        "target", ".next", ".nuxt", ".svelte-kit", "vendor", "Pods", ".venv", "venv",
        "__pycache__", ".gradle", ".idea", "coverage", "DerivedData",
    ]
    private static let maxFileBytes = 1_000_000
    private static let maxResults = 2000
    private static let maxPerFile = 100

    // ---- public entry ----
    static func inFiles(root: URL, query: String, options: Options = .init()) -> Result {
        if query.isEmpty { return Result(matches: [], truncated: false) }
        // A bad regex would make git grep error out (and NSRegularExpression throw); bail cleanly.
        if options.regex, (try? NSRegularExpression(pattern: query)) == nil {
            return Result(matches: [], truncated: false)
        }
        if let r = gitGrep(root: root, query: query, options: options) { return r }
        return walkSearch(root: root, query: query, options: options)
    }

    // ---- git grep backend (respects .gitignore) ----
    private static func gitGrep(root: URL, query: String, options: Options) -> Result? {
        var args = ["-n", "-I", "--untracked", "--no-color", "-m", "\(maxPerFile)"]
        if !options.caseSensitive { args.append("-i") }
        if options.wholeWord { args.append("-w") }
        args.append(options.regex ? "-E" : "-F")
        args += ["-e", query]
        guard let out = Git.grep(cwd: root.path, args: args) else { return nil }

        let matcher = makeMatcher(query, options)
        var matches: [Match] = []
        var truncated = false
        for raw in out.split(separator: "\n", omittingEmptySubsequences: true) {
            if matches.count >= maxResults { truncated = true; break }
            let s = String(raw)
            // <path>:<lineno>:<text>  (paths with ':' are vanishingly rare in code repos)
            guard let c1 = s.firstIndex(of: ":") else { continue }
            let afterPath = s[s.index(after: c1)...]
            guard let c2 = afterPath.firstIndex(of: ":"),
                  let lineNo = Int(afterPath[..<c2]) else { continue }
            let path = String(s[..<c1])
            let text = String(afterPath[afterPath.index(after: c2)...])
            let abs = URL(fileURLWithPath: root.path).appendingPathComponent(path).path
            let (ms, ml) = matcher(text)
            let clipped = text.count > 240 ? String(text.prefix(240)) : text
            matches.append(Match(file: abs, line: lineNo, column: ms + 1,
                                 text: clipped, matchStart: min(ms, clipped.count), matchLength: ml))
        }
        return Result(matches: matches, truncated: truncated)
    }

    // First-match (start, length) in `line`, in char units, for highlighting. (0,0) if none.
    private static func makeMatcher(_ query: String, _ o: Options) -> (String) -> (Int, Int) {
        if o.regex {
            let opts: NSRegularExpression.Options = o.caseSensitive ? [] : [.caseInsensitive]
            let pat = o.wholeWord ? "\\b(?:\(query))\\b" : query
            guard let re = try? NSRegularExpression(pattern: pat, options: opts) else { return { _ in (0, 0) } }
            return { line in
                let ns = line as NSString
                guard let m = re.firstMatch(in: line, range: NSRange(location: 0, length: ns.length)),
                      m.range.location != NSNotFound else { return (0, 0) }
                return (ns.substring(to: m.range.location).count, ns.substring(with: m.range).count)
            }
        }
        let opts: String.CompareOptions = o.caseSensitive ? [] : [.caseInsensitive]
        return { line in
            guard let r = line.range(of: query, options: opts) else { return (0, 0) }
            return (line.distance(from: line.startIndex, to: r.lowerBound), query.count)
        }
    }

    // ---- Swift walk fallback (non-git folders) ----
    private static func walk(_ dir: URL, _ visit: (URL) -> Bool) {
        let fm = FileManager.default
        guard let entries = try? fm.contentsOfDirectory(at: dir,
            includingPropertiesForKeys: [.isDirectoryKey], options: []) else { return }
        for e in entries {
            let name = e.lastPathComponent
            if name == ".DS_Store" || ignoredDirs.contains(name) { continue }
            let isDir = (try? e.resourceValues(forKeys: [.isDirectoryKey]))?.isDirectory ?? false
            if isDir { walk(e, visit) }
            else if !visit(e) { return }
        }
    }

    private static func walkSearch(root: URL, query: String, options: Options) -> Result {
        var matches: [Match] = []
        var truncated = false
        let matcher = makeMatcher(query, options)
        walk(root) { file in
            if matches.count >= maxResults { truncated = true; return false }
            guard let attrs = try? FileManager.default.attributesOfItem(atPath: file.path),
                  let size = attrs[.size] as? Int, size <= maxFileBytes else { return true }
            guard let data = try? Data(contentsOf: file), !data.contains(0),
                  let content = String(data: data, encoding: .utf8) else { return true }
            var perFile = 0
            for (i, raw) in content.split(separator: "\n", omittingEmptySubsequences: false).enumerated() {
                if perFile >= maxPerFile { break }
                let line = String(raw)
                let (ms, ml) = matcher(line)
                guard ml > 0 else { continue }
                matches.append(Match(file: file.path, line: i + 1, column: ms + 1,
                    text: line.count > 240 ? String(line.prefix(240)) : line,
                    matchStart: ms, matchLength: ml))
                perFile += 1
                if matches.count >= maxResults { truncated = true; return false }
            }
            return true
        }
        return Result(matches: matches, truncated: truncated)
    }

    // ---- replace ----
    // Replace across ONLY the given files (the ones the search matched), so it can never touch
    // .build / node_modules etc. Honors the same options (regex via NSRegularExpression).
    static func replaceInFiles(files: [String], query: String, replacement: String,
                               options: Options = .init()) -> (files: Int, replacements: Int) {
        if query.isEmpty { return (0, 0) }
        var changed = 0, total = 0
        let regex: NSRegularExpression? = options.regex
            ? try? NSRegularExpression(pattern: options.wholeWord ? "\\b(?:\(query))\\b" : query,
                                       options: options.caseSensitive ? [] : [.caseInsensitive])
            : nil
        if options.regex && regex == nil { return (0, 0) }
        let strOpts: String.CompareOptions = options.caseSensitive ? [.literal] : [.literal, .caseInsensitive]

        for path in Set(files) {
            guard let content = try? String(contentsOfFile: path, encoding: .utf8) else { continue }
            let next: String
            let count: Int
            if let re = regex {
                let ns = content as NSString
                let range = NSRange(location: 0, length: ns.length)
                count = re.numberOfMatches(in: content, range: range)
                if count == 0 { continue }
                next = re.stringByReplacingMatches(in: content, range: range, withTemplate: replacement)
            } else {
                var c = 0; var start = content.startIndex
                while let r = content.range(of: query, options: strOpts, range: start..<content.endIndex) {
                    c += 1; start = r.upperBound
                }
                if c == 0 { continue }
                count = c
                next = content.replacingOccurrences(of: query, with: replacement, options: strOpts)
            }
            let tmp = path + ".tmp"
            do {
                try next.write(toFile: tmp, atomically: false, encoding: .utf8)
                _ = try FileManager.default.replaceItemAt(URL(fileURLWithPath: path), withItemAt: URL(fileURLWithPath: tmp))
                changed += 1; total += count
            } catch { try? FileManager.default.removeItem(atPath: tmp) }
        }
        return (changed, total)
    }
}
