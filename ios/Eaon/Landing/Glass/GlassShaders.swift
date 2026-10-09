import SwiftUI

/// The Swift side of Glass.metal's SwiftUI shaders.
enum GlassShaders {
    /// Static film grain over a flat fill (a `colorEffect`).
    /// - Parameter amount: the grain's strength; 0 leaves the fill plain.
    static func paperGrain(amount: Double) -> Shader {
        ShaderLibrary.paperGrain(.float(amount))
    }
}
