import SwiftUI

/// Opt-in, user-authored system instruction sent with every request — the
/// direct, visible replacement for the hardcoded coding-agent prompt this
/// app used to always send invisibly. Empty by default: no system message
/// at all, exactly like before this existed.
struct CustomInstructionsSettingsView: View {
    @Environment(\.themeColors) private var colors
    @Bindable var chatViewModel: ChatViewModel
    @State private var draft: String = ""
    @State private var saved = false
    @FocusState private var isFocused: Bool

    private var hasUnsavedChanges: Bool {
        draft.trimmingCharacters(in: .whitespacesAndNewlines) != chatViewModel.customInstructions
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            Text("Custom Instructions")
                .font(AppFont.mono(20, weight: .bold))
                .foregroundColor(colors.textPrimary)
                .padding(.horizontal, 32)
                .padding(.top, 28)
                .padding(.bottom, 8)

            Text("An optional instruction sent with every new message, in every chat. Tell the model how you'd like it to respond: tone, format, anything. Leave this empty and nothing extra is sent.")
                .font(AppFont.sans(12))
                .foregroundColor(colors.textSecondary)
                .fixedSize(horizontal: false, vertical: true)
                .lineSpacing(3)
                .padding(.horizontal, 32)
                .padding(.bottom, 20)

            ScrollView {
                VStack(alignment: .leading, spacing: 16) {
                    editorCard
                }
                .padding(.horizontal, 32)
                .padding(.bottom, 32)
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
        .background(colors.backgroundPrimary)
        .onAppear { draft = chatViewModel.customInstructions }
    }

    private var editorCard: some View {
        SettingsCard {
            VStack(alignment: .leading, spacing: 10) {
                TextEditor(text: $draft)
                    .font(AppFont.sans(13))
                    .foregroundColor(colors.textPrimary)
                    .scrollContentBackground(.hidden)
                    .frame(height: 160)
                    .focused($isFocused)
                    .overlay(alignment: .topLeading) {
                        if draft.isEmpty {
                            Text("e.g. \"Keep responses concise. Prefer bullet points over long paragraphs.\"")
                                .font(AppFont.sans(13))
                                .foregroundColor(colors.textTertiary)
                                .padding(.top, 8)
                                .padding(.leading, 5)
                                .allowsHitTesting(false)
                        }
                    }

                HStack(spacing: 10) {
                    if saved {
                        Text("Saved")
                            .font(AppFont.mono(12, weight: .medium))
                            .foregroundColor(colors.textTertiary)
                            .transition(.opacity)
                    }
                    Spacer()
                    Button {
                        draft = ""
                        chatViewModel.customInstructions = ""
                        flashSaved()
                    } label: {
                        Text("Clear")
                            .font(AppFont.mono(12, weight: .medium))
                            .foregroundColor(colors.textSecondary)
                    }
                    .buttonStyle(.plain)
                    .disabled(chatViewModel.customInstructions.isEmpty && draft.isEmpty)

                    Button {
                        chatViewModel.customInstructions = draft.trimmingCharacters(in: .whitespacesAndNewlines)
                        isFocused = false
                        flashSaved()
                    } label: {
                        Text("Save")
                            .font(AppFont.mono(12, weight: .semibold))
                            .foregroundColor(hasUnsavedChanges ? AppearanceSettings.shared.onAccentColor : colors.textSecondary)
                            .padding(.horizontal, 16)
                            .padding(.vertical, 7)
                            .background(Capsule().fill(hasUnsavedChanges ? AppearanceSettings.shared.accentColor : colors.borderMedium))
                    }
                    .buttonStyle(PressableButtonStyle())
                    .disabled(!hasUnsavedChanges)
                }
            }
            .padding(18)
        }
    }

    private func flashSaved() {
        withAnimation(.uiEaseOut(duration: 0.15)) { saved = true }
        DispatchQueue.main.asyncAfter(deadline: .now() + 1.6) {
            withAnimation(.uiEaseOut(duration: 0.15)) { saved = false }
        }
    }
}
