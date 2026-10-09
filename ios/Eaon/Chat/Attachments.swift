import Foundation
import PDFKit
import UIKit
import UniformTypeIdentifiers

/// A picture or a document attached to a message.
struct MessageAttachment: Codable, Equatable, Identifiable, Sendable {
    enum Kind: String, Codable, Sendable {
        case image
        case text
    }

    var id = UUID()
    var kind: Kind
    var name: String
    /// A picture's file, in Application Support/Attachments.
    var file: String?
    /// A document's text, as the model reads it.
    var text: String?
}

/// Where attached pictures are kept: files beside the conversations, so the conversations stay small.
enum AttachmentStore {
    /// Replaced by tests.
    nonisolated(unsafe) static var directoryOverride: URL?

    static var directory: URL {
        if let directoryOverride { return directoryOverride }
        let base = (try? FileManager.default.url(for: .applicationSupportDirectory, in: .userDomainMask, appropriateFor: nil, create: true))
            ?? FileManager.default.temporaryDirectory
        return base.appendingPathComponent("Attachments", isDirectory: true)
    }

    /// Saves a JPEG and returns its file name.
    static func save(jpeg: Data) -> String? {
        let name = UUID().uuidString + ".jpg"
        try? FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        do {
            try jpeg.write(to: directory.appendingPathComponent(name), options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication])
            return name
        } catch {
            return nil
        }
    }

    static func data(for file: String) -> Data? {
        // A file name only: nothing in a saved conversation may point outside the folder.
        guard file == (file as NSString).lastPathComponent else { return nil }
        return try? Data(contentsOf: directory.appendingPathComponent(file))
    }

    static func delete(_ attachments: [MessageAttachment]) {
        for file in attachments.compactMap(\.file) where file == (file as NSString).lastPathComponent {
            try? FileManager.default.removeItem(at: directory.appendingPathComponent(file))
        }
    }

    static func deleteAll() {
        try? FileManager.default.removeItem(at: directory)
    }
}

/// What is in the composer, before it is sent.
struct DraftAttachment: Identifiable, Equatable {
    var id = UUID()
    var kind: MessageAttachment.Kind
    var name: String
    var jpeg: Data?
    var thumbnail: UIImage?
    var text: String?

    static func == (lhs: DraftAttachment, rhs: DraftAttachment) -> Bool { lhs.id == rhs.id }
}

enum AttachmentError: LocalizedError, Equatable {
    case notAnImage
    case unreadable(String)
    case empty(String)

    var errorDescription: String? {
        switch self {
        case .notAnImage: "That doesn't look like a picture Eaon can use."
        case .unreadable(let name): "Eaon couldn't read “\(name)”. Text files, PDFs and pictures work."
        case .empty(let name): "“\(name)” has no text Eaon can read."
        }
    }
}

/// Turns what the person picked into something a model can be sent.
enum AttachmentLoader {
    static let maxImageSide: CGFloat = 1_600
    static let maxTextCharacters = 24_000
    static let maxImagesPerMessage = 4

    /// A picture, scaled down to at most 1,600 points a side and saved as JPEG: a phone photo is many megabytes and a model doesn't need them.
    static func draft(fromImage data: Data, name: String = "Photo") throws -> DraftAttachment {
        guard let image = UIImage(data: data), image.size.width > 0 else { throw AttachmentError.notAnImage }
        let fitted = scaled(image, maxSide: maxImageSide)
        guard let jpeg = fitted.jpegData(compressionQuality: 0.8) else { throw AttachmentError.notAnImage }
        return DraftAttachment(kind: .image, name: name, jpeg: jpeg, thumbnail: scaled(image, maxSide: 240))
    }

    /// A text file, a source file or a PDF, as text.
    static func draft(fromFile url: URL) throws -> DraftAttachment {
        let name = url.lastPathComponent
        let accessing = url.startAccessingSecurityScopedResource()
        defer { if accessing { url.stopAccessingSecurityScopedResource() } }
        let type = UTType(filenameExtension: url.pathExtension)
        if type?.conforms(to: .image) == true, let data = try? Data(contentsOf: url) {
            return try draft(fromImage: data, name: name)
        }
        var text: String
        if type?.conforms(to: .pdf) == true {
            guard let document = PDFDocument(url: url), let extracted = document.string else { throw AttachmentError.unreadable(name) }
            text = extracted
        } else {
            guard let data = try? Data(contentsOf: url) else { throw AttachmentError.unreadable(name) }
            guard let decoded = String(data: data, encoding: .utf8) ?? String(data: data, encoding: .isoLatin1), !decoded.contains("\u{0}") else {
                throw AttachmentError.unreadable(name)
            }
            text = decoded
        }
        return try draft(fromText: text, name: name)
    }

    static func draft(fromText text: String, name: String) throws -> DraftAttachment {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { throw AttachmentError.empty(name) }
        var kept = trimmed
        if kept.count > maxTextCharacters {
            kept = String(kept.prefix(maxTextCharacters)) + "\n[cut: \(trimmed.count - maxTextCharacters) more characters]"
        }
        return DraftAttachment(kind: .text, name: name, text: kept)
    }

    /// What goes into the conversation: pictures are written to files.
    static func commit(_ drafts: [DraftAttachment]) -> [MessageAttachment] {
        drafts.compactMap { draft in
            switch draft.kind {
            case .image:
                guard let jpeg = draft.jpeg, let file = AttachmentStore.save(jpeg: jpeg) else { return nil }
                return MessageAttachment(id: draft.id, kind: .image, name: draft.name, file: file)
            case .text:
                return MessageAttachment(id: draft.id, kind: .text, name: draft.name, text: draft.text)
            }
        }
    }

    static func scaled(_ image: UIImage, maxSide: CGFloat) -> UIImage {
        let longest = max(image.size.width, image.size.height)
        guard longest > maxSide else { return image }
        let ratio = maxSide / longest
        let size = CGSize(width: (image.size.width * ratio).rounded(), height: (image.size.height * ratio).rounded())
        let format = UIGraphicsImageRendererFormat()
        format.scale = 1
        return UIGraphicsImageRenderer(size: size, format: format).image { _ in image.draw(in: CGRect(origin: .zero, size: size)) }
    }
}
