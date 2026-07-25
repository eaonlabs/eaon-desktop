import Foundation

// MARK: - Workspace file

/// One file the model has created in the current conversation's code
/// workspace. Workspace contents are always *derived* from the assistant
/// messages themselves (re-parsed on load), so there's no separate persisted
/// store that could drift out of sync with the transcript.
struct WorkspaceFile: Identifiable, Equatable {
    var path: String
    var language: String?
    var content: String
    /// False while this file's closing fence hasn't streamed in yet.
    var isComplete: Bool = true

    var id: String { path }

    var fileName: String { (path as NSString).lastPathComponent }

    var directory: String {
        let dir = (path as NSString).deletingLastPathComponent
        return dir.isEmpty ? "" : dir
    }

    var lineCount: Int {
        content.isEmpty ? 0 : content.components(separatedBy: "\n").count
    }
}

// MARK: - Parser

/// Extracts workspace files from assistant text. The model marks a file by
/// putting a `file="path"` attribute on the opening code fence:
///
///     ```html file="index.html"
///     ...entire file...
///     ```
///
/// Plain fences (no file attribute) are left alone — they stay ordinary chat
/// code blocks.
enum WorkspaceParser {
    /// How to drive the workspace, sent as a system message on Chat-mode
    /// requests that are actually about building something — see
    /// `shouldTeachWorkspace`, and `ChatViewModel.chatIdentityPrompt` for the
    /// short identity that carries every other turn. The tool protocol is
    /// plain fenced-text (not native API tool-calling) so it works
    /// identically over Aqua and every BYOK wire format. (This text existed
    /// for a while without actually being wired into any request — Chat mode
    /// had no coding instruction of its own at all, so a model asked to
    /// "make a website mockup" got zero guidance on how to present it and,
    /// observed live, sometimes reached for a connected service like GitHub
    /// or Vercel instead of just writing the code. Fixed 2026-07-14.)
    ///
    /// It deliberately no longer opens by declaring what the model IS. It
    /// used to start "You are the coding agent inside Eaon", and since it was
    /// the only system message a default Chat conversation carried, that was
    /// the model's whole identity on every turn — see `shouldTeachWorkspace`
    /// for what that did to "hello". Capability, not identity.
    static let systemInstruction = """
    This chat has a live code workspace panel beside it: a file explorer, an editor, a console, and a browser preview for websites. When the user asks you to build or change something, you write real files into it using the tools below — you don't describe code, you create it.

    ENVIRONMENT
    - Files you create appear instantly in the workspace. Websites render in a live preview: the entry point must be index.html, and files must reference each other with relative paths (e.g. <link rel="stylesheet" href="css/style.css">).
    - Scripts run locally on the user's Mac with these runtimes only: python3, node, swift, ruby, php, bash/zsh, perl, lua, go run. STANDARD LIBRARY ONLY — you cannot install packages (no pip, no npm install). No servers, no GUIs: programs get EOF on stdin, must finish on their own, and are killed after 60 seconds.

    TOOLS — each is a fenced code block in your reply:

    1. Create or overwrite a file — a normal fence with a file attribute, containing the COMPLETE file:
    ```html file="index.html"
    <!doctype html>
    ...entire file, first line to last...
    ```

    2. Edit part of an existing file (preferred for small changes — don't rewrite big files):
    ```eaon:edit file="src/app.js"
    <<<<<<< SEARCH
    exact existing lines to find
    =======
    what to replace them with
    >>>>>>> REPLACE
    ```
    The SEARCH text must match the file exactly and appear exactly once.

    3. Run a script file (websites just preview — never "run" an .html file):
    ```eaon:run file="main.py"
    ```

    4. Read a file back:
    ```eaon:read file="main.py"
    ```

    5. List all files:
    ```eaon:ls
    ```

    After your reply, any eaon:run / eaon:edit / eaon:read / eaon:ls tools execute automatically and their results come back to you in a message beginning "[Tool results". You then continue — this loops until you reply with no tools. (Plain file="…" creates don't loop back — they take effect immediately, so write the whole thing in this one reply.)

    HOW FILES ARE CREATED — read this carefully. The ONLY way to create or change a file here is the file="…" fence in tool 1 above (or eaon:edit for a change). A plain code block with no file attribute, a function/tool call, or an ```eaon:computer / tool="write_file" block does NOT create a file in this workspace — those are not available in chat and nothing will be saved or shown. Do not describe writing a file or narrate steps as if a tool ran; actually emit the file="…" block. (```eaon:mcp is only for connected cloud services like GitHub or Vercel, and only when the user explicitly asks to push/deploy/connect — never for writing the code itself.)

    WORKFLOW — only when the user has actually asked you to build or change something. If they haven't (a greeting, a question, small talk), ignore every step below and just reply to them normally. Never invent a project for yourself, and never write the user's side of the conversation.
    1. One short paragraph saying what you'll build. No long plans. Default to writing it directly, right here, this way — even when a connected service (GitHub, Vercel, Supabase, …) could also do this, don't reach for one unless the user specifically asks you to push, deploy, or connect somewhere.
    2. In the SAME reply, immediately write ALL the files, each complete from first line to last — never "rest unchanged", never placeholder comments. Do NOT stop after only saying what you'll build: the intro sentence and the actual file="…" blocks are one single message. Describing a file is not creating it.
    3. Scripts: run the entry file with eaon:run, read the result, and if it failed, fix the file (eaon:edit or a full rewrite) and run again — iterate until it exits cleanly. Websites: skip running; they preview automatically.
    4. Finish with a 1–3 sentence summary.

    Use forward slashes for folders (file="css/style.css"). To change a file you already made, prefer eaon:edit; re-emitting the full file with the same path also works.
    For anything that is NOT a coding request — conversation, questions, short snippets meant to be read inline — reply normally, with NO file attributes and NO eaon: blocks.
    """

    /// Whether this turn should carry `systemInstruction` at all.
    ///
    /// It used to ride on EVERY Chat-mode request, and with default settings
    /// it was the ONLY system message the conversation had — so the model's
    /// entire identity was "You are the coding agent inside Eaon", followed
    /// by ~900 tokens of file-writing syntax and a numbered WORKFLOW, on a
    /// turn where the user had typed "hello". Two failures came straight out
    /// of that, both reproduced live on GPT-5 Nano:
    ///
    /// 1. "hello" → "You can use me to help you with coding and tasks related
    ///    to coding" — the model answered from its identity, because that's
    ///    all it had been given.
    /// 2. "hi" → the model INVENTED a project ("I'd like to build a simple
    ///    web scraper…", written in the user's own voice), emitted an
    ///    index.html and fired an eaon:read. With no real request anywhere in
    ///    the context, the WORKFLOW section was the only thing that looked
    ///    like a task, so it ran it.
    ///
    /// The block is worth ~900 tokens and is only ever useful on a turn that
    /// actually builds something, so that's when it's sent: the current
    /// message asks for it, or the workspace already holds files from earlier
    /// in this same conversation — which keeps bare follow-ups ("make the
    /// button blue", "now add a footer") working, since by then there are
    /// files to point at.
    static func shouldTeachWorkspace(latestUserText: String, conversationHasFiles: Bool) -> Bool {
        conversationHasFiles || looksLikeBuildRequest(latestUserText)
    }

    /// Terms that mean code on their own — a language, a framework, a file
    /// extension, or a word with no everyday reading in a chat app.
    private static let codeSignals = [
        "html", "css", "javascript", "typescript", " js ", " ts ", "python",
        "swift", "kotlin", "rust", "golang", " go code", "ruby", "php",
        "node.js", "nodejs", "react", "vue", "svelte", "tailwind", "sql",
        "regex", "json", "bash", "shell script", "code", "coding", "script",
        "program", "function", "algorithm", "refactor", "debug", "compile",
        "syntax", "website", "web page", "webpage", "css file", "codebase",
    ]

    /// Real code subjects that also have an everyday meaning, so each only
    /// counts alongside a build verb — "which app should I use?" must not
    /// drag in the whole workspace protocol.
    private static let softSubjects = [
        "app", "application", "site", "page", "game", "class", "component",
        "bug", "file", "project", "landing", "dashboard", "form", "chart",
        "animation", "snippet", "tool", "calculator", "clone", "widget",
    ]

    private static let buildVerbs = [
        "build", "make", "create", "write", "implement", "generate", "add",
        "fix", "code", "design", "develop", "prototype", "mock up", "mockup",
        "rewrite", "refactor", "debug", "edit", "change", "update",
    ]

    private static let codeFileExtensions = [
        ".html", ".css", ".js", ".ts", ".jsx", ".tsx", ".py", ".swift", ".rb",
        ".php", ".go", ".rs", ".sh", ".json", ".java", ".kt", ".c", ".cpp", ".h",
    ]

    /// Deliberately generous: a false positive costs the tokens this block
    /// always used to cost anyway, while a false negative means the model
    /// describes code instead of writing it. Cheap, deterministic, offline —
    /// no extra model call to decide whether to prompt a model.
    static func looksLikeBuildRequest(_ raw: String) -> Bool {
        // The user pasting a fenced block is unambiguous.
        if raw.contains("```") { return true }
        let text = " " + raw.lowercased() + " "
        if codeFileExtensions.contains(where: text.contains) { return true }
        if codeSignals.contains(where: text.contains) { return true }
        guard softSubjects.contains(where: { text.contains(" \($0) ") || text.contains(" \($0)s ") }) else {
            return false
        }
        return buildVerbs.contains(where: text.contains)
    }

    /// Cheap pre-check so the full line scan doesn't run on every stream tick
    /// of an ordinary prose reply.
    static func mightContainFiles(_ text: String) -> Bool {
        guard text.contains("```") else { return false }
        return text.contains("file=") || text.contains("path=")
            || text.contains("filename=") || text.contains("eaon:")
            || text.contains("aqua:")  // legacy prefix, still parsed
    }

    /// The exact search/replace of an `eaon:edit` block, Aider-style.
    struct EditPayload: Equatable {
        let search: String
        let replace: String
    }

    /// Everything the agent can express in a reply, in the order it appears.
    /// Writes/edits drive the derived workspace; run/read/list are executed
    /// by the agent loop after the reply finishes streaming.
    enum Event: Equatable {
        case write(WorkspaceFile)
        /// `payload` is nil while the block is malformed or still streaming —
        /// derivation skips it, and the loop reports the malformation back.
        case edit(path: String, payload: EditPayload?)
        case run(path: String?)
        case read(path: String?)
        case list
        /// `server`/`tool` are nil when the fence is missing that
        /// attribute — reported back as an error the same way a malformed
        /// edit block is, rather than silently dropped. `server` names
        /// which connected service owns `tool`, since more than one can
        /// be connected at once.
        case mcpCall(server: String?, tool: String?, argumentsJSON: String)
        /// A live web search — see `WebSearchTool`. Not an `mcpCall`
        /// because it isn't a connected third-party account: no server id,
        /// no confirmation dialog, no "connected services" membership
        /// check.
        case webSearch(argumentsJSON: String)
        /// An image-generation request — see `ImageGenerationTool`. Not an
        /// `mcpCall` for the same reason `webSearch` isn't: it's a built-in
        /// capability, not a connected third-party service.
        case imageGeneration(argumentsJSON: String)
        /// A desktop-control action — see `DesktopControl`.
        case computerCall(ComputerCall)
    }

    /// One desktop-control fence, with enough context for the executor to
    /// accept the raw-body write form (path on the fence, file text as the
    /// body) and to refuse a write whose stream was cut off mid-file.
    struct ComputerCall: Equatable {
        /// Bare tool name (e.g. "move_item") — nil when the fence omitted
        /// the `tool="…"` attribute (reported back as an error, not dropped).
        let tool: String?
        /// The fence's own `path="…"` attribute — how the raw write form
        /// names its file. nil for the JSON-body forms.
        let fencePath: String?
        /// The fence's `append="true"` attribute — lets a raw write add to
        /// the end of an existing file (finishing a long file in parts).
        let fenceAppend: Bool
        /// The fence body: a JSON object for most calls, or the literal file
        /// text for the raw write form.
        let body: String
        /// False when the text ended without the closing ``` line. A JSON
        /// body that got cut off simply fails to parse, but a cut-off RAW
        /// body looks like a complete (shorter) file — this flag is how the
        /// executor knows to refuse it instead of writing a truncated file.
        let sawClosingFence: Bool
    }

    /// Matches a complete `<think>…</think>` / `<thinking>…</thinking>`
    /// span — the inline reasoning trace models like Nemotron and DeepSeek
    /// emit before their answer.
    private static let thinkSpanRegex = try! NSRegularExpression(
        pattern: "<think>[\\s\\S]*?</think>|<thinking>[\\s\\S]*?</thinking>",
        options: [.caseInsensitive]
    )

    /// Removes completed reasoning spans, replacing each with a newline.
    ///
    /// Two real failure modes force this (both captured live from Nemotron
    /// 3 Ultra transcripts, 2026-07-13):
    /// 1. The model glues its opening fence to the reasoning close —
    ///    `…game.</think>```eaon:computer tool="run_shell"` — so the
    ///    line-based scan below never sees a line *starting* with ``` and
    ///    the whole call is lost ("couldn't be parsed", three strikes,
    ///    stop). Replacing the span with a NEWLINE (not "") is what heals
    ///    this: the fence lands back at the start of its own line. It also
    ///    heals think-spans that *start* mid-line ("Sure.<think>…").
    /// 2. A fence QUOTED inside the reasoning ("the error says it needs:
    ///    ```eaon:mcp server=…") would otherwise parse as a real call and
    ///    fire phantom tool executions from the model's inner monologue.
    ///
    /// An unclosed span (mid-stream, still thinking) is left untouched —
    /// there's no way to know where it ends yet, and execution only ever
    /// happens on finished text.
    static func strippedOfThinking(_ text: String) -> String {
        // Cheap gate: the regex only runs on text that can possibly match.
        guard text.contains("</think") || text.contains("</THINK") || text.contains("</Think") else { return text }
        let range = NSRange(text.startIndex..., in: text)
        return thinkSpanRegex.stringByReplacingMatches(in: text, range: range, withTemplate: "\n")
    }

    /// Fence languages that unambiguously name a tool call even when the
    /// model drops the `eaon:` prefix — observed live: ```computer
    /// tool="run_shell" (Nemotron, after several failed retries). None of
    /// these collide with a real programming-language fence tag, so
    /// honoring them costs nothing and rescues an otherwise silently
    /// dropped call. Bare tool names (```run_shell) route through the same
    /// shorthand mapping the eaon:-prefixed kinds already use. Not private:
    /// `AssistantMessageContentView` recognizes the same shorthand for
    /// *display* (the request chip/diff card), so a call that executes
    /// correctly is never shown as raw, unrecognized code.
    static func prefixlessToolKind(_ language: String) -> String? {
        if language == "computer" || language == "mcp" { return language }
        if DesktopTool(rawValue: language) != nil { return language }
        return nil
    }

    /// Single line-scan state machine over one message's text. A file block
    /// missing its closing fence (mid-stream) yields `isComplete == false`;
    /// incomplete run/read/ls/mcp blocks are dropped entirely so a
    /// half-streamed tool is never acted on.
    ///
    /// `assumeFinal` flips that trailing-block rule for text that has
    /// FINISHED streaming: there, an unterminated block isn't "still being
    /// written," it's a model that stopped without emitting the closing
    /// fence — a common way for models to end a turn on a tool call. The
    /// agent loop passes true so those calls execute instead of being
    /// silently dropped (which ended the whole loop with no reply and no
    /// error — the "model goes quiet after a tool call" bug).
    static func events(from rawText: String, assumeFinal: Bool = false) -> [Event] {
        let text = strippedOfThinking(rawText)
        enum Mode {
            case outside
            case plainFence
            case file(path: String, language: String?)
            // `path` is the sanitized workspace-relative form (chat kinds:
            // edit/run/read/write); `rawPath` is the attribute verbatim —
            // real disk paths for computer calls, which sanitizing mangles
            // (it strips the leading "/" from absolute paths).
            case tool(kind: String, path: String?, toolName: String?, serverName: String?, rawPath: String?, append: Bool)
        }

        var events: [Event] = []
        var mode = Mode.outside
        var bodyLines: [String] = []

        // `sawFence` is true only when the block was closed by a real ```
        // line; the trailing assumeFinal close passes false so a computer
        // call can tell "model finished the block" from "stream ended
        // mid-block" (which matters for raw-body writes — see ComputerCall).
        func closeBlock(complete: Bool, sawFence: Bool) {
            switch mode {
            case .file(let path, let language):
                events.append(.write(WorkspaceFile(
                    path: path,
                    language: language,
                    content: bodyLines.joined(separator: "\n"),
                    isComplete: complete
                )))
            case .tool(let kind, let path, let toolName, let serverName, let rawPath, let append):
                switch kind {
                case "edit":
                    if let path {
                        events.append(.edit(path: path, payload: complete ? parseEditPayload(bodyLines) : nil))
                    }
                case "run":
                    if complete { events.append(.run(path: path)) }
                case "read":
                    if complete { events.append(.read(path: path)) }
                case "ls", "list":
                    if complete { events.append(.list) }
                case "write":
                    // Not documented, but a natural thing for a model to try.
                    if let path {
                        events.append(.write(WorkspaceFile(
                            path: path,
                            language: nil,
                            content: bodyLines.joined(separator: "\n"),
                            isComplete: complete
                        )))
                    }
                case "mcp":
                    if complete {
                        events.append(.mcpCall(server: serverName, tool: toolName, argumentsJSON: bodyLines.joined(separator: "\n")))
                    }
                case "search":
                    if complete {
                        events.append(.webSearch(argumentsJSON: bodyLines.joined(separator: "\n")))
                    }
                case "image":
                    if complete {
                        events.append(.imageGeneration(argumentsJSON: bodyLines.joined(separator: "\n")))
                    }
                case "computer":
                    if complete {
                        events.append(.computerCall(ComputerCall(
                            tool: toolName, fencePath: rawPath, fenceAppend: append,
                            body: bodyLines.joined(separator: "\n"), sawClosingFence: sawFence
                        )))
                    }
                default:
                    guard complete else { break }
                    // A very common model shorthand: naming the tool as the
                    // kind itself — ```eaon:write_file or ```eaon:run_shell
                    // — instead of the canonical ```eaon:computer
                    // tool="write_file". If the kind is a real device/coding
                    // tool, honor it as a computer call rather than dropping
                    // it (which is what forced the "couldn't be parsed" loop).
                    if DesktopTool(rawValue: kind) != nil {
                        events.append(.computerCall(ComputerCall(
                            tool: kind, fencePath: rawPath, fenceAppend: append,
                            body: bodyLines.joined(separator: "\n"), sawClosingFence: sawFence
                        )))
                    } else if let toolName {
                        // A natural model mistake: naming the service as the
                        // kind itself (```eaon:github tool="x") instead of
                        // ```eaon:mcp server="github". The intent is
                        // unambiguous when a tool attribute is present, so
                        // accept it — a wrong guess still dies with a clear
                        // "unknown service" error fed back to the model,
                        // instead of the whole call being silently dropped.
                        events.append(.mcpCall(server: serverName ?? kind, tool: toolName, argumentsJSON: bodyLines.joined(separator: "\n")))
                    }
                }
            case .outside, .plainFence:
                break
            }
            bodyLines = []
            mode = .outside
        }

        for rawLine in text.split(separator: "\n", omittingEmptySubsequences: false) {
            let line = String(rawLine)
            let trimmed = line.trimmingCharacters(in: .whitespaces)

            switch mode {
            case .file, .tool:
                if trimmed == "```" {
                    closeBlock(complete: true, sawFence: true)
                } else {
                    bodyLines.append(line)
                }
            case .plainFence:
                if trimmed == "```" { mode = .outside }
            case .outside:
                guard trimmed.hasPrefix("```") else { continue }
                let info = fenceInfo(from: String(trimmed.dropFirst(3)))
                // "aqua:" is the legacy spelling of the same convention
                // (pre-rename) — still accepted because models mimic what
                // they see, and older conversations' history is full of
                // aqua:-prefixed blocks. Both prefixes are 5 characters.
                if let language = info.language, language.hasPrefix("eaon:") || language.hasPrefix("aqua:") {
                    mode = .tool(kind: String(language.dropFirst(5)), path: info.path, toolName: info.tool, serverName: info.server, rawPath: info.rawPath, append: info.append)
                    bodyLines = []
                } else if let language = info.language, let kind = prefixlessToolKind(language) {
                    // The eaon: prefix was dropped but the kind is still
                    // unambiguous — treat it exactly like the prefixed form.
                    mode = .tool(kind: kind, path: info.path, toolName: info.tool, serverName: info.server, rawPath: info.rawPath, append: info.append)
                    bodyLines = []
                } else if let path = info.path {
                    mode = .file(path: path, language: info.language)
                    bodyLines = []
                } else {
                    // Ordinary code block — skip past it so a stray "file="
                    // in its *contents* can't be mistaken for a fence.
                    mode = .plainFence
                }
            }
        }
        // Text ended mid-block: still streaming (incomplete), unless the
        // caller says this text is final — then the model just never
        // emitted the closing fence, and the block counts as complete.
        closeBlock(complete: assumeFinal, sawFence: false)
        return events
    }

    /// The whole conversation's workspace, derived by replaying every write
    /// and edit event across the assistant messages in order. A later write
    /// for the same path replaces the content; an edit patches it in place.
    /// Tool-result messages are skipped — a read-back file's contents must
    /// never be re-parsed as new blocks.
    static func files(fromMessages messages: [ChatMessage]) -> [WorkspaceFile] {
        var ordered: [String] = []
        var byPath: [String: WorkspaceFile] = [:]
        for message in messages where !message.isUser && !message.isError && message.isToolResult != true {
            guard mightContainFiles(message.content) else { continue }
            replay(events(from: message.content), ordered: &ordered, byPath: &byPath)
        }
        return ordered.compactMap { byPath[$0] }
    }

    /// Parses one text's events into the files they produce (writes + edits
    /// applied in order) — the single-message view of the same replay.
    static func parse(_ text: String) -> [WorkspaceFile] {
        var ordered: [String] = []
        var byPath: [String: WorkspaceFile] = [:]
        replay(events(from: text), ordered: &ordered, byPath: &byPath)
        return ordered.compactMap { byPath[$0] }
    }

    static func replay(
        _ events: [Event],
        ordered: inout [String],
        byPath: inout [String: WorkspaceFile]
    ) {
        for event in events {
            switch event {
            case .write(let file):
                if byPath[file.path] == nil { ordered.append(file.path) }
                byPath[file.path] = file
            case .edit(let path, let payload):
                guard let payload, var file = byPath[path],
                      case .applied(let newContent) = applyEdit(to: file.content, payload: payload) else { continue }
                file.content = newContent
                file.isComplete = true
                byPath[path] = file
            case .run, .read, .list, .mcpCall, .webSearch, .computerCall, .imageGeneration:
                break
            }
        }
    }

    // MARK: Edits

    enum EditOutcome: Equatable {
        case applied(String)
        case failed(String)
    }

    /// Applies a search/replace edit the same way everywhere (derivation and
    /// the agent loop's result reporting), with str_replace semantics: the
    /// search text must appear exactly once.
    static func applyEdit(to content: String, payload: EditPayload) -> EditOutcome {
        guard !payload.search.isEmpty else {
            return .failed("the SEARCH section is empty")
        }
        let occurrences = content.components(separatedBy: payload.search).count - 1
        if occurrences == 0 {
            return .failed("the SEARCH text was not found in the file — it must match the current contents exactly (check whitespace)")
        }
        if occurrences > 1 {
            return .failed("the SEARCH text appears \(occurrences) times — include more surrounding lines so it matches exactly once")
        }
        return .applied(content.replacingOccurrences(of: payload.search, with: payload.replace))
    }

    /// Extracts the SEARCH/REPLACE sections from an eaon:edit body. Returns
    /// nil when the conflict markers are missing or out of order.
    static func parseEditPayload(_ lines: [String]) -> EditPayload? {
        func isMarker(_ line: String, _ marker: String) -> Bool {
            line.trimmingCharacters(in: .whitespaces) == marker
        }
        guard let searchStart = lines.firstIndex(where: { isMarker($0, "<<<<<<< SEARCH") }) else { return nil }
        guard let divider = lines[(searchStart + 1)...].firstIndex(where: { isMarker($0, "=======") }) else { return nil }
        guard let replaceEnd = lines[(divider + 1)...].firstIndex(where: { isMarker($0, ">>>>>>> REPLACE") }) else { return nil }
        return EditPayload(
            search: lines[(searchStart + 1)..<divider].joined(separator: "\n"),
            replace: lines[(divider + 1)..<replaceEnd].joined(separator: "\n")
        )
    }

    private static let fileAttributeRegex = try! NSRegularExpression(
        pattern: "(?:file|path|filename)\\s*=\\s*(?:\"([^\"]+)\"|'([^']+)'|([^\\s\"']+))",
        options: [.caseInsensitive]
    )

    /// `eaon:mcp` blocks name a tool instead of a file, e.g.
    /// `eaon:mcp server="github" tool="create_issue"` — separate
    /// attributes since neither a tool name nor a server id is ever a
    /// path (no sanitization/slash-splitting applies to either).
    private static let toolAttributeRegex = try! NSRegularExpression(
        pattern: "tool\\s*=\\s*(?:\"([^\"]+)\"|'([^']+)'|([^\\s\"']+))",
        options: [.caseInsensitive]
    )

    private static let serverAttributeRegex = try! NSRegularExpression(
        pattern: "server\\s*=\\s*(?:\"([^\"]+)\"|'([^']+)'|([^\\s\"']+))",
        options: [.caseInsensitive]
    )

    /// `append="true"` on a raw write fence — append to the file instead of
    /// overwriting it (how a long file gets finished in parts).
    private static let appendAttributeRegex = try! NSRegularExpression(
        pattern: "append\\s*=\\s*(?:\"([^\"]+)\"|'([^']+)'|([^\\s\"']+))",
        options: [.caseInsensitive]
    )

    /// Splits a fence info string like `html file="css/style.css"` into its
    /// language, file path, and (for `eaon:mcp`) tool/server names.
    /// `path`/`tool`/`server` are nil when their attribute is absent. Also
    /// accepts path=/filename= and unquoted values, since models vary.
    ///
    /// `path` is sanitized for the chat workspace (always relative, no
    /// escapes); `rawPath` is the same attribute verbatim — what the agent's
    /// raw write form needs, since its paths are REAL disk paths (`~/…`,
    /// `/Users/…`) that sanitizing would mangle. `append` is the
    /// `append="true"` flag of that same form.
    static func fenceInfo(from info: String?) -> (language: String?, path: String?, tool: String?, server: String?, rawPath: String?, append: Bool) {
        guard let info = info?.trimmingCharacters(in: .whitespaces), !info.isEmpty else {
            return (nil, nil, nil, nil, nil, false)
        }

        var path: String?
        var rawPath: String?
        let range = NSRange(info.startIndex..., in: info)
        if let match = fileAttributeRegex.firstMatch(in: info, range: range) {
            for group in 1...3 {
                if let valueRange = Range(match.range(at: group), in: info) {
                    let value = String(info[valueRange]).trimmingCharacters(in: .whitespaces)
                    rawPath = value.isEmpty ? nil : value
                    path = sanitizePath(value)
                    break
                }
            }
        }

        var append = false
        if let match = appendAttributeRegex.firstMatch(in: info, range: range) {
            for group in 1...3 {
                if let valueRange = Range(match.range(at: group), in: info) {
                    append = ["true", "1", "yes"].contains(String(info[valueRange]).lowercased())
                    break
                }
            }
        }

        var tool: String?
        if let match = toolAttributeRegex.firstMatch(in: info, range: range) {
            for group in 1...3 {
                if let valueRange = Range(match.range(at: group), in: info) {
                    tool = String(info[valueRange]).trimmingCharacters(in: .whitespaces)
                    break
                }
            }
        }

        var server: String?
        if let match = serverAttributeRegex.firstMatch(in: info, range: range) {
            for group in 1...3 {
                if let valueRange = Range(match.range(at: group), in: info) {
                    server = String(info[valueRange]).trimmingCharacters(in: .whitespaces)
                    break
                }
            }
        }

        let language = info
            .split(whereSeparator: { $0 == " " || $0 == "\t" })
            .map(String.init)
            .first { !$0.contains("=") }?
            .lowercased()

        return (language, path, tool, server, rawPath, append)
    }

    /// Normalizes a model-supplied path so it's always a safe, relative,
    /// forward-slash path — no absolute paths, no `..` escapes.
    private static func sanitizePath(_ raw: String) -> String? {
        let components = raw
            .replacingOccurrences(of: "\\", with: "/")
            .split(separator: "/")
            .map { String($0).trimmingCharacters(in: .whitespaces) }
            .filter { !$0.isEmpty && $0 != "." && $0 != ".." }
        guard !components.isEmpty else { return nil }
        return components.joined(separator: "/")
    }

    // MARK: Tool-argument recovery

    /// Escapes literal control characters that appear INSIDE JSON string
    /// literals — the single most common way a model's tool JSON goes
    /// invalid (real line breaks inside a "content"/"command" value).
    /// Deterministic and safe: text outside strings is untouched (newlines
    /// between keys are legal JSON whitespace), and already-escaped
    /// sequences pass through unchanged. Cannot fix unescaped inner quotes
    /// — that ambiguity is what the raw write form exists to avoid.
    static func repairedJSONControlCharacters(_ text: String) -> String {
        guard text.contains("\"") else { return text }
        var out = ""
        out.reserveCapacity(text.count + 64)
        var inString = false
        var escaped = false
        for ch in text {
            guard inString else {
                if ch == "\"" { inString = true }
                out.append(ch)
                continue
            }
            if escaped {
                out.append(ch)
                escaped = false
                continue
            }
            switch ch {
            case "\\":
                out.append(ch)
                escaped = true
            case "\"":
                out.append(ch)
                inString = false
            case "\n": out.append("\\n")
            case "\r": out.append("\\r")
            case "\t": out.append("\\t")
            default:
                if let scalar = ch.unicodeScalars.first, ch.unicodeScalars.count == 1, scalar.value < 0x20 {
                    out.append(String(format: "\\u%04x", scalar.value))
                } else {
                    out.append(ch)
                }
            }
        }
        return out
    }

    /// What `salvageWriteFileBody` recovered.
    enum WriteSalvage: Equatable {
        case arguments(path: String, content: String)
        /// The stream was cut off mid-file — refuse to write, and say so,
        /// rather than silently landing a truncated file on disk.
        case truncated
    }

    /// Last-resort recovery for a `write_file` whose body isn't a valid
    /// JSON arguments object — the failure that used to dead-end agent
    /// coding on real source files (HTML/CSS full of quotes and newlines
    /// can't survive being hand-escaped into one JSON string by a model).
    ///
    /// Two shapes are recovered, both observed live:
    /// 1. **Raw form** — the fence names the path
    ///    (```eaon:write_file path="~/x/y.py") and the body IS the file,
    ///    verbatim. Accepted only when the closing ``` was actually seen —
    ///    a cut-off raw body looks like a complete shorter file.
    /// 2. **Broken JSON-wrapper form** — {"path": "...", "content": "<raw
    ///    text with real newlines/quotes>"}. The path is extracted, and the
    ///    content span is taken verbatim when it contains no backslash (the
    ///    model clearly wasn't escaping); a span WITH backslashes must
    ///    decode cleanly as a JSON string or the whole salvage is refused —
    ///    a half-escaped file must never be written half-decoded.
    ///
    /// Returns nil when nothing can be recovered unambiguously (the caller
    /// reports the teaching error, and the model retries in a better
    /// format). Never writes anything itself — pure argument recovery.
    static func salvageWriteFileBody(fencePath: String?, body: String, sawClosingFence: Bool) -> WriteSalvage? {
        let trimmed = body.trimmingCharacters(in: .whitespacesAndNewlines)

        // Broken JSON-wrapper shape — only when it actually looks like one
        // (has BOTH keys); a raw-form body that merely starts with "{"
        // (writing a .json file) must not be mistaken for a wrapper.
        if trimmed.hasPrefix("{"),
           trimmed.contains("\"content\""),
           let path = firstQuotedValue(forKey: "path", in: trimmed), !path.isEmpty,
           let span = contentSpan(in: trimmed) {
            if !span.closed && !sawClosingFence { return .truncated }
            if !span.text.contains("\\") {
                return .arguments(path: path, content: span.text)
            }
            // Escapes present — trust them only if the span decodes cleanly
            // as a JSON string (after the deterministic control-char repair).
            let candidate = repairedJSONControlCharacters("\"" + span.text + "\"")
            if let data = candidate.data(using: .utf8),
               let decoded = try? JSONSerialization.jsonObject(with: data, options: [.fragmentsAllowed]) as? String {
                return .arguments(path: path, content: decoded)
            }
            return nil
        }

        // Raw form: the fence names the path, the body is the file.
        if let fencePath, !fencePath.isEmpty {
            return sawClosingFence ? .arguments(path: fencePath, content: body) : .truncated
        }
        return nil
    }

    /// First `"key": "value"` occurrence's value, verbatim (no unescaping —
    /// used for paths, which models never meaningfully escape).
    private static func firstQuotedValue(forKey key: String, in json: String) -> String? {
        guard let keyRange = json.range(of: "\"\(key)\"") else { return nil }
        let after = json[keyRange.upperBound...]
        guard let colon = after.firstIndex(of: ":") else { return nil }
        let afterColon = after[after.index(after: colon)...]
        guard let open = afterColon.firstIndex(where: { !$0.isWhitespace }), afterColon[open] == "\"" else { return nil }
        let valueStart = afterColon.index(after: open)
        guard let close = afterColon[valueStart...].firstIndex(of: "\"") else { return nil }
        return String(afterColon[valueStart..<close])
    }

    /// The raw span of the "content" value in a JSON-ish wrapper: from just
    /// after its opening quote to the trailing `"}` closer when present
    /// (`closed: true`), else to the end of the text (`closed: false` —
    /// either truncated output or content written raw to the end).
    private static func contentSpan(in json: String) -> (text: String, closed: Bool)? {
        guard let keyRange = json.range(of: "\"content\"") else { return nil }
        let after = json[keyRange.upperBound...]
        guard let colon = after.firstIndex(of: ":") else { return nil }
        let afterColon = after[after.index(after: colon)...]
        guard let open = afterColon.firstIndex(where: { !$0.isWhitespace }), afterColon[open] == "\"" else { return nil }
        let start = afterColon.index(after: open)
        let rest = String(afterColon[start...])

        // Trailing closer: a quote, optional whitespace, "}", optional
        // whitespace, end. (An optional trailing `, "append": true` between
        // the quote and the brace is tolerated — the one extra key the
        // write teaching mentions.)
        if let regex = try? NSRegularExpression(pattern: "\"\\s*(?:,\\s*\"append\"\\s*:\\s*(?:true|false)\\s*)?\\}\\s*$"),
           let match = regex.firstMatch(in: rest, range: NSRange(rest.startIndex..., in: rest)),
           let closerRange = Range(match.range, in: rest) {
            return (String(rest[..<closerRange.lowerBound]), true)
        }
        return (rest, false)
    }
}

// MARK: - File tree

/// A nested explorer-tree built from the workspace's flat path list.
struct WorkspaceTreeNode: Identifiable {
    let name: String
    /// Full file path for files; folder path (used as collapse key) for folders.
    let path: String
    let isFolder: Bool
    var children: [WorkspaceTreeNode] = []

    var id: String { (isFolder ? "dir:" : "file:") + path }
}

enum WorkspaceTree {
    static func build(from files: [WorkspaceFile]) -> [WorkspaceTreeNode] {
        nodes(
            for: files.map { ($0.path.split(separator: "/").map(String.init), $0.path) },
            prefix: ""
        )
    }

    private static func nodes(
        for entries: [(components: [String], fullPath: String)],
        prefix: String
    ) -> [WorkspaceTreeNode] {
        var folderEntries: [String: [(components: [String], fullPath: String)]] = [:]
        var folderOrder: [String] = []
        var fileNodes: [WorkspaceTreeNode] = []

        for entry in entries {
            if entry.components.count == 1 {
                fileNodes.append(WorkspaceTreeNode(name: entry.components[0], path: entry.fullPath, isFolder: false))
            } else {
                let head = entry.components[0]
                if folderEntries[head] == nil { folderOrder.append(head) }
                folderEntries[head, default: []].append((Array(entry.components.dropFirst()), entry.fullPath))
            }
        }

        // Folders first (alphabetical), then files in creation order — the
        // same convention VS Code's explorer uses.
        let folderNodes = folderOrder
            .sorted { $0.localizedCaseInsensitiveCompare($1) == .orderedAscending }
            .map { name in
                let folderPath = prefix.isEmpty ? name : prefix + "/" + name
                return WorkspaceTreeNode(
                    name: name,
                    path: folderPath,
                    isFolder: true,
                    children: nodes(for: folderEntries[name] ?? [], prefix: folderPath)
                )
            }
        return folderNodes + fileNodes
    }
}

// MARK: - File icons

enum WorkspaceFileIcon {
    static func systemName(forPath path: String) -> String {
        switch (path as NSString).pathExtension.lowercased() {
        case "html", "htm": return "globe"
        case "css", "scss", "sass": return "paintbrush"
        case "js", "jsx", "ts", "tsx", "swift", "py", "rb", "go", "rs",
             "c", "cpp", "h", "hpp", "java", "kt", "php", "sh", "sql":
            return "chevron.left.forwardslash.chevron.right"
        case "json", "yml", "yaml", "toml", "xml", "plist": return "curlybraces"
        case "md", "txt": return "doc.text"
        case "png", "jpg", "jpeg", "gif", "svg", "ico", "webp": return "photo"
        case "csv": return "tablecells"
        default: return "doc"
        }
    }
}
