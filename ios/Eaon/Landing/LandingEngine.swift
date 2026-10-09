import SwiftUI
import simd

/// The ways in, on the welcome screen.
enum EntryChoice: Equatable {
    case apple
    case github
    /// Use Eaon on this iPhone without an account.
    case guest
}

/// One frame of the landing screen: where the glass is, how far each piece
/// of UI has arrived, and the marbles.
struct LandingFrame {
    var layout: LandingLayout
    var time: Double

    /// Usually one; two while reduced motion crossfades the dome into the orb.
    var lenses: [LensInstance]

    // The UI, each 0…1.
    var intro: Double
    /// Points of blur on the opening line as it goes.
    var introBlur: Double
    var hint: Double
    /// "Meet Eaon." on the screen itself. (Behind the glass it's always there.)
    var title: Double
    var subtitle: Double
    var appleButton: Double
    var githubButton: Double
    var guestButton: Double
    var isHome: Bool
    var buttonsLive: Bool

    var marbles: [MarbleInstance]
}

/// The landing screen's state, motion and timing. Two places to be:
///
/// - **Intro**: the opening line, and a glass dome resting on the bottom
///   edge. Pressing it gathers a haze of light in the glass. The finger then
///   carries the glass the whole way: sliding up, it lifts the dome as a
///   lens, the haze spreads into a crescent round its lower rim, the opening
///   line blurs away and the welcome ("Meet Eaon.") shows through the glass;
///   further up, the lens shrinks under the finger into the orb, in the
///   orb's place above the welcome. Let go past the threshold (or flick) and
///   it settles the rest of the way; short of it, it springs back.
/// - **Home**: the rest of the screen arrives and marbles stream out of the
///   orb. The orb can be picked up and slid anywhere, a magnifier that grows
///   as it comes down, back toward the dome's size; as it nears the bottom
///   the welcome fades and the opening line comes back, and letting go there
///   goes back to the intro.
///
/// Nothing moves on its own while it's held: the glass's position and size
/// follow the finger, and the UI follows the glass. Let go, and springs
/// (stiffness and damping from LandingTuning) take it from where it is, at
/// the speed it was going. A finger can catch it again at any moment.
///
/// With Reduce Motion on, the glass doesn't fly: a swipe crossfades between
/// the two places, and there are no marbles.
///
/// A plain class, stepped from the view's TimelineView once a frame. Nothing
/// here is observed, so stepping it never invalidates a view by itself. The
/// gesture layer (LandingGestures.swift) calls `begin`, `move` and `end`.
@MainActor
final class LandingEngine {
    enum Phase { case intro, home }

    enum DragEvent {
        case none
        /// Letting go now would go through (forward, or back to the intro).
        case armed
        case disarmed
    }

    enum Outcome {
        case none
        case entered
        case returned
    }

    private(set) var phase: Phase = .intro
    private(set) var layout = LandingLayout(size: .zero, insets: EdgeInsets())
    private var tuning = LandingTuning()
    private var reduceMotion = false

    // The lens.
    private var x = DampedSpring(0, stiffness: 170, damping: 21)
    private var y = DampedSpring(0, stiffness: 170, damping: 21)
    private var radius = DampedSpring(0, stiffness: 170, damping: 21)
    /// Light gathering in the glass while it's held, 0…1.
    private var energy = DampedSpring.critical(0, response: 0.4)

    /// The opening line.
    private var intro = DampedSpring.critical(1, response: 0.3)
    /// Seconds into the home screen's arrival; runs backwards, faster, on the way out.
    private var reveal = 0.0
    /// "Meet Eaon." on the screen, 0…1.
    private var title = 0.0
    /// Reduce Motion's crossfade: 0 is the intro, 1 home.
    private var fade = 0.0

    private var clock = 0.0
    private var lastTime: Double?
    private var grab: Grab?
    private var armed = false
    private var hasEmitted = false
    private let marbles = MarbleField()

    private struct Grab {
        var start: CGPoint
        var location: CGPoint
        var time: Double
        /// The finger's velocity, smoothed.
        var velocity: CGVector = .zero
        var lensStart: CGPoint
        /// Intro: where on the lens the finger is, in radii, kept as the lens
        /// shrinks, so the same spot of glass stays under the finger.
        var anchor: CGVector
        /// …the same, pulled onto the glass if the finger came down beside it.
        var anchorOnGlass: CGVector
        /// Intro: how far along to the orb the glass was when the finger came down.
        var progressStart: Double
        /// Intro: where the finger will be when the glass, shrunk to the orb,
        /// sits in the orb's place.
        var fingerEnd: Double
        /// The lens's own velocity and its radius's, for letting go.
        var lensVelocity: CGVector = .zero
        var radiusVelocity: Double = 0
    }

    var isHolding: Bool { grab != nil }

    /// Advances to `date` and returns what to draw. Calling it again for the
    /// same date (SwiftUI re-evaluating the body) doesn't step a second time.
    func frame(at date: Date, layout next: LandingLayout, tuning: LandingTuning, reduceMotion: Bool) -> LandingFrame {
        self.tuning = tuning
        for spring in [\LandingEngine.x, \.y, \.radius] {
            self[keyPath: spring].stiffness = tuning.stiffness
            self[keyPath: spring].damping = tuning.damping
        }
        if reduceMotion != self.reduceMotion {
            self.reduceMotion = reduceMotion
            if reduceMotion { marbles.removeAll() }
            grab = nil
            settle()
        }
        if next != layout {
            let first = layout.size == .zero
            layout = next
            if first || grab == nil { settle() }
        }
        let now = date.timeIntervalSinceReferenceDate
        let dt = lastTime.map { clamp(now - $0, 0, 1.0 / 30) } ?? 0
        lastTime = now
        if dt > 0 { step(dt) }
        return snapshot()
    }

    // MARK: Touch

    /// A finger came down at `point`. Returns whether it picked up the glass.
    func begin(at point: CGPoint, time: Double) -> Bool {
        let center = lensCenter
        let r = max(radius.value, 1)
        let reach = hypot(point.x - center.x, point.y - center.y)
        switch phase {
        case .intro:
            // Anywhere along the bottom picks up the dome, not just the glass itself.
            guard point.y > layout.domeGrabLine || reach < r else { return false }
            if !reduceMotion { energy.target = 1 }
        case .home:
            guard reach < max(r, 28) + 22 else { return false }
        }
        let anchor = CGVector(dx: (point.x - center.x) / r, dy: (point.y - center.y) / r)
        let length = hypot(anchor.dx, anchor.dy)
        let onGlass = length > 0.8 ? CGVector(dx: anchor.dx * 0.8 / length, dy: anchor.dy * 0.8 / length) : anchor
        grab = Grab(
            start: point,
            location: point,
            time: time,
            lensStart: center,
            anchor: anchor,
            anchorOnGlass: onGlass,
            progressStart: progress,
            fingerEnd: Double(layout.orbCenter.y) + onGlass.dy * Double(layout.orbRadius)
        )
        armed = false
        return true
    }

    func move(to point: CGPoint, time: Double) -> DragEvent {
        guard var g = grab else { return .none }
        let dt = time - g.time
        if dt > 0.0005 {
            let vx = (point.x - g.location.x) / dt
            let vy = (point.y - g.location.y) / dt
            g.velocity = CGVector(dx: mix(g.velocity.dx, vx, 0.5), dy: mix(g.velocity.dy, vy, 0.5))
        }
        g.location = point
        g.time = time

        let nowArmed: Bool
        if reduceMotion {
            // Nothing moves under the finger; letting go decides.
            let ty = point.y - g.start.y
            nowArmed = phase == .intro ? ty < -40 : ty > 40
        } else {
            let before = (lensCenter, radius.value)
            switch phase {
            case .intro: moveDome(g, to: point)
            case .home: moveOrb(g, to: point)
            }
            if dt > 0.0005 {
                let vx = (lensCenter.x - before.0.x) / dt
                let vy = (lensCenter.y - before.0.y) / dt
                g.lensVelocity = CGVector(dx: mix(g.lensVelocity.dx, vx, 0.5), dy: mix(g.lensVelocity.dy, vy, 0.5))
                g.radiusVelocity = mix(g.radiusVelocity, (radius.value - before.1) / dt, 0.5)
            }
            x.velocity = g.lensVelocity.dx
            y.velocity = g.lensVelocity.dy
            switch phase {
            case .intro: nowArmed = progress >= Self.enterAt
            case .home: nowArmed = layout.returnProgress(y: lensCenter.y) >= Self.returnAt
            }
        }
        grab = g
        guard nowArmed != armed else { return .none }
        armed = nowArmed
        return nowArmed ? .armed : .disarmed
    }

    /// The dome follows the finger, keeping the same spot of glass under it.
    /// How far the finger has come toward the orb's place sets the glass's
    /// size, so it shrinks under the finger from dome to lens to orb, arriving
    /// at the orb's size as the finger brings it to the orb's place. Pulled
    /// down from rest, it resists.
    private func moveDome(_ g: Grab, to point: CGPoint) {
        let travel = Double(g.start.y - point.y)
        let span = max(Double(g.start.y) - g.fingerEnd, 1)
        let p = g.progressStart + (1 - g.progressStart) * travel / span
        let r = radiusFor(progress: clamp(p, 0, 1))
        radius.snap(to: r)
        // Beside the glass, the anchor slides onto it over the first few points.
        let t = smoothstep(0, 40, hypot(Double(point.x - g.start.x), travel))
        let ax = mix(g.anchor.dx, g.anchorOnGlass.dx, t)
        let ay = mix(g.anchor.dy, g.anchorOnGlass.dy, t)
        x.snap(to: Double(point.x) - ax * r)
        if p >= 0 {
            y.snap(to: Double(point.y) - ay * r)
        } else {
            let down = -p * span / max(1 - g.progressStart, 0.01)
            y.snap(to: Double(layout.domeCenter.y) + rubberBand(down, limit: 40))
        }
    }

    /// The orb goes wherever the finger takes it, and grows into a magnifier
    /// as it comes down, toward the dome's size near the bottom.
    private func moveOrb(_ g: Grab, to point: CGPoint) {
        x.snap(to: Double(g.lensStart.x + point.x - g.start.x))
        y.snap(to: Double(g.lensStart.y + point.y - g.start.y))
        radius.target = homeRadius(progress: layout.returnProgress(y: lensCenter.y))
    }

    /// The finger lifted, moving at `velocity` (points per second).
    func end(velocity: CGSize) -> Outcome {
        guard let g = grab else { return .none }
        grab = nil
        armed = false
        energy.target = 0
        // A wild flick shouldn't fling the glass off the screen.
        let speed = hypot(velocity.width, velocity.height)
        let limit = 2600.0
        let v = speed > limit ? CGSize(width: velocity.width * limit / speed, height: velocity.height * limit / speed) : velocity

        if reduceMotion {
            let ty = g.location.y - g.start.y
            switch phase {
            case .intro where ty < -40 || v.height < -300:
                enter()
                return .entered
            case .home where ty > 40 || v.height > 300:
                goBack()
                return .returned
            default:
                return .none
            }
        }

        // The glass carries on at the speed it was going.
        x.velocity = g.lensVelocity.dx
        y.velocity = g.lensVelocity.dy
        radius.velocity = g.radiusVelocity
        switch phase {
        case .intro:
            let span = Double(layout.domeCenter.y - layout.orbCenter.y)
            let projected = progress - Double(v.height) * 0.2 / max(span, 1)
            if progress >= Self.enterAt || (projected >= 0.6 && v.height < -280) {
                enter()
                return .entered
            }
        case .home:
            let span = Double(layout.domeCenter.y - layout.orbCenter.y)
            let progress = layout.returnProgress(y: lensCenter.y)
            let projected = progress + Double(v.height) * 0.2 / max(span, 1)
            if progress >= Self.returnAt || (projected >= 0.95 && v.height > 650) {
                goBack()
                return .returned
            }
        }
        // Short of the threshold: the springs take it back where it was.
        return .none
    }

    /// Lets go of a drag the system cancelled without an end event.
    func cancelHold() {
        if grab != nil { _ = end(velocity: .zero) }
    }

    // MARK: Going through

    /// Goes through to the home screen. Also what VoiceOver's activate does.
    func enter() {
        guard phase == .intro else { return }
        phase = .home
        grab = nil
        energy.target = 0
        hasEmitted = false
    }

    /// Back to the intro: the glass sinks back into the dome, the opening
    /// line returns, and the marbles float away.
    func goBack() {
        guard phase == .home else { return }
        phase = .intro
        grab = nil
        marbles.release(screenHeight: Double(layout.height))
        // The dome lands with a little of the light still in it.
        if !reduceMotion {
            energy.value = max(energy.value, 0.7)
            energy.target = 0
        }
    }

    // MARK: Stepping

    /// Past this much of the way to the orb, letting go goes through.
    private static let enterAt = 0.33
    /// Past this much of the way back to the dome, letting go of the orb goes back.
    private static let returnAt = 0.72
    /// When the home screen has finished arriving (the last button, see snapshot()).
    private static let revealEnd = 1.2

    private var lensCenter: CGPoint { CGPoint(x: x.value, y: y.value) }

    /// How far the glass has come from the dome's place to the orb's, 0…1.
    private var progress: Double {
        let span = Double(layout.domeCenter.y - layout.orbCenter.y)
        guard span > 0 else { return 0 }
        return clamp((Double(layout.domeCenter.y) - y.value) / span, 0, 1)
    }

    /// At home, how far the orb has been dragged back toward the dome, 0…1.
    private var returning: Double {
        phase == .home ? clamp(layout.returnProgress(y: CGFloat(y.value)), 0, 1) : 0
    }

    /// The glass's size along the way to the orb: a little bigger as it
    /// comes off the bottom, a wide lens for most of the way up, so the
    /// welcome shows through it as it passes over, then shrinking into the orb
    /// over the last part of the way.
    private func radiusFor(progress p: Double) -> Double {
        let dome = Double(layout.domeRadius)
        let lens = mix(dome, Double(layout.liftedRadius), smoothstep(0.05, 0.5, p))
        let swell = 1 + 0.12 * sin(.pi * clamp(p / 0.3, 0, 1))
        return mix(lens * swell, Double(layout.orbRadius), smoothstep(0.8, 1, p))
    }

    /// The orb's radius while it's held, by how far it's been dragged back
    /// toward the dome: a magnifier over the text, the dome's size at the bottom.
    private func homeRadius(progress: Double) -> Double {
        let orb = Double(layout.orbRadius) * 1.15
        let magnifier = Double(layout.magnifierRadius)
        let dome = Double(layout.domeRadius)
        if progress < 0.55 {
            return mix(orb, magnifier, smoothstep(-0.05, 0.3, progress))
        }
        return mix(magnifier, dome, smoothstep(0.55, 1.05, progress))
    }

    /// Puts everything at rest where it belongs (first layout, Reduce Motion).
    private func settle() {
        let center = phase == .intro ? layout.domeCenter : layout.orbCenter
        x.snap(to: center.x)
        y.snap(to: center.y)
        radius.snap(to: phase == .intro ? layout.domeRadius : layout.orbRadius)
        intro.snap(to: phase == .intro ? 1 : 0)
        energy.snap(to: 0)
        reveal = phase == .home ? Self.revealEnd : 0
        title = phase == .home ? 1 : 0
        fade = phase == .home ? 1 : 0
    }

    private func step(_ dt: Double) {
        clock += dt
        let held = grab != nil && !reduceMotion

        // Unless a finger has it, the glass heads for where it belongs.
        if !held {
            switch phase {
            case .intro:
                x.target = layout.domeCenter.x
                y.target = layout.domeCenter.y
                radius.target = layout.domeRadius
            case .home:
                x.target = layout.orbCenter.x
                y.target = layout.orbCenter.y
                radius.target = layout.orbRadius
            }
            x.step(dt)
            y.step(dt)
        }
        // Held over the intro, the radius follows the finger exactly; held at
        // home, it springs toward the size for where the orb is.
        if !(held && phase == .intro) { radius.step(dt) }
        energy.step(dt)

        // The UI follows the glass: the opening line goes as it lifts, and
        // comes back as the orb is brought down to the dome.
        intro.target = phase == .intro ? 1 - smoothstep(0.03, 0.25, progress) : smoothstep(0.6, 1, returning)
        intro.step(dt)
        // "Meet Eaon." arrives on the screen as the glass, nearly an orb,
        // slides off it; at home it finishes arriving on its own.
        switch phase {
        case .intro:
            let preview = smoothstep(0.72, 0.97, progress)
            title = preview > title ? preview : max(preview, title - dt / 0.2)
        case .home:
            title = min(1, title + dt / 0.4)
        }
        // Capped at the end of the last stage, so going back starts undoing at once.
        reveal = phase == .home ? min(reveal + dt, Self.revealEnd) : max(reveal - dt * 4, 0)
        let fadeTarget: Double = phase == .home ? 1 : 0
        fade += clamp(fadeTarget - fade, -dt / 0.35, dt / 0.35)

        // The marbles start once the welcome has mostly arrived.
        if phase == .home, reveal >= 0.7, !hasEmitted, !reduceMotion {
            hasEmitted = true
            marbles.start()
        }
        if !marbles.isEmpty || phase == .home {
            let home = layout.orbCenter
            let atRest = phase == .home && grab == nil
                && hypot(lensCenter.x - home.x, lensCenter.y - home.y) < layout.orbRadius * 0.5
                && abs(radius.value - Double(layout.orbRadius)) < Double(layout.orbRadius) * 0.3
            marbles.step(dt, layout: layout, orb: (lensCenter, CGFloat(radius.value)), orbAtRest: atRest, tuning: tuning)
        }
    }

    private func snapshot() -> LandingFrame {
        if reduceMotion { return crossfadeSnapshot() }
        func stage(_ delay: Double, _ duration: Double) -> Double {
            easeOutCubic((reveal - delay) / duration)
        }
        let introShown = clamp(intro.value, 0, 1)
        let p = progress
        // Brought back down toward the dome, the home screen fades with it.
        let staying = 1 - smoothstep(0.55, 0.95, returning)
        let lens = LensInstance(
            center: lensCenter,
            radius: max(radius.value, 1),
            crescent: clamp(energy.value, 0, 1) * (1 - smoothstep(0.25, 0.5, p)) * tuning.crescentIntensity,
            spread: smoothstep(0, 0.15, p)
        )
        return LandingFrame(
            layout: layout,
            time: clock,
            lenses: [lens],
            intro: introShown,
            introBlur: (1 - introShown) * 8,
            hint: phase == .intro ? introShown * (1 - smoothstep(0, 0.06, p)) : 0,
            title: title * staying,
            subtitle: stage(0.3, 0.6) * staying,
            appleButton: stage(0.5, 0.55) * staying,
            githubButton: stage(0.6, 0.55) * staying,
            guestButton: stage(0.7, 0.5) * staying,
            isHome: phase == .home,
            buttonsLive: phase == .home && reveal > 0.8 && returning < 0.3,
            marbles: marbles.instances
        )
    }

    /// Reduce Motion: the dome and the orb stay put and crossfade, with the
    /// UI fading between the two places. No crescent, no marbles.
    private func crossfadeSnapshot() -> LandingFrame {
        let f = clamp(fade, 0, 1)
        var lenses: [LensInstance] = []
        if f < 1 { lenses.append(LensInstance(center: layout.domeCenter, radius: layout.domeRadius, opacity: 1 - f)) }
        if f > 0 { lenses.append(LensInstance(center: layout.orbCenter, radius: layout.orbRadius, opacity: f)) }
        return LandingFrame(
            layout: layout,
            time: clock,
            lenses: lenses,
            intro: 1 - f,
            introBlur: 0,
            hint: 1 - f,
            title: f,
            subtitle: f,
            appleButton: f,
            githubButton: f,
            guestButton: f,
            isHome: phase == .home,
            buttonsLive: phase == .home && f > 0.9,
            marbles: []
        )
    }
}
