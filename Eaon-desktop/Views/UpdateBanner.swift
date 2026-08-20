import SwiftUI

/// The floating "New Version" card — icon badge, version headline, release
/// notes, and the Remind Me Later / Update Now row. Appears bottom-trailing
/// over the chat, never blocks anything.
struct UpdateBanner: View {
    @Environment(\.themeColors) private var colors
    @Bindable private var checker = UpdateChecker.shared
    let manifest: UpdateManifest

    private var accent: Color { AppearanceSettings.shared.accentColor }

    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            header

            if let notes = manifest.releaseNotes, !notes.isEmpty {
                releaseNotes(notes)
            }

            Divider().overlay(colors.borderSubtle)

            statusArea
        }
        .padding(20)
        .frame(width: 400)
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
                    .symbolEffect(.bounce, value: checker.downloadState == .relaunching)
            }

            VStack(alignment: .leading, spacing: 2) {
                Text("Eaon \(manifest.latestVersion)")
                    .font(AppFont.mono(16, weight: .semibold))
                    .foregroundStyle(colors.textPrimary)
                Text(statusHeadline)
                    .font(AppFont.mono(12, weight: .medium))
                    .foregroundStyle(colors.textTertiary)
            }

            Spacer(minLength: 0)

            // Only offered before anything's actually happened — once a
            // download/install is underway there's no safe mid-flight
            // cancel, so the card stays put until it finishes either way.
            if checker.downloadState == .idle || isFailed {
                Button {
                    checker.remindLater()
                } label: {
                    Image(systemName: "xmark")
                        .font(.system(size: 11, weight: .semibold))
                        .foregroundStyle(colors.textTertiary)
                        .iconHoverEffect(for: "xmark")
                        .frame(width: 22, height: 22)
                        .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .help("Not now. You can update later from Settings → General")
            }
        }
    }

    private var isFailed: Bool {
        if case .failed = checker.downloadState { return true }
        return false
    }

    private var iconName: String {
        switch checker.downloadState {
        case .relaunching: return "checkmark.circle.fill"
        case .failed: return "exclamationmark.triangle.fill"
        default: return "arrow.down.circle.fill"
        }
    }

    private var statusHeadline: String {
        switch checker.downloadState {
        case .idle: return "Update Available"
        case .downloading: return "Downloading Update"
        case .installing: return "Installing"
        case .relaunching: return "Restarting Eaon"
        case .failed: return "Update Failed"
        }
    }

    // MARK: - Release notes

    private func releaseNotes(_ notes: String) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            Text("WHAT'S NEW")
                .font(AppFont.mono(10, weight: .semibold))
                .tracking(0.8)
                .foregroundStyle(colors.textTertiary)

            ScrollView {
                Text(notes)
                    .font(AppFont.sans(12))
                    .foregroundStyle(colors.textSecondary)
                    .lineSpacing(3)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .textSelection(.enabled)
            }
            .frame(maxHeight: 120)
        }
        .padding(12)
        .background(
            RoundedRectangle(cornerRadius: 10, style: .continuous)
                .fill(colors.backgroundSubtle)
        )
    }

    // MARK: - Status / actions

    @ViewBuilder
    private var statusArea: some View {
        switch checker.downloadState {
        case .downloading(let fraction):
            progressRow(fraction: fraction, label: fraction.map { "\(Int($0 * 100))%" } ?? "Downloading…")
        case .installing:
            progressRow(fraction: nil, label: "Installing…")
        case .relaunching:
            progressRow(fraction: 1, label: "Restarting…")
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

    private func progressRow(fraction: Double?, label: String) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            GeometryReader { geometry in
                ZStack(alignment: .leading) {
                    Capsule().fill(colors.backgroundSubtle)
                    Capsule()
                        .fill(accent)
                        .frame(width: geometry.size.width * (fraction ?? 0.35))
                        .animation(.uiEaseInOut(duration: 0.3), value: fraction)
                }
            }
            .frame(height: 5)

            Text(label)
                .font(AppFont.mono(12, weight: .medium))
                .foregroundStyle(colors.textSecondary)
        }
    }

    private var actionRow: some View {
        HStack(spacing: 18) {
            Spacer(minLength: 0)

            Button {
                checker.updateNow()
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
