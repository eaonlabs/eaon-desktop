import XCTest
@testable import Eaon

final class RemoteClientTests: XCTestCase {
    override func setUp() { StubProtocol.reset() }
    override func tearDown() { StubProtocol.reset() }

    private func client() -> RemoteClient {
        RemoteClient(baseURL: URL(string: "http://mac.local:3266")!, key: "eaonr-key", session: StubProtocol.session())
    }

    private let workerJSON: [String: Any] = [
        "id": "w1", "name": "Nova", "color": "#5B6CF0", "purpose": "Writes code", "personality": "Methodical",
        "status": "working", "mood": "serious", "activity": "Running tests", "paused": false, "access": "safe",
        "model": ["providerId": "anthropic", "modelId": "claude-sonnet-5-5", "label": "claude-sonnet-5-5"],
        "goal": "Make the tests pass",
        "goalRun": ["text": "Make the tests pass", "status": "active", "turns": 3],
        "asks": [["id": "a1", "question": "Include refunds?", "options": ["Yes", "No"], "approve": NSNull(), "at": 1_700_000_000_000.0],
                 ["id": "a2", "question": "Run it?", "options": [], "approve": ["tool": "run_command", "summary": "Run npm test"], "at": 1_700_000_100_000.0]],
        "unread": 2, "lastRunAt": 1_700_000_200_000.0, "lastOutcome": ["at": 1_700_000_200_000.0, "ok": true], "lastError": NSNull(),
        "nextWakeAt": 1_700_000_900_000.0, "routines": [], "runningMessageId": "m9", "createdAt": 1_690_000_000_000.0
    ]

    // MARK: Addresses

    func testAddressesBecomeBaseURLsWithEaonsPort() {
        XCTAssertEqual(RemoteClient.baseURL(from: "192.168.1.20")?.absoluteString, "http://192.168.1.20:3266")
        XCTAssertEqual(RemoteClient.baseURL(from: " my-mac.local:4000/ ")?.absoluteString, "http://my-mac.local:4000")
        XCTAssertEqual(RemoteClient.baseURL(from: "http://10.0.0.5:3266/remote/v1")?.absoluteString, "http://10.0.0.5:3266")
        XCTAssertEqual(RemoteClient.baseURL(from: "https://my-mac.tailnet.ts.net")?.absoluteString, "https://my-mac.tailnet.ts.net")
        XCTAssertNil(RemoteClient.baseURL(from: ""))
        XCTAssertNil(RemoteClient.baseURL(from: "not an address"))
        XCTAssertNil(RemoteClient.baseURL(from: "ftp://x.test"))
        XCTAssertEqual(ModelCatalog.withDefaultPort("my-mac.local", port: 3266), "my-mac.local:3266")
        XCTAssertEqual(ModelCatalog.withDefaultPort("my-mac.local:1337", port: 1337), "my-mac.local:1337")
    }

    // MARK: Reading

    func testHelloAndWorkersAreReadWithTheKey() async throws {
        StubProtocol.handler = { [workerJSON] request in
            switch request.url!.path {
            case "/remote/v1/hello": return StubProtocol.respond(request.url!, json: ["app": "Eaon", "apiVersion": 1, "appVersion": "2026.6.1", "name": "Alex's MacBook Pro", "workers": 1, "running": 1])
            default: return StubProtocol.respond(request.url!, json: ["workers": [workerJSON]])
            }
        }
        let hello = try await client().hello()
        XCTAssertEqual(hello.name, "Alex's MacBook Pro")
        XCTAssertEqual(hello.apiVersion, 1)
        let workers = try await client().workers()
        XCTAssertEqual(workers.count, 1)
        for request in StubProtocol.recorded {
            XCTAssertEqual(request.value(forHTTPHeaderField: "Authorization"), "Bearer eaonr-key")
            XCTAssertEqual(request.httpMethod, "GET")
        }
    }

    func testAWorkerBecomesAnAgent() throws {
        let data = try JSONSerialization.data(withJSONObject: workerJSON)
        let agent = try JSONDecoder().decode(RemoteWorker.self, from: data).agent
        XCTAssertEqual(agent.key, AgentKey(place: .mac, id: "w1"))
        XCTAssertEqual(agent.name, "Nova")
        XCTAssertEqual(agent.status, .working)
        XCTAssertEqual(agent.mood, .serious)
        XCTAssertEqual(agent.access, .safe)
        XCTAssertEqual(agent.modelName, "claude-sonnet-5-5")
        XCTAssertEqual(agent.goalRun, AgentGoalRun(text: "Make the tests pass", state: .active, turns: 3, summary: nil))
        XCTAssertEqual(agent.asks.map(\.question), ["Include refunds?", "Run it?"])
        XCTAssertEqual(agent.asks[0].options, ["Yes", "No"])
        XCTAssertNil(agent.asks[0].approval)
        XCTAssertEqual(agent.asks[1].approval, "Run npm test")
        XCTAssertEqual(agent.unread, 2)
        XCTAssertEqual(agent.lastRunAt, Date(timeIntervalSince1970: 1_700_000_200))
        XCTAssertEqual(agent.nextWakeAt, Date(timeIntervalSince1970: 1_700_000_900))
        XCTAssertNil(agent.lastError)
        XCTAssertTrue(agent.needsYou)
    }

    func testUnknownValuesFromANewerMacAreTolerated() throws {
        var json = workerJSON
        json["status"] = "daydreaming"
        json["mood"] = "ecstatic"
        json["access"] = "godmode"
        json["somethingNew"] = ["x": 1]
        let agent = try JSONDecoder().decode(RemoteWorker.self, from: JSONSerialization.data(withJSONObject: json)).agent
        XCTAssertEqual(agent.status, .idle)
        XCTAssertEqual(agent.mood, .neutral)
        XCTAssertEqual(agent.access, .autonomous)
    }

    func testAThreadBecomesMessages() async throws {
        StubProtocol.handler = { request in
            XCTAssertEqual(URLComponents(url: request.url!, resolvingAgainstBaseURL: false)?.queryItems?.first?.value, "60")
            return StubProtocol.respond(request.url!, json: [
                "messages": [
                    ["id": "m1", "role": "user", "at": 1_700_000_000_000.0, "from": ["name": "Atlas", "color": "#22A7A0"], "parts": [["kind": "text", "text": "hello"]], "streaming": false],
                    ["id": "m2", "role": "assistant", "at": 1_700_000_001_000.0, "heartbeat": "check",
                     "parts": [["kind": "text", "text": "Looking."], ["kind": "tool", "id": "t1", "name": "run_command", "title": "Ran a command", "detail": "ls", "status": "done", "output": "a b"], ["kind": "hologram"]],
                     "error": "boom", "streaming": true]
                ],
                "hasMore": true
            ])
        }
        let reply = try await client().thread("w1")
        XCTAssertTrue(reply.hasMore)
        let messages = reply.messages.map(\.message)
        XCTAssertEqual(messages[0].role, .user)
        XCTAssertEqual(messages[0].from, AgentMessage.Sender(name: "Atlas", colorHex: "#22A7A0"))
        XCTAssertEqual(messages[1].parts.count, 2, "a part kind it doesn't know is skipped")
        XCTAssertEqual(messages[1].steps.first, AgentStep(id: "t1", name: "run_command", title: "Ran a command", detail: "ls", status: .done, output: "a b"))
        XCTAssertEqual(messages[1].heartbeat, "check")
        XCTAssertEqual(messages[1].error, "boom")
        XCTAssertTrue(messages[1].streaming)
        XCTAssertEqual(StubProtocol.recorded.first?.url?.path, "/remote/v1/workers/w1/thread")
    }

    // MARK: Commands

    func testCommandsSendTheRightRequests() async throws {
        StubProtocol.handler = { [workerJSON] request in
            if request.url!.path == "/remote/v1/workers" || request.url!.path == "/remote/v1/workers/w1" && request.httpMethod == "PATCH" {
                return StubProtocol.respond(request.url!, status: request.httpMethod == "POST" ? 201 : 200, json: ["worker": workerJSON])
            }
            return StubProtocol.respond(request.url!, json: ["ok": true])
        }
        let c = client()
        let created = try await c.create(.init(name: "Nova", color: "#5B6CF0", purpose: "Code", personality: "", access: "safe", model: .init(providerId: "anthropic", modelId: "claude")))
        XCTAssertEqual(created.id, "w1")
        _ = try await c.update("w1", .init(name: "Nova 2"))
        try await c.sendMessage("w1", text: "do it", goal: true)
        try await c.sendMessage("w1", text: "plain", goal: false)
        try await c.command("w1", "stop")
        try await c.command("w1", "wake")
        try await c.setPaused("w1", paused: true)
        try await c.setGoal("w1", status: "paused")
        try await c.setGoal("w1", status: nil)
        try await c.answer("w1", askID: "a1", text: nil, approved: true)
        try await c.delete("w1")

        func body(_ index: Int) -> [String: Any] { (try? JSONSerialization.jsonObject(with: StubProtocol.recorded[index].httpBody ?? Data()) as? [String: Any]) ?? [:] }
        let calls = StubProtocol.recorded.map { "\($0.httpMethod ?? "") \($0.url!.path)" }
        XCTAssertEqual(calls, [
            "POST /remote/v1/workers", "PATCH /remote/v1/workers/w1", "POST /remote/v1/workers/w1/send", "POST /remote/v1/workers/w1/send",
            "POST /remote/v1/workers/w1/stop", "POST /remote/v1/workers/w1/wake", "POST /remote/v1/workers/w1/pause", "POST /remote/v1/workers/w1/goal",
            "POST /remote/v1/workers/w1/goal", "POST /remote/v1/workers/w1/answer", "DELETE /remote/v1/workers/w1"
        ])
        XCTAssertEqual(body(0)["name"] as? String, "Nova")
        XCTAssertEqual((body(0)["model"] as? [String: String]), ["providerId": "anthropic", "modelId": "claude"])
        XCTAssertNil(body(1)["purpose"], "a partial edit sends only what changed")
        XCTAssertEqual(body(2)["goal"] as? Bool, true)
        XCTAssertNil(body(3)["goal"])
        XCTAssertEqual(body(6)["paused"] as? Bool, true)
        XCTAssertEqual(body(7)["status"] as? String, "paused")
        XCTAssertTrue(body(8).keys.contains("status") && body(8)["status"] is NSNull, "clearing the goal sends null")
        XCTAssertEqual(body(9)["askId"] as? String, "a1")
        XCTAssertEqual(body(9)["approved"] as? Bool, true)
        for request in StubProtocol.recorded where request.httpBody != nil {
            XCTAssertEqual(request.value(forHTTPHeaderField: "Content-Type"), "application/json")
        }
    }

    // MARK: Errors

    func testErrorsSayWhatToDo() async {
        for (status, kind) in [(401, RemoteError.Kind.unauthorized), (404, .notFound), (429, .rateLimited)] {
            StubProtocol.handler = { request in StubProtocol.respond(request.url!, status: status, json: ["error": ["code": "x", "message": "server words"]]) }
            do {
                _ = try await client().hello()
                XCTFail("expected \(status)")
            } catch {
                XCTAssertEqual((error as? RemoteError)?.kind, kind)
            }
        }
        StubProtocol.handler = { request in StubProtocol.respond(request.url!, status: 409, json: ["error": ["code": "conflict", "message": "That's the most workers."]]) }
        do { try await client().command("w1", "wake"); XCTFail() } catch { XCTAssertEqual((error as? RemoteError)?.message, "That's the most workers.") }
        StubProtocol.handler = { _ in throw URLError(.cannotConnectToHost) }
        do { _ = try await client().hello(); XCTFail() } catch {
            XCTAssertEqual((error as? RemoteError)?.kind, .unreachable)
            XCTAssertTrue((error as? RemoteError)?.message.contains("mac.local") == true)
        }
        StubProtocol.handler = { request in StubProtocol.respond(request.url!, type: "text/html", body: Data("<html>".utf8)) }
        do { _ = try await client().hello(); XCTFail() } catch { XCTAssertEqual((error as? RemoteError)?.kind, .old) }
    }

    // MARK: The event stream

    func testEventsAreReadFromTheStream() async throws {
        let workers = try JSONSerialization.data(withJSONObject: ["workers": [workerJSON]])
        let message: [String: Any] = ["workerId": "w1", "message": ["id": "m1", "role": "assistant", "at": 1.0, "parts": [], "streaming": true]]
        let body = """
        : ping

        event: workers
        data: \(String(decoding: workers, as: UTF8.self))

        event: message
        data: \(String(decoding: try JSONSerialization.data(withJSONObject: message), as: UTF8.self))

        event: delta
        data: {"workerId":"w1","messageId":"m1","text":"Hel"}

        event: tool
        data: {"workerId":"w1","messageId":"m1","part":{"kind":"tool","id":"t1","name":"x","title":"Did x","status":"running"}}

        event: mystery
        data: {"x":1}

        event: delta
        data: not json

        event: delta
        data: {"workerId":"w1","messageId":"m1","text":"lo"}


        """
        StubProtocol.handler = { request in
            XCTAssertEqual(request.value(forHTTPHeaderField: "Accept"), "text/event-stream")
            return StubProtocol.respond(request.url!, type: "text/event-stream", body: Data(body.utf8))
        }
        var events: [RemoteEvent] = []
        for try await event in client().events() { events.append(event) }
        XCTAssertEqual(events.count, 5, "unknown events and broken data are skipped")
        guard case .workers(let list) = events[0] else { return XCTFail("\(events[0])") }
        XCTAssertEqual(list.first?.name, "Nova")
        guard case .message(let id, let m) = events[1] else { return XCTFail() }
        XCTAssertEqual(id, "w1")
        XCTAssertTrue(m.streaming == true)
        XCTAssertEqual(events[2], .delta(workerID: "w1", messageID: "m1", text: "Hel"))
        guard case .tool(_, _, let part) = events[3] else { return XCTFail() }
        XCTAssertEqual(part.id, "t1")
        XCTAssertEqual(events[4], .delta(workerID: "w1", messageID: "m1", text: "lo"))
    }

    func testAnEventStreamWithTheWrongKeyThrows() async {
        StubProtocol.handler = { request in StubProtocol.respond(request.url!, status: 401, json: ["error": ["message": "no"]]) }
        do {
            for try await _ in client().events() {}
            XCTFail("expected an error")
        } catch {
            XCTAssertEqual((error as? RemoteError)?.kind, .unauthorized)
        }
    }

    func testTheEventParserPairsEachDataLineWithItsName() {
        var parser = SSEEventParser()
        XCTAssertNil(parser.feed(line: ": ping"))
        XCTAssertNil(parser.feed(line: "event: delta"))
        XCTAssertEqual(parser.feed(line: "data: {\"a\":1}")?.name, "delta")
        XCTAssertEqual(parser.feed(line: "data: {\"b\":2}")?.name, "message", "the name applies to one event")
    }
}

@MainActor
final class MacAgentsTests: XCTestCase {
    private func worker(_ id: String, name: String = "Nova", status: String = "idle") -> RemoteWorker {
        RemoteWorker(
            id: id, name: name, color: "#3E86C6", purpose: "p", status: status, paused: false, access: "autonomous", createdAt: 1_700_000_000_000
        )
    }

    private func message(_ id: String, role: String = "assistant", parts: [RemotePart] = [], streaming: Bool = false) -> RemoteMessage {
        RemoteMessage(id: id, role: role, at: 1_700_000_000_000, parts: parts, streaming: streaming)
    }

    /// A MacAgents that has the thread of one agent open.
    private func opened(_ id: String = "w1") async -> MacAgents {
        StubProtocol.reset()
        StubProtocol.handler = { request in StubProtocol.respond(request.url!, json: ["messages": [], "hasMore": false]) }
        let agents = MacAgents()
        agents.configure(client: RemoteClient(baseURL: URL(string: "http://x.test:3266")!, key: "k", session: StubProtocol.session()), name: "Mac")
        await agents.loadThread(id)
        return agents
    }

    override func tearDown() { StubProtocol.reset() }

    func testASnapshotReplacesTheList() async {
        let agents = await opened()
        agents.apply(.workers([worker("w1"), worker("w2", name: "Atlas", status: "working")]))
        XCTAssertEqual(agents.agents.map(\.name), ["Nova", "Atlas"])
        XCTAssertEqual(agents.agents[1].status, .working)
        agents.apply(.workers([worker("w2", name: "Atlas")]))
        XCTAssertEqual(agents.agents.map(\.name), ["Atlas"])
        agents.configure(client: nil, name: nil)
    }

    func testMessagesDeltasAndStepsBuildTheThreadLive() async {
        let agents = await opened()
        agents.apply(.message(workerID: "w1", message("u1", role: "user", parts: [RemotePart(kind: "text", text: "go")])))
        agents.apply(.message(workerID: "w1", message("a1", streaming: true)))
        agents.apply(.delta(workerID: "w1", messageID: "a1", text: "Look"))
        agents.apply(.delta(workerID: "w1", messageID: "a1", text: "ing."))
        agents.apply(.tool(workerID: "w1", messageID: "a1", RemotePart(kind: "tool", id: "t1", name: "run_command", title: "Ran a command", status: "running")))
        agents.apply(.tool(workerID: "w1", messageID: "a1", RemotePart(kind: "tool", id: "t1", name: "run_command", title: "Ran a command", status: "done", output: "ok")))
        agents.apply(.delta(workerID: "w1", messageID: "a1", text: " Done."))

        var thread = agents.messages(for: "w1")
        XCTAssertEqual(thread.map(\.id), ["u1", "a1"])
        XCTAssertEqual(thread[1].parts.count, 3)
        XCTAssertEqual(thread[1].steps.count, 1, "the step is updated in place, not added twice")
        XCTAssertEqual(thread[1].steps[0].status, .done)
        XCTAssertEqual(thread[1].text, "Looking.\n\n Done.")
        XCTAssertTrue(thread[1].streaming)

        // The turn ends: the whole message arrives and replaces it.
        agents.apply(.message(workerID: "w1", message("a1", parts: [RemotePart(kind: "text", text: "Final.")], streaming: false)))
        thread = agents.messages(for: "w1")
        XCTAssertEqual(thread.count, 2)
        XCTAssertEqual(thread[1].text, "Final.")
        XCTAssertFalse(thread[1].streaming)
        agents.configure(client: nil, name: nil)
    }

    func testAThreadThatIsntOpenIsNotBuilt() async {
        let agents = await opened("w1")
        agents.apply(.message(workerID: "other", message("x")))
        agents.apply(.delta(workerID: "other", messageID: "x", text: "hi"))
        XCTAssertTrue(agents.messages(for: "other").isEmpty)
        agents.configure(client: nil, name: nil)
    }

    func testWhatYouJustSentShowsAtOnceAndIsReplacedByTheMacsCopy() async throws {
        let agents = await opened()
        StubProtocol.handler = { request in StubProtocol.respond(request.url!, json: ["ok": true]) }
        try await agents.send("w1", text: "  do the thing  ", asGoal: false)
        XCTAssertEqual(agents.messages(for: "w1").map(\.text), ["do the thing"])
        XCTAssertTrue(agents.messages(for: "w1")[0].id.hasPrefix("local-"))
        // The Mac's own user message, which can combine several, arrives.
        agents.apply(.message(workerID: "w1", message("u9", role: "user", parts: [RemotePart(kind: "text", text: "do the thing")])))
        XCTAssertEqual(agents.messages(for: "w1").map(\.id), ["u9"])
        agents.configure(client: nil, name: nil)
    }

    func testASendThatFailsTakesItsEchoBack() async throws {
        let agents = await opened()
        StubProtocol.handler = { request in StubProtocol.respond(request.url!, status: 409, json: ["error": ["message": "Nope"]]) }
        do { try await agents.send("w1", text: "x", asGoal: false); XCTFail() } catch { XCTAssertEqual((error as? RemoteError)?.message, "Nope") }
        XCTAssertTrue(agents.messages(for: "w1").isEmpty)
        agents.configure(client: nil, name: nil)
    }

    func testTheTabBadgeCountsWhoIsWaitingOnYou() async throws {
        let h = AgentHarness()
        let scout = try await h.make("Scout")
        _ = try await h.make("Remy")
        let mac = MacAgents()
        let store = AgentsStore(phone: h.agents, mac: mac)
        XCTAssertEqual(store.waitingOnYou, 0)
        _ = h.agents.raiseQuestion(scout.key.id, question: "Which one?", options: [])
        XCTAssertEqual(store.waitingOnYou, 1)
        var asking = worker("w1")
        asking.asks = [RemoteAsk(id: "a", question: "Include refunds?", options: ["Yes"], approve: nil, at: 1)]
        mac.apply(.workers([asking, worker("w2")]))
        XCTAssertEqual(store.waitingOnYou, 2)
        XCTAssertEqual(store.all.count, 4)
        XCTAssertEqual(store.agent(AgentKey(place: .mac, id: "w1"))?.asks.count, 1)
        XCTAssertNil(store.agent(AgentKey(place: .phone, id: "w1")), "the same id on the other place is another agent")
        XCTAssertFalse(store.isEmpty)
    }

    func testWithoutAMacCommandsSayTheMacIsntConnected() async {
        let agents = MacAgents()
        XCTAssertFalse(agents.isAvailable)
        do { _ = try await agents.create(AgentDraft(name: "A", purpose: "p")); XCTFail() } catch { XCTAssertEqual(error as? AgentError, .notConnected) }
        do { try await agents.send("w", text: "x", asGoal: false); XCTFail() } catch { XCTAssertEqual(error as? AgentError, .notConnected) }
        await agents.stop("w")
        XCTAssertEqual(agents.connection, .off)
    }

    func testTheConnectionStreamsAndReconnects() async throws {
        StubProtocol.reset()
        let workers = try JSONSerialization.data(withJSONObject: ["workers": [["id": "w1", "name": "Nova", "color": "#3E86C6", "purpose": "p", "status": "idle", "paused": false, "access": "safe", "createdAt": 1.0]]])
        var attempts = 0
        StubProtocol.handler = { request in
            if request.url!.path == "/remote/v1/events" {
                attempts += 1
                if attempts == 1 { throw URLError(.networkConnectionLost) }
                return StubProtocol.respond(request.url!, type: "text/event-stream", body: Data("event: workers\ndata: \(String(decoding: workers, as: UTF8.self))\n\n".utf8))
            }
            return StubProtocol.respond(request.url!, json: ["models": [["id": "a/b", "name": "b", "provider": "A"]], "default": "a/b"])
        }
        let agents = MacAgents()
        agents.maxBackoff = 0.05
        agents.configure(client: RemoteClient(baseURL: URL(string: "http://x.test:3266")!, key: "k", session: StubProtocol.session()), name: "Mac")
        XCTAssertEqual(agents.connection, .connecting)
        for _ in 0..<100 where agents.agents.isEmpty { try? await Task.sleep(for: .milliseconds(30)) }
        XCTAssertEqual(agents.agents.map(\.name), ["Nova"])
        XCTAssertGreaterThanOrEqual(attempts, 2, "it came back after the connection dropped")
        XCTAssertEqual(agents.computerName, "Mac")
        for _ in 0..<50 where agents.models.isEmpty { try? await Task.sleep(for: .milliseconds(20)) }
        XCTAssertEqual(agents.models.map(\.name), ["b"])
        agents.configure(client: nil, name: nil)
        XCTAssertTrue(agents.agents.isEmpty)
        XCTAssertEqual(agents.connection, .off)
    }

    func testAWrongKeyIsNotRetried() async throws {
        StubProtocol.reset()
        var attempts = 0
        StubProtocol.handler = { request in
            attempts += 1
            return StubProtocol.respond(request.url!, status: 401, json: ["error": ["message": "no"]])
        }
        let agents = MacAgents()
        agents.maxBackoff = 0.02
        agents.configure(client: RemoteClient(baseURL: URL(string: "http://x.test:3266")!, key: "bad", session: StubProtocol.session()), name: nil)
        for _ in 0..<50 { if case .failed = agents.connection { break }; try? await Task.sleep(for: .milliseconds(20)) }
        try? await Task.sleep(for: .milliseconds(150))
        guard case .failed(let message) = agents.connection else { return XCTFail("\(agents.connection)") }
        XCTAssertTrue(message.contains("key"))
        XCTAssertEqual(attempts, 1, "retrying a wrong key would only get this iPhone locked out")
        agents.configure(client: nil, name: nil)
    }
}

final class PairingAndFaceTests: XCTestCase {
    func testPairingLinks() {
        let link = PairingLink.parse("eaon://pair?v=1&host=192.168.1.20&port=3266&key=eaonr-abc_DEF&name=Alex%27s%20MacBook%20Pro")
        XCTAssertEqual(link, PairingLink(host: "192.168.1.20", port: 3266, key: "eaonr-abc_DEF", name: "Alex's MacBook Pro"))
        XCTAssertEqual(link?.address, "192.168.1.20:3266")
        XCTAssertEqual(link?.displayName, "Alex's MacBook Pro")
        XCTAssertEqual(PairingLink.parse("  eaon://pair?host=my-mac.local&key=k  ")?.port, 3266, "the port defaults")
        XCTAssertEqual(PairingLink.parse("eaon://pair?host=h&key=k")?.displayName, "h")
        XCTAssertNil(PairingLink.parse("eaon://pair?host=h"), "no key")
        XCTAssertNil(PairingLink.parse("eaon://pair?key=k"), "no host")
        XCTAssertNil(PairingLink.parse("eaon://pair?host=a%20b&key=k"))
        XCTAssertNil(PairingLink.parse("eaon://pair?host=h&key=k&port=99999"))
        XCTAssertNil(PairingLink.parse("https://eaon.dev/pair?host=h&key=k"), "only our own scheme")
        XCTAssertNil(PairingLink.parse("eaon://other?host=h&key=k"))
        XCTAssertNil(PairingLink.parse("hello"))
    }

    func testFaceMotionIsDeterministicAndStaysInRange() {
        var blinked = false
        for step in 0..<4_000 {
            let time = Double(step) * 0.05
            let pose = FaceMotion.pose(at: time, seed: 42)
            XCTAssertEqual(pose, FaceMotion.pose(at: time, seed: 42), "the same time gives the same face")
            XCTAssertTrue((0.05...1.0).contains(pose.openness))
            XCTAssertTrue((-2.6...2.6).contains(pose.gazeX) && (-1.5...1.5).contains(pose.gazeY))
            if pose.openness < 0.5 { blinked = true }
        }
        XCTAssertTrue(blinked, "it blinks")
    }

    func testFacesDontBlinkInStep() {
        var together = 0
        var blinks = 0
        for step in 0..<4_000 {
            let time = Double(step) * 0.05
            let a = FaceMotion.openness(at: time, seed: AgentFace.seed(for: "a"))
            let b = FaceMotion.openness(at: time, seed: AgentFace.seed(for: "b"))
            if a < 0.5 { blinks += 1; if b < 0.5 { together += 1 } }
        }
        XCTAssertGreaterThan(blinks, 20)
        XCTAssertLessThan(Double(together) / Double(blinks), 0.3)
    }

    func testSeedsAreStableAndColoursAreRead() {
        XCTAssertEqual(AgentFace.seed(for: "agent-1"), AgentFace.seed(for: "agent-1"))
        XCTAssertNotEqual(AgentFace.seed(for: "agent-1"), AgentFace.seed(for: "agent-2"))
        XCTAssertEqual(UInt32(hexString: "#3E86C6"), 0x3E86C6)
        XCTAssertEqual(UInt32(hexString: "3e86c6"), 0x3E86C6)
        XCTAssertNil(UInt32(hexString: "blue"))
        XCTAssertNil(UInt32(hexString: "#12345"))
    }

    func testTemplatesBelongToTheirPlaces() {
        XCTAssertTrue(AgentTemplate.templates(for: .phone).contains { $0.id == "briefing" })
        XCTAssertFalse(AgentTemplate.templates(for: .mac).contains { $0.id == "briefing" })
        XCTAssertTrue(AgentTemplate.templates(for: .mac).contains { $0.id == "coder" })
        XCTAssertFalse(AgentTemplate.templates(for: .phone).contains { $0.id == "coder" }, "a phone agent can't run code")
        for template in AgentTemplate.all {
            XCTAssertNotNil(UInt32(hexString: template.colorHex), template.id)
            XCTAssertLessThanOrEqual(template.role.count, 40)
            XCTAssertLessThanOrEqual(template.purpose.count, 2_000)
        }
    }
}
