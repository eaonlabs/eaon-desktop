import AppKit
import ApplicationServices
import SwiftUI

/// Settings → Device Control (formerly its own "Eaon Claw" mode with a
/// dedicated enable gate — folded into Agent mode now, see `EaonMode`). Off
/// by default — the master switch for letting Agent, in addition to coding,
/// organize files, run commands, and open/close/drive apps and websites on
/// this Mac. The page's job is disclosure: say plainly what it can do and
/// what keeps it safe, so turning it on is an informed choice, not a
/// mystery toggle.
struct ComputerControlSettingsView: View {
    @Environment(\.themeColors) private var colors
    @Bindable private var store = DesktopControlStore.shared
    @Bindable private var bridge = BrowserBridge.shared

    /// Whether macOS currently trusts Eaon for Accessibility. Real state, not
    /// a computed read: the grant is flipped in System Settings — another app
    /// entirely — and nothing about that would make SwiftUI re-render this
    /// view, so a computed property just kept showing whatever was true when
    /// the page first drew. It's re-read when the page appears, every time
    /// the app comes back to the front (i.e. the moment you return from
    /// System Settings), and on a short timer while the page is open, so
    /// granting it is reflected without hunting for a refresh button.
    @State private var accessibilityGranted = ComputerControlSettingsView.accessibilityIsGranted

    /// 2s: fast enough that flipping the switch and cmd-tabbing back feels
    /// instant, cheap enough to be irrelevant (one in-process TCC read), and
    /// only while this page is on screen.
    private let permissionPollTimer = Timer.publish(every: 2, on: .main, in: .common).autoconnect()

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack(spacing: 10) {
                Text("Device Control")
                    .font(AppFont.mono(20, weight: .bold))
                    .foregroundColor(colors.textPrimary)
                BetaBadge()
            }
            .padding(.horizontal, 32)
            .padding(.top, 28)
            .padding(.bottom, 8)

            Text("Let Agent act on this Mac when you ask it to. On top of its usual coding tools it can organize files, run commands, and drive apps and websites. This is off by default and nothing runs until you turn it on.")
                .font(AppFont.sans(12))
                .foregroundColor(colors.textSecondary)
                .fixedSize(horizontal: false, vertical: true)
                .lineSpacing(3)
                .padding(.horizontal, 32)
                .padding(.bottom, 20)

            ScrollView {
                VStack(alignment: .leading, spacing: 16) {
                    toggleCard
                    canDoCard
                    safetyCard
                    permissionCard
                    browserExtensionCard
                }
                .padding(.horizontal, 32)
                .padding(.bottom, 32)
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
        .background(colors.backgroundPrimary)
        .onAppear { accessibilityGranted = Self.accessibilityIsGranted }
        .onReceive(permissionPollTimer) { _ in
            let current = Self.accessibilityIsGranted
            if current != accessibilityGranted { accessibilityGranted = current }
        }
        .onReceive(NotificationCenter.default.publisher(for: NSApplication.didBecomeActiveNotification)) { _ in
            accessibilityGranted = Self.accessibilityIsGranted
        }
    }

    private var toggleCard: some View {
        SettingsCard {
            HStack(spacing: 14) {
                VStack(alignment: .leading, spacing: 3) {
                    Text("Let Eaon control this Mac")
                        .font(AppFont.mono(14, weight: .semibold))
                        .foregroundColor(colors.textPrimary)
                    Text(store.isEnabled
                         ? "On — the model can act on your Mac when you ask it to. Each change asks first."
                         : "Off — the model can't touch your files, apps, or system.")
                        .font(AppFont.mono(12))
                        .foregroundColor(colors.textTertiary)
                }
                Spacer(minLength: 0)
                Toggle("", isOn: $store.isEnabled)
                    .labelsHidden()
                    .toggleStyle(JanSwitchToggleStyle())
            }
            .padding(16)
        }
    }

    private var canDoCard: some View {
        SettingsCard {
            VStack(alignment: .leading, spacing: 0) {
                cardHeader("What it can do")
                capabilityRow("folder", "Organize files", "List, move, rename, and create folders. It can send things to the Trash, but never delete permanently.")
                divider
                capabilityRow("terminal", "Run commands", "Run shell commands, the same as you would in Terminal, with a timeout and no admin access.")
                divider
                capabilityRow("macwindow.on.rectangle", "Drive apps & websites", "Open and quit apps, open URLs, and use AppleScript to control scriptable apps and click menu items by name.")
            }
        }
    }

    private var safetyCard: some View {
        SettingsCard {
            VStack(alignment: .leading, spacing: 0) {
                cardHeader("What keeps it safe")
                safetyRow("hand.raised.fill", "It asks before every change. Approve each action as it comes, or grant a whole chat at once.")
                divider
                safetyRow("trash.fill", "Deletions go to the Trash, so they're recoverable. There's no permanent-delete path.")
                divider
                safetyRow("lock.shield.fill", "No admin (sudo), no touching system files, and it will never enter passwords, buy anything, move money, or change account settings.")
                divider
                safetyRow("doc.text.magnifyingglass", "Text it reads from files, webpages, or command output counts as information, never as instructions. A booby-trapped file can't quietly redirect it, and anything that tries is shown to you.")
            }
        }
    }

    /// Reads the current Accessibility grant WITHOUT prompting — passing
    /// `kAXTrustedCheckOptionPrompt: false` checks the state instead of
    /// throwing a dialog at anyone who merely opens Settings.
    private static var accessibilityIsGranted: Bool {
        AXIsProcessTrustedWithOptions([kAXTrustedCheckOptionPrompt.takeUnretainedValue() as String: false] as CFDictionary)
    }

    /// Pairing for the browser extension — the better path for web control,
    /// so it's surfaced rather than buried in docs.
    private var browserExtensionCard: some View {
        SettingsCard {
            VStack(alignment: .leading, spacing: 10) {
                HStack(spacing: 6) {
                    Image(systemName: bridge.isConnected ? "checkmark.circle.fill" : "puzzlepiece.extension")
                        .font(.system(size: 12))
                        .foregroundColor(bridge.isConnected ? .green : colors.textTertiary)
                    Text(bridge.isConnected ? "Browser extension connected" : "Browser extension")
                        .font(AppFont.mono(12, weight: .semibold))
                        .foregroundColor(colors.textPrimary)
                }
                if let tab = bridge.connectedTabDescription, bridge.isConnected {
                    Text(tab)
                        .font(AppFont.sans(12))
                        .foregroundColor(colors.textTertiary)
                        .lineLimit(1)
                } else {
                    Text("Load the extension from the app's browser-extension folder (chrome://extensions → Developer mode → Load unpacked), then paste this token into it.")
                        .font(AppFont.sans(12))
                        .foregroundColor(colors.textTertiary)
                        .fixedSize(horizontal: false, vertical: true)
                        .lineSpacing(3)
                    HStack(spacing: 8) {
                        Text(bridge.token)
                            .font(AppFont.mono(12))
                            .textSelection(.enabled)
                            .lineLimit(1)
                            .padding(.horizontal, 8)
                            .padding(.vertical, 5)
                            .background(RoundedRectangle(cornerRadius: 6).fill(.quaternary.opacity(0.4)))
                        Button("Copy") {
                            NSPasteboard.general.clearContents()
                            NSPasteboard.general.setString(bridge.token, forType: .string)
                        }
                    }
                }
            }
            .padding(16)
        }
    }

    private var permissionCard: some View {
        SettingsCard {
            HStack(alignment: .top, spacing: 12) {
                Image(systemName: "info.circle")
                    .font(.system(size: 14))
                    .foregroundColor(colors.textTertiary)
                    .padding(.top, 1)
                // Live status, not prose. "If an action seems to do nothing,
                // a permission is usually why" was true but useless — it left
                // people to guess which permission, and browser scrolling
                // silently failing with `(1002) not allowed to send
                // keystrokes` is exactly the case that needs naming.
                // One status line and one action. The previous version
                // stacked three explanatory paragraphs here, which is exactly
                // the "make the user read a lot to learn one thing" problem —
                // what someone needs at a glance is whether it works and what
                // to press if it doesn't.
                VStack(alignment: .leading, spacing: 8) {
                    HStack(spacing: 6) {
                        Image(systemName: accessibilityGranted ? "checkmark.circle.fill" : "exclamationmark.triangle.fill")
                            .font(.system(size: 11))
                            .foregroundColor(accessibilityGranted ? .green : Color(hex: "#F59E0B"))
                        Text(accessibilityGranted
                             ? "Permissions look fine."
                             : "Accessibility is off, so scrolling web pages won't work.")
                            .font(AppFont.mono(12, weight: .semibold))
                            .foregroundColor(colors.textPrimary)
                    }
                    if !accessibilityGranted {
                        Button("Open Accessibility settings") {
                            if let url = URL(string: "x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility") {
                                NSWorkspace.shared.open(url)
                            }
                        }
                    }
                    Text("Eaon asks for anything else it needs the first time it's needed.")
                        .font(AppFont.sans(12))
                        .foregroundColor(colors.textTertiary)
                        .fixedSize(horizontal: false, vertical: true)
                        .lineSpacing(3)
                }
            }
            .padding(16)
        }
    }

    // MARK: - Row builders

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

    private func capabilityRow(_ icon: String, _ title: String, _ detail: String) -> some View {
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
                    .font(AppFont.sans(12))
                    .foregroundColor(colors.textTertiary)
                    .fixedSize(horizontal: false, vertical: true)
                    .lineSpacing(3)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(.horizontal, 16)
        .padding(.vertical, 12)
    }

    private func safetyRow(_ icon: String, _ text: String) -> some View {
        HStack(alignment: .top, spacing: 12) {
            Image(systemName: icon)
                .font(.system(size: 12))
                .foregroundColor(colors.textSecondary)
                .frame(width: 22)
            Text(text)
                .font(AppFont.sans(12))
                .foregroundColor(colors.textSecondary)
                .fixedSize(horizontal: false, vertical: true)
                .lineSpacing(3)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(.horizontal, 16)
        .padding(.vertical, 12)
    }
}
