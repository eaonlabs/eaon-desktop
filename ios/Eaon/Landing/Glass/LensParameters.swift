import Foundation

/// How the glass lens bends and catches light: the knobs of `lensFragment`
/// in Lens.metal. The defaults are tuned against the reference frames; the
/// debug panel (GlassTuningPanel) changes them live.
struct LensParameters: Equatable {
    /// How far a line of sight bends where the glass is steepest, in lens
    /// radii. Past about 1, the rim shows what's under the middle again,
    /// upside down.
    var refraction = 1.2
    /// How much the middle of the lens magnifies.
    var magnification = 1.5
    /// The bevel round the edge, as a fraction of the radius. The image
    /// swells into a smear where the bevel starts and folds over across it.
    var rimWidth = 0.35
    /// How gently the bevel starts: 2 is a round edge, which folds the image
    /// along a hard line; higher starts flatter and steepens later, which
    /// widens the smear and squeezes the folded ring toward the edge.
    var rimCurve = 4.0
    /// How far apart red and blue bend, as a fraction of the bend. Where the
    /// rim smears the image, a little of this fills letters with colour.
    var dispersion = 0.1
    /// The light the glass catches: the specular line along its upper-left
    /// edge and the pale lip of the steep bevel. 0 is unlit glass.
    var highlight = 1.0
}
