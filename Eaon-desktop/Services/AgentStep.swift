import Foundation

/// One thing the agent did, for the step trail shown while it works.
///
/// Eaon already publishes a live status line for every tool path
/// (`agentActivityText`). This turns that stream of strings into a list, and
/// pulls the few structured details worth showing separately: which kind of
/// work it is, and what it touched.
///
/// Parsed from the status text rather than reported by each tool. That is
/// the less obvious choice, and it is the right one here: a step log the
/// tools had to remember to append to goes stale the first time somebody
/// adds a tool and forgets, whereas parsing degrades to a plain untyped row
/// and keeps working.
struct AgentStep: Identifiable, Equatable {
    enum Status: Equatable { case running, done }

    /// The shape of the work, which picks the icon. Deliberately coarse:
    /// these are the distinctions worth a glance while scrolling past, not a
    /// taxonomy of every tool.
    enum Kind: Equatable {
        case searching
        case browsing
        case reading
        case writing
        case running
        case thinking

        var symbol: String {
            switch self {
            case .searching: return "magnifyingglass"
            case .browsing:  return "globe"
            case .reading:   return "doc.text"
            case .writing:   return "square.and.pencil"
            case .running:   return "terminal"
            case .thinking:  return "cpu"
            }
        }
    }

    let id = UUID()
    /// The status line as published, minus any trailing ellipsis — the row's
    /// own dimming already says it's in progress, so the dots are noise.
    var title: String
    var kind: Kind
    /// Things the step touched: domains searched, files read. Rendered as
    /// chips under the title.
    var chips: [String]
    /// Secondary prose under the label — the model's own reasoning for this
    /// step, when there is any. Wraps and is never truncated: the whole
    /// point of showing it is that it's readable.
    var detail: String?
    /// The individual calls folded into this row, revealed by a nested
    /// disclosure ("Explored 6 files ›"). This is what lets one row stand
    /// for six searches without hiding what they actually were: the count is
    /// the headline, the list is there when you want it.
    var details: [String] = []
    /// Label for that disclosure. Nil falls back to a plain count.
    var detailsSummary: String?
    var status: Status

    init(title raw: String, detail: String? = nil, status: Status = .running) {
        self.detail = detail
        let trimmed = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        let stripped = trimmed
            .replacingOccurrences(of: "…", with: "")
            .trimmingCharacters(in: .whitespaces)
        self.kind = Self.kind(for: stripped)
        self.chips = Self.chips(in: stripped)
        // Once the chips carry the specifics, the title shouldn't repeat
        // them: "Searching the web for "swift concurrency"" becomes
        // "Searching the web" with the query on its own line beneath.
        self.title = Self.headline(from: stripped, hasChips: !chips.isEmpty)
        self.status = status
    }

    /// A step for a tool call already parsed out of a message, where the
    /// label has been resolved by the chip logic and there is nothing to
    /// guess at.
    init(
        toolLabel: String,
        kind: Kind,
        chips: [String] = [],
        detail: String? = nil,
        details: [String] = [],
        detailsSummary: String? = nil,
        status: Status = .done
    ) {
        self.title = toolLabel
        self.kind = kind
        self.chips = chips
        self.detail = detail
        self.details = details
        self.detailsSummary = detailsSummary
        self.status = status
    }

    private static func kind(for text: String) -> Kind {
        let t = text.lowercased()
        if t.contains("search") { return .searching }
        if t.contains("brows") || t.contains("page") || t.contains("url") || t.contains("http") { return .browsing }
        if t.hasPrefix("reading") || t.contains("read_file") { return .reading }
        if t.contains("write") || t.contains("edit") { return .writing }
        if t.hasPrefix("running") || t.contains("shell") || t.contains("command") { return .running }
        return .thinking
    }

    /// Pulls quoted fragments and bare domains out of a status line. Both are
    /// the specifics worth showing: what was searched for, which site was
    /// read.
    private static func chips(in text: String) -> [String] {
        var found: [String] = []
        // "Searching the web for "…"" and 'Reading "…"'.
        for quote in ["\"", "\u{201C}"] {
            let close = quote == "\"" ? "\"" : "\u{201D}"
            if let open = text.range(of: quote),
               let shut = text.range(of: close, range: open.upperBound..<text.endIndex) {
                let inner = String(text[open.upperBound..<shut.lowerBound])
                    .trimmingCharacters(in: .whitespaces)
                if !inner.isEmpty, inner.count <= 48 { found.append(inner) }
                break
            }
        }
        if found.isEmpty {
            for token in text.split(whereSeparator: { " (),".contains($0) }) {
                let s = String(token).trimmingCharacters(in: CharacterSet(charactersIn: ".,:"))
                if s.contains("."), !s.hasSuffix("."), s.count >= 4, s.count <= 40,
                   !s.contains("/"), s.rangeOfCharacter(from: .whitespaces) == nil {
                    found.append(s)
                }
            }
        }
        return Array(found.prefix(3))
    }

    private static func headline(from text: String, hasChips: Bool) -> String {
        guard hasChips else { return text }
        // Cut at the quote or the trailing "for", whichever comes first, so
        // the row reads as a verb phrase.
        for marker in [" for \"", " \"", " for \u{201C}", " \u{201C}"] {
            if let r = text.range(of: marker) { return String(text[..<r.lowerBound]) }
        }
        return text
    }
}

extension AgentStep {
    /// Splits a raw reasoning trace into dot-mode steps.
    ///
    /// A `<think>` block arrives as one undivided wall of prose, which is
    /// exactly why it was hidden behind a disclosure: there was nothing to
    /// show but a paragraph nobody reads. Models do, however, paragraph
    /// their reasoning, and a paragraph is a step — so the first sentence
    /// becomes a label and the rest becomes the description under it.
    ///
    /// This is a presentation split, not a claim about the model's actual
    /// structure. It degrades safely: prose with no blank lines yields a
    /// single step, which is precisely the old behaviour.
    static func reasoningSteps(from reasoning: String, isInProgress: Bool) -> [AgentStep] {
        let paragraphs = reasoning
            .components(separatedBy: "\n\n")
            .map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }
            .filter { !$0.isEmpty }
        guard !paragraphs.isEmpty else { return [] }

        return paragraphs.enumerated().map { index, para in
            let (label, detail) = splitLabel(from: para)
            // Only the last one can still be running, and only while the
            // trace is actually open.
            let running = isInProgress && index == paragraphs.count - 1
            return AgentStep(
                toolLabel: label,
                kind: .thinking,
                detail: detail,
                status: running ? .running : .done
            )
        }
    }

    /// First sentence becomes the label, the remainder the description. A
    /// paragraph short enough to read at a glance stays whole, since
    /// splitting it would leave an empty-looking description.
    private static func splitLabel(from paragraph: String) -> (String, String?) {
        let flat = paragraph.replacingOccurrences(of: "\n", with: " ")
        guard flat.count > 80 else { return (flat, nil) }

        // Break at the first sentence end that leaves a usable label.
        for terminator in [". ", "? ", "! ", ": "] {
            if let r = flat.range(of: terminator), flat.distance(from: flat.startIndex, to: r.lowerBound) >= 12 {
                let label = String(flat[..<r.lowerBound])
                let rest = String(flat[r.upperBound...]).trimmingCharacters(in: .whitespaces)
                if label.count <= 90 { return (label, rest.isEmpty ? nil : rest) }
            }
        }
        // No sentence break early enough: use a clipped opening as the label
        // and keep the whole paragraph as the body, rather than cutting a
        // sentence in half and losing the words.
        let cut = flat.prefix(72)
        let label = (cut.last == " " ? String(cut.dropLast()) : String(cut)) + "…"
        return (label, flat)
    }
}
