import SwiftUI

// MARK: - Free Week trial popup

/// A one-time nudge offering the Free Week to users who already dismissed
/// onboarding before ever seeing it — onboarding's own "Start your free
/// week" option (see `OnboardingView`) only reaches brand-new installs.
/// RootView shows this at most once, ever: it flips
/// `eaon_has_seen_trial_popup` the moment either button is used (and
/// alongside `eaon_has_seen_onboarding` for anyone who just went through
/// onboarding, so they're never shown the same offer twice in a row).
struct FreeWeekTrialPopup: View {
    @Environment(\.themeColors) private var colors
    let onStarted: () -> Void
    let onDismiss: () -> Void

    @State private var appeared = false

    var body: some View {
        ZStack {
            colors.backgroundOverlay
                .ignoresSafeArea()
                .onTapGesture { onDismiss() }

            VStack(alignment: .leading, spacing: 0) {
                HStack(spacing: 10) {
                    Image(systemName: "gift.fill")
                        .font(.system(size: 16))
                        .foregroundStyle(AppearanceSettings.shared.accentColor)
                    Text("Try Eaon's hosted models free")
                        .font(AppFont.mono(18, weight: .semibold))
                        .foregroundStyle(colors.textPrimary)
                }
                .padding(.bottom, 14)

                Text("7 days of hosted models, on the house. One click, no account, no card. The trial runs through Eaon's own servers, so no API key is ever stored in the app.")
                    .font(AppFont.sans(14))
                    .foregroundStyle(colors.textSecondary)
                    .fixedSize(horizontal: false, vertical: true)
                    .padding(.bottom, TrialStore.shared.lastError == nil ? 24 : 10)

                if let error = TrialStore.shared.lastError {
                    Text(error)
                        .font(AppFont.sans(12))
                        .foregroundStyle(colors.destructive)
                        .fixedSize(horizontal: false, vertical: true)
                        .padding(.bottom, 14)
                }

                HStack(spacing: 10) {
                    Spacer()
                    DialogButton(title: "Not Now", style: .secondary) { onDismiss() }
                    DialogButton(
                        title: TrialStore.shared.isStarting ? "Starting…" : "Start Free Week",
                        style: .primary
                    ) {
                        guard !TrialStore.shared.isStarting else { return }
                        Task {
                            await TrialStore.shared.start()
                            if TrialStore.shared.isActive { onStarted() }
                        }
                    }
                    .disabled(TrialStore.shared.isStarting)
                    .opacity(TrialStore.shared.isStarting ? 0.6 : 1)
                }
            }
            .padding(24)
            .frame(width: 440)
            .background(
                RoundedRectangle(cornerRadius: 20, style: .continuous)
                    .fill(colors.backgroundPopover)
            )
            .overlay(
                RoundedRectangle(cornerRadius: 20, style: .continuous)
                    .stroke(colors.borderSubtle, lineWidth: 1)
            )
            .shadow(color: .black.opacity(0.3), radius: 40, y: 16)
            .scaleEffect(appeared ? 1 : 0.94)
            .opacity(appeared ? 1 : 0)
        }
        .onAppear {
            withAnimation(.easeOut(duration: 0.18)) { appeared = true }
        }
        .onExitCommand { onDismiss() }
    }
}
