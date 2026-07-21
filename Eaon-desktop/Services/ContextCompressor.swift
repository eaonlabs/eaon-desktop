import Foundation

/// Keeps a long conversation from sending its entire raw history on every
/// single message. Below the trigger threshold this does nothing at all —
/// short chats pay zero extra cost or latency. Once a conversation grows
/// past it, everything older than the most recent `keepVerbatimCount`
/// messages is replaced with one compact, running summary instead of being
/// sent verbatim (or silently falling off the front of the context window,
/// which is what would otherwise happen once the model — or the provider
/// behind it — truncates on its own).
///
/// The summary is incremental, not recomputed from scratch each time: a
/// later compression re-reads only the newly-eligible span and asks the
/// model to fold it into the existing summary, via `BackgroundCompletion`
/// (the same one-shot, routing-agnostic completion primitive
/// `MemoryExtractor` uses) — so a conversation that keeps growing doesn't
/// keep re-processing everything from message zero every time.
@MainActor
enum ContextCompressor {
    /// Below this many estimated tokens of prior (non-system) history,
    /// compression never triggers — a short chat has nothing worth
    /// compressing, and the extra round trip would be pure latency for no
    /// benefit.
    static let minTokensToConsider = 6_000
    /// Compress once prior history crosses this fraction of the model's
    /// known context limit — leaves real headroom for the system prompt,
    /// the new message, and the reply itself, rather than waiting until
    /// the conversation is already crowding the wall.
    static let triggerFraction = 0.6
    /// However much gets summarized, the most recent this many messages
    /// always ride along verbatim. Recent turns are what a reply most
    /// needs intact for a coherent continuation — and keeping them out of
    /// the summarized span means they never get re-paraphrased while
    /// they're still the active thread.
    static let keepVerbatimCount = 16

    /// Cheap enough to call before every send: true only when there's
    /// both (a) enough raw history to be worth the round trip and (b) a
    /// known context limit it's actually crowding. An unknown limit (an
    /// unrecognized cloud model, or a local one that hasn't reported yet)
    /// means never compressing rather than guessing at a threshold.
    static func shouldCompress(messageCount: Int, estimatedTokens: Int, contextLimitTokens: Int?) -> Bool {
        guard messageCount > keepVerbatimCount, estimatedTokens >= minTokensToConsider else { return false }
        guard let contextLimitTokens, contextLimitTokens > 0 else { return false }
        return Double(estimatedTokens) >= Double(contextLimitTokens) * triggerFraction
    }

    /// The index (into `messages`) that should stay verbatim from here on
    /// — everything before it is eligible to be folded into the summary.
    static func verbatimCutoff(messageCount: Int) -> Int {
        max(0, messageCount - keepVerbatimCount)
    }

    /// Produces an updated summary covering `messages[0..<cutoffIndex]`,
    /// extending `existingSummary` if there is one rather than
    /// re-summarizing the whole span again. Returns `existingSummary`
    /// unchanged (which may be nil) if there's nothing new to fold in, or
    /// if the model call fails — a failed compression attempt falls back
    /// to whatever summary already existed rather than losing it or
    /// silently sending nothing for the older span.
    static func compress(
        messages: [ChatMessage],
        upTo cutoffIndex: Int,
        existingSummary: ConversationSummary?,
        modelId: String,
        customConfig: CustomProviderConfig?,
        localRecord: LocalModelRecord?,
        aquaApiKey: String?
    ) async -> ConversationSummary? {
        let startIndex = min(existingSummary?.coversMessagesUpTo ?? 0, messages.count)
        guard startIndex < cutoffIndex else { return existingSummary }

        let newSpan = messages[startIndex..<cutoffIndex].filter { !$0.content.isEmpty }
        guard !newSpan.isEmpty else { return existingSummary }

        let transcript = newSpan
            .map { "\($0.isUser ? "User" : "Assistant"): \($0.content)" }
            .joined(separator: "\n\n")

        let prompt: String
        if let existingText = existingSummary?.text, !existingText.isEmpty {
            prompt = """
            Here is a running summary of an ongoing conversation so far:
            \(existingText)

            Here is what was said next, continuing from where that summary left off:
            \(transcript)

            Write one updated summary that folds the new part into the existing one. Plain prose, concise, preserving names, decisions, numbers, and anything said that would be expected to still be remembered later. Do not mention that this is a summary or refer to "the conversation" — just state what's true. Reply with only the updated summary text, nothing else.
            """
        } else {
            prompt = """
            Summarize the following conversation concisely, in plain prose. Preserve names, decisions, numbers, and anything said that would be expected to still be remembered later. Do not mention that this is a summary or refer to "the conversation" — just state what's true. Reply with only the summary text, nothing else.

            \(transcript)
            """
        }

        guard let raw = await BackgroundCompletion.requestRaw(
            history: [HistoryTurn(role: "user", content: prompt)],
            customConfig: customConfig,
            localRecord: localRecord,
            aquaApiKey: aquaApiKey,
            modelId: modelId
        ) else {
            return existingSummary
        }

        let text = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty else { return existingSummary }

        return ConversationSummary(text: text, coversMessagesUpTo: cutoffIndex, updatedAt: Date())
    }
}
