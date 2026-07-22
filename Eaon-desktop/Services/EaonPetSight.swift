import AppKit
import ScreenCaptureKit

/// The desktop pet's eyes on the actual screen: a one-shot ScreenCaptureKit
/// capture of the display the pet is on (excluding the pet's own windows),
/// sent to the user's current model with a question. Deliberately
/// on-demand — one fresh screenshot per question, never a standing video
/// feed: that's what a floating helper actually needs, it keeps cost at one
/// vision call per ask, and "looks when you ask" is an honest privacy story
/// (backed by the OS's own Screen Recording permission).
@MainActor
enum EaonPetSight {
    struct Answer {
        let text: String
        /// Where on the captured display to point, as fractions of image
        /// width/height from the top-left — present when the model was asked
        /// to find something and found it.
        let normalizedTarget: CGPoint?
    }

    struct Failure: Error {
        let message: String
        /// Setup problems (no permission, no vision model) get the sad face;
        /// real run failures get the error face.
        let isSetupProblem: Bool
    }

    static func answer(
        question: String,
        modelId: String,
        on screen: NSScreen?,
        excludingWindowNumbers: [Int]
    ) async -> Result<Answer, Failure> {
        guard !modelId.isEmpty else {
            return .failure(Failure(message: "Pick a model in Eaon first — I answer with whatever model you're using.", isSetupProblem: true))
        }
        guard ModelCatalog.supportsVision(for: modelId) else {
            return .failure(Failure(message: "My current model (\(modelId)) can't see images — switch to a vision-capable model and ask again.", isSetupProblem: true))
        }
        guard CGPreflightScreenCaptureAccess() else {
            // Fires the system prompt the first time; after that the user
            // has to flip the switch themselves, so say exactly where.
            CGRequestScreenCaptureAccess()
            return .failure(Failure(
                message: "I can't see your screen yet — allow Eaon under System Settings → Privacy & Security → Screen Recording, then ask me again.",
                isSetupProblem: true
            ))
        }

        let screenshot: HistoryImage
        do {
            screenshot = try await capture(on: screen, excludingWindowNumbers: excludingWindowNumbers)
        } catch {
            return .failure(Failure(message: "Couldn't capture the screen: \(error.localizedDescription)", isSetupProblem: false))
        }

        let history = [
            HistoryTurn(role: "system", content: Self.systemPrompt),
            HistoryTurn(role: "user", content: question, images: [screenshot]),
        ]
        guard let raw = await complete(history: history, modelId: modelId) else {
            return .failure(Failure(message: "I couldn't reach the model — check your connection or provider key and try again.", isSetupProblem: false))
        }
        return .success(parse(raw))
    }

    // MARK: - Capture

    private static func capture(
        on screen: NSScreen?,
        excludingWindowNumbers: [Int]
    ) async throws -> HistoryImage {
        let content = try await SCShareableContent.excludingDesktopWindows(false, onScreenWindowsOnly: true)
        let screenNumber = (screen?.deviceDescription[NSDeviceDescriptionKey("NSScreenNumber")] as? NSNumber)?.uint32Value
        let display = content.displays.first { $0.displayID == screenNumber }
            ?? content.displays.first
        guard let display else {
            throw NSError(domain: "EaonPetSight", code: 1, userInfo: [NSLocalizedDescriptionKey: "No display available to capture."])
        }
        let excluded = content.windows.filter { excludingWindowNumbers.contains(Int($0.windowID)) }
        let filter = SCContentFilter(display: display, excludingWindows: excluded)

        // Downscale to keep the vision payload sane (~1.7K on the long
        // side is plenty for UI reading) and include the cursor — "what am
        // I doing?" often IS the cursor.
        let config = SCStreamConfiguration()
        let scale = min(1.0, 1720.0 / Double(max(display.width, display.height)))
        config.width = max(1, Int(Double(display.width) * scale))
        config.height = max(1, Int(Double(display.height) * scale))
        config.showsCursor = true

        let cgImage = try await SCScreenshotManager.captureImage(contentFilter: filter, configuration: config)
        let rep = NSBitmapImageRep(cgImage: cgImage)
        guard let jpeg = rep.representation(using: .jpeg, properties: [.compressionFactor: 0.6]) else {
            throw NSError(domain: "EaonPetSight", code: 2, userInfo: [NSLocalizedDescriptionKey: "Couldn't encode the screenshot."])
        }
        return HistoryImage(base64: jpeg.base64EncodedString(), mimeType: "image/jpeg")
    }

    // MARK: - Model call

    private static let systemPrompt = """
    You are Eaon's tiny desktop companion, looking at a screenshot of the \
    user's screen taken right now. Answer their question about what's on \
    screen briefly and concretely — at most 2 short sentences, plain text, \
    no markdown. If they ask where something is, how to do something on this \
    screen, or to find/click/show something, ALSO end your reply with a new \
    line in exactly this form: LOCATE {"x":0.42,"y":0.18} — x and y are the \
    CENTER of the single best thing to point at, as fractions of image width \
    and height measured from the top-left corner. If there is nothing \
    relevant to point at, end with: LOCATE null
    """

    /// Same three-way route the Quick Assistant resolves (BYOK config →
    /// local model → Eaon key/trial), collapsed to the one OpenAI-compatible
    /// wire format all of them speak — including image parts.
    private static func complete(history: [HistoryTurn], modelId: String) async -> String? {
        var history = history
        var collected = ""
        let typewriter = TypewriterStreamController(instant: true) { collected = $0 }

        let config: CustomProviderConfig
        let apiKey: String
        var requestModelId = modelId
        if let owned = CustomProviderStore.shared.config(owning: modelId),
           let key = CustomProviderStore.shared.apiKey(for: owned.id), !key.isEmpty {
            config = owned
            apiKey = key
        } else if let record = LocalAIManager.shared.record(withId: modelId) {
            guard let baseURL = try? await LocalAIManager.shared.ensureReady(for: record) else { return nil }
            history = history.flattenedForStrictChatTemplates
            config = CustomProviderConfig(
                brand: ModelCatalog.brand(for: record.requestModelId),
                baseURL: baseURL.absoluteString,
                format: .openAICompatible,
                modelIDs: [record.requestModelId]
            )
            apiKey = "local-no-key"
            requestModelId = record.requestModelId
        } else if let access = EaonAccess.current {
            config = CustomProviderConfig(
                brand: ModelCatalog.brand(for: modelId),
                baseURL: access.baseURL.absoluteString,
                format: .openAICompatible,
                modelIDs: [modelId]
            )
            apiKey = access.apiKey
        } else {
            return nil
        }

        do {
            try await CustomProviderAPIService().streamCompletion(
                config: config, apiKey: apiKey, modelId: requestModelId,
                history: history, typewriter: typewriter
            )
        } catch {
            return nil
        }
        await typewriter.waitUntilCaughtUp()
        return collected.isEmpty ? nil : collected
    }

    // MARK: - Parsing

    /// Splits the LOCATE line off the reply. Tolerant: the tag can be
    /// anywhere in the last lines, `LOCATE null` (or no tag) means "nothing
    /// to point at", junk coordinates are clamped to the image.
    private static func parse(_ raw: String) -> Answer {
        var target: CGPoint?
        var kept: [String] = []
        // LOCATE is scanned over the FULL raw reply (reasoning models
        // sometimes tuck it inside their think block); the think spans are
        // stripped from the displayed text only, afterwards.
        for line in raw.components(separatedBy: .newlines) {
            let trimmed = line.trimmingCharacters(in: .whitespaces)
            guard let range = trimmed.range(of: "LOCATE") else {
                kept.append(line)
                continue
            }
            let payload = trimmed[range.upperBound...].trimmingCharacters(in: .whitespaces)
            if let data = payload.data(using: .utf8),
               let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
               let x = json["x"] as? Double, let y = json["y"] as? Double {
                target = CGPoint(x: min(max(x, 0), 1), y: min(max(y, 0), 1))
            }
            // "LOCATE null" (or unparsable payload) drops the line, keeps no target.
        }
        let text = strippingThink(kept.joined(separator: "\n"))
            .trimmingCharacters(in: .whitespacesAndNewlines)
        return Answer(text: text.isEmpty ? "Here — this is what you're after." : text, normalizedTarget: target)
    }

    /// Reasoning models (grok, DeepSeek-R1 family, …) prefix replies with
    /// `<think>…</think>` blocks. The chat UI folds those into its own
    /// "Thinking" disclosure; the pet's bubble just wants the answer —
    /// verified live: the first on-screen ask rendered the model's whole
    /// think block into the speech bubble. Closed spans are removed; an
    /// unclosed opener drops everything from it on (the model was still
    /// thinking when the stream ended — there's no answer inside to show).
    private static func strippingThink(_ text: String) -> String {
        var result = text
        while let open = result.range(of: "<think>", options: .caseInsensitive) {
            if let close = result.range(of: "</think>", options: .caseInsensitive,
                                        range: open.upperBound..<result.endIndex) {
                result.removeSubrange(open.lowerBound..<close.upperBound)
            } else {
                result.removeSubrange(open.lowerBound..<result.endIndex)
            }
        }
        return result
    }
}
