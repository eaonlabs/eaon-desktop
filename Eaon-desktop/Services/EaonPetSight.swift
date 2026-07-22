import AppKit
import ScreenCaptureKit

/// The desktop pet's eyes on the actual screen. Deliberately NOT a separate
/// ask surface — asking about the screen happens through the Quick
/// Assistant, the same "one text box for the whole app" everything else
/// uses. This file supplies the two on-demand pieces that make that work:
///
/// 1. `captureScreenAttachment` — grabs a fresh screenshot and saves it as a
///    normal `MessageAttachment`, indistinguishable downstream from a pasted
///    or uploaded image, wired to the composer's "My screen" row.
/// 2. `locate` — a silent call (never shown in the transcript) asking
///    specifically where on the screenshot to point, so the pet can fly
///    over and show the answer instead of just describing it. Fired
///    CONCURRENTLY with the main reply (not after it), so the hand appears
///    as soon as this short lookup returns — often while the answer is
///    still streaming — instead of waiting out a second sequential round-
///    trip on top of the first.
///
/// One screenshot per question, never a standing feed: that's the honest
/// privacy story (backed by the OS's own Screen Recording permission) and
/// keeps cost at exactly one extra model call per screen-question, not a
/// continuous one.
@MainActor
enum EaonPetSight {
    /// Grabs the display `screen` is on — excluding the given windows, so
    /// the assistant/pet's own chrome never leaks into their own screenshot
    /// — and saves it via `AttachmentStore`. Downscaled to ~1.7K on the long
    /// side (plenty to read UI text) and JPEG'd to keep the payload small.
    static func captureScreenAttachment(
        on screen: NSScreen?,
        excludingWindowNumbers: [Int]
    ) async throws -> MessageAttachment {
        let content = try await SCShareableContent.excludingDesktopWindows(false, onScreenWindowsOnly: true)
        let screenNumber = (screen?.deviceDescription[NSDeviceDescriptionKey("NSScreenNumber")] as? NSNumber)?.uint32Value
        let display = content.displays.first { $0.displayID == screenNumber } ?? content.displays.first
        guard let display else {
            throw NSError(domain: "EaonPetSight", code: 1, userInfo: [NSLocalizedDescriptionKey: "No display available to capture."])
        }
        let excluded = content.windows.filter { excludingWindowNumbers.contains(Int($0.windowID)) }
        let filter = SCContentFilter(display: display, excludingWindows: excluded)

        let config = SCStreamConfiguration()
        let scale = min(1.0, 1720.0 / Double(max(display.width, display.height)))
        config.width = max(1, Int(Double(display.width) * scale))
        config.height = max(1, Int(Double(display.height) * scale))
        config.showsCursor = true // "what am I doing?" often IS the cursor

        let cgImage = try await SCScreenshotManager.captureImage(contentFilter: filter, configuration: config)
        let rep = NSBitmapImageRep(cgImage: cgImage)
        guard let jpeg = rep.representation(using: .jpeg, properties: [.compressionFactor: 0.65]) else {
            throw NSError(domain: "EaonPetSight", code: 2, userInfo: [NSLocalizedDescriptionKey: "Couldn't encode the screenshot."])
        }
        return try AttachmentStore.importImageData(jpeg, fileName: "Screen.jpg")
    }

    /// Given the screenshot and the user's question, asks specifically where
    /// the single best thing to point at is. Returns fractions of image
    /// width/height from the top-left, or nil if the model found nothing
    /// worth pointing at, can't see images, or the call fails outright —
    /// every one of which just means the pet stays put, never a visible
    /// error (the real answer reaches the user through the normal reply).
    ///
    /// Takes only the question + image, NOT the answer, so it can run in
    /// parallel with the main reply instead of waiting for it — the question
    /// alone is enough to find "the chat channel" or "the sign-in button".
    static func locate(question: String, image: HistoryImage, modelId: String) async -> CGPoint? {
        guard !modelId.isEmpty, ModelCatalog.supportsVision(for: modelId) else { return nil }
        let history = [
            HistoryTurn(role: "system", content: locateSystemPrompt),
            HistoryTurn(role: "user", content: "Question: \(question)", images: [image]),
        ]
        // Same three-way route resolution `QuickAssistantViewModel` uses —
        // passing all three is safe: `BackgroundCompletion` only takes the
        // first that actually applies (custom → local → Aqua), and at most
        // one of them genuinely matches any given modelId.
        guard let raw = await BackgroundCompletion.requestRaw(
            history: history,
            customConfig: CustomProviderStore.shared.config(owning: modelId),
            localRecord: LocalAIManager.shared.record(withId: modelId),
            aquaApiKey: EaonAccess.current?.apiKey,
            modelId: modelId
        ) else { return nil }
        return parseLocation(raw)
    }

    private static let locateSystemPrompt = """
    A user asked a question about the attached screenshot. Reply with ONLY \
    compact JSON, no prose, no markdown, identifying the single best UI \
    element to point at to answer them, as fractions of the image's width \
    and height measured from the top-left corner: {"x":0.42,"y":0.18}. If \
    nothing in the image is worth pointing at (the question wasn't about a \
    specific on-screen location), reply with exactly: {"found":false}
    """

    /// Tolerant of a reasoning model's `<think>` preamble and of any prose
    /// wrapped around the JSON — takes the first `{...}` span containing
    /// numeric x/y keys, clamped to the image.
    private static func parseLocation(_ raw: String) -> CGPoint? {
        var text = raw
        while let open = text.range(of: "<think>", options: .caseInsensitive) {
            if let close = text.range(of: "</think>", options: .caseInsensitive, range: open.upperBound..<text.endIndex) {
                text.removeSubrange(open.lowerBound..<close.upperBound)
            } else {
                text.removeSubrange(open.lowerBound..<text.endIndex)
            }
        }
        guard let openBrace = text.firstIndex(of: "{"), let closeBrace = text.lastIndex(of: "}"),
              openBrace < closeBrace else { return nil }
        guard let data = text[openBrace...closeBrace].data(using: .utf8),
              let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let x = json["x"] as? Double, let y = json["y"] as? Double else { return nil }
        return CGPoint(x: min(max(x, 0), 1), y: min(max(y, 0), 1))
    }
}
