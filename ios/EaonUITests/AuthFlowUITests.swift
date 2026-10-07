import XCTest

/// The ways in, and the screens behind them, driven the way a person would.
///
/// Debug builds take launch arguments (see DebugLaunch.swift) to start in a
/// state: `-resetAll` forgets everything, `-guest` comes in as a guest,
/// `-demoAccount github` as a made-up person, `-tab settings` starts on a tab.
@MainActor
final class AuthFlowUITests: XCTestCase {
    override func setUp() {
        continueAfterFailure = false
    }

    private func launch(_ arguments: [String]) -> XCUIApplication {
        let app = XCUIApplication()
        app.launchArguments = arguments
        app.launch()
        return app
    }

    private func point(_ app: XCUIApplication, _ x: CGFloat, _ y: CGFloat) -> XCUICoordinate {
        app.windows.firstMatch.coordinate(withNormalizedOffset: CGVector(dx: x, dy: y))
    }

    /// Slides the glass up to the welcome, where the buttons are.
    private func enterWelcome(_ app: XCUIApplication) {
        point(app, 0.62, 0.8).press(forDuration: 0.4, thenDragTo: point(app, 0.55, 0.36), withVelocity: 260, thenHoldForDuration: 1)
        XCTAssertTrue(app.buttons["Continue without signing up"].waitForExistence(timeout: 8))
        // They arrive one after another.
        RunLoop.current.run(until: Date().addingTimeInterval(1.5))
    }

    // MARK: The landing's three ways in

    func testTheWelcomeOffersAppleGitHubAndNoAccount() {
        let app = launch(["-resetAll"])
        enterWelcome(app)
        XCTAssertTrue(app.buttons["Continue with Apple"].exists)
        XCTAssertTrue(app.buttons["Continue with GitHub"].exists)
        XCTAssertTrue(app.buttons["Continue without signing up"].exists)
    }

    func testContinuingWithoutSigningUpOpensTheApp() {
        let app = launch(["-resetAll"])
        enterWelcome(app)
        app.buttons["Continue without signing up"].tap()
        XCTAssertTrue(app.tabBars.buttons["Chat"].waitForExistence(timeout: 10))
        XCTAssertTrue(app.tabBars.buttons["Agents"].exists)
        XCTAssertTrue(app.tabBars.buttons["Settings"].exists)
        XCTAssertTrue(app.staticTexts["What can I help with?"].exists)
    }

    func testGuestComesBackAsAGuestAfterRelaunch() {
        let first = launch(["-resetAll"])
        enterWelcome(first)
        first.buttons["Continue without signing up"].tap()
        XCTAssertTrue(first.tabBars.buttons["Chat"].waitForExistence(timeout: 10))
        first.terminate()

        let second = launch([])
        XCTAssertTrue(second.tabBars.buttons["Chat"].waitForExistence(timeout: 10), "no landing the second time")
    }

    func testGitHubWithoutAClientIDSaysWhatIsMissing() {
        let app = launch(["-resetAll", "-githubClientID", "none"])
        enterWelcome(app)
        app.buttons["Continue with GitHub"].tap()
        XCTAssertTrue(app.staticTexts["GitHub sign-in isn't set up in this build."].waitForExistence(timeout: 5))
        XCTAssertTrue(app.buttons["Details"].exists, "the setup steps fold away under Details")
        app.buttons["Details"].tap()
        XCTAssertTrue(app.staticTexts.containing(NSPredicate(format: "label CONTAINS 'EAON_GITHUB_CLIENT_ID'")).firstMatch.waitForExistence(timeout: 3))
        // The other ways in still work.
        XCTAssertTrue(app.buttons["Continue without signing up"].isHittable)
    }

    func testTheGitHubCodeSheetShowsTheCodeAndCancels() {
        let app = launch(["-resetAll", "-sheet", "github"])
        XCTAssertTrue(app.staticTexts["Enter this code on GitHub"].waitForExistence(timeout: 8))
        XCTAssertTrue(app.buttons["Copy code and open GitHub"].exists)
        app.buttons["Cancel"].tap()
        XCTAssertTrue(app.staticTexts["Enter this code on GitHub"].waitForNonExistence(timeout: 5))
    }

    // MARK: Settings

    func testAGuestCanSignInFromSettings() {
        let app = launch(["-resetAll", "-guest", "-tab", "settings"])
        XCTAssertTrue(app.staticTexts["Guest"].waitForExistence(timeout: 8))
        XCTAssertTrue(app.buttons["Apple"].exists)
        XCTAssertTrue(app.buttons["GitHub"].exists)
        // No account, so nothing to sign out of.
        XCTAssertFalse(app.buttons["Sign out"].exists)
    }

    func testSigningOutReturnsToTheWelcome() {
        let app = launch(["-resetAll", "-demoAccount", "github", "-tab", "settings"])
        XCTAssertTrue(app.staticTexts["Alex Rivera"].waitForExistence(timeout: 8))
        XCTAssertTrue(app.staticTexts["@alexrivera"].exists)

        let signOut = app.buttons["Sign out"]
        for _ in 0..<6 where !signOut.isHittable { app.swipeUp() }
        signOut.tap()
        XCTAssertTrue(app.staticTexts["Your chats stay on this iPhone."].waitForExistence(timeout: 5))
        // The dialog's button and the row behind it have the same name; the dialog's is the one that can be tapped.
        let confirm = app.buttons.matching(identifier: "Sign out").allElementsBoundByIndex.first(where: { $0.isHittable })
        XCTAssertNotNil(confirm, "the dialog's Sign out button")
        confirm?.tap()

        XCTAssertTrue(app.otherElements["landing.probe"].waitForExistence(timeout: 10), "back at the landing screen")
    }

    // MARK: The Mac

    func testAnUnreachableMacIsReportedAndNothingIsKept() {
        let app = launch(["-resetAll", "-guest", "-tab", "agents", "-sheet", "connectMac"])
        let address = app.textFields["Address, like 192.168.1.20"]
        XCTAssertTrue(address.waitForExistence(timeout: 8))
        XCTAssertFalse(app.buttons["Connect"].isEnabled, "needs an address first")
        address.tap()
        // Port 9 (discard) on this machine refuses at once.
        address.typeText("127.0.0.1:9")
        app.buttons["Connect"].tap()
        XCTAssertTrue(app.staticTexts["Couldn't connect"].waitForExistence(timeout: 15))
        XCTAssertTrue(app.staticTexts["Use Eaon on your Mac"].exists, "still not connected")
    }
}
