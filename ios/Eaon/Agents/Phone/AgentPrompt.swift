import Foundation

/// What an agent is told about itself at the start of every turn.
enum AgentPrompt {
    static func system(for record: PhoneAgentRecord, now: Date, small: Bool) -> String {
        var lines: [String] = []
        lines.append("You are \(record.name), an agent that lives on the user's iPhone, inside the Eaon app.")
        lines.append("Your purpose: \(record.purpose)")
        if !record.personality.isEmpty { lines.append("Your manner: \(record.personality)") }
        lines.append("Right now it is \(timeText(now)).")
        if !record.goal.isEmpty { lines.append("Your goal: \(record.goal)") }
        if !record.notes.isEmpty { lines.append("Your notes (your own memory; keep them current with update_notes):\n\(record.notes)") }

        if small {
            lines.append("Be brief; this is a phone. Use the tools to look things up and to act, and never claim to have done something you didn't.")
        } else {
            lines.append("""
            How you work:
            - You run only while Eaon is open on the iPhone. You wake when the person writes to you, or at a time you set yourself (set_heartbeat, add_routine); a wake-up that comes due while Eaon is closed runs when it is next opened, and the person gets a reminder.
            - Use your tools to look things up and to act. Never claim to have done something you didn't do.
            - If you need a decision, call ask_user and carry on with what you can; the answer arrives as a message. Don't wait for it.
            - Keep what you learn in your notes: they are the only thing you remember between turns besides this conversation.
            - Be brief: the person is on a phone. Short paragraphs and short lists, no tables.
            """)
        }
        switch record.access {
        case .autonomous: break
        case .safe: lines.append("Your access is Careful: adding an event or a reminder needs the person's OK. The request is made for you when you try; say you are waiting.")
        case .readOnly: lines.append("Your access is Look only: you can read, search and report, but you cannot add or change anything.")
        }
        if let run = record.goalRun, run.state == .active {
            lines.append("You are working on your goal across several turns. When it is done, or you cannot go on, call finish_goal.")
        }
        return lines.joined(separator: "\n\n")
    }

    /// "Monday 5 October 2026, 7:42 PM PDT".
    static func timeText(_ date: Date) -> String {
        let formatter = DateFormatter()
        formatter.locale = Locale(identifier: "en_US_POSIX")
        formatter.dateFormat = "EEEE d MMMM yyyy, h:mm a zzz"
        return formatter.string(from: date)
    }

    /// "in 5 minutes", "in 2 hours", or a clock time for a later day.
    static func relative(_ date: Date, now: Date) -> String {
        let seconds = date.timeIntervalSince(now)
        if seconds < 90 { return "in a minute" }
        if seconds < 90 * 60 { return "in \(Int((seconds / 60).rounded())) minutes" }
        if seconds < 24 * 3600, Calendar.current.isDate(date, inSameDayAs: now) {
            return "at \(date.formatted(date: .omitted, time: .shortened))"
        }
        return "on \(date.formatted(.dateTime.weekday(.wide).hour().minute()))"
    }
}
