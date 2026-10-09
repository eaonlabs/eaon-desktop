import MetalKit
import SwiftUI

/// One glass lens to draw this frame.
struct LensInstance: Equatable {
    var center: CGPoint
    var radius: CGFloat
    /// The whole lens, shadow included; below 1 only while crossfading.
    var opacity: Double = 1
    /// The crescent of light, 0…1.
    var crescent: Double = 0
    /// 0 gathers the crescent into a haze in the middle; 1 spreads it round the lower rim.
    var spread: Double = 0
}

/// One marble to draw this frame; the layout matches `Marble` in Lens.metal.
struct MarbleInstance: Equatable {
    var center: SIMD2<Float>
    var radius: Float
    /// Which picture is inside (a slice of MarbleArt's texture).
    var art: Float
    /// How far the picture is turned, in radians.
    var spin: Float
    var alpha: Float
    /// How strongly the glass bends the picture, 0…1.
    var strength: Float
    var unused: Float = 0
}

/// The uniforms of `lensFragment`; the layout matches `LensUniforms` in Lens.metal.
private struct LensUniforms {
    var paper: SIMD4<Float>
    var crescentInner: SIMD4<Float>
    var crescentCore: SIMD4<Float>
    var crescentOuter: SIMD4<Float>
    var viewSize: SIMD2<Float>
    var center: SIMD2<Float>
    var radius: Float
    var refraction: Float
    var magnification: Float
    var rimWidth: Float
    var rimCurve: Float
    var dispersion: Float
    var highlight: Float
    var crescent: Float
    var spread: Float
    var opacity: Float
    var pixelsPerPoint: Float
    var grain: Float
    var dark: Float
    var layerCount: Int32
}

/// The layout matches `BackdropLayer` in Lens.metal.
private struct LayerUniforms {
    var rect: SIMD4<Float>
    var opacity: Float
    var lod: Float
    var unused: SIMD2<Float> = .zero
}

/// The layout matches `MarbleUniforms` in Lens.metal.
private struct MarbleUniforms {
    var view: SIMD4<Float>
    var highlight: Float
    var dark: Float
    var unused: SIMD2<Float> = .zero
}

/// Draws the landing screen's glass into a transparent MTKView over the
/// screen: the marbles, and the lens over them, refracting the UI layers
/// behind it (each a texture) and the marbles. Outside the glass the view is
/// clear, so the real UI shows through.
///
/// It draws when told to (`view.draw()`, from GlassLensView's update), not on
/// a timer, and presents with the Core Animation transaction, so the glass
/// moves in the same frame as the SwiftUI views under it.
@MainActor
final class LensRenderer: NSObject, MTKViewDelegate {
    /// One UI layer behind the glass, as the shader sees it.
    struct Layer {
        var texture: MTLTexture
        /// Where the texture sits on screen, in points.
        var rect: CGRect
        var opacity: Double
        /// Points of blur, done with the texture's mipmaps.
        var blur: Double
    }

    struct State {
        var lenses: [LensInstance] = []
        var parameters = LensParameters()
        var palette = CrescentPalette(core: LandingTuning().crescentColor)
        /// The paper, gamma-encoded sRGB.
        var paper: SIMD3<Float> = .one
        var grain: Float = 0
        var dark = false
        var layers: [Layer] = []
        var marbles: [MarbleInstance] = []
    }

    static let maxLayers = 4
    static let maxMarbles = 512

    var state = State()
    let device: MTLDevice

    /// The rendered UI layers, by key; see GlassLensView.
    var layerTextures: [AnyHashable: MTLTexture] = [:]
    /// The marbles' pictures, made the first time there are marbles.
    var marbleArt: MTLTexture?

    private let queue: MTLCommandQueue
    private let lensPipeline: MTLRenderPipelineState
    private let marblePipeline: MTLRenderPipelineState
    private let scenePipeline: MTLRenderPipelineState
    private let layerSampler: MTLSamplerState
    private let sceneSampler: MTLSamplerState
    private let artSampler: MTLSamplerState
    private let empty: MTLTexture
    private var scene: MTLTexture?
    private var marbleBuffers: [MTLBuffer]
    private var marbleBufferIndex = 0

    init?(device: MTLDevice? = MTLCreateSystemDefaultDevice()) {
        guard
            let device,
            let queue = device.makeCommandQueue(),
            let library = device.makeDefaultLibrary()
        else { return nil }

        func pipeline(_ vertex: String, _ fragment: String, blended: Bool) -> MTLRenderPipelineState? {
            let descriptor = MTLRenderPipelineDescriptor()
            descriptor.vertexFunction = library.makeFunction(name: vertex)
            descriptor.fragmentFunction = library.makeFunction(name: fragment)
            let color = descriptor.colorAttachments[0]!
            color.pixelFormat = .bgra8Unorm
            if blended {
                // Premultiplied "over".
                color.isBlendingEnabled = true
                color.sourceRGBBlendFactor = .one
                color.sourceAlphaBlendFactor = .one
                color.destinationRGBBlendFactor = .oneMinusSourceAlpha
                color.destinationAlphaBlendFactor = .oneMinusSourceAlpha
            }
            return try? device.makeRenderPipelineState(descriptor: descriptor)
        }

        func sampler(mipmapped: Bool, address: MTLSamplerAddressMode) -> MTLSamplerState? {
            let descriptor = MTLSamplerDescriptor()
            descriptor.minFilter = .linear
            descriptor.magFilter = .linear
            // Plain trilinear on purpose: where the rim squeezes text many
            // times over, it should average to grey, as through real glass.
            // Anisotropic filtering kept every stroke and drew hairline rings.
            if mipmapped { descriptor.mipFilter = .linear }
            descriptor.sAddressMode = address
            descriptor.tAddressMode = address
            return device.makeSamplerState(descriptor: descriptor)
        }

        let emptyDescriptor = MTLTextureDescriptor.texture2DDescriptor(pixelFormat: .rgba8Unorm, width: 1, height: 1, mipmapped: false)
        guard
            let lensPipeline = pipeline("lensVertex", "lensFragment", blended: true),
            let marblePipeline = pipeline("marbleVertex", "marbleFragment", blended: true),
            let scenePipeline = pipeline("fullscreenVertex", "sceneFragment", blended: false),
            // Past the edge of a layer, or of the screen, there's only paper.
            let layerSampler = sampler(mipmapped: true, address: .clampToZero),
            let sceneSampler = sampler(mipmapped: false, address: .clampToZero),
            let artSampler = sampler(mipmapped: true, address: .clampToEdge),
            let empty = device.makeTexture(descriptor: emptyDescriptor)
        else { return nil }
        empty.replace(region: MTLRegionMake2D(0, 0, 1, 1), mipmapLevel: 0, withBytes: [UInt8](repeating: 0, count: 4), bytesPerRow: 4)

        // Three, used in turn, so the CPU never writes one the GPU is still reading.
        let length = MemoryLayout<MarbleInstance>.stride * Self.maxMarbles
        let buffers = (0 ..< 3).compactMap { _ in device.makeBuffer(length: length, options: .storageModeShared) }
        guard buffers.count == 3 else { return nil }

        self.device = device
        self.queue = queue
        self.lensPipeline = lensPipeline
        self.marblePipeline = marblePipeline
        self.scenePipeline = scenePipeline
        self.layerSampler = layerSampler
        self.sceneSampler = sceneSampler
        self.artSampler = artSampler
        self.empty = empty
        self.marbleBuffers = buffers
    }

    func makeView() -> MTKView {
        let view = MTKView(frame: .zero, device: device)
        view.delegate = self
        view.colorPixelFormat = .bgra8Unorm
        view.clearColor = MTLClearColor(red: 0, green: 0, blue: 0, alpha: 0)
        view.isOpaque = false
        view.backgroundColor = .clear
        view.isUserInteractionEnabled = false
        view.framebufferOnly = true
        // Drawn on demand, in step with SwiftUI.
        view.isPaused = true
        view.enableSetNeedsDisplay = false
        view.presentsWithTransaction = true
        return view
    }

    /// Builds a texture's mipmaps on the GPU before it's first sampled.
    func generateMipmaps(_ texture: MTLTexture) {
        guard
            texture.mipmapLevelCount > 1,
            let commands = queue.makeCommandBuffer(),
            let blit = commands.makeBlitCommandEncoder()
        else { return }
        blit.generateMipmaps(for: texture)
        blit.endEncoding()
        commands.commit()
    }

    func mtkView(_ view: MTKView, drawableSizeWillChange size: CGSize) {
        // The view resized after its last update; draw it at the new size.
        DispatchQueue.main.async { view.draw() }
    }

    func draw(in view: MTKView) {
        let size = view.bounds.size
        guard
            size.width > 0, size.height > 0,
            let pass = view.currentRenderPassDescriptor,
            let drawable = view.currentDrawable,
            let commands = queue.makeCommandBuffer()
        else { return }
        let pixelsPerPoint = Float(view.drawableSize.width / size.width)
        let viewSize = SIMD2(Float(size.width), Float(size.height))

        // 1. The marbles, into their own texture, so the lens can see them.
        var sceneTexture = empty
        let marbleCount = min(state.marbles.count, Self.maxMarbles)
        if marbleCount > 0, let art = marbleArt, let target = sceneTarget(for: view.drawableSize) {
            let buffer = marbleBuffers[marbleBufferIndex]
            marbleBufferIndex = (marbleBufferIndex + 1) % marbleBuffers.count
            state.marbles.withUnsafeBytes { bytes in
                buffer.contents().copyMemory(from: bytes.baseAddress!, byteCount: MemoryLayout<MarbleInstance>.stride * marbleCount)
            }
            let scenePass = MTLRenderPassDescriptor()
            scenePass.colorAttachments[0].texture = target
            scenePass.colorAttachments[0].loadAction = .clear
            scenePass.colorAttachments[0].storeAction = .store
            scenePass.colorAttachments[0].clearColor = MTLClearColor(red: 0, green: 0, blue: 0, alpha: 0)
            if let encoder = commands.makeRenderCommandEncoder(descriptor: scenePass) {
                var uniforms = MarbleUniforms(
                    view: SIMD4(viewSize.x, viewSize.y, pixelsPerPoint, Float(state.parameters.dispersion)),
                    highlight: Float(state.parameters.highlight),
                    dark: state.dark ? 1 : 0
                )
                encoder.setRenderPipelineState(marblePipeline)
                encoder.setVertexBuffer(buffer, offset: 0, index: 0)
                encoder.setVertexBytes(&uniforms, length: MemoryLayout<MarbleUniforms>.stride, index: 1)
                encoder.setFragmentBytes(&uniforms, length: MemoryLayout<MarbleUniforms>.stride, index: 1)
                encoder.setFragmentTexture(art, index: 0)
                encoder.setFragmentSamplerState(artSampler, index: 0)
                encoder.drawPrimitives(type: .triangleStrip, vertexStart: 0, vertexCount: 4, instanceCount: marbleCount)
                encoder.endEncoding()
                sceneTexture = target
            }
        }

        guard let encoder = commands.makeRenderCommandEncoder(descriptor: pass) else { return }

        // 2. The marbles onto the screen.
        if sceneTexture !== empty {
            encoder.setRenderPipelineState(scenePipeline)
            encoder.setFragmentTexture(sceneTexture, index: 0)
            encoder.drawPrimitives(type: .triangle, vertexStart: 0, vertexCount: 3)
        }

        // 3. The lenses over them.
        if !state.lenses.isEmpty {
            var layers = state.layers.prefix(Self.maxLayers).map { layer in
                LayerUniforms(
                    rect: SIMD4(Float(layer.rect.minX), Float(layer.rect.minY), Float(layer.rect.width), Float(layer.rect.height)),
                    opacity: Float(clamp(layer.opacity, 0, 1)),
                    // A Gaussian blur of b points spans about b·scale texels,
                    // which is roughly what mip level log2(1 + that) averages.
                    lod: Float(log2(1 + layer.blur * Double(layer.texture.width) / max(layer.rect.width, 1)))
                )
            }
            let layerCount = layers.count
            if layers.isEmpty { layers.append(LayerUniforms(rect: .zero, opacity: 0, lod: 0)) }

            encoder.setRenderPipelineState(lensPipeline)
            encoder.setFragmentBytes(&layers, length: MemoryLayout<LayerUniforms>.stride * layers.count, index: 1)
            for i in 0 ..< Self.maxLayers {
                encoder.setFragmentTexture(i < state.layers.count ? state.layers[i].texture : empty, index: i)
            }
            encoder.setFragmentTexture(sceneTexture, index: Self.maxLayers)
            encoder.setFragmentSamplerState(layerSampler, index: 0)
            encoder.setFragmentSamplerState(sceneSampler, index: 1)

            let p = state.parameters
            for lens in state.lenses where lens.radius > 0.5 && lens.opacity > 0.001 {
                var uniforms = LensUniforms(
                    paper: SIMD4(state.paper, 1),
                    crescentInner: SIMD4(state.palette.inner, 1),
                    crescentCore: SIMD4(state.palette.core, 1),
                    crescentOuter: SIMD4(state.palette.outer, 1),
                    viewSize: viewSize,
                    center: SIMD2(Float(lens.center.x), Float(lens.center.y)),
                    radius: Float(lens.radius),
                    refraction: Float(p.refraction),
                    magnification: Float(p.magnification),
                    rimWidth: Float(p.rimWidth),
                    rimCurve: Float(p.rimCurve),
                    dispersion: Float(p.dispersion),
                    highlight: Float(p.highlight),
                    crescent: Float(clamp(lens.crescent, 0, 1)),
                    spread: Float(clamp(lens.spread, 0, 1)),
                    opacity: Float(clamp(lens.opacity, 0, 1)),
                    pixelsPerPoint: pixelsPerPoint,
                    grain: state.grain,
                    dark: state.dark ? 1 : 0,
                    layerCount: Int32(layerCount)
                )
                // Only the lens and its shadow are shaded.
                let reach = lens.radius * 1.25 + 12
                var rect = SIMD4<Float>(
                    Float((lens.center.x - reach) / size.width * 2 - 1),
                    Float(1 - (lens.center.y - reach) / size.height * 2),
                    Float((lens.center.x + reach) / size.width * 2 - 1),
                    Float(1 - (lens.center.y + reach) / size.height * 2)
                )
                encoder.setVertexBytes(&rect, length: MemoryLayout<SIMD4<Float>>.stride, index: 0)
                encoder.setFragmentBytes(&uniforms, length: MemoryLayout<LensUniforms>.stride, index: 0)
                encoder.drawPrimitives(type: .triangleStrip, vertexStart: 0, vertexCount: 4)
            }
        }
        encoder.endEncoding()

        // Presented with the Core Animation transaction (presentsWithTransaction),
        // so the glass lands in the same frame as SwiftUI's changes.
        commands.commit()
        commands.waitUntilScheduled()
        drawable.present()
    }

    /// The texture the marbles are drawn into, the size of the screen.
    private func sceneTarget(for drawableSize: CGSize) -> MTLTexture? {
        let width = Int(drawableSize.width), height = Int(drawableSize.height)
        guard width > 0, height > 0 else { return nil }
        if let scene, scene.width == width, scene.height == height { return scene }
        let descriptor = MTLTextureDescriptor.texture2DDescriptor(pixelFormat: .bgra8Unorm, width: width, height: height, mipmapped: false)
        descriptor.usage = [.renderTarget, .shaderRead]
        descriptor.storageMode = .private
        scene = device.makeTexture(descriptor: descriptor)
        return scene
    }
}
