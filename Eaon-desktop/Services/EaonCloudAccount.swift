import CryptoKit
import Foundation
import Observation

/// Identity for cloud sync, and the authenticated Appwrite calls it enables.
///
/// There is no sign-in here in the usual sense: no provider, no password, no
/// email, no personal information of any kind. A **sync code** — 20 random
/// characters generated on this Mac — deterministically derives the account
/// it belongs to (see `derive(from:)`), so any device holding the code lands
/// on the same rows and no other device can.
///
/// Social sign-in used to live here (Discord/GitHub, via a browser redirect
/// and a loopback listener) and has been removed outright rather than left
/// as a fallback. It was a standing dependency on credentials in a
/// third-party dashboard — a redirect URI, a client id, a client secret,
/// each able to break sign-in for every user without a line of code
/// changing, and each unfixable from inside the app. A sync code has no such
/// moving parts. It also collects strictly less about the user, which for
/// this product is the point rather than a side effect.
///
/// Identity is all this establishes. It tells the database *whose* rows
/// these are; it does not grant the ability to read them — the content key
/// is derived separately and never leaves the device.
@MainActor
@Observable
final class EaonCloudAccount {
    static let shared = EaonCloudAccount()

    static let endpoint = URL(string: "https://sfo.cloud.appwrite.io/v1")!
    /// The Student Pack project, whose id is the literal string "eaon" — not
    /// the 20-hex-character id Appwrite generates by default. There is a
    /// second, older project also named "Eaon" carrying a near-identical
    /// schema; this is the current one (more users, and the one the console
    /// opens on). Getting these two confused costs an afternoon, so: the id
    /// here must match the `project-sfo-<id>` segment of the console URL.
    static let projectId = "eaon"
    static let databaseId = "eaon"
    static let itemsTable = "sync_items"
    static let keysTable = "sync_keys"
    static let filesBucket = "sync_files"

    /// TablesDB lives under `/v1/tablesdb/…`, NOT `/v1/databases/…` — the
    /// latter is the older Databases API (collections/documents) and, when
    /// handed a `tables/` path, Appwrite Cloud answers with an HTML console
    /// page rather than a JSON 404. Verified against the live API: the
    /// wrong path returns HTML that no JSON decoder can make sense of, which
    /// is a needlessly baffling way to discover a typo.
    static func rowsPath(_ table: String, rowId: String? = nil) -> String {
        let base = "tablesdb/\(databaseId)/tables/\(table)/rows"
        guard let rowId else { return base }
        return base + "/" + rowId
    }

    /// Appwrite 1.9 rejects the shorthand `limit(100)` query string outright
    /// ("Invalid query: Syntax error"); queries must be JSON objects. Built
    /// here so no call site has to remember that.
    static func encodedQuery(method: String, values: [Any]) -> String {
        let json = (try? JSONSerialization.data(withJSONObject: ["method": method, "values": values]))
            .flatMap { String(data: $0, encoding: .utf8) } ?? ""
        return json.addingPercentEncoding(withAllowedCharacters: .alphanumerics) ?? ""
    }

    struct Session: Codable, Equatable {
        var userId: String
        var secret: String
        var email: String
        var name: String
        /// The sync code this session was opened with, kept so the vault can
        /// re-unlock itself on the next launch instead of demanding the code
        /// every time the app starts.
        ///
        /// Storing it locally is deliberate and costs nothing: the chats it
        /// decrypts are already sitting in plaintext on this same disk, so
        /// anyone who can read this can read them anyway. What the encryption
        /// defends against is the *server* — and the code never reaches it.
        /// Same reasoning as `APIKeyStore`, which keeps provider keys here
        /// for the same reason.
        ///
        /// Optional so sessions persisted before this existed still decode
        /// rather than throwing and silently signing the user out.
        var syncCode: String?

        var displayName: String {
            if !name.isEmpty { return name }
            if !email.isEmpty { return email }
            return "Signed in"
        }
    }

    enum AccountError: LocalizedError {
        case cancelled
        case timedOut
        case sessionExchangeFailed(String)
        case notSignedIn
        case requestFailed(status: Int, message: String)

        var errorDescription: String? {
            switch self {
            case .cancelled: return "Sign-in was cancelled."
            case .timedOut: return "Sign-in timed out. Try again."
            case .sessionExchangeFailed(let detail): return "Couldn't finish signing in: \(detail)"
            case .notSignedIn: return "You're not signed in."
            case .requestFailed(let status, let message): return "Cloud request failed (\(status)): \(message)"
            }
        }
    }

    private static let sessionKey = "cloud_sync_session_v1"

    private(set) var session: Session?
    private(set) var isSigningIn = false
    var lastError: String?

    var isSignedIn: Bool { session != nil }

    private init() {
        if let data = UserDefaults.standard.data(forKey: Self.sessionKey),
           let stored = try? JSONDecoder().decode(Session.self, from: data) {
            session = stored
        }
    }

    // MARK: - Sync codes (no provider, no sign-in)

    /// Everything a sync code derives. All three come from the code alone,
    /// so any device holding it lands on exactly the same account — which is
    /// the whole trick: the code IS the identity, and nothing personal is
    /// ever collected, stored, or transmitted.
    ///
    /// Two different prefixes on purpose. Hashing the same code twice with
    /// no domain separation would make the account id and the password
    /// derivable from each other, and the id is not secret — it's written
    /// into every row. The prefixes keep the password independent of it.
    struct DerivedCredentials {
        let userId: String
        let email: String
        let password: String
    }

    nonisolated static func derive(from code: String) -> DerivedCredentials {
        let normalized = CloudSyncCrypto.normalizeRecoveryCode(code)
        func hash(_ prefix: String) -> String {
            SHA256.hash(data: Data("\(prefix)|\(normalized)".utf8))
                .map { String(format: "%02x", $0) }.joined()
        }
        // 32 hex chars: inside Appwrite's 36-character user-id limit, and
        // valid without needing to start with a letter.
        let userId = String(hash("eaon-sync-id").prefix(32))
        return DerivedCredentials(
            userId: userId,
            // A syntactically valid address at a domain that intentionally
            // receives no mail — Appwrite requires an email, but nothing is
            // ever sent to it and it identifies no person.
            email: "\(userId)@sync.eaon.app",
            password: String(hash("eaon-sync-pw").prefix(40))
        )
    }

    /// Mints a brand-new sync code and claims the account it derives. The
    /// caller shows the code to the user — it is the only way back in, and
    /// it is never stored anywhere we control.
    func createSyncCode() async -> String? {
        let code = CloudSyncCrypto.generateRecoveryCode()
        isSigningIn = true
        lastError = nil
        defer { isSigningIn = false }
        do {
            let credentials = Self.derive(from: code)
            try await createAccount(credentials)
            var opened = try await openEmailSession(credentials)
            opened.syncCode = code
            session = opened
            persistSession()
            // The code doubles as the passphrase, so the vault opens right
            // here — no second prompt, and "Sync now" is live immediately.
            CloudSyncStore.shared.unlock(with: try await establishVaultKey(code: code))
            return code
        } catch {
            lastError = error.localizedDescription
            return nil
        }
    }

    /// Signs in on a second device with a code from the first. Creates the
    /// account if it somehow doesn't exist yet, so a code minted but never
    /// used still works.
    func signIn(withSyncCode code: String) async {
        guard !isSigningIn else { return }
        isSigningIn = true
        lastError = nil
        defer { isSigningIn = false }
        do {
            let credentials = Self.derive(from: code)
            var opened: Session
            do {
                opened = try await openEmailSession(credentials)
            } catch {
                // No account for this code yet — claim it, then sign in.
                try await createAccount(credentials)
                opened = try await openEmailSession(credentials)
            }
            opened.syncCode = code
            session = opened
            persistSession()
            CloudSyncStore.shared.unlock(with: try await establishVaultKey(code: code))
        } catch {
            lastError = "That sync code didn't work. Check it and try again."
        }
    }

    /// Produces the master key this account's content is encrypted under,
    /// creating it on first use and recovering it on every device after.
    ///
    /// The sync code plays both roles by design: it identifies the account
    /// (see `derive(from:)`) AND unwraps the content key here. Two secrets
    /// for one act — "sign in, then also enter your passphrase" — is the kind
    /// of friction people work around by choosing something weak, and there's
    /// no security won by splitting them when losing either one loses the
    /// data anyway.
    ///
    /// The key itself is generated on-device and only ever leaves it wrapped
    /// under the code, so `sync_keys` holds ciphertext the server cannot open.
    func establishVaultKey(code: String) async throws -> SymmetricKey {
        guard let userId = session?.userId else { throw AccountError.notSignedIn }
        let path = Self.rowsPath(Self.keysTable, rowId: userId)

        // Already set up on another device (or an earlier run here) — fetch
        // the wrapped key and open it.
        if let data = try? await send(try authorizedRequest(path: path)),
           let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
           let wrapped = json["wrappedKey"] as? String,
           let salt = json["salt"] as? String {
            let bundle = CloudSyncCrypto.WrappedKeyBundle(
                wrappedKey: wrapped,
                salt: salt,
                iterations: (json["iterations"] as? Int) ?? CloudSyncCrypto.defaultIterations,
                recoveryWrapped: json["recoveryWrapped"] as? String,
                recoverySalt: json["recoverySalt"] as? String,
                kdf: (json["kdf"] as? String) ?? CloudSyncCrypto.kdfIdentifier,
                version: CloudSyncCrypto.currentVersion
            )
            return try CloudSyncCrypto.unwrapMasterKey(passphrase: CloudSyncCrypto.normalizeRecoveryCode(code), bundle: bundle)
        }

        // First time for this code: mint a key, wrap it, and publish the
        // wrapping so other devices can open it with the same code.
        let masterKey = CloudSyncCrypto.generateMasterKey()
        let (bundle, _) = try CloudSyncCrypto.wrapNewMasterKey(
            masterKey,
            passphrase: CloudSyncCrypto.normalizeRecoveryCode(code)
        )
        let fields: [String: Any] = [
            "userId": userId,
            "wrappedKey": bundle.wrappedKey,
            "salt": bundle.salt,
            "iterations": bundle.iterations,
            "recoveryWrapped": bundle.recoveryWrapped ?? "",
            "recoverySalt": bundle.recoverySalt ?? "",
            "kdf": bundle.kdf,
        ]
        let body = try JSONSerialization.data(withJSONObject: [
            "rowId": userId,
            "data": fields,
            "permissions": ["read(\"user:\(userId)\")", "update(\"user:\(userId)\")", "delete(\"user:\(userId)\")"],
        ])
        _ = try await send(try authorizedRequest(path: Self.rowsPath(Self.keysTable), method: "POST", body: body))
        return masterKey
    }

    /// Re-opens the vault on launch from the stored code, so a signed-in user
    /// isn't met with "Locked" and no way to act on it every time they start
    /// the app. Silent on failure: this runs unprompted at startup, and an
    /// error banner for something the user didn't ask for is just noise —
    /// the Sync page still shows the locked state and its own error.
    func restoreVaultIfPossible() async {
        guard let code = session?.syncCode, !CloudSyncStore.shared.isUnlocked else { return }
        if let key = try? await establishVaultKey(code: code) {
            CloudSyncStore.shared.unlock(with: key)
        }
    }

    /// Forgets this device's session. Deliberately local-only: it does not
    /// touch anything already uploaded, because "stop this Mac talking to the
    /// cloud" and "erase what's in the cloud" are different intentions, and
    /// the second one is destructive enough to need its own explicit button.
    ///
    /// The sync code itself is not stored here and so isn't erased by this —
    /// signing back in means entering it again, which is exactly right: if
    /// signing out left the code lying around, it wouldn't be a secret.
    func signOut() {
        session = nil
        UserDefaults.standard.removeObject(forKey: Self.sessionKey)
        // Belt to the `httpShouldHandleCookies = false` braces: purge any
        // Appwrite cookie already sitting in shared storage from before that
        // was set. Without this, an app updated mid-session keeps a stale
        // cookie forever and every future sign-in fails with "a session is
        // active" — a bug the user could only clear by wiping app data.
        if let cookies = HTTPCookieStorage.shared.cookies(for: Self.endpoint) {
            for cookie in cookies where cookie.name.hasPrefix("a_session_") {
                HTTPCookieStorage.shared.deleteCookie(cookie)
            }
        }
    }

    private func persistSession() {
        guard let session, let data = try? JSONEncoder().encode(session) else { return }
        UserDefaults.standard.set(data, forKey: Self.sessionKey)
    }

    private func createAccount(_ credentials: DerivedCredentials) async throws {
        var request = URLRequest(url: Self.endpoint.appendingPathComponent("account"))
        request.httpMethod = "POST"
        // Cookies OFF, always. `AppHTTP.session` is the app-wide session and
        // carries `HTTPCookieStorage.shared`, so Appwrite's `a_session_*`
        // cookie from an earlier sign-in gets attached automatically — and
        // Appwrite then refuses a new one with "Creation of a session is
        // prohibited when a session is active", even after the app itself has
        // signed out. Reproduced against the live API: identical request
        // succeeds (201) without the jar and fails (401) with it. This client
        // authenticates with an explicit X-Appwrite-Session header, so cookies
        // are never needed here and only ever cause this.
        request.httpShouldHandleCookies = false
        request.addValue("application/json", forHTTPHeaderField: "Content-Type")
        request.addValue(Self.projectId, forHTTPHeaderField: "X-Appwrite-Project")
        request.httpBody = try JSONSerialization.data(withJSONObject: [
            "userId": credentials.userId,
            "email": credentials.email,
            "password": credentials.password,
        ])
        let (data, response) = try await AppHTTP.session.data(for: request)
        guard let http = response as? HTTPURLResponse else { throw URLError(.badServerResponse) }
        // 409 means this code's account already exists, which is a success
        // for our purposes — someone else's device got here first.
        guard http.statusCode < 300 || http.statusCode == 409 else {
            let message = (try? JSONSerialization.jsonObject(with: data) as? [String: Any])?["message"] as? String
            throw AccountError.sessionExchangeFailed(message ?? "couldn't create the sync account")
        }
    }

    /// Opens a session and digs the secret out of the response.
    ///
    /// Email sessions return `"secret": ""` in the JSON body — the real one
    /// arrives as a cookie, which a native client using explicit headers
    /// never sees. Appwrite publishes the same value in `x-fallback-cookies`
    /// precisely for non-browser clients; that's what this reads. Trusting
    /// the body's `secret` field here would silently produce an empty
    /// credential and 401 on every later call.
    private func openEmailSession(_ credentials: DerivedCredentials) async throws -> Session {
        var request = URLRequest(url: Self.endpoint.appendingPathComponent("account/sessions/email"))
        request.httpMethod = "POST"
        // Cookies OFF, always. `AppHTTP.session` is the app-wide session and
        // carries `HTTPCookieStorage.shared`, so Appwrite's `a_session_*`
        // cookie from an earlier sign-in gets attached automatically — and
        // Appwrite then refuses a new one with "Creation of a session is
        // prohibited when a session is active", even after the app itself has
        // signed out. Reproduced against the live API: identical request
        // succeeds (201) without the jar and fails (401) with it. This client
        // authenticates with an explicit X-Appwrite-Session header, so cookies
        // are never needed here and only ever cause this.
        request.httpShouldHandleCookies = false
        request.addValue("application/json", forHTTPHeaderField: "Content-Type")
        request.addValue(Self.projectId, forHTTPHeaderField: "X-Appwrite-Project")
        request.httpBody = try JSONSerialization.data(withJSONObject: [
            "email": credentials.email,
            "password": credentials.password,
        ])
        let (data, response) = try await AppHTTP.session.data(for: request)
        guard let http = response as? HTTPURLResponse, http.statusCode < 300 else {
            let message = (try? JSONSerialization.jsonObject(with: data) as? [String: Any])?["message"] as? String
            throw AccountError.sessionExchangeFailed(message ?? "sign-in refused")
        }
        guard let secret = Self.sessionSecret(from: http, body: data) else {
            throw AccountError.sessionExchangeFailed("no session secret in the response")
        }
        return Session(userId: credentials.userId, secret: secret, email: "", name: "Sync code")
    }

    /// Body first (the OAuth token flow does populate it), then the fallback
    /// cookie header (the email flow does not).
    nonisolated static func sessionSecret(from response: HTTPURLResponse, body: Data) -> String? {
        if let json = try? JSONSerialization.jsonObject(with: body) as? [String: Any],
           let secret = json["secret"] as? String, !secret.isEmpty {
            return secret
        }
        guard let fallback = response.value(forHTTPHeaderField: "x-fallback-cookies"),
              let data = fallback.data(using: .utf8),
              let cookies = try? JSONSerialization.jsonObject(with: data) as? [String: String] else {
            return nil
        }
        // Exactly one session cookie per project; take whichever key the
        // project id produced rather than hardcoding its shape.
        return cookies.first(where: { !$0.value.isEmpty })?.value
    }

    // MARK: - Authenticated requests

    /// Every cloud call goes through here, so the session header is attached
    /// in exactly one place and a signed-out state fails loudly rather than
    /// silently making an anonymous request that would 401 further away from
    /// the cause.
    func authorizedRequest(path: String, method: String = "GET", body: Data? = nil, contentType: String = "application/json") throws -> URLRequest {
        guard let session else { throw AccountError.notSignedIn }
        var request = URLRequest(url: Self.endpoint.appendingPathComponent(path))
        request.httpMethod = method
        request.timeoutInterval = 60
        request.httpShouldHandleCookies = false
        request.addValue(Self.projectId, forHTTPHeaderField: "X-Appwrite-Project")
        request.addValue(session.secret, forHTTPHeaderField: "X-Appwrite-Session")
        if let body {
            request.addValue(contentType, forHTTPHeaderField: "Content-Type")
            request.httpBody = body
        }
        return request
    }

    @discardableResult
    func send(_ request: URLRequest) async throws -> Data {
        let (data, response) = try await AppHTTP.session.data(for: request)
        guard let http = response as? HTTPURLResponse else { throw URLError(.badServerResponse) }
        guard http.statusCode < 300 else {
            // A 401 means the stored session is dead (expired, or revoked
            // from another device). Clearing it here turns a permanent
            // stream of failures into a visible "signed out" the user can
            // actually act on.
            if http.statusCode == 401 { signOut() }
            let message = (try? JSONSerialization.jsonObject(with: data) as? [String: Any])?["message"] as? String
            throw AccountError.requestFailed(status: http.statusCode, message: message ?? "unknown error")
        }
        return data
    }
}
