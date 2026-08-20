import Foundation

/// How full the current conversation is relative to its model's context
/// limit — approximate by nature, not a live API measurement the way this
/// app's other stats are:
/// - Token count is estimated from character count (~4 chars/token, same
///   ratio `TokenEstimate.approxTokens` already uses elsewhere).
/// - The context *limit* is real, live data from Ollama's `/api/ps` for a
///   currently-loaded local model, but for everything else (any cloud
///   model, or a local model not yet loaded) it falls back to a small,
///   hand-maintained table of each family's publicly published context
///   window. Deliberately conservative where a family has several context
///   sizes across variants — better to undercount headroom than overstate
///   it. An unrecognized model shows no indicator at all rather than a
///   guessed number.
enum ContextWindowEstimator {
    /// Published context windows, by family — checked as a lowercased
    /// substring match against the model id, same convention as
    /// `ModelCatalog.brand(for:)`. Deliberately not exhaustive.
    private static let knownLimits: [(match: String, tokens: Int)] = [
        ("claude", 200_000),
        ("gemini", 1_000_000),
        ("gpt-4o", 128_000),
        ("gpt-4.1", 128_000),
        ("gpt-5", 128_000),
        ("o1", 128_000),
        ("o3", 128_000),
        ("llama-3.1", 128_000),
        ("llama3.1", 128_000),
        ("llama-3.2", 128_000),
        ("llama3.2", 128_000),
        ("deepseek", 128_000),
        ("qwen", 128_000),
        ("mistral", 128_000),
        ("gemma", 8_192),
    ]

    /// The best available context limit for a model — live Ollama data
    /// when it's actually loaded, else the family table, else nil.
    static func contextLimit(modelId: String, liveOllamaContextLength: Int?) async -> Int? {
        if let liveOllamaContextLength, liveOllamaContextLength > 0 {
            return liveOllamaContextLength
        }
        let id = modelId.lowercased()
        return knownLimits.first { id.contains($0.match) }?.tokens
    }

    /// A compact "42% of context" style label, or nil if usage is
    /// negligible/limit unknown — callers should simply not show anything
    /// in that case rather than render a confusing partial state.
    static func usageLabel(usedTokens: Int, limitTokens: Int) -> String? {
        guard limitTokens > 0 else { return nil }
        let percent = Int((Double(usedTokens) / Double(limitTokens) * 100).rounded())
        guard percent >= 1 else { return nil }
        return "\(min(percent, 100))% of context"
    }
}
