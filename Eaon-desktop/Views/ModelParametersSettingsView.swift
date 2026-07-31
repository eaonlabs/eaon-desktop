import SwiftUI

/// Settings → Assistant → Model Parameters. Global sampling controls
/// (temperature, top-P, max tokens, and the two repetition penalties) applied
/// to every model, hosted or local. Each is individually switchable and every
/// one starts **off** — an untouched parameter is omitted from the request
/// entirely, so the model keeps its own tuned default (see
/// `ModelParametersStore` / `SamplingParameters` for why that distinction
/// matters, especially for reasoning models).
struct ModelParametersSettingsView: View {
    @Environment(\.themeColors) private var colors
    @Bindable private var store = ModelParametersStore.shared
    @Bindable private var appearance = AppearanceSettings.shared

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            Text("Model Parameters")
                .font(AppFont.mono(20, weight: .bold))
                .foregroundColor(colors.textPrimary)
                .padding(.horizontal, 32)
                .padding(.top, 28)
                .padding(.bottom, 8)

            Text("How the model samples its response. This applies to every model, hosted or local. Each control is off until you turn it on, and anything left off keeps that model's own default. Some models ignore or reject these, reasoning models especially. When that happens Eaon quietly retries without them, so chat never breaks.")
                .font(AppFont.sans(12))
                .foregroundColor(colors.textSecondary)
                .fixedSize(horizontal: false, vertical: true)
                .lineSpacing(3)
                .padding(.horizontal, 32)
                .padding(.bottom, 20)

            ScrollView {
                VStack(alignment: .leading, spacing: 20) {
                    samplingCard
                    lengthCard
                    repetitionCard
                    resetRow
                }
                .padding(.horizontal, 32)
                .padding(.bottom, 32)
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
        .background(colors.backgroundPrimary)
    }

    // MARK: - Cards

    private var samplingCard: some View {
        VStack(alignment: .leading, spacing: 8) {
            sectionLabel("Sampling")
            SettingsCard {
                VStack(spacing: 0) {
                    parameterRow(
                        title: "Temperature",
                        description: "Randomness. Lower is more focused and repeatable; higher is more varied and creative.",
                        enabled: $store.temperatureEnabled,
                        value: $store.temperature,
                        range: 0...2,
                        step: 0.05,
                        display: { String(format: "%.2f", $0) }
                    )
                    divider
                    parameterRow(
                        title: "Top P",
                        description: "Nucleus sampling. Considers only the most likely tokens whose probabilities sum to this. 1.00 means no limit.",
                        enabled: $store.topPEnabled,
                        value: $store.topP,
                        range: 0...1,
                        step: 0.01,
                        display: { String(format: "%.2f", $0) }
                    )
                }
            }
        }
    }

    private var lengthCard: some View {
        VStack(alignment: .leading, spacing: 8) {
            sectionLabel("Length")
            SettingsCard {
                parameterRow(
                    title: "Max output tokens",
                    description: "Hard cap on the length of a single reply. The model may stop sooner; it can't go past this.",
                    enabled: $store.maxTokensEnabled,
                    value: Binding(
                        get: { Double(store.maxTokens) },
                        set: { store.maxTokens = Int($0) }
                    ),
                    range: 256...16384,
                    step: 256,
                    display: { String(Int($0)) }
                )
            }
        }
    }

    private var repetitionCard: some View {
        VStack(alignment: .leading, spacing: 8) {
            sectionLabel("Repetition")
            SettingsCard {
                VStack(spacing: 0) {
                    parameterRow(
                        title: "Frequency penalty",
                        description: "Higher values reduce verbatim repetition. OpenAI-style and local models only.",
                        enabled: $store.frequencyPenaltyEnabled,
                        value: $store.frequencyPenalty,
                        range: -2...2,
                        step: 0.1,
                        display: { String(format: "%.1f", $0) }
                    )
                    divider
                    parameterRow(
                        title: "Presence penalty",
                        description: "Pushes the model toward new topics. Higher values make it less likely to dwell on what it's already said.",
                        enabled: $store.presencePenaltyEnabled,
                        value: $store.presencePenalty,
                        range: -2...2,
                        step: 0.1,
                        display: { String(format: "%.1f", $0) }
                    )
                }
            }
        }
    }

    private var resetRow: some View {
        Button {
            store.resetToDefaults()
        } label: {
            HStack(spacing: 6) {
                Image(systemName: "arrow.counterclockwise")
                    .font(.system(size: 12, weight: .semibold))
                    .iconHoverEffect(for: "arrow.counterclockwise")
                Text("Reset all to defaults")
                    .font(AppFont.mono(14, weight: .medium))
            }
            .foregroundStyle(store.isAllDefault ? colors.textTertiary : colors.destructive)
        }
        .buttonStyle(.plain)
        .disabled(store.isAllDefault)
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

    private var divider: some View {
        Divider().background(colors.borderSubtle).padding(.horizontal, 18)
    }

    /// One parameter: a title/description with an enable toggle, and — when
    /// enabled — a slider plus its live numeric value. Disabled rows read
    /// "Model default" so it's clear nothing is being sent.
    private func parameterRow(
        title: String,
        description: String,
        enabled: Binding<Bool>,
        value: Binding<Double>,
        range: ClosedRange<Double>,
        step: Double,
        display: @escaping (Double) -> String
    ) -> some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack(alignment: .top, spacing: 16) {
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

                Text(enabled.wrappedValue ? display(value.wrappedValue) : "Model default")
                    .font(AppFont.mono(12, weight: .medium))
                    .foregroundColor(enabled.wrappedValue ? colors.textPrimary : colors.textTertiary)
                    .monospacedDigit()

                Toggle("", isOn: enabled)
                    .labelsHidden()
                    .toggleStyle(.switch)
                    .tint(AppearanceSettings.toggleTint)
            }

            if enabled.wrappedValue {
                Slider(value: value, in: range, step: step)
                    .tint(appearance.accentColor)
                    .transition(.opacity)
            }
        }
        .padding(18)
        .animation(.uiEaseOut(duration: 0.15), value: enabled.wrappedValue)
    }
}
