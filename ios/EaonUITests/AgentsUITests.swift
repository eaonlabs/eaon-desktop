import XCTest

/// The Agents tab: the list, an agent's page, the questions agents ask, and spinning up a new one.
/// Debug builds take launch arguments to put agents on screen (see DebugLaunch.swift): `-demoAgents` gives the
/// phone three, `-demoMac` pretends a Mac is connected with two more.
@MainActor
final class AgentsUITests: XCTestCase {
    override func setUp() {
        continueAfterFailure = false
    }

    private func launch(_ extra: [String]) -> XCUIApplication {
        let app = XCUIApplication()
        app.launchArguments = ["-resetAll", "-guest", "-noNotificationPrompt"] + extra
        app.launch()
        return app
    }

    func testTheListShowsAgentsOnThePhoneAndOnTheMac() {
        let app = launch(["-demoAgents", "-demoMac", "-tab", "agents"])
        XCTAssertTrue(app.staticTexts["Scout"].waitForExistence(timeout: 10))
        for name in ["Scout", "Remy", "Morning", "Nova", "Atlas"] { XCTAssertTrue(app.staticTexts[name].exists, name) }
        XCTAssertTrue(app.staticTexts["On this iPhone"].exists)
        XCTAssertTrue(app.staticTexts["Alex's MacBook Pro"].exists)
        XCTAssertTrue(app.staticTexts["Live"].exists)
        // Two agents are waiting on an answer.
        XCTAssertTrue(app.staticTexts["May I add a reminder?"].exists)
        XCTAssertTrue(app.staticTexts["Should the report include refunds?"].exists)
    }

    func testAnApprovalCanBeAllowedOrDeclinedFromAnAgentsPage() {
        let app = launch(["-demoAgents", "-tab", "agents"])
        app.staticTexts["Remy"].tap()
        XCTAssertTrue(app.staticTexts["May I add a reminder?"].waitForExistence(timeout: 8))
        XCTAssertTrue(app.staticTexts["Add a reminder: Call Mum · 6:00 PM"].exists)
        XCTAssertTrue(app.buttons["Allow"].exists)
        app.buttons["Not now"].tap()
        // The question is gone once it's answered.
        XCTAssertTrue(app.staticTexts["May I add a reminder?"].waitForNonExistence(timeout: 5))
    }

    func testAMacAgentsQuestionHasQuickAnswers() {
        let app = launch(["-demoAgents", "-demoMac", "-openAgent", "Atlas"])
        XCTAssertTrue(app.staticTexts["Should the report include refunds?"].waitForExistence(timeout: 10))
        XCTAssertTrue(app.buttons["Include them"].exists)
        XCTAssertTrue(app.buttons["Leave them out"].exists)
        XCTAssertTrue(app.textFields["Or write an answer"].exists)
        XCTAssertTrue(app.staticTexts["Your Mac"].exists, "it says where it runs")
    }

    func testAnAgentsPageShowsItsGoalAndSteps() {
        let app = launch(["-demoAgents", "-openAgent", "Scout"])
        XCTAssertTrue(app.staticTexts["Goal · working on it"].waitForExistence(timeout: 10))
        XCTAssertTrue(app.staticTexts["Find the three biggest changes in Swift 6.2 concurrency"].exists)
        XCTAssertTrue(app.buttons["Pause"].exists)
        XCTAssertTrue(app.staticTexts["Read a web page"].exists)
        XCTAssertTrue(app.buttons["Stop"].exists, "it's working, so the composer offers Stop")
    }

    func testSpinningUpAnAgentOnThePhone() {
        let app = launch(["-tab", "agents"])
        XCTAssertTrue(app.buttons["Spin up an agent"].waitForExistence(timeout: 10))
        app.buttons["Spin up an agent"].tap()
        XCTAssertTrue(app.staticTexts["New agent"].waitForExistence(timeout: 8))
        // Not yet: it needs a name and a purpose.
        XCTAssertFalse(app.buttons["Create"].isEnabled)
        app.buttons["Researcher"].tap()
        let create = app.buttons["Create"]
        XCTAssertTrue(create.isEnabled, "a role fills in both")
        create.tap()
        // It opens on the new agent's page.
        XCTAssertTrue(app.staticTexts["Nothing yet"].waitForExistence(timeout: 10))
        XCTAssertTrue(app.staticTexts["This iPhone"].exists)
        app.navigationBars.buttons.firstMatch.tap()
        XCTAssertTrue(app.staticTexts["Researcher"].waitForExistence(timeout: 8))
    }

    func testConnectingToAMacIsOfferedFromTheEmptyState() {
        let app = launch(["-tab", "agents"])
        XCTAssertTrue(app.buttons["Control agents on your Mac"].waitForExistence(timeout: 10))
        app.buttons["Control agents on your Mac"].tap()
        XCTAssertTrue(app.staticTexts["Use Eaon on your Mac"].waitForExistence(timeout: 8))
        XCTAssertTrue(app.textFields["Address, like 192.168.1.20"].exists)
    }
}
