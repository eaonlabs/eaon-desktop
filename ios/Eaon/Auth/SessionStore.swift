import Foundation
import Observation

/// Whether anyone has come in yet, and as whom.
///
/// There are three ways in: Apple, GitHub, or none of the above, for people
/// who just want to use Eaon on this iPhone. Nothing about an account leaves
/// the device: the identity is the Keychain's, and the chats are the app's.
@MainActor
@Observable
final class SessionStore {
    enum State: Equatable {
        case signedOut
        case guest
        case account(Account)
    }

    private(set) var state: State

    private let keychain: Keychain
    private let defaults: UserDefaults

    private static let accountKey = "session.account"
    private static let guestKey = "eaon.session.guest"
    private static let launchedKey = "eaon.session.launched"
    private static func profileKey(_ id: String) -> String { "session.apple-profile.\(id)" }

    init(keychain: Keychain = Keychain(), defaults: UserDefaults = .standard) {
        self.keychain = keychain
        self.defaults = defaults

        // The Keychain outlives the app. Without this, deleting Eaon and
        // installing it again would sign the old account straight back in.
        if !defaults.bool(forKey: Self.launchedKey) {
            keychain.deleteAll()
            defaults.removeObject(forKey: Self.guestKey)
            defaults.set(true, forKey: Self.launchedKey)
        }

        if let account = keychain.value(Account.self, for: Self.accountKey) {
            state = .account(account)
        } else if defaults.bool(forKey: Self.guestKey) {
            state = .guest
        } else {
            state = .signedOut
        }
    }

    var isEntered: Bool { state != .signedOut }

    var account: Account? {
        if case .account(let account) = state { return account }
        return nil
    }

    var isGuest: Bool { state == .guest }

    func signIn(_ account: Account) {
        var account = account
        if account.provider == .apple {
            // Apple only sends the name and email the first time. Keep them,
            // so signing in again after signing out still knows who you are.
            let key = Self.profileKey(account.id)
            if account.name != nil || account.email != nil {
                keychain.setValue(AppleProfile(name: account.name, email: account.email), for: key)
            } else if let kept = keychain.value(AppleProfile.self, for: key) {
                account.name = kept.name
                account.email = kept.email
            }
        }
        keychain.setValue(account, for: Self.accountKey)
        defaults.removeObject(forKey: Self.guestKey)
        state = .account(account)
    }

    func continueAsGuest() {
        keychain.delete(Self.accountKey)
        defaults.set(true, forKey: Self.guestKey)
        state = .guest
    }

    /// Back to the landing screen. Chats stay on this iPhone.
    func signOut() {
        keychain.delete(Self.accountKey)
        defaults.removeObject(forKey: Self.guestKey)
        state = .signedOut
    }

    /// Signs out and forgets everything this app kept in the Keychain.
    func eraseEverything() {
        keychain.deleteAll()
        defaults.removeObject(forKey: Self.guestKey)
        state = .signedOut
    }

    /// Apple lets a person revoke an app's access from their Apple Account
    /// settings. Checked at launch and when Apple says so.
    func validate(appleCredentialIsValid: (String) async -> Bool) async {
        guard case .account(let account) = state, account.provider == .apple else { return }
        if await appleCredentialIsValid(account.id) == false { signOut() }
    }

    private struct AppleProfile: Codable {
        var name: String?
        var email: String?
    }
}
