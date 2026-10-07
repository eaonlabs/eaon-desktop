import Foundation

/// The tools a phone agent has. Each is small: the names and descriptions are
/// what the model reads, so they are short and say what the tool is for.
enum PhoneTools {
    /// A line cut to fit under a title.
    nonisolated static func clip(_ text: String?, _ limit: Int = 100) -> String? {
        guard let text, !text.isEmpty else { return nil }
        return text.count > limit ? String(text.prefix(limit)) + "…" : text
    }

    @MainActor
    static func make(agentID id: String, agents: PhoneAgents) -> [AgentTool] {
        let services = agents.services
        let clock = agents.clock

        return [
            AgentTool(
                name: "web_fetch",
                description: "Read a web page or a JSON/text address and get its text. For addresses on the public internet only.",
                parameters: [ToolParameter(name: "url", kind: .string, description: "The full address, starting with https://", required: true)],
                risk: .read,
                title: { _ in "Read a web page" },
                detail: { Self.clip($0.string("url")) },
                run: { arguments in
                    guard let text = arguments.string("url"), let url = URL(string: text) else { throw ToolRefusal(message: "I need a full web address.") }
                    return try await services.web.fetch(url)
                }
            ),
            AgentTool(
                name: "calendar_events",
                description: "List the person's calendar events coming up.",
                parameters: [ToolParameter(name: "days", kind: .integer, description: "How many days ahead, 1 to 31. Default 2.")],
                risk: .read,
                title: { _ in "Looked at the calendar" },
                detail: { arguments in arguments.int("days").map { "next \($0) days" } },
                run: { arguments in
                    let events = try await services.calendar.upcomingEvents(days: arguments.int("days") ?? 2)
                    if events.isEmpty { return "Nothing on the calendar in that time." }
                    return events.map { event in
                        let when = event.allDay ? event.start.formatted(date: .abbreviated, time: .omitted) + " (all day)"
                            : event.start.formatted(date: .abbreviated, time: .shortened) + "–" + event.end.formatted(date: .omitted, time: .shortened)
                        return "- \(when): \(event.title)\(event.location.map { " @ \($0)" } ?? "")"
                    }.joined(separator: "\n")
                }
            ),
            AgentTool(
                name: "list_reminders",
                description: "List the person's open reminders.",
                risk: .read,
                core: false,
                title: { _ in "Looked at the reminders" },
                run: { _ in
                    let reminders = try await services.calendar.openReminders()
                    if reminders.isEmpty { return "No open reminders." }
                    return reminders.map { "- \($0.title)\($0.due.map { " (due \($0.formatted(date: .abbreviated, time: .shortened)))" } ?? "")" }.joined(separator: "\n")
                }
            ),
            AgentTool(
                name: "add_calendar_event",
                description: "Add an event to the person's calendar.",
                parameters: [
                    ToolParameter(name: "title", kind: .string, description: "What the event is", required: true),
                    ToolParameter(name: "start", kind: .string, description: "When it starts: an ISO 8601 date and time like 2026-10-06T15:30:00, in the person's time zone", required: true),
                    ToolParameter(name: "minutes", kind: .integer, description: "How long it lasts. Default 60."),
                    ToolParameter(name: "notes", kind: .string, description: "Anything to add")
                ],
                risk: .write,
                title: { _ in "Add a calendar event" },
                detail: { arguments in Self.clip([arguments.string("title"), arguments.string("start")].compactMap { $0 }.joined(separator: " · ")) },
                run: { arguments in
                    guard let title = arguments.string("title"), !title.isEmpty else { throw ToolRefusal(message: "The event needs a title.") }
                    guard let startText = arguments.string("start"), let start = AgentDates.parse(startText, now: clock()) else {
                        throw ToolRefusal(message: "I couldn't read the start time. Use an ISO 8601 date and time, like 2026-10-06T15:30:00.")
                    }
                    return try await services.calendar.addEvent(title: title, start: start, minutes: arguments.int("minutes") ?? 60, notes: arguments.string("notes"))
                }
            ),
            AgentTool(
                name: "add_reminder",
                description: "Add a reminder for the person, optionally for a time.",
                parameters: [
                    ToolParameter(name: "title", kind: .string, description: "What to be reminded of", required: true),
                    ToolParameter(name: "due", kind: .string, description: "When, as an ISO 8601 date and time like 2026-10-06T15:30:00. Leave out for no time.")
                ],
                risk: .write,
                title: { _ in "Add a reminder" },
                detail: { arguments in Self.clip([arguments.string("title"), arguments.string("due")].compactMap { $0 }.joined(separator: " · ")) },
                run: { arguments in
                    guard let title = arguments.string("title"), !title.isEmpty else { throw ToolRefusal(message: "The reminder needs a title.") }
                    var due: Date?
                    if let text = arguments.string("due"), !text.isEmpty {
                        guard let parsed = AgentDates.parse(text, now: clock()) else { throw ToolRefusal(message: "I couldn't read the time. Use an ISO 8601 date and time, like 2026-10-06T15:30:00.") }
                        due = parsed
                    }
                    return try await services.calendar.addReminder(title: title, due: due)
                }
            ),
            AgentTool(
                name: "update_notes",
                description: "Your memory between turns. Add a line, or replace everything. Keep what you'll need later.",
                parameters: [
                    ToolParameter(name: "note", kind: .string, description: "What to remember", required: true),
                    ToolParameter(name: "replace", kind: .boolean, description: "True to replace all your notes with this")
                ],
                risk: .own,
                title: { _ in "Updated its notes" },
                detail: { Self.clip($0.string("note")) },
                run: { arguments in
                    guard let note = arguments.string("note"), !note.isEmpty else { throw ToolRefusal(message: "The note is empty.") }
                    return agents.remember(id, note: note, replace: arguments.bool("replace") ?? false)
                }
            ),
            AgentTool(
                name: "ask_user",
                description: "Ask the person something without waiting: they are notified, and the answer arrives later as a message.",
                parameters: [
                    ToolParameter(name: "question", kind: .string, description: "The question", required: true),
                    ToolParameter(name: "options", kind: .strings, description: "Up to four quick answers")
                ],
                risk: .own,
                title: { _ in "Asked you a question" },
                detail: { Self.clip($0.string("question")) },
                run: { arguments in
                    guard let question = arguments.string("question"), !question.isEmpty else { throw ToolRefusal(message: "The question is empty.") }
                    return agents.raiseQuestion(id, question: question, options: arguments.strings("options"))
                }
            ),
            AgentTool(
                name: "notify_user",
                description: "Send the person a notification to tell them something worth their attention.",
                parameters: [
                    ToolParameter(name: "title", kind: .string, description: "A short title"),
                    ToolParameter(name: "body", kind: .string, description: "The message", required: true)
                ],
                risk: .own,
                title: { _ in "Sent you a notification" },
                detail: { Self.clip($0.string("body")) },
                run: { arguments in
                    guard let body = arguments.string("body"), !body.isEmpty else { throw ToolRefusal(message: "The message is empty.") }
                    return agents.reachOut(id, title: arguments.string("title") ?? "", body: body)
                }
            ),
            AgentTool(
                name: "set_heartbeat",
                description: "Wake yourself later to check on something. Give in_minutes or at; stop to cancel.",
                parameters: [
                    ToolParameter(name: "in_minutes", kind: .integer, description: "Minutes from now, up to 1440"),
                    ToolParameter(name: "at", kind: .string, description: "A clock time like 8:30 or 20:30, or an ISO 8601 date and time"),
                    ToolParameter(name: "note", kind: .string, description: "What you'll want to do when you wake"),
                    ToolParameter(name: "stop", kind: .boolean, description: "True to cancel your wake-up")
                ],
                risk: .own,
                title: { arguments in arguments.bool("stop") == true ? "Cancelled its wake-up" : "Set a wake-up" },
                detail: { arguments in Self.clip(arguments.string("note") ?? arguments.string("at") ?? arguments.int("in_minutes").map { "in \($0) min" }) },
                run: { arguments in
                    try agents.setHeartbeat(id, inMinutes: arguments.int("in_minutes"), at: arguments.string("at"), note: arguments.string("note") ?? "", stop: arguments.bool("stop") ?? false)
                }
            ),
            AgentTool(
                name: "add_routine",
                description: "Do something on a schedule: every N minutes (at least 15), or daily at a time.",
                parameters: [
                    ToolParameter(name: "name", kind: .string, description: "A short name", required: true),
                    ToolParameter(name: "task", kind: .string, description: "What to do each time", required: true),
                    ToolParameter(name: "every_minutes", kind: .integer, description: "Repeat every this many minutes"),
                    ToolParameter(name: "daily", kind: .string, description: "Every day at this time, HH:MM like 08:30")
                ],
                risk: .own,
                title: { _ in "Set up a routine" },
                detail: { Self.clip($0.string("name")) },
                run: { arguments in
                    try agents.addRoutine(id, name: arguments.string("name") ?? "", task: arguments.string("task") ?? "", everyMinutes: arguments.int("every_minutes"), daily: arguments.string("daily"))
                }
            ),
            AgentTool(
                name: "remove_routine",
                description: "Stop one of your routines.",
                parameters: [ToolParameter(name: "name", kind: .string, description: "Its name", required: true)],
                risk: .own,
                core: false,
                title: { _ in "Removed a routine" },
                detail: { Self.clip($0.string("name")) },
                run: { arguments in agents.removeRoutine(id, name: arguments.string("name") ?? "") }
            ),
            AgentTool(
                name: "set_goal",
                description: "Write down what you are working towards, in one or two sentences.",
                parameters: [ToolParameter(name: "goal", kind: .string, description: "The goal", required: true)],
                risk: .own,
                core: false,
                title: { _ in "Set its goal" },
                detail: { Self.clip($0.string("goal")) },
                run: { arguments in agents.setOwnGoal(id, text: arguments.string("goal") ?? "") }
            ),
            AgentTool(
                name: "set_status",
                description: "Say in a few words what you're doing, so the person sees it, and optionally pick a mood.",
                parameters: [
                    ToolParameter(name: "activity", kind: .string, description: "A few words", required: true),
                    ToolParameter(name: "mood", kind: .choice(AgentMood.allCases.map(\.rawValue)), description: "A face to wear for a couple of minutes")
                ],
                risk: .own,
                core: false,
                title: { _ in "Updated its status" },
                detail: { Self.clip($0.string("activity")) },
                run: { arguments in
                    agents.setActivity(id, activity: arguments.string("activity") ?? "", mood: arguments.string("mood").flatMap(AgentMood.init(rawValue:)))
                    return "Status updated."
                }
            ),
            AgentTool(
                name: "finish_goal",
                description: "Report that your goal is achieved, or that you can't go on. Ends the goal run.",
                parameters: [
                    ToolParameter(name: "status", kind: .choice(["achieved", "blocked"]), description: "How it ended", required: true),
                    ToolParameter(name: "summary", kind: .string, description: "What you did, or what's in the way", required: true)
                ],
                risk: .own,
                title: { arguments in arguments.string("status") == "blocked" ? "Reported it's blocked" : "Finished its goal" },
                detail: { Self.clip($0.string("summary")) },
                run: { arguments in agents.finishGoal(id, achieved: arguments.string("status") != "blocked", summary: arguments.string("summary") ?? "") }
            )
        ]
    }
}

/// Dates a model writes: ISO 8601, with or without a time zone or seconds.
enum AgentDates {
    static func parse(_ text: String, now: Date) -> Date? {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        let withZone = ISO8601DateFormatter()
        if let date = withZone.date(from: trimmed) { return date }
        // No zone: the person's own.
        for format in ["yyyy-MM-dd'T'HH:mm:ss", "yyyy-MM-dd'T'HH:mm", "yyyy-MM-dd HH:mm:ss", "yyyy-MM-dd HH:mm", "yyyy-MM-dd"] {
            let formatter = DateFormatter()
            formatter.locale = Locale(identifier: "en_US_POSIX")
            formatter.timeZone = .current
            formatter.dateFormat = format
            if let date = formatter.date(from: trimmed) { return date }
        }
        return Schedule.parse(trimmed, after: now)
    }
}
