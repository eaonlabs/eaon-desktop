import SwiftUI
import UniformTypeIdentifiers

/// Theme bridge for the floating panel — it lives outside `RootView`'s
/// window, so it injects the same `themeColors` environment RootView does,
/// reacting to Appearance changes exactly the same way.
struct QuickAssistantRootView: View {
    @Environment(\.colorScheme) private var systemScheme
    @Bindable private var appearance = AppearanceSettings.shared

    var body: some View {
        QuickAssistantPanelView()
            .environment(\.themeColors, ThemeColors.forScheme(appearance.theme.colorScheme ?? systemScheme))
            .preferredColorScheme(appearance.theme.colorScheme)
            .tint(appearance.accentColor)
    }
}

/// The floating "Ask Eaon" content — a compact input pill that expands
/// into a small chat panel on send (Gemini-desktop-style). Window sizing
/// and pill ↔ panel animation live in `DesktopAssistantController`; this
/// view just renders whichever state `QuickAssistantViewModel.isExpanded`
/// says it's in and asks the controller to switch.
struct QuickAssistantPanelView: View {
    @Environment(\.themeColors) private var colors
    @Bindable private var vm = QuickAssistantViewModel.shared
    @Bindable private var appearance = AppearanceSettings.shared
    @FocusState private var inputFocused: Bool

    @State private var showingModelPicker = false
    @State private var modelPickerSearchText = ""
    @State private var showingAttachMenu = false
    @State private var isPlusHovered = false
    @State private var isImageImporterPresented = false
    @State private var isFileImporterPresented = false

    var body: some View {
        Group {
            if vm.isExpanded {
                expandedPanel
            } else {
                pill
            }
        }
        .onExitCommand { DesktopAssistantController.shared.hidePanel() }
        .onReceive(NotificationCenter.default.publisher(for: DesktopAssistantController.focusInputNotification)) { _ in
            inputFocused = true
        }
        .onAppear {
            // Borderless non-activating panels need a beat before a SwiftUI
            // field can take first responder.
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.06) { inputFocused = true }
        }
        // Attached at the outer level, not inside `pill`/`footer`, so both
        // states (the "+" appears in each) can present the same importers.
        .fileImporter(
            isPresented: $isImageImporterPresented,
            allowedContentTypes: [.image],
            allowsMultipleSelection: false
        ) { handleImport($0, kind: .image) }
        .fileImporter(
            isPresented: $isFileImporterPresented,
            allowedContentTypes: [.item],
            allowsMultipleSelection: false
        ) { handleImport($0, kind: .file) }
    }

    private func handleImport(_ result: Result<[URL], Error>, kind: AttachmentKind) {
        switch result {
        case .success(let urls):
            guard let url = urls.first else { return }
            let accessed = url.startAccessingSecurityScopedResource()
            defer { if accessed { url.stopAccessingSecurityScopedResource() } }
            vm.addAttachment(from: url, kind: kind)
            // No room to preview a thumbnail in a 60pt pill — force-expand
            // so the picked attachment is actually visible before sending.
            if !vm.pendingAttachments.isEmpty {
                DesktopAssistantController.shared.setExpanded(true)
            }
        case .failure(let error):
            vm.composerNotice = error.localizedDescription
        }
    }

    // MARK: - Pill

    private var pill: some View {
        // A true capsule (radius = half the height, the CSS
        // `border-radius: 9999px` equivalent) — not a rounded rect.
        glassPanel(shape: Capsule(style: .continuous), intensity: .pill) {
            HStack(spacing: 10) {
                plusButton

                inputField

                modelNameButton

                sendButton
            }
            .padding(.horizontal, 20)
            .frame(maxWidth: .infinity, maxHeight: .infinity)
        }
    }

    // MARK: - Expanded panel

    private var expandedPanel: some View {
        glassPanel(shape: RoundedRectangle(cornerRadius: 20, style: .continuous), intensity: .panel) {
            VStack(spacing: 0) {
                header
                Divider().overlay(Color.white.opacity(0.08))
                transcriptList
                Divider().overlay(Color.white.opacity(0.08))
                footer
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)
        }
    }

    private var header: some View {
        HStack(spacing: 6) {
            PanelHeaderButton(systemName: "xmark", help: "Collapse") {
                DesktopAssistantController.shared.setExpanded(false)
            }
            Spacer()
            PanelHeaderButton(systemName: "square.and.pencil", help: "New chat") {
                vm.clear()
                DesktopAssistantController.shared.setExpanded(false)
            }
            PanelHeaderButton(systemName: "arrow.up.left.and.arrow.down.right", help: "Continue in Eaon") {
                DesktopAssistantController.shared.openMainApp(handOffTranscript: true)
            }
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 10)
    }

    private var transcriptList: some View {
        ScrollViewReader { proxy in
            ScrollView {
                LazyVStack(alignment: .leading, spacing: 14) {
                    ForEach(vm.transcript) { turn in
                        turnView(turn)
                    }
                    Color.clear.frame(height: 1).id("quick-bottom")
                }
                .padding(14)
            }
            .onChange(of: vm.transcript.last?.text) { _, _ in
                proxy.scrollTo("quick-bottom", anchor: .bottom)
            }
            .onChange(of: vm.transcript.count) { _, _ in
                proxy.scrollTo("quick-bottom", anchor: .bottom)
            }
        }
    }

    @ViewBuilder
    private func turnView(_ turn: QuickAssistantViewModel.QuickTurn) -> some View {
        if turn.isUser {
            HStack {
                Spacer(minLength: 40)
                VStack(alignment: .trailing, spacing: 8) {
                    if !turn.attachments.isEmpty {
                        MessageAttachmentsView(attachments: turn.attachments)
                    }
                    if !turn.text.isEmpty {
                        Text(turn.text)
                            .font(AppFont.sans(13))
                            .foregroundStyle(colors.textPrimary)
                            .multilineTextAlignment(.leading)
                            .textSelection(.enabled)
                            .padding(.horizontal, 12)
                            .padding(.vertical, 8)
                            .background(
                                RoundedRectangle(cornerRadius: 12, style: .continuous)
                                    .fill(appearance.coloredUserBubble ? appearance.accentColor.opacity(0.15) : colors.userBubble)
                            )
                    }
                }
            }
        } else if turn.isError {
            Text(turn.text)
                .font(AppFont.sans(12.5))
                .foregroundStyle(colors.destructive)
                .textSelection(.enabled)
        } else {
            // Same renderer the main chat uses — markdown, code blocks,
            // thinking disclosure, typing indicator, all of it.
            AssistantMessageContentView(
                text: turn.text,
                isTyping: vm.isStreaming && turn.id == vm.transcript.last?.id
            )
        }
    }

    private var footer: some View {
        VStack(spacing: 6) {
            if !vm.pendingAttachments.isEmpty {
                PendingAttachmentsBar(attachments: vm.pendingAttachments) { id in
                    vm.removePendingAttachment(id: id)
                }
            }
            if let notice = vm.composerNotice {
                Text(notice)
                    .font(AppFont.sans(11))
                    .foregroundStyle(.white.opacity(0.75))
                    .padding(.horizontal, 14)
                    .transition(.opacity)
            }

            HStack(spacing: 10) {
                plusButton
                inputField
                sendButton
            }
            .padding(.horizontal, 14)
            .padding(.top, 10)

            Text("Eaon can make mistakes. Check important info.")
                .font(AppFont.sans(10))
                // A step dimmer than the 0.85 body text on purpose — a
                // disclaimer at full brightness competes with the content.
                .foregroundStyle(.white.opacity(0.7))
                .padding(.bottom, 8)
        }
        .animation(.uiEaseOut(duration: 0.15), value: vm.composerNotice)
    }

    // MARK: - Shared pieces

    private var inputField: some View {
        TextField(
            "",
            text: $vm.inputText,
            // Explicit prompt styling — the system's default placeholder
            // grey goes near-invisible against the dark glass tint.
            prompt: Text("Ask \(vm.modelDisplayName)…").foregroundStyle(.white.opacity(0.5))
        )
        .textFieldStyle(.plain)
        .font(AppFont.sans(14))
        .foregroundStyle(.white.opacity(0.85))
        .focused($inputFocused)
        .onSubmit(submit)
    }

    @ViewBuilder
    private var sendButton: some View {
        if vm.isStreaming {
            Button {
                vm.stop()
            } label: {
                Image(systemName: "stop.fill")
                    .font(.system(size: 11, weight: .semibold))
                    .foregroundStyle(appearance.onAccentColor)
                    .frame(width: 28, height: 28)
                    .background(Circle().fill(appearance.accentColor))
            }
            .buttonStyle(.plain)
            .help("Stop")
        } else {
            Button(action: submit) {
                Image(systemName: "arrow.up")
                    .font(.system(size: 12, weight: .semibold))
                    .foregroundStyle(canSend ? AnyShapeStyle(appearance.onAccentColor) : AnyShapeStyle(.white.opacity(0.5)))
                    .iconHoverEffect(for: "arrow.up")
                    .frame(width: 28, height: 28)
                    // Idle state is the spec's "slightly elevated" white
                    // 0.08 chip, not an opaque theme grey that would punch
                    // a solid hole in the glass.
                    .background(Circle().fill(canSend ? AnyShapeStyle(appearance.accentColor) : AnyShapeStyle(.white.opacity(0.08))))
            }
            .buttonStyle(.plain)
            .disabled(!canSend)
            .help("Send")
        }
    }

    private var canSend: Bool {
        !vm.inputText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || !vm.pendingAttachments.isEmpty
    }

    private func submit() {
        guard canSend, !vm.isStreaming else { return }
        DesktopAssistantController.shared.setExpanded(true)
        vm.send()
    }

    /// The "+" attachment trigger — reuses the exact same
    /// `ComposerAttachmentMenu` the main chat composer shows, so "add a
    /// photo," "paste image," and the rest behave identically here. A
    /// small accent dot appears once something's queued, since the pill's
    /// 60pt height has no room to preview a thumbnail directly.
    private var plusButton: some View {
        Button {
            showingAttachMenu = true
        } label: {
            Image(systemName: "plus")
                .font(.system(size: 14, weight: .semibold))
                .foregroundStyle(.white.opacity(0.85))
                .iconHoverEffect(for: "plus")
                .frame(width: 26, height: 26)
                .background(Circle().fill(.white.opacity(isPlusHovered ? 0.08 : 0)))
                .overlay(alignment: .topTrailing) {
                    if !vm.pendingAttachments.isEmpty {
                        Circle()
                            .fill(appearance.accentColor)
                            .frame(width: 7, height: 7)
                    }
                }
        }
        .buttonStyle(.plain)
        .onHover { isPlusHovered = $0 }
        .help("Add photos & files")
        .popover(isPresented: $showingAttachMenu, arrowEdge: .top) {
            ComposerAttachmentMenu(
                onPickImage: { showingAttachMenu = false; isImageImporterPresented = true },
                onPickFile: { showingAttachMenu = false; isFileImporterPresented = true },
                onPasteImage: {
                    showingAttachMenu = false
                    vm.pasteImageAttachment()
                    if !vm.pendingAttachments.isEmpty {
                        DesktopAssistantController.shared.setExpanded(true)
                    }
                },
                onAttachScreen: {
                    showingAttachMenu = false
                    Task {
                        await vm.attachScreenCapture()
                        if !vm.pendingAttachments.isEmpty {
                            DesktopAssistantController.shared.setExpanded(true)
                        }
                    }
                }
            )
        }
    }

    /// The model name, tappable — reuses `ModelPickerPopoverContent`
    /// (widened from `private` in `ModelPickerPopover.swift` for exactly
    /// this) against the app's one real `ChatViewModel`
    /// (`QuickAssistantViewModel.chatViewModel`, wired once from
    /// `RootView`), so switching here is switching the *actual* app
    /// selection — same search, provider grouping, and local-model badges
    /// as the main composer's own picker, just behind a minimal glass-
    /// styled label instead of `ModelPickerMenu`'s boxed button.
    private var modelNameButton: some View {
        Button {
            showingModelPicker = true
        } label: {
            Text(vm.modelDisplayName)
                .font(AppFont.mono(11))
                .foregroundStyle(.white.opacity(0.85))
                .lineLimit(1)
                .truncationMode(.middle)
                .frame(maxWidth: 120)
        }
        .buttonStyle(.plain)
        .disabled(vm.chatViewModel == nil)
        .popover(isPresented: $showingModelPicker, arrowEdge: .bottom) {
            if let chatViewModel = vm.chatViewModel {
                ModelPickerPopoverContent(
                    viewModel: chatViewModel,
                    searchText: $modelPickerSearchText,
                    isExpanded: $showingModelPicker
                )
            }
        }
    }

    /// The two glass treatments in this panel, deliberately different —
    /// verified live against reference screenshots after the shared, lighter
    /// treatment both used before read as "too see-through" for the compact
    /// pill and not obscuring enough behind the expanded chat panel (the
    /// desktop pet was showing through as a sharp, distracting shape at 0.08
    /// tint). `pill` is a light touch — small, glanceable, most of what's
    /// behind it is just desktop. `panel` carries a lot of readable text
    /// over whatever's behind it (including the pet), so it leans hard into
    /// `.regular`'s own "adaptive, legibility-first, more opaque" design
    /// intent, with an extra dimming pass on top for real glass since
    /// `.tint(_:)` alone tops out short of "the desktop behind this should
    /// read as an indistinct blur."
    private enum GlassIntensity {
        case pill, panel

        var nativeTint: Color {
            switch self {
            case .pill: Color(red: 15.0 / 255, green: 22.0 / 255, blue: 42.0 / 255).opacity(0.30)
            case .panel: Color(red: 15.0 / 255, green: 22.0 / 255, blue: 42.0 / 255).opacity(0.62)
            }
        }

        /// Extra flat dimming layered ON TOP of the native glass (inside the
        /// same shape) — `.glassEffect`'s own tint biases toward staying
        /// "glass" rather than fully opaque, so pushing the panel the rest
        /// of the way to "all blurred" needs a second pass rather than a
        /// single more-extreme tint value.
        var extraDim: Color {
            switch self {
            case .pill: .clear
            case .panel: Color(red: 8.0 / 255, green: 10.0 / 255, blue: 16.0 / 255).opacity(0.30)
            }
        }

        var legacyTint: Color {
            switch self {
            case .pill: Color(red: 15.0 / 255, green: 22.0 / 255, blue: 42.0 / 255).opacity(0.34)
            case .panel: Color(red: 10.0 / 255, green: 12.0 / 255, blue: 20.0 / 255).opacity(0.66)
            }
        }
    }

    /// On macOS 26+, real system Liquid Glass — the same compositor-level
    /// material Control Center and the Dock use, not an approximation of
    /// it. That's what actually produces the reference's live refraction
    /// of whatever sits behind the panel and the light-catching specular
    /// edge: neither is reproducible by layering SwiftUI views, since both
    /// depend on the window server compositing against the desktop in real
    /// time. Below macOS 26 (this app's minimum is 14), `.glassEffect`
    /// doesn't exist, so a hand-rolled approximation stands in — see
    /// `legacyGlassBackground` for exactly what that's built from.
    ///
    /// Generic over shape so the collapsed pill can be a true `Capsule`
    /// while the expanded panel stays a rounded rectangle. Content is
    /// passed in (rather than applied as a `.background()`) because
    /// `glassEffect(_:in:)` clips and renders in one step — the same
    /// reason it replaces `.background(shape.fill(...))` entirely instead
    /// of layering underneath it.
    @ViewBuilder
    private func glassPanel<Content: View, S: InsettableShape>(shape: S, intensity: GlassIntensity, @ViewBuilder content: () -> Content) -> some View {
        if #available(macOS 26.0, *) {
            // `.regular`, not `.clear`: per Apple's own guidance `.regular`
            // is the adaptive, legibility-first glass most system chrome
            // (toolbars, sidebars, Control Center) uses, biasing toward
            // *more* opaque to protect contrast — matching what both
            // reference screenshots actually show far better than `.clear`,
            // which is meant for glass meant to stay mostly see-through.
            content()
                .glassEffect(.regular.tint(intensity.nativeTint), in: shape)
                .overlay(shape.fill(intensity.extraDim))
        } else {
            content()
                .background(legacyGlassBackground(in: shape, tint: intensity.legacyTint))
        }
    }

    /// The pre-26 approximation, translated from CSS to native layers:
    ///
    /// - Backdrop: `.ultraThinMaterial` — `NSVisualEffectView`-backed, so a
    ///   real ~30px-class backdrop blur *with* the vibrancy saturation boost
    ///   built into every macOS material (the `saturate(210%)` half of the
    ///   CSS `backdrop-filter` — not tunable by number in public API, but the
    ///   effect is the same mechanism, and it's exactly what keeps the blur
    ///   from going muddy). The *lightest* material on purpose: heavier ones
    ///   pile on their own grey luminosity layer, which fights the wallpaper
    ///   colors this is supposed to let bleed through.
    /// - Tint: slate-950, applied ONCE over the material — strength set by
    ///   `intensity.legacyTint` (pill vs. panel, see `GlassIntensity`).
    /// - Rim: 1px gradient hairline, white 0.18 → 0.06 top-to-bottom (the
    ///   CSS `border-image` gradient) — stands in for the real glass's
    ///   specular edge, which this fallback has no way to reproduce.
    ///
    /// The CSS spec's dual box-shadows are deliberately NOT drawn here: the
    /// glass fills its borderless window edge-to-edge, so any SwiftUI-drawn
    /// shadow would be clipped off invisibly at the window bounds. Depth
    /// comes from the panel's real window-server shadow instead
    /// (`hasShadow = true` in `DesktopAssistantController.ensurePanel`).
    private func legacyGlassBackground(in shape: some InsettableShape, tint: Color) -> some View {
        shape
            .fill(.ultraThinMaterial)
            .overlay(shape.fill(tint))
            .overlay(
                shape.strokeBorder(
                    LinearGradient(
                        colors: [.white.opacity(0.18), .white.opacity(0.06)],
                        startPoint: .top,
                        endPoint: .bottom
                    ),
                    lineWidth: 1
                )
            )
    }
}

/// Small icon button for the expanded panel's header row — white-on-glass
/// (theme text tokens assume the app's own solid backgrounds, not this
/// always-dark tint), with the spec's white-0.08 elevated hover chip.
private struct PanelHeaderButton: View {
    let systemName: String
    let help: String
    let action: () -> Void
    @State private var isHovered = false

    var body: some View {
        Button(action: action) {
            Image(systemName: systemName)
                .font(.system(size: 11, weight: .semibold))
                .foregroundStyle(.white.opacity(0.8))
                .iconHoverEffect(for: systemName)
                .frame(width: 26, height: 26)
                .background(
                    RoundedRectangle(cornerRadius: 7, style: .continuous)
                        .fill(.white.opacity(isHovered ? 0.08 : 0))
                )
        }
        .buttonStyle(.plain)
        .onHover { isHovered = $0 }
        .help(help)
    }
}
