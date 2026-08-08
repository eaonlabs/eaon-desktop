import SwiftUI

enum SidebarDestination: Hashable {
    /// One of the top-level modes (Chat / Agent) — the conversational
    /// surface, framed for that mode.
    case mode(EaonMode)
    case compare
    case feature(AppFeature)
    case project(UUID)
    /// The settings page. The associated value is an optional deep-link
    /// sub-selection (a provider id, "appearance", etc.) so a caller can
    /// open Settings landed directly on a specific category instead of
    /// General — nil just opens it on the default (General).
    case settings(String?)
}

enum AppFeature: String, Hashable, CaseIterable {
    case projects = "Projects"
    case models = "Models"

    var icon: String {
        switch self {
        case .projects: return "folder"
        case .models: return "cube"
        }
    }

    var blurb: String {
        switch self {
        case .projects: return "Group related chats and files into projects."
        case .models: return "Download open models and run them on this Mac."
        }
    }
}

struct RootView: View {
    @Environment(\.colorScheme) private var systemColorScheme
    @State private var selection: SidebarDestination = .mode(.chat)
    /// One-shot so the app reopens on the mode it was last left in (the
    /// viewModel restores `currentMode` from defaults) without re-forcing
    /// that mode every time this view reappears — e.g. returning from
    /// Projects or Settings must not yank you back to a mode surface.
    @State private var didInitialModeSync = false
    @State private var sidebarCollapsed = false
    /// One-shot, first-launch-only — never re-shown automatically and never
    /// blocks anything; see `OnboardingView`'s own doc.
    @AppStorage("eaon_has_seen_onboarding") private var hasSeenOnboarding = false
    /// One-shot, ever — see `FreeWeekTrialPopup`'s doc. Set alongside
    /// `hasSeenOnboarding` for anyone who just went through onboarding, so
    /// this only actually fires for pre-existing installs.
    @AppStorage("eaon_has_seen_trial_popup") private var hasSeenTrialPopup = false
    @State private var showingTrialPopup = false
    @State private var showingSearchPalette = false
    @State private var conversationPendingDeletion: Conversation?
    @State private var conversationPendingRename: Conversation?
    @State private var showingDeleteAllChats = false
    @State private var showingNewProjectDialog = false
    @State private var projectPendingRename: Project?
    @State private var projectPendingDeletion: Project?
    @State private var chatViewModel = ChatViewModel()
    @AppStorage("nerd_hud_enabled") private var nerdHUDEnabled = false
    /// User-chosen width for the right-side coding workspace panel,
    /// resizable by dragging its leading edge (see `WorkspaceResizeHandle`)
    /// and persisted across launches. Clamped at use, not at save, so a
    /// width chosen on a big display degrades gracefully on a smaller one
    /// instead of permanently shrinking.
    @AppStorage("eaon_workspace_panel_width") private var workspacePanelWidth = 440.0
    @Bindable private var appearance = AppearanceSettings.shared
    @Bindable private var updateChecker = UpdateChecker.shared
    @Bindable private var cliUpdateStore = EaonCLIUpdateStore.shared

    private var resolvedScheme: ColorScheme {
        appearance.theme.colorScheme ?? systemColorScheme
    }

    private var colors: ThemeColors {
        ThemeColors.forScheme(resolvedScheme)
    }

    /// The Settings page keeps its whole navigation (categories, providers)
    /// in the sidebar and has no in-page control to bring it back, so the
    /// sidebar stays pinned open there — collapsing it would strand the user
    /// with no way to switch category or leave.
    private var isInSettings: Bool {
        if case .settings = selection { return true }
        return false
    }

    /// Only for installs that already finished onboarding before this popup
    /// existed (or where onboarding otherwise already handled the offer —
    /// see the `hasSeenTrialPopup` writes alongside every onboarding exit):
    /// no user key saved, and no trial ever started on this device —
    /// matches the exact guard `AquaProviderSettingsView`'s Free Week card
    /// uses to decide it has something to say.
    private var isEligibleForTrialPopup: Bool {
        hasSeenOnboarding
            && !hasSeenTrialPopup
            && !APIKeyStore.hasAPIKey
            && TrialStore.shared.credential == nil
    }

    var body: some View {
        ZStack(alignment: .topLeading) {
            Button("", action: toggleSidebar)
                .keyboardShortcut("\\", modifiers: .command)
                .opacity(0)
                .frame(width: 0, height: 0)

            HStack(spacing: 0) {
                if !sidebarCollapsed {
                    SidebarView(
                        viewModel: chatViewModel,
                        selection: $selection,
                        showingSearchPalette: $showingSearchPalette,
                        onOpenSettings: { selection = .settings(nil) },
                        onCollapse: { toggleSidebar() },
                        onNewChat: { newChat() },
                        onDeleteRequest: { conversationPendingDeletion = $0 },
                        onRenameRequest: { conversationPendingRename = $0 },
                        onDeleteAllRequest: { showingDeleteAllChats = true },
                        onNewProjectRequest: { showingNewProjectDialog = true },
                        onRenameProjectRequest: { projectPendingRename = $0 },
                        onDeleteProjectRequest: { projectPendingDeletion = $0 }
                    )
                    .frame(width: 240)
                    .floatingSidebarPanel(colors: colors)
                    .transition(.move(edge: .leading))
                }

                detailView
                    .background(colors.backgroundPrimary)
            }
            .background(colors.backgroundPrimary)

            if showingSearchPalette {
                SearchPaletteView(
                    isPresented: $showingSearchPalette,
                    viewModel: chatViewModel,
                    onNewChat: { newChat() },
                    onSelect: { id in
                        chatViewModel.selectConversation(id)
                        chatViewModel.enterMode(.chat)
                        selection = .mode(.chat)
                    },
                    onOpenSettings: { selectionId in
                        showingSearchPalette = false
                        selection = .settings(selectionId)
                    }
                )
            }

            if let pending = conversationPendingDeletion {
                DeleteChatDialog(
                    conversation: pending,
                    isPresented: Binding(
                        get: { conversationPendingDeletion != nil },
                        set: { if !$0 { conversationPendingDeletion = nil } }
                    ),
                    onConfirm: {
                        chatViewModel.deleteConversation(pending.id)
                        conversationPendingDeletion = nil
                    }
                )
            }

            if let path = chatViewModel.pendingRunConfirmation {
                RunConfirmationDialog(
                    path: path,
                    onAllow: { chatViewModel.respondToRunConfirmation(allow: true) },
                    onDeny: { chatViewModel.respondToRunConfirmation(allow: false) }
                )
                .zIndex(20)
            }

            if let call = chatViewModel.pendingMCPCallConfirmation {
                MCPCallConfirmationDialog(
                    call: call,
                    onAllow: { chatViewModel.respondToMCPCallConfirmation(allow: true) },
                    onDeny: { chatViewModel.respondToMCPCallConfirmation(allow: false) }
                )
                .zIndex(20)
            }

            if let call = chatViewModel.pendingDesktopCallConfirmation {
                DesktopCallConfirmationDialog(
                    call: call,
                    onAllowOnce: { chatViewModel.respondToDesktopCallConfirmation(.allowOnce) },
                    onAllowAll: { chatViewModel.respondToDesktopCallConfirmation(.allowAll) },
                    onDeny: { chatViewModel.respondToDesktopCallConfirmation(.deny) }
                )
                .zIndex(20)
            }

            if chatViewModel.isAskingToEnterAutoMode {
                AutoModeConfirmationDialog(
                    onConfirm: { chatViewModel.confirmEnterAutoMode() },
                    onCancel: { chatViewModel.cancelEnterAutoMode() }
                )
                .zIndex(20)
            }

            if let question = chatViewModel.pendingAgentQuestion {
                AskUserQuestions(
                    flow: question,
                    onComplete: { chatViewModel.answerAgentQuestion($0) }
                )
                .zIndex(20)
            }

            if let pending = conversationPendingRename {
                RenameChatDialog(
                    conversation: pending,
                    isPresented: Binding(
                        get: { conversationPendingRename != nil },
                        set: { if !$0 { conversationPendingRename = nil } }
                    ),
                    onConfirm: { newTitle in
                        chatViewModel.renameConversation(pending.id, to: newTitle)
                        conversationPendingRename = nil
                    }
                )
            }

            if showingDeleteAllChats {
                DeleteAllChatsDialog(
                    isPresented: $showingDeleteAllChats,
                    onConfirm: {
                        chatViewModel.deleteAllUnfiledConversations()
                        showingDeleteAllChats = false
                    }
                )
            }

            if showingNewProjectDialog {
                NewProjectDialog(isPresented: $showingNewProjectDialog) { name in
                    let project = chatViewModel.createProject(name: name)
                    selection = .project(project.id)
                }
            }

            if let project = projectPendingRename {
                RenameProjectDialog(
                    project: project,
                    isPresented: Binding(
                        get: { projectPendingRename != nil },
                        set: { if !$0 { projectPendingRename = nil } }
                    ),
                    onConfirm: { newName in
                        chatViewModel.renameProject(project.id, to: newName)
                        projectPendingRename = nil
                    }
                )
            }

            if let project = projectPendingDeletion {
                DeleteProjectDialog(
                    project: project,
                    isPresented: Binding(
                        get: { projectPendingDeletion != nil },
                        set: { if !$0 { projectPendingDeletion = nil } }
                    ),
                    onConfirm: {
                        chatViewModel.deleteProject(project.id)
                        if case .project(let openId) = selection, openId == project.id {
                            selection = .feature(.projects)
                        }
                        projectPendingDeletion = nil
                    }
                )
            }

            if nerdHUDEnabled {
                hudOverlay
            }

            if !hasSeenOnboarding {
                OnboardingView(
                    onOpenModels: {
                        selection = .feature(.models)
                        hasSeenOnboarding = true
                        hasSeenTrialPopup = true
                    },
                    onOpenProviderSettings: {
                        selection = .settings("aqua")
                        hasSeenOnboarding = true
                        hasSeenTrialPopup = true
                    },
                    onFinish: {
                        hasSeenOnboarding = true
                        hasSeenTrialPopup = true
                    },
                    onTrialStarted: {
                        hasSeenOnboarding = true
                        hasSeenTrialPopup = true
                        // Refetch through the trial gateway so the picker
                        // shows exactly the models the free week can run.
                        Task { await chatViewModel.fetchModels() }
                    }
                )
                .zIndex(30)
            }

            if showingTrialPopup {
                FreeWeekTrialPopup(
                    onStarted: {
                        hasSeenTrialPopup = true
                        showingTrialPopup = false
                        Task { await chatViewModel.fetchModels() }
                    },
                    onDismiss: {
                        hasSeenTrialPopup = true
                        showingTrialPopup = false
                    }
                )
                .zIndex(25)
            }

            if updateChecker.available != nil || cliUpdateStore.available != nil {
                VStack {
                    Spacer()
                    HStack {
                        Spacer()
                        // Stacked, not side-by-side — the rare case both are
                        // pending at once shouldn't force the window wider.
                        VStack(alignment: .trailing, spacing: 14) {
                            if let cliVersion = cliUpdateStore.available {
                                EaonCLIUpdateBanner(version: cliVersion)
                            }
                            if let manifest = updateChecker.available {
                                UpdateBanner(manifest: manifest)
                            }
                        }
                        .padding(20)
                    }
                }
                .frame(maxWidth: .infinity, maxHeight: .infinity)
                .transition(.move(edge: .bottom).combined(with: .opacity))
                .zIndex(5)
            }

        }
        // Extend content up under the transparent title bar so the sidebar
        // card reaches the very top of the window and the traffic lights sit
        // on top of it (rather than in a reserved strip above the content).
        .ignoresSafeArea(.container, edges: .top)
        .environment(\.themeColors, colors)
        .preferredColorScheme(appearance.colorScheme)
        .tint(appearance.accentColor)
        .onAppear {
            // Gives the floating desktop assistant the app's one real
            // ChatViewModel — same live model list/selection, no duplicated
            // fetch. Set unconditionally (unlike the mode-sync below): safe
            // to repeat, and must survive if RootView is ever recreated.
            QuickAssistantViewModel.shared.chatViewModel = chatViewModel
            guard !didInitialModeSync else { return }
            didInitialModeSync = true
            // Pull down anything made on another machine — at most once a
            // day (see `autoImportIfDue`), and a no-op when sync is off or
            // the vault is locked. Delayed so it never competes with launch:
            // the import merges into `conversations`, and doing that while
            // the sidebar is still building its first layout is a visible
            // stutter for no benefit. Silent by design — the user didn't ask
            // for it, so it must not interrupt them; Settings → Cloud Sync
            // reports what actually happened.
            DispatchQueue.main.asyncAfter(deadline: .now() + 2.0) {
                Task { @MainActor in
                    await CloudSyncEngine.shared.autoImportIfDue(into: chatViewModel)
                }
            }
            selection = .mode(chatViewModel.currentMode)
            if isEligibleForTrialPopup {
                // A short delay so this doesn't compete with the window's
                // own opening animation — it should feel like a beat after
                // launch, not part of it.
                DispatchQueue.main.asyncAfter(deadline: .now() + 1.2) {
                    if isEligibleForTrialPopup { showingTrialPopup = true }
                }
            }
        }
        // Settings pins the sidebar open (see `isInSettings`). If it's
        // reached while the sidebar is already collapsed — e.g. from ⌘K or a
        // provider gear in a collapsed-sidebar chat — bring it back so the
        // user isn't dropped into Settings with no navigation and no exit.
        .onChange(of: selection) { _, newValue in
            if case .settings = newValue, sidebarCollapsed {
                withAnimation(.linear(duration: 0.2)) { sidebarCollapsed = false }
            }
        }
        // Drive the desktop pet off the visible conversation's generation
        // lifecycle: it reacts to the tone of what the user just said,
        // drifts to a new spot and works while a reply streams, reacts to
        // the reply's own tone when it lands (wink by default), and wears
        // the error face when a run fails. No-op unless the pet is enabled.
        .onChange(of: chatViewModel.isGenerating) { wasGenerating, isGenerating in
            if isGenerating {
                if let userText = chatViewModel.messages.last(where: { $0.isUser })?.content {
                    EaonPetController.shared.reactToUserMessage(userText)
                }
                EaonPetController.shared.noteGenerationStarted()
            } else if wasGenerating {
                let hadError = chatViewModel.messages.last?.isError == true
                let reply = chatViewModel.messages.last(where: { !$0.isUser && $0.isToolResult != true && !$0.isError })?.content
                EaonPetController.shared.noteGenerationEnded(hadError: hadError, replyText: hadError ? nil : reply)
            }
        }
    }

    @ViewBuilder
    private var detailView: some View {
        Group {
            switch selection {
            case .mode(.chat), .mode(.agent):
                // Chat and the sandboxed coding Agent share the conversational
                // surface; the coding workspace slides in on the right when
                // the model creates files (most relevant in Agent mode).
                let mode: EaonMode = { if case .mode(let m) = selection { return m } else { return .chat } }()
                GeometryReader { geo in
                    HStack(spacing: 0) {
                        ChatHomeView(
                            viewModel: chatViewModel,
                            isSidebarCollapsed: sidebarCollapsed,
                            onExpandSidebar: { toggleSidebar() },
                            onOpenProviderSettings: { selectionId in
                                selection = .settings(selectionId)
                            },
                            mode: mode,
                            onModeChange: switchMode
                        )
                        if chatViewModel.isWorkspaceOpen {
                            let panelWidth = Self.clampedWorkspaceWidth(workspacePanelWidth, available: geo.size.width)
                            CodeWorkspacePanel(viewModel: chatViewModel)
                                .frame(width: panelWidth)
                                .floatingWorkspacePanel(colors: colors)
                                .overlay(alignment: .leading) {
                                    WorkspaceResizeHandle(
                                        width: $workspacePanelWidth,
                                        currentWidth: panelWidth,
                                        available: geo.size.width
                                    )
                                }
                                .transition(.move(edge: .trailing))
                        }
                    }
                }
            case .mode(.code):
                EaonCodeHomeView(
                    isSidebarCollapsed: sidebarCollapsed,
                    onExpandSidebar: { toggleSidebar() },
                    onExit: {
                        chatViewModel.enterMode(.chat)
                        switchMode(.chat)
                    }
                )
            case .settings(let initialId):
                // `.id` keyed on the deep-link target so opening Settings on
                // a *specific* category (a provider gear, search palette,
                // onboarding) rebuilds with that as its landing selection,
                // instead of reusing a prior instance still sitting on
                // General. Plain "open Settings" is .settings(nil) → General.
                SettingsRootView(
                    chatViewModel: chatViewModel,
                    initialSelectionId: initialId,
                    onExit: { selection = .mode(chatViewModel.currentMode) }
                )
                .id(initialId ?? "general")
            case .compare:
                ModelCompareView(availableModels: chatViewModel.aquaOnlyChatModels)
            case .feature(.projects):
                ProjectsView(
                    viewModel: chatViewModel,
                    onOpenProject: { selection = .project($0) },
                    onNewProjectRequest: { showingNewProjectDialog = true },
                    onRenameRequest: { projectPendingRename = $0 },
                    onDeleteRequest: { projectPendingDeletion = $0 }
                )
            case .feature(.models):
                ModelLibraryView(chatViewModel: chatViewModel) { modelId in
                    chatViewModel.startNewChat()
                    chatViewModel.selectModel(modelId)
                    chatViewModel.enterMode(.chat)
                    selection = .mode(.chat)
                }
            case .project(let id):
                if let project = chatViewModel.projects.first(where: { $0.id == id }) {
                    ProjectDetailScreen(
                        viewModel: chatViewModel,
                        project: project,
                        onBack: { selection = .feature(.projects) },
                        onOpenChat: { chatViewModel.enterMode(.chat); selection = .mode(.chat) },
                        onRenameRequest: { projectPendingRename = $0 },
                        onDeleteRequest: { projectPendingDeletion = $0 }
                    )
                } else {
                    // Deleted from elsewhere (e.g. context menu while it was
                    // open) — fall back to the projects list rather than a
                    // dead detail screen for a folder that no longer exists.
                    ProjectsView(
                        viewModel: chatViewModel,
                        onOpenProject: { selection = .project($0) },
                        onNewProjectRequest: { showingNewProjectDialog = true },
                        onRenameRequest: { projectPendingRename = $0 },
                        onDeleteRequest: { projectPendingDeletion = $0 }
                    )
                }
            case .feature(let feature):
                FeaturePlaceholderView(feature: feature)
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }

    /// The workspace panel's usable width band: never narrower than 340
    /// (the explorer + editor stop being usable below that), never so wide
    /// the chat column drops under ~420 (the composer and message bubbles
    /// need real room). Applied to whatever width the user last dragged,
    /// so shrinking the window squeezes the panel rather than the chat.
    static func clampedWorkspaceWidth(_ requested: Double, available: CGFloat) -> CGFloat {
        let maxWidth = max(340, Double(available) - 420)
        return CGFloat(min(max(requested, 340), maxWidth))
    }

    private func toggleSidebar() {
        // Refuse to collapse while Settings is showing — see `isInSettings`.
        // Expanding is always allowed (a collapsed sidebar + Settings, e.g.
        // reached via ⌘K, still needs a way back open).
        if isInSettings, !sidebarCollapsed { return }
        withAnimation(.linear(duration: 0.2)) {
            sidebarCollapsed.toggle()
        }
    }

    private func newChat() {
        chatViewModel.startNewChat()
        // Keep whatever mode the user is in — a new chat inside Agent mode
        // should stay Agent mode, not drop back to plain Chat.
        selection = .mode(chatViewModel.currentMode)
    }

    /// The mode switcher (composer bar) only has a view onto
    /// `viewModel.currentMode` — it can't see
    /// `selection`, which is what actually decides which top-level view this
    /// window shows. This is the one place that keeps both in sync.
    private func switchMode(_ mode: EaonMode) {
        selection = .mode(mode)
    }

    private var hudOverlay: some View {
        let pos = appearance.notificationPosition
        return VStack {
            if pos == .bottomRight || pos == .bottomLeft { Spacer() }
            HStack {
                if pos == .topRight || pos == .bottomRight { Spacer() }
                StatisticsHUDView(chatViewModel: chatViewModel)
                    .padding(12)
                if pos == .topLeft || pos == .bottomLeft { Spacer() }
            }
            if pos == .topRight || pos == .topLeft { Spacer() }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .allowsHitTesting(false)
    }
}

/// The invisible grab strip on the workspace panel's leading edge — drag
/// to resize, the standard macOS split-view affordance. Sits in the gutter
/// between the chat column and the floating panel card (the overlay is
/// applied after the card's outer padding), showing a small grip bar on
/// hover so the affordance is discoverable without adding permanent chrome.
private struct WorkspaceResizeHandle: View {
    @Environment(\.themeColors) private var colors
    /// The persisted width preference this drag writes through to.
    @Binding var width: Double
    /// The width actually on screen right now (post-clamp) — the drag's
    /// base, so grabbing a panel that was clamped smaller than its saved
    /// preference doesn't jump to the stale saved value on the first tick.
    let currentWidth: CGFloat
    let available: CGFloat

    @State private var dragBaseWidth: CGFloat?
    @State private var isHovering = false

    var body: some View {
        Rectangle()
            .fill(Color.clear)
            .frame(width: 11)
            .overlay {
                if isHovering || dragBaseWidth != nil {
                    RoundedRectangle(cornerRadius: 2)
                        .fill(colors.borderMedium)
                        .frame(width: 3, height: 44)
                }
            }
            .contentShape(Rectangle())
            .onHover { hovering in
                isHovering = hovering
                if hovering { NSCursor.resizeLeftRight.push() } else { NSCursor.pop() }
            }
            .gesture(
                DragGesture(minimumDistance: 1, coordinateSpace: .global)
                    .onChanged { value in
                        let base = dragBaseWidth ?? currentWidth
                        if dragBaseWidth == nil { dragBaseWidth = currentWidth }
                        // The panel hangs off the RIGHT edge, so dragging its
                        // leading handle left (negative translation) widens it.
                        let proposed = Double(base - value.translation.width)
                        width = min(max(proposed, 340), max(340, Double(available) - 420))
                    }
                    .onEnded { _ in dragBaseWidth = nil }
            )
    }
}

private extension View {
    /// The sidebar's floating-card treatment — inset on all sides with a
    /// flat hairline and a restrained shadow, so it reads as a raised panel
    /// without the gloss of a gradient sheen or a heavy multi-layer shadow.
    /// 16px matches the radius already used for the app's other large panels
    /// (Settings, Search) — smaller confirmation dialogs go a bit rounder
    /// (20px) since a big panel needs a proportionally tighter curve to
    /// avoid looking like a rounded blob. A small, even inset on every side
    /// (including the top) lets the rounded corners breathe against the
    /// window edge rather than getting clipped by it; the traffic lights are
    /// nudged inward (see WindowChrome) so they still land on the card.
    func floatingSidebarPanel(colors: ThemeColors) -> some View {
        self
            .background(colors.backgroundSidebar)
            .clipShape(RoundedRectangle(cornerRadius: 16, style: .continuous))
            .overlay(
                RoundedRectangle(cornerRadius: 16, style: .continuous)
                    .stroke(colors.borderSubtle, lineWidth: 1)
            )
            .shadow(color: .black.opacity(0.18), radius: 12, x: 0, y: 4)
            .padding(.top, 10)
            .padding(.bottom, 9)
            .padding(.leading, 9)
            .padding(.trailing, 6)
    }

    /// The workspace panel's mirror-image of the sidebar card, so the window
    /// reads as chat flanked by two matching floating panels.
    func floatingWorkspacePanel(colors: ThemeColors) -> some View {
        self
            .background(colors.backgroundSidebar)
            .clipShape(RoundedRectangle(cornerRadius: 16, style: .continuous))
            .overlay(
                RoundedRectangle(cornerRadius: 16, style: .continuous)
                    .stroke(colors.borderSubtle, lineWidth: 1)
            )
            .shadow(color: .black.opacity(0.18), radius: 12, x: 0, y: 4)
            .padding(.top, 10)
            .padding(.bottom, 9)
            .padding(.leading, 3)
            .padding(.trailing, 9)
    }
}
