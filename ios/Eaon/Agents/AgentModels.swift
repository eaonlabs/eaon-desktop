import Foundation

/// Where an agent runs: on this iPhone, or on a Mac running Eaon Desktop.
enum AgentPlace: String, Codable, Hashable, Sendable {
    case phone
    case mac

    var title: String {
        switch self {
        case .phone: "This iPhone"
        case .mac: "Your Mac"
        }
    }
}

struct AgentKey: Hashable, Codable, Sendable {
    var place: AgentPlace
    var id: String
}

enum AgentStatus: String, Codable, Sendable {
    /// Awake with nothing to do right now.
    case idle
    /// A turn is running.
    case working
    /// Nothing scheduled; it wakes when someone writes to it.
    case asleep
    case paused
    /// The last turn ended in an error.
    case failed
}

/// The faces an agent can make. Mirrors the desktop's WorkerMood.
enum AgentMood: String, Codable, Sendable, CaseIterable {
    case neutral, happy, excited, serious, curious, surprised, sad, angry, sleepy, asleep, dead

    init(wire: String) {
        self = AgentMood(rawValue: wire) ?? .neutral
    }
}

/// How much an agent may do alone. The same three levels as the desktop's Freedom setting.
enum AgentAccess: String, Codable, CaseIterable, Sendable, Identifiable {
    case autonomous
    case safe
    case readOnly = "read-only"

    var id: String { rawValue }

    var title: String {
        switch self {
        case .autonomous: "Autonomous"
        case .safe: "Careful"
        case .readOnly: "Look only"
        }
    }

    func summary(on place: AgentPlace) -> String {
        switch (self, place) {
        case (.autonomous, .phone): "Acts on its own: reads the web, keeps notes, and adds events and reminders."
        case (.safe, .phone): "Reads and keeps notes on its own, and asks you before it adds an event or a reminder."
        case (.readOnly, .phone): "Only looks: reads the web and your calendar, and reports back."
        case (.autonomous, .mac): "Acts on its own: files, commands, plugins, its browser and your Mac. It never spends money, types passwords or uses sudo; it asks you."
        case (.safe, .mac): "Makes ordinary changes on its own; anything risky is refused and reported to you."
        case (.readOnly, .mac): "Reads, searches and reports; it never changes anything."
        }
    }
}

/// A question an agent put to the person without stopping its work.
struct AgentAsk: Identifiable, Codable, Equatable, Sendable {
    var id: String
    var question: String
    /// Quick answers, as buttons. Writing their own is always possible.
    var options: [String] = []
    /// Set when it asks to do one specific thing it may not do alone: what it would do.
    var approval: String?
    var at: Date
}

struct AgentGoalRun: Codable, Equatable, Sendable {
    enum State: String, Codable, Sendable { case active, achieved, blocked, paused }
    var text: String
    var state: State
    var turns: Int = 0
    var summary: String?
}

/// What lists and headers show about an agent, wherever it runs.
struct Agent: Identifiable, Equatable, Sendable {
    var key: AgentKey
    var name: String
    var colorHex: String
    var purpose: String
    var personality: String = ""
    var status: AgentStatus = .idle
    var mood: AgentMood = .neutral
    /// The agent's own one-line account of what it is doing.
    var activity: String = ""
    var access: AgentAccess = .autonomous
    var modelName: String?
    var goal: String = ""
    var goalRun: AgentGoalRun?
    var asks: [AgentAsk] = []
    var unread: Int = 0
    var lastRunAt: Date?
    var lastError: String?
    var nextWakeAt: Date?
    var createdAt: Date = Date()

    var id: String { "\(key.place.rawValue):\(key.id)" }
    var place: AgentPlace { key.place }
    var isWorking: Bool { status == .working }
    var isPaused: Bool { status == .paused }
    var needsYou: Bool { !asks.isEmpty }
}

/// One step an agent took with a tool: reading a page, adding a reminder.
struct AgentStep: Identifiable, Codable, Equatable, Sendable {
    enum Status: String, Codable, Sendable { case running, done, denied, error }
    var id: String
    var name: String
    /// "Read a web page", "Added a reminder".
    var title: String
    /// One line: the address, the reminder's text.
    var detail: String?
    var status: Status = .running
    var output: String?
}

enum AgentPart: Codable, Equatable, Sendable {
    case text(String)
    case tool(AgentStep)
}

struct AgentMessage: Identifiable, Codable, Equatable, Sendable {
    enum Role: String, Codable, Sendable { case user, assistant }
    struct Sender: Codable, Equatable, Sendable {
        var name: String
        var colorHex: String?
    }

    var id: String
    var role: Role
    var at: Date
    /// Who wrote a user turn that wasn't the person.
    var from: Sender?
    var parts: [AgentPart]
    var error: String?
    /// An assistant turn woken by its own schedule: its note.
    var heartbeat: String?
    var streaming = false

    var text: String {
        parts.compactMap { if case .text(let text) = $0 { text } else { nil } }.joined(separator: "\n\n")
    }

    var steps: [AgentStep] {
        parts.compactMap { if case .tool(let step) = $0 { step } else { nil } }
    }

    /// Adds text to the last text part, or starts one after a tool step.
    mutating func append(text piece: String) {
        guard !piece.isEmpty else { return }
        if case .text(let existing)? = parts.last {
            parts[parts.count - 1] = .text(existing + piece)
        } else {
            parts.append(.text(piece))
        }
    }

    /// Adds a step, or replaces the one with the same id.
    mutating func upsert(step: AgentStep) {
        if let index = parts.firstIndex(where: { if case .tool(let existing) = $0 { existing.id == step.id } else { false } }) {
            parts[index] = .tool(step)
        } else {
            parts.append(.tool(step))
        }
    }
}

/// What the new-agent and edit sheets send.
struct AgentDraft: Equatable, Sendable {
    var name = ""
    var colorHex = "#3E86C6"
    var purpose = ""
    var personality = ""
    var access: AgentAccess = .autonomous
    /// On the Mac: a model it is pinned to, as "provider/model"; nil follows the app's choice.
    var modelID: String?
    /// On the phone: the model it is pinned to; nil follows the one chosen in Chat.
    var pinned: ModelRef?
}

/// The colours an agent can be given: the desktop's WORKER_COLORS, so an agent looks the same on both.
enum AgentPalette {
    static let hex: [String] = [
        "#3E86C6", "#5B6CF0", "#8E5CE6", "#D6509B", "#E4574B",
        "#EE8A36", "#E7B727", "#3FAE6A", "#22A7A0", "#6B7280"
    ]
}

/// Starting points for a new agent: the desktop's roles, and a few that suit a phone.
struct AgentTemplate: Identifiable, Equatable, Sendable {
    var id: String
    var role: String
    var symbol: String
    var purpose: String
    var personality: String
    var colorHex: String
    var places: Set<AgentPlace>

    static let all: [AgentTemplate] = [
        AgentTemplate(
            id: "briefing", role: "Daily briefing", symbol: "sun.max",
            purpose: "Every morning, looks at today's calendar and the weather, and sends a short, useful briefing: what's on, what to prepare, what could go wrong.",
            personality: "Calm and concise. Leads with what matters most.",
            colorHex: "#EE8A36", places: [.phone]
        ),
        AgentTemplate(
            id: "researcher", role: "Researcher", symbol: "magnifyingglass",
            purpose: "Finds and checks information: reads sources and reports findings with links, clearly separating facts from guesses.",
            personality: "Inquisitive and thorough. Digs until it understands why.",
            colorHex: "#3E86C6", places: [.phone, .mac]
        ),
        AgentTemplate(
            id: "reminders", role: "Reminder keeper", symbol: "checklist",
            purpose: "Turns what you tell it into reminders and calendar events at the right time, and nudges you about what's still open.",
            personality: "Friendly and exact. Confirms the time before it books anything.",
            colorHex: "#3FAE6A", places: [.phone]
        ),
        AgentTemplate(
            id: "writer", role: "Writer", symbol: "pencil.and.outline",
            purpose: "Turns notes and findings into clear writing: drafts, edits and polishes messages, posts and documents in the voice you ask for.",
            personality: "Warm and precise. Cuts filler and keeps the reader in mind.",
            colorHex: "#D6509B", places: [.phone, .mac]
        ),
        AgentTemplate(
            id: "coder", role: "Coder", symbol: "chevron.left.forwardslash.chevron.right",
            purpose: "Writes and changes code: implements features, fixes bugs, runs the tests and explains what changed.",
            personality: "Methodical and pragmatic. Tests before calling anything done.",
            colorHex: "#5B6CF0", places: [.mac]
        ),
        AgentTemplate(
            id: "reviewer", role: "Reviewer", symbol: "checkmark.seal",
            purpose: "Reviews work: checks code, writing and plans for mistakes, gaps and risks, and gives specific, actionable feedback.",
            personality: "Blunt but fair. Points at the problem and the fix.",
            colorHex: "#E4574B", places: [.mac]
        ),
        AgentTemplate(
            id: "analyst", role: "Data analyst", symbol: "chart.bar",
            purpose: "Works with data: cleans files, runs analyses and summarises what the numbers say and how sure it is.",
            personality: "Calm and numerate. Shows its working.",
            colorHex: "#22A7A0", places: [.mac]
        ),
        AgentTemplate(
            id: "planner", role: "Project lead", symbol: "list.bullet.rectangle",
            purpose: "Breaks a goal into tasks, follows up, and pulls the results together for you.",
            personality: "Steady and organised. Keeps everything moving and you informed.",
            colorHex: "#8E5CE6", places: [.phone, .mac]
        )
    ]

    static func templates(for place: AgentPlace) -> [AgentTemplate] {
        all.filter { $0.places.contains(place) }
    }
}
