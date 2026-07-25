import Foundation

/// One persona the creator invented for this task — an engineer, a design
/// specialist, a security reviewer, whoever the work actually calls for.
/// `role` is the one-line brief that becomes that persona's system prompt, so
/// each one argues from a genuinely different vantage point instead of all ten
/// being the same assistant wearing different name tags.
struct SwarmPersona: Codable, Equatable {
    let name: String
    let role: String
}

/// One thing a persona said in the discussion. `wantsToEnd` is that persona's
/// vote on the same turn it spoke — see `AgentSwarmRunner` for why the vote
/// rides along with the remark instead of being its own round of calls.
struct SwarmRemark: Codable, Equatable {
    let personaName: String
    let round: Int
    var text: String
    var wantsToEnd: Bool = false
    var isError: Bool = false
}

/// A finished swarm run: who was convened, everything they said, and how it
/// ended. Embedded verbatim (base64 JSON) in the synthesized reply's own
/// `content` — see `SwarmPanelExtractor` — so it persists and redisplays
/// exactly like everything else in a saved conversation, with no
/// `ChatMessage` schema change needed.
struct SwarmTranscript: Codable, Equatable {
    let task: String
    var personas: [SwarmPersona] = []
    var remarks: [SwarmRemark] = []
    /// True when the swarm stopped because enough personas voted to hand off,
    /// false when it ran out of rounds — shown on the card so a swarm that
    /// never reached consensus doesn't silently look like one that did.
    var endedByVote: Bool = false
    var roundsUsed: Int = 0

    /// Remarks that actually carry something to synthesize from.
    var usableRemarks: [SwarmRemark] { remarks.filter { !$0.isError && !$0.text.isEmpty } }
}

/// Runs an **Agent Swarm**: instead of one model reasoning to itself, a
/// creator convenes a roster of personas for the specific task, those personas
/// argue it out in rounds, and the discussion ends when enough of them vote to
/// hand off. The synthesis is deliberately NOT done here — the finished
/// transcript is fed to the app's normal generation pipeline as system context
/// (see `SwarmPanelExtractor.synthesisInstruction` and
/// `ChatViewModel.systemPromptHistory`), so the reply the user actually reads
/// goes through the exact same routing, streaming, typewriter, and — the whole
/// point in Eaon Work — the same agent tool loop that writes real files. The
/// swarm decides *what* to build; the normal pipeline builds it.
///
/// Every call routes through `BackgroundCompletion`, so a swarm runs on
/// whatever model the user picked — hosted, BYOK, or a local Ollama model.
/// That mattered enough to shape the design: a feature that silently needs an
/// account isn't a mode you can offer next to "Agent." (Swarm replaced the
/// old hosted-only `/reasoning` debate panel, which had exactly that flaw.)
@MainActor
enum AgentSwarmRunner {
    /// Roster bounds. The creator picks the number to fit the task; these only
    /// stop a runaway answer (or a one-persona "swarm", which is just Agent).
    static let minPersonas = 3
    static let maxPersonas = 10
    /// Discussion rounds before the swarm is cut off regardless of the vote.
    /// Each round is one sequential call per persona, so this is the main cost
    /// and latency dial — 3 rounds of 6 personas is already ~18 calls.
    static let maxRounds = 3
    /// How many personas must vote to end before the discussion hands off.
    /// The user's rule, and a sensible one: one impatient persona shouldn't be
    /// able to cut off a debate the rest are still mid-way through.
    static let votesToEnd = 3

    struct Route {
        let customConfig: CustomProviderConfig?
        let localRecord: LocalModelRecord?
        let apiKey: String?
        let modelId: String
    }

    static func run(
        task: String,
        route: Route,
        onStatus: @escaping (String) -> Void
    ) async -> SwarmTranscript {
        var transcript = SwarmTranscript(task: task)

        onStatus("Swarm — convening specialists for this task…")
        transcript.personas = await createPersonas(task: task, route: route)
        guard transcript.personas.count >= minPersonas else {
            // Nothing usable came back (offline, a model that can't follow the
            // JSON instruction). Returning an empty roster lets the caller
            // skip the whole feature for this turn and answer normally, rather
            // than staging a "discussion" between zero people.
            return transcript
        }

        var round = 1
        while round <= maxRounds {
            if Task.isCancelled { break }
            var endVotesThisRound = 0

            for persona in transcript.personas {
                if Task.isCancelled { break }
                onStatus("Swarm — round \(round): \(persona.name) is weighing in…")
                let prompt = discussionPrompt(
                    task: task,
                    persona: persona,
                    transcript: transcript,
                    round: round,
                    isFinalRound: round == maxRounds
                )
                let raw = await BackgroundCompletion.requestRaw(
                    history: [
                        HistoryTurn(role: "system", content: personaSystemPrompt(persona)),
                        HistoryTurn(role: "user", content: prompt),
                    ],
                    customConfig: route.customConfig,
                    localRecord: route.localRecord,
                    aquaApiKey: route.apiKey,
                    modelId: route.modelId
                )
                guard let raw, !raw.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
                    transcript.remarks.append(SwarmRemark(
                        personaName: persona.name, round: round, text: "", isError: true
                    ))
                    continue
                }
                let (body, wantsToEnd) = splitVote(from: raw)
                transcript.remarks.append(SwarmRemark(
                    personaName: persona.name, round: round, text: body, wantsToEnd: wantsToEnd
                ))
                if wantsToEnd { endVotesThisRound += 1 }
            }

            transcript.roundsUsed = round
            // The vote is only meaningful once everyone has actually spoken at
            // least once — otherwise a swarm could disband before the later
            // personas in the roster ever got a turn.
            if endVotesThisRound >= votesToEnd {
                transcript.endedByVote = true
                break
            }
            round += 1
        }

        onStatus("Swarm — the specialists are handing off…")
        return transcript
    }

    // MARK: - Creator

    /// The creator step: reads the task and invents the roster to argue it.
    /// Asked for strict JSON and parsed leniently (models love to wrap it in a
    /// fence); a roster that can't be parsed returns empty and the caller
    /// falls back to a normal answer rather than inventing a generic panel
    /// that has nothing to do with the request.
    private static func createPersonas(task: String, route: Route) async -> [SwarmPersona] {
        let prompt = """
        You are the CREATOR of an agent swarm. Read the task below and assemble the team best suited to argue it out before any work starts.

        Task:
        \(task)

        Pick between \(minPersonas) and \(maxPersonas) specialists whose expertise genuinely bears on THIS task — not a generic panel. For a UI feature that might be a frontend engineer, a design specialist, and an accessibility reviewer; for a data pipeline it would be someone else entirely. Give each a distinct point of view so they have something to actually disagree about.

        Reply with ONLY a JSON array, no prose and no code fence:
        [{"name": "Engineer", "role": "one line describing what this persona cares about and argues for"}]
        """
        let raw = await BackgroundCompletion.requestRaw(
            history: [HistoryTurn(role: "user", content: prompt)],
            customConfig: route.customConfig,
            localRecord: route.localRecord,
            aquaApiKey: route.apiKey,
            modelId: route.modelId
        )
        guard let raw else { return [] }
        return parsePersonas(raw)
    }

    /// Pulls the JSON array out of whatever the model actually returned —
    /// bare, fenced, or with a sentence in front of it.
    static func parsePersonas(_ raw: String) -> [SwarmPersona] {
        guard let start = raw.firstIndex(of: "["), let end = raw.lastIndex(of: "]"), start < end else {
            return []
        }
        let slice = String(raw[start...end])
        guard let data = slice.data(using: .utf8),
              let parsed = try? JSONDecoder().decode([SwarmPersona].self, from: data) else {
            return []
        }
        return parsed
            .filter { !$0.name.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty }
            .prefix(maxPersonas)
            .map { $0 }
    }

    // MARK: - Discussion

    private static func personaSystemPrompt(_ persona: SwarmPersona) -> String {
        """
        You are \(persona.name), one member of a swarm of specialists deciding how to approach a task together.

        Your perspective: \(persona.role)

        Argue from that perspective specifically. Be concrete and brief — a few sentences, the way someone actually talks in a design discussion, not a document. Disagree with the others by name where you genuinely do, and say why. Don't restate what someone already said just to agree; add something or push back. You are NOT doing the work itself and must not write the final code — the swarm is deciding WHAT to build and HOW, and a synthesizer writes it afterwards.
        """
    }

    private static func discussionPrompt(
        task: String,
        persona: SwarmPersona,
        transcript: SwarmTranscript,
        round: Int,
        isFinalRound: Bool
    ) -> String {
        let roster = transcript.personas
            .map { "- \($0.name): \($0.role)" }
            .joined(separator: "\n")
        let saidSoFar = transcript.usableRemarks
            .map { "\($0.personaName): \($0.text)" }
            .joined(separator: "\n\n")
        let discussion = saidSoFar.isEmpty
            ? "Nobody has spoken yet — you're opening the discussion."
            : saidSoFar

        let votingRule = isFinalRound
            ? "This is the final round, so the discussion ends after it regardless of the vote."
            : "The discussion ends as soon as \(votesToEnd) specialists vote END in the same round."

        return """
        The task the swarm is deciding how to approach:
        \(task)

        The swarm:
        \(roster)

        The discussion so far:
        \(discussion)

        It's your turn (round \(round) of at most \(maxRounds)). Say your piece as \(persona.name).

        Then, on the very last line and nothing after it, vote on whether the swarm has settled this enough to hand off to the synthesizer who writes the actual code:
        VOTE: END        (you're satisfied — the approach is clear enough to build)
        VOTE: CONTINUE   (something important is still unresolved)

        \(votingRule) Vote END only when you genuinely think the open questions are answered — voting END early to be agreeable produces worse work than one more round would have.
        """
    }

    /// Splits a persona's reply into what they said and how they voted. The
    /// vote rides on the same call as the remark rather than being its own
    /// round of requests: a swarm is already N calls per round, and doubling
    /// that to poll for a yes/no would double the cost and the wait for
    /// information the persona can just state as it finishes talking.
    ///
    /// Absent or unreadable vote line reads as CONTINUE — the safe default,
    /// since the failure mode is one more round of discussion rather than a
    /// swarm that disbands before it has decided anything.
    static func splitVote(from raw: String) -> (text: String, wantsToEnd: Bool) {
        var lines = raw.trimmingCharacters(in: .whitespacesAndNewlines)
            .components(separatedBy: .newlines)
        var wantsToEnd = false
        // Scan from the end: models sometimes add a blank line (or a stray
        // closing remark) after the vote they were told to put last.
        for index in lines.indices.reversed() {
            let line = lines[index].trimmingCharacters(in: .whitespacesAndNewlines)
            guard !line.isEmpty else { continue }
            let upper = line.uppercased()
            guard upper.contains("VOTE:") else { break }
            wantsToEnd = upper.contains("END")
            lines.remove(at: index)
            break
        }
        let text = lines.joined(separator: "\n").trimmingCharacters(in: .whitespacesAndNewlines)
        return (text, wantsToEnd)
    }
}

/// Embeds/extracts a finished `SwarmTranscript` inside a message's raw text,
/// the same trick `<think>` tags already use for a model's own reasoning trace
/// (see `ReasoningExtractor`):
/// no `ChatMessage` schema change, and it persists/redisplays for free because
/// `content` already round-trips through `Codable`/UserDefaults. Base64 rather
/// than raw JSON: the alphabet (`A–Za–z0–9+/=`) contains no `<`, `>`, or
/// `` ` ``, so a persona's own words can never forge a closing tag or a fence
/// the workspace parser would misread.
enum SwarmPanelExtractor {
    private static let openTag = "<eaon-swarm-panel>"
    private static let closeTag = "</eaon-swarm-panel>"

    /// Prepended to the synthesized reply once the swarm finishes and BEFORE
    /// that reply starts streaming, so the card is complete from the first
    /// render — never partially streamed the way a live `<think>` block is.
    static func encode(_ transcript: SwarmTranscript) -> String {
        guard let data = try? JSONEncoder().encode(transcript) else { return "" }
        return openTag + data.base64EncodedString() + closeTag + "\n\n"
    }

    struct Result {
        let transcript: SwarmTranscript?
        /// `raw` with the swarm block removed — what every other piece of
        /// message rendering should treat as "the message."
        let remainder: String
    }

    static func extract(from raw: String) -> Result {
        guard raw.hasPrefix(openTag), let closeRange = raw.range(of: closeTag) else {
            return Result(transcript: nil, remainder: raw)
        }
        let encodedStart = raw.index(raw.startIndex, offsetBy: openTag.count)
        let encoded = String(raw[encodedStart..<closeRange.lowerBound])
        let remainder = String(raw[closeRange.upperBound...])
            .trimmingCharacters(in: .whitespacesAndNewlines)
        guard let data = Data(base64Encoded: encoded),
              let transcript = try? JSONDecoder().decode(SwarmTranscript.self, from: data) else {
            return Result(transcript: nil, remainder: raw)
        }
        return Result(transcript: transcript, remainder: remainder)
    }

    /// The system-context turn the synthesizer reads — placed last, right
    /// before the user's own message, mirroring how `activeSkillForTurn` puts
    /// the freshest, most specific instruction closest to the request.
    static func synthesisInstruction(for transcript: SwarmTranscript) -> String {
        let roster = transcript.personas
            .map { "- \($0.name): \($0.role)" }
            .joined(separator: "\n")
        let discussion = transcript.usableRemarks
            .map { "[Round \($0.round)] \($0.personaName): \($0.text)" }
            .joined(separator: "\n\n")
        let ending = transcript.endedByVote
            ? "They voted to hand off, so they consider the approach settled."
            : "They ran out of discussion rounds before reaching a vote, so treat the open disagreements as genuinely unresolved and use your own judgement on them."

        return """
        You are the SYNTHESIZER of an agent swarm. Before this message, a swarm of specialists was convened for the user's task and argued out how it should be approached. \(ending)

        The swarm:
        \(roster)

        [Swarm discussion — "\(transcript.task)"]

        \(discussion)

        Now do the actual work. Build what they agreed on, in full — the specialists deliberately did not write any code themselves, so nothing is done yet and you are writing it from scratch. Where they disagreed, pick the stronger argument and go with it rather than hedging or building both. Where they missed something, fix it silently. Don't narrate the discussion back to the user or describe what each persona thought — they can already read it. Just deliver the finished work.
        """
    }
}
