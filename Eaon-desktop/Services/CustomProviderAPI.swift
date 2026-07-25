import Foundation

/// Executes a chat completion against a user-configured BYOK provider, in
/// whichever wire format that provider actually speaks, feeding text deltas
/// into the same `TypewriterStreamController` the Aqua path already uses.
///
/// Implemented against each provider's public documentation for their
/// standard, current API shape — not live-tested against a real key for any
/// of the three formats (that would require the user's own paid credentials).
/// If a specific provider's response shape has since changed, streaming will
/// surface a clear error rather than silently mis-rendering.
struct CustomProviderAPIService {
    func streamCompletion(
        config: CustomProviderConfig,
        apiKey: String,
        modelId: String,
        history: [HistoryTurn],
        typewriter: TypewriterStreamController,
        nativeTools: NativeToolConfig? = nil,
        /// Extra top-level request fields merged straight into the JSON
        /// body — right now just the composer's Thinking toggle
        /// (`["think": false]`), only ever sent for a local Ollama model
        /// whose own `/api/tags` capabilities confirmed it supports the
        /// field (see `LocalModelRecord.supportsThinkingToggle`). `nil`
        /// (the common case) changes nothing about the request.
        extraFields: [String: Any]? = nil,
        /// The user's global model parameters (Settings → Model Parameters),
        /// translated per-format below. Empty (the default) when the user
        /// hasn't opted any parameter in — sends nothing extra.
        sampling: SamplingParameters = SamplingParameters()
    ) async throws {
        guard let base = URL(string: config.baseURL), !config.baseURL.isEmpty else {
            throw APIClientError.unexpectedResponse("\"\(config.baseURL)\" isn't a valid base URL.")
        }

        switch config.format {
        case .openAICompatible:
            try await streamOpenAICompatible(base: base, apiKey: apiKey, modelId: modelId, history: history, typewriter: typewriter, nativeTools: nativeTools, extraFields: extraFields, sampling: sampling)
        case .anthropicMessages:
            // Native tools deliberately not attached: Anthropic's tool_use
            // wire shape is different, and the fenced-markup channel (still
            // taught in the system prompt) works there — one honest gap,
            // not a silent wrong-format request.
            try await streamAnthropicMessages(base: base, apiKey: apiKey, modelId: modelId, history: history, typewriter: typewriter, sampling: sampling)
        case .googleGemini:
            // Same as Anthropic — Gemini's functionDeclarations shape is
            // its own; markup remains the channel there.
            try await streamGoogleGemini(base: base, apiKey: apiKey, modelId: modelId, history: history, typewriter: typewriter, sampling: sampling)
        }
    }

    // MARK: - OpenAI-compatible

    private func streamOpenAICompatible(
        base: URL,
        apiKey: String,
        modelId: String,
        history: [HistoryTurn],
        typewriter: TypewriterStreamController,
        nativeTools: NativeToolConfig?,
        extraFields: [String: Any]? = nil,
        sampling: SamplingParameters = SamplingParameters()
    ) async throws {
        let apiMessages = history.map(\.openAICompatibleJSON)
        var body: [String: Any] = ["model": modelId, "messages": apiMessages, "stream": true]
        for (key, value) in sampling.openAIFields() { body[key] = value }
        if let nativeTools {
            body["tools"] = nativeTools.tools
        }
        if let extraFields {
            for (key, value) in extraFields { body[key] = value }
        }
        let bodyData = try JSONSerialization.data(withJSONObject: body)

        // A stream that ends without the provider ever saying it finished is
        // re-requested from scratch rather than surfaced as a half-answer —
        // see `StreamContinuity`.
        for attempt in 1...StreamContinuity.maxAttempts {
            var request = URLRequest(url: base.appendingPathComponent("chat/completions"))
            request.httpMethod = "POST"
            // Idle timeout, not total: it bounds time-to-first-token, which a
            // reasoning model (or a cold local model) can legitimately spend
            // longer on than the two minutes this used to allow.
            request.timeoutInterval = 300
            request.addValue("application/json", forHTTPHeaderField: "Content-Type")
            request.httpBody = bodyData
            // After the body on purpose: a free-week trial credential flowing
            // through this path (Quick Assistant routes the hosted models
            // here) signs the exact request bytes under a timestamp the
            // gateway checks for freshness, so each attempt re-signs;
            // ordinary BYOK keys get the same plain bearer header as before.
            EaonAccess.authorize(&request, apiKey: apiKey)

            let bytes: URLSession.AsyncBytes
            let http: HTTPURLResponse
            do {
                (bytes, http) = try await TransientHTTPRetry.send(request)
            } catch let urlError as URLError where StreamContinuity.isDroppedConnection(urlError) && attempt < StreamContinuity.maxAttempts {
                try await Task.sleep(for: StreamContinuity.backoff(beforeAttempt: attempt))
                continue
            }

            if http.statusCode != 200 {
                let message = try await Self.readErrorBody(bytes)
                // Not every OpenAI-compatible endpoint/model supports the
                // tools parameter (Ollama returns 400 for models without tool
                // training, some proxies reject it outright). Chat must still
                // work there — retry once without tools; the fenced-markup
                // channel remains available to the model either way.
                if nativeTools != nil, (400...422).contains(http.statusCode), message.lowercased().contains("tool") {
                    try await streamOpenAICompatible(base: base, apiKey: apiKey, modelId: modelId, history: history, typewriter: typewriter, nativeTools: nil, extraFields: extraFields, sampling: sampling)
                    return
                }
                // A model refusing a sampling parameter (reasoning models
                // often reject `temperature`) shouldn't break chat for
                // someone who moved a slider — retry once without them.
                if !sampling.isEmpty, (400...422).contains(http.statusCode), SamplingParameters.looksLikeRejection(message) {
                    try await streamOpenAICompatible(base: base, apiKey: apiKey, modelId: modelId, history: history, typewriter: typewriter, nativeTools: nativeTools, extraFields: extraFields, sampling: SamplingParameters())
                    return
                }
                throw APIClientError.httpError(status: http.statusCode, message: message)
            }

            var sawContent = false
            var sawTerminalSignal = false
            var toolCalls = ToolCallAccumulator()
            let reasoningBridge = ReasoningDeltaBridge()
            do {
                for try await line in bytes.lines {
                    // `data:` with no space after the colon is equally valid
                    // SSE and some endpoints send it that way; dropping a
                    // fixed 6 characters ate the first character of every
                    // frame's JSON there.
                    guard line.hasPrefix("data:") else { continue }
                    let payload = String(line.dropFirst(5)).trimmingCharacters(in: .whitespaces)
                    if payload == "[DONE]" { sawTerminalSignal = true; break }

                    guard let data = payload.data(using: .utf8),
                          let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
                          let choices = json["choices"] as? [[String: Any]],
                          let choice = choices.first else { continue }

                    // Plenty of OpenAI-compatible servers never emit the
                    // `[DONE]` sentinel but always set `finish_reason` on the
                    // last chunk. Either one proves the model reached the end,
                    // and accepting only the first would mean re-requesting
                    // every reply those servers hand back.
                    if let reason = choice["finish_reason"], !(reason is NSNull) {
                        sawTerminalSignal = true
                    }
                    guard let delta = choice["delta"] as? [String: Any] else { continue }

                    toolCalls.ingest(delta: delta)

                    let reasoning = (delta["reasoning_content"] as? String) ?? (delta["reasoning"] as? String)
                    if let combined = reasoningBridge.text(reasoning: reasoning, content: delta["content"] as? String) {
                        sawContent = true
                        await typewriter.append(combined)
                        await StatisticsTracker.shared.recordGeneratedCharacters(combined.count)
                    }
                }
            } catch let urlError as URLError where StreamContinuity.isDroppedConnection(urlError) && attempt < StreamContinuity.maxAttempts {
                await typewriter.reset()
                try await Task.sleep(for: StreamContinuity.backoff(beforeAttempt: attempt))
                continue
            }

            if let closing = reasoningBridge.closeIfNeeded() {
                sawContent = true
                await typewriter.append(closing)
            }

            // Native calls render as eaon:mcp fences appended to the same
            // message — the one pipeline (chips, confirmation, execution)
            // handles both channels identically from here on.
            if let nativeTools, let fences = toolCalls.fencedBlocks(nameMap: nativeTools.nameMap) {
                sawContent = true
                await typewriter.append(fences)
            }

            if sawTerminalSignal {
                if !sawContent { throw APIClientError.emptyResponse }
                return
            }
            guard attempt < StreamContinuity.maxAttempts else {
                if !sawContent { throw APIClientError.emptyResponse }
                await typewriter.append(streamTruncatedNotice)
                return
            }
            await typewriter.reset()
            try await Task.sleep(for: StreamContinuity.backoff(beforeAttempt: attempt))
        }
    }

    // MARK: - Anthropic Messages API

    private func streamAnthropicMessages(
        base: URL,
        apiKey: String,
        modelId: String,
        history: [HistoryTurn],
        typewriter: TypewriterStreamController,
        sampling: SamplingParameters = SamplingParameters()
    ) async throws {
        // Anthropic has no "system" role inside `messages` — it's a separate
        // top-level field.
        let systemText = history.filter { $0.role == "system" }.map(\.content).joined(separator: "\n\n")
        let turns: [[String: Any]] = history.filter { $0.role != "system" }.map { turn in
            guard !turn.images.isEmpty else { return ["role": turn.role, "content": turn.content] }
            // Anthropic's documented convention: image blocks before the
            // text that refers to them.
            var blocks: [[String: Any]] = turn.images.map {
                ["type": "image", "source": ["type": "base64", "media_type": $0.mimeType, "data": $0.base64]]
            }
            if !turn.content.isEmpty {
                blocks.append(["type": "text", "text": turn.content])
            }
            return ["role": turn.role, "content": blocks]
        }

        var body: [String: Any] = [
            "model": modelId,
            // Anthropic requires max_tokens; honor the user's cap if set,
            // else keep the prior default.
            "max_tokens": sampling.maxTokens ?? 4096,
            "messages": turns,
            "stream": true,
        ]
        for (key, value) in sampling.anthropicFields() { body[key] = value }
        if !systemText.isEmpty { body["system"] = systemText }
        let bodyData = try JSONSerialization.data(withJSONObject: body)

        // Same cut-off-stream retry as the OpenAI path — see `StreamContinuity`.
        for attempt in 1...StreamContinuity.maxAttempts {
            var request = URLRequest(url: base.appendingPathComponent("messages"))
            request.httpMethod = "POST"
            request.timeoutInterval = 300
            request.addValue(apiKey, forHTTPHeaderField: "x-api-key")
            request.addValue("2023-06-01", forHTTPHeaderField: "anthropic-version")
            request.addValue("application/json", forHTTPHeaderField: "Content-Type")
            request.httpBody = bodyData

            let bytes: URLSession.AsyncBytes
            let response: URLResponse
            do {
                (bytes, response) = try await AppHTTP.session.bytes(for: request)
            } catch let urlError as URLError where StreamContinuity.isDroppedConnection(urlError) && attempt < StreamContinuity.maxAttempts {
                try await Task.sleep(for: StreamContinuity.backoff(beforeAttempt: attempt))
                continue
            }
            guard let http = response as? HTTPURLResponse else { throw URLError(.badServerResponse) }
            if http.statusCode != 200 {
                throw APIClientError.httpError(status: http.statusCode, message: try await Self.readErrorBody(bytes))
            }

            var sawContent = false
            var sawTerminalSignal = false
            do {
                for try await line in bytes.lines {
                    guard line.hasPrefix("data:") else { continue }
                    let payload = String(line.dropFirst(5)).trimmingCharacters(in: .whitespaces)
                    guard let data = payload.data(using: .utf8),
                          let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
                          let type = json["type"] as? String else { continue }

                    if type == "content_block_delta",
                       let delta = json["delta"] as? [String: Any],
                       let text = delta["text"] as? String {
                        sawContent = true
                        await typewriter.append(text)
                        await StatisticsTracker.shared.recordGeneratedCharacters(text.count)
                    } else if type == "message_delta",
                              let delta = json["delta"] as? [String: Any],
                              let reason = delta["stop_reason"], !(reason is NSNull) {
                        // `message_delta` carries the stop_reason and always
                        // precedes `message_stop`; accepting it too means a
                        // proxy that closes right after it isn't mistaken for
                        // a cut-off reply.
                        sawTerminalSignal = true
                    } else if type == "message_stop" {
                        sawTerminalSignal = true
                        break
                    }
                }
            } catch let urlError as URLError where StreamContinuity.isDroppedConnection(urlError) && attempt < StreamContinuity.maxAttempts {
                await typewriter.reset()
                try await Task.sleep(for: StreamContinuity.backoff(beforeAttempt: attempt))
                continue
            }

            if sawTerminalSignal {
                if !sawContent { throw APIClientError.emptyResponse }
                return
            }
            guard attempt < StreamContinuity.maxAttempts else {
                if !sawContent { throw APIClientError.emptyResponse }
                await typewriter.append(streamTruncatedNotice)
                return
            }
            await typewriter.reset()
            try await Task.sleep(for: StreamContinuity.backoff(beforeAttempt: attempt))
        }
    }

    // MARK: - Google Gemini API

    private func streamGoogleGemini(
        base: URL,
        apiKey: String,
        modelId: String,
        history: [HistoryTurn],
        typewriter: TypewriterStreamController,
        sampling: SamplingParameters = SamplingParameters()
    ) async throws {
        guard var components = URLComponents(
            url: base.appendingPathComponent("models/\(modelId):streamGenerateContent"),
            resolvingAgainstBaseURL: false
        ) else {
            throw APIClientError.unexpectedResponse("Could not build a Gemini request URL.")
        }
        components.queryItems = [
            URLQueryItem(name: "key", value: apiKey),
            URLQueryItem(name: "alt", value: "sse"),
        ]
        guard let url = components.url else {
            throw APIClientError.unexpectedResponse("Could not build a Gemini request URL.")
        }

        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        // Idle timeout — see the OpenAI path above for why two minutes was
        // too tight for a slow first token.
        request.timeoutInterval = 300
        request.addValue("application/json", forHTTPHeaderField: "Content-Type")

        // Gemini's roles are "user"/"model" (not "assistant"), and it has no
        // system role inside `contents` — fold any system turns into the
        // front of the first user turn instead.
        let systemText = history.filter { $0.role == "system" }.map(\.content).joined(separator: "\n\n")
        var contents: [[String: Any]] = history
            .filter { $0.role != "system" }
            .map { turn in
                var parts: [[String: Any]] = [["text": turn.content]]
                for image in turn.images {
                    parts.append(["inline_data": ["mime_type": image.mimeType, "data": image.base64]])
                }
                return ["role": turn.role == "assistant" ? "model" : "user", "parts": parts]
            }

        if !systemText.isEmpty, !contents.isEmpty,
           var parts = contents[0]["parts"] as? [[String: Any]],
           var firstPart = parts.first,
           let firstText = firstPart["text"] as? String {
            firstPart["text"] = systemText + "\n\n" + firstText
            parts[0] = firstPart
            contents[0]["parts"] = parts
        }

        var geminiBody: [String: Any] = ["contents": contents]
        let generationConfig = sampling.geminiGenerationConfig()
        if !generationConfig.isEmpty { geminiBody["generationConfig"] = generationConfig }
        request.httpBody = try JSONSerialization.data(withJSONObject: geminiBody)

        let (bytes, response) = try await AppHTTP.session.bytes(for: request)
        guard let http = response as? HTTPURLResponse else { throw URLError(.badServerResponse) }
        if http.statusCode != 200 {
            throw APIClientError.httpError(status: http.statusCode, message: try await Self.readErrorBody(bytes))
        }

        var sawContent = false
        for try await line in bytes.lines {
            guard line.hasPrefix("data:") else { continue }
            let payload = String(line.dropFirst(5)).trimmingCharacters(in: .whitespaces)
            guard let data = payload.data(using: .utf8),
                  let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
                  let candidates = json["candidates"] as? [[String: Any]],
                  let content = candidates.first?["content"] as? [String: Any],
                  let parts = content["parts"] as? [[String: Any]],
                  let text = parts.first?["text"] as? String else { continue }

            sawContent = true
            await typewriter.append(text)
            await StatisticsTracker.shared.recordGeneratedCharacters(text.count)
        }
        if !sawContent { throw APIClientError.emptyResponse }
    }

    // MARK: - Model discovery

    /// Calls the provider's own model-listing endpoint so the editor sheet
    /// can auto-fill the "Models" field instead of requiring the user to
    /// know and type exact model IDs by hand. Same per-format auth as
    /// `streamCompletion` above — just a GET instead of a POST — since
    /// that's the one thing each format's real API actually requires.
    /// Manual entry stays available in the UI for whenever this fails (a
    /// self-hosted or proxy endpoint that doesn't implement listing, a
    /// restricted key, a shape that's since changed).
    func fetchAvailableModels(baseURL: String, format: APIRequestFormat, apiKey: String) async throws -> [String] {
        guard let base = URL(string: baseURL), !baseURL.isEmpty else {
            throw APIClientError.unexpectedResponse("\"\(baseURL)\" isn't a valid base URL.")
        }
        switch format {
        case .openAICompatible:
            return try await fetchOpenAICompatibleModels(base: base, apiKey: apiKey)
        case .anthropicMessages:
            return try await fetchAnthropicModels(base: base, apiKey: apiKey)
        case .googleGemini:
            return try await fetchGoogleModels(base: base, apiKey: apiKey)
        }
    }

    private func fetchOpenAICompatibleModels(base: URL, apiKey: String) async throws -> [String] {
        var request = URLRequest(url: base.appendingPathComponent("models"))
        request.addValue("Bearer \(apiKey)", forHTTPHeaderField: "Authorization")
        let data = try await Self.getJSON(request)

        struct Entry: Decodable { let id: String }
        struct ListResponse: Decodable { let data: [Entry] }
        return try JSONDecoder().decode(ListResponse.self, from: data).data.map(\.id)
    }

    private func fetchAnthropicModels(base: URL, apiKey: String) async throws -> [String] {
        var request = URLRequest(url: base.appendingPathComponent("models"))
        request.addValue(apiKey, forHTTPHeaderField: "x-api-key")
        request.addValue("2023-06-01", forHTTPHeaderField: "anthropic-version")
        let data = try await Self.getJSON(request)

        struct Entry: Decodable { let id: String }
        struct ListResponse: Decodable { let data: [Entry] }
        return try JSONDecoder().decode(ListResponse.self, from: data).data.map(\.id)
    }

    private func fetchGoogleModels(base: URL, apiKey: String) async throws -> [String] {
        guard var components = URLComponents(
            url: base.appendingPathComponent("models"),
            resolvingAgainstBaseURL: false
        ) else {
            throw APIClientError.unexpectedResponse("Could not build a Gemini models request URL.")
        }
        components.queryItems = [URLQueryItem(name: "key", value: apiKey)]
        guard let url = components.url else {
            throw APIClientError.unexpectedResponse("Could not build a Gemini models request URL.")
        }
        let data = try await Self.getJSON(URLRequest(url: url))

        // Google lists ids as "models/gemini-..." — strip the prefix so it
        // matches the bare id `streamGoogleGemini` itself expects (it builds
        // "models/<id>:streamGenerateContent" back up from the bare id).
        struct Entry: Decodable { let name: String }
        struct ListResponse: Decodable { let models: [Entry] }
        return try JSONDecoder().decode(ListResponse.self, from: data).models.map {
            $0.name.hasPrefix("models/") ? String($0.name.dropFirst("models/".count)) : $0.name
        }
    }

    private static func getJSON(_ request: URLRequest) async throws -> Data {
        let (data, response) = try await AppHTTP.session.data(for: request)
        guard let http = response as? HTTPURLResponse else { throw URLError(.badServerResponse) }
        guard http.statusCode == 200 else {
            throw APIClientError.httpError(status: http.statusCode, message: Self.readErrorBody(data))
        }
        return data
    }

    private static func readErrorBody(_ data: Data) -> String {
        if let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any] {
            if let detail = json["detail"] as? String { return detail }
            if let message = json["message"] as? String { return message }
            if let error = json["error"] as? [String: Any], let message = error["message"] as? String { return message }
        }
        return String(data: data, encoding: .utf8) ?? "Unknown error"
    }

    // MARK: - Shared

    private static func readErrorBody(_ bytes: URLSession.AsyncBytes) async throws -> String {
        var collected = Data()
        for try await byte in bytes { collected.append(byte) }

        if let json = try? JSONSerialization.jsonObject(with: collected) as? [String: Any] {
            if let detail = json["detail"] as? String { return detail }
            if let message = json["message"] as? String { return message }
            if let error = json["error"] as? [String: Any], let message = error["message"] as? String { return message }
        }
        return String(data: collected, encoding: .utf8) ?? "Unknown error"
    }
}
