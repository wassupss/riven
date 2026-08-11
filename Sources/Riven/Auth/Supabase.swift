import AppKit
import WebKit
import CryptoKit

// riven account & settings sync via Supabase - the native counterpart of riven's
// renderer auth (state/auth.ts) + main/auth.ts. GitHub OAuth uses PKCE: we open
// the provider authorize URL in a WKWebView window and intercept the redirect to
// lift the `code` (no custom URL scheme / Supabase allowlist change needed, exactly
// like the Electron build). The code is exchanged for a session over the Supabase
// auth REST API; settings sync to the user_settings table (RLS-protected).

// ---- config (public client values, injected into Info.plist at build time) ----
enum SupabaseConfig {
    // Trim whitespace AND newlines: values baked into Info.plist / injected via env
    // frequently carry a stray trailing newline (heredocs, `$(cat file)`, etc.). A
    // newline surviving into the URL string makes URLComponents(string:) return nil,
    // which used to crash the OAuth flow on a force-unwrap.
    static let url = (Bundle.main.infoDictionary?["SupabaseURL"] as? String)?
        .trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
    static let anonKey = (Bundle.main.infoDictionary?["SupabaseAnonKey"] as? String)?
        .trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
    static let redirect = ((Bundle.main.infoDictionary?["SupabaseRedirect"] as? String)?
        .trimmingCharacters(in: .whitespacesAndNewlines)).flatMap { $0.isEmpty ? nil : $0 }
        ?? "https://localhost/riven/auth/callback"
    static var isConfigured: Bool { !url.isEmpty && !anonKey.isEmpty }
}

// ---- session-token store (owner-only file, NOT the keychain) ----
// The keychain caused two release-blocking problems: the legacy keychain popped a
// "riven wants to use com.wassupss.riven.auth" ACL prompt on every launch after re-signing,
// and the data-protection keychain needs a `keychain-access-groups` entitlement that a
// Developer-ID app can't ship without a provisioning profile (it made the app get SIGKILL'd
// at launch). Store the token in a 0600 file under the user's account-protected home dir
// instead - the same tradeoff gh/npm/git credential stores make.
enum Keychain {
    private static let dir: URL = {
        let d = AppPaths.support("secrets")
        try? FileManager.default.createDirectory(at: d, withIntermediateDirectories: true,
                                                 attributes: [.posixPermissions: 0o700])
        return d
    }()
    private static func file(_ key: String) -> URL { dir.appendingPathComponent(key + ".txt") }
    static func set(_ key: String, _ value: String) {
        try? Data(value.utf8).write(to: file(key), options: .atomic)
        try? FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: file(key).path)
    }
    static func get(_ key: String) -> String? {
        guard let d = try? Data(contentsOf: file(key)) else { return nil }
        return String(data: d, encoding: .utf8)
    }
    static func delete(_ key: String) {
        try? FileManager.default.removeItem(at: file(key))
    }
}

struct AuthSession: Codable {
    var accessToken: String
    var refreshToken: String
    var expiresAt: Date
    var userId: String
    var email: String?
    var name: String?     // GitHub username / display name (from user_metadata)
}

extension Notification.Name {
    static let rivenAuthChanged = Notification.Name("rivenAuthChanged")       // sign-in/out
    static let rivenSettingsSynced = Notification.Name("rivenSettingsSynced") // a cloud pull was applied
    static let rivenSettingChanged = Notification.Name("rivenSettingChanged") // a local setting was set
}

final class SupabaseAuth {
    static let shared = SupabaseAuth()
    private(set) var session: AuthSession?
    private var oauthWindow: NSWindow?
    private var oauthDelegate: OAuthNavDelegate?
    private var oauthWinDelegate: OAuthWindowDelegate?
    // Invoked if the login window is dismissed before the flow resolves (e.g. the user
    // clicks the close button) so the caller's completion isn't leaked forever.
    private var oauthCancel: (() -> Void)?
    private var applyingRemote = false

    var isSignedIn: Bool { session != nil }
    var email: String? { session?.email }
    var displayName: String? { session?.name ?? session?.email }   // GitHub username / name

    private init() {}

    // Restore a persisted session on launch; refresh if it's expired.
    func restore() {
        guard SupabaseConfig.isConfigured,
              let raw = Keychain.get("session"),
              let s = try? JSONDecoder().decode(AuthSession.self, from: Data(raw.utf8)) else { return }
        session = s
        observeLocalChanges()
        if s.expiresAt <= Date().addingTimeInterval(60) {
            refresh { [weak self] ok in if ok { self?.pull() } else { self?.signOut() } }
        } else {
            pull()
        }
        NotificationCenter.default.post(name: .rivenAuthChanged, object: nil)
    }

    // ---- GitHub OAuth (PKCE) ----
    func signInWithGitHub(_ completion: @escaping (Result<Void, Error>) -> Void) {
        guard SupabaseConfig.isConfigured else { completion(.failure(err("Supabase 미구성"))); return }
        let verifier = Self.pkceVerifier()
        let challenge = Self.pkceChallenge(verifier)
        // No force-unwrap: a malformed base URL (e.g. stray whitespace/newline in the
        // injected config) must surface as a graceful error, never crash the app.
        guard var comp = URLComponents(string: "\(SupabaseConfig.url)/auth/v1/authorize") else {
            completion(.failure(err("Supabase URL이 올바르지 않습니다"))); return
        }
        comp.queryItems = [
            .init(name: "provider", value: "github"),
            .init(name: "redirect_to", value: SupabaseConfig.redirect),
            .init(name: "code_challenge", value: challenge),
            .init(name: "code_challenge_method", value: "s256"),
        ]
        guard let authorizeURL = comp.url else { completion(.failure(err("bad url"))); return }

        let del = OAuthNavDelegate(redirectPrefix: SupabaseConfig.redirect) { [weak self] result in
            self?.closeOAuthWindow()
            switch result {
            case .failure(let e): completion(.failure(e))
            case .success(let code):
                self?.exchange(code: code, verifier: verifier) { r in completion(r) }
            }
        }
        oauthDelegate = del
        let cancelErr = err("로그인이 취소되었습니다")
        oauthCancel = { completion(.failure(cancelErr)) }
        presentOAuthWindow(url: authorizeURL, delegate: del)
    }

    private func presentOAuthWindow(url: URL, delegate: OAuthNavDelegate) {
        // WKWebView / NSWindow may only be created on the main thread - hop there if
        // the caller isn't already on it (otherwise AppKit traps and crashes).
        guard Thread.isMainThread else {
            DispatchQueue.main.async { [weak self] in self?.presentOAuthWindow(url: url, delegate: delegate) }
            return
        }
        let cfg = WKWebViewConfiguration()
        let web = WKWebView(frame: NSRect(x: 0, y: 0, width: 480, height: 680), configuration: cfg)
        web.navigationDelegate = delegate
        let win = NSWindow(contentRect: web.frame, styleMask: [.titled, .closable],
                           backing: .buffered, defer: false)
        win.title = "로그인"
        win.center(); win.contentView = web; win.isReleasedWhenClosed = false
        // The Settings window is a floating panel; keep the OAuth window ABOVE it so the
        // GitHub login isn't hidden behind Settings.
        win.level = .modalPanel
        let winDel = OAuthWindowDelegate { [weak self] in self?.handleOAuthWindowClosed() }
        win.delegate = winDel
        oauthWinDelegate = winDel
        win.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
        oauthWindow = win
        web.load(URLRequest(url: url))
    }
    // The flow resolved (success/failure) - tear down without firing the cancel path.
    private func closeOAuthWindow() {
        oauthCancel = nil
        oauthWindow?.delegate = nil   // suppress windowWillClose re-entry
        oauthWindow?.close(); oauthWindow = nil; oauthDelegate = nil; oauthWinDelegate = nil
    }
    // The window was dismissed by the user before the flow resolved.
    private func handleOAuthWindowClosed() {
        guard let cancel = oauthCancel else { return }   // already resolved
        oauthCancel = nil
        oauthWindow = nil; oauthDelegate = nil; oauthWinDelegate = nil
        cancel()
    }

    // Exchange the PKCE auth code for a session.
    private func exchange(code: String, verifier: String, _ completion: @escaping (Result<Void, Error>) -> Void) {
        tokenRequest(grant: "pkce", body: ["auth_code": code, "code_verifier": verifier]) { [weak self] result in
            DispatchQueue.main.async {
                switch result {
                case .failure(let e): completion(.failure(e))
                case .success(let s):
                    self?.setSession(s)
                    self?.observeLocalChanges()
                    self?.pull()
                    NotificationCenter.default.post(name: .rivenAuthChanged, object: nil)
                    completion(.success(()))
                }
            }
        }
    }

    private func refresh(_ done: @escaping (Bool) -> Void) {
        guard let rt = session?.refreshToken else { done(false); return }
        tokenRequest(grant: "refresh_token", body: ["refresh_token": rt]) { [weak self] result in
            DispatchQueue.main.async {
                if case .success(let s) = result { self?.setSession(s); done(true) } else { done(false) }
            }
        }
    }

    func signOut() {
        session = nil
        Keychain.delete("session")
        NotificationCenter.default.post(name: .rivenAuthChanged, object: nil)
    }

    private func setSession(_ s: AuthSession) {
        session = s
        if let d = try? JSONEncoder().encode(s), let raw = String(data: d, encoding: .utf8) {
            Keychain.set("session", raw)
        }
    }

    // Ensure a fresh access token before an authorized REST call.
    private func withValidToken(_ use: @escaping (String?) -> Void) {
        guard let s = session else { use(nil); return }
        if s.expiresAt <= Date().addingTimeInterval(60) {
            refresh { ok in use(ok ? self.session?.accessToken : nil) }
        } else { use(s.accessToken) }
    }

    // ---- token endpoint (pkce / refresh_token) ----
    private func tokenRequest(grant: String, body: [String: Any], _ completion: @escaping (Result<AuthSession, Error>) -> Void) {
        guard let u = URL(string: "\(SupabaseConfig.url)/auth/v1/token?grant_type=\(grant)") else {
            completion(.failure(err("bad url"))); return
        }
        var r = URLRequest(url: u); r.httpMethod = "POST"
        r.setValue("application/json", forHTTPHeaderField: "Content-Type")
        r.setValue(SupabaseConfig.anonKey, forHTTPHeaderField: "apikey")
        r.httpBody = try? JSONSerialization.data(withJSONObject: body)
        URLSession.shared.dataTask(with: r) { data, resp, e in
            if let e = e { completion(.failure(e)); return }
            guard let data = data,
                  let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else {
                completion(.failure(self.err("no response"))); return
            }
            if let access = obj["access_token"] as? String, let refresh = obj["refresh_token"] as? String {
                let expIn = (obj["expires_in"] as? Double) ?? 3600
                let user = obj["user"] as? [String: Any]
                let meta = user?["user_metadata"] as? [String: Any]
                let name = (meta?["user_name"] as? String) ?? (meta?["preferred_username"] as? String)
                    ?? (meta?["name"] as? String) ?? (user?["email"] as? String)
                let s = AuthSession(accessToken: access, refreshToken: refresh,
                                    expiresAt: Date().addingTimeInterval(expIn),
                                    userId: (user?["id"] as? String) ?? "",
                                    email: user?["email"] as? String, name: name)
                completion(.success(s))
            } else {
                let msg = (obj["error_description"] as? String) ?? (obj["msg"] as? String) ?? "auth failed"
                completion(.failure(self.err(msg)))
            }
        }.resume()
    }

    private func err(_ m: String) -> Error { NSError(domain: "riven.auth", code: 1, userInfo: [NSLocalizedDescriptionKey: m]) }

    // ---- PKCE helpers ----
    private static func pkceVerifier() -> String {
        var bytes = [UInt8](repeating: 0, count: 64)
        _ = SecRandomCopyBytes(kSecRandomDefault, bytes.count, &bytes)
        return base64url(Data(bytes))
    }
    private static func pkceChallenge(_ verifier: String) -> String {
        base64url(Data(SHA256.hash(data: Data(verifier.utf8))))
    }
    private static func base64url(_ d: Data) -> String {
        d.base64EncodedString().replacingOccurrences(of: "+", with: "-")
            .replacingOccurrences(of: "/", with: "_").replacingOccurrences(of: "=", with: "")
    }

    // ---- settings sync (user_settings table, RLS) ----
    // Everything EXCEPT the local/sensitive keys is synced.
    // aiApiKey/session are secrets; aiCompleteEndpoint/aiProvider are machine-local
    // (a custom endpoint URL shouldn't leak to other devices via the synced settings row).
    // Never sync to the cloud: AI key/endpoint, the local dock session, AND the API panel's
    // request history / saved collections / environments - those can hold Bearer tokens and
    // Basic-auth passwords, so they stay on this device only.
    private static let noSync: Set<String> = [
        "browserURLs",      // 이 기기에서 보던 주소 (워크스페이스 경로가 들어간다)
        "browserZooms",     // 사이트별 확대 - 어느 사이트에 갔는지가 드러난다
        "browserTabs", "browserActiveTab",   // 이 기기에서 열어 둔 탭
        "aiApiKey", "session", "aiCompleteEndpoint", "aiProvider",
        "api.history", "api.collections", "api.environments",
        // 이 기기의 로컬 부기 값 - 동기화하면 안 된다. 특히 lastSeenVersion 이 동기화되면,
        // 한 기기가 업데이트 후 클라우드에 현재 버전을 올리고 → 다른 기기가 그 값을 pull 해
        // "이미 봤음" 이 돼 릴리스노트 다이얼로그가 안 떴다. installId 는 설치별 식별자라 공유 금지.
        "lastSeenVersion", "installId",
        // The local-change stamp is bookkeeping, never uploaded - AND it must be here or
        // localChanged() recurses into itself: set(any syncable key) → .rivenSettingChanged →
        // localChanged → set(localStampKey) → .rivenSettingChanged → localChanged → … until the
        // stack overflows. That was the v0.1.57 launch crash: while signed in, the first
        // syncable set() (pinned usage restoring "usagePinned") triggered the loop. It only bit
        // release builds because sync is configured there (signed in); local dev builds aren't.
        localStampKey,
    ]

    private func observeLocalChanges() {
        NotificationCenter.default.removeObserver(self, name: .rivenSettingChanged, object: nil)
        NotificationCenter.default.addObserver(self, selector: #selector(localChanged(_:)),
                                               name: .rivenSettingChanged, object: nil)
    }
    @objc private func localChanged(_ n: Notification) {
        guard isSignedIn, !applyingRemote else { return }
        // 동기화하지 않는 키(세션·비밀값·브라우저 탭)는 "바뀐 시각" 에도 넣지 않는다.
        // 그것까지 세면 로컬이 늘 최신으로 보여, 다른 기기의 변경을 영영 못 받는다.
        if let key = n.object as? String, Self.noSync.contains(key) { return }
        dirty = true
        Settings.shared.set(Self.localStampKey, Self.iso.string(from: Date()))
    }

    /// 아직 클라우드에 올리지 못한 변경이 있는가.
    private var dirty = false
    /// 로컬에서 마지막으로 설정을 바꾼 시각. 이 키 자체는 올리지 않는다.
    private static let localStampKey = "syncLocalStamp"

    /// 앱이 꺼질 때 한 번 올린다. 설정을 누를 때마다 올리면 눌린 횟수만큼 요청이 나가고,
    /// 정작 다른 기기가 그것을 받는 시점은 그 기기를 켤 때다 - 즉시 올려도 즉시 반영되지
    /// 않는다. 나가는 길에 한 번이면 충분하다.
    func flushOnQuit() {
        guard isSignedIn, dirty else { return }
        pushSynchronously()
    }

    func pull() {
        guard let uid = session?.userId else { return }
        withValidToken { [weak self] token in
            guard let self, let token else { return }
            guard let u = URL(string: "\(SupabaseConfig.url)/rest/v1/user_settings?user_id=eq.\(uid)&select=settings,updated_at") else { return }
            var r = URLRequest(url: u)
            r.setValue(SupabaseConfig.anonKey, forHTTPHeaderField: "apikey")
            r.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
            URLSession.shared.dataTask(with: r) { data, _, _ in
                guard let data = data,
                      let arr = try? JSONSerialization.jsonObject(with: data) as? [[String: Any]],
                      let row = arr.first,
                      let remote = row["settings"] as? [String: Any] else { return }
                // 원격이 우리 로컬 변경보다 오래됐으면 적용하지 않는다. 예전에는 무조건
                // 덮어썼는데, 올리기를 종료 시점으로 미룬 지금은 그게 곧 데이터 손실이다
                // (강제 종료로 못 올린 변경이 다음 실행의 pull 에 지워진다).
                let remoteAt = (row["updated_at"] as? String).flatMap { Self.iso.date(from: $0) }
                let localAt = Self.iso.date(from: Settings.shared.string(Self.localStampKey, ""))
                if let remoteAt, let localAt, remoteAt < localAt {
                    RLog.log("sync: 원격이 더 오래됐다 - 적용하지 않고 로컬을 올린다")
                    DispatchQueue.main.async { self.push() }
                    return
                }
                DispatchQueue.main.async { self.applyRemote(remote) }
            }.resume()
        }
    }

    private func applyRemote(_ remote: [String: Any]) {
        applyingRemote = true
        for (k, v) in remote where !Self.noSync.contains(k) { Settings.shared.set(k, v) }
        applyingRemote = false
        NotificationCenter.default.post(name: .rivenSettingsSynced, object: nil)
    }

    func push() {
        guard let uid = session?.userId else { return }
        dirty = false
        let payload = Settings.shared.syncableSnapshot(excluding: Self.noSync)
        withValidToken { token in
            guard let token else { return }
            guard let u = URL(string: "\(SupabaseConfig.url)/rest/v1/user_settings") else { return }
            var r = URLRequest(url: u); r.httpMethod = "POST"
            r.setValue("application/json", forHTTPHeaderField: "Content-Type")
            r.setValue(SupabaseConfig.anonKey, forHTTPHeaderField: "apikey")
            r.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
            r.setValue("resolution=merge-duplicates,return=minimal", forHTTPHeaderField: "Prefer")
            let body: [String: Any] = ["user_id": uid, "settings": payload,
                                       "updated_at": Self.iso.string(from: Date())]
            r.httpBody = try? JSONSerialization.data(withJSONObject: body)
            URLSession.shared.dataTask(with: r) { [weak self] _, _, _ in
                DispatchQueue.main.async { self?.pushCompleted?() }
            }.resume()
        }
    }

    /// 종료 직전용. 앱이 내려가는 중이라 비동기 완료를 기다려 줄 사람이 없다 - 짧게 기다린다.
    private func pushSynchronously() {
        let sem = DispatchSemaphore(value: 0)
        pushCompleted = { sem.signal() }
        push()
        _ = sem.wait(timeout: .now() + 2.0)   // 못 올려도 앱을 붙잡지 않는다
        pushCompleted = nil
    }
    private var pushCompleted: (() -> Void)?

    // cached - ISO8601DateFormatter is expensive to construct (never do it per call).
    private static let iso = ISO8601DateFormatter()
}

// Fires when the login window closes (user-dismissed or programmatic) so an abandoned
// flow doesn't leave the caller's completion hanging.
private final class OAuthWindowDelegate: NSObject, NSWindowDelegate {
    private let onClose: () -> Void
    init(_ onClose: @escaping () -> Void) { self.onClose = onClose }
    func windowWillClose(_ notification: Notification) { onClose() }
}

// Intercepts the OAuth redirect to lift the PKCE `code` (mirrors main/auth.ts).
private final class OAuthNavDelegate: NSObject, WKNavigationDelegate {
    private let redirectPrefix: String
    private let done: (Result<String, Error>) -> Void
    private var settled = false
    init(redirectPrefix: String, done: @escaping (Result<String, Error>) -> Void) {
        self.redirectPrefix = redirectPrefix; self.done = done
    }
    func webView(_ w: WKWebView, decidePolicyFor a: WKNavigationAction, decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        guard let url = a.request.url?.absoluteString, url.hasPrefix(redirectPrefix),
              let comps = URLComponents(string: url) else { decisionHandler(.allow); return }
        decisionHandler(.cancel)
        if settled { return }
        settled = true
        if let code = comps.queryItems?.first(where: { $0.name == "code" })?.value {
            done(.success(code))
        } else {
            let msg = comps.queryItems?.first(where: { $0.name == "error_description" })?.value ?? "oauth failed"
            done(.failure(NSError(domain: "riven.auth", code: 2, userInfo: [NSLocalizedDescriptionKey: msg])))
        }
    }
}
