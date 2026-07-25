import AppKit
import SwiftUI

/// The expressions the desktop pet can wear. Each maps to something Eaon is
/// actually doing or feeling, so the face reads as a status indicator rather
/// than decoration. `working` renders as a two-frame seesaw in the view;
/// `lookLeft`/`lookRight` double as the glance the pet throws in the
/// direction it's about to drift; the rest are tone reactions classified
/// from conversation text (praise, jokes, insults, apologies, surprise…).
enum EaonPetMood: Equatable, Sendable {
    case sleep      // idle — no active conversation
    case ready      // awake, waiting for a prompt
    case working    // generating a reply, or looking at the screen
    case listening  // microphone open, hearing you out (see EaonVoice)
    case speaking   // reading a reply aloud
    case lookLeft
    case lookRight
    case wink       // finished a reply cleanly / playful
    case happy      // praised, or the reply itself is upbeat
    case laughing   // something funny — lol / haha / 😂
    case love       // adored — ❤️ / "i love you" / "you're the best"
    case surprised  // startled — wow / omg / ?! / 🤯
    case confused   // puzzled — huh / wdym / "makes no sense"
    case sad        // insulted, or the reply is apologetic/regretful
    case angry      // refusal / firm pushback
    case error      // a run failed
}

/// Keyword/emoji tone classifier for the pet's emotional reactions. A tiny
/// deterministic heuristic on purpose: it runs on every message with zero
/// latency and zero cost (no extra model call), works offline, and only ever
/// picks from the pet's own vocabulary — a wrong guess is a shrug, not a
/// failure. Emoji outrank keywords because they're the sender's own explicit
/// emotional signal.
enum EaonPetTone {
    /// How the pet feels about something the USER said to it. Order matters:
    /// emoji (the sender's explicit signal) first, then the most specific
    /// keyword groups, so "i love this, lol" lands on the stronger feeling.
    static func forUserMessage(_ raw: String) -> EaonPetMood? {
        // Emoji — explicit and unambiguous.
        if containsAny(raw, ["❤️", "😍", "🥰", "💖", "😘", "💕"]) { return .love }
        if containsAny(raw, ["😂", "🤣", "😹"]) { return .laughing }
        if containsAny(raw, ["😮", "😲", "🤯", "😱", "😳"]) { return .surprised }
        if containsAny(raw, ["😡", "😠", "🖕", "😤"]) { return .sad } // yelled at → hurt
        if containsAny(raw, ["😕", "😟", "🫤"]) { return .confused }

        let text = " " + raw.lowercased() + " "
        let insults = [
            "annoying", "stupid", "dumb", "useless", "shut up", "hate you",
            "hate u", "terrible", "awful", "worst", "you suck", "u suck",
            "trash", "garbage", "idiot", "bad bot",
        ]
        if insults.contains(where: text.contains) { return .sad }
        let love = [
            "i love you", "love you", "love u", "adorable", "you're the best",
            "youre the best", "best bot", "so cute", "ur cute", "you're cute", "marry",
        ]
        if love.contains(where: text.contains) { return .love }
        let laughing = [
            " lol ", " lmao", " lmfao", "haha", "hehe", " rofl", "so funny", "hilarious", " lolol",
        ]
        if laughing.contains(where: text.contains) { return .laughing }
        let surprised = [
            " wow ", " woah", " whoa", " omg ", "no way", "oh my", "what?!", "?!", "unbelievable",
        ]
        if surprised.contains(where: text.contains) { return .surprised }
        let confused = [
            "huh", "wdym", "what do you mean", "i don't understand", "i dont understand",
            "makes no sense", "confusing", "confused", "i'm lost", "im lost", "what??",
        ]
        if confused.contains(where: text.contains) { return .confused }
        let praise = [
            "thank", "awesome", "amazing", "great job", "good job", "well done",
            "perfect", "good boy", "good bot", "nice work", "brilliant", "genius",
        ]
        if praise.contains(where: text.contains) { return .happy }
        return nil
    }

    /// The mood carried by a reply the model generated.
    static func forReply(_ raw: String) -> EaonPetMood? {
        if containsAny(raw, ["🥰", "❤️", "😍"]) { return .love }
        if containsAny(raw, ["😂", "🤣"]) { return .laughing }
        if containsAny(raw, ["🎉", "😄", "😊", "🥳", "😁", "✅"]) { return .happy }
        if containsAny(raw, ["😅", "😉", "😜"]) { return .wink }
        if containsAny(raw, ["😮", "🤯", "😲"]) { return .surprised }
        if containsAny(raw, ["😢", "😔", "☹️", "😞"]) { return .sad }
        if containsAny(raw, ["😠", "😡"]) { return .angry }
        let text = raw.lowercased()
        if ["i can't help", "i cannot help", "i won't", "i refuse"].contains(where: text.contains) { return .angry }
        if ["sorry", "unfortunately", "apolog", "my mistake", "ouch"].contains(where: text.contains) { return .sad }
        if ["could you clarify", "not sure what you mean", "did you mean", "can you clarify"].contains(where: text.contains) { return .confused }
        if [" haha", " lol ", "hilarious"].contains(where: text.contains) { return .laughing }
        if ["done!", "all set", "you're welcome", "glad", "happy to help"].contains(where: text.contains) { return .happy }
        return nil
    }

    private static func containsAny(_ text: String, _ needles: [String]) -> Bool {
        needles.contains(where: text.contains)
    }
}

/// Settings-backed switch for the on-screen companion. Off by default — it's
/// opt-in, unlike the floating assistant (which defaults on). Flipping it
/// shows or removes the floating pet window immediately, matching how
/// `DesktopAssistantStore` gates its own panel.
@MainActor
@Observable
final class EaonPetStore {
    static let shared = EaonPetStore()

    private static let key = "desktop_pet_enabled"

    var isEnabled: Bool {
        didSet {
            UserDefaults.standard.set(isEnabled, forKey: Self.key)
            EaonPetController.shared.applyEnabledState()
        }
    }

    private init() {
        isEnabled = UserDefaults.standard.object(forKey: Self.key) as? Bool ?? false
    }
}

/// A borderless, non-activating, always-present panel that hosts the pet's
/// body. It never takes keyboard focus (the ask bubble is a separate panel
/// that does) and never activates the app when clicked, so it sits over
/// other apps like a sticker — the same window recipe as the Quick
/// Assistant panel, minus the key-window ability.
final class EaonPetPanel: NSPanel {
    override var canBecomeKey: Bool { false }
    override var canBecomeMain: Bool { false }
}

/// Owns the pet: its floating window, where it sits, its pointing hand,
/// and — the observable bits the view reads — its current `mood` and
/// pointing angle. Callers never set mood directly; they call the semantic
/// `note…`/`react…`/`wake`/`handleTap`/`pointAt` methods so the whole state
/// machine (react to tone, point at things found on screen, doze off when
/// idle) lives in exactly one place.
///
/// Movement policy, deliberately strict: the pet moves for a REASON or not
/// at all. It flies out to point at something and then comes straight back;
/// it steps aside when the Quick Assistant panel would otherwise cover it.
/// That is the complete list. It used to also take a random "boredom stroll"
/// every 22–45 seconds, which read as the thing wandering aimlessly around
/// the screen — removed, not tuned: there is no interval at which unprompted
/// drifting stops being a distraction on a window that floats over
/// everything else. Its resting place is `homeFrame`, which only ever
/// changes when the USER drags it somewhere.
///
/// Asking it about your screen is deliberately NOT a separate popup here —
/// that's the Quick Assistant's "My screen" attach
/// (`QuickAssistantViewModel.attachScreenCapture`); this controller just
/// supplies the pointing follow-up once that reply lands. One text surface
/// for the whole app, the pet as its animated face.
@MainActor
@Observable
final class EaonPetController {
    static let shared = EaonPetController()

    /// Read by the face. Private setter: outside code goes through the
    /// semantic methods so timers, drifts and emotions stay coordinated.
    private(set) var mood: EaonPetMood = .sleep
    /// When non-nil, the pointing hand is out, aimed at this angle in the
    /// view's coordinate space (radians; 0 = right, positive = clockwise,
    /// matching SwiftUI's y-down `rotationEffect`).
    private(set) var pointingAngle: Double?

    // Distributed hooks: any script/launcher (Shortcuts, Raycast, a shell
    // one-liner) can make the pet react, point somewhere, or ask a question
    // about the screen through the Quick Assistant — the same external-
    // integration convention `DesktopAssistantController.distributedToggleName`
    // established.
    static let distributedReactName = Notification.Name("dev.eaon.desktop.pet-react")
    static let distributedPointName = Notification.Name("dev.eaon.desktop.pet-point")
    static let distributedAskName = Notification.Name("dev.eaon.desktop.pet-ask")

    @ObservationIgnored private var panel: EaonPetPanel?
    @ObservationIgnored private var idleWork: DispatchWorkItem?
    @ObservationIgnored private var holdWork: DispatchWorkItem?
    @ObservationIgnored private var driftWork: DispatchWorkItem?
    @ObservationIgnored private var pointingWork: DispatchWorkItem?
    @ObservationIgnored private var observingDistributed = false
    /// Where the pet belongs when it has nothing to do. Starts at its default
    /// corner and thereafter only ever changes when the USER drags it — the
    /// pet never picks a new resting place for itself.
    @ObservationIgnored private var homeFrame: NSRect?
    /// The last frame this controller asked for. The drag observer compares
    /// the window's CURRENT frame against it — see `observePetDrags` for why
    /// that specific comparison is what makes this correct.
    @ObservationIgnored fileprivate var lastProgrammaticFrame: NSRect?
    /// True from the start of a `pointAt` flight until the hand retracts —
    /// the one window in which the pet is legitimately away from home, so an
    /// assistant-panel move must not yank it back mid-gesture.
    @ObservationIgnored private var isPointing = false
    @ObservationIgnored private var petMoveObserver: NSObjectProtocol?
    @ObservationIgnored private var assistantObserver: NSObjectProtocol?
    /// The moment the current emotional reaction is allowed to end — a
    /// generation starting mid-reaction waits for this (capped) instead of
    /// stomping the feeling the instant it appeared.
    @ObservationIgnored private var emotionUntil = Date.distantPast

    /// Panel is bigger than the body so the pointing hand (which reaches
    /// ~105pt from center) never clips at the window edge — the extra area
    /// is fully transparent and click-through.
    static let petSize = NSSize(width: 224, height: 236)
    private static let idleToSleep: TimeInterval = 90
    /// Breathing room from the screen edge at the pet's home corner.
    private static let edgeGap: CGFloat = 16
    /// Clearance kept between the pet and the assistant panel when dodging —
    /// enough that the two read as sitting beside each other, not touching.
    private static let assistantGap: CGFloat = 12

    private init() {}

    // MARK: - Enable / window

    func applyEnabledState() {
        EaonPetStore.shared.isEnabled ? show() : hide()
    }

    private func show() {
        let panel = ensurePanel()
        if !panel.isVisible {
            // Placed via restingFrame, not a raw corner: if the assistant is
            // already up in that same bottom-right corner (its own default),
            // the pet lands beside it rather than on top of it.
            moveProgrammatically(to: restingFrame(), animate: false)
        }
        panel.orderFrontRegardless()
        setUpDistributedHooks()
        observeAssistantPanel()
        // Wake, look alert, then doze off if nothing happens — so enabling
        // it feels like it noticed you, not like a static sticker.
        becomeReady()
    }

    private func hide() {
        cancelAllTimers()
        pointingAngle = nil
        isPointing = false
        panel?.orderOut(nil)
    }

    /// The panel's window number — read by `QuickAssistantViewModel` so a
    /// "My screen" capture excludes the pet's own chrome (body + pointing
    /// hand) from the shot.
    var windowNumber: Int? { panel?.windowNumber }

    private func ensurePanel() -> EaonPetPanel {
        if let panel { return panel }
        let panel = EaonPetPanel(
            contentRect: NSRect(origin: .zero, size: Self.petSize),
            styleMask: [.borderless, .nonactivatingPanel],
            backing: .buffered,
            defer: false
        )
        // One level ABOVE the Quick Assistant panel (which is plain
        // `.floating`). At the same level the two are ordered by recency, and
        // the assistant — which orders front and takes key focus every time
        // it's summoned — always won, burying the pet under it. The pet also
        // moves out of the panel's way (see `restingFrame`), so this is the
        // belt to that braces: even mid-drag, or in the instant before the
        // dodge lands, the pet stays visible instead of disappearing.
        panel.level = NSWindow.Level(rawValue: NSWindow.Level.floating.rawValue + 1)
        panel.isOpaque = false
        panel.backgroundColor = .clear
        // The pet draws its own soft contact shadow; a window shadow would
        // wrap the square panel bounds, not the round body.
        panel.hasShadow = false
        panel.hidesOnDeactivate = false
        panel.isMovableByWindowBackground = true
        panel.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary, .stationary]
        panel.isReleasedWhenClosed = false
        // Same first-click problem as the assistant panel (see
        // `FirstMouseHostingView`): without this, tapping the pet while any
        // other app is focused did nothing at all.
        let hosting = FirstMouseHostingView(rootView: EaonPetRootView())
        // The controller owns the window size; stop the hosting view from
        // resizing the panel to SwiftUI's ideal size behind our back.
        hosting.sizingOptions = []
        panel.contentView = hosting
        self.panel = panel
        observePetDrags(panel)
        return panel
    }

    // MARK: - Mood API (the only way in)

    /// React to something the user just said (either surface — main chat or
    /// Quick Assistant). Insults hurt, praise delights; neutral text does
    /// nothing. Also wakes a sleeping pet: being spoken to is attention.
    func reactToUserMessage(_ text: String) {
        guard EaonPetStore.shared.isEnabled else { return }
        let reaction = EaonPetTone.forUserMessage(text)
        if mood == .sleep, reaction == nil {
            wake()
            return
        }
        guard let reaction else { return }
        react(reaction)
    }

    /// A new generation started — the pet reacts INSTANTLY, flipping to its
    /// working face in place the moment you hit send. It no longer glances-
    /// then-drifts-to-a-new-spot first (that ~0.3s+ of animation before any
    /// visible change is exactly the "it lags when I ask it something" the
    /// pet was called out for, and wandering away from the assistant panel
    /// while you're reading the reply was disruptive anyway). The only travel
    /// left anywhere is the flight out to point at something.
    ///
    /// The one deliberate exception: if you JUST triggered an emotion (praise
    /// or an insult a beat ago), that feeling is allowed to finish its short
    /// hold before working takes over, so a "thanks!"→happy doesn't get
    /// stomped to working in the same frame.
    func noteGenerationStarted() {
        guard EaonPetStore.shared.isEnabled else { return }
        cancelIdle()
        // NOT `driftWork?.cancel()` any more. That existed to kill the old
        // random boredom-stroll when a generation began — and once wandering
        // was removed, the only things left on that work item are the flight
        // out to point at something and the step aside from the assistant
        // panel. Cancelling it here meant the dodge scheduled 0.28s earlier
        // (when the panel opened) was destroyed by the send that opened it,
        // so the pet sat squarely on top of the panel for the whole reply —
        // observed live, 36 seconds of overlap.
        let remaining = emotionUntil.timeIntervalSinceNow
        if remaining > 0.1 {
            holdWork?.cancel()
            let work = DispatchWorkItem { [weak self] in self?.setMood(.working) }
            holdWork = work
            DispatchQueue.main.asyncAfter(deadline: .now() + min(remaining, 1.0), execute: work)
        } else {
            holdWork?.cancel()
            setMood(.working)
        }
    }

    /// A generation finished. The reply's own tone picks the reaction
    /// (upbeat → happy, apologetic → sad, refusal → angry) with a clean-run
    /// wink as the neutral default; a failed run wears the error face.
    func noteGenerationEnded(hadError: Bool, replyText: String?) {
        guard EaonPetStore.shared.isEnabled else { return }
        if hadError {
            react(.error)
            return
        }
        let reaction = replyText.flatMap(EaonPetTone.forReply) ?? .wink
        react(reaction)
    }

    /// The voice loop's current state, shown on the pet's face. Kept as its
    /// own entry point rather than reusing `react`/`noteGenerationStarted`
    /// because these two moods must NOT time out and settle back to ready on
    /// their own — the face has to keep saying "the microphone is open" for
    /// exactly as long as it actually is. `nil` hands control back to the
    /// normal state machine.
    func noteVoiceState(_ voice: EaonPetMood?) {
        guard EaonPetStore.shared.isEnabled else { return }
        cancelIdle()
        holdWork?.cancel()
        if let voice {
            setMood(voice)
        } else if mood == .listening || mood == .speaking {
            becomeReady()
        }
    }

    /// Bring it to attention (e.g. it was spoken to) without implying work.
    func wake() {
        guard EaonPetStore.shared.isEnabled, mood == .sleep else { return }
        holdWork?.cancel()
        becomeReady()
    }

    /// A click on the body: squish feedback happens view-side; here it
    /// wakes a sleeping pet and opens (or closes) the Quick Assistant — the
    /// pet's face IS the assistant's, so tapping it is how you talk to it.
    /// Asking about the screen itself happens there too, via its "My
    /// screen" attach — not a second popup.
    ///
    /// With voice turned on, tapping instead starts (or ends) listening —
    /// "talk to it" becomes literal. The panel still opens, because
    /// `EaonVoiceController` shows the question and the reply there; what
    /// changes is that the click opens your mouth rather than the keyboard.
    /// Voice off leaves this exactly as it was.
    func handleTap() {
        guard EaonPetStore.shared.isEnabled else { return }
        if mood == .sleep { becomeReady() }
        if EaonVoiceStore.shared.isEnabled {
            EaonVoiceController.shared.toggleListening()
            return
        }
        DesktopAssistantController.shared.toggle()
    }

    /// Show an emotion, hold it for a feeling-appropriate beat, then settle
    /// back to ready (unless a generation takes over meanwhile).
    private func react(_ reaction: EaonPetMood) {
        cancelIdle()
        holdWork?.cancel()
        setMood(reaction)
        let hold: TimeInterval
        switch reaction {
        case .sad, .angry: hold = 3.0
        case .error: hold = 2.4
        case .laughing: hold = 2.6
        case .love: hold = 2.4
        case .happy: hold = 1.8
        case .surprised: hold = 1.6
        case .confused: hold = 1.8
        default: hold = 1.2
        }
        emotionUntil = Date().addingTimeInterval(hold)
        let work = DispatchWorkItem { [weak self] in
            guard let self, self.mood == reaction else { return }
            self.becomeReady()
        }
        holdWork = work
        DispatchQueue.main.asyncAfter(deadline: .now() + hold, execute: work)
    }

    /// The one place "settle into ready" happens: arms the doze-off timer so
    /// every path back to idle behaves the same.
    private func becomeReady() {
        setMood(.ready)
        armIdleTimer()
    }

    private func setMood(_ next: EaonPetMood) {
        mood = next
    }

    // MARK: - Where the pet sits

    /// Glance toward the destination, then glide there and land in `arrival`.
    /// Only ever called with an explicit destination the pet has a reason to
    /// be at — the pointing perch, or its own home.
    private func drift(arrival: EaonPetMood, to destination: NSRect) {
        guard let panel, panel.isVisible else { setMood(arrival); return }
        setMood(destination.midX >= panel.frame.midX ? .lookRight : .lookLeft)
        driftWork?.cancel()
        let move = DispatchWorkItem { [weak self] in
            guard let self else { return }
            self.moveProgrammatically(to: destination, animate: true)
            self.setMood(arrival)
        }
        driftWork = move
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.28, execute: move)
    }

    /// Move the window ourselves, flagged so the drag observer doesn't mistake
    /// our own animation for the user repositioning the pet. `setFrame` runs
    /// its animation synchronously, so the flag covers every frame of it.
    private func moveProgrammatically(to frame: NSRect, animate: Bool) {
        guard let panel else { return }
        lastProgrammaticFrame = frame
        panel.setFrame(frame, display: true, animate: animate)
    }

    /// The pet's default corner on a given screen: bottom-right, the spot it
    /// has always started in.
    private func defaultHomeFrame(in visible: NSRect) -> NSRect {
        NSRect(
            x: visible.maxX - Self.petSize.width - Self.edgeGap,
            y: visible.minY + Self.edgeGap,
            width: Self.petSize.width,
            height: Self.petSize.height
        )
    }

    /// Where the pet should be sitting right now: its home, clamped onto the
    /// current screen, stepped aside if the assistant panel would cover it.
    private func restingFrame() -> NSRect {
        let size = Self.petSize
        let screen = panel?.screen ?? NSScreen.main ?? NSScreen.screens.first
        let v = screen?.visibleFrame ?? NSRect(x: 0, y: 0, width: 1440, height: 900)

        // Re-clamp every time: the display arrangement may have changed since
        // the home was recorded (laptop undocked, resolution switched).
        var home = homeFrame ?? defaultHomeFrame(in: v)
        home.origin.x = min(max(home.origin.x, v.minX + Self.edgeGap), v.maxX - size.width - Self.edgeGap)
        home.origin.y = min(max(home.origin.y, v.minY + Self.edgeGap), v.maxY - size.height - Self.edgeGap)

        guard let assistant = DesktopAssistantController.shared.panelFrame,
              assistant.intersects(home) else { return home }
        return dodging(assistant, from: home, in: v) ?? home
    }

    /// The nearest resting spot that clears the assistant panel. Preference
    /// order is sideways first — left of the panel, then right — because the
    /// panel lives in a bottom corner and stepping sideways keeps the pet in
    /// the band the user already put it in; above/below are the fallbacks for
    /// a panel dragged flat against a side. Nil when nothing on this screen
    /// fits, in which case the caller keeps the pet home and the raised
    /// window level alone keeps it visible.
    private func dodging(_ blocked: NSRect, from home: NSRect, in visible: NSRect) -> NSRect? {
        let size = Self.petSize
        let gap = Self.assistantGap
        let candidates = [
            NSRect(x: blocked.minX - size.width - gap, y: home.minY, width: size.width, height: size.height),
            NSRect(x: blocked.maxX + gap, y: home.minY, width: size.width, height: size.height),
            NSRect(x: home.minX, y: blocked.maxY + gap, width: size.width, height: size.height),
            NSRect(x: home.minX, y: blocked.minY - size.height - gap, width: size.width, height: size.height),
        ]
        return candidates.first { visible.contains($0) && !$0.intersects(blocked) }
    }

    /// Park the pet where it belongs. This is the ONLY movement that happens
    /// without the user asking for something — and it's a return to a place
    /// it already owns, never a wander to somewhere new.
    private func settle() {
        guard let panel, panel.isVisible else { return }
        let destination = restingFrame()
        guard destination != panel.frame else { return }
        drift(arrival: mood == .sleep ? .sleep : .ready, to: destination)
    }

    /// Re-park in response to the assistant panel moving — but never while
    /// the pet is out pointing at something, where being yanked home mid-
    /// gesture would read as a glitch rather than good manners.
    private func settleIfIdle() {
        guard EaonPetStore.shared.isEnabled, !isPointing else { return }
        settle()
    }

    /// Follow the assistant panel so the pet can step out of its way as it
    /// appears, expands, collapses, moves, or goes away.
    private func observeAssistantPanel() {
        guard assistantObserver == nil else { return }
        assistantObserver = NotificationCenter.default.addObserver(
            forName: DesktopAssistantController.panelFrameChangedNotification,
            object: nil,
            queue: .main
        ) { _ in
            Task { @MainActor in EaonPetController.shared.settleIfIdle() }
        }
    }

    /// Record where the user drags the pet as its new home, so "go back where
    /// you belong" means where THEY put it, not where we first placed it.
    /// Our own animated moves report through this same notification and are
    /// filtered out by `isProgrammaticMove`.
    ///
    /// Two things here are load-bearing, both learned from a crash.
    ///
    /// **No `MainActor.assumeIsolated`.** The previous version delivered this
    /// synchronously (`queue: nil`) and asserted main-actor isolation to read
    /// a flag while it was still set. That segfaulted inside
    /// `swift_task_isCurrentExecutorWithFlagsImpl`: the notification is posted
    /// from deep inside `-[NSWindow _setFrameCommon:display:fromServer:]`,
    /// where the Swift concurrency runtime cannot reliably resolve the
    /// current executor, and the check dereferenced garbage. It fired on
    /// every window move, so the app crashed in ordinary use. Hopping through
    /// a `Task { @MainActor }` is the only safe way in from here.
    ///
    /// **Compare the window's CURRENT frame, not the notification's.** That's
    /// what makes an async hop correct despite an animated `setFrame`
    /// reporting every intermediate frame: by the time this body runs the
    /// animation has settled, so our own moves read back exactly the
    /// destination we asked for and compare equal, while a real drag ends
    /// somewhere else. No flag, no timing window, nothing to get wrong.
    private func observePetDrags(_ panel: EaonPetPanel) {
        guard petMoveObserver == nil else { return }
        petMoveObserver = NotificationCenter.default.addObserver(
            forName: NSWindow.didMoveNotification, object: panel, queue: .main
        ) { [weak panel] _ in
            Task { @MainActor in
                guard let panel else { return }
                let controller = EaonPetController.shared
                let current = panel.frame
                guard controller.lastProgrammaticFrame != current else { return }
                controller.homeFrame = current
            }
        }
    }

    // MARK: - Pointing

    /// Fly next to `screenPoint` (global NSScreen coordinates, y-up) and
    /// extend the hand at it. The pet perches to the side of the target —
    /// offset toward the screen's center so neither body nor hand covers
    /// the thing it's pointing at — holds the point, then relaxes.
    func pointAt(screenPoint target: CGPoint, holdFor holdSeconds: TimeInterval = 7) {
        guard EaonPetStore.shared.isEnabled else { return }
        let panel = ensurePanel()
        if !panel.isVisible { show() }
        cancelIdle()
        pointingWork?.cancel()
        pointingAngle = nil
        isPointing = true

        let screen = NSScreen.screens.first { NSPointInRect(target, $0.frame) }
            ?? panel.screen ?? NSScreen.main
        let v = screen?.visibleFrame ?? NSRect(x: 0, y: 0, width: 1440, height: 900)

        // Perch beside the target, biased toward screen center.
        var dir = CGVector(dx: v.midX - target.x, dy: v.midY - target.y)
        let len = max(1, hypot(dir.dx, dir.dy))
        dir = CGVector(dx: dir.dx / len, dy: dir.dy / len)
        let size = Self.petSize
        var center = CGPoint(x: target.x + dir.dx * 190, y: target.y + dir.dy * 190)
        center.x = min(max(center.x, v.minX + size.width / 2 + 8), v.maxX - size.width / 2 - 8)
        center.y = min(max(center.y, v.minY + size.height / 2 + 8), v.maxY - size.height / 2 - 8)
        let dest = NSRect(x: center.x - size.width / 2, y: center.y - size.height / 2,
                          width: size.width, height: size.height)

        drift(arrival: .ready, to: dest)

        // Extend the hand once the glide lands. Angle is computed from the
        // final perch (y flipped: screen coords are y-up, the view's
        // rotationEffect is y-down).
        let extend = DispatchWorkItem { [weak self] in
            guard let self else { return }
            let dx = target.x - center.x
            let dyUp = target.y - center.y
            self.pointingAngle = atan2(-dyUp, dx)
        }
        pointingWork = extend
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.75, execute: extend)

        // Retract after the hold, then walk back home. The flight out was for
        // a reason; staying wherever it landed afterwards is exactly the
        // "it's just sitting somewhere random now" half of aimless drifting.
        let retract = DispatchWorkItem { [weak self] in
            guard let self else { return }
            self.pointingAngle = nil
            self.isPointing = false
            if self.mood == .ready { self.becomeReady() }
            self.settle()
        }
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.75 + holdSeconds, execute: retract)
    }

    // MARK: - Distributed hooks

    private func setUpDistributedHooks() {
        guard !observingDistributed else { return }
        observingDistributed = true
        let center = DistributedNotificationCenter.default()
        center.addObserver(
            forName: Self.distributedReactName, object: nil, queue: .main
        ) { note in
            let text = note.object as? String ?? ""
            Task { @MainActor in EaonPetController.shared.reactToUserMessage(text) }
        }
        center.addObserver(
            forName: Self.distributedPointName, object: nil, queue: .main
        ) { note in
            let parts = (note.object as? String ?? "").split(separator: ",").compactMap { Double($0.trimmingCharacters(in: .whitespaces)) }
            guard parts.count == 2 else { return }
            Task { @MainActor in
                EaonPetController.shared.pointAt(screenPoint: CGPoint(x: parts[0], y: parts[1]))
            }
        }
        center.addObserver(
            forName: Self.distributedAskName, object: nil, queue: .main
        ) { note in
            guard let question = note.object as? String, !question.isEmpty else { return }
            // Routed through the real assistant, exactly as if the user had
            // clicked "My screen" and typed the question themselves.
            Task { @MainActor in
                let vm = QuickAssistantViewModel.shared
                DesktopAssistantController.shared.showPanel()
                DesktopAssistantController.shared.setExpanded(true)
                await vm.attachScreenCapture()
                vm.inputText = question
                vm.send()
            }
        }
    }

    // MARK: - Timers (DispatchWorkItem so they're cheap to cancel/replace)

    private func armIdleTimer() {
        cancelIdle()
        let work = DispatchWorkItem { [weak self] in
            guard let self, self.mood == .ready else { return }
            self.setMood(.sleep)
        }
        idleWork = work
        DispatchQueue.main.asyncAfter(deadline: .now() + Self.idleToSleep, execute: work)
    }

    private func cancelIdle() { idleWork?.cancel(); idleWork = nil }
    private func cancelAllTimers() {
        cancelIdle()
        holdWork?.cancel(); holdWork = nil
        driftWork?.cancel(); driftWork = nil
        pointingWork?.cancel(); pointingWork = nil
    }
}
