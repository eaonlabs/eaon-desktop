import Foundation
import Observation

/// One line of the agent's plan for the current task.
struct PlanStep: Identifiable, Equatable {
    enum Status: String, CaseIterable {
        case pending
        case active
        case done
    }

    var text: String
    var status: Status
    /// Position, not identity — the model sends the whole list every time,
    /// so there's nothing stable to key off and nothing that needs to be.
    var id: Int
}

/// Parsing and normalising an `update_plan` call.
///
/// ## Why an agent needs a plan at all
///
/// On a five-step task ("add the endpoint, wire the client, write a test,
/// run it, fix what breaks") a model with no written plan is working from
/// whatever survived in its context. What actually happens is that it
/// finishes step three, the transcript has grown, and it either declares
/// victory early or quietly redoes step two. Writing the plan down and
/// ticking it off is a small amount of structure that keeps a long loop
/// pointed at the same target — and it is the difference between the user
/// watching an opaque stream of tool calls and watching progress.
///
/// The whole list is re-sent on every update rather than patched. Patching
/// needs stable ids, ids need bookkeeping, and bookkeeping is exactly what a
/// model gets wrong halfway through a long task; re-sending is idempotent
/// and impossible to desynchronise.
enum PlanUpdate {
    enum Parsed {
        case steps([PlanStep])
        case invalid(reason: String)
    }

    /// The plan the tool call describes, or a message explaining what was
    /// wrong with it. Normalises rather than rejecting wherever the intent
    /// is unambiguous — a rejected plan update costs a whole turn.
    static func parse(_ raw: Any?) -> Parsed {
        guard let items = raw as? [Any] else {
            return .invalid(reason: "\"steps\" must be a list of {\"text\": …, \"status\": …} objects.")
        }
        guard !items.isEmpty else { return .steps([]) }
        guard items.count <= 20 else {
            return .invalid(reason: "That's \(items.count) steps — a plan this long is a to-do list, not a plan. Keep it to the handful of real milestones (20 max).")
        }

        var steps: [PlanStep] = []
        for (index, item) in items.enumerated() {
            let text: String
            var status = PlanStep.Status.pending

            if let string = item as? String {
                // A bare list of strings is an obvious intent; taking it
                // rather than erroring saves a wasted turn on a model that
                // guessed the simpler shape.
                text = string
            } else if let object = item as? [String: Any] {
                guard let value = object["text"] as? String else {
                    return .invalid(reason: "step \(index + 1) has no \"text\".")
                }
                text = value
                if let rawStatus = object["status"] as? String,
                   let parsed = PlanStep.Status(rawValue: rawStatus.lowercased()) {
                    status = parsed
                } else if let rawStatus = object["status"] as? String {
                    // Common synonyms, mapped rather than refused.
                    switch rawStatus.lowercased() {
                    case "in_progress", "in progress", "running", "current": status = .active
                    case "completed", "complete", "finished": status = .done
                    case "todo", "not_started": status = .pending
                    default:
                        return .invalid(reason: "step \(index + 1) has status \"\(rawStatus)\" — use pending, active, or done.")
                    }
                }
            } else {
                return .invalid(reason: "step \(index + 1) must be an object with \"text\" and \"status\".")
            }

            let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
            guard !trimmed.isEmpty else { return .invalid(reason: "step \(index + 1) has empty text.") }
            steps.append(PlanStep(text: trimmed, status: status, id: index))
        }

        return .steps(normalized(steps))
    }

    /// Exactly one step may be active. A plan with three things "in
    /// progress" tells the user nothing about where the agent actually is,
    /// which is the only question the plan exists to answer — so extras are
    /// demoted rather than the update being refused.
    static func normalized(_ steps: [PlanStep]) -> [PlanStep] {
        var seenActive = false
        return steps.map { step in
            var step = step
            if step.status == .active {
                if seenActive { step.status = .pending } else { seenActive = true }
            }
            return step
        }
    }

    /// What the tool reports back — the model reads this, so it says what
    /// the plan now looks like rather than just "ok".
    static func receipt(for steps: [PlanStep]) -> String {
        guard !steps.isEmpty else { return "Plan cleared." }
        let done = steps.filter { $0.status == .done }.count
        let lines = steps.map { step in
            let mark: String
            switch step.status {
            case .done: mark = "[x]"
            case .active: mark = "[>]"
            case .pending: mark = "[ ]"
            }
            return "\(mark) \(step.text)"
        }
        return "Plan updated (\(done)/\(steps.count) done):\n" + lines.joined(separator: "\n")
    }
}

/// The plan the user sees, one per conversation.
///
/// Keyed by conversation because a background generation in another chat
/// must not overwrite the plan you're looking at — the same reason the
/// generation pipeline tracks `isGenerating` per conversation rather than
/// with one shared flag.
@MainActor
@Observable
final class AgentPlanStore {
    static let shared = AgentPlanStore()

    private var plans: [UUID: [PlanStep]] = [:]
    /// Plans for a conversation that hasn't been saved yet (no id until the
    /// first message lands), moved across by `adopt` once it has one.
    private var unsaved: [PlanStep] = []

    private init() {}

    func steps(for conversationId: UUID?) -> [PlanStep] {
        guard let conversationId else { return unsaved }
        return plans[conversationId] ?? []
    }

    func set(_ steps: [PlanStep], for conversationId: UUID?) {
        if let conversationId {
            plans[conversationId] = steps
        } else {
            unsaved = steps
        }
    }

    /// Moves the not-yet-saved plan onto the id the conversation just got,
    /// so a plan written before the first save isn't stranded.
    func adopt(conversationId: UUID) {
        guard !unsaved.isEmpty else { return }
        plans[conversationId] = unsaved
        unsaved = []
    }

    func clear(for conversationId: UUID?) {
        set([], for: conversationId)
    }
}
