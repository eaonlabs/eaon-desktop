import AppKit
import SwiftUI

enum AppTheme: String, CaseIterable, Identifiable {
    case light = "Light"
    case dark = "Dark"
    case system = "System"
    var id: String { rawValue }

    var colorScheme: ColorScheme? {
        switch self {
        case .light: return .light
        case .dark: return .dark
        case .system: return nil
        }
    }
}

enum AppFontSize: String, CaseIterable, Identifiable {
    case small = "Small"
    case medium = "Medium"
    case large = "Large"
    var id: String { rawValue }

    /// 16pt at Medium, with Small and Large a fixed ratio either side.
    ///
    /// The numbers are Jan's, and the ratios matter more than the values:
    /// its whole type scale derives from one `--font-size-base` (16px), with
    /// `--text-sm` at 0.875× and `--text-lg` at 1.125×. Eaon's old 13/15/17
    /// was both a step smaller and unevenly spaced, which is most of why the
    /// two apps read differently at a glance even with the same typeface.
    var messageFontSize: CGFloat {
        switch self {
        case .small: return 14   // 0.875 × 16
        case .medium: return 16  // Jan's --font-size-base
        case .large: return 18   // 1.125 × 16
        }
    }

    /// The same ratios, so chrome scales with body text rather than drifting
    /// against it — Jan derives every size from the one base for exactly
    /// this reason.
    var uiScale: CGFloat {
        switch self {
        case .small: return 0.875
        case .medium: return 1.0
        case .large: return 1.125
        }
    }
}

enum NotificationPosition: String, CaseIterable, Identifiable {
    case topRight = "Top right"
    case topLeft = "Top left"
    case bottomRight = "Bottom right"
    case bottomLeft = "Bottom left"
    var id: String { rawValue }
}

@MainActor
@Observable
final class AppearanceSettings {
    static let shared = AppearanceSettings()

    var theme: AppTheme {
        didSet {
            UserDefaults.standard.set(theme.rawValue, forKey: "app_theme")
            Self.syncAppKitAppearance(to: theme)
        }
    }

    /// Makes the *real* AppKit appearance match the theme the user picked in
    /// Settings — not just SwiftUI's `.preferredColorScheme`, which is a
    /// separate, narrower override.
    ///
    /// `.preferredColorScheme` only changes the SwiftUI `\.colorScheme`
    /// environment value — what `ThemeColors.forScheme` and every `Color`
    /// this app draws by hand key off. It does NOT touch the AppKit
    /// appearance that every AppKit-backed control (a `Picker` in `.menu`
    /// style is a real `NSPopUpButton`, same for native alerts and menus)
    /// resolves its system colors against. Leave that unsynced and picking
    /// Light while the Mac itself is in Dark mode makes every custom SwiftUI
    /// surface go light while native controls keep drawing their
    /// dark-appearance (near-white) label color — invisible against the new
    /// light background it now sits on.
    ///
    /// Setting `NSApp.appearance` alone isn't enough to fix that: it only
    /// changes the *default* new windows are created with. A window that's
    /// already on screen — like this one, mid-visit to the very Settings
    /// screen showing the broken picker — doesn't repaint just because the
    /// application-level default changed; its already-resolved control
    /// colors stay stale until something invalidates them. Setting each open
    /// window's own `.appearance` is what reliably forces that
    /// re-resolve-and-redraw, which is why both loops are here: `NSApp`
    /// covers windows created from here on, `NSApp.windows` covers the one
    /// already open right now.
    private static func syncAppKitAppearance(to theme: AppTheme) {
        let resolved: NSAppearance? = {
            switch theme {
            case .light: return NSAppearance(named: .aqua)
            case .dark: return NSAppearance(named: .darkAqua)
            // nil defers to the system preference — exactly what "System" means.
            case .system: return nil
            }
        }()
        NSApp.appearance = resolved
        for window in NSApp.windows {
            window.appearance = resolved
        }
    }

    var fontSize: AppFontSize {
        didSet { UserDefaults.standard.set(fontSize.rawValue, forKey: "app_font_size") }
    }

    var notificationPosition: NotificationPosition {
        didSet { UserDefaults.standard.set(notificationPosition.rawValue, forKey: "app_notification_position") }
    }

    var showTokenSpeed: Bool {
        didSet { UserDefaults.standard.set(showTokenSpeed, forKey: "app_show_token_speed") }
    }

    var coloredUserBubble: Bool {
        didSet { UserDefaults.standard.set(coloredUserBubble, forKey: "app_colored_user_bubble") }
    }

    /// The app's one accent, used for buttons, links, and selection states.
    ///
    /// There is no accent *picker* any more, and no multicolor mode: Eaon's
    /// chrome is monochrome by design, and a palette of user-chosen hues
    /// fought that rather than serving it.
    ///
    /// White — but adaptively so. A literal `#FFFFFF` is correct on the dark
    /// theme this app is built around, and invisible on the light one, whose
    /// page background is also `#FFFFFF`; a filled accent button there would
    /// be a shape you can't see. So this resolves to white on dark surfaces
    /// and to near-black on light ones. That's the same inverted-surface
    /// treatment `DialogButton`'s primary style already used
    /// (`textPrimary` on `backgroundPrimary`), just made available to every
    /// caller that asks for the accent.
    var accentColor: Color { Self.monochromeAccent }

    /// The foreground to put on top of an `accentColor` fill — the exact
    /// inverse, so the pair always contrasts whichever way the theme resolved.
    var onAccentColor: Color { Self.monochromeAccentForeground }

    private static let monochromeAccent = Color(nsColor: NSColor(name: nil) { appearance in
        appearance.bestMatch(from: [.aqua, .darkAqua]) == .darkAqua
            ? NSColor.white
            : NSColor(calibratedWhite: 0.05, alpha: 1)
    })

    private static let monochromeAccentForeground = Color(nsColor: NSColor(name: nil) { appearance in
        appearance.bestMatch(from: [.aqua, .darkAqua]) == .darkAqua
            ? NSColor.black
            : NSColor.white
    })

    var colorScheme: ColorScheme? {
        theme.colorScheme
    }

    private init() {
        let savedTheme = UserDefaults.standard.string(forKey: "app_theme") ?? AppTheme.dark.rawValue
        self.theme = AppTheme(rawValue: savedTheme) ?? .dark

        let savedFontSize = UserDefaults.standard.string(forKey: "app_font_size") ?? AppFontSize.medium.rawValue
        self.fontSize = AppFontSize(rawValue: savedFontSize) ?? .medium

        let savedPos = UserDefaults.standard.string(forKey: "app_notification_position") ?? NotificationPosition.topRight.rawValue
        self.notificationPosition = NotificationPosition(rawValue: savedPos) ?? .topRight

        if UserDefaults.standard.object(forKey: "app_show_token_speed") != nil {
            self.showTokenSpeed = UserDefaults.standard.bool(forKey: "app_show_token_speed")
        } else {
            self.showTokenSpeed = true
        }

        self.coloredUserBubble = UserDefaults.standard.bool(forKey: "app_colored_user_bubble")

        // `didSet` above doesn't fire for a property's own initial
        // assignment — sync explicitly, now that every stored property is
        // set and `self` is fully initialized, so a saved Light/Dark choice
        // is already in effect for the very first frame rather than only
        // from the next time the user touches the theme picker.
        Self.syncAppKitAppearance(to: self.theme)
    }

    func resetToDefaults() {
        theme = .dark
        fontSize = .medium
        notificationPosition = .topRight
        showTokenSpeed = true
        coloredUserBubble = false
    }
}
