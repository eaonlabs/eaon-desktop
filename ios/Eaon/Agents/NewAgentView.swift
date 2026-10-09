import SwiftUI

/// The sheet for spinning up an agent, or editing one. Pick where it runs, start from a
/// role or from scratch, say what it's for, and how much it may do on its own.
struct NewAgentView: View {
    var place: AgentPlace
    var editing: Agent?
    var onCreated: (Agent) -> Void

    @Environment(AgentsStore.self) private var store
    @Environment(ModelCatalog.self) private var catalog
    @Environment(\.dismiss) private var dismiss

    @State private var chosenPlace: AgentPlace
    @State private var draft: AgentDraft
    @State private var firstTask = ""
    @State private var busy = false
    @State private var error: String?
    @State private var modelTouched = false
    @FocusState private var focus: Field?

    private enum Field { case name, purpose, manner, task }

    init(place: AgentPlace, editing: Agent? = nil, onCreated: @escaping (Agent) -> Void) {
        self.place = place
        self.editing = editing
        self.onCreated = onCreated
        _chosenPlace = State(initialValue: place)
        var initial = AgentDraft()
        if let editing {
            initial = AgentDraft(
                name: editing.name,
                colorHex: editing.colorHex,
                purpose: editing.purpose,
                personality: editing.personality,
                access: editing.access
            )
        } else {
            initial.colorHex = AgentPalette.hex[0]
        }
        _draft = State(initialValue: initial)
    }

    private var isEditing: Bool { editing != nil }
    private var macAvailable: Bool { store.mac.isAvailable }

    var body: some View {
        NavigationStack {
            Form {
                if !isEditing && macAvailable {
                    Section {
                        Picker("Where it runs", selection: $chosenPlace) {
                            Text("This iPhone").tag(AgentPlace.phone)
                            Text(catalog.macName).tag(AgentPlace.mac)
                        }
                        .pickerStyle(.segmented)
                        .listRowInsets(EdgeInsets(top: 8, leading: 12, bottom: 8, trailing: 12))
                    } footer: {
                        Text(chosenPlace == .phone
                             ? "Works while Eaon is open on this iPhone."
                             : "Runs on your Mac, all the time, with its files, browser and tools.")
                            .contentTransition(.opacity)
                            .animation(Springs.smooth, value: chosenPlace)
                    }
                    .listRowBackground(Palette.surface)
                }

                if !isEditing {
                    Section {
                        ScrollView(.horizontal, showsIndicators: false) {
                            HStack(spacing: 8) {
                                ForEach(AgentTemplate.templates(for: chosenPlace)) { template in
                                    Button {
                                        Haptic.select()
                                        withAnimation(Springs.snappy) { apply(template) }
                                    } label: {
                                        Label(template.role, systemImage: template.symbol)
                                            .font(.subheadline.weight(.medium))
                                            .foregroundStyle(Palette.ink)
                                            .padding(.horizontal, 14)
                                            .frame(height: 36)
                                            .background(Palette.surface, in: Capsule())
                                    }
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
                    HStack(spacing: 14) {
                        AgentFace(colorHex: draft.colorHex, mood: .happy, size: 44, seed: 5)
                            .frame(width: 52, height: 52)
                        TextField("Name", text: $draft.name)
                            .font(.title3.weight(.semibold))
                            .focused($focus, equals: .name)
                            .textInputAutocapitalization(.words)
                            .submitLabel(.next)
                            .onSubmit { focus = .purpose }
                    }
                    colorRow
                } header: {
                    Text("Agent")
                }
                .listRowBackground(Palette.surface)

                Section {
                    TextField("What should it do?", text: $draft.purpose, axis: .vertical)
                        .lineLimit(3...8)
                        .focused($focus, equals: .purpose)
                    TextField("How should it come across? (optional)", text: $draft.personality, axis: .vertical)
                        .lineLimit(1...3)
                        .focused($focus, equals: .manner)
                        // The Mac keeps 600 characters of it.
                        .onChange(of: draft.personality) { _, new in
                            if new.count > 600 { draft.personality = String(new.prefix(600)) }
                        }
                } header: {
                    Text("Purpose")
                }
                .listRowBackground(Palette.surface)

                Section {
                    ForEach(AgentAccess.allCases) { access in
                        Button {
                            Haptic.select()
                            withAnimation(Springs.bouncy) { draft.access = access }
                        } label: {
                            HStack(alignment: .top, spacing: 12) {
                                VStack(alignment: .leading, spacing: 3) {
                                    Text(access.title).font(.body.weight(.medium)).foregroundStyle(Palette.ink)
                                    Text(access.summary(on: chosenPlace))
                                        .font(.footnote)
                                        .foregroundStyle(Palette.secondary)
                                        .fixedSize(horizontal: false, vertical: true)
                                }
                                Spacer(minLength: 8)
                                if draft.access == access {
                                    Image(systemName: "checkmark").font(.system(size: 15, weight: .semibold)).foregroundStyle(Palette.ink)
                                        .transition(.scale(scale: 0.3).combined(with: .opacity))
                                }
                            }
                            .contentShape(Rectangle())
                        }
                        .buttonStyle(.plain)
                    }
                } header: {
                    Text("How much it does on its own")
                }
                .listRowBackground(Palette.surface)

                modelSection

                if !isEditing {
                    Section {
                        TextField("Optional: give it something to start on", text: $firstTask, axis: .vertical)
                            .lineLimit(2...5)
                            .focused($focus, equals: .task)
                    } header: {
                        Text("First task")
                    }
                    .listRowBackground(Palette.surface)
                }

                if let error {
                    Section { Callout(kind: .error, title: "Couldn't \(isEditing ? "save" : "create") it", message: error, onDismiss: { self.error = nil }).listRowInsets(EdgeInsets()).listRowBackground(Color.clear) }
                }
            }
            .scrollContentBackground(.hidden)
            .background(ScreenBackground())
            .navigationTitle(isEditing ? "Edit agent" : "New agent")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { dismiss() }
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button(isEditing ? "Save" : "Create", action: save)
                        .fontWeight(.semibold)
                        .disabled(!canSave || busy)
                }
            }
            .onChange(of: chosenPlace) {
                // A pinned model belongs to one place.
                draft.modelID = nil
                draft.pinned = nil
            }
        }
        .tint(Palette.ink)
        .presentationBackground(Palette.background)
        .presentationDetents([.large])
        .presentationDragIndicator(.visible)
        .presentationCornerRadius(34)
        .interactiveDismissDisabled(busy)
    }

    // MARK: Parts

    private var colorRow: some View {
        HStack(spacing: 10) {
            ForEach(AgentPalette.hex, id: \.self) { hex in
                Button {
                    Haptic.select()
                    withAnimation(Springs.bouncy) { draft.colorHex = hex }
                } label: {
                    Circle()
                        .fill(Color(hexString: hex))
                        .frame(width: 26, height: 26)
                        .scaleEffect(draft.colorHex == hex ? 0.86 : 1)
                        .overlay(Circle().strokeBorder(Palette.ink, lineWidth: draft.colorHex == hex ? 2 : 0).padding(-4))
                }
                .buttonStyle(PressableStyle(scale: 0.85))
                .frame(maxWidth: .infinity)
                .accessibilityLabel("Colour \(hex)")
                .accessibilityAddTraits(draft.colorHex == hex ? .isSelected : [])
            }
        }
        .padding(.vertical, 6)
    }

    @ViewBuilder private var modelSection: some View {
        Section {
            Menu {
                if chosenPlace == .phone {
                    Button("Follow Chat's model") { draft.pinned = nil; modelTouched = true }
                    ForEach(phoneModels) { ref in
                        Button(ref.detail.map { "\(ref.name) · \($0)" } ?? ref.name) { draft.pinned = ref; modelTouched = true }
                    }
                } else {
                    if !isEditing { Button("Follow the Mac's choice") { draft.modelID = nil; modelTouched = true } }
                    ForEach(store.mac.models) { model in
                        Button("\(model.name) · \(model.provider)") { draft.modelID = model.id; modelTouched = true }
                    }
                }
            } label: {
                HStack {
                    Text("Model").foregroundStyle(Palette.ink)
                    Spacer()
                    Text(modelLabel).foregroundStyle(Palette.secondary)
                    Image(systemName: "chevron.up.chevron.down").font(.system(size: 11, weight: .semibold)).foregroundStyle(Palette.secondary)
                }
            }
        } header: {
            Text("Model")
        } footer: {
            Text("Agents use tools, so pick a model that supports them. Apple Intelligence works on this iPhone.")
        }
        .listRowBackground(Palette.surface)
    }

    private var phoneModels: [ModelRef] {
        (catalog.onDevice.isAvailable ? [ModelRef.onDevice] : []) + catalog.providerModelRefs + catalog.macModelRefs
    }

    private var modelLabel: String {
        if chosenPlace == .phone {
            return draft.pinned?.name ?? "Follows Chat"
        }
        if let id = draft.modelID, let model = store.mac.models.first(where: { $0.id == id }) { return model.name }
        if isEditing, !modelTouched, let name = editing?.modelName { return name }
        return "Mac's choice"
    }

    private var canSave: Bool {
        !draft.name.trimmingCharacters(in: .whitespaces).isEmpty && !draft.purpose.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    }

    // MARK: Actions

    private func apply(_ template: AgentTemplate) {
        draft.name = draft.name.isEmpty || AgentTemplate.all.contains(where: { $0.role == draft.name }) ? template.role : draft.name
        draft.purpose = template.purpose
        draft.personality = template.personality
        draft.colorHex = template.colorHex
    }

    private func save() {
        focus = nil
        busy = true
        error = nil
        Task {
            defer { busy = false }
            do {
                if let editing {
                    var update = draft
                    if !modelTouched {
                        update.pinned = store.phone.record(editing.key.id)?.pinned
                    }
                    try await store.source(editing.place).update(editing.key.id, with: update)
                    Haptic.success()
                    dismiss()
                } else {
                    let source = store.source(chosenPlace)
                    let agent = try await source.create(draft)
                    let task = firstTask.trimmingCharacters(in: .whitespacesAndNewlines)
                    if !task.isEmpty { try? await source.send(agent.key.id, text: task, asGoal: false) }
                    Haptic.success()
                    dismiss()
                    onCreated(agent)
                }
            } catch {
                Haptic.failure()
                self.error = (error as? LocalizedError)?.errorDescription ?? error.localizedDescription
            }
        }
    }
}
