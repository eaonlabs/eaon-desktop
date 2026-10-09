import SwiftUI

enum Palette {
    /// The warm paper the landing screen is printed on (charcoal in dark mode, like the app icon's tile).
    static let paper = Color("Paper")
    static let ink = Color("Ink")
    static let inkSecondary = Color("InkSecondary")

    /// How strong the paper's film grain is.
    static func grain(_ scheme: ColorScheme) -> Double { scheme == .dark ? 0.04 : 0.05 }

    /// The colours a worker can be given in the desktop app (WORKER_COLORS in
    /// src/shared/workers.ts), so an agent looks the same on both.
    static let workerHex: [UInt32] = [
        0x3E86C6, 0x5B6CF0, 0x8E5CE6, 0xD6509B, 0xE4574B,
        0xEE8A36, 0xE7B727, 0x3FAE6A, 0x22A7A0, 0x6B7280
    ]
    static let workers: [Color] = workerHex.map { Color(hex: $0) }
}

extension Color {
    init(hex: UInt32) {
        self.init(
            .sRGB,
            red: Double((hex >> 16) & 0xFF) / 255,
            green: Double((hex >> 8) & 0xFF) / 255,
            blue: Double(hex & 0xFF) / 255
        )
    }
}

/// Relative luminance of an sRGB hex colour, 0 (black) … 1 (white).
func luminance(hex: UInt32) -> Double {
    func linear(_ channel: UInt32) -> Double {
        let c = Double(channel & 0xFF) / 255
        return c <= 0.04045 ? c / 12.92 : pow((c + 0.055) / 1.055, 2.4)
    }
    return 0.2126 * linear(hex >> 16) + 0.7152 * linear(hex >> 8) + 0.0722 * linear(hex)
}
