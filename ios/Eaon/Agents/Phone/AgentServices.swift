import EventKit
import Foundation

/// The outside world an agent's tools reach, behind protocols so tests can fake it.
@MainActor
struct AgentServices {
    var web: any WebFetching = WebFetcher()
    var calendar: any CalendarService = EventKitService()
}

// MARK: - The web

protocol WebFetching: Sendable {
    func fetch(_ url: URL) async throws -> String
}

/// Which hosts an agent may not open. A page that tells an agent to fetch
/// something on the person's own network is how an agent gets turned against
/// a router or a printer, so anything private, local or unusual is refused.
enum NetGuard {
    static func isPrivate(host rawHost: String) -> Bool {
        let host = rawHost.lowercased().trimmingCharacters(in: CharacterSet(charactersIn: "[]."))
        if host.isEmpty || host == "localhost" { return true }
        if host.hasSuffix(".local") || host.hasSuffix(".localhost") || host.hasSuffix(".internal") || host.hasSuffix(".lan") || host.hasSuffix(".home") { return true }
        // A bare name ("router", "nas") is on the local network.
        if !host.contains(".") && !host.contains(":") { return true }
        if host.contains(":") { return isPrivateIPv6(host) }
        // Numbers and dots: a proper dotted quad is checked; anything else (2130706433, 0x7f.1, 127.1) is odd enough to refuse.
        if host.allSatisfy({ $0.isNumber || $0 == "." || $0 == "x" || ("a"..."f").contains($0) }) && host.contains(where: \.isNumber) {
            let octets = host.split(separator: ".", omittingEmptySubsequences: false).compactMap { Int($0) }
            guard octets.count == 4, host.split(separator: ".").count == 4, octets.allSatisfy({ (0...255).contains($0) }) else { return true }
            return isPrivateIPv4(octets)
        }
        return false
    }

    private static func isPrivateIPv4(_ o: [Int]) -> Bool {
        switch (o[0], o[1]) {
        case (10, _), (127, _), (0, _): true
        case (169, 254): true
        case (172, 16...31): true
        case (192, 168): true
        // Carrier-grade NAT, which is also what Tailscale uses.
        case (100, 64...127): true
        case (224..., _): true
        default: false
        }
    }

    private static func isPrivateIPv6(_ host: String) -> Bool {
        if host == "::1" || host == "::" { return true }
        if host.hasPrefix("fc") || host.hasPrefix("fd") || host.hasPrefix("fe8") || host.hasPrefix("fe9") || host.hasPrefix("fea") || host.hasPrefix("feb") { return true }
        // ::ffff:127.0.0.1
        if host.hasPrefix("::ffff:") { return isPrivate(host: String(host.dropFirst(7))) }
        return false
    }
}

/// Refuses a redirect to somewhere private: the first address may be fine and the second not.
final class RedirectGuard: NSObject, URLSessionTaskDelegate, @unchecked Sendable {
    func urlSession(
        _ session: URLSession,
        task: URLSessionTask,
        willPerformHTTPRedirection response: HTTPURLResponse,
        newRequest request: URLRequest,
        completionHandler: @escaping (URLRequest?) -> Void
    ) {
        guard let url = request.url, ["http", "https"].contains(url.scheme?.lowercased()), !NetGuard.isPrivate(host: url.host() ?? "") else {
            completionHandler(nil)
            return
        }
        completionHandler(request)
    }
}

/// Reads a page as text.
struct WebFetcher: WebFetching, @unchecked Sendable {
    static let maxBytes = 1_500_000
    static let maxCharacters = 6_000

    /// Replaced by tests, to answer from a stub instead of the network.
    var configuration: URLSessionConfiguration = .ephemeral

    func fetch(_ url: URL) async throws -> String {
        guard let scheme = url.scheme?.lowercased(), ["http", "https"].contains(scheme), let host = url.host() else {
            throw ToolRefusal(message: "That isn't a web address. Give a full address starting with https://.")
        }
        guard !NetGuard.isPrivate(host: host) else {
            throw ToolRefusal(message: "Eaon doesn't let agents open addresses on this iPhone's own network.")
        }
        let session = URLSession(configuration: configuration, delegate: RedirectGuard(), delegateQueue: nil)
        defer { session.finishTasksAndInvalidate() }
        var request = URLRequest(url: url, timeoutInterval: 15)
        request.setValue("Mozilla/5.0 (iPhone; Eaon) AppleWebKit/605.1.15", forHTTPHeaderField: "User-Agent")
        request.setValue("text/html,text/plain,application/json;q=0.9,*/*;q=0.5", forHTTPHeaderField: "Accept")

        let (bytes, response): (URLSession.AsyncBytes, URLResponse)
        do {
            (bytes, response) = try await session.bytes(for: request)
        } catch let error as URLError where error.code == .cancelled || error.code == .httpTooManyRedirects {
            throw ToolRefusal(message: "That address redirected somewhere Eaon won't open.")
        } catch let error as URLError {
            throw ToolRefusal(message: "Couldn't reach \(host): \(error.localizedDescription)")
        }
        guard let http = response as? HTTPURLResponse else { throw ToolRefusal(message: "That wasn't a web page.") }
        guard (200..<300).contains(http.statusCode) else { throw ToolRefusal(message: "\(host) answered \(http.statusCode).") }
        let type = (http.value(forHTTPHeaderField: "Content-Type") ?? "").lowercased()
        guard type.isEmpty || type.contains("text") || type.contains("json") || type.contains("xml") || type.contains("html") else {
            throw ToolRefusal(message: "That's \(type), not something Eaon can read as text.")
        }

        var data = Data()
        for try await byte in bytes {
            data.append(byte)
            if data.count >= Self.maxBytes { break }
        }
        let body = String(decoding: data, as: UTF8.self)
        if type.contains("html") || body.lowercased().contains("<html") {
            let page = HTMLText.convert(body)
            return Self.limit((page.title.map { "# \($0)\n" } ?? "") + page.text, from: url)
        }
        return Self.limit(body, from: url)
    }

    private static func limit(_ text: String, from url: URL) -> String {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        if trimmed.isEmpty { return "(The page has no text Eaon can read.)" }
        if trimmed.count <= maxCharacters { return "\(url.absoluteString)\n\n\(trimmed)" }
        return "\(url.absoluteString)\n\n\(trimmed.prefix(maxCharacters))\n[cut: \(trimmed.count - maxCharacters) more characters]"
    }
}

/// HTML to readable text, without a browser.
enum HTMLText {
    static func convert(_ html: String) -> (title: String?, text: String) {
        let title = firstMatch(in: html, pattern: "<title[^>]*>(.*?)</title>").map { decode(strip($0)) }.flatMap { $0.isEmpty ? nil : $0 }
        var body = html
        // Whole elements that are never text.
        for tag in ["script", "style", "noscript", "svg", "head", "template", "iframe"] {
            body = body.replacingOccurrences(of: "<\(tag)\\b[^>]*>.*?</\(tag)>", with: " ", options: [.regularExpression, .caseInsensitive])
        }
        body = body.replacingOccurrences(of: "<!--.*?-->", with: " ", options: [.regularExpression])
        // Where a line should break.
        body = body.replacingOccurrences(of: "<\\s*(br|/p|/div|/li|/tr|/h[1-6]|/section|/article|/ul|/ol|/table|hr)\\b[^>]*>", with: "\n", options: [.regularExpression, .caseInsensitive])
        body = body.replacingOccurrences(of: "<\\s*(li)\\b[^>]*>", with: "\n- ", options: [.regularExpression, .caseInsensitive])
        body = strip(body)
        body = decode(body)
        let lines = body.split(whereSeparator: \.isNewline).map { $0.split(whereSeparator: { $0 == " " || $0 == "\t" }).joined(separator: " ") }.filter { !$0.isEmpty }
        return (title, lines.joined(separator: "\n"))
    }

    private static func strip(_ text: String) -> String {
        text.replacingOccurrences(of: "<[^>]+>", with: " ", options: .regularExpression)
    }

    private static func firstMatch(in text: String, pattern: String) -> String? {
        guard let regex = try? NSRegularExpression(pattern: pattern, options: [.caseInsensitive, .dotMatchesLineSeparators]),
              let match = regex.firstMatch(in: text, range: NSRange(text.startIndex..., in: text)),
              match.numberOfRanges > 1, let range = Range(match.range(at: 1), in: text) else { return nil }
        return String(text[range])
    }

    private static let entities: [String: String] = [
        "&amp;": "&", "&lt;": "<", "&gt;": ">", "&quot;": "\"", "&#39;": "'", "&apos;": "'", "&nbsp;": " ",
        "&ndash;": "–", "&mdash;": "—", "&hellip;": "…", "&rsquo;": "’", "&lsquo;": "‘", "&ldquo;": "“", "&rdquo;": "”", "&copy;": "©"
    ]

    static func decode(_ text: String) -> String {
        var result = text
        for (entity, replacement) in entities { result = result.replacingOccurrences(of: entity, with: replacement) }
        // &#1234; and &#x1F600;
        let pattern = try? NSRegularExpression(pattern: "&#(x?)([0-9a-fA-F]+);")
        let matches = pattern?.matches(in: result, range: NSRange(result.startIndex..., in: result)) ?? []
        for match in matches.reversed() {
            guard let whole = Range(match.range, in: result), let hex = Range(match.range(at: 1), in: result), let digits = Range(match.range(at: 2), in: result),
                  let code = UInt32(result[digits], radix: result[hex].isEmpty ? 10 : 16), let scalar = Unicode.Scalar(code) else { continue }
            result.replaceSubrange(whole, with: String(Character(scalar)))
        }
        return result
    }
}

// MARK: - Calendar and reminders

struct CalendarItem: Equatable, Sendable {
    var title: String
    var start: Date
    var end: Date
    var allDay: Bool
    var location: String?
}

struct ReminderItem: Equatable, Sendable {
    var title: String
    var due: Date?
}

@MainActor
protocol CalendarService: AnyObject {
    func upcomingEvents(days: Int) async throws -> [CalendarItem]
    func addEvent(title: String, start: Date, minutes: Int, notes: String?) async throws -> String
    func openReminders() async throws -> [ReminderItem]
    func addReminder(title: String, due: Date?) async throws -> String
}

/// The person's calendar and reminders, through EventKit. iOS asks for permission the first time.
@MainActor
final class EventKitService: CalendarService {
    private let store = EKEventStore()

    func upcomingEvents(days: Int) async throws -> [CalendarItem] {
        try await requireEventAccess()
        let start = Date()
        let end = Calendar.current.date(byAdding: .day, value: max(1, min(days, 31)), to: start) ?? start.addingTimeInterval(86_400)
        let events = store.events(matching: store.predicateForEvents(withStart: start, end: end, calendars: nil))
        return events.sorted { $0.startDate < $1.startDate }.prefix(40).map {
            CalendarItem(title: $0.title ?? "Untitled", start: $0.startDate, end: $0.endDate, allDay: $0.isAllDay, location: $0.location)
        }
    }

    func addEvent(title: String, start: Date, minutes: Int, notes: String?) async throws -> String {
        try await requireEventAccess()
        guard let calendar = store.defaultCalendarForNewEvents else { throw ToolRefusal(message: "There's no calendar to add events to.") }
        let event = EKEvent(eventStore: store)
        event.title = title
        event.startDate = start
        event.endDate = start.addingTimeInterval(Double(max(minutes, 5)) * 60)
        event.notes = notes
        event.calendar = calendar
        try store.save(event, span: .thisEvent)
        return "Added “\(title)” to \(calendar.title) on \(start.formatted(date: .abbreviated, time: .shortened))."
    }

    func openReminders() async throws -> [ReminderItem] {
        try await requireReminderAccess()
        let predicate = store.predicateForIncompleteReminders(withDueDateStarting: nil, ending: nil, calendars: nil)
        return await withCheckedContinuation { continuation in
            store.fetchReminders(matching: predicate) { reminders in
                let items = (reminders ?? []).prefix(40).map { reminder in
                    ReminderItem(title: reminder.title ?? "Untitled", due: reminder.dueDateComponents?.date)
                }
                continuation.resume(returning: Array(items))
            }
        }
    }

    func addReminder(title: String, due: Date?) async throws -> String {
        try await requireReminderAccess()
        guard let list = store.defaultCalendarForNewReminders() else { throw ToolRefusal(message: "There's no reminders list to add to.") }
        let reminder = EKReminder(eventStore: store)
        reminder.title = title
        reminder.calendar = list
        if let due {
            reminder.dueDateComponents = Calendar.current.dateComponents([.year, .month, .day, .hour, .minute], from: due)
            reminder.addAlarm(EKAlarm(absoluteDate: due))
        }
        try store.save(reminder, commit: true)
        return "Added the reminder “\(title)”\(due.map { " for \($0.formatted(date: .abbreviated, time: .shortened))" } ?? "")."
    }

    private func requireEventAccess() async throws {
        let granted = (try? await store.requestFullAccessToEvents()) ?? false
        guard granted else { throw ToolRefusal(message: "Eaon doesn't have access to the calendar. The person can allow it in Settings › Privacy › Calendars.") }
    }

    private func requireReminderAccess() async throws {
        let granted = (try? await store.requestFullAccessToReminders()) ?? false
        guard granted else { throw ToolRefusal(message: "Eaon doesn't have access to Reminders. The person can allow it in Settings › Privacy › Reminders.") }
    }
}
