import AppKit
import SwiftUI

/// Settings page for one local backend (Ollama / Llama.cpp / MLX): install
/// status, its models, and — for the spawned engines — server controls and
/// a live log. All copy is written for people who've never run a local
/// model before.
struct LocalProviderSettingsView: View {
    @Environment(\.themeColors) private var colors
    @Bindable var chatViewModel: ChatViewModel
    @Bindable private var manager = LocalAIManager.shared
    let backend: LocalBackend

    @State private var pullNameInput = ""
    @State private var repoInput = ""
    @State private var copiedInstallCommand = false
    @State private var recordPendingDeletion: LocalModelRecord?
    /// Non-nil when a delete verifiably failed — see ModelLibraryView's
    /// identical state for why this must be surfaced, never swallowed.
    @State private var deletionFailureMessage: String?

    private var isInstalled: Bool { manager.installed.contains(backend) }

    /// "7.1 GB" / "512 MB" — decimal units matching Ollama's own reporting
    /// (and the row badge has no room for more words).
    static func formatResidentBytes(_ bytes: Int64) -> String {
        let gigabytes = Double(bytes) / 1_000_000_000
        if gigabytes >= 1 { return String(format: "%.1f GB", gigabytes) }
        return String(format: "%.0f MB", gigabytes * 1000)
    }

    private var backendModels: [LocalModelRecord] {
        switch backend {
        case .ollama: return manager.ollamaModels
        case .llamaCpp, .mlx: return manager.userModels.filter { $0.backend == backend }
        }
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            Text(backend.displayName)
                .font(AppFont.mono(20, weight: .bold))
                .foregroundColor(colors.textPrimary)
                .padding(.horizontal, 32)
                .padding(.top, 28)
                .padding(.bottom, 8)

            Text(backend.blurb)
                .font(AppFont.sans(12))
                .foregroundColor(colors.textSecondary)
                .fixedSize(horizontal: false, vertical: true)
                .lineSpacing(3)
                .padding(.horizontal, 32)
                .padding(.bottom, 20)

            ScrollView {
                VStack(alignment: .leading, spacing: 16) {
                    statusCard

                    if !isInstalled {
                        installCard
                    } else {
                        switch backend {
                        case .ollama:
                            ollamaModelsCard
                            keepAliveCard
                            pullCard
                        case .llamaCpp:
                            addModelCard(
                                placeholder: "ggml-org/gemma-3-1b-it-GGUF",
                                note: "Paste a Hugging Face GGUF repo (find them by searching \"GGUF\" on huggingface.co), or pick a .gguf file already on this Mac. Hugging Face models download the first time you chat, so that first start can take a while."
                            )
                            userModelsCard
                        case .mlx:
                            addModelCard(
                                placeholder: "mlx-community/Llama-3.2-3B-Instruct-4bit",
                                note: "Paste a Hugging Face MLX repo. The mlx-community page has hundreds of them, converted for Apple silicon. Models download the first time you chat."
                            )
                            userModelsCard
                        }

                        if let log = manager.serverLogs[backend], !log.isEmpty {
                            serverLogCard(log)
                        }
                    }
                }
                .padding(.horizontal, 32)
                .padding(.bottom, 32)
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
        .background(colors.backgroundPrimary)
        .onAppear {
            // Thorough (login-shell) check, not just the directory scan: this
            // page is where someone lands right after installing, and being
            // told "not installed" when it demonstrably is would be the whole
            // bug. See `refreshInstalledBackends`.
            Task { await manager.refreshInstalledBackends() }
            if backend == .ollama {
                Task {
                    await manager.refreshOllamaModels()
                    await manager.refreshLoadedOllamaModels()
                }
            }
        }
        .alert(
            "Delete this model?",
            isPresented: Binding(
                get: { recordPendingDeletion != nil },
                set: { if !$0 { recordPendingDeletion = nil } }
            ),
            presenting: recordPendingDeletion
        ) { record in
            Button("Delete", role: .destructive) {
                Task {
                    // Same verified-deletion reporting as ModelLibraryView —
                    // a delete that didn't actually free the disk must say
                    // so, not pretend.
                    if let failure = await manager.deleteModel(record) {
                        deletionFailureMessage = failure
                    }
                }
                recordPendingDeletion = nil
            }
            Button("Cancel", role: .cancel) { recordPendingDeletion = nil }
        } message: { record in
            Text(record.backend == .ollama
                 ? "\(record.displayName) will be removed from this Mac (frees \(record.detail.replacingOccurrences(of: " on this Mac", with: ""))). You can download it again anytime."
                 : "\(record.displayName) will be removed. Downloaded files in the app's models folder are deleted too.")
        }
        .alert(
            "Couldn't delete the model",
            isPresented: Binding(
                get: { deletionFailureMessage != nil },
                set: { if !$0 { deletionFailureMessage = nil } }
            )
        ) {
            Button("OK") { deletionFailureMessage = nil }
        } message: {
            Text(deletionFailureMessage ?? "")
        }
    }

    // MARK: Status

    private var statusText: String {
        if !isInstalled { return "Not installed" }
        switch backend {
        case .ollama:
            return manager.ollamaReachable
                ? "Running — \(backendModels.count) model\(backendModels.count == 1 ? "" : "s") ready"
                : "Installed — server not running"
        case .llamaCpp, .mlx:
            if manager.isStartingServer, manager.activeSpawned?.backend == backend {
                return manager.startupStatus ?? "Starting…"
            }
            if manager.activeSpawned?.backend == backend {
                return "Server running"
            }
            return "Installed — starts automatically when you chat"
        }
    }

    private var statusCard: some View {
        SettingsCard {
            HStack(spacing: 12) {
                Circle()
                    .fill(backend.tint.opacity(0.16))
                    .overlay(Circle().stroke(colors.borderSubtle, lineWidth: 1))
                    .frame(width: 36, height: 36)
                    .overlay {
                        Image(systemName: backend.systemIcon)
                            .font(.system(size: 15, weight: .semibold))
                            .foregroundStyle(backend.tint)
                    }

                VStack(alignment: .leading, spacing: 4) {
                    Text(backend.displayName)
                        .font(AppFont.mono(14, weight: .semibold))
                        .foregroundColor(colors.textPrimary)
                    Text(statusText)
                        .font(AppFont.mono(12))
                        .foregroundColor(colors.textSecondary)
                        .lineLimit(2)
                }

                Spacer()

                statusAction
            }
            .padding(16)
        }
    }

    @ViewBuilder
    private var statusAction: some View {
        switch backend {
        case .ollama:
            if isInstalled, !manager.ollamaReachable {
                AccentButton(title: "Start") {
                    Task { await manager.refreshOllamaModels(startServerIfNeeded: true) }
                }
            }
        case .llamaCpp, .mlx:
            if manager.activeSpawned?.backend == backend {
                Button("Stop server") { manager.stopSpawnedServer() }
                    .buttonStyle(.bordered)
            }
        }
    }

    // MARK: Install guide

    private var installCard: some View {
        SettingsCard {
            VStack(alignment: .leading, spacing: 12) {
                Text("Get \(backend.displayName)")
                    .font(AppFont.mono(14, weight: .semibold))
                    .foregroundColor(colors.textPrimary)

                Text(backend.installNote)
                    .font(AppFont.sans(12))
                    .foregroundColor(colors.textSecondary)
                    .fixedSize(horizontal: false, vertical: true)
                    .lineSpacing(3)

                HStack(spacing: 8) {
                    Text(backend.installCommand)
                        .font(AppFont.mono(12))
                        .foregroundColor(colors.textPrimary)
                        .padding(.horizontal, 10)
                        .padding(.vertical, 7)
                        .background(colors.backgroundInput)
                        .clipShape(RoundedRectangle(cornerRadius: 7, style: .continuous))
                        .overlay(
                            RoundedRectangle(cornerRadius: 7, style: .continuous)
                                .stroke(colors.borderSubtle, lineWidth: 1)
                        )

                    Button(copiedInstallCommand ? "Copied" : "Copy") {
                        NSPasteboard.general.clearContents()
                        NSPasteboard.general.setString(backend.installCommand, forType: .string)
                        copiedInstallCommand = true
                        DispatchQueue.main.asyncAfter(deadline: .now() + 1.5) { copiedInstallCommand = false }
                    }
                    .buttonStyle(.bordered)

                    Spacer()

                    AccentButton(title: "Check again") {
                        Task { await manager.refreshInstalledBackends(force: true) }
                        if backend == .ollama {
                            Task { await manager.refreshOllamaModels() }
                        }
                    }
                }
            }
            .padding(16)
        }
    }

    // MARK: Ollama models + pull

    private var ollamaModelsCard: some View {
        SettingsCard {
            VStack(alignment: .leading, spacing: 0) {
                HStack {
                    Text("Your models")
                        .font(AppFont.mono(14, weight: .semibold))
                        .foregroundColor(colors.textPrimary)
                    Spacer()
                    Button {
                        Task {
                            await manager.refreshOllamaModels(startServerIfNeeded: true)
                            await manager.refreshLoadedOllamaModels()
                        }
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
                    .help("Refresh")
                }
                .padding(.horizontal, 16)
                .padding(.top, 16)
                .padding(.bottom, 12)

                if backendModels.isEmpty {
                    Text(manager.ollamaReachable
                         ? "No chat models pulled yet. Grab one below."
                         : "Start the server to see your models.")
                        .font(AppFont.mono(14))
                        .foregroundColor(colors.textSecondary)
                        .padding(.horizontal, 16)
                        .padding(.bottom, 16)
                } else {
                    VStack(spacing: 0) {
                        ForEach(Array(backendModels.enumerated()), id: \.element.id) { index, record in
                            if index > 0 { Divider().padding(.leading, 16) }
                            localModelRow(record)
                        }
                    }
                    .padding(.bottom, 4)
                }
            }
        }
    }

    // MARK: Keep-alive

    /// Ollama unloads an idle model from RAM after a timeout — this is
    /// that timeout, made real and configurable. The app pings Ollama's
    /// native API to set it explicitly (the OpenAI-compatible endpoint
    /// actual chat streams through silently ignores this field, verified
    /// against a live server — see `LocalAIManager.primeOllamaModel`).
    private var keepAliveCard: some View {
        SettingsCard {
            HStack {
                VStack(alignment: .leading, spacing: 4) {
                    Text("Keep models loaded")
                        .font(AppFont.mono(14, weight: .semibold))
                        .foregroundColor(colors.textPrimary)
                    Text("How long an idle model stays in memory before Ollama frees the RAM.")
                        .font(AppFont.sans(12))
                        .foregroundColor(colors.textSecondary)
                        .fixedSize(horizontal: false, vertical: true)
                        .lineSpacing(3)
                }
                Spacer(minLength: 12)
                Menu {
                    ForEach(OllamaKeepAliveDuration.allCases) { duration in
                        Button {
                            manager.ollamaKeepAliveDuration = duration
                        } label: {
                            if duration == manager.ollamaKeepAliveDuration {
                                Label(duration.displayName, systemImage: "checkmark")
                            } else {
                                Text(duration.displayName)
                            }
                        }
                    }
                } label: {
                    HStack(spacing: 6) {
                        Text(manager.ollamaKeepAliveDuration.displayName)
                            .font(AppFont.mono(12, weight: .medium))
                            .foregroundColor(colors.textPrimary)
                        Image(systemName: "chevron.up.chevron.down")
                            .font(.system(size: 9, weight: .semibold))
                            .foregroundColor(colors.textTertiary)
                            .iconHoverEffect(for: "chevron.up.chevron.down")
                    }
                    .padding(.horizontal, 12)
                    .padding(.vertical, 7)
                    .background(Capsule().stroke(colors.borderMedium, lineWidth: 1))
                }
                .menuStyle(.borderlessButton)
                .fixedSize()
            }
            .padding(18)
        }
    }

    private var pullCard: some View {
        SettingsCard {
            VStack(alignment: .leading, spacing: 10) {
                Text("Download a model")
                    .font(AppFont.mono(14, weight: .semibold))
                    .foregroundColor(colors.textPrimary)

                Text("Type a model name from ollama.com/library, for example \"llama3.2\" or \"qwen2.5:7b\" — and it downloads to this Mac.")
                    .font(AppFont.sans(12))
                    .foregroundColor(colors.textSecondary)
                    .fixedSize(horizontal: false, vertical: true)
                    .lineSpacing(3)

                HStack(spacing: 8) {
                    TextField("llama3.2", text: $pullNameInput)
                        .textFieldStyle(.plain)
                        .font(AppFont.mono(14))
                        .padding(.horizontal, 12)
                        .padding(.vertical, 8)
                        .background(colors.backgroundInput)
                        .clipShape(RoundedRectangle(cornerRadius: 8, style: .continuous))
                        .overlay(
                            RoundedRectangle(cornerRadius: 8, style: .continuous)
                                .stroke(colors.borderSubtle, lineWidth: 1)
                        )

                    AccentButton(title: manager.isPulling ? "Downloading…" : "Download", isDisabled: manager.isPulling) {
                        let name = pullNameInput
                        pullNameInput = ""
                        Task { await manager.pullOllamaModel(name) }
                    }
                }

                if let status = manager.pullStatus {
                    Text(status)
                        .font(AppFont.mono(12))
                        .foregroundColor(colors.textSecondary)
                        .lineLimit(1)
                }
            }
            .padding(16)
        }
    }

    // MARK: llama.cpp / MLX model management

    private func addModelCard(placeholder: String, note: String) -> some View {
        SettingsCard {
            VStack(alignment: .leading, spacing: 10) {
                Text("Add a model")
                    .font(AppFont.mono(14, weight: .semibold))
                    .foregroundColor(colors.textPrimary)

                Text(note)
                    .font(AppFont.sans(12))
                    .foregroundColor(colors.textSecondary)
                    .fixedSize(horizontal: false, vertical: true)
                    .lineSpacing(3)

                HStack(spacing: 8) {
                    TextField(placeholder, text: $repoInput)
                        .textFieldStyle(.plain)
                        .font(AppFont.mono(14))
                        .padding(.horizontal, 12)
                        .padding(.vertical, 8)
                        .background(colors.backgroundInput)
                        .clipShape(RoundedRectangle(cornerRadius: 8, style: .continuous))
                        .overlay(
                            RoundedRectangle(cornerRadius: 8, style: .continuous)
                                .stroke(colors.borderSubtle, lineWidth: 1)
                        )

                    AccentButton(title: "Add", isDisabled: repoInput.trimmingCharacters(in: .whitespaces).isEmpty) {
                        manager.addUserModel(backend: backend, source: repoInput, isFile: false)
                        repoInput = ""
                    }
                }

                if backend == .llamaCpp {
                    Button {
                        chooseGGUFFile()
                    } label: {
                        HStack(spacing: 6) {
                            Image(systemName: "folder")
                                .iconHoverEffect(for: "folder")
                            Text("Choose a .gguf file on this Mac…")
                        }
                        .font(AppFont.mono(12, weight: .medium))
                    }
                    .buttonStyle(.bordered)
                }
            }
            .padding(16)
        }
    }

    private var userModelsCard: some View {
        SettingsCard {
            VStack(alignment: .leading, spacing: 0) {
                Text("Your models")
                    .font(AppFont.mono(14, weight: .semibold))
                    .foregroundColor(colors.textPrimary)
                    .padding(.horizontal, 16)
                    .padding(.top, 16)
                    .padding(.bottom, 12)

                if backendModels.isEmpty {
                    Text("Nothing added yet. Models you add appear in the model picker under \"On this Mac\".")
                        .font(AppFont.mono(14))
                        .foregroundColor(colors.textSecondary)
                        .fixedSize(horizontal: false, vertical: true)
                        .lineSpacing(3)
                        .padding(.horizontal, 16)
                        .padding(.bottom, 16)
                } else {
                    VStack(spacing: 0) {
                        ForEach(Array(backendModels.enumerated()), id: \.element.id) { index, record in
                            if index > 0 { Divider().padding(.leading, 16) }
                            localModelRow(record)
                        }
                    }
                    .padding(.bottom, 4)
                }
            }
        }
    }

    private func localModelRow(_ record: LocalModelRecord) -> some View {
        HStack(spacing: 10) {
            VStack(alignment: .leading, spacing: 2) {
                Text(record.displayName)
                    .font(AppFont.mono(14, weight: .medium))
                    .foregroundColor(colors.textPrimary)
                    .lineLimit(1)
                Text(record.detail)
                    .font(AppFont.mono(12))
                    .foregroundColor(colors.textTertiary)
            }

            Spacer()

            // Ollama: per-model residency is real, queryable state
            // (`/api/ps`) — show the live footprint and an eject that
            // frees it now instead of waiting out the keep-alive timer.
            if record.backend == .ollama, let residentBytes = manager.loadedOllamaModels[record.requestModelId] {
                Text("IN MEMORY · \(Self.formatResidentBytes(residentBytes))")
                    .font(AppFont.mono(9, weight: .bold))
                    .foregroundStyle(colors.textSecondary)
                    .padding(.horizontal, 6)
                    .padding(.vertical, 3)
                    .background(colors.backgroundSubtle)
                    .clipShape(RoundedRectangle(cornerRadius: 5, style: .continuous))

                Button {
                    Task { await manager.unloadOllamaModel(record.requestModelId) }
                } label: {
                    Image(systemName: "eject")
                        .font(.system(size: 12, weight: .semibold))
                        .foregroundColor(colors.textSecondary)
                        .iconHoverEffect(for: "eject")
                        .frame(width: 28, height: 28)
                }
                .buttonStyle(.plain)
                .help("Unload from memory. Frees the RAM now. The next message loads it again")
            }

            if manager.activeSpawned?.modelId == record.id {
                Text("RUNNING")
                    .font(AppFont.mono(9, weight: .bold))
                    .foregroundStyle(colors.textSecondary)
                    .padding(.horizontal, 6)
                    .padding(.vertical, 3)
                    .background(colors.backgroundSubtle)
                    .clipShape(RoundedRectangle(cornerRadius: 5, style: .continuous))

                // llama.cpp/MLX residency IS the spawned server process —
                // eject = stop it, same as the status card's own "Stop
                // server," just reachable from the model's own row.
                Button {
                    manager.stopSpawnedServer()
                } label: {
                    Image(systemName: "eject")
                        .font(.system(size: 12, weight: .semibold))
                        .foregroundColor(colors.textSecondary)
                        .iconHoverEffect(for: "eject")
                        .frame(width: 28, height: 28)
                }
                .buttonStyle(.plain)
                .help("Stop the server and unload from memory")
            }

            if record.backend == .llamaCpp {
                LlamaRunSettingsMenu(manager: manager, record: record)
            }

            Button {
                recordPendingDeletion = record
            } label: {
                Image(systemName: "trash")
                    .font(.system(size: 13))
                    .foregroundColor(colors.textSecondary)
                    .iconHoverEffect(for: "trash")
                    .frame(width: 28, height: 28)
            }
            .buttonStyle(.plain)
            .help("Delete from this Mac")
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 10)
    }

    private func chooseGGUFFile() {
        let panel = NSOpenPanel()
        panel.canChooseFiles = true
        panel.canChooseDirectories = false
        panel.allowsMultipleSelection = false
        panel.message = "Pick a .gguf model file"
        if panel.runModal() == .OK, let url = panel.url {
            manager.addUserModel(backend: .llamaCpp, source: url.path, isFile: true)
        }
    }

    // MARK: Server log

    private func serverLogCard(_ log: String) -> some View {
        SettingsCard {
            VStack(alignment: .leading, spacing: 8) {
                Text("Server log")
                    .font(AppFont.mono(14, weight: .semibold))
                    .foregroundColor(colors.textPrimary)

                ScrollView {
                    Text(log)
                        .font(AppFont.mono(10))
                        .foregroundColor(colors.textSecondary)
                        .textSelection(.enabled)
                        .frame(maxWidth: .infinity, alignment: .leading)
                }
                .frame(height: 120)
                .padding(8)
                .background(colors.backgroundCode)
                .clipShape(RoundedRectangle(cornerRadius: 8, style: .continuous))
            }
            .padding(16)
        }
    }
}
