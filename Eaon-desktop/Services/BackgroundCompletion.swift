import Foundation

/// One plain extra completion call, routed the same way a real chat message
/// would be — custom/BYOK provider, local Ollama/llama.cpp, or Eaon's own
/// hosted API — but never touching the visible conversation. Extracted out
/// of `MemoryExtractor` (its original and still-only in-chat-UI caller)
/// once `ContextCompressor` needed the exact same "ask the model something,
/// get plain text back, regardless of which backend is active" primitive;
/// duplicating the three-way routing a second time would just be two
/// copies to keep in sync instead of one.
@MainActor
enum BackgroundCompletion {
    static func requestRaw(
        history: [HistoryTurn],
        customConfig: CustomProviderConfig?,
        localRecord: LocalModelRecord?,
        aquaApiKey: String?,
        modelId: String
    ) async -> String? {
        var collected = ""
        // `instant` — this stream is never shown to anyone; running it
        // through the chat UI's deliberate typing-reveal pacing just made
        // every background call take seconds longer for no one.
        let typewriter = TypewriterStreamController(instant: true) { collected = $0 }

        do {
            if let customConfig, let key = CustomProviderStore.shared.apiKey(for: customConfig.id) {
                try await CustomProviderAPIService().streamCompletion(
                    config: customConfig, apiKey: key, modelId: modelId, history: history, typewriter: typewriter
                )
            } else if let localRecord {
                let baseURL = try await LocalAIManager.shared.ensureReady(for: localRecord)
                let ephemeralConfig = CustomProviderConfig(
                    brand: ModelCatalog.brand(for: localRecord.requestModelId),
                    baseURL: baseURL.absoluteString,
                    format: .openAICompatible,
                    modelIDs: [localRecord.requestModelId]
                )
                // Same strict-template flattening the chat path uses — this
                // history is often just [user] or [system, user] (a no-op
                // most of the time), but a template that rejects the shape
                // outright would fail the call silently otherwise.
                try await CustomProviderAPIService().streamCompletion(
                    config: ephemeralConfig, apiKey: "local-no-key", modelId: localRecord.requestModelId,
                    history: history.flattenedForStrictChatTemplates, typewriter: typewriter
                )
            } else if let aquaApiKey {
                try await requestAquaRaw(apiKey: aquaApiKey, modelId: modelId, history: history, typewriter: typewriter)
            } else {
                return nil
            }
        } catch {
            return nil
        }

        await typewriter.waitUntilCaughtUp()
        return collected.isEmpty ? nil : collected
    }

    private static func requestAquaRaw(
        apiKey: String,
        modelId: String,
        history: [HistoryTurn],
        typewriter: TypewriterStreamController
    ) async throws {
        // Trial-aware: a free-week credential routes to Eaon's gateway and
        // signs the exact body bytes; a user key hits the Aqua API as ever.
        var request = URLRequest(url: EaonAccess.baseURL(forKey: apiKey).appendingPathComponent("chat/completions"))
        request.httpMethod = "POST"
        request.timeoutInterval = 30
        request.addValue("application/json", forHTTPHeaderField: "Content-Type")
        let apiMessages = history.map(\.openAICompatibleJSON)
        request.httpBody = try JSONSerialization.data(withJSONObject: [
            "model": modelId, "messages": apiMessages, "stream": true,
        ])
        EaonAccess.authorize(&request, apiKey: apiKey)

        let (bytes, response) = try await AppHTTP.session.bytes(for: request)
        guard let http = response as? HTTPURLResponse, http.statusCode == 200 else {
            throw URLError(.badServerResponse)
        }

        for try await line in bytes.lines {
            guard line.hasPrefix("data: ") else { continue }
            let payload = String(line.dropFirst(6))
            if payload == "[DONE]" { break }
            guard let data = payload.data(using: .utf8),
                  let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
                  let choices = json["choices"] as? [[String: Any]],
                  let delta = choices.first?["delta"] as? [String: Any],
                  let content = delta["content"] as? String else { continue }
            typewriter.append(content)
        }
        typewriter.markStreamFinished()
    }
}
