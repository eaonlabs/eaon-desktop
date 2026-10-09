import SwiftUI

extension UInt32 {
    /// "#3E86C6" or "3E86C6"; nil for anything that isn't six hex digits.
    init?(hexString: String) {
        let text = hexString.trimmingCharacters(in: .whitespaces).replacingOccurrences(of: "#", with: "")
        guard text.count == 6, let value = UInt32(text, radix: 16) else { return nil }
        self = value
    }
}

extension Color {
    /// An agent's colour from the "#RRGGBB" the desktop and the phone store; blue if it isn't one.
    init(hexString: String) {
        self.init(hex: UInt32(hexString: hexString) ?? 0x3E86C6)
    }
}

/// How a face lives: when it blinks and where it glances, worked out from the
/// clock and a per-face seed, so every face moves on its own beat and a row of
/// them is never in step. Pure, so it can be tested and costs no state.
enum FaceMotion {
    struct Pose: Equatable {
        /// 1 open, near 0 at the bottom of a blink.
        var openness: Double
        /// Where the eyes look, in the face's 100-unit grid.
        var gazeX: Double
        var gazeY: Double
    }

    private static let blinkSlot = 4.0
    private static let blinkLength = 0.2
    private static let gazeSlot = 2.7
    private static let gazeEase = 0.32

    static func pose(at time: Double, seed: UInt64) -> Pose {
        Pose(openness: openness(at: time, seed: seed), gazeX: gaze(at: time, seed: seed).x, gazeY: gaze(at: time, seed: seed).y)
    }

    static func openness(at time: Double, seed: UInt64) -> Double {
        let slot = Int((time / blinkSlot).rounded(.down))
        let into = time - Double(slot) * blinkSlot
        // One blink a slot, at a random moment; now and then a second one right after.
        let start = 0.4 + random(seed, slot, 0) * 3.0
        let double = random(seed, slot, 1) < 0.28
        var closed = 0.0
        for (index, begin) in ([start] + (double ? [start + 0.32] : [])).enumerated() {
            _ = index
            let u = (into - begin) / blinkLength
            if u > 0 && u < 1 { closed = max(closed, sin(.pi * u)) }
        }
        return 1 - 0.92 * closed
    }

    static func gaze(at time: Double, seed: UInt64) -> (x: Double, y: Double) {
        let slot = Int((time / gazeSlot).rounded(.down))
        let into = time - Double(slot) * gazeSlot
        let from = target(seed, slot - 1)
        let to = target(seed, slot)
        let t = smoothstep(0, gazeEase, into)
        return (mix(from.x, to.x, t), mix(from.y, to.y, t))
    }

    private static func target(_ seed: UInt64, _ slot: Int) -> (x: Double, y: Double) {
        // Often a glance back to the middle, so the face doesn't look shifty.
        if random(seed, slot, 2) < 0.3 { return (0, 0) }
        return ((random(seed, slot, 3) - 0.5) * 5, (random(seed, slot, 4) - 0.5) * 2.8)
    }

    /// 0…1, the same every time for the same inputs.
    private static func random(_ seed: UInt64, _ slot: Int, _ salt: UInt64) -> Double {
        var z = seed &+ UInt64(bitPattern: Int64(slot)) &* 0x9E37_79B9_7F4A_7C15 &+ salt &* 0xD6E8_FEB8_6659_FD93
        z = (z ^ (z >> 30)) &* 0xBF58_476D_1CE4_E5B9
        z = (z ^ (z >> 27)) &* 0x94D0_49BB_1331_11EB
        z ^= z >> 31
        return Double(z >> 11) / Double(1 << 53)
    }
}

/// An agent's face: a flat circle in its colour with two rounded eyes, drawn
/// on the desktop's 100-unit grid (eyes centred at x 33.3 and 66.7, y 40). The
/// body never leaves its circle; the eyes do the living, and the mood is the
/// shape of the eyes. At work they narrow into focus and a ring in the agent's
/// colour chases round the face. A blue dot says it is waiting on you.
struct AgentFace: View {
    var colorHex: String
    var mood: AgentMood = .neutral
    var size: CGFloat = 44
    var busy = false
    var attention = false
    var seed: UInt64 = 7

    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Environment(\.colorScheme) private var colorScheme

    /// The ring needs room to be seen; tiny faces get the focused eyes only.
    private var showsRing: Bool { busy && size >= 40 }
    private var animated: Bool { !reduceMotion && size >= 24 && mood != .dead && mood != .asleep || (busy && !reduceMotion) }

    init(colorHex: String, mood: AgentMood = .neutral, size: CGFloat = 44, busy: Bool = false, attention: Bool = false, seed: UInt64? = nil) {
        self.colorHex = colorHex
        self.mood = mood
        self.size = size
        self.busy = busy
        self.attention = attention
        self.seed = seed ?? UInt64(truncatingIfNeeded: abs(colorHex.hashValue))
    }

    /// An agent's own face: the seed comes from its id, so it keeps its rhythm across launches.
    init(agent: Agent, size: CGFloat = 44) {
        self.init(
            colorHex: agent.colorHex,
            mood: agent.mood,
            size: size,
            busy: agent.isWorking,
            attention: agent.needsYou,
            seed: Self.seed(for: agent.id)
        )
    }

    /// A stable number from text (String.hashValue changes every launch).
    static func seed(for text: String) -> UInt64 {
        var hash: UInt64 = 0xCBF2_9CE4_8422_2325
        for byte in text.utf8 {
            hash ^= UInt64(byte)
            hash = hash &* 0x0000_0100_0000_01B3
        }
        return hash
    }

    var body: some View {
        // The canvas is larger than the face, so the ring (r 57 on a 50 body) can draw outside it.
        let canvasSide = size * 1.3
        TimelineView(.animation(minimumInterval: 1.0 / 30, paused: !animated)) { context in
            Canvas { graphics, _ in
                draw(in: &graphics, canvasSide: canvasSide, time: context.date.timeIntervalSinceReferenceDate)
            }
            .frame(width: canvasSide, height: canvasSide)
        }
        .frame(width: size, height: size)
        .accessibilityElement()
        .accessibilityLabel(label)
    }

    private var label: String {
        var text = "\(mood.rawValue) face"
        if busy { text += ", working" }
        if attention { text += ", needs you" }
        return text
    }

    // MARK: Drawing

    private func draw(in graphics: inout GraphicsContext, canvasSide: CGFloat, time: Double) {
        let unit = size / 100
        let origin = CGPoint(x: (canvasSide - size) / 2, y: (canvasSide - size) / 2)
        let body = Color(hexString: colorHex)
        let eye = eyeColor

        // Breathing: a scale too small to notice, except as "alive".
        let breath = animated ? 1 + 0.012 * sin(time * 1.3 + Double(seed % 7)) : 1
        graphics.translateBy(x: origin.x + size / 2, y: origin.y + size / 2)
        graphics.scaleBy(x: unit * breath, y: unit * breath)
        graphics.translateBy(x: -50, y: -50)

        if showsRing { drawRing(in: &graphics, color: body, time: time) }
        graphics.fill(Path(ellipseIn: CGRect(x: 0, y: 0, width: 100, height: 100)), with: .color(body))

        let pose = animated && !busy ? FaceMotion.pose(at: time, seed: seed) : FaceMotion.Pose(openness: 1, gazeX: 0, gazeY: 0)
        var openness = mood == .asleep || mood == .dead ? 1 : pose.openness
        var gazeX = pose.gazeX
        var gazeY = pose.gazeY
        if let bias = Self.gazeBias[mood] {
            gazeX += bias.x
            gazeY += bias.y
        }
        var focus: CGFloat = 1
        if busy {
            // Working: the eyes narrow and read from side to side.
            focus = 0.78
            gazeX = animated ? 2.6 * sin(time * 1.7) : 0
            openness = 1
        }

        for side in 0..<2 {
            var eyeContext = graphics
            let centreX = side == 0 ? 33.3 : 66.7
            eyeContext.translateBy(x: centreX + gazeX, y: 40 + gazeY)
            if side == 1 { eyeContext.scaleBy(x: -1, y: 1) }
            eyeContext.scaleBy(x: 1, y: max(0.06, openness * focus))
            Self.drawEye(mood: mood, side: side, in: &eyeContext, color: eye, lineWidth: max(2.2, 120 / size))
        }

        if attention {
            let dot = CGRect(x: 1, y: 1, width: 22, height: 22)
            graphics.fill(Path(ellipseIn: dot.insetBy(dx: -1.5, dy: -1.5)), with: .color(colorScheme == .dark ? Palette.pageDark : Palette.pageLight))
            graphics.fill(Path(ellipseIn: dot), with: .color(Color(hex: 0x0A84FF)))
        }
    }

    private func drawRing(in graphics: inout GraphicsContext, color: Color, time: Double) {
        let radius: CGFloat = 57
        let width = min(4.5, max(3, 280 / size))
        let rect = CGRect(x: 50 - radius, y: 50 - radius, width: radius * 2, height: radius * 2)
        graphics.stroke(Path(ellipseIn: rect), with: .color(color.opacity(0.25)), lineWidth: width)
        // An arc a quarter of the way round, chasing itself.
        let turn = (time / 1.5).truncatingRemainder(dividingBy: 1)
        var arc = Path()
        arc.addArc(center: CGPoint(x: 50, y: 50), radius: radius, startAngle: .degrees(turn * 360), endAngle: .degrees(turn * 360 + 100), clockwise: false)
        graphics.stroke(arc, with: .color(color), style: StrokeStyle(lineWidth: width, lineCap: .round))
    }

    /// Where each mood tends to look: down when sad or sleepy, up when curious.
    private static let gazeBias: [AgentMood: (x: Double, y: Double)] = [
        .sad: (0, 2.6), .sleepy: (0, 1.6), .curious: (0.8, -1.6)
    ]

    /// White eyes, unless the body is so light that white would vanish into it.
    private var eyeColor: Color {
        let value = UInt32(hexString: colorHex) ?? 0x3E86C6
        return luminance(hex: value) > 0.62 ? Color(hex: 0x1D2127) : .white
    }

    // MARK: The eyes

    /// One eye, in its own coordinates (centre 0,0), for the left side; the right is mirrored by the caller.
    static func drawEye(mood: AgentMood, side: Int, in graphics: inout GraphicsContext, color: Color, lineWidth: CGFloat) {
        switch mood {
        case .dead:
            var cross = Path()
            cross.move(to: CGPoint(x: -5.4, y: -5.4)); cross.addLine(to: CGPoint(x: 5.4, y: 5.4))
            cross.move(to: CGPoint(x: 5.4, y: -5.4)); cross.addLine(to: CGPoint(x: -5.4, y: 5.4))
            graphics.stroke(cross, with: .color(color), style: StrokeStyle(lineWidth: 4.6, lineCap: .square))
        case .asleep:
            var line = Path()
            line.move(to: CGPoint(x: -7, y: 6)); line.addLine(to: CGPoint(x: 7, y: 6))
            graphics.stroke(line, with: .color(color), style: StrokeStyle(lineWidth: lineWidth, lineCap: .round))
        case .excited:
            // Delighted: eyes squeezed into upturned arcs, ^ ^.
            var arc = Path()
            arc.move(to: CGPoint(x: -7.4, y: 4.6))
            arc.addQuadCurve(to: CGPoint(x: 7.4, y: 4.6), control: CGPoint(x: 0, y: -9.4))
            graphics.stroke(arc, with: .color(color), style: StrokeStyle(lineWidth: max(4.4, lineWidth), lineCap: .round))
        default:
            graphics.fill(shape(for: mood, side: side), with: .color(color))
        }
    }

    private static let k: CGFloat = 0.5523

    /// A semicircle over the top of centre-line `cy`, from the left edge to the right.
    private static func topArc(_ path: inout Path, cy: CGFloat, r: CGFloat) {
        path.addCurve(to: CGPoint(x: 0, y: cy - r), control1: CGPoint(x: -r, y: cy - k * r), control2: CGPoint(x: -k * r, y: cy - r))
        path.addCurve(to: CGPoint(x: r, y: cy), control1: CGPoint(x: k * r, y: cy - r), control2: CGPoint(x: r, y: cy - k * r))
    }

    /// A semicircle under centre-line `cy`, from the right edge to the left.
    private static func bottomArc(_ path: inout Path, cy: CGFloat, r: CGFloat) {
        path.addCurve(to: CGPoint(x: 0, y: cy + r), control1: CGPoint(x: r, y: cy + k * r), control2: CGPoint(x: k * r, y: cy + r))
        path.addCurve(to: CGPoint(x: -r, y: cy), control1: CGPoint(x: -k * r, y: cy + r), control2: CGPoint(x: -r, y: cy + k * r))
    }

    /// Eye outlines for the left eye, from the desktop's WorkerFace.
    static func shape(for mood: AgentMood, side: Int) -> Path {
        var path = Path()
        let w: CGFloat = 6.75
        switch mood {
        case .happy:
            // Rounded top, the lower edge lifted into an arc: smiling eyes.
            path.move(to: CGPoint(x: -w, y: -5.85))
            topArc(&path, cy: -5.85, r: w)
            path.addLine(to: CGPoint(x: w, y: 2.4))
            path.addQuadCurve(to: CGPoint(x: -w, y: 2.4), control: CGPoint(x: 0, y: -1.9))
        case .serious:
            path.move(to: CGPoint(x: -w, y: -5)); path.addLine(to: CGPoint(x: w, y: -5)); path.addLine(to: CGPoint(x: w, y: 4.25))
            bottomArc(&path, cy: 4.25, r: w)
        case .curious:
            if side == 1 {
                // One eye squints: a raised brow.
                path.move(to: CGPoint(x: -w, y: -1.8)); path.addLine(to: CGPoint(x: w, y: -1.8)); path.addLine(to: CGPoint(x: w, y: 4.25))
                bottomArc(&path, cy: 4.25, r: w)
            } else {
                path.move(to: CGPoint(x: -7.2, y: -6.6))
                topArc(&path, cy: -6.6, r: 7.2)
                path.addLine(to: CGPoint(x: 7.2, y: 5.6))
                bottomArc(&path, cy: 5.6, r: 7.2)
            }
        case .surprised:
            path.addEllipse(in: CGRect(x: -9.4, y: -12.4, width: 18.8, height: 24.8))
        case .sad:
            // Lids sloping down to the outside, the inner corners raised.
            path.move(to: CGPoint(x: -w, y: -1.4)); path.addLine(to: CGPoint(x: w, y: -7.2)); path.addLine(to: CGPoint(x: w, y: 4.25))
            bottomArc(&path, cy: 4.25, r: w)
        case .angry:
            path.move(to: CGPoint(x: -w, y: -7.6)); path.addLine(to: CGPoint(x: w, y: -1.6)); path.addLine(to: CGPoint(x: w, y: 4.25))
            bottomArc(&path, cy: 4.25, r: w)
        case .sleepy:
            // Heavy lids: only the lower half of each eye open.
            path.move(to: CGPoint(x: -w, y: 0.6)); path.addLine(to: CGPoint(x: w, y: 0.6)); path.addLine(to: CGPoint(x: w, y: 4.25))
            bottomArc(&path, cy: 4.25, r: w)
        default:
            // A full pill: semicircles at y -5.85 and +5.85.
            path.move(to: CGPoint(x: -w, y: -5.85))
            topArc(&path, cy: -5.85, r: w)
            path.addLine(to: CGPoint(x: w, y: 5.85))
            bottomArc(&path, cy: 5.85, r: w)
        }
        path.closeSubpath()
        return path
    }
}

extension Palette {
    /// The page behind a face, as plain colours, for drawing into a Canvas, which can't resolve appearance-dependent colours.
    static let pageLight = Color(hex: 0xFFFFFF)
    static let pageDark = Color(hex: 0x000000)
}

#Preview {
    VStack(spacing: 18) {
        ForEach([[AgentMood.neutral, .happy, .excited, .serious], [.curious, .surprised, .sad, .angry], [.sleepy, .asleep, .dead, .neutral]], id: \.self) { row in
            HStack(spacing: 18) {
                ForEach(Array(row.enumerated()), id: \.offset) { index, mood in
                    AgentFace(colorHex: AgentPalette.hex[index * 2], mood: mood, size: 64, busy: false, attention: false, seed: UInt64(index + 1))
                }
            }
        }
    }
    .padding()
}
