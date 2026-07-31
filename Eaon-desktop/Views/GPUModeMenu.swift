import SwiftUI

/// Per-model "how it runs" controls for a llama.cpp model — GPU offload
/// (`-ngl`), context window (`-c`), and Flash Attention (`-fa`). One popover
/// menu shared by `ModelLibraryView`'s combined list and
/// `LocalProviderSettingsView`'s per-backend page so both surfaces stay in
/// sync. Changing any option stops a running server for the model so the
/// next message respawns it with the new flags (see `updateLlamaSetting`).
struct LlamaRunSettingsMenu: View {
    @Environment(\.themeColors) private var colors
    @Bindable var manager: LocalAIManager
    let record: LocalModelRecord

    private var gpuMode: GPUOffloadMode { record.gpuMode ?? .auto }
    private var contextSize: LlamaContextSize { record.contextSize ?? .defaultValue }
    private var flashMode: FlashAttentionMode { record.flashAttention ?? .auto }

    var body: some View {
        Menu {
            Section("Context window") {
                ForEach(LlamaContextSize.allCases) { size in
                    Button {
                        manager.setContextSize(size, for: record.id)
                    } label: {
                        checkedLabel(size.label, isOn: size == contextSize)
                    }
                }
            }

            Section("Run on") {
                ForEach(GPUOffloadMode.allCases) { mode in
                    Button {
                        manager.setGPUMode(mode, for: record.id)
                    } label: {
                        checkedLabel(mode.label, isOn: mode == gpuMode)
                    }
                }
            }

            Section("Flash Attention") {
                ForEach(FlashAttentionMode.allCases) { mode in
                    Button {
                        manager.setFlashAttention(mode, for: record.id)
                    } label: {
                        checkedLabel(mode.label, isOn: mode == flashMode)
                    }
                }
            }
        } label: {
            Image(systemName: "slider.horizontal.3")
                .font(.system(size: 12))
                .foregroundColor(colors.textSecondary)
                .iconHoverEffect(for: "slider.horizontal.3")
                .frame(width: 26, height: 26)
        }
        .menuStyle(.borderlessButton)
        .fixedSize()
        .help("Performance settings. Context window (\(contextSize.label)), run on \(gpuMode.label), Flash Attention \(flashMode.label). Changes apply on the next message.")
    }

    @ViewBuilder
    private func checkedLabel(_ text: String, isOn: Bool) -> some View {
        if isOn {
            Label(text, systemImage: "checkmark")
        } else {
            Text(text)
        }
    }
}
