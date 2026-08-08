import SwiftUI

private struct SettingsCategory: Identifiable, Hashable {
    let id: String
    let title: String
    let icon: String
    /// Shows a small "BETA" pill next to this category in the sidebar —
    /// for a feature real enough to ship but new enough that "still
    /// stabilizing" is honest to say up front, not just implied.
    var isBeta: Bool = false
}

/// One labeled group in the settings sidebar — a small caps header (nil for
/// the leading group, which needs none) over its categories.
private struct SettingsSectionGroup {
    let title: String?
    let categories: [SettingsCategory]
}

/// The small caps header above a settings sidebar group — same visual
/// language as the "MODEL PROVIDERS" / "LOCAL" headers below it.
private struct SettingsSidebarSectionHeader: View {
    @Environment(\.themeColors) private var colors
    let title: String

    var body: some View {
        Text(title.uppercased())
            .font(AppFont.mono(10, weight: .semibold))
            .tracking(0.8)
            .foregroundColor(colors.textTertiary)
            .padding(.horizontal, 10)
            .padding(.top, 4)
            .padding(.bottom, 3)
            .frame(maxWidth: .infinity, alignment: .leading)
    }
}

/// A full-page settings destination — its own two-column layout (category
/// sub-sidebar + content pane) that fills the detail area next to the app's
/// main sidebar, exactly like the Models page. Not a modal: opening Settings
/// navigates here (`SidebarDestination.settings`) rather than dimming the
/// window behind a floating card, so the app's sidebar stays put and you
/// leave by clicking any other sidebar item (or pressing Esc).
struct SettingsRootView: View {
    @Environment(\.themeColors) private var colors
    @Bindable var chatViewModel: ChatViewModel
    @Bindable private var modelPrefs = ModelPreferencesStore.shared
    @Bindable private var customStore = CustomProviderStore.shared
    @Bindable private var localManager = LocalAIManager.shared
    @State private var selectedId: String
    @State private var isAddingProvider = false
    /// Called when the user presses Esc — lets the host (RootView) navigate
    /// back to the conversation surface, since a page has no "close" of its
    /// own the way the old modal did.
    var onExit: () -> Void = {}

    /// `initialSelectionId` lets a caller outside this view's own sidebar —
    /// e.g. the gear icon on a provider's group in the model picker — open
    /// Settings landed directly on that provider's page, instead of always
    /// starting on General.
    init(chatViewModel: ChatViewModel, initialSelectionId: String? = nil, onExit: @escaping () -> Void = {}) {
        self.chatViewModel = chatViewModel
        self._selectedId = State(initialValue: initialSelectionId ?? "general")
        self.onExit = onExit
    }

    /// The settings categories, grouped into labeled sections so the
    /// sidebar reads as a few short lists instead of one long crowded one.
    /// The first group is unlabeled (it leads the list, so a header there
    /// would just be redundant), the rest carry a small caps header in the
    /// same style as "MODEL PROVIDERS" / "LOCAL" further down.
    private let mainSections: [SettingsSectionGroup] = [
        .init(title: nil, categories: [
            .init(id: "general",    title: "General",     icon: "gearshape"),
            .init(id: "appearance", title: "Appearance",  icon: "paintpalette"),
            .init(id: "shortcuts",  title: "Shortcuts",   icon: "keyboard"),
        ]),
        .init(title: "Assistant", categories: [
            .init(id: "instructions",    title: "Custom Instructions", icon: "text.quote"),
            .init(id: "modelParameters", title: "Model Parameters",    icon: "slider.horizontal.3"),
            .init(id: "memory",          title: "Memory",              icon: "brain"),
            .init(id: "skills",          title: "Skills",              icon: "bolt.fill", isBeta: true),
            .init(id: "voice",           title: "Voice",               icon: "waveform", isBeta: true),
        ]),
        .init(title: "Tools", categories: [
            .init(id: "plugins",        title: "Plugins",         icon: "puzzlepiece.extension"),
            .init(id: "imageProviders", title: "Image Providers", icon: "photo"),
            .init(id: "computer",       title: "Device Control",  icon: "desktopcomputer", isBeta: true),
            .init(id: "localServer",    title: "Local API Server", icon: "server.rack", isBeta: true),
            .init(id: "network",        title: "Network",         icon: "network"),
        ]),
        .init(title: "System", categories: [
            // Next to Privacy on purpose: it's the one setting that decides
            // whether the user's data leaves this Mac at all, so it belongs
            // where someone goes looking for exactly that question.
            .init(id: "cloudSync",  title: "Cloud Sync", icon: "icloud", isBeta: true),
            .init(id: "privacy",    title: "Privacy",    icon: "lock.fill"),
            .init(id: "statistics", title: "Statistics", icon: "chart.bar"),
            .init(id: "hardware",   title: "Hardware",   icon: "cpu"),
        ]),
    ]

    private let providerCategories: [SettingsCategory] = [
        .init(id: "aqua", title: "Eaon API", icon: "drop.fill"),
    ]
    private let trialCategory = SettingsCategory(id: "trial", title: "Eaon Free Trial", icon: "gift.fill")

    private func customProviderSelectionId(_ config: CustomProviderConfig) -> String {
        "custom-provider:\(config.id.uuidString)"
    }

    private func config(for selectedId: String) -> CustomProviderConfig? {
        guard selectedId.hasPrefix("custom-provider:") else { return nil }
        let idString = String(selectedId.dropFirst("custom-provider:".count))
        return customStore.configs.first { $0.id.uuidString == idString }
    }

    // Named rather than inline closures below — a multi-statement inline
    // closure with two named arguments here previously tipped the whole
    // (already large) `body` expression over SwiftUI's type-checker
    // timeout, an unrelated-looking compile error dozens of lines away.
    private func finishAddingProvider() {
        isAddingProvider = false
    }

    private func switchToAquaFromAddProvider() {
        isAddingProvider = false
        selectedId = "aqua"
    }

    var body: some View {
        HStack(spacing: 0) {
            settingsSidebar
            settingsContent
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(colors.backgroundPrimary)
        .onExitCommand { onExit() }
        .sheet(isPresented: $isAddingProvider) {
            CustomProviderEditorSheet(
                chatViewModel: chatViewModel,
                existing: nil,
                onDone: finishAddingProvider,
                onWantsAqua: switchToAquaFromAddProvider
            )
        }
    }

    private var settingsSidebar: some View {
        VStack(alignment: .leading, spacing: 0) {
            Text("Settings")
                .font(AppFont.mono(20, weight: .bold))
                .foregroundColor(colors.textPrimary)
                .padding(.horizontal, 16)
                // Clears the window's title-bar band (this page renders under
                // it, same as the Models page) so the heading isn't tucked
                // up against the very top edge.
                .padding(.top, 50)
                .padding(.bottom, 12)

            // The provider brand list can run well past the window height
            // (every Aqua-served + BYOK brand gets its own row), so the nav
            // itself scrolls — only the title above stays put.
            ScrollView {
                VStack(alignment: .leading, spacing: 2) {
                    ForEach(Array(mainSections.enumerated()), id: \.offset) { index, section in
                        if let title = section.title {
                            SettingsSidebarSectionHeader(title: title)
                                // A little more air above a labeled group,
                                // less above the very first (unlabeled) one.
                                .padding(.top, index == 0 ? 0 : 14)
                        }
                        ForEach(section.categories) { cat in
                            SettingsSidebarRow(category: cat, isSelected: selectedId == cat.id)
                                .onTapGesture { selectedId = cat.id }
                        }
                    }
                }
                .padding(.horizontal, 8)

                modelProvidersSection
            }
        }
        .frame(width: 240)
        .background(colors.backgroundSidebar)
        .overlay(alignment: .trailing) {
            Rectangle()
                .fill(colors.borderSubtle)
                .frame(width: 1)
        }
    }

    @ViewBuilder
    private var settingsContent: some View {
        Group {
            switch selectedId {
            case "aqua":
                AquaProviderSettingsView(chatViewModel: chatViewModel)
            case "trial":
                TrialProviderSettingsView(chatViewModel: chatViewModel)
            case "statistics":
                StatisticsView(chatViewModel: chatViewModel)
            case "instructions":
                CustomInstructionsSettingsView(chatViewModel: chatViewModel)
            case "modelParameters":
                ModelParametersSettingsView()
            case "memory":
                MemorySettingsView(chatViewModel: chatViewModel)
            case "plugins":
                PluginsSettingsView()
            case "skills":
                SkillsSettingsView()
            case "voice":
                VoiceSettingsView()
            case "imageProviders":
                ImageProvidersSettingsView()
            case "computer":
                ComputerControlSettingsView()
            case "localServer":
                LocalAPIServerSettingsView()
            case "network":
                NetworkSettingsView()
            case "appearance":
                AppearanceSettingsView()
            case "shortcuts":
                ShortcutsSettingsView()
            case "cloudSync":
                CloudSyncSettingsView(chatViewModel: chatViewModel)
            case "privacy":
                PrivacySettingsView(chatViewModel: chatViewModel)
            case "hardware":
                HardwareSettingsView()
            default:
                if let config = config(for: selectedId) {
                    // `.id` forces SwiftUI to tear down and rebuild this
                    // view (including its @State) when the selected provider
                    // changes — without it, every custom provider hits this
                    // same `default` case at the same tree position, so
                    // SwiftUI reuses the previous provider's view instance
                    // and its stale `apiKeyInput`, leaking one provider's
                    // key into the next one's Save.
                    CustomProviderDetailSettingsView(chatViewModel: chatViewModel, config: config)
                        .id(config.id)
                } else if selectedId.hasPrefix("local:"),
                   let backend = LocalBackend(rawValue: String(selectedId.dropFirst("local:".count))) {
                    LocalProviderSettingsView(chatViewModel: chatViewModel, backend: backend)
                } else {
                    // Also the fallback for a deleted connection — e.g.
                    // removing this exact connection from its own detail
                    // page above leaves `selectedId` pointing at an id that
                    // no longer resolves.
                    GeneralSettingsView()
                }
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(colors.backgroundPrimary)
    }

    /// Pulled out of `card` as its own expression — inlined, this section
    /// (header + Aqua/BYOK/local rows) was enough on its own to tip
    /// SwiftUI's view-builder type-checker into "unable to type-check this
    /// expression in reasonable time," a timeout that surfaces as an
    /// unrelated-looking compile error somewhere else in the same giant
    /// expression rather than pointing at the actual cause.
    private var modelProvidersSection: some View {
        VStack(alignment: .leading, spacing: 2) {
            HStack {
                Text("MODEL PROVIDERS")
                    .font(AppFont.mono(10, weight: .semibold))
                    .foregroundColor(colors.textTertiary)
                    .tracking(0.8)
                Spacer()
                Button {
                    isAddingProvider = true
                } label: {
                    Image(systemName: "plus")
                        .font(.system(size: 11, weight: .semibold))
                        .foregroundColor(colors.textTertiary)
                        .iconHoverEffect(for: "plus")
                }
                .buttonStyle(.plain)
                .help("Add a custom provider")
            }
            .padding(.horizontal, 8)
            .padding(.top, 20)
            .padding(.bottom, 4)

            // Aqua isn't pre-added for a new install — it's one provider
            // option among several, not the app's default. It only earns
            // a permanent row once a key is actually saved; until then,
            // clicking "Add provider" opens the same neutral picker as
            // any other provider (not straight to an Aqua-branded page)
            // — Aqua is still reachable there as one of the picker's own
            // options, just not the thing you land on by default.
            if APIKeyStore.hasAPIKey {
                ForEach(providerCategories) { cat in
                    SettingsSidebarRow(category: cat, isSelected: selectedId == cat.id)
                        .onTapGesture { selectedId = cat.id }
                }
            } else {
                AddAquaRow { isAddingProvider = true }
            }

            // A genuinely separate row from "Eaon API" above, not folded
            // into it — gated strictly on `isActive` (not "ever held a
            // credential") so it disappears from here the moment the trial
            // ends, exactly like it does from the model picker.
            if TrialStore.shared.isActive {
                SettingsSidebarRow(category: trialCategory, isSelected: selectedId == trialCategory.id)
                    .onTapGesture { selectedId = trialCategory.id }
            }

            ForEach(customStore.sortedConfigs) { config in
                CustomProviderSidebarRow(
                    config: config,
                    isSelected: selectedId == customProviderSelectionId(config),
                    isEnabled: !modelPrefs.isProviderDisabled(.custom(config.id))
                )
                .onTapGesture { selectedId = customProviderSelectionId(config) }
            }

            Text("LOCAL")
                .font(AppFont.mono(10, weight: .medium))
                .foregroundColor(colors.textTertiary)
                .padding(.horizontal, 10)
                .padding(.top, 12)
                .padding(.bottom, 3)

            ForEach(LocalBackend.allCases) { backend in
                LocalBackendSidebarRow(
                    backend: backend,
                    isSelected: selectedId == "local:\(backend.rawValue)",
                    isInstalled: localManager.installed.contains(backend),
                    isActive: backend == .ollama
                        ? localManager.ollamaReachable
                        : localManager.activeSpawned?.backend == backend
                )
                .onTapGesture { selectedId = "local:\(backend.rawValue)" }
            }
        }
        .padding(.horizontal, 8)
        .padding(.bottom, 12)
    }
}

private struct SettingsSidebarRow: View {
    @Environment(\.themeColors) private var colors
    let category: SettingsCategory
    let isSelected: Bool

    var body: some View {
        // Nil — the plain monochrome look (the normal text colors below).
        // This used to be a per-section palette color in the old multicolor
        // accent mode; with a single monochrome accent there is no second
        // colorway to key off, and tinting every icon the same accent would
        // just be a louder version of the text color.
        let sectionColor: Color? = nil
        return HStack(spacing: 10) {
            Image(systemName: category.icon)
                .font(.system(size: 15, weight: .medium))
                .foregroundColor(sectionColor ?? (isSelected ? colors.textPrimary : colors.textSecondary))
                .iconHoverEffect(for: category.icon)
                .frame(width: 20, alignment: .center)

            Text(category.title)
                .font(AppFont.mono(13.5, weight: isSelected ? .semibold : .regular))
                .foregroundColor(colors.textPrimary)
                .lineLimit(1)

            if category.isBeta {
                BetaBadge()
            }

            Spacer()
        }
        .padding(.horizontal, 10)
        .padding(.vertical, 7)
        .background(
            RoundedRectangle(cornerRadius: 7, style: .continuous)
                .fill(isSelected ? colors.backgroundSelected : Color.clear)
        )
        .contentShape(Rectangle())
    }
}

/// A small "BETA" pill — same visual language as `ModelLibraryView`'s
/// fit-estimate badges (tinted capsule, tiny mono caps), reused here for
/// any settings category or page that isn't fully settled yet.
struct BetaBadge: View {
    var body: some View {
        Text("BETA")
            .font(AppFont.mono(9, weight: .bold))
            .tracking(0.4)
            .foregroundStyle(Color(hex: "#F59E0B"))
            .padding(.horizontal, 6)
            .padding(.vertical, 2)
            .background(Capsule().fill(Color(hex: "#F59E0B").opacity(0.14)))
    }
}

/// Shown instead of a permanent "Eaon API" row until a key is actually
/// saved — Aqua is offered, not pre-added, same as any other provider.
private struct AddAquaRow: View {
    @Environment(\.themeColors) private var colors
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            HStack(spacing: 10) {
                ZStack {
                    RoundedRectangle(cornerRadius: 6, style: .continuous)
                        .strokeBorder(colors.borderMedium, style: StrokeStyle(lineWidth: 1, dash: [3, 2]))
                        .frame(width: 26, height: 26)
                    Image(systemName: "plus")
                        .font(.system(size: 11, weight: .semibold))
                        .foregroundColor(colors.textTertiary)
                        .iconHoverEffect(for: "plus")
                }
                Text("Add provider")
                    .font(AppFont.mono(13, weight: .regular))
                    .foregroundColor(colors.textPrimary)
                Spacer()
            }
            .padding(.horizontal, 10)
            .padding(.vertical, 7)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .help("Eaon's free hosted models. Add a key to use it")
    }
}

/// A configured BYOK connection's row — real brand logo badge + company
/// name, plus a status dot matching the LOCAL section's own convention
/// (filled green when this connection is currently enabled).
private struct CustomProviderSidebarRow: View {
    @Environment(\.themeColors) private var colors
    @Bindable private var customStore = CustomProviderStore.shared
    let config: CustomProviderConfig
    let isSelected: Bool
    let isEnabled: Bool

    var body: some View {
        HStack(spacing: 10) {
            ProviderBadge(brand: config.brand, size: 24, customImage: customStore.logoImage(for: config))

            Text(config.displayName)
                .font(AppFont.mono(13, weight: isSelected ? .semibold : .regular))
                .foregroundColor(colors.textPrimary)

            Spacer()

            if isEnabled {
                Circle()
                    .fill(Color(hex: "#34C759"))
                    .frame(width: 7, height: 7)
                    .help("Enabled")
            }
        }
        .padding(.horizontal, 10)
        .padding(.vertical, 7)
        .background(
            RoundedRectangle(cornerRadius: 8, style: .continuous)
                .fill(isSelected ? colors.backgroundSelected : Color.clear)
        )
        .contentShape(Rectangle())
    }
}

/// A local backend's row (Ollama / Llama.cpp / MLX): tinted icon chip +
/// name + a status dot — filled when the backend is live, hollow when merely
/// installed, and the whole row dimmed when it isn't installed yet (still
/// clickable — its page is the install guide).
private struct LocalBackendSidebarRow: View {
    @Environment(\.themeColors) private var colors
    let backend: LocalBackend
    let isSelected: Bool
    let isInstalled: Bool
    let isActive: Bool

    var body: some View {
        HStack(spacing: 10) {
            Circle()
                .fill(backend.tint.opacity(0.16))
                .overlay(Circle().stroke(colors.borderSubtle, lineWidth: 1))
                .frame(width: 24, height: 24)
                .overlay {
                    Image(systemName: backend.systemIcon)
                        .font(.system(size: 10, weight: .semibold))
                        .foregroundStyle(backend.tint)
                }
                .opacity(isInstalled ? 1 : 0.45)

            Text(backend.displayName)
                .font(AppFont.mono(13, weight: isSelected ? .semibold : .regular))
                .foregroundColor(isInstalled ? colors.textPrimary : colors.textTertiary)

            Spacer()

            if isActive {
                Circle()
                    .fill(Color(hex: "#34C759"))
                    .frame(width: 7, height: 7)
                    .help("Running")
            }
        }
        .padding(.horizontal, 10)
        .padding(.vertical, 7)
        .background(
            RoundedRectangle(cornerRadius: 8, style: .continuous)
                .fill(isSelected ? colors.backgroundSelected : Color.clear)
        )
        .contentShape(Rectangle())
    }
}

struct SettingsCard<Content: View>: View {
    @Environment(\.themeColors) private var colors
    @ViewBuilder let content: Content

    var body: some View {
        content
            // Same fill as the page itself, not `backgroundElevated` (a
            // noticeably lighter grey shared with several non-Settings
            // surfaces — the composer, onboarding, the model picker — so
            // darkening it globally would ripple well beyond Settings).
            // Light mode already does exactly this: its card and page fill
            // are both pure white, separation coming from the border/shadow
            // alone — this brings dark mode's cards in line with that same
            // pattern instead of standing out as a distinct lighter slab.
            .background(colors.backgroundPrimary)
            .clipShape(RoundedRectangle(cornerRadius: 10, style: .continuous))
            .overlay(
                RoundedRectangle(cornerRadius: 10, style: .continuous)
                    .stroke(colors.borderMedium, lineWidth: 1)
            )
            .shadow(color: colors.shadowColor, radius: 6, y: 2)
    }
}
