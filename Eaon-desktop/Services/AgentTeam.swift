import Foundation

/// One member of the team the orchestrator convened for this task. `role` is
/// the one-line brief that becomes that member's system prompt, so a sub-agent
/// works from a genuinely different vantage point rather than being the same
/// assistant under a different name.
struct TeamMember: Codable, Equatable {
    let name: String
    let role: String
}

/// One unit of work the orchestrator split out, handed to a single sub-agent.
///
/// `dependsOn` is what makes this a team rather than a fan-out: a task that
/// names prerequisites does not start until they have finished, and it is
/// handed their output. Everything with no outstanding prerequisite runs at
/// the same time.
struct TeamTask: Codable, Equatable, Identifiable {
    /// Short, unique within a plan — the handle `dependsOn` refers to.
    let id: String
    let title: String
    /// What this sub-agent is actually asked to do, in full. This becomes its
    /// instruction, so it has to stand on its own: the sub-agent cannot see
    /// the rest of the plan.
    let brief: String
    /// The member whose vantage point this task is done from.
    let assignee: String
    var dependsOn: [String] = []
}

enum TeamTaskState: String, Codable, Equatable {
    /// Waiting on a prerequisite.
    case blocked
    case running
    case done
    case failed
    /// Never started — a prerequisite failed, or the run was cancelled.
    case skipped
}

struct TeamTaskResult: Codable, Equatable {
    let taskId: String
    let title: String
    let assignee: String
    var state: TeamTaskState
    var output: String = ""
    /// What the sub-agent did on the way, for the panel — not fed back to the
    /// model, which only needs the result.
    var activity: [String] = []
}

/// A finished (or in-flight) team run: the problem as the orchestrator
/// understood it, who it convened, the task graph, and how each task went.
struct TeamRun: Codable, Equatable {
    var task: String
    var problem: String = ""
    var members: [TeamMember] = []
    var tasks: [TeamTask] = []
    var results: [TeamTaskResult] = []

    /// Results worth handing to the synthesizer. A failed sub-agent
    /// contributes nothing to assemble from but stays in `results` for the
    /// panel, so a partial run reads as partial rather than silently smaller.
    var usableResults: [TeamTaskResult] {
        results.filter { $0.state == .done && !$0.output.isEmpty }
    }

    func result(for taskId: String) -> TeamTaskResult? {
        results.first { $0.taskId == taskId }
    }
}

/// Turns the user's request into a problem statement, a roster, and a task
/// graph. The orchestrator does no work itself — it decides what the work IS
/// and who does it.
enum TeamPlanner {
    /// Bounds on the plan. These are not tuning knobs so much as guards: one
    /// task is not a team, and a twenty-task graph on a chat message is a
    /// runaway, not a plan.
    static let minTasks = 2
    static let maxTasks = 8
    static let maxMembers = 6

    static func planningPrompt(task: String) -> String {
        """
        You are the ORCHESTRATOR of an agent team. You do not do the work yourself. You decide what the work IS, split it up, and assign it.

        The user's request:
        \(task)

        First, state the problem in your own words — what is actually being asked for, and what "done" looks like.

        Then assemble a team of up to \(maxMembers) specialists whose expertise genuinely bears on THIS request, each with a distinct vantage point.

        Then split the work into \(minTasks)–\(maxTasks) concrete tasks. For each task:
        - Give it a short lowercase id (e.g. "schema", "api", "tests").
        - Write a brief that STANDS ON ITS OWN. The specialist doing it cannot see the rest of the plan or this conversation — everything they need must be in the brief.
        - Assign it to one member by name.
        - List the ids of any tasks that must FINISH FIRST, in dependsOn. Their output is handed to this task. Leave it empty for anything that can start immediately.

        Split for genuine parallelism: tasks that could run at the same time should not depend on each other. Only add a dependency where the second task truly needs the first one's output. Do not invent make-work to fill the team — fewer, real tasks beat many thin ones.

        Reply with ONLY a JSON object, no prose and no code fence:
        {"problem":"...","team":[{"name":"Engineer","role":"what they care about"}],"tasks":[{"id":"schema","title":"Design the schema","brief":"...","assignee":"Engineer","dependsOn":[]}]}
        """
    }

    enum PlanError: Error, Equatable {
        case unparseable
        case tooFewTasks
        case unknownAssignee(String)
        case unknownDependency(task: String, missing: String)
        case cycle([String])
    }

    /// Pulls the plan out of whatever the model actually returned — bare,
    /// fenced, or with a sentence in front of it — then checks it is
    /// *runnable*. An unparseable or incoherent plan is rejected outright so
    /// the caller can fall back to answering normally, rather than dispatching
    /// a graph that deadlocks or names people who do not exist.
    static func parse(_ raw: String, task: String) -> Result<TeamRun, PlanError> {
        guard let start = raw.firstIndex(of: "{"), let end = raw.lastIndex(of: "}"), start < end,
              let data = String(raw[start...end]).data(using: .utf8),
              let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any]
        else { return .failure(.unparseable) }

        let members: [TeamMember] = (json["team"] as? [[String: Any]] ?? []).compactMap {
            guard let name = ($0["name"] as? String)?.trimmingCharacters(in: .whitespacesAndNewlines),
                  !name.isEmpty else { return nil }
            return TeamMember(name: name, role: ($0["role"] as? String) ?? "")
        }
        var seenIds = Set<String>()
        let tasks: [TeamTask] = (json["tasks"] as? [[String: Any]] ?? []).compactMap {
            guard let id = ($0["id"] as? String)?.trimmingCharacters(in: .whitespacesAndNewlines),
                  !id.isEmpty, !seenIds.contains(id),
                  let brief = $0["brief"] as? String, !brief.isEmpty
            else { return nil }
            seenIds.insert(id)
            return TeamTask(
                id: id,
                title: ($0["title"] as? String) ?? id,
                brief: brief,
                assignee: ($0["assignee"] as? String) ?? members.first?.name ?? "",
                dependsOn: ($0["dependsOn"] as? [String]) ?? []
            )
        }
        guard tasks.count >= minTasks else { return .failure(.tooFewTasks) }

        let capped = Array(tasks.prefix(maxTasks))
        let ids = Set(capped.map(\.id))
        let names = Set(members.map(\.name))
        for task in capped {
            guard names.contains(task.assignee) else { return .failure(.unknownAssignee(task.assignee)) }
            // A dependency dropped by the cap, or simply invented, would block
            // that task forever — caught here rather than at dispatch.
            for dependency in task.dependsOn where !ids.contains(dependency) {
                return .failure(.unknownDependency(task: task.id, missing: dependency))
            }
        }
        if let cycle = firstCycle(in: capped) { return .failure(.cycle(cycle)) }

        var run = TeamRun(task: task)
        run.problem = (json["problem"] as? String) ?? ""
        run.members = Array(members.prefix(maxMembers))
        run.tasks = capped
        return .success(run)
    }

    /// Depth-first cycle check. A cyclic graph is the one plan shape that
    /// would hang the dispatcher forever rather than failing loudly, so it is
    /// rejected before anything runs.
    static func firstCycle(in tasks: [TeamTask]) -> [String]? {
        let byId = Dictionary(uniqueKeysWithValues: tasks.map { ($0.id, $0) })
        var visiting = Set<String>()
        var settled = Set<String>()
        var stack: [String] = []

        func walk(_ id: String) -> [String]? {
            if settled.contains(id) { return nil }
            if visiting.contains(id) {
                // Report the cycle from where it closes, so the message names
                // the loop rather than the whole path that reached it.
                let from = stack.firstIndex(of: id) ?? 0
                return Array(stack[from...]) + [id]
            }
            visiting.insert(id)
            stack.append(id)
            for next in byId[id]?.dependsOn ?? [] {
                if let found = walk(next) { return found }
            }
            stack.removeLast()
            visiting.remove(id)
            settled.insert(id)
            return nil
        }

        for task in tasks {
            if let found = walk(task.id) { return found }
        }
        return nil
    }

    /// Tasks whose prerequisites have all finished successfully — the set the
    /// dispatcher can start right now.
    static func readyTasks(in run: TeamRun) -> [TeamTask] {
        let doneIds = Set(run.results.filter { $0.state == .done }.map(\.taskId))
        let startedIds = Set(run.results.map(\.taskId))
        return run.tasks.filter { task in
            !startedIds.contains(task.id) && task.dependsOn.allSatisfy { doneIds.contains($0) }
        }
    }

    /// Tasks that can never run because something they depend on failed or was
    /// skipped. Surfaced as `.skipped` rather than left `.blocked` forever, so
    /// a partial run reports honestly instead of looking stalled.
    static func unreachableTasks(in run: TeamRun) -> [TeamTask] {
        let deadIds = Set(run.results.filter { $0.state == .failed || $0.state == .skipped }.map(\.taskId))
        guard !deadIds.isEmpty else { return [] }
        let startedIds = Set(run.results.map(\.taskId))

        var dead = deadIds
        var changed = true
        // Fixed-point: a task blocked by a skipped task is itself unreachable,
        // and so on down the chain.
        while changed {
            changed = false
            for task in run.tasks where !dead.contains(task.id) {
                if task.dependsOn.contains(where: { dead.contains($0) }) {
                    dead.insert(task.id)
                    changed = true
                }
            }
        }
        return run.tasks.filter { dead.contains($0.id) && !startedIds.contains($0.id) }
    }
}
