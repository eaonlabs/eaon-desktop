import XCTest
@testable import Eaon

final class AgentToolsTests: XCTestCase {
    override func setUp() { StubProtocol.reset() }
    override func tearDown() { StubProtocol.reset() }

    // MARK: JSON

    func testJSONValues() {
        let value = JSONValue.parse(#"{"b": 2, "a": [1, "x", true, null], "n": {"k": "v"}}"#)
        XCTAssertEqual(value?["b"]?.int, 2)
        XCTAssertEqual(value?["a"]?.array?.count, 4)
        XCTAssertEqual(value?["n"]?["k"]?.string, "v")
        XCTAssertEqual(value?.canonical, #"{"a":[1,"x",true,null],"b":2,"n":{"k":"v"}}"#, "sorted and compact")
        XCTAssertEqual(JSONValue.string("12").int, 12)
        XCTAssertEqual(JSONValue.string("yes").bool, true)
        XCTAssertEqual(JSONValue.number(3).string, "3")
        XCTAssertNil(JSONValue.parse("not json"))
        let object: JSONObject = ["title": .string(" Hi "), "days": .number(2), "list": .array([.string("a"), .number(5)])]
        XCTAssertEqual(object.string("title"), "Hi")
        XCTAssertEqual(object.int("days"), 2)
        XCTAssertEqual(object.strings("list"), ["a", "5"])
    }

    // MARK: The tool runner

    @MainActor
    private func runner(access: AgentAccess = .autonomous, calls: inout [String]) -> ToolRunner {
        // Tools recorded by name, so a test can see what actually ran.
        let box = CallBox()
        _ = box
        return ToolRunner(tools: [], access: access)
    }

    private final class CallBox: @unchecked Sendable { var names: [String] = [] }

    @MainActor
    private func tools(_ box: CallBox) -> [AgentTool] {
        func tool(_ name: String, _ risk: ToolRisk) -> AgentTool {
            AgentTool(name: name, description: name, risk: risk, title: { _ in "Did \(name)" }, run: { _ in
                box.names.append(name)
                return "ok \(name)"
            })
        }
        return [tool("look", .read), tool("note", .own), tool("change", .write)]
    }

    @MainActor
    func testAccessLevelsDecideWhatRuns() async {
        let cases: [(AgentAccess, [String: ToolDecision])] = [
            (.autonomous, ["look": .allow, "note": .allow, "change": .allow]),
            (.safe, ["look": .allow, "note": .allow, "change": .askFirst]),
            (.readOnly, ["look": .allow, "note": .allow, "change": .refuse])
        ]
        for (access, expected) in cases {
            let box = CallBox()
            let runner = ToolRunner(tools: tools(box), access: access)
            for tool in runner.tools { XCTAssertEqual(runner.decision(for: tool), expected[tool.name], "\(access) \(tool.name)") }
        }
    }

    @MainActor
    func testStepsAreReportedAsTheyStartAndEnd() async {
        let box = CallBox()
        let runner = ToolRunner(tools: tools(box), access: .autonomous)
        var seen: [AgentStep.Status] = []
        runner.onStep = { seen.append($0.status) }
        let output = await runner.execute(name: "look", arguments: [:], id: "c1")
        XCTAssertEqual(output, "ok look")
        XCTAssertEqual(seen, [.running, .done])
    }

    @MainActor
    func testAnUnknownToolSaysWhatThereIs() async {
        let runner = ToolRunner(tools: tools(CallBox()), access: .autonomous)
        let output = await runner.execute(name: "teleport", arguments: [:])
        XCTAssertTrue(output.contains("no tool called teleport"))
        XCTAssertTrue(output.contains("look, note, change"))
    }

    @MainActor
    func testARepeatedCallIsStopped() async {
        let box = CallBox()
        let runner = ToolRunner(tools: tools(box), access: .autonomous)
        for _ in 0..<ToolRunner.repeatLimit { _ = await runner.execute(name: "look", arguments: ["q": .string("same")]) }
        let output = await runner.execute(name: "look", arguments: ["q": .string("same")])
        XCTAssertTrue(output.contains("same call"))
        XCTAssertEqual(box.names.count, ToolRunner.repeatLimit)
        // A different call is fine.
        let result1 = await runner.execute(name: "look", arguments: ["q": .string("other")])
        XCTAssertEqual(result1, "ok look")
    }

    @MainActor
    func testATurnHasACallBudget() async {
        let box = CallBox()
        let runner = ToolRunner(tools: tools(box), access: .autonomous)
        for index in 0..<ToolRunner.maxCalls { _ = await runner.execute(name: "look", arguments: ["i": .number(Double(index))]) }
        let output = await runner.execute(name: "look", arguments: ["i": .number(999)])
        XCTAssertTrue(output.hasPrefix("Too many tool calls"))
        XCTAssertEqual(box.names.count, ToolRunner.maxCalls)
    }

    @MainActor
    func testFailuresAndLongOutputsAreHandled() async {
        let failing = AgentTool(name: "boom", description: "", risk: .read, title: { _ in "Boom" }, run: { _ in throw ToolRefusal(message: "Nope") })
        let wordy = AgentTool(name: "wordy", description: "", risk: .read, title: { _ in "Wordy" }, run: { _ in String(repeating: "a", count: 10_000) })
        let runner = ToolRunner(tools: [failing, wordy], access: .autonomous)
        var steps: [AgentStep] = []
        runner.onStep = { steps.append($0) }
        let result2 = await runner.execute(name: "boom", arguments: [:])
        XCTAssertEqual(result2, "Failed: Nope")
        XCTAssertEqual(steps.last?.status, .error)
        let long = await runner.execute(name: "wordy", arguments: [:])
        XCTAssertLessThan(long.count, ToolRunner.maxOutput + 100)
        XCTAssertTrue(long.contains("[cut:"))
        XCTAssertEqual(steps.last?.output?.count, 800, "the transcript keeps a short version")
    }

    // MARK: The tool definitions

    @MainActor
    func testEveryToolHasANameADescriptionAndASchemaTheModelCanRead() throws {
        let h = AgentHarness()
        let agents = h.agents
        let tools = PhoneTools.make(agentID: "x", agents: agents)
        XCTAssertEqual(Set(tools.map(\.name)).count, tools.count, "names are unique")
        for tool in tools {
            XCTAssertFalse(tool.description.isEmpty, tool.name)
            XCTAssertTrue(tool.name.allSatisfy { $0.isLetter || $0 == "_" }, "\(tool.name) is a plain identifier")
            let definition = tool.openAIDefinition
            let function = try XCTUnwrap(definition["function"] as? [String: Any])
            XCTAssertEqual(function["name"] as? String, tool.name)
            let parameters = try XCTUnwrap(function["parameters"] as? [String: Any])
            let required = parameters["required"] as? [String] ?? []
            let properties = parameters["properties"] as? [String: Any] ?? [:]
            XCTAssertTrue(Set(required).isSubset(of: Set(properties.keys)), tool.name)
            XCTAssertNoThrow(try JSONSerialization.data(withJSONObject: definition))
        }
        // The small on-device model gets only the core tools.
        let core = tools.filter(\.core).map(\.name)
        XCTAssertTrue(core.contains("web_fetch") && core.contains("update_notes"))
        XCTAssertFalse(core.contains("set_status"))
        XCTAssertLessThanOrEqual(core.count, 12)
    }

    @MainActor
    func testWebFetchGoesThroughTheServiceAndRefusesBadAddresses() async throws {
        let h = AgentHarness(web: FakeWeb(reply: { url in
            if url.host == "boom.test" { throw ToolRefusal(message: "Down") }
            return "Text of \(url.absoluteString)"
        }))
        let agent = try await h.make()
        let runner = ToolRunner(tools: h.agents.tools(for: agent.key.id), access: .readOnly)
        let result3 = await runner.execute(name: "web_fetch", arguments: ["url": .string("https://example.com/a")])
        XCTAssertEqual(result3, "Text of https://example.com/a")
        let result4 = await runner.execute(name: "web_fetch", arguments: ["url": .string("")])
        XCTAssertTrue(result4.contains("full web address"))
        let result5 = await runner.execute(name: "web_fetch", arguments: ["url": .string("https://boom.test")])
        XCTAssertTrue(result5.contains("Down"))
    }

    @MainActor
    func testCalendarToolsFormatWhatTheyFind() async throws {
        let h = AgentHarness()
        h.calendar.events = [
            CalendarItem(title: "Standup", start: TestClock.date(2026, 10, 5, 9, 30), end: TestClock.date(2026, 10, 5, 10, 0), allDay: false, location: "Room 4"),
            CalendarItem(title: "Birthday", start: TestClock.date(2026, 10, 6), end: TestClock.date(2026, 10, 7), allDay: true, location: nil)
        ]
        let agent = try await h.make()
        let runner = ToolRunner(tools: h.agents.tools(for: agent.key.id), access: .readOnly)
        let text = await runner.execute(name: "calendar_events", arguments: ["days": .number(2)])
        XCTAssertTrue(text.contains("Standup") && text.contains("@ Room 4") && text.contains("(all day)"))
        h.calendar.events = []
        let result6 = await runner.execute(name: "calendar_events", arguments: [:])
        XCTAssertEqual(result6, "Nothing on the calendar in that time.")
    }

    @MainActor
    func testEventAndReminderTimesAreReadBeforeAnythingIsAdded() async throws {
        let h = AgentHarness()
        let agent = try await h.make()
        let runner = ToolRunner(tools: h.agents.tools(for: agent.key.id), access: .autonomous)
        let bad = await runner.execute(name: "add_calendar_event", arguments: ["title": .string("Lunch"), "start": .string("lunchtime")])
        XCTAssertTrue(bad.contains("couldn't read the start time"))
        XCTAssertTrue(h.calendar.addedEvents.isEmpty)
        let good = await runner.execute(name: "add_calendar_event", arguments: ["title": .string("Lunch"), "start": .string("2026-10-06T13:00:00"), "minutes": .number(45)])
        XCTAssertTrue(good.contains("Lunch"))
        XCTAssertEqual(h.calendar.addedEvents.first?.minutes, 45)
        XCTAssertEqual(h.calendar.addedEvents.first?.start, TestClock.date(2026, 10, 6, 13, 0))
    }

    func testDatesAModelMightWrite() {
        let now = TestClock.date(2026, 10, 5, 7, 0)
        XCTAssertEqual(AgentDates.parse("2026-10-06T13:00:00", now: now), TestClock.date(2026, 10, 6, 13, 0))
        XCTAssertEqual(AgentDates.parse("2026-10-06 13:00", now: now), TestClock.date(2026, 10, 6, 13, 0))
        XCTAssertEqual(AgentDates.parse("2026-10-06", now: now), TestClock.date(2026, 10, 6))
        XCTAssertEqual(AgentDates.parse("2026-10-06T13:00:00Z", now: now), ISO8601DateFormatter().date(from: "2026-10-06T13:00:00Z"))
        XCTAssertNil(AgentDates.parse("tomorrow", now: now))
    }

    // MARK: The web

    func testWhichAddressesAnAgentMayNotOpen() {
        let blocked = [
            "localhost", "127.0.0.1", "127.1", "0x7f000001", "2130706433", "10.0.0.5", "192.168.1.1", "172.16.0.9", "172.31.255.1",
            "169.254.169.254", "100.101.102.103", "0.0.0.0", "my-mac.local", "router", "nas.lan", "printer.home", "service.internal",
            "[::1]", "::1", "fd00::1", "fe80::1", "::ffff:127.0.0.1", "", "224.0.0.1", "1.2.3"
        ]
        for host in blocked { XCTAssertTrue(NetGuard.isPrivate(host: host), "“\(host)” should be refused") }
        let allowed = ["example.com", "www.swift.org", "8.8.8.8", "172.32.0.1", "100.63.0.1", "93.184.216.34", "api.github.com"]
        for host in allowed { XCTAssertFalse(NetGuard.isPrivate(host: host), "“\(host)” should be allowed") }
    }

    func testARedirectToSomewherePrivateIsRefused() {
        let guardian = RedirectGuard()
        let response = HTTPURLResponse(url: URL(string: "https://example.com")!, statusCode: 302, httpVersion: nil, headerFields: nil)!
        func decide(_ target: String) -> Bool {
            var allowed = false
            guardian.urlSession(URLSession.shared, task: URLSession.shared.dataTask(with: URL(string: "https://example.com")!), willPerformHTTPRedirection: response, newRequest: URLRequest(url: URL(string: target)!)) { allowed = $0 != nil }
            return allowed
        }
        XCTAssertTrue(decide("https://www.example.com/next"))
        XCTAssertFalse(decide("http://192.168.0.1/admin"))
        XCTAssertFalse(decide("http://localhost:8080"))
        XCTAssertFalse(decide("file:///etc/passwd"))
    }

    func testHTMLBecomesReadableText() {
        let page = HTMLText.convert("""
        <html><head><title>Swift &amp; Co</title><style>p{color:red}</style></head>
        <body><script>alert(1)</script><h1>Hello</h1><p>One <b>two</b>&nbsp;three &#8212; &#x1F600;</p>
        <ul><li>First</li><li>Second</li></ul><!-- gone --><p>Last</p></body></html>
        """)
        XCTAssertEqual(page.title, "Swift & Co")
        XCTAssertEqual(page.text, "Hello\nOne two three — 😀\n- First\n- Second\nLast")
    }

    func testFetchingAPageReadsItsText() async throws {
        StubProtocol.handler = { request in
            StubProtocol.respond(request.url!, type: "text/html; charset=utf-8", body: Data("<html><head><title>Hi</title></head><body><p>Hello world</p></body></html>".utf8))
        }
        var fetcher = WebFetcher()
        fetcher.configuration = Self.stubbed()
        let text = try await fetcher.fetch(URL(string: "https://example.com/page")!)
        XCTAssertTrue(text.hasPrefix("https://example.com/page"))
        XCTAssertTrue(text.contains("# Hi\nHello world"))
        XCTAssertTrue(StubProtocol.recorded.first?.value(forHTTPHeaderField: "User-Agent")?.contains("Eaon") == true)
    }

    func testFetchingRefusesPrivateAddressesWithoutTouchingTheNetwork() async {
        var fetcher = WebFetcher()
        fetcher.configuration = Self.stubbed()
        for address in ["http://192.168.1.1/", "http://localhost:3266/remote/v1/workers", "ftp://example.com/", "http://router/"] {
            do {
                _ = try await fetcher.fetch(URL(string: address)!)
                XCTFail("\(address) should be refused")
            } catch {
                XCTAssertNotNil(error as? ToolRefusal, address)
            }
        }
        XCTAssertTrue(StubProtocol.recorded.isEmpty)
    }

    func testFetchingExplainsErrorsAndBinaryContent() async {
        var fetcher = WebFetcher()
        fetcher.configuration = Self.stubbed()
        StubProtocol.handler = { request in StubProtocol.respond(request.url!, status: 404, type: "text/html", body: Data()) }
        do { _ = try await fetcher.fetch(URL(string: "https://example.com/x")!); XCTFail() } catch { XCTAssertEqual((error as? ToolRefusal)?.message, "example.com answered 404.") }
        StubProtocol.handler = { request in StubProtocol.respond(request.url!, type: "image/png", body: Data([1, 2, 3])) }
        do { _ = try await fetcher.fetch(URL(string: "https://example.com/x.png")!); XCTFail() } catch { XCTAssertTrue((error as? ToolRefusal)?.message.contains("image/png") == true) }
        StubProtocol.handler = { _ in throw URLError(.notConnectedToInternet) }
        do { _ = try await fetcher.fetch(URL(string: "https://example.com/x")!); XCTFail() } catch { XCTAssertTrue((error as? ToolRefusal)?.message.contains("Couldn't reach example.com") == true) }
    }

    private static func stubbed() -> URLSessionConfiguration {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [StubProtocol.self]
        return configuration
    }

    // MARK: Streamed tool calls

    func testToolCallsArrivingInPiecesAreAssembled() throws {
        var assembler = ToolCallAssembler()
        let lines = [
            #"data: {"choices":[{"delta":{"role":"assistant","content":"Let me "}}]}"#,
            #"data: {"choices":[{"delta":{"content":"check."}}]}"#,
            #"data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_a","type":"function","function":{"name":"web_fetch","arguments":""}}]}}]}"#,
            #"data: {"choices":[{"delta":{"tool_calls":[{"index":1,"id":"call_b","function":{"name":"update_notes","arguments":"{\"note\":"}}]}}]}"#,
            #"data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"{\"url\":\"https://x.dev\"}"}}]}}]}"#,
            #"data: {"choices":[{"delta":{"tool_calls":[{"index":1,"function":{"arguments":"\"hi\"}"}}]}}]}"#,
            #"data: {"choices":[{"delta":{},"finish_reason":"tool_calls"}]}"#
        ]
        var pieces: [String] = []
        for line in lines {
            if case .text(let piece) = try assembler.feed(line: line) { pieces.append(piece) }
        }
        XCTAssertEqual(try assembler.feed(line: "data: [DONE]"), .done)
        XCTAssertEqual(pieces, ["Let me ", "check."])
        XCTAssertEqual(assembler.text, "Let me check.")
        XCTAssertEqual(assembler.finishReason, "tool_calls")
        XCTAssertEqual(assembler.toolCalls, [
            ToolCall(id: "call_a", name: "web_fetch", arguments: #"{"url":"https://x.dev"}"#),
            ToolCall(id: "call_b", name: "update_notes", arguments: #"{"note":"hi"}"#)
        ])
        XCTAssertEqual(assembler.toolCalls[0].parsedArguments["url"]?.string, "https://x.dev")
    }

    func testACallWithoutArgumentsGetsEmptyOnesAndAnIDIfMissing() throws {
        var assembler = ToolCallAssembler()
        _ = try assembler.feed(line: #"data: {"choices":[{"delta":{"tool_calls":[{"function":{"name":"get_time"}}]}}]}"#)
        XCTAssertEqual(assembler.toolCalls, [ToolCall(id: "call_0", name: "get_time", arguments: "{}")])
        XCTAssertEqual(assembler.toolCalls[0].parsedArguments, [:])
    }

    func testStreamErrorsAreReported() {
        var assembler = ToolCallAssembler()
        XCTAssertThrowsError(try assembler.feed(line: #"data: {"error":{"message":"overloaded"}}"#)) { XCTAssertEqual(($0 as? BackendError), .failed("overloaded")) }
        XCTAssertEqual(try? assembler.feed(line: ": keep-alive"), .nothing)
    }

    // MARK: The OpenAI-style engine

    @MainActor
    func testTheEngineRunsToolsAndShowsTheModelWhatCameBack() async throws {
        var requests = 0
        StubProtocol.handler = { request in
            requests += 1
            if requests == 1 {
                let body = """
                data: {"choices":[{"delta":{"content":"Checking. "}}]}

                data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"c1","function":{"name":"look","arguments":"{\\"q\\":\\"swift\\"}"}}]}}]}

                data: {"choices":[{"delta":{},"finish_reason":"tool_calls"}]}

                data: [DONE]


                """
                return StubProtocol.respond(request.url!, type: "text/event-stream", body: Data(body.utf8))
            }
            return StubProtocol.respond(request.url!, type: "text/event-stream", body: sse(["It says ", "ok."]))
        }
        let box = CallBox()
        let runner = ToolRunner(tools: tools(box), access: .autonomous)
        let engine = OpenAIToolEngine(baseURL: URL(string: "http://mac.local:3266/v1")!, apiKey: "k", model: "m", session: StubProtocol.session())
        var streamed = ""
        try await engine.run(
            system: "You are Scout.",
            history: [EngineMessage(role: .user, text: "hello")],
            tools: runner.tools,
            runner: runner,
            onText: { streamed += $0 }
        )

        XCTAssertEqual(streamed, "Checking. It says ok.")
        XCTAssertEqual(box.names, ["look"])
        let recorded = StubProtocol.recorded
        XCTAssertEqual(recorded.count, 2)
        let first = try XCTUnwrap(JSONSerialization.jsonObject(with: recorded[0].httpBody ?? Data()) as? [String: Any])
        XCTAssertEqual((first["tools"] as? [[String: Any]])?.count, 3)
        XCTAssertEqual(first["stream"] as? Bool, true)
        let second = try XCTUnwrap(JSONSerialization.jsonObject(with: recorded[1].httpBody ?? Data()) as? [String: Any])
        let messages = try XCTUnwrap(second["messages"] as? [[String: Any]])
        XCTAssertEqual(messages.map { $0["role"] as? String }, ["system", "user", "assistant", "tool"])
        XCTAssertEqual(messages[3]["tool_call_id"] as? String, "c1")
        XCTAssertEqual(messages[3]["content"] as? String, "ok look")
        let call = try XCTUnwrap((messages[2]["tool_calls"] as? [[String: Any]])?.first)
        XCTAssertEqual((call["function"] as? [String: Any])?["name"] as? String, "look")
    }

    @MainActor
    func testAModelThatCantUseToolsGetsAClearError() async {
        StubProtocol.handler = { request in StubProtocol.respond(request.url!, status: 400, json: ["error": ["message": "model does not support tools"]]) }
        let runner = ToolRunner(tools: tools(CallBox()), access: .autonomous)
        let engine = OpenAIToolEngine(baseURL: URL(string: "http://mac.local:3266/v1")!, apiKey: nil, model: "m", session: StubProtocol.session())
        do {
            try await engine.run(system: "s", history: [EngineMessage(role: .user, text: "hi")], tools: runner.tools, runner: runner, onText: { _ in })
            XCTFail("expected an error")
        } catch {
            XCTAssertTrue((error as? BackendError)?.errorDescription?.contains("can't use tools") == true, "\(error)")
        }
    }

    @MainActor
    func testAServerThatAnswersAllAtOnceStillWorks() async throws {
        StubProtocol.handler = { request in
            StubProtocol.respond(request.url!, json: ["choices": [["message": ["role": "assistant", "content": "Plain answer.", "tool_calls": NSNull()]]]])
        }
        let runner = ToolRunner(tools: [], access: .autonomous)
        let engine = OpenAIToolEngine(baseURL: URL(string: "http://x.test/v1")!, apiKey: nil, model: "m", session: StubProtocol.session())
        var text = ""
        try await engine.run(system: "s", history: [EngineMessage(role: .user, text: "hi")], tools: [], runner: runner, onText: { text += $0 })
        XCTAssertEqual(text, "Plain answer.")
        let sent = try XCTUnwrap(JSONSerialization.jsonObject(with: StubProtocol.recorded[0].httpBody ?? Data()) as? [String: Any])
        XCTAssertNil(sent["tools"], "no tools, no tools key")
    }
}
