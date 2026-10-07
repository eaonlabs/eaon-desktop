import XCTest
@testable import Eaon

@MainActor
final class ChatControllerTests: XCTestCase {
    private let keychain = Keychain(service: "dev.eaon.ios.tests.\(UUID().uuidString)")
    private let defaults = UserDefaults(suiteName: "eaon.tests.\(UUID().uuidString)")!
    private let url = FileManager.default.temporaryDirectory.appendingPathComponent("eaon-tests-\(UUID().uuidString).json")

    override func setUp() { StubProtocol.reset() }

    override func tearDown() {
        StubProtocol.reset()
        keychain.deleteAll()
        try? FileManager.default.removeItem(at: url)
    }

    private func makeController() -> (chat: ChatController, store: ChatStore, catalog: ModelCatalog) {
        let catalog = ModelCatalog(keychain: keychain, defaults: defaults, session: StubProtocol.session())
        let provider = Provider(name: "Test", baseURL: "http://mac.local:1337", modelID: "m1")
        catalog.save(provider, key: "k")
        catalog.select(ModelRef(source: .provider(provider.id), id: "m1", name: "m1", detail: "Test"))
        let store = ChatStore(url: url)
        return (ChatController(store: store, catalog: catalog), store, catalog)
    }

    private func waitUntilDone(_ chat: ChatController, timeout: TimeInterval = 5) async {
        let deadline = Date().addingTimeInterval(timeout)
        while chat.isStreaming && Date() < deadline {
            try? await Task.sleep(for: .milliseconds(20))
        }
    }

    func testSendingStreamsTheReplyInAndSavesTheChat() async {
        StubProtocol.handler = { request in
            StubProtocol.respond(request.url!, type: "text/event-stream", body: sse(["Hello", " there", "."]))
        }
        let (chat, store, _) = makeController()
        chat.draft = "  Say hello to me  "
        XCTAssertTrue(chat.canSend)
        chat.send()
        XCTAssertTrue(chat.isStreaming)
        XCTAssertEqual(chat.draft, "")
        await waitUntilDone(chat)

        XCTAssertFalse(chat.isStreaming)
        XCTAssertEqual(chat.messages.map(\.role), [.user, .assistant])
        XCTAssertEqual(chat.messages.map(\.text), ["Say hello to me", "Hello there."])
        XCTAssertNil(chat.messages.last?.error)
        XCTAssertEqual(chat.current.title, "Say hello to me")
        XCTAssertEqual(store.conversations.count, 1)
        XCTAssertEqual(store.conversations.first?.messages.last?.text, "Hello there.")
    }

    func testTheSecondQuestionCarriesTheFirstAnswer() async throws {
        StubProtocol.handler = { request in StubProtocol.respond(request.url!, type: "text/event-stream", body: sse(["Ok"])) }
        let (chat, _, _) = makeController()
        chat.send("one")
        await waitUntilDone(chat)
        chat.send("two")
        await waitUntilDone(chat)

        let request = try XCTUnwrap(StubProtocol.recorded.last)
        let body = try XCTUnwrap(JSONSerialization.jsonObject(with: request.httpBody ?? Data()) as? [String: Any])
        let messages = try XCTUnwrap(body["messages"] as? [[String: String]])
        XCTAssertEqual(messages.map { $0["role"] }, ["system", "user", "assistant", "user"])
        XCTAssertEqual(messages.map { $0["content"] }.dropFirst(), ["one", "Ok", "two"])
    }

    func testAFailureStaysOnTheMessageAndTryAgainRecovers() async {
        StubProtocol.handler = { request in StubProtocol.respond(request.url!, status: 401, json: ["error": ["message": "no"]]) }
        let (chat, store, _) = makeController()
        chat.send("hello")
        await waitUntilDone(chat)

        XCTAssertEqual(chat.messages.count, 2)
        XCTAssertEqual(chat.messages.last?.text, "")
        XCTAssertTrue(chat.messages.last?.error?.contains("key was refused") == true)
        XCTAssertEqual(store.conversations.first?.messages.last?.error, chat.messages.last?.error)

        StubProtocol.handler = { request in StubProtocol.respond(request.url!, type: "text/event-stream", body: sse(["Fixed"])) }
        chat.regenerate()
        await waitUntilDone(chat)
        XCTAssertEqual(chat.messages.count, 2)
        XCTAssertEqual(chat.messages.last?.text, "Fixed")
        XCTAssertNil(chat.messages.last?.error)
    }

    func testNothingIsSentWithoutAModelOrText() {
        let catalog = ModelCatalog(keychain: keychain, defaults: defaults, session: StubProtocol.session())
        // No providers and no Mac. (Apple's model may or may not be here, so only look at an empty draft.)
        let chat = ChatController(store: ChatStore(url: url), catalog: catalog)
        chat.draft = "   "
        XCTAssertFalse(chat.canSend)
        chat.send()
        XCTAssertTrue(chat.isEmpty)
        XCTAssertTrue(StubProtocol.recorded.isEmpty)
    }

    func testNewChatAndOpeningAnotherOne() async {
        StubProtocol.handler = { request in StubProtocol.respond(request.url!, type: "text/event-stream", body: sse(["A"])) }
        let (chat, store, _) = makeController()
        chat.send("first")
        await waitUntilDone(chat)
        let first = chat.current
        chat.newChat()
        XCTAssertTrue(chat.isEmpty)
        XCTAssertNotEqual(chat.current.id, first.id)

        chat.send("second")
        await waitUntilDone(chat)
        XCTAssertEqual(store.conversations.map(\.title), ["second", "first"])

        chat.open(first)
        XCTAssertEqual(chat.messages.map(\.text), ["first", "A"])
        chat.forget(first.id)
        XCTAssertTrue(chat.isEmpty)
    }
}
