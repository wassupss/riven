import Foundation
import CoreServices

// Watches a workspace tree for file changes (riven's chokidar watcher in
// main/bridge.ts). Fires onChange(absolutePath) on the main queue with a short
// coalescing latency so partial writes settle first. One watcher per workspace.
final class AgentWatch {
    private var stream: FSEventStreamRef?
    private let onChange: (String) -> Void

    init(root: URL, onChange: @escaping (String) -> Void) {
        self.onChange = onChange
        var ctx = FSEventStreamContext(version: 0, info: Unmanaged.passUnretained(self).toOpaque(),
                                       retain: nil, release: nil, copyDescription: nil)
        let cb: FSEventStreamCallback = { _, info, count, pathsPtr, _, _ in
            guard let info else { return }
            let me = Unmanaged<AgentWatch>.fromOpaque(info).takeUnretainedValue()
            let paths = unsafeBitCast(pathsPtr, to: NSArray.self) as? [String] ?? []
            for p in paths { me.onChange(p) }
        }
        stream = FSEventStreamCreate(nil, cb, &ctx, [root.path] as CFArray,
            FSEventStreamEventId(kFSEventStreamEventIdSinceNow), 0.15,
            FSEventStreamCreateFlags(kFSEventStreamCreateFlagFileEvents | kFSEventStreamCreateFlagNoDefer | kFSEventStreamCreateFlagUseCFTypes))
        if let stream {
            FSEventStreamSetDispatchQueue(stream, DispatchQueue.main)
            FSEventStreamStart(stream)
        }
    }
    func stop() {
        guard let stream else { return }
        FSEventStreamStop(stream); FSEventStreamInvalidate(stream); FSEventStreamRelease(stream)
        self.stream = nil
    }
    deinit { stop() }
}
