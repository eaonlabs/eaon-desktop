import Foundation
#if canImport(FoundationModels)
import FoundationModels
#endif

/// One turn of what an agent has been told, as an engine reads it.
struct EngineMessage: Sendable, Equatable {
    enum Role: String, Sendable { case system, user, assistant }
    var role: Role
    var text: String
}

/// A tool a model asked to use.
struct ToolCall: Sendable, Equatable {
    var id: String
    var name: String
    /// The arguments as the model wrote them: JSON text.
    var arguments: String

    var parsedArguments: JSONObject {
        JSONValue.parse(arguments)?.object ?? [:]
    }
}

/// Something that can run one agent turn: talk to a model, let it use tools,
/// and stream what it says. The two engines are OpenAI-style tool calling,
/// which covers a Mac and every provider, and Apple's model on this iPhone.
protocol AgentEngine: Sendable {
    @MainActor
    func run(
        system: String,
        history: [EngineMessage],
        tools: [AgentTool],
        runner: ToolRunner,
        onText: @escaping @MainActor (String) -> Void
    ) async throws
}

// MARK: - OpenAI-style tool calling

/// Puts together a streamed reply's text and tool calls. OpenAI-style servers
/// send a call in pieces (its name first, then its arguments a few characters
/// at a time), several calls side by side, each with an `index`.
struct ToolCallAssembler: Sendable {
    enum Piece: Equatable {
        case text(String)
        case nothing
        case done
    }

    private struct Partial {
        var id = ""
        var name = ""
        var arguments = ""
    }

    private var partials: [Int: Partial] = [:]
    private(set) var text = ""
    private(set) var finishReason: String?

    mutating func feed(line: String) throws -> Piece {
        guard line.hasPrefix("data:") else { return .nothing }
        let payload = line.dropFirst(5).trimmingCharacters(in: .whitespaces)
        if payload == "[DONE]" { return .done }
        guard let data = payload.data(using: .utf8) else { return .nothing }
        if let message = SSE.errorMessage(in: data) { throw BackendError.failed(message) }
        guard let chunk = try? JSONDecoder().decode(Chunk.self, from: data), let choice = chunk.choices.first else { return .nothing }
        if let reason = choice.finishReason { finishReason = reason }
        for call in choice.delta?.toolCalls ?? [] {
            let index = call.index ?? 0
            var partial = partials[index] ?? Partial()
            if let id = call.id, !id.isEmpty { partial.id = id }
            if let name = call.function?.name, !name.isEmpty { partial.name = name }
            if let arguments = call.function?.arguments { partial.arguments += arguments }
            partials[index] = partial
        }
        if let piece = choice.delta?.content, !piece.isEmpty {
            text += piece
            return .text(piece)
        }
        return .nothing
    }

    var toolCalls: [ToolCall] {
        partials.sorted { $0.key < $1.key }.compactMap { index, partial in
            guard !partial.name.isEmpty else { return nil }
            return ToolCall(id: partial.id.isEmpty ? "call_\(index)" : partial.id, name: partial.name, arguments: partial.arguments.isEmpty ? "{}" : partial.arguments)
        }
    }

    private struct Chunk: Decodable {
        struct Choice: Decodable {
            struct Delta: Decodable {
                struct Call: Decodable {
                    struct Function: Decodable {
                        var name: String?
                        var arguments: String?
                    }
                    var index: Int?
                    var id: String?
                    var function: Function?
                }
                var content: String?
                var toolCalls: [Call]?
                enum CodingKeys: String, CodingKey {
                    case content
                    case toolCalls = "tool_calls"
                }
            }
            var delta: Delta?
            var finishReason: String?
            enum CodingKeys: String, CodingKey {
                case delta
                case finishReason = "finish_reason"
            }
        }
        var choices: [Choice]
    }
}

/// Runs a turn against any OpenAI-compatible server by letting the model call
/// tools in a loop: ask, run what it asked for, show it the results, ask again,
/// until it answers in words.
struct OpenAIToolEngine: AgentEngine {
    var baseURL: URL
    var apiKey: String?
    var model: String
    var session: URLSession = .shared

    @MainActor
    func run(
        system: String,
        history: [EngineMessage],
        tools: [AgentTool],
        runner: ToolRunner,
        onText: @escaping @MainActor (String) -> Void
    ) async throws {
        var messages: [[String: Any]] = [["role": "system", "content": system]]
        for message in history { messages.append(["role": message.role.rawValue, "content": message.text]) }
        let definitions = tools.map(\.openAIDefinition)

        for _ in 0...ToolRunner.maxCalls {
            let reply = try await stream(messages: messages, tools: definitions, onText: onText)
            guard !reply.calls.isEmpty else { return }

            messages.append([
                "role": "assistant",
                "content": reply.text,
                "tool_calls": reply.calls.map { call in
                    ["id": call.id, "type": "function", "function": ["name": call.name, "arguments": call.arguments]] as [String: Any]
                }
            ])
            for call in reply.calls {
                try Task.checkCancellation()
                let output = await runner.execute(name: call.name, arguments: call.parsedArguments, id: call.id)
                messages.append(["role": "tool", "tool_call_id": call.id, "content": output])
            }
        }
    }

    @MainActor
    private func stream(
        messages: [[String: Any]],
        tools: [[String: Any]],
        onText: @MainActor (String) -> Void
    ) async throws -> (text: String, calls: [ToolCall]) {
        var request = URLRequest(url: baseURL.appendingPathComponent("chat/completions"))
        request.httpMethod = "POST"
        request.timeoutInterval = 120
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.setValue("text/event-stream, application/json", forHTTPHeaderField: "Accept")
        if let apiKey, !apiKey.isEmpty { request.setValue("Bearer \(apiKey)", forHTTPHeaderField: "Authorization") }
        var body: [String: Any] = ["model": model, "messages": messages, "stream": true]
        if !tools.isEmpty { body["tools"] = tools }
        request.httpBody = try JSONSerialization.data(withJSONObject: body)

        do {
            let (bytes, response) = try await session.bytes(for: request)
            guard let http = response as? HTTPURLResponse else { throw BackendError.failed("The server's answer wasn't HTTP.") }
            guard (200..<300).contains(http.statusCode) else {
                var data = Data()
                for try await byte in bytes {
                    data.append(byte)
                    if data.count > 4096 { break }
                }
                let message = SSE.errorMessage(in: data)
                if http.statusCode == 400, message?.lowercased().contains("tool") == true {
                    throw BackendError.failed("This model can't use tools, which agents need. Pick another model.")
                }
                throw BackendError.http(http.statusCode, message)
            }

            var assembler = ToolCallAssembler()
            let isJSON = (http.value(forHTTPHeaderField: "Content-Type") ?? "").contains("application/json")
            var plain = Data()
            for try await line in bytes.lines {
                try Task.checkCancellation()
                if isJSON {
                    plain.append(Data(line.utf8))
                    continue
                }
                switch try assembler.feed(line: line) {
                case .text(let piece): onText(piece)
                case .done: return (assembler.text, assembler.toolCalls)
                case .nothing: break
                }
            }
            if isJSON, let whole = Self.wholeReply(plain) {
                if !whole.text.isEmpty { onText(whole.text) }
                return whole
            }
            return (assembler.text, assembler.toolCalls)
        } catch {
            throw BackendError.wrap(error, host: baseURL.host())
        }
    }

    /// A server that ignored `stream: true` sends one JSON document.
    private static func wholeReply(_ data: Data) -> (text: String, calls: [ToolCall])? {
        guard !data.isEmpty, let object = JSONValue.parse(String(decoding: data, as: UTF8.self)) else { return nil }
        if let message = SSE.errorMessage(in: data) { _ = message; return nil }
        guard let message = object["choices"]?.array?.first?["message"] else { return nil }
        let calls: [ToolCall] = (message["tool_calls"]?.array ?? []).enumerated().compactMap { index, call in
            guard let name = call["function"]?["name"]?.string else { return nil }
            let arguments = call["function"]?["arguments"]
            let text = arguments?.string ?? arguments?.canonical ?? "{}"
            return ToolCall(id: call["id"]?.string ?? "call_\(index)", name: name, arguments: text)
        }
        return (message["content"]?.string ?? "", calls)
    }
}

// MARK: - Apple's model on this iPhone

#if canImport(FoundationModels)
@available(iOS 26.0, *)
struct DynamicToolArguments: ConvertibleFromGeneratedContent {
    var values: JSONObject

    init(_ content: GeneratedContent) throws {
        values = JSONValue.parse(content.jsonString)?.object ?? [:]
    }
}

/// One of an agent's tools as Apple's model sees it: a name, a description and
/// a schema built from the tool's parameters at run time.
@available(iOS 26.0, *)
struct OnDeviceTool: Tool {
    typealias Arguments = DynamicToolArguments
    typealias Output = String

    let spec: AgentTool
    let runner: ToolRunner
    let parameters: GenerationSchema

    var name: String { spec.name }
    var description: String { spec.description }

    init?(_ spec: AgentTool, runner: ToolRunner) {
        guard let schema = Self.schema(for: spec) else { return nil }
        self.spec = spec
        self.runner = runner
        parameters = schema
    }

    func call(arguments: DynamicToolArguments) async throws -> String {
        await runner.execute(name: spec.name, arguments: arguments.values)
    }

    static func schema(for tool: AgentTool) -> GenerationSchema? {
        let properties = tool.parameters.map { parameter in
            DynamicGenerationSchema.Property(
                name: parameter.name,
                description: parameter.description,
                schema: dynamicSchema(for: parameter),
                isOptional: !parameter.required
            )
        }
        let root = DynamicGenerationSchema(name: "\(tool.name)_arguments", description: tool.description, properties: properties)
        return try? GenerationSchema(root: root, dependencies: [])
    }

    private static func dynamicSchema(for parameter: ToolParameter) -> DynamicGenerationSchema {
        switch parameter.kind {
        case .string: DynamicGenerationSchema(type: String.self)
        case .integer: DynamicGenerationSchema(type: Int.self)
        case .boolean: DynamicGenerationSchema(type: Bool.self)
        case .strings: DynamicGenerationSchema(arrayOf: DynamicGenerationSchema(type: String.self))
        case .choice(let words): DynamicGenerationSchema(name: "\(parameter.name)_choice", anyOf: words)
        }
    }
}

/// Runs a turn on Apple's model on this iPhone. The framework runs the
/// tool loop itself; each call goes through the same `ToolRunner`, so the same
/// access rules apply. Only the core tools are offered, because the model's
/// window is small.
@available(iOS 26.0, *)
struct OnDeviceToolEngine: AgentEngine {
    @MainActor
    func run(
        system: String,
        history: [EngineMessage],
        tools: [AgentTool],
        runner: ToolRunner,
        onText: @escaping @MainActor (String) -> Void
    ) async throws {
        let offered = tools.filter(\.core).compactMap { OnDeviceTool($0, runner: runner) }
        let session = LanguageModelSession(tools: offered, instructions: system)
        let prompt = OnDevice.prompt(from: history.map { BackendMessage(role: $0.role.rawValue, content: $0.text) })
        var sent = ""
        do {
            for try await snapshot in session.streamResponse(to: prompt) {
                let whole = snapshot.content
                if whole.hasPrefix(sent) {
                    let piece = String(whole.dropFirst(sent.count))
                    if !piece.isEmpty { onText(piece) }
                } else {
                    onText(whole)
                }
                sent = whole
            }
        } catch {
            throw OnDeviceBackend.describe(error)
        }
    }
}
#endif
