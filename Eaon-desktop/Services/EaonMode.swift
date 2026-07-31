import Foundation

/// The app's top-level modes, selected in the sidebar. A mode is a
/// *capability context*: it decides which tools the model is offered, which
/// teaching blocks go into the system prompt, and how long the agent loop is
/// allowed to run — all in `ChatViewModel`. The chat surface itself is shared
/// across both (they're both conversational). Image generation is its own
/// independent capability (see `ChatViewModel.imageModels`) reachable by
/// picking an image model from the regular model picker in either mode — it
/// isn't gated behind a dedicated mode of its own.
///
/// Deliberately not tied to any one screen — `ChatViewModel.currentMode`
/// persists across launches, and the sidebar reflects it.
///
/// Eaon Claw used to be a third mode here, holding the full device-control
/// catalog (files, apps, browser, AppleScript) separately from Agent's
/// coding-only tool subset. It's folded into Agent now: Agent is the one
/// general-purpose on-device mode, with a Sandboxed/Auto toggle that governs
/// every tool it can call, and an explicit, off-by-default opt-in in
/// Settings (`DesktopControlStore.isEnabled`, formerly Claw's own enable
/// gate) that widens its tool set from just coding to the full device
/// catalog when the user turns it on.
enum EaonMode: String, CaseIterable, Codable, Identifiable {
    /// Plain conversation. Web search and connected plugins still apply if
    /// the user turned them on, but no code execution and no device control.
    case chat
    /// The general on-device agent: writes real source files to the user's
    /// Mac, runs them, reads the output, and iterates until they work — the
    /// Claude-Code-style loop. With device control turned on in Settings, it
    /// can also organize files and drive apps/the browser for real
    /// multi-step tasks (deep research, shopping research, and more). A
    /// Sandboxed/Auto toggle (Shift+Tab) controls whether it confirms each
    /// action or runs them automatically, across everything it can do.
    case agent
    /// A real, developer-focused TUI — the already-built `eaon-cli`
    /// running in an embedded terminal (see `EmbeddedTerminalView`).
    /// Distinct from Agent: Agent is a GUI chat surface that happens to
    /// write files, Code is an actual terminal session with its own
    /// prompt, history, and keybindings, for the developer workflows a
    /// chat bubble UI doesn't fit (running test suites interactively,
    /// piping commands, git operations). Phase one embeds the CLI as-is;
    /// native panels (file tree, test runner, deploy) are a later phase.
    case code

    var id: String { rawValue }

    /// The modes offered in the composer's mode switcher (see
    /// `ModeSegmentedControl`) — Chat and Agent only. Code isn't picked from
    /// there; it's reached only by whatever route led you into it before
    /// (a persisted `currentMode` from an earlier session), and its own
    /// screen has its own way back to Chat. `EaonMode.allCases` still
    /// includes `.code` — this is deliberately a separate, smaller list
    /// rather than a change to the type's full case set, so nothing that
    /// depends on the complete enum (persistence, `RootView`'s routing)
    /// has to change.
    static let switcherCases: [EaonMode] = [.chat, .agent]

    /// Which history list a conversation belongs to. Chat and Work each keep
    /// their own; Code has no chat history of its own — it's a terminal, not
    /// a conversation surface — so it borrows Chat's rather than showing an
    /// empty sidebar or a list it can't add to.
    var conversationScope: EaonMode {
        self == .agent ? .agent : .chat
    }

    /// Full label for the sidebar row.
    var title: String {
        switch self {
        case .chat: return "Chat"
        case .agent: return "Eaon Work"
        case .code: return "Code"
        }
    }

    var icon: String {
        switch self {
        case .chat: return "bubble.left.and.bubble.right.fill"
        case .agent: return "hammer.fill"
        case .code: return "terminal.fill"
        }
    }

    /// One-line description shown under the mode's own empty state.
    var blurb: String {
        switch self {
        case .chat: return "Just talk — ask anything."
        case .agent: return "Build, run, and debug real code — and with device control on, get real tasks done on your Mac."
        case .code: return "A real terminal running Eaon's CLI agent — for git, test runners, and anything else a chat bubble doesn't fit."
        }
    }

    /// The composer placeholder, matched to what the mode is for.
    var composerPlaceholder: String {
        switch self {
        case .chat: return "Message Eaon…"
        case .agent: return "Describe what to build or get done…"
        case .code: return ""
        }
    }
}
