import AppKit
import SwiftUI
import UniformTypeIdentifiers

struct ChatComposer: View {
    @Environment(\.themeColors) private var colors
    @Bindable var viewModel: ChatViewModel
    /// Lets the mode switcher tell the window's root which surface to show —
    /// switching to/from Eaon Claw swaps the whole view, not just
    /// `viewModel.currentMode`. See `ModeSegmentedControl`.
    var onModeChange: (EaonMode) -> Void = { _ in }
    @FocusState private var isFocused: Bool
    @State private var editorHeight: CGFloat = GrowingMessageField.minHeight
    @State private var isAttachMenuOpen = false
    @State private var isImageImporterPresented = false
    @State private var isFileImporterPresented = false

    private var canSend: Bool {
        let hasText = !viewModel.inputText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
        let hasAttachments = !viewModel.pendingAttachments.isEmpty
        return (hasText || hasAttachments) && !viewModel.isGenerating
    }

    private var hasContent: Bool {
        !viewModel.inputText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
            || !viewModel.pendingAttachments.isEmpty
    }

    /// "Ask anything" is generic filler when the active model is already
    /// known — naming it costs nothing and feels more considered. Falls
    /// back to the generic phrasing only while there's genuinely no
    /// resolved model to name (nothing selected yet, or still loading).
    private var composerPlaceholder: String {
        guard !viewModel.selectedModel.isEmpty, !viewModel.isLoadingModels else {
            return "Ask anything"
        }
        let record = viewModel.chatModels.first { $0.id == viewModel.selectedModel }
        var name = ModelPreferencesStore.shared.nickname(for: viewModel.selectedModel)
            ?? ModelCatalog.displayName(modelId: viewModel.selectedModel, apiName: record?.name)
        // An Ollama-style "name:tag" id (e.g. "deepseek-r1:7b") has no
        // catalog entry or nickname to fall back on, so it reaches here
        // unstripped — "Ask deepseek-r1 anything" reads better inline than
        // including the tag. A real catalog/nickname name never has a colon.
        if let colonIndex = name.firstIndex(of: ":") {
            name = String(name[name.startIndex..<colonIndex])
        }
        return "Ask \(name) anything"
    }

    var body: some View {
        VStack(spacing: 8) {
            if viewModel.chatModels.isEmpty {
                noticeBanner(icon: "key.fill", tint: .orange, text: "Set up a model provider in Settings to start chatting. Use Eaon, your own API key, or a local model.")
            }
            if let notice = viewModel.composerNotice {
                noticeBanner(icon: "info.circle", tint: .orange, text: notice)
            }

            pill
        }
    }

    // MARK: - Composer pill

    /// Matching skill names for the `/` autocomplete popover — only while
    /// the composer is a bare leading slash command with nothing sent yet
    /// (no space typed after the name), so it disappears the moment the
    /// user starts writing their actual message. Disabled (not just
    /// invisible) skills never match — there's nothing useful about
    /// autocompleting to a skill the model would then ignore.
    private var skillAutocompleteMatches: [Skill] {
        let text = viewModel.inputText
        guard text.hasPrefix("/"), !text.contains(where: \.isWhitespace) else { return [] }
        let query = String(text.dropFirst()).lowercased()
        let enabled = SkillStore.shared.enabledSkills
        guard !query.isEmpty else { return enabled }
        return enabled.filter { $0.name.contains(query) }
    }

    private var pill: some View {
        VStack(spacing: 0) {
            if !viewModel.pendingAttachments.isEmpty {
                PendingAttachmentsBar(attachments: viewModel.pendingAttachments) { id in
                    viewModel.removePendingAttachment(id: id)
                }
                .padding(.top, 14)
            }

            if !skillAutocompleteMatches.isEmpty {
                SkillAutocompletePopover(skills: skillAutocompleteMatches) { skill in
                    viewModel.inputText = "/\(skill.name) "
                }
                .padding(.horizontal, 18)
                .padding(.top, 14)
            }

            // Row 1 — text area on its own line, spanning the full width.
            GrowingMessageField(
                text: $viewModel.inputText,
                isFocused: $isFocused,
                height: $editorHeight,
                onSend: sendIfPossible,
                onShiftTab: { viewModel.requestAgentPermissionToggle() },
                placeholder: composerPlaceholder
            )
            .padding(.horizontal, 18)
            .padding(.top, 16)

            // Row 2 — attach button and mode switcher pinned left, send
            // button pinned right. The mode switcher only shows before the
            // conversation has actually started — pick a mode, THEN send;
            // once there's a real reply in the transcript, switching tools/
            // prompt out from under it mid-conversation would be confusing,
            // so it's locked in and the control disappears rather than
            // sitting there doing nothing.
            HStack(spacing: 8) {
                plusButton
                // The coding Agent's permission pill — unlike the mode
                // switcher, it stays visible during the conversation (you
                // toggle Sandboxed/Auto while coding, not just before).
                if viewModel.currentMode == .agent {
                    // Chrome-less icons need their own air: with no button
                    // outline to separate them, gaps ARE the separation, and
                    // crowded ones read as a single smudge. 6pt between 28pt
                    // targets gives even, breathable rhythm without letting
                    // the group drift apart into three unrelated buttons.
                    HStack(spacing: 6) {
                        AgentPermissionPill(isAuto: viewModel.agentAutoRun) {
                            viewModel.requestAgentPermissionToggle()
                        }
                        .transition(.opacity.combined(with: .scale(scale: 0.9, anchor: .leading)))
                        // Agent vs. Agent Swarm — how the work gets thought
                        // through, next to the toggle controlling how it runs.
                        AgentSwarmPill(isSwarm: viewModel.agentSwarmEnabled) {
                            viewModel.agentSwarmEnabled.toggle()
                        }
                        .transition(.opacity.combined(with: .scale(scale: 0.9, anchor: .leading)))
                        // Only offered when device control is on, because without
                        // it the browser tools aren't sent to the model at all and
                        // the toggle would be a switch that does nothing.
                        if DesktopControlStore.shared.isEnabled {
                            BrowserPill(isOn: viewModel.browserModeEnabled) {
                                viewModel.browserModeEnabled.toggle()
                            }
                            .transition(.opacity.combined(with: .scale(scale: 0.9, anchor: .leading)))
                        }
                    }
                }
                Spacer(minLength: 0)
                trailingControls
            }
            .padding(.horizontal, 12)
            .padding(.top, 8)
            .padding(.bottom, 12)
            .animation(.easeOut(duration: 0.18), value: viewModel.messages.isEmpty)
            .animation(.easeOut(duration: 0.18), value: viewModel.currentMode)
            .animation(.spring(duration: 0.28, bounce: 0.18), value: viewModel.agentAutoRun)
            .animation(.spring(duration: 0.28, bounce: 0.18), value: viewModel.agentSwarmEnabled)
            .animation(.spring(duration: 0.28, bounce: 0.18), value: viewModel.browserModeEnabled)
        }
        .background(
            RoundedRectangle(cornerRadius: 26, style: .continuous)
                .fill(colors.backgroundInput)
        )
        .overlay(
            RoundedRectangle(cornerRadius: 26, style: .continuous)
                .stroke(colors.borderSubtle, lineWidth: 1)
        )
        .shadow(color: colors.shadowColor.opacity(0.16), radius: 6, x: 0, y: 2)
        .fileImporter(
            isPresented: $isImageImporterPresented,
            allowedContentTypes: [.image],
            allowsMultipleSelection: false
        ) { result in handleImport(result, kind: .image) }
        .fileImporter(
            isPresented: $isFileImporterPresented,
            allowedContentTypes: [.item],
            allowsMultipleSelection: false
        ) { result in handleImport(result, kind: .file) }
        .onAppear {
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.3) {
                AppFocus.activate()
                isFocused = true
            }
        }
        .onChange(of: viewModel.inputText) { _, _ in
            if viewModel.inputText.isEmpty {
                editorHeight = GrowingMessageField.minHeight
            }
        }
    }

    private var plusButton: some View {
        Button {
            isAttachMenuOpen.toggle()
        } label: {
            Image(systemName: "plus")
                .accessibilityLabel("Attach")
                .font(.system(size: 17, weight: .regular))
                .foregroundStyle(colors.textPrimary.opacity(0.85))
                .iconHoverEffect(for: "plus")
                .frame(width: 34, height: 34)
                .background(Circle().fill(colors.backgroundInputSecondary))
                .contentShape(Circle())
        }
        .buttonStyle(PressableButtonStyle())
        .popover(isPresented: $isAttachMenuOpen, arrowEdge: .top) {
            ComposerAttachmentMenu(
                onPickImage: { isAttachMenuOpen = false; isImageImporterPresented = true },
                onPickFile: { isAttachMenuOpen = false; isFileImporterPresented = true },
                onPasteImage: { isAttachMenuOpen = false; viewModel.pasteImageAttachment() },
                onComingSoon: { feature in
                    isAttachMenuOpen = false
                    viewModel.composerNotice = "\(feature) is coming to Eaon soon."
                },
                onInsertTemplate: { template in
                    isAttachMenuOpen = false
                    // Replaces rather than appends: this is meant as a
                    // starting point to fill in, not something to bolt onto
                    // whatever was already typed. A non-empty composer is
                    // the rare case (the "+" menu is usually the first
                    // thing tapped), and overwriting it silently would lose
                    // real typing, so ask first rather than guess.
                    if !viewModel.inputText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                        viewModel.composerNotice = "Clear the composer first to insert a template."
                        return
                    }
                    viewModel.inputText = template
                    AppFocus.activate()
                    isFocused = true
                },
                isThinkingAvailable: viewModel.currentModelSupportsThinkingToggle,
                thinkingEnabled: viewModel.thinkingEnabled,
                onToggleThinking: {
                    viewModel.thinkingEnabled.toggle()
                }
            )
        }
    }

    private var trailingControls: some View {
        Button(action: primaryAction) {
            primaryIcon
                .frame(width: 36, height: 36)
                .background(Circle().fill(primaryFill))
                .contentShape(Circle())
        }
        .buttonStyle(PressableButtonStyle())
        .disabled(!viewModel.isGenerating && !hasContent)
    }

    @ViewBuilder
    private var primaryIcon: some View {
        if viewModel.isGenerating {
            Image(systemName: "stop.fill")
                .font(.system(size: 13))
                .foregroundStyle(.white)
                .iconHoverEffect(for: "stop.fill")
        } else {
            // Nudges up-and-out on hover, like a paper airplane taking
            // off — the one motion that matches "send" without adding
            // showy movement to the single most-clicked button in the app.
            Image(systemName: "arrow.up")
                .font(.system(size: 16, weight: .semibold))
                .foregroundStyle(colors.backgroundPrimary)
                .iconHoverEffect(for: "arrow.up")
        }
    }

    // Monochrome inverted-surface fill (black-on-white in light, white-on-black
    // in dark) — dimmed when there's nothing to send, matching the target's
    // send button rather than a colored accent.
    private var primaryFill: Color {
        if viewModel.isGenerating { return colors.destructive }
        return hasContent ? colors.textPrimary : colors.textPrimary.opacity(0.35)
    }

    private func primaryAction() {
        if viewModel.isGenerating {
            viewModel.stopGeneration()
        } else if canSend {
            sendIfPossible()
        }
    }

    private func noticeBanner(icon: String, tint: Color, text: String) -> some View {
        HStack(spacing: 8) {
            Image(systemName: icon).foregroundStyle(tint)
            Text(text).font(AppFont.sans(12)).foregroundStyle(colors.textSecondary)
            Spacer()
        }
        .padding(.horizontal, 8)
    }

    private func handleImport(_ result: Result<[URL], Error>, kind: AttachmentKind) {
        switch result {
        case .success(let urls):
            guard let url = urls.first else { return }
            let accessed = url.startAccessingSecurityScopedResource()
            defer { if accessed { url.stopAccessingSecurityScopedResource() } }
            viewModel.addAttachment(from: url, kind: kind)
        case .failure(let error):
            viewModel.composerNotice = error.localizedDescription
        }
    }

    private func sendIfPossible() {
        guard canSend else { return }
        editorHeight = GrowingMessageField.minHeight
        viewModel.startSend()
    }
}

/// The `/` slash-command picker — appears above the composer the moment
/// the whole input is a bare, unfinished `/name` with no space typed after
/// it yet, listing every enabled skill whose name contains what's typed so
/// far (or all of them, for a bare `/`). Picking one fills in `/name ` so
/// the user's cursor lands ready to type the actual request; typing past
/// the name (a space) dismisses it the same way any slash-command UI does.
private struct SkillAutocompletePopover: View {
    @Environment(\.themeColors) private var colors
    let skills: [Skill]
    let onPick: (Skill) -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            ForEach(Array(skills.prefix(6).enumerated()), id: \.element.id) { index, skill in
                if index > 0 {
                    Divider().overlay(colors.borderSubtle)
                }
                Button {
                    onPick(skill)
                } label: {
                    HStack(spacing: 10) {
                        Image(systemName: "bolt.fill")
                            .font(.system(size: 11, weight: .semibold))
                            .foregroundStyle(colors.textTertiary)
                            .iconHoverEffect(for: "bolt.fill")
                            .frame(width: 18)
                        VStack(alignment: .leading, spacing: 1) {
                            Text("/\(skill.name)")
                                .font(AppFont.mono(12.5, weight: .semibold))
                                .foregroundColor(colors.textPrimary)
                            Text(skill.summary)
                                .font(AppFont.sans(11))
                                .foregroundColor(colors.textTertiary)
                                .lineLimit(1)
                        }
                        Spacer(minLength: 8)
                    }
                    .padding(.horizontal, 12)
                    .padding(.vertical, 8)
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
            }
        }
        .background(colors.backgroundElevated)
        .clipShape(RoundedRectangle(cornerRadius: 12, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: 12, style: .continuous).stroke(colors.borderSubtle, lineWidth: 1))
        .shadow(color: colors.shadowColor.opacity(0.2), radius: 8, y: 3)
    }
}

/// A composer toggle: one icon, on or off, no label.
///
/// These replaced three labelled colour-coded pills (purple "Sandboxed", teal
/// "Swarm", blue "Browser"). Three tinted capsules sitting under the text you
/// are trying to write is a lot of chrome for controls you set once and then
/// ignore, and hue-as-meaning does not survive contact with reality: nothing
/// tells you purple means safe and teal means a committee, the palette fights
/// whatever theme is loaded, and it degrades badly for the ~8% of developers
/// with a colour-vision deficiency. So state is carried by **fill and icon
/// weight** — the same way a toolbar toggle has worked for thirty years —
/// which reads correctly in greyscale.
///
/// The one exception is `accent`, used for exactly one state: Agent running
/// unsandboxed. That is the single case where the interface needs to say
/// something the shape can't, and reserving colour for it is what makes it
/// legible — a lone amber icon in an otherwise grey row is impossible to miss,
/// which is precisely what it could not be back when it was one tint among
/// three.
///
/// The label lives in the tooltip instead of on screen. These are three
/// controls, each with an unambiguous icon, in a fixed spot — the kind of
/// thing you learn once. A permanent caption is rent charged forever for a
/// question asked twice.
/// Timing shared by every tooltip in the composer's icon row.
///
/// Emil's rule, and the reason it's shared state rather than per-icon: the
/// first tooltip waits, so sweeping the pointer across the row doesn't flash
/// four labels at you — but once one has been open, the next opens instantly,
/// so reading along the row feels immediate instead of making you wait again
/// at every single step.
@MainActor
enum ComposerTooltipTiming {
    private static var lastDismissed: Date?

    static var skipsDelay: Bool {
        guard let lastDismissed else { return false }
        return Date().timeIntervalSince(lastDismissed) < 0.7
    }

    static func noteDismissed() { lastDismissed = Date() }
}

private struct TooltipHeightKey: PreferenceKey {
    static var defaultValue: CGFloat = 0
    static func reduce(value: inout CGFloat, nextValue: () -> CGFloat) {
        value = max(value, nextValue())
    }
}

/// The little downward point under a tooltip, aiming it at its own icon.
private struct TooltipCaret: Shape {
    func path(in rect: CGRect) -> Path {
        var path = Path()
        path.move(to: CGPoint(x: rect.minX, y: rect.minY))
        path.addLine(to: CGPoint(x: rect.maxX, y: rect.minY))
        path.addLine(to: CGPoint(x: rect.midX, y: rect.maxY))
        path.closeSubpath()
        return path
    }
}

/// A hover label for a composer icon.
///
/// The icons deliberately carry no text — that's what keeps the row quiet —
/// so the tooltip is where each control's name actually lives, and the system
/// `.help()` tooltip isn't good enough for that job: it takes roughly two
/// seconds to appear, renders wherever the pointer happens to be rather than
/// at the thing it describes, and can't show whether the toggle is currently
/// on. This one appears in a third of a second, points at its own icon, and
/// says the state out loud.
private struct ComposerTooltip: ViewModifier {
    @Environment(\.themeColors) private var colors
    let title: String
    let detail: String?
    /// Owned by the toggle, which already tracks hover for its own fill —
    /// tracking it twice would mean two sources of truth that can disagree.
    let isHovered: Bool

    @State private var isVisible = false
    /// The bubble's own measured height, so it can be pushed entirely above
    /// the icon whatever the text turns out to be. Measured rather than
    /// placed with an alignment guide: a guide set inside a conditional
    /// overlay isn't honoured here, and the bubble landed on top of the very
    /// icons it was labelling.
    @State private var bubbleHeight: CGFloat = 0

    func body(content: Content) -> some View {
        content
            .overlay(alignment: .top) {
                if isVisible {
                    bubble
                        .background(
                            GeometryReader { proxy in
                                Color.clear.preference(
                                    key: TooltipHeightKey.self,
                                    value: proxy.size.height
                                )
                            }
                        )
                        .onPreferenceChange(TooltipHeightKey.self) { bubbleHeight = $0 }
                        .offset(y: -(bubbleHeight + 7))
                }
            }
            .task(id: isHovered) {
                guard isHovered else {
                    if isVisible { ComposerTooltipTiming.noteDismissed() }
                    withAnimation(.easeOut(duration: 0.1)) { isVisible = false }
                    return
                }
                if !ComposerTooltipTiming.skipsDelay {
                    try? await Task.sleep(for: .milliseconds(350))
                }
                guard !Task.isCancelled else { return }
                withAnimation(.easeOut(duration: 0.12)) { isVisible = true }
            }
    }

    private var bubble: some View {
        VStack(spacing: 0) {
            VStack(alignment: .leading, spacing: 1) {
                Text(title)
                    .font(AppFont.sans(12, weight: .medium))
                if let detail {
                    Text(detail)
                        .font(AppFont.sans(11))
                        .opacity(0.62)
                }
            }
            // Inverted from the surface underneath, the way an overlay layer
            // should be: a tooltip that borrows the app's own panel colours
            // reads as part of the UI instead of as something floating
            // temporarily on top of it.
            .foregroundStyle(colors.backgroundPrimary)
            .multilineTextAlignment(.leading)
            .padding(.horizontal, 10)
            .padding(.vertical, 6)
            .background(
                RoundedRectangle(cornerRadius: 8, style: .continuous)
                    .fill(colors.textPrimary)
            )

            TooltipCaret()
                .fill(colors.textPrimary)
                .frame(width: 11, height: 5)
        }
        .fixedSize()
        .shadow(color: .black.opacity(0.28), radius: 10, y: 3)
        // Grows out of the icon it belongs to, not out of thin air — and
        // never from scale 0, which nothing in the real world does.
        .transition(.opacity.combined(with: .scale(scale: 0.94, anchor: .bottom)))
        .allowsHitTesting(false)
    }
}

private extension View {
    func composerTooltip(_ title: String, detail: String? = nil, isHovered: Bool) -> some View {
        modifier(ComposerTooltip(title: title, detail: detail, isHovered: isHovered))
    }
}

private struct ComposerIconToggle: View {
    @Environment(\.themeColors) private var colors
    let icon: String
    let isOn: Bool
    /// Overrides the accent for a state that has to stand out on its own
    /// terms regardless of what accent the user picked.
    var accent: Color? = nil
    /// A tiny status dot on the icon's corner — used for "extension
    /// connected". Nil draws nothing.
    var status: Color? = nil
    /// Shown on hover. `title` names the control and its state; `detail` is
    /// the one short line that explains what turning it on actually does.
    let title: String
    var detail: String? = nil
    let action: () -> Void

    @State private var isHovered = false

    /// On takes the user's chosen accent — except when that accent is the
    /// default white, where a tint would be no tint at all, so plain
    /// full-strength text colour does the job instead.
    private var onColor: Color {
        if let accent { return accent }
        return AppearanceSettings.shared.accentColorId == "white"
            ? colors.textPrimary
            : AppearanceSettings.shared.accentColor
    }

    private var foreground: Color {
        if isOn { return onColor }
        return isHovered ? colors.textSecondary : colors.textTertiary
    }

    var body: some View {
        Button(action: action) {
            Image(systemName: icon)
                .font(.system(size: 15, weight: .regular))
                .foregroundStyle(foreground)
                .frame(width: 28, height: 28)
                // Colour says which state you're in; the fill says only
                // "the cursor is here". Keeping those two jobs on separate
                // channels is why neither has to be loud.
                .background(
                    RoundedRectangle(cornerRadius: 8, style: .continuous)
                        .fill(isHovered ? colors.backgroundHover : .clear)
                )
                .overlay(alignment: .bottomTrailing) {
                    if let status {
                        Circle()
                            .fill(status)
                            .frame(width: 6, height: 6)
                            // Punched out of the composer's own background so
                            // the dot reads as attached to the icon rather
                            // than as a stray speck beside it.
                            .overlay(Circle().stroke(colors.backgroundInput, lineWidth: 1.2))
                            .offset(x: -1, y: -1)
                    }
                }
                .contentShape(Rectangle())
        }
        .buttonStyle(PressableButtonStyle())
        .onHover { isHovered = $0 }
        // Colour only — animating the icon swap as well makes a one-shot
        // toggle look like it's thinking about it.
        .animation(.easeOut(duration: 0.14), value: isOn)
        .animation(.easeOut(duration: 0.12), value: isHovered)
        .composerTooltip(title, detail: detail, isHovered: isHovered)
    }
}

/// The coding Agent's Sandboxed/Auto permission toggle. Click it (or press
/// Shift+Tab) to cycle. A shield when Eaon asks before each command; an
/// amber bolt when it doesn't.
private struct AgentPermissionPill: View {
    let isAuto: Bool
    let action: () -> Void

    var body: some View {
        ComposerIconToggle(
            icon: isAuto ? "bolt" : "lock.shield",
            isOn: isAuto,
            // The only colour in the row, and only for the state where
            // Eaon acts without asking.
            accent: isAuto ? Color(hex: "#F59E0B") : nil,
            title: isAuto ? "Auto (Active)" : "Sandboxed",
            detail: isAuto
                ? "Runs commands without asking. ⇧⇥ to go back."
                : "Asks before each command. ⇧⇥ for Auto.",
            action: action
        )
    }
}

/// Eaon Work's Agent / Agent Swarm selector, beside the permission pill.
/// The permission pill says how the work is *run*; this one says how it's
/// *thought through*: Agent is one model working the task itself, Swarm
/// convenes a roster of specialists who argue the approach out first and hand
/// their conclusion to a synthesizer that builds it (see `AgentSwarmRunner`).
/// One person or a crowd — the icon is the whole message, so it needs no
/// tint to tell the two apart.
private struct AgentSwarmPill: View {
    let isSwarm: Bool
    let action: () -> Void

    var body: some View {
        ComposerIconToggle(
            icon: isSwarm ? "person.3" : "person",
            isOn: isSwarm,
            title: isSwarm ? "Swarm (Active)" : "Single Agent",
            detail: isSwarm
                ? "A team argues out the approach first. Slower."
                : "One model works the task directly.",
            action: action
        )
    }
}

/// "This message is about my browser."
///
/// It grants nothing — the browser tools are already available whenever Device
/// Control is on. What it removes is ambiguity: asked "summarise this", a model
/// otherwise has to guess between the open tab, a file, and its own knowledge,
/// and guessing wrong wastes a whole turn. Switching this on states the target
/// outright (see `ChatViewModel.browserModeInstruction`).
///
/// A globe, not a Chrome logo, for two reasons: shipping Google's trademarked
/// mark in a product is a legal question rather than a design one, and the
/// bridge drives Comet, Brave, Edge, Arc and Safari just as happily — badging
/// it "Chrome" would misdescribe what it does.
///
/// The corner dot reports whether the extension is actually connected right
/// now, so "can Eaon see my browser?" is answerable at a glance instead of by
/// sending a message and seeing what happens. It's drawn only while browser
/// mode is on — a connection indicator on a switch you haven't flipped is
/// answering a question nobody asked.
private struct BrowserPill: View {
    @Environment(\.themeColors) private var colors
    let isOn: Bool
    let action: () -> Void
    @State private var isConnected = BrowserBridge.shared.isConnected

    var body: some View {
        ComposerIconToggle(
            icon: "globe",
            isOn: isOn,
            // Amber, not grey, when it isn't connected: a grey dot on a grey
            // icon is an indicator you can't actually read, which is worse
            // than none — it looks like the state was reported when it
            // wasn't. Amber says "on, but check something" and matches what
            // the same colour means on the permission toggle.
            status: isOn ? (isConnected ? Color(hex: "#4ADE80") : Color(hex: "#F59E0B")) : nil,
            title: isOn ? "Browser (Active)" : "Browser",
            detail: isOn
                ? (isConnected
                   ? "This message is about your open tab."
                   : "Extension not connected. Falling back to AppleScript.")
                : "Tell Eaon this message is about your open tab.",
            action: action
        )
        // Polled rather than observed: the bridge infers connection from when
        // the extension last polled, so it changes on a timer, not on an event
        // anything could publish.
        .onReceive(Timer.publish(every: 5, on: .main, in: .common).autoconnect()) { _ in
            BrowserBridge.shared.refreshConnectionState()
            isConnected = BrowserBridge.shared.isConnected
        }
    }
}

private struct GrowingMessageField: View {
    @Environment(\.themeColors) private var colors
    @Binding var text: String
    var isFocused: FocusState<Bool>.Binding
    @Binding var height: CGFloat
    var onSend: () -> Void
    var onShiftTab: () -> Void = {}
    var placeholder: String = "Ask anything"

    static let minHeight: CGFloat = 46
    static let maxHeight: CGFloat = 220
    private let fontSize: CGFloat = 16

    var body: some View {
        GeometryReader { proxy in
            ZStack(alignment: .topLeading) {
                if text.isEmpty {
                    Text(placeholder)
                        .font(AppFont.sans(fontSize))
                        .foregroundColor(colors.textTertiary)
                        .padding(.horizontal, 6)
                        .padding(.vertical, 4)
                        .allowsHitTesting(false)
                }

                EnterToSendTextEditor(
                    text: $text,
                    isFocused: isFocused,
                    onSend: onSend,
                    onShiftTab: onShiftTab,
                    textColor: colors.textPrimary
                )
                .padding(.horizontal, 2)
                .padding(.vertical, 2)
            }
            .frame(height: height)
            .contentShape(Rectangle())
            .onTapGesture {
                AppFocus.activate()
                isFocused.wrappedValue = true
            }
            .onAppear { updateHeight(for: proxy.size.width) }
            .onChange(of: text) { _, _ in updateHeight(for: proxy.size.width) }
            .onChange(of: proxy.size.width) { _, newWidth in updateHeight(for: newWidth) }
        }
        .frame(height: height)
    }

    private func updateHeight(for width: CGFloat) {
        let measured = Self.height(for: text, width: width, fontSize: fontSize)
        withAnimation(.easeOut(duration: 0.12)) { height = measured }
    }

    private static func height(for text: String, width: CGFloat, fontSize: CGFloat) -> CGFloat {
        let horizontalInset: CGFloat = 12
        let usableWidth = max(width - horizontalInset, 120)
        let font = AppFont.sansNSFont(fontSize)
        let sample = text.isEmpty ? " " : text
        let rect = (sample as NSString).boundingRect(
            with: CGSize(width: usableWidth, height: .greatestFiniteMagnitude),
            options: [.usesLineFragmentOrigin, .usesFontLeading],
            attributes: [.font: font]
        )
        return min(max(minHeight, ceil(rect.height) + 8), maxHeight)
    }
}

private struct EnterToSendTextEditor: NSViewRepresentable {
    @Binding var text: String
    var isFocused: FocusState<Bool>.Binding
    var onSend: () -> Void
    var onShiftTab: () -> Void = {}
    var textColor: Color

    func makeNSView(context: Context) -> NSScrollView {
        let scrollView = NSScrollView()
        scrollView.drawsBackground = false
        scrollView.hasVerticalScroller = false
        scrollView.hasHorizontalScroller = false
        scrollView.borderType = .noBorder

        let textView = EnterSendingTextView()
        textView.delegate = context.coordinator
        textView.onSend = onSend
        textView.onShiftTab = onShiftTab
        configure(textView)

        scrollView.documentView = textView
        context.coordinator.textView = textView
        return scrollView
    }

    func updateNSView(_ scrollView: NSScrollView, context: Context) {
        guard let textView = context.coordinator.textView else { return }
        textView.onSend = onSend
        textView.onShiftTab = onShiftTab
        applyColors(to: textView)
        if textView.string != text { textView.string = text }
        if isFocused.wrappedValue, scrollView.window?.firstResponder != textView {
            scrollView.window?.makeFirstResponder(textView)
        }
    }

    func makeCoordinator() -> Coordinator {
        Coordinator(text: $text, isFocused: isFocused)
    }

    private func configure(_ textView: EnterSendingTextView) {
        textView.isRichText = false
        textView.importsGraphics = false
        textView.drawsBackground = false
        textView.backgroundColor = .clear
        textView.font = AppFont.sansNSFont(16)
        textView.textContainerInset = NSSize(width: 4, height: 4)
        // NSTextView adds a default 5pt lineFragmentPadding inside the text
        // container, so typed text (and the blinking caret) sit ~5pt to the
        // right of where the placeholder Text is drawn — the caret ends up
        // landing on top of the placeholder's first glyphs ("Ask …") instead
        // of just before them. Zeroing it makes the caret/first-character
        // origin (padding 2 + inset 4 = 6) line up exactly with the
        // placeholder's own leading padding (6), so the caret sits cleanly at
        // the start of the field. See GrowingMessageField's ZStack layout.
        textView.textContainer?.lineFragmentPadding = 0
        textView.isVerticallyResizable = true
        textView.isHorizontallyResizable = false
        textView.autoresizingMask = [.width]
        textView.textContainer?.widthTracksTextView = true
        textView.textContainer?.containerSize = NSSize(width: 0, height: CGFloat.greatestFiniteMagnitude)
        textView.string = text
        applyColors(to: textView)
    }

    private func applyColors(to textView: EnterSendingTextView) {
        let nsColor = NSColor(textColor)
        textView.textColor = nsColor
        textView.insertionPointColor = nsColor
    }

    final class Coordinator: NSObject, NSTextViewDelegate {
        @Binding var text: String
        var isFocused: FocusState<Bool>.Binding
        weak var textView: EnterSendingTextView?

        init(text: Binding<String>, isFocused: FocusState<Bool>.Binding) {
            _text = text
            self.isFocused = isFocused
        }

        func textDidChange(_ notification: Notification) {
            guard let textView = notification.object as? NSTextView else { return }
            text = textView.string
        }

        func textDidBeginEditing(_ notification: Notification) {
            isFocused.wrappedValue = true
        }
    }
}

private final class EnterSendingTextView: NSTextView {
    var onSend: (() -> Void)?
    /// Shift+Tab — cycles the coding Agent's Sandboxed/Auto permission
    /// state. A no-op closure outside Agent mode (the view model gates it),
    /// so it's safe to always intercept here.
    var onShiftTab: (() -> Void)?

    override func keyDown(with event: NSEvent) {
        let isReturnKey = event.keyCode == 36 || event.keyCode == 76
        if isReturnKey {
            if event.modifierFlags.contains(.shift) {
                insertNewline(nil)
            } else {
                onSend?()
            }
            return
        }
        // Tab (keyCode 48) with Shift held → permission toggle. Swallowed so
        // it never inserts a literal tab or moves focus.
        if event.keyCode == 48, event.modifierFlags.contains(.shift) {
            onShiftTab?()
            return
        }
        super.keyDown(with: event)
    }
}
