import SwiftUI

/// The landing screen's live UI: the paper, the opening line, the welcome
/// and the two ways in, each laid out in its rect from LandingLayout and
/// faded in and out by the frame.
///
/// The glass (GlassLensView) is drawn over it. What the glass refracts is
/// these same pieces, rendered to textures from `backdrop(for:)`, laid out in
/// the same rects, so the view through the glass lines up with the screen.
struct LandingScene: View {
    let frame: LandingFrame
    /// The way in being worked on, if one is.
    var busy: EntryChoice? = nil
    let onChoose: (EntryChoice) -> Void

    @Environment(\.colorScheme) private var colorScheme

    var body: some View {
        let l = frame.layout
        ZStack(alignment: .topLeading) {
            Rectangle()
                .fill(Palette.paper)
                .colorEffect(GlassShaders.paperGrain(amount: Palette.grain(colorScheme)))
                .accessibilityHidden(true)

            IntroLine(fontSize: l.introFontSize)
                .blur(radius: frame.introBlur)
                .opacity(frame.intro)
                .placed(in: l.introRect)
                .accessibilityHidden(frame.intro < 0.5)

            WelcomeTitle(fontSize: l.welcomeFontSize)
                .opacity(frame.title)
                .placed(in: l.titleRect)
                .accessibilityHidden(frame.title < 0.5)

            WelcomeSubtitle(fontSize: l.welcomeFontSize)
                .blur(radius: Self.subtitleBlur(frame))
                .opacity(frame.subtitle)
                .offset(y: Self.subtitleOffset(frame))
                .placed(in: l.subtitleRect)
                .accessibilityHidden(frame.subtitle < 0.5)

            EntryButtons(
                glass: true,
                apple: frame.appleButton,
                github: frame.githubButton,
                guest: frame.guestButton,
                busy: busy,
                onChoose: onChoose
            )
                .placed(in: l.buttonsRect)
                .allowsHitTesting(frame.buttonsLive)
                .accessibilityHidden(!frame.buttonsLive)
        }
        .frame(width: l.width, height: l.height)
    }

    private static func subtitleBlur(_ frame: LandingFrame) -> Double { (1 - frame.subtitle) * 6 }
    private static func subtitleOffset(_ frame: LandingFrame) -> Double { (1 - frame.subtitle) * 10 }

    /// The UI behind the glass, as the lens sees it.
    ///
    /// Behind the glass "Meet Eaon." is always there: that's how the lens
    /// shows it as it lifts, before it's arrived on the screen. The buttons
    /// are drawn flat (Liquid Glass can't be rendered to a texture).
    static func backdrop(for frame: LandingFrame) -> [BackdropLayer] {
        let l = frame.layout
        let buttons = (frame.appleButton + frame.githubButton + frame.guestButton) / 3
        return [
            BackdropLayer(
                id: "intro",
                rect: l.introRect,
                opacity: frame.intro,
                blur: frame.introBlur,
                content: AnyView(IntroLine(fontSize: l.introFontSize))
            ),
            BackdropLayer(
                id: "title",
                rect: l.titleRect,
                content: AnyView(WelcomeTitle(fontSize: l.welcomeFontSize))
            ),
            BackdropLayer(
                id: "subtitle",
                rect: l.subtitleRect.offsetBy(dx: 0, dy: subtitleOffset(frame)),
                opacity: frame.subtitle,
                blur: subtitleBlur(frame),
                content: AnyView(WelcomeSubtitle(fontSize: l.welcomeFontSize))
            ),
            BackdropLayer(
                id: "buttons",
                rect: l.buttonsRect.offsetBy(dx: 0, dy: (1 - buttons) * 28),
                opacity: buttons,
                content: AnyView(EntryButtons(glass: false, apple: 1, github: 1, guest: 1, busy: nil, onChoose: { _ in }))
            )
        ]
    }
}

/// The opening line.
private struct IntroLine: View {
    let fontSize: CGFloat

    var body: some View {
        Text("Your AI can do\nmore than talk.")
            .font(.system(size: fontSize))
            .multilineTextAlignment(.center)
            .foregroundStyle(Palette.ink)
            .frame(maxWidth: .infinity, maxHeight: .infinity)
    }
}

private struct WelcomeTitle: View {
    let fontSize: CGFloat

    var body: some View {
        Text("Meet Eaon.")
            .font(.system(size: fontSize))
            .foregroundStyle(Palette.ink)
            .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .top)
    }
}

private struct WelcomeSubtitle: View {
    let fontSize: CGFloat

    var body: some View {
        Text("Your models and agents,\non your iPhone and your Mac.")
            .font(.system(size: fontSize))
            .multilineTextAlignment(.center)
            .foregroundStyle(Palette.ink)
            .minimumScaleFactor(0.8)
            .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .top)
    }
}

/// The ways in, each arriving on its own: Apple, GitHub, and a quiet line
/// for people who'd rather not sign up.
private struct EntryButtons: View {
    let glass: Bool
    let apple: Double
    let github: Double
    let guest: Double
    let busy: EntryChoice?
    let onChoose: (EntryChoice) -> Void

    var body: some View {
        VStack(spacing: LandingLayout.buttonSpacing) {
            EntryButton(title: "Continue with Apple", icon: .system("apple.logo"), prominent: true, glass: glass, working: busy == .apple) {
                onChoose(.apple)
            }
            .opacity(apple)
            .offset(y: (1 - apple) * 28)

            EntryButton(title: "Continue with GitHub", icon: .asset("GitHubMark"), prominent: false, glass: glass, working: busy == .github) {
                onChoose(.github)
            }
            .opacity(github)
            .offset(y: (1 - github) * 28)

            Button {
                onChoose(.guest)
            } label: {
                Text("Continue without signing up")
                    .font(.subheadline.weight(.medium))
                    .foregroundStyle(Palette.inkSecondary)
                    .frame(maxWidth: .infinity, minHeight: LandingLayout.guestHeight)
                    .contentShape(Rectangle())
            }
            .buttonStyle(PressStyle())
            .opacity(guest)
            .offset(y: (1 - guest) * 28)
        }
        .disabled(busy != nil)
        // The buttons sit in a fixed rect; past this size the labels would outgrow it.
        .dynamicTypeSize(...DynamicTypeSize.xxxLarge)
        .frame(maxHeight: .infinity, alignment: .bottom)
    }
}

private extension View {
    /// Lays the view out in `rect`, in the screen's coordinates.
    func placed(in rect: CGRect) -> some View {
        frame(width: rect.width, height: rect.height)
            .position(x: rect.midX, y: rect.midY)
    }
}

/// "Swipe up to start", with a sheen running across it now and then.
struct SwipeHint: View {
    let time: Double
    let animated: Bool

    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        // The sheen crosses in 1.2 s, then rests for 1.6 s.
        let cycle = 2.8
        let t = time.truncatingRemainder(dividingBy: cycle) / 1.2
        let sweep = animated && !reduceMotion && t <= 1 ? -0.4 + t * 1.8 : -1
        // Clamped in order: SwiftUI warns about stops out of order, which
        // they were whenever the sheen was off the text.
        let before = clamp(sweep - 0.2, 0, 1)
        let peak = clamp(sweep, before, 1)
        let after = clamp(sweep + 0.2, peak, 1)
        Text("Swipe up to start")
            .font(.footnote.weight(.medium))
            .foregroundStyle(
                LinearGradient(
                    stops: [
                        .init(color: Palette.inkSecondary, location: 0),
                        .init(color: Palette.inkSecondary, location: before),
                        .init(color: sweep >= 0 && sweep <= 1 ? Palette.ink : Palette.inkSecondary, location: peak),
                        .init(color: Palette.inkSecondary, location: after),
                        .init(color: Palette.inkSecondary, location: 1)
                    ],
                    startPoint: .leading,
                    endPoint: .trailing
                )
            )
    }
}

/// A button's picture: an SF Symbol, or one of our own in the asset catalog.
private enum EntryIcon {
    case system(String)
    case asset(String)
}

/// One way in. Liquid Glass on iOS 26 and later; a flat capsule before that,
/// and behind the lens, which can't see Liquid Glass.
private struct EntryButton: View {
    let title: LocalizedStringKey
    let icon: EntryIcon
    let prominent: Bool
    let glass: Bool
    /// Shows a spinner where the picture is.
    let working: Bool
    let action: () -> Void

    @Environment(\.colorScheme) private var colorScheme

    var body: some View {
        if #available(iOS 26.0, *), glass {
            glassButton
        } else {
            flatButton
        }
    }

    private var label: some View {
        Label {
            Text(title)
        } icon: {
            ZStack {
                switch icon {
                case .system(let name):
                    Image(systemName: name).opacity(working ? 0 : 1)
                case .asset(let name):
                    Image(name).resizable().scaledToFit().frame(width: 19, height: 19).opacity(working ? 0 : 1)
                }
                if working { ProgressView().controlSize(.small) }
            }
        }
        .font(.body.weight(.semibold))
        .lineLimit(1)
        .minimumScaleFactor(0.8)
    }

    @available(iOS 26.0, *)
    @ViewBuilder private var glassButton: some View {
        let content = label.frame(maxWidth: .infinity, minHeight: LandingLayout.buttonHeight - 14)
        if prominent {
            Button(action: action) { content.foregroundStyle(Palette.paper) }
                .buttonStyle(.glassProminent)
                .tint(Palette.ink)
                .controlSize(.large)
        } else {
            Button(action: action) { content.foregroundStyle(Palette.ink) }
                .buttonStyle(.glass)
                .controlSize(.large)
        }
    }

    private var flatButton: some View {
        Button(action: action) {
            label
                .frame(maxWidth: .infinity, minHeight: LandingLayout.buttonHeight)
                .foregroundStyle(prominent ? Palette.paper : Palette.ink)
                .background {
                    if prominent {
                        Capsule().fill(Palette.ink)
                    } else {
                        Capsule()
                            .fill(colorScheme == .dark ? Color.white.opacity(0.08) : Color.white.opacity(0.7))
                            .overlay(Capsule().strokeBorder(Palette.ink.opacity(0.08), lineWidth: 1))
                    }
                }
                .contentShape(Capsule())
        }
        .buttonStyle(PressStyle())
    }
}

/// Presses sink in a little and spring back.
private struct PressStyle: ButtonStyle {
    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .scaleEffect(configuration.isPressed ? 0.97 : 1)
            .opacity(configuration.isPressed ? 0.85 : 1)
            .animation(.interpolatingSpring(stiffness: 600, damping: 30), value: configuration.isPressed)
    }
}
