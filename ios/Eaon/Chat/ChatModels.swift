import Foundation

/// Where a model runs.
enum ModelSource: Codable, Hashable, Sendable {
    /// Apple's model on this iPhone.
    case onDevice
    /// Eaon on the Mac.
    case mac
    /// A provider the person added: OpenAI, OpenRouter, Ollama, anything that speaks the OpenAI API.
    case provider(UUID)
}

/// A model the person can pick.
struct ModelRef: Codable, Hashable, Sendable, Identifiable {
    var source: ModelSource
    /// What the API calls it.
    var id: String
    var name: String
    /// "OpenAI", "Your Mac"…
    var detail: String?

    static let onDevice = ModelRef(source: .onDevice, id: "apple.foundation", name: "Apple Intelligence", detail: "On this iPhone")
}

struct ChatMessage: Identifiable, Codable, Equatable, Sendable {
    enum Role: String, Codable, Sendable {
        case user
        case assistant
    }

    var id = UUID()
    var role: Role
    var text: String
    var date = Date()
    /// Set when the reply stopped on an error.
    var error: String?
    /// Pictures and documents sent with it. Optional, so conversations saved before there were any still load.
    var attachments: [MessageAttachment]?
}

struct Conversation: Identifiable, Codable, Equatable, Sendable {
    var id = UUID()
    var title: String
    var messages: [ChatMessage] = []
    var model: ModelRef?
    var updated = Date()

    static let untitled = "New chat"

    /// "Explain how tides work" → the title, cut at a word if it's long.
    static func title(from text: String) -> String {
        let line = text.split(whereSeparator: \.isNewline).first.map(String.init) ?? text
        let trimmed = line.trimmingCharacters(in: .whitespacesAndNewlines)
        guard trimmed.count > 44 else { return trimmed.isEmpty ? untitled : trimmed }
        let cut = trimmed.prefix(44)
        if let space = cut.lastIndex(of: " ") { return String(cut[..<space]) + "…" }
        return String(cut) + "…"
    }
}

/// Which part of the day it is, for the greeting.
enum DayPart {
    static func greeting(_ date: Date = Date(), calendar: Calendar = .current) -> String {
        switch calendar.component(.hour, from: date) {
        case 5..<12: "Good morning"
        case 12..<17: "Good afternoon"
        case 17..<22: "Good evening"
        default: "Hello"
        }
    }
}

extension String {
    /// One line of plain text from Markdown, for a preview: no emphasis marks, headings, list markers or fences.
    var markdownPreview: String {
        var lines: [String] = []
        for raw in split(whereSeparator: \.isNewline) {
            var line = raw.trimmingCharacters(in: .whitespaces)
            if line.hasPrefix("```") || line.isEmpty { continue }
            line = line.replacingOccurrences(of: "^(#{1,6}\\s+|[-*•>]\\s+|\\d+[.)]\\s+)", with: "", options: .regularExpression)
            line = line.replacingOccurrences(of: "[*_`]", with: "", options: .regularExpression)
            if !line.isEmpty { lines.append(line) }
        }
        return lines.joined(separator: " ")
    }
}
