import Foundation

/// Turns the tool calls inside one assistant message into the compact step
/// trail, instead of one chip per call.
///
/// The problem this solves: a research turn makes a dozen searches, and the
/// transcript rendered every one as its own pill plus a results card between
/// them. That is a screenful of scaffolding around an answer nobody has read
/// yet — and worse, the repetition carries almost no information, because six
/// consecutive searches differ only in their query string.
///
/// So consecutive calls of the same kind fold into one row: the row says what
/// happened once ("Searched the web"), the count says how much of it there
/// was, and the individual calls sit behind the row's own disclosure for
/// anyone who wants them. Nothing is discarded — it stops being shouted.
enum AgentStepToolCalls {
    /// Builds the trail for a message. Returns an empty array when the
    /// message made no tool calls, so callers can simply skip the block.
    ///
    /// `isStreaming` marks the final group as still running, which is what
    /// gives the last row its shimmer while the turn is live.
    static func steps(from blocks: [MessageBlock], isStreaming: Bool) -> [AgentStep] {
        var calls: [Call] = []
        for block in blocks {
            guard case .code(let language, let code) = block else { continue }
            guard let call = Call(language: language, body: code) else { continue }
            calls.append(call)
        }
        guard !calls.isEmpty else { return [] }

        // Fold runs of the same kind together. Deliberately only CONSECUTIVE
        // runs: "searched, read, searched" is a real back-and-forth, and
        // collapsing it to "searched ×2, read" would misreport the order the
        // work actually happened in.
        var groups: [[Call]] = []
        for call in calls {
            if var last = groups.last, last.first?.kind == call.kind {
                last.append(call)
                groups[groups.count - 1] = last
            } else {
                groups.append([call])
            }
        }

        return groups.enumerated().map { index, group in
            let isLastGroup = index == groups.count - 1
            return step(for: group, running: isStreaming && isLastGroup)
        }
    }

    private static func step(for group: [Call], running: Bool) -> AgentStep {
        let kind = group[0].kind
        let count = group.count
        let labels = group.map(\.label)

        // One call needs no rollup — the label already says everything, and a
        // "1 item" disclosure would be pure friction.
        if count == 1 {
            return AgentStep(
                toolLabel: group[0].headline(count: 1),
                kind: kind,
                chips: group[0].chip.map { [$0] } ?? [],
                status: running ? .running : .done
            )
        }

        return AgentStep(
            toolLabel: group[0].headline(count: count),
            kind: kind,
            details: labels,
            detailsSummary: summary(for: kind, count: count),
            status: running ? .running : .done
        )
    }

    private static func summary(for kind: AgentStep.Kind, count: Int) -> String {
        switch kind {
        case .searching: return "\(count) searches"
        case .browsing:  return "Opened \(count) pages"
        case .reading:   return "Explored \(count) files"
        case .writing:   return "Changed \(count) files"
        case .running:   return "Ran \(count) commands"
        case .thinking:  return "\(count) steps"
        }
    }

    // MARK: - One parsed call

    /// A single tool fence, reduced to the two things the trail needs: what
    /// kind of work it is, and a one-line human label.
    private struct Call {
        let kind: AgentStep.Kind
        /// The specific thing — a query, a path, a command.
        let subject: String?
        /// The tool's own name, for the fallback label.
        let toolName: String

        var chip: String? { subject }

        /// "Search: swift concurrency" — what the individual call was, shown
        /// inside the disclosure.
        var label: String {
            guard let subject, !subject.isEmpty else { return verb(count: 1) }
            return "\(verb(count: 1)): \(subject)"
        }

        /// The row's own headline. Plural once a run is folded together, so
        /// "Searched the web" reads correctly whether it stands for one call
        /// or six.
        func headline(count: Int) -> String {
            switch kind {
            case .searching: return "Searched the web"
            case .browsing:  return count == 1 ? "Read a page" : "Read \(count) sources"
            case .reading:   return count == 1 ? "Read a file" : "Read \(count) files"
            case .writing:   return count == 1 ? "Edited a file" : "Edited \(count) files"
            case .running:   return count == 1 ? "Ran a command" : "Ran \(count) commands"
            case .thinking:  return toolName
            }
        }

        private func verb(count: Int) -> String {
            switch kind {
            case .searching: return "Search"
            case .browsing:  return "Open"
            case .reading:   return "Read"
            case .writing:   return "Edit"
            case .running:   return "Run"
            case .thinking:  return toolName
            }
        }

        /// Recognizes the same fence shapes the executor does — the canonical
        /// `eaon:computer tool="…"`, the bare tool-name shorthand, the legacy
        /// `aqua:` prefix, and `eaon:search`. Anything that isn't a tool call
        /// returns nil and is left to render as ordinary content.
        init?(language: String?, body: String) {
            let fence = WorkspaceParser.fenceInfo(from: language)

            // Resolve the fence to a tool kind the same way display already
            // does elsewhere, so the trail and the chips can never disagree
            // about what counts as a tool call.
            let resolved: String? = {
                if let lang = fence.language, lang.hasPrefix("eaon:") || lang.hasPrefix("aqua:") { return lang }
                if let lang = fence.language, let kind = WorkspaceParser.prefixlessToolKind(lang) { return "eaon:" + kind }
                return nil
            }()
            guard let fenceLanguage = resolved else { return nil }

            let kindToken = String(fenceLanguage.dropFirst(5))
            // A plain file write renders as its own diff card, not a step —
            // the diff IS the content, and folding it into a one-line row
            // would hide the thing the user most wants to see.
            guard kindToken != "write" else { return nil }

            let tool = DesktopTool(rawValue: kindToken)?.rawValue ?? fence.tool
            self.toolName = tool ?? kindToken

            if kindToken == "search" {
                self.kind = .searching
                self.subject = Self.jsonValue(named: "query", in: body) ?? Self.firstLine(of: body)
                return
            }

            guard let tool else {
                self.kind = .thinking
                self.subject = nil
                return
            }

            switch tool {
            case "web_search":
                self.kind = .searching
                self.subject = Self.jsonValue(named: "query", in: body)
            case "browser_read", "browser_tabs", "open_url", "browser_click", "browser_type", "browser_scroll":
                self.kind = .browsing
                self.subject = Self.jsonValue(named: "url", in: body) ?? Self.jsonValue(named: "text", in: body)
            case "read_file", "list_directory", "find_files", "search_code":
                self.kind = .reading
                self.subject = Self.jsonValue(named: "path", in: body).map(Self.lastComponent)
                    ?? Self.jsonValue(named: "pattern", in: body)
            case "write_file", "edit_file", "create_folder", "move_item", "trash_item":
                self.kind = .writing
                self.subject = Self.jsonValue(named: "path", in: body).map(Self.lastComponent)
            case "run_shell":
                self.kind = .running
                self.subject = Self.jsonValue(named: "command", in: body)
            default:
                self.kind = .thinking
                self.subject = nil
            }
        }

        /// Pulls one string value out of the fence's JSON body without fully
        /// decoding it — the body can be a partially-streamed fragment, and a
        /// strict parse would simply fail on every frame until the call
        /// finished, leaving the row blank exactly while it's most alive.
        private static func jsonValue(named key: String, in body: String) -> String? {
            guard let keyRange = body.range(of: "\"\(key)\"") else { return nil }
            let after = body[keyRange.upperBound...]
            guard let colon = after.firstIndex(of: ":") else { return nil }
            let rest = after[after.index(after: colon)...]
            guard let openQuote = rest.firstIndex(of: "\"") else { return nil }

            var value = ""
            var index = rest.index(after: openQuote)
            while index < rest.endIndex {
                let character = rest[index]
                if character == "\\" {
                    let next = rest.index(after: index)
                    guard next < rest.endIndex else { break }
                    // Only the escapes that actually show up in a path or a
                    // query need unescaping for a one-line label.
                    switch rest[next] {
                    case "n": value.append(" ")
                    case "t": value.append(" ")
                    default: value.append(rest[next])
                    }
                    index = rest.index(after: next)
                    continue
                }
                if character == "\"" { break }
                value.append(character)
                index = rest.index(after: index)
            }
            let trimmed = value.trimmingCharacters(in: .whitespacesAndNewlines)
            guard !trimmed.isEmpty else { return nil }
            return trimmed.count > 80 ? String(trimmed.prefix(79)) + "…" : trimmed
        }

        private static func firstLine(of body: String) -> String? {
            body.split(separator: "\n").first.map { $0.trimmingCharacters(in: .whitespaces) }
        }

        private static func lastComponent(_ path: String) -> String {
            (path as NSString).lastPathComponent
        }
    }
}
