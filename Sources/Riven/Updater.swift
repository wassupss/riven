import AppKit
import Sparkle

// Auto-update via Sparkle. The app polls an appcast feed (SUFeedURL in Info.plist),
// verifies each update's EdDSA signature against SUPublicEDKey, and installs on quit.
// Only active when a feed is configured (release builds); dev builds no-op.
final class Updater: NSObject, SPUUpdaterDelegate {
    static let shared = Updater()
    private var controller: SPUStandardUpdaterController?
    // Fired when an update CHECK finishes (Sparkle then shows its own result window).
    // Settings uses it to clear its "확인 중…" hint instead of leaving it stuck.
    var onCheckFinished: (() -> Void)?

    private var configured: Bool {
        let feed = (Bundle.main.object(forInfoDictionaryKey: "SUFeedURL") as? String) ?? ""
        return !feed.isEmpty
    }

    // Start the updater (background scheduled checks) if a feed is configured.
    func start() {
        guard configured, controller == nil else { return }
        controller = SPUStandardUpdaterController(startingUpdater: true, updaterDelegate: self, userDriverDelegate: nil)
    }

    // SPUUpdaterDelegate — the check (scheduled or user-initiated) completed.
    func updater(_ updater: SPUUpdater, didFinishUpdateCycleFor updateCheck: SPUUpdateCheck, error: Error?) {
        DispatchQueue.main.async { [weak self] in
            self?.onCheckFinished?()
            self?.onCheckFinished = nil   // one-shot: only the caller that armed it cares
        }
    }

    // User-initiated "Check for Updates…" — Sparkle drives its own progress/UI.
    @objc func checkForUpdates(_ sender: Any?) {
        guard configured else {
            let a = NSAlert()
            a.messageText = "업데이트를 확인할 수 없습니다"
            a.informativeText = "이 빌드에는 업데이트 피드가 설정되어 있지 않습니다(개발 빌드)."
            a.runModal(); return
        }
        if controller == nil { start() }
        controller?.checkForUpdates(sender)
    }
}
