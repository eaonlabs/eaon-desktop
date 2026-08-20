import SwiftUI

/// Jan's switch, matched to its real values rather than approximated —
/// pulled from its shipped shadcn/ui `Switch` component, unmodified there.
///
/// Two things a plain `.toggleStyle(.switch).tint(_:)` on the native macOS
/// switch cannot reach, which is why this exists instead of a tint:
///
/// 1. **The knob is dark in dark mode, not a plain white circle.** shadcn's
///    default thumb is `bg-background` in light mode and
///    `dark:bg-primary-foreground` in dark mode — a near-black knob that
///    reads as a ring of contrast against the track rather than a bright
///    white dot. `colors.backgroundElevated` already resolves to exactly
///    those two values (`#171717` dark, `#FFFFFF` light) with no extra
///    branching needed here.
/// 2. **The on-color is Jan's own `--primary`.** Converted from its shipped
///    `oklch(.7003 .1611 35.09)`, that value is `#F17455` — which is,
///    unprompted, the exact hex of this app's own `AquaBrand.accent`. Using
///    the app's real accent isn't a coincidence dressed up as a decision;
///    it happens to already be the right answer.
///
/// Geometry is shadcn's literal spec, since Jan's is unmodified: a 36×20
/// track (`h-5 w-9`), a 16pt thumb (`size-4`) inset 2pt (`border-2`), which
/// nets exactly 16pt of travel (`translate-x-4`) — the numbers agree with
/// each other, which is what confirmed these were the right defaults to
/// copy rather than a rounding of something else.
struct JanSwitchToggleStyle: ToggleStyle {
    @Environment(\.themeColors) private var colors
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    private static let trackSize = CGSize(width: 36, height: 20)
    private static let thumbDiameter: CGFloat = 16
    private static let inset: CGFloat = 2

    func makeBody(configuration: Configuration) -> some View {
        Button {
            withAnimation(reduceMotion ? nil : .uiEaseOut()) {
                configuration.isOn.toggle()
            }
        } label: {
            Capsule(style: .continuous)
                .fill(configuration.isOn ? AquaBrand.accent : colors.borderMedium)
                .frame(width: Self.trackSize.width, height: Self.trackSize.height)
                .overlay(alignment: configuration.isOn ? .trailing : .leading) {
                    Circle()
                        .fill(colors.backgroundElevated)
                        .frame(width: Self.thumbDiameter, height: Self.thumbDiameter)
                        .shadow(color: colors.shadowColor.opacity(0.6), radius: 1, y: 0.5)
                        .padding(Self.inset)
                }
        }
        .buttonStyle(.plain)
        .accessibilityAddTraits(.isButton)
        .accessibilityValue(configuration.isOn ? "On" : "Off")
    }
}
