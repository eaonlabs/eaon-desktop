import SwiftUI

/// Where everything on the landing screen sits, in full-screen points with
/// the origin at the screen's top-left corner. The engine, the live UI, the
/// layers behind the glass and the gestures all take their positions from
/// here. Proportions follow the reference frames.
struct LandingLayout: Equatable {
    var size: CGSize
    var insets: EdgeInsets
    /// The dome's and the orb's radii, as fractions of the width (from LandingTuning).
    var restRadiusFraction = 0.47
    var endRadiusFraction = 0.075
    /// Point sizes of the opening line and of the welcome, after Dynamic Type.
    var introFontSize: CGFloat = 26
    var welcomeFontSize: CGFloat = 27

    var width: CGFloat { size.width }
    var height: CGFloat { size.height }
    var midX: CGFloat { size.width / 2 }

    // MARK: Intro

    /// The opening line, two lines centred a little above the middle.
    var introRect: CGRect {
        let h = introFontSize * 1.3 * 2 + 24
        return CGRect(x: 24, y: height * 0.48 - h / 2, width: width - 48, height: h)
    }

    /// The glass dome resting on the bottom edge, its top at 73% of the height.
    var domeRadius: CGFloat { min(width * restRadiusFraction, 260) }
    var domeCenter: CGPoint { CGPoint(x: midX, y: height * 0.73 + domeRadius) }
    /// Touches below this line pick up the dome, not just touches on the glass.
    var domeGrabLine: CGFloat { height * 0.55 }
    /// The lens over the welcome: wide enough to hold "Meet Eaon." and show
    /// its folded rim, as in the reference, before it shrinks into the orb.
    var liftedRadius: CGFloat { min(width * 0.29, domeRadius * 0.7) }
    var hintY: CGFloat { min(height * 0.89, height - insets.bottom - 34) }

    // MARK: Home

    /// Top of the welcome: "Meet Eaon." and the line under it.
    var welcomeTop: CGFloat { height * 0.47 }
    var titleRect: CGRect {
        CGRect(x: 24, y: welcomeTop, width: width - 48, height: (welcomeFontSize * 1.3).rounded(.up))
    }
    var subtitleRect: CGRect {
        CGRect(x: 24, y: titleRect.maxY, width: width - 48, height: (welcomeFontSize * 1.3 * 2 + 8).rounded(.up))
    }
    /// The small orb the lens settles into, just above the welcome.
    var orbRadius: CGFloat { (width * endRadiusFraction).rounded() }
    var orbCenter: CGPoint { CGPoint(x: midX, y: welcomeTop - 26 - orbRadius) }
    /// The orb picked up and dragged down over the text: a magnifier.
    var magnifierRadius: CGFloat { domeRadius * 0.58 }
    /// How far the orb has been dragged from its place toward the dome, 0…1.
    func returnProgress(y: CGFloat) -> Double {
        Double((y - orbCenter.y) / max(domeCenter.y - orbCenter.y, 1))
    }

    static let buttonHeight: CGFloat = 52
    static let buttonSpacing: CGFloat = 10
    /// "Continue without signing up", a quiet line under the two buttons.
    static let guestHeight: CGFloat = 44
    var buttonsRect: CGRect {
        let h = Self.buttonHeight * 2 + Self.buttonSpacing * 2 + Self.guestHeight
        let bottom = height - max(insets.bottom, 16) - 8
        return CGRect(x: 20, y: bottom - h, width: width - 40, height: h)
    }
}
