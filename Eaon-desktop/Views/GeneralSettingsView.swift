import AppKit
import SwiftUI

/// The "General" settings pane — app identity, updates, data location, and
/// support. Laid out as titled cards (section header inside a subtle
/// rounded container, rows separated by hairline dividers, control
/// right-aligned per row), matching the reference Settings design.
struct GeneralSettingsView: View {
    @Environment(\.themeColors) private var colors
    @Bindable private var updateChecker = UpdateChecker.shared

    @State private var showingCLISheet = false
    @State private var cliStatus: EaonCLILauncher.Status?
    @State private var giftStatus: FreeWeekTrial.GiftStatus?

    // The dev build is a bare executable with no Info.plist, so the bundle
    // never has a version — `AppVersion.current` is the source of truth.
    private var appVersion: String { AppVersion.current }

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            Text("General")
                .font(AppFont.mono(20, weight: .bold))
                .foregroundColor(colors.textPrimary)
                .padding(.horizontal, 32)
                .padding(.top, 50)
                .padding(.bottom, 20)

            ScrollView {
                VStack(alignment: .leading, spacing: 20) {
                    generalCard
                    assistantCard
                    cliCard
                    dataFolderCard
                    giftsCard
                    aboutCard
                }
                .padding(.horizontal, 32)
                .padding(.bottom, 32)
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
        .background(colors.backgroundPrimary)
        .sheet(isPresented: $showingCLISheet) {
            EaonCLIInfoSheet()
        }
        .task {
            cliStatus = await Task.detached { EaonCLILauncher.status() }.value
        }
        .task {
            giftStatus = await FreeWeekTrial.fetchGiftStatus()
        }
    }

    // MARK: - Desktop assistant

    /// The floating Ask-Eaon pill (menu bar sparkle / ⌥Space) — one switch,
    /// since everything it controls (status item, hotkey, panel) comes and
    /// goes together.
    private var assistantCard: some View {
        SettingsSectionCard(title: "Desktop Assistant") {
            SettingsSectionRow(
                title: "Floating assistant",
                description: "A compact Ask-Eaon bar that floats above your other windows, using your current model. Toggle it with the sparkle in the menu bar, or ⌥Space when no other app owns that shortcut."
            ) {
                Toggle("", isOn: Bindable(DesktopAssistantStore.shared).isEnabled)
                    .labelsHidden()
                    .toggleStyle(.switch)
                    .tint(AppearanceSettings.toggleTint)
            }

            SettingsSectionRowDivider()

            SettingsSectionRow(
                title: "Desktop pet",
                description: "A little companion that roams your screen and reacts to your conversations — it works while you wait, gets happy or hurt depending on what's said, and dozes off when idle. Click it to open the floating assistant; attach \"My screen\" from its + menu to ask about what's on screen, and it'll fly over and point at what it finds."
            ) {
                Toggle("", isOn: Bindable(EaonPetStore.shared).isEnabled)
                    .labelsHidden()
                    .toggleStyle(.switch)
                    .tint(AppearanceSettings.toggleTint)
            }
        }
    }

    // MARK: - Eaon CLI

    /// Entry point to the CLI control hub — a quick status/version summary
    /// plus a "Manage" button opening `EaonCLIInfoSheet`, which carries the
    /// full setup commands, config-file access, and command reference.
    private var cliCard: some View {
        SettingsSectionCard(title: "Eaon CLI") {
            SettingsSectionRow(
                title: "Eaon in your terminal",
                description: "Agentic coding, Claw, and chat for any model — the engine behind Eaon Code, runnable in any terminal."
            ) {
                pillButton(title: "Manage", icon: "terminal") {
                    showingCLISheet = true
                }
            }

            SettingsSectionRowDivider()

            SettingsSectionRow(
                title: "Status",
                description: cliStatusDescription
            ) {
                if let cliStatus, let version = cliStatus.version {
                    Text("v\(version)")
                        .font(AppFont.mono(13, weight: .medium))
                        .foregroundColor(colors.textSecondary)
                }
            }
        }
    }

    private var cliStatusDescription: String {
        guard let cliStatus else { return "Checking…" }
        if let newer = cliStatus.updateAvailable { return "Update available — v\(newer). Open Manage to update." }
        if cliStatus.isReady { return "Ready — Eaon Code launches it automatically." }
        if cliStatus.nodePath == nil { return "Node.js not found. Open Manage for setup steps." }
        return "Not built yet. Open Manage for the setup commands." }

    // MARK: - General

    private var generalCard: some View {
        SettingsSectionCard(title: "General") {
            SettingsSectionRow(title: "App Version") {
                Text(appVersion)
                    .font(AppFont.mono(13, weight: .medium))
                    .foregroundColor(colors.textSecondary)
            }

            SettingsSectionRowDivider()

            SettingsSectionRow(
                title: "Automatic Update Check",
                description: "Automatically check for updates on startup and periodically."
            ) {
                Toggle("", isOn: $updateChecker.isAutoCheckEnabled)
                    .labelsHidden()
                    .toggleStyle(.switch)
                    .tint(AppearanceSettings.toggleTint)
            }

            SettingsSectionRowDivider()

            SettingsSectionRow(
                title: "Check for Updates",
                description: updateChecker.lastManualCheckResult ?? "Check if a newer version of Eaon is available."
            ) {
                pillButton(title: "Check for Updates", isLoading: updateChecker.isCheckingManually) {
                    Task { await updateChecker.checkManually() }
                }
                .disabled(updateChecker.isCheckingManually)
            }
        }
    }

    // MARK: - Data Folder

    /// "Downloaded local models and file attachments" — deliberately not
    /// "messages": conversations actually live in UserDefaults (see
    /// `LegacyDefaultsMigrator`), not this folder, so claiming otherwise
    /// here would just be wrong.
    private var dataFolderCard: some View {
        SettingsSectionCard(title: "Data Folder") {
            SettingsSectionRow(
                title: "App Data",
                description: "Downloaded local models and file attachments."
            ) {
                pillButton(title: "Show in Finder", icon: "folder") {
                    NSWorkspace.shared.activateFileViewerSelecting([AppDataLocation.directory])
                }
            }

            // The real on-disk path, as a copyable chip beneath the row —
            // same placement as the reference.
            HStack(spacing: 8) {
                Text(AppDataLocation.directory.path)
                    .font(AppFont.mono(11))
                    .foregroundColor(colors.textTertiary)
                    .lineLimit(1)
                    .truncationMode(.middle)
                Button {
                    NSPasteboard.general.clearContents()
                    NSPasteboard.general.setString(AppDataLocation.directory.path, forType: .string)
                } label: {
                    Image(systemName: "doc.on.doc")
                        .font(.system(size: 11))
                        .foregroundColor(colors.textTertiary)
                        .iconHoverEffect(for: "doc.on.doc")
                }
                .buttonStyle(.plain)
                .help("Copy path")
                Spacer(minLength: 0)
            }
            .padding(.horizontal, 10)
            .padding(.vertical, 7)
            .background(RoundedRectangle(cornerRadius: 7, style: .continuous).fill(colors.backgroundInputSecondary))
            .padding(.bottom, 14)
        }
    }

    // MARK: - Gifts

    /// Today this is one gift — the Free Week — but framed as its own
    /// section (rather than folded into "About") so it reads as a stable,
    /// always-there place to check "what can I redeem," the way the
    /// Providers page's `freeWeekCard` (a contextual nudge that hides once
    /// there's nothing to offer) deliberately isn't.
    private var giftsCard: some View {
        SettingsSectionCard(title: "Gifts") {
            VStack(alignment: .leading, spacing: 0) {
                freeWeekGiftRow
            }
            .padding(.bottom, 14)
        }
    }

    @ViewBuilder
    private var freeWeekGiftRow: some View {
        let trial = TrialStore.shared

        VStack(alignment: .leading, spacing: 10) {
            HStack(spacing: 8) {
                Image(systemName: "gift.fill")
                    .font(.system(size: 13, weight: .semibold))
                    .foregroundColor(AppearanceSettings.shared.accentColor)
                Text("Free Week")
                    .font(AppFont.mono(14, weight: .semibold))
                    .foregroundColor(colors.textPrimary)
                Spacer()
                giftBadge(trial: trial)
            }

            Text(giftDescription(trial: trial))
                .font(AppFont.sans(12))
                .foregroundColor(colors.textSecondary)
                .fixedSize(horizontal: false, vertical: true)

            // Only "never redeemed yet" has anything actionable to show —
            // every other state is purely informational (see
            // giftDescription). Redeeming no longer depends on whether a
            // key is saved: the trial is its own independent provider now,
            // not something a key makes redundant.
            if trial.credential == nil {
                if let giftStatus, !giftStatus.available {
                    Text("Email \(giftStatus.supportEmail) with the subject \u{201c}extra usage\u{201d} if you need access.")
                        .font(AppFont.sans(11.5))
                        .foregroundColor(colors.textTertiary)
                        .fixedSize(horizontal: false, vertical: true)
                } else {
                    HStack(spacing: 10) {
                        pillButton(title: trial.isStarting ? "Starting…" : "Redeem", icon: "gift", isLoading: trial.isStarting) {
                            guard !trial.isStarting else { return }
                            Task {
                                await trial.start()
                                if trial.isActive {
                                    giftStatus = await FreeWeekTrial.fetchGiftStatus()
                                }
                            }
                        }
                        .disabled(trial.isStarting)

                        if let giftStatus {
                            Text("\(giftStatus.remaining) of \(giftStatus.total) left · through \(Self.giftExpiryFormatter.string(from: giftStatus.expiresAt))")
                                .font(AppFont.sans(11))
                                .foregroundColor(colors.textTertiary)
                        }
                    }

                    if let error = trial.lastError {
                        Text(error)
                            .font(AppFont.sans(11.5))
                            .foregroundColor(colors.destructive)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                }
            }
        }
        .padding(.top, 14)
    }

    @ViewBuilder
    private func giftBadge(trial: TrialStore) -> some View {
        if trial.isActive {
            badgePill("\(trial.daysLeft) day\(trial.daysLeft == 1 ? "" : "s") left", color: Color(hex: "#34C759"))
        } else if trial.isExpired {
            badgePill("Claimed", color: colors.textTertiary)
        } else if let giftStatus, !giftStatus.available {
            badgePill("Closed", color: colors.textTertiary)
        }
    }

    private func badgePill(_ title: String, color: Color) -> some View {
        Text(title)
            .font(AppFont.mono(10.5, weight: .semibold))
            .foregroundColor(color)
            .padding(.horizontal, 7)
            .padding(.vertical, 3)
            .background(Capsule().fill(color.opacity(0.14)))
    }

    private func giftDescription(trial: TrialStore) -> String {
        if trial.isActive {
            return "Hosted models are on the house through \(trial.credential.map { Self.giftExpiryFormatter.string(from: $0.expiresAt) } ?? "the end of the week") — works alongside your own Eaon API key, if you have one, as its own separate provider."
        }
        if trial.isExpired {
            return "Your free week has ended. Your own Eaon API key (if you have one) is unaffected."
        }
        if let giftStatus, !giftStatus.available {
            return "The first \(giftStatus.total) free weeks have all been claimed, or the offer window has closed."
        }
        return "7 days of every hosted model, free — one click, no account, no card, and it keeps working even if you already have your own Eaon API key. Limited to the first \(giftStatus?.total ?? 100) people to redeem, through \(giftStatus.map { Self.giftExpiryFormatter.string(from: $0.expiresAt) } ?? "the offer's deadline")."
    }

    private static let giftExpiryFormatter: DateFormatter = {
        let formatter = DateFormatter()
        formatter.dateStyle = .medium
        formatter.timeStyle = .none
        return formatter
    }()

    // MARK: - About & Support

    private var aboutCard: some View {
        SettingsSectionCard(title: "About") {
            SettingsSectionRow(
                title: "Website",
                description: "Unified free AI API platform for top models."
            ) {
                pillButton(title: "eaon.dev", icon: "arrow.up.right") {
                    NSWorkspace.shared.open(URL(string: "https://eaon.dev")!)
                }
            }

            SettingsSectionRowDivider()

            SettingsSectionRow(
                title: "Support",
                description: "support@eaon.dev"
            ) {
                pillButton(title: "Email Us") {
                    NSWorkspace.shared.open(URL(string: "mailto:support@eaon.dev")!)
                }
            }
        }
    }

    // MARK: - Shared

    private func pillButton(title: String, icon: String? = nil, isLoading: Bool = false, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            HStack(spacing: 6) {
                if isLoading {
                    ProgressView().controlSize(.small)
                } else if let icon {
                    Image(systemName: icon)
                        .font(.system(size: 11))
                        .iconHoverEffect(for: icon)
                }
                Text(title)
                    .font(AppFont.mono(12, weight: .semibold))
            }
            .foregroundColor(colors.textPrimary)
            .padding(.horizontal, 14)
            .padding(.vertical, 7)
            .background(Capsule().fill(colors.backgroundInputSecondary))
        }
        .buttonStyle(PressableButtonStyle())
    }
}

// MARK: - Reusable card + row components

/// A titled settings card: a bold section header sitting inside a subtle
/// rounded container, with its rows laid out beneath it. Rows are placed by
/// the caller (with `SettingsSectionRowDivider` between them where wanted),
/// so each card reads as one grouped block — the reference Settings style.
struct SettingsSectionCard<Content: View>: View {
    @Environment(\.themeColors) private var colors
    let title: String
    @ViewBuilder let content: Content

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            Text(title)
                .font(AppFont.mono(16, weight: .semibold))
                .foregroundColor(colors.textPrimary)
                .padding(.top, 18)
                .padding(.bottom, 2)

            content
        }
        .padding(.horizontal, 20)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(
            RoundedRectangle(cornerRadius: 14, style: .continuous)
                // Same reasoning as `SettingsCard` — page-matching fill,
                // not the lighter `backgroundElevated` shared with non-
                // Settings surfaces.
                .fill(colors.backgroundPrimary)
        )
        .overlay(
            RoundedRectangle(cornerRadius: 14, style: .continuous)
                .stroke(colors.borderSubtle, lineWidth: 1)
        )
    }
}

/// One row inside a `SettingsSectionCard`: a bold title (+ optional gray
/// description below it) on the left, an arbitrary control right-aligned.
struct SettingsSectionRow<Control: View>: View {
    @Environment(\.themeColors) private var colors
    let title: String
    var description: String? = nil
    @ViewBuilder let control: Control

    var body: some View {
        HStack(alignment: .center, spacing: 16) {
            VStack(alignment: .leading, spacing: 4) {
                Text(title)
                    .font(AppFont.mono(14, weight: .semibold))
                    .foregroundColor(colors.textPrimary)
                if let description {
                    Text(description)
                        .font(AppFont.sans(12))
                        .foregroundColor(colors.textSecondary)
                        .fixedSize(horizontal: false, vertical: true)
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)

            control
        }
        .padding(.vertical, 14)
    }
}

/// The hairline separator between rows in a `SettingsSectionCard`.
struct SettingsSectionRowDivider: View {
    @Environment(\.themeColors) private var colors
    var body: some View {
        Rectangle()
            .fill(colors.borderSubtle)
            .frame(height: 1)
    }
}
