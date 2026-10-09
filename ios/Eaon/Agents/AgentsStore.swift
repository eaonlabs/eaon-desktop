import Foundation
import Observation

/// Every agent the person has, wherever it runs: the phone's, and the connected Mac's.
@MainActor
@Observable
final class AgentsStore {
    let phone: PhoneAgents
    let mac: MacAgents
    /// Set to take the person to an agent's page: a tapped notification, a new agent.
    var openRequest: AgentKey?

    init(phone: PhoneAgents, mac: MacAgents) {
        self.phone = phone
        self.mac = mac
    }

    func source(_ place: AgentPlace) -> any AgentSource {
        switch place {
        case .phone: phone
        case .mac: mac
        }
    }

    func agent(_ key: AgentKey) -> Agent? {
        source(key.place).agents.first { $0.key == key }
    }

    var all: [Agent] { phone.agents + mac.agents }
    var isEmpty: Bool { phone.agents.isEmpty && mac.agents.isEmpty }

    /// How many agents are waiting on an answer, for the tab's badge.
    var waitingOnYou: Int { all.filter(\.needsYou).count }
}

/// The words for an agent's state, one line.
enum AgentWords {
    static func line(for agent: Agent, now: Date = Date()) -> String {
        if agent.needsYou { return agent.asks.first?.question ?? "Has a question" }
        switch agent.status {
        case .working: return agent.activity.isEmpty ? "Working…" : agent.activity
        case .paused: return "Paused"
        case .failed: return agent.lastError ?? "Something went wrong"
        case .idle, .asleep:
            if !agent.activity.isEmpty { return agent.activity }
            if let next = agent.nextWakeAt, next > now { return "Checks in \(AgentPrompt.relative(next, now: now))" }
            if let last = agent.lastRunAt { return "Last worked \(last.formatted(.relative(presentation: .named)))" }
            return agent.status == .asleep ? "Waiting for you to write to it" : "Ready"
        }
    }

    static func status(for agent: Agent) -> String {
        if agent.needsYou { return "Waiting for you" }
        return switch agent.status {
        case .working: "Working"
        case .paused: "Paused"
        case .failed: "Failed"
        case .asleep: "Resting"
        case .idle: "Awake"
        }
    }
}
