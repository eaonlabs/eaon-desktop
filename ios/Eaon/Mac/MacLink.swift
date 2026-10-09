import SwiftUI

/// A phone and a laptop with a line between them: dashed and still when
/// there's no connection, travelling while it's made, solid and green once it is.
struct MacLink: View {
    enum State { case idle, connecting, connected }
    var state: State

    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        HStack(spacing: 0) {
            tile("iphone")
            line
                .frame(height: 24)
                .padding(.horizontal, 10)
            tile("laptopcomputer")
        }
        .accessibilityElement()
        .accessibilityLabel(
            state == .connected ? "This iPhone is connected to your Mac" : state == .connecting ? "Connecting to your Mac" : "This iPhone isn't connected to a Mac"
        )
    }

    private func tile(_ symbol: String) -> some View {
        Image(systemName: symbol)
            .font(.system(size: 34, weight: .regular))
            .foregroundStyle(Palette.ink)
            .frame(width: 84, height: 84)
            .background(Palette.fill.opacity(0.7), in: RoundedRectangle(cornerRadius: 26, style: .continuous))
            .overlay(RoundedRectangle(cornerRadius: 26, style: .continuous).strokeBorder(Palette.hairline, lineWidth: 0.5))
    }

    private var tint: Color {
        switch state {
        case .idle: Palette.secondary.opacity(0.5)
        case .connecting: Palette.tint
        case .connected: Palette.positive
        }
    }

    private var line: some View {
        TimelineView(.animation(minimumInterval: 1.0 / 30, paused: state != .connecting || reduceMotion)) { context in
            let phase = context.date.timeIntervalSinceReferenceDate * 24
            Canvas { canvas, size in
                var path = Path()
                path.move(to: CGPoint(x: 0, y: size.height / 2))
                path.addLine(to: CGPoint(x: size.width, y: size.height / 2))
                let style = StrokeStyle(
                    lineWidth: 3,
                    lineCap: .round,
                    dash: state == .connected ? [] : [0.1, 9],
                    dashPhase: state == .connecting && !reduceMotion ? -phase : 0
                )
                canvas.stroke(path, with: .color(tint), style: style)
            }
        }
        .animation(.smooth(duration: 0.4), value: state)
    }
}
