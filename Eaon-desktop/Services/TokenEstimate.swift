import Foundation

/// A quick, provider-agnostic token estimate from raw character count —
/// the ~4 chars/token approximation used wherever an exact tokenizer isn't
/// worth calling for a rough size check.
///
/// Pulled out of `StatisticsTracker` when Statistics was removed: this one
/// function wasn't actually about usage tracking — `ChatViewModel`'s context-
/// window fullness check and `ContextCompressor`'s trigger both depend on it
/// for real behavior, not just for what the Statistics page displayed.
enum TokenEstimate {
    static func approxTokens(characters: Int) -> Int {
        max(0, Int(ceil(Double(characters) / 4.0)))
    }
}
