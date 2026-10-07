import MetalKit
import SwiftUI

/// One layer of the UI behind the glass, which the lens refracts. Lay the
/// same content out at the same `rect` in the live UI, so the two line up.
struct BackdropLayer {
    /// Change it whenever the content changes; the layer's texture is only
    /// rendered again when this, its size, the colour scheme or the text size change.
    var id: AnyHashable
    /// Where the layer sits on screen, in points. Moving it doesn't re-render it.
    var rect: CGRect
    var opacity: Double = 1
    /// Points of blur.
    var blur: Double = 0
    var content: AnyView
}

/// The landing screen's glass, drawn in Metal over the real UI: lenses that
/// refract `layers` (the UI behind the glass) and `marbles`, and the marbles
/// themselves. Lay it over the UI, the same size, with the same coordinates.
/// It's transparent outside the glass and doesn't take touches.
struct GlassLensView: UIViewRepresentable {
    var lenses: [LensInstance]
    var parameters: LensParameters
    var crescentColor: Color = LandingTuning().crescentColor
    var layers: [BackdropLayer]
    var marbles: [MarbleInstance] = []

    func makeCoordinator() -> LensRenderer? { LensRenderer() }

    func makeUIView(context: Context) -> UIView {
        context.coordinator?.makeView() ?? UIView()
    }

    func updateUIView(_ view: UIView, context: Context) {
        guard let renderer = context.coordinator, let metalView = view as? MTKView else { return }
        let environment = context.environment

        var rendered: [LensRenderer.Layer] = []
        var keys: Set<AnyHashable> = []
        for layer in layers.prefix(LensRenderer.maxLayers) {
            let key = LayerKey(
                id: layer.id,
                width: layer.rect.width,
                height: layer.rect.height,
                colorScheme: environment.colorScheme,
                displayScale: environment.displayScale,
                dynamicTypeSize: environment.dynamicTypeSize
            )
            keys.insert(key)
            var texture = renderer.layerTextures[key]
            if texture == nil {
                texture = BackdropTexture.render(layer.content, size: layer.rect.size, environment: environment, device: renderer.device)
                if let texture {
                    renderer.generateMipmaps(texture)
                    renderer.layerTextures[key] = texture
                }
            }
            if let texture {
                rendered.append(.init(texture: texture, rect: layer.rect, opacity: layer.opacity, blur: layer.blur))
            }
        }
        renderer.layerTextures = renderer.layerTextures.filter { keys.contains($0.key) }

        if !marbles.isEmpty, renderer.marbleArt == nil, let art = MarbleArt.makeTexture(device: renderer.device) {
            renderer.generateMipmaps(art)
            renderer.marbleArt = art
        }

        let paper = Palette.paper.resolve(in: environment)
        renderer.state = .init(
            lenses: lenses,
            parameters: parameters,
            palette: CrescentPalette(core: crescentColor),
            paper: SIMD3(paper.red, paper.green, paper.blue),
            grain: Float(Palette.grain(environment.colorScheme)),
            dark: environment.colorScheme == .dark,
            layers: rendered,
            marbles: marbles
        )
        metalView.draw()
    }
}

private struct LayerKey: Hashable {
    var id: AnyHashable
    var width: CGFloat
    var height: CGFloat
    var colorScheme: ColorScheme
    var displayScale: CGFloat
    var dynamicTypeSize: DynamicTypeSize
}
