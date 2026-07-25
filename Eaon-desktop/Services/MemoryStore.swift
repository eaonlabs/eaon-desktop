import Foundation

/// What kind of thing a memory is — a durable fact ("works as a teacher in
/// Austin") or a dated happening from the user's life ("had a chess
/// tournament", "math final on Friday"). The split exists because they age
/// differently: a fact stays relevant until it changes; an event matters a
/// lot this week and not much next month. `promptBlock` uses that to keep
/// the injected context feeling like a friend's working memory instead of
/// an ever-growing dossier.
enum MemoryKind: String, Codable {
    case fact
    case event
}

struct MemoryItem: Identifiable, Codable, Equatable {
    let id: UUID
    var text: String
    var createdAt: Date
    /// Optional so items saved before kinds existed decode fine (Swift's
    /// synthesized Decodable throws on a missing non-optional key — the
    /// exact silent-data-loss trap `ChatMessage.wasColdLoad`'s doc comment
    /// documents from experience). Read through `resolvedKind`.
    var kind: MemoryKind?

    var resolvedKind: MemoryKind { kind ?? .fact }

    init(id: UUID = UUID(), text: String, createdAt: Date = Date(), kind: MemoryKind = .fact) {
        self.id = id
        self.text = text
        self.createdAt = createdAt
        self.kind = kind
    }
}

/// Durable, user-visible things Eaon remembers across conversations — the
/// user's own manual entries, plus anything `MemoryExtractor` silently
/// pulled out of a chat (and, with separate consent, out of plugin results
/// or a user-chosen file). Off by default: nothing is stored or sent until
/// the user turns it on in Settings.
@MainActor
@Observable
final class MemoryStore {
    static let shared = MemoryStore()

    /// Storage cap — what can be REMEMBERED. What gets SENT per request is
    /// separately capped by `promptBlock` (facts cap + a recency window on
    /// events), so a long-lived memory can grow without every chat paying
    /// for all of it.
    static let maxMemories = 250
    /// Prompt-side cap — the block must stay a short, skimmable briefing,
    /// not a dossier. Bounds facts that actually matched what the user just
    /// said (see `promptBlock(relevantTo:)`); it used to be 60 and
    /// unconditional, which is exactly how a bare "hi" ended up dragging in
    /// forty facts about an unrelated coding project — plenty to derail a
    /// small model into repeating them back verbatim instead of answering.
    private static let maxPromptFacts = 10
    /// Below this many stored facts, document-frequency weighting (see
    /// `relevantFacts`) is skipped in favor of plain overlap — with only 1
    /// or 2 facts total, a fact trivially "shares" every one of its own
    /// words with 100% of the store, so "how common is this word across
    /// what's stored" isn't a meaningful signal yet; it only starts telling
    /// you something once there's enough stored to actually vary.
    private static let minFactsForFrequencyWeighting = 4
    private static let maxPromptEvents = 15
    /// Events older than this stay stored (and visible in Settings) but
    /// stop riding along in prompts — last month's dentist appointment is
    /// exactly the thing a human would quietly stop bringing up.
    private static let eventPromptWindowDays = 30
    /// Caps how many NEW memories one single extraction call can add —
    /// independent of `maxMemories`, the lifetime storage ceiling. Without
    /// this, one verbose exchange about a complex project could dump a
    /// dozen granular facts (file paths, tool names, framework choices) in
    /// a single shot; capping the PER-CALL yield is a safety valve against
    /// that even when `MemoryExtractor`'s own prompt fails to hold the
    /// line, the way weaker models observably do.
    private static let maxNewItemsPerExtraction = 5

    private static let memoriesKey = "eaon_memories"
    private static let enabledKey = "eaon_memory_enabled"
    private static let autoLearnEnabledKey = "eaon_memory_autolearn_enabled"
    private static let pluginLearnEnabledKey = "eaon_memory_plugin_learn_enabled"
    private static let lastAutoLearnKey = "eaon_memory_last_autolearn"
    private static let junkPruneDoneKey = "eaon_memory_junk_prune_v1"

    private(set) var memories: [MemoryItem] = []
    var isEnabled: Bool {
        didSet {
            guard isEnabled != oldValue else { return }
            UserDefaults.standard.set(isEnabled, forKey: Self.enabledKey)
        }
    }
    /// Whether a message you send silently triggers `MemoryExtractor` to
    /// look for new facts — separate from `isEnabled`, which only
    /// controls whether facts already saved get used in chats. Turning
    /// this off stops the ongoing background extraction call after every
    /// message while everything already remembered keeps working; it has
    /// no effect on the explicit, one-time "Learn from your existing
    /// chats" backfill, which isn't automatic and stays available either
    /// way. Defaults to true (matching the only behavior this app had
    /// before this setting existed) so adding it doesn't silently change
    /// anything for someone who never touches it.
    var isAutoLearnEnabled: Bool {
        didSet {
            guard isAutoLearnEnabled != oldValue else { return }
            UserDefaults.standard.set(isAutoLearnEnabled, forKey: Self.autoLearnEnabledKey)
        }
    }
    /// Separate, off-by-default consent for learning from what CONNECTED
    /// PLUGINS return in chat (calendar events, issues, documents…). Off
    /// means extraction only ever sees what the user and the model
    /// themselves wrote. Its own toggle — not folded into auto-learn —
    /// because plugin results routinely carry other people's information
    /// and content the user never typed, which deserves an explicit yes.
    var isPluginLearnEnabled: Bool {
        didSet {
            guard isPluginLearnEnabled != oldValue else { return }
            UserDefaults.standard.set(isPluginLearnEnabled, forKey: Self.pluginLearnEnabledKey)
        }
    }
    /// Human-readable outcome of the most recent automatic extraction —
    /// "Learned 2 new things · 3:41 PM", "Nothing new · 3:41 PM", or a
    /// plain-words failure. Exists because the extractor is deliberately
    /// silent in chat, which previously made "working and finding
    /// nothing" indistinguishable from "broken" — the exact complaint
    /// that led to this file's overhaul.
    var lastAutoLearnSummary: String? {
        didSet {
            guard lastAutoLearnSummary != oldValue else { return }
            UserDefaults.standard.set(lastAutoLearnSummary, forKey: Self.lastAutoLearnKey)
        }
    }

    var isFull: Bool { memories.count >= Self.maxMemories }

    private init() {
        isEnabled = UserDefaults.standard.bool(forKey: Self.enabledKey)
        isAutoLearnEnabled = UserDefaults.standard.object(forKey: Self.autoLearnEnabledKey) == nil
            ? true
            : UserDefaults.standard.bool(forKey: Self.autoLearnEnabledKey)
        isPluginLearnEnabled = UserDefaults.standard.bool(forKey: Self.pluginLearnEnabledKey)
        lastAutoLearnSummary = UserDefaults.standard.string(forKey: Self.lastAutoLearnKey)
        if let data = UserDefaults.standard.data(forKey: Self.memoriesKey),
           let decoded = try? JSONDecoder().decode([MemoryItem].self, from: data) {
            memories = decoded.sorted { $0.createdAt > $1.createdAt }
        }

        // One-time cleanup of junk already extracted before the
        // `isLikelyUsefulMemory` gate existed — a live user store held
        // dozens of implementation-detail "facts" ("Tools: write_file…",
        // "File structure: src/app.js…") that kept polluting every related
        // conversation. Runs once (versioned flag), uses exactly the same
        // filter new extractions go through, and yes — a manual entry that
        // happens to match a junk shape would also be removed in this one
        // pass; accepted, since the filter's shapes are code-fragment
        // patterns no one writes about themselves.
        if !UserDefaults.standard.bool(forKey: Self.junkPruneDoneKey) {
            UserDefaults.standard.set(true, forKey: Self.junkPruneDoneKey)
            let kept = memories.filter { Self.isLikelyUsefulMemory($0.text) }
            if kept.count != memories.count {
                memories = kept
                persist()
            }
        }
    }

    /// Adds extracted items, silently skipping near-duplicates (a plain
    /// case-insensitive containment check, not embeddings: this list is
    /// meant to stay short and human-readable, not grow an entry for every
    /// slight rephrasing of the same fact). Returns how many were actually
    /// added, so callers can report a truthful "learned N" instead of
    /// counting attempts.
    @discardableResult
    func addExtracted(_ items: [(kind: MemoryKind, text: String)]) -> Int {
        var added = 0
        for item in items {
            guard added < Self.maxNewItemsPerExtraction else { break }
            guard memories.count < Self.maxMemories else { break }
            let trimmed = item.text.trimmingCharacters(in: .whitespacesAndNewlines)
            guard !trimmed.isEmpty, !isDuplicate(of: trimmed) else { continue }
            // Deterministic gate on top of the extraction prompt — the
            // prompt asks for high-level durable facts, but the extractor
            // runs on whatever model just answered, including small local
            // ones that observably ignore the nuance and emit
            // implementation minutiae ("Tools: write_file, str_replace",
            // "File structure: src/app.js"). Code can hold the line a weak
            // model won't.
            guard Self.isLikelyUsefulMemory(trimmed) else { continue }
            memories.insert(MemoryItem(text: trimmed, kind: item.kind), at: 0)
            added += 1
        }
        if added > 0 { persist() }
        return added
    }

    /// Shape-based junk detector for AUTO-extracted memories (manual
    /// entries via `addManual` are never filtered — what the user typed
    /// deliberately is theirs to keep). Everything here is a pattern taken
    /// from junk observed live in a real user's store, not hypothetical:
    /// colon-label lists ("Framework: TypeScript", "Tools: …"), file
    /// paths and extensions, snake_case identifiers, email/account
    /// plumbing, code fences, and fragments too short to be a sentence
    /// about a person. Deliberately conservative — a rejected real fact
    /// costs one forgotten detail; an accepted junk fact pollutes every
    /// future related conversation.
    static func isLikelyUsefulMemory(_ text: String) -> Bool {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard trimmed.count >= 8, trimmed.count < 300 else { return false }
        guard trimmed.split(whereSeparator: \.isWhitespace).count >= 3 else { return false }
        guard !trimmed.contains("```"), !trimmed.contains("@") else { return false }

        let junkPatterns = [
            #"^[A-Za-z][A-Za-z ]{0,24}:\s"#,          // "Framework: …", "File structure: …"
            #"[A-Za-z0-9]+_[A-Za-z0-9]+"#,            // write_file, Q4_K_M, snake_case anything
            #"(?i)\b[\w-]+\.(js|jsx|ts|tsx|py|html?|css|json|md|swift|java|rb|go|rs|cpp|hpp|sh|ya?ml|toml|gguf|test)\b"#,
            #"\w/\w"#,                                 // path-ish: src/app, a/b
        ]
        for pattern in junkPatterns where trimmed.range(of: pattern, options: .regularExpression) != nil {
            return false
        }
        return true
    }

    @discardableResult
    func addManual(_ text: String) -> Bool {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty, memories.count < Self.maxMemories, !isDuplicate(of: trimmed) else { return false }
        memories.insert(MemoryItem(text: trimmed), at: 0)
        persist()
        return true
    }

    /// What happened to each candidate in a bulk import — reported back to
    /// the user verbatim, because "Imported 12" alone hides whether the
    /// other 5 were duplicates, junk, or lost to the storage cap.
    struct ImportOutcome: Equatable {
        var added = 0
        var skippedDuplicates = 0
        var skippedFiltered = 0
        var skippedOverCap = 0
    }

    /// Bulk-adds facts brought over from another AI product (see
    /// `MemoryParsing.parseProviderMemoryList` for how a pasted dump
    /// becomes candidates). An explicit user action, so the per-extraction
    /// cap doesn't apply — but every candidate still passes the same junk
    /// gate and duplicate check auto-extraction uses: imported junk
    /// pollutes future prompts exactly as badly as extracted junk.
    func importFacts(_ candidates: [String]) -> ImportOutcome {
        var outcome = ImportOutcome()
        for candidate in candidates {
            let trimmed = candidate.trimmingCharacters(in: .whitespacesAndNewlines)
            guard !trimmed.isEmpty else { continue }
            guard memories.count < Self.maxMemories else {
                outcome.skippedOverCap += 1
                continue
            }
            guard Self.isLikelyUsefulMemory(trimmed) else {
                outcome.skippedFiltered += 1
                continue
            }
            guard !isDuplicate(of: trimmed) else {
                outcome.skippedDuplicates += 1
                continue
            }
            memories.insert(MemoryItem(text: trimmed, kind: .fact), at: 0)
            outcome.added += 1
        }
        if outcome.added > 0 { persist() }
        return outcome
    }

    func remove(_ id: UUID) {
        memories.removeAll { $0.id == id }
        persist()
    }

    func clearAll() {
        guard !memories.isEmpty else { return }
        memories.removeAll()
        persist()
    }

    /// The system-prompt briefing built from what's remembered — nil when
    /// there's nothing to say. Facts are filtered to what's actually
    /// relevant to `userText` (see `relevantFacts`), then events — recent,
    /// dated, newest first, limited to the last `eventPromptWindowDays` —
    /// which stay topic-independent on purpose (a friend brings up "how did
    /// the exam go?" unprompted; that's the feature, not the bug this
    /// filtering exists for). Ends with guidance to USE the memory like a
    /// person would — follow up on how things went, connect topics — rather
    /// than recite it. `now` is injectable for tests; production callers
    /// pass nothing.
    func promptBlock(relevantTo userText: String, now: Date = Date()) -> String? {
        guard isEnabled, !memories.isEmpty else { return nil }

        let facts = relevantFacts(to: userText)
        let windowStart = now.addingTimeInterval(-TimeInterval(Self.eventPromptWindowDays) * 86_400)
        let events = memories
            .filter { $0.resolvedKind == .event && $0.createdAt >= windowStart && $0.createdAt <= now }
            .sorted { $0.createdAt > $1.createdAt }
            .prefix(Self.maxPromptEvents)

        guard !facts.isEmpty || !events.isEmpty else { return nil }

        var sections: [String] = [
            "What you know about this user from earlier conversations. Weave it in naturally when it's relevant — follow up on how something went, connect new topics to what you know — without reciting this list back or claiming to remember anything not on it."
        ]
        if !facts.isEmpty {
            sections.append("Facts:\n" + facts.map { "- \($0.text)" }.joined(separator: "\n"))
        }
        if !events.isEmpty {
            let formatter = DateFormatter()
            formatter.dateFormat = "EEE MMM d"
            let lines = events.map { "- \(formatter.string(from: $0.createdAt)): \($0.text)" }
            sections.append("Recent happenings in their life (dated by when they mentioned it, newest first):\n" + lines.joined(separator: "\n"))
        }
        return sections.joined(separator: "\n\n")
    }

    /// Facts that actually relate to what the user just said — the same
    /// "no embeddings, stays explainable" philosophy `isDuplicate` already
    /// uses below, not a semantic similarity model, but weighted by how
    /// DISTINCTIVE each shared word is across this user's own stored
    /// facts, not just whether it's shared at all. Plain overlap alone
    /// still lets a generic word through: "I've been fixing this bug for
    /// years" and a stored "Is 24 years old" share only "years" — nothing
    /// about that means the two are actually related, but a bare
    /// word-count match would surface the age fact anyway. A word that
    /// appears in only one or two stored facts ("carbonara," "Lume") is
    /// strong, specific evidence two things share a topic; a word
    /// scattered across many facts ("years," "project," "using") barely
    /// narrows anything down and is weighted down accordingly — the same
    /// idea document search ranking has used forever (inverse document
    /// frequency), just computed over the user's own dozen-ish stored
    /// facts instead of a search index. Still fully auditable from the
    /// stored text alone: open Memory settings and the "why did this
    /// match" answer is still "these specific words, this often."
    ///
    /// A fact is included ONLY when the current message actually has
    /// something to do with it — no ambient/default set for a bare "hi" or
    /// any other contentless message, even though a *little* proactive
    /// personalization there ("knows your name") would be harmless on its
    /// own. Explicit product decision, not an oversight: a fact only ever
    /// rides along when there's a real question about it.
    private func relevantFacts(to userText: String) -> [MemoryItem] {
        let allFacts = memories.filter { $0.resolvedKind == .fact }
        guard !allFacts.isEmpty else { return [] }
        // Expanded with a small, hand-picked synonym table before scoring —
        // plain overlap has ZERO shared words between "what's my age" and a
        // fact stored as "is 24 years old" (neither contains the other's
        // literal word at all), which would otherwise silently fail to
        // recall a fact that's unambiguously what's being asked about. Only
        // the query side is expanded; that alone is enough to bridge the
        // gap in either direction since the group already contains every
        // member regardless of which one triggered it.
        let queryWords = Self.expanded(Self.meaningfulWords(in: userText))
        guard !queryWords.isEmpty else { return [] }
        guard !allFacts.isEmpty else { return [] }

        let factWordSets = allFacts.map { ($0, Self.meaningfulWords(in: $0.text)) }
        var documentFrequency: [String: Int] = [:]
        for (_, words) in factWordSets {
            for word in words { documentFrequency[word, default: 0] += 1 }
        }

        let scored: [(item: MemoryItem, score: Double)] = factWordSets.compactMap { fact, factWords in
            let shared = queryWords.intersection(factWords)
            guard !shared.isEmpty else { return nil }
            let score = shared.reduce(into: 0.0) { total, word in
                total += 1.0 / Double(documentFrequency[word] ?? 1)
            }
            return (fact, score)
        }
        guard !scored.isEmpty else { return [] }

        // Stable sort by score alone (Swift's sort is already stable) keeps
        // ties in their existing newest-first storage order rather than
        // shuffling them.
        let ranked = scored.sorted { $0.score > $1.score }

        guard allFacts.count >= Self.minFactsForFrequencyWeighting else {
            return Array(ranked.prefix(Self.maxPromptFacts).map(\.item))
        }

        // A word shared with half the store or more is too generic to
        // count as real evidence on its own — strictly greater than, not
        // >=, so a word landing exactly at that boundary (documentFrequency
        // == half the store) is excluded, not treated as a borderline pass.
        // Facts that clear this only via several weaker words still
        // qualify; facts riding on one generic word alone don't.
        let minScore = 1.0 / Double(max(allFacts.count / 2, 1))
        let relevant = ranked.filter { $0.score > minScore }
        guard !relevant.isEmpty else { return [] }

        return relevant
            .prefix(Self.maxPromptFacts)
            .map(\.item)
    }

    /// Common short/filler words dropped before scoring — matching them
    /// would make nearly everything "relevant" to nearly everything else
    /// (a fact and a query both containing "the" says nothing), which
    /// defeats the entire point of filtering.
    private static let stopWords: Set<String> = [
        "the", "a", "an", "is", "are", "was", "were", "be", "been", "being",
        "have", "has", "had", "do", "does", "did", "will", "would", "could",
        "should", "can", "may", "might", "must", "shall", "to", "of", "in",
        "on", "at", "for", "with", "about", "as", "by", "from", "and", "or",
        "but", "if", "so", "than", "that", "this", "these", "those", "it",
        "its", "i", "me", "my", "you", "your", "we", "our", "they", "them",
        "what", "which", "who", "how", "why", "when", "where", "hi", "hey",
        "hello", "thanks", "thank", "ok", "okay", "yes", "no", "please",
        "just", "want", "need", "like", "get", "got", "make", "made",
    ]

    private static func meaningfulWords(in text: String) -> Set<String> {
        Set(
            text.lowercased()
                .components(separatedBy: CharacterSet.alphanumerics.inverted)
                .filter { $0.count > 2 && !stopWords.contains($0) }
        )
    }

    /// A small, hand-picked table for the most common ways people ask
    /// about themselves — added because plain overlap has zero shared
    /// words between phrasings that obviously mean the same thing ("what's
    /// my age" vs. a fact stored as "is 24 years old" share no literal
    /// word at all). Deliberately narrow, not a general thesaurus: the
    /// point of `relevantFacts` is to stay auditable and resistant to
    /// coincidental matches, and a broad synonym net would loosen exactly
    /// the precision the document-frequency weighting above exists to buy
    /// back. Covers only identity-level questions (age, name, where they
    /// live, what they do) — the categories a memory feature is most
    /// commonly asked about directly.
    private static let synonymGroups: [Set<String>] = [
        // "years" deliberately excluded from the group's own membership —
        // it's too generic on its own ("for years," "10 years of
        // experience") to safely TRIGGER pulling in "age"/"old"/"born" for
        // an unrelated query; "old" already reliably bridges "what's my
        // age" (via "age" below) to a fact stored as "...years old"
        // without needing "years" itself to be a group member.
        ["age", "old", "born", "birthday"],
        ["name", "called"],
        ["live", "lives", "location", "city", "hometown", "based"],
        ["job", "work", "works", "career", "role", "profession", "occupation"],
    ]

    private static func expanded(_ words: Set<String>) -> Set<String> {
        var result = words
        for group in synonymGroups where !group.isDisjoint(with: words) {
            result.formUnion(group)
        }
        return result
    }

    private func isDuplicate(of fact: String) -> Bool {
        memories.contains {
            $0.text.localizedCaseInsensitiveContains(fact) || fact.localizedCaseInsensitiveContains($0.text)
        }
    }

    /// Folds memories pulled from the cloud into the local store.
    ///
    /// Union by id, never a replacement: a fact this device knows and the
    /// cloud copy doesn't is kept, exactly as in `ChatViewModel.mergeFromCloud`
    /// and for the same reason — an import should only ever be able to ADD
    /// what you know about yourself, never quietly forget some of it because
    /// another machine happened to sync first.
    @discardableResult
    func mergeFromCloud(_ incoming: [MemoryItem]) -> Int {
        let known = Set(memories.map(\.id))
        let fresh = incoming.filter { !known.contains($0.id) }
        guard !fresh.isEmpty else { return 0 }
        memories.append(contentsOf: fresh)
        memories.sort { $0.createdAt > $1.createdAt }
        persist()
        return fresh.count
    }

    private func persist() {
        guard let data = try? JSONEncoder().encode(memories) else { return }
        UserDefaults.standard.set(data, forKey: Self.memoriesKey)
    }
}

/// Pure parsing for extractor replies — separated from `MemoryExtractor`
/// (which drags in the whole networking stack) so the riskiest logic here
/// stays compilable and testable standalone, the same layering reason
/// `WorkspaceParser` is separate from the agent loop.
enum MemoryParsing {
    /// Matches `WorkspaceParser.strippedOfThinking`'s behavior for the one
    /// case that matters here: a reasoning model wrapping its reply in a
    /// `<think>…</think>` span whose prose can contain stray `[`
    /// characters — which used to send `extractJSONArray` hunting inside
    /// the reasoning and coming back with garbage (one of the reasons
    /// extraction never visibly worked). Duplicated as a private tiny
    /// regex rather than importing WorkspaceParser, to keep this file's
    /// standalone-compile property.
    private static let thinkSpanRegex = try! NSRegularExpression(
        pattern: "<think>[\\s\\S]*?</think>|<thinking>[\\s\\S]*?</thinking>",
        options: [.caseInsensitive]
    )

    /// Parses the extractor's reply into memory items, tolerantly:
    /// - the requested shape: `[{"kind": "fact"|"event", "text": "…"}]`
    /// - the legacy/lazy shape: `["…", "…"]` (treated as facts)
    /// - a mix of both in one array
    /// - any of the above buried in prose or a reasoning span
    /// Unknown kinds default to `fact`; blank/oversized texts are dropped.
    static func parseItems(from raw: String) -> [(kind: MemoryKind, text: String)] {
        let range = NSRange(raw.startIndex..., in: raw)
        let stripped = thinkSpanRegex.stringByReplacingMatches(in: raw, range: range, withTemplate: "\n")
        guard let jsonText = extractJSONArray(from: stripped),
              let data = jsonText.data(using: .utf8),
              let array = try? JSONSerialization.jsonObject(with: data) as? [Any] else { return [] }

        var items: [(MemoryKind, String)] = []
        for element in array {
            if let text = element as? String {
                items.append((.fact, text))
            } else if let object = element as? [String: Any], let text = object["text"] as? String {
                let kind = (object["kind"] as? String).flatMap(MemoryKind.init(rawValue:)) ?? .fact
                items.append((kind, text))
            }
        }
        return items
            .map { ($0.0, $0.1.trimmingCharacters(in: .whitespacesAndNewlines)) }
            .filter { !$0.1.isEmpty && $0.1.count < 300 }
    }

    /// Turns a memory list copied out of another AI product — ChatGPT's
    /// Manage Memories page, Gemini's Saved Info, or any assistant's reply
    /// to "list everything you remember about me" — into individual
    /// candidate facts. Deliberately deterministic (no model call): those
    /// dumps are already one-fact-per-line lists, so parsing them is
    /// string cleanup, and a model in the middle would just re-introduce
    /// the unreliability this feature's filters exist to keep out.
    /// Line-based: strips bullets/numbering/quotes, drops headers and
    /// blanks. When the paste is a solid prose paragraph instead of a
    /// list (one or two long lines), falls back to sentence-splitting so
    /// a conversational dump still imports.
    static func parseProviderMemoryList(_ raw: String) -> [String] {
        let lines = raw
            .components(separatedBy: .newlines)
            .map(cleanImportedLine)
            .filter { !$0.isEmpty }

        if lines.count <= 2, let longest = lines.max(by: { $0.count < $1.count }), longest.count > 160 {
            return lines.flatMap { line in
                line.components(separatedBy: ". ")
                    .map { $0.trimmingCharacters(in: CharacterSet.whitespaces.union(CharacterSet(charactersIn: "."))) }
                    .filter { $0.count >= 8 }
            }
        }
        return lines
    }

    private static func cleanImportedLine(_ line: String) -> String {
        var text = line.trimmingCharacters(in: .whitespaces)
        // Leading bullet characters, possibly repeated ("- ", "• ", "* ").
        while let first = text.first, "-•*–—·".contains(first) {
            text = String(text.dropFirst()).trimmingCharacters(in: .whitespaces)
        }
        // Numbered lists: "1. ", "12) ".
        if let range = text.range(of: #"^\d{1,3}[.)]\s+"#, options: .regularExpression) {
            text.removeSubrange(range)
        }
        text = text.trimmingCharacters(in: CharacterSet(charactersIn: "\"\u{201C}\u{201D}"))
        // Section headers ("Memories:", "Saved info:") aren't facts.
        if text.hasSuffix(":") { return "" }
        return text.trimmingCharacters(in: .whitespaces)
    }

    /// Finds a JSON array's exact substring anywhere in `text` — tracking
    /// bracket depth and skipping over quoted-string contents (so a
    /// literal "[" or "]" inside a fact string, or in trailing prose,
    /// doesn't throw off the boundary) — rather than requiring the whole
    /// reply to be pure JSON. Models reliably ignore "reply with ONLY
    /// JSON, no commentary" — especially weaker/local ones — so this has
    /// to tolerate a preamble ("Sure, here's what I found:") or a
    /// trailing note instead of silently discarding real facts.
    static func extractJSONArray(from text: String) -> String? {
        guard let start = text.firstIndex(of: "[") else { return nil }
        var depth = 0
        var inString = false
        var isEscaped = false
        var index = start
        while index < text.endIndex {
            let char = text[index]
            if isEscaped {
                isEscaped = false
            } else if char == "\\" {
                isEscaped = true
            } else if char == "\"" {
                inString.toggle()
            } else if !inString {
                if char == "[" {
                    depth += 1
                } else if char == "]" {
                    depth -= 1
                    if depth == 0 { return String(text[start...index]) }
                }
            }
            index = text.index(after: index)
        }
        return nil
    }
}
