import AppKit
import WebKit
import CryptoKit

// riven account & settings sync via Supabase — the native counterpart of riven's
// renderer auth (state/auth.ts) + main/auth.ts. GitHub OAuth uses PKCE: we open
// the provider authorize URL in a WKWebView window and intercept the redirect to
// lift the `code` (no custom URL scheme / Supabase allowlist change needed, exactly
// like the Electron build). The code is exchanged for a session over the Supabase
// auth REST API; settings sync to the user_settings table (RLS-protected).

// ---- config (public client values, injected into Info.plist at build time) ----
enum SupabaseConfig {
    static let url = (Bundle.main.infoDictionary?["SupabaseURL"] as? String)?
        .trimmingCharacters(in: .whitespaces) ?? ""
    static let anonKey = (Bundle.main.infoDictionary?["SupabaseAnonKey"] as? String)?
        .trimmingCharacters(in: .whitespaces) ?? ""
    static let redirect = ((Bundle.main.infoDictionary?["SupabaseRedirect"] as? String)?
        .trimmingCharacters(in: .whitespaces)).flatMap { $0.isEmpty ? nil : $0 }
        ?? "https://localhost/riven/auth/callback"
    static var isConfigured: Bool { !url.isEmpty && !anonKey.isEmpty }
}

// ---- tiny Keychain string store (session tokens live here, never in settings) ----
enum Keychain {
    private static let service = "com.wassupss.riven.auth"
    static func set(_ key: String, _ value: String) {
        let q: [String: Any] = [kSecClass as String: kSecClassGenericPassword,
                                 kSecAttrService as String: service, kSecAttrAccount as String: key]
        SecItemDelete(q as CFDictionary)
        var add = q; add[kSecValueData as String] = Data(value.utf8)
        SecItemAdd(add as CFDictionary, nil)
    }
    static func get(_ key: String) -> String? {
        let q: [String: Any] = [kSecClass as String: kSecClassGenericPassword,
                                 kSecAttrService as String: service, kSecAttrAccount as String: key,
                                 kSecReturnData as String: true, kSecMatchLimit as String: kSecMatchLimitOne]
        var out: CFTypeRef?
        guard SecItemCopyMatching(q as CFDictionary, &out) == errSecSuccess,
              let d = out as? Data else { return nil }
        return String(data: d, encoding: .utf8)
    }
    static func delete(_ key: String) {
        let q: [String: Any] = [kSecClass as String: kSecClassGenericPassword,
                                 kSecAttrService as String: service, kSecAttrAccount as String: key]
        SecItemDelete(q as CFDictionary)
    }
}

struct AuthSession: Codable {
    var accessToken: String
    var refreshToken: String
    var expiresAt: Date
    var userId: String
    var email: String?
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
    private var pushTimer: Timer?
    private var applyingRemote = false

    var isSignedIn: Bool { session != nil }
    var email: String? { session?.email }

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
        var comp = URLComponents(string: "\(SupabaseConfig.url)/auth/v1/authorize")!
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
        presentOAuthWindow(url: authorizeURL, delegate: del)
    }

    private func presentOAuthWindow(url: URL, delegate: OAuthNavDelegate) {
        let cfg = WKWebViewConfiguration()
        let web = WKWebView(frame: NSRect(x: 0, y: 0, width: 480, height: 680), configuration: cfg)
        web.navigationDelegate = delegate
        let win = NSWindow(contentRect: web.frame, styleMask: [.titled, .closable],
                           backing: .buffered, defer: false)
        win.title = "로그인"
        win.center(); win.contentView = web; win.isReleasedWhenClosed = false
        win.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
        oauthWindow = win
        web.load(URLRequest(url: url))
    }
    private func closeOAuthWindow() {
        oauthWindow?.close(); oauthWindow = nil; oauthDelegate = nil
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
        pushTimer?.invalidate(); pushTimer = nil
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
                let s = AuthSession(accessToken: access, refreshToken: refresh,
                                    expiresAt: Date().addingTimeInterval(expIn),
                                    userId: (user?["id"] as? String) ?? "",
                                    email: user?["email"] as? String)
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
    private static let noSync: Set<String> = ["aiApiKey", "session"]

    private func observeLocalChanges() {
        NotificationCenter.default.removeObserver(self, name: .rivenSettingChanged, object: nil)
        NotificationCenter.default.addObserver(self, selector: #selector(localChanged),
                                               name: .rivenSettingChanged, object: nil)
    }
    @objc private func localChanged() {
        guard isSignedIn, !applyingRemote else { return }
        pushTimer?.invalidate()
        pushTimer = Timer.scheduledTimer(withTimeInterval: 0.8, repeats: false) { [weak self] _ in self?.push() }
    }

    func pull() {
        guard let uid = session?.userId else { return }
        withValidToken { [weak self] token in
            guard let self, let token else { return }
            guard let u = URL(string: "\(SupabaseConfig.url)/rest/v1/user_settings?user_id=eq.\(uid)&select=settings") else { return }
            var r = URLRequest(url: u)
            r.setValue(SupabaseConfig.anonKey, forHTTPHeaderField: "apikey")
            r.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
            URLSession.shared.dataTask(with: r) { data, _, _ in
                guard let data = data,
                      let arr = try? JSONSerialization.jsonObject(with: data) as? [[String: Any]],
                      let remote = arr.first?["settings"] as? [String: Any] else { return }
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
            URLSession.shared.dataTask(with: r).resume()
        }
    }

    // cached — ISO8601DateFormatter is expensive to construct (never do it per call).
    private static let iso = ISO8601DateFormatter()
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
