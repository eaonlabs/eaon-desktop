import SwiftUI

/// Settings → Image Providers — bring-your-own cloud image API keys and
/// local Stable Diffusion servers (Automatic1111 / DrawThings / ComfyUI in
/// compatible mode). Eaon's own hosted image models need nothing here —
/// they use the same Aqua key chat already does, and show up in the model
/// picker automatically.
struct ImageProvidersSettingsView: View {
    @Environment(\.themeColors) private var colors
    @Bindable private var store = ImageProviderStore.shared
    @State private var editingConfig: ImageProviderConfig?
    @State private var isAddingNew = false
    @State private var configPendingDeletion: ImageProviderConfig?

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            Text("Image Providers")
                .font(AppFont.mono(20, weight: .bold))
                .foregroundColor(colors.textPrimary)
                .padding(.horizontal, 32)
                .padding(.top, 28)
                .padding(.bottom, 8)

            Text("Eaon's own hosted image models (nanobanana, GPT Image, Ideogram, and others) work with no setup. They show up in the model picker's Image Generation section on their own. Add a connection here only for your own cloud image API key, or for a Stable Diffusion server already running on this Mac.")
                .font(AppFont.sans(12))
                .foregroundColor(colors.textSecondary)
                .fixedSize(horizontal: false, vertical: true)
                .lineSpacing(3)
                .padding(.horizontal, 32)
                .padding(.bottom, 20)

            ScrollView {
                VStack(alignment: .leading, spacing: 16) {
                    addCard
                    ForEach(store.sortedConfigs) { config in
                        configCard(config)
                    }
                }
                .padding(.horizontal, 32)
                .padding(.bottom, 32)
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
        .background(colors.backgroundPrimary)
        .sheet(isPresented: $isAddingNew) {
            ImageProviderEditorSheet(existing: nil) { isAddingNew = false }
        }
        .sheet(item: $editingConfig) { config in
            ImageProviderEditorSheet(existing: config) { editingConfig = nil }
        }
        .alert(
            "Remove this connection?",
            isPresented: Binding(
                get: { configPendingDeletion != nil },
                set: { if !$0 { configPendingDeletion = nil } }
            ),
            presenting: configPendingDeletion
        ) { config in
            Button("Remove", role: .destructive) {
                store.remove(config.id)
                configPendingDeletion = nil
            }
            Button("Cancel", role: .cancel) { configPendingDeletion = nil }
        } message: { config in
            Text("This deletes the saved key (if any) and model list for \(config.displayName).")
        }
    }

    private var addCard: some View {
        Button {
            isAddingNew = true
        } label: {
            HStack(spacing: 10) {
                Image(systemName: "plus.circle.fill")
                    .font(.system(size: 16))
                    .foregroundColor(AppearanceSettings.shared.accentColor)
                    .iconHoverEffect(for: "plus.circle.fill")
                Text("Add an image connection")
                    .font(AppFont.mono(14, weight: .medium))
                    .foregroundColor(colors.textPrimary)
                Spacer()
            }
            .padding(16)
        }
        .buttonStyle(.plain)
        .background(SettingsCard { Color.clear })
    }

    private func configCard(_ config: ImageProviderConfig) -> some View {
        SettingsCard {
            HStack(spacing: 12) {
                ZStack {
                    RoundedRectangle(cornerRadius: 8, style: .continuous)
                        .fill(colors.backgroundSubtle)
                        .frame(width: 32, height: 32)
                    Image(systemName: config.format == .automatic1111 ? "desktopcomputer" : "cloud")
                        .font(.system(size: 14, weight: .medium))
                        .foregroundColor(colors.textSecondary)
                }

                VStack(alignment: .leading, spacing: 3) {
                    Text(config.displayName)
                        .font(AppFont.mono(14, weight: .semibold))
                        .foregroundColor(colors.textPrimary)
                    Text("\(config.format.displayName) · \(config.trimmedModelIDs.count) model\(config.trimmedModelIDs.count == 1 ? "" : "s") · \(config.baseURL)")
                        .font(AppFont.mono(12))
                        .foregroundColor(colors.textTertiary)
                        .lineLimit(1)
                }

                Spacer(minLength: 8)

                Button {
                    editingConfig = config
                } label: {
                    Image(systemName: "pencil")
                        .font(.system(size: 12))
                        .foregroundColor(colors.textSecondary)
                        .iconHoverEffect(for: "pencil")
                        .frame(width: 26, height: 26)
                }
                .buttonStyle(.plain)
                .help("Edit")

                Button {
                    configPendingDeletion = config
                } label: {
                    Image(systemName: "trash")
                        .font(.system(size: 12))
                        .foregroundColor(colors.textSecondary)
                        .iconHoverEffect(for: "trash")
                        .frame(width: 26, height: 26)
                }
                .buttonStyle(.plain)
                .help("Remove")
            }
            .padding(14)
        }
    }
}

/// Add/edit sheet — deliberately simpler than the chat-provider editor
/// (`CustomProviderEditorSheet`): no discovery call, no advanced format
/// options, just what an image connection actually needs.
private struct ImageProviderEditorSheet: View {
    @Environment(\.themeColors) private var colors
    @Environment(\.dismiss) private var dismiss
    @Bindable private var store = ImageProviderStore.shared
    let existing: ImageProviderConfig?
    let onDone: () -> Void

    @State private var displayName = ""
    @State private var baseURL = ""
    @State private var format: ImageWireFormat = .openAICompatible
    @State private var modelIDsText = ""
    @State private var apiKeyInput = ""
    @State private var saveError: String?

    private var isEditing: Bool { existing != nil }

    private var modelIDs: [String] {
        modelIDsText
            .components(separatedBy: CharacterSet(charactersIn: ",\n"))
            .map { $0.trimmingCharacters(in: .whitespaces) }
            .filter { !$0.isEmpty }
    }

    private var canSave: Bool {
        !displayName.trimmingCharacters(in: .whitespaces).isEmpty
            && !baseURL.trimmingCharacters(in: .whitespaces).isEmpty
            && !modelIDs.isEmpty
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            Text(isEditing ? "Edit Image Connection" : "Add Image Connection")
                .font(AppFont.mono(16, weight: .bold))
                .foregroundColor(colors.textPrimary)

            Picker("", selection: $format) {
                ForEach(ImageWireFormat.allCases) { candidate in
                    Text(candidate.displayName).tag(candidate)
                }
            }
            .pickerStyle(.segmented)
            .labelsHidden()

            Text(format.helpText)
                .font(AppFont.sans(12.5))
                .foregroundColor(colors.textTertiary)
                .fixedSize(horizontal: false, vertical: true)
                .lineSpacing(3)

            field("Name", text: $displayName, placeholder: format == .automatic1111 ? "My Stable Diffusion Server" : "My OpenAI Key")
            field("Base URL", text: $baseURL, placeholder: format == .automatic1111 ? "http://127.0.0.1:7860" : "https://api.openai.com/v1")

            if format == .openAICompatible {
                VStack(alignment: .leading, spacing: 4) {
                    Text("API Key")
                        .font(AppFont.mono(12))
                        .foregroundColor(colors.textSecondary)
                    SecureField("Paste your API key", text: $apiKeyInput)
                        .textFieldStyle(.plain)
                        .font(AppFont.mono(13))
                        .padding(.horizontal, 12)
                        .padding(.vertical, 9)
                        .background(colors.backgroundInput)
                        .clipShape(RoundedRectangle(cornerRadius: 8, style: .continuous))
                        .overlay(RoundedRectangle(cornerRadius: 8, style: .continuous).stroke(colors.borderSubtle, lineWidth: 1))
                    if isEditing, let existing, store.apiKey(for: existing.id) != nil {
                        Label("API key saved on this device", systemImage: "lock.fill")
                            .font(AppFont.mono(12))
                            .foregroundColor(colors.textTertiary)
                    }
                }
            }

            VStack(alignment: .leading, spacing: 4) {
                Text(format == .automatic1111 ? "Model label" : "Model IDs (comma-separated)")
                    .font(AppFont.mono(12))
                    .foregroundColor(colors.textSecondary)
                TextField(
                    format == .automatic1111 ? "Whatever's loaded, e.g. SDXL" : "dall-e-3, gpt-image-1",
                    text: $modelIDsText
                )
                .textFieldStyle(.plain)
                .font(AppFont.mono(13))
                .padding(.horizontal, 12)
                .padding(.vertical, 9)
                .background(colors.backgroundInput)
                .clipShape(RoundedRectangle(cornerRadius: 8, style: .continuous))
                .overlay(RoundedRectangle(cornerRadius: 8, style: .continuous).stroke(colors.borderSubtle, lineWidth: 1))
                if format == .automatic1111 {
                    Text("These tools have no per-request model switch, so this is just a label to give it an entry in the model picker. Whatever's loaded in the server is what actually generates.")
                        .font(AppFont.sans(10))
                        .foregroundColor(colors.textTertiary)
                        .fixedSize(horizontal: false, vertical: true)
                        .lineSpacing(3)
                }
            }

            if let saveError {
                Text(saveError)
                    .font(AppFont.mono(12))
                    .foregroundColor(colors.destructive)
            }

            HStack {
                if isEditing {
                    Button("Remove", role: .destructive) {
                        if let existing { store.remove(existing.id) }
                        onDone()
                        dismiss()
                    }
                    .buttonStyle(.plain)
                    .font(AppFont.mono(12, weight: .medium))
                    .foregroundColor(colors.destructive)
                }
                Spacer()
                QuietButton(title: "Cancel") { onDone(); dismiss() }
                    .buttonStyle(.plain)
                    .font(AppFont.mono(14, weight: .medium))
                    .foregroundColor(colors.textSecondary)
                AccentButton(title: isEditing ? "Save" : "Add", isDisabled: !canSave) {
                    save()
                }
            }
        }
        .padding(24)
        .frame(width: 460)
        .background(colors.backgroundPopover)
        .onAppear {
            if let existing {
                displayName = existing.displayName
                baseURL = existing.baseURL
                format = existing.format
                modelIDsText = existing.modelIDs.joined(separator: ", ")
            }
        }
    }

    private func field(_ label: String, text: Binding<String>, placeholder: String) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(label)
                .font(AppFont.mono(12))
                .foregroundColor(colors.textSecondary)
            TextField(placeholder, text: text)
                .textFieldStyle(.plain)
                .font(AppFont.mono(13))
                .padding(.horizontal, 12)
                .padding(.vertical, 9)
                .background(colors.backgroundInput)
                .clipShape(RoundedRectangle(cornerRadius: 8, style: .continuous))
                .overlay(RoundedRectangle(cornerRadius: 8, style: .continuous).stroke(colors.borderSubtle, lineWidth: 1))
        }
    }

    private func save() {
        var config = existing ?? ImageProviderConfig(displayName: "", baseURL: "", format: format, modelIDs: [])
        config.displayName = displayName.trimmingCharacters(in: .whitespaces)
        config.baseURL = baseURL.trimmingCharacters(in: .whitespaces)
        config.format = format
        config.modelIDs = modelIDs
        do {
            try store.save(config, apiKey: apiKeyInput)
            onDone()
            dismiss()
        } catch {
            saveError = error.localizedDescription
        }
    }
}
