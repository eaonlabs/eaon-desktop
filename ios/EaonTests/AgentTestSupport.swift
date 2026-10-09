import Foundation
import XCTest
@testable import Eaon

/// A clock the test moves.
final class TestClock: @unchecked Sendable {
    private let lock = NSLock()
    private var current: Date

    init(_ date: Date = TestClock.date(2026, 10, 5, 7, 0)) { current = date }

    var now: Date {
        lock.lock(); defer { lock.unlock() }
        return current
    }

    func advance(minutes: Double) {
        lock.lock(); defer { lock.unlock() }
        current = current.addingTimeInterval(minutes * 60)
    }

    func set(_ date: Date) {
        lock.lock(); defer { lock.unlock() }
        current = date
    }

    static func date(_ year: Int, _ month: Int, _ day: Int, _ hour: Int = 0, _ minute: Int = 0) -> Date {
        Calendar.current.date(from: DateComponents(year: year, month: month, day: day, hour: hour, minute: minute))!
    }
}

/// An engine that does what the test says: it can stream text and call tools through the runner.
@MainActor
final class ScriptedEngine: AgentEngine {
    typealias Script = @MainActor (_ system: String, _ history: [EngineMessage], _ tools: [AgentTool], _ runner: ToolRunner, _ onText: @MainActor (String) -> Void) async throws -> Void

    var script: Script
    private(set) var turns: [(system: String, history: [EngineMessage], tools: [AgentTool])] = []

    init(_ script: @escaping Script = { _, _, _, _, onText in onText("Okay.") }) {
        self.script = script
    }

    func run(system: String, history: [EngineMessage], tools: [AgentTool], runner: ToolRunner, onText: @escaping @MainActor (String) -> Void) async throws {
        turns.append((system, history, tools))
        try await script(system, history, tools, runner, onText)
    }

    var lastPrompt: String { turns.last?.history.last?.text ?? "" }
}

@MainActor
final class FakeCalendar: CalendarService {
    var events: [CalendarItem] = []
    private(set) var addedEvents: [(title: String, start: Date, minutes: Int)] = []
    private(set) var addedReminders: [(title: String, due: Date?)] = []

    func upcomingEvents(days: Int) async throws -> [CalendarItem] { events }
    func addEvent(title: String, start: Date, minutes: Int, notes: String?) async throws -> String {
        addedEvents.append((title, start, minutes))
        return "Added “\(title)”."
    }
    func openReminders() async throws -> [ReminderItem] { addedReminders.map { ReminderItem(title: $0.title, due: $0.due) } }
    func addReminder(title: String, due: Date?) async throws -> String {
        addedReminders.append((title, due))
        return "Added the reminder “\(title)”."
    }
}

struct FakeWeb: WebFetching {
    var reply: @Sendable (URL) throws -> String = { "Page at \($0.absoluteString)" }
    func fetch(_ url: URL) async throws -> String { try reply(url) }
}

@MainActor
struct AgentHarness {
    let agents: PhoneAgents
    let engine: ScriptedEngine
    let storage: MemoryPhoneAgentStorage
    let notifier: RecordingAgentNotifier
    let calendar: FakeCalendar
    let clock: TestClock

    init(
        engine: ScriptedEngine = ScriptedEngine(),
        small: Bool = false,
        storage: MemoryPhoneAgentStorage = MemoryPhoneAgentStorage(),
        clock: TestClock = TestClock(),
        web: FakeWeb = FakeWeb()
    ) {
        let notifier = RecordingAgentNotifier()
        let calendar = FakeCalendar()
        self.engine = engine
        self.storage = storage
        self.notifier = notifier
        self.calendar = calendar
        self.clock = clock
        agents = PhoneAgents(
            storage: storage,
            notifier: notifier,
            services: AgentServices(web: web, calendar: calendar),
            clock: { clock.now },
            resolveModel: { _ in ResolvedAgentModel(ref: .onDevice, engine: engine, small: small) }
        )
        agents.goalPause = .milliseconds(1)
    }

    @discardableResult
    func make(_ name: String = "Scout", access: AgentAccess = .autonomous, purpose: String = "Helps out.") async throws -> Agent {
        try await agents.create(AgentDraft(name: name, purpose: purpose, access: access))
    }

    /// Waits until nothing is running and nothing is about to.
    func settle(timeout: TimeInterval = 5) async {
        let deadline = Date().addingTimeInterval(timeout)
        var quiet = 0
        while Date() < deadline {
            quiet = agents.hasRunningTurns ? 0 : quiet + 1
            if quiet >= 6 { return }
            try? await Task.sleep(for: .milliseconds(10))
        }
    }

    func thread(_ agent: Agent) -> [AgentMessage] { agents.messages(for: agent.key.id) }
    func record(_ agent: Agent) -> PhoneAgentRecord { agents.record(agent.key.id)! }
}
