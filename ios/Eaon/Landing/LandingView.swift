import SwiftUI

/// The first thing you see: a glass dome on the bottom edge to swipe up,
/// which lifts into a lens, shows you the welcome through the glass, and
/// shrinks into an orb that marbles stream out of.
///
/// This view only puts the pieces together, once a frame:
/// - `LandingEngine` steps the state, springs and marbles and hands back a `LandingFrame`;
/// - `LandingScene` is the live UI, laid out from `LandingLayout`;
/// - `GlassLensView` draws the glass over it in Metal, refracting the same
///   UI rendered to textures (`LandingScene.backdrop`) and the marbles;
/// - `LensTouchArea` (LandingGestures.swift) feeds drags on the glass back to the engine.
struct LandingView: View {
    /// The way in being worked on, if one is: its button shows a spinner.
    var busy: EntryChoice? = nil
    var onChoose: (EntryChoice) -> Void = { _ in }

    @State private var engine = LandingEngine()
    @State private var haptics = LensHaptics()
    @State private var store = TuningStore()
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @ScaledMetric(relativeTo: .title2) private var introFontSize: CGFloat = 26
    @ScaledMetric(relativeTo: .title2) private var welcomeFontSize: CGFloat = 27
    #if DEBUG
    @State private var showsTuning = ProcessInfo.processInfo.arguments.contains("-tune")
    #endif

    var body: some View {
        // The outer reader stays inside the safe area, so it knows the insets;
        // the inner one ignores it, so it has the whole screen to draw on.
        // (A reader that ignores the safe area reports zero insets.)
        GeometryReader { safeArea in
            GeometryReader { proxy in
                screen(size: proxy.size, insets: safeArea.safeAreaInsets)
            }
            .ignoresSafeArea()
        }
        .lensHaptics(haptics)
        #if DEBUG
        .overlay(alignment: .topTrailing) { tuneButton }
        .sheet(isPresented: $showsTuning) {
            GlassTuningPanel(tuning: $store.tuning)
                .presentationDetents([.fraction(0.42), .large])
                .presentationBackgroundInteraction(.enabled(upThrough: .fraction(0.42)))
        }
        .task {
            if ProcessInfo.processInfo.arguments.contains("-autoplay") {
                await LandingAutoplay.run(engine)
            }
        }
        #endif
    }

    private func screen(size: CGSize, insets: EdgeInsets) -> some View {
        TimelineView(.animation) { timeline in
            let tuning = store.tuning
            let layout = LandingLayout(
                size: size,
                insets: insets,
                restRadiusFraction: tuning.restRadius,
                endRadiusFraction: tuning.endRadius,
                // The composition holds up to about the first accessibility size.
                introFontSize: min(introFontSize, 34),
                welcomeFontSize: min(welcomeFontSize, 34)
            )
            let frame = engine.frame(at: timeline.date, layout: layout, tuning: tuning, reduceMotion: reducesMotion)
            ZStack(alignment: .topLeading) {
                LandingScene(frame: frame, busy: busy, onChoose: onChoose)
                GlassLensView(
                    lenses: frame.lenses,
                    parameters: tuning.lens,
                    crescentColor: tuning.crescentColor,
                    layers: LandingScene.backdrop(for: frame),
                    marbles: frame.marbles
                )
                .allowsHitTesting(false)
                .accessibilityHidden(true)
                swipeHint(frame)
                LensTouchArea(engine: engine, frame: frame) { haptics.record($0) }
                #if DEBUG
                testProbe(frame)
                #endif
            }
            .frame(width: size.width, height: size.height)
        }
    }

    /// Reduce Motion, or `-reduceMotion` at launch in a Debug build.
    private var reducesMotion: Bool {
        #if DEBUG
        if ProcessInfo.processInfo.arguments.contains("-reduceMotion") { return true }
        #endif
        return reduceMotion
    }

    /// On top of the glass, as a label printed on the dome. For VoiceOver
    /// it's the button that opens Eaon, since VoiceOver can't swipe the glass.
    private func swipeHint(_ frame: LandingFrame) -> some View {
        SwipeHint(time: frame.time, animated: frame.hint > 0)
            .opacity(frame.hint)
            .position(x: frame.layout.midX, y: frame.layout.hintY)
            .allowsHitTesting(false)
            .accessibilityLabel("Start")
            .accessibilityHint("Opens Eaon")
            .accessibilityAddTraits(.isButton)
            .accessibilityAction {
                engine.enter()
                haptics.record(.entered)
            }
            .accessibilityHidden(frame.hint < 0.5)
    }

    #if DEBUG
    /// Where the landing screen is and where its glass is, for the UI tests
    /// (EaonUITests), which see this though VoiceOver doesn't.
    private func testProbe(_ frame: LandingFrame) -> some View {
        let lens = frame.lenses.last
        let value = String(
            format: "%@ x=%.0f y=%.0f r=%.0f m=%d",
            frame.isHome ? "home" : "intro",
            lens?.center.x ?? 0,
            lens?.center.y ?? 0,
            lens?.radius ?? 0,
            frame.marbles.count
        )
        return Color.clear
            .frame(width: 1, height: 1)
            .allowsHitTesting(false)
            .accessibilityElement()
            .accessibilityIdentifier("landing.probe")
            .accessibilityValue(value)
            .accessibilityHidden(true)
    }

    /// Opens the tuning panel. Debug builds only, while the glass is being tuned.
    private var tuneButton: some View {
        Button("Tune the glass", systemImage: "slider.horizontal.3") { showsTuning = true }
            .labelStyle(.iconOnly)
            .font(.body.weight(.medium))
            .foregroundStyle(Palette.inkSecondary)
            .frame(width: 44, height: 44)
            .contentShape(Rectangle())
            .padding(.trailing, 8)
    }
    #endif
}

#Preview {
    LandingView()
}
