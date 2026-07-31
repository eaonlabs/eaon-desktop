import SwiftUI

/// The "Eaon Free Trial" settings page — a genuinely separate provider page
/// from `AquaProviderSettingsView`, not a card folded into it. Status
/// (not started / active / ended), the start button, and this provider's
/// own model list (`chatViewModel.trialModels`, already suffix-tagged —
/// every id here already carries `FreeWeekTrial.trialModelSuffix`, so
/// nickname/favorite/hide preferences are independent of the same model
/// under the "Eaon" page, exactly like two separate BYOK connections would
/// be). Only reachable while the trial is active or was at some point
/// (`TrialStore.shared.credential != nil`) — see `SettingsRootView`, which
/// stops offering this page's sidebar row once there's nothing left to show.
struct TrialProviderSettingsView: View {
    @Environment(\.themeColors) private var colors
    @Bindable var chatViewModel: ChatViewModel
    @Bindable private var modelPrefs = ModelPreferencesStore.shared
    @Bindable private var trial = TrialStore.shared

    @State private var editingModel: APIModel?
    @State private var nicknameDraft = ""
    @State private var modelPendingDeletion: APIModel?

    private var visibleModels: [APIModel] {
        chatViewModel.trialModels
            .filter { !modelPrefs.isHidden($0.id) }
            .sorted { $0.id.localizedCaseInsensitiveCompare($1.id) == .orderedAscending }
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            Text("Eaon Free Trial")
                .font(AppFont.mono(20, weight: .bold))
                .foregroundColor(colors.textPrimary)
                .padding(.horizontal, 32)
                .padding(.top, 28)
                .padding(.bottom, 20)

            ScrollView {
                VStack(alignment: .leading, spacing: 16) {
                    providerCard
                    statusCard
                    if trial.isActive {
                        modelsCard
                    }
                }
                .padding(.horizontal, 32)
                .padding(.bottom, 32)
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
        .background(colors.backgroundPrimary)
        .onAppear {
            AppFocus.activate()
            if trial.isActive, chatViewModel.trialModels.isEmpty, !chatViewModel.isLoadingModels {
                Task { await chatViewModel.fetchModels() }
            }
            // Fresh days-left/usage numbers whenever the page opens (also
            // how a server-side revocation gets noticed).
            if trial.isActive {
                Task { await trial.refreshStatus() }
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
                onCancel: {
                    editingModel = nil
                }
            )
        }
        .alert(
            "Remove model?",
            isPresented: Binding(
                get: { modelPendingDeletion != nil },
                set: { if !$0 { modelPendingDeletion = nil } }
            ),
            presenting: modelPendingDeletion
        ) { model in
            Button("Remove", role: .destructive) {
                chatViewModel.hideModel(model.id)
                modelPendingDeletion = nil
            }
            Button("Cancel", role: .cancel) {
                modelPendingDeletion = nil
            }
        } message: { model in
            Text("\(model.id) will be hidden from the model picker. You can restore it from the + menu in Models.")
        }
    }

    private var providerCard: some View {
        SettingsCard {
            HStack(spacing: 12) {
                AquaMark(size: 36)

                VStack(alignment: .leading, spacing: 4) {
                    Text("Eaon Free Trial")
                        .font(AppFont.mono(14, weight: .semibold))
                        .foregroundColor(colors.textPrimary)
                    Text("7 days of hosted models through Eaon's own gateway, independent of any API key you've saved")
                        .font(AppFont.mono(12))
                        .foregroundColor(colors.textSecondary)
                }

                Spacer()

                if trial.isActive {
                    Toggle("", isOn: Binding(
                        get: { !modelPrefs.isProviderDisabled(.trial) },
                        set: { _ in chatViewModel.toggleProvider(.trial) }
                    ))
                    .toggleStyle(.switch)
                    .tint(AppearanceSettings.toggleTint)
                    .help(modelPrefs.isProviderDisabled(.trial) ? "Turn the trial back on" : "Turn the trial off — every model it serves stops working")
                }
            }
            .padding(16)
        }
    }

    @ViewBuilder
    private var statusCard: some View {
        SettingsCard {
            VStack(alignment: .leading, spacing: 12) {
                HStack(spacing: 8) {
                    Text("Status")
                        .font(AppFont.mono(14, weight: .semibold))
                        .foregroundColor(colors.textPrimary)
                    if trial.isActive {
                        Text("\(trial.daysLeft) day\(trial.daysLeft == 1 ? "" : "s") left")
                            .font(AppFont.mono(10.5, weight: .semibold))
                            .foregroundColor(Color(hex: "#34C759"))
                            .padding(.horizontal, 7)
                            .padding(.vertical, 3)
                            .background(Capsule().fill(Color(hex: "#34C759").opacity(0.14)))
                    } else if trial.isExpired {
                        Text("Ended")
                            .font(AppFont.mono(10.5, weight: .semibold))
                            .foregroundColor(colors.textTertiary)
                            .padding(.horizontal, 7)
                            .padding(.vertical, 3)
                            .background(Capsule().fill(colors.backgroundChipSecondary))
                    }
                }

                if trial.isActive {
                    Text("Hosted models are on the house through \(trial.credential.map { Self.expiryFormatter.string(from: $0.expiresAt) } ?? "the end of the week")\(trialUsageSuffix). This keeps working even if you also have your own Eaon API key saved. Pick a model from this group to use the trial, or from \"Eaon\" to use your key. No account, no card, and no API key is ever stored in the app.")
                        .font(AppFont.sans(12))
                        .foregroundColor(colors.textSecondary)
                        .fixedSize(horizontal: false, vertical: true)
                        .lineSpacing(3)
                } else if trial.isExpired {
                    Text("Your free week has ended, so this provider and its models are gone from the picker. Your own Eaon API key, if you have one, still works. Add or manage it from the \"Eaon API\" page.")
                        .font(AppFont.sans(12))
                        .foregroundColor(colors.textSecondary)
                        .fixedSize(horizontal: false, vertical: true)
                        .lineSpacing(3)
                } else {
                    Text("Try every hosted model free for 7 days. One click, no account and no card, and it keeps working even after you add your own Eaon API key. The trial is tied to this Mac and runs through Eaon's own servers, so no API key is stored in the app.")
                        .font(AppFont.sans(12))
                        .foregroundColor(colors.textSecondary)
                        .fixedSize(horizontal: false, vertical: true)
                        .lineSpacing(3)

                    HStack {
                        AccentButton(
                            title: trial.isStarting ? "Starting…" : "Start Free Week",
                            isDisabled: trial.isStarting
                        ) {
                            Task {
                                await TrialStore.shared.start()
                                if TrialStore.shared.isActive {
                                    await chatViewModel.fetchModels()
                                    await TrialStore.shared.refreshStatus()
                                }
                            }
                        }
                        Spacer()
                    }

                    if let error = trial.lastError {
                        Text(error)
                            .font(AppFont.sans(11.5))
                            .foregroundColor(colors.destructive)
                            .fixedSize(horizontal: false, vertical: true)
                            .lineSpacing(3)
                    }
                }
            }
            .padding(16)
            .frame(maxWidth: .infinity, alignment: .leading)
        }
    }

    private var trialUsageSuffix: String {
        guard let used = trial.usage, let total = trial.totalRequests else { return "" }
        return " (\(used) of \(total) requests used)"
    }

    private static let expiryFormatter: DateFormatter = {
        let formatter = DateFormatter()
        formatter.dateStyle = .medium
        formatter.timeStyle = .none
        return formatter
    }()

    private var modelsCard: some View {
        SettingsCard {
            VStack(alignment: .leading, spacing: 0) {
                HStack {
                    Text("Models")
                        .font(AppFont.mono(14, weight: .semibold))
                        .foregroundColor(colors.textPrimary)
                    Spacer()
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
                .padding(.horizontal, 16)
                .padding(.top, 16)
                .padding(.bottom, 12)

                if chatViewModel.isLoadingModels {
                    HStack(spacing: 10) {
                        ProgressView().controlSize(.small)
                        Text("Loading models…")
                            .font(AppFont.mono(13))
                            .foregroundColor(colors.textSecondary)
                    }
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(.horizontal, 16)
                    .padding(.bottom, 16)
                } else if visibleModels.isEmpty {
                    Text("No models available.")
                        .font(AppFont.mono(13))
                        .foregroundColor(colors.textSecondary)
                        .padding(.horizontal, 16)
                        .padding(.bottom, 16)
                } else {
                    VStack(spacing: 0) {
                        ForEach(Array(visibleModels.enumerated()), id: \.element.id) { index, model in
                            if index > 0 {
                                Divider().padding(.leading, 16)
                            }
                            modelRow(model)
                        }
                    }
                    .padding(.bottom, 4)
                }
            }
        }
    }

    private func modelRow(_ model: APIModel) -> some View {
        HStack(spacing: 10) {
            VStack(alignment: .leading, spacing: 2) {
                HStack(spacing: 6) {
                    Text(FreeWeekTrial.strippingTrialSuffix(model.id))
                        .font(AppFont.mono(14, weight: .medium))
                        .foregroundColor(colors.textPrimary)

                    if ModelCatalog.supportsVision(for: model.id) {
                        Image(systemName: "eye")
                            .font(.system(size: 11, weight: .medium))
                            .foregroundColor(colors.textTertiary)
                            .help("Supports vision")
                    }
                }

                Text(rowSubtitle(for: model))
                    .font(AppFont.mono(12))
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
        return defaultName == FreeWeekTrial.strippingTrialSuffix(model.id) ? "No custom nickname" : defaultName
    }

    private func defaultCatalogName(for model: APIModel) -> String {
        EaonHostedModels.defaultDisplayName(for: model.id, apiName: model.name)
    }
}
