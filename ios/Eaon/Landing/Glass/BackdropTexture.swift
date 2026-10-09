import Metal
import SwiftUI

/// What the lens sees: a SwiftUI view rendered into a Metal texture, so the
/// shader can look anywhere on it. (SwiftUI's own `layerEffect` only hands a
/// shader the part of the layer near each tile it shades; a lens that looks
/// a radius away from a pixel came back with blank paper.)
///
/// The view is drawn with a transparent background, premultiplied, in sRGB,
/// with room for mipmaps (LensRenderer builds them), since the rim of the
/// lens shrinks it a long way.
@MainActor
enum BackdropTexture {
    /// How many texels per pixel. The lens magnifies, so a little extra keeps
    /// the text in its middle sharp.
    static let oversample: CGFloat = 1.5

    static func render(
        _ content: some View,
        size: CGSize,
        environment: EnvironmentValues,
        device: MTLDevice
    ) -> MTLTexture? {
        guard size.width >= 1, size.height >= 1 else { return nil }
        // ImageRenderer doesn't inherit the environment; pass on what changes how text is set.
        let renderer = ImageRenderer(
            content: content
                .frame(width: size.width, height: size.height)
                .environment(\.colorScheme, environment.colorScheme)
                .environment(\.displayScale, environment.displayScale)
                .environment(\.dynamicTypeSize, environment.dynamicTypeSize)
                .environment(\.layoutDirection, environment.layoutDirection)
                .environment(\.locale, environment.locale)
                .environment(\.legibilityWeight, environment.legibilityWeight)
        )
        renderer.proposedSize = ProposedViewSize(size)
        renderer.isOpaque = false
        // Large textures cost memory; 8192 is the most every iPhone supports.
        let limit = 8192 / max(size.width, size.height)
        renderer.scale = min(environment.displayScale * oversample, limit)
        guard let image = renderer.cgImage else { return nil }
        return texture(from: image, device: device)
    }

    /// Uploads an image as RGBA, 8 bits, premultiplied, sRGB, with room for mipmaps.
    static func texture(from image: CGImage, device: MTLDevice) -> MTLTexture? {
        let width = image.width
        let height = image.height
        let bytesPerRow = width * 4
        // Drawn upright, CoreGraphics puts the top row first, as Metal expects.
        guard
            let space = CGColorSpace(name: CGColorSpace.sRGB),
            let context = CGContext(
                data: nil,
                width: width,
                height: height,
                bitsPerComponent: 8,
                bytesPerRow: bytesPerRow,
                space: space,
                bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue
            )
        else { return nil }
        context.draw(image, in: CGRect(x: 0, y: 0, width: width, height: height))
        guard let pixels = context.data else { return nil }

        let descriptor = MTLTextureDescriptor.texture2DDescriptor(
            pixelFormat: .rgba8Unorm,
            width: width,
            height: height,
            mipmapped: true
        )
        descriptor.usage = .shaderRead
        guard let texture = device.makeTexture(descriptor: descriptor) else { return nil }
        texture.replace(
            region: MTLRegionMake2D(0, 0, width, height),
            mipmapLevel: 0,
            withBytes: pixels,
            bytesPerRow: bytesPerRow
        )
        return texture
    }
}
