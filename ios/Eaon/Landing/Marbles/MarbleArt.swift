import Metal
import SwiftUI

/// The pictures inside the marbles: agents' faces (the desktop app's worker
/// faces, in its worker colours), things agents do (symbols on bright
/// gradients, and emoji), and swirls of colour. Rendered once into a texture
/// array, one picture per slice, which the marble shader looks into.
///
/// Each picture fills its square edge to edge: a marble's rim folds over
/// whatever's beyond the middle, so there's no transparent border to show.
@MainActor
enum MarbleArt {
    enum Kind {
        case face, symbol, emoji, swirl
    }

    private struct Piece {
        var kind: Kind
        var view: AnyView
    }

    /// Pixels per side of each slice.
    private static let pixels = 192

    private static let faceColors: [UInt32] = [0x3E86C6, 0x5B6CF0, 0x8E5CE6, 0xD6509B, 0xEE8A36, 0x3FAE6A, 0xE7B727]
    private static let symbols: [(String, UInt32, UInt32)] = [
        ("globe.americas.fill", 0x5B6CF0, 0x22D3EE),
        ("envelope.fill", 0xFC466B, 0x3F5EFB),
        ("chart.line.uptrend.xyaxis", 0x11998E, 0x38EF7D),
        ("calendar", 0xFF5F6D, 0xFFC371),
        ("terminal.fill", 0x1C1C1E, 0x4A4A4F),
        ("airplane", 0x00C2FF, 0x4D7CFE),
        ("music.note", 0x8E5CE6, 0xFF6FD8),
        ("cart.fill", 0xF7971E, 0xFFD200)
    ]
    private static let emoji: [(String, UInt32, UInt32)] = [
        ("🚀", 0xC9E4FF, 0x7FB2FF),
        ("🎨", 0xFFE3B3, 0xFF9F6E),
        ("🍕", 0xFFF1C2, 0xFFB85C),
        ("🎧", 0xE8D9FF, 0xA98BFF),
        ("🌈", 0xD7F5FF, 0x8FD8FF),
        ("🧠", 0xFFDDE9, 0xFF8FB8),
        ("🔔", 0xFFF4C7, 0xFFC94D),
        ("🍦", 0xFFE0F0, 0xFF9CCB),
        ("♟️", 0xE9ECF2, 0xB5BCCB),
        ("🐙", 0xFFD9D2, 0xFF7A68)
    ]
    private static let swirls: [[UInt32]] = [
        [0xFF6FB5, 0xFF9F43, 0xFFD43B, 0x4D7CFE, 0x9B5DE5, 0xFF6FB5],
        [0x00C2FF, 0x4D7CFE, 0xFF4757, 0xFFD43B, 0x00C2FF],
        [0x9B5DE5, 0xF15BB5, 0xFEE440, 0x00BBF9, 0x00F5D4, 0x9B5DE5],
        [0x1C1C1E, 0xFF9F43, 0xFF4757, 0x1C1C1E, 0x4D7CFE, 0x1C1C1E],
        [0xFFD43B, 0xFF6B6B, 0xC44DFF, 0x4D7CFE, 0xFFD43B]
    ]

    private static let pieces: [Piece] = {
        var pieces: [Piece] = []
        for color in faceColors {
            pieces.append(Piece(kind: .face, view: AnyView(FaceArt(color: color))))
        }
        for (name, a, b) in symbols {
            pieces.append(Piece(kind: .symbol, view: AnyView(SymbolArt(name: name, from: a, to: b))))
        }
        for (glyph, a, b) in emoji {
            pieces.append(Piece(kind: .emoji, view: AnyView(EmojiArt(glyph: glyph, from: a, to: b))))
        }
        for colors in swirls {
            pieces.append(Piece(kind: .swirl, view: AnyView(SwirlArt(colors: colors))))
        }
        return pieces
    }()

    static var count: Int { pieces.count }

    static func kind(of index: Int) -> Kind { pieces[clamp(index, 0, pieces.count - 1)].kind }

    /// How strongly a marble bends its picture: a face has to stay a face and
    /// a symbol readable; a swirl of colour can be turned inside out.
    static func strength(of index: Int) -> Float {
        switch kind(of: index) {
        case .face: 0.18
        case .symbol: 0.55
        case .emoji: 0.6
        case .swirl: 1
        }
    }

    /// Renders every picture into a mipmappable texture array.
    static func makeTexture(device: MTLDevice) -> MTLTexture? {
        let descriptor = MTLTextureDescriptor()
        descriptor.textureType = .type2DArray
        descriptor.pixelFormat = .rgba8Unorm
        descriptor.width = pixels
        descriptor.height = pixels
        descriptor.arrayLength = pieces.count
        descriptor.mipmapLevelCount = Int(log2(Double(pixels))) + 1
        descriptor.usage = .shaderRead
        guard
            let texture = device.makeTexture(descriptor: descriptor),
            let space = CGColorSpace(name: CGColorSpace.sRGB)
        else { return nil }

        let side = CGFloat(pixels) / 2
        for (slice, piece) in pieces.enumerated() {
            let renderer = ImageRenderer(content: piece.view.frame(width: side, height: side))
            renderer.scale = 2
            renderer.isOpaque = true
            guard
                let image = renderer.cgImage,
                let context = CGContext(
                    data: nil,
                    width: pixels,
                    height: pixels,
                    bitsPerComponent: 8,
                    bytesPerRow: pixels * 4,
                    space: space,
                    bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue
                )
            else { continue }
            context.draw(image, in: CGRect(x: 0, y: 0, width: pixels, height: pixels))
            guard let bytes = context.data else { continue }
            texture.replace(
                region: MTLRegionMake2D(0, 0, pixels, pixels),
                mipmapLevel: 0,
                slice: slice,
                withBytes: bytes,
                bytesPerRow: pixels * 4,
                bytesPerImage: pixels * pixels * 4
            )
        }
        return texture
    }
}

// MARK: - The pictures

/// A worker's face from the desktop app: two rounded eyes on its colour,
/// lit from the upper left. The eyes are dark on a light colour.
private struct FaceArt: View {
    let color: UInt32

    var body: some View {
        GeometryReader { proxy in
            let side = proxy.size.width
            let eye = luminance(hex: color) > 0.55 ? Color(white: 0.1) : Color.white
            ZStack {
                Color(hex: color)
                RadialGradient(colors: [.white.opacity(0.35), .clear], center: UnitPoint(x: 0.3, y: 0.25), startRadius: 0, endRadius: side * 0.7)
                // The desktop face's eyes on its 100-point grid, scaled so
                // the face fills the middle of the marble.
                HStack(spacing: side * 0.13) {
                    Capsule().fill(eye).frame(width: side * 0.12, height: side * 0.22)
                    Capsule().fill(eye).frame(width: side * 0.12, height: side * 0.22)
                }
                .offset(y: -side * 0.05)
            }
        }
    }
}

/// Something an agent does: a white symbol on a bright gradient.
private struct SymbolArt: View {
    let name: String
    let from: UInt32
    let to: UInt32

    var body: some View {
        GeometryReader { proxy in
            ZStack {
                LinearGradient(colors: [Color(hex: from), Color(hex: to)], startPoint: .topLeading, endPoint: .bottomTrailing)
                Image(systemName: name)
                    .font(.system(size: proxy.size.width * 0.32, weight: .semibold))
                    .foregroundStyle(.white)
            }
        }
    }
}

/// Something an agent does, as an emoji on a soft gradient.
private struct EmojiArt: View {
    let glyph: String
    let from: UInt32
    let to: UInt32

    var body: some View {
        GeometryReader { proxy in
            ZStack {
                RadialGradient(colors: [Color(hex: from), Color(hex: to)], center: .center, startRadius: 0, endRadius: proxy.size.width * 0.7)
                Text(glyph)
                    .font(.system(size: proxy.size.width * 0.42))
            }
        }
    }
}

/// A swirl of colour.
private struct SwirlArt: View {
    let colors: [UInt32]

    var body: some View {
        ZStack {
            AngularGradient(colors: colors.map { Color(hex: $0) }, center: UnitPoint(x: 0.45, y: 0.55))
            RadialGradient(colors: [.white.opacity(0.5), .clear], center: UnitPoint(x: 0.35, y: 0.3), startRadius: 0, endRadius: 40)
        }
    }
}
