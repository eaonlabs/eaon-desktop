import SwiftUI

/// The Eaon mascot: a pixel-art bot with a terminal for a face.
///
/// The brief it answers: say "Eaon" and say "code" in one silhouette. So the
/// chassis is the brand coral (`#F17455`) against the same deep near-black
/// the app's own chrome uses, and the face is a terminal — two eyes above a
/// live shell prompt, `>` and a cursor that blinks the way a real one does.
/// The character is doing the thing the product does.
///
/// Nothing here is borrowed from another tool's mascot: it stands facing you
/// rather than walking in profile, it's a machine rather than an animal, and
/// the only detail either would share is the medium itself.
///
/// The art is authored as text grids — one character per pixel — so every
/// frame stays diffable in review and editable without an asset pipeline.
/// Rendering happens in a `Canvas` at a whole-point scale, which is what
/// keeps the pixels crisp instead of resampled.
enum EaonMascot {
    /// One character per pixel; `.` is transparent.
    static let palette: [Character: Color] = [
        "K": Color(hex: "#2A2226"),  // outline — deep plum-black, not pure black
        "C": Color(hex: "#F17455"),  // chassis — the Eaon brand coral
        "D": Color(hex: "#C25540"),  // chassis shade, bottom-right
        "H": Color(hex: "#FF9E80"),  // chassis sheen, top-left
        "S": Color(hex: "#16171B"),  // screen
        "W": Color(hex: "#F2EFEA"),  // screen phosphor
    ]

    static let columns = 28
    static let rows = 23

    /// Resting: eyes open, cursor lit, arms level, antenna bright.
    static let frameA: [String] = [
        "...........KHHHHK...........",
        "...........KCCCCK...........",
        "............KKKK............",
        ".............KK.............",
        ".............KK.............",
        ".......KKKKKKKKKKKKKK.......",
        "......KHHHHHHCCCCCCCCK......",
        ".....KHHHHHCCCCCCCCCCCK.....",
        ".....KCCKKKKKKKKKKKKCCK.....",
        ".....KCCKSWWSSSSWWSKCCK.....",
        ".....KCCKSWWSSSSWWSKCCK.....",
        ".KKKKKCCKSSSSSSSSSSKCCKKKKK.",
        ".KCCCCCCKSWSSSSSSSSKCCCCCCK.",
        ".KCCCCCCKSSWSSSSSSSKCCCCCCK.",
        ".KKKKKCCKSWSSWWWWSSKCCKKKKK.",
        ".....KCCKSSSSSSSSSSKCCK.....",
        ".....KCCKKKKKKKKKKKKCCK.....",
        ".....KCCCCCCCCCCCCCDDDK.....",
        "......KCCCCCCCCCCCCDDK......",
        ".......KKCCKKKKKKCCKK.......",
        "........KCCK....KCCK........",
        "........KCCK....KCCK........",
        "........KKKK....KKKK........",
    ]

    /// Cursor dark, arms dropped one pixel, antenna dimmed — the off-beat of
    /// the idle cycle. Alternated with `frameA` it reads as a shell cursor
    /// blinking while the bot shifts its weight.
    static let frameB: [String] = [
        "...........KCCCCK...........",
        "...........KCCCCK...........",
        "............KKKK............",
        ".............KK.............",
        ".............KK.............",
        ".......KKKKKKKKKKKKKK.......",
        "......KHHHHHHCCCCCCCCK......",
        ".....KHHHHHCCCCCCCCCCCK.....",
        ".....KCCKKKKKKKKKKKKCCK.....",
        ".....KCCKSWWSSSSWWSKCCK.....",
        ".....KCCKSWWSSSSWWSKCCK.....",
        ".....KCCKSSSSSSSSSSKCCK.....",
        ".KKKKKCCKSWSSSSSSSSKCCKKKKK.",
        ".KCCCCCCKSSWSSSSSSSKCCCCCCK.",
        ".KCCCCCCKSWSSSSSSSSKCCCCCCK.",
        ".KKKKKCCKSSSSSSSSSSKCCKKKKK.",
        ".....KCCKKKKKKKKKKKKCCK.....",
        ".....KCCCCCCCCCCCCCDDDK.....",
        "......KCCCCCCCCCCCCDDK......",
        ".......KKCCKKKKKKCCKK.......",
        "........KCCK....KCCK........",
        "........KCCK....KCCK........",
        "........KKKK....KKKK........",
    ]

    /// Eyes shut — held for a single tick, so it reads as a blink and not a
    /// nap.
    static let frameBlink: [String] = [
        "...........KHHHHK...........",
        "...........KCCCCK...........",
        "............KKKK............",
        ".............KK.............",
        ".............KK.............",
        ".......KKKKKKKKKKKKKK.......",
        "......KHHHHHHCCCCCCCCK......",
        ".....KHHHHHCCCCCCCCCCCK.....",
        ".....KCCKKKKKKKKKKKKCCK.....",
        ".....KCCKSSSSSSSSSSKCCK.....",
        ".....KCCKSWWSSSSWWSKCCK.....",
        ".KKKKKCCKSSSSSSSSSSKCCKKKKK.",
        ".KCCCCCCKSWSSSSSSSSKCCCCCCK.",
        ".KCCCCCCKSSWSSSSSSSKCCCCCCK.",
        ".KKKKKCCKSWSSWWWWSSKCCKKKKK.",
        ".....KCCKSSSSSSSSSSKCCK.....",
        ".....KCCKKKKKKKKKKKKCCK.....",
        ".....KCCCCCCCCCCCCCDDDK.....",
        "......KCCCCCCCCCCCCDDK......",
        ".......KKCCKKKKKKCCKK.......",
        "........KCCK....KCCK........",
        "........KCCK....KCCK........",
        "........KKKK....KKKK........",
    ]

    /// The timeline as a pure function of tick index, so it needs no stored
    /// state: a blink lands every ninth tick, and otherwise the cursor
    /// alternates every third — about once a second, which is a shell
    /// cursor's own rhythm rather than a flicker.
    static func frame(forTick tick: Int) -> [String] {
        if tick % 9 == 8 { return frameBlink }
        return (tick / 3) % 2 == 0 ? frameA : frameB
    }
}

/// The animated mascot, sized in whole art-pixels.
struct EaonMascotView: View {
    /// Points per art pixel. Whole numbers only — a fractional scale
    /// resamples the sprite and throws away the crisp edges that make it
    /// read as pixel art in the first place.
    var pixelSize: CGFloat = 4
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    /// ~3 ticks a second is all the idle cycle needs. Faster would burn
    /// battery animating a character whose entire job is to sit and wait.
    private static let tickLength: TimeInterval = 0.35

    var body: some View {
        Group {
            if reduceMotion {
                EaonMascotSprite(grid: EaonMascot.frameA, pixelSize: pixelSize)
            } else {
                TimelineView(.periodic(from: .now, by: Self.tickLength)) { context in
                    let tick = Int(context.date.timeIntervalSinceReferenceDate / Self.tickLength)
                    EaonMascotSprite(grid: EaonMascot.frame(forTick: tick), pixelSize: pixelSize)
                }
            }
        }
        .frame(
            width: CGFloat(EaonMascot.columns) * pixelSize,
            height: CGFloat(EaonMascot.rows) * pixelSize
        )
        .accessibilityLabel("The Eaon bot")
    }
}

// MARK: - Perching

extension EaonMascot {
    /// Points per art pixel in the hero slot.
    static let heroPixelSize: CGFloat = 4
    /// Perched, it draws at half scale. Exactly half of a whole-point pixel
    /// size lands back on whole points, so the sprite is just as crisp
    /// sitting on the composer as it is in the hero — only the flight
    /// between them passes through fractional scales, and that's in motion.
    static let perchedScale: CGFloat = 0.5

    static var heroSize: CGSize {
        CGSize(
            width: CGFloat(columns) * heroPixelSize,
            height: CGFloat(rows) * heroPixelSize
        )
    }

    static var perchedSize: CGSize {
        CGSize(width: heroSize.width * perchedScale, height: heroSize.height * perchedScale)
    }

    /// How long the mascot holds the hero slot before it goes and sits down.
    /// Long enough to be seen and read as the page's mascot, short enough
    /// that it's out of the way before anyone has finished deciding what to
    /// type.
    static let perchDelay: Duration = .seconds(5)
}

/// Reports a named rectangle so the sprite can be flown between two places
/// that live in different branches of the layout — a hero slot in a `VStack`
/// and a corner of the composer below it — without either having to know
/// about the other.
struct EaonMascotAnchorKey: PreferenceKey {
    static var defaultValue: [String: CGRect] = [:]
    static func reduce(value: inout [String: CGRect], nextValue: () -> [String: CGRect]) {
        value.merge(nextValue()) { _, new in new }
    }
}

extension View {
    func eaonMascotAnchor(_ name: String, space: String) -> some View {
        background(
            GeometryReader { proxy in
                Color.clear.preference(
                    key: EaonMascotAnchorKey.self,
                    value: [name: proxy.frame(in: .named(space))]
                )
            }
        )
    }
}

/// One frame, drawn cell by cell.
///
/// A `Canvas` rather than a grid of `Rectangle`s: the sprite is ~400 filled
/// cells redrawn several times a second, which is nothing as one draw call
/// and real overhead as 400 separate views in the layout system.
struct EaonMascotSprite: View {
    let grid: [String]
    let pixelSize: CGFloat

    var body: some View {
        Canvas { context, _ in
            for (y, row) in grid.enumerated() {
                for (x, cell) in row.enumerated() where cell != "." {
                    guard let color = EaonMascot.palette[cell] else { continue }
                    context.fill(
                        Path(CGRect(
                            x: CGFloat(x) * pixelSize,
                            y: CGFloat(y) * pixelSize,
                            width: pixelSize,
                            height: pixelSize
                        )),
                        with: .color(color)
                    )
                }
            }
        }
    }
}
