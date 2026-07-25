import AVFoundation
import Foundation
import Speech

/// Settings-backed switches for talking to the desktop pet out loud. Both off
/// by default and independent of the pet's own toggle: the pet is a companion,
/// this turns it into a voice assistant, and turning one on shouldn't silently
/// turn on a microphone.
@MainActor
@Observable
final class EaonVoiceStore {
    static let shared = EaonVoiceStore()

    private static let enabledKey = "eaon_voice_enabled"
    private static let wakeWordKey = "eaon_voice_wake_word_enabled"
    private static let voiceKey = "eaon_voice_identifier"
    private static let rateKey = "eaon_voice_rate"
    private static let engineKey = "eaon_voice_engine"
    private static let kokoroVoiceKey = "eaon_voice_kokoro"
    private static let conversationKey = "eaon_voice_conversation_mode"

    /// The chosen voice's `AVSpeechSynthesisVoice.identifier`. Empty means
    /// "pick the best installed automatically" — the behaviour before this
    /// setting existed, and still the right default.
    var voiceIdentifier: String {
        didSet { UserDefaults.standard.set(voiceIdentifier, forKey: Self.voiceKey) }
    }

    /// Speaking rate as a multiple of the system default. Slightly under 1
    /// reads as measured rather than clipped; the compact voices in
    /// particular sound markedly less robotic a touch slower.
    var rateMultiplier: Double {
        didSet { UserDefaults.standard.set(rateMultiplier, forKey: Self.rateKey) }
    }

    /// Which engine speaks. See `EaonSpeechEngine`.
    var engine: EaonSpeechEngine {
        didSet { UserDefaults.standard.set(engine.rawValue, forKey: Self.engineKey) }
    }

    /// Kokoro preset used when `engine == .kokoro`.
    var kokoroVoice: String {
        didSet { UserDefaults.standard.set(kokoroVoice, forKey: Self.kokoroVoiceKey) }
    }

    /// Hands-free back-and-forth: once you start talking, Eaon keeps the
    /// conversation open — it answers, listens again straight away, and you
    /// can cut it off mid-sentence just by speaking, with no wake phrase
    /// between turns. The ChatGPT-voice-mode shape.
    var conversationMode: Bool {
        didSet {
            UserDefaults.standard.set(conversationMode, forKey: Self.conversationKey)
            EaonVoiceController.shared.applyEnabledState()
        }
    }

    var isEnabled: Bool {
        didSet {
            UserDefaults.standard.set(isEnabled, forKey: Self.enabledKey)
            EaonVoiceController.shared.applyEnabledState()
        }
    }

    /// Hands-free "Hey Eaon". Costs a permanently open microphone, which is
    /// why it's a second, separate opt-in rather than part of turning voice on
    /// — push-to-talk users should never be holding the mic open.
    var wakeWordEnabled: Bool {
        didSet {
            UserDefaults.standard.set(wakeWordEnabled, forKey: Self.wakeWordKey)
            EaonVoiceController.shared.applyEnabledState()
        }
    }

    private init() {
        isEnabled = UserDefaults.standard.object(forKey: Self.enabledKey) as? Bool ?? false
        wakeWordEnabled = UserDefaults.standard.object(forKey: Self.wakeWordKey) as? Bool ?? false
        voiceIdentifier = UserDefaults.standard.string(forKey: Self.voiceKey) ?? ""
        rateMultiplier = UserDefaults.standard.object(forKey: Self.rateKey) as? Double ?? 0.96
        engine = EaonSpeechEngine(rawValue: UserDefaults.standard.string(forKey: Self.engineKey) ?? "") ?? .system
        kokoroVoice = UserDefaults.standard.string(forKey: Self.kokoroVoiceKey) ?? "af_heart"
        conversationMode = UserDefaults.standard.object(forKey: Self.conversationKey) as? Bool ?? false
    }
}

/// Where the voice loop currently is.
enum EaonVoiceState: Equatable {
    /// Nothing running; microphone closed.
    case off
    /// Microphone open, waiting to hear the wake phrase. Only ever reached
    /// with the wake word turned on.
    case waking
    /// Capturing what the user is actually asking.
    case listening
    /// Question sent, waiting on the model.
    case thinking
    /// Reading the reply aloud.
    case speaking
}

/// Talking to Eaon out loud, entirely on this Mac.
///
/// **Nothing here touches the network.** Speech-to-text is Apple's on-device
/// recognizer (`requiresOnDeviceRecognition = true`) and text-to-speech is
/// `AVSpeechSynthesizer` reading voices already installed on the machine — no
/// API key, no model download, no audio ever leaving the computer. The only
/// network call in the round trip is the answer itself, which routes through
/// the user's own chosen model (a local Ollama model included, making the
/// whole loop fully offline).
///
/// The privacy rule is enforced, not hoped for: if this Mac can't transcribe
/// the current language on-device, the feature **refuses to run and says so**
/// rather than falling back to Apple's server-based recognition, which would
/// quietly ship microphone audio off the machine — the exact thing someone
/// choosing a privacy-focused app is trying to avoid.
///
/// ## How a hands-free turn flows
///
/// One continuous recognition session spans the wake phrase AND the command.
/// That's deliberate: tearing the session down on "Hey Eaon" and starting a
/// fresh one would drop the first word of "…what's on my screen", because
/// audio keeps arriving during the restart. Instead the session stays up and
/// the controller simply stops ignoring what it hears, remembering how far
/// into the transcript the wake phrase ended so the command starts clean.
///
/// ## Performance, since this runs on every Mac
/// - Push-to-talk opens the mic only while listening and closes it after.
///   Wake-word mode necessarily holds it open — that's the trade, and it's
///   why it's a separate opt-in.
/// - The audio tap does exactly one thing: hand the buffer to the recognizer.
///   It runs on a real-time audio thread and captures the request directly
///   rather than reaching through `self`, which would force an actor hop on
///   every buffer (~86×/second).
/// - Endpointing is a wall-clock comparison on a 0.25s timer, not continuous
///   signal analysis.
/// - Replies are spoken sentence-by-sentence as they stream, so Eaon starts
///   answering while the model is still writing instead of after it finishes.
@MainActor
@Observable
final class EaonVoiceController: NSObject {
    static let shared = EaonVoiceController()

    private(set) var state: EaonVoiceState = .off
    /// Live transcription of the command, so the user can see it heard them
    /// correctly before it commits.
    private(set) var partialTranscript = ""
    /// Set when something stopped the loop that the user needs to know about
    /// (permission refused, on-device recognition unavailable).
    private(set) var lastError: String?
    /// True when echo cancellation is active. When it isn't, barge-in is
    /// unreliable because the microphone hears the pet's own voice.
    private(set) var echoCancellationActive = false

    // MARK: - Audio / recognition plumbing

    @ObservationIgnored private let engine = AVAudioEngine()
    @ObservationIgnored private var recognizer: SFSpeechRecognizer?
    @ObservationIgnored private var request: SFSpeechAudioBufferRecognitionRequest?
    @ObservationIgnored private var recognitionTask: SFSpeechRecognitionTask?
    @ObservationIgnored private var endpointTimer: Timer?
    @ObservationIgnored private var lastHeardAt = Date.distantPast
    @ObservationIgnored private let synthesizer = AVSpeechSynthesizer()
    @ObservationIgnored private var replyWatchdog: Task<Void, Never>?
    /// True only once the audio engine has actually been started for a real
    /// listening session. Gates every subsequent `engine.inputNode` access,
    /// because reading that property is itself a microphone request — see
    /// `teardownAudio`.
    @ObservationIgnored private var audioSessionStarted = false

    /// True while the session is still waiting for the wake phrase. False the
    /// moment it's heard, so subsequent transcript is treated as the command.
    @ObservationIgnored private var wakeArmed = false
    /// How much of the running transcript belongs to the wake phrase and
    /// everything before it — stripped so the command doesn't start with
    /// "hey eaon".
    @ObservationIgnored private var transcriptOffset = 0
    /// Utterances handed to the synthesizer that haven't finished yet. The
    /// turn is over when this drains, not when the last one is queued.
    @ObservationIgnored private var pendingUtterances = 0
    /// How far into the reply we've already spoken, so streaming speech never
    /// repeats itself.
    @ObservationIgnored private var speechCursor = 0
    /// True from the first thing you say until the conversation lapses —
    /// only meaningful with `conversationMode` on. While set, turns follow
    /// each other with no wake phrase and speech interrupts playback.
    @ObservationIgnored private var conversationActive = false

    private static let silenceToEndTurn: TimeInterval = 1.3
    private static let silenceToGiveUp: TimeInterval = 6
    /// A live conversation waits longer before lapsing than a single
    /// push-to-talk turn does — you're allowed to think mid-conversation
    /// without it hanging up on you.
    private static let silenceToEndConversation: TimeInterval = 14

    private var giveUpWindow: TimeInterval {
        conversationActive ? Self.silenceToEndConversation : Self.silenceToGiveUp
    }

    private override init() {
        super.init()
        synthesizer.delegate = self
    }

    // MARK: - Lifecycle

    /// Called when either toggle changes (and at launch): start hands-free
    /// listening, or shut everything down.
    /// `mayPrompt` decides whether this is allowed to raise the macOS
    /// microphone/speech permission dialog.
    ///
    /// **Launch passes `false`, always.** An app that asks for your
    /// microphone the moment it opens looks like it wants to listen to you,
    /// whatever the reason turns out to be — and Eaon has no business
    /// touching the microphone until you've explicitly asked it to talk.
    /// Permission is therefore requested at exactly one moment: when the
    /// user turns voice on, or clicks the pet to dictate. Never on open,
    /// never in the background, never as a side effect of anything else.
    ///
    /// A relaunch with hands-free already on still resumes silently, because
    /// `alreadyAuthorized` reads the existing grant WITHOUT prompting. If the
    /// grant isn't there, it simply waits for a deliberate action rather than
    /// asking out of nowhere.
    func applyEnabledState(mayPrompt: Bool = true) {
        let store = EaonVoiceStore.shared
        guard store.isEnabled else {
            cancelEverything()
            return
        }
        if store.wakeWordEnabled {
            guard mayPrompt || Self.alreadyAuthorized else { return }
            if state == .off { Task { await startSession(armed: true, mayPrompt: mayPrompt) } }
        } else if state == .waking {
            // Wake word switched off while idly listening — close the mic.
            cancelEverything()
        }
    }

    /// Whether the microphone and recognizer are ALREADY granted. Pure status
    /// reads — neither of these shows a dialog, which is the whole point.
    private static var alreadyAuthorized: Bool {
        AVCaptureDevice.authorizationStatus(for: .audio) == .authorized
            && SFSpeechRecognizer.authorizationStatus() == .authorized
    }

    /// The pet was tapped. Push-to-talk starts/stops a turn; with the wake
    /// word on, a tap still works as a manual override so you never *have* to
    /// say the phrase. A tap while it's talking shuts it up.
    func toggleListening() {
        guard EaonVoiceStore.shared.isEnabled else { return }
        // Open the panel FIRST, always. It's the only surface that can show
        // "Listening…", the live transcript, or a permission error — without
        // it, tapping the pet with voice on looked like it did nothing at
        // all, whether it was working or silently failing.
        DesktopAssistantController.shared.showPanel()
        DesktopAssistantController.shared.setExpanded(true)
        switch state {
        case .off:
            Task { await startSession(armed: false) }
        case .waking:
            // Already listening for the phrase — skip it and take the command
            // directly.
            wakeArmed = false
            transcriptOffset = currentTranscriptLength()
            partialTranscript = ""
            lastHeardAt = Date()
            enter(.listening)
        case .listening:
            finishTurn()
        case .speaking:
            stopSpeaking()
        case .thinking:
            break // let the reply land rather than half-cancelling it
        }
    }

    func cancelEverything() {
        replyWatchdog?.cancel()
        replyWatchdog = nil
        teardownAudio()
        stopSpeaking()
        partialTranscript = ""
        enter(.off)
    }

    // MARK: - The recognition session

    /// Opens the mic and starts one continuous recognition session.
    /// `armed` = wait for the wake phrase before treating speech as a command.
    /// Guarded on the recognition task, NOT on `state`: hands-free mode keeps
    /// the microphone live through `.thinking` and `.speaking` so "Hey Eaon"
    /// can interrupt a reply. Guarding on `state == .off` (the obvious
    /// version) silently refused exactly those restarts and quietly disabled
    /// barge-in.
    private func startSession(armed: Bool, mayPrompt: Bool = true) async {
        guard recognitionTask == nil else { return }
        // Never open a permission dialog from a path the user didn't
        // initiate — see `applyEnabledState`.
        guard mayPrompt || Self.alreadyAuthorized else { return }
        lastError = nil
        partialTranscript = ""
        transcriptOffset = 0
        wakeArmed = armed

        guard await ensurePermissions() else { return }

        let recognizer = SFSpeechRecognizer(locale: Locale.current) ?? SFSpeechRecognizer()
        guard let recognizer, recognizer.isAvailable else {
            fail("Speech recognition isn't available on this Mac right now.")
            return
        }
        // The privacy line in the sand — see the type's doc comment.
        guard recognizer.supportsOnDeviceRecognition else {
            fail("Your Mac can't transcribe \(Locale.current.identifier) without sending audio to Apple, so Eaon won't. Add that language under System Settings → Keyboard → Dictation to get the on-device model, then try again.")
            return
        }
        self.recognizer = recognizer

        // From here on the input hardware genuinely is needed, and the user
        // has already granted it above. Flagged BEFORE the first `inputNode`
        // read so teardown knows there's something real to tear down.
        audioSessionStarted = true
        let input = engine.inputNode
        // Echo cancellation, so the microphone doesn't hear the pet's own
        // voice through the speakers. Without it, hands-free mode transcribes
        // Eaon talking to itself. Must be set BEFORE reading the input format
        // — enabling it changes the format the node vends.
        do {
            try input.setVoiceProcessingEnabled(true)
            echoCancellationActive = true
        } catch {
            // Not fatal: push-to-talk is unaffected (the mic is shut while
            // speaking) and wake-word mode still works, just with a chance of
            // hearing itself. Recorded so the settings row can say so.
            echoCancellationActive = false
        }

        let request = SFSpeechAudioBufferRecognitionRequest()
        request.shouldReportPartialResults = true
        request.requiresOnDeviceRecognition = true
        self.request = request

        let format = input.outputFormat(forBus: 0)
        // A zero sample rate means the input device isn't usable (no mic, or
        // one that vanished); installing a tap on it raises an uncatchable
        // exception, so bail with a real message instead.
        guard format.sampleRate > 0 else {
            fail("No microphone is available.")
            return
        }

        // Captured directly, NOT through self — this runs on a real-time
        // audio thread and must not hop actors per buffer.
        input.installTap(onBus: 0, bufferSize: 1024, format: format) { buffer, _ in
            request.append(buffer)
        }

        engine.prepare()
        do {
            try engine.start()
        } catch {
            input.removeTap(onBus: 0)
            fail("Couldn't start the microphone: \(error.localizedDescription)")
            return
        }

        lastHeardAt = Date()
        // A session started while a reply is in flight (hands-free barge-in)
        // must not overwrite `.thinking`/`.speaking` — those are what the
        // user is actually watching.
        if armed {
            if state == .off { enter(.waking) }
        } else {
            enter(.listening)
        }

        recognitionTask = recognizer.recognitionTask(with: request) { [weak self] result, error in
            Task { @MainActor in
                guard let self else { return }
                if let result {
                    self.ingest(transcript: result.bestTranscription.formattedString)
                    if result.isFinal { self.sessionEnded() }
                } else if error != nil {
                    self.sessionEnded()
                }
            }
        }

        startEndpointTimer()
    }

    /// Every partial result flows through here. In `waking` it's scanned for
    /// the wake phrase and otherwise discarded; after that it accumulates as
    /// the command.
    private func ingest(transcript full: String) {
        // Conversation mode: once you're in a conversation, ANY speech is
        // meant for Eaon — including speech that lands while it's still
        // talking, which is what "interrupt it" means. No wake phrase between
        // turns, exactly like ChatGPT's voice mode.
        //
        // Gated on echo cancellation actually being active. Without AEC the
        // microphone hears the pet's own voice through the speakers, and
        // "any speech interrupts" would make it interrupt itself forever —
        // a feedback loop, not a conversation.
        if wakeArmed, conversationActive, echoCancellationActive {
            let heard = String(full.dropFirst(min(transcriptOffset, full.count)))
                .trimmingCharacters(in: .whitespacesAndNewlines)
            // A couple of characters is a cough or a stray phoneme; a few
            // words is a person talking.
            if heard.count >= 3 {
                wakeArmed = false
                lastHeardAt = Date()
                if state == .speaking { stopSpeaking() }
                replyWatchdog?.cancel()
                replyWatchdog = nil
                enter(.listening)
            }
        }
        if wakeArmed {
            guard let end = Self.wakePhraseEnd(in: full) else { return }
            // Heard it. Everything after the phrase in this same result is
            // already the start of the command — "Hey Eaon, what's the time"
            // arrives as one string, and the command must not lose "what's".
            wakeArmed = false
            transcriptOffset = end
            lastHeardAt = Date()
            // Interrupting a reply is the whole point of barge-in.
            if state == .speaking { stopSpeaking() }
            replyWatchdog?.cancel()
            enter(.listening)
        }
        guard state == .listening else { return }
        let text = String(full.dropFirst(min(transcriptOffset, full.count)))
            .trimmingCharacters(in: .whitespacesAndNewlines)
        if text != partialTranscript {
            partialTranscript = text
            lastHeardAt = Date()
            // Dictation: the words go straight into the composer as you say
            // them, so you can see exactly what was heard, fix it if it got
            // something wrong, and press Enter when YOU'RE done. That last
            // part matters — every auto-send heuristic (silence timers,
            // wake phrases, end-of-turn detection) is a guess about when you
            // stopped talking, and a wrong guess either cuts you off or
            // fires a half-finished question. Enter is not a guess.
            QuickAssistantViewModel.shared.inputText = text
            publishStatus()
        }
    }

    private func currentTranscriptLength() -> Int {
        // Best effort: the running transcript is whatever the last partial
        // said, plus what we already skipped.
        transcriptOffset + partialTranscript.count
    }

    /// The recognizer's task ended (its own duration cap, a final result, or
    /// an error). In hands-free mode that must not end listening — restart so
    /// "Hey Eaon" keeps working indefinitely.
    private func sessionEnded() {
        let shouldStayHandsFree = EaonVoiceStore.shared.isEnabled
            && EaonVoiceStore.shared.wakeWordEnabled
            && state != .listening
        teardownAudio()
        if state == .listening {
            // A final result mid-command: treat it as the end of the turn.
            finishTurn()
            return
        }
        if shouldStayHandsFree {
            enter(.off)
            Task { await startSession(armed: true, mayPrompt: false) }
        } else if state == .waking {
            enter(.off)
        }
    }

    private func startEndpointTimer() {
        endpointTimer?.invalidate()
        let timer = Timer.scheduledTimer(withTimeInterval: 0.25, repeats: true) { [weak self] _ in
            Task { @MainActor in
                guard let self, self.state == .listening else { return }
                let quietFor = Date().timeIntervalSince(self.lastHeardAt)
                if !self.partialTranscript.isEmpty, quietFor >= Self.silenceToEndTurn {
                    self.finishTurn()
                } else if self.partialTranscript.isEmpty, quietFor >= self.giveUpWindow {
                    // Opened the mic (or heard the wake phrase) and then
                    // nothing — don't send an empty question.
                    self.conversationActive = false
                    if EaonVoiceStore.shared.wakeWordEnabled {
                        self.wakeArmed = true
                        self.enter(.waking)
                    } else {
                        self.cancelEverything()
                    }
                }
            }
        }
        endpointTimer = timer
        RunLoop.main.add(timer, forMode: .common)
    }

    /// Stop capturing and send what was heard.
    private func finishTurn() {
        guard state == .listening else { return }
        let spoken = partialTranscript.trimmingCharacters(in: .whitespacesAndNewlines)
        partialTranscript = ""

        // Hands-free keeps the mic open through the answer so you can
        // interrupt; push-to-talk closes it, which is both more private and a
        // guarantee it can never hear itself.
        if EaonVoiceStore.shared.wakeWordEnabled {
            wakeArmed = true
            transcriptOffset = 0
            // The running transcript is stale now — restart the session so
            // the next wake phrase is matched against fresh text rather than
            // everything already said this session.
            teardownAudio()
            Task { await startSession(armed: true, mayPrompt: false) }
        } else {
            teardownAudio()
        }

        guard !spoken.isEmpty else {
            enter(EaonVoiceStore.shared.wakeWordEnabled ? .waking : .off)
            return
        }
        // Dictation, NOT auto-send. The transcript is already sitting in the
        // composer (see `ingest`); you stopped talking, so the microphone
        // closes and the words wait for you to press Enter. Editing a
        // misheard word before sending is the whole point.
        QuickAssistantViewModel.shared.inputText = spoken
        conversationActive = false
        enter(.off)
    }

    /// Release the microphone and every recognition object. Called on every
    /// exit path — a voice feature that leaves the mic hot is a privacy bug
    /// even when it's an accident.
    private func teardownAudio() {
        endpointTimer?.invalidate()
        endpointTimer = nil
        recognitionTask?.cancel()
        recognitionTask = nil
        request?.endAudio()
        request = nil

        // Do NOT touch `engine.inputNode` unless a session actually started.
        //
        // Merely *reading* `AVAudioEngine.inputNode` instantiates the input
        // hardware, and that alone raises the macOS microphone prompt — the
        // property access IS the request. So this teardown, whose entire job
        // is cleanup, was itself asking for the microphone.
        //
        // That made the launch path ask on every open: applyEnabledState ->
        // voice is OFF -> cancelEverything() -> teardownAudio() -> inputNode
        // -> prompt. The feature being *disabled* is what triggered it, and
        // every `mayPrompt` guard sat downstream of this line and never ran.
        guard audioSessionStarted else { return }
        audioSessionStarted = false
        if engine.isRunning { engine.stop() }
        engine.inputNode.removeTap(onBus: 0)
    }

    // MARK: - Asking, and answering out loud

    /// Hands the transcript to the Quick Assistant — the same surface the
    /// pet's tap and the `pet-ask` scripting hook already use, so a spoken
    /// question is routed and rendered identically to a typed one and there's
    /// no second conversation pipeline to keep in sync.
    private func send(_ question: String) {
        let vm = QuickAssistantViewModel.shared
        DesktopAssistantController.shared.showPanel()
        DesktopAssistantController.shared.setExpanded(true)
        vm.inputText = question
        // Speaking the answer is driven by `noteReplyStarted`/`noteReplyFinished`,
        // which the Quick Assistant calls for EVERY turn — so a question
        // typed into the panel is answered out loud exactly like a spoken
        // one. Wiring it here instead would have meant only the microphone
        // ever got a spoken reply, which is what "I ask it something and it
        // doesn't respond" actually was.
        vm.send()
    }

    /// A Quick Assistant turn just began — typed or spoken, it makes no
    /// difference. Starts reading the answer aloud as it streams.
    func noteReplyStarted() {
        guard EaonVoiceStore.shared.isEnabled else { return }
        speechCursor = 0
        replyWatchdog?.cancel()
        if state != .speaking { enter(.thinking) }

        replyWatchdog = Task { [weak self] in
            let vm = QuickAssistantViewModel.shared
            // Poll rather than hook the view model's generation path: the
            // reply streams through a typewriter every other feature depends
            // on, and a ~0.18s tick for the few seconds a reply takes costs
            // nothing measurable.
            while !Task.isCancelled {
                try? await Task.sleep(for: .milliseconds(180))
                let snapshot: (streaming: Bool, text: String?) = await MainActor.run {
                    let last = vm.transcript.last
                    let reply = (last?.isUser == false && last?.isError == false) ? last?.text : nil
                    return (vm.isStreaming, reply)
                }
                if let text = snapshot.text, !text.isEmpty {
                    await MainActor.run { self?.speakStreamingProgress(text) }
                }
                if !snapshot.streaming { break }
            }
        }
    }

    /// The turn finished. Speaks whatever streaming didn't already cover —
    /// short replies land here whole, having never produced a sentence
    /// boundary while streaming.
    func noteReplyFinished(_ text: String?) {
        guard EaonVoiceStore.shared.isEnabled else { return }
        replyWatchdog?.cancel()
        replyWatchdog = nil
        guard let text, !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
            if pendingUtterances == 0 { finishSpeakingTurn() }
            return
        }
        speakRemainder(of: text)
    }

    /// Speak complete sentences as they arrive, so Eaon starts answering while
    /// the model is still writing. Only the prose BEFORE any code fence is
    /// streamed: a fence that's still open can't be sanitized reliably (its
    /// closing ``` hasn't arrived), and reading half a code block aloud is
    /// worse than waiting. Whatever is left — including the code summary — is
    /// spoken by `speakRemainder` once the reply completes.
    private func speakStreamingProgress(_ raw: String) {
        guard state == .speaking || state == .thinking else { return }
        // Reasoning models stream their whole chain-of-thought first, inside
        // <think>…</think>. Reading that aloud is unbearable — observed live:
        // the pet delivered twenty utterances of "Wait wait, no, let me make
        // sure…" before ever reaching the one-sentence answer. `visibleContent`
        // is empty until the block closes, so nothing is spoken while the
        // model is still thinking, and the cursor counts in VISIBLE space so
        // the reasoning can never be reached by later slicing either.
        let visible = ReasoningExtractor.extract(from: raw).visibleContent
        let safeEnd = visible.range(of: "```")?.lowerBound ?? visible.endIndex
        let streamable = String(visible[visible.startIndex..<safeEnd])
        guard streamable.count > speechCursor else { return }
        let pending = String(streamable.dropFirst(speechCursor))
        guard let boundary = Self.lastSentenceBoundary(in: pending) else { return }
        let chunk = String(pending[pending.startIndex..<boundary])
        speechCursor += pending.distance(from: pending.startIndex, to: boundary)
        enqueue(Self.spokenText(from: chunk))
    }

    /// Everything not already spoken, once the reply is final.
    private func speakRemainder(of raw: String) {
        // Visible space, matching `speakStreamingProgress`'s cursor — the
        // model's <think> reasoning is never spoken.
        let visible = ReasoningExtractor.extract(from: raw).visibleContent
        let pending = visible.count > speechCursor ? String(visible.dropFirst(speechCursor)) : ""
        speechCursor = visible.count
        let text = Self.spokenText(from: pending)
        if text.isEmpty && pendingUtterances == 0 {
            finishSpeakingTurn()
            return
        }
        enqueue(text)
    }

    /// Read a reply aloud from scratch (the per-message button's path).
    func speak(_ raw: String) {
        speechCursor = raw.count
        enqueue(Self.spokenText(from: raw))
    }

    /// Queue one utterance. `AVSpeechSynthesizer` plays queued utterances
    /// back to back, which is exactly what sentence-streaming wants — no gap
    /// between "The answer is" and the next clause.
    private func enqueue(_ text: String) {
        guard !text.isEmpty else { return }
        // The per-message "read aloud" button uses its own synthesizer; two
        // talking at once would be gibberish.
        SpeechNarrator.shared.stop()
        pendingUtterances += 1
        if state != .speaking { enter(.speaking) }

        guard EaonVoiceStore.shared.engine == .kokoro, KokoroSpeech.isInstalled else {
            speakWithSystemVoice(text)
            return
        }
        // Neural path. Falls back to the system voice on any failure rather
        // than dropping the sentence — a misconfigured Kokoro should cost
        // you voice quality, never the answer itself.
        Task { [weak self] in
            let audio = await KokoroSpeech.shared.synthesize(
                text, voice: EaonVoiceStore.shared.kokoroVoice
            )
            guard let self else { return }
            guard let audio else {
                self.speakWithSystemVoice(text)
                return
            }
            KokoroSpeech.shared.play(audio) { [weak self] in
                guard let self else { return }
                self.pendingUtterances = max(0, self.pendingUtterances - 1)
                if self.pendingUtterances == 0, self.state == .speaking, self.replyWatchdog == nil {
                    self.finishSpeakingTurn()
                }
            }
        }
    }

    private func speakWithSystemVoice(_ text: String) {
        let utterance = AVSpeechUtterance(string: text)
        utterance.voice = Self.bestVoice()
        Self.applyProsody(to: utterance)
        synthesizer.speak(utterance)
    }

    func stopSpeaking() {
        pendingUtterances = 0
        if synthesizer.isSpeaking { synthesizer.stopSpeaking(at: .immediate) }
        KokoroSpeech.shared.stopPlayback()
        if state == .speaking { finishSpeakingTurn() }
    }

    /// The reply is fully spoken — go back to waiting for the wake phrase, or
    /// all the way idle in push-to-talk.
    private func finishSpeakingTurn() {
        speechCursor = 0
        pendingUtterances = 0
        let store = EaonVoiceStore.shared

        // Conversation mode: the answer is done, so listen again immediately.
        // No wake phrase, no click — the conversation just continues, and
        // lapses on its own if you don't say anything (see the endpoint
        // timer's give-up branch).
        if store.isEnabled, store.conversationMode, conversationActive {
            wakeArmed = false
            transcriptOffset = 0
            partialTranscript = ""
            lastHeardAt = Date()
            teardownAudio()
            enter(.off)
            Task { await startSession(armed: false, mayPrompt: false) }
            return
        }

        guard store.isEnabled, store.wakeWordEnabled else {
            enter(.off)
            return
        }
        // Hands-free: fall back to waiting for the wake phrase. The session is
        // usually still live (it stayed up through the reply for barge-in);
        // if it isn't, bring it back.
        if recognitionTask != nil {
            wakeArmed = true
            enter(.waking)
        } else {
            enter(.off)
            Task { await startSession(armed: true, mayPrompt: false) }
        }
    }

    /// The nicest voice already on this machine for the user's language.
    /// macOS ships a compact default and lets people download much better
    /// "Enhanced"/"Premium" ones; picking the best installed means the app
    /// sounds good on a Mac that has them without ever requiring a download.
    static func bestVoice() -> AVSpeechSynthesisVoice? {
        // An explicit choice always wins — that's the whole point of the
        // picker. Falls through to automatic if the chosen voice was since
        // uninstalled, rather than going silent.
        let chosen = EaonVoiceStore.shared.voiceIdentifier
        if !chosen.isEmpty, let voice = AVSpeechSynthesisVoice(identifier: chosen) {
            return voice
        }
        let language = Locale.current.identifier.replacingOccurrences(of: "_", with: "-")
        let prefix = String(language.prefix(2))
        let candidates = AVSpeechSynthesisVoice.speechVoices().filter { $0.language.hasPrefix(prefix) }
        guard !candidates.isEmpty else { return AVSpeechSynthesisVoice(language: language) }
        // Exact locale wins ties, so en-GB isn't read in a US accent on a
        // British Mac when both are installed at the same quality.
        return candidates.max {
            (qualityRank($0), $0.language == language ? 1 : 0) < (qualityRank($1), $1.language == language ? 1 : 0)
        }
    }

    static func qualityRank(_ voice: AVSpeechSynthesisVoice) -> Int {
        switch voice.quality {
        case .premium: return 3
        case .enhanced: return 2
        default: return 1
        }
    }

    /// Voices worth offering, best first. Novelty voices (Bubbles, Zarvox,
    /// Bad News and the rest of the 1980s synths) are filtered out — they're
    /// party tricks, not something anyone wants their assistant to sound
    /// like, and they bury the real voices in a 41-item list.
    static func selectableVoices() -> [AVSpeechSynthesisVoice] {
        let prefix = String(Locale.current.identifier.prefix(2))
        return AVSpeechSynthesisVoice.speechVoices()
            .filter { $0.language.hasPrefix(prefix) }
            .filter { !$0.identifier.contains("com.apple.speech.synthesis.voice") }
            .sorted {
                (qualityRank($0), $1.name) > (qualityRank($1), $0.name)
            }
    }

    /// True when this Mac has only the tiny built-in voices. **This is the
    /// real reason the pet sounds robotic**, and it isn't something the app
    /// can fix in code: macOS ships only `compact`/`super-compact` voices and
    /// downloads the lifelike `enhanced`/`premium` ones on demand. Measured
    /// on a stock machine: 180 voices installed, every single one `default`
    /// quality. The settings row uses this to say so plainly and point at
    /// the download, instead of leaving people to conclude the app is just
    /// bad at speech.
    static var onlyCompactVoicesInstalled: Bool {
        !AVSpeechSynthesisVoice.speechVoices().contains { $0.quality != .default }
    }

    /// Speak a sample in a candidate voice, for the picker's preview button.
    func preview(voiceIdentifier: String) {
        if synthesizer.isSpeaking { synthesizer.stopSpeaking(at: .immediate) }
        let utterance = AVSpeechUtterance(string: "Hi, I'm Eaon. This is how I'll sound when I talk to you.")
        utterance.voice = AVSpeechSynthesisVoice(identifier: voiceIdentifier) ?? Self.bestVoice()
        Self.applyProsody(to: utterance)
        synthesizer.speak(utterance)
    }

    /// Shared speaking style. A touch under the system default rate, because
    /// the stock rate on compact voices runs words together and is a large
    /// part of what reads as "robotic".
    static func applyProsody(to utterance: AVSpeechUtterance) {
        let multiplier = Float(EaonVoiceStore.shared.rateMultiplier)
        utterance.rate = AVSpeechUtteranceDefaultSpeechRate * max(0.5, min(1.5, multiplier))
        utterance.pitchMultiplier = 1.0
        utterance.postUtteranceDelay = 0
    }

    // MARK: - Wake phrase

    /// Spellings the on-device recognizer actually produces for "Hey Eaon".
    /// It has never heard the word, so it guesses at something phonetically
    /// close — an explicit list of the real-world variants is far more
    /// predictable than a loose pattern, which matches things like "hey
    /// again" and fires the assistant mid-conversation.
    private static let wakeVariants = [
        "hey eaon", "hey eon", "hey aeon", "hey ean", "hey eyon", "hey eion",
        "hey aon", "hey e on", "hey a on", "hey ion", "hey neon", "hey yon",
        "hi eaon", "hi eon", "hi aeon",
        "ok eaon", "okay eaon", "ok eon", "okay eon",
    ]

    /// The character offset just past the wake phrase, or nil if it isn't
    /// there. Matching is done on a punctuation-stripped copy so "Hey, Eaon."
    /// is heard the same as "hey eaon", but the offset returned indexes the
    /// ORIGINAL string so the caller can slice the command out of it.
    static func wakePhraseEnd(in transcript: String) -> Int? {
        let lower = transcript.lowercased()
        // Map each index of the cleaned string back to the original.
        var cleaned = ""
        var backIndex: [Int] = []
        for (offset, character) in lower.enumerated() {
            if character.isLetter || character.isWhitespace {
                cleaned.append(character.isWhitespace ? " " : character)
                backIndex.append(offset)
            }
        }
        // Collapse runs of spaces, keeping the mapping aligned.
        var squeezed = ""
        var squeezedBack: [Int] = []
        var lastWasSpace = false
        for (index, character) in cleaned.enumerated() {
            let isSpace = character == " "
            if isSpace && lastWasSpace { continue }
            squeezed.append(character)
            squeezedBack.append(backIndex[index])
            lastWasSpace = isSpace
        }
        for variant in wakeVariants {
            guard let range = squeezed.range(of: variant) else { continue }
            let endOffset = squeezed.distance(from: squeezed.startIndex, to: range.upperBound)
            // +1 so the offset lands past the matched character itself.
            let original = endOffset < squeezedBack.count
                ? squeezedBack[endOffset]
                : (squeezedBack.last.map { $0 + 1 } ?? 0)
            return min(original, transcript.count)
        }
        return nil
    }

    // MARK: - Text shaping

    /// The end of the last complete sentence in `text`, or nil if there isn't
    /// one yet. Used to decide how much of a still-streaming reply is safe to
    /// start reading aloud.
    static func lastSentenceBoundary(in text: String) -> String.Index? {
        var boundary: String.Index?
        var index = text.startIndex
        while index < text.endIndex {
            let character = text[index]
            if character == "\n" {
                // A line break always ends a spoken chunk, with no lookahead:
                // requiring whitespace after it (the rule the punctuation
                // below needs) meant a bulleted or multi-line reply — which
                // is most of them — never produced a boundary at all and so
                // never streamed. Caught in testing.
                boundary = text.index(after: index)
            } else if character == "." || character == "!" || character == "?" {
                let next = text.index(after: index)
                // A terminator only ends a sentence if whitespace (or the end
                // of what we have) follows — otherwise it's a decimal point,
                // a version number, or a file extension: "3.14", "file.txt".
                if next == text.endIndex || text[next].isWhitespace {
                    boundary = next
                }
            }
            index = text.index(after: index)
        }
        return boundary
    }

    /// Turn a markdown reply into something worth hearing.
    ///
    /// Read verbatim, a normal assistant answer is unbearable: the synthesizer
    /// pronounces "**" as "asterisk asterisk", reads bullet hyphens as
    /// "hyphen", and will happily recite an entire code block character by
    /// character. Code especially — nobody wants forty seconds of punctuation
    /// read at them, and it's the part a person reads on screen anyway.
    static func spokenText(from raw: String) -> String {
        // A reasoning model's <think> monologue is display-only and must
        // never be read aloud. Belt-and-braces: the streaming path already
        // works in visible space, but the public `speak(_:)` entry point
        // takes whatever it's handed.
        var text = ReasoningExtractor.extract(from: raw).visibleContent

        // Fenced code: replaced by a short spoken note, not deleted outright,
        // so "here's the function" isn't followed by silence.
        text = text.replacingOccurrences(
            of: "```[\\s\\S]*?```",
            with: " (code shown on screen) ",
            options: .regularExpression
        )
        // An unclosed fence — a reply that ended mid-code — would otherwise be
        // read out in full.
        text = text.replacingOccurrences(
            of: "```[\\s\\S]*$",
            with: " (code shown on screen) ",
            options: .regularExpression
        )
        // Inline code, keeping what's inside — `foo()` is usually a word the
        // sentence needs.
        text = text.replacingOccurrences(of: "`([^`]*)`", with: "$1", options: .regularExpression)
        // Images entirely — BEFORE links, because an image is a link with a
        // "!" in front and the link rule would otherwise consume the
        // bracketed part and leave the bare "!" behind, which the synthesizer
        // reads aloud as "exclamation mark" (caught in testing).
        text = text.replacingOccurrences(of: "!\\[[^\\]]*\\]\\([^)]*\\)", with: " ", options: .regularExpression)
        // Links: say the label, drop the URL.
        text = text.replacingOccurrences(of: "\\[([^\\]]+)\\]\\([^)]*\\)", with: "$1", options: .regularExpression)
        // Emphasis and heading markers.
        text = text.replacingOccurrences(of: "[*_]{1,3}", with: "", options: .regularExpression)
        text = text.replacingOccurrences(of: "(?m)^\\s{0,3}#{1,6}\\s*", with: "", options: .regularExpression)
        // Bullets and blockquotes become clean sentence starts.
        text = text.replacingOccurrences(of: "(?m)^\\s*[-*+]\\s+", with: "", options: .regularExpression)
        text = text.replacingOccurrences(of: "(?m)^\\s*>\\s?", with: "", options: .regularExpression)
        // Table pipes and horizontal rules read as noise.
        text = text.replacingOccurrences(of: "(?m)^\\s*\\|.*$", with: " ", options: .regularExpression)
        text = text.replacingOccurrences(of: "(?m)^\\s*([-*_]\\s*){3,}$", with: " ", options: .regularExpression)
        // Collapse the whitespace all of the above leaves behind.
        text = text.replacingOccurrences(of: "[ \\t]{2,}", with: " ", options: .regularExpression)
        text = text.replacingOccurrences(of: "\\n{3,}", with: "\n\n", options: .regularExpression)

        return text.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    // MARK: - State

    /// Single place the state changes, so the pet's face can't drift out of
    /// sync with what the microphone is actually doing.
    private func enter(_ next: EaonVoiceState) {
        guard state != next else { return }
        state = next
        switch next {
        case .listening: EaonPetController.shared.noteVoiceState(.listening)
        case .speaking: EaonPetController.shared.noteVoiceState(.speaking)
        case .off, .waking, .thinking: EaonPetController.shared.noteVoiceState(nil)
        }
        publishStatus()
    }

    /// Mirrors what the microphone is doing into the assistant panel, which
    /// is where the user is actually looking. Without this the whole feature
    /// was invisible: the pet's eyes changed shape and nothing else, so
    /// "listening", "heard you", and "silently failed" were indistinguishable.
    private func publishStatus() {
        let vm = QuickAssistantViewModel.shared
        switch state {
        case .listening:
            vm.composerNotice = partialTranscript.isEmpty
                ? "Listening — just talk, then press Enter to send."
                : "Listening — press Enter when you're done."
        case .waking:
            vm.composerNotice = "Say \u{201C}Hey Eaon\u{201D} to talk."
        case .thinking, .speaking, .off:
            // Only clear notices this controller owns — a screen-capture or
            // paste error posted by something else must survive.
            if Self.isVoiceNotice(vm.composerNotice) { vm.composerNotice = nil }
        }
    }

    private static func isVoiceNotice(_ notice: String?) -> Bool {
        guard let notice else { return false }
        return notice.hasPrefix("Listening") || notice.hasPrefix("Say \u{201C}Hey Eaon")
    }

    // MARK: - Permissions

    /// Microphone and speech recognition, both required, both asked for only
    /// when the user actually tries to talk — never at launch.
    /// Whether this build can legally ask for the microphone at all.
    ///
    /// macOS does not *deny* a TCC request that lacks its usage-description
    /// string — it **terminates the process**, SIGABRT, no catchable error.
    /// A bare `swift build` executable has no Info.plist whatsoever, so
    /// simply running the binary directly with voice switched on killed the
    /// app the instant it tried to listen (hit repeatedly during
    /// development, and it looks like a mystery crash rather than a missing
    /// build step). Checking first converts that into an explanation.
    private static var hasVoiceUsageDescriptions: Bool {
        let info = Bundle.main.infoDictionary
        let mic = (info?["NSMicrophoneUsageDescription"] as? String) ?? ""
        let speech = (info?["NSSpeechRecognitionUsageDescription"] as? String) ?? ""
        return !mic.isEmpty && !speech.isEmpty
    }

    private func ensurePermissions() async -> Bool {
        guard Self.hasVoiceUsageDescriptions else {
            fail("This build can't use the microphone: it's missing the microphone and speech-recognition usage descriptions in its Info.plist. That happens when the raw executable is run directly instead of the packaged Eaon.app — build with ./build-installer.sh and run the app bundle.")
            return false
        }
        let mic = await withCheckedContinuation { continuation in
            AVCaptureDevice.requestAccess(for: .audio) { continuation.resume(returning: $0) }
        }
        guard mic else {
            fail("Eaon needs microphone access to hear you. Turn it on in System Settings → Privacy & Security → Microphone.")
            return false
        }
        let speech = await withCheckedContinuation { continuation in
            SFSpeechRecognizer.requestAuthorization { continuation.resume(returning: $0) }
        }
        guard speech == .authorized else {
            fail("Eaon needs speech recognition access to understand you. Turn it on in System Settings → Privacy & Security → Speech Recognition.")
            return false
        }
        return true
    }

    private func fail(_ message: String) {
        teardownAudio()
        lastError = message
        partialTranscript = ""
        enter(.off)
        // Put it in front of the user, not only in Settings. A denied
        // microphone used to fail completely silently — the pet just sat
        // there looking idle, which is indistinguishable from working.
        QuickAssistantViewModel.shared.composerNotice = message
        DesktopAssistantController.shared.showPanel()
    }
}

extension EaonVoiceController: AVSpeechSynthesizerDelegate {
    nonisolated func speechSynthesizer(_ synthesizer: AVSpeechSynthesizer, didFinish utterance: AVSpeechUtterance) {
        Task { @MainActor in
            self.pendingUtterances = max(0, self.pendingUtterances - 1)
            // Only the LAST queued utterance ends the turn — a sentence
            // finishing mid-reply just means the next one is about to start.
            if self.pendingUtterances == 0, self.state == .speaking, self.replyWatchdog == nil {
                self.finishSpeakingTurn()
            }
        }
    }

    nonisolated func speechSynthesizer(_ synthesizer: AVSpeechSynthesizer, didCancel utterance: AVSpeechUtterance) {
        Task { @MainActor in
            self.pendingUtterances = max(0, self.pendingUtterances - 1)
        }
    }
}
