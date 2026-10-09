import Foundation
import Observation

/// A model chosen for an agent's turn, with the engine that can run it.
struct ResolvedAgentModel {
    var ref: ModelRef
    var engine: any AgentEngine
    /// Apple's model on this iPhone has a small window: it gets a shorter prompt and fewer tools.
    var small: Bool
}

/// Why an agent woke up.
enum AgentWake: Equatable {
    case mail
    case heartbeat(String)
    case routine(PhoneRoutine)
    case checkIn
    case goalContinue
}

/// The agents that live on this iPhone: their records and conversations, and
/// the loop that runs them.
///
/// An agent wakes for three reasons: the person wrote to it, a wake-up it set
/// itself came due (a heartbeat or a routine), or its goal needs another turn.
/// iOS doesn't let an app run in the background, so schedules are kept while
/// Eaon is open, and a notification reminds the person to open it when one
/// comes due; a turn then runs, once, however many were missed. Agents on a
/// Mac run all the time.
@MainActor
@Observable
final class PhoneAgents: AgentSource {
    let place = AgentPlace.phone
    var isAvailable: Bool { true }

    private(set) var records: [PhoneAgentRecord]
    private(set) var running: Set<String> = []
    private(set) var threads: [String: [AgentMessage]] = [:]
    /// Moves on every scheduler pass, so a mood that depends on the time (sleepy after a while) is redrawn.
    private(set) var ticker = Date()

    @ObservationIgnored private let storage: PhoneAgentStorage
    @ObservationIgnored private let notifier: AgentNotifier
    @ObservationIgnored let services: AgentServices
    @ObservationIgnored private let resolveModel: @MainActor (ModelRef?) -> ResolvedAgentModel?
    @ObservationIgnored let clock: @Sendable () -> Date
    @ObservationIgnored private var tasks: [String: Task<Void, Never>] = [:]
    @ObservationIgnored private var scheduler: Task<Void, Never>?
    @ObservationIgnored private var goalTurns: [String: Int] = [:]
    /// Whether Eaon is in front of the person: a reply that finishes while it isn't becomes a notification.
    @ObservationIgnored var isForeground: @MainActor () -> Bool = { true }

    /// How long a goal waits between turns. Short enough to feel continuous, long enough to stop a runaway.
    @ObservationIgnored var goalPause: Duration = .seconds(3)

    static let maxAgents = 16
    static let maxConcurrent = 2
    static let goalTurnLimit = 6
    static let historyMessages = 16

    init(
        storage: PhoneAgentStorage = FilePhoneAgentStorage(),
        notifier: AgentNotifier,
        services: AgentServices = AgentServices(),
        clock: @escaping @Sendable () -> Date = { Date() },
        resolveModel: @escaping @MainActor (ModelRef?) -> ResolvedAgentModel?
    ) {
        self.storage = storage
        self.notifier = notifier
        self.services = services
        self.clock = clock
        self.resolveModel = resolveModel
        records = storage.loadRecords()
        // A quit mid-turn leaves a message still marked as streaming; nothing is streaming now.
        for record in records {
            var thread = storage.loadThread(record.id)
            var changed = false
            for index in thread.indices where thread[index].streaming {
                thread[index].streaming = false
                changed = true
            }
            if changed { storage.saveThread(record.id, thread) }
        }
    }

    // MARK: Reading

    var agents: [Agent] {
        _ = ticker
        let now = clock()
        return records.map { record in
            var agent = record.project(running: running.contains(record.id), now: now, modelName: record.pinned?.name)
            if agent.isWorking && agent.activity.isEmpty { agent.activity = "Working…" }
            return agent
        }
    }

    func record(_ id: String) -> PhoneAgentRecord? {
        records.first { $0.id == id }
    }

    func messages(for id: String) -> [AgentMessage] {
        threads[id] ?? []
    }

    func loadThread(_ id: String) async {
        if threads[id] == nil { threads[id] = storage.loadThread(id) }
    }

    var hasRunningTurns: Bool { !tasks.isEmpty }

    // MARK: Creating and editing

    func create(_ draft: AgentDraft) async throws -> Agent {
        let name = draft.name.trimmingCharacters(in: .whitespacesAndNewlines)
        let purpose = draft.purpose.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !name.isEmpty else { throw AgentError(message: "Give the agent a name.") }
        guard name.count <= 40 else { throw AgentError(message: "That name is too long.") }
        guard !purpose.isEmpty else { throw AgentError(message: "Say what the agent is for.") }
        guard purpose.count <= 2_000 else { throw AgentError(message: "That description is too long.") }
        guard records.count < Self.maxAgents else { throw AgentError(message: "That's the most agents this iPhone can keep: \(Self.maxAgents).") }
        guard !records.contains(where: { $0.name.caseInsensitiveCompare(name) == .orderedSame }) else {
            throw AgentError(message: "There's already an agent called \(name).")
        }
        let record = PhoneAgentRecord(
            id: UUID().uuidString,
            name: name,
            colorHex: UInt32(hexString: draft.colorHex) != nil ? draft.colorHex : AgentPalette.hex[0],
            purpose: purpose,
            personality: draft.personality.trimmingCharacters(in: .whitespacesAndNewlines),
            access: draft.access,
            pinned: draft.pinned,
            createdAt: clock()
        )
        records.append(record)
        persistRecords()
        // Agents can reach you when Eaon isn't open, so iOS is asked once; creating one doesn't wait on the answer.
        Task { await notifier.requestPermission() }
        return project(record)
    }

    func update(_ id: String, with draft: AgentDraft) async throws {
        guard let index = records.firstIndex(where: { $0.id == id }) else { throw AgentError(message: "That agent is gone.") }
        let name = draft.name.trimmingCharacters(in: .whitespacesAndNewlines)
        let purpose = draft.purpose.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !name.isEmpty, name.count <= 40 else { throw AgentError(message: "Give the agent a name of up to 40 letters.") }
        guard !purpose.isEmpty, purpose.count <= 2_000 else { throw AgentError(message: "Say what the agent is for, in under 2,000 letters.") }
        guard !records.contains(where: { $0.id != id && $0.name.caseInsensitiveCompare(name) == .orderedSame }) else {
            throw AgentError(message: "There's already an agent called \(name).")
        }
        records[index].name = name
        records[index].purpose = purpose
        records[index].personality = draft.personality.trimmingCharacters(in: .whitespacesAndNewlines)
        records[index].access = draft.access
        records[index].pinned = draft.pinned
        if UInt32(hexString: draft.colorHex) != nil { records[index].colorHex = draft.colorHex }
        persistRecords()
    }

    func remove(_ id: String) async throws {
        tasks[id]?.cancel()
        tasks[id] = nil
        running.remove(id)
        records.removeAll { $0.id == id }
        threads[id] = nil
        goalTurns[id] = nil
        storage.deleteThread(id)
        notifier.cancelWake(agentID: id)
        persistRecords()
    }

    /// Forgets every agent, conversation and scheduled reminder, and stops whatever is running.
    func eraseAll() {
        for task in tasks.values { task.cancel() }
        tasks = [:]
        running = []
        for record in records {
            storage.deleteThread(record.id)
            notifier.cancelWake(agentID: record.id)
        }
        records = []
        threads = [:]
        goalTurns = [:]
        persistRecords()
    }

    // MARK: Commands

    func send(_ id: String, text: String, asGoal: Bool) async throws {
        let text = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty else { return }
        guard text.count <= 8_000 else { throw AgentError(message: "That message is too long.") }
        guard let index = records.firstIndex(where: { $0.id == id }) else { throw AgentError(message: "That agent is gone.") }
        records[index].inbox.append(PhoneMail(text: text, goal: asGoal, at: clock()))
        if asGoal {
            records[index].goal = String(text.prefix(PhoneAgentRecord.maxGoal))
            records[index].goalRun = AgentGoalRun(text: records[index].goal, state: .active)
            goalTurns[id] = 0
        }
        persistRecords()
        if !records[index].paused { startTurn(id, wake: .mail) }
    }

    func stop(_ id: String) async {
        guard tasks[id] != nil else { return }
        // Stopping mid-goal stops the goal's next turn too; saying "continue" resumes it.
        if let index = records.firstIndex(where: { $0.id == id }), records[index].goalRun?.state == .active {
            records[index].goalRun?.state = .paused
            persistRecords()
        }
        tasks[id]?.cancel()
    }

    func wake(_ id: String) async {
        guard let record = record(id), !record.paused else { return }
        startTurn(id, wake: record.inbox.isEmpty ? .checkIn : .mail)
    }

    func setPaused(_ id: String, paused: Bool) async {
        guard let index = records.firstIndex(where: { $0.id == id }) else { return }
        records[index].paused = paused
        persistRecords()
        if paused {
            tasks[id]?.cancel()
            notifier.cancelWake(agentID: id)
        } else {
            refreshWake(id)
            if !records[index].inbox.isEmpty { startTurn(id, wake: .mail) }
        }
    }

    func setGoal(_ id: String, _ command: GoalCommand) async {
        guard let index = records.firstIndex(where: { $0.id == id }) else { return }
        switch command {
        case .pause:
            records[index].goalRun?.state = .paused
            tasks[id]?.cancel()
        case .resume:
            guard records[index].goalRun != nil else { return }
            records[index].goalRun?.state = .active
            goalTurns[id] = 0
            persistRecords()
            if !records[index].paused { startTurn(id, wake: .goalContinue) }
        case .clear:
            records[index].goalRun = nil
        }
        persistRecords()
    }

    func answer(_ id: String, askID: String, text: String?, approved: Bool?) async {
        guard let index = records.firstIndex(where: { $0.id == id }),
              let askIndex = records[index].asks.firstIndex(where: { $0.ask.id == askID }) else { return }
        let pending = records[index].asks.remove(at: askIndex)

        var mail: String
        if let action = pending.action {
            if approved == true, let tool = tools(for: id).first(where: { $0.name == action.tool }) {
                let runner = ToolRunner(tools: [tool], access: records[index].access)
                let (output, step) = await runner.executeApproved(tool, arguments: action.arguments.object ?? [:])
                appendMessage(id, AgentMessage(id: UUID().uuidString, role: .assistant, at: clock(), parts: [.tool(step)]))
                mail = "[The person approved: \(step.title)] \(output)"
            } else {
                mail = "[The person declined: \(pending.ask.approval ?? pending.ask.question)] Don't do it. Carry on without it."
            }
        } else {
            let reply = (text ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
            mail = "[Answer to “\(pending.ask.question)”] \(reply.isEmpty ? (approved == true ? "Yes." : "No.") : reply)"
        }
        records[index].inbox.append(PhoneMail(text: mail, at: clock()))
        persistRecords()
        if !records[index].paused { startTurn(id, wake: .mail) }
    }

    func clear(_ id: String) async {
        threads[id] = []
        storage.saveThread(id, [])
    }

    func markRead(_ id: String) async {
        guard let index = records.firstIndex(where: { $0.id == id }), records[index].unread != 0 else { return }
        records[index].unread = 0
        persistRecords()
    }

    // MARK: The scheduler

    /// Starts checking for due wake-ups every few seconds, while Eaon is open.
    func startScheduler(every seconds: Double = 20) {
        scheduler?.cancel()
        scheduler = Task { [weak self] in
            while !Task.isCancelled {
                self?.tick()
                try? await Task.sleep(for: .seconds(seconds))
            }
        }
    }

    func stopScheduler() {
        scheduler?.cancel()
        scheduler = nil
    }

    /// Wakes whoever is due: mail first, then a heartbeat, then a routine. Wake-ups missed while
    /// Eaon was closed run once, late, and the next one is counted from now: never a burst.
    func tick() {
        let now = clock()
        ticker = now
        for record in records where !record.paused && tasks[record.id] == nil {
            guard tasks.count < Self.maxConcurrent else { break }
            if !record.inbox.isEmpty {
                startTurn(record.id, wake: .mail)
            } else if let heartbeat = record.heartbeat, heartbeat.nextAt <= now {
                wakeByHeartbeat(record.id, heartbeat, now: now)
            } else if let routine = record.routines.first(where: { $0.nextAt <= now }) {
                wakeByRoutine(record.id, routine, now: now)
            }
        }
    }

    private func wakeByHeartbeat(_ id: String, _ heartbeat: PhoneHeartbeat, now: Date) {
        guard let index = records.firstIndex(where: { $0.id == id }) else { return }
        // A repeating heartbeat goes on from now; a one-off is done.
        if let every = heartbeat.everyMinutes {
            records[index].heartbeat = PhoneHeartbeat(nextAt: now.addingTimeInterval(Double(every) * 60), everyMinutes: every, note: heartbeat.note)
        } else {
            records[index].heartbeat = nil
        }
        persistRecords()
        guard withinBudget(id, now: now) else { return }
        startTurn(id, wake: .heartbeat(heartbeat.note))
    }

    private func wakeByRoutine(_ id: String, _ routine: PhoneRoutine, now: Date) {
        guard let index = records.firstIndex(where: { $0.id == id }),
              let routineIndex = records[index].routines.firstIndex(where: { $0.id == routine.id }) else { return }
        records[index].routines[routineIndex].nextAt = Self.nextOccurrence(of: routine, after: now)
        persistRecords()
        guard withinBudget(id, now: now) else { return }
        startTurn(id, wake: .routine(routine))
    }

    static func nextOccurrence(of routine: PhoneRoutine, after now: Date) -> Date {
        if let daily = routine.daily, let next = Schedule.next(daily: daily, after: now) { return next }
        return now.addingTimeInterval(Double(max(routine.everyMinutes ?? 60, 1)) * 60)
    }

    /// A worker that wakes itself too often is looping; stop before it burns the person's battery and keys.
    private func withinBudget(_ id: String, now: Date) -> Bool {
        guard let index = records.firstIndex(where: { $0.id == id }) else { return false }
        records[index].selfWakes = records[index].selfWakes.filter { now.timeIntervalSince($0) < 3_600 }
        guard records[index].selfWakes.count < PhoneAgentRecord.maxSelfWakesPerHour else { return false }
        records[index].selfWakes.append(now)
        return true
    }

    /// Tells iOS to remind the person when the soonest wake-up is due.
    func refreshWake(_ id: String) {
        guard let record = record(id) else { return }
        if !record.paused, let next = record.nextWake {
            notifier.scheduleWake(agentID: id, name: record.name, at: next)
        } else {
            notifier.cancelWake(agentID: id)
        }
    }

    // MARK: Running a turn

    private func startTurn(_ id: String, wake: AgentWake) {
        guard tasks[id] == nil, record(id) != nil else { return }
        running.insert(id)
        tasks[id] = Task { [weak self] in
            let ran = await self?.runTurn(id, wake: wake) ?? false
            self?.turnFinished(id, ran: ran)
        }
    }

    private func turnFinished(_ id: String, ran: Bool) {
        tasks[id] = nil
        running.remove(id)
        refreshWake(id)
        // A turn that couldn't even start (no model) leaves its mail waiting; trying again at once would only spin.
        guard ran, let record = record(id), !record.paused else { return }
        // Mail that arrived during the turn, or a goal that isn't done: another turn.
        if !record.inbox.isEmpty {
            startTurn(id, wake: .mail)
        } else if record.goalRun?.state == .active {
            let turns = goalTurns[id, default: 0]
            if turns >= Self.goalTurnLimit {
                if let index = records.firstIndex(where: { $0.id == id }) {
                    records[index].goalRun?.state = .paused
                    records[index].goalRun?.summary = "Paused after \(turns) turns. Say continue to carry on."
                    persistRecords()
                }
            } else {
                Task { [weak self] in
                    try? await Task.sleep(for: self?.goalPause ?? .seconds(3))
                    guard let self, self.record(id)?.goalRun?.state == .active else { return }
                    self.startTurn(id, wake: .goalContinue)
                }
            }
        }
    }

    /// Runs one turn. False if it couldn't start, so nothing about the agent's state moved on.
    private func runTurn(_ id: String, wake: AgentWake) async -> Bool {
        guard let recordNow = record(id) else { return false }
        guard let model = resolveModel(recordNow.pinned) else {
            fail(id, "No model to run on. Pick one in Chat, or set up Apple Intelligence, a provider or your Mac.")
            return false
        }
        await loadThread(id)

        // What woke it, as one user turn.
        let now = clock()
        let input = turnInput(id, wake: wake, now: now)
        appendMessage(id, AgentMessage(id: UUID().uuidString, role: .user, at: now, from: input.sender, parts: [.text(input.display)]))
        let replyID = UUID().uuidString
        var reply = AgentMessage(id: replyID, role: .assistant, at: now, parts: [], streaming: true)
        if case .heartbeat(let note) = wake { reply.heartbeat = note.isEmpty ? "Wake-up" : note }
        appendMessage(id, reply)
        if let index = records.firstIndex(where: { $0.id == id }) {
            records[index].lastError = nil
            records[index].activity = ""
            persistRecords()
        }
        if case .mail = wake { goalTurns[id] = goalTurns[id] ?? 0 }
        if case .goalContinue = wake { goalTurns[id, default: 0] += 1 }

        let tools = tools(for: id)
        let runner = ToolRunner(tools: tools, access: recordNow.access)
        runner.onStep = { [weak self] step in self?.mutate(id, replyID) { $0.upsert(step: step) } }
        runner.onNeedsApproval = { [weak self] tool, arguments in self?.queueApproval(id, tool: tool, arguments: arguments) }

        var pending = ""
        var lastFlush = ContinuousClock.now
        let flush: @MainActor () -> Void = { [weak self] in
            guard !pending.isEmpty else { return }
            let piece = pending
            pending = ""
            self?.mutate(id, replyID) { $0.append(text: piece) }
        }

        do {
            try await model.engine.run(
                system: AgentPrompt.system(for: recordNow, now: now, small: model.small),
                history: history(id, replyID: replyID, input: input, small: model.small),
                tools: tools,
                runner: runner,
                onText: { piece in
                    pending += piece
                    if ContinuousClock.now - lastFlush > .milliseconds(45) {
                        flush()
                        lastFlush = .now
                    }
                }
            )
            flush()
            finishTurn(id, replyID, error: nil, cancelled: false)
        } catch is CancellationError {
            flush()
            finishTurn(id, replyID, error: nil, cancelled: true)
        } catch {
            flush()
            var text = (error as? LocalizedError)?.errorDescription ?? error.localizedDescription
            if let recovery = (error as? BackendError)?.recovery { text += " " + recovery }
            finishTurn(id, replyID, error: text, cancelled: false)
        }
        return true
    }

    private func finishTurn(_ id: String, _ replyID: String, error: String?, cancelled: Bool) {
        mutate(id, replyID) { message in
            message.streaming = false
            if let error { message.error = error }
        }
        // A reply with no words and no steps is a failure to say so, not an empty bubble.
        var failure = error
        if error == nil, !cancelled, let reply = messages(for: id).first(where: { $0.id == replyID }), reply.text.isEmpty, reply.steps.isEmpty {
            failure = "The model sent back nothing."
            mutate(id, replyID) { $0.error = failure }
        }
        if cancelled, let reply = messages(for: id).first(where: { $0.id == replyID }), reply.text.isEmpty, reply.steps.isEmpty {
            removeMessage(id, replyID)
        }
        guard let index = records.firstIndex(where: { $0.id == id }) else { return }
        let now = clock()
        if !cancelled {
            records[index].lastRunAt = now
            records[index].lastOutcome = PhoneAgentRecord.Outcome(at: now, ok: failure == nil)
            records[index].lastError = failure
            if !isForeground() || selected != id { records[index].unread += 1 }
        }
        storage.saveThread(id, messages(for: id))
        persistRecords()

        if !isForeground(), !cancelled {
            let reply = messages(for: id).last(where: { $0.id == replyID })
            let body = failure ?? String((reply?.text ?? "").prefix(140))
            if !body.isEmpty { notifier.post(title: failure == nil ? records[index].name : "\(records[index].name) hit a problem", body: body, agentID: id) }
        }
    }

    /// The agent whose page is open, so a reply to it isn't counted unread.
    @ObservationIgnored var selected: String?

    private func fail(_ id: String, _ message: String) {
        guard let index = records.firstIndex(where: { $0.id == id }) else { return }
        records[index].lastError = message
        records[index].lastOutcome = PhoneAgentRecord.Outcome(at: clock(), ok: false)
        persistRecords()
    }

    // MARK: What a turn is told

    struct TurnInput {
        var display: String
        /// What the model reads (the display text with the time and the sender).
        var prompt: String
        var sender: AgentMessage.Sender?
    }

    private func turnInput(_ id: String, wake: AgentWake, now: Date) -> TurnInput {
        let stamp = "[Local time: \(AgentPrompt.timeText(now))]"
        switch wake {
        case .mail:
            var mail: [PhoneMail] = []
            if let index = records.firstIndex(where: { $0.id == id }) {
                mail = records[index].inbox
                records[index].inbox = []
            }
            let text = mail.map(\.text).joined(separator: "\n\n")
            return TurnInput(display: text, prompt: "\(stamp)\n\(text)", sender: nil)
        case .heartbeat(let note):
            let text = note.isEmpty ? "Time to check in." : note
            return TurnInput(display: text, prompt: "\(stamp)\n[Wake-up you set for yourself] \(text)", sender: .init(name: "Wake-up", colorHex: nil))
        case .routine(let routine):
            return TurnInput(display: routine.task, prompt: "\(stamp)\n[Routine “\(routine.name)”] \(routine.task)", sender: .init(name: "Routine · \(routine.name)", colorHex: nil))
        case .checkIn:
            let text = "Check in: look at what's going on, and do whatever is useful."
            return TurnInput(display: "Check-in", prompt: "\(stamp)\n\(text)", sender: .init(name: "Check-in", colorHex: nil))
        case .goalContinue:
            let goal = record(id)?.goal ?? ""
            let text = "Keep working on your goal: \(goal)\nIf it's done, or you can't go on, call finish_goal."
            return TurnInput(display: "Continuing on the goal", prompt: "\(stamp)\n\(text)", sender: .init(name: "Goal", colorHex: nil))
        }
    }

    /// The conversation so far, as plain turns, newest kept. Tool steps aren't replayed: the agent keeps what it
    /// learned in its notes, and what it did is in its words.
    private func history(_ id: String, replyID: String, input: TurnInput, small: Bool) -> [EngineMessage] {
        var turns: [EngineMessage] = []
        var budget = small ? 1_800 : 20_000
        let thread = messages(for: id).filter { $0.id != replyID }
        // The last user message is the one just added: it is sent with its time.
        for message in thread.dropLast().suffix(Self.historyMessages).reversed() {
            let text = message.text
            guard !text.isEmpty else { continue }
            budget -= text.count
            if budget < 0 { break }
            let prefix = message.from.map { "[\($0.name)] " } ?? ""
            turns.append(EngineMessage(role: message.role == .user ? .user : .assistant, text: prefix + text))
        }
        turns.reverse()
        turns.append(EngineMessage(role: .user, text: input.prompt))
        return turns
    }

    // MARK: Approvals

    /// A "Careful" agent wants to make a change: ask the person, with the action ready to run on a yes.
    private func queueApproval(_ id: String, tool: AgentTool, arguments: JSONObject) {
        guard let index = records.firstIndex(where: { $0.id == id }) else { return }
        let key = JSONValue.object(arguments).canonical
        // The same request twice is one question.
        guard !records[index].asks.contains(where: { $0.action?.tool == tool.name && $0.action?.arguments.canonical == key }) else { return }
        let summary = [tool.title(arguments), tool.detail(arguments)].compactMap { $0 }.joined(separator: ": ")
        let ask = AgentAsk(id: UUID().uuidString, question: "May I \(tool.title(arguments).lowercased())?", options: [], approval: summary, at: clock())
        records[index].asks.append(PhoneAsk(ask: ask, action: PendingAction(tool: tool.name, arguments: .object(arguments))))
        persistRecords()
        notifier.post(title: "\(records[index].name) needs your OK", body: summary, agentID: id)
    }

    // MARK: Things a tool does to its agent

    func remember(_ id: String, note: String, replace: Bool) -> String {
        guard let index = records.firstIndex(where: { $0.id == id }) else { return "Gone." }
        var notes = replace ? note : (records[index].notes.isEmpty ? note : records[index].notes + "\n" + note)
        // Over the limit, the oldest lines go first.
        while notes.count > PhoneAgentRecord.maxNotes, let newline = notes.firstIndex(of: "\n") {
            notes = String(notes[notes.index(after: newline)...])
        }
        records[index].notes = String(notes.suffix(PhoneAgentRecord.maxNotes))
        persistRecords()
        return "Notes saved (\(records[index].notes.count) of \(PhoneAgentRecord.maxNotes) characters)."
    }

    func setOwnGoal(_ id: String, text: String) -> String {
        guard let index = records.firstIndex(where: { $0.id == id }) else { return "Gone." }
        records[index].goal = String(text.prefix(PhoneAgentRecord.maxGoal))
        persistRecords()
        return "Goal set."
    }

    func setActivity(_ id: String, activity: String, mood: AgentMood?) {
        guard let index = records.firstIndex(where: { $0.id == id }) else { return }
        records[index].activity = String(activity.prefix(120))
        if let mood { records[index].moodHint = .init(mood: mood, until: clock().addingTimeInterval(120)) }
        persistRecords()
    }

    func raiseQuestion(_ id: String, question: String, options: [String]) -> String {
        guard let index = records.firstIndex(where: { $0.id == id }) else { return "Gone." }
        let ask = AgentAsk(id: UUID().uuidString, question: question, options: Array(options.prefix(4)), approval: nil, at: clock())
        records[index].asks.append(PhoneAsk(ask: ask, action: nil))
        persistRecords()
        notifier.post(title: "\(records[index].name) has a question", body: question, agentID: id)
        return "Asked. The answer will arrive as a message; carry on without waiting."
    }

    func reachOut(_ id: String, title: String, body: String) -> String {
        guard let index = records.firstIndex(where: { $0.id == id }) else { return "Gone." }
        notifier.post(title: title.isEmpty ? records[index].name : title, body: body, agentID: id)
        records[index].unread += 1
        persistRecords()
        return "Sent."
    }

    func setHeartbeat(_ id: String, inMinutes: Int?, at: String?, note: String, stop: Bool) throws -> String {
        guard let index = records.firstIndex(where: { $0.id == id }) else { return "Gone." }
        if stop {
            records[index].heartbeat = nil
            persistRecords()
            refreshWake(id)
            return "Wake-up cancelled."
        }
        let now = clock()
        let date: Date
        if let at, !at.isEmpty {
            guard let parsed = Schedule.parse(at, after: now) else { throw ToolRefusal(message: "I couldn't read “\(at)” as a time. Use 8:30, 20:30 or an ISO date.") }
            date = parsed
        } else {
            let minutes = max(inMinutes ?? 1, 1)
            guard minutes <= 24 * 60 else { throw ToolRefusal(message: "Wake-ups can be at most a day away.") }
            date = now.addingTimeInterval(Double(minutes) * 60)
        }
        records[index].heartbeat = PhoneHeartbeat(nextAt: date, everyMinutes: nil, note: note)
        persistRecords()
        refreshWake(id)
        return "I'll wake you \(AgentPrompt.relative(date, now: now)). It runs while Eaon is open; otherwise the person is reminded to open it."
    }

    func addRoutine(_ id: String, name: String, task: String, everyMinutes: Int?, daily: String?) throws -> String {
        guard let index = records.firstIndex(where: { $0.id == id }) else { return "Gone." }
        guard !name.isEmpty, !task.isEmpty else { throw ToolRefusal(message: "A routine needs a name and a task.") }
        guard records[index].routines.count < PhoneAgentRecord.maxRoutines else { throw ToolRefusal(message: "Too many routines: at most \(PhoneAgentRecord.maxRoutines).") }
        let now = clock()
        var routine = PhoneRoutine(id: UUID().uuidString, name: name, task: task, everyMinutes: nil, daily: nil, nextAt: now)
        if let daily, !daily.isEmpty {
            guard Schedule.next(daily: daily, after: now) != nil else { throw ToolRefusal(message: "“\(daily)” isn't a clock time. Use HH:MM, like 08:30.") }
            routine.daily = daily
        } else if let every = everyMinutes {
            guard every >= 15 else { throw ToolRefusal(message: "Routines repeat at most every 15 minutes.") }
            routine.everyMinutes = every
        } else {
            throw ToolRefusal(message: "Say when: every_minutes, or daily as HH:MM.")
        }
        routine.nextAt = Self.nextOccurrence(of: routine, after: now)
        records[index].routines.removeAll { $0.name.caseInsensitiveCompare(name) == .orderedSame }
        records[index].routines.append(routine)
        persistRecords()
        refreshWake(id)
        return "Routine “\(name)” set: next \(AgentPrompt.relative(routine.nextAt, now: now))."
    }

    func removeRoutine(_ id: String, name: String) -> String {
        guard let index = records.firstIndex(where: { $0.id == id }) else { return "Gone." }
        let before = records[index].routines.count
        records[index].routines.removeAll { $0.name.caseInsensitiveCompare(name) == .orderedSame }
        persistRecords()
        refreshWake(id)
        return records[index].routines.count < before ? "Removed “\(name)”." : "No routine called “\(name)”."
    }

    func finishGoal(_ id: String, achieved: Bool, summary: String) -> String {
        guard let index = records.firstIndex(where: { $0.id == id }) else { return "Gone." }
        guard records[index].goalRun != nil else { return "There's no goal to finish." }
        records[index].goalRun?.state = achieved ? .achieved : .blocked
        records[index].goalRun?.summary = summary
        persistRecords()
        return achieved ? "Goal marked achieved." : "Goal marked blocked."
    }

    // MARK: Plumbing

    func tools(for id: String) -> [AgentTool] {
        PhoneTools.make(agentID: id, agents: self)
    }

    private func project(_ record: PhoneAgentRecord) -> Agent {
        record.project(running: running.contains(record.id), now: clock(), modelName: record.pinned?.name)
    }

    private func persistRecords() {
        storage.saveRecords(records)
    }

    private func appendMessage(_ id: String, _ message: AgentMessage) {
        var thread = threads[id] ?? storage.loadThread(id)
        thread.append(message)
        threads[id] = thread
    }

    private func removeMessage(_ id: String, _ messageID: String) {
        threads[id]?.removeAll { $0.id == messageID }
    }

    /// Changes one message in place and keeps the conversation on disk soon after.
    private func mutate(_ id: String, _ messageID: String, _ change: (inout AgentMessage) -> Void) {
        guard var thread = threads[id], let index = thread.lastIndex(where: { $0.id == messageID }) else { return }
        change(&thread[index])
        threads[id] = thread
        storage.saveThread(id, thread)
    }

    func flush() {
        storage.flush()
    }
}

#if DEBUG
extension PhoneAgents {
    /// Three agents with something going on, for looking at the screens.
    func installDemo() {
        guard records.isEmpty else { return }
        let now = clock()
        func step(_ name: String, _ title: String, _ detail: String?, _ status: AgentStep.Status = .done, _ output: String? = nil) -> AgentPart {
            .tool(AgentStep(id: UUID().uuidString, name: name, title: title, detail: detail, status: status, output: output))
        }
        func chat(_ role: AgentMessage.Role, _ ago: TimeInterval, from: AgentMessage.Sender? = nil, _ parts: [AgentPart], streaming: Bool = false) -> AgentMessage {
            AgentMessage(id: UUID().uuidString, role: role, at: now.addingTimeInterval(-ago), from: from, parts: parts, streaming: streaming)
        }

        var morning = PhoneAgentRecord(
            id: "demo-morning", name: "Morning", colorHex: "#EE8A36", purpose: "Every morning, looks at today's calendar and sends a short briefing.",
            personality: "Calm and concise.", access: .autonomous, pinned: nil, createdAt: now.addingTimeInterval(-86_400 * 3)
        )
        morning.routines = [PhoneRoutine(id: "r1", name: "Morning briefing", task: "Look at today's calendar and send a short briefing.", everyMinutes: nil, daily: "08:00", nextAt: now.addingTimeInterval(3_600 * 11))]
        morning.lastRunAt = now.addingTimeInterval(-3_600 * 13)
        morning.lastOutcome = .init(at: now.addingTimeInterval(-3_600 * 13), ok: true)
        morning.notes = "Prefers the briefing before 8:15.\nSkip weekends."
        morning.goalRun = nil

        var scout = PhoneAgentRecord(
            id: "demo-scout", name: "Scout", colorHex: "#3E86C6", purpose: "Finds and checks information, and reports with links.",
            personality: "Inquisitive and thorough.", access: .safe, pinned: nil, createdAt: now.addingTimeInterval(-86_400)
        )
        scout.activity = "Reading the Swift concurrency docs"
        scout.goal = "Find the three biggest changes in Swift 6.2 concurrency"
        scout.goalRun = AgentGoalRun(text: scout.goal, state: .active, turns: 2)

        var remy = PhoneAgentRecord(
            id: "demo-remy", name: "Remy", colorHex: "#3FAE6A", purpose: "Turns what you tell it into reminders and events.",
            personality: "Friendly and exact.", access: .safe, pinned: nil, createdAt: now.addingTimeInterval(-7_200)
        )
        let ask = AgentAsk(id: "ask1", question: "May I add a reminder?", options: [], approval: "Add a reminder: Call Mum · 6:00 PM", at: now.addingTimeInterval(-120))
        remy.asks = [PhoneAsk(ask: ask, action: PendingAction(tool: "add_reminder", arguments: .object(["title": .string("Call Mum"), "due": .string("2026-10-05T18:00:00")])))]
        remy.lastRunAt = now.addingTimeInterval(-130)
        remy.lastOutcome = .init(at: now.addingTimeInterval(-130), ok: true)

        records = [scout, remy, morning]
        running = ["demo-scout"]
        threads["demo-morning"] = [
            chat(.user, 3_600 * 13 + 30, from: .init(name: "Routine · Morning briefing", colorHex: nil), [.text("Look at today's calendar and send a short briefing.")]),
            chat(.assistant, 3_600 * 13, [
                step("calendar_events", "Looked at the calendar", "next 1 days", .done, "- 5 Oct, 9:30–10:00 AM: Standup\n- 5 Oct, 1:00–2:00 PM: Lunch with Priya\n- 5 Oct, 4:00–5:00 PM: Design review"),
                .text("**Good morning.** Three things today:\n\n- **9:30** Standup\n- **1:00** Lunch with Priya\n- **4:00** Design review, bring the new landing screens\n\nNothing clashes. The review is the one to prepare for.")
            ])
        ]
        threads["demo-scout"] = [
            chat(.user, 900, [.text("Find the three biggest changes in Swift 6.2 concurrency")]),
            chat(.assistant, 880, [
                step("web_fetch", "Read a web page", "https://www.swift.org/blog/", .done, "# Swift.org Blog\nSwift 6.2 Released …"),
                .text("I found the release post. Reading the concurrency section now to pull out the three changes."),
                step("web_fetch", "Read a web page", "https://docs.swift.org/swift-book/", .running)
            ], streaming: true)
        ]
        threads["demo-remy"] = [
            chat(.user, 200, [.text("Remind me to call Mum at 6 tonight")]),
            chat(.assistant, 180, [
                step("add_reminder", "Add a reminder", "Call Mum · 2026-10-05T18:00:00", .denied, "Waiting for your OK."),
                .text("I've asked for your OK to add that reminder. I'll set it as soon as you say yes.")
            ])
        ]
    }
}
#endif
