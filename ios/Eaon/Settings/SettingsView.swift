import SwiftUI

/// How the app looks. Follows the phone unless told otherwise.
enum AppTheme: String, CaseIterable, Identifiable {
    case system, light, dark

    var id: String { rawValue }

    var title: String {
        switch self {
        case .system: "System"
        case .light: "Light"
        case .dark: "Dark"
        }
    }

    var colorScheme: ColorScheme? {
        switch self {
        case .system: nil
        case .light: .light
        case .dark: .dark
        }
    }

    static let storageKey = "eaon.theme"
}

/// Settings, as a sheet after ChatGPT's: you at the top, then which models, how it looks, and what's kept.
struct SettingsView: View {
    @Environment(SessionStore.self) private var session
    @Environment(AuthController.self) private var auth
    @Environment(ModelCatalog.self) private var catalog
    @Environment(ChatStore.self) private var store
    @Environment(ChatController.self) private var chat
    @Environment(AppNavigator.self) private var navigator
    @Environment(AgentsStore.self) private var agents
    @Environment(\.openURL) private var openURL
    @Environment(\.dismiss) private var dismiss

    @AppStorage(AppTheme.storageKey) private var theme = AppTheme.system
    @AppStorage(Haptic.defaultsKey) private var haptics = true

    @State private var showsPicker = false
    @State private var showsMac = false
    @State private var editing: Provider?
    @State private var addingProvider = false
    @State private var confirmsSignOut = false
    @State private var confirmsClearChats = false
    @State private var confirmsErase = false

    var body: some View {
        NavigationStack {
            List {
                Section { profile }
                    .listRowBackground(Color.clear)
                    .listRowInsets(EdgeInsets(top: 0, leading: 0, bottom: 4, trailing: 0))

                if session.account == nil {
                    Section { signInCard }
                        .listRowBackground(Palette.surface)
                }

                Section {
                    row(icon: "sparkles", title: "Model", value: catalog.activeModel?.name ?? "None") { showsPicker = true }
                    row(icon: "iphone", title: "Apple Intelligence", value: catalog.onDevice.isAvailable ? "Ready" : "Unavailable", chevron: false)
                    row(icon: "laptopcomputer", title: "Mac", value: macValue) { showsMac = true }
                    row(icon: IconTile.agentFace, title: "Agents", value: agentCount) {
                        dismiss()
                        navigator.go(.agents)
                    }
                } header: {
                    header("Models")
                }
                .listRowBackground(Palette.surface)

                Section {
                    ForEach(catalog.providers) { provider in
                        row(icon: "cloud", title: provider.name, value: provider.modelID) { editing = provider }
                            .swipeActions(edge: .trailing, allowsFullSwipe: true) {
                                Button(role: .destructive) {
                                    Haptic.warning()
                                    catalog.delete(provider)
                                } label: {
                                    Label("Remove", systemImage: "trash")
                                }
                            }
                    }
                    row(icon: "plus", title: "Add a provider", value: nil) { addingProvider = true }
                } header: {
                    header("Providers")
                } footer: {
                    Text("Keys are kept in this iPhone's Keychain and sent only to the provider they belong to.")
                }
                .listRowBackground(Palette.surface)

                Section {
                    Picker(selection: $theme) {
                        ForEach(AppTheme.allCases) { Text($0.title).tag($0) }
                    } label: {
                        tileLabel("circle.lefthalf.filled", "Appearance")
                    }
                    .pickerStyle(.menu)
                    Toggle(isOn: $haptics) {
                        tileLabel("hand.tap", "Haptics")
                    }
                    .tint(Palette.positive)
                } header: {
                    header("Appearance")
                }
                .listRowBackground(Palette.surface)

                Section {
                    row(icon: "bubble.left.and.text.bubble.right", title: "Chats on this iPhone", value: "\(store.conversations.count)", chevron: false)
                    Button(role: .destructive) {
                        confirmsClearChats = true
                    } label: {
                        tileLabel("trash", "Delete all chats", tint: Palette.negative)
                    }
                    .disabled(store.conversations.isEmpty)
                    if session.account != nil {
                        Button(role: .destructive) {
                            confirmsSignOut = true
                        } label: {
                            tileLabel("rectangle.portrait.and.arrow.right", "Sign out", tint: Palette.negative)
                        }
                    }
                    Button(role: .destructive) {
                        confirmsErase = true
                    } label: {
                        tileLabel("exclamationmark.triangle", "Erase everything on this iPhone", tint: Palette.negative)
                    }
                } header: {
                    header("Your data")
                } footer: {
                    Text("Chats, keys and the Mac connection stay on this iPhone. Nothing is sent to an Eaon server.")
                }
                .listRowBackground(Palette.surface)

                Section {
                    row(icon: "info.circle", title: "Version", value: version, chevron: false)
                    row(icon: "safari", title: "eaon.dev", value: nil) {
                        if let url = URL(string: "https://eaon.dev") { openURL(url) }
                    }
                } header: {
                    header("About")
                }
                .listRowBackground(Palette.surface)
            }
            .listStyle(.insetGrouped)
            .listSectionSpacing(22)
            .scrollContentBackground(.hidden)
            .background(ScreenBackground())
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarTrailing) {
                    Button {
                        dismiss()
                    } label: {
                        Image(systemName: "xmark")
                    }
                    .accessibilityLabel("Close")
                }
            }
        }
        .tint(Palette.ink)
        .presentationBackground(Palette.background)
        .presentationDragIndicator(.hidden)
        .sheet(isPresented: $showsPicker) { ModelPickerView() }
        .sheet(isPresented: $showsMac) { ConnectMacView() }
        .sheet(item: $editing) { ProviderEditor(provider: $0) }
        .sheet(isPresented: $addingProvider) { ProviderEditor(provider: nil) }
        .confirmationDialog("Sign out of Eaon?", isPresented: $confirmsSignOut, titleVisibility: .visible) {
            Button("Sign out", role: .destructive) { session.signOut() }
        } message: {
            Text("Your chats stay on this iPhone.")
        }
        .confirmationDialog("Delete all chats?", isPresented: $confirmsClearChats, titleVisibility: .visible) {
            Button("Delete \(store.conversations.count) chat\(store.conversations.count == 1 ? "" : "s")", role: .destructive) {
                Haptic.warning()
                chat.newChat()
                store.deleteAll()
            }
        } message: {
            Text("This can't be undone.")
        }
        .confirmationDialog("Erase everything on this iPhone?", isPresented: $confirmsErase, titleVisibility: .visible) {
            Button("Erase everything", role: .destructive) {
                Haptic.warning()
                chat.newChat()
                store.deleteAll()
                agents.phone.eraseAll()
                catalog.eraseEverything()
                session.eraseEverything()
            }
        } message: {
            Text("Deletes your chats, your agents on this iPhone, provider keys and the Mac connection, and signs you out.")
        }
    }

    // MARK: You

    /// Your picture and name in the middle, as ChatGPT puts them.
    private var profile: some View {
        VStack(spacing: 10) {
            AvatarView(account: session.account, size: 76)
                .entrance(rise: 8, scale: 0.7, animation: Springs.bouncy)
            VStack(spacing: 3) {
                Text(session.account?.displayName ?? "Guest")
                    .font(.title2.weight(.bold))
                    .foregroundStyle(Palette.ink)
                    .lineLimit(1)
                if let account = session.account {
                    HStack(spacing: 5) {
                        Image(systemName: "checkmark.seal.fill")
                        Text(account.detail ?? account.provider.title)
                    }
                    .font(.subheadline)
                    .foregroundStyle(Palette.secondary)
                    .lineLimit(1)
                }
            }
            .entrance(delay: 0.06)
        }
        .frame(maxWidth: .infinity)
        .padding(.top, 4)
        .accessibilityElement(children: .combine)
    }

    /// For a guest: what signing in is for, and the two ways to.
    private var signInCard: some View {
        VStack(alignment: .leading, spacing: 14) {
            VStack(alignment: .leading, spacing: 4) {
                Text("Sign in to Eaon")
                    .font(.headline)
                    .foregroundStyle(Palette.ink)
                Text("Keep Eaon tied to you. Your chats stay on this iPhone either way.")
                    .font(.subheadline)
                    .foregroundStyle(Palette.secondary)
                    .fixedSize(horizontal: false, vertical: true)
            }
            HStack(spacing: 10) {
                signInButton("Apple", icon: Image(systemName: "apple.logo"), prominent: true) {
                    Task { await auth.signInWithApple() }
                }
                signInButton("GitHub", icon: Image("GitHubMark").renderingMode(.template), prominent: false) {
                    Task { await auth.startGitHub() }
                }
            }
            if let issue = auth.issue {
                Callout(kind: .error, title: issue.title, message: issue.message, detail: issue.detail, onDismiss: auth.dismissIssue)
            }
        }
        .padding(.vertical, 8)
    }

    private func signInButton(_ title: String, icon: Image, prominent: Bool, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            HStack(spacing: 8) {
                if auth.busy == (title == "Apple" ? .apple : .github) {
                    ProgressView().controlSize(.small)
                } else {
                    icon.resizable().scaledToFit().frame(width: 17, height: 17)
                }
                Text(title)
            }
        }
        .buttonStyle(PillButtonStyle(kind: prominent ? .primary : .secondary))
        .disabled(auth.busy != nil)
    }

    // MARK: Rows

    private var agentCount: String {
        let count = agents.phone.agents.count + agents.mac.agents.count
        return count == 0 ? "None yet" : "\(count)"
    }

    private var macValue: String {
        switch catalog.macStatus {
        case .notConnected: "Not connected"
        case .connecting: "Connecting…"
        case .connected: catalog.macName
        case .failed: "Can't reach"
        }
    }

    private var version: String {
        let info = Bundle.main.infoDictionary
        let short = info?["CFBundleShortVersionString"] as? String ?? "0.1"
        let build = info?["CFBundleVersion"] as? String ?? "1"
        return "\(short) (\(build))"
    }

    /// A section's name, bold and grey above its card.
    private func header(_ text: String) -> some View {
        Text(text)
            .font(.headline)
            .foregroundStyle(Palette.secondary)
            .textCase(nil)
            .padding(.leading, -4)
    }

    private func tileLabel(_ icon: String, _ title: String, tint: Color = Palette.ink) -> some View {
        HStack(spacing: 14) {
            IconTile(systemImage: icon, tint: tint, size: 28)
            Text(title).foregroundStyle(tint)
        }
    }

    @ViewBuilder
    private func row(icon: String, title: String, value: String?, chevron: Bool = true, action: (() -> Void)? = nil) -> some View {
        let content = HStack(spacing: 14) {
            IconTile(systemImage: icon, size: 28)
            Text(title).foregroundStyle(Palette.ink).lineLimit(1)
            Spacer(minLength: 8)
            if let value {
                Text(value)
                    .foregroundStyle(Palette.secondary)
                    .lineLimit(1)
            }
            if action != nil && chevron {
                Image(systemName: "chevron.right")
                    .font(.system(size: 13, weight: .semibold))
                    .foregroundStyle(Palette.tertiary)
            }
        }
        .frame(minHeight: 32)
        .contentShape(Rectangle())
        if let action {
            Button {
                Haptic.select()
                action()
            } label: { content }
            .buttonStyle(.plain)
        } else {
            content
        }
    }
}
