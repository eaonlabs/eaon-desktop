import SwiftUI

/// What a drag on the glass did, for the haptics that go with it.
enum LensEvent {
    /// A finger picked up the dome or the orb.
    case pickedUp
    /// Letting go now would go through (forward, or back to the start).
    case armed
    /// The lens went through to the home screen.
    case entered
    /// The orb was dropped at the bottom and everything went back to the start.
    case returned
}

/// The touch layer over the landing screen: turns a drag on the glass into
/// the engine's `begin`, `move` and `end`, and reports what happened.
///
/// It only catches touches on the glass (and, at the start, anywhere along
/// the bottom, so the dome is easy to pick up), leaving the rest of the
/// screen to the buttons under it.
struct LensTouchArea: View {
    let engine: LandingEngine
    let frame: LandingFrame
    let onEvent: (LensEvent) -> Void

    @GestureState private var touching = false

    var body: some View {
        Color.clear
            .contentShape(touchShape)
            .gesture(drag)
            // The system can cancel a drag without an end event; let go of the glass then too.
            .onChange(of: touching) { _, isTouching in
                if !isTouching { engine.cancelHold() }
            }
            .accessibilityHidden(true)
    }

    private var touchShape: TouchShape {
        let l = frame.layout
        // While Reduce Motion crossfades, the lens that counts is the one being arrived at.
        let lens = frame.lenses.last ?? LensInstance(center: l.domeCenter, radius: l.domeRadius)
        let circle = CGRect(
            x: lens.center.x - lens.radius,
            y: lens.center.y - lens.radius,
            width: lens.radius * 2,
            height: lens.radius * 2
        )
        if frame.isHome {
            // A little larger than the orb, which is small for a fingertip.
            return TouchShape(rect: nil, circle: circle.insetBy(dx: -22, dy: -22))
        }
        let bottom = CGRect(x: 0, y: l.domeGrabLine, width: l.width, height: l.height - l.domeGrabLine)
        return TouchShape(rect: bottom, circle: circle)
    }

    private var drag: some Gesture {
        DragGesture(minimumDistance: 0)
            .updating($touching) { _, state, _ in state = true }
            .onChanged { value in
                let time = value.time.timeIntervalSinceReferenceDate
                if !engine.isHolding {
                    guard engine.begin(at: value.startLocation, time: time) else { return }
                    onEvent(.pickedUp)
                }
                if engine.move(to: value.location, time: time) == .armed {
                    onEvent(.armed)
                }
            }
            .onEnded { value in
                switch engine.end(velocity: value.velocity) {
                case .entered: onEvent(.entered)
                case .returned: onEvent(.returned)
                case .none: break
                }
            }
    }
}

/// The part of the screen that picks up the glass.
private struct TouchShape: Shape {
    var rect: CGRect?
    var circle: CGRect

    func path(in _: CGRect) -> Path {
        var path = Path()
        if let rect { path.addRect(rect) }
        path.addEllipse(in: circle)
        return path
    }
}

/// A count of each lens event, for `.sensoryFeedback` to fire on.
struct LensHaptics: Equatable {
    var pickedUp = 0
    var armed = 0
    var entered = 0
    var returned = 0

    mutating func record(_ event: LensEvent) {
        switch event {
        case .pickedUp: pickedUp += 1
        case .armed: armed += 1
        case .entered: entered += 1
        case .returned: returned += 1
        }
    }
}

extension View {
    /// A tap when the glass is picked up, a tick when letting go would go
    /// through, and a thump when it does.
    func lensHaptics(_ haptics: LensHaptics) -> some View {
        sensoryFeedback(.impact(weight: .light, intensity: 0.7), trigger: haptics.pickedUp)
            .sensoryFeedback(.selection, trigger: haptics.armed)
            .sensoryFeedback(.impact(weight: .medium), trigger: haptics.entered)
            .sensoryFeedback(.impact(weight: .light), trigger: haptics.returned)
    }
}
