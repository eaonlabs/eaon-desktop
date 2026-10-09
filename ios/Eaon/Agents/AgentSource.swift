import Foundation

/// What the person can do about a goal an agent is working on.
enum GoalCommand: Equatable, Sendable {
    case pause
    case resume
    case clear
}

/// A problem with an agent command, in words for the person.
struct AgentError: LocalizedError, Equatable {
    var message: String
    var errorDescription: String? { message }

    static let notConnected = AgentError(message: "Your Mac isn't connected.")
    static func unavailable(_ what: String) -> AgentError { AgentError(message: what) }
}

/// A place agents live: this iPhone, or a Mac. The screens talk to this, so an
/// agent on the phone and an agent on the Mac look and behave the same.
@MainActor
protocol AgentSource: AnyObject {
    var place: AgentPlace { get }
    var agents: [Agent] { get }
    /// Whether it can be used now: always for the phone, only while connected for a Mac.
    var isAvailable: Bool { get }

    func messages(for id: String) -> [AgentMessage]
    func loadThread(_ id: String) async

    func create(_ draft: AgentDraft) async throws -> Agent
    func update(_ id: String, with draft: AgentDraft) async throws
    func remove(_ id: String) async throws

    func send(_ id: String, text: String, asGoal: Bool) async throws
    func stop(_ id: String) async
    func wake(_ id: String) async
    func setPaused(_ id: String, paused: Bool) async
    func setGoal(_ id: String, _ command: GoalCommand) async
    /// Answers a question, or approves or declines the one thing it asked to do.
    func answer(_ id: String, askID: String, text: String?, approved: Bool?) async
    func clear(_ id: String) async
    func markRead(_ id: String) async
}
