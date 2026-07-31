import Foundation

/// Asks the model to name a conversation, instead of using the first thing
/// the user typed.
///
/// The truncated-first-message title is a poor name for a chat and gets worse
/// the more you have: a sidebar of "hi", "hi", "hello how are you doin…" is
/// unusable for finding anything, and a long opening question gets clipped
/// mid-word into something that reads like a fragment. The model has just
/// read the whole exchange and is the only participant that actually knows
/// what the conversation turned out to be about.
///
/// Runs once per conversation, after the first exchange completes, on the
/// same route the chat itself used — so there's no second credential path to
/// break, and a local-only user's titles are generated locally too, never
/// silently sent to a hosted model.
enum ConversationTitler {
    /// Kept short enough to read at a glance in a narrow sidebar without
    /// truncation. The prompt asks for this; `sanitize` enforces it, because
    /// a model asked for "under 6 words" will still occasionally write a
    /// sentence.
    static let maxCharacters = 38

    private static let systemPrompt = """
    You name chat conversations. Reply with ONLY the title — no quotes, no \
    punctuation at the end, no preamble, no explanation.

    Rules:
    - 2 to 5 words. Never a full sentence.
    - Describe what the conversation is ABOUT, not what the user said.
    - Use the conversation's own language.
    - No trailing period.

    Examples:
    "hey can you help me center a div in css" -> CSS centering help
    "write me a snake game in python" -> Python snake game
    "hi" -> Casual greeting
    """

    /// Produces a title, or nil if the model gave nothing usable — in which
    /// case the caller keeps whatever it already had. A failed title is a
    /// non-event: it must never surface an error, and it must never leave a
    /// conversation nameless.
    static func title(
        forUserMessage userText: String,
        assistantReply: String,
        customConfig: CustomProviderConfig?,
        localRecord: LocalModelRecord?,
        aquaApiKey: String?,
        modelId: String
    ) async -> String? {
        let user = userText.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !user.isEmpty else { return nil }

        // Both sides are capped: a title needs the gist, not the transcript,
        // and sending a 40-message code dump to name a chat would cost more
        // than the chat did.
        let exchange = """
        User: \(String(user.prefix(600)))

        Assistant: \(String(assistantReply.trimmingCharacters(in: .whitespacesAndNewlines).prefix(600)))
        """

        let raw = await BackgroundCompletion.requestRaw(
            history: [
                HistoryTurn(role: "system", content: systemPrompt),
                HistoryTurn(role: "user", content: exchange),
            ],
            customConfig: customConfig,
            localRecord: localRecord,
            aquaApiKey: aquaApiKey,
            modelId: modelId
        )
        guard let raw else { return nil }
        return sanitize(raw)
    }

    /// Turns whatever the model actually said into something that belongs in
    /// a sidebar. Models ignore formatting instructions often enough that
    /// this has to assume the worst: a reasoning model emits `<think>` spans,
    /// a chatty one writes `Title: "CSS centering help"`, a small one returns
    /// a whole paragraph.
    static func sanitize(_ raw: String) -> String? {
        var text = raw

        // Strip a reasoning model's thinking block — the real answer is what
        // follows it.
        while let open = text.range(of: "<think>", options: .caseInsensitive) {
            if let close = text.range(of: "</think>", options: .caseInsensitive, range: open.upperBound..<text.endIndex) {
                text.removeSubrange(open.lowerBound..<close.upperBound)
            } else {
                text.removeSubrange(open.lowerBound..<text.endIndex)
            }
        }

        // First non-empty line only: anything after it is commentary the
        // model was asked not to write.
        guard var line = text
            .split(separator: "\n", omittingEmptySubsequences: true)
            .map({ $0.trimmingCharacters(in: .whitespaces) })
            .first(where: { !$0.isEmpty })
        else { return nil }

        // "Title: X" / "Chat title - X" — drop the label, keep X.
        for prefix in ["title:", "chat title:", "conversation title:", "name:"] {
            if line.lowercased().hasPrefix(prefix) {
                line = String(line.dropFirst(prefix.count)).trimmingCharacters(in: .whitespaces)
            }
        }

        // Surrounding quotes, markdown emphasis, list bullets, trailing stops.
        line = line.trimmingCharacters(in: CharacterSet(charactersIn: " \t\"'`*_#-–—•"))
        line = line.trimmingCharacters(in: CharacterSet(charactersIn: ".!,;:"))
        line = line.replacingOccurrences(of: "\\s+", with: " ", options: .regularExpression)

        guard !line.isEmpty else { return nil }
        // A model that returned a paragraph despite the instruction has not
        // produced a title; the caller's existing fallback is better than a
        // clipped essay.
        guard line.count <= 120 else { return nil }
        if line.count > maxCharacters {
            line = String(line.prefix(maxCharacters)).trimmingCharacters(in: .whitespaces) + "…"
        }
        return line
    }
}
