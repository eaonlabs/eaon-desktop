import SwiftUI

/// An agent's conversation: what it was told, what it did, and what it said.
struct AgentThread: View {
    let messages: [AgentMessage]
    let agent: Agent
    var onRetry: () -> Void

    var body: some View {
        if messages.isEmpty {
            VStack(spacing: 6) {
                Text("Nothing yet")
                    .font(.subheadline.weight(.semibold))
                    .foregroundStyle(Palette.ink)
                Text("Tell \(agent.name) what to do, or send it a goal and let it work.")
                    .font(.subheadline)
                    .foregroundStyle(Palette.secondary)
                    .multilineTextAlignment(.center)
            }
            .padding(.vertical, 24)
            .entrance(delay: 0.15)
        } else {
            LazyVStack(spacing: 18) {
                ForEach(Array(messages.enumerated()), id: \.element.id) { index, message in
                    if index == 0 || message.at.timeIntervalSince(messages[index - 1].at) > 20 * 60 {
                        Text(message.at.formatted(date: .abbreviated, time: .shortened))
                            .font(.caption)
                            .foregroundStyle(Palette.secondary)
                            .frame(maxWidth: .infinity)
                    }
                    AgentMessageRow(message: message, isLast: index == messages.count - 1, onRetry: onRetry)
                }
            }
        }
    }
}

struct AgentMessageRow: View {
    let message: AgentMessage
    var isLast = false
    var onRetry: () -> Void = {}

    var body: some View {
        switch message.role {
        case .user: user
        case .assistant: assistant
        }
    }

    @ViewBuilder
    private var user: some View {
        if let from = message.from {
            // Not the person: a routine, a wake-up, another agent.
            VStack(spacing: 4) {
                Label(from.name, systemImage: "clock.arrow.circlepath")
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(Palette.secondary)
                if !message.text.isEmpty {
                    Text(message.text)
                        .font(.footnote)
                        .foregroundStyle(Palette.secondary)
                        .multilineTextAlignment(.center)
                        .lineLimit(3)
                }
            }
            .frame(maxWidth: .infinity)
            .padding(.horizontal, 12)
        } else {
            HStack {
                Spacer(minLength: 56)
                Text(message.text)
                    .font(.body)
                    .foregroundStyle(Palette.ink)
                    .padding(.horizontal, 16)
                    .padding(.vertical, 10)
                    .background(Palette.surface, in: RoundedRectangle(cornerRadius: 22, style: .continuous))
                    .contextMenu {
                        Button("Copy", systemImage: "doc.on.doc") { UIPasteboard.general.string = message.text }
                    }
            }
            // Rises from the composer it was written in.
            .entrance(rise: 26, scale: 0.9, anchor: .bottomTrailing, animation: Springs.bouncy, isEnabled: isFresh)
        }
    }

    /// Written a moment ago, so worth animating in; the history is simply there.
    private var isFresh: Bool { Date().timeIntervalSince(message.at) < 2 }

    private var assistant: some View {
        VStack(alignment: .leading, spacing: 10) {
            if let heartbeat = message.heartbeat {
                Label("Woke up: \(heartbeat)", systemImage: "alarm")
                    .font(.caption.weight(.medium))
                    .foregroundStyle(Palette.secondary)
            }
            ForEach(Array(message.parts.enumerated()), id: \.offset) { _, part in
                switch part {
                case .text(let text):
                    if !text.isEmpty {
                        MarkdownText(source: text, animatesNewBlocks: message.streaming)
                            .foregroundStyle(Palette.ink)
                            .contextMenu {
                                Button("Copy", systemImage: "doc.on.doc") { UIPasteboard.general.string = text }
                            }
                    }
                case .tool(let step):
                    AgentStepRow(step: step)
                        .entrance(rise: 8, isEnabled: message.streaming)
                }
            }
            if message.streaming && message.parts.isEmpty {
                ThinkingDot()
                    .padding(.vertical, 6)
                    .entrance(rise: 0, scale: 0.3, animation: Springs.bouncy)
            }
            if let error = message.error {
                Callout(kind: .error, title: "Couldn't finish that", message: error, actionTitle: isLast ? "Try again" : nil, action: isLast ? onRetry : nil)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }
}

/// One tool step: what it was and how it went. Tap for what came back.
struct AgentStepRow: View {
    let step: AgentStep

    @State private var expanded = false

    var body: some View {
        Button {
            guard step.output?.isEmpty == false else { return }
            Haptic.select()
            withAnimation(Springs.smooth) { expanded.toggle() }
        } label: {
            VStack(alignment: .leading, spacing: 8) {
                HStack(spacing: 10) {
                    icon
                        .frame(width: 20, height: 20)
                    VStack(alignment: .leading, spacing: 1) {
                        Text(step.title)
                            .font(.footnote.weight(.semibold))
                            .foregroundStyle(Palette.ink)
                        if let detail = step.detail, !detail.isEmpty {
                            Text(detail)
                                .font(.caption)
                                .foregroundStyle(Palette.secondary)
                                .lineLimit(1)
                        }
                    }
                    Spacer(minLength: 0)
                    if step.output?.isEmpty == false {
                        Image(systemName: "chevron.down")
                            .font(.system(size: 11, weight: .bold))
                            .foregroundStyle(Palette.secondary)
                            .rotationEffect(.degrees(expanded ? 180 : 0))
                    }
                }
                if expanded, let output = step.output {
                    Text(output)
                        .font(.system(size: 12, design: .monospaced))
                        .foregroundStyle(Palette.secondary)
                        .textSelection(.enabled)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .transition(.opacity.combined(with: .move(edge: .top)))
                }
            }
            .padding(.horizontal, 12)
            .padding(.vertical, 10)
            .background(Palette.surface, in: RoundedRectangle(cornerRadius: 14, style: .continuous))
            .clipShape(RoundedRectangle(cornerRadius: 14, style: .continuous))
        }
        .buttonStyle(PressableStyle(scale: 0.99))
        .animation(Springs.bouncy, value: step.status)
        .accessibilityElement(children: .combine)
        .accessibilityHint(step.output?.isEmpty == false ? "Shows what came back" : "")
    }

    @ViewBuilder private var icon: some View {
        switch step.status {
        case .running:
            ProgressView().controlSize(.small)
                .transition(.opacity)
        case .done:
            Image(systemName: "checkmark.circle.fill").foregroundStyle(Palette.positive)
                .transition(.scale(scale: 0.3).combined(with: .opacity))
        case .denied:
            Image(systemName: "hand.raised.fill").foregroundStyle(Palette.caution)
                .transition(.scale(scale: 0.3).combined(with: .opacity))
        case .error:
            Image(systemName: "exclamationmark.triangle.fill").foregroundStyle(Palette.negative)
                .transition(.scale(scale: 0.3).combined(with: .opacity))
        }
    }
}
