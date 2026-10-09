import UIKit

/// Small taps for the things that deserve one. Turned off from Settings.
@MainActor
enum Haptic {
    static let defaultsKey = "eaon.haptics"

    private static var isOn: Bool {
        UserDefaults.standard.object(forKey: defaultsKey) as? Bool ?? true
    }

    static func tap() {
        guard isOn else { return }
        UIImpactFeedbackGenerator(style: .light).impactOccurred(intensity: 0.7)
    }

    static func select() {
        guard isOn else { return }
        UISelectionFeedbackGenerator().selectionChanged()
    }

    static func success() {
        guard isOn else { return }
        UINotificationFeedbackGenerator().notificationOccurred(.success)
    }

    static func warning() {
        guard isOn else { return }
        UINotificationFeedbackGenerator().notificationOccurred(.warning)
    }

    static func failure() {
        guard isOn else { return }
        UINotificationFeedbackGenerator().notificationOccurred(.error)
    }
}
