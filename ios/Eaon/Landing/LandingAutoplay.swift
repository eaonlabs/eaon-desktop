#if DEBUG
import SwiftUI

/// The whole landing sequence played by a pretend finger, for recording the
/// Simulator, which can't drag on its own. Launch a Debug build with
/// `-autoplay`: `xcrun simctl launch booted dev.eaon.ios -autoplay`.
///
/// Press the dome and slide it all the way up into the orb's place; drag
/// the orb around and over the text; bring it down to the bottom to go back;
/// then lift the dome only a little, which springs back.
@MainActor
enum LandingAutoplay {
    static func run(_ engine: LandingEngine) async {
        func wait(_ seconds: Double) async { try? await Task.sleep(for: .seconds(seconds)) }
        func now() -> Double { Date().timeIntervalSinceReferenceDate }
        func drag(_ a: CGPoint, _ b: CGPoint, over duration: Double) async {
            let start = now()
            while true {
                let t = min((now() - start) / duration, 1)
                let e = smoothstep(0, 1, t)
                _ = engine.move(to: CGPoint(x: a.x + (b.x - a.x) * e, y: a.y + (b.y - a.y) * e), time: now())
                if t >= 1 { return }
                await wait(1.0 / 120)
            }
        }

        await wait(1.5)
        let l = engine.layout

        // Press the dome near its top right, let the light gather, then
        // slide it up until it's the orb, in the orb's place.
        let press = CGPoint(x: l.midX + 50, y: l.height * 0.8)
        guard engine.begin(at: press, time: now()) else { return }
        let held = CGPoint(x: press.x + 2, y: press.y - 4)
        await drag(press, held, over: 0.9)
        let lifted = CGPoint(x: l.midX + 12, y: l.orbCenter.y - 20)
        await drag(held, lifted, over: 2.4)
        await wait(0.4)
        _ = engine.end(velocity: .zero)
        await wait(5)

        // Pick the orb up, push it up into the marbles, then read through it.
        let orb = l.orbCenter
        guard engine.begin(at: orb, time: now()) else { return }
        let up = CGPoint(x: orb.x - 50, y: orb.y - 120)
        await drag(orb, up, over: 0.7)
        let reading = CGPoint(x: orb.x + 10, y: l.titleRect.midY + 20)
        await drag(up, reading, over: 1.4)
        await wait(0.8)
        _ = engine.end(velocity: .zero)
        await wait(1.8)

        // Drag it down to the bottom and let go: back to the start.
        guard engine.begin(at: l.orbCenter, time: now()) else { return }
        await drag(l.orbCenter, CGPoint(x: l.midX + 20, y: l.height * 0.9), over: 1.8)
        await wait(0.3)
        _ = engine.end(velocity: CGSize(width: 0, height: 200))
        await wait(3)

        // Lift the dome a little and let go short of the threshold: it springs back.
        guard engine.begin(at: press, time: now()) else { return }
        await drag(press, CGPoint(x: press.x, y: press.y - (press.y - l.orbCenter.y) * 0.2), over: 0.8)
        _ = engine.end(velocity: .zero)
    }
}
#endif
