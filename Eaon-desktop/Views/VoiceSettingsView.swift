import AVFoundation
import AppKit
import SwiftUI

/// Settings → Voice. Everything about talking to the desktop pet, on one page.
///
/// This used to live inside General's "Desktop Assistant" card, which grew to
/// eight rows and two warning blocks — one card asking you to read several
/// hundred words before you could decide anything. Voice is a self-contained
/// feature with its own caveats, so it gets its own page, and General goes
/// back to two switches.
///
/// The page also only shows what currently applies: with voice off you see one
/// switch and a short explanation, not a wall of engine and wake-word options
/// that don't do anything yet.
struct VoiceSettingsView: View {
    @Environment(\.themeColors) private var colors
    @Bindable private var store = EaonVoiceStore.shared
    @Bindable private var petStore = EaonPetStore.shared

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack(spacing: 10) {
                Text("Voice")
                    .font(AppFont.mono(20, weight: .bold))
                    .foregroundColor(colors.textPrimary)
                alphaBadge
            }
            .padding(.horizontal, 32)
            .padding(.top, 28)
            .padding(.bottom, 8)

            Text("Local speech-to-text dictation with on-device models.")
                .font(AppFont.sans(12))
                .foregroundColor(colors.textSecondary)
                .fixedSize(horizontal: false, vertical: true)
                .lineSpacing(3)
                .padding(.horizontal, 32)
                .padding(.bottom, 20)

            ScrollView {
                VStack(alignment: .leading, spacing: 16) {
                    mainCard
                    if store.isEnabled { speechCard }
                    if store.isEnabled { advancedCard }
                }
                .padding(.horizontal, 32)
                .padding(.bottom, 32)
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
        .background(colors.backgroundPrimary)
    }

    private var alphaBadge: some View {
        Text("ALPHA")
            .font(AppFont.mono(9.5, weight: .bold))
            .foregroundStyle(Color(hex: "#F59E0B"))
            .padding(.horizontal, 6)
            .padding(.vertical, 2)
            .background(Capsule().fill(Color(hex: "#F59E0B").opacity(0.16)))
            .overlay(Capsule().stroke(Color(hex: "#F59E0B").opacity(0.45), lineWidth: 1))
    }

    // MARK: - Cards

    private var mainCard: some View {
        SettingsSectionCard(title: "Dictation") {
            SettingsSectionRow(
                title: "Enable Voice Dictation",
                description: petStore.isEnabled
                    ? "Click the pet to dictate text into the assistant."
                    : "Turn on the desktop pet in General first."
            ) {
                Toggle("", isOn: $store.isEnabled)
                    .labelsHidden()
                    .toggleStyle(.switch)
                    .tint(AppearanceSettings.toggleTint)
                    .disabled(!petStore.isEnabled)
            }

            if store.isEnabled {
                SettingsSectionRowDivider()

                SettingsSectionRow(
                    title: "Dictation Mode",
                    description: "Toggle: click once to start, again to stop. Hold: dictate while held."
                ) {
                    Picker("", selection: $store.dictationMode) {
                        ForEach(DictationMode.allCases) { mode in
                            Text(mode.title).tag(mode)
                        }
                    }
                    .labelsHidden()
                    .pickerStyle(.segmented)
                    .frame(width: 140)
                }

                SettingsSectionRowDivider()

                SettingsSectionRow(
                    title: "Speech Model",
                    description: store.speechModel.blurb
                ) {
                    Picker("", selection: $store.speechModelId) {
                        ForEach(SpeechModelChoice.all) { model in
                            Text(model.name).tag(model.id)
                        }
                    }
                    .labelsHidden()
                    .frame(width: 190)
                }

                if !store.speechModel.isBuiltIn && !LocalSpeechTranscriber.isInstalled {
                    SettingsSectionRowDivider()
                    modelInstallNote
                }
            }

            if let error = EaonVoiceController.shared.lastError {
                SettingsSectionRowDivider()
                Text(error)
                    .font(AppFont.sans(12.5))
                    .foregroundColor(colors.textTertiary)
                    .fixedSize(horizontal: false, vertical: true)
                    .lineSpacing(3)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(.horizontal, 14)
                    .padding(.vertical, 10)
            }
        }
    }

    /// Shown only when a downloaded model is selected but missing — the one
    /// moment the install command is relevant.
    private var modelInstallNote: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text("\(store.speechModel.name) isn't installed. In Terminal:")
                .font(AppFont.sans(12.5))
                .foregroundColor(colors.textTertiary)
            Text(LocalSpeechTranscriber.installCommand)
                .font(AppFont.mono(12))
                .textSelection(.enabled)
                .padding(.horizontal, 8)
                .padding(.vertical, 5)
                .background(RoundedRectangle(cornerRadius: 6).fill(.quaternary.opacity(0.4)))
            Text("Apple Silicon only. The model downloads on first use. Until then the built-in recognizer is used, so dictation keeps working.")
                .font(AppFont.sans(12.5))
                .foregroundColor(colors.textTertiary)
                .fixedSize(horizontal: false, vertical: true)
                .lineSpacing(3)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(.horizontal, 14)
        .padding(.vertical, 10)
    }

    private var speechCard: some View {
        SettingsSectionCard(title: "How it sounds") {
            SettingsSectionRow(title: "Engine", description: "Kokoro is a local neural voice; it needs a one-time install.") {
                Picker("", selection: $store.engine) {
                    ForEach(EaonSpeechEngine.allCases) { option in
                        Text(option == .system ? "System" : "Kokoro").tag(option)
                    }
                }
                .labelsHidden()
                .frame(width: 150)
            }

            SettingsSectionRowDivider()

            if store.engine == .kokoro && !KokoroSpeech.isInstalled {
                installNote
            } else if store.engine == .kokoro {
                SettingsSectionRow(title: "Kokoro voice") {
                    Picker("", selection: $store.kokoroVoice) {
                        ForEach(KokoroSpeech.voices, id: \.id) { voice in
                            Text(voice.label).tag(voice.id)
                        }
                    }
                    .labelsHidden()
                    .frame(width: 260)
                }
            } else {
                SettingsSectionRow(title: "System voice") {
                    HStack(spacing: 8) {
                        Picker("", selection: $store.voiceIdentifier) {
                            Text("Automatic").tag("")
                            ForEach(EaonVoiceController.selectableVoices(), id: \.identifier) { voice in
                                Text(Self.voiceLabel(voice)).tag(voice.identifier)
                            }
                        }
                        .labelsHidden()
                        .frame(width: 210)
                        Button("Preview") {
                            EaonVoiceController.shared.preview(voiceIdentifier: store.voiceIdentifier)
                        }
                    }
                }
                if EaonVoiceController.onlyCompactVoicesInstalled {
                    SettingsSectionRowDivider()
                    betterVoicesNote
                }
            }
        }
    }

    private var advancedCard: some View {
        SettingsSectionCard(title: "Hands-free") {
            SettingsSectionRow(
                title: "\u{201C}Hey Eaon\u{201D}",
                description: "Often mishears the name. Clicking the pet is more reliable."
            ) {
                Toggle("", isOn: $store.wakeWordEnabled)
                    .labelsHidden()
                    .toggleStyle(.switch)
                    .tint(AppearanceSettings.toggleTint)
            }

            SettingsSectionRowDivider()

            SettingsSectionRow(
                title: "Keep listening after replies",
                description: "The least finished part. It still needs working echo cancellation."
            ) {
                Toggle("", isOn: $store.conversationMode)
                    .labelsHidden()
                    .toggleStyle(.switch)
                    .tint(AppearanceSettings.toggleTint)
            }
        }
    }

    // MARK: - Notes

    private var installNote: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text("Kokoro isn't installed. In Terminal:")
                .font(AppFont.sans(12.5))
                .foregroundColor(colors.textTertiary)
            Text(KokoroSpeech.installCommand)
                .font(AppFont.mono(12))
                .textSelection(.enabled)
                .padding(.horizontal, 8)
                .padding(.vertical, 5)
                .background(RoundedRectangle(cornerRadius: 6).fill(.quaternary.opacity(0.4)))
            Text("Apple Silicon only. Until then the system voice is used.")
                .font(AppFont.sans(12.5))
                .foregroundColor(colors.textTertiary)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(.horizontal, 14)
        .padding(.vertical, 10)
    }

    private var betterVoicesNote: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text("Your Mac only has compact voices installed, which is why speech sounds robotic. Apple's lifelike voices are a free download.")
                .font(AppFont.sans(12.5))
                .foregroundColor(colors.textTertiary)
                .fixedSize(horizontal: false, vertical: true)
                .lineSpacing(3)
            Button("Open Accessibility settings") {
                if let url = URL(string: "x-apple.systempreferences:com.apple.Accessibility-Settings.extension") {
                    NSWorkspace.shared.open(url)
                }
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(.horizontal, 14)
        .padding(.vertical, 10)
    }

    private static func voiceLabel(_ voice: AVSpeechSynthesisVoice) -> String {
        let quality: String
        switch voice.quality {
        case .premium: quality = "Premium"
        case .enhanced: quality = "Enhanced"
        default: quality = "Compact"
        }
        return "\(voice.name) — \(quality)"
    }
}
