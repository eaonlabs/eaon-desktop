import Foundation

/// After a turn finishes, silently asks the same model that just answered
/// to pull out anything new worth remembering about the user — never shown
/// in chat, never allowed to touch the visible conversation. No longer
/// silent about its OUTCOME, though: every run records a one-line result
/// (`MemoryStore.lastAutoLearnSummary`) the Memory settings page shows,
/// because a background feature whose success and failure both look like
/// nothing-happened is indistinguishable from broken — the exact complaint
/// that led to this rewrite.
///
/// Deliberately NOT built on tool-calling — this app talks to three very
/// different wire formats (Aqua's own API, several BYOK providers, and
/// local llama.cpp/Ollama/MLX servers whose function-calling support is
/// inconsistent at best) and a memory feature that only sometimes works
/// depending on which model you picked is exactly the gimmick the user
/// explicitly doesn't want. A plain extra completion call, asked to reply
/// with a JSON array, works identically everywhere.
@MainActor
enum MemoryExtractor {
    /// `toolContext` — this turn's plugin/tool results, passed ONLY when
    /// the user has separately consented (`MemoryStore.isPluginLearnEnabled`);
    /// nil otherwise, so unconsented extraction never even sees them.
    static func run(
        userText: String,
        assistantText: String,
        toolContext: String?,
        customConfig: CustomProviderConfig?,
        localRecord: LocalModelRecord?,
        aquaApiKey: String?,
        modelId: String
    ) async {
        guard MemoryStore.shared.isEnabled, !MemoryStore.shared.isFull else { return }
        guard !userText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { return }

        let existing = MemoryStore.shared.memories.map(\.text)
        let prompt = buildPrompt(userText: userText, assistantText: assistantText, toolContext: toolContext, existing: existing)
        let history: [HistoryTurn] = [
            HistoryTurn(role: "system", content: systemPrompt),
            HistoryTurn(role: "user", content: prompt),
        ]

        guard let raw = await BackgroundCompletion.requestRaw(
            history: history,
            customConfig: customConfig,
            localRecord: localRecord,
            aquaApiKey: aquaApiKey,
            modelId: modelId
        ) else {
            MemoryStore.shared.lastAutoLearnSummary = "Couldn't check the last message (the model didn't answer) · \(Self.timestamp())"
            return
        }

        let items = MemoryParsing.parseItems(from: raw)
        guard !items.isEmpty else {
            MemoryStore.shared.lastAutoLearnSummary = "Nothing new in the last message · \(Self.timestamp())"
            return
        }
        let added = MemoryStore.shared.addExtracted(items)
        MemoryStore.shared.lastAutoLearnSummary = added > 0
            ? "Learned \(added) new thing\(added == 1 ? "" : "s") · \(Self.timestamp())"
            : "Nothing new in the last message · \(Self.timestamp())"
    }

    private static func timestamp() -> String {
        let formatter = DateFormatter()
        formatter.timeStyle = .short
        return formatter.string(from: Date())
    }

    // MARK: - Learn from a user-chosen file

    /// Extracts memories from text the user explicitly picked and confirmed
    /// (see `MemorySettingsView`'s open-panel + confirmation flow — the
    /// consent lives there; by the time this runs, the user has said yes
    /// twice). Returns how many memories were added, or a thrown
    /// `FileLearnError` with a plain-words reason.
    enum FileLearnError: Error, LocalizedError {
        case unreadable
        case modelFailed

        var errorDescription: String? {
            switch self {
            case .unreadable: return "That file couldn't be read as text."
            case .modelFailed: return "The model didn't answer — try again, or switch models."
            }
        }
    }

    static let maxFileCharacters = 12_000

    static func runOnFileText(
        _ text: String,
        fileName: String,
        customConfig: CustomProviderConfig?,
        localRecord: LocalModelRecord?,
        aquaApiKey: String?,
        modelId: String
    ) async throws -> Int {
        let capped = String(text.prefix(maxFileCharacters))
        let existing = MemoryStore.shared.memories.map(\.text)
        let known = existing.isEmpty ? "(nothing yet)" : existing.map { "- \($0)" }.joined(separator: "\n")
        let prompt = """
        Already known about the user:
        \(known)

        Text the user chose to share from their file "\(fileName)":
        \(capped)

        JSON array of NEW items worth remembering, or []:
        """
        let history: [HistoryTurn] = [
            HistoryTurn(role: "system", content: backfillSystemPrompt),
            HistoryTurn(role: "user", content: prompt),
        ]
        guard let raw = await BackgroundCompletion.requestRaw(history: history, customConfig: customConfig, localRecord: localRecord, aquaApiKey: aquaApiKey, modelId: modelId) else {
            throw FileLearnError.modelFailed
        }
        return MemoryStore.shared.addExtracted(MemoryParsing.parseItems(from: raw))
    }

    // MARK: - Backfill from existing conversations

    /// Mines facts out of chats that already existed before memory was
    /// turned on (or before this ran) — one extraction call per
    /// conversation, sequentially, so each call sees everything found so
    /// far and doesn't re-add the same fact from conversation 2 that
    /// conversation 1 already surfaced. Explicit and opt-in (a button in
    /// Settings, never automatic): this makes a real API call per
    /// conversation, which costs time and — on a paid model — money, so
    /// it only runs when asked for, same philosophy as every other
    /// side-effectful action in this app.
    struct BackfillResult {
        let conversationsReviewed: Int
        let conversationsTotal: Int
        let factsAdded: Int
        let stoppedEarly: Bool
    }

    /// Stops early if the store fills up (no point spending more calls
    /// once nothing more can be stored) or `isCancelled` reports true
    /// (checked between conversations, not mid-call — an in-flight
    /// request is let to finish rather than aborted, so a cancel never
    /// wastes the network round-trip it already paid for).
    static func runBackfill(
        conversations: [Conversation],
        customConfig: CustomProviderConfig?,
        localRecord: LocalModelRecord?,
        aquaApiKey: String?,
        modelId: String,
        onProgress: @escaping (_ completed: Int, _ total: Int, _ newFactCount: Int) -> Void,
        isCancelled: @escaping () -> Bool
    ) async -> BackfillResult {
        let candidates = conversations.filter { !Self.transcript(for: $0).isEmpty }
        var newFactCount = 0
        var reviewed = 0
        var stoppedEarly = false
        for (index, conversation) in candidates.enumerated() {
            if isCancelled() || MemoryStore.shared.isFull {
                stoppedEarly = true
                break
            }

            let existing = MemoryStore.shared.memories.map(\.text)
            let prompt = backfillPrompt(transcript: Self.transcript(for: conversation), existing: existing)
            let history: [HistoryTurn] = [
                HistoryTurn(role: "system", content: backfillSystemPrompt),
                HistoryTurn(role: "user", content: prompt),
            ]

            if let raw = await BackgroundCompletion.requestRaw(history: history, customConfig: customConfig, localRecord: localRecord, aquaApiKey: aquaApiKey, modelId: modelId) {
                newFactCount += MemoryStore.shared.addExtracted(MemoryParsing.parseItems(from: raw))
            }
            reviewed = index + 1
            onProgress(reviewed, candidates.count, newFactCount)
        }
        return BackfillResult(conversationsReviewed: reviewed, conversationsTotal: candidates.count, factsAdded: newFactCount, stoppedEarly: stoppedEarly)
    }

    /// A capped, speaker-labeled transcript — real user/assistant turns
    /// only (tool-result and error messages are mechanical, not
    /// something a user "said," and would just dilute the extraction
    /// with noise). Capped in characters, not message count, matching
    /// every other request-size guard in this app (see
    /// `MCPConnectionStore.maxCatalogCharacters` for the same reasoning):
    /// an old conversation with hundreds of turns must never itself
    /// become the oversized-request problem this app has already had to
    /// fix more than once elsewhere.
    private static let maxTranscriptCharacters = 8000

    private static func transcript(for conversation: Conversation) -> String {
        let turns = conversation.messages.filter { $0.isToolResult != true && !$0.isError }
        var lines: [String] = []
        var used = 0
        for message in turns {
            let speaker = message.isUser ? "User" : "Assistant"
            let line = "\(speaker): \(message.content)"
            guard used + line.count <= maxTranscriptCharacters else { break }
            lines.append(line)
            used += line.count
        }
        return lines.joined(separator: "\n")
    }

    /// The shared definition of what's worth remembering — used verbatim by
    /// both extraction prompts so per-turn and backfill/file extraction
    /// never drift apart on what qualifies.
    private static let whatToRemember = """
    Reply with ONLY a JSON array (no markdown, no commentary) of objects like {"kind": "fact", "text": "..."} or {"kind": "event", "text": "..."}.
    - "fact": durable and HIGH-LEVEL — their name, role, location, relationships, preferences, and (at most) a single one-line summary of an ongoing project: what it's called and what it does. NEVER extract implementation detail as separate facts — file paths, folder structure, tool/function names, framework or library choices, entry points, build steps. That's the CONTENT of a coding task, not a fact about the user, and it's already useless the moment the project's architecture changes. Bad (never do this): {"text": "File structure: src/app.js, src/tools"}, {"text": "Tools: write_file, str_replace, read_file"}, {"text": "Framework: TypeScript"}, {"text": "Editor: Monaco"}. Good: {"text": "is building 'Lume Labs', an agentic AI coding platform"} — ONE fact, not ten.
    - "event": a happening in their life a thoughtful friend would remember and ask about later — a trip, an exam, an interview, being sick, a hard week, weekend plans, something they're excited or worried about. Keep any stated timing in the text itself (e.g. "has a math final on Friday").
    Extract ONLY from what the User themself wrote. The Assistant's words are context for understanding the User's message — never a source of facts; nothing the Assistant said, listed, or built qualifies on its own.
    Never include: one-off requests to the assistant (like a coding task, including its implementation details), facts about the assistant, anything already in the known list, guesses, or sensitive details (health, finances, other people's private information) beyond what the user plainly volunteered as worth remembering.
    When in doubt, extract NOTHING for that item — a handful of high-value facts beats a long list of granular ones; the model reading them back later has to make sense of the whole list at once, not just the one you're adding now.
    Reply with [] if nothing qualifies.
    """

    private static let systemPrompt = """
    You silently extract things worth remembering about a user, from one exchange of a chat, for a personalization feature.
    \(whatToRemember)
    """

    private static let backfillSystemPrompt = """
    You silently extract things worth remembering about a user, from text they shared or an existing chat transcript, for a personalization feature.
    \(whatToRemember)
    """

    private static func backfillPrompt(transcript: String, existing: [String]) -> String {
        let known = existing.isEmpty ? "(nothing yet)" : existing.map { "- \($0)" }.joined(separator: "\n")
        return """
        Already known about the user:
        \(known)

        Chat transcript:
        \(transcript)

        JSON array of NEW items worth remembering, or []:
        """
    }

    private static func buildPrompt(userText: String, assistantText: String, toolContext: String?, existing: [String]) -> String {
        let known = existing.isEmpty ? "(nothing yet)" : existing.map { "- \($0)" }.joined(separator: "\n")
        // The assistant reply is context only (the prompt says so
        // explicitly) — capped hard, because a long technical answer fed
        // in wholesale is exactly where a weak extractor model went
        // mining for "facts" that were really implementation details of
        // its own previous reply. The user's text keeps far more room:
        // it's the only sanctioned source.
        let cappedAssistant = String(assistantText.prefix(1_500))
        var sections = """
        Already known about the user:
        \(known)

        Latest exchange:
        User: \(String(userText.prefix(4_000)))
        Assistant (context only, never a source of facts): \(cappedAssistant)
        """
        if let toolContext, !toolContext.isEmpty {
            sections += """


            Results returned by services the user connected and consented to learn from (their calendar, issues, documents…):
            \(toolContext)
            """
        }
        sections += "\n\nJSON array of NEW items worth remembering, or []:"
        return sections
    }
}
