import Foundation

// Debug logger that appends to /tmp/riven-debug.log (raw binary stdout is
// buffered and lost, so file logging is how we trace real-run behavior).
enum RLog {
    private static let path = "/tmp/riven-debug.log"
    static func log(_ msg: String) {
        let line = "\(Date().timeIntervalSince1970): \(msg)\n"
        if let h = FileHandle(forWritingAtPath: path) {
            h.seekToEndOfFile(); h.write(Data(line.utf8)); h.closeFile()
        } else {
            try? line.write(toFile: path, atomically: true, encoding: .utf8)
        }
    }
}
