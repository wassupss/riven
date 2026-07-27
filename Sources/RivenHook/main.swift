import Foundation

// riven-hook — the tiny bridge an agent's lifecycle hook executes.
//
//   riven-hook <agent> <event>      (hook payload JSON arrives on stdin)
//
// It forwards one JSON line to the riven app over a unix socket and exits. Design
// rules, in priority order:
//
//  1. NEVER block or fail the agent. Every error path exits 0. A coding agent must
//     not stall because riven is closed, restarting, or wedged.
//  2. No dependencies beyond Foundation, so this stays a few hundred KB and starts
//     in single-digit milliseconds — it runs on every prompt/stop of every pane.
//  3. The pane identity comes from RIVEN_PANE_SESSION in our OWN environment, not
//     from the payload. riven injects that var into each terminal surface, and hook
//     processes are descendants of the pane's command, so they inherit it. This is
//     what makes the bridge agent-agnostic: Claude Code exposes `session_id` in the
//     payload, Codex has no equivalent, but both inherit the pane env.

let args = Array(CommandLine.arguments.dropFirst())
guard args.count >= 2 else { exit(0) }          // malformed invocation → say nothing
let agent = args[0], event = args[1]

// The pane this hook belongs to. Without it the app can't route the event, so there
// is nothing useful to send.
guard let pane = ProcessInfo.processInfo.environment["RIVEN_PANE_SESSION"],
      UUID(uuidString: pane) != nil else { exit(0) }

// riven passes the socket path per surface; fall back to the default location so a
// hook still works if the env var was stripped.
let socketPath = ProcessInfo.processInfo.environment["RIVEN_HOOK_SOCKET"]
    ?? FileManager.default.homeDirectoryForCurrentUser
        .appendingPathComponent("Library/Application Support/riven-native/hooks.sock").path

// ---- read the payload -------------------------------------------------------
// Cap the read: a payload is normally a few hundred bytes, but PostToolUse-style
// events can carry large tool output. We only ever use small scalar fields, so
// truncating protects both this process and the app's line limit. Truncated JSON
// fails to parse app-side and is dropped — deliberately better than unbounded reads.
let maxPayload = 256 * 1024
var payload = Data()
while payload.count < maxPayload, let chunk = try? FileHandle.standardInput.read(upToCount: 64 * 1024),
      !chunk.isEmpty {
    payload.append(chunk)
}

// Keep the payload as an opaque JSON value; the app decides which fields it needs.
// If stdin wasn't valid JSON (or was truncated) send an empty object rather than
// dropping the event — the event NAME alone still drives the state machine.
let payloadObject: Any = (try? JSONSerialization.jsonObject(with: payload)) ?? [String: Any]()

let envelope: [String: Any] = [
    "v": 1,
    "agent": agent,
    "event": event,
    "pane": pane,
    "payload": payloadObject,
]
guard var line = try? JSONSerialization.data(withJSONObject: envelope) else { exit(0) }
line.append(0x0A)   // the app reads newline-delimited JSON

// ---- send -------------------------------------------------------------------
// A blocking connect+write with a short timeout. The socket is local, so this is
// sub-millisecond in practice; the timeout only matters if the app is wedged, and
// even then we give up quickly rather than holding up the agent.
let fd = socket(AF_UNIX, SOCK_STREAM, 0)
guard fd >= 0 else { exit(0) }
defer { close(fd) }

var timeout = timeval(tv_sec: 1, tv_usec: 0)
setsockopt(fd, SOL_SOCKET, SO_SNDTIMEO, &timeout, socklen_t(MemoryLayout<timeval>.size))

var addr = sockaddr_un()
addr.sun_family = sa_family_t(AF_UNIX)
let pathBytes = Array(socketPath.utf8)
// sun_path is a fixed 104-byte buffer; an over-long path can't be represented.
guard pathBytes.count < MemoryLayout.size(ofValue: addr.sun_path) else { exit(0) }
withUnsafeMutableBytes(of: &addr.sun_path) { raw in
    raw.copyBytes(from: pathBytes)
}
addr.sun_len = UInt8(MemoryLayout<sockaddr_un>.size)

let connected = withUnsafePointer(to: &addr) { ptr in
    ptr.withMemoryRebound(to: sockaddr.self, capacity: 1) { sa in
        connect(fd, sa, socklen_t(MemoryLayout<sockaddr_un>.size))
    }
}
guard connected == 0 else { exit(0) }   // riven not running → nothing to notify

line.withUnsafeBytes { buf in
    var sent = 0
    while sent < buf.count {
        let n = write(fd, buf.baseAddress!.advanced(by: sent), buf.count - sent)
        if n <= 0 { break }             // EPIPE / timeout → give up silently
        sent += n
    }
}
exit(0)
