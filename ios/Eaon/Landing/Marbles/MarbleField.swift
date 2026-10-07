import SwiftUI
import simd

/// The marbles the orb lets out once you're in, and their physics.
///
/// - **Arrival**: each marble leaves the middle of the orb as a speck and
///   springs up to its full size with a little overshoot, while buoyancy
///   floats it up into a pile against the top of the screen. A pull toward
///   the middle, strongest low down, keeps the stream narrow near the orb and
///   lets the pile spread at the top; marbles shoulder each other, and the
///   orb, out of the way.
/// - **Leaving**: going back to the start lets them go: each in turn floats
///   up and off the top of the screen, shrinking a little as it goes.
@MainActor
final class MarbleField {
    private struct Marble {
        var art: Int
        var position: SIMD2<Double>
        var velocity: SIMD2<Double>
        /// Full-grown radius.
        var size: Double
        /// 0…1 (and a little past 1 on the way in) of `size`.
        var scale = DampedSpring(0.08, stiffness: 150, damping: 13)
        var age = 0.0
        var seed: Double
        var spin: Double
        /// Seconds until a leaving marble lets go; nil while it stays.
        var leaveIn: Double?

        var radius: Double { size * max(scale.value, 0) }
    }

    private var marbles: [Marble] = []
    private var rng = SeededRandom(seed: 0xEA0)
    private var emitted = 0
    private var emitTimer = 0.0
    private var clock = 0.0
    private(set) var isEmitting = false

    var isEmpty: Bool { marbles.isEmpty }

    /// Starts letting marbles out of the orb, from the first one.
    func start() {
        marbles.removeAll { $0.leaveIn != nil }
        rng = SeededRandom(seed: 0xEA0)
        emitted = 0
        emitTimer = 0
        isEmitting = true
    }

    /// Lets every marble float away, the ones nearest the top first.
    func release(screenHeight: Double) {
        isEmitting = false
        for i in marbles.indices where marbles[i].leaveIn == nil {
            let fromTop = marbles[i].position.y / max(screenHeight, 1)
            marbles[i].leaveIn = 0.15 + fromTop * 0.5 + rng.next(in: 0 ... 0.3)
        }
    }

    func removeAll() {
        marbles.removeAll()
        isEmitting = false
    }

    /// - Parameters:
    ///   - orb: the glass orb, which the marbles come out of and keep clear of.
    ///   - orbAtRest: whether the orb is sitting in its place; it only lets
    ///     marbles out then, not while it's being carried about.
    func step(_ dt: Double, layout: LandingLayout, orb: (center: CGPoint, radius: CGFloat), orbAtRest: Bool, tuning: LandingTuning) {
        guard dt > 0 else { return }
        clock += dt
        let scale = Double(layout.width) / 402
        let orbCenter = SIMD2(Double(orb.center.x), Double(orb.center.y))
        let orbRadius = Double(orb.radius)

        if orbAtRest { emit(dt, from: orbCenter, orbRadius: orbRadius, scale: scale, tuning: tuning) }

        let substeps = 2
        let h = dt / Double(substeps)
        let width = Double(layout.width)
        let height = Double(layout.height)
        for _ in 0 ..< substeps {
            for i in marbles.indices {
                var m = marbles[i]
                m.age += h
                if let leaveIn = m.leaveIn {
                    m.leaveIn = leaveIn - h
                    if leaveIn <= 0 { m.scale.target = 0.55 }
                }
                m.scale.step(h)
                m.velocity += acceleration(of: m, midX: width / 2, height: height, scale: scale) * h
                m.velocity *= exp(-2.4 * h)
                m.position += m.velocity * h
                marbles[i] = m
            }
            separate(orbCenter: orbCenter, orbRadius: orbRadius, width: width)
        }
        // Gone once they're off the top.
        marbles.removeAll { $0.leaveIn.map { $0 < 0 } == true && $0.position.y + $0.radius < -4 }
    }

    /// Lets the next marbles out of the middle of the orb.
    private func emit(_ dt: Double, from orbCenter: SIMD2<Double>, orbRadius: Double, scale: Double, tuning: LandingTuning) {
        guard isEmitting else { return }
        let count = max(tuning.marbleCount, 0)
        emitTimer -= dt
        while emitTimer <= 0, emitted < count {
            let index = emitted
            // Mostly small, a few large; the first few are specks, as the stream gets going.
            let lo = min(tuning.marbleMinSize, tuning.marbleMaxSize)
            let hi = max(tuning.marbleMinSize, tuning.marbleMaxSize)
            var size = lo + (hi - lo) * pow(rng.next(), 1.25)
            size *= mix(0.25, 1, smoothstep(0, 10, Double(index)))
            size = max(size, 1)
            let art = rng.pick(MarbleArt.count)
            let upright = MarbleArt.kind(of: art) != .swirl
            let marble = Marble(
                art: art,
                position: orbCenter + SIMD2(rng.next(in: -0.2 ... 0.2) * orbRadius, 0),
                velocity: SIMD2(rng.next(in: -190 ... 190), rng.next(in: -400 ... -240)) * scale,
                size: size * scale,
                seed: rng.next(),
                spin: upright ? rng.next(in: -0.35 ... 0.35) : rng.next(in: 0 ... 2 * .pi)
            )
            var popping = marble
            popping.scale.target = 1
            marbles.append(popping)
            emitted += 1
            emitTimer += 1 / max(tuning.spawnRate, 0.5)
        }
        if emitted >= count { isEmitting = false }
    }

    private func acceleration(of m: Marble, midX: Double, height: Double, scale: Double) -> SIMD2<Double> {
        if let leaveIn = m.leaveIn, leaveIn <= 0 {
            // Let go: float up and away, faster and faster.
            return SIMD2(0, -1500 * scale)
        }
        let isSpeck = m.size < 5 * scale
        var a = SIMD2<Double>(0, -(isSpeck ? 260 : 360 + m.size * 4) * scale)
        // Pulled toward the middle, so the stream fans out from the orb and
        // the marbles heap into a mound under the top edge rather than
        // spreading along it.
        a.x += (midX - m.position.x) * 0.9
        // A little wander, so the pile is never quite still.
        let t = clock * 0.6 + m.seed * 40
        let drift = SIMD2<Double>(sin(t * 1.3 + m.seed * 6), cos(t * 1.1 + m.seed * 4))
        a += drift * (isSpeck ? 40 : 18) * scale
        return a
    }

    private func separate(orbCenter: SIMD2<Double>, orbRadius: Double, width: Double) {
        let n = marbles.count
        for _ in 0 ..< 2 {
            for i in 0 ..< n where marbles[i].leaveIn.map({ $0 > 0 }) ?? true {
                for j in (i + 1) ..< n where marbles[j].leaveIn.map({ $0 > 0 }) ?? true {
                    let delta = marbles[j].position - marbles[i].position
                    let dist = simd_length(delta)
                    let reach = marbles[i].radius + marbles[j].radius + 1
                    guard dist < reach, dist > 0.0001 else { continue }
                    let normal = delta / dist
                    let mi = marbles[i].radius * marbles[i].radius
                    let mj = marbles[j].radius * marbles[j].radius
                    guard mi + mj > 0 else { continue }
                    let wi = mj / (mi + mj)
                    let wj = mi / (mi + mj)
                    let overlap = reach - dist
                    marbles[i].position -= normal * overlap * wi
                    marbles[j].position += normal * overlap * wj
                    let closing = simd_dot(marbles[j].velocity - marbles[i].velocity, normal)
                    if closing < 0 {
                        marbles[i].velocity += normal * closing * wi
                        marbles[j].velocity -= normal * closing * wj
                    }
                }
            }
        }
        for i in 0 ..< n {
            var m = marbles[i]
            let leaving = m.leaveIn.map { $0 <= 0 } ?? false
            // Fresh marbles are still inside the orb, on their way out; the
            // rest keep clear of it, so the orb pushes through the pile.
            if m.age > 0.4, !leaving {
                let delta = m.position - orbCenter
                let dist = simd_length(delta)
                let reach = orbRadius * 0.92 + m.radius
                if dist < reach, dist > 0.0001 {
                    let normal = delta / dist
                    m.position = orbCenter + normal * reach
                    let into = simd_dot(m.velocity, normal)
                    if into < 0 { m.velocity -= normal * into }
                }
            }
            let left = m.radius + 2
            let right = width - m.radius - 2
            if m.position.x < left { m.position.x = left; m.velocity.x = abs(m.velocity.x) * 0.3 }
            if m.position.x > right { m.position.x = right; m.velocity.x = -abs(m.velocity.x) * 0.3 }
            // The pile presses up against the top edge, the top row cut by it.
            if !leaving, m.position.y < m.radius * 0.15 {
                m.position.y = m.radius * 0.15
                m.velocity.y = max(m.velocity.y, 0)
            }
            marbles[i] = m
        }
    }

    // MARK: Drawing

    var instances: [MarbleInstance] {
        marbles.map { m in
            MarbleInstance(
                center: SIMD2(Float(m.position.x), Float(m.position.y)),
                radius: Float(m.radius),
                art: Float(m.art),
                spin: Float(m.spin),
                alpha: 1,
                strength: MarbleArt.strength(of: m.art)
            )
        }
    }
}
