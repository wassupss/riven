import Foundation

// Debug logger. Appends to a per-user, owner-only file under Application Support
// (NOT world-readable /tmp — a shared temp dir would leak workspace paths / trace
// data to any local user). Raw binary stdout is buffered and lost, so file logging
// is how we trace real-run behavior.
enum RLog {
    private static let path: String = {
        let dir = FileManager.default.homeDirectoryForCurrentUser
            .appendingPathComponent("Library/Application Support/riven-native")
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        let p = dir.appendingPathComponent("debug.log").path
        if !FileManager.default.fileExists(atPath: p) {
            FileManager.default.createFile(atPath: p, contents: nil,
                                           attributes: [.posixPermissions: 0o600])
        }
        return p
    }()
    static func log(_ msg: String) {
        let line = "\(Date().timeIntervalSince1970): \(msg)\n"
        if let h = FileHandle(forWritingAtPath: path) {
            h.seekToEndOfFile(); h.write(Data(line.utf8)); h.closeFile()
        } else {
            try? line.write(toFile: path, atomically: true, encoding: .utf8)
        }
    }
}
