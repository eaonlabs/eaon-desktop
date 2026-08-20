import SwiftUI

/// Settings → Tools → Network. An optional HTTP/HTTPS proxy for Eaon's
/// outbound traffic (chat, images, web search, plugins, updates) — for a
/// corporate or firewalled network that requires one. Off by default; local
/// model servers on this Mac aren't routed through it.
struct NetworkSettingsView: View {
    @Environment(\.themeColors) private var colors
    @Bindable private var store = ProxyStore.shared
    @Bindable private var appearance = AppearanceSettings.shared

    @State private var portText = ""
    @State private var isTesting = false
    @State private var testResult: String?
    @State private var testSucceeded = false

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            Text("Network")
                .font(AppFont.mono(20, weight: .bold))
                .foregroundColor(colors.textPrimary)
                .padding(.horizontal, 32)
                .padding(.top, 28)
                .padding(.bottom, 8)

            Text("Route Eaon's outbound connections through an HTTP or HTTPS proxy. That covers chat, images, web search, plugins, and updates. This is for corporate or firewalled networks that require one. It's off by default, and traffic goes out directly when it's off. Local model servers on this Mac aren't affected either way.")
                .font(AppFont.sans(12))
                .foregroundColor(colors.textSecondary)
                .fixedSize(horizontal: false, vertical: true)
                .lineSpacing(3)
                .padding(.horizontal, 32)
                .padding(.bottom, 20)

            ScrollView {
                VStack(alignment: .leading, spacing: 16) {
                    toggleCard
                    if store.isEnabled {
                        addressCard
                        testCard
                    }
                    footnote
                }
                .padding(.horizontal, 32)
                .padding(.bottom, 32)
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
        .background(colors.backgroundPrimary)
        .onAppear { portText = String(store.port) }
    }

    private var toggleCard: some View {
        SettingsCard {
            HStack(alignment: .top, spacing: 12) {
                Image(systemName: "network")
                    .font(.system(size: 14))
                    .foregroundColor(colors.textSecondary)
                    .frame(width: 18)
                    .padding(.top, 2)
                VStack(alignment: .leading, spacing: 3) {
                    Text("Use a proxy")
                        .font(AppFont.mono(14, weight: .semibold))
                        .foregroundColor(colors.textPrimary)
                    Text(store.isActive
                         ? "On — traffic routes through \(store.host):\(store.port)."
                         : store.isEnabled
                            ? "On — enter a host and port below."
                            : "Off — Eaon connects directly.")
                        .font(AppFont.sans(12))
                        .foregroundColor(store.isEnabled && !store.isActive ? colors.destructive : colors.textSecondary)
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

    private var addressCard: some View {
        SettingsCard {
            VStack(alignment: .leading, spacing: 0) {
                HStack(spacing: 12) {
                    Text("Host")
                        .font(AppFont.mono(14, weight: .semibold))
                        .foregroundColor(colors.textPrimary)
                        .frame(width: 48, alignment: .leading)
                    TextField("proxy.example.com or 127.0.0.1", text: $store.host)
                        .textFieldStyle(.plain)
                        .font(AppFont.mono(14))
                        .foregroundColor(colors.textPrimary)
                        .padding(.horizontal, 10)
                        .padding(.vertical, 8)
                        .background(colors.backgroundInput)
                        .clipShape(RoundedRectangle(cornerRadius: 7, style: .continuous))
                        .overlay(RoundedRectangle(cornerRadius: 7, style: .continuous).stroke(colors.borderSubtle, lineWidth: 1))
                }
                .padding(.horizontal, 16)
                .padding(.top, 16)
                .padding(.bottom, 10)

                Divider().overlay(colors.borderSubtle).padding(.horizontal, 16)

                HStack(spacing: 12) {
                    Text("Port")
                        .font(AppFont.mono(14, weight: .semibold))
                        .foregroundColor(colors.textPrimary)
                        .frame(width: 48, alignment: .leading)
                    TextField("8080", text: $portText)
                        .textFieldStyle(.plain)
                        .font(AppFont.mono(14))
                        .foregroundColor(colors.textPrimary)
                        .frame(width: 90)
                        .padding(.horizontal, 10)
                        .padding(.vertical, 8)
                        .background(colors.backgroundInput)
                        .clipShape(RoundedRectangle(cornerRadius: 7, style: .continuous))
                        .overlay(RoundedRectangle(cornerRadius: 7, style: .continuous).stroke(colors.borderSubtle, lineWidth: 1))
                        .onSubmit(applyPort)
                        .onChange(of: portText) { _, _ in applyPort() }
                    Spacer()
                }
                .padding(.horizontal, 16)
                .padding(.top, 10)
                .padding(.bottom, 16)
            }
        }
    }

    private var testCard: some View {
        SettingsCard {
            HStack(spacing: 12) {
                VStack(alignment: .leading, spacing: 3) {
                    Text("Test connection")
                        .font(AppFont.mono(14, weight: .semibold))
                        .foregroundColor(colors.textPrimary)
                    if let testResult {
                        Text(testResult)
                            .font(AppFont.mono(12))
                            .foregroundColor(testSucceeded ? Color(hex: "#34C759") : colors.destructive)
                            .fixedSize(horizontal: false, vertical: true)
                            .lineSpacing(3)
                    } else {
                        Text("Sends one request through the current settings and reports what came back.")
                            .font(AppFont.sans(12))
                            .foregroundColor(colors.textSecondary)
                            .fixedSize(horizontal: false, vertical: true)
                            .lineSpacing(3)
                    }
                }
                Spacer(minLength: 12)
                Button {
                    Task { await testConnection() }
                } label: {
                    HStack(spacing: 5) {
                        if isTesting {
                            ProgressView().controlSize(.small)
                        }
                        Text(isTesting ? "Testing…" : "Test")
                            .font(AppFont.mono(12, weight: .medium))
                    }
                }
                .buttonStyle(.bordered)
                .disabled(isTesting)
            }
            .padding(18)
        }
    }

    private var footnote: some View {
        Text("Authenticated proxies (username / password) aren't supported yet.")
            .font(AppFont.sans(12))
            .foregroundColor(colors.textTertiary)
            .padding(.horizontal, 4)
    }

    private func applyPort() {
        let digits = portText.filter(\.isNumber)
        if digits != portText { portText = digits }
        guard let value = Int(digits), (1...65535).contains(value) else { return }
        if value != store.port { store.port = value }
    }

    private func testConnection() async {
        isTesting = true
        testResult = nil
        applyPort()
        var request = URLRequest(url: EaonHostedAPI.modelsURL)
        request.timeoutInterval = 12
        request.httpMethod = "GET"
        do {
            let (_, response) = try await AppHTTP.session.data(for: request)
            let route = store.isActive ? "via \(store.host):\(store.port)" : "direct (proxy off or incomplete)"
            if let http = response as? HTTPURLResponse {
                testResult = "Reached the network \(route). HTTP \(http.statusCode)."
                testSucceeded = true
            } else {
                testResult = "Got a response \(route), but not an HTTP one."
                testSucceeded = false
            }
        } catch {
            testResult = "Couldn't connect: \(error.localizedDescription)"
            testSucceeded = false
        }
        isTesting = false
    }
}
