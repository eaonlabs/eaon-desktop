import SwiftUI

/// The list behind the composer's model chip: Apple's model on this iPhone,
/// the models on a connected Mac, and the providers the person added.
struct ModelPickerView: View {
    @Environment(ModelCatalog.self) private var catalog
    @Environment(AppNavigator.self) private var navigator
    @Environment(\.dismiss) private var dismiss

    #if DEBUG
    @State private var addingProvider = DebugLaunch.sheet == "provider"
    #else
    @State private var addingProvider = false
    #endif

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(spacing: 26) {
                    group("On this iPhone") { onDeviceRow }
                        .entrance(delay: 0.04)
                    group("Your Mac") { macRows }
                        .entrance(delay: 0.09)
                    group("Providers") { providerRows }
                        .entrance(delay: 0.14)
                    Text("Keys stay in this iPhone's Keychain. Chats go only to the model you pick.")
                        .font(.footnote)
                        .foregroundStyle(Palette.secondary)
                        .multilineTextAlignment(.center)
                        .frame(maxWidth: .infinity)
                        .padding(.horizontal, 24)
                        .entrance(delay: 0.18)
                }
                .padding(.horizontal, Metrics.gutter)
                .padding(.top, 8)
                .padding(.bottom, 30)
            }
            .background(ScreenBackground())
            .navigationTitle("Model")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    Button("Done") { dismiss() }
                        .fontWeight(.semibold)
                }
            }
        }
        .tint(Palette.ink)
        .presentationBackground(Palette.background)
        .presentationDetents([.medium, .large])
        .presentationDragIndicator(.visible)
        .presentationCornerRadius(34)
        .sheet(isPresented: $addingProvider) {
            ProviderEditor(provider: nil) { catalog.select($0) }
        }
        .task { catalog.refreshOnDevice() }
    }

    private func group<Content: View>(_ title: String, @ViewBuilder content: () -> Content) -> some View {
        VStack(spacing: 8) {
            SectionLabel(title)
            RowGroup(content: content)
        }
    }

    // MARK: Rows

    @ViewBuilder private var onDeviceRow: some View {
        let status = catalog.onDevice
        row(
            icon: "iphone",
            title: ModelRef.onDevice.name,
            subtitle: status.isAvailable ? "Private. Runs on this iPhone, no account or key needed." : unavailableText(status),
            selected: catalog.activeModel == .onDevice,
            enabled: status.isAvailable
        ) { catalog.select(.onDevice) }
    }

    @ViewBuilder private var macRows: some View {
        if catalog.macAddress == nil {
            row(icon: "laptopcomputer", title: "Connect your Mac", subtitle: "Use the models set up in Eaon on your Mac.", trailing: "chevron.right") {
                dismiss()
                Task {
                    // The sheet has to be gone before another can come up.
                    try? await Task.sleep(for: .milliseconds(450))
                    navigator.showsConnectMac = true
                }
            }
        } else if catalog.macModelRefs.isEmpty {
            row(
                icon: "laptopcomputer",
                title: catalog.macName,
                subtitle: catalog.macStatus == .connecting ? "Connecting…" : "No models yet. Open Mac to check the connection.",
                enabled: false
            ) {}
        } else {
            ForEach(catalog.macModelRefs) { ref in
                row(icon: "laptopcomputer", title: ref.name, subtitle: ref.detail, selected: catalog.activeModel == ref) {
                    catalog.select(ref)
                }
            }
        }
    }

    @ViewBuilder private var providerRows: some View {
        ForEach(catalog.providerModelRefs) { ref in
            row(icon: "cloud", title: ref.name, subtitle: ref.detail, selected: catalog.activeModel == ref) {
                catalog.select(ref)
            }
        }
        row(icon: "plus", title: "Add a provider", subtitle: "OpenAI, OpenRouter, Ollama or any OpenAI-compatible server.", trailing: "chevron.right") {
            addingProvider = true
        }
    }

    private func unavailableText(_ status: OnDeviceStatus) -> String {
        if case .unavailable(let reason) = status { return reason }
        return ""
    }

    private func row(
        icon: String,
        title: String,
        subtitle: String?,
        selected: Bool = false,
        enabled: Bool = true,
        trailing: String? = nil,
        action: @escaping () -> Void
    ) -> some View {
        Button {
            Haptic.select()
            action()
            if trailing == nil { dismiss() }
        } label: {
            HStack(spacing: 12) {
                IconTile(systemImage: icon, tint: enabled ? Palette.ink : Palette.secondary)
                VStack(alignment: .leading, spacing: 2) {
                    Text(title)
                        .font(.body.weight(.medium))
                        .foregroundStyle(enabled ? Palette.ink : Palette.secondary)
                        .lineLimit(1)
                    if let subtitle {
                        Text(subtitle)
                            .font(.footnote)
                            .foregroundStyle(Palette.secondary)
                            .multilineTextAlignment(.leading)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                }
                Spacer(minLength: 8)
                if selected {
                    Image(systemName: "checkmark")
                        .font(.system(size: 15, weight: .semibold))
                        .foregroundStyle(Palette.ink)
                        .transition(.scale(scale: 0.4).combined(with: .opacity))
                } else if let trailing {
                    Image(systemName: trailing)
                        .font(.system(size: 13, weight: .semibold))
                        .foregroundStyle(Palette.secondary.opacity(0.7))
                }
            }
            .padding(.horizontal, 14)
            .padding(.vertical, 12)
            .frame(maxWidth: .infinity, alignment: .leading)
            .contentShape(Rectangle())
        }
        .buttonStyle(PressableStyle(scale: 0.99))
        .disabled(!enabled)
        .accessibilityAddTraits(selected ? .isSelected : [])
    }
}
