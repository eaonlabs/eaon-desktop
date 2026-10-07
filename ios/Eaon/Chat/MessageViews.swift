import SwiftUI

/// One message in the thread. Yours are soft grey bubbles on the right; Eaon's are set straight on
/// the page, with a small row of actions under the last one. A message written just now arrives with
/// a little motion; ones opened from the history are simply there.
struct MessageRow: View {
    let message: ChatMessage
    /// This reply is still arriving.
    var isStreaming = false
    /// The last reply gets the actions.
    var isLast = false
    var modelName: String?
    var onRetry: () -> Void = {}

    @State private var copied = false

    /// Written a moment ago, so worth animating in. Rows a lazy list rebuilds as you scroll back aren't.
    private var isFresh: Bool { Date().timeIntervalSince(message.date) < 2 }

    var body: some View {
        switch message.role {
        case .user: user
        case .assistant: assistant
        }
    }

    private var user: some View {
        HStack {
            Spacer(minLength: 56)
            VStack(alignment: .trailing, spacing: 8) {
                if let attachments = message.attachments, !attachments.isEmpty {
                    AttachmentGallery(attachments: attachments)
                }
                if !message.text.isEmpty {
                    Text(message.text)
                        .font(.body)
                        .foregroundStyle(Palette.ink)
                        .padding(.horizontal, 16)
                        .padding(.vertical, 10)
                        .background(Palette.surface, in: RoundedRectangle(cornerRadius: 22, style: .continuous))
                        .contextMenu {
                            Button("Copy", systemImage: "doc.on.doc") { UIPasteboard.general.string = message.text }
                            ShareLink(item: message.text)
                        }
                }
            }
        }
        // Rises from the composer it was written in.
        .entrance(rise: 26, scale: 0.9, anchor: .bottomTrailing, animation: Springs.bouncy, isEnabled: isFresh)
    }

    private var assistant: some View {
        VStack(alignment: .leading, spacing: 10) {
            if message.text.isEmpty && message.error == nil {
                ThinkingDot()
                    .padding(.vertical, 6)
                    .entrance(rise: 0, scale: 0.3, animation: Springs.bouncy, isEnabled: isFresh)
            } else if !message.text.isEmpty {
                MarkdownText(source: message.text, animatesNewBlocks: isStreaming)
                    .foregroundStyle(Palette.ink)
                    .contextMenu {
                        Button("Copy", systemImage: "doc.on.doc") { UIPasteboard.general.string = message.text }
                        ShareLink(item: message.text)
                    }
            }

            if let error = message.error {
                Callout(
                    kind: .error,
                    title: "Couldn't finish that",
                    message: error,
                    actionTitle: "Try again",
                    action: onRetry
                )
            } else if isLast && !isStreaming && !message.text.isEmpty {
                actions
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    private var actions: some View {
        HStack(spacing: 0) {
            actionButton(copied ? "Copied" : "Copy", systemImage: copied ? "checkmark" : "doc.on.doc") {
                UIPasteboard.general.string = message.text
                Haptic.tap()
                withAnimation(Springs.snappy) { copied = true }
                Task {
                    try? await Task.sleep(for: .seconds(1.6))
                    withAnimation(Springs.snappy) { copied = false }
                }
            }
            actionButton("Try again", systemImage: "arrow.clockwise", action: onRetry)
            ShareLink(item: message.text) {
                actionIcon("square.and.arrow.up")
            }
            .buttonStyle(PressableStyle(scale: 0.85))
            .accessibilityLabel("Share")
            if let modelName {
                Text(modelName)
                    .font(.caption)
                    .foregroundStyle(Palette.secondary)
                    .lineLimit(1)
                    .padding(.leading, 6)
            }
        }
        .padding(.leading, -10)
        .entrance(delay: 0.05, rise: 6)
    }

    private func actionButton(_ title: String, systemImage: String, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            actionIcon(systemImage)
        }
        .buttonStyle(PressableStyle(scale: 0.85))
        .accessibilityLabel(title)
    }

    private func actionIcon(_ systemImage: String) -> some View {
        Image(systemName: systemImage)
            .font(.system(size: 15, weight: .regular))
            .foregroundStyle(Palette.secondary)
            .contentTransition(.symbolEffect(.replace))
            .frame(width: 36, height: 36)
            .contentShape(Rectangle())
    }
}

/// A dot that breathes while Eaon is getting started.
struct ThinkingDot: View {
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        TimelineView(.animation(minimumInterval: 1.0 / 60, paused: reduceMotion)) { context in
            let t = context.date.timeIntervalSinceReferenceDate
            let phase = (sin(t * 2 * .pi / 1.3) + 1) / 2
            Circle()
                .fill(Palette.ink)
                .frame(width: 13, height: 13)
                .scaleEffect(reduceMotion ? 1 : 0.68 + 0.32 * phase)
                .opacity(reduceMotion ? 0.8 : 0.5 + 0.5 * phase)
                .frame(width: 20, height: 20)
        }
        .accessibilityElement()
        .accessibilityLabel("Eaon is thinking")
    }
}
