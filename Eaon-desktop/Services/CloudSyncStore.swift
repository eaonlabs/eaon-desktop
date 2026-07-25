import CryptoKit
import Foundation
import Observation

/// The master switch for cloud sync, and the deliberate friction in front of
/// turning it on.
///
/// Off by default, and — unlike every other toggle in this app — it cannot
/// be flipped on by a single click. Enabling it is the one setting that
/// changes *where the user's data physically lives*: until it's on, a
/// conversation exists only on this Mac and nowhere else, and that is the
/// promise the product is built around. A stray click on a switch is not
/// informed consent to undo it, so `requestEnable()` opens a confirmation
/// the user has to type an exact phrase into. Turning it OFF has no such
/// gate: friction belongs in front of the choice that's hard to take back,
/// never in front of the one that restores the safer state.
///
/// Note what this switch does and doesn't control. Content is end-to-end
/// encrypted regardless (see `CloudSyncCrypto`) — the server never holds a
/// readable message either way. What flipping this on actually decides is
/// whether the user's encrypted data leaves the machine at all, which is a
/// separate question from whether anyone could read it if it did, and worth
/// asking separately.
@MainActor
@Observable
final class CloudSyncStore {
    static let shared = CloudSyncStore()

    /// The phrase the user must type to enable sync. Deliberately a full
    /// sentence rather than a single word: it has to be long enough that
    /// typing it can't be muscle memory or a mis-swipe, and it names the
    /// thing being switched on so nobody can type it without having read it.
    static let confirmationPhrase = "turn on cloud sync"

    private static let enabledKey = "cloud_sync_enabled_v1"

    /// The user's saved *preference*, which is not the same thing as sync
    /// being on. Never set directly from the UI — the toggle calls
    /// `requestEnable()` or `disable()`.
    private var enabledPreference: Bool {
        didSet {
            guard enabledPreference != oldValue else { return }
            UserDefaults.standard.set(enabledPreference, forKey: Self.enabledKey)
        }
    }

    /// Whether sync is actually on, which requires BOTH the user's
    /// preference and a signed-in account.
    ///
    /// Computed rather than stored, because the two can otherwise drift into
    /// a state that shouldn't exist: the preference persists in
    /// UserDefaults, a session does not have to (signing out, a revoked
    /// session, a 401 clearing it), so a saved `true` outlived its account
    /// and the switch rendered ON while the card underneath it said "sign in
    /// above first". Worse than merely confusing — it told the user their
    /// data was syncing when there was no account for it to sync to.
    ///
    /// Deriving it means that display can't lie, and no future call site can
    /// reintroduce the drift by forgetting to check.
    var isEnabled: Bool {
        enabledPreference && EaonCloudAccount.shared.isSignedIn
    }

    /// Non-nil exactly while the type-to-confirm sheet should be showing.
    var isConfirmingEnable = false

    /// What the user has typed into the confirmation field so far. Lives
    /// here rather than in the view so dismissing the sheet any way at all
    /// (Escape, the backdrop, Cancel) clears it — a half-typed phrase left
    /// behind would mean the next attempt starts closer to enabled than the
    /// user actually intended.
    var confirmationInput = ""

    private init() {
        enabledPreference = UserDefaults.standard.bool(forKey: Self.enabledKey)
    }

    /// Whether what's typed so far matches the required phrase. Case and
    /// surrounding whitespace are forgiven — the gate exists to prove
    /// deliberate intent, not to test typing accuracy, and a user who typed
    /// "Turn On Cloud Sync" has unambiguously demonstrated the intent.
    /// Internal spacing is normalized for the same reason.
    var confirmationMatches: Bool {
        Self.normalize(confirmationInput) == Self.confirmationPhrase
    }

    static func normalize(_ raw: String) -> String {
        raw.lowercased()
            .split(whereSeparator: \.isWhitespace)
            .joined(separator: " ")
    }

    /// The toggle's "on" path. Opens the confirmation rather than enabling,
    /// so sync stays off until the phrase is actually typed.
    ///
    /// The signed-in check is here, not only on the view's `.disabled()`: a
    /// disabled control is a courtesy, not a guarantee, and this is the rule
    /// that must hold no matter which surface calls it.
    func requestEnable() {
        guard !isEnabled, EaonCloudAccount.shared.isSignedIn else { return }
        confirmationInput = ""
        isConfirmingEnable = true
    }

    /// Called by the sheet's confirm button. Re-checks both the phrase and
    /// the account here rather than trusting the view to have disabled its
    /// own button — the authority for "may this turn on" belongs in one
    /// place, and a sign-out while the sheet is open must not slip through.
    func confirmEnable() {
        guard confirmationMatches, EaonCloudAccount.shared.isSignedIn else { return }
        enabledPreference = true
        isConfirmingEnable = false
        confirmationInput = ""
    }

    func cancelEnable() {
        isConfirmingEnable = false
        confirmationInput = ""
    }

    /// Turning sync off is immediate and unguarded — see the type note above.
    /// This stops anything further leaving the machine; it deliberately does
    /// NOT decide what happens to data already uploaded, which is its own
    /// choice the user gets to make separately (see `CloudSyncSettingsView`).
    func disable() {
        enabledPreference = false
        isConfirmingEnable = false
        confirmationInput = ""
        // The unlocked key is dropped the instant sync is off. Keeping it
        // resident would mean the app still holds the means to read cloud
        // data after the user has said stop.
        lockVault()
        CloudSyncEngine.shared.resetLocalLedger()
    }

    // MARK: - The unlocked key

    /// The master key for this session, held ONLY in memory. It is never
    /// written to disk, UserDefaults, or the Keychain — the passphrase that
    /// produces it is the user's alone, and a copy at rest is a copy that
    /// can be stolen. Quitting Eaon locks the vault by construction.
    private(set) var masterKey: SymmetricKey?

    var isUnlocked: Bool { masterKey != nil }

    /// Set when the account has never had sync set up, so the UI asks the
    /// user to *create* a passphrase (and shows them a recovery code) rather
    /// than asking them to enter one that doesn't exist yet.
    var isPreparingVault = false
    var vaultError: String?
    /// Shown exactly once, immediately after setup. Never stored.
    var freshRecoveryCode: String?

    func unlock(with key: SymmetricKey) {
        masterKey = key
        vaultError = nil
    }

    func lockVault() {
        masterKey = nil
        freshRecoveryCode = nil
    }
}
