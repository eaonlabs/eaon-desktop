import Foundation
import Observation

/// The conversation on the screen: sending, streaming the reply in, stopping,
/// and trying again. Saves to `ChatStore` as it goes, unless it is a temporary chat.
@MainActor
@Observable
final class ChatController {
    private(set) var current = Conversation(title: Conversation.untitled)
    private(set) var isStreaming = false
    /// A chat that is never saved: it isn't in the history and goes when you start another.
    private(set) var isTemporary = false
    /// What's in the composer.
    var draft = ""
    var attachments: [DraftAttachment] = []
    /// Something to tell the person about what they just tried, above the composer.
    var notice: String?

    @ObservationIgnored private let store: ChatStore
    @ObservationIgnored private let catalog: ModelCatalog
    @ObservationIgnored private var streamTask: Task<Void, Never>?
    /// Bumped whenever a reply starts or is stopped, so a late piece of a stopped reply is ignored.
    @ObservationIgnored private var generation = 0

    /// How much attached document text goes with a request, newest first.
    static let attachedTextBudget = 60_000
    /// How many of the latest messages with pictures keep them in the request.
    static let messagesWithPictures = 3

    init(store: ChatStore, catalog: ModelCatalog) {
        self.store = store
        self.catalog = catalog
    }

    var messages: [ChatMessage] { current.messages }
    var isEmpty: Bool { current.messages.isEmpty }
    var activeModel: ModelRef? { catalog.activeModel }

    var hasContent: Bool {
        !draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || !attachments.isEmpty
    }

    var canSend: Bool {
        !isStreaming && catalog.activeModel != nil && hasContent
    }

    // MARK: Which conversation

    func newChat() {
        stop()
        current = Conversation(title: Conversation.untitled)
        isTemporary = false
        draft = ""
        attachments = []
        notice = nil
    }

    /// A fresh chat that won't be kept.
    func startTemporary() {
        newChat()
        isTemporary = true
    }

    func open(_ conversation: Conversation) {
        stop()
        current = conversation
        isTemporary = false
        draft = ""
        attachments = []
        notice = nil
    }

    /// Called when a conversation is deleted from the history.
    func forget(_ id: UUID) {
        if current.id == id && !isTemporary { newChat() }
    }

    // MARK: Attaching

    func attach(_ draft: DraftAttachment) {
        let pictures = attachments.filter { $0.kind == .image }.count
        if draft.kind == .image, pictures >= AttachmentLoader.maxImagesPerMessage {
            notice = "Up to \(AttachmentLoader.maxImagesPerMessage) pictures in one message."
            return
        }
        attachments.append(draft)
        notice = nil
    }

    func removeAttachment(_ id: UUID) {
        attachments.removeAll { $0.id == id }
    }

    // MARK: Sending

    func send(_ text: String? = nil) {
        let text = (text ?? draft).trimmingCharacters(in: .whitespacesAndNewlines)
        guard (!text.isEmpty || !attachments.isEmpty), !isStreaming else { return }
        guard let model = catalog.activeModel, let backend = catalog.backend(for: model) else { return }
        if model.source == .onDevice, attachments.contains(where: { $0.kind == .image }) {
            notice = "Apple's model on this iPhone can't look at pictures. Choose another model for this one."
            return
        }

        let sent = AttachmentLoader.commit(attachments)
        draft = ""
        attachments = []
        notice = nil
        if current.messages.isEmpty {
            current.title = Conversation.title(from: text.isEmpty ? (sent.first?.name ?? "") : text)
        }
        current.model = model
        var message = ChatMessage(role: .user, text: text)
        if !sent.isEmpty { message.attachments = sent }
        current.messages.append(message)
        current.messages.append(ChatMessage(role: .assistant, text: ""))
        save()
        reply(using: backend)
    }

    /// Asks again for the last reply, or for the one that failed.
    func regenerate() {
        guard !isStreaming, let model = catalog.activeModel, let backend = catalog.backend(for: model),
              let last = current.messages.last, last.role == .assistant else { return }
        current.messages.removeLast()
        current.model = model
        current.messages.append(ChatMessage(role: .assistant, text: ""))
        save()
        reply(using: backend)
    }

    func stop() {
        guard isStreaming else { return }
        // Whatever the stream says from here on is for a reply nobody is waiting for.
        generation += 1
        streamTask?.cancel()
        finalize()
    }

    private func save() {
        if !isTemporary { store.upsert(current) }
    }

    // MARK: What the model is sent

    /// The conversation as a model reads it: documents are part of their message's text, and the latest few
    /// pictures go as pictures. (Documents are cut from the oldest, if there are too many.)
    func requestMessages() -> [BackendMessage] {
        var budget = Self.attachedTextBudget
        var sentPictures = 0
        var converted: [BackendMessage] = []
        for message in current.messages.dropLast().reversed() {
            var content = message.text
            var images: [Data] = []
            for attachment in message.attachments ?? [] {
                switch attachment.kind {
                case .text:
                    guard let text = attachment.text, budget > 0 else { continue }
                    let part = String(text.prefix(budget))
                    budget -= part.count
                    content += (content.isEmpty ? "" : "\n\n") + "[Attached file: \(attachment.name)]\n\(part)"
                case .image:
                    if sentPictures < Self.messagesWithPictures, let file = attachment.file, let data = AttachmentStore.data(for: file) {
                        images.append(data)
                    } else {
                        // Too far back to send again: the model is told there was one.
                        content += (content.isEmpty ? "" : "\n\n") + "[Picture: \(attachment.name)]"
                    }
                }
            }
            if !images.isEmpty { sentPictures += 1 }
            if content.isEmpty && images.isEmpty { continue }
            converted.append(BackendMessage(role: message.role.rawValue, content: content, images: images))
        }
        return [BackendMessage(role: "system", content: Assistant.instructions)] + converted.reversed()
    }

    // MARK: Streaming

    private func reply(using backend: any ChatBackend) {
        let history = requestMessages()
        let replyID = current.messages[current.messages.count - 1].id
        generation += 1
        let generation = generation
        isStreaming = true

        streamTask = Task { [weak self] in
            var pending = ""
            var lastFlush = ContinuousClock.now
            do {
                for try await piece in backend.stream(history) {
                    pending += piece
                    // The screen needn't hear about every token.
                    if ContinuousClock.now - lastFlush > .milliseconds(45) {
                        self?.append(pending, to: replyID, generation: generation)
                        pending = ""
                        lastFlush = .now
                    }
                }
                self?.append(pending, to: replyID, generation: generation)
            } catch {
                self?.append(pending, to: replyID, generation: generation)
                if !(error is CancellationError) { self?.fail(replyID, generation: generation, with: error) }
            }
            self?.finish(generation: generation)
        }
    }

    private func append(_ text: String, to id: UUID, generation: Int) {
        guard !text.isEmpty, generation == self.generation,
              let index = current.messages.lastIndex(where: { $0.id == id }) else { return }
        current.messages[index].text += text
    }

    private func fail(_ id: UUID, generation: Int, with error: Error) {
        guard generation == self.generation, let index = current.messages.lastIndex(where: { $0.id == id }) else { return }
        var message = (error as? LocalizedError)?.errorDescription ?? error.localizedDescription
        if let recovery = (error as? BackendError)?.recovery { message += " " + recovery }
        current.messages[index].error = message
    }

    private func finish(generation: Int) {
        guard generation == self.generation else { return }
        finalize()
    }

    private func finalize() {
        isStreaming = false
        streamTask = nil
        // An answer that never started leaves an empty bubble. Drop it unless it carries the error.
        if let last = current.messages.last, last.role == .assistant, last.text.isEmpty, last.error == nil {
            current.messages.removeLast()
        }
        save()
    }
}
