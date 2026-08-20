import AppKit
import SwiftUI
import UniformTypeIdentifiers

/// A single bring-your-own-key connection's own full settings page — laid
/// out exactly like `AquaProviderSettingsView` (header card, then API key,
/// then Models) so every provider looks and behaves the same regardless of
/// whether it's Aqua or something the user configured themselves. This
/// bypasses Aqua entirely for the model IDs it lists, hitting that
/// provider's own endpoint with its own key.
struct CustomProviderDetailSettingsView: View {
    @Environment(\.themeColors) private var colors
    @Bindable var chatViewModel: ChatViewModel
    @Bindable private var store = CustomProviderStore.shared
    @Bindable private var modelPrefs = ModelPreferencesStore.shared
    let config: CustomProviderConfig

    @State private var apiKeyInput = ""
    @State private var isSaving = false
    @State private var saveMessage: String?
    @State private var saveFailed = false

    @State private var isFetchingModels = false
    @State private var fetchError: String?

    @State private var editingModelId: String?
    @State private var nicknameDraft = ""
    @State private var modelIdPendingDeletion: String?
    @State private var showingRemoveConnection = false
    @State private var showingAdvancedEdit = false

    // "White" as an accent reads fine as a fill, but as bare text on this
    // page's own background it can vanish in light mode — fall back to the
    // normal readable text color for that one option. Mirrors Eaon's page.
    private var confirmationTextColor: Color {
        colors.textPrimary
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            Text(config.displayName)
                .font(AppFont.mono(20, weight: .bold))
                .foregroundColor(colors.textPrimary)
                .padding(.horizontal, 32)
                .padding(.top, 28)
                .padding(.bottom, 20)

            ScrollView {
                VStack(alignment: .leading, spacing: 16) {
                    providerCard
                    apiKeyCard
                    modelsCard
                    dangerZoneCard
                }
                .padding(.horizontal, 32)
                .padding(.bottom, 32)
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
        .background(colors.backgroundPrimary)
        .onAppear {
            // Mirrors Eaon's page: prefill the real stored key (SecureField
            // never displays it as plaintext) so Save is a harmless resave
            // when nothing changed, rather than "blank means keep current."
            apiKeyInput = store.apiKey(for: config.id) ?? ""
        }
        .sheet(isPresented: Binding(
            get: { editingModelId != nil },
            set: { if !$0 { editingModelId = nil } }
        )) {
            if let modelId = editingModelId {
                ModelNicknameEditorSheet(
                    modelId: modelId,
                    nickname: $nicknameDraft,
                    onSave: {
                        chatViewModel.setModelNickname(nicknameDraft, for: modelId)
                        editingModelId = nil
                    },
                    onCancel: { editingModelId = nil }
                )
            }
        }
        .sheet(isPresented: $showingAdvancedEdit) {
            CustomProviderEditorSheet(chatViewModel: chatViewModel, existing: config) {
                showingAdvancedEdit = false
            }
        }
        .alert(
            "Remove this model?",
            isPresented: Binding(
                get: { modelIdPendingDeletion != nil },
                set: { if !$0 { modelIdPendingDeletion = nil } }
            ),
            presenting: modelIdPendingDeletion
        ) { modelId in
            Button("Remove", role: .destructive) { removeModelId(modelId) }
            Button("Cancel", role: .cancel) { modelIdPendingDeletion = nil }
        } message: { modelId in
            Text("\(modelId) will be removed from this connection's model list. Type it back in manually, or refresh to fetch it again, any time.")
        }
        .alert(
            "Remove this connection?",
            isPresented: $showingRemoveConnection
        ) {
            Button("Remove", role: .destructive) {
                chatViewModel.removeCustomProvider(config.id)
            }
            Button("Cancel", role: .cancel) {}
        } message: {
            Text("This deletes the saved key and model list for \(config.displayName). Chats you already had with it are kept.")
        }
    }

    /// The real brand + base URL, shown as context under the connection's
    /// name only when a custom name actually replaces it there — otherwise
    /// the title already says the brand, and repeating it would be noise.
    private var providerSubtitle: String {
        let base = config.baseURL.isEmpty ? "No base URL set" : config.baseURL
        guard config.customName?.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty == false else { return base }
        return "\(config.brand.companyName) · \(base)"
    }

    private var currentLogoImage: NSImage? {
        store.logoImage(for: config)
    }

    /// Click to pick a replacement image; right-click for the option to
    /// go back to the brand's default. Mirrors the familiar "click your
    /// account picture to change it" pattern rather than adding a whole
    /// new row just for this.
    private var providerLogoPicker: some View {
        Button(action: pickLogo) {
            ZStack(alignment: .bottomTrailing) {
                ProviderBadge(brand: config.brand, size: 36, customImage: currentLogoImage)

                ZStack {
                    Circle().fill(colors.backgroundElevated)
                    Image(systemName: "pencil")
                        .font(.system(size: 8, weight: .bold))
                        .foregroundColor(colors.textSecondary)
                        .iconHoverEffect(for: "pencil")
                }
                .frame(width: 16, height: 16)
                .overlay(Circle().stroke(colors.borderSubtle, lineWidth: 1))
                .offset(x: 4, y: 4)
            }
        }
        .buttonStyle(.plain)
        .contextMenu {
            Button("Change Logo…", action: pickLogo)
            if config.customLogoFileName != nil {
                Button("Reset to Default", role: .destructive) {
                    store.setCustomLogo(fileName: nil, for: config.id)
                }
            }
        }
        .help("Change this connection's logo")
    }

    private func pickLogo() {
        let panel = NSOpenPanel()
        panel.allowedContentTypes = [.image]
        panel.allowsMultipleSelection = false
        panel.canChooseDirectories = false
        guard panel.runModal() == .OK, let url = panel.url else { return }
        guard let fileName = ProviderLogoStore.saveLogo(from: url, replacing: config.customLogoFileName, for: config.id) else { return }
        store.setCustomLogo(fileName: fileName, for: config.id)
    }

    private var providerCard: some View {
        SettingsCard {
            HStack(spacing: 12) {
                providerLogoPicker

                VStack(alignment: .leading, spacing: 4) {
                    Text(config.displayName)
                        .font(AppFont.mono(14, weight: .semibold))
                        .foregroundColor(colors.textPrimary)
                    Text(providerSubtitle)
                        .font(AppFont.mono(12))
                        .foregroundColor(colors.textSecondary)
                }

                Spacer()

                Toggle("", isOn: Binding(
                    get: { !modelPrefs.isProviderDisabled(.custom(config.id)) },
                    set: { _ in chatViewModel.toggleProvider(.custom(config.id)) }
                ))
                .toggleStyle(JanSwitchToggleStyle())
                .help(modelPrefs.isProviderDisabled(.custom(config.id))
                      ? "Turn \(config.displayName) back on"
                      : "Turn \(config.displayName) off. Only this connection, not Eaon or your other providers")
            }
            .padding(16)
        }
    }

    private var apiKeyCard: some View {
        SettingsCard {
            VStack(alignment: .leading, spacing: 12) {
                Text("API Key")
                    .font(AppFont.mono(14, weight: .semibold))
                    .foregroundColor(colors.textPrimary)

                Text("Your key stays on this device, saved in the app's own settings. It goes out only as an authorization header when you send a message.")
                    .font(AppFont.sans(12))
                    .foregroundColor(colors.textSecondary)
                    .fixedSize(horizontal: false, vertical: true)
                    .lineSpacing(3)

                HStack(spacing: 10) {
                    SecureField("Paste your \(config.brand.companyName) API key", text: $apiKeyInput)
                        .textFieldStyle(.plain)
                        .font(AppFont.mono(14))
                        .padding(.horizontal, 12)
                        .padding(.vertical, 9)
                        .background(colors.backgroundInput)
                        .clipShape(RoundedRectangle(cornerRadius: 8, style: .continuous))
                        .overlay(
                            RoundedRectangle(cornerRadius: 8, style: .continuous)
                                .stroke(colors.borderSubtle, lineWidth: 1)
                        )

                    AccentButton(title: "Save", isDisabled: isSaving) { saveAPIKey() }
                }

                if let saveMessage {
                    Text(saveMessage)
                        .font(.caption)
                        .foregroundColor(saveFailed ? colors.destructive : confirmationTextColor)
                }

                if store.apiKey(for: config.id) != nil {
                    Label("API key saved on this device", systemImage: "lock.fill")
                        .font(AppFont.mono(12))
                        .foregroundColor(colors.textTertiary)
                }
            }
            .padding(16)
        }
    }

    private var modelsCard: some View {
        SettingsCard {
            VStack(alignment: .leading, spacing: 0) {
                HStack {
                    Text("Models")
                        .font(AppFont.mono(14, weight: .semibold))
                        .foregroundColor(colors.textPrimary)

                    Spacer()

                    Button {
                        refreshModels()
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
                    .disabled(isFetchingModels)
                    .help("Fetch the current model list from \(config.displayName)")
                }
                .padding(.horizontal, 16)
                .padding(.top, 16)
                .padding(.bottom, 12)

                if isFetchingModels {
                    HStack(spacing: 10) {
                        ProgressView()
                            .controlSize(.small)
                        Text("Fetching models from \(config.displayName)…")
                            .font(AppFont.mono(14))
                            .foregroundColor(colors.textSecondary)
                    }
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(.horizontal, 16)
                    .padding(.bottom, 16)
                } else if let fetchError {
                    VStack(alignment: .leading, spacing: 8) {
                        Text("Could not fetch models")
                            .font(AppFont.mono(14, weight: .semibold))
                            .foregroundColor(colors.textPrimary)
                        Text(fetchError)
                            .font(AppFont.mono(12))
                            .foregroundColor(colors.textSecondary)
                        Button("Retry") { refreshModels() }
                            .buttonStyle(.bordered)
                    }
                    .padding(.horizontal, 16)
                    .padding(.bottom, 16)
                } else if config.trimmedModelIDs.isEmpty {
                    Text("No models listed yet. Refresh to fetch them, or add one from Advanced settings below.")
                        .font(AppFont.mono(14))
                        .foregroundColor(colors.textSecondary)
                        .padding(.horizontal, 16)
                        .padding(.bottom, 16)
                } else {
                    VStack(spacing: 0) {
                        ForEach(Array(config.trimmedModelIDs.enumerated()), id: \.element) { index, modelId in
                            if index > 0 {
                                Divider().padding(.leading, 16)
                            }
                            modelRow(modelId)
                        }
                    }
                    .padding(.bottom, 4)
                }
            }
        }
    }

    private func modelRow(_ modelId: String) -> some View {
        HStack(spacing: 10) {
            VStack(alignment: .leading, spacing: 2) {
                Text(modelId)
                    .font(AppFont.mono(14, weight: .medium))
                    .foregroundColor(colors.textPrimary)
                Text(rowSubtitle(for: modelId))
                    .font(AppFont.mono(12))
                    .foregroundColor(modelPrefs.nickname(for: modelId) != nil ? colors.textSecondary : colors.textTertiary)
            }

            Spacer()

            HStack(spacing: 2) {
                Button {
                    modelPrefs.toggleFavorite(modelId)
                } label: {
                    Image(systemName: modelPrefs.isFavorite(modelId) ? "star.fill" : "star")
                        .font(.system(size: 13))
                        .foregroundColor(modelPrefs.isFavorite(modelId) ? .yellow : colors.textSecondary)
                        .iconHoverEffect(for: "star")
                        .frame(width: 28, height: 28)
                }
                .buttonStyle(.plain)
                .help(modelPrefs.isFavorite(modelId) ? "Remove from favorites" : "Add to favorites")

                Button {
                    nicknameDraft = modelPrefs.nickname(for: modelId) ?? ""
                    editingModelId = modelId
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
                    modelIdPendingDeletion = modelId
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

    private var dangerZoneCard: some View {
        SettingsCard {
            HStack {
                VStack(alignment: .leading, spacing: 4) {
                    Button {
                        showingAdvancedEdit = true
                    } label: {
                        Text("Advanced connection settings")
                            .font(AppFont.mono(14, weight: .semibold))
                            .foregroundColor(colors.textPrimary)
                    }
                    .buttonStyle(.plain)
                    Text("Change the company, server address, or request format for this connection.")
                        .font(AppFont.sans(12))
                        .foregroundColor(colors.textSecondary)
                        .fixedSize(horizontal: false, vertical: true)
                        .lineSpacing(3)
                }

                Spacer()

                Button("Remove connection", role: .destructive) {
                    showingRemoveConnection = true
                }
                .buttonStyle(.bordered)
            }
            .padding(16)
        }
    }

    private func rowSubtitle(for modelId: String) -> String {
        modelPrefs.nickname(for: modelId) ?? "No custom nickname"
    }

    private func saveAPIKey() {
        isSaving = true
        saveMessage = nil
        saveFailed = false

        do {
            try store.save(config, apiKey: apiKeyInput)
            saveMessage = "API key saved."
            saveFailed = false
        } catch {
            saveMessage = error.localizedDescription
            saveFailed = true
            NSHapticFeedbackManager.defaultPerformer.perform(.generic, performanceTime: .default)
        }

        isSaving = false
    }

    private func removeModelId(_ modelId: String) {
        var updated = config
        updated.modelIDs.removeAll { $0.trimmingCharacters(in: .whitespaces) == modelId }
        try? store.save(updated, apiKey: "")
        modelIdPendingDeletion = nil
    }

    private func refreshModels() {
        guard let apiKey = store.apiKey(for: config.id), !apiKey.isEmpty else {
            fetchError = "No API key saved yet. Add one above first."
            return
        }
        isFetchingModels = true
        fetchError = nil
        Task {
            do {
                let ids = try await CustomProviderAPIService().fetchAvailableModels(
                    baseURL: config.baseURL,
                    format: config.format,
                    apiKey: apiKey
                )
                guard !ids.isEmpty else {
                    isFetchingModels = false
                    fetchError = "No models were returned."
                    return
                }
                var updated = config
                updated.modelIDs = ids.sorted()
                try? store.save(updated, apiKey: "")
                isFetchingModels = false
            } catch {
                isFetchingModels = false
                fetchError = error.localizedDescription
            }
        }
    }
}

// MARK: - Add / edit sheet

/// Deliberately non-technical: pick a company, paste a key, type the model
/// names — connection details (base URL + wire format) are chosen
/// automatically and only appear under "Advanced settings" for the rare
/// person who genuinely needs to override them.
struct CustomProviderEditorSheet: View {
    @Environment(\.themeColors) private var colors
    @Bindable var chatViewModel: ChatViewModel
    let existing: CustomProviderConfig?
    let onDone: () -> Void
    /// Only offered when adding a brand-new connection (nil while editing
    /// an existing one, where it wouldn't make sense) — Aqua isn't one of
    /// `sortedBrands` here (it's the app's own backend, not a BYOK
    /// connection), so this is its only way back for someone who opened
    /// this generic sheet but actually wanted Eaon's free hosted models.
    var onWantsAqua: (() -> Void)?

    @State private var brand: ProviderBrand
    @State private var customName: String
    @State private var baseURL: String
    @State private var format: APIRequestFormat
    @State private var modelIDsText: String
    @State private var apiKey: String = ""
    @State private var errorMessage: String?
    @State private var showAdvanced = false
    @State private var modelsFetchStatus: ModelsFetchStatus = .idle
    @State private var autoFetchTask: Task<Void, Never>?

    private enum ModelsFetchStatus: Equatable {
        case idle
        case fetching
        case succeeded(count: Int)
        case failed(String)
    }

    /// The curated, popular subset (see `byokPickerBrands`) — plus whichever
    /// brand this sheet was already opened for, even if it's outside that
    /// set (editing an existing niche-brand connection shouldn't make its
    /// own brand disappear from the picker).
    private var sortedBrands: [ProviderBrand] {
        var brands = Set(ProviderBrand.byokPickerBrands)
        if let existing {
            brands.insert(existing.brand)
        }
        return brands.sorted { $0.companyName.localizedCaseInsensitiveCompare($1.companyName) == .orderedAscending }
    }

    private var parsedModelIDs: [String] {
        modelIDsText
            .components(separatedBy: CharacterSet(charactersIn: ",\n"))
            .map { $0.trimmingCharacters(in: .whitespaces) }
            .filter { !$0.isEmpty }
    }

    /// Whether we can set up the connection for this brand without asking the
    /// user anything technical.
    private var hasAutoSetup: Bool {
        KnownProviderDefaults.baseURL(for: brand) != nil
    }

    private var recommendedFormat: APIRequestFormat {
        KnownProviderDefaults.format(for: brand)
    }

    private var canSave: Bool {
        !baseURL.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
            && !parsedModelIDs.isEmpty
            && (existing != nil || !apiKey.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
    }

    init(
        chatViewModel: ChatViewModel,
        existing: CustomProviderConfig?,
        onDone: @escaping () -> Void,
        onWantsAqua: (() -> Void)? = nil
    ) {
        self.chatViewModel = chatViewModel
        self.existing = existing
        self.onWantsAqua = onWantsAqua
        self.onDone = onDone
        let initialBrand = existing?.brand ?? .openAI
        _brand = State(initialValue: initialBrand)
        _customName = State(initialValue: existing?.customName ?? "")
        _baseURL = State(initialValue: existing?.baseURL ?? KnownProviderDefaults.baseURL(for: initialBrand) ?? "")
        _format = State(initialValue: existing?.format ?? KnownProviderDefaults.format(for: initialBrand))
        _modelIDsText = State(initialValue: (existing?.modelIDs ?? []).joined(separator: "\n"))
    }

    /// Debounced so it fires once typing settles rather than once per
    /// keystroke — cancels any fetch still in flight from an earlier edit.
    private func scheduleAutoFetch() {
        autoFetchTask?.cancel()
        let trimmedKey = apiKey.trimmingCharacters(in: .whitespacesAndNewlines)
        let trimmedURL = baseURL.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmedKey.isEmpty, !trimmedURL.isEmpty else {
            modelsFetchStatus = .idle
            return
        }
        let capturedFormat = format
        autoFetchTask = Task {
            try? await Task.sleep(for: .milliseconds(700))
            guard !Task.isCancelled else { return }
            await runFetch(baseURL: trimmedURL, format: capturedFormat, apiKey: trimmedKey)
        }
    }

    @MainActor
    private func runFetch(baseURL: String, format: APIRequestFormat, apiKey: String) async {
        modelsFetchStatus = .fetching
        do {
            let ids = try await CustomProviderAPIService().fetchAvailableModels(baseURL: baseURL, format: format, apiKey: apiKey)
            guard !Task.isCancelled else { return }
            guard !ids.isEmpty else {
                modelsFetchStatus = .failed("No models were returned. Add them manually below.")
                return
            }
            modelIDsText = ids.sorted().joined(separator: "\n")
            modelsFetchStatus = .succeeded(count: ids.count)
        } catch {
            guard !Task.isCancelled else { return }
            modelsFetchStatus = .failed("Couldn't fetch models automatically. \(error.localizedDescription)")
        }
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            VStack(alignment: .leading, spacing: 4) {
                Text(existing == nil ? "Add Custom Provider" : "Edit Custom Provider")
                    .font(AppFont.mono(16, weight: .semibold))
                    .foregroundColor(colors.textPrimary)
                Text("Pick the company and paste your key. Eaon fetches the models you have access to.")
                    .font(AppFont.sans(12))
                    .foregroundColor(colors.textSecondary)
                    .fixedSize(horizontal: false, vertical: true)
                    .lineSpacing(3)
                if let onWantsAqua {
                    Button(action: onWantsAqua) {
                        Text("Looking for Eaon's free hosted models instead?")
                            .font(AppFont.mono(12, weight: .medium))
                            .foregroundColor(colors.link)
                    }
                    .buttonStyle(.plain)
                    .padding(.top, 2)
                }
            }

            VStack(alignment: .leading, spacing: 6) {
                fieldLabel("Provider")
                BrandPickerDropdown(brands: sortedBrands, selection: $brand)
                    .onChange(of: brand) { _, newBrand in
                        // Refresh the auto-filled URL when it's still one of ours
                        // (empty, or a known default) — never clobber a URL the
                        // user typed themselves.
                        let current = baseURL.trimmingCharacters(in: .whitespacesAndNewlines)
                        if current.isEmpty || KnownProviderDefaults.allKnownBaseURLs.contains(current) {
                            baseURL = KnownProviderDefaults.baseURL(for: newBrand) ?? ""
                        }
                        format = KnownProviderDefaults.format(for: newBrand)
                        scheduleAutoFetch()
                    }
                if hasAutoSetup {
                    HStack(spacing: 5) {
                        Image(systemName: "checkmark.circle.fill")
                            .font(.system(size: 11))
                        Text("Connection details for \(brand.companyName) are set up automatically.")
                            .font(AppFont.mono(12))
                    }
                    .foregroundColor(colors.textTertiary)
                }
            }

            VStack(alignment: .leading, spacing: 6) {
                fieldLabel("Name (optional)")
                textField(brand.companyName, text: $customName)
                Text("What this connection is called in the model picker and its settings row. Leave blank to use \"\(brand.companyName)\".")
                    .font(AppFont.sans(12))
                    .foregroundColor(colors.textTertiary)
                    .fixedSize(horizontal: false, vertical: true)
                    .lineSpacing(3)
            }

            VStack(alignment: .leading, spacing: 6) {
                fieldLabel("API key")
                SecureField(existing == nil ? "Paste your \(brand.companyName) API key" : "Leave blank to keep current key", text: $apiKey)
                    .textFieldStyle(.plain)
                    .font(AppFont.mono(14))
                    .padding(.horizontal, 12)
                    .padding(.vertical, 9)
                    .background(colors.backgroundInput)
                    .clipShape(RoundedRectangle(cornerRadius: 8, style: .continuous))
                    .overlay(
                        RoundedRectangle(cornerRadius: 8, style: .continuous)
                            .stroke(colors.borderSubtle, lineWidth: 1)
                    )
                    .onChange(of: apiKey) { _, _ in scheduleAutoFetch() }
                Text("You get this from your \(brand.companyName) account (usually under \"API keys\"). It stays on this device only.")
                    .font(AppFont.sans(12))
                    .foregroundColor(colors.textTertiary)
                    .fixedSize(horizontal: false, vertical: true)
                    .lineSpacing(3)
            }

            VStack(alignment: .leading, spacing: 6) {
                HStack {
                    fieldLabel("Models")
                    Spacer()
                    Button {
                        autoFetchTask?.cancel()
                        let trimmedKey = apiKey.trimmingCharacters(in: .whitespacesAndNewlines)
                        let trimmedURL = baseURL.trimmingCharacters(in: .whitespacesAndNewlines)
                        guard !trimmedKey.isEmpty, !trimmedURL.isEmpty else { return }
                        Task { await runFetch(baseURL: trimmedURL, format: format, apiKey: trimmedKey) }
                    } label: {
                        HStack(spacing: 4) {
                            if modelsFetchStatus == .fetching {
                                ProgressView().controlSize(.small)
                            } else {
                                Image(systemName: "arrow.clockwise")
                                    .font(.system(size: 10, weight: .semibold))
                                    .iconHoverEffect(for: "arrow.clockwise")
                            }
                            Text("Fetch")
                                .font(AppFont.mono(12, weight: .medium))
                        }
                        .foregroundColor(colors.textSecondary)
                    }
                    .buttonStyle(.plain)
                    .disabled(modelsFetchStatus == .fetching || apiKey.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                    .help("Fetch the list of models this key can access")
                }
                ZStack(alignment: .topLeading) {
                    TextEditor(text: $modelIDsText)
                        .font(AppFont.mono(14))
                        .scrollContentBackground(.hidden)
                    if modelIDsText.isEmpty, let example = KnownProviderDefaults.exampleModelID(for: brand) {
                        Text(example)
                            .font(AppFont.mono(14))
                            .foregroundColor(colors.textTertiary.opacity(0.6))
                            .padding(.top, 1)
                            .padding(.leading, 5)
                            .allowsHitTesting(false)
                    }
                }
                .frame(height: 70)
                .padding(6)
                .background(colors.backgroundInput)
                .clipShape(RoundedRectangle(cornerRadius: 8, style: .continuous))
                .overlay(
                    RoundedRectangle(cornerRadius: 8, style: .continuous)
                        .stroke(colors.borderSubtle, lineWidth: 1)
                )
                modelsStatusView
                Text(modelsCaption)
                    .font(AppFont.sans(12))
                    .foregroundColor(colors.textTertiary)
                    .fixedSize(horizontal: false, vertical: true)
                    .lineSpacing(3)
            }

            if !hasAutoSetup {
                VStack(alignment: .leading, spacing: 6) {
                    fieldLabel("Server address")
                    textField("https://api.example.com/v1", text: $baseURL)
                        .onChange(of: baseURL) { _, _ in scheduleAutoFetch() }
                    Text("Where \(brand.companyName)'s API lives. Copy it from their API documentation. It usually starts with https:// and often ends with /v1.")
                        .font(AppFont.sans(12))
                        .foregroundColor(colors.textTertiary)
                        .fixedSize(horizontal: false, vertical: true)
                        .lineSpacing(3)
                }
            }

            advancedSection

            if let errorMessage {
                Text(errorMessage)
                    .font(AppFont.mono(12))
                    .foregroundColor(colors.destructive)
            }

            HStack {
                QuietButton(title: "Cancel", action: onDone)
                    .keyboardShortcut(.cancelAction)
                Spacer()
                AccentButton(title: "Save", isDisabled: !canSave) { save() }
                    .keyboardShortcut(.defaultAction)
            }
        }
        .padding(24)
        .frame(width: 440)
        .background(colors.backgroundPrimary)
    }

    @ViewBuilder
    private var modelsStatusView: some View {
        switch modelsFetchStatus {
        case .idle:
            EmptyView()
        case .fetching:
            HStack(spacing: 5) {
                ProgressView().controlSize(.small)
                Text("Fetching available models…")
                    .font(AppFont.mono(12))
                    .foregroundColor(colors.textTertiary)
            }
        case .succeeded(let count):
            HStack(spacing: 5) {
                Image(systemName: "checkmark.circle.fill")
                    .font(.system(size: 11))
                Text("Auto-filled \(count) model\(count == 1 ? "" : "s") from \(brand.companyName).")
                    .font(AppFont.mono(12))
            }
            .foregroundColor(colors.textTertiary)
        case .failed(let message):
            HStack(alignment: .top, spacing: 5) {
                Image(systemName: "exclamationmark.triangle.fill")
                    .font(.system(size: 11))
                Text(message)
                    .font(AppFont.mono(12))
                    .fixedSize(horizontal: false, vertical: true)
                    .lineSpacing(3)
            }
            .foregroundColor(colors.textTertiary)
        }
    }

    private var modelsCaption: String {
        if let example = KnownProviderDefaults.exampleModelID(for: brand) {
            return "Fetched automatically once your key is in. You can also type each model on its own line yourself, exactly as \(brand.companyName) names it (for example \"\(example)\")."
        }
        return "Fetched automatically once your key is in. You can also type each model on its own line yourself, exactly as \(brand.companyName) names it in their documentation."
    }

    // MARK: Advanced settings

    /// The technical knobs (server address override + wire format), tucked
    /// away so the main flow never requires understanding them.
    private var advancedSection: some View {
        VStack(alignment: .leading, spacing: 12) {
            Button {
                withAnimation(.easeOut(duration: 0.15)) { showAdvanced.toggle() }
            } label: {
                HStack(spacing: 5) {
                    Image(systemName: "chevron.right")
                        .font(.system(size: 9, weight: .semibold))
                        .rotationEffect(.degrees(showAdvanced ? 90 : 0))
                        .iconHoverEffect(for: "chevron.right")
                    Text("Advanced settings")
                        .font(AppFont.mono(12, weight: .medium))
                }
                .foregroundColor(colors.textSecondary)
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)

            if showAdvanced {
                VStack(alignment: .leading, spacing: 14) {
                    Text("Only change these if \(brand.companyName) gave you different connection details. The defaults work for almost everyone.")
                        .font(AppFont.sans(12))
                        .foregroundColor(colors.textTertiary)
                        .fixedSize(horizontal: false, vertical: true)
                        .lineSpacing(3)

                    if hasAutoSetup {
                        VStack(alignment: .leading, spacing: 6) {
                            fieldLabel("Server address (base URL)")
                            textField("https://api.example.com/v1", text: $baseURL)
                        }
                    }

                    VStack(alignment: .leading, spacing: 6) {
                        fieldLabel("Request format")
                        Picker("", selection: $format) {
                            ForEach(APIRequestFormat.allCases) { option in
                                Text(option == recommendedFormat ? "\(option.displayName) (recommended)" : option.displayName)
                                    .tag(option)
                            }
                        }
                        .labelsHidden()
                        Text(format.helpText)
                            .font(AppFont.sans(12))
                            .foregroundColor(colors.textTertiary)
                            .fixedSize(horizontal: false, vertical: true)
                            .lineSpacing(3)
                    }
                }
                .padding(12)
                .background(
                    RoundedRectangle(cornerRadius: 10, style: .continuous)
                        .fill(colors.backgroundSubtle)
                )
            }
        }
    }

    private func fieldLabel(_ text: String) -> some View {
        Text(text)
            .font(AppFont.mono(12, weight: .semibold))
            .foregroundColor(colors.textSecondary)
    }

    private func textField(_ placeholder: String, text: Binding<String>) -> some View {
        TextField(placeholder, text: text)
            .textFieldStyle(.plain)
            .font(AppFont.mono(14))
            .padding(.horizontal, 12)
            .padding(.vertical, 9)
            .background(colors.backgroundInput)
            .clipShape(RoundedRectangle(cornerRadius: 8, style: .continuous))
            .overlay(
                RoundedRectangle(cornerRadius: 8, style: .continuous)
                    .stroke(colors.borderSubtle, lineWidth: 1)
            )
    }

    private func save() {
        var config = existing ?? CustomProviderConfig(brand: brand, baseURL: baseURL, format: format, modelIDs: [])
        config.brand = brand
        let trimmedName = customName.trimmingCharacters(in: .whitespacesAndNewlines)
        config.customName = trimmedName.isEmpty ? nil : trimmedName
        config.baseURL = baseURL.trimmingCharacters(in: .whitespacesAndNewlines)
        config.format = format
        config.modelIDs = parsedModelIDs

        do {
            try chatViewModel.saveCustomProvider(config, apiKey: apiKey)
            onDone()
        } catch {
            errorMessage = error.localizedDescription
        }
    }
}

// MARK: - Brand picker

/// A logo-and-name dropdown for choosing a provider's brand — the real
/// mark next to the name, everywhere the plain-text native picker used to
/// be. Built custom instead of `Picker` specifically so the trigger and
/// every row can show `BrandLogoView`, which a native menu item can't.
private struct BrandPickerDropdown: View {
    @Environment(\.themeColors) private var colors
    let brands: [ProviderBrand]
    @Binding var selection: ProviderBrand
    @State private var isOpen = false
    @State private var isHovered = false

    var body: some View {
        Button {
            isOpen.toggle()
        } label: {
            HStack(spacing: 10) {
                RoundedRectangle(cornerRadius: 8, style: .continuous)
                    .fill(colors.backgroundSubtle)
                    .frame(width: 28, height: 28)
                    .overlay { BrandLogoView(brand: selection, size: 16) }

                Text(selection.companyName)
                    .font(AppFont.mono(14, weight: .medium))
                    .foregroundColor(colors.textPrimary)

                Spacer(minLength: 4)

                Image(systemName: "chevron.up.chevron.down")
                    .font(.system(size: 10, weight: .semibold))
                    .foregroundColor(colors.textTertiary)
                    .iconHoverEffect(for: "chevron.up.chevron.down")
            }
            .padding(.horizontal, 10)
            .padding(.vertical, 7)
            .background(isHovered ? colors.backgroundHover : colors.backgroundInput)
            .clipShape(RoundedRectangle(cornerRadius: 8, style: .continuous))
            .overlay(
                RoundedRectangle(cornerRadius: 8, style: .continuous)
                    .stroke(colors.borderSubtle, lineWidth: 1)
            )
            .contentShape(RoundedRectangle(cornerRadius: 8, style: .continuous))
        }
        .buttonStyle(PressableButtonStyle())
        .onHover { isHovered = $0 }
        .popover(isPresented: $isOpen, arrowEdge: .bottom) {
            BrandPickerList(brands: brands, selection: $selection, isOpen: $isOpen)
        }
    }
}

private struct BrandPickerList: View {
    @Environment(\.themeColors) private var colors
    let brands: [ProviderBrand]
    @Binding var selection: ProviderBrand
    @Binding var isOpen: Bool

    var body: some View {
        ScrollView {
            VStack(spacing: 2) {
                ForEach(brands, id: \.self) { brand in
                    BrandPickerRow(brand: brand, isSelected: brand == selection) {
                        selection = brand
                        isOpen = false
                    }
                }
            }
            .padding(6)
        }
        .frame(width: 280, height: min(CGFloat(brands.count) * 42 + 12, 340))
        .background(colors.backgroundPopover)
    }
}

private struct BrandPickerRow: View {
    @Environment(\.themeColors) private var colors
    let brand: ProviderBrand
    let isSelected: Bool
    let onSelect: () -> Void
    @State private var isHovered = false

    var body: some View {
        Button(action: onSelect) {
            HStack(spacing: 10) {
                RoundedRectangle(cornerRadius: 8, style: .continuous)
                    .fill(colors.backgroundSubtle)
                    .frame(width: 28, height: 28)
                    .overlay { BrandLogoView(brand: brand, size: 16) }

                Text(brand.companyName)
                    .font(AppFont.mono(14))
                    .foregroundColor(colors.textPrimary)
                    .lineLimit(1)

                Spacer(minLength: 4)

                if isSelected {
                    Image(systemName: "checkmark")
                        .font(.system(size: 11, weight: .semibold))
                        .foregroundColor(AppearanceSettings.shared.accentColor)
                }
            }
            .padding(.horizontal, 10)
            .padding(.vertical, 8)
            .background(isSelected ? colors.backgroundSelected : (isHovered ? colors.backgroundHover : .clear))
            .clipShape(RoundedRectangle(cornerRadius: 8, style: .continuous))
            .contentShape(RoundedRectangle(cornerRadius: 8, style: .continuous))
        }
        .buttonStyle(.plain)
        .onHover { isHovered = $0 }
    }
}
