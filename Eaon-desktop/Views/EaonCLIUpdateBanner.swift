import SwiftUI

/// The floating "Eaon CLI update available" card — same visual family as
/// `UpdateBanner` (the app's own "New Version" card), simplified since
/// there's no download to track: this is a local file copy from what's
/// already bundled in this app, so it finishes almost instantly.
struct EaonCLIUpdateBanner: View {
    @Environment(\.themeColors) private var colors
    @Bindable private var store = EaonCLIUpdateStore.shared
    let version: String

    private var accent: Color { AppearanceSettings.shared.accentColor }

    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            header
            reassurance
            Divider().overlay(colors.borderSubtle)
            statusArea
        }
        .padding(20)
        .frame(width: 380)
        .background(
            RoundedRectangle(cornerRadius: 18, style: .continuous)
                .fill(colors.backgroundElevated)
        )
        .overlay(
            RoundedRectangle(cornerRadius: 18, style: .continuous)
                .stroke(colors.borderSubtle, lineWidth: 1)
        )
        .shadow(color: .black.opacity(0.35), radius: 28, y: 10)
        .shadow(color: .black.opacity(0.18), radius: 6, y: 2)
    }

    // MARK: - Header

    private var header: some View {
        HStack(alignment: .center, spacing: 14) {
            ZStack {
                Circle()
                    .fill(accent.opacity(0.16))
                    .frame(width: 40, height: 40)
                Image(systemName: iconName)
                    .font(.system(size: 16, weight: .semibold))
                    .foregroundStyle(accent)
            }

            VStack(alignment: .leading, spacing: 2) {
                Text("Eaon CLI v\(version)")
                    .font(AppFont.mono(16, weight: .semibold))
                    .foregroundStyle(colors.textPrimary)
                Text(statusHeadline)
                    .font(AppFont.mono(12, weight: .medium))
                    .foregroundStyle(colors.textTertiary)
            }

            Spacer(minLength: 0)

            if store.state == .idle || isFailed {
                Button {
                    store.remindLater()
                } label: {
                    Image(systemName: "xmark")
                        .font(.system(size: 11, weight: .semibold))
                        .foregroundStyle(colors.textTertiary)
                        .iconHoverEffect(for: "xmark")
                        .frame(width: 22, height: 22)
                        .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .help("Not now. You can update later from Settings → General → Eaon CLI")
            }
        }
    }

    private var isFailed: Bool {
        if case .failed = store.state { return true }
        return false
    }

    private var iconName: String {
        switch store.state {
        case .done: return "checkmark.circle.fill"
        case .failed: return "exclamationmark.triangle.fill"
        default: return "terminal.fill"
        }
    }

    private var statusHeadline: String {
        switch store.state {
        case .idle: return "Update Available"
        case .updating: return "Updating…"
        case .done: return "Updated"
        case .failed: return "Update Failed"
        }
    }

    // MARK: - Reassurance

    private var reassurance: some View {
        Text("Replaces the CLI's program files only. Your saved API keys, providers, and past sessions in ~/.eaon/cli stay exactly as they are.")
            .font(AppFont.sans(12))
            .foregroundStyle(colors.textSecondary)
            .fixedSize(horizontal: false, vertical: true)
    }

    // MARK: - Status / actions

    @ViewBuilder
    private var statusArea: some View {
        switch store.state {
        case .updating:
            HStack(spacing: 10) {
                ProgressView().controlSize(.small)
                Text("Copying the newer version in…")
                    .font(AppFont.mono(12, weight: .medium))
                    .foregroundStyle(colors.textSecondary)
                Spacer(minLength: 0)
            }
        case .done:
            HStack(spacing: 8) {
                Image(systemName: "checkmark.circle.fill")
                    .foregroundStyle(Color(hex: "#34C759"))
                Text("Eaon CLI is up to date.")
                    .font(AppFont.mono(12, weight: .medium))
                    .foregroundStyle(colors.textSecondary)
                Spacer(minLength: 0)
            }
        case .failed(let message):
            VStack(alignment: .leading, spacing: 12) {
                Text(message)
                    .font(AppFont.sans(12))
                    .foregroundStyle(colors.destructive)
                    .fixedSize(horizontal: false, vertical: true)
                actionRow
            }
        case .idle:
            actionRow
        }
    }

    private var actionRow: some View {
        HStack(spacing: 18) {
            Spacer(minLength: 0)

            Button {
                store.updateNow()
            } label: {
                Text("Update Now")
                    .font(AppFont.mono(14, weight: .semibold))
                    .foregroundStyle(AppearanceSettings.shared.onAccentColor)
                    .padding(.horizontal, 18)
                    .padding(.vertical, 9)
                    .background(Capsule().fill(accent))
            }
            .buttonStyle(PressableButtonStyle())
        }
    }
}
