import AppKit
import SwiftUI

/// Settings for Eaon's own local, OpenAI-compatible API server — see
/// `LocalAPIServer`. Off by default, full disclosure about what turning it
/// on actually does, matching Computer Control's own settings page rather
/// than a quieter, default-on toggle like Privacy's "Always allow".
struct LocalAPIServerSettingsView: View {
    @Environment(\.themeColors) private var colors
    @Bindable private var store = LocalAPIServerStore.shared
    @Bindable private var server = LocalAPIServer.shared
    @State private var portText = ""
    @State private var copiedField: String?

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            Text("Local API Server")
                .font(AppFont.mono(20, weight: .bold))
                .foregroundColor(colors.textPrimary)
                .padding(.horizontal, 32)
                .padding(.top, 28)
                .padding(.bottom, 20)

            ScrollView {
                VStack(alignment: .leading, spacing: 16) {
                    explanationCard
                    toggleCard
                    if store.isEnabled {
                        connectionCard
                        authCard
                        activityCard
                    }
                }
                .padding(.horizontal, 32)
                .padding(.bottom, 32)
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
        .background(colors.backgroundPrimary)
        .onAppear { portText = String(store.port) }
    }

    private var explanationCard: some View {
        SettingsCard {
            VStack(alignment: .leading, spacing: 6) {
                Text("What this does")
                    .font(AppFont.mono(14, weight: .semibold))
                    .foregroundColor(colors.textPrimary)
                Text("Turns this Mac into a local OpenAI-compatible server. Any tool that can call an OpenAI-style chat API can point at Eaon's base URL below, whether that's a script, a coding CLI, or another app. It'll use whichever model you have configured here: Eaon, a BYOK key, or a local Ollama, llama.cpp, or MLX model. It forwards the exact conversation it's given, so no memory, custom instructions, or plugin tools are injected.")
                    .font(AppFont.sans(12))
                    .foregroundColor(colors.textSecondary)
                    .fixedSize(horizontal: false, vertical: true)
                    .lineSpacing(3)
                Text("Bound to this Mac only, on the loopback network interface. It's never reachable from your network or the internet, whatever your firewall says.")
                    .font(AppFont.sans(12))
                    .foregroundColor(colors.textTertiary)
                    .fixedSize(horizontal: false, vertical: true)
                    .lineSpacing(3)
                    .padding(.top, 2)
            }
            .padding(18)
        }
    }

    private var toggleCard: some View {
        SettingsCard {
            HStack(alignment: .top, spacing: 12) {
                Image(systemName: "server.rack")
                    .font(.system(size: 14))
                    .foregroundColor(colors.textSecondary)
                    .frame(width: 18)
                    .padding(.top, 2)
                VStack(alignment: .leading, spacing: 3) {
                    Text("Run local server")
                        .font(AppFont.mono(14, weight: .semibold))
                        .foregroundColor(colors.textPrimary)
                    Text(statusText)
                        .font(AppFont.sans(12))
                        .foregroundColor(store.isEnabled && server.isRunning ? colors.textSecondary : colors.destructive)
                        .fixedSize(horizontal: false, vertical: true)
                        .lineSpacing(3)
                }
                Spacer(minLength: 12)
                Toggle("", isOn: $store.isEnabled)
                    .labelsHidden()
                    .toggleStyle(JanSwitchToggleStyle())
            }
            .padding(18)
        }
    }

    private var statusText: String {
        guard store.isEnabled else { return "Off" }
        if let error = server.lastError { return "Couldn't start: \(error)" }
        return server.isRunning ? "Running on 127.0.0.1:\(store.port)" : "Starting…"
    }

    private var connectionCard: some View {
        SettingsCard {
            VStack(alignment: .leading, spacing: 0) {
                Text("Connection")
                    .font(AppFont.mono(14, weight: .semibold))
                    .foregroundColor(colors.textPrimary)
                    .padding(.horizontal, 16)
                    .padding(.top, 16)
                    .padding(.bottom, 4)

                copyableRow(label: "Base URL", value: store.baseURL, field: "url")
                Divider().overlay(colors.borderSubtle).padding(.horizontal, 16)
                portRow
            }
            .padding(.bottom, 6)
        }
    }

    private var portRow: some View {
        HStack(alignment: .center, spacing: 12) {
            VStack(alignment: .leading, spacing: 3) {
                Text("Port")
                    .font(AppFont.mono(14, weight: .semibold))
                    .foregroundColor(colors.textPrimary)
                Text("Defaults to 1234. Change it if something else on this Mac is already using that port.")
                    .font(AppFont.sans(12))
                    .foregroundColor(colors.textSecondary)
                    .fixedSize(horizontal: false, vertical: true)
                    .lineSpacing(3)
            }
            Spacer(minLength: 12)
            TextField("1234", text: $portText)
                .textFieldStyle(.plain)
                .font(AppFont.mono(14))
                .foregroundColor(colors.textPrimary)
                .multilineTextAlignment(.trailing)
                .frame(width: 70)
                .padding(.horizontal, 10)
                .padding(.vertical, 6)
                .background(RoundedRectangle(cornerRadius: 6, style: .continuous).fill(colors.backgroundChip))
                .onSubmit { applyPort() }
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 12)
    }

    private func applyPort() {
        guard let value = Int(portText), (1...65535).contains(value) else {
            portText = String(store.port)
            return
        }
        store.port = value
    }

    private var authCard: some View {
        SettingsCard {
            VStack(alignment: .leading, spacing: 0) {
                HStack(alignment: .top, spacing: 12) {
                    VStack(alignment: .leading, spacing: 3) {
                        Text("Require an API key")
                            .font(AppFont.mono(14, weight: .semibold))
                            .foregroundColor(colors.textPrimary)
                        Text("Callers must send this key as \"Authorization: Bearer <key>\" — stops any other app on this Mac from silently using your models.")
                            .font(AppFont.sans(12))
                            .foregroundColor(colors.textSecondary)
                            .fixedSize(horizontal: false, vertical: true)
                            .lineSpacing(3)
                    }
                    Spacer(minLength: 12)
                    Toggle("", isOn: $store.requireAPIKey)
                        .labelsHidden()
                        .toggleStyle(JanSwitchToggleStyle())
                }
                .padding(18)

                if store.requireAPIKey {
                    Divider().overlay(colors.borderSubtle).padding(.horizontal, 16)
                    copyableRow(label: "API key", value: store.apiKey, field: "key")
                    HStack {
                        Spacer()
                        Button("Regenerate") { store.regenerateAPIKey() }
                            .buttonStyle(.plain)
                            .font(AppFont.mono(12, weight: .medium))
                            .foregroundColor(colors.textSecondary)
                            .padding(.trailing, 16)
                            .padding(.bottom, 12)
                    }
                }
            }
        }
    }

    private func copyableRow(label: String, value: String, field: String) -> some View {
        HStack(alignment: .center, spacing: 12) {
            VStack(alignment: .leading, spacing: 3) {
                Text(label)
                    .font(AppFont.mono(14, weight: .semibold))
                    .foregroundColor(colors.textPrimary)
                Text(value)
                    .font(AppFont.mono(12))
                    .foregroundColor(colors.textSecondary)
                    .textSelection(.enabled)
                    .lineLimit(1)
                    .truncationMode(.middle)
            }
            Spacer(minLength: 12)
            Button {
                NSPasteboard.general.clearContents()
                NSPasteboard.general.setString(value, forType: .string)
                copiedField = field
                DispatchQueue.main.asyncAfter(deadline: .now() + 1.5) {
                    if copiedField == field { copiedField = nil }
                }
            } label: {
                Image(systemName: copiedField == field ? "checkmark" : "doc.on.doc")
                    .font(.system(size: 12))
                    .foregroundColor(colors.textSecondary)
                    .iconHoverEffect(for: copiedField == field ? "checkmark" : "doc.on.doc")
            }
            .buttonStyle(.plain)
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 12)
    }

    private var activityCard: some View {
        SettingsCard {
            VStack(alignment: .leading, spacing: 8) {
                Text("Recent requests")
                    .font(AppFont.mono(14, weight: .semibold))
                    .foregroundColor(colors.textPrimary)
                if server.recentRequests.isEmpty {
                    Text("Nothing yet. Requests show up here once a tool connects.")
                        .font(AppFont.sans(12))
                        .foregroundColor(colors.textTertiary)
                } else {
                    VStack(alignment: .leading, spacing: 4) {
                        ForEach(Array(server.recentRequests.enumerated()), id: \.offset) { _, entry in
                            Text(entry)
                                .font(AppFont.mono(12))
                                .foregroundColor(colors.textSecondary)
                        }
                    }
                }
            }
            .padding(18)
        }
    }
}
