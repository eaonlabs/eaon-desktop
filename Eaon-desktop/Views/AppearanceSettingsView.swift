import SwiftUI

struct AppearanceSettingsView: View {
    @Environment(\.themeColors) private var colors
    @Bindable private var settings = AppearanceSettings.shared
    @Bindable private var fontStore = FontPreferenceStore.shared
    @State private var showResetConfirm = false

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            Text("Appearance")
                .font(AppFont.mono(20, weight: .bold))
                .foregroundColor(colors.textPrimary)
                .padding(.horizontal, 32)
                .padding(.top, 28)
                .padding(.bottom, 20)

            ScrollView {
                VStack(alignment: .leading, spacing: 20) {
                    themeSection
                    fontSection
                    chatSection
                    resetRow
                }
                .padding(.horizontal, 32)
                .padding(.bottom, 32)
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
        .background(colors.backgroundPrimary)
        .alert("Reset Appearance?", isPresented: $showResetConfirm) {
            Button("Reset", role: .destructive) {
                settings.resetToDefaults()
                fontStore.fontId = "spaceGrotesk"
            }
            Button("Cancel", role: .cancel) {}
        } message: {
            Text("This will reset all appearance settings to their defaults.")
        }
    }

    // MARK: - Sections

    private var themeSection: some View {
        VStack(alignment: .leading, spacing: 8) {
            sectionLabel("Theme")

            SettingsCard {
                VStack(alignment: .leading, spacing: 0) {
                    settingsRow("Appearance", description: "Choose how Eaon looks.") {
                        themedPicker(selection: $settings.theme) {
                            ForEach(AppTheme.allCases) { theme in
                                Text(theme.rawValue).tag(theme)
                            }
                        }
                        .frame(width: 110)
                    }

                    settingsDivider
                    settingsRow("Font Size", description: "Adjust the app's font size.") {
                        themedPicker(selection: $settings.fontSize) {
                            ForEach(AppFontSize.allCases) { size in
                                Text(size.rawValue).tag(size)
                            }
                        }
                        .frame(width: 110)
                    }

                }
            }
        }
    }

    private var fontSection: some View {
        VStack(alignment: .leading, spacing: 8) {
            sectionLabel("Font")

            SettingsCard {
                VStack(alignment: .leading, spacing: 0) {
                    settingsRow("Typeface", description: "Used for chat text, labels, and code. Featured picks plus every font on this Mac.") {
                        EmptyView()
                    }
                    .padding(.bottom, 4)

                    FontOptionPicker(selectedId: $fontStore.fontId, accentColor: settings.accentColor)
                        .padding(.horizontal, 20)
                        .padding(.bottom, 18)
                }
            }
        }
    }

    private var chatSection: some View {
        VStack(alignment: .leading, spacing: 8) {
            sectionLabel("Chat")

            SettingsCard {
                VStack(alignment: .leading, spacing: 0) {
                    settingsRow("Colored user bubble", description: "Tint your own messages with the accent color instead of a neutral gray.") {
                        Toggle("", isOn: $settings.coloredUserBubble)
                            .toggleStyle(.switch)
                            .tint(AppearanceSettings.toggleTint)
                    }

                    settingsDivider
                    settingsRow("Show token speed", description: "Display tokens/sec and token count inline below assistant messages.") {
                        Toggle("", isOn: $settings.showTokenSpeed)
                            .toggleStyle(.switch)
                            .tint(AppearanceSettings.toggleTint)
                    }
                }
            }
        }
    }

    private var resetRow: some View {
        Button {
            showResetConfirm = true
        } label: {
            HStack(spacing: 6) {
                Image(systemName: "arrow.counterclockwise")
                    .font(.system(size: 12, weight: .semibold))
                    .iconHoverEffect(for: "arrow.counterclockwise")
                Text("Reset appearance to defaults")
                    .font(AppFont.mono(14, weight: .medium))
            }
            .foregroundStyle(colors.destructive)
        }
        .buttonStyle(.plain)
        .padding(.top, 4)
    }

    // MARK: - Components

    private func sectionLabel(_ title: String) -> some View {
        Text(title.uppercased())
            .font(AppFont.mono(11.5, weight: .semibold))
            .tracking(0.4)
            .foregroundColor(colors.textTertiary)
            .padding(.horizontal, 4)
    }

    private var settingsDivider: some View {
        Divider()
            .background(colors.borderSubtle)
            .padding(.horizontal, 16)
    }

    private func settingsRow(_ title: String, description: String, @ViewBuilder control: () -> some View) -> some View {
        HStack(alignment: .center, spacing: 16) {
            VStack(alignment: .leading, spacing: 4) {
                Text(title)
                    .font(AppFont.mono(14, weight: .semibold))
                    .foregroundColor(colors.textPrimary)
                Text(description)
                    .font(AppFont.sans(12))
                    .foregroundColor(colors.textSecondary)
                    .fixedSize(horizontal: false, vertical: true)
                    .lineSpacing(3)
            }
            .frame(maxWidth: .infinity, alignment: .leading)

            control()
        }
        .padding(.horizontal, 20)
        .padding(.vertical, 16)
    }

    private func themedPicker<S: Hashable, Content: View>(
        selection: Binding<S>,
        @ViewBuilder content: () -> Content
    ) -> some View {
        Picker("", selection: selection, content: content)
            .labelsHidden()
            .pickerStyle(.menu)
            .foregroundStyle(colors.textPrimary)
            .tint(colors.textPrimary)
            .padding(.horizontal, 10)
            .padding(.vertical, 6)
            .background(colors.backgroundInputSecondary)
            .clipShape(RoundedRectangle(cornerRadius: 8, style: .continuous))
            .overlay(
                RoundedRectangle(cornerRadius: 8, style: .continuous)
                    .stroke(colors.borderSubtle, lineWidth: 1)
            )
    }
}
