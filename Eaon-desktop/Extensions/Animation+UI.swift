import SwiftUI

/// The app's two motion curves, matched to Jan.
///
/// These were previously the much stronger curves Emil Kowalski's design-eng
/// notes point to — `cubic-bezier(0.23, 1, 0.32, 1)` and
/// `(0.77, 0, 0.175, 1)`. Those are *more* expressive: a very fast start and
/// a long settle, which reads as deliberate on a landing page and as busy in
/// an app you sit in all day.
///
/// Jan's motion is quieter and quicker — one default duration of 150ms and
/// the standard Material curve, taken from its shipped
/// `--default-transition-duration: .15s` and
/// `--default-transition-timing-function: cubic-bezier(.4, 0, .2, 1)`. The
/// call sites keep their names, so this retunes the whole app's feel without
/// touching a single view.
extension Animation {
    /// Jan's default duration. Most transitions should just use this rather
    /// than inventing a number — a single shared duration is a large part of
    /// why an interface feels coherent instead of assembled.
    static let uiDuration: Double = 0.15

    /// For anything entering, exiting, or responding to a press.
    /// Jan's `--ease-out: cubic-bezier(0, 0, .2, 1)` — decelerating, no
    /// overshoot.
    static func uiEaseOut(duration: Double = uiDuration) -> Animation {
        .timingCurve(0, 0, 0.2, 1, duration: duration)
    }

    /// For something already on screen moving from A to B (reordering,
    /// expanding in place). Jan's `--ease-in-out: cubic-bezier(.4, 0, .2, 1)`,
    /// which is also its default timing function.
    static func uiEaseInOut(duration: Double = uiDuration) -> Animation {
        .timingCurve(0.4, 0, 0.2, 1, duration: duration)
    }
}
