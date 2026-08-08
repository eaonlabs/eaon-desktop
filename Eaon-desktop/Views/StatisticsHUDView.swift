import SwiftUI

struct StatisticsHUDView: View {
    @Environment(\.themeColors) private var colors
    @Bindable private var tracker = StatisticsTracker.shared
    @Bindable var chatViewModel: ChatViewModel

    // Matches confirmationTextColor's reasoning in AquaProviderSettingsView —
    // the monochrome accent used as plain text would vanish against the
    // page it sits on, so plain readable text color instead.
    private var generatingTextColor: Color {
        colors.textPrimary
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(tracker.selectedEngine)
                .font(AppFont.mono(11, weight: .semibold))
                .foregroundColor(colors.textPrimary)
                .lineLimit(1)

            Text("RPM \(tracker.liveRPM) · TPM \(tracker.liveTPM) · \(Int(tracker.tokensPerSecond)) tok/s")
                .font(AppFont.mono(10))
                .foregroundColor(colors.textSecondary)

            Text(tracker.isGenerating ? "Generating…" : tracker.connectionState)
                .font(AppFont.mono(10))
                .foregroundColor(tracker.isGenerating ? generatingTextColor : colors.textTertiary)
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 10)
        .background(.ultraThinMaterial, in: RoundedRectangle(cornerRadius: 12, style: .continuous))
        .overlay(
            RoundedRectangle(cornerRadius: 12, style: .continuous)
                .stroke(colors.borderSubtle, lineWidth: 1)
        )
        .shadow(color: colors.shadowColor, radius: 12, y: 4)
        .onReceive(Timer.publish(every: 1, on: .main, in: .common).autoconnect()) { _ in
            let model = chatViewModel.chatModels.first { $0.id == chatViewModel.selectedModel }
            tracker.syncChatState(
                messages: chatViewModel.messages,
                draft: chatViewModel.inputText,
                modelId: chatViewModel.selectedModel,
                modelName: model?.name,
                generating: chatViewModel.isGenerating
            )
        }
    }
}
