import SwiftUI

// The on-screen companion's face. One coral orb; all expression lives in two
// white eyes that morph between shapes. Ported from the motion spec: every
// state is a transform/opacity/shape change, layered so the ambient life
// (float, breathe, blink, idle glances) never fights the mood transitions.
// The mood itself is owned by `EaonPetController.shared`; this view only
// renders and animates whatever it holds.

// MARK: - Geometry

/// A rounded shape with four independently-sized corners, animatable so the
/// eyes can morph smoothly between pill / dash / rounded-rect / teardrop
/// (the fang used for `angry`). The `error` X is a separate overlay.
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

/// Everything about one eye in one pose. Interpolating between two of these
/// (via the mood animation) is what produces every morph.
struct EyePose: Equatable {
    var dx: CGFloat
    var dy: CGFloat
    var rot: Double
    var w: CGFloat
    var h: CGFloat
    var radii: CornerRadii
    var isX: Bool
}

/// Left eye, right eye, head tilt, and horizontal gaze offset for a mood.
/// Numbers are tuned against the reference frames at this 120pt body size.
private func eyePoses(_ mood: EaonPetMood, phase: Int) -> (EyePose, EyePose, Double, CGFloat) {
    let gap: CGFloat = 26
    switch mood {
    case .ready:
        return (EyePose(dx: -gap, dy: -4, rot: 0, w: 22, h: 44, radii: .all(11), isX: false),
                EyePose(dx: gap, dy: -4, rot: 0, w: 22, h: 44, radii: .all(11), isX: false), 0, 0)
    case .sleep:
        return (EyePose(dx: -gap + 2, dy: 4, rot: 0, w: 20, h: 6, radii: .all(3), isX: false),
                EyePose(dx: gap - 2, dy: 4, rot: 0, w: 20, h: 6, radii: .all(3), isX: false), 0, 0)
    case .working:
        let up: CGFloat = -12, down: CGFloat = 7
        return (EyePose(dx: -gap, dy: phase == 0 ? up : down, rot: 0, w: 22, h: 44, radii: .all(8), isX: false),
                EyePose(dx: gap, dy: phase == 0 ? down : up, rot: 0, w: 22, h: 44, radii: .all(8), isX: false), 0, 0)
    case .lookLeft:
        return (EyePose(dx: -31, dy: -8, rot: -11, w: 22, h: 44, radii: .all(7), isX: false),
                EyePose(dx: 6, dy: -8, rot: -11, w: 22, h: 44, radii: .all(7), isX: false), -6, -9)
    case .lookRight:
        return (EyePose(dx: -6, dy: -8, rot: 11, w: 22, h: 44, radii: .all(7), isX: false),
                EyePose(dx: 31, dy: -8, rot: 11, w: 22, h: 44, radii: .all(7), isX: false), 6, 9)
    case .wink:
        return (EyePose(dx: -27, dy: 7, rot: 0, w: 18, h: 6, radii: .all(3), isX: false),
                EyePose(dx: 27, dy: -8, rot: 0, w: 22, h: 44, radii: .all(11), isX: false), -5, 0)
    case .angry:
        return (EyePose(dx: -24, dy: -2, rot: -24, w: 21, h: 51,
                        radii: CornerRadii(tl: 2, tr: 11, br: 11, bl: 11), isX: false),
                EyePose(dx: 24, dy: -2, rot: 24, w: 21, h: 51,
                        radii: CornerRadii(tl: 11, tr: 2, br: 11, bl: 11), isX: false), 0, 0)
    case .error:
        return (EyePose(dx: -gap, dy: -4, rot: 0, w: 27, h: 27, radii: .all(4), isX: true),
                EyePose(dx: gap, dy: -4, rot: 0, w: 27, h: 27, radii: .all(4), isX: true), 0, 0)
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

private struct EyeView: View {
    let pose: EyePose
    var body: some View {
        ZStack {
            EyeShape(radii: pose.radii)
                .fill(Color.white)
                .frame(width: pose.w, height: pose.h)
                .opacity(pose.isX ? 0 : 1)
            PetXEyes()
                .opacity(pose.isX ? 1 : 0)
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
    @State private var didStartAmbient = false

    // Fixed cadence for the working seesaw — only applied while working.
    private let seesaw = Timer.publish(every: 0.66, on: .main, in: .common).autoconnect()

    var body: some View {
        let mood = controller.mood
        let (leftPose, rightPose, tilt, gazeX) = eyePoses(mood, phase: workPhase)

        ZStack {
            // Contact shadow — shrinks and fades as the body floats up, giving
            // it weight (follow-through).
            Ellipse()
                .fill(RadialGradient(colors: [Color.black.opacity(0.32), .clear],
                                     center: .center, startRadius: 1, endRadius: 46))
                .frame(width: 104, height: 20)
                .scaleEffect(floatUp ? 0.84 : 1.0)
                .opacity(floatUp ? 0.5 : 0.85)
                .offset(y: 60)
                .blur(radius: 2.5)

            ZStack {
                petBody(mood: mood)
                eyes(leftPose: leftPose, rightPose: rightPose, tilt: tilt, gazeX: gazeX, mood: mood)
            }
            .scaleEffect(breathe * poke)
            .offset(y: floatUp ? -6 : 0)
            .contentShape(Circle())
            .onTapGesture { tapped() }
        }
        .frame(width: 150, height: 172)
        .onAppear { startAmbient() }
        .onReceive(seesaw) { _ in
            guard controller.mood == .working, !reduceMotion else { return }
            withAnimation(.easeInOut(duration: 0.55)) {
                workPhase = workPhase == 0 ? 1 : 0
            }
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
            .saturation(mood == .angry ? 1.2 : (mood == .error ? 0.5 : 1.0))
            .brightness(mood == .error ? -0.05 : 0)
            .shadow(color: Color(red: 0.82, green: 0.33, blue: 0.17).opacity(0.5), radius: 14, x: 0, y: 10)
            .animation(.easeOut(duration: 0.35), value: mood)
    }

    private func eyes(leftPose: EyePose, rightPose: EyePose, tilt: Double, gazeX: CGFloat, mood: EaonPetMood) -> some View {
        ZStack {
            EyeView(pose: leftPose)
            EyeView(pose: rightPose)
        }
        .frame(width: 120, height: 120)
        .scaleEffect(x: 1, y: blink, anchor: .center)
        .rotationEffect(.degrees(tilt))
        .offset(x: gazeX + saccade)
        .animation(.spring(response: 0.42, dampingFraction: 0.82), value: mood)
        .animation(.easeInOut(duration: 0.55), value: workPhase)
        .animation(.easeOut(duration: 0.4), value: saccade)
    }

    // MARK: - Ambient life

    private func startAmbient() {
        guard !didStartAmbient else { return }
        didStartAmbient = true
        if !reduceMotion {
            withAnimation(.easeInOut(duration: 3.6).repeatForever(autoreverses: true)) { floatUp = true }
            withAnimation(.easeInOut(duration: 3.6).repeatForever(autoreverses: true)) { breathe = 1.02 }
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
        guard mood != .sleep, mood != .error, !reduceMotion else { return }
        withAnimation(.easeOut(duration: 0.09)) { blink = 0.08 }
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.1) {
            withAnimation(.easeOut(duration: 0.11)) { blink = 1 }
        }
    }

    private func scheduleSaccade() {
        DispatchQueue.main.asyncAfter(deadline: .now() + Double.random(in: 2.4...5.2)) {
            if controller.mood == .ready, !reduceMotion {
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
        controller.handlePoke()
    }
}

/// The panel's SwiftUI root — a fixed-size stage the transparent window is
/// sized to match.
struct EaonPetRootView: View {
    var body: some View {
        EaonPetView()
            .frame(width: 150, height: 172)
    }
}
