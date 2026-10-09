import XCTest
@testable import Eaon

final class ChatBackendTests: XCTestCase {
    override func setUp() { StubProtocol.reset() }
    override func tearDown() { StubProtocol.reset() }

    // MARK: SSE lines

    func testSSELines() throws {
        XCTAssertEqual(try SSE.parse(line: #"data: {"choices":[{"delta":{"content":"Hel"}}]}"#), .text("Hel"))
        XCTAssertEqual(try SSE.parse(line: #"data:{"choices":[{"delta":{"content":"lo"}}]}"#), .text("lo"))
        XCTAssertEqual(try SSE.parse(line: "data: [DONE]"), .done)
        // A role-only first chunk, a keep-alive comment and an empty delta say nothing.
        XCTAssertEqual(try SSE.parse(line: #"data: {"choices":[{"delta":{"role":"assistant"}}]}"#), .ignore)
        XCTAssertEqual(try SSE.parse(line: ": keep-alive"), .ignore)
        XCTAssertEqual(try SSE.parse(line: #"data: {"choices":[{"delta":{"content":""}}]}"#), .ignore)
        XCTAssertEqual(try SSE.parse(line: "data: not json"), .ignore)
    }

    func testAnErrorInTheStreamThrows() {
        XCTAssertThrowsError(try SSE.parse(line: #"data: {"error":{"message":"Rate limit"}}"#)) { error in
            XCTAssertEqual(error as? BackendError, .failed("Rate limit"))
        }
    }

    // MARK: Addresses

    func testAddressesBecomeAPIBases() {
        let cases: [(String, String?)] = [
            ("192.168.1.20:1337", "http://192.168.1.20:1337/v1"),
            ("  192.168.1.20:1337/  ", "http://192.168.1.20:1337/v1"),
            ("http://192.168.1.20:1337/v1", "http://192.168.1.20:1337/v1"),
            ("my-mac.local:1337", "http://my-mac.local:1337/v1"),
            ("localhost:1337", "http://localhost:1337/v1"),
            ("10.0.0.5", "http://10.0.0.5/v1"),
            ("api.openai.com/v1", "https://api.openai.com/v1"),
            ("https://openrouter.ai/api/v1/", "https://openrouter.ai/api/v1"),
            ("https://my-mac.tailnet.ts.net", "https://my-mac.tailnet.ts.net/v1"),
            ("https://example.com/api?x=1#top", "https://example.com/api/v1"),
            ("", nil),
            ("not an address", nil),
            ("ftp://example.com", nil)
        ]
        for (typed, expected) in cases {
            XCTAssertEqual(ModelsClient.baseURL(from: typed)?.absoluteString, expected, "for “\(typed)”")
        }
    }

    // MARK: The backend

    private func backend(key: String? = "k", model: String = "demo") -> OpenAICompatibleBackend {
        OpenAICompatibleBackend(baseURL: URL(string: "http://mac.local:1337/v1")!, apiKey: key, model: model, session: StubProtocol.session())
    }

    private func collect(_ backend: OpenAICompatibleBackend, _ messages: [BackendMessage] = [BackendMessage(role: "user", content: "hi")]) async throws -> String {
        var text = ""
        for try await piece in backend.stream(messages) { text += piece }
        return text
    }

    func testStreamsPiecesInOrderAndSendsTheRequestRight() async throws {
        StubProtocol.handler = { request in
            StubProtocol.respond(request.url!, type: "text/event-stream", body: sse(["Hel", "lo ", "there"]))
        }
        let text = try await collect(backend(), [
            BackendMessage(role: "system", content: "Be brief."),
            BackendMessage(role: "user", content: "hi")
        ])
        XCTAssertEqual(text, "Hello there")

        let request = try XCTUnwrap(StubProtocol.recorded.first)
        XCTAssertEqual(request.url?.absoluteString, "http://mac.local:1337/v1/chat/completions")
        XCTAssertEqual(request.httpMethod, "POST")
        XCTAssertEqual(request.value(forHTTPHeaderField: "Authorization"), "Bearer k")
        let body = try XCTUnwrap(JSONSerialization.jsonObject(with: request.httpBody ?? Data()) as? [String: Any])
        XCTAssertEqual(body["model"] as? String, "demo")
        XCTAssertEqual(body["stream"] as? Bool, true)
        let messages = try XCTUnwrap(body["messages"] as? [[String: String]])
        XCTAssertEqual(messages.map { $0["role"] }, ["system", "user"])
        XCTAssertEqual(messages.last?["content"], "hi")
    }

    func testNoKeyMeansNoAuthorizationHeader() async throws {
        StubProtocol.handler = { request in StubProtocol.respond(request.url!, type: "text/event-stream", body: sse(["ok"])) }
        _ = try await collect(backend(key: nil))
        XCTAssertNil(StubProtocol.recorded.first?.value(forHTTPHeaderField: "Authorization"))
    }

    func testARefusedKeyIsSaidPlainly() async {
        StubProtocol.handler = { request in StubProtocol.respond(request.url!, status: 401, json: ["error": ["message": "Invalid key"]]) }
        do {
            _ = try await collect(backend())
            XCTFail("expected an error")
        } catch {
            XCTAssertEqual(error as? BackendError, .http(401, "Invalid key"))
            XCTAssertEqual((error as? BackendError)?.errorDescription, "The key was refused.")
        }
    }

    func testAServerErrorKeepsItsMessage() async {
        StubProtocol.handler = { request in StubProtocol.respond(request.url!, status: 500, json: ["error": ["message": "Bad day"]]) }
        do {
            _ = try await collect(backend())
            XCTFail("expected an error")
        } catch {
            XCTAssertEqual((error as? BackendError)?.errorDescription, "Bad day")
        }
    }

    func testAServerThatIgnoredStreamingStillWorks() async throws {
        StubProtocol.handler = { request in
            StubProtocol.respond(request.url!, json: ["choices": [["message": ["role": "assistant", "content": "All at once."]]]])
        }
        let text = try await collect(backend())
        XCTAssertEqual(text, "All at once.")
    }

    func testAnEmptyAnswerIsAnError() async {
        StubProtocol.handler = { request in StubProtocol.respond(request.url!, type: "text/event-stream", body: Data("data: [DONE]\n\n".utf8)) }
        do {
            _ = try await collect(backend())
            XCTFail("expected an error")
        } catch {
            XCTAssertEqual(error as? BackendError, .empty)
        }
    }

    func testAnUnreachableServerNamesTheHost() async {
        StubProtocol.handler = { _ in throw URLError(.cannotConnectToHost) }
        do {
            _ = try await collect(backend())
            XCTFail("expected an error")
        } catch {
            XCTAssertEqual(error as? BackendError, .unreachable("mac.local"))
            XCTAssertEqual((error as? BackendError)?.errorDescription, "Couldn't reach mac.local.")
        }
    }

    // MARK: Models

    func testListsModelsSorted() async throws {
        StubProtocol.handler = { request in
            StubProtocol.respond(request.url!, json: ["data": [["id": "openai/gpt-5"], ["id": "anthropic/claude"]]])
        }
        let ids = try await ModelsClient.models(at: URL(string: "http://mac.local:1337/v1")!, apiKey: "k", session: StubProtocol.session())
        XCTAssertEqual(ids, ["anthropic/claude", "openai/gpt-5"])
        XCTAssertEqual(StubProtocol.recorded.first?.url?.absoluteString, "http://mac.local:1337/v1/models")
        XCTAssertEqual(StubProtocol.recorded.first?.value(forHTTPHeaderField: "Authorization"), "Bearer k")
    }

    func testSomethingThatIsntAnAPIIsSaidSo() async {
        StubProtocol.handler = { request in StubProtocol.respond(request.url!, type: "text/html", body: Data("<html></html>".utf8)) }
        do {
            _ = try await ModelsClient.models(at: URL(string: "http://mac.local/v1")!, apiKey: nil, session: StubProtocol.session())
            XCTFail("expected an error")
        } catch {
            XCTAssertTrue((error as? BackendError)?.errorDescription?.contains("OpenAI-style") == true, "\(error)")
        }
    }

    // MARK: On this iPhone

    func testThePromptKeepsTheEndOfALongConversation() {
        var messages = [BackendMessage(role: "system", content: "ignored")]
        for index in 0..<40 {
            messages.append(BackendMessage(role: index % 2 == 0 ? "user" : "assistant", content: "turn \(index) " + String(repeating: "x", count: 400)))
        }
        messages.append(BackendMessage(role: "user", content: "the last question"))
        let prompt = OnDevice.prompt(from: messages, limit: 2_000)
        XCTAssertTrue(prompt.hasSuffix("the last question"))
        XCTAssertTrue(prompt.contains("turn 39"))
        XCTAssertFalse(prompt.contains("turn 0 "))
        XCTAssertFalse(prompt.contains("ignored"))
        XCTAssertLessThan(prompt.count, 2_600)
    }

    func testAFirstMessageIsJustTheMessage() {
        XCTAssertEqual(OnDevice.prompt(from: [BackendMessage(role: "system", content: "s"), BackendMessage(role: "user", content: "hello")]), "hello")
    }
}
