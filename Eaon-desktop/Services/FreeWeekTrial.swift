import CryptoKit
import Foundation
import IOKit
import SwiftUI

/// The Free Week — 7 days of hosted models, no signup, activated with one
/// click after install. The counterpart of the gateway's `trial.js`.
///
/// Security model on this side, stated plainly:
/// - The app NEVER holds a real provider key. It holds a trial credential
///   (token + signing secret) that only works against Eaon's own gateway,
///   which attaches the real upstream keys server-side. Extracting this
///   credential from the app gets an attacker at most this device's own
///   capped, expiring, revocable trial — nothing else.
/// - Every request is signed: HMAC-SHA256(secret, "ts.deviceHash.bodySHA").
///   The secret travels exactly once (the mint response, over TLS) and
///   never again — a bearer token leaked from a log or screenshot is
///   useless without it.
/// - The credential is bound server-side to this device's hash; it does
///   not work from another machine even WITH both halves.
/// - Nothing here is ever displayed in UI or written to logs.
enum FreeWeekTrial {
    /// The gateway that serves the free week — Eaon's own, NOT the
    /// user-key Aqua endpoint. Real provider keys live only behind it.
    static let baseURL = URL(string: "https://api.eaon.dev/v1")!

    static let keyPrefix = "eaon-trial-"

    /// Appended to a hosted model's id when it's listed/selected under the
    /// "Eaon Free Trial" provider group rather than "Eaon" — the two groups
    /// otherwise offer the exact same catalog, so this is what keeps them
    /// from colliding into one entry everywhere ids get compared (model-list
    /// dedup, the picker's per-row selection, `chatModels.contains(where:)`).
    /// Stripped back off before a model id is ever sent to a real API, or
    /// used to look up a display name — the wire format and the hand-
    /// maintained catalog have no idea this exists.
    ///
    /// A SUFFIX, not a prefix: several existing capability checks key off
    /// `id.hasPrefix("gpt")` / `.hasPrefix("sonnet")` / etc. (see
    /// `ModelCatalog.supportsVision`), and a leading tag would silently
    /// break every one of them. Appending at the end leaves those intact —
    /// only an EXACT id match (the display-name catalog lookup) needs the
    /// explicit strip below.
    static let trialModelSuffix = "#trial"

    static func isTrialTaggedModelId(_ modelId: String) -> Bool {
        modelId.hasSuffix(trialModelSuffix)
    }

    static func strippingTrialSuffix(_ modelId: String) -> String {
        isTrialTaggedModelId(modelId) ? String(modelId.dropLast(trialModelSuffix.count)) : modelId
    }

    /// True when this apiKey string is a trial credential — how request
    /// builders decide to attach signing headers (see `authorize`).
    static func isTrialKey(_ apiKey: String) -> Bool {
        apiKey.hasPrefix(keyPrefix)
    }

    /// Live snapshot of the "first 100" launch gift — claimed/remaining
    /// count and the fixed redemption deadline. Public and unauthenticated
    /// on the gateway side: there's no credential to check before someone
    /// has even decided whether to redeem.
    struct GiftStatus {
        let claimed: Int
        let total: Int
        let remaining: Int
        let expiresAt: Date
        let available: Bool
        let supportEmail: String
    }

    /// Returns nil on any network or parse failure — callers treat that the
    /// same as "status unknown yet," never as "offer closed" (a Settings
    /// card that can't reach the gateway shouldn't claim the gift is gone).
    static func fetchGiftStatus() async -> GiftStatus? {
        var request = URLRequest(url: baseURL.appendingPathComponent("trial/gift"))
        request.timeoutInterval = 15
        guard let (data, response) = try? await AppHTTP.session.data(for: request),
              (response as? HTTPURLResponse)?.statusCode == 200,
              let json = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any],
              let payload = json["data"] as? [String: Any],
              let claimed = payload["claimed"] as? Int,
              let total = payload["total"] as? Int,
              let remaining = payload["remaining"] as? Int,
              let expiresRaw = payload["expires_at"] as? String,
              let expiresAt = ISO8601DateFormatter.trialParser.date(from: expiresRaw),
              let available = payload["available"] as? Bool,
              let supportEmail = payload["support_email"] as? String
        else {
            return nil
        }
        return GiftStatus(
            claimed: claimed,
            total: total,
            remaining: remaining,
            expiresAt: expiresAt,
            available: available,
            supportEmail: supportEmail
        )
    }
}

/// One minted credential, persisted in UserDefaults (deliberately — see
/// `APIKeyStore`'s header for why this app avoids the Keychain while
/// ad-hoc signed; the trial credential is designed to be low-value, so the
/// same tradeoff holds).
struct TrialCredential: Codable, Equatable {
    let key: String
    let secret: String
    let expiresAt: Date
}

/// Thread-safe mirror of the active credential, so request builders running
/// off the main actor (streaming, memory extraction) can sign without a
/// MainActor hop — the exact `AppHTTP` lock-box pattern this codebase
/// already uses for the proxy-aware URLSession. `TrialStore` (MainActor)
/// is the only writer.
enum TrialCredentialBox {
    private static let lock = NSLock()
    nonisolated(unsafe) private static var value: TrialCredential?

    static var current: TrialCredential? {
        lock.lock(); defer { lock.unlock() }
        return value
    }

    static func set(_ credential: TrialCredential?) {
        lock.lock(); value = credential; lock.unlock()
    }
}

@MainActor
@Observable
final class TrialStore {
    static let shared = TrialStore()

    private static let credentialKey = "eaon_free_week_credential"
    private nonisolated static let deviceSaltKey = "eaon_free_week_device_salt"

    private(set) var credential: TrialCredential?
    /// Last /v1/trial/status snapshot, for the settings card.
    private(set) var usage: Int?
    private(set) var totalRequests: Int?
    var isStarting = false
    var lastError: String?

    private init() {
        credential = Self.loadCredential()
        TrialCredentialBox.set(credential)
    }

    /// Active = we hold a credential the server hasn't aged out yet. The
    /// server enforces expiry authoritatively on every request — this is
    /// only for choosing UI states and request routing.
    var isActive: Bool {
        guard let credential else { return false }
        return credential.expiresAt > Date()
    }

    var isExpired: Bool {
        guard let credential else { return false }
        return credential.expiresAt <= Date()
    }

    var daysLeft: Int {
        guard let credential else { return 0 }
        return max(0, Int(ceil(credential.expiresAt.timeIntervalSinceNow / 86_400)))
    }

    // MARK: - Device identity

    /// SHA-256 of the Mac's platform UUID AND its hardware serial number,
    /// combined — one trial per physical machine, ever, is only as strong
    /// as this identifier is hard to reset. Either value alone is a
    /// single point of failure (some recovery/repair flows can touch the
    /// platform UUID in isolation); requiring both to change together is
    /// materially harder for a casual reset to defeat, without needing any
    /// entitlement beyond what `IOPlatformExpertDevice` already grants.
    /// Never sends either raw identifier off the device — only this hash.
    /// Falls back to a persisted random value on the rare machine where
    /// IOKit answers neither (e.g. inside some hardened VMs).
    nonisolated static var deviceHash: String {
        let uuid = hardwareIdentifier(kIOPlatformUUIDKey)
        let serial = hardwareIdentifier(kIOPlatformSerialNumberKey)
        let raw: String
        if uuid == nil, serial == nil {
            raw = persistedFallbackID()
        } else {
            // Order fixed and both slots always present (empty string for
            // whichever is missing) so the combined identity is
            // deterministic regardless of which single signal a given
            // machine happens to withhold.
            raw = "\(uuid ?? "")|\(serial ?? "")"
        }
        let digest = SHA256.hash(data: Data("eaon-free-week-v2:\(raw)".utf8))
        return digest.map { String(format: "%02x", $0) }.joined()
    }

    private nonisolated static func hardwareIdentifier(_ key: String) -> String? {
        let entry = IOServiceGetMatchingService(kIOMainPortDefault, IOServiceMatching("IOPlatformExpertDevice"))
        guard entry != IO_OBJECT_NULL else { return nil }
        defer { IOObjectRelease(entry) }
        guard let value = IORegistryEntryCreateCFProperty(entry, key as CFString, kCFAllocatorDefault, 0) else {
            return nil
        }
        return value.takeRetainedValue() as? String
    }

    private nonisolated static func persistedFallbackID() -> String {
        if let existing = UserDefaults.standard.string(forKey: deviceSaltKey) {
            return existing
        }
        let fresh = UUID().uuidString
        UserDefaults.standard.set(fresh, forKey: deviceSaltKey)
        return fresh
    }

    // MARK: - Request signing

    /// The three headers the gateway requires with every trial request —
    /// nonce'd by the clock, bound to this device, pinned to these exact
    /// body bytes. `body` must be the same Data assigned to httpBody.
    nonisolated static func signingHeaders(secret: String, body: Data?) -> [String: String] {
        let device = TrialStore.deviceHash
        let ts = String(Int(Date().timeIntervalSince1970))
        let bodyHash = SHA256.hash(data: body ?? Data()).map { String(format: "%02x", $0) }.joined()
        let payload = "\(ts).\(device).\(bodyHash)"
        let signature = HMAC<SHA256>.authenticationCode(
            for: Data(payload.utf8),
            using: SymmetricKey(data: Data(secret.utf8))
        ).map { String(format: "%02x", $0) }.joined()
        return [
            "X-Eaon-Device": device,
            "X-Eaon-TS": ts,
            "X-Eaon-Sig": signature,
        ]
    }

    // MARK: - Lifecycle

    /// Activate (or recover) this device's free week. One network call, no
    /// account. Idempotent per device: the server rotates the credential
    /// in place on a re-mint and never extends the original week.
    func start() async {
        guard !isStarting else { return }
        isStarting = true
        lastError = nil
        defer { isStarting = false }

        var request = URLRequest(url: FreeWeekTrial.baseURL.appendingPathComponent("trial/start"))
        request.httpMethod = "POST"
        request.timeoutInterval = 20
        request.addValue("application/json", forHTTPHeaderField: "Content-Type")
        request.addValue("eaon-desktop/\(AppVersion.current)", forHTTPHeaderField: "X-Eaon-Client")
        request.httpBody = try? JSONSerialization.data(withJSONObject: [
            "device": Self.deviceHash,
            "platform": "macos",
            "app_version": AppVersion.current,
        ])

        do {
            let (data, response) = try await AppHTTP.session.data(for: request)
            let status = (response as? HTTPURLResponse)?.statusCode ?? 0
            let json = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any]

            guard status == 201, let payload = json?["data"] as? [String: Any],
                  let key = payload["key"] as? String,
                  let secret = payload["secret"] as? String,
                  let expiresRaw = payload["expires_at"] as? String,
                  let expires = ISO8601DateFormatter.trialParser.date(from: expiresRaw) else {
                let message = ((json?["error"] as? [String: Any])?["message"] as? String)
                    ?? "Couldn't start the free week — try again in a moment."
                lastError = message
                return
            }

            let minted = TrialCredential(key: key, secret: secret, expiresAt: expires)
            credential = minted
            TrialCredentialBox.set(minted)
            Self.persist(minted)
        } catch {
            lastError = "Couldn't reach eaon.dev — check your connection and try again."
        }
    }

    /// Refresh the usage/days figures for the settings card. Also how the
    /// app discovers a server-side revocation: an invalid/revoked answer
    /// clears the stored credential so the UI falls back honestly.
    func refreshStatus() async {
        guard let credential else { return }
        var request = URLRequest(url: FreeWeekTrial.baseURL.appendingPathComponent("trial/status"))
        request.timeoutInterval = 15
        request.addValue("Bearer \(credential.key)", forHTTPHeaderField: "Authorization")
        for (field, value) in Self.signingHeaders(secret: credential.secret, body: nil) {
            request.addValue(value, forHTTPHeaderField: field)
        }

        guard let (data, response) = try? await AppHTTP.session.data(for: request),
              let http = response as? HTTPURLResponse else { return }

        if http.statusCode == 200,
           let json = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any],
           let payload = json["data"] as? [String: Any] {
            usage = payload["usage"] as? Int
            totalRequests = payload["total_requests"] as? Int
            if let expiresRaw = payload["expires_at"] as? String,
               let expires = ISO8601DateFormatter.trialParser.date(from: expiresRaw),
               expires != credential.expiresAt {
                let updated = TrialCredential(key: credential.key, secret: credential.secret, expiresAt: expires)
                self.credential = updated
                TrialCredentialBox.set(updated)
                Self.persist(updated)
            }
            return
        }

        // Revoked or rotated away underneath us — drop the dead credential
        // so the UI offers the honest next step instead of failing quietly.
        if http.statusCode == 401 || http.statusCode == 403,
           let json = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any],
           let code = (json["error"] as? [String: Any])?["code"] as? String,
           code == "trial_revoked" || code == "trial_invalid" {
            clear()
        }
    }

    func clear() {
        credential = nil
        usage = nil
        totalRequests = nil
        TrialCredentialBox.set(nil)
        UserDefaults.standard.removeObject(forKey: Self.credentialKey)
    }

    // MARK: - Persistence

    private static func loadCredential() -> TrialCredential? {
        guard let data = UserDefaults.standard.data(forKey: credentialKey) else { return nil }
        return try? JSONDecoder.trialDecoder.decode(TrialCredential.self, from: data)
    }

    private static func persist(_ credential: TrialCredential) {
        if let data = try? JSONEncoder.trialEncoder.encode(credential) {
            UserDefaults.standard.set(data, forKey: credentialKey)
        }
    }
}

// MARK: - Eaon access resolution

/// The one choke point deciding how hosted-model requests authenticate:
/// the user's own key against the Aqua API when they have one, else the
/// free-week credential against Eaon's gateway. Every hosted call site
/// resolves through here so key-vs-trial can never disagree between the
/// URL a request goes to and the credential attached to it.
struct EaonAccess {
    let baseURL: URL
    let apiKey: String
    let isTrial: Bool

    var chatCompletionsURL: URL { baseURL.appendingPathComponent("chat/completions") }
    var modelsURL: URL { baseURL.appendingPathComponent("models") }

    /// A user-entered key always wins — for background/auxiliary features
    /// (memory extraction, backfill, the `/reasoning` panel) that aren't
    /// tied to a specific selected model's provider identity, and just want
    /// "whatever hosted access is available right now." The main chat send
    /// path does NOT use this for a trial-tagged selection — see `trial`
    /// below and `ChatViewModel.resolveRoutingForSelectedModel`. Nonisolated
    /// (reads the lock-box, not MainActor state) so streaming paths resolve
    /// freely.
    static var current: EaonAccess? {
        if let key = APIKeyStore.loadAPIKey(), !key.isEmpty {
            return EaonAccess(baseURL: EaonHostedAPI.baseURL, apiKey: key, isTrial: false)
        }
        if let credential = TrialCredentialBox.current, credential.expiresAt > Date() {
            return EaonAccess(baseURL: FreeWeekTrial.baseURL, apiKey: credential.key, isTrial: true)
        }
        return nil
    }

    /// Always the trial's own access when a valid credential exists —
    /// independent of whether a user key is ALSO saved, unlike `current`.
    /// This is what makes "Eaon Free Trial" a genuinely separate provider
    /// rather than a fallback a saved key silently shadows: picking a model
    /// from that group routes here explicitly, every time, regardless of
    /// what else is configured.
    static var trial: EaonAccess? {
        guard let credential = TrialCredentialBox.current, credential.expiresAt > Date() else { return nil }
        return EaonAccess(baseURL: FreeWeekTrial.baseURL, apiKey: credential.key, isTrial: true)
    }

    /// Attach authorization to a fully-built request. MUST be called after
    /// `httpBody` is set: trial signatures are computed over the exact
    /// body bytes. Safe for user-key requests too (plain bearer).
    ///
    /// Static + key-driven (rather than a method on `current`) so call
    /// sites that already carry an apiKey string through their plumbing —
    /// ChatViewModel's GenerationRouting — can authorize without
    /// re-resolving, keyed off the credential they actually routed with.
    static func authorize(_ request: inout URLRequest, apiKey: String) {
        request.setValue("Bearer \(apiKey)", forHTTPHeaderField: "Authorization")
        guard FreeWeekTrial.isTrialKey(apiKey),
              let credential = TrialCredentialBox.current,
              credential.key == apiKey else { return }
        for (field, value) in TrialStore.signingHeaders(secret: credential.secret, body: request.httpBody) {
            request.setValue(value, forHTTPHeaderField: field)
        }
    }

    /// The base URL requests carrying `apiKey` should target — the
    /// GenerationRouting counterpart of `authorize`.
    static func baseURL(forKey apiKey: String) -> URL {
        FreeWeekTrial.isTrialKey(apiKey) ? FreeWeekTrial.baseURL : EaonHostedAPI.baseURL
    }
}

// MARK: - Shared coders

extension ISO8601DateFormatter {
    /// Parses the gateway's ISO timestamps (with fractional seconds, as
    /// `new Date().toISOString()` emits).
    static let trialParser: ISO8601DateFormatter = {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return formatter
    }()
}

extension JSONDecoder {
    static let trialDecoder: JSONDecoder = {
        let decoder = JSONDecoder()
        decoder.dateDecodingStrategy = .iso8601
        return decoder
    }()
}

extension JSONEncoder {
    static let trialEncoder: JSONEncoder = {
        let encoder = JSONEncoder()
        encoder.dateEncodingStrategy = .iso8601
        return encoder
    }()
}
