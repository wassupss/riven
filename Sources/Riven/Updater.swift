import AppKit
import Sparkle

// Auto-update via Sparkle. The app polls an appcast feed (SUFeedURL in Info.plist),
// verifies each update's EdDSA signature against SUPublicEDKey, and installs on quit.
// Only active when a feed is configured (release builds); dev builds no-op.
//
// Sparkle는 자기 창/알림을 직접 띄우고, 그 문구는 Sparkle.framework 안의 .lproj에서
// 고른다(ko.lproj 포함). 어느 언어를 쓸지는 프로세스의 선호 언어(AppleLanguages)가
// 정하므로, 앱 안에서 언어를 바꾸면 I18n이 그 값을 함께 갱신한다(I18n.applyProcessLanguage).
final class Updater: NSObject {
    static let shared = Updater()
    private var controller: SPUStandardUpdaterController?

    // 확인이 진행 중인지 — 설정 창을 닫았다 다시 열어도 상태 라벨을 복원할 수 있게 공개한다.
    private(set) var isChecking = false
    // 확인이 끝났을 때(최신 · 업데이트 발견 · 실패 · 사용자가 창을 닫음) 호출된다.
    // Sparkle이 자기 UI를 닫아도 우리 쪽 "확인 중…" 라벨이 남지 않도록 하는 훅.
    var onCheckFinished: (() -> Void)?

    private var configured: Bool {
        let feed = (Bundle.main.object(forInfoDictionaryKey: "SUFeedURL") as? String) ?? ""
        return !feed.isEmpty
    }

    // Start the updater (background scheduled checks) if a feed is configured.
    func start() {
        // Sparkle 번들이 로드되기 전에 프로세스 선호 언어를 riven 설정과 맞춰 둔다 —
        // 이 시점 이후 Sparkle이 고르는 .lproj가 결정된다.
        I18n.applyProcessLanguage(I18n.current)
        guard configured, controller == nil else { return }
        controller = SPUStandardUpdaterController(startingUpdater: true, updaterDelegate: self, userDriverDelegate: nil)
    }

    // User-initiated "Check for Updates…" — Sparkle drives its own progress/UI.
    @objc func checkForUpdates(_ sender: Any?) {
        guard configured else {
            let a = NSAlert()
            a.messageText = t("update.unavailable")
            a.informativeText = t("update.noFeed")
            a.addButton(withTitle: t("common.confirm"))
            a.runModal()
            finishCheck()
            return
        }
        if controller == nil { start() }
        isChecking = true
        controller?.checkForUpdates(sender)
    }

    // 어떤 경로로 끝나든 상태를 내리고 알린다 (Sparkle 콜백은 여러 개가 올 수 있으므로
    // 멱등하게 — 라벨을 유휴 문구로 되돌리는 동작이라 중복 호출은 무해하다).
    private func finishCheck() {
        isChecking = false
        DispatchQueue.main.async { [weak self] in self?.onCheckFinished?() }
    }
}

// 업데이트 사이클의 종료 지점들. didFinishUpdateCycle이 정상/취소를 모두 덮지만,
// 나머지도 함께 받아 어떤 경로에서도 상태가 중간에 멈추지 않게 한다.
extension Updater: SPUUpdaterDelegate {
    func updater(_ updater: SPUUpdater, didFinishUpdateCycleFor updateCheck: SPUUpdateCheck, error: Error?) {
        finishCheck()
    }
    func updaterDidNotFindUpdate(_ updater: SPUUpdater) { finishCheck() }
    func updater(_ updater: SPUUpdater, didAbortWithError error: Error) { finishCheck() }
    // 업데이트를 찾은 경우에도 확인 단계는 끝난 것 — 이후는 Sparkle 자체 UI가 맡는다.
    func updater(_ updater: SPUUpdater, didFindValidUpdate item: SUAppcastItem) { finishCheck() }
}
