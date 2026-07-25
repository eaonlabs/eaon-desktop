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
        let raw = inputText.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !raw.isEmpty || !pendingAttachments.isEmpty, !isStreaming else { return }
        inputText = ""
        // Set immediately (before the async /screen branch, if any) so a
        // second Enter mid-capture can't double-fire — matches the
        // already-true value `dispatchSend` sets for the plain-text path.
        isStreaming = true

        if let question = Self.screenCommandQuestion(from: raw) {
            task = Task { [weak self] in await self?.runScreenCommand(question: question) }
            return
        }

        dispatchSend(text: raw)
    }

    /// Shared tail of a real send — appends the turn, reacts, and kicks the
    /// actual generation. Assumes `isStreaming` is already true.
    private func dispatchSend(text: String) {
        let attachments = pendingAttachments
        pendingAttachments = []
        let screenCapture = pendingScreenCapture
        pendingScreenCapture = nil
        transcript.append(QuickTurn(text: text, isUser: true, attachments: attachments))
        // The desktop pet listens to this surface too: it reacts to the
        // tone of what was just said, then settles into its working state
        // while the reply streams. (Both no-ops when the pet is off.)
        EaonPetController.shared.reactToUserMessage(text)
        EaonPetController.shared.noteGenerationStarted()
        // With voice on, the pet reads the answer aloud — for a question
        // TYPED here just as much as one spoken at it. (No-op when voice is
        // off, which is the default.)
        EaonVoiceController.shared.noteReplyStarted()
        task = Task { [weak self] in await self?.run(screenCapture: screenCapture) }
    }

    /// `/screen` (optionally followed by a question) — a typed shortcut for
    /// "+ → My screen" that ALSO switches to whichever model last actually
    /// answered a screen question successfully, before capturing. Plain
    /// attaching (the + menu button) deliberately does NOT do this model
    /// switch — it stays a predictable "just attach, use whatever I have
    /// selected" action; `/screen` is the power-shortcut that additionally
    /// fixes the model, since the app's model selection is one shared value
    /// that can drift to something non-vision from other activity.
    ///
    /// Matches only the whole word "/screen" (exact, or followed by
    /// whitespace) — `hasPrefix` alone would misfire on an unrelated future
    /// word like "/screenshot".
    private static func screenCommandQuestion(from text: String) -> String? {
        let lower = text.lowercased()
        guard lower == "/screen" || lower.hasPrefix("/screen ") || lower.hasPrefix("/screen\n") else { return nil }
        let rest = text.dropFirst("/screen".count).trimmingCharacters(in: .whitespacesAndNewlines)
        return rest.isEmpty ? "What's on my screen right now?" : rest
    }

    private func runScreenCommand(question: String) async {
        if let remembered = Self.lastScreenVisionModel, remembered != selectedModelId {
            chatViewModel?.selectModel(remembered)
        }
        // Attach even if this fails — a permission denial still leaves the
        // typed question sendable as plain text, with the notice explaining
        // why (same forgiving behavior a failed paste already gets).
        await attachScreenCapture()
        dispatchSend(text: question)
    }

    /// The last model that successfully answered a screen-capture question
    /// with real vision (not just a graceful non-vision fallback) — set in
    /// `run()`, read by `runScreenCommand`. Persisted across launches like
    /// every other model preference in this app.
    private static let screenVisionModelKey = "eaon_screen_vision_model"
    private static var lastScreenVisionModel: String? {
        get { UserDefaults.standard.string(forKey: screenVisionModelKey) }
        set { UserDefaults.standard.set(newValue, forKey: screenVisionModelKey) }
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

        // "Where should the pet point?" runs CONCURRENTLY with the main
        // reply, kicked off here rather than after it. Previously this was a
        // second, sequential round-trip that only started once the whole
        // answer had streamed — so on a slow model the pointing hand could
        // take a minute-plus to appear (two full model calls back to back,
        // reported as "the hand shows after a solid 2 mins"). Firing it in
        // parallel means it's usually already done by the time the answer
        // lands. (We still only ACT on the result after a successful reply,
        // below, so the pet never points at a failed turn or before the
        // user has an answer to go with the point.)
        var locateTask: Task<CGPoint?, Never>?

        do {
            let modelId = selectedModelId
            guard !modelId.isEmpty else {
                throw QuickAssistantError(message: "No model selected — pick one from the model name above.")
            }

            if let screenCapture, ModelCatalog.supportsVision(for: modelId),
               let image = ImagePayloadBuilder.build(for: screenCapture.attachment) {
                locateTask = Task { await EaonPetSight.locate(question: question, image: image, modelId: modelId) }
            }

            // Same opt-in system instruction the main app sends, read from
            // its own persisted key so the two never disagree.
            var history: [HistoryTurn] = []
            let instructions = UserDefaults.standard.string(forKey: "custom_instructions") ?? ""
            if !instructions.isEmpty {
                history.append(HistoryTurn(role: "system", content: instructions))
            }
            // Only the MOST RECENT attachment-bearing turn sends its images
            // as real image data — earlier ones fall back to a text note
            // (same as a non-vision model already gets). Seen live: a
            // screen-capture question that failed and got retried kept
            // BOTH attempts' full-size screenshots in history, and the
            // combined payload for the retry came back "413 Payload Too
            // Large" — a failure caused entirely by carrying forward images
            // nobody was still asking about. Capping to the latest keeps
            // the conversation honest (the model still sees a note that
            // something was attached) without unbounded payload growth.
            let lastAttachmentTurnId = transcript.prefix(replyIndex).last(where: { !$0.attachments.isEmpty })?.id
            for turn in transcript.prefix(replyIndex) where !turn.isError && (!turn.text.isEmpty || !turn.attachments.isEmpty) {
                history.append(historyTurn(for: turn, modelId: modelId, includeImages: turn.id == lastAttachmentTurnId))
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
        // Say the last of it out loud (a short reply never produced a
        // sentence boundary while streaming, so this is where it gets read).
        EaonVoiceController.shared.noteReplyFinished(hadError ? nil : reply?.text)

        // This turn included a live screen capture and got a real answer
        // FROM A MODEL THAT COULD ACTUALLY SEE IT (not the graceful
        // non-vision text-only fallback) — remember it as the model
        // `/screen` should switch to next time, and consume the already-
        // running location lookup: await its (usually finished) result and
        // fly the pet over if it found something. If it's still running we
        // wait only for it, never a fresh call.
        if let screenCapture, let reply, !hadError, !reply.text.isEmpty,
           ModelCatalog.supportsVision(for: selectedModelId) {
            Self.lastScreenVisionModel = selectedModelId
            if let locateTask {
                Task { [screenCapture] in
                    guard let normalized = await locateTask.value, let screen = screenCapture.screen else { return }
                    let f = screen.frame
                    let point = CGPoint(x: f.minX + normalized.x * f.width, y: f.maxY - normalized.y * f.height)
                    EaonPetController.shared.pointAt(screenPoint: point)
                }
            }
        } else {
            locateTask?.cancel()
        }
    }

    /// Mirrors `ChatViewModel.historyTurn(for:modelId:)`: real image parts
    /// for attachments the active model can actually see, a plain
    /// "[Attached: x]" fallback note for anything it can't (a non-image
    /// file, a model without vision, or — `includeImages: false` — an
    /// older turn whose image is no longer the one being asked about) — so
    /// the same picture behaves identically whether it's sent from the main
    /// window or the quick panel.
    private func historyTurn(for turn: QuickTurn, modelId: String, includeImages: Bool) -> HistoryTurn {
        let role = turn.isUser ? "user" : "assistant"
        guard !turn.attachments.isEmpty else {
            return HistoryTurn(role: role, content: turn.text)
        }

        var images: [HistoryImage] = []
        var sentIds: Set<UUID> = []
        if includeImages, ModelCatalog.supportsVision(for: modelId) {
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
        // The same silent free-week mint the main window performs
        // (`ChatViewModel.autoStartTrialIfNeeded`). Without it, this surface —
        // the one the desktop pet talks through — was the ONLY one that never
        // bootstrapped its own access: asking the pet on a fresh install
        // failed with "add an API key", while typing the identical question
        // in the main window quietly started a trial and answered. That
        // asymmetry is the whole reason the pet "never responds".
        //
        // Idempotent and cheap: it fires only when this device has never held
        // a credential at all, so an expired trial falls straight through to
        // the honest message below rather than silently re-minting.
        if EaonAccess.current == nil, TrialStore.shared.credential == nil, !TrialStore.shared.isStarting {
            await TrialStore.shared.start()
        }
        guard let access = EaonAccess.current else {
            throw QuickAssistantError(message: TrialStore.shared.isExpired
                ? "Your free week has ended. Add your Eaon API key in Settings → Eaon API to keep chatting."
                : (TrialStore.shared.lastError
                    ?? "Couldn't reach Eaon to start your free week. Check your connection, or add an API key in Settings → Eaon API."))
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
