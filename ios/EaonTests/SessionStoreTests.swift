import XCTest
@testable import Eaon

@MainActor
final class SessionStoreTests: XCTestCase {
    private var keychain = Keychain(service: "dev.eaon.ios.tests.\(UUID().uuidString)")
    private var defaults = UserDefaults(suiteName: "eaon.tests.\(UUID().uuidString)")!

    override func tearDown() {
        keychain.deleteAll()
    }

    private func store() -> SessionStore { SessionStore(keychain: keychain, defaults: defaults) }

    private let github = Account(provider: .github, id: "7", name: "Ada Lovelace", email: nil, handle: "ada", avatarURL: nil)

    func testStartsSignedOut() {
        let store = store()
        XCTAssertEqual(store.state, .signedOut)
        XCTAssertFalse(store.isEntered)
    }

    func testGuestSurvivesARelaunch() {
        store().continueAsGuest()
        let again = store()
        XCTAssertEqual(again.state, .guest)
        XCTAssertTrue(again.isEntered)
        XCTAssertNil(again.account)
    }

    func testAnAccountSurvivesARelaunch() {
        store().signIn(github)
        let again = store()
        XCTAssertEqual(again.account, github)
        XCTAssertFalse(again.isGuest)
    }

    func testSigningInReplacesGuest() {
        let store = store()
        store.continueAsGuest()
        store.signIn(github)
        XCTAssertEqual(store.account, github)
        // And a relaunch doesn't come back as a guest.
        XCTAssertEqual(self.store().account, github)
    }

    func testSignOutGoesBackToTheStart() {
        let store = store()
        store.signIn(github)
        store.signOut()
        XCTAssertEqual(store.state, .signedOut)
        XCTAssertEqual(self.store().state, .signedOut)
    }

    func testAFreshInstallDoesNotInheritAnOldKeychain() {
        store().signIn(github)
        // Deleting the app clears UserDefaults but not the Keychain.
        defaults = UserDefaults(suiteName: "eaon.tests.\(UUID().uuidString)")!
        XCTAssertEqual(store().state, .signedOut)
    }

    func testAppleKeepsTheNameItOnlySendsOnce() {
        let store = store()
        store.signIn(Account(provider: .apple, id: "001.abc", name: "Grace Hopper", email: "grace@example.com", handle: nil, avatarURL: nil))
        store.signOut()
        // The second time, Apple sends neither.
        store.signIn(Account(provider: .apple, id: "001.abc", name: nil, email: nil, handle: nil, avatarURL: nil))
        XCTAssertEqual(store.account?.name, "Grace Hopper")
        XCTAssertEqual(store.account?.email, "grace@example.com")
    }

    func testARevokedAppleCredentialSignsOut() async {
        let store = store()
        store.signIn(Account(provider: .apple, id: "001.abc", name: "G", email: nil, handle: nil, avatarURL: nil))
        await store.validate(appleCredentialIsValid: { _ in true })
        XCTAssertNotNil(store.account)
        await store.validate(appleCredentialIsValid: { _ in false })
        XCTAssertEqual(store.state, .signedOut)
    }

    func testGitHubAccountsAreNeverCheckedWithApple() async {
        let store = store()
        store.signIn(github)
        await store.validate(appleCredentialIsValid: { _ in false })
        XCTAssertEqual(store.account, github)
    }

    func testEraseEverythingForgetsTheAccount() {
        let store = store()
        store.signIn(github)
        store.eraseEverything()
        XCTAssertEqual(store.state, .signedOut)
        XCTAssertNil(keychain.read("session.account"))
    }

    func testAccountWordsForTheScreens() {
        XCTAssertEqual(github.firstName, "Ada")
        XCTAssertEqual(github.initials, "AL")
        XCTAssertEqual(github.detail, "@ada")
        let relay = Account(provider: .apple, id: "1", name: nil, email: "x@privaterelay.appleid.com", handle: nil, avatarURL: nil)
        XCTAssertEqual(relay.detail, "Email hidden by Apple")
        XCTAssertEqual(relay.initials, "E")
        XCTAssertEqual(relay.displayName, "Apple account")
    }
}
