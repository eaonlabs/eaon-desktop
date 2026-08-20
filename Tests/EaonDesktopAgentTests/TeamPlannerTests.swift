import XCTest
@testable import Eaon_desktop

/// The orchestrator's plan is model output, so every one of these inputs is a
/// shape a model actually produces — fenced JSON, prose in front, an invented
/// dependency, a name that doesn't match the roster. The graph checks matter
/// more than the parsing: a cyclic or dangling plan is the one thing that
/// would hang the dispatcher rather than fail loudly.
final class TeamPlannerTests: XCTestCase {

    private func plan(_ json: String) -> Result<TeamRun, TeamPlanner.PlanError> {
        TeamPlanner.parse(json, task: "build a thing")
    }

    private let valid = """
    {"problem":"ship a login form",
     "team":[{"name":"Engineer","role":"builds it"},{"name":"Reviewer","role":"checks it"}],
     "tasks":[
       {"id":"form","title":"Build the form","brief":"Write the form.","assignee":"Engineer","dependsOn":[]},
       {"id":"review","title":"Review it","brief":"Review the form.","assignee":"Reviewer","dependsOn":["form"]}
     ]}
    """

    // MARK: - Parsing

    func testParsesABarePlan() throws {
        let run = try plan(valid).get()
        XCTAssertEqual(run.problem, "ship a login form")
        XCTAssertEqual(run.members.count, 2)
        XCTAssertEqual(run.tasks.map(\.id), ["form", "review"])
        XCTAssertEqual(run.tasks[1].dependsOn, ["form"])
    }

    func testParsesThroughAFenceAndProse() throws {
        let wrapped = "Sure, here's the plan:\n```json\n\(valid)\n```\nLet me know!"
        let run = try plan(wrapped).get()
        XCTAssertEqual(run.tasks.count, 2)
    }

    func testGarbageIsRejectedRatherThanGuessedAt() {
        XCTAssertEqual(plan("no json here"), .failure(.unparseable))
    }

    func testASingleTaskIsNotATeam() {
        let single = """
        {"team":[{"name":"A","role":"x"}],
         "tasks":[{"id":"one","title":"One","brief":"Do it.","assignee":"A","dependsOn":[]}]}
        """
        XCTAssertEqual(plan(single), .failure(.tooFewTasks))
    }

    func testTasksWithoutABriefAreDroppedNotDispatchedEmpty() {
        // A brief is the sub-agent's whole instruction — an empty one would
        // dispatch an agent with nothing to do.
        let missing = """
        {"team":[{"name":"A","role":"x"}],
         "tasks":[{"id":"a","title":"A","brief":"real","assignee":"A"},
                  {"id":"b","title":"B","assignee":"A"}]}
        """
        XCTAssertEqual(plan(missing), .failure(.tooFewTasks))
    }

    func testDuplicateIdsAreCollapsedSoDependenciesStayUnambiguous() {
        let dupes = """
        {"team":[{"name":"A","role":"x"}],
         "tasks":[{"id":"a","title":"first","brief":"1","assignee":"A"},
                  {"id":"a","title":"second","brief":"2","assignee":"A"},
                  {"id":"b","title":"third","brief":"3","assignee":"A"}]}
        """
        let run = try? plan(dupes).get()
        XCTAssertEqual(run?.tasks.map(\.id), ["a", "b"])
        XCTAssertEqual(run?.tasks.first?.title, "first", "the first definition should win")
    }

    // MARK: - Graph validity

    func testAnInventedAssigneeIsRejected() {
        let bad = valid.replacingOccurrences(of: "\"assignee\":\"Reviewer\"", with: "\"assignee\":\"Ghost\"")
        XCTAssertEqual(plan(bad), .failure(.unknownAssignee("Ghost")))
    }

    func testADanglingDependencyIsRejected() {
        let bad = valid.replacingOccurrences(of: "\"dependsOn\":[\"form\"]", with: "\"dependsOn\":[\"nope\"]")
        XCTAssertEqual(plan(bad), .failure(.unknownDependency(task: "review", missing: "nope")))
    }

    func testADirectCycleIsCaughtBeforeAnythingRuns() {
        let cyclic = """
        {"team":[{"name":"A","role":"x"}],
         "tasks":[{"id":"a","title":"A","brief":"1","assignee":"A","dependsOn":["b"]},
                  {"id":"b","title":"B","brief":"2","assignee":"A","dependsOn":["a"]}]}
        """
        guard case .failure(.cycle(let loop)) = plan(cyclic) else {
            return XCTFail("a cycle must be rejected — it would hang the dispatcher forever")
        }
        XCTAssertTrue(loop.contains("a") && loop.contains("b"))
    }

    func testAnIndirectCycleIsAlsoCaught() {
        let cyclic = """
        {"team":[{"name":"A","role":"x"}],
         "tasks":[{"id":"a","title":"A","brief":"1","assignee":"A","dependsOn":["c"]},
                  {"id":"b","title":"B","brief":"2","assignee":"A","dependsOn":["a"]},
                  {"id":"c","title":"C","brief":"3","assignee":"A","dependsOn":["b"]}]}
        """
        guard case .failure(.cycle) = plan(cyclic) else {
            return XCTFail("a three-hop cycle must be caught too")
        }
    }

    func testADiamondIsNotACycle() {
        // Two independent tasks feeding one join — the shape parallelism is
        // actually for. Must not be mistaken for a loop.
        let diamond = """
        {"team":[{"name":"A","role":"x"}],
         "tasks":[{"id":"root","title":"R","brief":"1","assignee":"A"},
                  {"id":"left","title":"L","brief":"2","assignee":"A","dependsOn":["root"]},
                  {"id":"right","title":"R2","brief":"3","assignee":"A","dependsOn":["root"]},
                  {"id":"join","title":"J","brief":"4","assignee":"A","dependsOn":["left","right"]}]}
        """
        XCTAssertNoThrow(try plan(diamond).get())
    }

    // MARK: - Scheduling

    func testOnlyUnblockedTasksAreReadyAtTheStart() throws {
        let run = try plan(valid).get()
        XCTAssertEqual(TeamPlanner.readyTasks(in: run).map(\.id), ["form"])
    }

    func testADependentTaskUnblocksWhenItsPrerequisiteFinishes() throws {
        var run = try plan(valid).get()
        run.results = [TeamTaskResult(taskId: "form", title: "Build the form", assignee: "Engineer", state: .done, output: "done")]
        XCTAssertEqual(TeamPlanner.readyTasks(in: run).map(\.id), ["review"])
    }

    func testAStartedTaskIsNotHandedOutTwice() throws {
        var run = try plan(valid).get()
        run.results = [TeamTaskResult(taskId: "form", title: "Build the form", assignee: "Engineer", state: .running)]
        XCTAssertTrue(TeamPlanner.readyTasks(in: run).isEmpty, "a running task must not be dispatched again")
    }

    func testIndependentTasksAreAllReadyTogether() throws {
        let parallel = """
        {"team":[{"name":"A","role":"x"}],
         "tasks":[{"id":"a","title":"A","brief":"1","assignee":"A"},
                  {"id":"b","title":"B","brief":"2","assignee":"A"},
                  {"id":"c","title":"C","brief":"3","assignee":"A"}]}
        """
        let run = try plan(parallel).get()
        XCTAssertEqual(Set(TeamPlanner.readyTasks(in: run).map(\.id)), ["a", "b", "c"])
    }

    func testAFailedPrerequisiteMakesDependentsUnreachableNotStalled() throws {
        var run = try plan(valid).get()
        run.results = [TeamTaskResult(taskId: "form", title: "Build the form", assignee: "Engineer", state: .failed)]
        XCTAssertTrue(TeamPlanner.readyTasks(in: run).isEmpty)
        XCTAssertEqual(TeamPlanner.unreachableTasks(in: run).map(\.id), ["review"],
                       "a task behind a failure must be reported skipped, never left waiting forever")
    }

    func testUnreachabilityPropagatesDownTheChain() {
        let chain = """
        {"team":[{"name":"A","role":"x"}],
         "tasks":[{"id":"a","title":"A","brief":"1","assignee":"A"},
                  {"id":"b","title":"B","brief":"2","assignee":"A","dependsOn":["a"]},
                  {"id":"c","title":"C","brief":"3","assignee":"A","dependsOn":["b"]}]}
        """
        guard var run = try? TeamPlanner.parse(chain, task: "t").get() else { return XCTFail("plan should parse") }
        run.results = [TeamTaskResult(taskId: "a", title: "A", assignee: "A", state: .failed)]
        XCTAssertEqual(Set(TeamPlanner.unreachableTasks(in: run).map(\.id)), ["b", "c"])
    }

    func testNothingIsUnreachableWhileEverythingIsHealthy() throws {
        var run = try plan(valid).get()
        run.results = [TeamTaskResult(taskId: "form", title: "Build the form", assignee: "Engineer", state: .done, output: "ok")]
        XCTAssertTrue(TeamPlanner.unreachableTasks(in: run).isEmpty)
    }

    func testUsableResultsExcludeFailuresAndEmptyOutput() {
        var run = TeamRun(task: "t")
        run.results = [
            TeamTaskResult(taskId: "a", title: "A", assignee: "X", state: .done, output: "real"),
            TeamTaskResult(taskId: "b", title: "B", assignee: "X", state: .failed, output: "boom"),
            TeamTaskResult(taskId: "c", title: "C", assignee: "X", state: .done, output: ""),
        ]
        XCTAssertEqual(run.usableResults.map(\.taskId), ["a"])
    }
}
