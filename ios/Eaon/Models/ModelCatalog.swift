import Foundation
import Observation

/// A provider the person added: any server that speaks the OpenAI API.
struct Provider: Codable, Identifiable, Equatable, Sendable {
    var id = UUID()
    var name: String
    /// The address as typed.
    var baseURL: String
    var modelID: String
}

enum MacStatus: Equatable {
    case notConnected
    case connecting
    case connected
    case failed(String)
}

/// Every model Eaon can talk to from this iPhone, and which one is in use:
/// Apple's on the phone, the ones on a connected Mac, and the providers the
/// person added. Addresses live in UserDefaults; keys live in the Keychain.
@MainActor
@Observable
final class ModelCatalog {
    private(set) var providers: [Provider]
    private(set) var macAddress: String?
    private(set) var macModels: [String] = []
    private(set) var macStatus: MacStatus
    /// What the Mac calls itself ("Alex's MacBook Pro"), from its Remote API.
    private(set) var macComputerName: String?
    /// Whether that Mac has the Remote API, so its agents can be controlled from here. An older Eaon only lends its models.
    private(set) var macAgentsSupported = false
    private(set) var onDevice: OnDeviceStatus
    private(set) var selected: ModelRef?

    /// Told when the Mac connection is made, changes or is dropped: the client for its agents, and its name.
    @ObservationIgnored var onMacChange: (@MainActor (RemoteClient?, String?) -> Void)?

    @ObservationIgnored private let keychain: Keychain
    @ObservationIgnored private let defaults: UserDefaults
    @ObservationIgnored private let session: URLSession

    private static let providersKey = "eaon.models.providers"
    private static let macKey = "eaon.models.mac"
    private static let selectedKey = "eaon.models.selected"
    private static let macNameKey = "eaon.models.macName"
    private static let macAgentsKey = "eaon.models.macAgents"
    private static let macKeychainKey = "mac.key"
    private static func providerKeychainKey(_ id: UUID) -> String { "provider.key.\(id.uuidString)" }

    init(keychain: Keychain = Keychain(), defaults: UserDefaults = .standard, session: URLSession = .shared) {
        self.keychain = keychain
        self.defaults = defaults
        self.session = session
        providers = defaults.data(forKey: Self.providersKey).flatMap { try? JSONDecoder().decode([Provider].self, from: $0) } ?? []
        let address = defaults.string(forKey: Self.macKey)
        macAddress = address
        macComputerName = defaults.string(forKey: Self.macNameKey)
        macAgentsSupported = defaults.bool(forKey: Self.macAgentsKey)
        macStatus = address == nil ? .notConnected : .connecting
        selected = defaults.data(forKey: Self.selectedKey).flatMap { try? JSONDecoder().decode(ModelRef.self, from: $0) }
        onDevice = OnDevice.status()
    }

    // MARK: What's on offer

    var macModelRefs: [ModelRef] {
        macModels.map { id in
            // Eaon's ids are "provider/model".
            let parts = id.split(separator: "/", maxSplits: 1).map(String.init)
            return ModelRef(
                source: .mac,
                id: id,
                name: parts.count == 2 ? parts[1] : id,
                detail: parts.count == 2 ? "\(parts[0]) · \(macName)" : macName
            )
        }
    }

    var providerModelRefs: [ModelRef] {
        providers.map { ModelRef(source: .provider($0.id), id: $0.modelID, name: $0.modelID, detail: $0.name) }
    }

    /// The model new messages go to.
    var activeModel: ModelRef? {
        if let selected, isOffered(selected) { return selected }
        return defaultModel
    }

    private var defaultModel: ModelRef? {
        if onDevice.isAvailable { return .onDevice }
        if let provider = providerModelRefs.first { return provider }
        return macModelRefs.first
    }

    func isOffered(_ ref: ModelRef) -> Bool {
        switch ref.source {
        case .onDevice: onDevice.isAvailable
        case .mac: macAddress != nil
        case .provider(let id): providers.contains { $0.id == id }
        }
    }

    func select(_ ref: ModelRef) {
        selected = ref
        defaults.set(try? JSONEncoder().encode(ref), forKey: Self.selectedKey)
    }

    func backend(for ref: ModelRef) -> (any ChatBackend)? {
        switch ref.source {
        case .onDevice:
            #if canImport(FoundationModels)
            if #available(iOS 26.0, *), onDevice.isAvailable { return OnDeviceBackend() }
            #endif
            return nil
        case .mac:
            guard let address = macAddress, let url = ModelsClient.baseURL(from: address) else { return nil }
            return OpenAICompatibleBackend(baseURL: url, apiKey: macKey, model: ref.id, session: session)
        case .provider(let id):
            guard let provider = providers.first(where: { $0.id == id }),
                  let url = ModelsClient.baseURL(from: provider.baseURL) else { return nil }
            return OpenAICompatibleBackend(baseURL: url, apiKey: key(for: provider), model: provider.modelID, session: session)
        }
    }

    // MARK: On this iPhone

    func refreshOnDevice() {
        onDevice = OnDevice.status()
    }

    // MARK: The Mac

    var macName: String {
        if let name = macComputerName, !name.isEmpty { return name }
        guard let address = macAddress, let host = ModelsClient.baseURL(from: address)?.host() else { return "Your Mac" }
        let isAddress = host.split(separator: ".").allSatisfy { Int($0) != nil } || host.contains(":")
        if isAddress || host == "localhost" { return "Your Mac" }
        // "alexs-macbook-pro.local" → "alexs-macbook-pro"
        var name = host
        if name.hasSuffix(".local") { name.removeLast(6) }
        return name.split(separator: ".").first.map(String.init) ?? name
    }

    var macKey: String? { keychain.string(Self.macKeychainKey) }

    /// A client for the Mac's agents, once a Mac that has the Remote API is connected.
    var remoteClient: RemoteClient? {
        guard macAgentsSupported, let address = macAddress, let key = macKey, let url = RemoteClient.baseURL(from: address) else { return nil }
        return RemoteClient(baseURL: url, key: key, session: session)
    }

    /// Tells the agents side about the connection as it stands.
    func announceMac() {
        onMacChange?(remoteClient, macComputerName)
    }

    /// Checks the address and key, keeps them if they work, and finds out what the Mac offers: its agents (the
    /// Remote API) and its models. An address without a port gets Eaon's, 3266.
    func connectMac(address: String, key: String) async throws {
        let typed = address.trimmingCharacters(in: .whitespacesAndNewlines)
        guard let remoteURL = RemoteClient.baseURL(from: typed) else { throw BackendError.badAddress }
        let stored = Self.withDefaultPort(typed, port: remoteURL.port)
        guard let modelsURL = ModelsClient.baseURL(from: stored) else { throw BackendError.badAddress }
        let key = key.trimmingCharacters(in: .whitespacesAndNewlines)
        macStatus = .connecting

        var name: String?
        var agents = false
        do {
            let hello = try await RemoteClient(baseURL: remoteURL, key: key, session: session).hello()
            name = hello.name
            agents = true
        } catch let error as RemoteError where error.kind == .unauthorized {
            macStatus = macAddress == nil ? .notConnected : .failed(Self.message(for: error))
            throw BackendError.http(401, nil)
        } catch let error as RemoteError where error.kind == .unreachable {
            macStatus = macAddress == nil ? .notConnected : .failed(Self.message(for: error))
            throw BackendError.unreachable(remoteURL.host() ?? "the Mac")
        } catch {
            // Not a Mac with the Remote API (an older Eaon, or the Local API Server): its models may still be there.
        }

        do {
            let models = try await ModelsClient.models(at: modelsURL, apiKey: key, session: session)
            macModels = models
        } catch {
            // The Remote API alone is a connection: agents work even if the model list can't be read.
            guard agents else {
                macStatus = macAddress == nil ? .notConnected : .failed(Self.message(for: error))
                throw error
            }
            macModels = []
        }
        macAddress = stored
        macComputerName = name
        macAgentsSupported = agents
        keychain.setString(key, for: Self.macKeychainKey)
        defaults.set(stored, forKey: Self.macKey)
        defaults.set(name, forKey: Self.macNameKey)
        defaults.set(agents, forKey: Self.macAgentsKey)
        macStatus = .connected
        announceMac()
    }

    /// "my-mac.local" → "my-mac.local:3266"; an address that already has a port is kept as typed.
    nonisolated static func withDefaultPort(_ typed: String, port: Int?) -> String {
        let bare = typed.replacingOccurrences(of: "http://", with: "").replacingOccurrences(of: "https://", with: "")
        let hostPart = bare.split(separator: "/").first.map(String.init) ?? bare
        if hostPart.contains(":") || typed.contains("://") { return typed }
        return "\(typed.trimmingCharacters(in: CharacterSet(charactersIn: "/"))):\(port ?? RemoteClient.defaultPort)"
    }

    /// Asks the Mac for its models again: on launch, and when the app comes back to the front.
    func refreshMac() async {
        guard let address = macAddress, let url = ModelsClient.baseURL(from: address) else { return }
        if macStatus != .connected { macStatus = .connecting }
        do {
            macModels = try await ModelsClient.models(at: url, apiKey: macKey, session: session)
            macStatus = .connected
        } catch is CancellationError {
            return
        } catch {
            macStatus = .failed(Self.message(for: error))
        }
    }

    func disconnectMac() {
        macAddress = nil
        macModels = []
        macComputerName = nil
        macAgentsSupported = false
        macStatus = .notConnected
        keychain.delete(Self.macKeychainKey)
        defaults.removeObject(forKey: Self.macKey)
        defaults.removeObject(forKey: Self.macNameKey)
        defaults.removeObject(forKey: Self.macAgentsKey)
        if selected?.source == .mac { clearSelection() }
        announceMac()
    }

    // MARK: Providers

    func key(for provider: Provider) -> String? {
        keychain.string(Self.providerKeychainKey(provider.id))
    }

    /// Adds or replaces a provider. An empty key means none (Ollama, LM Studio).
    func save(_ provider: Provider, key: String?) {
        if let index = providers.firstIndex(where: { $0.id == provider.id }) {
            providers[index] = provider
        } else {
            providers.append(provider)
        }
        keychain.setString(key?.trimmingCharacters(in: .whitespacesAndNewlines), for: Self.providerKeychainKey(provider.id))
        persistProviders()
        // A provider edited under the selected model keeps it selected under its new name.
        if selected?.source == .provider(provider.id) {
            select(ModelRef(source: .provider(provider.id), id: provider.modelID, name: provider.modelID, detail: provider.name))
        }
    }

    func delete(_ provider: Provider) {
        providers.removeAll { $0.id == provider.id }
        keychain.delete(Self.providerKeychainKey(provider.id))
        persistProviders()
        if selected?.source == .provider(provider.id) { clearSelection() }
    }

    /// Forgets every provider, key and Mac connection.
    func eraseEverything() {
        for provider in providers { keychain.delete(Self.providerKeychainKey(provider.id)) }
        providers = []
        disconnectMac()
        clearSelection()
        persistProviders()
    }

    // MARK: Plumbing

    private func clearSelection() {
        selected = nil
        defaults.removeObject(forKey: Self.selectedKey)
    }

    private func persistProviders() {
        defaults.set(try? JSONEncoder().encode(providers), forKey: Self.providersKey)
    }

    static func message(for error: Error) -> String {
        if let error = error as? LocalizedError, let description = error.errorDescription {
            if let backend = error as? BackendError, let recovery = backend.recovery { return description + " " + recovery }
            return description
        }
        return error.localizedDescription
    }
}

#if DEBUG
extension ModelCatalog {
    /// A pretend connected Mac, for screenshots.
    func installDemoMac() {
        macAddress = "192.168.1.20:3266"
        macModels = ["anthropic/claude-sonnet-5-5", "openai/gpt-5", "ollama/llama3.2"]
        macComputerName = "Alex's MacBook Pro"
        macAgentsSupported = true
        macStatus = .connected
    }
}
#endif

// MARK: - For agents

extension ModelCatalog {
    /// The model an agent's turn runs on and the engine that can run it: the one it is pinned to, else the one
    /// chosen in Chat. Nil when there is nothing to run on.
    func resolveAgentModel(_ pinned: ModelRef?) -> ResolvedAgentModel? {
        let chosen: ModelRef?
        if let pinned, isOffered(pinned) { chosen = pinned } else { chosen = activeModel }
        guard let ref = chosen else { return nil }
        switch ref.source {
        case .onDevice:
            #if canImport(FoundationModels)
            if #available(iOS 26.0, *), onDevice.isAvailable {
                return ResolvedAgentModel(ref: ref, engine: OnDeviceToolEngine(), small: true)
            }
            #endif
            return nil
        case .mac, .provider:
            guard let backend = backend(for: ref) as? OpenAICompatibleBackend else { return nil }
            return ResolvedAgentModel(
                ref: ref,
                engine: OpenAIToolEngine(baseURL: backend.baseURL, apiKey: backend.apiKey, model: backend.model, session: backend.session),
                small: false
            )
        }
    }
}
