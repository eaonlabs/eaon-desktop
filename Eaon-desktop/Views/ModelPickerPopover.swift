import AppKit
import SwiftUI

/// One real, switchable connection — Aqua, or a specific BYOK config —
/// together with every model *that connection* actually serves. This is
/// deliberately not grouped by who made the model: a single BYOK connection
/// like Groq serves models from many different companies (Meta's Llama,
/// Alibaba's Qwen, Moonshot's Kimi, and its own), so grouping by maker would
/// scatter one provider's whole lineup across unrelated sections instead of
/// showing what that provider itself is actually offering.
private struct ProviderGroup: Identifiable {
    let id: String
    let key: ModelProviderKey
    let settingsSelectionId: String
    let brand: ProviderBrand
    let title: String
    let isEnabled: Bool
    let models: [APIModel]
    var customLogo: NSImage? = nil
}

struct ModelPickerMenu: View {
    @Environment(\.themeColors) private var colors
    @Bindable var viewModel: ChatViewModel
    @Bindable private var modelPrefs = ModelPreferencesStore.shared
    var onOpenProviderSettings: (String) -> Void = { _ in }
    @State private var isExpanded = false
    @State private var searchText = ""

    private var selectedModelRecord: APIModel? {
        viewModel.chatModels.first { $0.id == viewModel.selectedModel }
    }

    private var selectedDisplayName: String {
        if viewModel.isLoadingModels {
            return "Loading models…"
        }
        if viewModel.selectedModel.isEmpty {
            return "Select a model"
        }
        if let custom = modelPrefs.nickname(for: viewModel.selectedModel) {
            return custom
        }
        return ModelCatalog.displayName(
            modelId: viewModel.selectedModel,
            apiName: selectedModelRecord?.name
        )
    }

    @State private var isHovered = false

    var body: some View {
        Button {
            isExpanded.toggle()
        } label: {
            HStack(spacing: 8) {
                if !viewModel.selectedModel.isEmpty {
                    // The same soft-tinted-circle badge the dropdown's own
                    // provider headers use (see `ProviderBadge`) — the
                    // closed pill and the open list read as one component
                    // wearing two states instead of two different pieces of
                    // chrome that just happen to sit near each other.
                    ProviderBadge(brand: ModelCatalog.brand(for: viewModel.selectedModel), size: 22)
                        .overlay(alignment: .bottomTrailing) {
                            if LocalAIManager.shared.owns(viewModel.selectedModel) {
                                Circle()
                                    .fill(Color(hex: "#34C759"))
                                    .frame(width: 7, height: 7)
                                    .overlay(Circle().stroke(colors.backgroundElevated, lineWidth: 1.5))
                                    .offset(x: 2, y: 2)
                            }
                        }
                        .help(LocalAIManager.shared.owns(viewModel.selectedModel) ? "Running locally on this Mac" : "Running in the cloud")
                }

                Text(selectedDisplayName)
                    .font(AppFont.mono(14, weight: .medium))
                    .foregroundStyle(colors.textPrimary)
                    .lineLimit(1)

                Image(systemName: "chevron.up.chevron.down")
                    .font(.system(size: 11, weight: .semibold))
                    .foregroundStyle(colors.textTertiary)
                    .iconHoverEffect(for: "chevron.up.chevron.down")
            }
            .padding(.leading, viewModel.selectedModel.isEmpty ? 14 : 6)
            .padding(.trailing, 12)
            .padding(.vertical, 6)
            .background(
                Capsule(style: .continuous)
                    .fill(isHovered ? colors.backgroundInputSecondary : colors.backgroundElevated)
            )
            .overlay(
                Capsule(style: .continuous)
                    .stroke(colors.borderSubtle, lineWidth: 1)
            )
            .contentShape(Capsule(style: .continuous))
        }
        .buttonStyle(PressableButtonStyle())
        .onHover { isHovered = $0 }
        // Uses allChatCapableModels (not chatModels) so the picker stays
        // reachable even if every provider is currently toggled off — you
        // need to be able to open it to turn one back on.
        .disabled(viewModel.isLoadingModels || viewModel.allChatCapableModels.isEmpty)
        .popover(isPresented: $isExpanded, arrowEdge: .bottom) {
            ModelPickerPopoverContent(
                viewModel: viewModel,
                searchText: $searchText,
                isExpanded: $isExpanded,
                onOpenProviderSettings: onOpenProviderSettings
            )
        }
        .fixedSize()
    }
}

/// Not private — reused as-is by the floating desktop assistant
/// (`QuickAssistantPanelView`), which wants the exact same search/provider-
/// grouping/local-model behavior behind its own minimal glass-styled
/// trigger rather than `ModelPickerMenu`'s full boxed button.
struct ModelPickerPopoverContent: View {
    @Environment(\.themeColors) private var colors
    @Bindable var viewModel: ChatViewModel
    @Bindable private var modelPrefs = ModelPreferencesStore.shared
    @Binding var searchText: String
    @Binding var isExpanded: Bool
    var onOpenProviderSettings: (String) -> Void = { _ in }
    @FocusState private var isSearchFocused: Bool

    private var query: String { searchText.trimmingCharacters(in: .whitespacesAndNewlines).lowercased() }

    private var favoriteModels: [APIModel] {
        guard query.isEmpty else { return [] }
        return viewModel.chatModels
            .filter { modelPrefs.isFavorite($0.id) }
            .sorted { $0.id.localizedCaseInsensitiveCompare($1.id) == .orderedAscending }
    }

    /// Models that run on this Mac (Ollama / llama.cpp / MLX) — shown as
    /// their own section rather than scattered across brand sections.
    private var localModels: [APIModel] {
        viewModel.allChatCapableModels.filter { model in
            guard LocalAIManager.shared.owns(model.id) else { return false }
            guard !query.isEmpty else { return true }
            let name = (model.name ?? model.id).lowercased()
            return name.contains(query) || model.id.lowercased().contains(query) || "local".contains(query)
        }
    }

    private var customConfigs: [CustomProviderConfig] {
        CustomProviderStore.shared.sortedConfigs
    }

    /// One group per real, switchable connection (Aqua, then every BYOK
    /// config in the order it was added) — each with every model *that
    /// connection* actually serves, not grouped by who made it. Built from
    /// the raw catalog (`allChatCapableModels`, not `chatModels`) so a
    /// switched-off connection's group still shows here — dimmed, with its
    /// gear still reachable — rather than vanishing along with the only way
    /// back to turning it on. Outside of an active search every connection
    /// shows regardless of model count, so a brand-new or empty BYOK config
    /// is still discoverable; during a search, an empty group just adds
    /// noise, so it's dropped like every other empty section already is.
    private var providerGroups: [ProviderGroup] {
        func matches(_ model: APIModel) -> Bool {
            guard !query.isEmpty else { return true }
            let name = (model.name ?? model.id).lowercased()
            let company = ModelCatalog.brand(for: model.id).companyName.lowercased()
            return name.contains(query) || model.id.lowercased().contains(query) || company.contains(query)
        }

        let served = viewModel.allChatCapableModels.filter { viewModel.providerKey(forModelId: $0.id) != nil }
        let grouped = Dictionary(grouping: served) { viewModel.providerKey(forModelId: $0.id)! }

        var groups: [ProviderGroup] = []

        let aquaModels = (grouped[.aqua] ?? []).filter(matches)
        if !viewModel.availableModels.filter(\.isChatModel).isEmpty, query.isEmpty || !aquaModels.isEmpty {
            groups.append(ProviderGroup(
                id: "aqua",
                key: .aqua,
                settingsSelectionId: "aqua",
                brand: .aqua,
                title: "Eaon",
                isEnabled: !modelPrefs.isProviderDisabled(.aqua),
                models: aquaModels.sorted(by: modelNameSort)
            ))
        }

        // Its own group, not folded into "Eaon" above — exists only while
        // there's an active trial (`viewModel.trialModels` is empty
        // otherwise), which is what makes it disappear everywhere the
        // moment the trial ends, with no separate expiry check needed here.
        let trialModelsForGroup = (grouped[.trial] ?? []).filter(matches)
        if !viewModel.trialModels.isEmpty, query.isEmpty || !trialModelsForGroup.isEmpty {
            groups.append(ProviderGroup(
                id: "trial",
                key: .trial,
                settingsSelectionId: "trial",
                brand: .aqua,
                title: "Eaon Free Trial",
                isEnabled: !modelPrefs.isProviderDisabled(.trial),
                models: trialModelsForGroup.sorted(by: modelNameSort)
            ))
        }

        for config in customConfigs {
            let key = ModelProviderKey.custom(config.id)
            let models = (grouped[key] ?? []).filter(matches)
            guard query.isEmpty || !models.isEmpty else { continue }
            groups.append(ProviderGroup(
                id: "custom:\(config.id.uuidString)",
                key: key,
                settingsSelectionId: "custom-provider:\(config.id.uuidString)",
                brand: config.brand,
                title: config.displayName,
                isEnabled: !modelPrefs.isProviderDisabled(key),
                models: models.sorted(by: modelNameSort),
                customLogo: CustomProviderStore.shared.logoImage(for: config)
            ))
        }

        return groups
    }

    /// Whether there's real content to show — `providerGroups` already
    /// includes a disabled connection's group (so it stays reachable) and
    /// already drops an empty group during an active search, so this can
    /// just check for emptiness directly.
    private var hasAnythingToShow: Bool {
        !providerGroups.isEmpty || !favoriteModels.isEmpty || !localModels.isEmpty
    }

    var body: some View {
        VStack(spacing: 0) {
            searchBar

            Divider().overlay(colors.borderSubtle)

            if viewModel.isLoadingModels {
                loadingState
            } else if let error = viewModel.modelsLoadError {
                errorState(error)
            } else if viewModel.allChatCapableModels.isEmpty {
                emptyCatalogState
            } else if !hasAnythingToShow {
                emptyState
            } else {
                modelList
            }
        }
        .frame(width: 340, height: Self.popoverHeight)
        .background(colors.backgroundPopover)
        .presentationBackground(colors.backgroundPopover)
        .onAppear {
            isSearchFocused = true
            if viewModel.allChatCapableModels.isEmpty && !viewModel.isLoadingModels {
                Task { await viewModel.fetchModels() }
            }
        }
    }

    private var searchBar: some View {
        // Flush against the popover's own edges, not a separate pill inset
        // inside it — no distinct fill, no border, no corner radius of its
        // own. It's the top of the box, not a control floating inside the
        // box, so the popover's own (system-provided) top corners are what
        // shape it; a Divider below is the only thing separating it from
        // the list. No leading glass icon either — the placeholder text
        // alone already reads as search.
        TextField("Search models...", text: $searchText)
            .textFieldStyle(.plain)
            .font(AppFont.mono(14))
            .focused($isSearchFocused)
            .padding(.horizontal, 16)
            .padding(.vertical, 14)
    }

    private var modelList: some View {
        ScrollView {
            LazyVStack(alignment: .leading, spacing: 0) {
                // Pinned favorites section — deliberately NOT a card: these
                // are pulled from across every provider, so there's no
                // single brand color to frame the box in, and a card with
                // no accent would look like a mistake next to the ones that
                // have one right below it.
                if !favoriteModels.isEmpty {
                    FavoritesSectionHeader()
                    ForEach(favoriteModels) { model in
                        MinimalModelRow(
                            model: model,
                            isSelected: viewModel.selectedModel == model.id,
                            accent: ModelCatalog.brand(for: model.id).accentColor
                        ) {
                            viewModel.selectModel(model.id)
                            isExpanded = false
                        }
                    }
                    Divider().padding(.horizontal, 8).padding(.vertical, 6)
                }

                // Models running on this Mac (Ollama / llama.cpp / MLX) —
                // same reasoning as Favorites: a mixed bag, no single card.
                if !localModels.isEmpty {
                    LocalSectionHeader()
                    ForEach(localModels) { model in
                        MinimalModelRow(
                            model: model,
                            isSelected: viewModel.selectedModel == model.id,
                            accent: ModelCatalog.brand(for: model.id).accentColor
                        ) {
                            viewModel.selectModel(model.id)
                            isExpanded = false
                        }
                    }
                    Divider().padding(.horizontal, 8).padding(.vertical, 6)
                }

                // One card per real connection — its own badge, its own
                // name, a gear straight to its Settings page, and every
                // model it actually serves (regardless of who made it).
                // Framed as a distinct container (not just a heading over a
                // run of rows) so "these all belong to this one connection"
                // is a shape you see, not a boundary you infer from a
                // hairline — the more that matters the more providers are
                // active at once. Clicking the header itself (not the gear)
                // collapses it, persisted so it stays tidied away next time.
                ForEach(providerGroups) { group in
                    let isCollapsed = modelPrefs.isProviderGroupCollapsed(group.key)
                    VStack(alignment: .leading, spacing: 2) {
                        ProviderGroupHeader(
                            brand: group.brand,
                            title: group.title,
                            isEnabled: group.isEnabled,
                            isCollapsed: isCollapsed,
                            customLogo: group.customLogo,
                            onToggleCollapsed: { modelPrefs.toggleProviderGroupCollapsed(group.key) },
                            onOpenSettings: {
                                isExpanded = false
                                onOpenProviderSettings(group.settingsSelectionId)
                            }
                        )
                        if !isCollapsed {
                            if !group.isEnabled {
                                Text("Turned off. Click the gear to turn it back on.")
                                    .font(AppFont.mono(12))
                                    .foregroundStyle(colors.textTertiary)
                                    .padding(.horizontal, 10)
                                    .padding(.bottom, 4)
                            } else if group.models.isEmpty {
                                Text("No models configured yet.")
                                    .font(AppFont.mono(12))
                                    .foregroundStyle(colors.textTertiary)
                                    .padding(.horizontal, 10)
                                    .padding(.bottom, 4)
                            } else {
                                ForEach(group.models) { model in
                                    // Tinted in the CONNECTION's own accent
                                    // (Groq's red, not each model's maker) —
                                    // it's the card's colour, so the
                                    // selected row inside it reads as
                                    // "highlighted within this card" rather
                                    // than an unrelated hue appearing.
                                    MinimalModelRow(
                                        model: model,
                                        isSelected: viewModel.selectedModel == model.id,
                                        accent: group.brand.accentColor
                                    ) {
                                        viewModel.selectModel(model.id)
                                        isExpanded = false
                                    }
                                }
                            }
                        }
                    }
                    .padding(8)
                    .background(
                        RoundedRectangle(cornerRadius: 14, style: .continuous)
                            .fill(colors.backgroundSubtle.opacity(0.6))
                    )
                    .overlay(
                        RoundedRectangle(cornerRadius: 14, style: .continuous)
                            .stroke(colors.borderSubtle, lineWidth: 1)
                    )
                    .padding(.bottom, 10)
                }

                // Image-generation models — a genuinely different
                // capability (one prompt in, one image out, no
                // conversation), kept as its own clearly-labeled section at
                // the end rather than folded into the regular provider
                // groups above, which are all chat models.
                if !viewModel.imageModels.isEmpty {
                    Divider().padding(.horizontal, 8).padding(.vertical, 6)
                    ImageGenerationSectionHeader()
                    ForEach(viewModel.imageModels) { model in
                        MinimalModelRow(
                            model: model,
                            isSelected: viewModel.selectedModel == model.id,
                            accent: ModelCatalog.brand(for: model.id).accentColor
                        ) {
                            viewModel.selectModel(model.id)
                            isExpanded = false
                        }
                    }
                }
            }
            .padding(.horizontal, 8)
            .padding(.bottom, 10)
        }
    }

    private var loadingState: some View {
        VStack(spacing: 12) {
            ProgressView().controlSize(.small)
            Text("Loading models…").font(AppFont.mono(14)).foregroundStyle(colors.textSecondary)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }

    private func errorState(_ message: String) -> some View {
        VStack(spacing: 10) {
            Text("Could not load models").font(AppFont.mono(14, weight: .semibold))
            Text(message).font(AppFont.mono(12)).foregroundStyle(colors.textSecondary)
                .multilineTextAlignment(.center).padding(.horizontal, 24)
            AccentButton(title: "Retry") { Task { await viewModel.fetchModels() } }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }

    private var emptyCatalogState: some View {
        Text("No models available").font(AppFont.mono(14)).foregroundStyle(colors.textSecondary)
            .frame(maxWidth: .infinity, maxHeight: .infinity)
    }

    private var emptyState: some View {
        Text("No models match your search").font(AppFont.mono(14)).foregroundStyle(colors.textSecondary)
            .frame(maxWidth: .infinity, maxHeight: .infinity)
    }

    private func modelNameSort(_ lhs: APIModel, _ rhs: APIModel) -> Bool {
        (lhs.name ?? lhs.id).localizedCaseInsensitiveCompare(rhs.name ?? rhs.id) == .orderedAscending
    }

    /// How tall the popover opens. It used to be a flat 480pt, which was
    /// fine for one or two connections and cramped the moment several were
    /// active — five local models plus two provider cards already filled it
    /// with nothing else visible, forcing a scroll to see connections that
    /// hadn't even loaded on screen yet.
    ///
    /// Scaled off the actual screen instead of a second fixed number, so it
    /// keeps making sense on a laptop panel and a large external display
    /// alike, and floored/capped so it's never cramped on a small screen or
    /// so tall on a big one that it reads as a separate window rather than
    /// a popover anchored to the model button.
    private static var popoverHeight: CGFloat {
        let visibleHeight = (NSScreen.main ?? NSScreen.screens.first)?.visibleFrame.height ?? 900
        return min(max(visibleHeight * 0.72, 480), 760)
    }
}

private struct FavoritesSectionHeader: View {
    @Environment(\.themeColors) private var colors
    var body: some View {
        HStack(spacing: 6) {
            Image(systemName: "star.fill")
                .font(.system(size: 11, weight: .semibold))
                .foregroundStyle(Color.yellow)
            Text("Favorites")
                .font(AppFont.mono(14, weight: .semibold))
                .foregroundStyle(colors.textSecondary)
            Spacer(minLength: 0)
        }
        .padding(.horizontal, 8)
        .padding(.top, 8)
        .padding(.bottom, 6)
    }
}

private struct ImageGenerationSectionHeader: View {
    @Environment(\.themeColors) private var colors
    var body: some View {
        HStack(spacing: 6) {
            Image(systemName: "photo")
                .font(.system(size: 11, weight: .semibold))
                .foregroundStyle(colors.textSecondary)
            Text("Image Generation")
                .font(AppFont.mono(14, weight: .semibold))
                .foregroundStyle(colors.textSecondary)
            Spacer(minLength: 0)
        }
        .padding(.horizontal, 8)
        .padding(.top, 8)
        .padding(.bottom, 6)
        .help("One prompt in, one image out. A different kind of model from the rest of this list")
    }
}

private struct LocalSectionHeader: View {
    @Environment(\.themeColors) private var colors
    var body: some View {
        HStack(spacing: 6) {
            Image(systemName: "laptopcomputer")
                .font(.system(size: 11, weight: .semibold))
                .foregroundStyle(colors.textSecondary)
            Text("On this Mac")
                .font(AppFont.mono(14, weight: .semibold))
                .foregroundStyle(colors.textSecondary)
            Spacer(minLength: 0)
        }
        .padding(.horizontal, 8)
        .padding(.top, 8)
        .padding(.bottom, 6)
        .help("These models run locally. No internet, no API key")
    }
}

/// A real connection's header in the browse list — real logo, name, and a
/// gear straight to that connection's own Settings page. Clicking anywhere
/// else on the row collapses/expands its model list, same outer-button +
/// overlaid-icon-button split `MinimalModelRow` already uses for its star,
/// so the gear's own tap takes precedence over the row's collapse toggle
/// rather than firing both. Dimmed (with no gear action needed to discover
/// *that* it's off — the row below already says so) when the connection
/// itself is currently switched off.
private struct ProviderGroupHeader: View {
    @Environment(\.themeColors) private var colors
    let brand: ProviderBrand
    let title: String
    let isEnabled: Bool
    let isCollapsed: Bool
    var customLogo: NSImage? = nil
    let onToggleCollapsed: () -> Void
    let onOpenSettings: () -> Void

    @State private var isHovered = false

    var body: some View {
        ZStack(alignment: .trailing) {
            Button(action: onToggleCollapsed) {
                HStack(spacing: 10) {
                    ProviderBadge(brand: brand, size: 26, customImage: customLogo)
                        .opacity(isEnabled ? 1 : 0.45)

                    Text(title)
                        .font(AppFont.mono(14, weight: .semibold))
                        .foregroundStyle(isEnabled ? colors.textPrimary : colors.textTertiary)

                    // Hidden until the row is hovered — the reference this
                    // was matched against has no visible affordance here at
                    // all, and a chevron sitting permanently between the
                    // name and the gear read as a second control competing
                    // with it. Collapsing is still one click away; it just
                    // doesn't have to announce itself all the time.
                    if isHovered {
                        Image(systemName: "chevron.right")
                            .font(.system(size: 9, weight: .semibold))
                            .foregroundStyle(colors.textTertiary)
                            .rotationEffect(.degrees(isCollapsed ? 0 : 90))
                    }

                    Spacer(minLength: 0)
                }
                .padding(.trailing, 36)
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .help(isCollapsed ? "Show \(title)'s models" : "Hide \(title)'s models")

            Button(action: onOpenSettings) {
                Image(systemName: "gearshape.fill")
                    .font(.system(size: 12, weight: .medium))
                    .foregroundStyle(colors.textSecondary)
                    .iconHoverEffect(for: "gearshape.fill")
                    .frame(width: 28, height: 28)
                    .background(colors.backgroundInputSecondary)
                    .clipShape(RoundedRectangle(cornerRadius: 8, style: .continuous))
            }
            .buttonStyle(.plain)
            .help("\(title) settings")
        }
        // Now sits inside the provider's own card, so it only needs the
        // small inset that separates it from the card's edge — the old
        // 14pt top gap was doing separation work the card now does instead.
        .padding(.horizontal, 6)
        .padding(.top, 4)
        .padding(.bottom, 6)
        .onHover { isHovered = $0 }
    }
}

private struct MinimalModelRow: View {
    @Environment(\.themeColors) private var colors
    @Bindable private var modelPrefs = ModelPreferencesStore.shared
    let model: APIModel
    let isSelected: Bool
    /// What tints the selected state — the connection's own brand color
    /// (Groq's red, not the model maker's) so the highlight reads as
    /// belonging to the card it's sitting in rather than an unrelated hue
    /// showing up. Falls back to a plain accent for the plain callers below.
    var accent: Color? = nil
    let onSelect: () -> Void

    @State private var isHovered = false
    private var isFav: Bool { modelPrefs.isFavorite(model.id) }
    private var tint: Color { accent ?? AppearanceSettings.shared.accentColor }

    private var displayName: String {
        modelPrefs.nickname(for: model.id)
            ?? ModelCatalog.displayName(modelId: model.id, apiName: model.name)
    }

    var body: some View {
        ZStack(alignment: .trailing) {
            Button(action: onSelect) {
                HStack(spacing: 8) {
                    // No per-model logo tile: inside a provider's own card
                    // that mark is already shown once, in the header — a
                    // second copy on every row is the same information
                    // charged twice, and it was crowding out the long ids
                    // ("…maverick-17b-128e-instruct") that are the thing
                    // actually distinguishing one row from the next.
                    Text(displayName)
                        .font(AppFont.mono(14))
                        .foregroundStyle(isSelected ? tint : colors.textPrimary)
                        .lineLimit(1)
                        .truncationMode(.middle)

                    if ModelCatalog.supportsVision(for: model.id) { VisionIndicatorIcon(size: 12) }

                    Spacer(minLength: 4)

                    if model.tier?.lowercased() == "premium" {
                        Text("PRO")
                            .font(AppFont.mono(9, weight: .bold))
                            .foregroundStyle(colors.textSecondary)
                            .padding(.horizontal, 6).padding(.vertical, 3)
                            .background(colors.backgroundSubtle)
                            .clipShape(RoundedRectangle(cornerRadius: 5, style: .continuous))
                    }

                    // Reserved so the trailing icons fading in on hover
                    // never reflow the name column.
                    Color.clear.frame(width: isFav ? 46 : 24)
                }
                .padding(.horizontal, 14)
                .padding(.vertical, 10)
                .background(
                    RoundedRectangle(cornerRadius: 9, style: .continuous)
                        .fill(isSelected ? tint.opacity(0.14) : (isHovered ? colors.backgroundHover : .clear))
                )
                .overlay(
                    RoundedRectangle(cornerRadius: 9, style: .continuous)
                        .stroke(isSelected ? tint.opacity(0.55) : .clear, lineWidth: 1)
                )
                .contentShape(RoundedRectangle(cornerRadius: 9, style: .continuous))
            }
            .buttonStyle(.plain)

            HStack(spacing: 2) {
                // Shown whenever it's on, not just on hover — a favourite
                // you can't see isn't doing its job.
                if isHovered || isFav {
                    Button {
                        modelPrefs.toggleFavorite(model.id)
                    } label: {
                        Image(systemName: isFav ? "star.fill" : "star")
                            .font(.system(size: 11.5, weight: .medium))
                            .foregroundStyle(isFav ? Color.yellow : colors.textTertiary)
                            .frame(width: 22, height: 22)
                            .contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                    .help(isFav ? "Remove from favourites" : "Add to favourites")
                }

                // The list's own housekeeping: most people use a handful of
                // models out of a provider's whole catalog, and this is how
                // the rest stop being scrolled past every time. Restoring
                // one lives in Settings → Models, named in the tooltip so
                // hiding never feels like a one-way door.
                if isHovered {
                    Button {
                        modelPrefs.hideModel(model.id)
                    } label: {
                        Image(systemName: "eye")
                            .font(.system(size: 11.5, weight: .medium))
                            .foregroundStyle(colors.textTertiary)
                            .frame(width: 22, height: 22)
                            .contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                    .help("Hide this model — bring it back in Settings → Models")
                }
            }
            .padding(.trailing, 6)
        }
        .onHover { isHovered = $0 }
    }
}

struct VisionIndicatorIcon: View {
    @Environment(\.themeColors) private var colors
    var size: CGFloat = 13

    var body: some View {
        Image(systemName: "eyeglasses")
            .font(.system(size: size, weight: .regular))
            .foregroundStyle(colors.textTertiary)
    }
}
