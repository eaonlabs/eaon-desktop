import SwiftUI

/// Settings → Cloud Sync. Off by default; the page's job, like Device
/// Control's, is disclosure — say plainly what leaves the Mac, what doesn't,
/// and what the server can and can't read, so turning it on is an informed
/// choice rather than a mystery switch.
struct CloudSyncSettingsView: View {
    var chatViewModel: ChatViewModel

    @Environment(\.themeColors) private var colors
    @Bindable private var store = CloudSyncStore.shared
    @Bindable private var account = EaonCloudAccount.shared
    @Bindable private var engine = CloudSyncEngine.shared
    @State private var isConfirmingCloudWipe = false
    @State private var isEnteringCode = false
    @State private var enteredCode = ""
    /// Held only long enough to show the user their new code once. Never
    /// persisted — if it were recoverable from this Mac it would not be a
    /// secret, and the point of the code is that only the user has it.
    @State private var newlyMintedCode: String?
    /// Result of the most recent manual import, so the row can report what
    /// actually happened instead of silently completing.
    @State private var lastImportResult: (added: Int, updated: Int)?

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack(spacing: 10) {
                Text("Cloud Sync")
                    .font(AppFont.mono(20, weight: .bold))
                    .foregroundColor(colors.textPrimary)
                BetaBadge()
            }
            .padding(.horizontal, 32)
            .padding(.top, 28)
            .padding(.bottom, 8)

            Text("Keep your chats and memories on every machine you sign in from. Everything is encrypted here before it's uploaded, so the server only ever holds data it can't read. This is off by default. Nothing leaves this Mac until you turn it on.")
                .font(AppFont.sans(12))
                .foregroundColor(colors.textSecondary)
                .fixedSize(horizontal: false, vertical: true)
                .lineSpacing(3)
                .padding(.horizontal, 32)
                .padding(.bottom, 20)

            ScrollView {
                VStack(alignment: .leading, spacing: 16) {
                    // Identity first: the toggle below is meaningless until
                    // the database knows whose rows these are, so signing in
                    // leads and the switch stays disabled until it's done.
                    accountCard
                    toggleCard
                    if store.isEnabled, account.isSignedIn {
                        syncStatusCard
                        importCard
                    }
                    whatSyncsCard
                    privacyCard
                    if account.isSignedIn, engine.hasCloudData {
                        cloudDataCard
                    }
                }
                .padding(.horizontal, 32)
                .padding(.bottom, 32)
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
        .background(colors.backgroundPrimary)
        .sheet(isPresented: $store.isConfirmingEnable) {
            CloudSyncConfirmSheet()
        }
        .sheet(item: Binding(
            get: { newlyMintedCode.map(MintedCode.init) },
            set: { if $0 == nil { newlyMintedCode = nil } }
        )) { minted in
            SyncCodeSheet(code: minted.value) { newlyMintedCode = nil }
        }
    }

    // MARK: - Cards

    /// Sign-in. Sits above the toggle because it answers a different
    /// question — "who are you", not "may we upload" — and the second is
    /// unanswerable until the first is. Signing in on its own uploads
    /// nothing; that's what the switch below is for.
    private var accountCard: some View {
        SettingsCard {
            VStack(alignment: .leading, spacing: 0) {
                if let session = account.session {
                    HStack(spacing: 14) {
                        Image(systemName: "person.crop.circle.fill.badge.checkmark")
                            .font(.system(size: 20))
                            .foregroundColor(AppearanceSettings.shared.accentColor)
                        VStack(alignment: .leading, spacing: 3) {
                            Text(session.displayName)
                                .font(AppFont.mono(14, weight: .semibold))
                                .foregroundColor(colors.textPrimary)
                            Text("Signed in. Your synced data is filed under this account.")
                                .font(AppFont.mono(12))
                                .foregroundColor(colors.textTertiary)
                        }
                        Spacer(minLength: 0)
                        Button("Sign out") {
                            account.signOut()
                            store.disable()
                        }
                        .buttonStyle(.plain)
                        .font(AppFont.mono(12))
                        .foregroundColor(colors.textSecondary)
                        .padding(.horizontal, 12)
                        .padding(.vertical, 6)
                        .background(RoundedRectangle(cornerRadius: 7).fill(colors.backgroundChip))
                    }
                    .padding(16)
                } else {
                    VStack(alignment: .leading, spacing: 12) {
                        VStack(alignment: .leading, spacing: 3) {
                            Text("Set up sync")
                                .font(AppFont.mono(14, weight: .semibold))
                                .foregroundColor(colors.textPrimary)
                            Text("Eaon gives you a sync code. That code is the only thing identifying your data, so there's no email and no account. Keep it somewhere safe, because it's also the only way in from another machine.")
                                .font(AppFont.mono(12))
                                .foregroundColor(colors.textTertiary)
                                .fixedSize(horizontal: false, vertical: true)
                                .lineSpacing(3)
                        }

                        HStack(spacing: 10) {
                            Button {
                                Task { newlyMintedCode = await account.createSyncCode() }
                            } label: {
                                HStack(spacing: 7) {
                                    Image(systemName: "sparkles").font(.system(size: 12))
                                    Text("Create a sync code").font(AppFont.mono(12, weight: .medium))
                                }
                                .foregroundColor(colors.backgroundPrimary)
                                .padding(.horizontal, 14)
                                .padding(.vertical, 8)
                                .background(RoundedRectangle(cornerRadius: 8).fill(colors.textPrimary))
                            }
                            .buttonStyle(.plain)
                            .disabled(account.isSigningIn)

                            Button("I already have one") { isEnteringCode.toggle() }
                                .buttonStyle(.plain)
                                .font(AppFont.mono(12))
                                .foregroundColor(colors.textSecondary)
                                .padding(.horizontal, 14)
                                .padding(.vertical, 8)
                                .background(RoundedRectangle(cornerRadius: 8).fill(colors.backgroundChip))

                            if account.isSigningIn { ProgressView().controlSize(.small) }
                        }

                        if isEnteringCode {
                            HStack(spacing: 8) {
                                TextField("", text: $enteredCode, prompt: Text("XXXXX-XXXXX-XXXXX-XXXXX")
                                    .foregroundColor(colors.textTertiary))
                                    .textFieldStyle(.plain)
                                    .font(AppFont.mono(13))
                                    .foregroundColor(colors.textPrimary)
                                    .padding(.horizontal, 12).padding(.vertical, 8)
                                    .background(RoundedRectangle(cornerRadius: 8).fill(colors.backgroundInput))
                                    .onSubmit { Task { await account.signIn(withSyncCode: enteredCode) } }
                                Button("Connect") {
                                    Task { await account.signIn(withSyncCode: enteredCode) }
                                }
                                .buttonStyle(.plain)
                                .font(AppFont.mono(12, weight: .medium))
                                .foregroundColor(colors.textPrimary)
                                .padding(.horizontal, 14).padding(.vertical, 8)
                                .background(RoundedRectangle(cornerRadius: 8).fill(colors.backgroundChip))
                                .disabled(enteredCode.trimmingCharacters(in: .whitespaces).isEmpty)
                            }
                        }

                        if let error = account.lastError {
                            Text(error)
                                .font(AppFont.mono(12))
                                .foregroundColor(colors.destructive)
                                .fixedSize(horizontal: false, vertical: true)
                                .lineSpacing(3)
                        }
                    }
                    .padding(16)
                }
            }
        }
    }

    /// Live sync status: how far along, and what's still waiting. A bare
    /// spinner would be indistinguishable from a hang, which is the wrong
    /// thing to show someone about their own data leaving their machine.
    private var syncStatusCard: some View {
        SettingsCard {
            VStack(alignment: .leading, spacing: 10) {
                HStack {
                    Text(statusHeadline)
                        .font(AppFont.mono(14, weight: .semibold))
                        .foregroundColor(colors.textPrimary)
                    Spacer(minLength: 0)
                    if engine.phase.isBusy {
                        Text("\(engine.uploaded) of \(engine.total)")
                            .font(AppFont.mono(12))
                            .foregroundColor(colors.textTertiary)
                    } else {
                        Button("Sync now") {
                            Task {
                                guard let key = store.masterKey else { return }
                                await engine.sync(conversations: chatViewModel.conversations, masterKey: key)
                            }
                        }
                        .buttonStyle(.plain)
                        .font(AppFont.mono(12, weight: .medium))
                        .foregroundColor(store.isUnlocked ? colors.textPrimary : colors.textTertiary)
                        .padding(.horizontal, 12)
                        .padding(.vertical, 6)
                        .background(RoundedRectangle(cornerRadius: 7).fill(colors.backgroundChip))
                        .disabled(!store.isUnlocked)
                    }
                }

                // The bar itself. Rendered from real counts, so it can't
                // creep toward 100% while nothing is actually happening.
                GeometryReader { geometry in
                    ZStack(alignment: .leading) {
                        Capsule().fill(colors.backgroundChip)
                        Capsule()
                            .fill(AppearanceSettings.shared.accentColor)
                            .frame(width: max(0, geometry.size.width * engine.progress))
                            .animation(.easeOut(duration: 0.25), value: engine.progress)
                    }
                }
                .frame(height: 6)

                Text(statusDetail)
                    .font(AppFont.mono(12))
                    .foregroundColor(statusIsError ? colors.destructive : colors.textTertiary)
                    .fixedSize(horizontal: false, vertical: true)
                    .lineSpacing(3)
            }
            .padding(16)
        }
    }

    private var pendingCount: Int {
        engine.pendingCount(in: chatViewModel.conversations)
    }

    private var statusHeadline: String {
        switch engine.phase {
        case .syncing: return "Syncing…"
        case .importing: return "Importing from the cloud…"
        case .deleting: return "Removing your cloud data…"
        case .failed: return "Sync stopped"
        case .idle: return pendingCount == 0 ? "Everything is synced" : "Waiting to sync"
        }
    }

    private var statusIsError: Bool {
        if case .failed = engine.phase { return true }
        return false
    }

    private var statusDetail: String {
        if case .failed(let message) = engine.phase {
            return "\(message) — \(engine.uploaded) of \(engine.total) had gone up before it stopped."
        }
        if !store.isUnlocked {
            return "Locked. Enter your sync passphrase to upload. It never leaves this Mac."
        }
        if engine.phase.isBusy { return "\(engine.uploaded) of \(engine.total) items uploaded." }
        let total = chatViewModel.conversations.count
        if pendingCount == 0 {
            if let at = engine.lastSyncedAt {
                return "All \(total) chat\(total == 1 ? "" : "s") are in the cloud. Last synced \(at.formatted(date: .abbreviated, time: .shortened))."
            }
            return "Nothing waiting to upload."
        }
        return "\(pendingCount) of \(total) chat\(total == 1 ? "" : "s") not yet uploaded."
    }

    /// Bringing chats DOWN from the cloud — the other direction from the card
    /// above, and worth its own control rather than being folded into "Sync
    /// now". A user who has just signed in on a second machine is looking for
    /// exactly this word: import.
    private var importCard: some View {
        SettingsCard {
            VStack(alignment: .leading, spacing: 0) {
                cardHeader("Chats from your other devices")
                HStack(alignment: .top, spacing: 12) {
                    Image(systemName: "arrow.down.circle")
                        .font(.system(size: 14))
                        .foregroundColor(AppearanceSettings.shared.accentColor)
                        .frame(width: 22)
                    VStack(alignment: .leading, spacing: 2) {
                        Text("Import chats from the cloud")
                            .font(AppFont.mono(14, weight: .medium))
                            .foregroundColor(colors.textPrimary)
                        Text(importDetail)
                            .font(AppFont.sans(12.5))
                            .foregroundColor(colors.textTertiary)
                            .fixedSize(horizontal: false, vertical: true)
                            .lineSpacing(3)
                    }
                    Spacer(minLength: 0)
                    Button(engine.phase == .importing ? "Importing…" : "Import now") {
                        Task {
                            guard let key = store.masterKey else { return }
                            lastImportResult = await engine.importFromCloud(into: chatViewModel, masterKey: key)
                        }
                    }
                    .buttonStyle(.plain)
                    .font(AppFont.mono(12, weight: .medium))
                    .foregroundColor(store.isUnlocked ? colors.textPrimary : colors.textTertiary)
                    .padding(.horizontal, 12)
                    .padding(.vertical, 6)
                    .background(RoundedRectangle(cornerRadius: 7).fill(colors.backgroundChip))
                    .disabled(!store.isUnlocked || engine.phase.isBusy)
                }
                .padding(.horizontal, 16)
                .padding(.vertical, 12)
            }
        }
    }

    private var importDetail: String {
        if let result = lastImportResult {
            if result.added == 0 && result.updated == 0 {
                return "Nothing new — this Mac already has everything in the cloud."
            }
            var parts: [String] = []
            if result.added > 0 { parts.append("\(result.added) new chat\(result.added == 1 ? "" : "s")") }
            if result.updated > 0 { parts.append("\(result.updated) updated") }
            return "Imported " + parts.joined(separator: ", ") + "."
        }
        if let last = engine.lastImportedAt {
            return "Runs by itself once a day. Last import \(last.formatted(date: .abbreviated, time: .shortened))."
        }
        return "Pulls down chats made on your other machines. Runs by itself once a day; use this to fetch them right now."
    }

    /// The destructive control, kept visually and physically apart from the
    /// rest — and worded so it's unmistakable that it erases the *cloud*
    /// copy, not the chats on this Mac.
    private var cloudDataCard: some View {
        SettingsCard {
            VStack(alignment: .leading, spacing: 0) {
                cardHeader("Your data in the cloud")
                HStack(alignment: .top, spacing: 12) {
                    Image(systemName: "trash")
                        .font(.system(size: 14))
                        .foregroundColor(colors.destructive)
                        .frame(width: 22)
                    VStack(alignment: .leading, spacing: 2) {
                        Text("Delete everything in the cloud")
                            .font(AppFont.mono(14, weight: .medium))
                            .foregroundColor(colors.textPrimary)
                        Text("Erases every chat, memory, and attachment this account has stored on the server. The chats on this Mac are not touched.")
                            .font(AppFont.sans(12.5))
                            .foregroundColor(colors.textTertiary)
                            .fixedSize(horizontal: false, vertical: true)
                            .lineSpacing(3)
                    }
                    Spacer(minLength: 0)
                    Button("Delete") { isConfirmingCloudWipe = true }
                        .buttonStyle(.plain)
                        .font(AppFont.mono(12, weight: .medium))
                        .foregroundColor(colors.destructive)
                        .padding(.horizontal, 12)
                        .padding(.vertical, 6)
                        .background(RoundedRectangle(cornerRadius: 7).fill(colors.backgroundChip))
                        .disabled(engine.phase.isBusy)
                }
                .padding(.horizontal, 16)
                .padding(.vertical, 12)
            }
        }
        .alert("Delete your cloud data?", isPresented: $isConfirmingCloudWipe) {
            Button("Cancel", role: .cancel) {}
            Button("Delete from cloud", role: .destructive) {
                Task { await engine.deleteAllCloudData() }
            }
        } message: {
            Text("Every chat, memory, and attachment stored on the server for this account is erased. Your chats on this Mac stay exactly as they are. This can't be undone.")
        }
    }

    /// The switch itself. Bound through a custom `Binding` rather than
    /// directly to `store.isEnabled`: flipping it on must open the
    /// confirmation instead of enabling, and the switch has to spring back
    /// to off while that's pending — which it does for free here, because
    /// `isEnabled` genuinely hasn't changed yet.
    private var toggleCard: some View {
        SettingsCard {
            HStack(spacing: 14) {
                VStack(alignment: .leading, spacing: 3) {
                    Text("Sync my data across devices")
                        .font(AppFont.mono(14, weight: .semibold))
                        .foregroundColor(colors.textPrimary)
                    Text(!EaonCloudAccount.shared.isSignedIn
                         ? "Sign in above first, so the cloud knows whose data this is."
                         : store.isEnabled
                           ? "On — your encrypted chats, memories, and attachments are kept in sync."
                           : "Off — everything stays on this Mac. Nothing is uploaded.")
                        .font(AppFont.mono(12))
                        .foregroundColor(colors.textTertiary)
                        .fixedSize(horizontal: false, vertical: true)
                        .lineSpacing(3)
                }
                Spacer(minLength: 0)
                Toggle("", isOn: Binding(
                    get: { store.isEnabled },
                    set: { wantsOn in
                        if wantsOn { store.requestEnable() } else { store.disable() }
                    }
                ))
                .labelsHidden()
                .toggleStyle(.switch)
                .tint(AppearanceSettings.toggleTint)
                // Unreachable until signed in: there'd be no account to file
                // the data under, so letting it be switched on would promise
                // something the app can't deliver.
                .disabled(!EaonCloudAccount.shared.isSignedIn)
            }
            .padding(16)
        }
    }

    private var whatSyncsCard: some View {
        SettingsCard {
            VStack(alignment: .leading, spacing: 0) {
                cardHeader("What syncs")
                row("bubble.left.and.bubble.right", "Chats", "Every conversation, its messages, and its title.")
                divider
                row("brain", "Memories", "The facts Eaon remembers about you.")
                divider
                row("paperclip", "Attachments & generated images", "The files and images inside your chats.")
                divider
                row("xmark.circle", "Not synced", "Your API keys, and this Mac's own settings, never leave the machine.")
            }
        }
    }

    private var privacyCard: some View {
        SettingsCard {
            VStack(alignment: .leading, spacing: 0) {
                cardHeader("What the server can see")
                row("lock.fill", "Not your messages", "Everything is encrypted here, with a key derived from your passphrase, before it's uploaded. The server only ever holds unreadable data.")
                divider
                row("key.fill", "Not your passphrase", "It never leaves this Mac. Nobody can unlock your chats without it, us included, which also means we can't recover them for you. You'll get a recovery code when you set it up.")
                divider
                row("clock", "Only that something changed", "The server sees an anonymous id and a timestamp per item, which is what lets your devices work out who has the newer copy.")
            }
        }
    }

    // MARK: - Shared bits (matching Device Control's page)

    private func cardHeader(_ title: String) -> some View {
        Text(title)
            .font(AppFont.mono(12, weight: .semibold))
            .foregroundColor(colors.textTertiary)
            .tracking(0.5)
            .padding(.horizontal, 16)
            .padding(.top, 14)
            .padding(.bottom, 8)
    }

    private var divider: some View {
        Divider().overlay(colors.borderSubtle).padding(.leading, 16)
    }

    private func row(_ icon: String, _ title: String, _ detail: String) -> some View {
        HStack(alignment: .top, spacing: 12) {
            Image(systemName: icon)
                .font(.system(size: 14))
                .foregroundColor(AppearanceSettings.shared.accentColor)
                .frame(width: 22)
            VStack(alignment: .leading, spacing: 2) {
                Text(title)
                    .font(AppFont.mono(14, weight: .medium))
                    .foregroundColor(colors.textPrimary)
                Text(detail)
                    .font(AppFont.sans(12.5))
                    .foregroundColor(colors.textTertiary)
                    .fixedSize(horizontal: false, vertical: true)
                    .lineSpacing(3)
            }
            Spacer(minLength: 0)
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 12)
    }
}

/// The type-to-confirm gate in front of enabling sync.
///
/// A switch is a one-click, easily-mistaken gesture, and this particular one
/// starts sending the user's conversations off their machine. Requiring the
/// phrase to be typed makes that impossible to do by accident or by muscle
/// memory — the same reasoning behind GitHub asking you to type a repo's
/// name before deleting it. The Enable button stays disabled until the
/// phrase matches, so the only way through is to have read it.
private struct CloudSyncConfirmSheet: View {
    @Environment(\.themeColors) private var colors
    @Bindable private var store = CloudSyncStore.shared
    @FocusState private var fieldFocused: Bool

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack(spacing: 10) {
                Image(systemName: "icloud.and.arrow.up")
                    .font(.system(size: 16, weight: .semibold))
                    .foregroundColor(AppearanceSettings.shared.accentColor)
                Text("Turn on cloud sync?")
                    .font(AppFont.mono(15, weight: .bold))
                    .foregroundColor(colors.textPrimary)
            }
            .padding(.bottom, 10)

            Text("Right now your chats exist only on this Mac. Turning this on starts uploading them. They're encrypted, so the server can't read them, but they do leave this machine.")
                .font(AppFont.sans(12))
                .foregroundColor(colors.textSecondary)
                .fixedSize(horizontal: false, vertical: true)
                .lineSpacing(3)
                .padding(.bottom, 16)

            Text("Type ")
                .font(AppFont.sans(12))
                .foregroundColor(colors.textSecondary)
            + Text("\(CloudSyncStore.confirmationPhrase)")
                .font(AppFont.mono(12, weight: .bold))
                .foregroundColor(colors.textPrimary)
            + Text(" to confirm.")
                .font(AppFont.sans(12))
                .foregroundColor(colors.textSecondary)

            TextField("", text: $store.confirmationInput, prompt: Text(CloudSyncStore.confirmationPhrase)
                .foregroundColor(colors.textTertiary))
                .textFieldStyle(.plain)
                .font(AppFont.mono(13))
                .foregroundColor(colors.textPrimary)
                .padding(.horizontal, 12)
                .padding(.vertical, 9)
                .background(
                    RoundedRectangle(cornerRadius: 8)
                        .fill(colors.backgroundInput)
                        .overlay(
                            RoundedRectangle(cornerRadius: 8)
                                .stroke(store.confirmationMatches
                                        ? AppearanceSettings.shared.accentColor.opacity(0.7)
                                        : colors.borderSubtle,
                                        lineWidth: 1)
                        )
                )
                .focused($fieldFocused)
                // Enter is a shortcut for the confirm button, not a bypass —
                // it goes through the same guarded path, so it does nothing
                // until the phrase actually matches.
                .onSubmit { store.confirmEnable() }
                .padding(.top, 8)
                .padding(.bottom, 18)

            HStack(spacing: 10) {
                Spacer()
                Button("Cancel") { store.cancelEnable() }
                    .buttonStyle(.plain)
                    .font(AppFont.mono(12))
                    .foregroundColor(colors.textSecondary)
                    .padding(.horizontal, 14)
                    .padding(.vertical, 7)
                    .background(RoundedRectangle(cornerRadius: 7).fill(colors.backgroundChip))
                    .keyboardShortcut(.cancelAction)

                Button("Turn on sync") { store.confirmEnable() }
                    .buttonStyle(.plain)
                    .font(AppFont.mono(12, weight: .semibold))
                    .foregroundColor(store.confirmationMatches ? AppearanceSettings.shared.onAccentColor : colors.textTertiary)
                    .padding(.horizontal, 14)
                    .padding(.vertical, 7)
                    .background(
                        RoundedRectangle(cornerRadius: 7)
                            .fill(store.confirmationMatches
                                  ? AppearanceSettings.shared.accentColor
                                  : colors.backgroundChip)
                    )
                    .disabled(!store.confirmationMatches)
            }
        }
        .padding(22)
        .frame(width: 430)
        .background(colors.backgroundPrimary)
        .onAppear { fieldFocused = true }
    }
}

/// Wrapper so the freshly minted code can drive a `.sheet(item:)` — a bare
/// `String` isn't `Identifiable`.
private struct MintedCode: Identifiable {
    let value: String
    var id: String { value }
}

/// Shown once, immediately after a code is created, and never again.
///
/// The code is the account and the decryption key at the same time, so this
/// is the only moment it can be captured. Deliberately blunt about that:
/// people dismiss "save this" dialogs reflexively, and the cost of getting
/// it wrong here is every synced chat, permanently.
private struct SyncCodeSheet: View {
    @Environment(\.themeColors) private var colors
    let code: String
    let onDone: () -> Void
    @State private var didCopy = false
    @State private var acknowledged = false

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack(spacing: 10) {
                Image(systemName: "key.horizontal.fill")
                    .font(.system(size: 16, weight: .semibold))
                    .foregroundColor(AppearanceSettings.shared.accentColor)
                Text("Your sync code")
                    .font(AppFont.mono(15, weight: .bold))
                    .foregroundColor(colors.textPrimary)
            }
            .padding(.bottom, 10)

            Text("Write this down or put it in your password manager. It's the only way to reach your chats from another machine, and the only way to decrypt them. Nobody can recover it for you, us included.")
                .font(AppFont.sans(12))
                .foregroundColor(colors.textSecondary)
                .fixedSize(horizontal: false, vertical: true)
                .lineSpacing(3)
                .padding(.bottom, 16)

            HStack {
                Text(code)
                    .font(AppFont.mono(18, weight: .bold))
                    .foregroundColor(colors.textPrimary)
                    .textSelection(.enabled)
                Spacer()
                Button(didCopy ? "Copied" : "Copy") {
                    NSPasteboard.general.clearContents()
                    NSPasteboard.general.setString(code, forType: .string)
                    didCopy = true
                }
                .buttonStyle(.plain)
                .font(AppFont.mono(12, weight: .medium))
                .foregroundColor(colors.textSecondary)
                .padding(.horizontal, 12).padding(.vertical, 6)
                .background(RoundedRectangle(cornerRadius: 7).fill(colors.backgroundChip))
            }
            .padding(14)
            .background(
                RoundedRectangle(cornerRadius: 10)
                    .fill(colors.backgroundInput)
                    .overlay(RoundedRectangle(cornerRadius: 10).stroke(colors.borderSubtle, lineWidth: 1))
            )
            .padding(.bottom, 16)

            Toggle(isOn: $acknowledged) {
                Text("I've saved my sync code somewhere safe")
                    .font(AppFont.sans(12))
                    .foregroundColor(colors.textSecondary)
            }
            .toggleStyle(.checkbox)
            .padding(.bottom, 18)

            HStack {
                Spacer()
                Button("Done") { onDone() }
                    .buttonStyle(.plain)
                    .font(AppFont.mono(12, weight: .semibold))
                    .foregroundColor(acknowledged ? AppearanceSettings.shared.onAccentColor : colors.textTertiary)
                    .padding(.horizontal, 16).padding(.vertical, 7)
                    .background(
                        RoundedRectangle(cornerRadius: 7)
                            .fill(acknowledged ? AppearanceSettings.shared.accentColor : colors.backgroundChip)
                    )
                    .disabled(!acknowledged)
            }
        }
        .padding(22)
        .frame(width: 440)
        .background(colors.backgroundPrimary)
        .interactiveDismissDisabled(!acknowledged)
    }
}
