import SwiftUI
import UIKit

extension UIColor {
    convenience init(hex: UInt32, alpha: CGFloat = 1) {
        self.init(
            red: CGFloat((hex >> 16) & 0xFF) / 255,
            green: CGFloat((hex >> 8) & 0xFF) / 255,
            blue: CGFloat(hex & 0xFF) / 255,
            alpha: alpha
        )
    }
}

extension Color {
    /// A colour that follows the appearance.
    init(light: UInt32, dark: UInt32) {
        self.init(uiColor: UIColor { $0.userInterfaceStyle == .dark ? UIColor(hex: dark) : UIColor(hex: light) })
    }
}

/// What the screens after the landing are made of, after ChatGPT on the iPhone: a plain page (white,
/// or true black in dark mode), soft grey surfaces instead of bordered cards, glass for the controls
/// that float, and ink for what can be pressed. The landing keeps its warm paper.
extension Palette {
    /// Behind every screen and sheet.
    static let background = Color(light: 0xFFFFFF, dark: 0x000000)
    /// Grouped rows, cards, the composer and the user's message.
    static let surface = Color(light: 0xF4F4F4, dark: 0x202020)
    /// A step up from a surface: a highlighted row, chips and buttons sitting on one, the pressed state.
    static let fill = Color(light: 0xE8E8E8, dark: 0x363636)
    static let hairline = Color(light: 0xE3E3E3, dark: 0x3A3A3A)
    /// Text that steps back: subtitles, footnotes, the quiet half of a row.
    static let secondary = Color(light: 0x6E6E6E, dark: 0xB4B4B4)
    /// Quieter still: placeholders and chevrons.
    static let tertiary = Color(light: 0x9B9B9B, dark: 0x8E8E8E)
    static let tint = Color(hex: 0x3E86C6)
    static let positive = Color(hex: 0x3FAE6A)
    static let negative = Color(hex: 0xE4574B)
    static let caution = Color(hex: 0xE7B727)
    /// The drawer, the same page the screen sits on.
    static let drawer = Color(light: 0xFFFFFF, dark: 0x000000)
    /// Laid over the screen while the drawer pushes it aside: it greys a little, either way.
    static let pushedTint = Color(light: 0x000000, dark: 0xFFFFFF)
}

/// Sizes the screens share, so cards and gutters line up from screen to screen.
enum Metrics {
    static let gutter: CGFloat = 20
    static let cardRadius: CGFloat = 20
    static let fieldRadius: CGFloat = 18
    static let controlHeight: CGFloat = 50
}

extension View {
    /// A soft grey card on the page: continuous corners, no border, no shadow.
    func card(padding: CGFloat = 18, radius: CGFloat = Metrics.cardRadius) -> some View {
        self.padding(padding)
            .background(Palette.surface, in: RoundedRectangle(cornerRadius: radius, style: .continuous))
    }
}

/// The page, behind every screen.
struct ScreenBackground: View {
    var body: some View {
        Palette.background.ignoresSafeArea()
    }
}

extension View {
    /// Liquid Glass on iOS 26 and later, for controls that float over the page; a soft grey fill before that.
    @ViewBuilder
    func glass<S: Shape>(in shape: S, interactive: Bool = true) -> some View {
        if #available(iOS 26.0, *) {
            glassEffect(interactive ? .regular.interactive() : .regular, in: shape)
        } else {
            background(Palette.surface, in: shape)
        }
    }
}
