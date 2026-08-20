import SwiftUI

/// A unified item the palette can act on — a real chat, or a command (jump
/// to a Settings page, switch model, change theme). Everything lives in one
/// flat, ordered list so arrow keys and Enter only ever have to think about
/// a single index, never which section it's in.
private enum PaletteItem: Identifiable {
    case newChat
    case conversation(Conversation)
    case openSettings(title: String, icon: String, selectionId: String?)
    case switchModel(id: String, displayName: String)
    case setTheme(AppTheme)

    var id: String {
        switch self {
        case .newChat: return "new-chat"
        case .conversation(let c): return "chat:\(c.id.uuidString)"
        case .openSettings(_, _, let selectionId): return "settings:\(selectionId ?? "general")"
        case .switchModel(let id, _): return "model:\(id)"
        case .setTheme(let theme): return "theme:\(theme.rawValue)"
        }
    }
}

struct SearchPaletteView: View {
    @Environment(\.themeColors) private var colors
    @Bindable private var appearance = AppearanceSettings.shared
    @Binding var isPresented: Bool
    @Bindable var viewModel: ChatViewModel
    var onNewChat: () -> Void
    var onSelect: (UUID) -> Void = { _ in }
    /// Opens Settings landed on a specific page (nil = General) — same
    /// mechanism `ModelPickerMenu`'s per-provider gear already uses.
    var onOpenSettings: (String?) -> Void = { _ in }

    @State private var searchText = ""
    @FocusState private var isSearchFocused: Bool
    @State private var appeared = false
    /// Index into `items` — the only thing arrow keys and Enter touch.
    @State private var selectedIndex = 0

    private var query: String { searchText.trimmingCharacters(in: .whitespaces).lowercased() }

    private static let settingsPages: [(title: String, icon: String, id: String?)] = [
        ("General", "gearshape", nil),
        ("Custom Instructions", "text.quote", "instructions"),
        ("Appearance", "paintpalette", "appearance"),
        ("Shortcuts", "keyboard", "shortcuts"),
        ("Privacy", "lock.fill", "privacy"),
        ("Statistics", "chart.bar", "statistics"),
    ]

    private var conversationResults: [Conversation] {
        // Deliberately unscoped: search is how you find a chat you know
        // exists, and hiding half the history behind whichever mode happens
        // to be active would make it fail at exactly that. Picking a result
        // from the other mode moves you into that mode.
        let all = viewModel.allConversationsSorted
        guard !query.isEmpty else { return all }
        return all.filter { convo in
            convo.title.lowercased().contains(query)
                || convo.messages.contains { $0.content.lowercased().contains(query) }
        }
    }

    private var settingsResults: [PaletteItem] {
        Self.settingsPages
            .filter { query.isEmpty || $0.title.lowercased().contains(query) }
            .map { .openSettings(title: $0.title, icon: $0.icon, selectionId: $0.id) }
    }

    private var modelResults: [PaletteItem] {
        guard !query.isEmpty else { return [] }
        return viewModel.chatModels
            .filter { model in
                let name = ModelPreferencesStore.shared.nickname(for: model.id)
                    ?? ModelCatalog.displayName(modelId: model.id, apiName: model.name)
                return name.lowercased().contains(query) || model.id.lowercased().contains(query)
            }
            .prefix(6)
            .map { model in
                let name = ModelPreferencesStore.shared.nickname(for: model.id)
                    ?? ModelCatalog.displayName(modelId: model.id, apiName: model.name)
                return .switchModel(id: model.id, displayName: name)
            }
    }

    private var themeResults: [PaletteItem] {
        guard !query.isEmpty, "theme".contains(query) || "appearance".contains(query) || "dark".contains(query) || "light".contains(query) else { return [] }
        return AppTheme.allCases.map { .setTheme($0) }
    }

    /// The single source of truth for both rendering order and keyboard
    /// navigation — always build the list itself here, never duplicate its
    /// order anywhere else.
    private var items: [PaletteItem] {
        var result: [PaletteItem] = [.newChat]
        result += conversationResults.map { .conversation($0) }
        result += settingsResults
        result += modelResults
        result += themeResults
        return result
    }

    private func sectionTitle(for item: PaletteItem) -> String? {
        switch item {
        case .newChat: return nil
        case .conversation: return "Chats"
        case .openSettings: return "Settings"
        case .switchModel: return "Switch model"
        case .setTheme: return "Theme"
        }
    }

    var body: some View {
        ZStack {
            colors.backgroundOverlay
                .ignoresSafeArea()
                .onTapGesture { isPresented = false }

            VStack(spacing: 0) {
                searchField
                Divider().overlay(colors.borderSubtle)
                resultsList
            }
            .frame(width: 560)
            .background(colors.backgroundPopover)
            .clipShape(RoundedRectangle(cornerRadius: 16, style: .continuous))
            .overlay(
                RoundedRectangle(cornerRadius: 16, style: .continuous)
                    .stroke(colors.borderSubtle, lineWidth: 1)
            )
            .shadow(color: .black.opacity(0.28), radius: 40, y: 16)
            .scaleEffect(appeared ? 1 : 0.96)
            .opacity(appeared ? 1 : 0)
        }
        .onAppear {
            isSearchFocused = true
            // The palette itself opens often (⌘K), but per-open is still an
            // occasional action, not a rapid one — a brief entrance reads
            // as responsive rather than janky. What must NOT animate is the
            // per-keystroke selection highlight below.
            withAnimation(.uiEaseOut(duration: 0.16)) { appeared = true }
        }
        .onExitCommand { isPresented = false }
    }

    private var searchField: some View {
        HStack(spacing: 12) {
            Image(systemName: "magnifyingglass")
                .foregroundColor(colors.textSecondary)
                .font(.system(size: 17))
            TextField("Search chats, settings, models…", text: $searchText)
                .textFieldStyle(.plain)
                .font(AppFont.mono(18))
                .focused($isSearchFocused)
                .onKeyPress(.upArrow) { moveSelection(-1); return .handled }
                .onKeyPress(.downArrow) { moveSelection(1); return .handled }
                .onKeyPress(.return) { activateSelection(); return .handled }
        }
        .padding(.horizontal, 18)
        .padding(.vertical, 15)
        .onChange(of: searchText) { _, _ in selectedIndex = 0 }
    }

    private var resultsList: some View {
        let currentItems = items
        return ScrollViewReader { proxy in
            ScrollView {
                VStack(spacing: 0) {
                    ForEach(Array(currentItems.enumerated()), id: \.element.id) { index, item in
                        if index == 0 || sectionTitle(for: currentItems[index - 1]) != sectionTitle(for: item),
                           let title = sectionTitle(for: item) {
                            sectionHeader(title)
                        }
                        row(for: item, isSelected: index == selectedIndex)
                            .id(item.id)
                    }

                    if currentItems.count <= 1, !query.isEmpty {
                        Text("No matches")
                            .font(AppFont.mono(14))
                            .foregroundStyle(colors.textTertiary)
                            .frame(maxWidth: .infinity)
                            .padding(.vertical, 30)
                    }
                }
                .padding(.vertical, 6)
            }
            .frame(maxHeight: 380)
            .onChange(of: selectedIndex) { _, newValue in
                guard let id = currentItems[safe: newValue]?.id else { return }
                // Keyboard-driven scroll-into-view — instant, no animation,
                // same reasoning as the highlight itself.
                proxy.scrollTo(id, anchor: nil)
            }
        }
    }

    private func sectionHeader(_ title: String) -> some View {
        HStack {
            Text(title)
                .font(AppFont.mono(12, weight: .semibold))
                .foregroundStyle(colors.textTertiary)
            Spacer()
        }
        .padding(.horizontal, 16)
        .padding(.top, 10)
        .padding(.bottom, 4)
    }

    @ViewBuilder
    private func row(for item: PaletteItem, isSelected: Bool) -> some View {
        switch item {
        case .newChat:
            PaletteRow(icon: "square.and.pencil", title: "New chat", subtitle: nil, isSelected: isSelected) {
                activate(item)
            }
        case .conversation(let convo):
            PaletteRow(
                icon: "message",
                title: convo.title,
                subtitle: convo.messages.first(where: { !$0.isUser && !$0.content.isEmpty })?.content,
                isSelected: isSelected
            ) { activate(item) }
        case .openSettings(let title, let icon, _):
            PaletteRow(icon: icon, title: title, subtitle: nil, isSelected: isSelected) { activate(item) }
        case .switchModel(let id, let displayName):
            PaletteRow(
                icon: "cube",
                title: displayName,
                subtitle: LocalAIManager.shared.owns(id) ? "Local" : nil,
                isSelected: isSelected
            ) { activate(item) }
        case .setTheme(let theme):
            PaletteRow(
                icon: theme == appearance.theme ? "checkmark.circle.fill" : "circle",
                title: "\(theme.rawValue) theme",
                subtitle: nil,
                isSelected: isSelected
            ) { activate(item) }
        }
    }

    private func activate(_ item: PaletteItem) {
        isPresented = false
        switch item {
        case .newChat:
            onNewChat()
        case .conversation(let convo):
            onSelect(convo.id)
        case .openSettings(_, _, let selectionId):
            onOpenSettings(selectionId)
        case .switchModel(let id, _):
            viewModel.selectModel(id)
        case .setTheme(let theme):
            appearance.theme = theme
        }
    }

    private func moveSelection(_ delta: Int) {
        let count = items.count
        guard count > 0 else { return }
        // No animation — this fires on every arrow-key repeat, potentially
        // dozens of times a second; it must feel instant, not follow a fade.
        selectedIndex = ((selectedIndex + delta) % count + count) % count
    }

    private func activateSelection() {
        guard let item = items[safe: selectedIndex] else { return }
        activate(item)
    }
}

private extension Array {
    subscript(safe index: Int) -> Element? {
        indices.contains(index) ? self[index] : nil
    }
}

private struct PaletteRow: View {
    @Environment(\.themeColors) private var colors
    let icon: String
    let title: String
    let subtitle: String?
    let isSelected: Bool
    let action: () -> Void
    @State private var isHovered = false

    var body: some View {
        Button(action: action) {
            HStack(spacing: 12) {
                Image(systemName: icon)
                    .font(.system(size: 15))
                    .foregroundStyle(colors.textSecondary)
                    .iconHoverEffect(for: icon)
                    .frame(width: 22)
                VStack(alignment: .leading, spacing: 1) {
                    Text(title)
                        .font(AppFont.mono(14))
                        .foregroundStyle(colors.textPrimary)
                        .lineLimit(1)
                    if let subtitle, !subtitle.isEmpty {
                        Text(subtitle)
                            .font(AppFont.mono(12))
                            .foregroundStyle(colors.textTertiary)
                            .lineLimit(1)
                    }
                }
                Spacer(minLength: 0)
            }
            .padding(.horizontal, 16)
            .padding(.vertical, 9)
            // Selection highlight is keyboard-driven and must be instant —
            // no `.animation()` here, on purpose (emil-design-eng: never
            // animate a high-frequency keyboard action).
            .background(isSelected || isHovered ? colors.backgroundHover : .clear)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .onHover { isHovered = $0 }
    }
}
