import SwiftUI

/// The drawer on the left, after ChatGPT's: the name and a search button, the places to go, every
/// chat you've had, and a floating "New chat" with Settings beside it at the bottom.
struct SideDrawer: View {
    var width: CGFloat

    @Environment(AppNavigator.self) private var navigator
    @Environment(ChatStore.self) private var store
    @Environment(ChatController.self) private var chat
    @Environment(AgentsStore.self) private var agents

    @State private var searching = false
    @State private var search = ""
    @State private var renaming: Conversation?
    @State private var renameText = ""
    @FocusState private var searchFocused: Bool

    private static let inset: CGFloat = 24

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            top
                .padding(.horizontal, Self.inset)
                .padding(.top, 6)
                .padding(.bottom, 10)

            if !searching {
                VStack(alignment: .leading, spacing: 0) {
                    place(symbol: IconTile.agentFace, title: "Agents", badge: agents.waitingOnYou) {
                        navigator.go(.agents)
                    }
                    place(symbol: "laptopcomputer", title: "Your Mac") {
                        navigator.drawerOpen = false
                        navigator.showsConnectMac = true
                    }
                    Rectangle()
                        .fill(Palette.hairline)
                        .frame(height: 0.5)
                        .padding(.horizontal, Self.inset)
                        .padding(.vertical, 12)
                }
                .transition(.opacity.combined(with: .move(edge: .top)))
            }

            list
        }
        .frame(width: width)
        .frame(maxHeight: .infinity, alignment: .top)
        .overlay(alignment: .bottom) { bottomBar }
        .background(Palette.drawer.ignoresSafeArea())
        .animation(Springs.smooth, value: searching)
        .onChange(of: navigator.drawerOpen) { _, open in
            if !open { endSearch() }
        }
        .alert("Rename chat", isPresented: Binding(get: { renaming != nil }, set: { if !$0 { renaming = nil } })) {
            TextField("Name", text: $renameText)
            Button("Cancel", role: .cancel) {}
            Button("Save") {
                if let renaming { store.rename(renaming.id, to: renameText) }
            }
        }
    }

    // MARK: Top

    private var top: some View {
        HStack(spacing: 12) {
            if searching {
                HStack(spacing: 8) {
                    Image(systemName: "magnifyingglass")
                        .font(.system(size: 15, weight: .medium))
                        .foregroundStyle(Palette.secondary)
                    TextField("Search chats", text: $search)
                        .font(.body)
                        .foregroundStyle(Palette.ink)
                        .tint(Palette.ink)
                        .focused($searchFocused)
                        .submitLabel(.search)
                        .autocorrectionDisabled()
                }
                .padding(.horizontal, 14)
                .frame(height: 44)
                .glass(in: Capsule(), interactive: false)
                .transition(.opacity.combined(with: .scale(scale: 0.9, anchor: .trailing)))
            } else {
                Text("Eaon")
                    .font(.title2.weight(.semibold))
                    .foregroundStyle(Palette.ink)
                    .transition(.opacity)
                Spacer(minLength: 0)
            }

            Button {
                Haptic.tap()
                if searching { endSearch() } else { startSearch() }
            } label: {
                Image(systemName: searching ? "xmark" : "magnifyingglass")
                    .contentTransition(.symbolEffect(.replace))
            }
            .buttonStyle(GlassCircleButtonStyle(diameter: 44))
            .accessibilityLabel(searching ? "Stop searching" : "Search chats")
        }
        .frame(height: 48)
    }

    private func startSearch() {
        searching = true
        Task {
            try? await Task.sleep(for: .milliseconds(250))
            searchFocused = true
        }
    }

    private func endSearch() {
        search = ""
        searchFocused = false
        searching = false
    }

    // MARK: Places

    private func place(symbol: String, title: String, badge: Int = 0, action: @escaping () -> Void) -> some View {
        Button {
            Haptic.select()
            action()
        } label: {
            HStack(spacing: 16) {
                IconTile(systemImage: symbol, size: 30)
                Text(title)
                    .font(.body.weight(.semibold))
                Spacer(minLength: 8)
                if badge > 0 {
                    Text("\(badge)")
                        .font(.footnote.weight(.semibold))
                        .foregroundStyle(.white)
                        .padding(.horizontal, 7)
                        .frame(minWidth: 22, minHeight: 22)
                        .background(Palette.tint, in: Capsule())
                        .transition(.scale(scale: 0.4).combined(with: .opacity))
                }
            }
            .foregroundStyle(Palette.ink)
            .padding(.horizontal, Self.inset)
            .frame(height: 50)
            .contentShape(Rectangle())
            .animation(Springs.bouncy, value: badge)
        }
        .buttonStyle(PressableStyle(scale: 0.98))
    }

    // MARK: Chats

    private var conversations: [Conversation] {
        ConversationGroups.group(store.conversations, search: search).flatMap(\.conversations)
    }

    private var list: some View {
        List {
            if conversations.isEmpty {
                Text(store.conversations.isEmpty ? "Your chats will show up here." : "Nothing matches “\(search)”.")
                    .font(.subheadline)
                    .foregroundStyle(Palette.secondary)
                    .listRowBackground(Color.clear)
                    .listRowSeparator(.hidden)
                    .listRowInsets(EdgeInsets(top: 8, leading: Self.inset, bottom: 8, trailing: Self.inset))
            }
            ForEach(conversations) { conversation in
                chatRow(conversation)
                    .listRowBackground(Color.clear)
                    .listRowSeparator(.hidden)
                    .listRowInsets(EdgeInsets(top: 0, leading: 10, bottom: 0, trailing: 10))
            }
        }
        .listStyle(.plain)
        .scrollContentBackground(.hidden)
        .scrollDismissesKeyboard(.interactively)
        .contentMargins(.bottom, 96, for: .scrollContent)
        .animation(Springs.smooth, value: search)
    }

    private func chatRow(_ conversation: Conversation) -> some View {
        let selected = conversation.id == chat.current.id && !chat.isTemporary && navigator.screen == .chat
        return Button {
            Haptic.select()
            chat.open(conversation)
            navigator.go(.chat)
        } label: {
            Text(conversation.title)
                .font(.body)
                .foregroundStyle(Palette.ink)
                .lineLimit(1)
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(.horizontal, Self.inset - 10)
                .frame(height: 46)
                .background(selected ? Palette.surface : .clear, in: RoundedRectangle(cornerRadius: 14, style: .continuous))
                .contentShape(Rectangle())
        }
        .buttonStyle(PressableStyle(scale: 0.98))
        .swipeActions(edge: .trailing, allowsFullSwipe: true) {
            Button(role: .destructive) {
                Haptic.warning()
                withAnimation { store.delete(conversation.id) }
                chat.forget(conversation.id)
            } label: {
                Label("Delete", systemImage: "trash")
            }
        }
        .contextMenu {
            Button("Rename", systemImage: "pencil") {
                renameText = conversation.title
                renaming = conversation
            }
            Button("Delete", systemImage: "trash", role: .destructive) {
                store.delete(conversation.id)
                chat.forget(conversation.id)
            }
        }
    }

    // MARK: Bottom

    private var bottomBar: some View {
        HStack {
            Button {
                Haptic.tap()
                chat.newChat()
                navigator.go(.chat)
            } label: {
                Label("New chat", systemImage: "square.and.pencil")
                    .font(.body.weight(.semibold))
                    .foregroundStyle(Palette.background)
                    .padding(.horizontal, 22)
                    .frame(height: 52)
                    .background(Palette.ink, in: Capsule())
                    .contentShape(Capsule())
            }
            .buttonStyle(PressableStyle(scale: 0.95))
            .accessibilityIdentifier("drawer.newChat")

            Spacer()

            Button {
                Haptic.select()
                navigator.openSettings()
            } label: {
                Image(systemName: "gearshape")
            }
            .buttonStyle(GlassCircleButtonStyle(diameter: 52))
            .accessibilityLabel("Settings")
            .accessibilityIdentifier("drawer.settings")
        }
        .padding(.horizontal, Self.inset - 4)
        .padding(.top, 28)
        .padding(.bottom, 8)
        .background {
            // The list fades out behind the buttons rather than ending at an edge.
            LinearGradient(
                stops: [
                    .init(color: Palette.drawer.opacity(0), location: 0),
                    .init(color: Palette.drawer, location: 0.45)
                ],
                startPoint: .top,
                endPoint: .bottom
            )
            .ignoresSafeArea(edges: .bottom)
            .allowsHitTesting(false)
        }
    }
}

/// The button that opens the drawer, at the top left of a screen.
struct DrawerButton: View {
    @Environment(AppNavigator.self) private var navigator

    var body: some View {
        Button {
            Haptic.tap()
            navigator.drawerOpen = true
        } label: {
            MenuGlyph()
                .foregroundStyle(Palette.ink)
        }
        .accessibilityLabel("Menu")
        .accessibilityIdentifier("drawer.open")
    }
}
