import Foundation

/// The wire shapes of Eaon Remote API v1 (docs/remote-api.md in the desktop repo), and how they become the
/// app's own agent types.

struct RemoteHello: Decodable, Equatable, Sendable {
    var app: String
    var apiVersion: Int
    var appVersion: String?
    var name: String
    var workers: Int?
    var running: Int?
}

struct RemoteAsk: Decodable, Equatable, Sendable {
    struct Approve: Decodable, Equatable, Sendable {
        var tool: String
        var summary: String
    }
    var id: String
    var question: String
    var options: [String]?
    var approve: Approve?
    var at: Double
}

struct RemoteWorker: Decodable, Equatable, Sendable {
    struct Model: Decodable, Equatable, Sendable {
        var providerId: String
        var modelId: String
        var label: String
    }
    struct GoalRun: Decodable, Equatable, Sendable {
        var text: String
        var status: String
        var turns: Int?
        var summary: String?
    }
    struct Outcome: Decodable, Equatable, Sendable {
        var at: Double
        var ok: Bool
    }

    var id: String
    var name: String
    var color: String
    var purpose: String
    var personality: String?
    var status: String
    var mood: String?
    var activity: String?
    var paused: Bool
    var access: String
    var model: Model?
    var goal: String?
    var goalRun: GoalRun?
    var asks: [RemoteAsk]?
    var unread: Int?
    var lastRunAt: Double?
    var lastOutcome: Outcome?
    var lastError: String?
    var nextWakeAt: Double?
    var runningMessageId: String?
    var createdAt: Double

    var agent: Agent {
        Agent(
            key: AgentKey(place: .mac, id: id),
            name: name,
            colorHex: color,
            purpose: purpose,
            personality: personality ?? "",
            status: AgentStatus(rawValue: status) ?? .idle,
            mood: AgentMood(wire: mood ?? "neutral"),
            activity: activity ?? "",
            access: AgentAccess(rawValue: access) ?? .autonomous,
            modelName: model?.label,
            goal: goal ?? "",
            goalRun: goalRun.map {
                AgentGoalRun(text: $0.text, state: AgentGoalRun.State(rawValue: $0.status) ?? .active, turns: $0.turns ?? 0, summary: $0.summary)
            },
            asks: (asks ?? []).map {
                AgentAsk(id: $0.id, question: $0.question, options: $0.options ?? [], approval: $0.approve?.summary, at: Self.date($0.at))
            },
            unread: unread ?? 0,
            lastRunAt: lastRunAt.map(Self.date),
            lastError: lastError,
            nextWakeAt: nextWakeAt.map(Self.date),
            createdAt: Self.date(createdAt)
        )
    }

    static func date(_ milliseconds: Double) -> Date {
        Date(timeIntervalSince1970: milliseconds / 1000)
    }
}

struct RemotePart: Decodable, Equatable, Sendable {
    var kind: String
    var text: String?
    var id: String?
    var name: String?
    var title: String?
    var detail: String?
    var status: String?
    var output: String?

    var part: AgentPart? {
        switch kind {
        case "text":
            return .text(text ?? "")
        case "tool":
            guard let id else { return nil }
            return .tool(AgentStep(
                id: id,
                name: name ?? "tool",
                title: title ?? name ?? "Used a tool",
                detail: detail,
                status: AgentStep.Status(rawValue: status ?? "done") ?? .done,
                output: output
            ))
        default:
            return nil
        }
    }
}

struct RemoteMessage: Decodable, Equatable, Sendable {
    struct From: Decodable, Equatable, Sendable {
        var name: String
        var color: String?
    }
    var id: String
    var role: String
    var at: Double
    var from: From?
    var parts: [RemotePart]
    var error: String?
    var heartbeat: String?
    var streaming: Bool?

    var message: AgentMessage {
        AgentMessage(
            id: id,
            role: role == "user" ? .user : .assistant,
            at: RemoteWorker.date(at),
            from: from.map { AgentMessage.Sender(name: $0.name, colorHex: $0.color) },
            parts: parts.compactMap(\.part),
            error: error,
            heartbeat: heartbeat,
            streaming: streaming ?? false
        )
    }
}

struct RemoteModel: Decodable, Equatable, Sendable, Identifiable {
    var id: String
    var name: String
    var provider: String
}

struct RemoteModels: Decodable, Equatable, Sendable {
    var models: [RemoteModel]
    var `default`: String?
}

/// What the Mac pushes down the event stream.
enum RemoteEvent: Equatable, Sendable {
    case workers([RemoteWorker])
    case message(workerID: String, RemoteMessage)
    case delta(workerID: String, messageID: String, text: String)
    case tool(workerID: String, messageID: String, RemotePart)
}

/// Why a call to the Mac failed.
struct RemoteError: LocalizedError, Equatable, Sendable {
    enum Kind: Equatable, Sendable {
        case unreachable
        case unauthorized
        case notFound
        case rateLimited
        case old
        case other
    }

    var kind: Kind
    var message: String

    var errorDescription: String? { message }

    static func unreachable(_ host: String) -> RemoteError {
        RemoteError(kind: .unreachable, message: "Couldn't reach \(host). Check that Eaon is open on the Mac and that Remote devices is on, and that this iPhone is on the same network.")
    }
}

/// Splits a server-sent event stream into events. The stream's own line reader drops blank lines, so an
/// event ends at its `data:` line (the Mac sends each event's data on one line).
struct SSEEventParser: Sendable {
    private var name = "message"

    mutating func feed(line: String) -> (name: String, data: String)? {
        if line.hasPrefix(":") { return nil }
        if line.hasPrefix("event:") {
            name = line.dropFirst(6).trimmingCharacters(in: .whitespaces)
            return nil
        }
        if line.hasPrefix("data:") {
            let data = line.dropFirst(5).trimmingCharacters(in: .whitespaces)
            defer { name = "message" }
            return (name, data)
        }
        return nil
    }
}
