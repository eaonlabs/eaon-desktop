import AppKit
import SwiftUI

/// Lets models read and act in outside services on the user's behalf, via
/// MCP (Model Context Protocol) servers reached over the internet. Distinct
/// from the local coding agent's file tools: nothing here is sandboxed, so
/// a connection is opt-in per service (this page) and every individual
/// tool call still asks first (see `MCPCallConfirmationDialog`).
///
/// Only ever shows `MCPCatalog.available` — every row here genuinely
/// works. Services that turned out to be blocked (vendor-side, not a gap
/// in this app) were removed rather than kept as a permanently-disabled
/// "Coming soon" row; a tag that never resolves is just clutter.
struct PluginsSettingsView: View {
    @Environment(\.themeColors) private var colors
    @Bindable private var customStore = CustomMCPServerStore.shared
    @State private var expandedIds: Set<String> = []
    @State private var isAddingCustomServer = false

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            Text("Plugins")
                .font(AppFont.mono(20, weight: .bold))
                .foregroundColor(colors.textPrimary)
                .padding(.horizontal, 32)
                .padding(.top, 28)
                .padding(.bottom, 4)

            Text("Connect outside services so models can read and act on your behalf, with your consent.")
                .font(AppFont.sans(12))
                .foregroundColor(colors.textSecondary)
                .padding(.horizontal, 32)
                .padding(.bottom, 20)

            ScrollView {
                SettingsCard {
                    VStack(spacing: 0) {
                        ForEach(Array(MCPCatalog.builtIn.enumerated()), id: \.element.id) { index, server in
                            if index > 0 {
                                Divider().overlay(colors.borderSubtle)
                            }
                            PluginRow(
                                server: server,
                                isExpanded: expandedIds.contains(server.id),
                                onToggle: { toggle(server.id) }
                            )
                        }
                    }
                }
                .padding(.horizontal, 32)
                .padding(.bottom, 20)

                customServersSection
                    .padding(.horizontal, 32)
                    .padding(.bottom, 32)
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
        .background(colors.backgroundPrimary)
        .sheet(isPresented: $isAddingCustomServer) {
            AddCustomMCPServerSheet(isPresented: $isAddingCustomServer)
        }
    }

    /// Any MCP server reachable by URL, not just the individually-verified
    /// built-in ones above — the same generic protocol client and
    /// confirm/dispatch pipeline, just pointed somewhere the user chose.
    private var customServersSection: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack {
                Text("Custom servers")
                    .font(AppFont.mono(14, weight: .semibold))
                    .foregroundColor(colors.textSecondary)
                Spacer()
                Button {
                    isAddingCustomServer = true
                } label: {
                    HStack(spacing: 4) {
                        Image(systemName: "plus")
                            .iconHoverEffect(for: "plus")
                        Text("Add")
                    }
                    .font(AppFont.mono(12, weight: .medium))
                }
                .buttonStyle(.plain)
                .foregroundColor(colors.link)
            }

            if customStore.servers.isEmpty {
                Text("Connect to any MCP server by URL, not just the ones above.")
                    .font(AppFont.sans(12))
                    .foregroundColor(colors.textTertiary)
                    .padding(.vertical, 4)
            } else {
                SettingsCard {
                    VStack(spacing: 0) {
                        ForEach(Array(customServersWithDefinitions.enumerated()), id: \.element.server.id) { index, entry in
                            if index > 0 {
                                Divider().overlay(colors.borderSubtle)
                            }
                            PluginRow(
                                server: entry.definition,
                                isExpanded: expandedIds.contains(entry.definition.id),
                                onToggle: { toggle(entry.definition.id) }
                            )
                            .contextMenu {
                                Button("Remove Server", role: .destructive) {
                                    customStore.remove(entry.server.id)
                                }
                            }
                        }
                    }
                }
            }
        }
    }

    /// Pairs each stored custom server with its converted `MCPServerDefinition`
    /// so the context menu's "Remove" can act on the real stored id while
    /// `PluginRow` itself only ever deals in definitions.
    private var customServersWithDefinitions: [(server: CustomMCPServer, definition: MCPServerDefinition)] {
        customStore.sortedServers.compactMap { server in
            customStore.definitions.first { $0.id == "custom-\(server.id.uuidString)" }.map { (server, $0) }
        }
    }

    private func toggle(_ id: String) {
        withAnimation(.easeOut(duration: 0.15)) {
            if expandedIds.contains(id) {
                expandedIds.remove(id)
            } else {
                expandedIds.insert(id)
            }
        }
    }
}

/// The "Add Custom Server" form — name, endpoint URL, token, and an
/// advanced-disclosure auth scheme override for the rare server that
/// doesn't use a plain Bearer token. Saves via `CustomMCPServerStore`, then
/// immediately attempts to connect using the exact same path a built-in
/// service's token field uses (`MCPConnectionStore.connect`), so adding and
/// connecting is one step rather than two.
private struct AddCustomMCPServerSheet: View {
    @Environment(\.themeColors) private var colors
    @Binding var isPresented: Bool

    @State private var name = ""
    @State private var endpoint = ""
    @State private var token = ""
    @State private var authScheme = "Bearer"
    @State private var showsAdvanced = false
    @State private var isConnecting = false
    @State private var errorMessage: String?

    private var trimmedName: String { name.trimmingCharacters(in: .whitespacesAndNewlines) }
    private var trimmedEndpoint: String { endpoint.trimmingCharacters(in: .whitespacesAndNewlines) }
    private var canSave: Bool {
        !trimmedName.isEmpty && URL(string: trimmedEndpoint)?.scheme != nil
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            Text("Add Custom MCP Server")
                .font(AppFont.mono(16, weight: .bold))
                .foregroundColor(colors.textPrimary)

            Text("Connect to any MCP server by its URL, whether it's self-hosted, internal, or just not in the catalog above.")
                .font(AppFont.sans(12))
                .foregroundColor(colors.textSecondary)
                .fixedSize(horizontal: false, vertical: true)
                .lineSpacing(3)

            labeledField("Name", text: $name, placeholder: "e.g. My Internal Tools")
            labeledField("Endpoint URL", text: $endpoint, placeholder: "https://example.com/mcp")
            labeledField("API Token", text: $token, placeholder: "Paste an API token", isSecure: true)

            DisclosureGroup("Advanced", isExpanded: $showsAdvanced) {
                labeledField("Auth header scheme", text: $authScheme, placeholder: "Bearer")
                    .padding(.top, 8)
            }
            .font(AppFont.mono(12, weight: .medium))
            .foregroundColor(colors.textSecondary)

            if let errorMessage {
                Text(errorMessage)
                    .font(AppFont.mono(12))
                    .foregroundColor(colors.destructive)
                    .fixedSize(horizontal: false, vertical: true)
                    .lineSpacing(3)
            }

            HStack {
                Spacer()
                Button("Cancel") { isPresented = false }
                    .buttonStyle(.bordered)
                AccentButton(title: isConnecting ? "Connecting…" : "Add & Connect", isDisabled: !canSave || isConnecting) {
                    save()
                }
            }
        }
        .padding(24)
        .frame(width: 420)
    }

    private func labeledField(_ label: String, text: Binding<String>, placeholder: String, isSecure: Bool = false) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(label)
                .font(AppFont.mono(12, weight: .medium))
                .foregroundColor(colors.textSecondary)
            Group {
                if isSecure {
                    SecureField(placeholder, text: text)
                } else {
                    TextField(placeholder, text: text)
                }
            }
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
        errorMessage = nil
        guard let url = URL(string: trimmedEndpoint), url.scheme != nil else {
            errorMessage = "That doesn't look like a valid URL. Include https://."
            return
        }
        let scheme = authScheme.trimmingCharacters(in: .whitespacesAndNewlines)
        let server = CustomMCPServer(displayName: trimmedName, endpoint: trimmedEndpoint, authScheme: scheme.isEmpty ? "Bearer" : scheme)
        CustomMCPServerStore.shared.save(server, token: token)

        guard !token.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
            isPresented = false
            return
        }
        guard let definition = CustomMCPServerStore.shared.definitions.first(where: { $0.id == "custom-\(server.id.uuidString)" }) else {
            isPresented = false
            return
        }
        isConnecting = true
        Task {
            await MCPConnectionStore.shared.connect(server: definition, token: token)
            isConnecting = false
            isPresented = false
        }
    }
}

/// One service's row — a header (badge, name, summary, status, chevron)
/// that expands into its connect UI.
private struct PluginRow: View {
    @Environment(\.themeColors) private var colors
    @Bindable private var store = MCPConnectionStore.shared
    let server: MCPServerDefinition
    let isExpanded: Bool
    let onToggle: () -> Void

    @State private var tokenInput = ""
    @State private var clientIdInput = ""
    @State private var isHovered = false

    var body: some View {
        VStack(spacing: 0) {
            header
            if isExpanded {
                Divider().overlay(colors.borderSubtle).padding(.horizontal, 16)
                connectionControls
                    .padding(16)
            }
        }
    }

    private var header: some View {
        Button(action: onToggle) {
            HStack(spacing: 12) {
                badge
                VStack(alignment: .leading, spacing: 2) {
                    Text(server.displayName)
                        .font(AppFont.mono(14, weight: .semibold))
                        .foregroundColor(colors.textPrimary)
                    Text(server.summary)
                        .font(AppFont.sans(12))
                        .foregroundColor(colors.textSecondary)
                }
                Spacer(minLength: 12)
                statusTag
                Image(systemName: "chevron.down")
                    .font(.system(size: 11, weight: .semibold))
                    .foregroundColor(colors.textTertiary)
                    .rotationEffect(.degrees(isExpanded ? 180 : 0))
                    .iconHoverEffect(for: "chevron.down")
            }
            .padding(.horizontal, 16)
            .padding(.vertical, 14)
            .contentShape(Rectangle())
            .background(isHovered ? colors.backgroundHover : Color.clear)
        }
        .buttonStyle(.plain)
        .onHover { isHovered = $0 }
    }

    private var badge: some View {
        RoundedRectangle(cornerRadius: 8, style: .continuous)
            .fill(Color.white.opacity(0.08))
            .overlay(RoundedRectangle(cornerRadius: 8, style: .continuous).stroke(colors.borderSubtle, lineWidth: 1))
            .frame(width: 36, height: 36)
            .overlay {
                if let image = BrandLogoLoader.image(named: server.logoAssetName) {
                    Image(nsImage: image)
                        .resizable()
                        .interpolation(.high)
                        .antialiased(true)
                        .scaledToFit()
                        .frame(width: 20, height: 20)
                } else {
                    Image(systemName: "puzzlepiece.extension.fill")
                        .font(.system(size: 13, weight: .semibold))
                        .foregroundStyle(colors.textTertiary)
                }
            }
    }

    @ViewBuilder
    private var statusTag: some View {
        switch store.state(for: server.id) {
        case .connected where hasNoTools:
            HStack(spacing: 5) {
                Image(systemName: "exclamationmark.triangle.fill")
                    .font(.system(size: 10))
                Text("Connected, no tools")
            }
            .font(AppFont.mono(11, weight: .medium))
            .foregroundStyle(.orange)
        case .connected:
            HStack(spacing: 5) {
                Circle().fill(Color(hex: "#34C759")).frame(width: 7, height: 7)
                Text("Connected")
            }
            .font(AppFont.mono(11, weight: .medium))
            .foregroundColor(colors.textSecondary)
        case .connecting:
            ProgressView().controlSize(.small)
        case .needsManualClientId, .failed:
            Image(systemName: "exclamationmark.triangle.fill")
                .font(.system(size: 11))
                .foregroundStyle(.orange)
        case .disconnected:
            EmptyView()
        }
    }

    /// True once a connection attempt fully succeeded (no thrown error)
    /// but the server's own `tools/list` came back with nothing — a
    /// state that looked identical to a genuinely working connection
    /// until this was added, which is exactly how Cloudflare's missing
    /// "Account Resources: Read" permission went unnoticed: the app said
    /// "Connected" while the model had literally nothing to call.
    private var hasNoTools: Bool {
        store.isConnected(server.id) && store.tools(for: server.id).isEmpty
    }

    @ViewBuilder
    private var connectionControls: some View {
        switch store.state(for: server.id) {
        case .connected:
            VStack(alignment: .leading, spacing: 10) {
                if hasNoTools {
                    Text("Connected, but \(server.displayName) returned no tools, so the model can't do anything with it yet. " + (server.tokenHint ?? noToolsFallbackHint))
                        .font(AppFont.mono(12))
                        .foregroundColor(.orange)
                        .fixedSize(horizontal: false, vertical: true)
                        .lineSpacing(3)
                }
                HStack {
                    Text(toolCountLabel)
                        .font(AppFont.mono(12))
                        .foregroundColor(colors.textTertiary)
                    Spacer()
                    Button("Disconnect", role: .destructive) {
                        store.disconnect(server)
                    }
                    .buttonStyle(.bordered)
                }
            }

        case .connecting:
            Text(server.authMode == .oauth ? "Waiting for sign-in to finish in your browser…" : "Verifying your token and listing available tools…")
                .font(AppFont.mono(12))
                .foregroundColor(colors.textTertiary)

        case .needsManualClientId:
            VStack(alignment: .leading, spacing: 10) {
                Text("\(server.displayName) doesn't support automatic sign-in, so you'll need to create a client ID yourself once.")
                    .font(AppFont.mono(12))
                    .foregroundColor(colors.textSecondary)
                    .fixedSize(horizontal: false, vertical: true)
                    .lineSpacing(3)

                if let setupURL = server.manualClientIdSetupURL {
                    Button {
                        NSWorkspace.shared.open(setupURL)
                    } label: {
                        HStack(spacing: 5) {
                            Text("Create a \(server.displayName) app")
                            Image(systemName: "arrow.up.right")
                                .iconHoverEffect(for: "arrow.up.right")
                        }
                        .font(AppFont.mono(12, weight: .medium))
                        .foregroundColor(colors.link)
                    }
                    .buttonStyle(.plain)
                }

                if let hint = server.manualClientIdHint {
                    Text(hint)
                        .font(AppFont.sans(12.5))
                        .foregroundColor(colors.textTertiary)
                        .fixedSize(horizontal: false, vertical: true)
                        .lineSpacing(3)
                }

                HStack(spacing: 10) {
                    TextField("Paste the Client ID", text: $clientIdInput)
                        .textFieldStyle(.plain)
                        .font(AppFont.mono(13))
                        .padding(.horizontal, 12)
                        .padding(.vertical, 9)
                        .background(colors.backgroundInput)
                        .clipShape(RoundedRectangle(cornerRadius: 8, style: .continuous))
                        .overlay(
                            RoundedRectangle(cornerRadius: 8, style: .continuous)
                                .stroke(colors.borderSubtle, lineWidth: 1)
                        )
                        .onSubmit(signInWithClientId)

                    AccentButton(title: "Continue", isDisabled: clientIdInput.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty) {
                        signInWithClientId()
                    }
                }
            }

        case .disconnected, .failed:
            VStack(alignment: .leading, spacing: 10) {
                if case .failed(let message) = store.state(for: server.id) {
                    Text(message)
                        .font(AppFont.mono(12))
                        .foregroundColor(colors.destructive)
                }

                switch server.authMode {
                case .oauth:
                    AccentButton(title: "Sign in to \(server.displayName)", isDisabled: false) {
                        signIn()
                    }
                    Text("Opens \(server.displayName) in your browser to sign in. Eaon never sees your password, only the token \(server.displayName) issues afterward.")
                        .font(AppFont.sans(12.5))
                        .foregroundColor(colors.textTertiary)
                        .fixedSize(horizontal: false, vertical: true)
                        .lineSpacing(3)

                case .pastedToken:
                    HStack(spacing: 10) {
                        SecureField(server.tokenFieldPlaceholder, text: $tokenInput)
                            .textFieldStyle(.plain)
                            .font(AppFont.mono(13))
                            .padding(.horizontal, 12)
                            .padding(.vertical, 9)
                            .background(colors.backgroundInput)
                            .clipShape(RoundedRectangle(cornerRadius: 8, style: .continuous))
                            .overlay(
                                RoundedRectangle(cornerRadius: 8, style: .continuous)
                                    .stroke(colors.borderSubtle, lineWidth: 1)
                            )
                            .onSubmit(connect)

                        AccentButton(title: "Connect", isDisabled: tokenInput.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty) {
                            connect()
                        }
                    }

                    if let tokenHint = server.tokenHint {
                        Text(tokenHint)
                            .font(AppFont.sans(12.5))
                            .foregroundColor(colors.textTertiary)
                            .fixedSize(horizontal: false, vertical: true)
                            .lineSpacing(3)
                    }

                    if let tokenCreationURL = server.tokenCreationURL {
                        Button {
                            NSWorkspace.shared.open(tokenCreationURL)
                        } label: {
                            HStack(spacing: 5) {
                                Text("Create a token")
                                Image(systemName: "arrow.up.right")
                                .iconHoverEffect(for: "arrow.up.right")
                            }
                            .font(AppFont.mono(12, weight: .medium))
                            .foregroundColor(colors.link)
                        }
                        .buttonStyle(.plain)
                        .help(server.tokenCreationURLIsPrefilled
                              ? "Opens \(server.displayName) with the right permissions already selected."
                              : "Opens \(server.displayName)'s dashboard to create one.")
                    }
                }
            }
        }
    }

    private var noToolsFallbackHint: String {
        server.authMode == .oauth ? "Try disconnecting and signing in again." : "Try disconnecting and reconnecting with a different token."
    }

    private var toolCountLabel: String {
        let count = store.tools(for: server.id).count
        return "\(count) tool\(count == 1 ? "" : "s") available"
    }

    private func connect() {
        let trimmed = tokenInput.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return }
        Task {
            await store.connect(server: server, token: trimmed)
            if store.isConnected(server.id) {
                tokenInput = ""
            }
        }
    }

    private func signIn() {
        Task {
            await store.connectOAuth(server: server, interactive: true)
        }
    }

    private func signInWithClientId() {
        let trimmed = clientIdInput.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return }
        Task {
            await store.connectOAuth(server: server, interactive: true, manualClientId: trimmed)
            if store.isConnected(server.id) {
                clientIdInput = ""
            }
        }
    }
}
