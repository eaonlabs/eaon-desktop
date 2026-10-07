import Foundation
import Network

/// What a Mac shows to pair a phone: its address and its key, as a link or a QR code.
/// `eaon://pair?v=1&host=192.168.1.20&port=3266&key=eaonr-…&name=Alex%27s%20MacBook%20Pro`
struct PairingLink: Equatable, Identifiable, Sendable {
    var host: String
    var port: Int
    var key: String
    var name: String?

    var id: String { "\(host):\(port)" }
    var address: String { "\(host):\(port)" }
    /// What to show a person before connecting.
    var displayName: String { name?.isEmpty == false ? name! : host }

    static func parse(_ url: URL) -> PairingLink? {
        guard url.scheme?.lowercased() == "eaon", url.host()?.lowercased() == "pair",
              let items = URLComponents(url: url, resolvingAgainstBaseURL: false)?.queryItems else { return nil }
        func value(_ name: String) -> String? { items.first { $0.name == name }?.value }
        guard let host = value("host")?.trimmingCharacters(in: .whitespaces), !host.isEmpty, !host.contains(" "),
              let key = value("key")?.trimmingCharacters(in: .whitespaces), !key.isEmpty else { return nil }
        let port = value("port").flatMap(Int.init) ?? RemoteClient.defaultPort
        guard (1...65_535).contains(port) else { return nil }
        return PairingLink(host: host, port: port, key: key, name: value("name"))
    }

    /// A link pasted as text, or scanned from a QR code.
    static func parse(_ text: String) -> PairingLink? {
        URL(string: text.trimmingCharacters(in: .whitespacesAndNewlines)).flatMap(parse)
    }
}

/// Macs on this network that are running Eaon with Remote devices on, found with Bonjour.
@MainActor
@Observable
final class MacDiscovery {
    struct Found: Identifiable, Equatable, Sendable {
        var id: String
        var name: String
        var host: String
        var port: Int
        var address: String { "\(host):\(port)" }
    }

    private(set) var found: [Found] = []
    private(set) var isSearching = false
    @ObservationIgnored private var browser: NWBrowser?

    func start() {
        guard browser == nil else { return }
        let browser = NWBrowser(for: .bonjourWithTXTRecord(type: "_eaon._tcp", domain: nil), using: NWParameters())
        browser.browseResultsChangedHandler = { [weak self] results, _ in
            let items = results.compactMap(Self.found(from:))
            Task { @MainActor in self?.found = items.sorted { $0.name < $1.name } }
        }
        browser.stateUpdateHandler = { [weak self] state in
            Task { @MainActor in
                switch state {
                case .ready: self?.isSearching = true
                case .failed, .cancelled: self?.isSearching = false
                default: break
                }
            }
        }
        self.browser = browser
        browser.start(queue: .main)
    }

    func stop() {
        browser?.cancel()
        browser = nil
        isSearching = false
    }

    /// A service's name, and the host and port in its TXT record. A service without them can't be used, so it isn't shown.
    nonisolated private static func found(from result: NWBrowser.Result) -> Found? {
        guard case .service(let service, _, _, _) = result.endpoint,
              case .bonjour(let record) = result.metadata,
              let host = record["host"], !host.isEmpty else { return nil }
        let port = record["port"].flatMap(Int.init) ?? RemoteClient.defaultPort
        let name = service.hasPrefix("Eaon (") && service.hasSuffix(")") ? String(service.dropFirst(6).dropLast()) : service
        return Found(id: service, name: name, host: host, port: port)
    }
}
