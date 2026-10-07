import Foundation
import Observation

/// The chats on this iPhone, kept in one JSON file in Application Support.
/// They belong to the device, not to an account: signing out leaves them be.
@MainActor
@Observable
final class ChatStore {
    private(set) var conversations: [Conversation] = []

    @ObservationIgnored private let url: URL
    @ObservationIgnored private var pendingSave: Task<Void, Never>?

    static var defaultURL: URL {
        let base = (try? FileManager.default.url(for: .applicationSupportDirectory, in: .userDomainMask, appropriateFor: nil, create: true))
            ?? FileManager.default.temporaryDirectory
        return base.appendingPathComponent("conversations.json")
    }

    init(url: URL = ChatStore.defaultURL) {
        self.url = url
        if let data = try? Data(contentsOf: url),
           let saved = try? JSONDecoder().decode([Conversation].self, from: data) {
            conversations = saved.sorted { $0.updated > $1.updated }
        }
    }

    func conversation(_ id: UUID) -> Conversation? {
        conversations.first { $0.id == id }
    }

    /// Saves a conversation, newest first. Empty ones aren't kept.
    func upsert(_ conversation: Conversation) {
        guard !conversation.messages.isEmpty else { return }
        var conversation = conversation
        conversation.updated = Date()
        if let index = conversations.firstIndex(where: { $0.id == conversation.id }) {
            conversations.remove(at: index)
        }
        conversations.insert(conversation, at: 0)
        scheduleSave()
    }

    func rename(_ id: UUID, to title: String) {
        let title = title.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !title.isEmpty, let index = conversations.firstIndex(where: { $0.id == id }) else { return }
        conversations[index].title = title
        scheduleSave()
    }

    func delete(_ id: UUID) {
        if let conversation = conversation(id) { AttachmentStore.delete(conversation.messages.flatMap { $0.attachments ?? [] }) }
        conversations.removeAll { $0.id == id }
        scheduleSave()
    }

    func deleteAll() {
        AttachmentStore.deleteAll()
        conversations = []
        scheduleSave()
    }

    /// Writes now. Called as the app goes to the background.
    func flush() {
        pendingSave?.cancel()
        write()
    }

    private func scheduleSave() {
        pendingSave?.cancel()
        pendingSave = Task { [weak self] in
            try? await Task.sleep(for: .milliseconds(400))
            guard !Task.isCancelled else { return }
            self?.write()
        }
    }

    private func write() {
        guard let data = try? JSONEncoder().encode(conversations) else { return }
        try? data.write(to: url, options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication])
    }
}
