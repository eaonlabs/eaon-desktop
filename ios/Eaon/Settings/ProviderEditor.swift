import SwiftUI

/// Adds a provider, or edits one: any server that speaks the OpenAI API.
struct ProviderEditor: View {
    let provider: Provider?
    /// Called with the model once it's saved, so the caller can switch to it.
    var onSave: (ModelRef) -> Void = { _ in }

    @Environment(ModelCatalog.self) private var catalog
    @Environment(\.dismiss) private var dismiss

    @State private var name = ""
    @State private var address = ""
    @State private var key = ""
    @State private var modelID = ""
    @State private var available: [String] = []
    @State private var loading = false
    @State private var loadError: String?
    @State private var confirmsDelete = false
    @FocusState private var focus: Field?

    private enum Field { case name, address, key, model }

    private static let presets: [(name: String, address: String)] = [
        ("OpenAI", "https://api.openai.com/v1"),
        ("OpenRouter", "https://openrouter.ai/api/v1"),
        ("Groq", "https://api.groq.com/openai/v1")
    ]

    var body: some View {
        NavigationStack {
            Form {
                if provider == nil {
                    Section {
                        ScrollView(.horizontal, showsIndicators: false) {
                            HStack(spacing: 8) {
                                ForEach(Self.presets, id: \.name) { preset in
                                    Button(preset.name) {
                                        Haptic.select()
                                        name = preset.name
                                        address = preset.address
                                        focus = .key
                                    }
                                    .font(.subheadline.weight(.medium))
                                    .foregroundStyle(Palette.ink)
                                    .padding(.horizontal, 14)
                                    .frame(height: 34)
                                    .background(Palette.surface, in: Capsule())
                                    .buttonStyle(PressableStyle())
                                }
                            }
                            .padding(.horizontal, 20)
                        }
                        .listRowInsets(EdgeInsets())
                        .listRowBackground(Color.clear)
                    } header: {
                        Text("Start from")
                    }
                }

                Section {
                    TextField("Name", text: $name)
                        .focused($focus, equals: .name)
                        .textInputAutocapitalization(.words)
                    TextField("Address", text: $address)
                        .focused($focus, equals: .address)
                        .keyboardType(.URL)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                    SecureField("API key", text: $key)
                        .focused($focus, equals: .key)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                } header: {
                    Text("Provider")
                } footer: {
                    Text("The key stays in this iPhone's Keychain. Leave it empty for servers that don't need one. For Ollama or LM Studio on your Mac, use its network address, like 192.168.1.20:11434.")
                }
                .listRowBackground(Palette.surface)

                Section {
                    TextField("Model", text: $modelID)
                        .focused($focus, equals: .model)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                    if !available.isEmpty {
                        Picker("Choose from the list", selection: $modelID) {
                            ForEach(available, id: \.self) { Text($0).tag($0) }
                        }
                        .pickerStyle(.menu)
                    }
                    Button {
                        Task { await loadModels() }
                    } label: {
                        HStack {
                            Text(available.isEmpty ? "Load models" : "Reload models")
                            if loading { ProgressView().controlSize(.small) }
                        }
                    }
                    .disabled(loading || ModelsClient.baseURL(from: address) == nil)
                } header: {
                    Text("Model")
                } footer: {
                    if let loadError {
                        Text(loadError).foregroundStyle(Palette.negative)
                    }
                }
                .listRowBackground(Palette.surface)

                if provider != nil {
                    Section {
                        Button("Remove provider", role: .destructive) { confirmsDelete = true }
                    }
                    .listRowBackground(Palette.surface)
                }
            }
            .scrollContentBackground(.hidden)
            .background(ScreenBackground())
            .navigationTitle(provider == nil ? "Add a provider" : "Edit provider")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { dismiss() }
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Save", action: save)
                        .fontWeight(.semibold)
                        .disabled(!canSave)
                }
            }
            .confirmationDialog("Remove \(name)?", isPresented: $confirmsDelete, titleVisibility: .visible) {
                Button("Remove", role: .destructive) {
                    if let provider { catalog.delete(provider) }
                    dismiss()
                }
            } message: {
                Text("Its key is deleted from this iPhone.")
            }
        }
        .tint(Palette.ink)
        .presentationBackground(Palette.background)
        .presentationDetents([.large])
        .presentationDragIndicator(.visible)
        .presentationCornerRadius(34)
        .onAppear(perform: load)
    }

    private var canSave: Bool {
        !name.trimmingCharacters(in: .whitespaces).isEmpty
            && !modelID.trimmingCharacters(in: .whitespaces).isEmpty
            && ModelsClient.baseURL(from: address) != nil
    }

    private func load() {
        guard let provider else { return }
        name = provider.name
        address = provider.baseURL
        modelID = provider.modelID
        key = catalog.key(for: provider) ?? ""
    }

    private func loadModels() async {
        guard let url = ModelsClient.baseURL(from: address) else { return }
        loading = true
        loadError = nil
        defer { loading = false }
        do {
            available = try await ModelsClient.models(at: url, apiKey: key)
            if modelID.isEmpty, let first = available.first { modelID = first }
            if available.isEmpty { loadError = "That server didn't list any models. Type the model's name instead." }
        } catch {
            available = []
            loadError = ModelCatalog.message(for: error) + " You can still type the model's name."
        }
    }

    private func save() {
        let saved = Provider(
            id: provider?.id ?? UUID(),
            name: name.trimmingCharacters(in: .whitespaces),
            baseURL: address.trimmingCharacters(in: .whitespaces),
            modelID: modelID.trimmingCharacters(in: .whitespaces)
        )
        catalog.save(saved, key: key)
        Haptic.success()
        onSave(ModelRef(source: .provider(saved.id), id: saved.modelID, name: saved.modelID, detail: saved.name))
        dismiss()
    }
}
