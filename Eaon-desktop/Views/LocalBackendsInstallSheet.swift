import AppKit
import SwiftUI

/// One place to see every local runner (Ollama, llama.cpp, MLX) at once,
/// each with its real install command ready to copy-paste — rather than
/// discovering them one at a time, backend by backend, only after hitting a
/// "this isn't installed" wall on whichever tab happens to need it.
struct LocalBackendsInstallSheet: View {
    @Environment(\.themeColors) private var colors
    @Environment(\.dismiss) private var dismiss
    @Bindable private var manager = LocalAIManager.shared

    @State private var copiedBackend: LocalBackend?

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            header

            ScrollView {
                VStack(alignment: .leading, spacing: 12) {
                    Text("Local models run entirely on this Mac, with no API key and no internet once they're downloaded. Each one needs its own small runner installed first. Pick whichever fits what you want to run.")
                        .font(AppFont.sans(12))
                        .foregroundColor(colors.textSecondary)
                        .fixedSize(horizontal: false, vertical: true)
                        .lineSpacing(3)

                    ForEach(LocalBackend.allCases) { backend in
                        backendCard(backend)
                    }
                }
                .padding(20)
            }
        }
        .frame(width: 560, height: 620)
        .background(colors.backgroundPrimary)
    }

    private var header: some View {
        HStack {
            Text("Install Local Runners")
                .font(AppFont.mono(16, weight: .semibold))
                .foregroundColor(colors.textPrimary)
            Spacer()
            Button {
                Task { await manager.refreshInstalledBackends(force: true) }
            } label: {
                HStack(spacing: 5) {
                    Image(systemName: "arrow.clockwise")
                        .font(.system(size: 11))
                        .iconHoverEffect(for: "arrow.clockwise")
                    Text("Check Again")
                        .font(AppFont.mono(11, weight: .medium))
                }
            }
            .buttonStyle(.bordered)
            Button {
                dismiss()
            } label: {
                Image(systemName: "xmark")
                    .font(.system(size: 12, weight: .semibold))
                    .foregroundColor(colors.textSecondary)
                    .iconHoverEffect(for: "xmark")
                    .frame(width: 26, height: 26)
                    .background(Circle().fill(colors.backgroundSubtle))
            }
            .buttonStyle(.plain)
        }
        .padding(16)
        .background(colors.backgroundSidebar)
    }

    private func backendCard(_ backend: LocalBackend) -> some View {
        let isInstalled = manager.installed.contains(backend)

        return SettingsCard {
            VStack(alignment: .leading, spacing: 12) {
                HStack(spacing: 10) {
                    Circle()
                        .fill(backend.tint.opacity(0.16))
                        .overlay(Circle().stroke(colors.borderSubtle, lineWidth: 1))
                        .frame(width: 32, height: 32)
                        .overlay {
                            Image(systemName: backend.systemIcon)
                                .font(.system(size: 13, weight: .semibold))
                                .foregroundStyle(backend.tint)
                        }

                    VStack(alignment: .leading, spacing: 2) {
                        Text(backend.displayName)
                            .font(AppFont.mono(13, weight: .semibold))
                            .foregroundColor(colors.textPrimary)
                        Text(backend.blurb)
                            .font(AppFont.sans(11))
                            .foregroundColor(colors.textSecondary)
                            .fixedSize(horizontal: false, vertical: true)
                            .lineSpacing(3)
                    }

                    Spacer(minLength: 8)

                    statusPill(isInstalled: isInstalled)
                }

                if !isInstalled {
                    Text(backend.installNote)
                        .font(AppFont.sans(11))
                        .foregroundColor(colors.textTertiary)
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
                            .textSelection(.enabled)

                        Button(copiedBackend == backend ? "Copied" : "Copy") {
                            NSPasteboard.general.clearContents()
                            NSPasteboard.general.setString(backend.installCommand, forType: .string)
                            copiedBackend = backend
                            DispatchQueue.main.asyncAfter(deadline: .now() + 1.5) {
                                if copiedBackend == backend { copiedBackend = nil }
                            }
                        }
                        .buttonStyle(.bordered)
                    }
                }
            }
            .padding(16)
        }
    }

    private func statusPill(isInstalled: Bool) -> some View {
        HStack(spacing: 4) {
            Image(systemName: isInstalled ? "checkmark.circle.fill" : "circle.dashed")
                .font(.system(size: 9, weight: .semibold))
            Text(isInstalled ? "Installed" : "Not installed")
                .font(AppFont.mono(10.5, weight: .medium))
        }
        .foregroundStyle(isInstalled ? Color(hex: "#34C759") : colors.textTertiary)
        .padding(.horizontal, 7)
        .padding(.vertical, 3)
        .background(Capsule().fill((isInstalled ? Color(hex: "#34C759") : colors.textTertiary).opacity(0.14)))
    }
}
