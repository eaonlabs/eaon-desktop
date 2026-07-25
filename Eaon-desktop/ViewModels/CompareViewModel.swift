import Foundation
import SwiftUI

// Represents a single model's response in a comparison run.
@MainActor
@Observable
final class CompareSlot {
    let modelId: String
    var content: String = ""
    var isGenerating: Bool = false
    var isError: Bool = false
    var generationStart: Date?
    var generationEnd: Date?
    var generatedTokenCount: Int = 0

    init(modelId: String) {
        self.modelId = modelId
    }

    var tokensPerSecond: Double? {
        guard let start = generationStart, let end = generationEnd,
              generatedTokenCount > 0 else { return nil }
        let dur = end.timeIntervalSince(start)
        guard dur > 0 else { return nil }
        return Double(generatedTokenCount) / dur
    }

    var latencySeconds: Double? {
        guard let start = generationStart, let end = generationEnd else { return nil }
        return end.timeIntervalSince(start)
    }

    func reset() {
        content = ""
        isGenerating = false
        isError = false
        generationStart = nil
        generationEnd = nil
        generatedTokenCount = 0
    }
}

@MainActor
@Observable
final class CompareViewModel {
    var prompt: String = ""
    var systemPrompt: String = ""
    var slots: [CompareSlot] = []
    var isRunning: Bool = false

    var canRun: Bool {
        !prompt.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
            && slots.count >= 2
            && slots.count <= 3
            && !isRunning
    }

    func addSlot(modelId: String) {
        guard slots.count < 3 else { return }
        guard !slots.contains(where: { $0.modelId == modelId }) else { return }
        slots.append(CompareSlot(modelId: modelId))
    }

    func removeSlot(at index: Int) {
        guard slots.indices.contains(index) else { return }
        slots.remove(at: index)
    }

    func setSlotModel(at index: Int, modelId: String) {
        guard slots.indices.contains(index) else { return }
        slots[index] = CompareSlot(modelId: modelId)
    }

    func run(apiKey: String) async {
        let trimmedPrompt = prompt.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmedPrompt.isEmpty, slots.count >= 2 else { return }

        isRunning = true
        for slot in slots { slot.reset() }

        await withTaskGroup(of: Void.self) { group in
            for slot in slots {
                group.addTask { [weak self] in
                    await self?.stream(slot: slot, prompt: trimmedPrompt, apiKey: apiKey)
                }
            }
        }

        isRunning = false
    }

    private func stream(slot: CompareSlot, prompt: String, apiKey: String) async {
        slot.isGenerating = true
        slot.generationStart = Date()

        // Trial-aware routing + body-bound authorization (see EaonAccess).
        var request = URLRequest(url: EaonAccess.baseURL(forKey: apiKey).appendingPathComponent("chat/completions"))
        request.httpMethod = "POST"
        request.timeoutInterval = 120
        request.addValue("application/json", forHTTPHeaderField: "Content-Type")

        var messages: [[String: String]] = []
        if !systemPrompt.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            messages.append(["role": "system", "content": systemPrompt])
        }
        messages.append(["role": "user", "content": prompt])

        var body: [String: Any] = [
            "model": slot.modelId,
            "messages": messages,
            "stream": true,
        ]
        // Same global sampling parameters the main chat uses, so a comparison
        // reflects the settings the user actually chats with.
        for (key, value) in ModelParametersStore.shared.effectiveParameters.openAIFields() {
            body[key] = value
        }

        do {
            request.httpBody = try JSONSerialization.data(withJSONObject: body)
            EaonAccess.authorize(&request, apiKey: apiKey)
            let (bytes, response) = try await AppHTTP.session.bytes(for: request)

            guard let httpResponse = response as? HTTPURLResponse,
                  httpResponse.statusCode == 200 else {
                slot.content = "API error — check your key and model availability."
                slot.isError = true
                slot.isGenerating = false
                slot.generationEnd = Date()
                return
            }

            var accumulated = ""
            var sawDone = false
            for try await line in bytes.lines {
                guard line.hasPrefix("data:") else { continue }
                let payload = String(line.dropFirst(5)).trimmingCharacters(in: .whitespaces)
                if payload == "[DONE]" { sawDone = true; break }
                guard let data = payload.data(using: .utf8),
                      let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
                      let choices = json["choices"] as? [[String: Any]],
                      let choice = choices.first else { continue }
                // `finish_reason` counts as a terminal signal too — see
                // `consumeStream` in ChatViewModel.
                if let reason = choice["finish_reason"], !(reason is NSNull) { sawDone = true }
                guard let delta = choice["delta"] as? [String: Any],
                      let chunk = delta["content"] as? String else { continue }
                accumulated += chunk
                slot.content = accumulated
            }
            // See streamTruncatedNotice's doc comment (ChatViewModel.swift) —
            // the connection ending without [DONE] is not the same as the
            // provider saying it's done.
            if !accumulated.isEmpty, !sawDone {
                accumulated += streamTruncatedNotice
                slot.content = accumulated
            }

            let approxTokens = max(1, Int(ceil(Double(accumulated.count) / 4.0)))
            slot.generatedTokenCount = approxTokens
            slot.generationEnd = Date()
            slot.isGenerating = false
        } catch {
            slot.content = error.localizedDescription
            slot.isError = true
            slot.isGenerating = false
            slot.generationEnd = Date()
        }
    }
}
