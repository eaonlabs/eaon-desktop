import Foundation

/// Talks to Eaon Desktop's Remote API (docs/remote-api.md): reads agents, sends commands, follows the live stream.
struct RemoteClient: Sendable {
    static let defaultPort = 3266

    var baseURL: URL
    var key: String
    var session: URLSession = .shared

    /// "192.168.1.20", "192.168.1.20:3266", "my-mac.local" or "http://host:3266/" → the server's base URL.
    /// An address without a port gets Eaon's.
    static func baseURL(from text: String) -> URL? {
        var text = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty, !text.contains(" ") else { return nil }
        if !text.contains("://") { text = "http://" + text }
        guard var components = URLComponents(string: text), let host = components.host, !host.isEmpty,
              components.scheme == "http" || components.scheme == "https" else { return nil }
        if components.port == nil, components.scheme == "http" { components.port = defaultPort }
        components.path = ""
        components.query = nil
        components.fragment = nil
        return components.url
    }

    // MARK: Reading

    func hello() async throws -> RemoteHello {
        try await get("remote/v1/hello")
    }

    func workers() async throws -> [RemoteWorker] {
        struct Reply: Decodable { var workers: [RemoteWorker] }
        return try await (get("remote/v1/workers") as Reply).workers
    }

    func thread(_ id: String, limit: Int = 60) async throws -> (messages: [RemoteMessage], hasMore: Bool) {
        struct Reply: Decodable {
            var messages: [RemoteMessage]
            var hasMore: Bool?
        }
        let reply: Reply = try await get("remote/v1/workers/\(id)/thread", query: [URLQueryItem(name: "limit", value: String(limit))])
        return (reply.messages, reply.hasMore ?? false)
    }

    func models() async throws -> RemoteModels {
        try await get("remote/v1/models")
    }

    // MARK: Commands

    struct DraftBody: Encodable {
        var name: String?
        var color: String?
        var purpose: String?
        var personality: String?
        var access: String?
        var model: Model?

        struct Model: Encodable {
            var providerId: String
            var modelId: String
        }
    }

    func create(_ draft: DraftBody) async throws -> RemoteWorker {
        struct Reply: Decodable { var worker: RemoteWorker }
        return try await (send("POST", "remote/v1/workers", body: draft) as Reply).worker
    }

    func update(_ id: String, _ draft: DraftBody) async throws -> RemoteWorker {
        struct Reply: Decodable { var worker: RemoteWorker }
        return try await (send("PATCH", "remote/v1/workers/\(id)", body: draft) as Reply).worker
    }

    func delete(_ id: String) async throws {
        _ = try await sendRaw("DELETE", "remote/v1/workers/\(id)", body: nil as DraftBody?)
    }

    func sendMessage(_ id: String, text: String, goal: Bool) async throws {
        struct Body: Encodable {
            var text: String
            var goal: Bool?
        }
        _ = try await sendRaw("POST", "remote/v1/workers/\(id)/send", body: Body(text: text, goal: goal ? true : nil))
    }

    func command(_ id: String, _ name: String) async throws {
        _ = try await sendRaw("POST", "remote/v1/workers/\(id)/\(name)", body: nil as DraftBody?)
    }

    func setPaused(_ id: String, paused: Bool) async throws {
        struct Body: Encodable { var paused: Bool }
        _ = try await sendRaw("POST", "remote/v1/workers/\(id)/pause", body: Body(paused: paused))
    }

    func setGoal(_ id: String, status: String?) async throws {
        struct Body: Encodable {
            var status: String?
            func encode(to encoder: Encoder) throws {
                var container = encoder.container(keyedBy: CodingKeys.self)
                try container.encode(status, forKey: .status)   // null clears the goal
            }
            enum CodingKeys: String, CodingKey { case status }
        }
        _ = try await sendRaw("POST", "remote/v1/workers/\(id)/goal", body: Body(status: status))
    }

    func answer(_ id: String, askID: String, text: String?, approved: Bool?) async throws {
        struct Body: Encodable {
            var askId: String
            var text: String?
            var approved: Bool?
        }
        _ = try await sendRaw("POST", "remote/v1/workers/\(id)/answer", body: Body(askId: askID, text: text, approved: approved))
    }

    // MARK: The live stream

    /// Every event the Mac pushes, until the connection drops (the stream then throws or ends).
    func events() -> AsyncThrowingStream<RemoteEvent, Error> {
        AsyncThrowingStream { continuation in
            let task = Task {
                do {
                    var request = try makeRequest("GET", "remote/v1/events", query: [])
                    request.timeoutInterval = 60 * 60 * 24
                    request.setValue("text/event-stream", forHTTPHeaderField: "Accept")
                    let (bytes, response) = try await session.bytes(for: request)
                    try Self.check(response, data: nil)
                    var parser = SSEEventParser()
                    for try await line in bytes.lines {
                        try Task.checkCancellation()
                        guard let (name, data) = parser.feed(line: line), let event = Self.decode(event: name, data: data) else { continue }
                        continuation.yield(event)
                    }
                    continuation.finish()
                } catch {
                    continuation.finish(throwing: Self.wrap(error, host: baseURL.host()))
                }
            }
            continuation.onTermination = { _ in task.cancel() }
        }
    }

    static func decode(event name: String, data: String) -> RemoteEvent? {
        guard let bytes = data.data(using: .utf8) else { return nil }
        let decoder = JSONDecoder()
        switch name {
        case "workers":
            struct Body: Decodable { var workers: [RemoteWorker] }
            return (try? decoder.decode(Body.self, from: bytes)).map { .workers($0.workers) }
        case "message":
            struct Body: Decodable {
                var workerId: String
                var message: RemoteMessage
            }
            return (try? decoder.decode(Body.self, from: bytes)).map { .message(workerID: $0.workerId, $0.message) }
        case "delta":
            struct Body: Decodable {
                var workerId: String
                var messageId: String
                var text: String
            }
            return (try? decoder.decode(Body.self, from: bytes)).map { .delta(workerID: $0.workerId, messageID: $0.messageId, text: $0.text) }
        case "tool":
            struct Body: Decodable {
                var workerId: String
                var messageId: String
                var part: RemotePart
            }
            return (try? decoder.decode(Body.self, from: bytes)).map { .tool(workerID: $0.workerId, messageID: $0.messageId, $0.part) }
        default:
            return nil
        }
    }

    // MARK: Plumbing

    private func makeRequest(_ method: String, _ path: String, query: [URLQueryItem]) throws -> URLRequest {
        var components = URLComponents(url: baseURL.appendingPathComponent(path), resolvingAgainstBaseURL: false)
        if !query.isEmpty { components?.queryItems = query }
        guard let url = components?.url else { throw RemoteError(kind: .other, message: "That address isn't one Eaon can use.") }
        var request = URLRequest(url: url)
        request.httpMethod = method
        request.timeoutInterval = 15
        request.setValue("Bearer \(key)", forHTTPHeaderField: "Authorization")
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        return request
    }

    private func get<T: Decodable>(_ path: String, query: [URLQueryItem] = []) async throws -> T {
        let request = try makeRequest("GET", path, query: query)
        return try await perform(request)
    }

    private func send<T: Decodable, B: Encodable>(_ method: String, _ path: String, body: B?) async throws -> T {
        var request = try makeRequest(method, path, query: [])
        if let body {
            request.httpBody = try JSONEncoder().encode(body)
            request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        }
        return try await perform(request)
    }

    private func sendRaw<B: Encodable>(_ method: String, _ path: String, body: B?) async throws -> Data {
        var request = try makeRequest(method, path, query: [])
        if let body {
            request.httpBody = try JSONEncoder().encode(body)
            request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        } else if method != "GET" {
            request.httpBody = Data("{}".utf8)
            request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        }
        do {
            let (data, response) = try await session.data(for: request)
            try Self.check(response, data: data)
            return data
        } catch {
            throw Self.wrap(error, host: baseURL.host())
        }
    }

    private func perform<T: Decodable>(_ request: URLRequest) async throws -> T {
        do {
            let (data, response) = try await session.data(for: request)
            try Self.check(response, data: data)
            do {
                return try JSONDecoder().decode(T.self, from: data)
            } catch {
                throw RemoteError(kind: .old, message: "That address answered, but not like Eaon Desktop with Remote devices turned on.")
            }
        } catch {
            throw Self.wrap(error, host: baseURL.host())
        }
    }

    /// Turns a status code and the server's `{error: {code, message}}` into a RemoteError.
    private static func check(_ response: URLResponse, data: Data?) throws {
        guard let http = response as? HTTPURLResponse else { throw RemoteError(kind: .other, message: "The Mac's answer wasn't HTTP.") }
        guard !(200..<300).contains(http.statusCode) else { return }
        let message = data.flatMap { try? JSONDecoder().decode(ErrorBody.self, from: $0) }?.error.message
        switch http.statusCode {
        case 401: throw RemoteError(kind: .unauthorized, message: "That key isn't this Mac's. Copy it again from Eaon › Settings › Remote devices.")
        case 403: throw RemoteError(kind: .other, message: message ?? "The Mac refused that.")
        case 404: throw RemoteError(kind: .notFound, message: message ?? "Not found. This Mac may be running an older Eaon.")
        case 429: throw RemoteError(kind: .rateLimited, message: "Too many wrong keys. Wait a minute and try again.")
        default: throw RemoteError(kind: .other, message: message ?? "The Mac answered \(http.statusCode).")
        }
    }

    private struct ErrorBody: Decodable {
        struct Inner: Decodable { var message: String }
        var error: Inner
    }

    static func wrap(_ error: Error, host: String?) -> Error {
        if error is CancellationError || error is RemoteError { return error }
        if let urlError = error as? URLError {
            if urlError.code == .cancelled { return CancellationError() }
            return RemoteError.unreachable(host ?? "the Mac")
        }
        return error
    }
}
