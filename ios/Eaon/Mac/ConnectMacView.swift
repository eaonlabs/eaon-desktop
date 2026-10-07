import SwiftUI
import VisionKit

/// Connects this iPhone to Eaon on a Mac, to control its agents and use its models. The easy ways first: scan the
/// QR code the Mac shows, or tap the Mac that turns up on this network; or type its address and key.
struct ConnectMacView: View {
    @Environment(ModelCatalog.self) private var catalog
    @Environment(AgentsStore.self) private var store
    @Environment(AppNavigator.self) private var navigator
    @Environment(\.dismiss) private var dismiss
    @Environment(\.openURL) private var openURL

    @State private var discovery = MacDiscovery()
    @State private var address = ""
    @State private var key = ""
    @State private var connecting = false
    @State private var error: String?
    @State private var scanning = false
    @State private var incoming: PairingLink?
    @State private var showsSteps = false
    @FocusState private var focus: Field?

    private enum Field { case address, key }

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(spacing: 22) {
                    hero
                        .entrance(rise: 10, scale: 0.97)
                    if catalog.macAddress == nil {
                        if let incoming {
                            confirmCard(incoming)
                                .transition(.opacity.combined(with: .scale(scale: 0.96)))
                        }
                        quickWays
                            .entrance(delay: 0.08)
                        manualForm
                            .entrance(delay: 0.14)
                        steps
                            .entrance(delay: 0.2)
                    } else {
                        connected
                            .entrance(delay: 0.08)
                    }
                }
                .padding(.horizontal, Metrics.gutter)
                .padding(.top, 8)
                .padding(.bottom, 32)
            }
            .scrollDismissesKeyboard(.interactively)
            .background(ScreenBackground())
            .navigationTitle("Your Mac")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    Button("Done") { dismiss() }.fontWeight(.semibold)
                }
            }
            .animation(.smooth(duration: 0.35), value: catalog.macAddress)
            .animation(.smooth(duration: 0.3), value: error)
            .animation(.smooth(duration: 0.3), value: incoming)
        }
        .tint(Palette.ink)
        .presentationBackground(Palette.background)
        .presentationDetents([.large])
        .presentationDragIndicator(.visible)
        .presentationCornerRadius(34)
        .fullScreenCover(isPresented: $scanning) {
            ScannerScreen { text in
                scanning = false
                if let link = PairingLink.parse(text) {
                    incoming = link
                } else {
                    Haptic.failure()
                    error = "That QR code isn't from Eaon on a Mac."
                }
            }
        }
        .task {
            discovery.start()
            if let link = navigator.pairingLink {
                incoming = link
                navigator.pairingLink = nil
            }
        }
        .onDisappear { discovery.stop() }
    }

    // MARK: Hero

    private var hero: some View {
        VStack(spacing: 16) {
            MacLink(state: linkState)
                .frame(height: 96)
            VStack(spacing: 6) {
                Text(catalog.macAddress == nil ? "Use Eaon on your Mac" : catalog.macName)
                    .font(.title2.weight(.semibold))
                    .foregroundStyle(Palette.ink)
                    .multilineTextAlignment(.center)
                statusLine
            }
        }
        .frame(maxWidth: .infinity)
        .card(padding: 24)
    }

    private var linkState: MacLink.State {
        if connecting { return .connecting }
        guard catalog.macAddress != nil else { return .idle }
        if catalog.macAgentsSupported { return store.mac.connection == .live ? .connected : (store.mac.connection == .connecting ? .connecting : .idle) }
        return catalog.macStatus == .connected ? .connected : .idle
    }

    @ViewBuilder private var statusLine: some View {
        if catalog.macAddress == nil {
            Text("See what its agents are doing, talk to them and approve what they ask, from this iPhone. Its models work in Chat too.")
                .font(.subheadline)
                .foregroundStyle(Palette.secondary)
                .multilineTextAlignment(.center)
        } else if catalog.macAgentsSupported {
            switch store.mac.connection {
            case .live:
                HStack(spacing: 8) {
                    StatusDot(color: Palette.positive)
                    Text("Connected · \(store.mac.agents.count) agent\(store.mac.agents.count == 1 ? "" : "s")")
                        .font(.subheadline).foregroundStyle(Palette.secondary)
                }
            case .connecting, .off:
                HStack(spacing: 8) {
                    StatusDot(color: Palette.tint, pulsing: true)
                    Text("Connecting…").font(.subheadline).foregroundStyle(Palette.secondary)
                }
            case .failed:
                HStack(spacing: 8) {
                    StatusDot(color: Palette.negative)
                    Text("Can't reach it right now").font(.subheadline).foregroundStyle(Palette.secondary)
                }
            }
        } else {
            Text("Its models work in Chat. Update Eaon on the Mac to control its agents too.")
                .font(.subheadline)
                .foregroundStyle(Palette.secondary)
                .multilineTextAlignment(.center)
        }
    }

    // MARK: Pairing

    private func confirmCard(_ link: PairingLink) -> some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack(spacing: 12) {
                IconTile(systemImage: "link", tint: Palette.tint)
                VStack(alignment: .leading, spacing: 2) {
                    Text("Connect to \(link.displayName)?")
                        .font(.body.weight(.semibold))
                        .foregroundStyle(Palette.ink)
                    Text(link.address)
                        .font(.footnote.monospaced())
                        .foregroundStyle(Palette.secondary)
                }
            }
            Text("Only connect to a Mac that's yours: anyone you connect to can see the messages you send its agents.")
                .font(.footnote)
                .foregroundStyle(Palette.secondary)
            HStack(spacing: 10) {
                Button("Not now") { incoming = nil }
                    .buttonStyle(PillButtonStyle(kind: .secondary))
                Button {
                    Task { await connect(address: link.address, key: link.key) }
                } label: {
                    if connecting { ProgressView().tint(Palette.background) } else { Text("Connect") }
                }
                .buttonStyle(PillButtonStyle(kind: .primary))
                .disabled(connecting)
            }
        }
        .card(padding: 16, radius: 22)
        .overlay(RoundedRectangle(cornerRadius: 22, style: .continuous).strokeBorder(Palette.tint.opacity(0.4), lineWidth: 1))
    }

    private var quickWays: some View {
        VStack(spacing: 8) {
            if !discovery.found.isEmpty {
                SectionLabel("On this network")
                RowGroup(dividerInset: 54) {
                    ForEach(discovery.found) { mac in
                        Button {
                            Haptic.select()
                            address = mac.address
                            focus = .key
                        } label: {
                            HStack(spacing: 12) {
                                IconTile(systemImage: "laptopcomputer")
                                VStack(alignment: .leading, spacing: 2) {
                                    Text(mac.name).font(.body.weight(.medium)).foregroundStyle(Palette.ink).lineLimit(1)
                                    Text("Tap, then enter its key").font(.footnote).foregroundStyle(Palette.secondary)
                                }
                                Spacer()
                                Image(systemName: "chevron.right").font(.system(size: 12, weight: .semibold)).foregroundStyle(Palette.secondary.opacity(0.6))
                            }
                            .padding(.horizontal, 14)
                            .padding(.vertical, 12)
                            .contentShape(Rectangle())
                        }
                        .buttonStyle(PressableStyle(scale: 0.99))
                    }
                }
            }
            if DataScannerViewController.isSupported && DataScannerViewController.isAvailable {
                Button {
                    Haptic.tap()
                    scanning = true
                } label: {
                    Label("Scan the QR code on your Mac", systemImage: "qrcode.viewfinder")
                }
                .buttonStyle(PillButtonStyle(kind: .primary))
                .padding(.top, discovery.found.isEmpty ? 0 : 6)
            }
        }
    }

    private var manualForm: some View {
        VStack(spacing: 14) {
            SectionLabel("Or enter it yourself")
            RowGroup(dividerInset: 54) {
                field(icon: "network", prompt: "Address, like 192.168.1.20", text: $address, field: .address, secure: false)
                field(icon: "key", prompt: "Key from Settings › Remote devices", text: $key, field: .key, secure: true)
            }

            if let error {
                Callout(kind: .error, title: "Couldn't connect", message: error, onDismiss: { self.error = nil })
                    .transition(.opacity.combined(with: .scale(scale: 0.98)))
            }

            Button {
                Task { await connect(address: address, key: key) }
            } label: {
                if connecting {
                    HStack(spacing: 10) { ProgressView().tint(Palette.background); Text("Connecting…") }
                } else {
                    Text("Connect")
                }
            }
            .buttonStyle(PillButtonStyle(kind: incoming == nil ? .primary : .secondary))
            .disabled(connecting || address.trimmingCharacters(in: .whitespaces).isEmpty)
        }
    }

    private func field(icon: String, prompt: String, text: Binding<String>, field: Field, secure: Bool) -> some View {
        HStack(spacing: 12) {
            Image(systemName: icon)
                .font(.system(size: 16, weight: .medium))
                .foregroundStyle(Palette.secondary)
                .frame(width: 24)
            Group {
                if secure {
                    SecureField(prompt, text: text)
                } else {
                    TextField(prompt, text: text).keyboardType(.URL)
                }
            }
            .focused($focus, equals: field)
            .textInputAutocapitalization(.never)
            .autocorrectionDisabled()
            .submitLabel(secure ? .go : .next)
            .onSubmit {
                if secure { Task { await connect(address: address, key: key) } } else { focus = .key }
            }
            .onChange(of: text.wrappedValue) { _, new in
                // A whole pairing link pasted into either box fills both.
                if let link = PairingLink.parse(new) {
                    address = link.address
                    key = link.key
                }
            }
            .font(.body)
            .foregroundStyle(Palette.ink)
        }
        .padding(.horizontal, 16)
        .frame(height: 54)
    }

    private var steps: some View {
        VStack(alignment: .leading, spacing: 0) {
            Button {
                withAnimation(Springs.smooth) { showsSteps.toggle() }
            } label: {
                HStack {
                    Text("How to connect")
                        .font(.body.weight(.medium))
                        .foregroundStyle(Palette.ink)
                    Spacer()
                    Image(systemName: "chevron.down")
                        .font(.system(size: 13, weight: .semibold))
                        .foregroundStyle(Palette.secondary)
                        .rotationEffect(.degrees(showsSteps ? 180 : 0))
                }
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)

            if showsSteps {
                VStack(alignment: .leading, spacing: 14) {
                    step(1, "Update Eaon on your Mac, open it, and go to Settings › Remote devices.")
                    step(2, "Turn on Allow remote devices. The Mac shows a QR code, its address and a key.")
                    step(3, "Scan the code here, or type the address and key. Your Mac and this iPhone need to be on the same Wi-Fi, or on a private network like Tailscale.")
                    step(4, "If macOS asks the Mac to accept incoming connections, choose Allow; if iOS asks to find devices on your local network, say yes.")
                }
                .padding(.top, 16)
                .transition(.opacity.combined(with: .move(edge: .top)))
            }
        }
        .card(padding: 18, radius: 22)
    }

    private func step(_ number: Int, _ text: String) -> some View {
        HStack(alignment: .firstTextBaseline, spacing: 12) {
            Text("\(number)")
                .font(.footnote.weight(.bold))
                .foregroundStyle(Palette.ink)
                .frame(width: 24, height: 24)
                .background(Palette.fill, in: Circle())
            Text(text)
                .font(.subheadline)
                .foregroundStyle(Palette.secondary)
                .fixedSize(horizontal: false, vertical: true)
        }
    }

    // MARK: Connected

    @ViewBuilder private var connected: some View {
        if catalog.macAgentsSupported, case .failed(let message) = store.mac.connection {
            Callout(kind: .error, title: "Can't reach \(catalog.macName)", message: message, detail: catalog.macAddress, actionTitle: "Try again") {
                catalog.announceMac()
            }
        }
        VStack(spacing: 10) {
            Button {
                Haptic.tap()
                navigator.go(.agents)
                dismiss()
            } label: {
                Label(catalog.macAgentsSupported ? "See its agents" : "Back to the app", systemImage: "person.2")
            }
            .buttonStyle(PillButtonStyle(kind: .primary))
            Button("Disconnect", role: .destructive) {
                Haptic.warning()
                address = catalog.macAddress ?? ""
                catalog.disconnectMac()
            }
            .buttonStyle(PillButtonStyle(kind: .destructive))
        }
    }

    // MARK: Connecting

    private func connect(address: String, key: String) async {
        guard !connecting else { return }
        focus = nil
        error = nil
        connecting = true
        defer { connecting = false }
        do {
            try await catalog.connectMac(address: address, key: key)
            Haptic.success()
            incoming = nil
            self.key = ""
        } catch {
            Haptic.failure()
            self.error = ModelCatalog.message(for: error)
        }
    }
}

// MARK: - Scanning

/// The camera, looking for the QR code a Mac shows.
private struct ScannerScreen: View {
    var onFound: (String) -> Void
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        ZStack(alignment: .topTrailing) {
            QRScanner(onFound: onFound).ignoresSafeArea()
            VStack {
                Spacer()
                Text("Point the camera at the QR code in Eaon › Settings › Remote devices on your Mac")
                    .font(.subheadline.weight(.medium))
                    .foregroundStyle(.white)
                    .multilineTextAlignment(.center)
                    .padding(.horizontal, 20)
                    .padding(.vertical, 14)
                    .background(.black.opacity(0.55), in: RoundedRectangle(cornerRadius: 18, style: .continuous))
                    .padding(.horizontal, 24)
                    .padding(.bottom, 40)
            }
            Button {
                dismiss()
            } label: {
                Image(systemName: "xmark")
                    .font(.system(size: 15, weight: .bold))
                    .foregroundStyle(.white)
                    .frame(width: 40, height: 40)
                    .background(.black.opacity(0.5), in: Circle())
            }
            .padding(20)
            .accessibilityLabel("Close")
        }
    }
}

private struct QRScanner: UIViewControllerRepresentable {
    var onFound: (String) -> Void

    func makeUIViewController(context: Context) -> DataScannerViewController {
        let controller = DataScannerViewController(
            recognizedDataTypes: [.barcode(symbologies: [.qr])],
            qualityLevel: .balanced,
            recognizesMultipleItems: false,
            isHighFrameRateTrackingEnabled: false,
            isPinchToZoomEnabled: true,
            isGuidanceEnabled: false,
            isHighlightingEnabled: true
        )
        controller.delegate = context.coordinator
        try? controller.startScanning()
        return controller
    }

    func updateUIViewController(_ controller: DataScannerViewController, context: Context) {}

    func makeCoordinator() -> Coordinator { Coordinator(onFound: onFound) }

    final class Coordinator: NSObject, DataScannerViewControllerDelegate {
        let onFound: (String) -> Void
        private var done = false

        init(onFound: @escaping (String) -> Void) { self.onFound = onFound }

        func dataScanner(_ dataScanner: DataScannerViewController, didAdd addedItems: [RecognizedItem], allItems: [RecognizedItem]) {
            guard !done else { return }
            for case .barcode(let barcode) in addedItems {
                if let text = barcode.payloadStringValue {
                    done = true
                    dataScanner.stopScanning()
                    onFound(text)
                    return
                }
            }
        }
    }
}
