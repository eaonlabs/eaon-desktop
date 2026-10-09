import Foundation

/// A pending question, with the action that happens if the person says yes.
struct PhoneAsk: Codable, Equatable, Sendable {
    var ask: AgentAsk
    /// Set for an approval: the tool and the exact arguments it would run with.
    var action: PendingAction?
}

struct PendingAction: Codable, Equatable, Sendable {
    var tool: String
    var arguments: JSONValue
}

struct PhoneRoutine: Codable, Equatable, Identifiable, Sendable {
    var id: String
    var name: String
    var task: String
    var everyMinutes: Int?
    /// Local clock time, "HH:MM".
    var daily: String?
    var nextAt: Date
}

struct PhoneHeartbeat: Codable, Equatable, Sendable {
    var nextAt: Date
    var everyMinutes: Int?
    var note: String
}

/// Something written to an agent while it was busy, kept for its next turn.
struct PhoneMail: Codable, Equatable, Sendable {
    var text: String
    var goal = false
    var at: Date
}

/// Everything about a phone agent except its conversation, which is kept apart
/// because it grows without bound. One JSON file holds all the records.
struct PhoneAgentRecord: Codable, Equatable, Identifiable, Sendable {
    struct Outcome: Codable, Equatable, Sendable {
        var at: Date
        var ok: Bool
    }

    struct MoodHint: Codable, Equatable, Sendable {
        var mood: AgentMood
        var until: Date
    }

    var id: String
    var name: String
    var colorHex: String
    var purpose: String
    var personality: String
    var access: AgentAccess
    /// A model it is pinned to; nil follows the one chosen in the app.
    var pinned: ModelRef?
    var createdAt: Date

    var goal = ""
    var notes = ""
    var goalRun: AgentGoalRun?
    var asks: [PhoneAsk] = []
    var routines: [PhoneRoutine] = []
    var heartbeat: PhoneHeartbeat?
    var paused = false
    var activity = ""
    var moodHint: MoodHint?
    var lastRunAt: Date?
    var lastOutcome: Outcome?
    var lastError: String?
    var unread = 0
    var inbox: [PhoneMail] = []
    /// When its own schedule woke it, for the hourly budget.
    var selfWakes: [Date] = []

    static let maxRoutines = 10
    static let maxNotes = 3_000
    static let maxGoal = 500
    static let maxSelfWakesPerHour = 12

    /// The soonest it will wake by itself.
    var nextWake: Date? {
        ([heartbeat?.nextAt] + routines.map { Optional($0.nextAt) }).compactMap { $0 }.min()
    }

    var hasSchedule: Bool { nextWake != nil }

    func mood(running: Bool, now: Date) -> AgentMood {
        if paused { return .asleep }
        if lastOutcome?.ok == false, lastError != nil, !running { return .dead }
        if let hint = moodHint, hint.until > now { return hint.mood }
        if running { return .serious }
        if !asks.isEmpty { return .curious }
        if let outcome = lastOutcome, now.timeIntervalSince(outcome.at) < 10 * 60 { return outcome.ok ? .happy : .sad }
        if !hasSchedule && inbox.isEmpty {
            let since = lastRunAt ?? createdAt
            let idle = now.timeIntervalSince(since)
            if idle > 15 * 60 { return .asleep }
            if idle > 5 * 60 { return .sleepy }
        }
        return .neutral
    }

    func status(running: Bool) -> AgentStatus {
        if paused { return .paused }
        if running { return .working }
        if lastOutcome?.ok == false, lastError != nil { return .failed }
        return hasSchedule || !inbox.isEmpty ? .idle : .asleep
    }

    func project(running: Bool, now: Date, modelName: String?) -> Agent {
        Agent(
            key: AgentKey(place: .phone, id: id),
            name: name,
            colorHex: colorHex,
            purpose: purpose,
            personality: personality,
            status: status(running: running),
            mood: mood(running: running, now: now),
            activity: activity,
            access: access,
            modelName: modelName,
            goal: goal,
            goalRun: goalRun,
            asks: asks.map(\.ask),
            unread: unread,
            lastRunAt: lastRunAt,
            lastError: lastError,
            nextWakeAt: paused ? nil : nextWake,
            createdAt: createdAt
        )
    }
}

/// When a routine or heartbeat is next due after `date`.
enum Schedule {
    /// The next time the clock reads `hhmm` after `date`, in `calendar`; nil if it isn't a time.
    static func next(daily hhmm: String, after date: Date, calendar: Calendar = .current) -> Date? {
        let parts = hhmm.split(separator: ":").compactMap { Int($0) }
        guard parts.count == 2, (0..<24).contains(parts[0]), (0..<60).contains(parts[1]) else { return nil }
        return calendar.nextDate(after: date, matching: DateComponents(hour: parts[0], minute: parts[1], second: 0), matchingPolicy: .nextTime)
    }

    /// "8:30", "08:30", "8.30", "8:30pm", "20:30", or an ISO 8601 date and time, as a date after `now`.
    static func parse(_ text: String, after now: Date, calendar: Calendar = .current) -> Date? {
        let trimmed = text.trimmingCharacters(in: .whitespaces)
        if let iso = ISO8601DateFormatter().date(from: trimmed) { return iso > now ? iso : nil }
        let lower = trimmed.lowercased()
        let pm = lower.hasSuffix("pm")
        let am = lower.hasSuffix("am")
        let digits = lower.replacingOccurrences(of: "am", with: "").replacingOccurrences(of: "pm", with: "").replacingOccurrences(of: ".", with: ":").trimmingCharacters(in: .whitespaces)
        let parts = digits.split(separator: ":").compactMap { Int($0) }
        guard parts.count >= 1, parts.count <= 2 else { return nil }
        var hour = parts[0]
        let minute = parts.count == 2 ? parts[1] : 0
        if pm, hour < 12 { hour += 12 }
        if am, hour == 12 { hour = 0 }
        guard (0..<24).contains(hour), (0..<60).contains(minute) else { return nil }
        return calendar.nextDate(after: now, matching: DateComponents(hour: hour, minute: minute, second: 0), matchingPolicy: .nextTime)
    }
}
