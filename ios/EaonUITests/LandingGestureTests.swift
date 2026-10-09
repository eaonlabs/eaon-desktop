import XCTest

/// Drags the landing screen's glass with real (synthesized) touches, the
/// way a finger does, through SwiftUI's gesture rather than the engine.
///
/// The screen reports where it is through a probe element that Debug builds
/// add for these tests: "intro" or "home", and the glass's centre and radius.
@MainActor
final class LandingGestureTests: XCTestCase {
    private var app: XCUIApplication!

    override func setUp() async throws {
        continueAfterFailure = false
        app = XCUIApplication()
        // Start signed out: other tests leave the app in as a guest, which skips the landing screen.
        app.launchArguments = ["-resetAll"]
        if name.contains("ReduceMotion") { app.launchArguments.append("-reduceMotion") }
        app.launch()
    }

    private struct Probe {
        var place: String
        var x: Double, y: Double, r: Double
        var marbles: Double
    }

    private func probe() -> Probe {
        let value = app.otherElements["landing.probe"].value as? String ?? ""
        var numbers: [String: Double] = [:]
        for part in value.split(separator: " ").dropFirst() {
            let pair = part.split(separator: "=")
            if pair.count == 2 { numbers[String(pair[0])] = Double(pair[1]) }
        }
        return Probe(
            place: value.split(separator: " ").first.map(String.init) ?? "",
            x: numbers["x"] ?? 0, y: numbers["y"] ?? 0, r: numbers["r"] ?? 0,
            marbles: numbers["m"] ?? 0
        )
    }

    private func waitFor(_ place: String, timeout: TimeInterval = 4) -> Bool {
        let deadline = Date().addingTimeInterval(timeout)
        while Date() < deadline {
            if probe().place == place { return true }
            RunLoop.current.run(until: Date().addingTimeInterval(0.2))
        }
        return false
    }

    private var window: XCUIElement { app.windows.firstMatch }

    private func point(_ x: CGFloat, _ y: CGFloat) -> XCUICoordinate {
        window.coordinate(withNormalizedOffset: CGVector(dx: x, dy: y))
    }

    /// Slid partway up and let go past the threshold, the glass settles the
    /// rest of the way into the orb.
    func testLettingGoPastTheThresholdSettlesIntoTheOrb() {
        let rest = probe()
        XCTAssertEqual(rest.place, "intro")
        let height = window.frame.height
        point(0.62, 0.8).press(forDuration: 0.4, thenDragTo: point(0.6, 0.55), withVelocity: 200, thenHoldForDuration: 2)
        XCTAssertTrue(waitFor("home"))
        let orb = probe()
        XCTAssertLessThan(orb.r, rest.r * 0.3, "the dome became the small orb")
        XCTAssertLessThan(orb.y, rest.y - height * 0.3, "the glass came up the screen")
    }

    /// Sliding the dome all the way up goes through, and marbles come out of the orb.
    func testSlidingTheDomeUpGoesThrough() {
        point(0.62, 0.8).press(forDuration: 0.4, thenDragTo: point(0.55, 0.36), withVelocity: 260, thenHoldForDuration: 1)
        XCTAssertTrue(waitFor("home"))
        RunLoop.current.run(until: Date().addingTimeInterval(2))
        XCTAssertGreaterThan(probe().marbles, 0)
    }

    /// With Reduce Motion, a swipe crossfades the dome into the orb: the
    /// glass doesn't travel, and there are no marbles.
    func testReduceMotionCrossfades() {
        let rest = probe()
        point(0.62, 0.8).press(forDuration: 0.2, thenDragTo: point(0.62, 0.6), withVelocity: 600, thenHoldForDuration: 0.1)
        XCTAssertTrue(waitFor("home"))
        RunLoop.current.run(until: Date().addingTimeInterval(2))
        let orb = probe()
        XCTAssertLessThan(orb.r, rest.r * 0.3)
        XCTAssertEqual(orb.marbles, 0)
    }

    /// Let go short of the threshold, the dome springs back to rest.
    func testAShortSlideSpringsBack() {
        let rest = probe()
        point(0.62, 0.8).press(forDuration: 0.4, thenDragTo: point(0.62, 0.73), withVelocity: 200, thenHoldForDuration: 0.3)
        RunLoop.current.run(until: Date().addingTimeInterval(1.5))
        let after = probe()
        XCTAssertEqual(after.place, "intro")
        XCTAssertEqual(after.y, rest.y, accuracy: 2, "back at rest")
        XCTAssertEqual(after.r, rest.r, accuracy: 2)
    }

    /// The orb, brought back down to the bottom, goes back to the intro.
    func testBringingTheOrbDownGoesBack() {
        point(0.62, 0.8).press(forDuration: 0.4, thenDragTo: point(0.55, 0.36), withVelocity: 260, thenHoldForDuration: 1)
        XCTAssertTrue(waitFor("home"))
        let orb = probe()
        let height = window.frame.height
        let width = window.frame.width
        point(orb.x / width, orb.y / height).press(forDuration: 0.3, thenDragTo: point(0.52, 0.92), withVelocity: 300, thenHoldForDuration: 0.4)
        XCTAssertTrue(waitFor("intro"))
    }
}
