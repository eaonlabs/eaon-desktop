import SwiftUI

/// A playable-audio message bubble: a pill-shaped scrubber with play/pause,
/// elapsed/duration labels, and a download action, plus a copy/regenerate/
/// more row underneath — built on the same `ActionIcon` primitive as
/// `MessageActionsRow`, but with audio's own action set instead of text's.
///
/// Visual-only for now — play/pause and the scrubber drive local view state,
/// not real playback. Nothing in the app produces or attaches audio content
/// yet; wire the closures below to a real source and player engine once
/// that exists.
struct AudioPlayerBubble: View {
    @Environment(\.themeColors) private var colors

    var duration: TimeInterval
    var onDownload: () -> Void
    var onCopy: () -> Void
    var onRegenerate: () -> Void
    var onMore: () -> Void

    @State private var isPlaying = false
    @State private var progress: Double

    init(
        duration: TimeInterval = 2,
        initialProgress: Double = 0.72,
        onDownload: @escaping () -> Void = {},
        onCopy: @escaping () -> Void = {},
        onRegenerate: @escaping () -> Void = {},
        onMore: @escaping () -> Void = {}
    ) {
        self.duration = duration
        self.onDownload = onDownload
        self.onCopy = onCopy
        self.onRegenerate = onRegenerate
        self.onMore = onMore
        _progress = State(initialValue: min(max(initialProgress, 0), 1))
    }

    private var elapsed: TimeInterval { progress * duration }

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            player
            HStack(spacing: 2) {
                ActionIcon(systemName: "doc.on.doc", help: "Copy", action: onCopy)
                ActionIcon(systemName: "arrow.clockwise", help: "Regenerate", action: onRegenerate)
                ActionIcon(systemName: "ellipsis", help: "More", action: onMore)
            }
        }
        .frame(maxWidth: 300, alignment: .leading)
    }

    private var player: some View {
        HStack(spacing: 10) {
            playButton
            Text(Self.format(elapsed))
                .font(AppFont.mono(12))
                .foregroundStyle(colors.textTertiary)
            scrubber
            Text(Self.format(duration))
                .font(AppFont.mono(12))
                .foregroundStyle(colors.textTertiary)
            downloadButton
        }
        .padding(.leading, 6)
        .padding(.trailing, 12)
        .padding(.vertical, 8)
        .background(Capsule(style: .continuous).fill(colors.backgroundChip))
        .overlay(Capsule(style: .continuous).stroke(colors.borderSubtle, lineWidth: 1))
    }

    private var playButton: some View {
        Button {
            withAnimation(.easeOut(duration: 0.12)) { isPlaying.toggle() }
        } label: {
            Image(systemName: isPlaying ? "pause.fill" : "play.fill")
                .font(.system(size: 11, weight: .semibold))
                .foregroundStyle(colors.backgroundPrimary)
                .iconHoverEffect(for: isPlaying ? "pause.fill" : "play.fill")
                .frame(width: 26, height: 26)
                .background(Circle().fill(colors.textPrimary))
                // Optical centering: play's triangle reads left-of-center
                // next to pause's two even bars, so it needs a hair more
                // right padding to look centered rather than measure equal.
                .offset(x: isPlaying ? 0 : 1)
        }
        .buttonStyle(PressableButtonStyle())
        .help(isPlaying ? "Pause" : "Play")
    }

    private var scrubber: some View {
        GeometryReader { geo in
            let width = max(geo.size.width, 1)
            let thumbX = min(max(progress, 0), 1) * width
            ZStack(alignment: .leading) {
                Capsule(style: .continuous)
                    .fill(colors.backgroundSubtle)
                    .frame(height: 3)
                Capsule(style: .continuous)
                    .fill(Self.progressColor)
                    .frame(width: thumbX, height: 3)
                Circle()
                    .fill(Self.progressColor)
                    .frame(width: 10, height: 10)
                    .offset(x: thumbX - 5)
            }
            .frame(maxHeight: .infinity)
            .contentShape(Rectangle())
            .gesture(
                DragGesture(minimumDistance: 0)
                    .onChanged { value in
                        progress = min(max(value.location.x / width, 0), 1)
                    }
            )
        }
        .frame(height: 20)
    }

    private var downloadButton: some View {
        Button(action: onDownload) {
            Image(systemName: "square.and.arrow.down")
                .font(.system(size: 13, weight: .regular))
                .foregroundStyle(colors.textSecondary)
                .iconHoverEffect(for: "square.and.arrow.down")
        }
        .buttonStyle(PressableButtonStyle())
        .help("Download")
    }

    // A dedicated media-progress teal rather than the app's own brand accent
    // — everyday chrome here stays monochrome by design (see ThemeColors),
    // and forcing the brand orange onto a scrubber would read as a random
    // one-off rather than a deliberate media-player convention.
    private static let progressColor = Color(hex: "#10B981")

    private static func format(_ time: TimeInterval) -> String {
        let total = max(0, Int(time.rounded()))
        return String(format: "%d:%02d", total / 60, total % 60)
    }
}
