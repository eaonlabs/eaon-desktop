import XCTest
@testable import Eaon_desktop

final class PlanUpdateTests: XCTestCase {
    private func parsedSteps(
        _ raw: Any?,
        file: StaticString = #filePath,
        line: UInt = #line
    ) -> [PlanStep] {
        switch PlanUpdate.parse(raw) {
        case .steps(let steps):
            return steps
        case .invalid(let reason):
            XCTFail("Expected valid plan, got: \(reason)", file: file, line: line)
            return []
        }
    }

    private func invalidReason(
        _ raw: Any?,
        file: StaticString = #filePath,
        line: UInt = #line
    ) -> String {
        switch PlanUpdate.parse(raw) {
        case .steps:
            XCTFail("Expected invalid plan", file: file, line: line)
            return ""
        case .invalid(let reason):
            return reason
        }
    }

    func testExplicitStatusesAreParsed() {
        let steps = parsedSteps([
            ["text": "Inspect", "status": "done"],
            ["text": "Build", "status": "active"],
            ["text": "Verify", "status": "pending"],
        ])

        XCTAssertEqual(steps.map(\.status), [.done, .active, .pending])
    }

    func testInProgressSynonymMapsToActive() {
        let steps = parsedSteps([["text": "Build", "status": "in_progress"]])
        XCTAssertEqual(steps.first?.status, .active)
    }

    func testCompletedSynonymMapsToDone() {
        let steps = parsedSteps([["text": "Build", "status": "completed"]])
        XCTAssertEqual(steps.first?.status, .done)
    }

    func testBareStringArrayBecomesPendingSteps() {
        let steps = parsedSteps(["Inspect", "Build"])

        XCTAssertEqual(steps.map(\.text), ["Inspect", "Build"])
        XCTAssertEqual(steps.map(\.status), [.pending, .pending])
    }

    func testExtraActiveStepsAreDemoted() {
        let steps = parsedSteps([
            ["text": "One", "status": "active"],
            ["text": "Two", "status": "active"],
            ["text": "Three", "status": "active"],
        ])

        XCTAssertEqual(steps.map(\.status), [.active, .pending, .pending])
        XCTAssertEqual(steps.filter { $0.status == .active }.count, 1)
    }

    func testNonListIsRejected() {
        XCTAssertTrue(invalidReason(["steps": "not a list"]).contains("must be a list"))
    }

    func testMissingTextIsRejected() {
        XCTAssertTrue(
            invalidReason([["status": "pending"]]).contains("has no \"text\"")
        )
    }

    func testEmptyTextIsRejected() {
        XCTAssertTrue(
            invalidReason([["text": " \n ", "status": "pending"]]).contains("empty text")
        )
    }

    func testUnknownStatusIsRejected() {
        XCTAssertTrue(
            invalidReason([["text": "Build", "status": "blocked"]])
                .contains("use pending, active, or done")
        )
    }

    func testPlanOverTwentyStepsIsRejected() {
        XCTAssertTrue(
            invalidReason((1...21).map { "Step \($0)" }).contains("20 max")
        )
    }

    func testEmptyListClearsPlan() {
        XCTAssertTrue(parsedSteps([]).isEmpty)
        XCTAssertEqual(PlanUpdate.receipt(for: []), "Plan cleared.")
    }

    func testTextIsTrimmedAndIDsFollowPosition() {
        let steps = parsedSteps(["  First  ", "\nSecond\t"])
        XCTAssertEqual(steps.map(\.text), ["First", "Second"])
        XCTAssertEqual(steps.map(\.id), [0, 1])
    }

    func testReceiptReportsCountsAndStatusMarkers() {
        let steps = [
            PlanStep(text: "Done", status: .done, id: 0),
            PlanStep(text: "Working", status: .active, id: 1),
            PlanStep(text: "Later", status: .pending, id: 2),
        ]

        XCTAssertEqual(
            PlanUpdate.receipt(for: steps),
            """
            Plan updated (1/3 done):
            [x] Done
            [>] Working
            [ ] Later
            """
        )
    }
}
