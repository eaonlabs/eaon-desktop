import SwiftUI

/// A card listing chat models with the same per-model nickname/favorite/hide
/// controls as the Aqua API settings page — extracted so the per-brand
/// provider page can show the same actions for just that brand's models
/// without duplicating the nickname-editing sheet/alert logic.
struct ModelListCard: View {
    @Environment(\.themeColors) private var colors
    @Bindable var chatViewModel: ChatViewModel
    @Bindable private var modelPrefs = ModelPreferencesStore.shared

    let models: [APIModel]
    var title: String = "Models"
    /// Hidden model IDs offered in the "+" restore menu — scoped by the
    /// caller so a per-brand page only ever offers to restore models of
    /// that same brand, never a different one.
    var restorableHiddenIDs: [String] = []
    var showsRefresh: Bool = true

    @State private var editingModel: APIModel?
    @State private var nicknameDraft = ""
    @State private var modelPendingDeletion: APIModel?

    private var sortedModels: [APIModel] {
        models.sorted { $0.id.localizedCaseInsensitiveCompare($1.id) == .orderedAscending }
    }

    var body: some View {
        SettingsCard {
            VStack(alignment: .leading, spacing: 0) {
                header
                content
            }
        }
        .sheet(item: $editingModel) { model in
            ModelNicknameEditorSheet(
                modelId: model.id,
                nickname: $nicknameDraft,
                onSave: {
                    chatViewModel.setModelNickname(nicknameDraft, for: model.id)
                    editingModel = nil
                },
                onCancel: { editingModel = nil }
            )
        }
        // "Hide", not "Remove"/"Delete" — this flow ONLY takes the model
        // out of the picker (`hideModel` → `ModelPreferencesStore`); it
        // never deletes anything from disk. The old destructive-red
        // "Remove" read as real deletion, which for a local model meant a
        // user could "remove" gigabytes here and reasonably expect their
        // storage back — one of the live reports behind the
        // says-deleted-but-storage-unchanged confusion. Actually deleting
        // a local model lives in Settings → Models.
        .alert(
            "Hide this model?",
            isPresented: Binding(
                get: { modelPendingDeletion != nil },
                set: { if !$0 { modelPendingDeletion = nil } }
            ),
            presenting: modelPendingDeletion
        ) { model in
            Button("Hide") {
                chatViewModel.hideModel(model.id)
                modelPendingDeletion = nil
            }
            Button("Cancel", role: .cancel) { modelPendingDeletion = nil }
        } message: { model in
            Text("\(model.id) will be hidden from the model picker. Nothing is deleted from this Mac. Restore it from the + menu, or delete a downloaded model for real in Settings → Models.")
        }
    }

    private var header: some View {
        HStack {
            Text(title)
                .font(.system(size: 14, weight: .semibold))
                .foregroundColor(colors.textPrimary)

            Spacer()

            HStack(spacing: 4) {
                if showsRefresh {
                    Button {
                        Task { await chatViewModel.fetchModels() }
                    } label: {
                        Image(systemName: "arrow.clockwise")
                            .font(.system(size: 13, weight: .medium))
                            .foregroundColor(colors.textSecondary)
                            .iconHoverEffect(for: "arrow.clockwise")
                            .frame(width: 28, height: 28)
                            .background(colors.backgroundInput)
                            .clipShape(RoundedRectangle(cornerRadius: 6, style: .continuous))
                    }
                    .buttonStyle(.plain)
                    .disabled(chatViewModel.isLoadingModels)
                    .help("Refresh models from API")
                }

                if !restorableHiddenIDs.isEmpty {
                    Menu {
                        ForEach(restorableHiddenIDs, id: \.self) { modelId in
                            Button(modelId) {
                                chatViewModel.restoreModel(modelId)
                            }
                        }
                    } label: {
                        Image(systemName: "plus")
                            .font(.system(size: 13, weight: .medium))
                            .foregroundColor(colors.textSecondary)
                            .iconHoverEffect(for: "plus")
                            .frame(width: 28, height: 28)
                            .background(colors.backgroundInput)
                            .clipShape(RoundedRectangle(cornerRadius: 6, style: .continuous))
                    }
                    .menuStyle(.borderlessButton)
                    .help("Restore removed models")
                }
            }
        }
        .padding(.horizontal, 16)
        .padding(.top, 16)
        .padding(.bottom, 12)
    }

    @ViewBuilder
    private var content: some View {
        if chatViewModel.isLoadingModels {
            HStack(spacing: 10) {
                ProgressView().controlSize(.small)
                Text("Loading models…")
                    .font(.system(size: 13))
                    .foregroundColor(colors.textSecondary)
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(.horizontal, 16)
            .padding(.bottom, 16)
        } else if sortedModels.isEmpty {
            Text("No models here yet.")
                .font(.system(size: 13))
                .foregroundColor(colors.textSecondary)
                .padding(.horizontal, 16)
                .padding(.bottom, 16)
        } else {
            VStack(spacing: 0) {
                ForEach(Array(sortedModels.enumerated()), id: \.element.id) { index, model in
                    if index > 0 {
                        Divider().padding(.leading, 16)
                    }
                    modelRow(model)
                }
            }
            .padding(.bottom, 4)
        }
    }

    private func modelRow(_ model: APIModel) -> some View {
        HStack(spacing: 10) {
            VStack(alignment: .leading, spacing: 2) {
                HStack(spacing: 6) {
                    Text(model.id)
                        .font(.system(size: 13, weight: .medium, design: .monospaced))
                        .foregroundColor(colors.textPrimary)

                    if ModelCatalog.supportsVision(for: model.id) {
                        Image(systemName: "eye")
                            .font(.system(size: 11, weight: .medium))
                            .foregroundColor(colors.textTertiary)
                            .help("Supports vision")
                    }
                }

                Text(rowSubtitle(for: model))
                    .font(.system(size: 11))
                    .foregroundColor(modelPrefs.nickname(for: model.id) != nil ? colors.textSecondary : colors.textTertiary)
            }

            Spacer()

            HStack(spacing: 2) {
                Button {
                    modelPrefs.toggleFavorite(model.id)
                } label: {
                    Image(systemName: modelPrefs.isFavorite(model.id) ? "star.fill" : "star")
                        .font(.system(size: 13))
                        .foregroundColor(modelPrefs.isFavorite(model.id) ? .yellow : colors.textSecondary)
                        .iconHoverEffect(for: "star")
                        .frame(width: 28, height: 28)
                }
                .buttonStyle(.plain)
                .help(modelPrefs.isFavorite(model.id) ? "Remove from favorites" : "Add to favorites")

                Button {
                    nicknameDraft = modelPrefs.nickname(for: model.id) ?? defaultCatalogName(for: model)
                    editingModel = model
                } label: {
                    Image(systemName: "square.and.pencil")
                        .font(.system(size: 13))
                        .foregroundColor(colors.textSecondary)
                        .iconHoverEffect(for: "square.and.pencil")
                        .frame(width: 28, height: 28)
                }
                .buttonStyle(.plain)
                .help("Edit nickname")

                Button {
                    modelPendingDeletion = model
                } label: {
                    Image(systemName: "trash")
                        .font(.system(size: 13))
                        .foregroundColor(colors.textSecondary)
                        .iconHoverEffect(for: "trash")
                        .frame(width: 28, height: 28)
                }
                .buttonStyle(.plain)
                .help("Remove from list")
            }
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 10)
    }

    private func rowSubtitle(for model: APIModel) -> String {
        if let nickname = modelPrefs.nickname(for: model.id) {
            return nickname
        }
        let defaultName = defaultCatalogName(for: model)
        return defaultName == model.id ? "No custom nickname" : defaultName
    }

    private func defaultCatalogName(for model: APIModel) -> String {
        EaonHostedModels.defaultDisplayName(for: model.id, apiName: model.name)
    }
}
