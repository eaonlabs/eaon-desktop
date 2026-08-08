import SwiftUI

/// The dotted thought-orb shown while the assistant is working.
///
/// A Swift port of Jakub Antalík's `thinking-orbs` (MIT licensed,
/// github.com/Jakubantalik/thinking-orbs), whose engine is itself descended
/// from inkform's HalftoneSphere. The maths below — the Fibonacci lattice,
/// the value noise, the yaw/tilt projector, the z-sorted matte painter — is
/// his; the port, the state mapping and the SwiftUI shell are ours.
///
/// It is honestly 3D: points are placed on a unit sphere, rotated, and
/// projected orthographically, with depth carried by dot size and ink weight
/// alone. No blur, no gradients, no glow — which is exactly why it sits
/// comfortably in Eaon's chrome, where every other surface is flat and
/// monochrome too.
///
/// Four of the library's nine modes are ported, one per state Eaon actually
/// reports. The others (rubik, wave, braid, ribbon, morph) describe work
/// this app doesn't distinguish, and a mode nothing can ever select is just
/// code to maintain.
struct ThinkingOrb: View {
    /// What the assistant is doing. Mapped from the status Eaon already
    /// publishes, so the orb never claims to know more than the app does.
    enum State {
        /// The default: waiting on the first tokens.
        case thinking
        /// A web search is running.
        case searching
        /// Agent tools or a swarm discussion are running.
        case connecting
        /// A local model is being read into memory.
        case loading

        /// Maps a status line to a mode. Deliberately conservative: anything
        /// unrecognised falls back to `.thinking` rather than guessing, since
        /// a wrong mode is a small lie about what the app is doing.
        static func matching(_ status: String?) -> State {
            guard let status = status?.lowercased() else { return .thinking }
            if status.contains("searching the web") || status.contains("search") { return .searching }
            if status.contains("loading") && status.contains("memory") { return .loading }
            if status.hasPrefix("running") || status.contains("swarm") || status.contains("connecting") {
                return .connecting
            }
            return .thinking
        }
    }

    var state: State = .thinking
    /// 22pt is the smallest the dot lattice stays legible at; the library's
    /// own tunings are baked for a 20pt frame, so this stays close to them.
    var size: CGFloat = 22

    @Environment(\.colorScheme) private var colorScheme
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    /// 30fps, not 60.
    ///
    /// This is a particle sim redrawn synchronously on the main thread, and
    /// it is only ever on screen *while the model is generating* — which is
    /// precisely when there's least headroom to spare, especially for a
    /// local model saturating the CPU. Halving the redraw rate halves that
    /// cost during the exact window where it competes with token streaming
    /// and with the typewriter's own 60Hz updates. Ambient particle motion
    /// reads as continuous well below 60fps, so this is invisible in the
    /// look and very visible in the load.
    private static let frameInterval: Double = 1.0 / 30.0

    var body: some View {
        TimelineView(.animation(minimumInterval: Self.frameInterval, paused: reduceMotion)) { timeline in
            Canvas(rendersAsynchronously: false) { context, canvasSize in
                let preset = OrbPreset.forState(state)
                // Reduced motion still gets an orb, just a still one. The
                // frame is taken slightly into the loop rather than at t=0,
                // where several modes start from a degenerate pose (every
                // particle stacked at the same phase).
                let t = reduceMotion
                    ? 0.6
                    : timeline.date.timeIntervalSinceReferenceDate * preset.speed
                preset.draw(&context, canvasSize.width, t, colorScheme == .dark)
            }
        }
        .frame(width: size, height: size)
        // Decorative: the status text beside it is what carries the meaning,
        // and announcing "animation" over the top of "Searching the web…"
        // just makes VoiceOver noisier.
        .accessibilityHidden(true)
    }
}

// MARK: - Engine primitives

/// A projected, depth-shaded point.
private struct OrbDot {
    var x: CGFloat
    var y: CGFloat
    var z: CGFloat
    var r: CGFloat
    /// Ink value: 0 is the darkest ink on paper. Mirrored on dark themes.
    var white: CGFloat
    var a: CGFloat = 1
}

/// A stroked edge between two projected points.
private struct OrbLine {
    var x1: CGFloat, y1: CGFloat, x2: CGFloat, y2: CGFloat
    var white: CGFloat
    var a: CGFloat
    var w: CGFloat
}

private enum Orb {
    static func lerp(_ a: CGFloat, _ b: CGFloat, _ f: CGFloat) -> CGFloat { a + (b - a) * f }

    static func frac(_ x: CGFloat) -> CGFloat { x - floor(x) }

    /// Deterministic hash in [0, 1). The sine-fract trick: cheap, stable
    /// across runs, and good enough for scattering that never needs to be
    /// statistically sound.
    static func hashD(_ a: CGFloat, _ b: CGFloat) -> CGFloat {
        let h = sin(a * 12.9898 + b * 78.233) * 43758.5453
        return h - floor(h)
    }

    /// Value noise on a 2D lattice: smooth, deterministic, cheap.
    static func vnoise(_ x: CGFloat, _ y: CGFloat) -> CGFloat {
        let xi = floor(x), yi = floor(y)
        var fx = x - xi, fy = y - yi
        fx = fx * fx * (3 - 2 * fx)
        fy = fy * fy * (3 - 2 * fy)
        let a = hashD(xi, yi)
        let b = hashD(xi + 1, yi)
        let c = hashD(xi, yi + 1)
        let d = hashD(xi + 1, yi + 1)
        return a + (b - a) * fx + (c - a) * fy + (a - b - c + d) * fx * fy
    }

    /// Evenly spread directions on a unit sphere (Fibonacci lattice).
    static func fibDir(_ i: Int, _ n: Int) -> (CGFloat, CGFloat, CGFloat) {
        let golden = CGFloat.pi * (3 - sqrt(5))
        let y = 1 - (2 * (CGFloat(i) + 0.5)) / CGFloat(n)
        let rad = sqrt(max(0, 1 - y * y))
        let a = CGFloat(i) * golden
        return (rad * cos(a), y, rad * sin(a))
    }

    /// Shortest signed angular distance, wrapped to (-π, π].
    static func angleDelta(_ a: CGFloat, _ b: CGFloat) -> CGFloat {
        atan2(sin(a - b), cos(a - b))
    }

    /// Spin, tilt, and orthographic projection in one closure.
    static func makeProj(
        yaw: CGFloat, tilt: CGFloat, cx: CGFloat, cy: CGFloat, scale: CGFloat
    ) -> (CGFloat, CGFloat, CGFloat) -> (CGFloat, CGFloat, CGFloat) {
        let st = sin(tilt), ct = cos(tilt)
        let sy = sin(yaw), cyw = cos(yaw)
        return { x, y, z in
            let x1 = x * cyw + z * sy
            let z1 = -x * sy + z * cyw
            let y1 = y * ct - z1 * st
            let z2 = y * st + z1 * ct
            return (cx + x1 * scale, cy - y1 * scale, z2)
        }
    }

    /// Dot radii were tuned against a 300pt frame; scaling sub-linearly
    /// keeps a small orb's dots from vanishing.
    static func radiusScale(_ size: CGFloat, _ pow_: CGFloat) -> CGFloat {
        pow(size / 300, pow_)
    }

    /// Painter: far to near, matte grayscale. On a dark substrate the ink
    /// value is mirrored so near dots read bright — the same depth language,
    /// inverted.
    static func paint(_ ctx: inout GraphicsContext, _ dots: [OrbDot], _ dark: Bool, _ rMin: CGFloat) {
        for d in dots.sorted(by: { $0.z < $1.z }) {
            guard d.a >= 0.02 else { continue }
            let w = min(1, max(0, d.white))
            let g = (dark ? 1 - w : w)
            let r = max(rMin, d.r)
            ctx.fill(
                Path(ellipseIn: CGRect(x: d.x - r, y: d.y - r, width: r * 2, height: r * 2)),
                with: .color(Color(white: g, opacity: d.a))
            )
        }
    }

    /// Edges are stroked before the nodes so the dots always sit on top.
    static func paintLines(_ ctx: inout GraphicsContext, _ lines: [OrbLine], _ dark: Bool) {
        for l in lines {
            guard l.a >= 0.02 else { continue }
            let w = min(1, max(0, l.white))
            let g = (dark ? 1 - w : w)
            var p = Path()
            p.move(to: CGPoint(x: l.x1, y: l.y1))
            p.addLine(to: CGPoint(x: l.x2, y: l.y2))
            ctx.stroke(p, with: .color(Color(white: g, opacity: l.a)), lineWidth: l.w)
        }
    }
}

// MARK: - Presets

/// The library resolves (state × size) into scaled draw options at runtime.
/// Eaon only ever renders one size, so the multipliers are folded in here
/// instead: the numbers in each painter are the library's 20pt tunings with
/// its `scaleCounts` / `scaleRadii` already applied. Keeping them literal
/// means the render path does no setup work at all.
///
/// Three were then re-tuned, because the library's small preset is sized for
/// a demo page where the orb is the only thing on screen. Beside 13pt status
/// text it has to hold its own at a glance:
///
///   - **orbits** 3 paths of 10 dots read as a scatter rather than an orb;
///     raised to 5 × 18, with the radii pulled back so the denser lattice
///     doesn't fill in solid.
///   - **web** 8 nodes cleared the 0.72 distance threshold so rarely that
///     the edges — the entire point of the mode — usually didn't draw at
///     all. Raised to 18.
///   - **ring** 15 segments left a visible seam, and a 0.565 wobble pushed
///     the lobes deep enough that a still frame read as a teardrop rather
///     than a ring being gently deformed. Now 22 segments at 0.34.
///
/// Speeds are the library's, untouched. They are already faster at small
/// sizes than large, which is the right instinct: a quicker mark makes the
/// wait feel shorter even when it isn't.
private struct OrbPreset {
    let speed: Double
    let draw: (inout GraphicsContext, CGFloat, Double, Bool) -> Void

    static func forState(_ state: ThinkingOrb.State) -> OrbPreset {
        switch state {
        case .thinking:   return OrbPreset(speed: 3.9,  draw: drawOrbits)
        case .searching:  return OrbPreset(speed: 2.665, draw: drawGlobe)
        case .connecting: return OrbPreset(speed: 6.63, draw: drawWeb)
        case .loading:    return OrbPreset(speed: 3.78, draw: drawRing)
        }
    }
}

// MARK: Orbits — the default "working" state

/// Particles running tilted orbits, with the paths themselves left as faint
/// ghosts. No nucleus: the tuned preset is coreless, so what you see is the
/// work happening rather than a thing sitting there.
private func drawOrbits(_ ctx: inout GraphicsContext, _ size: CGFloat, _ time: Double, _ dark: Bool) {
    let t = CGFloat(time)
    let cx = size / 2, cy = size / 2
    let R = (size / 2) * 0.82
    let pt = Orb.makeProj(yaw: t * 0.12, tilt: 0.3, cx: cx, cy: cy, scale: 1)
    let rs = Orb.radiusScale(size, 0.6)

    // Two density tiers. The denser one is the re-tuning described above,
    // for the 22pt orb that stands on its own beside a status line. Below
    // ~18pt there isn't the area to resolve 105 dots — they silt up into a
    // grey smudge — so the inline mark falls back to the library's original
    // sparse numbers, which is the size they were tuned for in the first
    // place.
    let compact = size < 18
    let orbitN = compact ? 3 : 5
    let ghostN = compact ? 10 : 18
    let particles = 3
    let ghostR: CGFloat = compact ? 2.16 : 1.71
    let ghostA: CGFloat = 0.5
    let partR: CGFloat = compact ? 2.88 : 2.28
    let partRDepth: CGFloat = compact ? 3.84 : 3.04

    var dots: [OrbDot] = []
    dots.reserveCapacity(orbitN * (ghostN + particles))

    for orb in 0..<orbitN {
        let h1 = Orb.hashD(CGFloat(orb), 1.7)
        let h2 = Orb.hashD(CGFloat(orb), 5.2)
        let h3 = Orb.hashD(CGFloat(orb), 8.9)
        let ro = R * (0.45 + 0.52 * h1)
        let th = h1 * 2 * .pi
        let phi = acos(2 * h2 - 1)
        // Orbit plane basis: u and v perpendicular to the plane normal n.
        let nx = sin(phi) * cos(th)
        let ny = cos(phi)
        let nz = sin(phi) * sin(th)
        var ux = -ny, uy = nx
        let uz: CGFloat = 0
        let ul = max(1e-6, sqrt(ux * ux + uy * uy))
        ux /= ul; uy /= ul
        let vx = ny * uz - nz * uy
        let vy = nz * ux - nx * uz
        let vz = nx * uy - ny * ux
        let speed = (0.25 + 0.55 * h3) * (h3 > 0.5 ? 1 : -1)

        for k in 0..<ghostN {
            let a = (CGFloat(k) / CGFloat(ghostN)) * 2 * .pi
            let (px, py, z) = pt(
                (ux * cos(a) + vx * sin(a)) * ro,
                (uy * cos(a) + vy * sin(a)) * ro,
                (uz * cos(a) + vz * sin(a)) * ro
            )
            let depth = (z / ro + 1) / 2
            dots.append(OrbDot(x: px, y: py, z: z, r: ghostR * rs,
                               white: 0.72, a: ghostA * (0.4 + 0.6 * depth)))
        }
        for m in 0..<particles {
            let a = t * speed + (CGFloat(m) / CGFloat(particles)) * 2 * .pi + h2 * 6
            let (px, py, z) = pt(
                (ux * cos(a) + vx * sin(a)) * ro,
                (uy * cos(a) + vy * sin(a)) * ro,
                (uz * cos(a) + vz * sin(a)) * ro
            )
            let depth = (z / ro + 1) / 2
            dots.append(OrbDot(x: px, y: py, z: z,
                               r: (partR + partRDepth * depth) * rs,
                               white: 0.3 - 0.22 * depth))
        }
    }
    Orb.paint(&ctx, dots, dark, 0.3)
}

// MARK: Globe — searching

/// A dotted sphere with a meridian sweeping across it. The scan reads as a
/// size ripple rather than a highlight, so it survives on a flat monochrome
/// surface where a specular shine would look painted on.
private func drawGlobe(_ ctx: inout GraphicsContext, _ size: CGFloat, _ time: Double, _ dark: Bool) {
    let t = CGFloat(time)
    let spin: CGFloat = 0.5
    let cx = size / 2, cy = size / 2
    let radius = (size / 2) * 0.82
    let tilt = 0.4 + 0.06 * sin(t * 0.35)
    let pt = Orb.makeProj(yaw: t * spin, tilt: tilt, cx: cx, cy: cy, scale: radius)
    let scanMul: CGFloat = 4.335
    let scan = t * (spin + (1.7 - spin) * scanMul)
    let rs = Orb.radiusScale(size, 0.6)
    let dimBase: CGFloat = 0.45

    let latRings = 6, lonDensity: CGFloat = 14
    let rBase: CGFloat = 1.05, rDepth: CGFloat = 2.975, rBoost: CGFloat = 1.0
    let inkFar: CGFloat = 0.62, inkSpan: CGFloat = 0.54

    var dots: [OrbDot] = []
    dots.reserveCapacity(latRings * Int(lonDensity))

    for li in 0...latRings {
        let lat = -CGFloat.pi / 2 + (CGFloat(li) / CGFloat(latRings)) * .pi
        let cosLat = cos(lat), sinLat = sin(lat)
        let lonCount = max(1, Int((abs(cosLat) * lonDensity).rounded()))
        for lj in 0..<lonCount {
            let lon = (CGFloat(lj) / CGFloat(lonCount)) * 2 * .pi
            let (px, py, z) = pt(cosLat * cos(lon), sinLat, cosLat * sin(lon))
            let depth = (z + 1) / 2
            let d = Orb.angleDelta(lon + t * spin, scan)
            let boost = exp(-(d * d) / 0.18) * max(0, z)
            dots.append(OrbDot(
                x: px, y: py, z: z,
                r: (rBase + rDepth * depth + rBoost * boost) * rs,
                white: inkFar - inkSpan * depth,
                a: dimBase + (1 - dimBase) * min(1, boost)
            ))
        }
    }
    Orb.paint(&ctx, dots, dark, 0.3)
}

// MARK: Web — tools and swarm

/// A constellation wiring itself: nodes drift under slow value noise, any
/// pair close enough grows an edge, and bright packets run between randomly
/// re-picked pairs. The obvious mode for work that is many things talking to
/// each other.
private func drawWeb(_ ctx: inout GraphicsContext, _ size: CGFloat, _ time: Double, _ dark: Bool) {
    let t = CGFloat(time)
    let cx = size / 2, cy = size / 2
    let R = (size / 2) * 0.8
    // The projector carries the radius as its scale, so node vectors stay
    // unit-length and the distance test below is in unit-sphere space.
    let pt = Orb.makeProj(yaw: t * 0.12, tilt: 0.32, cx: cx, cy: cy, scale: R)
    let rs = Orb.radiusScale(size, 0.6)

    let nodeN = 18
    let thr: CGFloat = 0.72
    let nodeR: CGFloat = 1.68, nodeRDepth: CGFloat = 2.16
    let lineW: CGFloat = 0.8
    let signals = 3

    var nodes: [(CGFloat, CGFloat, CGFloat)] = []
    nodes.reserveCapacity(nodeN)
    for i in 0..<nodeN {
        let d = Orb.fibDir(i, nodeN)
        let x = d.0 + 0.3 * (Orb.vnoise(CGFloat(i) * 0.31 + 9, t * 0.24) - 0.5) * 2
        let y = d.1 + 0.3 * (Orb.vnoise(CGFloat(i) * 0.53 + 27, t * 0.21) - 0.5) * 2
        let z = d.2 + 0.3 * (Orb.vnoise(CGFloat(i) * 0.77 + 55, t * 0.27) - 0.5) * 2
        let l = max(1e-6, sqrt(x * x + y * y + z * z))
        nodes.append((x / l, y / l, z / l))
    }

    var lines: [OrbLine] = []
    var dots: [OrbDot] = []

    for i in 0..<nodeN {
        for j in (i + 1)..<nodeN {
            let dx = nodes[i].0 - nodes[j].0
            let dy = nodes[i].1 - nodes[j].1
            let dz = nodes[i].2 - nodes[j].2
            let dist = sqrt(dx * dx + dy * dy + dz * dz)
            guard dist < thr else { continue }
            let (x1, y1, z1) = pt(nodes[i].0, nodes[i].1, nodes[i].2)
            let (x2, y2, z2) = pt(nodes[j].0, nodes[j].1, nodes[j].2)
            let depth = ((z1 + z2) / 2 + 1) / 2
            lines.append(OrbLine(
                x1: x1, y1: y1, x2: x2, y2: y2,
                white: 0.42,
                a: (1 - dist / thr) * (0.3 + 0.55 * depth),
                w: max(0.6, lineW * rs)
            ))
        }
    }

    for i in 0..<nodeN {
        let (px, py, z) = pt(nodes[i].0, nodes[i].1, nodes[i].2)
        let depth = (z + 1) / 2
        let pulse = 1 + 0.25 * sin(t * 1.4 + CGFloat(i) * 2.7)
        dots.append(OrbDot(x: px, y: py, z: z,
                           r: (nodeR + nodeRDepth * depth) * pulse * rs,
                           white: 0.55 - 0.45 * depth))
    }

    for s in 0..<signals {
        let seg = floor(t * 0.55 + CGFloat(s) * 7.31)
        let a = Int(Orb.hashD(seg, CGFloat(s) * 3.1 + 1.7) * CGFloat(nodeN))
        let b = Int(Orb.hashD(seg, CGFloat(s) * 5.7 + 4.2) * CGFloat(nodeN))
        guard a != b, a < nodeN, b < nodeN else { continue }
        let f = Orb.frac(t * 0.55 + CGFloat(s) * 7.31)
        let x = Orb.lerp(nodes[a].0, nodes[b].0, f)
        let y = Orb.lerp(nodes[a].1, nodes[b].1, f)
        let z = Orb.lerp(nodes[a].2, nodes[b].2, f)
        let l = max(1e-6, sqrt(x * x + y * y + z * z))
        let (px, py, zr) = pt(x / l, y / l, z / l)
        let depth = (zr + 1) / 2
        dots.append(OrbDot(x: px, y: py, z: zr,
                           r: (nodeR * 1.5 + nodeRDepth * depth) * rs,
                           white: 0.05, a: 0.5 + 0.5 * depth))
    }

    Orb.paintLines(&ctx, lines, dark)
    Orb.paint(&ctx, dots, dark, 0.3)
}

// MARK: Ring — loading a local model

/// A face-on ring whose radius undulates, so it reads as something slowly
/// breathing rather than travelling. Reserved for waits the user cannot
/// hurry — reading a local model into memory — where a fast, busy mark would
/// only make the wait feel worse.
private func drawRing(_ ctx: inout GraphicsContext, _ size: CGFloat, _ time: Double, _ dark: Bool) {
    let t = CGFloat(time)
    let cx = size / 2, cy = size / 2
    let R = (size / 2) * 0.78
    // spin 0 freezes the 3D tumble, leaving only the travelling undulation.
    let camTilt: CGFloat = 0.3
    let pt = Orb.makeProj(yaw: 0, tilt: camTilt, cx: cx, cy: cy, scale: 1)
    let rs = Orb.radiusScale(size, 0.6)

    let wobMul: CGFloat = 0.34
    let rBase: CGFloat = 1.7842, rDepth: CGFloat = 2.7574

    // Face-on cancels the camera tilt so the band's great circle projects as
    // a true circle instead of ribbon's tilted ellipse.
    let ya: CGFloat = 0
    let ta = -camTilt
    let ux = cos(ya), uy: CGFloat = 0, uz = sin(ya)
    let vx = -uz * sin(ta), vy = cos(ta), vz = ux * sin(ta)
    let nx = uy * vz - uz * vy
    let ny = uz * vx - ux * vz
    let nz = ux * vy - uy * vx

    // Radial lobes swell past R, so the base radius is pulled in by most of
    // the wobble amplitude. The silhouette then stays inside the frame no
    // matter how far the deformation is pushed.
    let wobAmp = 0.23 * wobMul
    let baseR = R / (1 + 0.85 * wobAmp)

    let lanes = 8, segs = 22
    var dots: [OrbDot] = []
    dots.reserveCapacity(lanes * segs)

    for w in 0..<lanes {
        let laneOff = (CGFloat(w) - CGFloat(lanes - 1) / 2) * 0.075
        let edge = abs(CGFloat(w) - CGFloat(lanes - 1) / 2) / max(1, CGFloat(lanes - 1) / 2)
        for k in 0..<segs {
            let a = (CGFloat(k) / CGFloat(segs)) * 2 * .pi
            let wob = (0.16 * sin(a * 3 - t * 1.7 + CGFloat(w) * 0.22)
                       + 0.07 * sin(a * 5 + t * 1.1)) * wobMul
            // Face-on modulates the in-plane radius, so lobes genuinely swell
            // outward. A normal-direction wobble would be cancelled by the
            // re-normalisation below and could only ever pull dots inward.
            let radial = 1 + wob
            let off = laneOff
            let x = ux * cos(a) + vx * sin(a) + nx * off
            let y = uy * cos(a) + vy * sin(a) + ny * off
            let z = uz * cos(a) + vz * sin(a) + nz * off
            let l = max(1e-6, sqrt(x * x + y * y + z * z))
            let rr = baseR * radial
            let (px, py, zr) = pt((x / l) * rr, (y / l) * rr, (z / l) * rr)
            let depth = (zr / R + 1) / 2
            dots.append(OrbDot(
                x: px, y: py, z: zr,
                r: (rBase + rDepth * depth) * (1 - 0.25 * edge) * rs,
                white: 0.52 - 0.44 * depth + 0.18 * edge,
                a: 0.4 + 0.6 * depth
            ))
        }
    }
    Orb.paint(&ctx, dots, dark, 0.3)
}
