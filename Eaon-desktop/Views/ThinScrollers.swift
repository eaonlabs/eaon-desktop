import SwiftUI
import AppKit

/// Thin dark scrollers, applied to whichever `NSScrollView` encloses this
/// view.
///
/// The stock scroller isn't a bug and isn't light mode leaking through: in
/// `darkAqua` macOS deliberately draws a **light** knob, reasoning that it
/// should contrast with a dark window. Against Eaon's near-black chrome that
/// reads as a bright white bar stapled to the edge — the loudest thing on the
/// screen and never what you're looking at.
///
/// `scrollerKnobStyle = .dark` asks for the opposite: a dark knob, which
/// AppKit intends for light content but which is exactly right here.
/// `controlSize = .small` narrows it.
///
/// ## Why this and not a custom NSScroller
///
/// A `NSScroller` subclass overriding `drawKnob`/`drawKnobSlot` gives exact
/// control over width and colour, and was written first. It was dropped
/// because it could not be **verified**: an overlay scroller only draws while
/// it is active, so rendering one offscreen produces an empty image even with
/// the knob forced to solid red. Shipping unverifiable custom drawing risks
/// every scrollbar in the app disappearing, which is far worse than a knob
/// that is a shade off. These two properties are native, already proven in
/// this app's chat sidebar, and leave overlay fade, click-to-page and drag
/// behaviour completely untouched.
///
/// SwiftUI exposes no handle on the backing `NSScrollView` and there is no
/// appearance proxy for scrollers, so the only way in is to sit inside the
/// hierarchy and walk up. That is fragile by nature, so it fails soft: find
/// nothing, change nothing.
private struct ScrollerStyleInstaller: NSViewRepresentable {
    func makeNSView(context: Context) -> NSView {
        let probe = NSView(frame: .zero)
        // Deferred: at `makeNSView` time the probe has no superview yet, so
        // there is nothing to walk up to.
        DispatchQueue.main.async { style(from: probe) }
        return probe
    }

    func updateNSView(_ nsView: NSView, context: Context) {
        DispatchQueue.main.async { style(from: nsView) }
    }

    private func style(from probe: NSView) {
        var candidate: NSView? = probe.superview
        while let view = candidate {
            if let scrollView = view as? NSScrollView {
                scrollView.scrollerStyle = .overlay
                scrollView.scrollerKnobStyle = .dark
                scrollView.verticalScroller?.controlSize = .small
                scrollView.horizontalScroller?.controlSize = .small
                return
            }
            candidate = view.superview
        }
    }
}

extension View {
    /// Applies Eaon's thin dark scrollers to the enclosing scroll view.
    ///
    /// Put this on the scroll view's **content**, not on the `ScrollView`
    /// itself — only the content actually lives inside the `NSScrollView`, so
    /// from outside there is nothing to walk up to and the modifier silently
    /// does nothing.
    func thinScrollers() -> some View {
        background(ScrollerStyleInstaller().frame(width: 0, height: 0))
    }
}
