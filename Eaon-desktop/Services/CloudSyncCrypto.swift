import CommonCrypto
import CryptoKit
import Foundation

/// The end-to-end encryption layer for cloud sync.
///
/// Everything Eaon uploads is sealed here first, so the server stores
/// ciphertext and nothing else. That is the whole point of the feature
/// existing at all in a privacy-focused app: signing in proves *who you
/// are* to Appwrite, but it never gives Appwrite (or anyone holding its
/// API key, or anyone who breaches it) the ability to read a single
/// message.
///
/// KEY HIERARCHY — why there are two layers instead of just deriving a key
/// from the passphrase and encrypting with it:
///
///   passphrase ──PBKDF2──▶ KEK ──unwraps──▶ MK ──encrypts──▶ your chats
///   recovery code ──PBKDF2──▶ RKEK ──unwraps──▶ MK  (same MK, second wrapping)
///
/// The master key (MK) is 32 random bytes generated once, and it is what
/// actually encrypts content. The passphrase only ever encrypts *the MK*.
/// That buys two things a single-layer design can't have: changing the
/// passphrase re-wraps one 32-byte key instead of re-encrypting and
/// re-uploading every conversation, and a recovery code can be a second,
/// independent wrapping of the same MK — so losing the passphrase doesn't
/// have to mean losing the data.
///
/// PRIMITIVES — AES-256-GCM for content (authenticated, so a tampered blob
/// fails to open rather than decrypting to garbage) and PBKDF2-HMAC-SHA256
/// at 600,000 iterations for the passphrase (OWASP's 2023 floor for this
/// KDF). Argon2id would be the better KDF, but it ships in neither CryptoKit
/// nor the Rust core's existing dependency set, and a hand-rolled or
/// third-party implementation on the path that guards every user's chat
/// history is a worse trade than a well-parameterised PBKDF2. The `kdf`
/// field is persisted with every wrapped key so this can be migrated later
/// without stranding existing accounts.
enum CloudSyncCrypto {
    /// Bumped only for a change that makes old blobs unreadable — the
    /// stored value is what tells a future version how to interpret one.
    static let currentVersion = 1
    static let kdfIdentifier = "pbkdf2-hmac-sha256"
    /// OWASP's 2023 minimum for PBKDF2-HMAC-SHA256. Measured at ~0.4s on an
    /// M-series Mac, which is the right order of magnitude: slow enough to
    /// make offline guessing expensive, fast enough that unlocking doesn't
    /// feel broken.
    static let defaultIterations = 600_000

    enum CryptoError: LocalizedError {
        case wrongPassphrase
        case malformedPayload
        case keyDerivationFailed

        var errorDescription: String? {
            switch self {
            case .wrongPassphrase:
                return "That passphrase doesn't unlock your sync key. Check it and try again — or use your recovery code."
            case .malformedPayload:
                return "This synced item couldn't be read. It may have been written by a newer version of Eaon."
            case .keyDerivationFailed:
                return "Couldn't derive the encryption key on this device."
            }
        }
    }

    // MARK: - Master key

    /// A fresh 256-bit master key. Generated once per account, on the first
    /// device to turn sync on, and thereafter only ever transported wrapped.
    static func generateMasterKey() -> SymmetricKey {
        SymmetricKey(size: .bits256)
    }

    /// The bundle stored in the `sync_keys` table — everything needed to get
    /// the MK back from a passphrase, and nothing that helps an attacker who
    /// doesn't have one. Salts are public by design; that's what they're for.
    struct WrappedKeyBundle: Equatable {
        var wrappedKey: String
        var salt: String
        var iterations: Int
        var recoveryWrapped: String?
        var recoverySalt: String?
        var kdf: String
        var version: Int
    }

    /// Seals a new master key under both a passphrase and a freshly minted
    /// recovery code, and hands back the code so it can be shown to the user
    /// exactly once. Two independent salts on purpose: reusing one would let
    /// a single PBKDF2 pass be tested against both wrappings at once.
    static func wrapNewMasterKey(
        _ masterKey: SymmetricKey,
        passphrase: String,
        iterations: Int = defaultIterations
    ) throws -> (bundle: WrappedKeyBundle, recoveryCode: String) {
        let salt = randomBytes(16)
        let recoverySalt = randomBytes(16)
        let recoveryCode = generateRecoveryCode()

        let kek = try deriveKey(secret: passphrase, salt: salt, iterations: iterations)
        let rkek = try deriveKey(secret: recoveryCode, salt: recoverySalt, iterations: iterations)

        let keyBytes = masterKey.withUnsafeBytes { Data($0) }
        let bundle = WrappedKeyBundle(
            wrappedKey: try seal(keyBytes, with: kek).base64EncodedString(),
            salt: salt.base64EncodedString(),
            iterations: iterations,
            recoveryWrapped: try seal(keyBytes, with: rkek).base64EncodedString(),
            recoverySalt: recoverySalt.base64EncodedString(),
            kdf: kdfIdentifier,
            version: currentVersion
        )
        return (bundle, recoveryCode)
    }

    /// Recovers the master key from a passphrase. A wrong passphrase fails
    /// here as a GCM authentication failure, not as garbage that decrypts to
    /// nonsense downstream — which is exactly why the MK is sealed rather
    /// than merely XORed or stored raw.
    static func unwrapMasterKey(passphrase: String, bundle: WrappedKeyBundle) throws -> SymmetricKey {
        guard let salt = Data(base64Encoded: bundle.salt),
              let wrapped = Data(base64Encoded: bundle.wrappedKey) else {
            throw CryptoError.malformedPayload
        }
        let kek = try deriveKey(secret: passphrase, salt: salt, iterations: bundle.iterations)
        guard let raw = try? open(wrapped, with: kek) else { throw CryptoError.wrongPassphrase }
        return SymmetricKey(data: raw)
    }

    /// The same recovery, through the second wrapping. Separate entry point
    /// (rather than a flag) so a caller can't accidentally feed a passphrase
    /// to the recovery path or vice versa.
    static func unwrapMasterKey(recoveryCode: String, bundle: WrappedKeyBundle) throws -> SymmetricKey {
        guard let saltText = bundle.recoverySalt, let wrappedText = bundle.recoveryWrapped,
              let salt = Data(base64Encoded: saltText),
              let wrapped = Data(base64Encoded: wrappedText) else {
            throw CryptoError.malformedPayload
        }
        let normalized = normalizeRecoveryCode(recoveryCode)
        let rkek = try deriveKey(secret: normalized, salt: salt, iterations: bundle.iterations)
        guard let raw = try? open(wrapped, with: rkek) else { throw CryptoError.wrongPassphrase }
        return SymmetricKey(data: raw)
    }

    /// Re-wraps an already-unlocked master key under a new passphrase. The
    /// recovery wrapping is carried over untouched — the MK hasn't changed,
    /// so the existing recovery code still opens it, and invalidating a code
    /// the user has written down somewhere would be a nasty surprise.
    static func rewrap(
        masterKey: SymmetricKey,
        newPassphrase: String,
        keeping bundle: WrappedKeyBundle,
        iterations: Int = defaultIterations
    ) throws -> WrappedKeyBundle {
        let salt = randomBytes(16)
        let kek = try deriveKey(secret: newPassphrase, salt: salt, iterations: iterations)
        let keyBytes = masterKey.withUnsafeBytes { Data($0) }
        var updated = bundle
        updated.wrappedKey = try seal(keyBytes, with: kek).base64EncodedString()
        updated.salt = salt.base64EncodedString()
        updated.iterations = iterations
        updated.kdf = kdfIdentifier
        updated.version = currentVersion
        return updated
    }

    // MARK: - Content

    /// Seals arbitrary bytes (a serialized conversation, a memory list, an
    /// attachment's contents) under the master key. Output is
    /// `nonce || ciphertext || tag`, base64'd for the text column.
    static func encrypt(_ plaintext: Data, with masterKey: SymmetricKey) throws -> String {
        try seal(plaintext, with: masterKey).base64EncodedString()
    }

    static func decrypt(_ base64: String, with masterKey: SymmetricKey) throws -> Data {
        guard let combined = Data(base64Encoded: base64) else { throw CryptoError.malformedPayload }
        return try open(combined, with: masterKey)
    }

    /// Raw-bytes variant for attachments, which go to Storage as files
    /// rather than into a text column — base64'ing a 40MB image to put it in
    /// a database row would be both slower and 33% larger for no benefit.
    static func encryptBytes(_ plaintext: Data, with masterKey: SymmetricKey) throws -> Data {
        try seal(plaintext, with: masterKey)
    }

    static func decryptBytes(_ combined: Data, with masterKey: SymmetricKey) throws -> Data {
        try open(combined, with: masterKey)
    }

    // MARK: - Recovery codes

    /// 20 chars from an unambiguous alphabet (no O/0, I/1, U — misread or
    /// mistyped characters are the entire failure mode for something a user
    /// writes on paper), grouped for legibility. ~103 bits of entropy.
    static func generateRecoveryCode() -> String {
        let alphabet = Array("ABCDEFGHJKLMNPQRSTVWXYZ23456789")
        var out: [Character] = []
        for index in 0..<20 {
            if index > 0, index % 5 == 0 { out.append("-") }
            out.append(alphabet[Int.random(in: 0..<alphabet.count)])
        }
        return String(out)
    }

    /// Users retype these from paper, so accept the shapes they'll actually
    /// produce: lowercase, missing dashes, stray spaces.
    static func normalizeRecoveryCode(_ raw: String) -> String {
        let kept = raw.uppercased().filter { $0.isLetter || $0.isNumber }
        var out: [Character] = []
        for (index, character) in kept.enumerated() {
            if index > 0, index % 5 == 0 { out.append("-") }
            out.append(character)
        }
        return String(out)
    }

    // MARK: - Primitives

    private static func seal(_ plaintext: Data, with key: SymmetricKey) throws -> Data {
        let box = try AES.GCM.seal(plaintext, using: key)
        guard let combined = box.combined else { throw CryptoError.malformedPayload }
        return combined
    }

    private static func open(_ combined: Data, with key: SymmetricKey) throws -> Data {
        let box = try AES.GCM.SealedBox(combined: combined)
        return try AES.GCM.open(box, using: key)
    }

    static func randomBytes(_ count: Int) -> Data {
        var bytes = [UInt8](repeating: 0, count: count)
        _ = SecRandomCopyBytes(kSecRandomDefault, count, &bytes)
        return Data(bytes)
    }

    /// PBKDF2-HMAC-SHA256 via CommonCrypto — CryptoKit has no password-based
    /// KDF at all, and HKDF is the wrong tool here (it's fast by design,
    /// which is precisely what a passphrase KDF must not be).
    static func deriveKey(secret: String, salt: Data, iterations: Int) throws -> SymmetricKey {
        let secretBytes = Array(secret.utf8)
        var derived = [UInt8](repeating: 0, count: 32)
        let status = salt.withUnsafeBytes { saltBuffer -> Int32 in
            CCKeyDerivationPBKDF(
                CCPBKDFAlgorithm(kCCPBKDF2),
                secretBytes, secretBytes.count,
                saltBuffer.bindMemory(to: UInt8.self).baseAddress, salt.count,
                CCPseudoRandomAlgorithm(kCCPRFHmacAlgSHA256),
                UInt32(iterations),
                &derived, derived.count
            )
        }
        guard status == kCCSuccess else { throw CryptoError.keyDerivationFailed }
        return SymmetricKey(data: Data(derived))
    }
}
