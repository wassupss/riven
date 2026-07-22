import Foundation

extension Bundle {
    // SwiftPM's generated `Bundle.module` resolves `Riven_Riven.bundle` at
    // `Bundle.main.bundleURL` (= the .app ROOT) and falls back to an absolute
    // build-time `.build/…` path. Inside a packaged .app the bundle actually lives in
    // `Contents/Resources`, so `Bundle.module` only "works" on the build machine (via
    // the .build fallback) and fatalErrors everywhere else. Resolve it robustly:
    // Contents/Resources first (packaged app), then next-to-executable (dev / swift run).
    static let riven: Bundle = {
        var candidates: [URL] = []
        if let res = Bundle.main.resourceURL { candidates.append(res.appendingPathComponent("Riven_Riven.bundle")) }
        candidates.append(Bundle.main.bundleURL.appendingPathComponent("Riven_Riven.bundle"))
        for url in candidates { if let b = Bundle(url: url) { return b } }
        return .main   // non-crashing last resort (callers handle a missing resource)
    }()
}
