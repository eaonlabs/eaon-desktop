import CoreGraphics
import Foundation

/// A damped spring with a mass of 1, stepped by hand once a frame.
///
/// The landing screen steps its own springs instead of animating with
/// SwiftUI's because the values feed shaders and physics every frame, and
/// because a finger can catch the glass mid-flight and let go of it again:
/// setting `velocity` to the finger's carries its speed straight into the spring.
struct DampedSpring {
    var value: Double
    var velocity: Double = 0
    var target: Double
    /// Pull toward the target per point of distance.
    var stiffness: Double
    /// Drag per point per second of speed. 2·√stiffness is critically damped;
    /// less overshoots.
    var damping: Double

    init(_ value: Double, stiffness: Double, damping: Double) {
        self.value = value
        self.target = value
        self.stiffness = stiffness
        self.damping = damping
    }

    /// A spring that settles without overshooting, taking about `response` seconds.
    static func critical(_ value: Double, response: Double) -> DampedSpring {
        let stiffness = pow(2 * .pi / response, 2)
        return DampedSpring(value, stiffness: stiffness, damping: 2 * stiffness.squareRoot())
    }

    var isSettled: Bool { abs(value - target) < 0.001 && abs(velocity) < 0.01 }

    mutating func step(_ dt: Double) {
        var remaining = dt
        // Small fixed substeps keep a stiff spring stable at any frame rate.
        while remaining > 0 {
            let h = min(remaining, 1.0 / 240)
            let force = -stiffness * (value - target) - damping * velocity
            velocity += force * h
            value += velocity * h
            remaining -= h
        }
    }

    mutating func snap(to newValue: Double) {
        value = newValue
        target = newValue
        velocity = 0
    }
}

@inline(__always) func clamp<T: Comparable>(_ x: T, _ lo: T, _ hi: T) -> T { min(max(x, lo), hi) }

@inline(__always) func mix(_ a: Double, _ b: Double, _ t: Double) -> Double { a + (b - a) * t }

func smoothstep(_ edge0: Double, _ edge1: Double, _ x: Double) -> Double {
    let t = clamp((x - edge0) / (edge1 - edge0), 0, 1)
    return t * t * (3 - 2 * t)
}

func easeOutCubic(_ t: Double) -> Double {
    let u = 1 - clamp(t, 0, 1)
    return 1 - u * u * u
}

/// Resistance past a limit, like a scroll view pulled beyond its end.
func rubberBand(_ offset: Double, limit: Double) -> Double {
    let sign: Double = offset < 0 ? -1 : 1
    let x = abs(offset)
    return sign * limit * (1 - 1 / (x / limit * 0.55 + 1))
}

/// A small deterministic random source, so the marbles come out the same way every time.
struct SeededRandom {
    private var state: UInt64

    init(seed: UInt64) { state = seed }

    mutating func next() -> Double {
        state &+= 0x9E37_79B9_7F4A_7C15
        var z = state
        z = (z ^ (z >> 30)) &* 0xBF58_476D_1CE4_E5B9
        z = (z ^ (z >> 27)) &* 0x94D0_49BB_1331_11EB
        z ^= z >> 31
        return Double(z >> 11) / Double(1 << 53)
    }

    mutating func next(in range: ClosedRange<Double>) -> Double {
        range.lowerBound + next() * (range.upperBound - range.lowerBound)
    }

    mutating func pick(_ count: Int) -> Int { min(Int(next() * Double(count)), count - 1) }
}
