import Foundation

// Tracks files an agent edited this session (before/after content), backing the
// Changes panel — a port of riven's state/agentEdits.ts. The native AI is inline
// completion today (no file-writing agent), so record() has no caller yet; the
// store + panel are the faithful infrastructure that lights up when an agent
// starts applying edits. Accept drops the entry; revert restores `before`.
final class AgentEdits {
    static let shared = AgentEdits()
    private init() {}

    struct Edit { let before: String; let after: String; let hasBaseline: Bool }
    struct Entry { let path: String; let workspace: String; let isNew: Bool
        var added: Int; var removed: Int; let at: Date }

    private(set) var timeline: [Entry] = []     // newest last, like riven
    private(set) var edits: [String: Edit] = [:]
    func edit(for path: String) -> Edit? { edits[path] }

    // Baseline "last known content" per absolute path (riven's module `cache`). The
    // before of the next diff. Seeded by snapshot(), updated on our own editor saves.
    private var baseline: [String: String] = [:]
    func baselineContent(_ path: String) -> String? { baseline[path] }
    func updateBaseline(_ path: String, _ content: String) { baseline[path] = content }

    // Snapshot a workspace's file contents once (riven's snapshotContents): 2000-file
    // cap, skip hidden / >200KB / binary / ignored dirs. Populates the baseline.
    private var snapshotted: Set<String> = []
    private static let ignoredDirs: Set<String> = [
        ".git", "node_modules", "out", "dist", ".riven", ".cache", ".next", ".turbo",
        ".svelte-kit", ".nuxt", ".output", ".vercel", ".vite", ".parcel-cache", "coverage",
        "__pycache__", ".pytest_cache", ".mypy_cache", ".venv", "venv", "target", ".build",
        "DerivedData", "Library", ".Trash"]
    static func isIgnored(_ path: String) -> Bool {
        path.split(separator: "/").contains { ignoredDirs.contains(String($0)) }
    }
    func snapshot(workspace: URL) {
        guard !snapshotted.contains(workspace.path) else { return }
        snapshotted.insert(workspace.path)
        DispatchQueue.global(qos: .utility).async {
            let fm = FileManager.default
            guard let en = fm.enumerator(at: workspace, includingPropertiesForKeys: [.isRegularFileKey, .fileSizeKey],
                                         options: [.skipsHiddenFiles]) else { return }
            var count = 0
            var snap: [String: String] = [:]
            for case let url as URL in en {
                if AgentEdits.ignoredDirs.contains(url.lastPathComponent) { en.skipDescendants(); continue }
                guard (try? url.resourceValues(forKeys: [.isRegularFileKey]))?.isRegularFile == true else { continue }
                if let size = (try? url.resourceValues(forKeys: [.fileSizeKey]))?.fileSize, size > 200_000 { continue }
                guard let data = try? Data(contentsOf: url), !data.contains(0),
                      let s = String(data: data, encoding: .utf8) else { continue }
                snap[url.path] = s
                count += 1; if count >= 2000 { break }
            }
            DispatchQueue.main.async { for (k, v) in snap where self.baseline[k] == nil { self.baseline[k] = v } }
        }
    }

    // Observers (the Changes panel) refresh when the timeline changes.
    private var observers: [() -> Void] = []
    func observe(_ fn: @escaping () -> Void) { observers.append(fn) }
    private func notify() { observers.forEach { $0() } }

    // Record (or update) an agent edit. `added`/`removed` are line counts computed
    // from a simple longest-common-prefix/suffix line diff.
    func record(path: String, workspace: String, before: String, after: String, isNew: Bool) {
        let (added, removed) = lineDelta(before: before, after: after)
        edits[path] = Edit(before: before, after: after, hasBaseline: !isNew)
        if let i = timeline.firstIndex(where: { $0.path == path }) {
            timeline[i].added = added; timeline[i].removed = removed
        } else {
            timeline.append(Entry(path: path, workspace: workspace, isNew: isNew,
                                  added: added, removed: removed, at: Date()))
        }
        notify()
    }

    func resolve(path: String) {   // accept: keep the file, drop the entry
        timeline.removeAll { $0.path == path }
        edits[path] = nil
        notify()
    }
    func acceptAll() { timeline.removeAll(); edits.removeAll(); notify() }

    // Revert: restore the pre-edit content to disk, then drop the entry. Returns
    // the reverted path so the caller can reload it if open in the editor.
    @discardableResult
    func revert(path: String) -> Bool {
        guard let e = edits[path] else { resolve(path: path); return false }
        do { try e.before.write(toFile: path, atomically: true, encoding: .utf8) }
        catch { return false }
        resolve(path: path)
        return true
    }
    func revertAll() -> [String] {
        let paths = timeline.map { $0.path }
        for p in paths { if let e = edits[p] { try? e.before.write(toFile: p, atomically: true, encoding: .utf8) } }
        acceptAll()
        return paths
    }

    private func lineDelta(before: String, after: String) -> (added: Int, removed: Int) {
        let a = before.split(separator: "\n", omittingEmptySubsequences: false)
        let b = after.split(separator: "\n", omittingEmptySubsequences: false)
        var lo = 0
        while lo < a.count && lo < b.count && a[lo] == b[lo] { lo += 1 }
        var hiA = a.count - 1, hiB = b.count - 1
        while hiA >= lo && hiB >= lo && a[hiA] == b[hiB] { hiA -= 1; hiB -= 1 }
        return (max(0, hiB - lo + 1), max(0, hiA - lo + 1))
    }
}
