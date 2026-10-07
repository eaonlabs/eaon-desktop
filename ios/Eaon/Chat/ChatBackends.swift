import Foundation
#if canImport(FoundationModels)
import FoundationModels
#endif

/// One turn, as a backend sees it.
struct BackendMessage: Sendable, Equatable {
    var role: String
    var content: String
    /// JPEG pictures sent with it, for models that can see.
    var images: [Data] = []
}

/// Something that can answer a conversation, a piece at a time.
protocol ChatBackend: Sendable {
    func stream(_ messages: [BackendMessage]) -> AsyncThrowingStream<String, Error>
}

enum Assistant {
    /// What every model is told before the conversation.
    static let instructions = """
    You are Eaon, a helpful assistant on the user's iPhone. Answer directly and keep it short unless asked \
    for more. Use Markdown for lists and code. If you don't know, say so.
    """
}

/// What can go wrong talking to a model, in words a person can use.
enum BackendError: LocalizedError, Equatable {
    case http(Int, String?)
    case unreachable(String)
    case badAddress
    case empty
    case unavailable(String)
    case failed(String)

    var errorDescription: String? {
        switch self {
        case .http(401, _), .http(403, _): "The key was refused."
        case .http(404, _): "That model or address wasn't found."
        case .http(429, _): "The provider says you're sending too much. Wait a moment."
        case .http(let code, let message):
            if let message, !message.isEmpty { message } else { "The server answered \(code)." }
        case .unreachable(let host): "Couldn't reach \(host)."
        case .badAddress: "That address isn't one Eaon can use."
        case .empty: "The model sent back nothing."
        case .unavailable(let reason): reason
        case .failed(let message): message
        }
    }

    /// What to try.
    var recovery: String? {
        switch self {
        case .http(401, _), .http(403, _): "Check the key in Settings."
        case .unreachable: "Check that it's running and that this iPhone can reach it."
        default: nil
        }
    }

    static func wrap(_ error: Error, host: String? = nil) -> Error {
        if error is CancellationError || error is BackendError { return error }
        if let urlError = error as? URLError {
            if urlError.code == .cancelled { return CancellationError() }
            return BackendError.unreachable(host ?? "the server")
        }
        return BackendError.failed(error.localizedDescription)
    }
}

// MARK: - OpenAI-compatible

/// Any server that speaks the OpenAI chat API: Eaon on the Mac, OpenAI,
/// OpenRouter, Groq, Ollama, LM Studio.
struct OpenAICompatibleBackend: ChatBackend {
    var baseURL: URL
    var apiKey: String?
    var model: String
    var session: URLSession = .shared

    func stream(_ messages: [BackendMessage]) -> AsyncThrowingStream<String, Error> {
        AsyncThrowingStream { continuation in
            let task = Task {
                do {
                    try await run(messages, into: continuation)
                    continuation.finish()
                } catch {
                    continuation.finish(throwing: BackendError.wrap(error, host: baseURL.host()))
                }
            }
            continuation.onTermination = { _ in task.cancel() }
        }
    }

    private func run(_ messages: [BackendMessage], into continuation: AsyncThrowingStream<String, Error>.Continuation) async throws {
        var request = URLRequest(url: baseURL.appendingPathComponent("chat/completions"))
        request.httpMethod = "POST"
        request.timeoutInterval = 120
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.setValue("text/event-stream, application/json", forHTTPHeaderField: "Accept")
        if let apiKey, !apiKey.isEmpty { request.setValue("Bearer \(apiKey)", forHTTPHeaderField: "Authorization") }
        request.httpBody = try JSONEncoder().encode(
            RequestBody(model: model, messages: messages.map { .init(role: $0.role, content: $0.content, images: $0.images) }, stream: true)
        )

        let (bytes, response) = try await session.bytes(for: request)
        guard let http = response as? HTTPURLResponse else { throw BackendError.failed("The server's answer wasn't HTTP.") }

        guard (200..<300).contains(http.statusCode) else {
            var body = Data()
            for try await byte in bytes {
                body.append(byte)
                if body.count > 4096 { break }
            }
            throw BackendError.http(http.statusCode, SSE.errorMessage(in: body))
        }

        var received = false
        var plain = Data()
        let isJSON = (http.value(forHTTPHeaderField: "Content-Type") ?? "").contains("application/json")

        for try await line in bytes.lines {
            try Task.checkCancellation()
            if isJSON {
                plain.append(Data(line.utf8))
                continue
            }
            switch try SSE.parse(line: line) {
            case .text(let text):
                received = true
                continuation.yield(text)
            case .done:
                if !received { throw BackendError.empty }
                return
            case .ignore:
                break
            }
        }

        if isJSON, !plain.isEmpty {
            // A server that ignored `stream: true` sends one JSON document.
            if let message = SSE.errorMessage(in: plain) { throw BackendError.failed(message) }
            if let text = SSE.wholeReply(in: plain), !text.isEmpty {
                continuation.yield(text)
                return
            }
        }
        if !received { throw BackendError.empty }
    }

    private struct RequestBody: Encodable {
        /// Plain text, or (with pictures) the OpenAI list of text and `image_url` parts.
        struct Message: Encodable {
            var role: String
            var content: String
            var images: [Data] = []

            enum Keys: String, CodingKey { case role, content }
            private struct TextPart: Encodable {
                var type = "text"
                var text: String
            }
            private struct ImagePart: Encodable {
                struct Link: Encodable { var url: String }
                var type = "image_url"
                var imageURL: Link
                enum CodingKeys: String, CodingKey {
                    case type
                    case imageURL = "image_url"
                }
            }

            func encode(to encoder: Encoder) throws {
                var container = encoder.container(keyedBy: Keys.self)
                try container.encode(role, forKey: .role)
                guard !images.isEmpty else {
                    try container.encode(content, forKey: .content)
                    return
                }
                var parts = container.nestedUnkeyedContainer(forKey: .content)
                if !content.isEmpty { try parts.encode(TextPart(text: content)) }
                for image in images {
                    try parts.encode(ImagePart(imageURL: .init(url: "data:image/jpeg;base64," + image.base64EncodedString())))
                }
            }
        }
        var model: String
        var messages: [Message]
        var stream: Bool
    }
}

/// Server-sent events, as OpenAI-style APIs send them.
enum SSE {
    enum Event: Equatable {
        case text(String)
        case done
        case ignore
    }

    static func parse(line: String) throws -> Event {
        guard line.hasPrefix("data:") else { return .ignore }
        let payload = line.dropFirst(5).trimmingCharacters(in: .whitespaces)
        if payload == "[DONE]" { return .done }
        guard let data = payload.data(using: .utf8) else { return .ignore }
        if let message = errorMessage(in: data) { throw BackendError.failed(message) }
        guard let chunk = try? JSONDecoder().decode(Chunk.self, from: data) else { return .ignore }
        if let text = chunk.choices.first?.delta?.content, !text.isEmpty { return .text(text) }
        return .ignore
    }

    /// `{"error": {"message": "…"}}` or `{"error": "…"}`.
    static func errorMessage(in data: Data) -> String? {
        guard let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else { return nil }
        if let error = object["error"] as? [String: Any] { return error["message"] as? String ?? "The server reported an error." }
        if let error = object["error"] as? String { return error }
        return nil
    }

    static func wholeReply(in data: Data) -> String? {
        try? JSONDecoder().decode(Whole.self, from: data).choices.first?.message?.content
    }

    private struct Chunk: Decodable {
        struct Choice: Decodable {
            struct Delta: Decodable { var content: String? }
            var delta: Delta?
        }
        var choices: [Choice]
    }

    private struct Whole: Decodable {
        struct Choice: Decodable {
            struct Message: Decodable { var content: String? }
            var message: Message?
        }
        var choices: [Choice]
    }
}

// MARK: - Models list

/// What `GET /v1/models` says, for the Mac and for providers.
enum ModelsClient {
    /// Turns what a person types ("192.168.1.20:1337", "my-mac.local") into
    /// an API base URL ending in `/v1`.
    static func baseURL(from text: String) -> URL? {
        var text = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty, !text.contains(" ") else { return nil }
        if !text.contains("://") {
            // A bare address on the local network is plain http; a hostname with
            // a dot and no port is something on the internet.
            let host = text.split(separator: "/").first.map(String.init) ?? text
            let isLocal = host.contains(":") || host.hasSuffix(".local") || host == "localhost"
                || host.split(separator: ".").allSatisfy({ Int($0) != nil })
            text = (isLocal ? "http://" : "https://") + text
        }
        guard var components = URLComponents(string: text), let host = components.host, !host.isEmpty,
              components.scheme == "http" || components.scheme == "https" else { return nil }
        var path = components.path
        while path.hasSuffix("/") { path.removeLast() }
        if !path.hasSuffix("/v1") { path += "/v1" }
        components.path = path
        components.query = nil
        components.fragment = nil
        return components.url
    }

    static func models(at baseURL: URL, apiKey: String?, session: URLSession = .shared) async throws -> [String] {
        var request = URLRequest(url: baseURL.appendingPathComponent("models"))
        request.timeoutInterval = 8
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        if let apiKey, !apiKey.isEmpty { request.setValue("Bearer \(apiKey)", forHTTPHeaderField: "Authorization") }
        do {
            let (data, response) = try await session.data(for: request)
            guard let http = response as? HTTPURLResponse else { throw BackendError.failed("The server's answer wasn't HTTP.") }
            guard (200..<300).contains(http.statusCode) else { throw BackendError.http(http.statusCode, SSE.errorMessage(in: data)) }
            let reply = try? JSONDecoder().decode(Reply.self, from: data)
            guard let reply else { throw BackendError.failed("That address answered, but not like an OpenAI-style server.") }
            return reply.data.map(\.id).sorted()
        } catch {
            throw BackendError.wrap(error, host: baseURL.host())
        }
    }

    private struct Reply: Decodable {
        struct Item: Decodable { var id: String }
        var data: [Item]
    }
}

// MARK: - On this iPhone

enum OnDeviceStatus: Equatable {
    case available
    case unavailable(String)

    var isAvailable: Bool { self == .available }
}

enum OnDevice {
    /// Whether Apple's model can answer, and if not, why, in a sentence.
    static func status() -> OnDeviceStatus {
        #if canImport(FoundationModels)
        if #available(iOS 26.0, *) {
            switch SystemLanguageModel.default.availability {
            case .available:
                return .available
            case .unavailable(.deviceNotEligible):
                return .unavailable("This iPhone doesn't support Apple Intelligence.")
            case .unavailable(.appleIntelligenceNotEnabled):
                return .unavailable("Turn on Apple Intelligence in the Settings app to use it.")
            case .unavailable(.modelNotReady):
                return .unavailable("Apple's model is still downloading. Try again soon.")
            case .unavailable:
                return .unavailable("Apple's model isn't available right now.")
            }
        }
        #endif
        return .unavailable("Needs iOS 26 or later.")
    }

    /// The last few turns folded into one prompt: the model on the phone has a
    /// small window, so it gets the end of the conversation and not the start.
    static func prompt(from messages: [BackendMessage], limit: Int = 6000) -> String {
        let turns = messages.filter { $0.role != "system" }
        guard let last = turns.last else { return "" }
        var history: [String] = []
        var size = last.content.count
        for message in turns.dropLast().reversed() {
            size += message.content.count + 12
            if size > limit { break }
            history.append("\(message.role == "user" ? "User" : "Assistant"): \(message.content)")
        }
        if history.isEmpty { return last.content }
        return "Earlier in this conversation:\n" + history.reversed().joined(separator: "\n") + "\n\nReply to this message from the user:\n" + last.content
    }
}

#if canImport(FoundationModels)
@available(iOS 26.0, *)
struct OnDeviceBackend: ChatBackend {
    func stream(_ messages: [BackendMessage]) -> AsyncThrowingStream<String, Error> {
        AsyncThrowingStream { continuation in
            let task = Task {
                do {
                    let session = LanguageModelSession(instructions: Assistant.instructions)
                    var sent = ""
                    for try await snapshot in session.streamResponse(to: OnDevice.prompt(from: messages)) {
                        let whole = snapshot.content
                        // Each snapshot is the reply so far; the screen wants the new part.
                        if whole.hasPrefix(sent) {
                            let piece = String(whole.dropFirst(sent.count))
                            if !piece.isEmpty { continuation.yield(piece) }
                        } else {
                            continuation.yield(whole)
                        }
                        sent = whole
                    }
                    if sent.isEmpty { throw BackendError.empty }
                    continuation.finish()
                } catch {
                    continuation.finish(throwing: Self.describe(error))
                }
            }
            continuation.onTermination = { _ in task.cancel() }
        }
    }

    static func describe(_ error: Error) -> Error {
        if error is CancellationError || error is BackendError { return error }
        let text = String(describing: error).lowercased()
        if text.contains("guardrail") {
            return BackendError.failed("Apple's model won't answer that one.")
        }
        if text.contains("exceededcontext") || text.contains("context") && text.contains("exceed") {
            return BackendError.failed("This chat has grown too long for the model on this iPhone. Start a new one.")
        }
        if text.contains("unsupportedlanguage") || text.contains("unsupportedlocale") {
            return BackendError.failed("The model on this iPhone doesn't support that language yet.")
        }
        #if DEBUG
        // Not one of the known failures: a Debug build says what the system said. (The Simulator reports Apple's
        // model as available and then fails every request with GenerationError -1; only a real iPhone answers.)
        let detail = (error as NSError).localizedDescription.trimmingCharacters(in: .whitespacesAndNewlines)
        return BackendError.failed("The model on this iPhone couldn't answer." + (detail.isEmpty ? "" : " (\(String(detail.prefix(160))))"))
        #else
        return BackendError.failed("The model on this iPhone couldn't answer.")
        #endif
    }
}
#endif
