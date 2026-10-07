import Foundation
import Observation

/// The agents on a connected Mac. It keeps a live copy of what the Mac's
/// Eaon says over the Remote API's event stream, and sends the person's
/// commands back. If the connection drops it reconnects, with a pause that grows,
/// and catches up on the conversations that were open.
@MainActor
@Observable
final class MacAgents: AgentSource {
    enum Connection: Equatable {
        case off
        case connecting
        case live
        case failed(String)
    }

    let place = AgentPlace.mac
    private(set) var agents: [Agent] = []
    private(set) var connection: Connection = .off
    private(set) var computerName: String?
    private(set) var models: [RemoteModel] = []
    private(set) var defaultModel: String?

    var isAvailable: Bool { connection == .live }

    @ObservationIgnored private var threads: [String: [AgentMessage]] = [:]
    /// Messages the person just sent, shown at once, until the Mac's own copy arrives.
    @ObservationIgnored private var echoes: [String: [AgentMessage]] = [:]
    private(set) var threadVersion = 0
    @ObservationIgnored private var client: RemoteClient?
    @ObservationIgnored private var loop: Task<Void, Never>?
    @ObservationIgnored private var loaded: Set<String> = []
    /// The longest pause between reconnection attempts, in seconds.
    @ObservationIgnored var maxBackoff = 15.0

    // MARK: Connecting

    /// Points at a Mac (or at none, with nil), and follows it.
    func configure(client: RemoteClient?, name: String?) {
        loop?.cancel()
        loop = nil
        self.client = client
        computerName = name
        guard let client else {
            agents = []
            threads = [:]
            echoes = [:]
            loaded = []
            models = []
            connection = .off
            return
        }
        connection = .connecting
        loop = Task { [weak self] in await self?.follow(client) }
    }

    private func follow(_ client: RemoteClient) async {
        var pause = 1.0
        var reconnected = false
        while !Task.isCancelled {
            do {
                for try await event in client.events() {
                    if connection != .live {
                        connection = .live
                        pause = 1
                        if reconnected { await catchUp(client) }
                        reconnected = true
                        Task { await self.loadModels(client) }
                    }
                    apply(event)
                }
                connection = .failed("The Mac closed the connection.")
            } catch is CancellationError {
                return
            } catch let error as RemoteError where error.kind == .unauthorized {
                // Retrying a wrong key only gets this iPhone locked out.
                connection = .failed(error.message)
                return
            } catch {
                connection = .failed((error as? LocalizedError)?.errorDescription ?? error.localizedDescription)
            }
            try? await Task.sleep(for: .seconds(pause))
            pause = min(pause * 2, maxBackoff)
            if !Task.isCancelled, connection != .live { connection = .connecting }
        }
    }

    private func loadModels(_ client: RemoteClient) async {
        if let reply = try? await client.models() {
            models = reply.models
            defaultModel = reply.default
        }
    }

    /// After a reconnect: what happened while the stream was down.
    private func catchUp(_ client: RemoteClient) async {
        for id in loaded {
            if let reply = try? await client.thread(id) {
                threads[id] = reply.messages.map(\.message)
                threadVersion += 1
            }
        }
    }

    // MARK: Events

    func apply(_ event: RemoteEvent) {
        switch event {
        case .workers(let workers):
            agents = workers.map(\.agent)
        case .message(let workerID, let message):
            guard loaded.contains(workerID) else { return }
            var thread = threads[workerID] ?? []
            let converted = message.message
            if let index = thread.firstIndex(where: { $0.id == converted.id }) {
                thread[index] = converted
            } else {
                thread.append(converted)
            }
            threads[workerID] = thread
            if converted.role == .user {
                let text = converted.text
                echoes[workerID]?.removeAll { text.contains($0.text) }
            }
            threadVersion += 1
        case .delta(let workerID, let messageID, let text):
            changeMessage(workerID, messageID) { $0.append(text: text) }
        case .tool(let workerID, let messageID, let part):
            guard case .tool(let step)? = part.part else { return }
            changeMessage(workerID, messageID) { $0.upsert(step: step) }
        }
    }

    private func changeMessage(_ workerID: String, _ messageID: String, _ change: (inout AgentMessage) -> Void) {
        guard var thread = threads[workerID], let index = thread.lastIndex(where: { $0.id == messageID }) else { return }
        change(&thread[index])
        threads[workerID] = thread
        threadVersion += 1
    }

    // MARK: Reading

    func messages(for id: String) -> [AgentMessage] {
        _ = threadVersion
        return (threads[id] ?? []) + (echoes[id] ?? [])
    }

    func loadThread(_ id: String) async {
        guard let client else { return }
        loaded.insert(id)
        if let reply = try? await client.thread(id) {
            threads[id] = reply.messages.map(\.message)
            threadVersion += 1
        }
    }

    private func refreshAgents() async {
        guard let client, let workers = try? await client.workers() else { return }
        agents = workers.map(\.agent)
    }

    // MARK: Commands

    private func requireClient() throws -> RemoteClient {
        guard let client else { throw AgentError.notConnected }
        return client
    }

    private func body(_ draft: AgentDraft) -> RemoteClient.DraftBody {
        var model: RemoteClient.DraftBody.Model?
        if let id = draft.modelID, let slash = id.firstIndex(of: "/") {
            model = .init(providerId: String(id[..<slash]), modelId: String(id[id.index(after: slash)...]))
        }
        return RemoteClient.DraftBody(
            name: draft.name.trimmingCharacters(in: .whitespacesAndNewlines),
            color: draft.colorHex,
            purpose: draft.purpose.trimmingCharacters(in: .whitespacesAndNewlines),
            personality: draft.personality.trimmingCharacters(in: .whitespacesAndNewlines),
            access: draft.access.rawValue,
            model: model
        )
    }

    func create(_ draft: AgentDraft) async throws -> Agent {
        let client = try requireClient()
        let worker = try await client.create(body(draft))
        let agent = worker.agent
        if !agents.contains(where: { $0.key == agent.key }) { agents.append(agent) }
        return agent
    }

    func update(_ id: String, with draft: AgentDraft) async throws {
        let client = try requireClient()
        let worker = try await client.update(id, body(draft))
        if let index = agents.firstIndex(where: { $0.key.id == id }) { agents[index] = worker.agent }
    }

    func remove(_ id: String) async throws {
        let client = try requireClient()
        try await client.delete(id)
        agents.removeAll { $0.key.id == id }
        threads[id] = nil
        echoes[id] = nil
        loaded.remove(id)
    }

    func send(_ id: String, text: String, asGoal: Bool) async throws {
        let client = try requireClient()
        let text = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty else { return }
        let echo = AgentMessage(id: "local-\(UUID().uuidString)", role: .user, at: Date(), parts: [.text(text)])
        echoes[id, default: []].append(echo)
        threadVersion += 1
        do {
            try await client.sendMessage(id, text: text, goal: asGoal)
        } catch {
            echoes[id]?.removeAll { $0.id == echo.id }
            threadVersion += 1
            throw error
        }
    }

    func stop(_ id: String) async { await run { try await $0.command(id, "stop") } }
    func wake(_ id: String) async { await run { try await $0.command(id, "wake") } }
    func clear(_ id: String) async {
        await run { try await $0.command(id, "clear") }
        threads[id] = []
        echoes[id] = nil
        threadVersion += 1
    }
    func markRead(_ id: String) async { await run(refresh: false) { try await $0.command(id, "read") } }

    func setPaused(_ id: String, paused: Bool) async {
        await run { try await $0.setPaused(id, paused: paused) }
    }

    func setGoal(_ id: String, _ command: GoalCommand) async {
        let status: String? = switch command {
        case .pause: "paused"
        case .resume: "active"
        case .clear: nil
        }
        await run { try await $0.setGoal(id, status: status) }
    }

    func answer(_ id: String, askID: String, text: String?, approved: Bool?) async {
        await run { try await $0.answer(id, askID: askID, text: text, approved: approved) }
    }

    /// Commands from a button have nowhere to show an error: if one fails, the next event or refresh puts the screen
    /// right, and a dropped connection already says so.
    private func run(refresh: Bool = true, _ command: (RemoteClient) async throws -> Void) async {
        guard let client else { return }
        try? await command(client)
        if refresh { await refreshAgents() }
    }
}

#if DEBUG
extension MacAgents {
    /// A pretend connected Mac with two agents, for looking at the screens.
    func installDemo() {
        let now = Date()
        computerName = "Alex's MacBook Pro"
        connection = .live
        models = [
            RemoteModel(id: "anthropic/claude-sonnet-5-5", name: "claude-sonnet-5-5", provider: "Anthropic"),
            RemoteModel(id: "openai/gpt-5", name: "gpt-5", provider: "OpenAI")
        ]
        agents = [
            Agent(
                key: AgentKey(place: .mac, id: "nova"), name: "Nova", colorHex: "#5B6CF0",
                purpose: "Writes and changes code, runs the tests and explains what changed.",
                personality: "Methodical and pragmatic.", status: .working, mood: .serious,
                activity: "Running the test suite", access: .autonomous, modelName: "claude-sonnet-5-5",
                goal: "Make the checkout tests pass",
                goalRun: AgentGoalRun(text: "Make the checkout tests pass", state: .active, turns: 4),
                createdAt: now.addingTimeInterval(-86_400 * 6)
            ),
            Agent(
                key: AgentKey(place: .mac, id: "atlas"), name: "Atlas", colorHex: "#22A7A0",
                purpose: "Works with data and reports what the numbers say.",
                status: .idle, mood: .curious,
                asks: [AgentAsk(id: "q1", question: "Should the report include refunds?", options: ["Include them", "Leave them out"], approval: nil, at: now.addingTimeInterval(-300))],
                lastRunAt: now.addingTimeInterval(-600), nextWakeAt: now.addingTimeInterval(3_600), createdAt: now.addingTimeInterval(-86_400 * 2)
            )
        ]
    }
}
#endif
