import SwiftUI

// MARK: - Buttons

/// The full-width capsule for the one thing a screen wants you to do.
struct PillButtonStyle: ButtonStyle {
    enum Kind { case primary, secondary, destructive }
    var kind: Kind = .primary

    func makeBody(configuration: Configuration) -> some View {
        PillBody(configuration: configuration, kind: kind)
    }

    private struct PillBody: View {
        let configuration: ButtonStyleConfiguration
        let kind: Kind
        @Environment(\.isEnabled) private var isEnabled

        var body: some View {
            configuration.label
                .font(.body.weight(.semibold))
                .frame(maxWidth: .infinity, minHeight: Metrics.controlHeight)
                .foregroundStyle(foreground)
                .background(background, in: Capsule())
                .opacity(isEnabled ? 1 : 0.4)
                .scaleEffect(configuration.isPressed ? 0.97 : 1)
                .brightness(configuration.isPressed ? (kind == .primary ? 0.12 : -0.02) : 0)
                .animation(Springs.snappy, value: configuration.isPressed)
                .animation(Springs.snappy, value: isEnabled)
                .contentShape(Capsule())
        }

        private var foreground: Color {
            switch kind {
            case .primary: Palette.background
            case .secondary: Palette.ink
            case .destructive: Palette.negative
            }
        }

        private var background: Color {
            switch kind {
            case .primary: Palette.ink
            case .secondary: Palette.fill
            case .destructive: Palette.negative.opacity(0.1)
            }
        }
    }
}

/// A round icon button (send, stop, close). A filled one that can't be pressed yet goes pale
/// and a little smaller, and springs up to full ink the moment it can.
struct RoundButtonStyle: ButtonStyle {
    var diameter: CGFloat = 36
    var filled = true

    func makeBody(configuration: Configuration) -> some View {
        RoundBody(configuration: configuration, diameter: diameter, filled: filled)
    }

    private struct RoundBody: View {
        let configuration: ButtonStyleConfiguration
        let diameter: CGFloat
        let filled: Bool
        @Environment(\.isEnabled) private var isEnabled

        var body: some View {
            configuration.label
                .font(.system(size: diameter * 0.44, weight: .bold))
                .foregroundStyle(filled ? Palette.background : Palette.ink)
                .frame(width: diameter, height: diameter)
                .background(background, in: Circle())
                .opacity(filled || isEnabled ? 1 : 0.35)
                .scaleEffect((configuration.isPressed ? 0.88 : 1) * (filled && !isEnabled ? 0.92 : 1))
                .animation(Springs.snappy, value: configuration.isPressed)
                .animation(Springs.bouncy, value: isEnabled)
                .contentShape(Circle())
        }

        private var background: Color {
            guard filled else { return Palette.fill }
            return isEnabled ? Palette.ink : Palette.ink.opacity(0.2)
        }
    }
}

/// Presses sink in a little and spring back: for rows and cards that are buttons.
struct PressableStyle: ButtonStyle {
    var scale: CGFloat = 0.98

    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .scaleEffect(configuration.isPressed ? scale : 1)
            .opacity(configuration.isPressed ? 0.75 : 1)
            .animation(Springs.snappy, value: configuration.isPressed)
    }
}

// MARK: - Callout

/// A rounded callout for something that went wrong or needs saying, tinted by what kind it is.
/// Errors can fold their detail away, and carry a button to the place that fixes them.
struct Callout: View {
    enum Kind {
        case error, info, success

        var symbol: String {
            switch self {
            case .error: "exclamationmark.triangle.fill"
            case .info: "info.circle.fill"
            case .success: "checkmark.circle.fill"
            }
        }

        var color: Color {
            switch self {
            case .error: Palette.negative
            case .info: Palette.tint
            case .success: Palette.positive
            }
        }
    }

    var kind: Kind = .info
    var title: String
    var message: String? = nil
    var detail: String? = nil
    var actionTitle: String? = nil
    var action: (() -> Void)? = nil
    var onDismiss: (() -> Void)? = nil

    @State private var expanded = false

    var body: some View {
        HStack(alignment: .top, spacing: 12) {
            Image(systemName: kind.symbol)
                .font(.system(size: 17, weight: .semibold))
                .foregroundStyle(kind.color)
                .frame(width: 24, height: 24)
                .accessibilityHidden(true)

            VStack(alignment: .leading, spacing: 4) {
                Text(title)
                    .font(.subheadline.weight(.semibold))
                    .foregroundStyle(Palette.ink)
                if let message {
                    Text(message)
                        .font(.subheadline)
                        .foregroundStyle(Palette.secondary)
                        .fixedSize(horizontal: false, vertical: true)
                }
                if expanded, let detail {
                    Text(detail)
                        .font(.footnote.monospaced())
                        .foregroundStyle(Palette.secondary)
                        .textSelection(.enabled)
                        .padding(.top, 2)
                        .transition(.opacity.combined(with: .move(edge: .top)))
                }
                if actionTitle != nil || detail != nil {
                    HStack(spacing: 8) {
                        if let actionTitle, let action {
                            Button(actionTitle, action: action)
                                .font(.footnote.weight(.semibold))
                                .padding(.horizontal, 12)
                                .frame(height: 30)
                                .background(Palette.ink, in: Capsule())
                                .foregroundStyle(Palette.background)
                                .buttonStyle(PressableStyle(scale: 0.95))
                        }
                        if detail != nil {
                            Button(expanded ? "Hide details" : "Details") {
                                withAnimation(Springs.smooth) { expanded.toggle() }
                            }
                            .font(.footnote.weight(.medium))
                            .foregroundStyle(Palette.secondary)
                            .frame(height: 30)
                        }
                    }
                    .padding(.top, 6)
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)

            if let onDismiss {
                Button(action: onDismiss) {
                    Image(systemName: "xmark")
                        .font(.system(size: 11, weight: .bold))
                        .foregroundStyle(Palette.secondary)
                        .frame(width: 26, height: 26)
                        .background(Palette.fill, in: Circle())
                        .frame(width: 44, height: 44)
                        .contentShape(Circle())
                }
                .buttonStyle(PressableStyle(scale: 0.9))
                .padding(-9)
                .accessibilityLabel("Dismiss")
            }
        }
        .padding(14)
        .background(kind.color.opacity(0.08), in: RoundedRectangle(cornerRadius: 18, style: .continuous))
        .background(Palette.background, in: RoundedRectangle(cornerRadius: 18, style: .continuous))
        .accessibilityElement(children: .contain)
    }
}

// MARK: - Small parts

struct StatusDot: View {
    var color: Color
    var pulsing = false
    @State private var on = false

    var body: some View {
        Circle()
            .fill(color)
            .frame(width: 9, height: 9)
            .overlay(
                Circle()
                    .stroke(color.opacity(0.45), lineWidth: 3)
                    .scaleEffect(pulsing && on ? 1.9 : 1)
                    .opacity(pulsing && on ? 0 : 1)
            )
            .onAppear {
                guard pulsing else { return }
                withAnimation(.easeOut(duration: 1.2).repeatForever(autoreverses: false)) { on = true }
            }
    }
}

/// A person: their GitHub picture, or their initials on a soft fill.
struct AvatarView: View {
    var account: Account?
    var size: CGFloat = 44

    var body: some View {
        ZStack {
            Circle().fill(Palette.fill)
            if let account {
                if let url = account.avatarURL {
                    AsyncImage(url: url) { phase in
                        if let image = phase.image {
                            image.resizable().scaledToFill()
                        } else {
                            initials(account)
                        }
                    }
                } else {
                    initials(account)
                }
            } else {
                Image(systemName: "person.fill")
                    .font(.system(size: size * 0.42, weight: .medium))
                    .foregroundStyle(Palette.secondary)
            }
        }
        .frame(width: size, height: size)
        .clipShape(Circle())
        .accessibilityHidden(true)
    }

    private func initials(_ account: Account) -> some View {
        Text(account.initials)
            .font(.system(size: size * 0.38, weight: .semibold))
            .foregroundStyle(Palette.ink)
    }
}

/// A quiet label above a group.
struct SectionLabel: View {
    var text: String

    init(_ text: String) { self.text = text }

    var body: some View {
        Text(text)
            .font(.footnote.weight(.semibold))
            .foregroundStyle(Palette.secondary)
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(.horizontal, 4)
            .accessibilityAddTraits(.isHeader)
    }
}

/// The Eaon "e".
struct EaonMark: View {
    var size: CGFloat = 28

    var body: some View {
        Image("EaonMark")
            .resizable()
            .scaledToFit()
            .frame(width: size, height: size)
            .accessibilityHidden(true)
    }
}

/// Two lines, the lower one shorter: what opens the drawer.
struct MenuGlyph: View {
    var body: some View {
        VStack(alignment: .leading, spacing: 5) {
            Capsule().frame(width: 18, height: 2)
            Capsule().frame(width: 11, height: 2)
        }
        .frame(width: 22, height: 22)
        .accessibilityHidden(true)
    }
}

// MARK: - Grouped rows

/// A soft grey card holding rows, a hairline between each.
struct RowGroup<Content: View>: View {
    var dividerInset: CGFloat = 54
    @ViewBuilder var content: Content

    var body: some View {
        VStack(spacing: 0) {
            Group(subviews: content) { subviews in
                ForEach(subviews.indices, id: \.self) { index in
                    subviews[index]
                    if index < subviews.count - 1 {
                        Rectangle()
                            .fill(Palette.hairline)
                            .frame(height: 0.5)
                            .padding(.leading, dividerInset)
                    }
                }
            }
        }
        .background(Palette.surface, in: RoundedRectangle(cornerRadius: Metrics.cardRadius, style: .continuous))
        .clipShape(RoundedRectangle(cornerRadius: Metrics.cardRadius, style: .continuous))
    }
}

/// The symbol at the start of a row: plain, in a fixed square so titles line up.
struct IconTile: View {
    var systemImage: String
    var tint: Color = Palette.ink
    var size: CGFloat = 28

    /// Pass as `systemImage` for agents: a little outline face, the way the app draws them. (The
    /// smiley symbols turn solid in dark mode, which reads as a different icon.)
    static let agentFace = "eaon.agentFace"

    var body: some View {
        Group {
            if systemImage == Self.agentFace {
                AgentGlyph(size: max(17, size * 0.6) + 3)
            } else {
                Image(systemName: systemImage)
                    .font(.system(size: max(17, size * 0.6), weight: .regular))
            }
        }
        .foregroundStyle(tint)
        .frame(width: size, height: size)
        .accessibilityHidden(true)
    }
}

/// An outline face, a circle with two upright eyes, like an agent's.
struct AgentGlyph: View {
    var size: CGFloat = 20

    var body: some View {
        ZStack {
            Circle().strokeBorder(lineWidth: max(1.5, size * 0.085))
            HStack(spacing: size * 0.2) {
                Capsule().frame(width: size * 0.12, height: size * 0.27)
                Capsule().frame(width: size * 0.12, height: size * 0.27)
            }
            .offset(y: -size * 0.04)
        }
        .frame(width: size, height: size)
    }
}
