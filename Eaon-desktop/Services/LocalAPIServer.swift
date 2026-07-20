import Foundation
import Network

/// A minimal, hand-rolled HTTP/1.1 request — just enough to route the two
/// endpoints this server actually serves. No external dependency exists in
/// this project (see `Package.swift`) to parse HTTP for us, matching the
/// rest of this app's "hand-roll the protocol" pattern (the MCP JSON-RPC
/// client, the OAuth client).
private struct ParsedHTTPRequest {
    let method: String
    let path: String
    let headers: [String: String]
    let body: Data
}

private enum HTTPRequestParser {
    /// Returns nil until a complete request (headers *and* however much
    /// body `Content-Length` declares) has arrived — the caller keeps
    /// accumulating bytes and retrying.
    static func parse(_ buffer: Data) -> ParsedHTTPRequest? {
        guard let headerEndRange = buffer.range(of: Data("\r\n\r\n".utf8)) else { return nil }
        guard let headerText = String(data: buffer[..<headerEndRange.lowerBound], encoding: .utf8) else { return nil }

        let lines = headerText.components(separatedBy: "\r\n")
        guard let requestLine = lines.first else { return nil }
        let requestParts = requestLine.components(separatedBy: " ")
        guard requestParts.count >= 2 else { return nil }

        var headers: [String: String] = [:]
        for line in lines.dropFirst() {
            guard let colonIndex = line.firstIndex(of: ":") else { continue }
            let key = line[line.startIndex..<colonIndex].trimmingCharacters(in: .whitespaces).lowercased()
            let value = line[line.index(after: colonIndex)...].trimmingCharacters(in: .whitespaces)
            headers[key] = value
        }

        let bodyStart = headerEndRange.upperBound
        let contentLength = Int(headers["content-length"] ?? "") ?? 0
        guard buffer.count - bodyStart >= contentLength else { return nil }

        let body = contentLength > 0 ? buffer[bodyStart..<(bodyStart + contentLength)] : Data()
        return ParsedHTTPRequest(method: requestParts[0], path: requestParts[1], headers: headers, body: Data(body))
    }
}

/// Resolves an incoming request's `model` id to the same (config, apiKey)
/// pair `ChatViewModel.sendMessage` resolves to — BYOK config → local model
/// → Aqua, in that exact order — so a request through the local server is
/// routed identically to typing the same model into the chat UI. Reuses
/// `CustomProviderAPIService.streamCompletion` for all three branches (Aqua
/// included, via a synthesized config) instead of duplicating three
/// separate wire-calling paths.
private enum LocalAPIRouting {
    struct Resolved {
        let config: CustomProviderConfig
        let apiKey: String
        /// The id to actually put in the upstream request body — for a
        /// local model this is `LocalModelRecord.requestModelId`, NOT the
        /// synthetic "ollama:<tag>" id Eaon's own model picker (and this
        /// server's own `/v1/models`) shows; sending that synthetic id
        /// upstream is a real, verified-live 400 ("invalid model name")
        /// from Ollama. For BYOK/Aqua the two ids are the same.
        let upstreamModelId: String
    }

    enum ResolutionError: LocalizedError {
        case noAquaKey
        case noCustomProviderKey(String)

        var errorDescription: String? {
            switch self {
            case .noAquaKey: return "No Eaon API key is saved in Eaon — add one in Settings → Eaon API."
            case .noCustomProviderKey(let name): return "No API key saved for \(name) — add one in Settings → Custom Providers."
            }
        }
    }

    @MainActor
    static func resolve(modelId: String) async throws -> Resolved {
        if let customConfig = CustomProviderStore.shared.config(owning: modelId) {
            guard let key = CustomProviderStore.shared.apiKey(for: customConfig.id), !key.isEmpty else {
                throw ResolutionError.noCustomProviderKey(customConfig.displayName)
            }
            return Resolved(config: customConfig, apiKey: key, upstreamModelId: modelId)
        }

        if let localRecord = LocalAIManager.shared.record(withId: modelId) {
            let baseURL = try await LocalAIManager.shared.ensureReady(for: localRecord)
            let ephemeralConfig = CustomProviderConfig(
                brand: ModelCatalog.brand(for: localRecord.requestModelId),
                baseURL: baseURL.absoluteString,
                format: .openAICompatible,
                modelIDs: [localRecord.requestModelId]
            )
            return Resolved(config: ephemeralConfig, apiKey: "local-no-key", upstreamModelId: localRecord.requestModelId)
        }

        guard let aquaKey = APIKeyStore.loadAPIKey(), !aquaKey.isEmpty else {
            throw ResolutionError.noAquaKey
        }
        let aquaConfig = CustomProviderConfig(
            brand: .aqua,
            baseURL: EaonHostedAPI.baseURL.absoluteString,
            format: .openAICompatible,
            modelIDs: [modelId]
        )
        return Resolved(config: aquaConfig, apiKey: aquaKey, upstreamModelId: modelId)
    }
}

/// Eaon's own local, OpenAI-compatible API server — `POST
/// /v1/chat/completions` and `GET /v1/models`, bound to the loopback
/// interface only (`NWParameters.requiredInterfaceType = .loopback`, a
/// kernel-level guarantee — loopback traffic never reaches the network
/// interface, so this is unreachable from any other device regardless of
/// firewall state). Lets any OpenAI-client-compatible tool — a script, a
/// coding CLI, another chat app — point at Eaon and use whichever backend
/// (Aqua, a BYOK key, or a local Ollama/llama.cpp/MLX model) is actually
/// configured here, the same way LM Studio's and Jan.ai's own "Local
/// Server" features work.
///
/// Deliberately a plain relay: unlike the in-app chat, it injects none of
/// Eaon's own custom instructions, memory, or tool-calling system prompts
/// into the conversation — the external caller owns its own system prompt
/// and history entirely. One request per connection (`Connection: close`)
/// rather than persistent keep-alive — real HTTP/1.1 pipelining support
/// would be meaningfully more code for a server whose real workload is
/// occasional local calls, not high-throughput traffic.
@MainActor
@Observable
final class LocalAPIServer {
    static let shared = LocalAPIServer()

    private(set) var isRunning = false
    private(set) var lastError: String?
    /// Most-recent-first, capped — just enough for the settings page to
    /// show "yes, it's actually receiving requests" without growing
    /// unbounded across a long-running server.
    private(set) var recentRequests: [String] = []

    private var listener: NWListener?

    private init() {}

    /// Called by `LocalAPIServerStore` on every relevant settings change,
    /// and once at app launch — always fully stops any existing listener
    /// first, so toggling the port or re-enabling never leaves a stale one
    /// bound in the background.
    func applySettings() {
        stop()
        guard LocalAPIServerStore.shared.isEnabled else { return }
        start(port: LocalAPIServerStore.shared.port)
    }

    private func start(port: Int) {
        guard let nwPort = NWEndpoint.Port(rawValue: UInt16(clamping: port)) else {
            lastError = "\(port) isn't a valid port number."
            return
        }
        let parameters = NWParameters.tcp
        parameters.requiredInterfaceType = .loopback
        parameters.allowLocalEndpointReuse = true

        guard let listener = try? NWListener(using: parameters, on: nwPort) else {
            lastError = "Could not start a server on port \(port) — it may already be in use."
            return
        }

        listener.newConnectionHandler = { [weak self] connection in
            Task { @MainActor in
                self?.accept(connection)
            }
        }
        listener.stateUpdateHandler = { [weak self] state in
            Task { @MainActor in
                guard let self else { return }
                switch state {
                case .ready:
                    self.isRunning = true
                    self.lastError = nil
                case .failed(let error):
                    self.isRunning = false
                    self.lastError = error.localizedDescription
                case .cancelled:
                    self.isRunning = false
                default:
                    break
                }
            }
        }
        listener.start(queue: .main)
        self.listener = listener
    }

    func stop() {
        listener?.cancel()
        listener = nil
        isRunning = false
    }

    private func logRequest(_ summary: String) {
        recentRequests.insert(summary, at: 0)
        if recentRequests.count > 20 { recentRequests.removeLast() }
    }

    // MARK: - Connection handling

    private func accept(_ connection: NWConnection) {
        connection.stateUpdateHandler = { state in
            if case .failed = state { connection.cancel() }
        }
        connection.start(queue: .main)
        receiveRequest(on: connection, buffer: Data())
    }

    private func receiveRequest(on connection: NWConnection, buffer: Data) {
        connection.receive(minimumIncompleteLength: 1, maximumLength: 1 << 20) { [weak self] data, _, isComplete, error in
            guard let self else { return }
            var buffer = buffer
            if let data, !data.isEmpty { buffer.append(data) }

            if let request = HTTPRequestParser.parse(buffer) {
                Task { @MainActor in
                    await self.route(request, on: connection)
                }
                return
            }

            if isComplete || error != nil {
                connection.cancel()
                return
            }
            Task { @MainActor in
                self.receiveRequest(on: connection, buffer: buffer)
            }
        }
    }

    // MARK: - Routing

    private func route(_ request: ParsedHTTPRequest, on connection: NWConnection) async {
        let path = request.path.components(separatedBy: "?").first ?? request.path
        logRequest("\(request.method) \(path)")

        // --- Anti-DNS-rebinding: the listener binds loopback only, but a
        // malicious web page can still reach 127.0.0.1 from the user's
        // browser and — via DNS rebinding — satisfy the Same-Origin Policy
        // to READ the response, draining the API keys this server can
        // proxy. Two checks kill that whole class of attack:
        //   1. Host must be loopback. A rebinding attack arrives with the
        //      attacker's own hostname in Host (e.g. evil.com), not
        //      127.0.0.1/localhost — reject anything else.
        //   2. Reject any browser Origin. Real CLIs/scripts (curl, python,
        //      node) never send an Origin header; only browsers do, so a
        //      cross-site fetch is refused outright regardless of CORS.
        guard hostIsLoopback(request.headers["host"]) else {
            writeErrorResponse(connection, status: "403 Forbidden", message: "Invalid Host header — this server only accepts loopback requests.")
            return
        }
        if let origin = request.headers["origin"], !origin.isEmpty, !originIsLoopback(origin) {
            writeErrorResponse(connection, status: "403 Forbidden", message: "Cross-origin requests are not allowed. Call this server from a script or CLI, not a web page.")
            return
        }

        if request.method == "OPTIONS" {
            writeEmptyResponse(connection, status: "204 No Content")
            return
        }

        // Reachable even with an API key configured, same as any service's
        // unauthenticated health check — a tool probing whether something
        // is listening on this port before it has (or needs) a key
        // shouldn't have to authenticate just to find out.
        if request.method == "GET", path == "/" {
            handleRoot(on: connection)
            return
        }

        if LocalAPIServerStore.shared.requireAPIKey {
            let expected = "Bearer \(LocalAPIServerStore.shared.apiKey)"
            let provided = request.headers["authorization"] ?? ""
            guard Self.constantTimeEquals(provided, expected) else {
                writeErrorResponse(connection, status: "401 Unauthorized", message: "Missing or incorrect Authorization header.")
                return
            }
        }

        switch (request.method, path) {
        case ("GET", "/v1/models"):
            await handleModelsList(on: connection)
        case ("POST", "/v1/chat/completions"):
            await handleChatCompletions(request, on: connection)
        default:
            writeErrorResponse(connection, status: "404 Not Found", message: "No such endpoint: \(request.method) \(path). Eaon's local server serves GET /v1/models and POST /v1/chat/completions.")
        }
    }

    // MARK: - GET / (discovery/health-check)

    /// What a script or a tool's "test connection" button sees before it
    /// commits to using this server — enough to confirm "this is Eaon, and
    /// here's what it speaks" without requiring the caller to already know
    /// the two real routes.
    private func handleRoot(on connection: NWConnection) {
        writeJSONResponse(connection, status: "200 OK", json: [
            "name": "Eaon Local API Server",
            "openai_compatible": true,
            "endpoints": ["GET /v1/models", "POST /v1/chat/completions"],
        ])
    }

    // MARK: - GET /v1/models

    private func handleModelsList(on connection: NWConnection) async {
        let aquaModels = (try? await EaonHostedAPIService().fetchModels()) ?? []
        let candidates = aquaModels.filter(\.isChatModel) + CustomProviderStore.shared.syntheticModels + LocalAIManager.shared.syntheticModels

        var seen = Set<String>()
        var data: [[String: Any]] = []
        for model in candidates {
            guard !seen.contains(model.id) else { continue }
            guard !ModelPreferencesStore.shared.isHidden(model.id) else { continue }
            if LocalAIManager.shared.record(withId: model.id) == nil {
                let key: ModelProviderKey = CustomProviderStore.shared.config(owning: model.id).map { .custom($0.id) } ?? .aqua
                guard !ModelPreferencesStore.shared.isProviderDisabled(key) else { continue }
            }
            seen.insert(model.id)
            data.append(["id": model.id, "object": "model", "created": 0, "owned_by": "eaon"])
        }

        writeJSONResponse(connection, status: "200 OK", json: ["object": "list", "data": data])
    }

    // MARK: - POST /v1/chat/completions

    private func handleChatCompletions(_ request: ParsedHTTPRequest, on connection: NWConnection) async {
        guard let bodyJSON = try? JSONSerialization.jsonObject(with: request.body) as? [String: Any],
              let modelId = bodyJSON["model"] as? String, !modelId.isEmpty,
              let messagesJSON = bodyJSON["messages"] as? [[String: Any]] else {
            writeErrorResponse(connection, status: "400 Bad Request", message: "Request body must be JSON with \"model\" (string) and \"messages\" (array) fields.")
            return
        }

        let history = Self.history(from: messagesJSON)
        guard !history.isEmpty else {
            writeErrorResponse(connection, status: "400 Bad Request", message: "\"messages\" must contain at least one message with a role and content.")
            return
        }

        let resolved: LocalAPIRouting.Resolved
        do {
            resolved = try await LocalAPIRouting.resolve(modelId: modelId)
        } catch {
            writeErrorResponse(connection, status: "400 Bad Request", message: error.localizedDescription)
            return
        }

        let wantsStream = (bodyJSON["stream"] as? Bool) ?? false
        if wantsStream {
            await streamChatCompletion(config: resolved.config, apiKey: resolved.apiKey, upstreamModelId: resolved.upstreamModelId, displayModelId: modelId, history: history, on: connection)
        } else {
            await bufferedChatCompletion(config: resolved.config, apiKey: resolved.apiKey, upstreamModelId: resolved.upstreamModelId, displayModelId: modelId, history: history, on: connection)
        }
    }

    /// Plain string content or OpenAI's vision-style content-parts array —
    /// only the text parts are kept; ingesting an external caller's own
    /// inline images isn't supported in this first pass.
    private static func history(from messagesJSON: [[String: Any]]) -> [HistoryTurn] {
        messagesJSON.compactMap { message -> HistoryTurn? in
            guard let role = message["role"] as? String else { return nil }
            if let content = message["content"] as? String {
                return HistoryTurn(role: role, content: content)
            }
            if let parts = message["content"] as? [[String: Any]] {
                let text = parts.compactMap { $0["text"] as? String }.joined(separator: "\n")
                return HistoryTurn(role: role, content: text)
            }
            return nil
        }
    }

    private func bufferedChatCompletion(
        config: CustomProviderConfig,
        apiKey: String,
        upstreamModelId: String,
        displayModelId: String,
        history: [HistoryTurn],
        on connection: NWConnection
    ) async {
        var finalText = ""
        let typewriter = TypewriterStreamController(instant: true) { finalText = $0 }
        do {
            try await CustomProviderAPIService().streamCompletion(config: config, apiKey: apiKey, modelId: upstreamModelId, history: history, typewriter: typewriter, nativeTools: nil)
        } catch {
            writeErrorResponse(connection, status: "502 Bad Gateway", message: error.localizedDescription)
            return
        }

        let estimatedTokens = max(1, Int(ceil(Double(finalText.count) / 4.0)))
        writeJSONResponse(connection, status: "200 OK", json: [
            "id": "chatcmpl-\(UUID().uuidString)",
            "object": "chat.completion",
            "created": Int(Date().timeIntervalSince1970),
            "model": displayModelId,
            "choices": [[
                "index": 0,
                "message": ["role": "assistant", "content": finalText],
                "finish_reason": "stop",
            ]],
            "usage": [
                "prompt_tokens": 0,
                "completion_tokens": estimatedTokens,
                "total_tokens": estimatedTokens,
            ],
        ])
    }

    private func streamChatCompletion(
        config: CustomProviderConfig,
        apiKey: String,
        upstreamModelId: String,
        displayModelId: String,
        history: [HistoryTurn],
        on connection: NWConnection
    ) async {
        beginChunkedResponse(connection, contentType: "text/event-stream")

        let responseId = "chatcmpl-\(UUID().uuidString)"
        let created = Int(Date().timeIntervalSince1970)

        // `TypewriterStreamController`'s callback always hands back the
        // *cumulative* displayed string (the contract the chat UI needs) —
        // an SSE client wants incremental deltas instead, so this stream
        // exists purely to turn "cumulative, called synchronously on the
        // main actor" into "ordered deltas, written one at a time,
        // each awaited before the next begins."
        var previousText = ""
        let (deltas, continuation) = AsyncStream<String>.makeStream()
        let typewriter = TypewriterStreamController(instant: true) { cumulative in
            let delta = String(cumulative.dropFirst(previousText.count))
            previousText = cumulative
            guard !delta.isEmpty else { return }
            continuation.yield(delta)
        }

        let writer = Task { @MainActor [weak self] in
            for await delta in deltas {
                guard let self else { break }
                let chunk: [String: Any] = [
                    "id": responseId, "object": "chat.completion.chunk", "created": created, "model": displayModelId,
                    "choices": [["index": 0, "delta": ["content": delta], "finish_reason": NSNull()]],
                ]
                await self.sendSSEEvent(connection, json: chunk)
            }
        }

        var streamError: Error?
        do {
            try await CustomProviderAPIService().streamCompletion(config: config, apiKey: apiKey, modelId: upstreamModelId, history: history, typewriter: typewriter, nativeTools: nil)
        } catch {
            streamError = error
        }
        continuation.finish()
        await writer.value

        if let streamError {
            let errorChunk: [String: Any] = ["error": ["message": streamError.localizedDescription, "type": "upstream_error"]]
            await sendSSEEvent(connection, json: errorChunk)
        } else {
            let doneChunk: [String: Any] = [
                "id": responseId, "object": "chat.completion.chunk", "created": created, "model": displayModelId,
                "choices": [["index": 0, "delta": [String: Any](), "finish_reason": "stop"]],
            ]
            await sendSSEEvent(connection, json: doneChunk)
        }
        await sendChunkedBytes(connection, text: "data: [DONE]\n\n")
        endChunkedResponse(connection)
    }

    // MARK: - Raw HTTP writing

    /// Deliberately NO `Access-Control-Allow-Origin`. This server is for
    /// scripts and CLIs, never web pages — omitting the header means a
    /// browser's Same-Origin Policy blocks any cross-site page from reading
    /// a response, a second layer under the explicit Origin rejection in
    /// `route`. (`X-Content-Type-Options` blocks MIME sniffing.)
    private func corsHeaders() -> String {
        "X-Content-Type-Options: nosniff\r\n"
    }

    /// Only loopback hostnames are allowed — the anti-rebinding gate. Accepts
    /// a missing Host (HTTP/1.0 / raw socket tools) since those aren't
    /// browsers; rejects any real non-loopback hostname.
    private func hostIsLoopback(_ host: String?) -> Bool {
        guard let host, !host.isEmpty else { return true }
        let name = host.components(separatedBy: ":").first?.lowercased() ?? host.lowercased()
        return name == "127.0.0.1" || name == "localhost" || name == "::1" || name == "[::1]"
    }

    /// A loopback Origin (e.g. another local tool that happens to send one)
    /// is fine; any real web origin is not.
    private func originIsLoopback(_ origin: String) -> Bool {
        guard let url = URL(string: origin), let host = url.host?.lowercased() else { return false }
        return host == "127.0.0.1" || host == "localhost" || host == "::1"
    }

    /// Length-independent, byte-for-byte compare so the auth check can't be
    /// narrowed by a timing side channel — belt-and-suspenders on a loopback
    /// server, but this is the security pass.
    private static func constantTimeEquals(_ a: String, _ b: String) -> Bool {
        let x = Array(a.utf8), y = Array(b.utf8)
        var diff = x.count ^ y.count
        for i in 0..<Swift.max(x.count, y.count) {
            let xi = i < x.count ? x[i] : 0
            let yi = i < y.count ? y[i] : 0
            diff |= Int(xi ^ yi)
        }
        return diff == 0
    }

    private func writeJSONResponse(_ connection: NWConnection, status: String, json: [String: Any]) {
        let body = (try? JSONSerialization.data(withJSONObject: json)) ?? Data()
        writeResponse(connection, status: status, contentType: "application/json", body: body)
    }

    private func writeErrorResponse(_ connection: NWConnection, status: String, message: String) {
        writeJSONResponse(connection, status: status, json: ["error": ["message": message, "type": "invalid_request_error"]])
    }

    private func writeEmptyResponse(_ connection: NWConnection, status: String) {
        writeResponse(connection, status: status, contentType: "text/plain", body: Data())
    }

    private func writeResponse(_ connection: NWConnection, status: String, contentType: String, body: Data) {
        var head = "HTTP/1.1 \(status)\r\n"
        head += "Content-Type: \(contentType)\r\n"
        head += "Content-Length: \(body.count)\r\n"
        head += "Connection: close\r\n"
        head += corsHeaders()
        head += "\r\n"
        var responseData = Data(head.utf8)
        responseData.append(body)
        connection.send(content: responseData, completion: .contentProcessed { _ in connection.cancel() })
    }

    private func beginChunkedResponse(_ connection: NWConnection, contentType: String) {
        var head = "HTTP/1.1 200 OK\r\n"
        head += "Content-Type: \(contentType)\r\n"
        head += "Cache-Control: no-cache\r\n"
        head += "Transfer-Encoding: chunked\r\n"
        head += "Connection: close\r\n"
        head += corsHeaders()
        head += "\r\n"
        connection.send(content: Data(head.utf8), completion: .contentProcessed { _ in })
    }

    private func sendSSEEvent(_ connection: NWConnection, json: [String: Any]) async {
        guard let data = try? JSONSerialization.data(withJSONObject: json), let text = String(data: data, encoding: .utf8) else { return }
        await sendChunkedBytes(connection, text: "data: \(text)\n\n")
    }

    /// Wraps `text` in one HTTP chunked-transfer-encoding frame and awaits
    /// its send completing before returning — the caller relies on this to
    /// keep SSE events writing out in order.
    private func sendChunkedBytes(_ connection: NWConnection, text: String) async {
        let payload = Data(text.utf8)
        guard !payload.isEmpty else { return }
        var frame = Data(String(payload.count, radix: 16).utf8)
        frame.append(Data("\r\n".utf8))
        frame.append(payload)
        frame.append(Data("\r\n".utf8))
        await withCheckedContinuation { continuation in
            connection.send(content: frame, completion: .contentProcessed { _ in continuation.resume() })
        }
    }

    private func endChunkedResponse(_ connection: NWConnection) {
        connection.send(content: Data("0\r\n\r\n".utf8), completion: .contentProcessed { _ in connection.cancel() })
    }
}
