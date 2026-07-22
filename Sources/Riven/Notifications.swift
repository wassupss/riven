import AppKit
import UserNotifications

// macOS notifications for the terminal — posts OS notifications for OSC 9 / OSC 777
// desktop-notification escapes and the bell, matching riven (notifies when an agent
// finishes or a shell sends a notification). Gated by the "notifications" setting.
// A delegate makes banners show even while riven is frontmost (macOS otherwise
// suppresses foreground notifications).
final class NotificationDelegate: NSObject, UNUserNotificationCenterDelegate {
    static let shared = NotificationDelegate()
    func userNotificationCenter(_ center: UNUserNotificationCenter,
                                willPresent notification: UNNotification,
                                withCompletionHandler completionHandler: @escaping (UNNotificationPresentationOptions) -> Void) {
        completionHandler([.banner, .list, .sound])   // show even when the app is active
    }
}

enum Notifications {
    private static var authorized = false

    static func requestAuthorization() {
        guard Bundle.main.bundleIdentifier != nil else { return }   // needs a bundle id
        let center = UNUserNotificationCenter.current()
        center.delegate = NotificationDelegate.shared
        center.requestAuthorization(options: [.alert, .sound, .badge]) { granted, _ in
            authorized = granted
        }
    }

    static var enabled: Bool { Settings.shared.bool("notifications", true) }

    // Post a desktop notification (from ghostty's DESKTOP_NOTIFICATION action, or the
    // bell). Shows even when riven is frontmost (see the delegate above).
    static func post(title: String, body: String) {
        guard enabled, Bundle.main.bundleIdentifier != nil else { NSSound.beep(); return }
        let content = UNMutableNotificationContent()
        content.title = title.isEmpty ? "riven" : title
        content.body = body
        content.sound = .default
        let req = UNNotificationRequest(identifier: UUID().uuidString, content: content, trigger: nil)
        UNUserNotificationCenter.current().add(req, withCompletionHandler: nil)
    }

    // Terminal bell → notify (agent usually rings the bell when a turn finishes).
    static func bell() {
        if !NSApp.isActive { NSApp.requestUserAttention(.informationalRequest) }
        if enabled { post(title: "riven", body: "터미널 작업 완료") } else { NSSound.beep() }
    }
}
