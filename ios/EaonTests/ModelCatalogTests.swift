import XCTest
@testable import Eaon

@MainActor
final class ModelCatalogTests: XCTestCase {
    private let keychain = Keychain(service: "dev.eaon.ios.tests.\(UUID().uuidString)")
    private let defaults = UserDefaults(suiteName: "eaon.tests.\(UUID().uuidString)")!

    override func setUp() { StubProtocol.reset() }

    override func tearDown() {
        StubProtocol.reset()
        keychain.deleteAll()
    }

    private func catalog() -> ModelCatalog {
        ModelCatalog(keychain: keychain, defaults: defaults, session: StubProtocol.session())
    }

    private func macReplies(key: String = "eaon-abc") {
        StubProtocol.handler = { request in
            guard request.value(forHTTPHeaderField: "Authorization") == "Bearer \(key)" else {
                return StubProtocol.respond(request.url!, status: 401, json: ["error": ["message": "bad key"]])
            }
            return StubProtocol.respond(request.url!, json: ["data": [["id": "openai/gpt-5"], ["id": "ollama/llama3.2"], ["id": "plain"]]])
        }
    }

    func testConnectingToAMacKeepsTheAddressAndTheKey() async throws {
        macReplies()
        let catalog = catalog()
        XCTAssertEqual(catalog.macStatus, .notConnected)
        try await catalog.connectMac(address: "my-mac.local:1337", key: " eaon-abc ")

        XCTAssertEqual(catalog.macStatus, .connected)
        XCTAssertEqual(catalog.macAddress, "my-mac.local:1337")
        XCTAssertEqual(catalog.macKey, "eaon-abc")
        XCTAssertEqual(catalog.macName, "my-mac")
        XCTAssertEqual(catalog.macModelRefs.map(\.name), ["llama3.2", "gpt-5", "plain"])
        XCTAssertEqual(catalog.macModelRefs.first?.detail, "ollama · my-mac")

        // A new catalog finds it again and reconnects quietly.
        let again = self.catalog()
        XCTAssertEqual(again.macAddress, "my-mac.local:1337")
        XCTAssertEqual(again.macStatus, .connecting)
        await again.refreshMac()
        XCTAssertEqual(again.macStatus, .connected)
        XCTAssertEqual(again.macModels.count, 3)
    }

    func testAWrongKeyDoesNotConnect() async {
        macReplies()
        let catalog = catalog()
        do {
            try await catalog.connectMac(address: "192.168.1.20:1337", key: "wrong")
            XCTFail("expected an error")
        } catch {
            XCTAssertEqual((error as? BackendError)?.errorDescription, "The key was refused.")
        }
        XCTAssertNil(catalog.macAddress)
        XCTAssertEqual(catalog.macStatus, .notConnected)
        XCTAssertNil(catalog.macKey)
    }

    func testABadAddressIsRefusedBeforeAskingAnyone() async {
        let catalog = catalog()
        do {
            try await catalog.connectMac(address: "not an address", key: "")
            XCTFail("expected an error")
        } catch {
            XCTAssertEqual(error as? BackendError, .badAddress)
        }
        XCTAssertTrue(StubProtocol.recorded.isEmpty)
    }

    func testAnIPAddressIsJustYourMac() async throws {
        macReplies()
        let catalog = catalog()
        try await catalog.connectMac(address: "192.168.1.20:1337", key: "eaon-abc")
        XCTAssertEqual(catalog.macName, "Your Mac")
    }

    func testAMacThatGoesAwayIsFailedNotForgotten() async throws {
        macReplies()
        let catalog = catalog()
        try await catalog.connectMac(address: "192.168.1.20:1337", key: "eaon-abc")
        StubProtocol.handler = { _ in throw URLError(.cannotConnectToHost) }
        await catalog.refreshMac()
        guard case .failed(let message) = catalog.macStatus else { return XCTFail("\(catalog.macStatus)") }
        XCTAssertTrue(message.contains("Couldn't reach 192.168.1.20"))
        XCTAssertEqual(catalog.macAddress, "192.168.1.20:1337")
        XCTAssertEqual(catalog.macModels.count, 3, "the last list stays")
    }

    func testDisconnectingForgetsTheMacAndItsSelection() async throws {
        macReplies()
        let catalog = catalog()
        try await catalog.connectMac(address: "192.168.1.20:1337", key: "eaon-abc")
        catalog.select(catalog.macModelRefs[0])
        XCTAssertEqual(catalog.activeModel?.source, .mac)
        catalog.disconnectMac()
        XCTAssertNil(catalog.macAddress)
        XCTAssertNil(catalog.macKey)
        XCTAssertEqual(catalog.macStatus, .notConnected)
        XCTAssertTrue(catalog.macModelRefs.isEmpty)
        XCTAssertNil(catalog.selected)
    }

    func testProvidersKeepTheirKeysInTheKeychainOnly() {
        let catalog = catalog()
        let provider = Provider(name: "OpenAI", baseURL: "https://api.openai.com/v1", modelID: "gpt-5")
        catalog.save(provider, key: "  sk-secret  ")

        XCTAssertEqual(catalog.key(for: provider), "sk-secret")
        let saved = defaults.data(forKey: "eaon.models.providers").flatMap { String(data: $0, encoding: .utf8) } ?? ""
        XCTAssertFalse(saved.contains("sk-secret"), "the key must not be in UserDefaults")
        XCTAssertEqual(self.catalog().providers, [provider])
        XCTAssertEqual(self.catalog().key(for: provider), "sk-secret")
    }

    func testEditingAProviderKeepsItSelectedUnderItsNewModel() {
        let catalog = catalog()
        var provider = Provider(name: "P", baseURL: "http://x.local/v1", modelID: "old")
        catalog.save(provider, key: nil)
        catalog.select(catalog.providerModelRefs[0])
        provider.modelID = "new"
        catalog.save(provider, key: nil)
        XCTAssertEqual(catalog.providers.count, 1)
        XCTAssertEqual(catalog.activeModel?.id, "new")
    }

    func testDeletingTheSelectedProviderClearsTheSelectionAndTheKey() {
        let catalog = catalog()
        let provider = Provider(name: "P", baseURL: "http://x.local/v1", modelID: "m")
        catalog.save(provider, key: "k")
        catalog.select(catalog.providerModelRefs[0])
        catalog.delete(provider)
        XCTAssertTrue(catalog.providers.isEmpty)
        XCTAssertNil(catalog.selected)
        XCTAssertNil(catalog.key(for: provider))
        XCTAssertNil(keychain.string("provider.key.\(provider.id.uuidString)"))
    }

    func testEraseEverythingClearsProvidersAndTheMac() async throws {
        macReplies()
        let catalog = catalog()
        let provider = Provider(name: "P", baseURL: "http://x.local/v1", modelID: "m")
        catalog.save(provider, key: "k")
        try await catalog.connectMac(address: "192.168.1.20:1337", key: "eaon-abc")
        catalog.eraseEverything()
        XCTAssertTrue(catalog.providers.isEmpty)
        XCTAssertNil(catalog.macAddress)
        XCTAssertNil(catalog.key(for: provider))
        XCTAssertNil(self.catalog().macAddress)
        XCTAssertTrue(self.catalog().providers.isEmpty)
    }

    func testTheBackendForAMacModelPointsAtTheMac() async throws {
        macReplies()
        let catalog = catalog()
        try await catalog.connectMac(address: "my-mac.local:1337", key: "eaon-abc")
        let backend = try XCTUnwrap(catalog.backend(for: catalog.macModelRefs[0]) as? OpenAICompatibleBackend)
        XCTAssertEqual(backend.baseURL.absoluteString, "http://my-mac.local:1337/v1")
        XCTAssertEqual(backend.apiKey, "eaon-abc")
        XCTAssertEqual(backend.model, "ollama/llama3.2")
    }
}
