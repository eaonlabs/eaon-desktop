#if DEBUG
import SwiftUI

/// A still lens over test text, for tuning the glass's optics against the
/// reference frames without the motion. Drag anywhere to move the lens; the
/// slider button opens the tuning panel. Launch a Debug build with `-lab`;
/// `-crescent 0.8` shows the crescent at that strength.
///
/// The text is drawn twice: live, as the screen, and into the lens's
/// backdrop texture, which the glass refracts.
struct LensLab: View {
    /// Where the first line of the test text sits, as a fraction of the height.
    static let textY = 0.46

    @State private var store = TuningStore()
    @State private var radius = Self.launchValue("radius") ?? 100
    @State private var lensCenter: CGPoint?
    @State private var dragStart: CGPoint?
    @State private var showsPanel = ProcessInfo.processInfo.arguments.contains("-panel")
    @Environment(\.colorScheme) private var colorScheme

    var body: some View {
        GeometryReader { proxy in
            let size = proxy.size
            // It starts over the first line, on the gap between the words, like the reference frames.
            let center = lensCenter ?? CGPoint(
                x: size.width * (Self.launchValue("lensX") ?? 0.49),
                y: size.height * (Self.launchValue("lensY") ?? Self.textY)
            )
            let crescent = Self.launchValue("crescent") ?? 0
            ZStack {
                Rectangle()
                    .fill(Palette.paper)
                    .colorEffect(GlassShaders.paperGrain(amount: Palette.grain(colorScheme)))
                LabText(size: size)
                GlassLensView(
                    lenses: [LensInstance(center: center, radius: radius, crescent: crescent, spread: 1)],
                    parameters: store.tuning.lens,
                    crescentColor: store.tuning.crescentColor,
                    layers: [BackdropLayer(id: "text", rect: CGRect(origin: .zero, size: size), content: AnyView(LabText(size: size)))]
                )
                .allowsHitTesting(false)
            }
            .contentShape(Rectangle())
            .gesture(
                // Moves the lens by the drag, wherever the finger starts, so
                // the finger needn't cover the glass.
                DragGesture(minimumDistance: 0)
                    .onChanged { value in
                        let start = dragStart ?? center
                        dragStart = start
                        lensCenter = CGPoint(
                            x: start.x + value.translation.width,
                            y: start.y + value.translation.height
                        )
                    }
                    .onEnded { _ in dragStart = nil }
            )
        }
        .ignoresSafeArea()
        .overlay(alignment: .topTrailing) {
            Button("Tune", systemImage: "slider.horizontal.3") { showsPanel = true }
                .labelStyle(.iconOnly)
                .font(.title3)
                .padding(12)
                .background(.regularMaterial, in: Circle())
                .padding(.trailing, 16)
        }
        .overlay(alignment: .topLeading) {
            Text("Lens lab")
                .font(.caption.weight(.medium))
                .foregroundStyle(.secondary)
                .padding(.leading, 20)
                .padding(.top, 14)
        }
        .sheet(isPresented: $showsPanel) {
            GlassTuningPanel(tuning: $store.tuning, labRadius: $radius)
                .presentationDetents([.height(320), .medium])
                .presentationBackgroundInteraction(.enabled)
        }
    }

    private static func launchValue(_ key: String) -> Double? {
        UserDefaults.standard.object(forKey: key) != nil ? UserDefaults.standard.double(forKey: key) : nil
    }
}

/// The test text, set like the reference frames: a short line over a longer
/// one, regular weight, centred, a little above the middle of the screen.
private struct LabText: View {
    let size: CGSize

    var body: some View {
        VStack(spacing: 4) {
            Text("Meet Eaon.")
                .foregroundStyle(Palette.ink)
            Text("Your models and agents,\non your iPhone and your Mac.")
                .foregroundStyle(Palette.inkSecondary)
        }
        .font(.system(size: 24))
        .multilineTextAlignment(.center)
        .frame(width: size.width)
        // The first line's middle on textY.
        .padding(.top, size.height * LensLab.textY - 15)
        .frame(width: size.width, height: size.height, alignment: .top)
    }
}
#endif
