import Foundation

/// The history, in the days it's shown by: Today, Yesterday, the week before, and the rest.
enum ConversationGroups {
    struct Section: Identifiable, Equatable {
        var title: String
        var conversations: [Conversation]
        var id: String { title }
    }

    /// Conversations whose title or any message contains `search` (if there is one), newest first within each day.
    static func group(_ conversations: [Conversation], search: String = "", now: Date = Date(), calendar: Calendar = .current) -> [Section] {
        let query = search.trimmingCharacters(in: .whitespaces)
        let matches = conversations.filter { conversation in
            query.isEmpty
                || conversation.title.localizedCaseInsensitiveContains(query)
                || conversation.messages.contains { $0.text.localizedCaseInsensitiveContains(query) }
        }
        var buckets: [(String, [Conversation])] = [("Today", []), ("Yesterday", []), ("Previous 7 days", []), ("Earlier", [])]
        let today = calendar.startOfDay(for: now)
        for conversation in matches.sorted(by: { $0.updated > $1.updated }) {
            let days = calendar.dateComponents([.day], from: calendar.startOfDay(for: conversation.updated), to: today).day ?? 0
            let index = days <= 0 ? 0 : days == 1 ? 1 : days <= 7 ? 2 : 3
            buckets[index].1.append(conversation)
        }
        return buckets.filter { !$0.1.isEmpty }.map { Section(title: $0.0, conversations: $0.1) }
    }
}
