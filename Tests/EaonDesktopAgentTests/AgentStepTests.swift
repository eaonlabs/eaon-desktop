import XCTest
@testable import Eaon_desktop

/// `AgentStep` parses the status lines Eaon already publishes into typed
/// rows. Every string below is one the app actually emits — taken from
/// `ChatViewModel` and `DesktopControl` — because the parser's whole job is
/// coping with those specific shapes, and a test built from invented inputs
/// would pass while the real ones regressed.
final class AgentStepTests: XCTestCase {

    func testClassifiesEachKindOfWork() {
        XCTAssertEqual(AgentStep(title: "Searching the web for \"x\"…").kind, .searching)
        XCTAssertEqual(AgentStep(title: "Running write_file…").kind, .writing)
        XCTAssertEqual(AgentStep(title: "Running edit_file…").kind, .writing)
        XCTAssertEqual(AgentStep(title: "Running a command").kind, .running)
        XCTAssertEqual(AgentStep(title: "Reading files").kind, .reading)
        XCTAssertEqual(AgentStep(title: "Connecting…").kind, .thinking)
    }

    /// Regression: `browsing` was matched on the literal "browser", so the
    /// present participle — which is what a status line actually uses — fell
    /// through to the generic icon.
    func testBrowsingIsMatchedOnTheParticipleNotJustTheNoun() {
        XCTAssertEqual(AgentStep(title: "Browsing example.com").kind, .browsing)
        XCTAssertEqual(AgentStep(title: "Running browser_read…").kind, .browsing)
        XCTAssertEqual(AgentStep(title: "Opening url").kind, .browsing)
    }

    func testTrailingEllipsisIsStripped() {
        // The row's own dimming says it's in progress; the dots are noise,
        // and they'd also make a finished step read as still running.
        XCTAssertEqual(AgentStep(title: "Running a command…").title, "Running a command")
        XCTAssertFalse(AgentStep(title: "Connecting…").title.contains("…"))
    }

    func testQuotedFragmentBecomesAChipAndLeavesTheTitle() {
        let step = AgentStep(title: "Searching the web for \"swift concurrency\"…")
        XCTAssertEqual(step.title, "Searching the web")
        XCTAssertEqual(step.chips, ["swift concurrency"])
    }

    func testBareDomainsBecomeChips() {
        let step = AgentStep(title: "Browsing example.com and docs.swift.org")
        XCTAssertEqual(step.chips, ["example.com", "docs.swift.org"])
    }

    /// A shell path is full of dots but is not a list of domains, and
    /// chipping its fragments would be worse than showing nothing.
    func testFilePathsAreNotMistakenForDomains() {
        let step = AgentStep(title: "Running /Users/me/project/build.sh…")
        XCTAssertTrue(step.chips.isEmpty, "got \(step.chips)")
        XCTAssertEqual(step.kind, .running)
    }

    func testChipsAreCappedSoOneStepCannotFloodTheRow() {
        let step = AgentStep(title: "a.com b.com c.com d.com e.com")
        XCTAssertLessThanOrEqual(step.chips.count, 3)
    }

    func testStepsStartRunning() {
        XCTAssertEqual(AgentStep(title: "Anything").status, .running)
    }
}

/// The reasoning trace is one undivided blob; these cover the split that
/// turns it into dot-mode steps.
final class ReasoningStepsTests: XCTestCase {

    func testParagraphsBecomeSeparateSteps() {
        let text = "First thought here.\n\nSecond thought here.\n\nThird one."
        let steps = AgentStep.reasoningSteps(from: text, isInProgress: false)
        XCTAssertEqual(steps.count, 3)
        XCTAssertTrue(steps.allSatisfy { $0.status == .done })
    }

    /// Degrades to exactly the old behaviour rather than inventing breaks.
    func testProseWithNoBlankLinesStaysOneStep() {
        let steps = AgentStep.reasoningSteps(from: "Just one continuous thought.", isInProgress: false)
        XCTAssertEqual(steps.count, 1)
        XCTAssertNil(steps[0].detail)
    }

    func testOnlyTheLastStepRunsAndOnlyWhileOpen() {
        let text = "One.\n\nTwo.\n\nThree."
        let live = AgentStep.reasoningSteps(from: text, isInProgress: true)
        XCTAssertEqual(live.last?.status, .running)
        XCTAssertEqual(live.first?.status, .done)

        let finished = AgentStep.reasoningSteps(from: text, isInProgress: false)
        XCTAssertFalse(finished.contains { $0.status == .running })
    }

    func testLongParagraphSplitsIntoLabelAndDescription() {
        let text = "Checking the schema first. All 47 columns need to match their expected types, and nullability constraints on the required fields must hold before anything downstream can run."
        let steps = AgentStep.reasoningSteps(from: text, isInProgress: false)
        XCTAssertEqual(steps.count, 1)
        XCTAssertEqual(steps[0].title, "Checking the schema first")
        XCTAssertNotNil(steps[0].detail)
        XCTAssertTrue(steps[0].detail!.hasPrefix("All 47 columns"))
    }

    /// A short paragraph is readable as-is; splitting it would leave a
    /// description with nothing in it.
    func testShortParagraphIsNotSplit() {
        let steps = AgentStep.reasoningSteps(from: "Short. Fine.", isInProgress: false)
        XCTAssertNil(steps[0].detail)
    }

    func testEmptyReasoningYieldsNothing() {
        XCTAssertTrue(AgentStep.reasoningSteps(from: "   \n\n  ", isInProgress: false).isEmpty)
    }
}
