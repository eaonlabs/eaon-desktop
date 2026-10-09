import SwiftUI

/// Chat or Agents: the two-way switch at the top of both screens, a glass capsule with the chosen
/// side sitting in a pill of its own. The pill slides across when you switch.
struct ScreenSwitch: View {
    @Environment(AppNavigator.self) private var navigator
    @Namespace private var pill

    var body: some View {
        HStack(spacing: 0) {
            segment("Chat", .chat)
            segment("Agents", .agents)
        }
        .padding(4)
        .glass(in: Capsule())
    }

    private func segment(_ title: String, _ screen: AppScreen) -> some View {
        let selected = navigator.screen == screen
        return Button {
            guard !selected else { return }
            Haptic.select()
            withAnimation(Springs.smooth) { navigator.go(screen) }
        } label: {
            Text(title)
                .font(.body.weight(.semibold))
                .foregroundStyle(Palette.ink)
                .padding(.horizontal, 18)
                .frame(height: 38)
                .background {
                    if selected {
                        Capsule()
                            .fill(Palette.background)
                            .shadow(color: .black.opacity(0.08), radius: 3, y: 1)
                            .matchedGeometryEffect(id: "selection", in: pill)
                    }
                }
                .contentShape(Capsule())
        }
        .buttonStyle(.plain)
        .accessibilityAddTraits(selected ? .isSelected : [])
        .accessibilityIdentifier("switch.\(title.lowercased())")
    }
}

/// A round glass button with a symbol in it, for the controls that float at the top of a screen.
struct GlassCircleButtonStyle: ButtonStyle {
    var diameter: CGFloat = 44

    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .font(.system(size: 18, weight: .medium))
            .foregroundStyle(Palette.ink)
            .frame(width: diameter, height: diameter)
            .glass(in: Circle())
            .contentShape(Circle())
            .scaleEffect(configuration.isPressed ? 0.9 : 1)
            .animation(Springs.snappy, value: configuration.isPressed)
    }
}
