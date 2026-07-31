import SwiftUI

/// The single fixed brand accent, used only for actual brand identity (the
/// logo mark/wordmark) — everyday UI chrome is monochrome by default, matching
/// the target ChatGPT-style look, so this is deliberately *not* the app's
/// general-purpose interactive color anymore. It's still offered as one of
/// several selectable options in Appearance settings.
enum AquaBrand {
    static let accent = Color(hex: "#F17455")
}

struct ThemeColors: Equatable {
    let backgroundPrimary: Color
    let backgroundSidebar: Color
    let backgroundElevated: Color
    let backgroundPopover: Color
    let backgroundInput: Color
    let backgroundInputSecondary: Color
    let backgroundCode: Color
    let backgroundCodeHeader: Color
    let backgroundChip: Color
    let backgroundChipSecondary: Color
    let backgroundChart: Color
    let backgroundOverlay: Color
    let backgroundHover: Color
    let backgroundSelected: Color
    let backgroundSubtle: Color

    let textPrimary: Color
    let textSecondary: Color
    let textTertiary: Color
    let textCode: Color

    let borderSubtle: Color
    let borderMedium: Color

    let userBubble: Color
    let shadowColor: Color
    let destructive: Color
    /// Restrained hyperlink tone for inline text links — kept neutral rather
    /// than the brand orange, since everyday chrome is monochrome by default.
    let link: Color

    /// Diff colors for the coding agent's inline write/edit preview
    /// (`FileDiffCard`) — fixed, recognizable green/red rather than the
    /// app's monochrome default chrome, matching the diff-view convention
    /// every code editor already trained the user on. Same values GitHub
    /// uses for its own dark/light diffs, chosen for verified contrast
    /// against `backgroundCode` in both themes rather than raw system
    /// red/green, which would clash with this app's warmer neutrals.
    let diffAdded: Color
    let diffRemoved: Color

    func rowBackground(isSelected: Bool, isHovered: Bool) -> Color {
        if isSelected { return backgroundSelected }
        if isHovered { return backgroundHover }
        return .clear
    }

    static func forScheme(_ scheme: ColorScheme) -> ThemeColors {
        scheme == .dark ? .dark : .light
    }

    // ChatGPT-desktop-style neutrals: a warm dark charcoal stage with a
    // slightly *darker* sidebar receding behind it (not lighter), and
    // popovers/inputs a shade lighter than the stage so they read as
    // "sitting on top" of it.
    // Darkened 2026-07-12 — the old #212121 stage read as noticeably lighter
    // gray than the near-black the app should have; every surface below is
    // shifted down together so the same relative layering (sidebar recedes
    // darkest, elevated surfaces sit a shade above the stage) still holds.
    static let dark = ThemeColors(
        backgroundPrimary: Color(hex: "#121212"),
        backgroundSidebar: Color(hex: "#131313"),
        backgroundElevated: Color(hex: "#161616"),
        backgroundPopover: Color(hex: "#1A1A1A"),
        backgroundInput: Color(hex: "#1C1C1C"),
        backgroundInputSecondary: Color(hex: "#262626"),
        backgroundCode: Color(hex: "#0A0A0A"),
        backgroundCodeHeader: Color(hex: "#1C1C1C"),
        backgroundChip: Color(hex: "#1C1C1C"),
        backgroundChipSecondary: Color(hex: "#262626"),
        backgroundChart: Color(hex: "#1A1A1A"),
        backgroundOverlay: Color.black.opacity(0.6),
        backgroundHover: Color.white.opacity(0.06),
        backgroundSelected: Color.white.opacity(0.11),
        backgroundSubtle: Color.white.opacity(0.06),
        textPrimary: Color(hex: "#ECECEC"),
        textSecondary: Color(hex: "#B4B4B4"),
        textTertiary: Color(hex: "#8E8E9C"),
        textCode: Color(hex: "#ECECEC"),
        borderSubtle: Color.white.opacity(0.10),
        borderMedium: Color.white.opacity(0.16),
        userBubble: Color(hex: "#1C1C1C"),
        shadowColor: Color.black.opacity(0.5),
        destructive: Color(hex: "#FF6467"),
        link: Color(hex: "#5B9BFF"),
        diffAdded: Color(hex: "#3FB950"),
        diffRemoved: Color(hex: "#F85149")
    )

    static let light = ThemeColors(
        backgroundPrimary: Color(hex: "#FFFFFF"),
        backgroundSidebar: Color(hex: "#F9F9F9"),
        backgroundElevated: Color(hex: "#FFFFFF"),
        backgroundPopover: Color(hex: "#FFFFFF"),
        backgroundInput: Color(hex: "#FFFFFF"),
        backgroundInputSecondary: Color(hex: "#F5F5F5"),
        backgroundCode: Color(hex: "#F5F5F5"),
        backgroundCodeHeader: Color(hex: "#EDEDED"),
        backgroundChip: Color(hex: "#F5F5F5"),
        backgroundChipSecondary: Color(hex: "#E5E5E5"),
        backgroundChart: Color(hex: "#F5F5F5"),
        backgroundOverlay: Color.black.opacity(0.3),
        backgroundHover: Color.black.opacity(0.045),
        backgroundSelected: Color.black.opacity(0.07),
        backgroundSubtle: Color.black.opacity(0.045),
        textPrimary: Color(hex: "#0D0D0D"),
        textSecondary: Color(hex: "#5D5D5D"),
        // Darkened from #8E8E9C, which measures ~3.23:1 against this
        // background — fails WCAG AA's 4.5:1 for normal text (the dark-mode
        // value passes fine as-is; only light mode needed the fix).
        textTertiary: Color(hex: "#6E6E7A"),
        textCode: Color(hex: "#1F2328"),
        borderSubtle: Color.black.opacity(0.08),
        borderMedium: Color.black.opacity(0.14),
        userBubble: Color(hex: "#F4F4F4"),
        shadowColor: Color.black.opacity(0.10),
        destructive: Color(hex: "#E7000B"),
        link: Color(hex: "#2563EB"),
        diffAdded: Color(hex: "#1A7F37"),
        diffRemoved: Color(hex: "#CF222E")
    )
}

private struct ThemeColorsKey: EnvironmentKey {
    static let defaultValue = ThemeColors.dark
}

extension EnvironmentValues {
    var themeColors: ThemeColors {
        get { self[ThemeColorsKey.self] }
        set { self[ThemeColorsKey.self] = newValue }
    }
}

extension View {
    func themed(_ colors: ThemeColors) -> some View {
        environment(\.themeColors, colors)
    }
}
