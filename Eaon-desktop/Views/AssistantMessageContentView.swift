import SwiftUI

struct AssistantMessageContentView: View {
    let text: String
    let isTyping: Bool
    /// Called with a file path when the user clicks a workspace file card —
    /// nil (the default) leaves plain code-block rendering untouched for any
    /// caller that isn't wired into the workspace panel.
    var onOpenWorkspaceFile: ((String) -> Void)? = nil
    /// Real status text for a local model still loading — nil shows the
    /// plain pulsing dot exactly as before.
    var loadingStatusText: String? = nil

    /// Reasoning extraction + block parsing memoized together — these were
    /// computed properties re-running their string scans two to three times
    /// per body evaluation (body read `extracted` twice and `blocks` once,
    /// and `blocks` itself re-ran `extracted`), on every typewriter tick
    /// while streaming and on every scroll-in of a row. One cache entry per
    /// distinct message text makes a finished message's re-render a lookup.
    ///
    /// The two step lists live in here too, and must stay here. Both scan
    /// the whole message (paragraph splitting for the reasoning trail, a
    /// fence walk for the tool trail), and computing them in `body` instead
    /// put those scans back on exactly the path this cache exists to keep
    /// clear: every typewriter tick of a live reply, and every scroll-in of
    /// a finished one. A finished message must be a pure lookup.
    private var parsed: (
        swarm: SwarmTranscript?,
        extracted: ReasoningExtractor.Result,
        blocks: [MessageBlock],
        reasoningSteps: [AgentStep],
        toolSteps: [AgentStep]
    ) {
        RenderCache.shared.value("msg|\(text)|\(isTyping)", store: !isTyping) {
            // The swarm discussion (if one ran) is a fixed prefix written once
            // that work finishes, always complete from the first render —
            // unlike `<think>`, it's never partially streamed, so there's no
            // in-progress state to track here.
            let swarmResult = SwarmPanelExtractor.extract(from: text)
            let extracted = ReasoningExtractor.extract(from: swarmResult.remainder)
            let blocks = MessageContentParser.parse(extracted.visibleContent)
            let reasoningSteps = extracted.reasoning.map {
                AgentStep.reasoningSteps(from: $0, isInProgress: extracted.isReasoningInProgress)
            } ?? []
            let toolSteps = AgentStepToolCalls.steps(from: blocks, isStreaming: isTyping)
            return (swarmResult.transcript, extracted, blocks, reasoningSteps, toolSteps)
        }
    }

    var body: some View {
        let (swarm, extracted, blocks, reasoningSteps, toolSteps) = parsed
        VStack(alignment: .leading, spacing: 12) {
            if let swarm {
                SwarmPanelDisclosure(transcript: swarm)
            }
            if !reasoningSteps.isEmpty {
                // Dot mode: the trace is prose, and a column of different
                // glyphs beside paragraphs of reasoning claims a taxonomy
                // that isn't there. One mark per step, hollow while open.
                ThinkingSteps(
                    steps: reasoningSteps,
                    title: "Thinking",
                    showIcons: false
                )
            }

            // Every tool call in this message as ONE collapsible trail,
            // rather than a pill per call with a results card between them.
            // See `AgentStepToolCalls` for why the calls are folded.
            if !toolSteps.isEmpty {
                ThinkingSteps(steps: toolSteps, title: "Worked on it")
            }

            if blocks.isEmpty {
                // The reasoning disclosure above already communicates "still
                // working" while a <think> block is open or just closed —
                // showing the plain pulsing dot too would say the same thing
                // twice.
                if isTyping, extracted.reasoning == nil {
                    ThinkingIndicator(statusText: loadingStatusText ?? "Thinking…")
                }
            } else {
                ForEach(Array(blocks.enumerated()), id: \.offset) { index, block in
                    blockView(block, index: index, blockCount: blocks.count)
                }
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .animation(nil, value: text)
    }

    @ViewBuilder
    private func blockView(_ block: MessageBlock, index: Int, blockCount: Int) -> some View {
        let isLast = index == blockCount - 1
        let showCursor = isTyping && isLast

        switch block {
        case .text(let content):
            if !content.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                MarkdownBlockView(text: content)
            } else if showCursor {
                ThinkingIndicator(statusText: "Thinking…")
            }

        case .code(let language, let code):
            // eaon:* fences are agent tool requests (run/edit/read/ls/mcp) —
            // a small action chip; a fence carrying a file attribute is a
            // workspace file — a compact card (the code itself lives in the
            // workspace panel, the way Cursor/Lovable summarize in chat).
            let fence = WorkspaceParser.fenceInfo(from: language)
            // aqua: is the legacy prefix — old conversations are full of
            // it, and their chips must keep rendering as chips. A model
            // that drops the eaon:/aqua: prefix entirely (```computer,
            // ```write_file, …) still executes — see
            // `WorkspaceParser.prefixlessToolKind` — so display must
            // recognize the identical shorthand, or a call that worked
            // would render as an unrecognized raw code block.
            let resolvedFenceLanguage: String? = {
                if let lang = fence.language, lang.hasPrefix("eaon:") || lang.hasPrefix("aqua:") { return lang }
                if let lang = fence.language, let kind = WorkspaceParser.prefixlessToolKind(lang) { return "eaon:" + kind }
                return nil
            }()
            if let fenceLanguage = resolvedFenceLanguage, fenceLanguage != "eaon:write", fenceLanguage != "aqua:write" {
                let kind = String(fenceLanguage.dropFirst(5))
                // The bare tool-name shorthand (```write_file, no
                // tool="..." attribute at all) names the tool as the kind
                // itself; the canonical ```eaon:computer form names it in
                // the tool="..." attribute. Resolving through DesktopTool
                // covers both the same way the execution parser does.
                let computerTool = DesktopTool(rawValue: kind)?.rawValue ?? fence.tool
                if kind == "computer" || DesktopTool(rawValue: kind) != nil,
                   let computerTool, ["write_file", "edit_file"].contains(computerTool) {
                    FileDiffCard(toolName: computerTool, argumentsJSON: code, fencePath: fence.rawPath, isStreaming: showCursor)
                } else {
                    // Nothing here: this call is already a row in the trail
                    // above (`AgentStepToolCalls`). A chip as well would say
                    // the same thing twice, which is the sprawl the trail
                    // exists to replace. File writes/edits are the deliberate
                    // exception handled just above — their diff is content
                    // the user wants to see, not process noise.
                    EmptyView()
                }
            } else if let path = fence.path {
                WorkspaceFileCard(path: path, code: code, isStreaming: showCursor) {
                    onOpenWorkspaceFile?(path)
                }
            } else {
                CodeBlockView(
                    language: language,
                    code: code,
                    showTypingCursor: showCursor
                )
            }
        }
    }
}

/// Inline chip for an agent tool request (run/edit/read/ls). The request is
/// summarized here; its outcome arrives in the following results card and
/// streams into the workspace console.
struct ToolActionChip: View {
    @Environment(\.themeColors) private var colors
    let kindToken: String
    let path: String?
    /// The `tool="..."` attribute for "mcp"; for "computer" this instead
    /// carries the resolved DesktopTool name (e.g. "run_shell") — either
    /// from the canonical `tool="..."` attribute or the bare-shorthand
    /// fence kind itself (```run_shell). Both are "which real action is
    /// this," just spelled differently depending on the fence form.
    var toolName: String? = nil
    /// The `server="..."` attribute — only meaningful for the "mcp" kind.
    /// Drives the real service badge/name shown in place of the generic
    /// icon, now that more than one service can be connected at once.
    var serverId: String? = nil
    /// The fence body — populated (by the caller) for "search" (its query
    /// lives in JSON rather than an attribute) and for every "computer"
    /// call (path/command/etc. all live in JSON there too). Parsed
    /// leniently since it can be a partial, still-streaming JSON fragment.
    var bodyText: String? = nil
    var isStreaming: Bool = false

    private var kind: String { String(kindToken.dropFirst("eaon:".count)) }
    private var server: MCPServerDefinition? { serverId.flatMap(MCPCatalog.definition(for:)) }

    private var searchQuery: String? {
        guard let bodyText, let data = bodyText.data(using: .utf8),
              let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let query = object["query"] as? String, !query.isEmpty else { return nil }
        return query
    }

    /// Memoized — `label`/`computerLabel` call `arg()` up to twice per
    /// render, and each `computerArgs` access was a fresh JSONSerialization
    /// parse of the fence body. Small JSON, but it ran on every tick of a
    /// streaming reply; a lookup is effectively free.
    private var computerArgs: [String: Any]? {
        guard let bodyText, let data = bodyText.data(using: .utf8) else { return nil }
        return RenderCache.shared.value("chipargs|\(bodyText)", store: !isStreaming) {
            try? JSONSerialization.jsonObject(with: data) as? [String: Any]
        }
    }

    private func arg(_ key: String) -> String? { computerArgs?[key] as? String }
    private func lastComponent(_ path: String?) -> String { path.map { ($0 as NSString).lastPathComponent } ?? "?" }

    private var icon: String {
        switch kind {
        case "run": return "play.fill"
        case "edit": return "pencil"
        case "read": return "eye"
        case "mcp": return "bolt.horizontal.circle"
        case "search": return "magnifyingglass"
        case "computer":
            switch toolName {
            case "run_shell": return "terminal"
            case "read_file": return "eye"
            case "list_directory": return "folder"
            case "create_folder": return "folder.badge.plus"
            case "move_item": return "arrow.turn.up.right"
            case "trash_item": return "trash"
            case "open_path": return "arrow.up.forward.app"
            case "open_app": return "app.badge.checkmark"
            case "quit_app": return "xmark.app"
            case "open_url": return "safari"
            case "run_applescript": return "applescript"
            default: return "hammer"
            }
        default: return "list.bullet"
        }
    }

    private var label: String {
        switch kind {
        case "run": return "Run \(path ?? "")"
        case "edit": return "Edit \(path ?? "")"
        case "read": return "Read \(path ?? "")"
        case "ls", "list": return "List files"
        case "mcp":
            let toolText = toolName ?? "tool"
            return server.map { "\($0.displayName) · \(toolText)" } ?? "Call \(toolText)"
        case "search": return "Search: \(searchQuery ?? "…")"
        case "computer": return computerLabel
        default: return kindToken
        }
    }

    /// A per-tool label built from the fence's own JSON body, so e.g.
    /// `run_shell` shows the actual command rather than the generic
    /// "eaon:computer" the raw fence language would otherwise read as.
    private var computerLabel: String {
        switch toolName {
        case "run_shell": return "Run: \(arg("command") ?? "…")"
        case "read_file": return "Read \(lastComponent(arg("path")))"
        case "list_directory": return "List \(arg("path") ?? "…")"
        case "create_folder": return "New folder \(arg("path") ?? "…")"
        case "move_item": return "Move \(lastComponent(arg("from"))) → \(arg("to") ?? "?")"
        case "trash_item": return "Trash \(lastComponent(arg("path")))"
        case "open_path": return "Open \(arg("path") ?? "…")"
        case "open_app": return "Open \(arg("name") ?? "app")"
        case "quit_app": return "Quit \(arg("name") ?? "app")"
        case "open_url": return "Open \(arg("url") ?? "URL")"
        case "run_applescript": return "Run AppleScript"
        default: return toolName ?? "Computer"
        }
    }

    var body: some View {
        HStack(spacing: 8) {
            if kind == "mcp", let server, let image = BrandLogoLoader.image(named: server.logoAssetName) {
                Image(nsImage: image)
                    .resizable()
                    .interpolation(.high)
                    .antialiased(true)
                    .scaledToFit()
                    .frame(width: 12, height: 12)
                    .frame(width: 22, height: 22)
                    .background(
                        RoundedRectangle(cornerRadius: 6, style: .continuous)
                            .fill(colors.backgroundChipSecondary)
                    )
            } else {
                Image(systemName: icon)
                    .font(.system(size: 10, weight: .semibold))
                    .foregroundStyle(colors.textSecondary)
                    .frame(width: 22, height: 22)
                    .background(
                        RoundedRectangle(cornerRadius: 6, style: .continuous)
                            .fill(colors.backgroundChipSecondary)
                    )
            }
            Text(label.trimmingCharacters(in: .whitespaces))
                .font(AppFont.mono(12, weight: .medium))
                .foregroundStyle(colors.textPrimary)
                .lineLimit(1)
            if isStreaming {
                ProgressView()
                    .controlSize(.small)
            }
        }
        .padding(.horizontal, 10)
        .padding(.vertical, 7)
        .background(
            RoundedRectangle(cornerRadius: 9, style: .continuous)
                .fill(colors.backgroundChip)
        )
        .overlay(
            RoundedRectangle(cornerRadius: 9, style: .continuous)
                .stroke(colors.borderSubtle, lineWidth: 1)
        )
    }
}

/// Chat-side stand-in for a file the model created: filename, live line
/// count, and a click-through into the workspace panel's editor.
struct WorkspaceFileCard: View {
    @Environment(\.themeColors) private var colors
    let path: String
    let code: String
    var isStreaming: Bool = false
    var onOpen: () -> Void = {}

    @State private var isHovered = false

    var body: some View {
        Button(action: onOpen) {
            HStack(spacing: 10) {
                Image(systemName: WorkspaceFileIcon.systemName(forPath: path))
                    .font(.system(size: 13))
                    .foregroundStyle(colors.textSecondary)
                    .iconHoverEffect(for: WorkspaceFileIcon.systemName(forPath: path))
                    .frame(width: 30, height: 30)
                    .background(
                        RoundedRectangle(cornerRadius: 7, style: .continuous)
                            .fill(colors.backgroundChipSecondary)
                    )

                VStack(alignment: .leading, spacing: 2) {
                    Text(path)
                        .font(AppFont.mono(12.5, weight: .semibold))
                        .foregroundStyle(colors.textPrimary)
                        .lineLimit(1)
                    Text(subtitle)
                        .font(AppFont.mono(11))
                        .foregroundStyle(colors.textTertiary)
                        .lineLimit(1)
                }

                Spacer(minLength: 12)

                if isStreaming {
                    ProgressView()
                        .controlSize(.small)
                } else {
                    Image(systemName: "chevron.right")
                        .font(.system(size: 10, weight: .semibold))
                        .foregroundStyle(colors.textTertiary)
                        .iconHoverEffect(for: "chevron.right")
                }
            }
            .padding(10)
            .frame(maxWidth: 420, alignment: .leading)
            .background(
                RoundedRectangle(cornerRadius: 10, style: .continuous)
                    .fill(isHovered ? colors.backgroundHover : colors.backgroundChip)
            )
            .overlay(
                RoundedRectangle(cornerRadius: 10, style: .continuous)
                    .stroke(colors.borderSubtle, lineWidth: 1)
            )
            .contentShape(RoundedRectangle(cornerRadius: 10, style: .continuous))
        }
        .buttonStyle(.plain)
        .onHover { isHovered = $0 }
        .help("Open in workspace")
    }

    private var subtitle: String {
        // Byte-scan, not components(separatedBy:) — that allocated an array
        // of every line just to count them, re-run on every typewriter tick
        // while this card's file streams in.
        var lines = code.isEmpty ? 0 : 1
        for byte in code.utf8 where byte == UInt8(ascii: "\n") { lines += 1 }
        return isStreaming
            ? "Writing… \(lines) line\(lines == 1 ? "" : "s")"
            : "\(lines) line\(lines == 1 ? "" : "s") · Open in workspace"
    }
}

/// A Cursor/Claude-Code-style inline diff for the coding agent's two
/// content-bearing tools — `write_file` and `edit_file` — so a real code
/// change is visible with real line numbers right in the chat, not just a
/// generic "eaon:computer" chip. `write_file` has no "before" to diff
/// against at this layer (only this one fence body is available here, not
/// the rest of the conversation), so every line renders as added — an
/// honest "this is the file's content now," not a fabricated diff against
/// a version we can't see from here. `edit_file` already carries its own
/// before/after (`search`/`replace`), so that IS a real diff; its two sides
/// are numbered independently from 1 (old line N → new line N) since no
/// absolute file position is available at this layer either — accurate
/// framing over a cosmetic match to a real editor's absolute gutter.
struct FileDiffCard: View {
    @Environment(\.themeColors) private var colors
    /// "write_file" or "edit_file" — the only two tools routed here.
    let toolName: String
    let argumentsJSON: String
    /// The fence's own `path="…"` attribute — set for the raw write form,
    /// where the body is the literal file text rather than a JSON object.
    var fencePath: String? = nil
    var isStreaming: Bool = false

    private struct DiffLine: Identifiable {
        let id: Int
        let number: Int
        /// Plain text — only consulted to detect a genuinely empty line
        /// (SwiftUI needs a non-empty string to hold the row's height).
        let text: String
        let attributed: AttributedString
        let isAdded: Bool
    }

    /// Everything the card renders, derived from `(toolName, argumentsJSON,
    /// colors)` in ONE pass. This used to be five separate computed
    /// properties (`parsedArgs`, `path`, `fileName`, `lines`, the counts),
    /// each re-parsing the full JSON and/or re-highlighting the entire file
    /// on every access — and `body` accessed them ~5 times per render, per
    /// typewriter tick while streaming. For the real 7.7KB snake.py that
    /// meant re-highlighting ~38KB of text per tick at up to 250 ticks/s:
    /// the single biggest contributor to the pinned-core lag this replaced.
    private struct DiffModel {
        var fileName = "file"
        var lines: [DiffLine] = []
        var addedCount = 0
        var removedCount = 0
    }

    /// One computation per distinct input, memoized through `RenderCache` —
    /// a finished message's card costs a dictionary lookup on re-render and
    /// scroll-in. Still-streaming content (whose JSON grows every tick, so
    /// every key is new) computes once per tick and skips storing.
    private var model: DiffModel {
        RenderCache.shared.value("diff|\(toolName)|\(fencePath ?? "")|\(colors == .dark)|\(argumentsJSON)", store: !isStreaming) {
            Self.computeModel(toolName: toolName, argumentsJSON: argumentsJSON, fencePath: fencePath, colors: colors)
        }
    }

    private static func computeModel(toolName: String, argumentsJSON: String, fencePath: String?, colors: ThemeColors) -> DiffModel {
        // Strict parse ONCE; individual lenient fallbacks only when the
        // whole document isn't valid JSON yet (mid-stream).
        let strict = argumentsJSON.data(using: .utf8)
            .flatMap { try? JSONSerialization.jsonObject(with: $0) as? [String: Any] }
        func field(_ key: String) -> String? {
            if let value = strict?[key] as? String { return value }
            guard strict == nil else { return nil }
            return partialStringField(key, in: argumentsJSON)
        }

        // Raw write form: the fence names the path and the body IS the file
        // — exactly what the executor accepts, so the preview and the real
        // write can never disagree. (A raw body that's valid JSON — writing
        // a .json file — still renders as raw, matching execution: the
        // strict parse only wins when it carries real path/content args.)
        let bodyIsArgsJSON = strict?["path"] is String || strict?["content"] is String
        let rawForm = toolName == "write_file" && fencePath != nil && !bodyIsArgsJSON

        var model = DiffModel()
        let path = rawForm ? fencePath : (field("path") ?? fencePath)
        model.fileName = path.map { ($0 as NSString).lastPathComponent } ?? "file"
        let language = SyntaxLanguage.detect(fileExtension: path.map { ($0 as NSString).pathExtension } ?? "")

        if rawForm {
            for (index, row) in splitHighlighted(argumentsJSON, language: language, colors: colors, keepEmptyLine: true).enumerated() {
                model.lines.append(DiffLine(id: index, number: index + 1, text: row.plain, attributed: row.attributed, isAdded: true))
            }
        } else if toolName == "write_file" {
            // Absent (nil) means "content" hasn't started streaming in at
            // all yet (still on "path") — genuinely nothing to show, vs.
            // present-but-empty ("") which is a real empty file.
            if let content = field("content") {
                for (index, row) in splitHighlighted(content, language: language, colors: colors, keepEmptyLine: true).enumerated() {
                    model.lines.append(DiffLine(id: index, number: index + 1, text: row.plain, attributed: row.attributed, isAdded: true))
                }
            } else if strict == nil, fencePath != nil, !argumentsJSON.isEmpty {
                // JSON-ish body that never grew a content field but the
                // fence names a path — show the body raw rather than an
                // empty card while it streams.
                for (index, row) in splitHighlighted(argumentsJSON, language: language, colors: colors, keepEmptyLine: true).enumerated() {
                    model.lines.append(DiffLine(id: index, number: index + 1, text: row.plain, attributed: row.attributed, isAdded: true))
                }
            }
        } else {
            let removed = field("search").map { splitHighlighted($0, language: language, colors: colors, keepEmptyLine: false) } ?? []
            let added = field("replace").map { splitHighlighted($0, language: language, colors: colors, keepEmptyLine: false) } ?? []
            for (index, row) in removed.enumerated() {
                model.lines.append(DiffLine(id: index, number: index + 1, text: row.plain, attributed: row.attributed, isAdded: false))
            }
            for (index, row) in added.enumerated() {
                model.lines.append(DiffLine(id: removed.count + index, number: index + 1, text: row.plain, attributed: row.attributed, isAdded: true))
            }
        }
        model.addedCount = model.lines.lazy.filter(\.isAdded).count
        model.removedCount = model.lines.count - model.addedCount
        return model
    }

    /// Finds `"key":"` in a possibly-truncated JSON fragment and decodes
    /// forward from the opening quote exactly like a JSON string literal —
    /// honoring \", \\, \/, \n, \t, \r, and \uXXXX — stopping at an
    /// unescaped closing quote (the field is complete) or simply running
    /// out of characters (the field is still arriving; whatever decoded so
    /// far is returned, which is what makes the card grow live token by
    /// token instead of appearing all at once). Lone/incomplete escape
    /// sequences at the very end (a trailing "\" or a "\u" with fewer than
    /// four hex digits so far) stop the decode right before them rather
    /// than guessing — the next character(s) will complete it on the next
    /// update. Doesn't reconstruct \uXXXX surrogate pairs into a single
    /// character (emoji etc.) — source code essentially never contains
    /// one, so this isn't worth the extra complexity here.
    private static func partialStringField(_ key: String, in json: String) -> String? {
        guard let keyRange = json.range(of: "\"\(key)\"") else { return nil }
        guard let colonIndex = json[keyRange.upperBound...].firstIndex(of: ":") else { return nil }
        let afterColon = json[json.index(after: colonIndex)...]
        guard let quoteIndex = afterColon.firstIndex(where: { !$0.isWhitespace }), afterColon[quoteIndex] == "\"" else { return nil }

        var result = ""
        var index = afterColon.index(after: quoteIndex)
        while index < afterColon.endIndex {
            let c = afterColon[index]
            if c == "\\" {
                let escapeIndex = afterColon.index(after: index)
                guard escapeIndex < afterColon.endIndex else { break }
                let escapeChar = afterColon[escapeIndex]
                if escapeChar == "u" {
                    let hexStart = afterColon.index(after: escapeIndex)
                    guard let hexEnd = afterColon.index(hexStart, offsetBy: 4, limitedBy: afterColon.endIndex) else { break }
                    if let codepoint = UInt32(afterColon[hexStart..<hexEnd], radix: 16), let scalar = Unicode.Scalar(codepoint) {
                        result.append(Character(scalar))
                    }
                    index = hexEnd
                    continue
                }
                switch escapeChar {
                case "n": result.append("\n")
                case "t": result.append("\t")
                case "r": result.append("\r")
                default: result.append(escapeChar) // \", \\, \/, or a lenient pass-through
                }
                index = afterColon.index(after: escapeIndex)
            } else if c == "\"" {
                return result
            } else {
                result.append(c)
                index = afterColon.index(after: index)
            }
        }
        return result
    }

    /// Highlights a whole snippet ONCE, then splits the *result* into
    /// per-line pieces (rather than highlighting each line in isolation),
    /// so a construct spanning several lines — a block comment, a
    /// triple-quoted string — still colors correctly across the break; a
    /// line entirely inside one but carrying no delimiter of its own would
    /// otherwise fall back to plain text. Splits on "\n" and drops exactly
    /// one trailing empty line for text ending in a newline (not a line
    /// anyone wrote — would make a 46-line file read as 47), matching how
    /// `write_file`'s own line count is computed. `keepEmptyLine` controls
    /// what a genuinely empty string means: `write_file`'s whole `content`
    /// being "" is still one real (blank) line of an empty file; `edit_file`'s
    /// `search`/`replace` being "" is deliberately zero lines — its own doc
    /// says an empty `replace` deletes the matched text outright, and
    /// showing that as "+1 blank line added" would misrepresent a clean
    /// deletion as an addition.
    private static func splitHighlighted(_ text: String, language: SyntaxLanguage, colors: ThemeColors, keepEmptyLine: Bool) -> [(plain: String, attributed: AttributedString)] {
        guard !text.isEmpty else {
            return keepEmptyLine ? [("", AttributedString(""))] : []
        }
        let highlighted = SyntaxHighlighter.highlight(text, language: language, colors: colors)
        var result: [(String, AttributedString)] = []
        var lineStart = highlighted.startIndex
        var index = highlighted.startIndex
        while index < highlighted.endIndex {
            if highlighted.characters[index] == "\n" {
                let slice = highlighted[lineStart..<index]
                result.append((String(slice.characters), AttributedString(slice)))
                index = highlighted.index(afterCharacter: index)
                lineStart = index
            } else {
                index = highlighted.index(afterCharacter: index)
            }
        }
        let finalSlice = highlighted[lineStart..<highlighted.endIndex]
        let finalPlain = String(finalSlice.characters)
        if !(finalPlain.isEmpty && !result.isEmpty) {
            result.append((finalPlain, AttributedString(finalSlice)))
        }
        return result
    }

    var body: some View {
        // Once per render — header, emptiness check, and rows all read this
        // same value instead of independently recomputing it.
        let model = model
        VStack(alignment: .leading, spacing: 0) {
            header(model)
            if !model.lines.isEmpty {
                Divider().opacity(0.5)
                diffBody(model)
            } else if isStreaming {
                HStack(spacing: 8) {
                    ProgressView().controlSize(.small)
                    Text("Writing…")
                        .font(AppFont.mono(11))
                        .foregroundStyle(colors.textTertiary)
                }
                .padding(10)
            } else {
                Text("Couldn't preview this edit. See the tool result below.")
                    .font(AppFont.mono(11))
                    .foregroundStyle(colors.textTertiary)
                    .padding(10)
            }
        }
        .frame(maxWidth: 560, alignment: .leading)
        .background(
            RoundedRectangle(cornerRadius: 10, style: .continuous)
                .fill(colors.backgroundChip.opacity(0.6))
        )
        .overlay(
            RoundedRectangle(cornerRadius: 10, style: .continuous)
                .stroke(colors.borderSubtle, lineWidth: 1)
        )
        .clipShape(RoundedRectangle(cornerRadius: 10, style: .continuous))
    }

    private func header(_ model: DiffModel) -> some View {
        HStack(spacing: 8) {
            Image(systemName: toolName == "write_file" ? "doc.badge.plus" : "pencil")
                .font(.system(size: 10, weight: .semibold))
                .foregroundStyle(colors.textSecondary)
                .frame(width: 22, height: 22)
                .background(
                    RoundedRectangle(cornerRadius: 6, style: .continuous)
                        .fill(colors.backgroundChipSecondary)
                )

            (Text(toolName == "write_file" ? "Write" : "Edit").fontWeight(.semibold)
                + Text("  " + model.fileName))
                .font(AppFont.mono(12.5))
                .foregroundStyle(colors.textPrimary)
                .lineLimit(1)
                .truncationMode(.head)

            Spacer(minLength: 8)

            if model.addedCount > 0 {
                Text("+\(model.addedCount)")
                    .font(AppFont.mono(11, weight: .semibold))
                    .foregroundStyle(colors.diffAdded)
            }
            if model.removedCount > 0 {
                Text("−\(model.removedCount)")
                    .font(AppFont.mono(11, weight: .semibold))
                    .foregroundStyle(colors.diffRemoved)
            }
            if isStreaming {
                ProgressView().controlSize(.small)
            }
        }
        .padding(.horizontal, 10)
        .padding(.vertical, 8)
    }

    private func diffBody(_ model: DiffModel) -> some View {
        ScrollView {
            // Lazy on purpose: the card caps its visible height at 280pt
            // (~25 rows), and during streaming the new content lands at the
            // BOTTOM, past what's shown — materializing all 200+ rows of a
            // big file per tick built a mountain of Text views nobody could
            // see. Lazy construction only builds what's scrolled into view.
            LazyVStack(alignment: .leading, spacing: 0) {
                ForEach(Array(model.lines.enumerated()), id: \.element.id) { index, line in
                    diffRow(line, showCursor: isStreaming && index == model.lines.count - 1)
                }
            }
            .padding(.vertical, 6)
        }
        .frame(maxHeight: 280)
        .background(colors.backgroundCode)
        .textSelection(.enabled)
    }

    @ViewBuilder
    private func diffRow(_ line: DiffLine, showCursor: Bool) -> some View {
        HStack(spacing: 0) {
            Text(line.isAdded ? "+" : "−")
                .font(AppFont.mono(11, weight: .bold))
                .foregroundStyle(line.isAdded ? colors.diffAdded : colors.diffRemoved)
                .frame(width: 14, alignment: .center)
            Text("\(line.number)")
                .font(AppFont.mono(10.5))
                .foregroundStyle(colors.textTertiary)
                .frame(width: 28, alignment: .trailing)
                .padding(.trailing, 8)
            // No `.foregroundStyle` here — `SyntaxHighlighter` already
            // bakes a base color plus per-token overrides into the
            // AttributedString itself (same reason `CodeBlockView` renders
            // its highlighted text bare); adding one would paint over
            // every token color it just set.
            rowText(line, showCursor: showCursor)
                .font(AppFont.mono(11.5))
                .lineLimit(1)
                .truncationMode(.tail)
            Spacer(minLength: 0)
        }
        .padding(.vertical, 1.5)
        .padding(.horizontal, 6)
        .background((line.isAdded ? colors.diffAdded : colors.diffRemoved).opacity(0.12))
    }

    /// The last row gets a blinking cursor while the call is still
    /// streaming — the same `TimelineView` blink already used for a
    /// streaming plain code block (`CodeBlockView`) and the workspace
    /// editor's own in-progress file (`CodeWorkspacePanel`), so a line
    /// actively growing reads the same way everywhere else in the app.
    @ViewBuilder
    private func rowText(_ line: DiffLine, showCursor: Bool) -> some View {
        let content = line.text.isEmpty ? AttributedString(" ") : line.attributed
        if showCursor {
            TimelineView(.periodic(from: .now, by: 0.5)) { context in
                let cursorVisible = Int(context.date.timeIntervalSince1970 * 2) % 2 == 0
                (Text(content) + Text("▎").foregroundColor(colors.textPrimary.opacity(cursorVisible ? 0.95 : 0.2)))
            }
        } else {
            Text(content)
        }
    }
}

/// Shown while the assistant is preparing its first tokens — a `ThinkingOrb`
/// paired with real status text (e.g. a local model still loading into
/// memory) rather than leaving that wait unexplained.
///
/// The orb replaced a single pulsing dot. A pulse can only ever say "still
/// alive"; the orb's mode says *what kind* of work is running, which is
/// information the app already had and was throwing away. The status text
/// stays: the orb narrows the guess to four categories, the words say the
/// rest.
struct ThinkingIndicator: View {
    @Environment(\.themeColors) private var colors
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    var statusText: String? = nil

    /// The label's treatment follows the reference indicator: a shimmer
    /// sweeping the text rather than each character bobbing, and a new status
    /// arriving on a short vertical slide instead of swapping in place.
    ///
    /// Both changes are about a label that keeps changing. A per-character
    /// wave can't wrap and reads as decoration on a long line; a shimmer is
    /// one moving highlight over ordinary text, so it stays calm at any
    /// length. And when the status itself changes ("Searching…" →
    /// "Reading…"), sliding the old line out and the new one in makes the
    /// change legible as a change, where an in-place swap just looks like a
    /// glitch.
    /// The reference uses 0.24s in and 0.16s out on cubic-bezier(0.4, 0,
    /// 0.2, 1). SwiftUI drives both halves of a transition from the one
    /// enclosing animation, so this is a single 0.24s on that same curve —
    /// the outgoing line is fading and moving away from the eye, where the
    /// 80ms difference isn't perceptible, and splitting them would mean
    /// hand-rolling two transactions for no visible gain.
    private static let slide: Double = 0.24

    var body: some View {
        // .top rather than centred: once a long status wraps to two lines,
        // a centred orb floats in the middle of the block instead of sitting
        // beside the first line where it reads as a bullet.
        HStack(alignment: .top, spacing: 8) {
            ThinkingOrb(state: .matching(statusText))
                // The orb's dots stop short of its own bounds, so it needs
                // less optical nudging than the old 9pt circle did to sit on
                // the first line's cap-height.
                .padding(.top, 1)

            if let statusText {
                ShimmerText(
                    text: statusText,
                    font: AppFont.mono(13),
                    color: colors.textSecondary,
                    // Faster than a step row's: here the shimmer is the
                    // "still working" signal itself.
                    period: 1.5
                )
                // Keyed on the text so a changed status is a real
                // insert/remove pair — that's what the transition animates.
                .id(statusText)
                .transition(
                    .asymmetric(
                        insertion: .offset(y: 11).combined(with: .opacity),
                        removal: .offset(y: -11).combined(with: .opacity)
                    )
                )
                // Centres the label against the orb's mass rather than
                // its frame, which is taller than the text it sits beside.
                .padding(.top, 4)
            }
            // Lets the label take the width it needs and wrap, instead of the
            // row sizing to its content and overflowing the message column.
            Spacer(minLength: 0)
        }
        .padding(.vertical, 2)
        // Clipped so the outgoing line disappears at the row's edge instead
        // of sliding over whatever sits above it.
        .clipped()
        .animation(
            reduceMotion ? nil : .timingCurve(0.4, 0, 0.2, 1, duration: Self.slide),
            value: statusText
        )
        // VoiceOver gets one stable announcement. Without this the cycling
        // status would re-announce every few seconds, which is unusable —
        // the same reason the reference keeps a static sr-only label and
        // hides the visible cycling text.
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(statusText ?? "Thinking")
    }
}

/// The status label beside the pulsing dot.
///
/// Short labels ("Thinking", "Searching the web") keep the per-letter wave —
/// a Stagger of a Float, in animation-vocabulary terms. Continuous motion is
/// genuinely the point here: it exists to keep saying "still working" for as
/// long as it's on screen, so looping indefinitely is correct, unlike a
/// button press. Amplitude and speed stay small because this runs constantly,
/// every generation, all day.
///
/// Anything longer renders as ONE plain `Text`. The wave lays each character
/// out as its own view in an `HStack`, and that only works for a short label:
///
///   - an HStack cannot wrap, so a long status runs straight off the edge of
///     the message column instead of flowing onto a second line;
///   - per-character views can't kern against each other, so spacing goes
///     visibly uneven — the "letters are all different sizes" look;
///   - a 44-character status becomes 44 concurrently repeating animations,
///     and at 0.045s of stagger per character the wave takes 2 full seconds
///     to travel, so distant parts of one sentence sit at opposite offsets
///     at the same moment.
///
/// Agent Swarm made this visible by introducing genuinely long statuses
/// ("Swarm — round 2: Security Reviewer is weighing in…"). The threshold
/// keeps the effect exactly where it was designed to work.
private struct WaveText: View {
    let text: String
    let font: Font
    let color: Color
    @State private var animate = false

    /// Longest label that still lays out on one line in the message column,
    /// and short enough that the wave reads as one travelling motion rather
    /// than several unrelated ones.
    private static let maxWavedCharacters = 22

    /// Emil's "strong ease-in-out" cubic-bezier (0.77, 0, 0.175, 1) rather
    /// than the built-in easeInOut, which reads flat next to a curve with
    /// real acceleration at both ends.
    private var waveCurve: Animation {
        .timingCurve(0.77, 0, 0.175, 1, duration: 0.7)
    }

    var body: some View {
        if text.count <= Self.maxWavedCharacters {
            HStack(spacing: 0) {
                ForEach(Array(text.enumerated()), id: \.offset) { index, character in
                    Text(String(character))
                        .font(font)
                        .foregroundStyle(color)
                        .offset(y: animate ? -2 : 1.5)
                        .animation(
                            waveCurve.repeatForever(autoreverses: true).delay(Double(index) * 0.045),
                            value: animate
                        )
                }
            }
            .onAppear { animate = true }
        } else {
            // One Text: correct kerning, wraps, and a single gentle breath
            // instead of dozens of competing per-letter animations. The
            // pulsing dot beside it already carries "still working".
            Text(text)
                .font(font)
                .foregroundStyle(color)
                .fixedSize(horizontal: false, vertical: true)
                .opacity(animate ? 0.55 : 1.0)
                .animation(.easeInOut(duration: 1.1).repeatForever(autoreverses: true), value: animate)
                .onAppear { animate = true }
        }
    }
}

/// Splits a raw streamed message on its first `<think>…</think>` block —
/// the chain-of-thought a reasoning model (DeepSeek-R1, QwQ, and other
/// local reasoning models served through Ollama) emits inline ahead of its
/// real answer. Left alone, that block would render as literal `<think>`
/// text in the middle of the reply; extracting it here lets
/// `ThinkingDisclosure` show it behind a click instead. Streaming-side
/// providers that send reasoning as its own `reasoning_content`/`reasoning`
/// field (DeepSeek's own API) get wrapped in the same tag by
/// `ReasoningDeltaBridge` before the text ever reaches here, so this one
/// routine covers both real shapes.
enum ReasoningExtractor {
    struct Result {
        let reasoning: String?
        let visibleContent: String
        /// True while `<think>` has opened but `</think>` hasn't arrived
        /// yet — the model is still reasoning, not the final answer.
        let isReasoningInProgress: Bool
    }

    static func extract(from raw: String) -> Result {
        guard let openRange = raw.range(of: "<think>") else {
            return Result(reasoning: nil, visibleContent: raw, isReasoningInProgress: false)
        }

        let before = String(raw[raw.startIndex..<openRange.lowerBound])
        let afterOpen = raw[openRange.upperBound...]

        if let closeRange = afterOpen.range(of: "</think>") {
            let reasoning = String(afterOpen[afterOpen.startIndex..<closeRange.lowerBound])
            let after = String(afterOpen[closeRange.upperBound...])
            // Straight concatenation would squish "before" and "after"
            // together with no separator on the rare model that emits real
            // content on both sides of the block with no whitespace of its
            // own around the tags.
            let trimmedBefore = before.trimmingCharacters(in: .whitespacesAndNewlines)
            let trimmedAfter = after.trimmingCharacters(in: .whitespacesAndNewlines)
            let visible = [trimmedBefore, trimmedAfter].filter { !$0.isEmpty }.joined(separator: "\n\n")
            return Result(
                reasoning: reasoning.trimmingCharacters(in: .whitespacesAndNewlines),
                visibleContent: visible,
                isReasoningInProgress: false
            )
        }

        return Result(
            reasoning: String(afterOpen).trimmingCharacters(in: .whitespacesAndNewlines),
            visibleContent: before.trimmingCharacters(in: .whitespacesAndNewlines),
            isReasoningInProgress: true
        )
    }
}

/// The swarm's discussion, collapsed behind a click — it's background work on
/// the way to the answer, not the answer itself, the same reasoning as
/// `ThinkingDisclosure` above. Grouped by round, since the point of a swarm is
/// watching
/// the specialists converge (or fail to) across rounds rather than comparing
/// two independent takes. Personas that voted to hand off are marked, so the
/// vote that actually ended the discussion is visible rather than implied.
struct SwarmPanelDisclosure: View {
    @Environment(\.themeColors) private var colors
    let transcript: SwarmTranscript
    @State private var isExpanded = false

    private var rounds: [Int] {
        Array(Set(transcript.usableRemarks.map(\.round))).sorted()
    }

    private var summary: String {
        let count = transcript.personas.count
        let roundWord = transcript.roundsUsed == 1 ? "round" : "rounds"
        return transcript.endedByVote
            ? "Swarm — \(count) specialists agreed after \(transcript.roundsUsed) \(roundWord)"
            : "Swarm — \(count) specialists talked it over for \(transcript.roundsUsed) \(roundWord)"
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            Button {
                withAnimation(.easeOut(duration: 0.16)) { isExpanded.toggle() }
            } label: {
                HStack(spacing: 6) {
                    Image(systemName: "chevron.right")
                        .font(.system(size: 10, weight: .semibold))
                        .foregroundStyle(colors.textTertiary)
                        .rotationEffect(.degrees(isExpanded ? 90 : 0))
                        .animation(.easeOut(duration: 0.16), value: isExpanded)
                        .iconHoverEffect(for: "chevron.right")
                    Image(systemName: "person.3.fill")
                        .font(.system(size: 10, weight: .semibold))
                        .foregroundStyle(colors.textSecondary)
                    Text(summary)
                        .font(AppFont.mono(13))
                        .foregroundStyle(colors.textSecondary)
                }
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)

            if isExpanded {
                VStack(alignment: .leading, spacing: 14) {
                    // The roster first — a persona's argument only means
                    // something once you know what they were convened for.
                    if !transcript.personas.isEmpty {
                        VStack(alignment: .leading, spacing: 3) {
                            Text("THE SWARM")
                                .font(AppFont.mono(9.5, weight: .semibold))
                                .foregroundStyle(colors.textTertiary.opacity(0.7))
                            ForEach(Array(transcript.personas.enumerated()), id: \.offset) { _, persona in
                                Text("\(persona.name) — \(persona.role)")
                                    .font(AppFont.mono(11.5))
                                    .foregroundStyle(colors.textTertiary)
                                    .fixedSize(horizontal: false, vertical: true)
                            }
                        }
                    }

                    ForEach(rounds, id: \.self) { round in
                        VStack(alignment: .leading, spacing: 10) {
                            Text("ROUND \(round)")
                                .font(AppFont.mono(9.5, weight: .semibold))
                                .foregroundStyle(colors.textTertiary.opacity(0.7))
                            ForEach(Array(transcript.usableRemarks.filter { $0.round == round }.enumerated()), id: \.offset) { _, remark in
                                VStack(alignment: .leading, spacing: 4) {
                                    HStack(spacing: 5) {
                                        Text(remark.personaName)
                                            .font(AppFont.mono(11.5, weight: .semibold))
                                            .foregroundStyle(colors.textSecondary)
                                        if remark.wantsToEnd {
                                            Text("voted to hand off")
                                                .font(AppFont.mono(9.5))
                                                .foregroundStyle(colors.textTertiary.opacity(0.75))
                                        }
                                    }
                                    Text(remark.text)
                                        .font(AppFont.mono(12))
                                        .foregroundStyle(colors.textTertiary)
                                        .textSelection(.enabled)
                                }
                                .fixedSize(horizontal: false, vertical: true)
                            }
                        }
                    }
                }
                .padding(.leading, 10)
                .padding(.vertical, 8)
                .padding(.trailing, 4)
                .overlay(alignment: .leading) {
                    Rectangle()
                        .fill(colors.borderSubtle)
                        .frame(width: 2)
                }
                .padding(.top, 8)
                .padding(.leading, 6)
                .transition(.opacity.combined(with: .move(edge: .top)))
            }
        }
        .padding(.vertical, 4)
    }
}


