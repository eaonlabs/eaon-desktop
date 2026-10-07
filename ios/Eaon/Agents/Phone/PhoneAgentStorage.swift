import Foundation

/// Where phone agents are kept. A protocol so tests can keep them in memory.
@MainActor
protocol PhoneAgentStorage: AnyObject {
    func loadRecords() -> [PhoneAgentRecord]
    func saveRecords(_ records: [PhoneAgentRecord])
    func loadThread(_ id: String) -> [AgentMessage]
    func saveThread(_ id: String, _ messages: [AgentMessage])
    func deleteThread(_ id: String)
    func flush()
}

/// JSON files in Application Support/Agents: `agents.json`, and `thread-<id>.json` for each conversation.
/// Writes are short-delayed and atomic, so a stream of tokens doesn't hit the disk per token.
@MainActor
final class FilePhoneAgentStorage: PhoneAgentStorage {
    private let directory: URL
    private var pendingRecords: [PhoneAgentRecord]?
    private var pendingThreads: [String: [AgentMessage]] = [:]
    private var timer: Task<Void, Never>?

    static var defaultDirectory: URL {
        let base = (try? FileManager.default.url(for: .applicationSupportDirectory, in: .userDomainMask, appropriateFor: nil, create: true))
            ?? FileManager.default.temporaryDirectory
        return base.appendingPathComponent("Agents", isDirectory: true)
    }

    init(directory: URL = FilePhoneAgentStorage.defaultDirectory) {
        self.directory = directory
        try? FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
    }

    private var recordsURL: URL { directory.appendingPathComponent("agents.json") }
    private func threadURL(_ id: String) -> URL { directory.appendingPathComponent("thread-\(Self.safe(id)).json") }

    /// Ids are made here, but the file name is still cleaned: nothing should reach outside the folder.
    private static func safe(_ id: String) -> String {
        String(id.unicodeScalars.filter { CharacterSet.alphanumerics.union(CharacterSet(charactersIn: "-_")).contains($0) })
    }

    func loadRecords() -> [PhoneAgentRecord] {
        let decoder = JSONDecoder()
        decoder.dateDecodingStrategy = .secondsSince1970
        return (try? Data(contentsOf: recordsURL)).flatMap { try? decoder.decode([PhoneAgentRecord].self, from: $0) } ?? []
    }

    func saveRecords(_ records: [PhoneAgentRecord]) {
        pendingRecords = records
        schedule()
    }

    func loadThread(_ id: String) -> [AgentMessage] {
        if let pending = pendingThreads[id] { return pending }
        let decoder = JSONDecoder()
        decoder.dateDecodingStrategy = .secondsSince1970
        return (try? Data(contentsOf: threadURL(id))).flatMap { try? decoder.decode([AgentMessage].self, from: $0) } ?? []
    }

    func saveThread(_ id: String, _ messages: [AgentMessage]) {
        pendingThreads[id] = messages
        schedule()
    }

    func deleteThread(_ id: String) {
        pendingThreads[id] = nil
        try? FileManager.default.removeItem(at: threadURL(id))
    }

    func flush() {
        timer?.cancel()
        write()
    }

    private func schedule() {
        timer?.cancel()
        timer = Task { [weak self] in
            try? await Task.sleep(for: .milliseconds(500))
            guard !Task.isCancelled else { return }
            self?.write()
        }
    }

    private func write() {
        let encoder = JSONEncoder()
        encoder.dateEncodingStrategy = .secondsSince1970
        let options: Data.WritingOptions = [.atomic, .completeFileProtectionUntilFirstUserAuthentication]
        if let records = pendingRecords, let data = try? encoder.encode(records) {
            try? data.write(to: recordsURL, options: options)
            pendingRecords = nil
        }
        for (id, messages) in pendingThreads {
            if let data = try? encoder.encode(messages) { try? data.write(to: threadURL(id), options: options) }
        }
        pendingThreads = [:]
    }
}

/// Keeps everything in memory, for tests.
@MainActor
final class MemoryPhoneAgentStorage: PhoneAgentStorage {
    var records: [PhoneAgentRecord] = []
    var threads: [String: [AgentMessage]] = [:]

    func loadRecords() -> [PhoneAgentRecord] { records }
    func saveRecords(_ records: [PhoneAgentRecord]) { self.records = records }
    func loadThread(_ id: String) -> [AgentMessage] { threads[id] ?? [] }
    func saveThread(_ id: String, _ messages: [AgentMessage]) { threads[id] = messages }
    func deleteThread(_ id: String) { threads[id] = nil }
    func flush() {}
}
