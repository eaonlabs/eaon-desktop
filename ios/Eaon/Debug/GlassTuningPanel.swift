#if DEBUG
import SwiftUI

/// A temporary panel for tuning the landing screen live: the glass, its
/// sizes, the crescent, the springs and the marbles. Shown as a low sheet so
/// the screen stays visible, and usable, above it. Debug builds only.
struct GlassTuningPanel: View {
    @Binding var tuning: LandingTuning
    /// The lab's lens radius, in points; the landing screen sizes its glass by the screen.
    var labRadius: Binding<Double>?

    var body: some View {
        NavigationStack {
            Form {
                Section("Glass") {
                    row("Refraction", value: $tuning.lens.refraction, in: 0...2.5)
                    row("Magnification", value: $tuning.lens.magnification, in: 1...2.5)
                    row("Dispersion", value: $tuning.lens.dispersion, in: 0...0.4)
                    row("Rim width", value: $tuning.lens.rimWidth, in: 0.05...0.6)
                    row("Rim curve", value: $tuning.lens.rimCurve, in: 2...6)
                    row("Highlight", value: $tuning.lens.highlight, in: 0...2)
                }
                Section("Size") {
                    if let labRadius {
                        row("Radius", value: labRadius, in: 30...220, format: "%.0f pt")
                    } else {
                        row("Radius at rest", value: $tuning.restRadius, in: 0.25...0.7, format: "%.2f × width")
                        row("Radius at end", value: $tuning.endRadius, in: 0.03...0.2, format: "%.3f × width")
                    }
                }
                Section("Crescent") {
                    ColorPicker("Colour", selection: $tuning.crescentColor, supportsOpacity: false)
                    row("Intensity", value: $tuning.crescentIntensity, in: 0...1.5)
                }
                Section {
                    row("Stiffness", value: $tuning.stiffness, in: 40...600, format: "%.0f")
                    row("Damping", value: $tuning.damping, in: 4...60, format: "%.1f")
                } header: {
                    Text("Springs")
                } footer: {
                    let ratio = tuning.damping / (2 * tuning.stiffness.squareRoot())
                    Text(String(format: "Damping ratio %.2f: below 1 overshoots, 1 settles without.", ratio))
                }
                Section("Marbles") {
                    row("Count", value: count, in: 0...200, format: "%.0f")
                    row("Smallest", value: $tuning.marbleMinSize, in: 1...20, format: "%.0f pt")
                    row("Largest", value: $tuning.marbleMaxSize, in: 4...48, format: "%.0f pt")
                    row("Spawn rate", value: $tuning.spawnRate, in: 2...60, format: "%.0f a second")
                }
                Section {
                    Button("Reset to defaults") { tuning = LandingTuning() }
                }
            }
            .navigationTitle("Glass")
            .navigationBarTitleDisplayMode(.inline)
        }
    }

    private var count: Binding<Double> {
        Binding(get: { Double(tuning.marbleCount) }, set: { tuning.marbleCount = Int($0.rounded()) })
    }

    private func row(_ title: String, value: Binding<Double>, in range: ClosedRange<Double>, format: String = "%.2f") -> some View {
        VStack(alignment: .leading, spacing: 2) {
            HStack {
                Text(title)
                Spacer()
                Text(String(format: format, value.wrappedValue))
                    .monospacedDigit()
                    .foregroundStyle(.secondary)
            }
            Slider(value: value, in: range)
        }
    }
}
#endif
