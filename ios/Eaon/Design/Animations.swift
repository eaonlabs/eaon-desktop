import SwiftUI

/// The app's springs, so things that move together move alike.
enum Springs {
    /// Presses and toggles: small things answering a finger.
    static var snappy: Animation { .spring(response: 0.3, dampingFraction: 0.78) }
    /// Things arriving and leaving: messages, screens, sections.
    static var smooth: Animation { .spring(response: 0.5, dampingFraction: 0.88) }
    /// A little overshoot, for something that wants to be noticed.
    static var bouncy: Animation { .spring(response: 0.45, dampingFraction: 0.64) }
}

extension View {
    /// Rises into place and comes into focus the first time it shows. Staggering `delay` across
    /// siblings brings a group in one after another. With `isEnabled` false it's simply there,
    /// which is how a message from the history shows up without replaying its arrival.
    func entrance(
        delay: Double = 0,
        rise: CGFloat = 14,
        scale: CGFloat = 1,
        anchor: UnitPoint = .center,
        animation: Animation = Springs.smooth,
        isEnabled: Bool = true
    ) -> some View {
        modifier(Entrance(delay: delay, rise: rise, scale: scale, anchor: anchor, animation: animation, isEnabled: isEnabled))
    }
}

private struct Entrance: ViewModifier {
    var delay: Double
    var rise: CGFloat
    var scale: CGFloat
    var anchor: UnitPoint
    var animation: Animation
    var isEnabled: Bool

    @State private var shown = false
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    func body(content: Content) -> some View {
        let hidden = isEnabled && !shown
        let moves = hidden && !reduceMotion
        content
            .opacity(hidden ? 0 : 1)
            .scaleEffect(moves ? scale : 1, anchor: anchor)
            .offset(y: moves ? rise : 0)
            .blur(radius: moves ? 6 : 0)
            .onAppear {
                guard !shown else { return }
                guard isEnabled else {
                    shown = true
                    return
                }
                withAnimation(reduceMotion ? .easeOut(duration: 0.2) : animation.delay(delay)) {
                    shown = true
                }
            }
    }
}

extension AnyTransition {
    /// A screen or a block coming into focus: it fades, sharpens and settles from a touch larger.
    static var focus: AnyTransition {
        .modifier(active: FocusTransition(amount: 1), identity: FocusTransition(amount: 0))
    }
}

private struct FocusTransition: ViewModifier {
    var amount: Double

    func body(content: Content) -> some View {
        content
            .opacity(1 - amount)
            .scaleEffect(1 + 0.015 * amount)
            .blur(radius: 8 * amount)
    }
}
