import AppKit
import ScreenCaptureKit

/// One screenshot, on demand, as a normal attachment.
///
/// Deliberately NOT a separate ask surface — asking about the screen happens
/// through the Quick Assistant, the same "one text box for the whole app"
/// everything else uses. This just supplies the picture, saved as an ordinary
/// `MessageAttachment` that is indistinguishable downstream from a pasted or
/// uploaded image, wired to the composer's "My screen" row.
///
/// One screenshot per question, never a standing feed: that is the honest
/// privacy story (backed by the OS's own Screen Recording permission) and it
/// keeps the cost at exactly one image per screen-question rather than a
/// continuous capture.
@MainActor
enum ScreenCapture {
    /// Grabs the display `screen` is on — excluding the given windows, so the
    /// assistant's own chrome never leaks into its own screenshot — and saves
    /// it via `AttachmentStore`. Downscaled to ~1.7K on the long side (plenty
    /// to read UI text) and JPEG'd to keep the payload small.
    static func captureScreenAttachment(
        on screen: NSScreen?,
        excludingWindowNumbers: [Int]
    ) async throws -> MessageAttachment {
        let content = try await SCShareableContent.excludingDesktopWindows(false, onScreenWindowsOnly: true)
        let screenNumber = (screen?.deviceDescription[NSDeviceDescriptionKey("NSScreenNumber")] as? NSNumber)?.uint32Value
        let display = content.displays.first { $0.displayID == screenNumber } ?? content.displays.first
        guard let display else {
            throw NSError(domain: "ScreenCapture", code: 1, userInfo: [NSLocalizedDescriptionKey: "No display available to capture."])
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
            throw NSError(domain: "ScreenCapture", code: 2, userInfo: [NSLocalizedDescriptionKey: "Couldn't encode the screenshot."])
        }
        return try AttachmentStore.importImageData(jpeg, fileName: "Screen.jpg")
    }
}
