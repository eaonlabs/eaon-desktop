import AppKit
import SwiftUI

struct SidebarView: View {
    @Environment(\.themeColors) private var colors
    @Bindable var viewModel: ChatViewModel
    @Binding var selection: SidebarDestination
    @Binding var showingSearchPalette: Bool
    var onOpenSettings: () -> Void = {}
    var onCollapse: () -> Void = {}
    var onNewChat: () -> Void = {}
    var onDeleteRequest: (Conversation) -> Void = { _ in }
    var onRenameRequest: (Conversation) -> Void = { _ in }
    var onDeleteAllRequest: () -> Void = {}
    var onNewProjectRequest: () -> Void = {}
    var onRenameProjectRequest: (Project) -> Void = { _ in }
    var onDeleteProjectRequest: (Project) -> Void = { _ in }

    /// Which project folders are expanded inline in the sidebar — a folder's
    /// chats only ever show here, on click, never mixed into the flat
    /// "Chats" list below.
    @State private var expandedProjectIds: Set<UUID> = []

    /// Which repository folders are showing their sessions. Nil until the
    /// first render so `defaultExpanded` can decide, after which it's
    /// whatever the user has opened and closed — an explicit set, because
    /// "no folders open" is a real state that mustn't be mistaken for
    /// "hasn't been decided yet" and silently re-opened.
    @State private var expandedFolderIds: Set<String> = []
    @State private var hasSeededExpansion = false

    /// Height of the top/bottom edge fade over the conversation list —
    /// tall enough to read as a deliberate gradient, short enough that it
    /// doesn't eat into rows near the edge.
    private let listFadeHeight: CGFloat = 20

    var body: some View {
        VStack(spacing: 0) {
            header

            modeSwitcher

            // Nav rows, pinned chats, and Projects are the sidebar's fixed
            // furniture — they stay put. Only the conversation list below
            // them scrolls, in its own `ScrollView`; nesting it inside one
            // shared scroll container (as this used to) let a scroll
            // gesture over the chat rows carry the nav rows and Projects
            // off-screen with them.
            VStack(alignment: .leading, spacing: 2) {
                navItems
                pinnedSection
                projectsSection
            }
            .padding(.horizontal, 8)

            ScrollView {
                VStack(alignment: .leading, spacing: 2) {
                    // Work files its history by project folder; Chat has no
                    // folders to file under, so it keeps the date buckets.
                    if viewModel.currentMode.conversationScope == .agent {
                        repositoriesSection
                    } else {
                        chatHistory
                    }
                }
                .padding(.horizontal, 8)
                .padding(.bottom, 12)
                .thinScrollers()
            }
            // Fades the list's own edges into the sidebar's background
            // rather than clipping rows off with a hard edge — the list can
            // still scroll right up to them, it just reads as settling
            // under the fixed area above instead of stopping abruptly.
            .overlay(alignment: .top) {
                LinearGradient(colors: [colors.backgroundSidebar, .clear], startPoint: .top, endPoint: .bottom)
                    .frame(height: listFadeHeight)
                    .allowsHitTesting(false)
            }
            .overlay(alignment: .bottom) {
                LinearGradient(colors: [.clear, colors.backgroundSidebar], startPoint: .top, endPoint: .bottom)
                    .frame(height: listFadeHeight)
                    .allowsHitTesting(false)
            }
        }
        .frame(maxHeight: .infinity, alignment: .top)
    }

    // MARK: - Header

    /// A title-bar band tall enough for the native traffic-light window
    /// controls to sit inside it on the left; only the collapse toggle lives
    /// here, on the right, so it never collides with them.
    private var header: some View {
        HStack(spacing: 2) {
            Spacer()
            // Hidden while Settings is open — its whole navigation lives in
            // this sidebar, so collapsing it there would leave no way to
            // switch category or leave (RootView pins it open to match).
            if !isInSettings {
                SidebarIconButton(systemName: "sidebar.left", help: "Close sidebar", action: onCollapse)
            }
        }
        .padding(.horizontal, 10)
        .frame(height: 50)
    }

    private var isInSettings: Bool {
        if case .settings = selection { return true }
        return false
    }

    // MARK: - Mode switcher

    /// Chat / Work, pinned above New Chat and outside the scroll view — it
    /// says which mode everything below belongs to, so it can't scroll away
    /// from the thing it labels.
    ///
    /// Picking a mode also navigates back to the conversation surface. From
    /// Settings or Models the switcher would otherwise change the mode
    /// silently while the screen stayed put, which reads as a dead control;
    /// a top-level switch should always take you to the thing it switches.
    private var modeSwitcher: some View {
        ModeSegmentedControl(currentMode: viewModel.currentMode) { mode in
            viewModel.enterMode(mode)
            selection = .mode(mode)
        }
        .padding(.horizontal, 8)
        .padding(.bottom, 10)
    }

    // MARK: - Nav items

    private var navItems: some View {
        VStack(alignment: .leading, spacing: 2) {
            SidebarNavRow(icon: "bubble.left", title: "New Chat", trailing: "⌘N", shortcut: "n") {
                onNewChat()
            }
            SidebarNavRow(
                icon: "folder.badge.plus",
                title: "New Project",
                trailing: "⌘P",
                isActive: selection == .feature(.projects),
                shortcut: "p"
            ) {
                selection = .feature(.projects)
            }
            SidebarNavRow(icon: "magnifyingglass", title: "Search", trailing: "⌘K", shortcut: "k") {
                showingSearchPalette = true
            }
            SidebarNavRow(
                icon: "cube",
                title: "Models",
                isActive: selection == .feature(.models)
            ) {
                selection = .feature(.models)
            }
            SidebarNavRow(icon: "gearshape", title: "Settings", isActive: isSettingsActive) {
                onOpenSettings()
            }
        }
        .padding(.bottom, 6)
    }

    private var isSettingsActive: Bool {
        if case .settings = selection { return true }
        return false
    }

    // MARK: - Projects

    /// Only shown once at least one project exists — with none yet, "New
    /// Projects" above already leads to the empty state's own creation CTA,
    /// so an empty "Projects" header here would just be clutter.
    @ViewBuilder
    private var projectsSection: some View {
        let items = viewModel.sortedProjects
        if !items.isEmpty {
            HStack(spacing: 4) {
                Text("Projects")
                    .font(AppFont.mono(12, weight: .semibold))
                    .foregroundStyle(colors.textTertiary)

                Spacer(minLength: 0)

                Button(action: onNewProjectRequest) {
                    Image(systemName: "plus")
                        .font(.system(size: 12, weight: .semibold))
                        .foregroundStyle(colors.textTertiary)
                        .frame(width: 20, height: 20)
                        .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .help("New project")
            }
            .padding(.horizontal, 10)
            .padding(.top, 12)
            .padding(.bottom, 4)

            ForEach(items) { project in
                let isExpanded = expandedProjectIds.contains(project.id)

                ProjectRow(
                    project: project,
                    isExpanded: isExpanded,
                    onToggle: { toggleExpanded(project.id) },
                    onRename: { onRenameProjectRequest(project) },
                    onDelete: { onDeleteProjectRequest(project) }
                )

                if isExpanded {
                    let chats = viewModel.conversations(inProject: project.id)
                    if chats.isEmpty {
                        Text("No chats yet")
                            .font(AppFont.mono(12))
                            .foregroundStyle(colors.textTertiary)
                            .padding(.leading, 38)
                            .padding(.vertical, 7)
                    } else {
                        ForEach(chats) { conversation in
                            ConversationRow(
                                conversation: conversation,
                                isActive: viewModel.currentConversationId == conversation.id,
                                projects: viewModel.sortedProjects,
                                onSelect: {
                                    viewModel.selectConversation(conversation.id)
                                    viewModel.enterMode(.chat); selection = .mode(.chat)
                                },
                                onRename: { onRenameRequest(conversation) },
                                onDelete: { onDeleteRequest(conversation) },
                                onMoveToProject: { viewModel.moveConversation(conversation.id, toProject: $0) },
                                showsPinOption: false,
                                isGeneratingInBackground: viewModel.isGeneratingInBackground(conversation.id)
                            )
                            .padding(.leading, 20)
                        }
                    }
                }
            }
        }
    }

    private func toggleExpanded(_ id: UUID) {
        withAnimation(.easeOut(duration: 0.15)) {
            if expandedProjectIds.contains(id) {
                expandedProjectIds.remove(id)
            } else {
                expandedProjectIds.insert(id)
            }
        }
    }

    // MARK: - Pinned

    @ViewBuilder
    private var pinnedSection: some View {
        let pinned = viewModel.pinnedConversations
        if !pinned.isEmpty {
            HStack(spacing: 4) {
                Text("Pinned")
                    .font(AppFont.mono(12, weight: .semibold))
                    .foregroundStyle(colors.textTertiary)
                Spacer(minLength: 0)
            }
            .padding(.horizontal, 10)
            .padding(.top, 12)
            .padding(.bottom, 4)

            ForEach(pinned) { conversation in
                ConversationRow(
                    conversation: conversation,
                    isActive: viewModel.currentConversationId == conversation.id,
                    projects: viewModel.sortedProjects,
                    onSelect: {
                        viewModel.selectConversation(conversation.id)
                        viewModel.enterMode(.chat); selection = .mode(.chat)
                    },
                    onRename: { onRenameRequest(conversation) },
                    onDelete: { onDeleteRequest(conversation) },
                    onTogglePin: { viewModel.togglePinned(conversation.id) },
                    onMoveToProject: { viewModel.moveConversation(conversation.id, toProject: $0) },
                    isGeneratingInBackground: viewModel.isGeneratingInBackground(conversation.id)
                )
            }
        }
    }

    // MARK: - Chat history

    /// One flat, most-recent-first list under a single "Chats" heading.
    ///
    /// It used to be split into Today / Yesterday / Previous 7 Days /
    /// Previous 30 Days / by month. Those headings cost a row of vertical
    /// space each and earned almost nothing: you look for a chat by its
    /// title, not by working out which week you had it in, and a sidebar
    /// this narrow could end up showing four headings around six chats.
    /// The list is still ordered newest-first, so recency is still there to
    /// read — it just isn't announced five times over.
    @ViewBuilder
    private var chatHistory: some View {
        let unfiled = viewModel.unpinnedUnfiledConversations
        if !unfiled.isEmpty {
            HStack(spacing: 4) {
                Text("Chats")
                    .font(AppFont.mono(12, weight: .semibold))
                    .foregroundStyle(colors.textTertiary)

                Spacer(minLength: 0)

                Menu {
                    Button(role: .destructive) {
                        onDeleteAllRequest()
                    } label: {
                        Label("Delete All", systemImage: "trash")
                    }
                } label: {
                    Image(systemName: "ellipsis")
                        .font(.system(size: 12, weight: .semibold))
                        .foregroundStyle(colors.textTertiary)
                        .frame(width: 20, height: 20)
                        .contentShape(Rectangle())
                }
                .menuStyle(.button)
                .menuIndicator(.hidden)
                .buttonStyle(.plain)
                .fixedSize()
            }
            .padding(.horizontal, 10)
            .padding(.top, 12)
            .padding(.bottom, 4)

            ForEach(unfiled) { conversation in
                ConversationRow(
                    conversation: conversation,
                    isActive: viewModel.currentConversationId == conversation.id,
                    projects: viewModel.sortedProjects,
                    onSelect: {
                        viewModel.selectConversation(conversation.id)
                        viewModel.enterMode(.chat); selection = .mode(.chat)
                    },
                    onRename: { onRenameRequest(conversation) },
                    onDelete: { onDeleteRequest(conversation) },
                    onTogglePin: { viewModel.togglePinned(conversation.id) },
                    onMoveToProject: { viewModel.moveConversation(conversation.id, toProject: $0) },
                    isGeneratingInBackground: viewModel.isGeneratingInBackground(conversation.id)
                )
            }
        }
    }

    // MARK: - Repositories (Work mode)

    /// Work's history, filed under the folder each session was held in.
    ///
    /// Chat sessions are about whatever you asked; Work sessions are about a
    /// codebase, and "which project was that in" is the thing you actually
    /// remember about one. A flat, date-bucketed list makes you read every
    /// title to find the three that belong to the repo you're in — grouping
    /// by folder answers it before you read anything.
    ///
    /// Folders with no sessions are listed too, not hidden: they're the ones
    /// you've opened and can start work in, and dropping them would make the
    /// folder picker and this list disagree about which projects exist.
    private func isExpanded(_ group: ChatViewModel.WorkFolderGroup) -> Bool {
        expandedFolderIds.contains(group.id)
    }

    private func toggleExpanded(_ group: ChatViewModel.WorkFolderGroup) {
        if expandedFolderIds.contains(group.id) {
            expandedFolderIds.remove(group.id)
        } else {
            expandedFolderIds.insert(group.id)
        }
    }

    /// Opens only the folder you're working in, once, on first appearance.
    /// Everything else starts folded — the whole point of the disclosure is
    /// that a sidebar of five projects isn't a wall of every session you've
    /// ever had.
    private func seedExpansionIfNeeded(_ groups: [ChatViewModel.WorkFolderGroup]) {
        guard !hasSeededExpansion, !groups.isEmpty else { return }
        hasSeededExpansion = true
        let selected = WorkFolderStore.shared.selectedPath
        if let current = groups.first(where: { $0.path != nil && $0.path == selected }) {
            expandedFolderIds.insert(current.id)
        } else if let first = groups.first, first.path == nil {
            // Nothing selected: open "No folder" if that's where the history
            // is, so the list isn't entirely blank on first look.
            expandedFolderIds.insert(first.id)
        }
    }

    @ViewBuilder
    private var repositoriesSection: some View {
        let groups = viewModel.workFolderGroups

        HStack(spacing: 4) {
            Text("Repositories")
                .font(AppFont.mono(12, weight: .semibold))
                .foregroundStyle(colors.textTertiary)

            Spacer(minLength: 0)

            Button {
                WorkFolderStore.shared.chooseFolder()
            } label: {
                Image(systemName: "folder.badge.plus")
                    .font(.system(size: 12, weight: .medium))
                    .foregroundStyle(colors.textTertiary)
                    .frame(width: 20, height: 20)
                    .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .help("Add a project folder")
        }
        .padding(.horizontal, 10)
        .padding(.top, 12)
        .padding(.bottom, 4)
        .onAppear { seedExpansionIfNeeded(groups) }
        .onChange(of: groups.count) { _, _ in seedExpansionIfNeeded(groups) }

        if groups.isEmpty {
            Text("Add a folder to start working in your own code.")
                .font(AppFont.sans(12))
                .foregroundStyle(colors.textTertiary)
                .fixedSize(horizontal: false, vertical: true)
                .padding(.horizontal, 10)
                .padding(.vertical, 6)
        }

        ForEach(groups) { group in
            let expanded = isExpanded(group)

            RepositoryRow(
                group: group,
                isSelected: group.path != nil && group.path == WorkFolderStore.shared.selectedPath,
                isExpanded: expanded,
                onSelect: {
                    guard let path = group.path else { return }
                    WorkFolderStore.shared.select(path: path)
                    // Working somewhere means wanting to see what's there —
                    // selecting a folder opens it rather than leaving you to
                    // click twice for one intention.
                    expandedFolderIds.insert(group.id)
                },
                onToggleExpanded: { toggleExpanded(group) },
                onNewSession: {
                    if let path = group.path { WorkFolderStore.shared.select(path: path) }
                    onNewChat()
                }
            )

            if group.isEmpty, expanded {
                Text("No sessions yet")
                    .font(AppFont.sans(12))
                    .foregroundStyle(colors.textTertiary)
                    .padding(.leading, 45)
                    .padding(.vertical, 5)
            } else if expanded {
                ForEach(group.conversations) { conversation in
                    RepositorySessionRow(
                        conversation: conversation,
                        isActive: viewModel.currentConversationId == conversation.id,
                        isGeneratingInBackground: viewModel.isGeneratingInBackground(conversation.id),
                        onSelect: {
                            // Opening a session also moves Eaon back into the
                            // folder it was held in — otherwise you'd be
                            // reading a transcript about one project while the
                            // next message went to a different one.
                            if let path = conversation.workFolderPath {
                                WorkFolderStore.shared.select(path: path)
                            }
                            viewModel.selectConversation(conversation.id)
                            selection = .mode(.agent)
                        },
                        onRename: { onRenameRequest(conversation) },
                        onDelete: { onDeleteRequest(conversation) }
                    )
                }
            }
        }
    }

    /// Groups already most-recent-first conversations into ChatGPT's date
    /// buckets (Today / Yesterday / Previous 7 Days / Previous 30 Days / by
    /// month) without re-sorting — the incoming order already determines
    /// bucket order, so this is a single linear pass.
    private struct ConversationBucket {
        let title: String
        var conversations: [Conversation]
    }

    private static func dateBuckets(for conversations: [Conversation]) -> [ConversationBucket] {
        var buckets: [ConversationBucket] = []
        for conversation in conversations {
            let title = bucketTitle(for: conversation.updatedAt)
            if buckets.last?.title == title {
                buckets[buckets.count - 1].conversations.append(conversation)
            } else {
                buckets.append(ConversationBucket(title: title, conversations: [conversation]))
            }
        }
        return buckets
    }

    private static func bucketTitle(for date: Date) -> String {
        let calendar = Calendar.current
        if calendar.isDateInToday(date) { return "Today" }
        if calendar.isDateInYesterday(date) { return "Yesterday" }

        let days = calendar.dateComponents(
            [.day],
            from: calendar.startOfDay(for: date),
            to: calendar.startOfDay(for: Date())
        ).day ?? 0

        if days < 7 { return "Previous 7 Days" }
        if days < 30 { return "Previous 30 Days" }

        let formatter = DateFormatter()
        let sameYear = calendar.component(.year, from: date) == calendar.component(.year, from: Date())
        formatter.dateFormat = sameYear ? "LLLL" : "LLLL yyyy"
        return formatter.string(from: date)
    }

    // MARK: - Account row

}

/// Reaches into the real `NSScrollView` behind a SwiftUI `ScrollView` to
/// give its scroller the thin, translucent, dark-tinted overlay look —
/// SwiftUI's own `.scrollIndicators()` only offers show/hide, nothing about
/// thickness or knob color, and the system's default legacy scroller (wide,
/// opaque, light gray) barely belongs against this app's dark sidebar.
///
/// An invisible `NSViewRepresentable` rather than a modifier, because
/// there's no SwiftUI handle to the scroller at all — this is the standard
/// way to reach an ancestor AppKit object SwiftUI doesn't expose: drop a
/// zero-content view into the hierarchy and walk `superview` up from it.

// MARK: - Aqua brand mark

/// A peak rising from a wave — reads as both "A" and water, echoing the
/// swell photography and angular wordmark of the backend's own branding.
/// Deliberately simple: at the 18–30px sizes this renders in, fine
/// letterform detail (e.g. a literal crossbar) would just turn to mud.
struct AquaGlyph: Shape {
    func path(in rect: CGRect) -> Path {
        let w = rect.width, h = rect.height
        var path = Path()
        path.move(to: CGPoint(x: w * 0.5, y: h * 0.12))
        path.addLine(to: CGPoint(x: w * 0.86, y: h * 0.80))
        path.addCurve(
            to: CGPoint(x: w * 0.14, y: h * 0.80),
            control1: CGPoint(x: w * 0.68, y: h * 0.62),
            control2: CGPoint(x: w * 0.32, y: h * 0.62)
        )
        path.closeSubpath()
        return path
    }
}

struct AquaMark: View {
    var size: CGFloat = 26

    var body: some View {
        ZStack {
            RoundedRectangle(cornerRadius: size * 0.28, style: .continuous)
                .fill(AquaBrand.accent)
            AquaGlyph()
                .fill(.white)
                .frame(width: size * 0.52, height: size * 0.52)
                .offset(y: size * 0.02)
        }
        .frame(width: size, height: size)
    }
}

/// The app's own wordmark — "Eaon," the product name. Distinct from the
/// backend/company brand (the Aqua API), which is unchanged — same
/// relationship as "ChatGPT" the product vs "OpenAI" the company.
struct AquaWordmark: View {
    var size: CGFloat = 16
    @Environment(\.themeColors) private var colors

    var body: some View {
        Text("Eaon")
            .font(.system(size: size, weight: .semibold))
            .foregroundStyle(colors.textPrimary)
    }
}

// MARK: - Nav row

private struct SidebarNavRow: View {
    @Environment(\.themeColors) private var colors
    let icon: String
    let title: String
    var trailing: String? = nil
    var isActive: Bool = false
    var shortcut: KeyEquivalent? = nil
    let action: () -> Void

    @State private var isHovered = false

    var body: some View {
        Button(action: action) {
            HStack(spacing: 9) {
                Image(systemName: icon)
                    .font(.system(size: 15, weight: .regular))
                    .foregroundStyle(colors.textPrimary.opacity(0.85))
                    .frame(width: 20)
                Text(title)
                    .font(AppFont.mono(14, weight: .regular))
                    .foregroundStyle(colors.textPrimary)
                Spacer(minLength: 0)
                if let trailing {
                    ShortcutHintView(shortcut: trailing)
                }
            }
            .padding(.horizontal, 10)
            .padding(.vertical, 7)
            .background(
                RoundedRectangle(cornerRadius: 9, style: .continuous)
                    .fill(isActive ? colors.backgroundSelected : (isHovered ? colors.backgroundHover : .clear))
            )
            .contentShape(RoundedRectangle(cornerRadius: 9, style: .continuous))
        }
        .buttonStyle(PressableButtonStyle())
        .modifier(OptionalShortcut(shortcut: shortcut))
        .onHover { isHovered = $0 }
    }
}

/// Renders a shortcut like "⌘N" as separated, muted glyphs (⌘  N), always
/// visible — matching the target layout's persistent key hints.
private struct ShortcutHintView: View {
    @Environment(\.themeColors) private var colors
    let shortcut: String

    private var glyphs: [String] {
        guard let key = shortcut.last else { return [] }
        let modifiers = String(shortcut.dropLast())
        return [modifiers, String(key)].filter { !$0.isEmpty }
    }

    var body: some View {
        HStack(spacing: 6) {
            ForEach(Array(glyphs.enumerated()), id: \.offset) { _, glyph in
                Text(glyph)
                    .font(AppFont.mono(12, weight: .regular))
                    .foregroundStyle(colors.textTertiary)
            }
        }
    }
}

private struct OptionalShortcut: ViewModifier {
    let shortcut: KeyEquivalent?
    func body(content: Content) -> some View {
        if let shortcut {
            content.keyboardShortcut(shortcut, modifiers: .command)
        } else {
            content
        }
    }
}

// MARK: - Conversation row

/// A project folder in Work's sidebar, with its sessions listed beneath it.
private struct RepositoryRow: View {
    @Environment(\.themeColors) private var colors
    let group: ChatViewModel.WorkFolderGroup
    let isSelected: Bool
    let isExpanded: Bool
    let onSelect: () -> Void
    let onToggleExpanded: () -> Void
    let onNewSession: () -> Void

    @State private var isHovered = false

    var body: some View {
        Button(action: onSelect) {
            HStack(spacing: 6) {
                // The disclosure is its own hit target, separate from the
                // row: peeking at what's inside a folder must not silently
                // repoint where Eaon writes code, and clicking the row does
                // exactly that.
                Button(action: onToggleExpanded) {
                    Image(systemName: "chevron.right")
                        .font(.system(size: 9, weight: .semibold))
                        .foregroundStyle(colors.textTertiary)
                        .rotationEffect(.degrees(isExpanded ? 90 : 0))
                        .frame(width: 14, height: 14)
                        .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .disabled(group.isEmpty)
                .opacity(group.isEmpty ? 0.25 : 1)
                // Short and eased-out: a disclosure arrow is a confirmation
                // that the click landed, not an event worth watching.
                .animation(.easeOut(duration: 0.16), value: isExpanded)

                // Filled once there's history in it — an at-a-glance
                // difference between "a project" and "a folder I opened
                // once", without a second column of metadata to read.
                Image(systemName: group.isEmpty ? "folder" : "folder.fill")
                    .font(.system(size: 13))
                    .foregroundStyle(group.isEmpty ? colors.textTertiary : colors.textSecondary)
                    .frame(width: 18)

                Text(group.name)
                    .font(AppFont.sans(14))
                    .foregroundStyle(group.isEmpty ? colors.textSecondary : colors.textPrimary)
                    .lineLimit(1)

                Spacer(minLength: 0)

                // Kept out of the layout until hovered rather than faded in
                // place, so a row of folders isn't a row of buttons.
                if isHovered, group.path != nil {
                    Button(action: onNewSession) {
                        Image(systemName: "plus")
                            .font(.system(size: 11, weight: .semibold))
                            .foregroundStyle(colors.textTertiary)
                            .frame(width: 18, height: 18)
                            .contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                    .help("New session in \(group.name)")
                } else if !group.isEmpty {
                    // The count stands in for the list while it's collapsed,
                    // so a folded folder still says how much is in it.
                    Text("\(group.conversations.count)")
                        .font(AppFont.sans(12))
                        .foregroundStyle(colors.textTertiary)
                        .padding(.trailing, 2)
                }
            }
            .padding(.horizontal, 10)
            .padding(.vertical, 5)
            .background(
                RoundedRectangle(cornerRadius: 9, style: .continuous)
                    .fill(isSelected ? colors.backgroundSelected : (isHovered ? colors.backgroundHover : .clear))
            )
            .contentShape(RoundedRectangle(cornerRadius: 9, style: .continuous))
        }
        .buttonStyle(PressableButtonStyle())
        .onHover { isHovered = $0 }
        .padding(.top, 6)
        .help(group.path.map(WorkFolder.abbreviated) ?? "Sessions held before a folder was chosen")
        .contextMenu {
            if let path = group.path {
                Button("Reveal in Finder") {
                    NSWorkspace.shared.selectFile(nil, inFileViewerRootedAtPath: path)
                }
            }
        }
    }
}

/// One Work session, indented under the folder it was held in.
private struct RepositorySessionRow: View {
    @Environment(\.themeColors) private var colors
    let conversation: Conversation
    let isActive: Bool
    var isGeneratingInBackground: Bool = false
    let onSelect: () -> Void
    let onRename: () -> Void
    let onDelete: () -> Void

    @State private var isHovered = false

    var body: some View {
        Button(action: onSelect) {
            HStack(spacing: 6) {
                if isGeneratingInBackground {
                    ProgressView()
                        .controlSize(.small)
                        .scaleEffect(0.55)
                        .frame(width: 10, height: 10)
                }

                Text(conversation.title)
                    .font(AppFont.sans(14))
                    .foregroundStyle(isActive ? colors.textPrimary : colors.textPrimary.opacity(0.82))
                    .lineLimit(1)

                Spacer(minLength: 6)

                Text(Self.compactAge(conversation.updatedAt))
                    .font(AppFont.sans(12))
                    .foregroundStyle(colors.textTertiary)
            }
            // Indented to the folder name's text, not its icon, so the
            // nesting reads as "belongs to that" rather than as a second
            // column.
            .padding(.leading, 29)
            .padding(.trailing, 10)
            .padding(.vertical, 5)
            .background(
                RoundedRectangle(cornerRadius: 9, style: .continuous)
                    .fill(isActive ? colors.backgroundSelected : (isHovered ? colors.backgroundHover : .clear))
            )
            .contentShape(RoundedRectangle(cornerRadius: 9, style: .continuous))
        }
        .buttonStyle(PressableButtonStyle())
        .onHover { isHovered = $0 }
        .contextMenu {
            Button { onRename() } label: { Label("Rename", systemImage: "pencil") }
            Button(role: .destructive) { onDelete() } label: { Label("Delete", systemImage: "trash") }
        }
    }

    /// "3h", "2d" — a session list is scanned, not read, and the age only
    /// has to separate "this morning" from "last month".
    static func compactAge(_ date: Date) -> String {
        let seconds = Date().timeIntervalSince(date)
        if seconds < 60 { return "now" }
        if seconds < 3600 { return "\(Int(seconds / 60))m" }
        if seconds < 86_400 { return "\(Int(seconds / 3600))h" }
        return "\(Int(seconds / 86_400))d"
    }
}

private struct ConversationRow: View {
    @Environment(\.themeColors) private var colors
    let conversation: Conversation
    let isActive: Bool
    /// Offered in the row's own menu so filing a chat is one gesture from
    /// where the chat already is, instead of a drag or a trip elsewhere.
    /// Empty means no projects exist yet, and the submenu is left out
    /// rather than opening onto nothing.
    var projects: [Project] = []
    let onSelect: () -> Void
    let onRename: () -> Void
    let onDelete: () -> Void
    var onTogglePin: () -> Void = {}
    /// nil takes the chat back out of whatever project it's in.
    var onMoveToProject: (UUID?) -> Void = { _ in }
    /// Declared after the closures above so every call site can list its
    /// arguments in the order Swift requires without reshuffling.
    /// Pinning only means anything for an unfiled chat — the Pinned
    /// section lives alongside the flat "Chats" list, not inside a
    /// project's own disclosure, so a project chat's row omits the option
    /// entirely rather than offering a toggle with no visible effect.
    var showsPinOption: Bool = true
    /// True while this chat is still generating a reply in the
    /// background — i.e. you switched away from it (a new chat, or a
    /// different existing one) before it finished. Confirms the other
    /// model really is still working, rather than leaving that invisible.
    var isGeneratingInBackground: Bool = false

    @State private var isHovered = false

    private var isPinned: Bool { conversation.isPinned == true }
    private var pinLabel: String { isPinned ? "Unpin" : "Pin" }
    private var pinIcon: String { isPinned ? "pin.slash" : "pin" }

    var body: some View {
        Button(action: onSelect) { rowContent }
            .buttonStyle(PressableButtonStyle())
            .onHover { isHovered = $0 }
            .contextMenu { menuItems }
    }

    /// One definition, used by both the "…" button and the right-click
    /// menu — two lists that drifted apart would mean an action you can
    /// only reach one way, for no reason anyone could explain.
    @ViewBuilder
    private var menuItems: some View {
        Button { onRename() } label: { Label("Rename", systemImage: "pencil") }

        if !projects.isEmpty {
            Menu {
                ForEach(projects) { project in
                    Button {
                        onMoveToProject(project.id)
                    } label: {
                        // Ticked when the chat is already in it, so the
                        // submenu says where the chat lives as well as
                        // offering to move it.
                        Label(
                            project.name,
                            systemImage: conversation.projectId == project.id ? "checkmark" : "folder"
                        )
                    }
                }
                if conversation.projectId != nil {
                    Divider()
                    Button("Remove from Project") { onMoveToProject(nil) }
                }
            } label: {
                Label("Add to project", systemImage: "folder")
            }
        }

        if showsPinOption {
            Button { onTogglePin() } label: { Label(pinLabel, systemImage: pinIcon) }
        }

        Divider()
        Button(role: .destructive) { onDelete() } label: { Label("Delete", systemImage: "trash") }
    }

    private var rowContent: some View {
        // The trailing slot is ALWAYS in the layout (the menu just fades in)
        // and never taller than the text line — so hovering can't change the
        // row's height or the title's width, and nothing below shifts.
        HStack(spacing: 8) {
            Text(conversation.title)
                .font(AppFont.mono(14))
                .foregroundStyle(colors.textPrimary)
                .lineLimit(1)
                .truncationMode(.tail)

            Spacer(minLength: 0)

            // Always visible, hover included — unlike the unread dot below,
            // "this is still working" stays worth knowing even while your
            // cursor is right over the row about to open its menu.
            if isGeneratingInBackground {
                SidebarGeneratingDot()
                    .help("Still generating a reply")
            }

            ZStack {
                if conversation.hasUnread {
                    Circle()
                        .fill(colors.textPrimary)
                        .frame(width: 7, height: 7)
                        .opacity(isHovered || isActive ? 0 : 1)
                }
                Menu {
                    menuItems
                } label: {
                    Image(systemName: "ellipsis")
                        .font(.system(size: 14, weight: .semibold))
                        .foregroundStyle(colors.textSecondary)
                        .frame(width: 22, height: 17)
                        .contentShape(Rectangle())
                }
                .menuStyle(.button)
                .menuIndicator(.hidden)
                .buttonStyle(.plain)
                .fixedSize()
                .opacity(isHovered || isActive ? 1 : 0)
                .allowsHitTesting(isHovered || isActive)
            }
            .frame(width: 22, height: 17)
        }
        .padding(.horizontal, 10)
        .padding(.vertical, 7)
        .background(
            RoundedRectangle(cornerRadius: 9, style: .continuous)
                .fill(isActive ? colors.backgroundSelected : (isHovered ? colors.backgroundHover : .clear))
        )
        .contentShape(RoundedRectangle(cornerRadius: 9, style: .continuous))
    }
}

/// A conversation still generating in the background — you switched away
/// (a new chat, or a different existing one) before it finished.
private struct SidebarGeneratingDot: View {
    @Environment(\.themeColors) private var colors
    @State private var pulse = false

    var body: some View {
        Circle()
            .fill(colors.textSecondary)
            .frame(width: 6, height: 6)
            .opacity(pulse ? 0.3 : 1)
            .animation(.easeInOut(duration: 0.7).repeatForever(autoreverses: true), value: pulse)
            .onAppear { pulse = true }
    }
}

// MARK: - Project row

/// A disclosure row — clicking it only expands/collapses its chats inline,
/// it never navigates away. Chats inside are the *only* place they're shown
/// in the sidebar; they're deliberately excluded from the flat "Chats" list.
private struct ProjectRow: View {
    @Environment(\.themeColors) private var colors
    let project: Project
    let isExpanded: Bool
    let onToggle: () -> Void
    let onRename: () -> Void
    let onDelete: () -> Void

    @State private var isHovered = false

    var body: some View {
        Button(action: onToggle) { rowContent }
            .buttonStyle(PressableButtonStyle())
            .onHover { isHovered = $0 }
            .contextMenu {
                Button { onRename() } label: { Label("Rename", systemImage: "pencil") }
                Button(role: .destructive) { onDelete() } label: { Label("Delete", systemImage: "trash") }
            }
    }

    private var rowContent: some View {
        HStack(spacing: 6) {
            Image(systemName: "chevron.right")
                .font(.system(size: 10, weight: .semibold))
                .foregroundStyle(colors.textTertiary)
                .rotationEffect(.degrees(isExpanded ? 90 : 0))
                .frame(width: 10)

            Image(systemName: isExpanded ? "folder.fill" : "folder")
                .font(.system(size: 13, weight: .regular))
                .foregroundStyle(colors.textSecondary)
                .frame(width: 16)

            Text(project.name)
                .font(AppFont.mono(14))
                .foregroundStyle(colors.textPrimary)
                .lineLimit(1)
                .truncationMode(.tail)

            Spacer(minLength: 0)

            // Always-reserved slot, same reasoning as ConversationRow: the
            // hover menu fades in without ever changing the row's geometry.
            Menu {
                Button { onRename() } label: { Label("Rename", systemImage: "pencil") }
                Button(role: .destructive) { onDelete() } label: { Label("Delete", systemImage: "trash") }
            } label: {
                Image(systemName: "ellipsis")
                    .font(.system(size: 14, weight: .semibold))
                    .foregroundStyle(colors.textSecondary)
                    .frame(width: 22, height: 17)
                    .contentShape(Rectangle())
            }
            .menuStyle(.button)
            .menuIndicator(.hidden)
            .buttonStyle(.plain)
            .fixedSize()
            .opacity(isHovered ? 1 : 0)
            .allowsHitTesting(isHovered)
        }
        .padding(.horizontal, 10)
        .padding(.vertical, 7)
        .background(
            RoundedRectangle(cornerRadius: 9, style: .continuous)
                .fill(isExpanded ? colors.backgroundSelected : (isHovered ? colors.backgroundHover : .clear))
        )
        .contentShape(RoundedRectangle(cornerRadius: 9, style: .continuous))
        .animation(.easeOut(duration: 0.15), value: isExpanded)
    }
}

// MARK: - Shared components

struct SidebarIconButton: View {
    @Environment(\.themeColors) private var colors
    let systemName: String
    var help: String = ""
    let action: () -> Void
    @State private var isHovered = false

    var body: some View {
        Button(action: action) {
            Image(systemName: systemName)
                .font(.system(size: 16, weight: .regular))
                .foregroundStyle(colors.textSecondary)
                .iconHoverEffect(for: systemName)
                .frame(width: 30, height: 30)
                .background(
                    RoundedRectangle(cornerRadius: 8, style: .continuous)
                        .fill(isHovered ? colors.backgroundHover : .clear)
                )
                .contentShape(Rectangle())
        }
        .buttonStyle(PressableButtonStyle())
        .onHover { isHovered = $0 }
        .help(help)
    }
}

/// Subtle scale-on-press feedback (Emil: buttons must feel responsive).
struct PressableButtonStyle: ButtonStyle {
    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .scaleEffect(configuration.isPressed ? 0.98 : 1.0)
            .animation(.uiEaseOut(duration: 0.12), value: configuration.isPressed)
    }
}
