import AppKit
import Foundation

/// The engine behind the floating desktop assistant (the Gemini-style
/// "Ask Eaon" pill — see `DesktopAssistant.swift` for the window itself).
///
/// Deliberately a small, separate view model rather than a second window
/// onto `ChatViewModel`: the quick panel is a scratchpad — one lightweight
/// conversation, no tools, no skills, no workspace, not saved into the
/// sidebar unless the user explicitly hands it off to the main window. What
/// it does share with the main app is everything that matters for parity:
/// the same persisted model selection, the same BYOK → local → Aqua routing
/// precedence, the same custom instructions, the same sampling parameters,
/// the same attachment/vision pipeline, and the same
/// `CustomProviderAPIService` wire code (every route here is
/// OpenAI-compatible — BYOK configs directly, local servers via
/// `ensureReady` + an ephemeral config exactly like
/// `ChatViewModel.streamLocalCompletion`, and Aqua via an ephemeral config
/// pointing at the same gateway URL + Bearer key its dedicated path uses).
@MainActor
@Observable
final class QuickAssistantViewModel {
    static let shared = QuickAssistantViewModel()

    struct QuickTurn: Identifiable, Equatable {
        let id = UUID()
        var text: String
        let isUser: Bool
        var isError = false
        var attachments: [MessageAttachment] = []
    }

    var transcript: [QuickTurn] = []
    var inputText = ""
    var isStreaming = false
    /// Pill (false) vs. full chat panel (true). Mutated only by
    /// `DesktopAssistantController.setExpanded`, which also animates the
    /// window frame to match — the two must change together.
    var isExpanded = false
    /// Attachments queued for the *next* send — mirrors
    /// `ChatViewModel.pendingAttachments`. Picking or pasting one force-
    /// expands the panel (there's no room to preview a thumbnail in a 60pt
    /// pill), handled by the view via `DesktopAssistantController`.
    var pendingAttachments: [MessageAttachment] = []
    /// One-shot, auto-clearing feedback for an attachment action that
    /// didn't work (no image on the clipboard, a bad file) — mirrors
    /// `ChatViewModel.composerNotice` so a failed paste doesn't just do
    /// nothing with no explanation.
    var composerNotice: String?

    /// Set once, from `RootView`, to the app's single real `ChatViewModel`
    /// instance — gives the quick panel the exact same live model list,
    /// selection, and `selectModel(_:)` (persistence + Ollama warm-up +
    /// context-limit refresh) the main window uses, with no duplicated
    /// fetching or state of its own. `ModelPickerPopoverContent` (reused
    /// directly from `ModelPickerPopover.swift`) reads this straight.
    var chatViewModel: ChatViewModel?

    private var task: Task<Void, Never>?
    private var activeTypewriter: TypewriterStreamController?
    /// Set by `attachScreenCapture()`, consumed by `send()` — marks the
    /// queued attachment as a LIVE screen grab (not a paste or file) and
    /// remembers which physical screen it came from, which is what makes a
    /// "fly over and point" follow-up meaningful once the reply lands.
    private var pendingScreenCapture: (attachment: MessageAttachment, screen: NSScreen?)?

    private init() {}

    /// The live selection when `chatViewModel` is wired (the normal case);
    /// falls back to reading the same persisted key directly only for the
    /// brief window before `RootView` sets it.
    var selectedModelId: String {
        chatViewModel?.selectedModel ?? UserDefaults.standard.string(forKey: "selected_model_id") ?? ""
    }

    var modelDisplayName: String {
        let id = selectedModelId
        guard !id.isEmpty else { return "No model" }
        return ModelPreferencesStore.shared.nickname(for: id)
            ?? ModelCatalog.displayName(modelId: id, apiName: nil)
    }

    func send() {
        let text = inputText.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty || !pendingAttachments.isEmpty, !isStreaming else { return }
        inputText = ""
        let attachments = pendingAttachments
        pendingAttachments = []
        let screenCapture = pendingScreenCapture
        pendingScreenCapture = nil
        transcript.append(QuickTurn(text: text, isUser: true, attachments: attachments))
        isStreaming = true
        // The desktop pet listens to this surface too: it reacts to the
        // tone of what was just said, then settles into its working state
        // while the reply streams. (Both no-ops when the pet is off.)
        EaonPetController.shared.reactToUserMessage(text)
        EaonPetController.shared.noteGenerationStarted()
        task = Task { [weak self] in await self?.run(screenCapture: screenCapture) }
    }

    func stop() {
        task?.cancel()
        task = nil
        activeTypewriter?.cancel()
        isStreaming = false
    }

    func clear() {
        stop()
        transcript = []
        inputText = ""
        pendingAttachments = []
        pendingScreenCapture = nil
        composerNotice = nil
    }

    // MARK: - Attachments

    /// `url` must already be security-scope-accessed by the caller (the
    /// `.fileImporter` result), matching `ChatViewModel.addAttachment`'s
    /// own contract.
    func addAttachment(from url: URL, kind: AttachmentKind) {
        do {
            let attachment = try AttachmentStore.importFile(from: url, kind: kind)
            pendingAttachments.append(attachment)
            composerNotice = nil
        } catch {
            composerNotice = error.localizedDescription
        }
    }

    func pasteImageAttachment() {
        do {
            guard let attachment = try AttachmentStore.importImageFromPasteboard() else {
                composerNotice = "No image found on the clipboard."
                return
            }
            pendingAttachments.append(attachment)
            composerNotice = nil
        } catch {
            composerNotice = "Could not paste image: \(error.localizedDescription)"
        }
    }

    func removePendingAttachment(id: UUID) {
        pendingAttachments.removeAll { $0.id == id }
        if pendingScreenCapture?.attachment.id == id { pendingScreenCapture = nil }
    }

    /// The "My screen" attach: grabs the display this panel is on right
    /// now (never the pet's — it may have wandered off to a different one)
    /// and queues it exactly like any other picked or pasted image. Asking
    /// Screen Recording permission is a system prompt the OS itself owns;
    /// after a denial there's nothing more specific this can do than point
    /// at where to fix it.
    func attachScreenCapture() async {
        guard CGPreflightScreenCaptureAccess() else {
            CGRequestScreenCaptureAccess()
            composerNotice = "Allow Eaon to record your screen — System Settings → Privacy & Security → Screen Recording — then try again."
            return
        }
        let screen = DesktopAssistantController.shared.currentScreen
        let excluded = [DesktopAssistantController.shared.panelWindowNumber, EaonPetController.shared.windowNumber]
            .compactMap { $0 }
        do {
            let attachment = try await EaonPetSight.captureScreenAttachment(on: screen, excludingWindowNumbers: excluded)
            pendingAttachments.append(attachment)
            pendingScreenCapture = (attachment, screen)
            // Say so now, not after a wasted round-trip: without this, the
            // capture still attaches fine (same graceful fallback any
            // attachment gets with a non-vision model — a text note instead
            // of the real image) but the model can only reply that it can't
            // see it, which a user has no way to anticipate up front.
            composerNotice = ModelCatalog.supportsVision(for: selectedModelId)
                ? nil
                : "Captured — but \(modelDisplayName) can't see images. Switch to a vision model to actually ask about it."
        } catch {
            composerNotice = "Couldn't capture the screen: \(error.localizedDescription)"
        }
    }

    // MARK: - Generation

    private struct QuickAssistantError: LocalizedError {
        let message: String
        var errorDescription: String? { message }
    }

    private struct Route {
        let config: CustomProviderConfig
        let apiKey: String
        let requestModelId: String
    }

    private func run(screenCapture: (attachment: MessageAttachment, screen: NSScreen?)? = nil) async {
        let replyIndex = transcript.count
        let question = transcript.indices.contains(replyIndex - 1) ? transcript[replyIndex - 1].text : ""
        transcript.append(QuickTurn(text: "", isUser: false))

        let typewriter = TypewriterStreamController { [weak self] text in
            guard let self, self.transcript.indices.contains(replyIndex) else { return }
            self.transcript[replyIndex].text = text
        }
        activeTypewriter = typewriter

        do {
            let modelId = selectedModelId
            guard !modelId.isEmpty else {
                throw QuickAssistantError(message: "No model selected — pick one from the model name above.")
            }

            // Same opt-in system instruction the main app sends, read from
            // its own persisted key so the two never disagree.
            var history: [HistoryTurn] = []
            let instructions = UserDefaults.standard.string(forKey: "custom_instructions") ?? ""
            if !instructions.isEmpty {
                history.append(HistoryTurn(role: "system", content: instructions))
            }
            for turn in transcript.prefix(replyIndex) where !turn.isError && (!turn.text.isEmpty || !turn.attachments.isEmpty) {
                history.append(historyTurn(for: turn, modelId: modelId))
            }

            let route = try await resolveRoute(modelId: modelId, history: &history)
            try await CustomProviderAPIService().streamCompletion(
                config: route.config,
                apiKey: route.apiKey,
                modelId: route.requestModelId,
                history: history,
                typewriter: typewriter,
                sampling: ModelParametersStore.shared.effectiveParameters
            )
            typewriter.markStreamFinished()
            await typewriter.waitUntilCaughtUp()
        } catch is CancellationError {
            typewriter.cancel()
        } catch {
            typewriter.cancel()
            if transcript.indices.contains(replyIndex), transcript[replyIndex].text.isEmpty {
                transcript[replyIndex].text = error.localizedDescription
                transcript[replyIndex].isError = true
            }
        }

        activeTypewriter = nil
        isStreaming = false
        // Let the pet react to how this turn ended: the reply's own tone,
        // or the error face if it failed.
        let reply = transcript.indices.contains(replyIndex) ? transcript[replyIndex] : nil
        let hadError = reply?.isError == true
        EaonPetController.shared.noteGenerationEnded(hadError: hadError, replyText: hadError ? nil : reply?.text)

        // This turn included a live screen capture and got a real answer —
        // fire a silent, never-shown follow-up asking where to point, and
        // fly the pet over if it found something. Fully async: doesn't
        // block `isStreaming` clearing, so the panel stays responsive while
        // the pet catches up a moment later.
        if let screenCapture, let reply, !hadError, !reply.text.isEmpty,
           let image = ImagePayloadBuilder.build(for: screenCapture.attachment) {
            let modelId = selectedModelId
            let answerText = reply.text
            Task { [screenCapture] in
                guard let normalized = await EaonPetSight.locate(
                    question: question, answer: answerText, image: image, modelId: modelId
                ), let screen = screenCapture.screen else { return }
                let f = screen.frame
                let point = CGPoint(x: f.minX + normalized.x * f.width, y: f.maxY - normalized.y * f.height)
                EaonPetController.shared.pointAt(screenPoint: point)
            }
        }
    }

    /// Mirrors `ChatViewModel.historyTurn(for:modelId:)`: real image parts
    /// for attachments the active model can actually see, a plain
    /// "[Attached: x]" fallback note for anything it can't (a non-image
    /// file, or a model without vision) — so the same picture behaves
    /// identically whether it's sent from the main window or the quick
    /// panel.
    private func historyTurn(for turn: QuickTurn, modelId: String) -> HistoryTurn {
        let role = turn.isUser ? "user" : "assistant"
        guard !turn.attachments.isEmpty else {
            return HistoryTurn(role: role, content: turn.text)
        }

        var images: [HistoryImage] = []
        var sentIds: Set<UUID> = []
        if ModelCatalog.supportsVision(for: modelId) {
            for attachment in turn.attachments where attachment.kind == .image {
                guard let image = ImagePayloadBuilder.build(for: attachment) else { continue }
                images.append(image)
                sentIds.insert(attachment.id)
            }
        }

        let remaining = turn.attachments.filter { !sentIds.contains($0.id) }
        var content = turn.text
        if !remaining.isEmpty {
            let note = "[Attached: \(remaining.map(\.fileName).joined(separator: ", "))]"
            content = content.isEmpty ? note : content + "\n\n" + note
        }
        return HistoryTurn(role: role, content: content, images: images)
    }

    /// Mirror of `ChatViewModel`'s routing precedence (BYOK config → local
    /// model → Aqua), collapsed to the one wire format all three speak.
    private func resolveRoute(modelId: String, history: inout [HistoryTurn]) async throws -> Route {
        if let config = CustomProviderStore.shared.config(owning: modelId) {
            guard let key = CustomProviderStore.shared.apiKey(for: config.id), !key.isEmpty else {
                throw QuickAssistantError(message: "No API key saved for \(config.displayName) — add one in the main Eaon window.")
            }
            return Route(config: config, apiKey: key, requestModelId: modelId)
        }

        if let record = LocalAIManager.shared.record(withId: modelId) {
            let baseURL = try await LocalAIManager.shared.ensureReady(for: record)
            // Local servers render strict chat templates — same flatten (and
            // llama.cpp context trim) the main chat path applies.
            history = history.flattenedForStrictChatTemplates
            if record.backend == .llamaCpp {
                history = history.trimmedToFit(contextTokens: (record.contextSize ?? .defaultValue).tokens)
            }
            let config = CustomProviderConfig(
                brand: ModelCatalog.brand(for: record.requestModelId),
                baseURL: baseURL.absoluteString,
                format: .openAICompatible,
                modelIDs: [record.requestModelId]
            )
            return Route(config: config, apiKey: "local-no-key", requestModelId: record.requestModelId)
        }

        // User key or free-week trial — the trial's base URL and signing
        // ride the same BYOK streaming path (see CustomProviderAPIService's
        // EaonAccess.authorize call).
        guard let access = EaonAccess.current else {
            throw QuickAssistantError(message: "Add an API key (or start your free week) or a local model in the main Eaon window first.")
        }
        let config = CustomProviderConfig(
            brand: ModelCatalog.brand(for: modelId),
            baseURL: access.baseURL.absoluteString,
            format: .openAICompatible,
            modelIDs: [modelId]
        )
        return Route(config: config, apiKey: access.apiKey, requestModelId: modelId)
    }
}
