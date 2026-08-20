import AppKit
import SwiftUI
import UniformTypeIdentifiers

private let conversationMaxWidth: CGFloat = 768

struct ChatHomeView: View {
    @Environment(\.themeColors) private var colors
    @Bindable var viewModel: ChatViewModel
    /// Read here (not just inside `MessageCell`) so a change to font size or
    /// the colored-user-bubble/accent-color settings actually reaches
    /// already-rendered rows — see `MessageCell`'s own doc on why an
    /// `Equatable`-gated view can't discover an external dependency it
    /// didn't have a chance to re-read.
    @Bindable private var appearance = AppearanceSettings.shared
    /// Whether the sidebar is currently hidden — with no rail left reserving
    /// space in that corner, the top bar itself has to clear the traffic
    /// lights and offer a way to bring the sidebar back.
    var isSidebarCollapsed: Bool = false
    var onExpandSidebar: () -> Void = {}
    /// Lets the model picker's per-provider gear icon open Settings landed
    /// directly on that provider's own page.
    var onOpenProviderSettings: (String) -> Void = { _ in }
    /// The active mode — only used here to frame the empty state (heading +
    /// blurb) so each mode reads as its own place. The conversational surface
    /// itself is identical across Chat/Agent/Eaon Claw.
    var mode: EaonMode = .chat
    /// Forwarded to the composer's mode switcher — see `ChatComposer.onModeChange`.
    var onModeChange: (EaonMode) -> Void = { _ in }

    @State private var showingShareSheet = false
    /// True while the bottom of the conversation is visible (or close to
    /// it) — the only state in which new content should auto-scroll into
    /// view. Set from `BottomAnchorOffsetKey`'s live measurement, not from
    /// gesture detection, so it reflects where the content actually is
    /// regardless of whether the user got there by trackpad scroll, a
    /// drag, or a keyboard shortcut. Starts true so a freshly opened chat
    /// still lands at the bottom.
    @State private var isNearBottom = true
    /// Token for the local scroll-wheel monitor installed while the
    /// conversation is on screen — see `installScrollIntentMonitor`.
    @State private var scrollIntentMonitor: Any?

    /// Measured frames for the two places the mascot can be, in
    /// `mascotSpace` — see `EaonMascotAnchorKey`.
    @State private var mascotAnchors: [String: CGRect] = [:]
    /// False while it's still standing in the hero slot; true once it has
    /// gone to sit on the composer.
    @State private var mascotPerched = false

    private static let mascotSpace = "eaonMascotSpace"
    /// One spring for every part of the move — the sprite's travel, its
    /// shrink, and the hero slot closing behind it — so they read as a
    /// single event. Slow for UI (0.75s) on purpose: this is a character
    /// crossing the screen, not a control responding to a click, and the
    /// whole point is that you notice it go.
    private static let mascotFlight: Animation = .spring(duration: 0.75, bounce: 0.28)
    private static let heroAnchorName = "hero"
    private static let perchAnchorName = "perch"

    var body: some View {
        VStack(spacing: 0) {
            topBar

            if mode == .agent, !DesktopControlStore.shared.isEnabled {
                DeviceControlOptInHint { onOpenProviderSettings("computer") }
            }

            if viewModel.messages.isEmpty {
                emptyState
            } else {
                conversation
            }
        }
        .background(colors.backgroundPrimary)
        .overlay {
            if showingShareSheet, let conversation = currentConversation {
                ShareChatSheet(conversation: conversation, isPresented: $showingShareSheet)
            }
        }
    }

    private var currentConversation: Conversation? {
        Conversation(
            title: viewModel.conversations.first { $0.id == viewModel.currentConversationId }?.title ?? "New chat",
            messages: viewModel.messages
        )
    }

    // MARK: - Top bar

    private var topBar: some View {
        HStack(spacing: 8) {
            if isSidebarCollapsed {
                // Clears the traffic lights — with the sidebar hidden there's
                // no rail reserving this corner for them anymore, so the top
                // bar has to leave the room itself instead of sitting under
                // them. Also the only way back to the full sidebar now that
                // there's no persistent rail icon for it.
                Spacer().frame(width: 80)
                TopBarIconButton(systemName: "sidebar.left", label: nil) {
                    onExpandSidebar()
                }
                .help("Show sidebar")
            }

            // Leading, right next to the sidebar's edge — not centered.
            ModelPickerMenu(viewModel: viewModel, onOpenProviderSettings: onOpenProviderSettings)

            if !viewModel.messages.isEmpty { ContextUsageBadge(viewModel: viewModel) }

            Spacer(minLength: 0)

            // Reopen the coding workspace when this chat has files but the
            // panel was closed.
            if !viewModel.workspaceFiles.isEmpty {
                TopBarIconButton(systemName: "chevron.left.forwardslash.chevron.right", label: nil) {
                    if viewModel.isWorkspaceOpen {
                        viewModel.closeWorkspace()
                    } else {
                        viewModel.openWorkspace()
                    }
                }
            }

            if !viewModel.messages.isEmpty {
                TopBarIconButton(systemName: "square.and.arrow.up", label: nil) {
                    showingShareSheet = true
                }
            }
        }
        // The mode switcher deliberately isn't here: it lives at the top of
        // the sidebar (see `SidebarView`), above New Chat, where it reads as
        // the header of the whole left column rather than as one more button
        // competing with the model picker and the share/workspace icons.
        .padding(.horizontal, 14)
        .frame(height: 50)
        // Match the sidebar card's 10pt top inset so the picker sits on the
        // same line as the traffic lights / sidebar header controls.
        .padding(.top, 10)
    }

    // MARK: - Empty state

    private var emptyState: some View {
        ZStack(alignment: .topLeading) {
            emptyStateContent

            // The mascot itself is drawn here rather than in either slot, so
            // one continuous sprite travels between them — two separate
            // views swapping would read as "one vanished, another appeared"
            // instead of "it got up and went to sit down".
            if mode == .agent,
               let target = mascotAnchors[mascotPerched ? Self.perchAnchorName : Self.heroAnchorName] {
                EaonMascotView(pixelSize: EaonMascot.heroPixelSize)
                    .scaleEffect(mascotPerched ? EaonMascot.perchedScale : 1)
                    .position(x: target.midX, y: target.midY)
                    // Purely decorative, and it sits over the composer's top
                    // edge — it must never eat a click meant for the box.
                    .allowsHitTesting(false)
                    .animation(Self.mascotFlight, value: mascotPerched)
            }
        }
        .coordinateSpace(name: Self.mascotSpace)
        .onPreferenceChange(EaonMascotAnchorKey.self) { mascotAnchors = $0 }
        .task(id: mode) {
            guard mode == .agent, !mascotPerched else { return }
            try? await Task.sleep(for: EaonMascot.perchDelay)
            guard !Task.isCancelled else { return }
            mascotPerched = true
        }
        // Typing is the moment the hero slot stops being welcome — get out
        // of the way immediately rather than waiting out the timer.
        .onChange(of: viewModel.inputText) { _, newValue in
            if !newValue.isEmpty { mascotPerched = true }
        }
    }

    private var emptyStateContent: some View {
        VStack(spacing: 0) {
            Spacer()

            if mode == .chat {
                // Jan's hero, matched exactly: its `--text-3xl` is
                // `calc(--font-size-base * 1.875)` = 30px at the 16px base,
                // with `--text-3xl--line-height: 1.2`, set semibold rather
                // than bold. Eaon's old 34pt bold read a size heavier and
                // sat closer to a marketing headline than an empty state.
                Text("How can I help you today?")
                    .font(AppFont.sans(30, weight: .semibold))
                    .lineSpacing(30 * 0.2)
                    .foregroundStyle(colors.textPrimary)
                    .padding(.bottom, 26)
            } else {
                VStack(spacing: 8) {
                    // Work gets the mascot; other modes keep their symbol.
                    // A character above "what can I do for you" says
                    // "something lives here and works for you" in a way no
                    // SF Symbol hammer can.
                    //
                    // Only the SLOT lives here — the sprite is drawn by the
                    // ZStack above. The slot keeps its full height even once
                    // the mascot has left, so the title doesn't jump up the
                    // screen the moment it goes to sit down.
                    if mode == .agent {
                        // The slot closes up once the mascot has left, so the
                        // page doesn't keep a mascot-shaped hole above the
                        // title forever. It animates with the same spring as
                        // the flight, so the title rising and the mascot
                        // leaving are visibly one movement.
                        Color.clear
                            .frame(
                                width: EaonMascot.heroSize.width,
                                height: mascotPerched ? 0 : EaonMascot.heroSize.height
                            )
                            .eaonMascotAnchor(Self.heroAnchorName, space: Self.mascotSpace)
                            .padding(.bottom, mascotPerched ? 0 : 4)
                            .animation(Self.mascotFlight, value: mascotPerched)
                    } else {
                        Image(systemName: mode.icon)
                            .font(.system(size: 30, weight: .semibold))
                            .foregroundStyle(colors.textSecondary)
                    }
                    Text(mode.title)
                        .font(AppFont.mono(30, weight: .bold))
                        .foregroundStyle(colors.textPrimary)
                    Text(mode.blurb)
                        .font(AppFont.sans(12))
                        .foregroundStyle(colors.textTertiary)
                        .multilineTextAlignment(.center)
                        // Capped and allowed to wrap. Unconstrained, a long
                        // blurb stretched the full window width as a single
                        // line, which on a wide display read as a banner
                        // rather than a caption under the title.
                        .frame(maxWidth: 440)
                        .fixedSize(horizontal: false, vertical: true)
                }
                .padding(.bottom, 26)
            }

            if mode == .agent {
                WorkContextBar { viewModel.startNewChat() }
                    .frame(maxWidth: conversationMaxWidth, alignment: .leading)
                    .padding(.horizontal, 24)
                    .padding(.bottom, 8)
            }

            ChatComposer(viewModel: viewModel, onModeChange: onModeChange)
                .frame(maxWidth: conversationMaxWidth)
                .padding(.horizontal, 24)
                .overlay(alignment: .topTrailing) { perchAnchor }

            // No recent-chats list under the composer. Jan's empty state is
            // the question and the box, nothing else — the sidebar is
            // already a complete, always-visible list of the same chats, so
            // repeating a slice of it here competes with the one thing the
            // screen is asking you to do.
            Spacer()
            Spacer()
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }

    /// Where the mascot ends up: perched on the composer's top-right corner,
    /// feet overlapping the border so it reads as sitting ON the box rather
    /// than floating above it. Inset from the corner because the composer is
    /// heavily rounded there — sat right on the curve it would look like it
    /// was sliding off.
    /// What's shown between the last message and the composer while the
    /// assistant is working.
    ///
    /// Pulled out of the transcript's `VStack` because the type checker was
    /// starting to time out on that expression — a `ForEach` plus a
    /// three-branch chain of differently-typed views in one builder is a lot
    /// of overload resolution, and it fails as a hard build error rather
    /// than a warning once it tips over.
    @ViewBuilder
    private var activityIndicator: some View {
        // A running swarm gets the full discussion panel; everything else
        // keeps the lighter indicator. Showing both would be redundant: the
        // panel carries the status line itself.
        if let swarm = viewModel.liveSwarmTranscript, !swarm.personas.isEmpty {
            SwarmLivePanel(transcript: swarm, statusText: viewModel.agentActivityText)
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(.top, 6)
                .transition(.opacity)
        } else if let activityText = viewModel.agentActivityText {
            ThinkingIndicator(statusText: activityText)
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(.top, 6)
                .transition(.opacity)
        }
    }

    private var perchAnchor: some View {
        Color.clear
            .frame(width: EaonMascot.perchedSize.width, height: EaonMascot.perchedSize.height)
            .offset(x: -46, y: -EaonMascot.perchedSize.height + 4)
            .eaonMascotAnchor(Self.perchAnchorName, space: Self.mascotSpace)
    }

    // MARK: - Empty-state recents

    /// The most recent chats, so a fresh window offers somewhere to go back
    /// to instead of a blank void — tapping one opens it.
    private var emptyStateRecents: some View {
        VStack(alignment: .leading, spacing: 4) {
            Text("RECENT")
                .font(AppFont.mono(10, weight: .semibold))
                .tracking(0.6)
                .foregroundStyle(colors.textTertiary)
                .padding(.leading, 4)
                .padding(.bottom, 2)
            ForEach(recentConversations) { conversation in
                Button {
                    viewModel.selectConversation(conversation.id)
                } label: {
                    HStack(spacing: 11) {
                        Image(systemName: "clock.arrow.circlepath")
                            .font(.system(size: 12))
                            .foregroundStyle(colors.textTertiary)
                            .frame(width: 26, height: 26)
                            .background(Circle().fill(colors.backgroundChip.opacity(0.6)))
                        Text(conversation.title)
                            .font(AppFont.sans(14))
                            .foregroundStyle(colors.textPrimary.opacity(0.85))
                            .lineLimit(1)
                        Spacer(minLength: 8)
                        Text(Self.relativeTime(conversation.updatedAt))
                            .font(AppFont.mono(10))
                            .foregroundStyle(colors.textTertiary)
                        Image(systemName: "chevron.right")
                            .font(.system(size: 10, weight: .semibold))
                            .foregroundStyle(colors.textTertiary.opacity(0.7))
                    }
                    .padding(.horizontal, 12)
                    .padding(.vertical, 8)
                    .contentShape(Rectangle())
                }
                .buttonStyle(EmptyStateRowButtonStyle())
                .help("Open this chat")
            }
        }
    }

    /// A short "2h ago" / "3d ago" for a recent chat's last activity —
    /// concrete without cluttering the row with a full timestamp.
    private static func relativeTime(_ date: Date) -> String {
        let seconds = Date().timeIntervalSince(date)
        if seconds < 60 { return "just now" }
        if seconds < 3600 { return "\(Int(seconds / 60))m ago" }
        if seconds < 86_400 { return "\(Int(seconds / 3600))h ago" }
        if seconds < 604_800 { return "\(Int(seconds / 86_400))d ago" }
        let weeks = Int(seconds / 604_800)
        return weeks < 5 ? "\(weeks)w ago" : "\(Int(seconds / 2_629_800))mo ago"
    }

    /// The three most recently updated non-empty chats, excluding whatever's
    /// open now — a quick way back into real work from a fresh window.
    private var recentConversations: [Conversation] {
        // Scoped like every other list — Work's empty state offers Work
        // sessions to return to, not the last thing you asked in Chat.
        viewModel.conversationsInCurrentScope
            .filter { !$0.messages.isEmpty && $0.id != viewModel.currentConversationId }
            .sorted { $0.updatedAt > $1.updatedAt }
            .prefix(3)
            .map { $0 }
    }

    // MARK: - Conversation

    private var conversation: some View {
        VStack(spacing: 0) {
            ScrollViewReader { proxy in
                ZStack(alignment: .bottomTrailing) {
                    GeometryReader { viewportGeo in
                        ScrollView {
                            // Spacing is 0 on the stack itself and applied
                            // per-row instead — full space before a
                            // genuinely new turn (a user message, or the
                            // first assistant-side reply to one), tight
                            // space between a turn's own internal steps
                            // (tool-call chip → tool-result card →
                            // continuation text), so a multi-step reply
                            // reads as one continuous answer instead of
                            // several separate messages.
                            LazyVStack(spacing: 0) {
                                ForEach(Array(viewModel.messages.enumerated()), id: \.element.id) { index, message in
                                    messageRow(index: index, message: message)
                                }
                                activityIndicator
                                // Reports its own position back up via
                                // `BottomAnchorOffsetKey` so `isNearBottom`
                                // reflects where the content actually is —
                                // see that key's own doc for why this beats
                                // inferring "the user scrolled" from a
                                // gesture instead.
                                Color.clear
                                    .frame(height: 8)
                                    .id(bottomAnchor)
                                    .background(
                                        GeometryReader { anchorGeo in
                                            Color.clear.preference(
                                                key: BottomAnchorOffsetKey.self,
                                                value: anchorGeo.frame(in: .named(Self.scrollCoordinateSpace)).maxY
                                            )
                                        }
                                    )
                            }
                            .animation(.easeOut(duration: 0.15), value: viewModel.agentActivityText)
                            // Remarks arrive without the status line
                            // necessarily changing, so the panel needs its
                            // own trigger or new rows would pop in unanimated.
                            .animation(.easeOut(duration: 0.15), value: viewModel.liveSwarmTranscript?.remarks.count)
                            .frame(maxWidth: conversationMaxWidth)
                            .frame(maxWidth: .infinity)
                            .padding(.horizontal, 24)
                            .padding(.top, 12)
                            .padding(.bottom, 12)
                        }
                        .coordinateSpace(name: Self.scrollCoordinateSpace)
                        .onPreferenceChange(BottomAnchorOffsetKey.self) { anchorMaxY in
                            // 60pt of slack so settling scroll physics (or
                            // the anchor's own 8pt height) don't flicker
                            // the jump-to-bottom button right at the edge.
                            // Diff-guarded write inside an explicit
                            // withAnimation: this preference fires on every
                            // layout tick, and an always-on `.animation(value:)`
                            // over the whole ZStack (the previous design)
                            // kept an animation context alive continuously.
                            let near = anchorMaxY <= viewportGeo.size.height + 60
                            if near != isNearBottom {
                                withAnimation(.easeOut(duration: 0.15)) { isNearBottom = near }
                            }
                        }
                    }
                    // A message the user just sent is an explicit "show me
                    // what happens next" — always follow, and re-arm
                    // following for the rest of that turn even if they'd
                    // scrolled away during a previous one. Every other
                    // change (a tool-call chip, a tool-result card, the
                    // next step's bubble, streamed content) is the agent
                    // loop's own bookkeeping mid-turn and follows only
                    // while the user hasn't deliberately scrolled up to
                    // read something — the entire point of this feature.
                    //
                    // Content ticks follow WITHOUT animation: the typewriter
                    // fires these up to ~250×/s, and a 200ms eased scrollTo
                    // per tick meant overlapping animations fighting each
                    // other — and, worse, a user's upward flick happening
                    // MID-animation kept measuring as "still near bottom,"
                    // so following re-captured them before they could
                    // escape (the reported "I can't scroll up while it's
                    // responding"). Instant jumps track the growing content
                    // just as well with none of that.
                    .onChange(of: viewModel.messages.last?.content) { _, _ in
                        if isNearBottom { scrollToBottom(proxy, animated: false) }
                    }
                    .onChange(of: viewModel.messages.count) { oldCount, newCount in
                        if newCount > oldCount, viewModel.messages.last?.isUser == true {
                            isNearBottom = true
                            scrollToBottom(proxy)
                        } else if isNearBottom {
                            scrollToBottom(proxy, animated: false)
                        }
                    }
                    .onChange(of: viewModel.agentActivityText) { _, _ in
                        if isNearBottom { scrollToBottom(proxy, animated: false) }
                    }
                    // A different conversation entirely (switched in the
                    // sidebar, or a fresh new chat) — never inherit
                    // whatever scroll state the previous conversation left
                    // behind; always open at its own bottom.
                    .onChange(of: viewModel.currentConversationId) { _, _ in
                        isNearBottom = true
                        scrollToBottom(proxy, animated: false)
                    }
                    .onAppear {
                        scrollToBottom(proxy, animated: false)
                        installScrollIntentMonitor()
                    }
                    .onDisappear { removeScrollIntentMonitor() }

                    if !isNearBottom {
                        JumpToBottomButton {
                            withAnimation(.easeOut(duration: 0.15)) { isNearBottom = true }
                            scrollToBottom(proxy)
                        }
                        .padding(.trailing, 24)
                        .padding(.bottom, 16)
                        .transition(.opacity.combined(with: .scale(scale: 0.85, anchor: .bottomTrailing)))
                    }
                }
            }

            VStack(spacing: 6) {
                // Stays visible mid-conversation: which folder the agent is
                // editing is exactly the thing you want to be able to check
                // at turn twelve, not only at turn one.
                if mode == .agent {
                    let plan = AgentPlanStore.shared.steps(for: viewModel.currentConversationId)
                    if !plan.isEmpty {
                        AgentPlanCard(steps: plan)
                            .frame(maxWidth: conversationMaxWidth, alignment: .leading)
                    }

                    WorkContextBar { viewModel.startNewChat() }
                        .frame(maxWidth: conversationMaxWidth, alignment: .leading)
                }

                ChatComposer(viewModel: viewModel, onModeChange: onModeChange)
                    .frame(maxWidth: conversationMaxWidth)
                    // Once a conversation is underway there's no hero slot to
                    // fly from, so it's simply already sitting there — the
                    // same spot it landed in on the empty state, so it reads
                    // as the same character staying put rather than a new
                    // decoration appearing.
                    .overlay(alignment: .topTrailing) {
                        if mode == .agent {
                            EaonMascotView(pixelSize: EaonMascot.heroPixelSize)
                                .scaleEffect(EaonMascot.perchedScale)
                                .frame(
                                    width: EaonMascot.perchedSize.width,
                                    height: EaonMascot.perchedSize.height
                                )
                                .offset(x: -46, y: -EaonMascot.perchedSize.height + 4)
                                .allowsHitTesting(false)
                        }
                    }

                Text("Eaon can make mistakes. Check important info.")
                    .font(AppFont.sans(12))
                    .foregroundStyle(colors.textTertiary)
                    .padding(.bottom, 8)
            }
            .padding(.horizontal, 24)
            .padding(.top, 4)
            .background(colors.backgroundPrimary)
        }
    }

    private let bottomAnchor = "aqua-bottom-anchor"
    private static let scrollCoordinateSpace = "aqua-chat-scroll"

    // Named rather than left inline in `conversation`'s `ForEach` — a
    // `MessageCell` call carrying this many parameters, inside a closure
    // with a computed `id:`, previously tipped SwiftUI's view-builder
    // type-checker into "unable to type-check this expression in
    // reasonable time" (the exact failure mode already documented on
    // `SettingsRootView.modelProvidersSection` for the same reason).
    @ViewBuilder
    private func messageRow(index: Int, message: ChatMessage) -> some View {
        MessageCell(
            message: message,
            isActivelyTyping: viewModel.activeTypingMessageId == message.id,
            onRegenerate: { viewModel.regenerateLastResponse() },
            onEditUserMessage: { newText in viewModel.editUserMessageAndResend(id: message.id, newContent: newText) },
            onOpenWorkspaceFile: { viewModel.openWorkspace(selecting: $0) },
            isBusy: viewModel.isGenerating,
            showHeader: isFirstInAssistantRun(index),
            showFooter: isLastInAssistantRun(index),
            loadingStatusText: viewModel.activeTypingMessageId == message.id ? viewModel.loadingStatusText : nil,
            fontSize: appearance.fontSize.messageFontSize,
            userBubbleFill: appearance.coloredUserBubble ? appearance.accentColor.opacity(0.15) : colors.userBubble
        )
        // The skip-unchanged-rows gate — see MessageCell's own == doc.
        .equatable()
        .padding(.top, topSpacing(before: index))
        .id(message.id)
    }

    /// Full space (a new turn) before a user message, or the first
    /// assistant-side message replying to one; tight space between a
    /// turn's own internal steps (tool-call chip → tool-result card →
    /// continuation text) so a multi-step reply reads as one continuous
    /// answer.
    private func topSpacing(before index: Int) -> CGFloat {
        guard index > 0 else { return 0 }
        let messages = viewModel.messages
        return (!messages[index].isUser && !messages[index - 1].isUser) ? 6 : 24
    }

    /// True for the first message in a run of consecutive non-user
    /// messages — an agent turn's opening step. Meaningless for a user
    /// message itself, which `MessageCell` never reads this for.
    private func isFirstInAssistantRun(_ index: Int) -> Bool {
        index == 0 || viewModel.messages[index - 1].isUser
    }

    /// True for the last message in that same run — the turn's real final
    /// output, where stats and the copy/regenerate row belong.
    private func isLastInAssistantRun(_ index: Int) -> Bool {
        let messages = viewModel.messages
        return index == messages.count - 1 || messages[index + 1].isUser
    }

    private func scrollToBottom(_ proxy: ScrollViewProxy, animated: Bool = true) {
        if animated {
            withAnimation(.easeOut(duration: 0.2)) { proxy.scrollTo(bottomAnchor, anchor: .bottom) }
        } else {
            proxy.scrollTo(bottomAnchor, anchor: .bottom)
        }
    }

    /// The user's own scroll gesture is the authoritative "stop following
    /// me" signal. Position measurement alone (the preference above) loses
    /// a race during fast streams: an upward flick that hasn't yet carried
    /// the anchor past the 60pt slack still measures as "near bottom," so
    /// the next content tick would scroll right back down and re-capture
    /// the user — reported live as "I can't scroll up while the model is
    /// responding." An `NSEvent` local monitor sees the wheel/trackpad
    /// event itself the moment it happens: any upward scroll disarms
    /// following instantly, no measurement involved. Re-arming stays
    /// measurement-based (actually returning to the bottom), plus the
    /// explicit re-arms (sending a message, the jump-to-bottom button).
    /// The monitor is app-local and returns the event untouched — purely a
    /// listener. A scroll in some other scroll view (the diff card, the
    /// workspace panel) can disarm too, which is harmless: the next
    /// preference tick re-arms if the conversation is in fact still at its
    /// bottom.
    private func installScrollIntentMonitor() {
        guard scrollIntentMonitor == nil else { return }
        scrollIntentMonitor = NSEvent.addLocalMonitorForEvents(matching: .scrollWheel) { event in
            if event.scrollingDeltaY > 0, isNearBottom {
                isNearBottom = false
            }
            return event
        }
    }

    private func removeScrollIntentMonitor() {
        if let scrollIntentMonitor {
            NSEvent.removeMonitor(scrollIntentMonitor)
        }
        scrollIntentMonitor = nil
    }
}

/// The bottom anchor's own bottom edge, measured in `chatScroll`'s named
/// coordinate space (applied to the `ScrollView` itself, so this is
/// relative to the visible viewport, not the scrolled content) — small
/// when the anchor sits inside or just below the visible area, large once
/// the user has scrolled it well out of view. Reported live so
/// "auto-scroll or not" reflects real content position rather than
/// inferring intent from a drag gesture, which would miss a trackpad
/// scroll, a keyboard page-down, or the view settling after a resize.
private struct BottomAnchorOffsetKey: PreferenceKey {
    static var defaultValue: CGFloat = 0
    static func reduce(value: inout CGFloat, nextValue: () -> CGFloat) {
        value = nextValue()
    }
}

/// Subtle press/hover feedback for empty-state recent-chat rows —
/// a light background tint on hover so they read as tappable without shouting.
private struct EmptyStateRowButtonStyle: ButtonStyle {
    @Environment(\.themeColors) private var colors
    @State private var isHovered = false

    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .background(
                RoundedRectangle(cornerRadius: 9, style: .continuous)
                    .fill(isHovered || configuration.isPressed ? colors.backgroundHover : .clear)
            )
            .opacity(configuration.isPressed ? 0.7 : 1)
            .onHover { isHovered = $0 }
    }
}

/// Floating affordance shown only once the user has scrolled away from a
/// live-updating bottom — the explicit way back, rather than requiring a
/// manual drag all the way down.
private struct JumpToBottomButton: View {
    @Environment(\.themeColors) private var colors
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            Image(systemName: "arrow.down")
                .font(.system(size: 13, weight: .semibold))
                .foregroundStyle(colors.textPrimary)
                .frame(width: 34, height: 34)
                .background(Circle().fill(colors.backgroundElevated))
                .overlay(Circle().stroke(colors.borderSubtle, lineWidth: 1))
                .shadow(color: colors.shadowColor, radius: 8, y: 3)
        }
        .buttonStyle(.plain)
        .help("Jump to bottom")
    }
}

/// How full the current conversation is relative to the active model's
/// context window — approximate (see `ContextWindowEstimator`), so it
/// reads as a rough gauge, not a precise measurement. Silent (renders
/// nothing) whenever the limit isn't known or usage is negligible, rather
/// than showing a guessed or misleadingly-precise number.
private struct ContextUsageBadge: View {
    @Environment(\.themeColors) private var colors
    @Bindable var viewModel: ChatViewModel

    private var label: String? {
        guard let limit = viewModel.contextLimitTokens else { return nil }
        return ContextWindowEstimator.usageLabel(usedTokens: viewModel.estimatedUsedTokens, limitTokens: limit)
    }

    private var percent: Double {
        guard let limit = viewModel.contextLimitTokens, limit > 0 else { return 0 }
        return Double(viewModel.estimatedUsedTokens) / Double(limit)
    }

    private var tint: Color {
        if percent >= 0.9 { return colors.destructive }
        if percent >= 0.75 { return .orange }
        return colors.textTertiary
    }

    var body: some View {
        if let label {
            Text(label)
                .font(AppFont.mono(12, weight: .medium))
                .foregroundStyle(tint)
                .padding(.horizontal, 9)
                .padding(.vertical, 5)
                .background(Capsule().fill(colors.backgroundChip.opacity(0.6)))
                .help("Roughly \(viewModel.estimatedUsedTokens) of \(viewModel.contextLimitTokens ?? 0) tokens, estimated from character count rather than counted exactly")
        }
    }
}

// MARK: - Top bar components

struct TopBarIconButton: View {
    @Environment(\.themeColors) private var colors
    let systemName: String
    var label: String? = nil
    let action: () -> Void
    @State private var isHovered = false

    var body: some View {
        Button(action: action) {
            HStack(spacing: 6) {
                Image(systemName: systemName)
                    .font(.system(size: 14, weight: .medium))
                    .iconHoverEffect(for: systemName)
                if let label {
                    Text(label).font(AppFont.mono(14, weight: .medium))
                }
            }
            .foregroundStyle(colors.textPrimary.opacity(0.85))
            .padding(.horizontal, label == nil ? 8 : 12)
            .frame(height: 34)
            .background(
                Capsule().fill(isHovered ? colors.backgroundHover : .clear)
            )
            .overlay(
                Capsule().stroke(colors.borderSubtle, lineWidth: label == nil ? 0 : 1)
            )
            .contentShape(Capsule())
        }
        .buttonStyle(PressableButtonStyle())
        .onHover { isHovered = $0 }
    }
}

// MARK: - Message cell

/// `Equatable` so SwiftUI can skip re-rendering rows whose inputs didn't
/// change. Without this, the closure properties (`onRegenerate`,
/// `onOpenWorkspaceFile`) — recreated fresh by the parent every render and
/// incomparable by reflection — made EVERY visible row re-evaluate its
/// whole body (markdown parse, syntax highlight, diff derivation) on EVERY
/// typewriter tick of a streaming reply, up to ~250 times a second. The
/// closures are semantically constant (same view-model methods every
/// time), so comparing everything BUT them is exactly right. Applied via
/// `.equatable()` at the call site in `messageRow`.
struct MessageCell: View, Equatable {
    @Environment(\.themeColors) private var colors
    let message: ChatMessage
    var isActivelyTyping: Bool = false
    var onRegenerate: () -> Void = {}
    var onEditUserMessage: (String) -> Void = { _ in }
    var onOpenWorkspaceFile: ((String) -> Void)? = nil
    /// Whether the conversation is mid-generation — hides the user-message
    /// Edit affordance while a reply is streaming (editing then would be a
    /// no-op the view-model guards against anyway). In `==` so the affordance
    /// correctly appears/disappears when generation starts or stops; that's
    /// only two re-evaluations per turn, not the per-tick storm the gate is
    /// really there to prevent.
    var isBusy: Bool = false

    /// Inline "edit & resend" state for a user message — kept as local view
    /// state (not lifted to the view-model) so entering/leaving the editor
    /// never touches the message model or triggers a persist until Save.
    @State private var isEditingUserMessage = false
    @State private var editDraft = ""
    @State private var isHoveringUserBubble = false

    static func == (lhs: MessageCell, rhs: MessageCell) -> Bool {
        lhs.message == rhs.message
            && lhs.isActivelyTyping == rhs.isActivelyTyping
            && lhs.showHeader == rhs.showHeader
            && lhs.showFooter == rhs.showFooter
            && lhs.loadingStatusText == rhs.loadingStatusText
            && lhs.fontSize == rhs.fontSize
            && lhs.userBubbleFill == rhs.userBubbleFill
            && lhs.isBusy == rhs.isBusy
    }
    /// True only for the first assistant-side message in a run of
    /// consecutive non-user messages (an agent turn) — shows the model
    /// name/logo once per turn instead of once per internal step, so a
    /// multi-step tool-use reply reads as one continuous answer instead of
    /// several separate messages that each restate who's talking.
    var showHeader: Bool = true
    /// True only for the last message in that same run — generation stats
    /// and the copy/regenerate row belong to the turn's real final output,
    /// not to an intermediate tool-call step.
    var showFooter: Bool = true
    /// Set by the caller only for the message currently streaming, from
    /// `ChatViewModel.loadingStatusText` — real status text for an Ollama
    /// model still loading. Ollama's server runs independent of this app
    /// and stays reachable regardless of whether *this* model is loaded, so
    /// this can't be derived locally the way the llama.cpp/MLX case below
    /// can; `ChatViewModel` already did the real pre-flight check.
    var loadingStatusText: String? = nil
    /// Both of these used to be computed properties reaching straight into
    /// `AppearanceSettings.shared` — invisible to `==` above, so once a row
    /// rendered once, `.equatable()` would keep reusing that render forever
    /// and a later Font Size / colored-bubble / accent-color change in
    /// Settings would never reach already-on-screen messages (reported live
    /// as "the font changer doesn't work"). Passed in from `ChatHomeView`
    /// instead, which itself reads `AppearanceSettings` — a genuine change
    /// now shows up as a real inequality here, the same way a genuine
    /// `message` change always did.
    var fontSize: CGFloat = AppFontSize.medium.messageFontSize
    var userBubbleFill: Color = .clear

    /// Merges the two real local-loading signals into one: `loadingStatusText`
    /// (passed in, Ollama's case) and `LocalAIManager`'s own live spawn
    /// status (read directly here — llama.cpp/MLX are spawned by this app,
    /// so their loading state is already tracked and doesn't need passing
    /// in). Only one is ever relevant for a given local backend at once.
    private var liveLoadingText: String? {
        guard isActivelyTyping else { return nil }
        if LocalAIManager.shared.isStartingServer {
            return LocalAIManager.shared.startupStatus ?? "Starting the local server…"
        }
        return loadingStatusText
    }

    /// A completed local-or-not message's real generation stats — nil for
    /// anything still typing, an error, a tool-result card, or a message
    /// with no timing data (e.g. one loaded from before this feature
    /// existed). Every number here is measured, never estimated.
    private var statsCaption: String? {
        guard !message.isUser, message.isToolResult != true, !message.isError else { return nil }
        guard let modelId = message.modelId, !modelId.isEmpty else { return nil }
        guard let start = message.generationStartTime, let end = message.generationEndTime,
              message.generatedTokenCount > 0 else { return nil }

        var parts: [String] = []

        if LocalAIManager.shared.owns(modelId) {
            let backendName = LocalAIManager.shared.record(withId: modelId)?.backend.displayName ?? "this Mac"
            parts.append("Ran locally · \(backendName)")
        }

        parts.append("\(message.generatedTokenCount) tok")
        let duration = end.timeIntervalSince(start)
        if duration > 0 {
            let tokensPerSecond = Double(message.generatedTokenCount) / duration
            parts.append(String(format: "%.0f tok/s", tokensPerSecond))
        }

        if let loadSeconds = message.coldLoadDurationSeconds {
            parts.append(String(format: "loaded in %.1fs", loadSeconds))
        } else if message.wasColdLoad == true {
            // Real fact (a fresh load did happen), just without a precise
            // duration to show — see `ChatMessage.coldLoadDurationSeconds`.
            parts.append("model was loading")
        }

        if let bytes = message.localMemoryBytes, bytes > 0 {
            let gigabytes = Double(bytes) / 1_000_000_000
            parts.append(String(format: "%.1f GB in memory", gigabytes))
        }

        return parts.joined(separator: " · ")
    }

    var body: some View {
        if message.isToolResult == true {
            // Not drawn. Tool results used to get a card of their own between
            // every pair of calls, which is most of what made a research turn
            // unreadable — and the card mostly restated the call that had
            // just been shown above it. The step trail on the assistant
            // message now carries what was done; the raw text stays in the
            // conversation (the model still receives it), it simply isn't
            // shouted at the user. Preview runtime errors are the exception:
            // those are a real failure the user has to see, and nothing else
            // surfaces them.
            if message.content.hasPrefix("[Preview runtime errors") {
                ToolResultsCard(content: message.content)
            }
        } else if message.isUser {
            userMessage
        } else {
            assistantMessage
        }
    }

    private var userMessage: some View {
        HStack {
            Spacer(minLength: 60)
            VStack(alignment: .trailing, spacing: 8) {
                if let skillName = message.invokedSkillName {
                    HStack(spacing: 4) {
                        Image(systemName: "bolt.fill")
                            .font(.system(size: 9, weight: .semibold))
                        Text("Skill: \(skillName)")
                            .font(AppFont.mono(12, weight: .medium))
                    }
                    .foregroundStyle(colors.textTertiary)
                }
                if !message.attachments.isEmpty {
                    MessageAttachmentsView(attachments: message.attachments)
                }
                if isEditingUserMessage {
                    userMessageEditor
                } else if !message.content.isEmpty {
                    userBubble
                }
            }
        }
    }

    private var userBubble: some View {
        VStack(alignment: .trailing, spacing: 4) {
            Text(message.content)
                .font(AppFont.sans(fontSize))
                .foregroundStyle(colors.textPrimary)
                .multilineTextAlignment(.leading)
                .textSelection(.enabled)
                .padding(.horizontal, 14)
                .padding(.vertical, 9)
                .background(
                    RoundedRectangle(cornerRadius: 12, style: .continuous)
                        .fill(userBubbleFill)
                )

            // Revealed on hover (and hidden while a reply is generating).
            Button {
                editDraft = message.content
                withAnimation(.easeOut(duration: 0.12)) { isEditingUserMessage = true }
            } label: {
                HStack(spacing: 3) {
                    Image(systemName: "pencil")
                        .iconHoverEffect(for: "pencil")
                    Text("Edit")
                }
                .font(AppFont.mono(12, weight: .medium))
                .foregroundStyle(colors.textTertiary)
            }
            .buttonStyle(.plain)
            .help("Edit this message and resend")
            .opacity(isHoveringUserBubble && !isBusy ? 1 : 0)
            .allowsHitTesting(isHoveringUserBubble && !isBusy)
        }
        .onHover { hovering in
            withAnimation(.easeOut(duration: 0.12)) { isHoveringUserBubble = hovering }
        }
    }

    private var userMessageEditor: some View {
        VStack(alignment: .trailing, spacing: 8) {
            TextEditor(text: $editDraft)
                .font(AppFont.sans(fontSize))
                .foregroundStyle(colors.textPrimary)
                .scrollContentBackground(.hidden)
                .frame(minWidth: 300, idealWidth: 440, maxWidth: 520, minHeight: 62, maxHeight: 220)
                .padding(8)
                .background(
                    RoundedRectangle(cornerRadius: 12, style: .continuous)
                        .fill(colors.backgroundInput)
                )
                .overlay(
                    RoundedRectangle(cornerRadius: 12, style: .continuous)
                        .stroke(colors.borderMedium, lineWidth: 1)
                )

            HStack(spacing: 8) {
                Button {
                    withAnimation(.easeOut(duration: 0.12)) { isEditingUserMessage = false }
                } label: {
                    Text("Cancel")
                        .font(AppFont.mono(12, weight: .medium))
                        .foregroundStyle(colors.textSecondary)
                }
                .buttonStyle(.plain)

                Button {
                    let text = editDraft
                    isEditingUserMessage = false
                    onEditUserMessage(text)
                } label: {
                    Text("Save & Resend")
                        .font(AppFont.mono(12, weight: .semibold))
                        .foregroundStyle(AppearanceSettings.shared.onAccentColor)
                        .padding(.horizontal, 14)
                        .padding(.vertical, 6)
                        .background(Capsule().fill(AppearanceSettings.shared.accentColor))
                }
                .buttonStyle(PressableButtonStyle())
                .disabled(editDraft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
            }
        }
    }

    @ViewBuilder
    private var assistantMessage: some View {
        if message.isError {
            errorMessage
        } else if message.isGeneratedImage == true {
            VStack(alignment: .leading, spacing: 6) {
                if showHeader { modelAttributionHeader }
                generatedImageBubble
            }
        } else {
            VStack(alignment: .leading, spacing: 6) {
                if showHeader, !message.content.isEmpty || isActivelyTyping {
                    modelAttributionHeader
                }
                HoverRevealAssistantBody(
                    messageId: message.id,
                    content: message.content,
                    isActivelyTyping: isActivelyTyping,
                    onRegenerate: onRegenerate,
                    onOpenWorkspaceFile: onOpenWorkspaceFile,
                    loadingStatusText: liveLoadingText,
                    statsCaption: statsCaption,
                    showFooter: showFooter
                )
            }
        }
    }

    /// Which model actually said this — shown as soon as a reply starts
    /// appearing, not just once it's done, so it reads as "this is who's
    /// talking" rather than a completion stat. Respects a renamed nickname
    /// the same way the model picker itself does, and reuses `BrandLogoView`
    /// bare (no circular badge chip) so it sits light or gets a real
    /// company logo depending on the model, without adding visual weight
    /// this small a label doesn't need.
    @ViewBuilder
    private var modelAttributionHeader: some View {
        if let modelId = message.modelId, !modelId.isEmpty {
            let displayName = ModelPreferencesStore.shared.nickname(for: modelId)
                ?? ModelCatalog.displayName(modelId: modelId, apiName: message.modelName)
            HStack(spacing: 6) {
                BrandLogoView(brand: ModelCatalog.brand(for: modelId), size: 14)
                Text(displayName)
                    .font(AppFont.mono(12, weight: .medium))
                    .foregroundStyle(colors.textTertiary)
            }
        }
    }

    /// The whole point of this message IS the image — shown large, not as a
    /// small attachment thumbnail the way a user's upload gets. Bypasses
    /// `HoverRevealAssistantBody`'s markdown/code-block/tool-chip pipeline
    /// entirely, since none of that applies to a pure image response.
    @ViewBuilder
    private var generatedImageBubble: some View {
        if let attachment = message.attachments.first, let image = AttachmentStore.loadImage(for: attachment) {
            VStack(alignment: .leading, spacing: 8) {
                Image(nsImage: image)
                    .resizable()
                    .scaledToFit()
                    .frame(maxWidth: 420, maxHeight: 420)
                    .clipShape(RoundedRectangle(cornerRadius: 14, style: .continuous))
                    .overlay(
                        RoundedRectangle(cornerRadius: 14, style: .continuous)
                            .stroke(colors.borderSubtle, lineWidth: 1)
                    )
                    .contextMenu {
                        Button("Save Image As…") { saveGeneratedImage(image, suggestedName: attachment.fileName) }
                    }

                if !message.content.isEmpty {
                    Text(message.content)
                        .font(AppFont.sans(fontSize - 1))
                        .foregroundStyle(colors.textSecondary)
                }
            }
        } else {
            Text("This generated image is no longer available.")
                .font(AppFont.sans(fontSize))
                .foregroundStyle(colors.textTertiary)
        }
    }

    private func saveGeneratedImage(_ image: NSImage, suggestedName: String) {
        let panel = NSSavePanel()
        panel.nameFieldStringValue = suggestedName
        panel.allowedContentTypes = [.png]
        guard panel.runModal() == .OK, let url = panel.url,
              let tiff = image.tiffRepresentation,
              let bitmap = NSBitmapImageRep(data: tiff),
              let png = bitmap.representation(using: .png, properties: [:]) else { return }
        try? png.write(to: url)
    }

    private var errorMessage: some View {
        HStack(alignment: .top, spacing: 10) {
            Image(systemName: "exclamationmark.triangle.fill")
                .foregroundStyle(colors.destructive)
            VStack(alignment: .leading, spacing: 4) {
                Text("Something went wrong")
                    .font(AppFont.mono(fontSize, weight: .semibold))
                    .foregroundStyle(colors.textPrimary)
                Text(message.content)
                    .font(AppFont.sans(fontSize - 1))
                    .foregroundStyle(colors.textSecondary)
                    .textSelection(.enabled)
            }
            Spacer(minLength: 0)
        }
        .padding(12)
        .background(
            RoundedRectangle(cornerRadius: 10, style: .continuous)
                .fill(colors.destructive.opacity(0.06))
        )
        .overlay(
            RoundedRectangle(cornerRadius: 10, style: .continuous)
                .stroke(colors.destructive.opacity(0.25), lineWidth: 1)
        )
    }
}

/// Compact, collapsed rendering of an automated tool-results message (run
/// output, edit confirmations, preview errors) — the agent's "terminal"
/// turns, summarized in chat with the full text one click away.
struct ToolResultsCard: View {
    @Environment(\.themeColors) private var colors
    let content: String
    @State private var expanded = false

    private var isPreviewErrors: Bool { content.hasPrefix("[Preview runtime errors") }

    private var summaryItems: [String] {
        if isPreviewErrors {
            return Array(content.components(separatedBy: "\n").dropFirst().prefix(3))
        }
        let lines = content.components(separatedBy: "\n")
        var items: [String] = []
        for (index, line) in lines.enumerated() where line.hasPrefix("### ") {
            var item = String(line.dropFirst(4))
            if index + 1 < lines.count {
                let next = lines[index + 1]
                if next.hasPrefix("exit code:") || next.hasPrefix("OK") || next.hasPrefix("ERROR") {
                    item += "  ·  " + next
                }
            }
            items.append(item)
        }
        return items.isEmpty ? ["results"] : items
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            Button {
                withAnimation(.easeOut(duration: 0.15)) { expanded.toggle() }
            } label: {
                HStack(spacing: 6) {
                    Image(systemName: isPreviewErrors ? "exclamationmark.triangle" : "terminal")
                        .font(.system(size: 10, weight: .semibold))
                    Text(isPreviewErrors ? "Preview errors" : "Tool results")
                        .font(AppFont.mono(12, weight: .semibold))
                    Image(systemName: "chevron.right")
                        .font(.system(size: 8, weight: .semibold))
                        .rotationEffect(.degrees(expanded ? 90 : 0))
                    Spacer(minLength: 0)
                }
                .foregroundStyle(colors.textTertiary)
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)

            ForEach(Array(summaryItems.enumerated()), id: \.offset) { _, item in
                Text(item)
                    .font(AppFont.mono(12))
                    .foregroundStyle(colors.textSecondary)
                    .lineLimit(1)
            }

            if expanded {
                ScrollView {
                    Text(content)
                        .font(AppFont.mono(12))
                        .foregroundStyle(colors.textCode)
                        .textSelection(.enabled)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .padding(8)
                }
                .frame(maxHeight: 240)
                .background(colors.backgroundCode)
                .clipShape(RoundedRectangle(cornerRadius: 8, style: .continuous))
            }
        }
        .padding(10)
        .frame(maxWidth: 560, alignment: .leading)
        .background(
            RoundedRectangle(cornerRadius: 10, style: .continuous)
                .fill(colors.backgroundChip.opacity(0.6))
        )
        .overlay(
            RoundedRectangle(cornerRadius: 10, style: .continuous)
                .stroke(colors.borderSubtle, lineWidth: 1)
        )
    }
}

/// Assistant body + action row, where the row only appears on hover — it
/// stays reserved-but-invisible (not removed from layout) so hovering
/// doesn't shift the message above/below it.
private struct HoverRevealAssistantBody: View {
    @Environment(\.themeColors) private var colors
    let messageId: UUID
    let content: String
    let isActivelyTyping: Bool
    var onRegenerate: () -> Void
    var onOpenWorkspaceFile: ((String) -> Void)? = nil
    /// Real status text for a local model still loading — see
    /// `ThinkingIndicator`.
    var loadingStatusText: String? = nil
    /// A completed message's real generation stats (tokens, speed, and for
    /// a local model: which backend, whether it needed a fresh load, and
    /// its memory footprint) — nil for messages with nothing to show yet.
    var statsCaption: String? = nil
    /// False for every step but the last in a multi-step agent turn — an
    /// intermediate step's own stats/copy/regenerate row would apply to
    /// just that one piece, not the turn's real final answer.
    var showFooter: Bool = true
    @State private var isHovered = false

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            if !content.isEmpty || isActivelyTyping {
                AssistantMessageContentView(
                    text: content,
                    isTyping: isActivelyTyping,
                    onOpenWorkspaceFile: onOpenWorkspaceFile,
                    loadingStatusText: loadingStatusText
                )
            }
            if showFooter, !isActivelyTyping && !content.isEmpty {
                if let statsCaption {
                    Text(statsCaption)
                        .font(AppFont.mono(12))
                        .foregroundStyle(colors.textTertiary)
                }
                // Copy should hand back the real answer, not the model's
                // internal <think> scratchpad riding along in `content`.
                MessageActionsRow(messageId: messageId, content: ReasoningExtractor.extract(from: content).visibleContent, onRegenerate: onRegenerate)
                    .opacity(isHovered ? 1 : 0)
                    .animation(.easeOut(duration: 0.12), value: isHovered)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .onHover { isHovered = $0 }
    }
}

// MARK: - Assistant action row

struct MessageActionsRow: View {
    @Environment(\.themeColors) private var colors
    var messageId: UUID = UUID()
    let content: String
    var onRegenerate: () -> Void = {}

    @State private var copied = false
    @State private var reaction: Int = 0 // -1 down, 0 none, 1 up
    @Bindable private var narrator = SpeechNarrator.shared

    var body: some View {
        HStack(spacing: 2) {
            ActionIcon(systemName: copied ? "checkmark" : "doc.on.doc", help: "Copy") {
                NSPasteboard.general.clearContents()
                NSPasteboard.general.setString(content, forType: .string)
                copied = true
                DispatchQueue.main.asyncAfter(deadline: .now() + 1.5) { copied = false }
            }
            ActionIcon(
                systemName: narrator.isSpeaking(messageId) ? "stop.fill" : "speaker.wave.2",
                help: narrator.isSpeaking(messageId) ? "Stop" : "Read aloud"
            ) {
                narrator.toggle(id: messageId, text: content)
            }
            ActionIcon(systemName: reaction == 1 ? "hand.thumbsup.fill" : "hand.thumbsup", help: "Good response") {
                reaction = reaction == 1 ? 0 : 1
            }
            ActionIcon(systemName: reaction == -1 ? "hand.thumbsdown.fill" : "hand.thumbsdown", help: "Bad response") {
                reaction = reaction == -1 ? 0 : -1
            }
            ActionIcon(systemName: "arrow.clockwise", help: "Regenerate", action: onRegenerate)
        }
        .padding(.top, 2)
    }
}

struct ActionIcon: View {
    @Environment(\.themeColors) private var colors
    let systemName: String
    var help: String = ""
    let action: () -> Void
    @State private var isHovered = false

    var body: some View {
        Button(action: action) {
            Image(systemName: systemName)
                .font(.system(size: 13, weight: .regular))
                .foregroundStyle(colors.textSecondary)
                .frame(width: 28, height: 28)
                .background(
                    RoundedRectangle(cornerRadius: 7, style: .continuous)
                        .fill(isHovered ? colors.backgroundHover : .clear)
                )
                .contentShape(Rectangle())
        }
        .buttonStyle(PressableButtonStyle())
        .onHover { isHovered = $0 }
        .help(help)
    }
}
