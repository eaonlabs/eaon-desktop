import Foundation

/// What an agent may do with a given tool right now.
enum ToolDecision: Equatable {
    case allow
    /// A change it may not make alone: the person is asked, and it happens if they say yes.
    case askFirst
    case refuse
}

/// Runs the tools an agent calls: checks its access level, records each step
/// in the transcript as it starts and ends, and keeps outputs short.
///
/// Both engines (OpenAI-style tool calls, and Apple's on-device model) call
/// `execute`, so the rules live here once.
@MainActor
final class ToolRunner {
    let tools: [AgentTool]
    let access: AgentAccess
    /// Called with each step as it starts and again as it ends.
    var onStep: (AgentStep) -> Void = { _ in }
    /// A change a "Careful" agent isn't allowed to make alone: the runtime asks the person.
    var onNeedsApproval: (AgentTool, JSONObject) -> Void = { _, _ in }
    /// Calls so far this turn, to stop a model that loops.
    private(set) var calls = 0
    private var recent: [String: Int] = [:]

    static let maxCalls = 14
    static let maxOutput = 4_000
    /// The same call this many times in a turn is a loop.
    static let repeatLimit = 3

    init(tools: [AgentTool], access: AgentAccess) {
        self.tools = tools
        self.access = access
    }

    func decision(for tool: AgentTool) -> ToolDecision {
        switch (tool.risk, access) {
        case (.read, _), (.own, _): .allow
        case (.write, .autonomous): .allow
        case (.write, .safe): .askFirst
        case (.write, .readOnly): .refuse
        }
    }

    /// Runs one call and returns what the model should read.
    func execute(name: String, arguments: JSONObject, id: String = UUID().uuidString) async -> String {
        guard let tool = tools.first(where: { $0.name == name }) else {
            return "There is no tool called \(name). Use one of: \(tools.map(\.name).joined(separator: ", "))."
        }
        calls += 1
        if calls > Self.maxCalls { return "Too many tool calls in one turn. Stop and report what you have." }
        let signature = name + JSONValue.object(arguments).canonical
        recent[signature, default: 0] += 1
        if recent[signature, default: 0] > Self.repeatLimit {
            return "You have made this same call \(Self.repeatLimit) times. It won't give a different answer; use what you have or try something else."
        }

        var step = AgentStep(id: id, name: name, title: tool.title(arguments), detail: tool.detail(arguments), status: .running)
        onStep(step)

        switch decision(for: tool) {
        case .refuse:
            step.status = .denied
            step.output = "Not allowed: this agent can only look."
            onStep(step)
            return "Refused: this agent's access is Look only, so it cannot change anything. Tell the person what you would have done."
        case .askFirst:
            step.status = .denied
            step.output = "Waiting for your OK."
            onStep(step)
            onNeedsApproval(tool, arguments)
            return "Not done yet: this needs the person's OK, and they have been asked. Carry on with anything else, and say that you are waiting for their answer."
        case .allow:
            break
        }

        do {
            var output = try await tool.run(arguments)
            if output.count > Self.maxOutput { output = String(output.prefix(Self.maxOutput)) + "\n[cut: \(output.count - Self.maxOutput) more characters]" }
            step.status = .done
            step.output = String(output.prefix(800))
            onStep(step)
            return output
        } catch let refusal as ToolRefusal {
            step.status = .error
            step.output = refusal.message
            onStep(step)
            return "Failed: \(refusal.message)"
        } catch is CancellationError {
            step.status = .error
            step.output = "Stopped."
            onStep(step)
            return "Stopped."
        } catch {
            step.status = .error
            step.output = error.localizedDescription
            onStep(step)
            return "Failed: \(error.localizedDescription)"
        }
    }

    /// Runs a call the person has just approved, skipping the access check.
    func executeApproved(_ tool: AgentTool, arguments: JSONObject) async -> (output: String, step: AgentStep) {
        var step = AgentStep(id: UUID().uuidString, name: tool.name, title: tool.title(arguments), detail: tool.detail(arguments), status: .running)
        do {
            let output = try await tool.run(arguments)
            step.status = .done
            step.output = String(output.prefix(800))
            return (output, step)
        } catch let refusal as ToolRefusal {
            step.status = .error
            step.output = refusal.message
            return ("Failed: \(refusal.message)", step)
        } catch {
            step.status = .error
            step.output = error.localizedDescription
            return ("Failed: \(error.localizedDescription)", step)
        }
    }
}
