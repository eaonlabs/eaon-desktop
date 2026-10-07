import PhotosUI
import SwiftUI
import UniformTypeIdentifiers

/// The chat: a question and a few things to ask when it's empty, the thread when it isn't, a plain
/// header over it (menu, which model, new or temporary chat), and the composer at the bottom either way.
/// Starting, leaving and switching chats each bring the new one into focus.
struct ChatView: View {
    @Environment(ChatController.self) private var chat
    @Environment(ModelCatalog.self) private var catalog
    @Environment(AppNavigator.self) private var navigator

    @State private var showsAttach = Self.launchSheet == "attach"
    @State private var showsPicker = Self.launchSheet == "picker" || Self.launchSheet == "provider"
    @State private var showsCamera = false
    @State private var showsPhotos = false
    @State private var showsFiles = false
    @State private var photoItems: [PhotosPickerItem] = []
    /// What the "+" sheet chose, to be done once it has gone.
    @State private var pending: ComposerAction?
    @State private var pinnedToBottom = true
    @FocusState private var composerFocused: Bool

    private static var launchSheet: String? {
        #if DEBUG
        DebugLaunch.sheet
        #else
        nil
        #endif
    }

    private var picturesLeft: Int {
        max(0, AttachmentLoader.maxImagesPerMessage - chat.attachments.filter { $0.kind == .image }.count)
    }

    var body: some View {
        NavigationStack {
            ZStack {
                ScreenBackground()
                if chat.isEmpty {
                    EmptyChat(
                        hasModel: catalog.activeModel != nil,
                        isTemporary: chat.isTemporary,
                        showsStarters: !chat.hasContent,
                        onPrompt: { chat.send($0) },
                        onAgents: { navigator.go(.agents) },
                        onChooseModel: { showsPicker = true }
                    )
                    .id(chat.isTemporary)
                    .transition(.focus)
                } else {
                    thread
                        .id(chat.current.id)
                        .transition(.focus)
                }
            }
            .animation(Springs.smooth, value: chat.isEmpty)
            .animation(Springs.smooth, value: chat.current.id)
            .animation(Springs.smooth, value: chat.isTemporary)
            .safeAreaInset(edge: .bottom, spacing: 0) {
                Composer(focused: $composerFocused, onPlus: { showsAttach = true }, onModel: {
                    composerFocused = false
                    showsPicker = true
                })
            }
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarLeading) { DrawerButton() }
                ToolbarItem(placement: .principal) { ScreenSwitch() }
                ToolbarItem(placement: .topBarTrailing) { trailingButton }
            }
        }
        .sheet(isPresented: $showsAttach, onDismiss: perform) {
            AttachSheet(
                activeModelName: catalog.activeModel?.name,
                isTemporary: chat.isTemporary,
                photosLeft: picturesLeft
            ) { action in
                pending = action
                showsAttach = false
            }
        }
        .sheet(isPresented: $showsPicker) { ModelPickerView() }
        .fullScreenCover(isPresented: $showsCamera) {
            CameraPicker { data in add(imageData: data, name: "Photo") }
                .ignoresSafeArea()
        }
        .photosPicker(isPresented: $showsPhotos, selection: $photoItems, maxSelectionCount: max(picturesLeft, 1), matching: .images)
        .onChange(of: photoItems) { _, items in loadPhotos(items) }
        .fileImporter(
            isPresented: $showsFiles,
            allowedContentTypes: [.image, .pdf, .text, .json, .xml, .html, .commaSeparatedText],
            allowsMultipleSelection: true
        ) { result in
            if case .success(let urls) = result { loadFiles(urls) }
        }
    }

    // MARK: Header

    /// An empty chat offers a temporary one; a chat with something in it offers a fresh one.
    @ViewBuilder private var trailingButton: some View {
        if chat.isEmpty {
            Button {
                Haptic.tap()
                withAnimation(Springs.smooth) { chat.isTemporary ? chat.newChat() : chat.startTemporary() }
            } label: {
                TemporaryChatIcon(size: 20, filled: chat.isTemporary)
                    .foregroundStyle(chat.isTemporary ? Palette.background : Palette.ink)
                    .frame(width: 30, height: 30)
                    .background(chat.isTemporary ? Palette.ink : .clear, in: Circle())
                    .animation(Springs.bouncy, value: chat.isTemporary)
            }
            .accessibilityLabel(chat.isTemporary ? "Leave temporary chat" : "Temporary chat")
            .accessibilityIdentifier("header.temporary")
        } else {
            Button {
                Haptic.tap()
                composerFocused = false
                withAnimation(Springs.smooth) { chat.newChat() }
            } label: {
                Image(systemName: "square.and.pencil")
            }
            .accessibilityLabel("New chat")
            .accessibilityIdentifier("header.new")
        }
    }

    // MARK: Doing what the "+" chose

    private func perform() {
        guard let action = pending else { return }
        pending = nil
        switch action {
        case .camera: showsCamera = true
        case .photos: showsPhotos = true
        case .files: showsFiles = true
        case .model: showsPicker = true
        case .temporary: withAnimation(Springs.smooth) { chat.isTemporary ? chat.newChat() : chat.startTemporary() }
        case .agents: navigator.go(.agents)
        }
    }

    private func add(imageData: Data, name: String) {
        do {
            chat.attach(try AttachmentLoader.draft(fromImage: imageData, name: name))
        } catch {
            chat.notice = error.localizedDescription
        }
    }

    private func loadPhotos(_ items: [PhotosPickerItem]) {
        guard !items.isEmpty else { return }
        photoItems = []
        Task {
            for (index, item) in items.enumerated() {
                guard let data = try? await item.loadTransferable(type: Data.self) else {
                    chat.notice = "Eaon couldn't open that picture."
                    continue
                }
                add(imageData: data, name: items.count > 1 ? "Photo \(index + 1)" : "Photo")
            }
        }
    }

    private func loadFiles(_ urls: [URL]) {
        Task {
            for url in urls {
                do {
                    chat.attach(try await Task.detached { try AttachmentLoader.draft(fromFile: url) }.value)
                } catch {
                    chat.notice = error.localizedDescription
                }
            }
        }
    }

    // MARK: The thread

    private var thread: some View {
        ScrollViewReader { proxy in
            ScrollView {
                LazyVStack(spacing: 24) {
                    ForEach(chat.messages) { message in
                        MessageRow(
                            message: message,
                            isStreaming: chat.isStreaming && message.id == chat.messages.last?.id,
                            isLast: message.id == chat.messages.last?.id,
                            modelName: chat.current.model?.name,
                            onRetry: { chat.regenerate() }
                        )
                    }
                    Color.clear.frame(height: 8).id(Self.bottom)
                }
                .padding(.horizontal, Metrics.gutter)
                .padding(.top, 8)
            }
            .scrollDismissesKeyboard(.interactively)
            // Short threads sit at the top; once they fill the screen they stay at the end.
            .defaultScrollAnchor(.bottom, for: .initialOffset)
            .defaultScrollAnchor(.bottom, for: .sizeChanges)
            .defaultScrollAnchor(.top, for: .alignment)
            .onScrollGeometryChange(for: Bool.self) { geometry in
                geometry.contentOffset.y + geometry.containerSize.height >= geometry.contentSize.height - 60
            } action: { _, atBottom in
                pinnedToBottom = atBottom
            }
            // A new message always brings you to it; a reply streaming in only
            // follows you while you're at the bottom, so reading up isn't fought.
            .onChange(of: chat.messages.count) {
                withAnimation(Springs.smooth) { proxy.scrollTo(Self.bottom, anchor: .bottom) }
            }
            .onChange(of: chat.messages.last?.text) {
                if pinnedToBottom { proxy.scrollTo(Self.bottom, anchor: .bottom) }
            }
            .onChange(of: composerFocused) { _, focused in
                if focused { withAnimation(Springs.smooth) { proxy.scrollTo(Self.bottom, anchor: .bottom) } }
            }
            .overlay(alignment: .bottom) {
                ZStack {
                    if !pinnedToBottom {
                        Button {
                            Haptic.tap()
                            withAnimation(Springs.smooth) { proxy.scrollTo(Self.bottom, anchor: .bottom) }
                        } label: {
                            Image(systemName: "arrow.down")
                                .font(.system(size: 15, weight: .semibold))
                                .foregroundStyle(Palette.ink)
                                .frame(width: 36, height: 36)
                                .background(Palette.background, in: Circle())
                                .overlay(Circle().strokeBorder(Palette.hairline, lineWidth: 1))
                                .shadow(color: .black.opacity(0.08), radius: 10, y: 3)
                                .frame(width: 44, height: 44)
                                .contentShape(Circle())
                        }
                        .buttonStyle(PressableStyle(scale: 0.88))
                        .padding(.bottom, 8)
                        .transition(.scale(scale: 0.5).combined(with: .opacity))
                        .accessibilityLabel("Scroll to the latest message")
                    }
                }
                .animation(Springs.bouncy, value: pinnedToBottom)
            }
        }
    }

    private static let bottom = "bottom"
}

/// What the chat shows before the first message, as ChatGPT does: an open page, with a few things to
/// ask listed just above the composer, rising in one after another and stepping aside once you type.
private struct EmptyChat: View {
    var hasModel: Bool
    var isTemporary: Bool
    /// The suggestions step aside once something's being written.
    var showsStarters: Bool
    var onPrompt: (String) -> Void
    var onAgents: () -> Void
    var onChooseModel: () -> Void

    private struct Starter: Identifiable {
        var emoji: String
        var title: String
        var prompt: String?
        var id: String { title }
    }

    private static let starters = [
        Starter(emoji: "✈️", title: "Explain how airplanes fly", prompt: "Explain how airplanes fly"),
        Starter(emoji: "🍲", title: "Dinner ideas with chicken and rice", prompt: "Dinner ideas with chicken and rice"),
        Starter(emoji: "✉️", title: "Write a polite decline", prompt: "Write a polite message declining an invitation"),
        Starter(emoji: "🤖", title: "Start an agent", prompt: nil)
    ]

    var body: some View {
        VStack(spacing: 0) {
            Spacer(minLength: 24)

            if isTemporary {
                VStack(spacing: 8) {
                    TemporaryChatIcon(size: 30)
                        .foregroundStyle(Palette.ink)
                        .padding(.bottom, 6)
                        .entrance(rise: 6, scale: 0.6, animation: Springs.bouncy)
                    Text("Temporary chat")
                        .font(.title2.weight(.semibold))
                        .foregroundStyle(Palette.ink)
                        .entrance(delay: 0.06)
                    Text("Won't be saved to your history.")
                        .font(.body)
                        .foregroundStyle(Palette.secondary)
                        .multilineTextAlignment(.center)
                        .entrance(delay: 0.12)
                }
                .padding(.horizontal, Metrics.gutter)
                Spacer(minLength: 24)
            }

            if !hasModel {
                Callout(
                    kind: .info,
                    title: "Pick a model to start",
                    message: "Use Apple's model on this iPhone, a model on your Mac, or one from a provider you add.",
                    actionTitle: "Choose a model",
                    action: onChooseModel
                )
                .padding(.horizontal, Metrics.gutter)
                .padding(.bottom, 12)
                .entrance(delay: 0.1)
            } else if !isTemporary && showsStarters {
                starters
                    .padding(.bottom, 8)
                    .transition(.opacity.combined(with: .move(edge: .bottom)))
            }
        }
        .frame(maxWidth: .infinity)
        .animation(Springs.smooth, value: showsStarters)
    }

    private var starters: some View {
        VStack(alignment: .leading, spacing: 0) {
            ForEach(Array(Self.starters.enumerated()), id: \.element.id) { index, starter in
                Button {
                    Haptic.tap()
                    if let prompt = starter.prompt { onPrompt(prompt) } else { onAgents() }
                } label: {
                    HStack(spacing: 14) {
                        Text(starter.emoji)
                            .font(.title3)
                            .frame(width: 28)
                        Text(starter.title)
                            .font(.body.weight(.medium))
                            .foregroundStyle(Palette.ink)
                            .lineLimit(1)
                        Spacer(minLength: 0)
                    }
                    .padding(.horizontal, Metrics.gutter + 2)
                    .frame(height: 50)
                    .contentShape(Rectangle())
                }
                .buttonStyle(PressableStyle(scale: 0.97))
                .accessibilityIdentifier("starter.\(starter.title)")
                .entrance(delay: 0.05 + Double(index) * 0.055, rise: 18)
            }
        }
    }
}
