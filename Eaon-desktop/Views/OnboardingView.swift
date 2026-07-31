import SwiftUI

/// Shown once, on first launch — a brief, three-step introduction for
/// someone who's never used Eaon before: what it is, the three modes, and
/// how to get a model actually talking. Deliberately never blocks anything:
/// every step has a "Skip"/"Continue without choosing" way out, and closing
/// it (any way) just lands in an ordinary empty chat — same as if onboarding
/// didn't exist. An earlier version of this hard-gated the whole app behind
/// requiring an Eaon API key before you could do anything at all; that was
/// wrong and got removed. This one only ever suggests, never requires.
struct OnboardingView: View {
    @Environment(\.themeColors) private var colors
    /// Opens the Models page (a top-level feature, not a Settings page) and
    /// dismisses onboarding.
    var onOpenModels: () -> Void = {}
    /// Opens Settings landed on the provider page (Eaon's own key, or the
    /// "+" to add a BYOK custom provider lives in that same section) and
    /// dismisses onboarding.
    var onOpenProviderSettings: () -> Void = {}
    /// Dismisses onboarding with no further navigation — "Skip" from any
    /// step, or the final step's own "I'll figure it out later".
    var onFinish: () -> Void = {}
    /// Called after the free week actually started (mint succeeded) — the
    /// parent refreshes the model list and dismisses onboarding.
    var onTrialStarted: () -> Void = {}

    @State private var step = 0
    @State private var appeared = false

    private let totalSteps = 3

    var body: some View {
        ZStack {
            colors.backgroundOverlay
                .ignoresSafeArea()

            VStack(alignment: .leading, spacing: 0) {
                topRow
                Divider().overlay(colors.borderSubtle)

                Group {
                    switch step {
                    case 0: welcomeStep
                    case 1: modesStep
                    default: getStartedStep
                    }
                }
                .padding(28)
                .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)

                Divider().overlay(colors.borderSubtle)
                bottomRow
            }
            .frame(width: 560, height: 500)
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
    }

    // MARK: - Chrome

    private var topRow: some View {
        HStack {
            Text("Getting started")
                .font(AppFont.mono(13, weight: .semibold))
                .foregroundStyle(colors.textTertiary)
            Spacer()
            if step < totalSteps - 1 {
                Button("Skip") { onFinish() }
                    .buttonStyle(.plain)
                    .font(AppFont.mono(13, weight: .medium))
                    .foregroundStyle(colors.textTertiary)
            }
        }
        .padding(.horizontal, 24)
        .padding(.vertical, 14)
    }

    private var bottomRow: some View {
        HStack(spacing: 10) {
            HStack(spacing: 6) {
                ForEach(0..<totalSteps, id: \.self) { i in
                    Circle()
                        .fill(i == step ? colors.textPrimary : colors.borderMedium)
                        .frame(width: 6, height: 6)
                }
            }

            Spacer()

            if step > 0 {
                DialogButton(title: "Back", style: .secondary) {
                    withAnimation(.easeOut(duration: 0.15)) { step -= 1 }
                }
            }
            if step < totalSteps - 1 {
                DialogButton(title: "Continue", style: .primary) {
                    withAnimation(.easeOut(duration: 0.15)) { step += 1 }
                }
            }
        }
        .padding(.horizontal, 24)
        .padding(.vertical, 16)
    }

    // MARK: - Step 1: Welcome

    private var welcomeStep: some View {
        VStack(alignment: .leading, spacing: 14) {
            Image(systemName: "sparkles")
                .font(.system(size: 30, weight: .semibold))
                .foregroundStyle(colors.textPrimary)
                .padding(.bottom, 4)
            Text("Welcome to Eaon")
                .font(AppFont.mono(26, weight: .bold))
                .foregroundStyle(colors.textPrimary)
            Text("A chat client that isn't locked into one provider. Use Eaon's hosted models, bring your own API key, or download open models and run them entirely offline on this Mac. Same app, same conversations, either way.")
                .font(AppFont.sans(14))
                .foregroundStyle(colors.textSecondary)
                .lineSpacing(3)
                .fixedSize(horizontal: false, vertical: true)
                .lineSpacing(3)
        }
    }

    // MARK: - Step 2: Modes

    private var modesStep: some View {
        VStack(alignment: .leading, spacing: 16) {
            Text("Three ways to work")
                .font(AppFont.mono(20, weight: .bold))
                .foregroundStyle(colors.textPrimary)

            VStack(spacing: 10) {
                ForEach(EaonMode.allCases) { mode in
                    modeRow(mode)
                }
            }

            Text("Image generation is available from the model picker in any mode. It isn't a separate mode of its own.")
                .font(AppFont.sans(12))
                .foregroundStyle(colors.textTertiary)
                .fixedSize(horizontal: false, vertical: true)
                .lineSpacing(3)
        }
    }

    private func modeRow(_ mode: EaonMode) -> some View {
        HStack(spacing: 12) {
            Image(systemName: mode.icon)
                .font(.system(size: 14, weight: .semibold))
                .foregroundStyle(colors.textSecondary)
                .frame(width: 32, height: 32)
                .background(
                    RoundedRectangle(cornerRadius: 8, style: .continuous)
                        .fill(colors.backgroundChipSecondary)
                )
            VStack(alignment: .leading, spacing: 1) {
                Text(mode.title)
                    .font(AppFont.mono(13, weight: .semibold))
                    .foregroundStyle(colors.textPrimary)
                Text(mode.blurb)
                    .font(AppFont.sans(12))
                    .foregroundStyle(colors.textTertiary)
            }
            Spacer(minLength: 0)
        }
        .padding(10)
        .background(
            RoundedRectangle(cornerRadius: 10, style: .continuous)
                .fill(colors.backgroundChip.opacity(0.5))
        )
    }

    // MARK: - Step 3: Get started

    private var getStartedStep: some View {
        VStack(alignment: .leading, spacing: 16) {
            Text("Pick how models run")
                .font(AppFont.mono(20, weight: .bold))
                .foregroundStyle(colors.textPrimary)
            Text("Either works fully. Switch or add the other anytime in Settings.")
                .font(AppFont.sans(13))
                .foregroundStyle(colors.textSecondary)

            getStartedOption(
                icon: "gift.fill",
                title: TrialStore.shared.isStarting ? "Starting your free week…" : "Start your free week",
                description: trialOptionDescription,
                action: {
                    guard !TrialStore.shared.isStarting else { return }
                    Task {
                        await TrialStore.shared.start()
                        if TrialStore.shared.isActive { onTrialStarted() }
                    }
                }
            )
            getStartedOption(
                icon: "cpu",
                title: "Run models on this Mac",
                description: "Download an open model and chat with it fully offline. Private, free, no key needed.",
                action: onOpenModels
            )
            getStartedOption(
                icon: "key.fill",
                title: "Connect an API key",
                description: "Use Eaon's hosted models, or bring your own key from another provider.",
                action: onOpenProviderSettings
            )

            Spacer(minLength: 0)

            Button("I'll figure it out later") { onFinish() }
                .buttonStyle(.plain)
                .font(AppFont.mono(13, weight: .medium))
                .foregroundStyle(colors.textTertiary)
                .frame(maxWidth: .infinity, alignment: .center)
        }
    }

    private var trialOptionDescription: String {
        if let error = TrialStore.shared.lastError {
            return error
        }
        return "7 days of hosted models, on the house. One click, no account, no card."
    }

    private func getStartedOption(icon: String, title: String, description: String, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            HStack(spacing: 14) {
                Image(systemName: icon)
                    .font(.system(size: 16, weight: .semibold))
                    .foregroundStyle(colors.textPrimary)
                    .iconHoverEffect(for: icon)
                    .frame(width: 38, height: 38)
                    .background(
                        RoundedRectangle(cornerRadius: 9, style: .continuous)
                            .fill(colors.backgroundChipSecondary)
                    )
                VStack(alignment: .leading, spacing: 2) {
                    Text(title)
                        .font(AppFont.mono(13.5, weight: .semibold))
                        .foregroundStyle(colors.textPrimary)
                    Text(description)
                        .font(AppFont.sans(12))
                        .foregroundStyle(colors.textSecondary)
                        .fixedSize(horizontal: false, vertical: true)
                        .lineSpacing(3)
                }
                Spacer(minLength: 0)
                Image(systemName: "chevron.right")
                    .font(.system(size: 11, weight: .semibold))
                    .foregroundStyle(colors.textTertiary)
                    .iconHoverEffect(for: "chevron.right")
            }
            .padding(12)
            .background(
                RoundedRectangle(cornerRadius: 12, style: .continuous)
                    .fill(colors.backgroundElevated)
            )
            .overlay(
                RoundedRectangle(cornerRadius: 12, style: .continuous)
                    .stroke(colors.borderMedium, lineWidth: 1)
            )
            .contentShape(RoundedRectangle(cornerRadius: 12, style: .continuous))
        }
        .buttonStyle(PressableButtonStyle())
    }
}
