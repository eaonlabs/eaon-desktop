import SwiftUI

/// Every knob of the landing screen: the glass, its sizes, the crescent of
/// light, the springs and the marbles. Release builds use the defaults; in
/// Debug builds the tuning panel (GlassTuningPanel) changes them live, and
/// launch arguments can set the numbers (e.g. `-stiffness 300`).
struct LandingTuning: Equatable {
    var lens = LensParameters()

    /// The dome's radius at rest on the bottom edge, as a fraction of the screen's width.
    var restRadius = 0.47
    /// The orb's radius once you're in, as a fraction of the screen's width.
    var endRadius = 0.075

    /// The deep blue at the heart of the crescent; its cyan inner edge and
    /// violet outer edge are turned from it.
    var crescentColor = Color(red: 0.12, green: 0.24, blue: 1.0)
    /// 0 hides the crescent and the haze; 1 is as in the reference.
    var crescentIntensity = 1.0

    /// The lens's springs (position and size), with a mass of 1.
    var stiffness = 170.0
    var damping = 21.0

    /// How many marbles come out of the orb.
    var marbleCount = 85
    /// The smallest and largest marble radius, in points on a 402-point-wide screen.
    var marbleMinSize = 2.0
    var marbleMaxSize = 30.0
    /// Marbles per second.
    var spawnRate = 24.0

    init() {
        #if DEBUG
        let defaults = UserDefaults.standard
        func read(_ key: String, into value: inout Double) {
            if defaults.object(forKey: key) != nil { value = defaults.double(forKey: key) }
        }
        read("refraction", into: &lens.refraction)
        read("magnification", into: &lens.magnification)
        read("rimWidth", into: &lens.rimWidth)
        read("rimCurve", into: &lens.rimCurve)
        read("dispersion", into: &lens.dispersion)
        read("highlight", into: &lens.highlight)
        read("restRadius", into: &restRadius)
        read("endRadius", into: &endRadius)
        read("crescentIntensity", into: &crescentIntensity)
        read("stiffness", into: &stiffness)
        read("damping", into: &damping)
        var count = Double(marbleCount)
        read("marbleCount", into: &count)
        marbleCount = Int(count)
        read("marbleMinSize", into: &marbleMinSize)
        read("marbleMaxSize", into: &marbleMaxSize)
        read("spawnRate", into: &spawnRate)
        #endif
    }
}

/// Holds the tuning a screen draws with, so the debug panel can change it live.
@MainActor @Observable
final class TuningStore {
    var tuning = LandingTuning()
}

/// The crescent's three colours, turned from its core colour: a cyan inner
/// edge (toward the middle of the glass), the core, and a violet outer edge
/// that also tints the haze.
struct CrescentPalette: Equatable {
    var inner: SIMD3<Float>
    var core: SIMD3<Float>
    var outer: SIMD3<Float>

    init(core color: Color) {
        let resolved = color.resolve(in: EnvironmentValues())
        var hue: CGFloat = 0, saturation: CGFloat = 0, brightness: CGFloat = 0, alpha: CGFloat = 0
        UIColor(red: CGFloat(resolved.red), green: CGFloat(resolved.green), blue: CGFloat(resolved.blue), alpha: 1)
            .getHue(&hue, saturation: &saturation, brightness: &brightness, alpha: &alpha)
        func turned(_ degrees: CGFloat, saturation s: CGFloat, brightness b: CGFloat) -> SIMD3<Float> {
            var h = hue + degrees / 360
            h -= floor(h)
            let c = UIColor(hue: h, saturation: clamp(s, 0, 1), brightness: clamp(b, 0, 1), alpha: 1)
            var r: CGFloat = 0, g: CGFloat = 0, bl: CGFloat = 0, a: CGFloat = 0
            c.getRed(&r, green: &g, blue: &bl, alpha: &a)
            return SIMD3(Float(r), Float(g), Float(bl))
        }
        core = SIMD3(resolved.red, resolved.green, resolved.blue)
        inner = turned(-34, saturation: saturation * 0.75, brightness: 1)
        outer = turned(38, saturation: saturation * 0.6, brightness: 1)
    }
}
