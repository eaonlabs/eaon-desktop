import XCTest
@testable import Eaon

@MainActor
final class PhoneAgentsTests: XCTestCase {
    // MARK: Making agents

    func testANewAgentNeedsANameAndAPurposeAndAUniqueName() async throws {
        let h = AgentHarness()
        do { _ = try await h.agents.create(AgentDraft(name: "  ", purpose: "x")); XCTFail() } catch { XCTAssertEqual((error as? AgentError)?.message, "Give the agent a name.") }
        do { _ = try await h.agents.create(AgentDraft(name: "A", purpose: " ")); XCTFail() } catch { XCTAssertEqual((error as? AgentError)?.message, "Say what the agent is for.") }
        try await h.make("Scout")
        do { _ = try await h.make("scout"); XCTFail() } catch { XCTAssertTrue((error as? AgentError)?.message.contains("already an agent") == true) }
        XCTAssertEqual(h.agents.agents.count, 1)
    }

    func testThereIsALimit() async throws {
        let h = AgentHarness()
        for index in 0..<PhoneAgents.maxAgents { try await h.make("Agent \(index)") }
        do { _ = try await h.make("One more"); XCTFail() } catch { XCTAssertTrue((error as? AgentError)?.message.contains("most agents") == true) }
    }

    func testCreatingAskesForNotificationsWithoutWaitingOnTheAnswer() async throws {
        let h = AgentHarness()
        try await h.make()
        try? await Task.sleep(for: .milliseconds(50))
        XCTAssertEqual(h.notifier.permissionRequests, 1)
    }

    func testEditingChangesTheRecordAndKeepsTheRest() async throws {
        let h = AgentHarness()
        let agent = try await h.make("Scout")
        var draft = AgentDraft(name: "Scout 2", colorHex: "#D6509B", purpose: "New job", personality: "Terse", access: .readOnly)
        draft.pinned = .onDevice
        try await h.agents.update(agent.key.id, with: draft)
        let record = h.record(agent)
        XCTAssertEqual([record.name, record.colorHex, record.purpose, record.personality], ["Scout 2", "#D6509B", "New job", "Terse"])
        XCTAssertEqual(record.access, .readOnly)
        XCTAssertEqual(record.pinned, .onDevice)
        XCTAssertEqual(record.createdAt, agent.createdAt)
    }

    // MARK: A turn

    func testAMessageRunsATurnAndStreamsTheReply() async throws {
        let engine = ScriptedEngine { _, _, _, _, onText in
            onText("Hello ")
            onText("there.")
        }
        let h = AgentHarness(engine: engine)
        let agent = try await h.make()
        try await h.agents.send(agent.key.id, text: "  hi  ", asGoal: false)
        XCTAssertTrue(h.agents.hasRunningTurns)
        await h.settle()

        let thread = h.thread(agent)
        XCTAssertEqual(thread.map(\.role), [.user, .assistant])
        XCTAssertEqual(thread[0].text, "hi")
        XCTAssertEqual(thread[1].text, "Hello there.")
        XCTAssertFalse(thread[1].streaming)
        let record = h.record(agent)
        XCTAssertEqual(record.lastOutcome?.ok, true)
        XCTAssertNil(record.lastError)
        XCTAssertEqual(record.inbox.count, 0)
        XCTAssertEqual(record.unread, 1)
        XCTAssertEqual(h.storage.threads[agent.key.id]?.count, 2, "saved")
        // The model is told who it is, the time, and what the person said.
        XCTAssertTrue(engine.turns[0].system.contains("You are Scout"))
        XCTAssertTrue(engine.lastPrompt.hasPrefix("[Local time:"))
        XCTAssertTrue(engine.lastPrompt.hasSuffix("hi"))
    }

    func testMailSentWhileBusyIsFoldedIntoTheNextTurn() async throws {
        var release: CheckedContinuation<Void, Never>?
        let engine = ScriptedEngine { _, history, _, _, onText in
            if history.last?.text.hasSuffix("first") == true {
                await withCheckedContinuation { release = $0 }
            }
            onText("ok")
        }
        let h = AgentHarness(engine: engine)
        let agent = try await h.make()
        try await h.agents.send(agent.key.id, text: "first", asGoal: false)
        while release == nil { try? await Task.sleep(for: .milliseconds(5)) }
        try await h.agents.send(agent.key.id, text: "second", asGoal: false)
        try await h.agents.send(agent.key.id, text: "third", asGoal: false)
        XCTAssertEqual(h.record(agent).inbox.count, 2)
        release?.resume()
        await h.settle()

        XCTAssertEqual(engine.turns.count, 2, "one more turn, not two")
        XCTAssertTrue(engine.lastPrompt.contains("second\n\nthird"))
        XCTAssertEqual(h.record(agent).inbox.count, 0)
    }

    func testThePromptCarriesTheConversationSoFar() async throws {
        let h = AgentHarness()
        let agent = try await h.make()
        try await h.agents.send(agent.key.id, text: "one", asGoal: false)
        await h.settle()
        try await h.agents.send(agent.key.id, text: "two", asGoal: false)
        await h.settle()
        let roles = h.engine.turns[1].history.map { $0.role }
        XCTAssertEqual(roles, [.user, .assistant, .user])
        XCTAssertEqual(h.engine.turns[1].history[0].text, "one")
        XCTAssertEqual(h.engine.turns[1].history[1].text, "Okay.")
    }

    func testASmallModelGetsAShortHistory() async throws {
        let h = AgentHarness(small: true)
        let agent = try await h.make()
        let long = String(repeating: "x", count: 1_000)
        for index in 0..<6 {
            try await h.agents.send(agent.key.id, text: "\(index) \(long)", asGoal: false)
            await h.settle()
        }
        let history = h.engine.turns.last!.history
        XCTAssertLessThan(history.dropLast().map(\.text.count).reduce(0, +), 2_400)
        XCTAssertTrue(history.last!.text.hasSuffix(long.prefix(10)) || history.last!.text.contains("5 "))
    }

    func testNoModelIsAFailureWithAReason() async throws {
        let storage = MemoryPhoneAgentStorage()
        let notifier = RecordingAgentNotifier()
        let agents = PhoneAgents(storage: storage, notifier: notifier, resolveModel: { _ in nil })
        let agent = try await agents.create(AgentDraft(name: "A", purpose: "p"))
        try await agents.send(agent.key.id, text: "hi", asGoal: false)
        for _ in 0..<50 where agents.hasRunningTurns { try? await Task.sleep(for: .milliseconds(10)) }
        XCTAssertTrue(agents.record(agent.key.id)?.lastError?.contains("No model") == true)
        XCTAssertEqual(agents.agents.first?.status, .failed)
        // The message waits for a model; the agent doesn't spin trying.
        XCTAssertEqual(agents.record(agent.key.id)?.inbox.count, 1)
        try? await Task.sleep(for: .milliseconds(100))
        XCTAssertFalse(agents.hasRunningTurns)
    }

    // MARK: Tools

    func testToolsRunThroughTheRunnerAndShowAsSteps() async throws {
        let engine = ScriptedEngine { _, _, _, runner, onText in
            let result = await runner.execute(name: "update_notes", arguments: ["note": .string("Likes tea")])
            onText("Noted: \(result)")
        }
        let h = AgentHarness(engine: engine)
        let agent = try await h.make()
        try await h.agents.send(agent.key.id, text: "remember", asGoal: false)
        await h.settle()

        XCTAssertEqual(h.record(agent).notes, "Likes tea")
        let reply = h.thread(agent)[1]
        XCTAssertEqual(reply.steps.count, 1)
        XCTAssertEqual(reply.steps[0].title, "Updated its notes")
        XCTAssertEqual(reply.steps[0].status, .done)
        XCTAssertEqual(reply.steps[0].detail, "Likes tea")
        // Steps and text keep their order.
        guard case .tool = reply.parts.first, case .text = reply.parts.last else { return XCTFail("\(reply.parts)") }
    }

    func testNotesKeepTheirNewestLinesWithinTheLimit() async throws {
        let h = AgentHarness()
        let agent = try await h.make()
        let line = String(repeating: "a", count: 999)
        for index in 0..<5 { _ = h.agents.remember(agent.key.id, note: "\(index)" + line, replace: false) }
        let notes = h.record(agent).notes
        XCTAssertLessThanOrEqual(notes.count, PhoneAgentRecord.maxNotes)
        XCTAssertTrue(notes.contains("4" + line))
        XCTAssertFalse(notes.contains("0" + line), "the oldest went first")
        XCTAssertEqual(h.agents.remember(agent.key.id, note: "fresh", replace: true).hasPrefix("Notes saved"), true)
        XCTAssertEqual(h.record(agent).notes, "fresh")
    }

    // MARK: Access levels

    func testACarefulAgentAsksBeforeAddingAReminderAndDoesItOnApproval() async throws {
        let engine = ScriptedEngine { _, history, _, runner, onText in
            if history.last?.text.contains("[The person approved") == true { onText("Great, it's set."); return }
            let result = await runner.execute(name: "add_reminder", arguments: ["title": .string("Call Mum"), "due": .string("2026-10-05T18:00:00")])
            onText(result.hasPrefix("Not done yet") ? "Waiting for your OK." : "?")
        }
        let h = AgentHarness(engine: engine)
        let agent = try await h.make("Remy", access: .safe)
        try await h.agents.send(agent.key.id, text: "remind me", asGoal: false)
        await h.settle()

        XCTAssertTrue(h.calendar.addedReminders.isEmpty, "nothing happened yet")
        let asks = h.record(agent).asks
        XCTAssertEqual(asks.count, 1)
        XCTAssertEqual(asks[0].action?.tool, "add_reminder")
        XCTAssertTrue(asks[0].ask.approval?.contains("Call Mum") == true)
        XCTAssertEqual(h.thread(agent)[1].steps[0].status, .denied)
        XCTAssertEqual(h.notifier.posts.last?.title, "Remy needs your OK")
        XCTAssertEqual(h.agents.agents[0].asks.count, 1)
        XCTAssertEqual(h.agents.agents[0].mood, .curious)

        // Asking again for the same thing doesn't ask twice.
        _ = h.agents.tools(for: agent.key.id)
        await h.agents.answer(agent.key.id, askID: asks[0].ask.id, text: nil, approved: true)
        await h.settle()

        XCTAssertEqual(h.calendar.addedReminders.map(\.title), ["Call Mum"])
        XCTAssertTrue(h.record(agent).asks.isEmpty)
        XCTAssertTrue(h.engine.lastPrompt.contains("[The person approved: Add a reminder] Added the reminder “Call Mum”"))
        XCTAssertEqual(h.thread(agent).last?.text, "Great, it's set.")
        // The approved step is in the transcript.
        XCTAssertTrue(h.thread(agent).contains { $0.steps.contains { $0.name == "add_reminder" && $0.status == .done } })
    }

    func testDecliningDoesNothingAndTellsTheAgent() async throws {
        let engine = ScriptedEngine { _, _, _, runner, onText in
            _ = await runner.execute(name: "add_calendar_event", arguments: ["title": .string("Lunch"), "start": .string("2026-10-06T13:00:00")])
            onText("ok")
        }
        let h = AgentHarness(engine: engine)
        let agent = try await h.make(access: .safe)
        try await h.agents.send(agent.key.id, text: "book lunch", asGoal: false)
        await h.settle()
        let ask = try XCTUnwrap(h.record(agent).asks.first)
        await h.agents.answer(agent.key.id, askID: ask.ask.id, text: nil, approved: false)
        await h.settle()
        XCTAssertTrue(h.calendar.addedEvents.isEmpty)
        XCTAssertTrue(h.engine.lastPrompt.contains("[The person declined"))
    }

    func testALookOnlyAgentCannotWriteAndIsNotAsked() async throws {
        let engine = ScriptedEngine { _, _, _, runner, onText in
            let result = await runner.execute(name: "add_reminder", arguments: ["title": .string("x")])
            onText(result)
        }
        let h = AgentHarness(engine: engine)
        let agent = try await h.make(access: .readOnly)
        try await h.agents.send(agent.key.id, text: "do it", asGoal: false)
        await h.settle()
        XCTAssertTrue(h.calendar.addedReminders.isEmpty)
        XCTAssertTrue(h.record(agent).asks.isEmpty)
        XCTAssertTrue(h.thread(agent)[1].text.hasPrefix("Refused"))
        XCTAssertEqual(h.thread(agent)[1].steps[0].status, .denied)
    }

    func testAnAutonomousAgentJustDoesIt() async throws {
        let engine = ScriptedEngine { _, _, _, runner, onText in
            _ = await runner.execute(name: "add_reminder", arguments: ["title": .string("Call Mum"), "due": .string("2026-10-05T18:00:00")])
            onText("Done.")
        }
        let h = AgentHarness(engine: engine)
        let agent = try await h.make(access: .autonomous)
        try await h.agents.send(agent.key.id, text: "remind me", asGoal: false)
        await h.settle()
        XCTAssertEqual(h.calendar.addedReminders.map(\.title), ["Call Mum"])
        XCTAssertNotNil(h.calendar.addedReminders.first?.due)
    }

    // MARK: Questions

    func testAskUserRaisesAQuestionAndTheAnswerWakesTheAgent() async throws {
        let engine = ScriptedEngine { _, history, _, runner, onText in
            if history.last?.text.contains("[Answer to") == true { onText("Starting with concurrency."); return }
            _ = await runner.execute(name: "ask_user", arguments: ["question": .string("Which topic?"), "options": .array([.string("Concurrency"), .string("Macros")])])
            onText("I'll wait.")
        }
        let h = AgentHarness(engine: engine)
        let agent = try await h.make()
        try await h.agents.send(agent.key.id, text: "research swift", asGoal: false)
        await h.settle()

        let ask = try XCTUnwrap(h.record(agent).asks.first?.ask)
        XCTAssertEqual(ask.question, "Which topic?")
        XCTAssertEqual(ask.options, ["Concurrency", "Macros"])
        XCTAssertNil(ask.approval)
        XCTAssertEqual(h.notifier.posts.last?.body, "Which topic?")

        await h.agents.answer(agent.key.id, askID: ask.id, text: "Concurrency", approved: nil)
        await h.settle()
        XCTAssertTrue(h.record(agent).asks.isEmpty)
        XCTAssertTrue(h.engine.lastPrompt.contains("[Answer to “Which topic?”] Concurrency"))
        XCTAssertEqual(h.thread(agent).last?.text, "Starting with concurrency.")
    }

    // MARK: Schedules

    func testAHeartbeatWakesTheAgentOnceAtItsTime() async throws {
        let engine = ScriptedEngine { _, history, _, runner, onText in
            if history.last?.text.contains("[Wake-up you set for yourself]") == true { onText("Checked."); return }
            let result = await runner.execute(name: "set_heartbeat", arguments: ["in_minutes": .number(5), "note": .string("check the notes")])
            onText(result)
        }
        let h = AgentHarness(engine: engine)
        let agent = try await h.make()
        try await h.agents.send(agent.key.id, text: "watch", asGoal: false)
        await h.settle()

        let due = try XCTUnwrap(h.record(agent).heartbeat?.nextAt)
        XCTAssertEqual(due.timeIntervalSince(h.clock.now), 300, accuracy: 1)
        XCTAssertEqual(h.notifier.wakes[agent.key.id], due, "iOS is asked to remind the person")
        XCTAssertEqual(h.agents.agents[0].nextWakeAt, due)

        h.agents.tick()
        XCTAssertFalse(h.agents.hasRunningTurns, "not yet")
        h.clock.advance(minutes: 6)
        h.agents.tick()
        await h.settle()
        XCTAssertEqual(h.engine.turns.count, 2)
        XCTAssertTrue(h.engine.lastPrompt.contains("[Wake-up you set for yourself] check the notes"))
        XCTAssertNil(h.record(agent).heartbeat, "a one-off is done")
        XCTAssertEqual(h.thread(agent).last(where: { $0.role == .assistant })?.heartbeat, "check the notes")
        XCTAssertNil(h.notifier.wakes[agent.key.id])

        h.clock.advance(minutes: 60)
        h.agents.tick()
        await h.settle()
        XCTAssertEqual(h.engine.turns.count, 2, "and it doesn't run again")
    }

    func testADailyRoutineRunsOnceEvenAfterManyMissedDays() async throws {
        let clock = TestClock(TestClock.date(2026, 10, 5, 7, 0))
        let h = AgentHarness(clock: clock)
        let agent = try await h.make()
        let message = try h.agents.addRoutine(agent.key.id, name: "Briefing", task: "Summarise my day", everyMinutes: nil, daily: "08:00")
        XCTAssertTrue(message.contains("Briefing"))
        XCTAssertEqual(h.record(agent).routines[0].nextAt, TestClock.date(2026, 10, 5, 8, 0))

        clock.set(TestClock.date(2026, 10, 5, 8, 1))
        h.agents.tick()
        await h.settle()
        XCTAssertEqual(h.engine.turns.count, 1)
        XCTAssertTrue(h.engine.lastPrompt.contains("[Routine “Briefing”] Summarise my day"))
        XCTAssertEqual(h.record(agent).routines[0].nextAt, TestClock.date(2026, 10, 6, 8, 0))

        // The phone was closed for three days: one late run, then tomorrow.
        clock.set(TestClock.date(2026, 10, 9, 9, 30))
        h.agents.tick()
        await h.settle()
        h.agents.tick()
        await h.settle()
        XCTAssertEqual(h.engine.turns.count, 2)
        XCTAssertEqual(h.record(agent).routines[0].nextAt, TestClock.date(2026, 10, 10, 8, 0))
    }

    func testRoutinesAreChecked() async throws {
        let h = AgentHarness()
        let agent = try await h.make()
        XCTAssertThrowsError(try h.agents.addRoutine(agent.key.id, name: "x", task: "y", everyMinutes: 5, daily: nil)) { XCTAssertTrue(($0 as? ToolRefusal)?.message.contains("15 minutes") == true) }
        XCTAssertThrowsError(try h.agents.addRoutine(agent.key.id, name: "x", task: "y", everyMinutes: nil, daily: "25:99"))
        XCTAssertThrowsError(try h.agents.addRoutine(agent.key.id, name: "x", task: "y", everyMinutes: nil, daily: nil))
        XCTAssertThrowsError(try h.agents.addRoutine(agent.key.id, name: "", task: "y", everyMinutes: 30, daily: nil))
        _ = try h.agents.addRoutine(agent.key.id, name: "Walk", task: "t", everyMinutes: 30, daily: nil)
        _ = try h.agents.addRoutine(agent.key.id, name: "walk", task: "t2", everyMinutes: 60, daily: nil)
        XCTAssertEqual(h.record(agent).routines.count, 1, "the same name replaces")
        XCTAssertEqual(h.agents.removeRoutine(agent.key.id, name: "WALK"), "Removed “WALK”.")
        XCTAssertTrue(h.record(agent).routines.isEmpty)
    }

    func testAnAgentThatWakesItselfTooOftenIsStopped() async throws {
        let h = AgentHarness()
        let agent = try await h.make()
        for _ in 0..<(PhoneAgentRecord.maxSelfWakesPerHour + 3) {
            _ = try h.agents.setHeartbeat(agent.key.id, inMinutes: 1, at: nil, note: "again", stop: false)
            h.clock.advance(minutes: 2)
            h.agents.tick()
            await h.settle()
        }
        XCTAssertEqual(h.engine.turns.count, PhoneAgentRecord.maxSelfWakesPerHour)
    }

    func testHeartbeatTimesAreParsed() throws {
        let h = AgentHarness()
        let now = TestClock.date(2026, 10, 5, 7, 0)
        XCTAssertEqual(Schedule.parse("8:30", after: now), TestClock.date(2026, 10, 5, 8, 30))
        XCTAssertEqual(Schedule.parse("6:30", after: now), TestClock.date(2026, 10, 6, 6, 30), "already past today: tomorrow")
        XCTAssertEqual(Schedule.parse("8:30pm", after: now), TestClock.date(2026, 10, 5, 20, 30))
        XCTAssertEqual(Schedule.parse("12am", after: now), TestClock.date(2026, 10, 6, 0, 0))
        XCTAssertEqual(Schedule.parse("20.15", after: now), TestClock.date(2026, 10, 5, 20, 15))
        XCTAssertNotNil(Schedule.parse("2026-10-06T09:00:00Z", after: now))
        XCTAssertNil(Schedule.parse("2020-01-01T09:00:00Z", after: now), "in the past")
        XCTAssertNil(Schedule.parse("soon", after: now))
        XCTAssertNil(Schedule.parse("25:00", after: now))
        XCTAssertNil(Schedule.next(daily: "9", after: now))
        _ = h
    }

    func testHeartbeatLimitsAreExplained() async throws {
        let h = AgentHarness()
        let agent = try await h.make()
        XCTAssertThrowsError(try h.agents.setHeartbeat(agent.key.id, inMinutes: 99_999, at: nil, note: "", stop: false))
        XCTAssertThrowsError(try h.agents.setHeartbeat(agent.key.id, inMinutes: nil, at: "whenever", note: "", stop: false))
        _ = try h.agents.setHeartbeat(agent.key.id, inMinutes: 10, at: nil, note: "", stop: false)
        XCTAssertNotNil(h.record(agent).heartbeat)
        XCTAssertEqual(try h.agents.setHeartbeat(agent.key.id, inMinutes: nil, at: nil, note: "", stop: true), "Wake-up cancelled.")
        XCTAssertNil(h.record(agent).heartbeat)
    }

    // MARK: Goals

    func testAGoalKeepsGoingUntilTheAgentFinishesIt() async throws {
        let engine = ScriptedEngine { _, history, _, runner, onText in
            if history.last?.text.contains("Keep working on your goal") == true {
                _ = await runner.execute(name: "finish_goal", arguments: ["status": .string("achieved"), "summary": .string("Found three changes")])
                onText("All done.")
            } else {
                onText("Starting.")
            }
        }
        let h = AgentHarness(engine: engine)
        let agent = try await h.make()
        try await h.agents.send(agent.key.id, text: "Find three changes", asGoal: true)
        XCTAssertEqual(h.record(agent).goal, "Find three changes")
        XCTAssertEqual(h.record(agent).goalRun?.state, .active)
        await h.settle()
        try? await Task.sleep(for: .milliseconds(80))
        await h.settle()

        XCTAssertEqual(engine.turns.count, 2)
        XCTAssertEqual(h.record(agent).goalRun?.state, .achieved)
        XCTAssertEqual(h.record(agent).goalRun?.summary, "Found three changes")
        XCTAssertTrue(engine.turns[0].system.contains("Your goal: Find three changes"))
    }

    func testAGoalThatNeverFinishesPausesAfterItsTurns() async throws {
        let h = AgentHarness()
        let agent = try await h.make()
        try await h.agents.send(agent.key.id, text: "Endless task", asGoal: true)
        for _ in 0..<40 {
            await h.settle()
            try? await Task.sleep(for: .milliseconds(15))
            if h.record(agent).goalRun?.state == .paused { break }
        }
        XCTAssertEqual(h.record(agent).goalRun?.state, .paused)
        XCTAssertTrue(h.record(agent).goalRun?.summary?.contains("Say continue") == true)
        XCTAssertEqual(h.engine.turns.count, 1 + PhoneAgents.goalTurnLimit)

        // Saying continue starts it again, for another stretch.
        let before = h.engine.turns.count
        await h.agents.setGoal(agent.key.id, .resume)
        XCTAssertEqual(h.record(agent).goalRun?.state, .active)
        for _ in 0..<40 {
            await h.settle()
            try? await Task.sleep(for: .milliseconds(15))
            if h.record(agent).goalRun?.state == .paused { break }
        }
        XCTAssertGreaterThan(h.engine.turns.count, before)
        XCTAssertEqual(h.record(agent).goalRun?.state, .paused)
        await h.agents.setGoal(agent.key.id, .clear)
        XCTAssertNil(h.record(agent).goalRun)
    }

    // MARK: Stopping, failing, pausing

    func testStopKeepsWhatWasWrittenAndPausesAGoal() async throws {
        var release: CheckedContinuation<Void, Never>?
        let engine = ScriptedEngine { _, _, _, _, onText in
            onText("Part one. ")
            await withCheckedContinuation { release = $0 }
            try Task.checkCancellation()
            onText("Part two.")
        }
        let h = AgentHarness(engine: engine)
        let agent = try await h.make()
        try await h.agents.send(agent.key.id, text: "go", asGoal: true)
        while release == nil { try? await Task.sleep(for: .milliseconds(5)) }
        await h.agents.stop(agent.key.id)
        release?.resume()
        await h.settle()

        let reply = h.thread(agent)[1]
        XCTAssertEqual(reply.text, "Part one. ")
        XCTAssertFalse(reply.streaming)
        XCTAssertNil(reply.error)
        XCTAssertEqual(h.record(agent).goalRun?.state, .paused)
        XCTAssertNil(h.record(agent).lastOutcome, "stopping isn't a failure or a success")
        XCTAssertEqual(h.engine.turns.count, 1)
    }

    func testAFailureIsKeptAndAWakeRecovers() async throws {
        var fail = true
        let engine = ScriptedEngine { _, _, _, _, onText in
            if fail { throw BackendError.http(401, nil) }
            onText("Back.")
        }
        let h = AgentHarness(engine: engine)
        let agent = try await h.make()
        try await h.agents.send(agent.key.id, text: "go", asGoal: false)
        await h.settle()

        let reply = h.thread(agent)[1]
        XCTAssertTrue(reply.error?.contains("key was refused") == true)
        XCTAssertEqual(h.record(agent).lastOutcome?.ok, false)
        XCTAssertEqual(h.agents.agents[0].status, .failed)
        XCTAssertEqual(h.agents.agents[0].mood, .dead)

        fail = false
        await h.agents.wake(agent.key.id)
        await h.settle()
        XCTAssertEqual(h.thread(agent).last?.text, "Back.")
        XCTAssertEqual(h.record(agent).lastOutcome?.ok, true)
        XCTAssertNil(h.record(agent).lastError)
        XCTAssertNotEqual(h.agents.agents[0].status, .failed)
    }

    func testAnEmptyReplyIsAFailureNotABlankBubble() async throws {
        let h = AgentHarness(engine: ScriptedEngine { _, _, _, _, _ in })
        let agent = try await h.make()
        try await h.agents.send(agent.key.id, text: "go", asGoal: false)
        await h.settle()
        XCTAssertEqual(h.thread(agent)[1].error, "The model sent back nothing.")
        XCTAssertEqual(h.record(agent).lastOutcome?.ok, false)
    }

    func testAPausedAgentWaitsForResume() async throws {
        let h = AgentHarness()
        let agent = try await h.make()
        await h.agents.setPaused(agent.key.id, paused: true)
        try await h.agents.send(agent.key.id, text: "hello", asGoal: false)
        h.agents.tick()
        await h.settle()
        XCTAssertEqual(h.engine.turns.count, 0)
        XCTAssertEqual(h.agents.agents[0].status, .paused)
        XCTAssertEqual(h.agents.agents[0].mood, .asleep)
        XCTAssertEqual(h.record(agent).inbox.count, 1)

        await h.agents.setPaused(agent.key.id, paused: false)
        await h.settle()
        XCTAssertEqual(h.engine.turns.count, 1)
        XCTAssertEqual(h.record(agent).inbox.count, 0)
    }

    // MARK: Moods

    func testMoodsFollowWhatTheAgentIsDoing() async throws {
        let h = AgentHarness()
        let agent = try await h.make()
        var record = h.record(agent)
        let now = h.clock.now
        XCTAssertEqual(record.mood(running: false, now: now), .neutral)
        XCTAssertEqual(record.mood(running: false, now: now.addingTimeInterval(6 * 60)), .sleepy)
        XCTAssertEqual(record.mood(running: false, now: now.addingTimeInterval(16 * 60)), .asleep)
        XCTAssertEqual(record.mood(running: true, now: now), .serious)
        record.lastOutcome = .init(at: now, ok: true)
        XCTAssertEqual(record.mood(running: false, now: now.addingTimeInterval(60)), .happy)
        record.lastOutcome = .init(at: now, ok: false)
        XCTAssertEqual(record.mood(running: false, now: now.addingTimeInterval(60)), .sad)
        record.lastError = "x"
        XCTAssertEqual(record.mood(running: false, now: now.addingTimeInterval(60)), .dead)
        record.lastError = nil
        record.moodHint = .init(mood: .excited, until: now.addingTimeInterval(100))
        XCTAssertEqual(record.mood(running: false, now: now.addingTimeInterval(60)), .excited)
        XCTAssertEqual(record.mood(running: false, now: now.addingTimeInterval(200)), .sad, "hints expire")
        record.paused = true
        XCTAssertEqual(record.mood(running: true, now: now), .asleep)
    }

    // MARK: Keeping and forgetting

    func testRecordsAndConversationsSurviveARelaunch() async throws {
        let storage = MemoryPhoneAgentStorage()
        let h = AgentHarness(storage: storage)
        let agent = try await h.make("Scout")
        try await h.agents.send(agent.key.id, text: "hi", asGoal: false)
        await h.settle()
        // A turn that was streaming when the app was killed.
        var thread = storage.threads[agent.key.id]!
        thread[1].streaming = true
        storage.threads[agent.key.id] = thread

        let again = AgentHarness(storage: storage)
        XCTAssertEqual(again.agents.agents.map(\.name), ["Scout"])
        await again.agents.loadThread(agent.key.id)
        XCTAssertEqual(again.agents.messages(for: agent.key.id).count, 2)
        XCTAssertFalse(again.agents.messages(for: agent.key.id)[1].streaming)
        XCTAssertFalse(again.agents.hasRunningTurns)
    }

    func testRemovingAndErasing() async throws {
        let h = AgentHarness()
        let one = try await h.make("One")
        let two = try await h.make("Two")
        _ = try h.agents.setHeartbeat(one.key.id, inMinutes: 10, at: nil, note: "", stop: false)
        try await h.agents.send(one.key.id, text: "hi", asGoal: false)
        await h.settle()
        try await h.agents.remove(one.key.id)
        XCTAssertEqual(h.agents.agents.map(\.name), ["Two"])
        XCTAssertNil(h.storage.threads[one.key.id])
        XCTAssertNil(h.notifier.wakes[one.key.id])
        h.agents.eraseAll()
        XCTAssertTrue(h.agents.agents.isEmpty)
        XCTAssertTrue(h.storage.records.isEmpty)
        _ = two
    }

    func testAReplyWhileAwayBecomesANotification() async throws {
        let h = AgentHarness()
        h.agents.isForeground = { false }
        let agent = try await h.make("Scout")
        try await h.agents.send(agent.key.id, text: "hi", asGoal: false)
        await h.settle()
        XCTAssertEqual(h.notifier.posts.last, RecordingAgentNotifier.Post(title: "Scout", body: "Okay.", agentID: agent.key.id))
        XCTAssertEqual(h.record(agent).unread, 1)
        await h.agents.markRead(agent.key.id)
        XCTAssertEqual(h.record(agent).unread, 0)
    }

    func testTheOpenAgentIsNotCountedUnread() async throws {
        let h = AgentHarness()
        let agent = try await h.make("Scout")
        h.agents.selected = agent.key.id
        try await h.agents.send(agent.key.id, text: "hi", asGoal: false)
        await h.settle()
        XCTAssertEqual(h.record(agent).unread, 0)
    }
}
