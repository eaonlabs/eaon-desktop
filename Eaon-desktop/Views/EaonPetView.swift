import SwiftUI

// The on-screen companion's face. One coral orb; all expression lives in two
// white eyes that morph between shapes, plus a small pointing hand that
// springs out when the pet has something on screen to show you. Ported from
// the motion spec: every state is a transform/opacity/shape change, layered
// so the ambient life (float, breathe, blink, idle glances) never fights the
// mood transitions. Mood and pointing angle are owned by
// `EaonPetController.shared`; this view only renders and animates them.
// Asking the pet about the screen is NOT a view here — it's the Quick
// Assistant's own "My screen" attach (see `QuickAssistantViewModel`).

// MARK: - Geometry

/// A rounded shape with four independently-sized corners, animatable so the
/// eyes can morph smoothly between pill / dash / dome / rounded-rect /
/// teardrop (the fang used for `angry`). The `error` X is a separate overlay.
struct CornerRadii: Equatable {
    var tl: CGFloat
    var tr: CGFloat
    var br: CGFloat
    var bl: CGFloat
    static func all(_ v: CGFloat) -> CornerRadii { CornerRadii(tl: v, tr: v, br: v, bl: v) }
}

struct EyeShape: Shape {
    var radii: CornerRadii

    var animatableData: AnimatablePair<AnimatablePair<CGFloat, CGFloat>, AnimatablePair<CGFloat, CGFloat>> {
        get { AnimatablePair(AnimatablePair(radii.tl, radii.tr), AnimatablePair(radii.br, radii.bl)) }
        set {
            radii = CornerRadii(
                tl: newValue.first.first, tr: newValue.first.second,
                br: newValue.second.first, bl: newValue.second.second
            )
        }
    }

    func path(in rect: CGRect) -> Path {
        let limit = min(rect.width, rect.height) / 2
        let tl = max(0, min(radii.tl, limit))
        let tr = max(0, min(radii.tr, limit))
        let br = max(0, min(radii.br, limit))
        let bl = max(0, min(radii.bl, limit))
        let x = rect.minX, y = rect.minY, w = rect.width, h = rect.height

        var p = Path()
        p.move(to: CGPoint(x: x + w / 2, y: y))
        p.addLine(to: CGPoint(x: x + w - tr, y: y))
        p.addArc(center: CGPoint(x: x + w - tr, y: y + tr), radius: tr,
                 startAngle: .degrees(-90), endAngle: .degrees(0), clockwise: false)
        p.addLine(to: CGPoint(x: x + w, y: y + h - br))
        p.addArc(center: CGPoint(x: x + w - br, y: y + h - br), radius: br,
                 startAngle: .degrees(0), endAngle: .degrees(90), clockwise: false)
        p.addLine(to: CGPoint(x: x + bl, y: y + h))
        p.addArc(center: CGPoint(x: x + bl, y: y + h - bl), radius: bl,
                 startAngle: .degrees(90), endAngle: .degrees(180), clockwise: false)
        p.addLine(to: CGPoint(x: x, y: y + tl))
        p.addArc(center: CGPoint(x: x + tl, y: y + tl), radius: tl,
                 startAngle: .degrees(180), endAngle: .degrees(270), clockwise: false)
        p.closeSubpath()
        return p
    }
}

/// A whole-shape override that the rounded-rect `EyeShape` can't express —
/// the crossed bars of `error` and the heart of `love`. `.none` uses the
/// normal morphable `EyeShape`.
enum EyeSpecial: Equatable {
    case none, x, heart
}

/// Everything about one eye in one pose. Interpolating between two of these
/// (via the mood animation) is what produces every morph.
struct EyePose: Equatable {
    var dx: CGFloat
    var dy: CGFloat
    var rot: Double
    var w: CGFloat
    var h: CGFloat
    var radii: CornerRadii
    var special: EyeSpecial = .none
}

/// Left eye, right eye, head tilt, and horizontal gaze offset for a mood.
/// Numbers are tuned against the reference frames at this 120pt body size.
private func eyePoses(_ mood: EaonPetMood, phase: Int) -> (EyePose, EyePose, Double, CGFloat) {
    let gap: CGFloat = 26
    switch mood {
    case .ready:
        return (EyePose(dx: -gap, dy: -4, rot: 0, w: 22, h: 44, radii: .all(11)),
                EyePose(dx: gap, dy: -4, rot: 0, w: 22, h: 44, radii: .all(11)), 0, 0)
    case .sleep:
        return (EyePose(dx: -gap + 2, dy: 4, rot: 0, w: 20, h: 6, radii: .all(3)),
                EyePose(dx: gap - 2, dy: 4, rot: 0, w: 20, h: 6, radii: .all(3)), 0, 0)
    case .working:
        let up: CGFloat = -12, down: CGFloat = 7
        return (EyePose(dx: -gap, dy: phase == 0 ? up : down, rot: 0, w: 22, h: 44, radii: .all(8)),
                EyePose(dx: gap, dy: phase == 0 ? down : up, rot: 0, w: 22, h: 44, radii: .all(8)), 0, 0)
    case .listening:
        // Wide and still — attention, not activity. Deliberately the calmest
        // pose in the set: it's the face that says "the mic is open," so it
        // must be unmistakable and must not twitch while you're mid-sentence.
        return (EyePose(dx: -gap, dy: -5, rot: 0, w: 26, h: 52, radii: .all(13)),
                EyePose(dx: gap, dy: -5, rot: 0, w: 26, h: 52, radii: .all(13)), 0, 0)
    case .speaking:
        // Two-frame squash on the same seesaw timer `.working` uses — the
        // pet has no mouth, so "talking" reads as a rhythmic bob of the eyes.
        let tall: CGFloat = 44, squat: CGFloat = 30
        let h = phase == 0 ? tall : squat
        return (EyePose(dx: -gap, dy: phase == 0 ? -4 : 2, rot: 0, w: 22, h: h, radii: .all(11)),
                EyePose(dx: gap, dy: phase == 0 ? -4 : 2, rot: 0, w: 22, h: h, radii: .all(11)), 0, 0)
    case .lookLeft:
        return (EyePose(dx: -31, dy: -8, rot: -11, w: 22, h: 44, radii: .all(7)),
                EyePose(dx: 6, dy: -8, rot: -11, w: 22, h: 44, radii: .all(7)), -6, -9)
    case .lookRight:
        return (EyePose(dx: -6, dy: -8, rot: 11, w: 22, h: 44, radii: .all(7)),
                EyePose(dx: 31, dy: -8, rot: 11, w: 22, h: 44, radii: .all(7)), 6, 9)
    case .wink:
        return (EyePose(dx: -27, dy: 7, rot: 0, w: 18, h: 6, radii: .all(3)),
                EyePose(dx: 27, dy: -8, rot: 0, w: 22, h: 44, radii: .all(11)), -5, 0)
    case .happy:
        // Two domes (⌒ ⌒) — closed, upward-curved delight.
        return (EyePose(dx: -gap, dy: -4, rot: 0, w: 24, h: 13,
                        radii: CornerRadii(tl: 12, tr: 12, br: 2, bl: 2)),
                EyePose(dx: gap, dy: -4, rot: 0, w: 24, h: 13,
                        radii: CornerRadii(tl: 12, tr: 12, br: 2, bl: 2)), 0, 0)
    case .laughing:
        // Upturned smile-eyes (‿ ‿) — flat top, round bottom: the big
        // squeezed-shut laugh, distinct from happy's ⌒ domes.
        return (EyePose(dx: -gap, dy: -2, rot: 0, w: 27, h: 15,
                        radii: CornerRadii(tl: 2, tr: 2, br: 13, bl: 13)),
                EyePose(dx: gap, dy: -2, rot: 0, w: 27, h: 15,
                        radii: CornerRadii(tl: 2, tr: 2, br: 13, bl: 13)), 0, 0)
    case .love:
        return (EyePose(dx: -gap, dy: -3, rot: 0, w: 28, h: 26, radii: .all(0), special: .heart),
                EyePose(dx: gap, dy: -3, rot: 0, w: 28, h: 26, radii: .all(0), special: .heart), 0, 0)
    case .surprised:
        // Wide round eyes, pulled slightly apart — the classic startle.
        return (EyePose(dx: -gap - 1, dy: -2, rot: 0, w: 31, h: 31, radii: .all(16)),
                EyePose(dx: gap + 1, dy: -2, rot: 0, w: 31, h: 31, radii: .all(16)), 0, 0)
    case .confused:
        // Asymmetric — one normal eye, one small and raised — with a head
        // tilt: reads as "huh?".
        return (EyePose(dx: -gap, dy: -2, rot: 0, w: 22, h: 40, radii: .all(11)),
                EyePose(dx: gap, dy: -12, rot: 0, w: 17, h: 21, radii: .all(9)), 9, 3)
    case .sad:
        // Droopy dashes, outer ends sagging down.
        return (EyePose(dx: -gap, dy: 6, rot: -16, w: 21, h: 7, radii: .all(3.5)),
                EyePose(dx: gap, dy: 6, rot: 16, w: 21, h: 7, radii: .all(3.5)), 0, 0)
    case .angry:
        return (EyePose(dx: -24, dy: -2, rot: -24, w: 21, h: 51,
                        radii: CornerRadii(tl: 2, tr: 11, br: 11, bl: 11)),
                EyePose(dx: 24, dy: -2, rot: 24, w: 21, h: 51,
                        radii: CornerRadii(tl: 11, tr: 2, br: 11, bl: 11)), 0, 0)
    case .error:
        return (EyePose(dx: -gap, dy: -4, rot: 0, w: 27, h: 27, radii: .all(4), special: .x),
                EyePose(dx: gap, dy: -4, rot: 0, w: 27, h: 27, radii: .all(4), special: .x), 0, 0)
    }
}

private extension Color {
    static let petCoralTop = Color(red: 0xEE / 255.0, green: 0x80 / 255.0, blue: 0x5D / 255.0)
    static let petCoral    = Color(red: 0xE7 / 255.0, green: 0x72 / 255.0, blue: 0x4F / 255.0)
    static let petCoralBot = Color(red: 0xDC / 255.0, green: 0x60 / 255.0, blue: 0x38 / 255.0)
}

// MARK: - Eye views

private struct PetXEyes: View {
    var body: some View {
        ZStack {
            Capsule().fill(Color.white).frame(width: 27, height: 8).rotationEffect(.degrees(45))
            Capsule().fill(Color.white).frame(width: 27, height: 8).rotationEffect(.degrees(-45))
        }
    }
}

/// A classic two-lobe heart, filled — the `love` eyes.
private struct HeartShape: Shape {
    func path(in rect: CGRect) -> Path {
        let w = rect.width, h = rect.height
        var p = Path()
        p.move(to: CGPoint(x: rect.midX, y: rect.minY + h))
        p.addCurve(to: CGPoint(x: rect.minX, y: rect.minY + h / 4),
                   control1: CGPoint(x: rect.midX, y: rect.minY + h * 3 / 4),
                   control2: CGPoint(x: rect.minX, y: rect.minY + h / 2))
        p.addArc(center: CGPoint(x: rect.minX + w / 4, y: rect.minY + h / 4), radius: w / 4,
                 startAngle: .degrees(180), endAngle: .degrees(0), clockwise: false)
        p.addArc(center: CGPoint(x: rect.minX + w * 3 / 4, y: rect.minY + h / 4), radius: w / 4,
                 startAngle: .degrees(180), endAngle: .degrees(0), clockwise: false)
        p.addCurve(to: CGPoint(x: rect.midX, y: rect.minY + h),
                   control1: CGPoint(x: rect.maxX, y: rect.minY + h / 2),
                   control2: CGPoint(x: rect.midX, y: rect.minY + h * 3 / 4))
        p.closeSubpath()
        return p
    }
}

private struct EyeView: View {
    let pose: EyePose
    var body: some View {
        ZStack {
            EyeShape(radii: pose.radii)
                .fill(Color.white)
                .frame(width: pose.w, height: pose.h)
                .opacity(pose.special == .none ? 1 : 0)
            PetXEyes()
                .opacity(pose.special == .x ? 1 : 0)
            HeartShape()
                .fill(Color.white)
                .frame(width: pose.w, height: pose.h)
                .opacity(pose.special == .heart ? 1 : 0)
        }
        .rotationEffect(.degrees(pose.rot))
        .offset(x: pose.dx, y: pose.dy)
    }
}

// MARK: - The pet

struct EaonPetView: View {
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    private let controller = EaonPetController.shared

    @State private var floatUp = false
    @State private var breathe: CGFloat = 1
    @State private var blink: CGFloat = 1
    @State private var workPhase = 0
    @State private var saccade: CGFloat = 0
    @State private var poke: CGFloat = 1
    /// Transient whole-body scale for reaction punctuation — a startle pop
    /// on `surprised`, a bounce on `laughing`, a heartbeat on `love`.
    @State private var reactPop: CGFloat = 1
    @State private var didStartAmbient = false

    // Fixed cadence for the working seesaw — only applied while working.
    private let seesaw = Timer.publish(every: 0.66, on: .main, in: .common).autoconnect()

    private var frameSize: NSSize { EaonPetController.petSize }

    var body: some View {
        let mood = controller.mood
        let pointing = controller.pointingAngle
        let (leftPose, rightPose, tilt, gazeX) = eyePoses(mood, phase: workPhase)
        // While pointing, the eyes track the hand.
        let pointGaze: CGSize = pointing.map {
            CGSize(width: cos($0) * 9, height: sin($0) * 7)
        } ?? .zero

        ZStack {
            // Contact shadow — shrinks and fades as the body floats up,
            // giving it weight (follow-through).
            Ellipse()
                .fill(RadialGradient(colors: [Color.black.opacity(0.32), .clear],
                                     center: .center, startRadius: 1, endRadius: 46))
                .frame(width: 104, height: 20)
                .scaleEffect(floatUp ? 0.84 : 1.0)
                .opacity(floatUp ? 0.5 : 0.85)
                .offset(y: 74)
                .blur(radius: 2.5)

            // The pointing hand lives behind the body edge and rotates
            // around its center, so it emerges from wherever it's aimed.
            if let angle = pointing {
                hand(angle: angle)
                    .transition(.scale(scale: 0.35).combined(with: .opacity))
            }

            ZStack {
                petBody(mood: mood)
                eyes(leftPose: leftPose, rightPose: rightPose, tilt: tilt,
                     gazeX: gazeX + pointGaze.width, gazeY: pointGaze.height, mood: mood)
            }
            .frame(width: 120, height: 120)
            .contentShape(Circle())
            .onTapGesture { tapped() }
            .scaleEffect(breathe * poke * reactPop)
            .offset(y: floatUp ? -6 : 0)
        }
        .animation(.spring(response: 0.42, dampingFraction: 0.68), value: pointing)
        .frame(width: frameSize.width, height: frameSize.height)
        .onAppear { startAmbient() }
        .onReceive(seesaw) { _ in
            // `.speaking` rides the same two-frame timer as `.working`, but
            // faster — a talking rhythm rather than a working seesaw.
            let mood = controller.mood
            guard mood == .working || mood == .speaking, !reduceMotion else { return }
            withAnimation(.easeInOut(duration: mood == .speaking ? 0.22 : 0.55)) {
                workPhase = workPhase == 0 ? 1 : 0
            }
        }
        .onChange(of: controller.mood) { _, newMood in
            reactToMoodChange(newMood)
        }
    }

    private func petBody(mood: EaonPetMood) -> some View {
        Circle()
            .fill(LinearGradient(colors: [.petCoralTop, .petCoral, .petCoralBot],
                                 startPoint: .top, endPoint: .bottom))
            .overlay(
                Circle().fill(RadialGradient(
                    colors: [Color.white.opacity(0.22), .clear],
                    center: UnitPoint(x: 0.33, y: 0.26), startRadius: 1, endRadius: 66
                ))
            )
            .overlay(Circle().stroke(Color.white.opacity(0.10), lineWidth: 1).blur(radius: 0.5))
            .frame(width: 120, height: 120)
            .saturation(bodySaturation(mood))
            .brightness(bodyBrightness(mood))
            .shadow(color: Color(red: 0.82, green: 0.33, blue: 0.17).opacity(0.5), radius: 14, x: 0, y: 10)
            .animation(.easeOut(duration: 0.35), value: mood)
    }

    private func bodySaturation(_ mood: EaonPetMood) -> Double {
        switch mood {
        case .angry: 1.2
        case .love: 1.18   // flushed and warm
        case .error: 0.5
        case .sad: 0.88
        default: 1.0
        }
    }

    private func bodyBrightness(_ mood: EaonPetMood) -> Double {
        switch mood {
        case .error: -0.05
        case .love: 0.04
        default: 0
        }
    }

    /// Reaction punctuation: a quick physical beat on the emotions that read
    /// better with motion than shape alone. Guarded by reduce-motion.
    private func reactToMoodChange(_ mood: EaonPetMood) {
        guard !reduceMotion else { return }
        switch mood {
        case .surprised:
            // Startle: snap bigger, spring back.
            withAnimation(.spring(response: 0.16, dampingFraction: 0.5)) { reactPop = 1.12 }
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.16) {
                withAnimation(.spring(response: 0.4, dampingFraction: 0.62)) { reactPop = 1 }
            }
        case .laughing:
            // A couple of giddy bounces.
            bounce(count: 3)
        case .love:
            // Double heartbeat.
            heartbeat()
        default:
            if reactPop != 1 {
                withAnimation(.easeOut(duration: 0.2)) { reactPop = 1 }
            }
        }
    }

    private func bounce(count: Int, index: Int = 0) {
        guard index < count else {
            withAnimation(.easeOut(duration: 0.18)) { reactPop = 1 }
            return
        }
        withAnimation(.easeOut(duration: 0.14)) { reactPop = 1.08 }
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.14) {
            withAnimation(.easeIn(duration: 0.14)) { reactPop = 0.97 }
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.14) {
                if EaonPetController.shared.mood == .laughing {
                    bounce(count: count, index: index + 1)
                } else {
                    withAnimation(.easeOut(duration: 0.16)) { reactPop = 1 }
                }
            }
        }
    }

    private func heartbeat() {
        func beat(_ then: @escaping () -> Void) {
            withAnimation(.easeOut(duration: 0.12)) { reactPop = 1.1 }
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.12) {
                withAnimation(.easeIn(duration: 0.16)) { reactPop = 1 }
                DispatchQueue.main.asyncAfter(deadline: .now() + 0.16, execute: then)
            }
        }
        beat { beat {} }
    }

    private func eyes(leftPose: EyePose, rightPose: EyePose, tilt: Double,
                      gazeX: CGFloat, gazeY: CGFloat, mood: EaonPetMood) -> some View {
        ZStack {
            EyeView(pose: leftPose)
            EyeView(pose: rightPose)
        }
        .frame(width: 120, height: 120)
        .scaleEffect(x: 1, y: blink, anchor: .center)
        .rotationEffect(.degrees(tilt))
        .offset(x: gazeX + saccade, y: gazeY)
        .animation(.spring(response: 0.42, dampingFraction: 0.82), value: mood)
        .animation(.easeInOut(duration: 0.55), value: workPhase)
        .animation(.easeOut(duration: 0.4), value: saccade)
        .animation(.easeOut(duration: 0.35), value: gazeY)
    }

    /// The little pointing arm: a coral stub reaching out of the body into
    /// a white mitt with an extended finger — same two-color language as
    /// the eyes. Drawn pointing right at angle 0 and rotated to aim.
    private func hand(angle: Double) -> some View {
        ZStack {
            Capsule()
                .fill(LinearGradient(colors: [.petCoral, .petCoralBot],
                                     startPoint: .leading, endPoint: .trailing))
                .frame(width: 36, height: 12)
                .offset(x: 62)
            Circle()
                .fill(Color.white)
                .frame(width: 19, height: 19)
                .offset(x: 83)
            Capsule()
                .fill(Color.white)
                .frame(width: 22, height: 9)
                .offset(x: 96)
        }
        .rotationEffect(.radians(angle))
    }

    // MARK: - Ambient life

    private func startAmbient() {
        guard !didStartAmbient else { return }
        didStartAmbient = true
        if !reduceMotion {
            // Deferred a tick: kicking off a `repeatForever` animation
            // synchronously inside the same `onAppear` that mounts the view
            // is a known SwiftUI trap — with no enclosing Scene transaction
            // (this view is hosted directly in a raw NSPanel, not a normal
            // WindowGroup), SwiftUI can bake the end state into the very
            // first layout instead of animating into it, so the loop never
            // visibly starts. Starting it on the next runloop turn, after
            // the view has actually appeared, avoids that.
            DispatchQueue.main.async {
                withAnimation(.easeInOut(duration: 3.6).repeatForever(autoreverses: true)) { floatUp = true }
                withAnimation(.easeInOut(duration: 3.6).repeatForever(autoreverses: true)) { breathe = 1.02 }
            }
        }
        scheduleBlink()
        scheduleSaccade()
    }

    private func scheduleBlink() {
        DispatchQueue.main.asyncAfter(deadline: .now() + Double.random(in: 2.6...6.0)) {
            blinkOnce()
            scheduleBlink()
        }
    }

    private func blinkOnce() {
        let mood = controller.mood
        // Skip moods whose eyes are already closed, special-shaped, or held
        // wide — blinking any of them looks wrong.
        let noBlink: [EaonPetMood] = [.sleep, .error, .happy, .laughing, .love, .surprised]
        guard !noBlink.contains(mood), !reduceMotion else { return }
        withAnimation(.easeOut(duration: 0.09)) { blink = 0.08 }
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.1) {
            withAnimation(.easeOut(duration: 0.11)) { blink = 1 }
        }
    }

    private func scheduleSaccade() {
        DispatchQueue.main.asyncAfter(deadline: .now() + Double.random(in: 2.4...5.2)) {
            if controller.mood == .ready, controller.pointingAngle == nil, !reduceMotion {
                let dx = CGFloat([-1, 1].randomElement() ?? 1) * CGFloat.random(in: 4...7)
                withAnimation(.easeOut(duration: 0.4)) { saccade = dx }
                DispatchQueue.main.asyncAfter(deadline: .now() + 0.5) {
                    withAnimation(.easeOut(duration: 0.4)) { saccade = 0 }
                }
            }
            scheduleSaccade()
        }
    }

    private func tapped() {
        if !reduceMotion {
            withAnimation(.spring(response: 0.2, dampingFraction: 0.55)) { poke = 0.9 }
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.12) {
                withAnimation(.spring(response: 0.35, dampingFraction: 0.6)) { poke = 1 }
            }
        }
        controller.handleTap()
    }
}

/// The panel's SwiftUI root — a fixed-size stage the transparent window is
/// sized to match.
struct EaonPetRootView: View {
    var body: some View {
        EaonPetView()
            .frame(width: EaonPetController.petSize.width,
                   height: EaonPetController.petSize.height)
    }
}
