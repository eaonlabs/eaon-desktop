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
                noticeBanner(icon: "key.fill", tint: .orange, text: "Set up a model provider in Settings to start chatting — Eaon, your own API key, or a local model.")
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
                if viewModel.messages.isEmpty {
                    ModeSegmentedControl(currentMode: viewModel.currentMode) { mode in
                        viewModel.enterMode(mode)
                        onModeChange(mode)
                    }
                    .transition(.opacity.combined(with: .scale(scale: 0.9, anchor: .leading)))
                }
                // The coding Agent's permission pill — unlike the mode
                // switcher, it stays visible during the conversation (you
                // toggle Sandboxed/Auto while coding, not just before).
                if viewModel.currentMode == .agent {
                    AgentPermissionPill(isAuto: viewModel.agentAutoRun) {
                        viewModel.requestAgentPermissionToggle()
                    }
                    .transition(.opacity.combined(with: .scale(scale: 0.9, anchor: .leading)))
                    // Agent vs. Agent Swarm — how the work gets thought
                    // through, next to the pill controlling how it gets run.
                    AgentSwarmPill(isSwarm: viewModel.agentSwarmEnabled) {
                        viewModel.agentSwarmEnabled.toggle()
                    }
                    .transition(.opacity.combined(with: .scale(scale: 0.9, anchor: .leading)))
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

/// The coding Agent's Sandboxed/Auto permission indicator, in the composer.
/// Tap it (or press Shift+Tab) to cycle. Light purple for the safe,
/// ask-before-each-command default; amber for the opted-into,
/// runs-without-asking Auto state. The colour shift alone signals which
/// state you're in at a glance — the same at-a-glance safety cue a code
/// editor's mode line gives.
private struct AgentPermissionPill: View {
    @Environment(\.themeColors) private var colors
    let isAuto: Bool
    let action: () -> Void
    @State private var isHovered = false

    private var tint: Color { isAuto ? Color(hex: "#F59E0B") : Color(hex: "#A78BFA") }
    private var label: String { isAuto ? "Auto" : "Sandboxed" }
    private var icon: String { isAuto ? "bolt.fill" : "lock.shield.fill" }

    var body: some View {
        Button(action: action) {
            HStack(spacing: 5) {
                Image(systemName: icon)
                    .font(.system(size: 10, weight: .semibold))
                    .iconHoverEffect(for: icon)
                Text(label)
                    .font(AppFont.mono(11, weight: .medium))
            }
            .foregroundStyle(tint)
            .padding(.horizontal, 10)
            .padding(.vertical, 6)
            .background(Capsule().fill(tint.opacity(isHovered ? 0.24 : 0.16)))
            .overlay(Capsule().stroke(tint.opacity(0.45), lineWidth: 1))
            .contentShape(Capsule())
        }
        .buttonStyle(PressableButtonStyle())
        .onHover { isHovered = $0 }
        .help(isAuto
            ? "Auto — Eaon runs commands and writes files without asking. Press ⇧⇥ to return to Sandboxed."
            : "Sandboxed — Eaon asks before each command. Press ⇧⇥ to switch to Auto.")
    }
}

/// Eaon Work's Agent / Agent Swarm selector, beside the permission pill.
/// The permission pill says how the work is *run*; this one says how it's
/// *thought through*: Agent is one model working the task itself, Swarm
/// convenes a roster of specialists who argue the approach out first and hand
/// their conclusion to a synthesizer that builds it (see `AgentSwarmRunner`).
/// Teal for the swarm so it never reads as a third permission state — the
/// safety cue stays purple/amber and means only one thing.
private struct AgentSwarmPill: View {
    @Environment(\.themeColors) private var colors
    let isSwarm: Bool
    let action: () -> Void
    @State private var isHovered = false

    private var tint: Color { isSwarm ? Color(hex: "#2DD4BF") : colors.textSecondary }
    private var label: String { isSwarm ? "Swarm" : "Agent" }
    private var icon: String { isSwarm ? "person.3.fill" : "person.fill" }

    var body: some View {
        Button(action: action) {
            HStack(spacing: 5) {
                Image(systemName: icon)
                    .font(.system(size: 10, weight: .semibold))
                    .iconHoverEffect(for: icon)
                Text(label)
                    .font(AppFont.mono(11, weight: .medium))
            }
            .foregroundStyle(tint)
            .padding(.horizontal, 10)
            .padding(.vertical, 6)
            .background(Capsule().fill(tint.opacity(isHovered ? 0.24 : 0.16)))
            .overlay(Capsule().stroke(tint.opacity(0.45), lineWidth: 1))
            .contentShape(Capsule())
        }
        .buttonStyle(PressableButtonStyle())
        .onHover { isHovered = $0 }
        .help(isSwarm
            ? "Agent Swarm — a team of specialists is convened for the task, argues out the approach, votes to hand off, and a synthesizer builds what they settled on. Slower and costs more calls. Click for plain Agent."
            : "Agent — one model works the task directly. Click to convene a swarm instead.")
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
