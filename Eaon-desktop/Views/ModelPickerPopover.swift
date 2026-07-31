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
                    // The logo alone only ever says who *made* the model —
                    // the same Meta/DeepSeek/etc. mark shows whether that
                    // model is running locally (Ollama/llama.cpp/MLX) or
                    // over Aqua/a BYOK connection like Groq. A dot answers
                    // the question the logo can't: is this staying on this
                    // Mac, or leaving it.
                    BrandLogoView(brand: ModelCatalog.brand(for: viewModel.selectedModel), size: 20)
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
            .padding(.leading, viewModel.selectedModel.isEmpty ? 14 : 8)
            .padding(.trailing, 12)
            .padding(.vertical, 7)
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
                .padding(.horizontal, 12)
                .padding(.top, 12)
                .padding(.bottom, 8)

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
        .frame(width: 340, height: 480)
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
        HStack(spacing: 8) {
            Image(systemName: "magnifyingglass")
                .font(.system(size: 13))
                .foregroundStyle(colors.textTertiary)
            TextField("Search models...", text: $searchText)
                .textFieldStyle(.plain)
                .font(AppFont.mono(14))
                .focused($isSearchFocused)
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 10)
        .background(colors.backgroundInputSecondary)
        .clipShape(RoundedRectangle(cornerRadius: 12, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: 12, style: .continuous).stroke(colors.borderSubtle, lineWidth: 1))
    }

    private var modelList: some View {
        ScrollView {
            LazyVStack(alignment: .leading, spacing: 0) {
                // Pinned favorites section
                if !favoriteModels.isEmpty {
                    FavoritesSectionHeader()
                    ForEach(favoriteModels) { model in
                        MinimalModelRow(model: model, isSelected: viewModel.selectedModel == model.id) {
                            viewModel.selectModel(model.id)
                            isExpanded = false
                        }
                    }
                    Divider().padding(.horizontal, 8).padding(.vertical, 6)
                }

                // Models running on this Mac (Ollama / llama.cpp / MLX)
                if !localModels.isEmpty {
                    LocalSectionHeader()
                    ForEach(localModels) { model in
                        MinimalModelRow(model: model, isSelected: viewModel.selectedModel == model.id) {
                            viewModel.selectModel(model.id)
                            isExpanded = false
                        }
                    }
                    Divider().padding(.horizontal, 8).padding(.vertical, 6)
                }

                // One group per real connection — its own logo, its own
                // name, a gear straight to its Settings page, and every
                // model it actually serves (regardless of who made it).
                // Clicking the header itself (not the gear) collapses it —
                // a pure browsing preference, persisted so it stays tidied
                // away next time too.
                ForEach(providerGroups) { group in
                    let isCollapsed = modelPrefs.isProviderGroupCollapsed(group.key)
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
                                .padding(.horizontal, 8)
                                .padding(.bottom, 8)
                        } else if group.models.isEmpty {
                            Text("No models configured yet.")
                                .font(AppFont.mono(12))
                                .foregroundStyle(colors.textTertiary)
                                .padding(.horizontal, 8)
                                .padding(.bottom, 8)
                        } else {
                            ForEach(group.models) { model in
                                MinimalModelRow(model: model, isSelected: viewModel.selectedModel == model.id) {
                                    viewModel.selectModel(model.id)
                                    isExpanded = false
                                }
                            }
                        }
                    }
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
                        MinimalModelRow(model: model, isSelected: viewModel.selectedModel == model.id) {
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
            Text("Loading models…").font(AppFont.mono(13)).foregroundStyle(colors.textSecondary)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }

    private func errorState(_ message: String) -> some View {
        VStack(spacing: 10) {
            Text("Could not load models").font(AppFont.mono(13, weight: .semibold))
            Text(message).font(AppFont.mono(12)).foregroundStyle(colors.textSecondary)
                .multilineTextAlignment(.center).padding(.horizontal, 24)
            AccentButton(title: "Retry") { Task { await viewModel.fetchModels() } }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }

    private var emptyCatalogState: some View {
        Text("No models available").font(AppFont.mono(13)).foregroundStyle(colors.textSecondary)
            .frame(maxWidth: .infinity, maxHeight: .infinity)
    }

    private var emptyState: some View {
        Text("No models match your search").font(AppFont.mono(13)).foregroundStyle(colors.textSecondary)
            .frame(maxWidth: .infinity, maxHeight: .infinity)
    }

    private func modelNameSort(_ lhs: APIModel, _ rhs: APIModel) -> Bool {
        (lhs.name ?? lhs.id).localizedCaseInsensitiveCompare(rhs.name ?? rhs.id) == .orderedAscending
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
                .font(AppFont.mono(13, weight: .semibold))
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
                .font(AppFont.mono(13, weight: .semibold))
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
                .font(AppFont.mono(13, weight: .semibold))
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

    var body: some View {
        ZStack(alignment: .trailing) {
            Button(action: onToggleCollapsed) {
                HStack(spacing: 8) {
                    ProviderBadge(brand: brand, size: 22, customImage: customLogo)
                        .opacity(isEnabled ? 1 : 0.45)

                    Text(title)
                        .font(AppFont.mono(14, weight: .semibold))
                        .foregroundStyle(isEnabled ? colors.textPrimary : colors.textTertiary)

                    Image(systemName: "chevron.right")
                        .font(.system(size: 9, weight: .semibold))
                        .foregroundStyle(colors.textTertiary)
                        .rotationEffect(.degrees(isCollapsed ? 0 : 90))
                        .iconHoverEffect(for: "chevron.right")

                    Spacer(minLength: 0)
                }
                .padding(.trailing, 30)
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .help(isCollapsed ? "Show \(title)'s models" : "Hide \(title)'s models")

            Button(action: onOpenSettings) {
                Image(systemName: "gearshape.fill")
                    .font(.system(size: 11, weight: .medium))
                    .foregroundStyle(colors.textSecondary)
                    .iconHoverEffect(for: "gearshape.fill")
                    .frame(width: 22, height: 22)
                    .background(colors.backgroundSubtle)
                    .clipShape(RoundedRectangle(cornerRadius: 6, style: .continuous))
            }
            .buttonStyle(.plain)
            .help("\(title) settings")
        }
        .padding(.horizontal, 8)
        .padding(.top, 14)
        .padding(.bottom, 6)
    }
}

private struct MinimalModelRow: View {
    @Environment(\.themeColors) private var colors
    @Bindable private var modelPrefs = ModelPreferencesStore.shared
    let model: APIModel
    let isSelected: Bool
    let onSelect: () -> Void

    @State private var isHovered = false
    private var isFav: Bool { modelPrefs.isFavorite(model.id) }

    private var displayName: String {
        modelPrefs.nickname(for: model.id)
            ?? ModelCatalog.displayName(modelId: model.id, apiName: model.name)
    }

    var body: some View {
        ZStack(alignment: .trailing) {
            Button(action: onSelect) {
                HStack(spacing: 10) {
                    RoundedRectangle(cornerRadius: 8, style: .continuous)
                        .fill(colors.backgroundSubtle)
                        .frame(width: 28, height: 28)
                        .overlay { BrandLogoView(brand: ModelCatalog.brand(for: model.id), size: 16) }

                    HStack(spacing: 6) {
                        Text(displayName)
                            .font(AppFont.mono(14))
                            .foregroundStyle(colors.textPrimary)
                            .lineLimit(1)
                        if ModelCatalog.supportsVision(for: model.id) { VisionIndicatorIcon(size: 13) }
                    }

                    Spacer(minLength: 4)

                    if model.tier?.lowercased() == "premium" {
                        Text("PRO")
                            .font(AppFont.mono(9, weight: .bold))
                            .foregroundStyle(colors.textSecondary)
                            .padding(.horizontal, 6).padding(.vertical, 3)
                            .background(colors.backgroundSubtle)
                            .clipShape(RoundedRectangle(cornerRadius: 5, style: .continuous))
                    }

                    // reserve space for star button
                    Color.clear.frame(width: 24)
                }
                .padding(.horizontal, 8)
                .padding(.vertical, 7)
                .background(
                    isSelected ? colors.backgroundSelected : (isHovered ? colors.backgroundHover : .clear)
                )
                .clipShape(RoundedRectangle(cornerRadius: 10, style: .continuous))
                .contentShape(RoundedRectangle(cornerRadius: 10, style: .continuous))
            }
            .buttonStyle(.plain)

            // Star button — always present when hovered or already favorited
            if isHovered || isFav {
                Button {
                    modelPrefs.toggleFavorite(model.id)
                } label: {
                    Image(systemName: isFav ? "star.fill" : "star")
                        .font(.system(size: 12, weight: .medium))
                        .foregroundStyle(isFav ? Color.yellow : colors.textTertiary)
                        .iconHoverEffect(for: "star")
                        .frame(width: 24, height: 24)
                }
                .buttonStyle(.plain)
                .padding(.trailing, 10)
            }
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
