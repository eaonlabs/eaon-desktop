import SwiftUI

/// The message box, after ChatGPT's: a soft grey card at the bottom with the text on top, and under it
/// "+" to attach or switch things, which model answers, and send (which becomes stop while a reply is
/// coming). What's attached sits above the text. The thread fades out behind it.
struct Composer: View {
    @Environment(ChatController.self) private var chat
    @Environment(ModelCatalog.self) private var catalog

    var focused: FocusState<Bool>.Binding
    var onPlus: () -> Void
    var onModel: () -> Void

    private static let shape = RoundedRectangle(cornerRadius: 28, style: .continuous)

    var body: some View {
        @Bindable var chat = chat
        VStack(spacing: 8) {
            if let notice = chat.notice { noticeRow(notice) }

            VStack(alignment: .leading, spacing: 0) {
                if !chat.attachments.isEmpty { strip }

                TextField(
                    "",
                    text: $chat.draft,
                    prompt: Text(chat.isTemporary ? "Ask in a temporary chat" : "Ask Eaon").foregroundStyle(Palette.tertiary),
                    axis: .vertical
                )
                .lineLimit(1...8)
                .font(.body)
                .foregroundStyle(Palette.ink)
                .tint(Palette.ink)
                .focused(focused)
                .padding(.horizontal, 16)
                .padding(.top, 14)
                .padding(.bottom, 4)
                .accessibilityIdentifier("composer.field")

                HStack(spacing: 2) {
                    plusButton
                    modelButton
                    Spacer(minLength: 4)
                    sendButton
                }
                .padding(.horizontal, 4)
                .padding(.bottom, 4)
            }
            .background(Palette.surface, in: Self.shape)
            .overlay(Self.shape.strokeBorder(Palette.hairline.opacity(0.45), lineWidth: 0.5))
        }
        .padding(.horizontal, 12)
        .padding(.top, 10)
        .padding(.bottom, 8)
        .background {
            LinearGradient(
                stops: [
                    .init(color: Palette.background.opacity(0), location: 0),
                    .init(color: Palette.background, location: 0.35)
                ],
                startPoint: .top,
                endPoint: .bottom
            )
            .ignoresSafeArea(edges: .bottom)
            .allowsHitTesting(false)
        }
        .animation(Springs.smooth, value: chat.attachments.count)
        .animation(Springs.smooth, value: chat.notice)
        .accessibilityElement(children: .contain)
    }

    private var plusButton: some View {
        Button {
            focused.wrappedValue = false
            Haptic.tap()
            onPlus()
        } label: {
            Image(systemName: "plus")
                .font(.system(size: 22, weight: .regular))
                .foregroundStyle(Palette.ink)
                .frame(width: 44, height: 44)
                .contentShape(Circle())
        }
        .buttonStyle(PressableStyle(scale: 0.86))
        .accessibilityLabel("Add")
        .accessibilityHint("Attach a picture or file, or change what this chat does")
        .accessibilityIdentifier("composer.plus")
    }

    /// Which model answers: where it runs, and its name. Opens the model list.
    private var modelButton: some View {
        Button {
            Haptic.select()
            onModel()
        } label: {
            HStack(spacing: 6) {
                Image(systemName: modelSymbol)
                    .font(.system(size: 14, weight: .medium))
                    .contentTransition(.symbolEffect(.replace))
                Text(catalog.activeModel?.name ?? "Choose a model")
                    .lineLimit(1)
                    .contentTransition(.numericText())
                Image(systemName: "chevron.down")
                    .font(.system(size: 10, weight: .semibold))
            }
            .font(.subheadline.weight(.medium))
            .foregroundStyle(Palette.secondary)
            .padding(.horizontal, 8)
            .frame(height: 40)
            .contentShape(Capsule())
            .animation(Springs.smooth, value: catalog.activeModel?.name)
        }
        .buttonStyle(PressableStyle(scale: 0.95))
        .accessibilityLabel("Model")
        .accessibilityValue(catalog.activeModel?.name ?? "None chosen")
        .accessibilityHint("Opens the model list")
        .accessibilityIdentifier("composer.model")
    }

    private var modelSymbol: String {
        switch catalog.activeModel?.source {
        case .onDevice: "iphone"
        case .mac: "laptopcomputer"
        case .provider: "cloud"
        case nil: "sparkles"
        }
    }

    private var sendButton: some View {
        Button {
            Haptic.tap()
            if chat.isStreaming { chat.stop() } else { chat.send() }
        } label: {
            Image(systemName: chat.isStreaming ? "stop.fill" : "arrow.up")
                .contentTransition(.symbolEffect(.replace))
        }
        .buttonStyle(RoundButtonStyle(diameter: 40))
        .padding(2)
        .disabled(!chat.isStreaming && !chat.canSend)
        .accessibilityLabel(chat.isStreaming ? "Stop" : "Send")
        .accessibilityIdentifier("composer.send")
        .animation(Springs.snappy, value: chat.isStreaming)
    }

    // MARK: Attachments

    private var strip: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 8) {
                ForEach(chat.attachments) { attachment in
                    DraftTile(attachment: attachment) {
                        Haptic.tap()
                        withAnimation(Springs.smooth) { chat.removeAttachment(attachment.id) }
                    }
                    .transition(.scale(scale: 0.6).combined(with: .opacity))
                }
            }
            .padding(.horizontal, 12)
            .padding(.top, 12)
        }
        .scrollClipDisabled()
        .transition(.opacity.combined(with: .move(edge: .bottom)))
    }

    private func noticeRow(_ text: String) -> some View {
        HStack(alignment: .top, spacing: 10) {
            Image(systemName: "info.circle.fill")
                .foregroundStyle(Palette.tint)
                .padding(.top, 1)
            Text(text)
                .font(.footnote)
                .foregroundStyle(Palette.ink)
                .fixedSize(horizontal: false, vertical: true)
            Spacer(minLength: 0)
            Button {
                chat.notice = nil
            } label: {
                Image(systemName: "xmark")
                    .font(.system(size: 11, weight: .bold))
                    .foregroundStyle(Palette.secondary)
                    .frame(width: 24, height: 24)
            }
            .buttonStyle(.plain)
            .accessibilityLabel("Dismiss")
        }
        .padding(.horizontal, 14)
        .padding(.vertical, 10)
        .background(Palette.surface, in: RoundedRectangle(cornerRadius: 18, style: .continuous))
        .transition(.move(edge: .bottom).combined(with: .opacity).combined(with: .scale(scale: 0.96, anchor: .bottom)))
        .accessibilityIdentifier("composer.notice")
    }
}

/// A picture or a file waiting in the composer, with a way to take it back out.
private struct DraftTile: View {
    let attachment: DraftAttachment
    var remove: () -> Void

    var body: some View {
        ZStack(alignment: .topTrailing) {
            Group {
                if attachment.kind == .image, let thumbnail = attachment.thumbnail {
                    Image(uiImage: thumbnail)
                        .resizable()
                        .scaledToFill()
                        .frame(width: 60, height: 60)
                        .clipShape(RoundedRectangle(cornerRadius: 14, style: .continuous))
                } else {
                    HStack(spacing: 8) {
                        Image(systemName: "doc.text")
                            .font(.system(size: 18, weight: .regular))
                            .foregroundStyle(Palette.secondary)
                        Text(attachment.name)
                            .font(.footnote.weight(.medium))
                            .foregroundStyle(Palette.ink)
                            .lineLimit(2)
                            .frame(maxWidth: 120, alignment: .leading)
                    }
                    .padding(.horizontal, 12)
                    .frame(height: 60)
                    .background(Palette.background, in: RoundedRectangle(cornerRadius: 14, style: .continuous))
                }
            }

            Button(action: remove) {
                Image(systemName: "xmark")
                    .font(.system(size: 9, weight: .heavy))
                    .foregroundStyle(Palette.background)
                    .frame(width: 20, height: 20)
                    .background(Palette.ink, in: Circle())
                    .overlay(Circle().strokeBorder(Palette.surface, lineWidth: 1.5))
            }
            .buttonStyle(PressableStyle(scale: 0.85))
            .offset(x: 5, y: -5)
            .accessibilityLabel("Remove \(attachment.name)")
        }
        .accessibilityElement(children: .contain)
    }
}
