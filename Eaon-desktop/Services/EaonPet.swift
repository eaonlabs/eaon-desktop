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

/// Owns the pet: its floating window, where it roams, its pointing hand,
/// and — the observable bits the view reads — its current `mood` and
/// pointing angle. Callers never set mood directly; they call the semantic
/// `note…`/`react…`/`wake`/`handleTap`/`pointAt` methods so the whole state
/// machine (react to tone, drift while working, wander when bored, point at
/// things found on screen, doze off when idle) lives in exactly one place.
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
    @ObservationIgnored private var wanderWork: DispatchWorkItem?
    @ObservationIgnored private var pointingWork: DispatchWorkItem?
    @ObservationIgnored private var observingDistributed = false
    /// The moment the current emotional reaction is allowed to end — a
    /// generation starting mid-reaction waits for this (capped) instead of
    /// stomping the feeling the instant it appeared.
    @ObservationIgnored private var emotionUntil = Date.distantPast

    /// Panel is bigger than the body so the pointing hand (which reaches
    /// ~105pt from center) never clips at the window edge — the extra area
    /// is fully transparent and click-through.
    static let petSize = NSSize(width: 224, height: 236)
    private static let idleToSleep: TimeInterval = 90

    private init() {}

    // MARK: - Enable / window

    func applyEnabledState() {
        EaonPetStore.shared.isEnabled ? show() : hide()
    }

    private func show() {
        let panel = ensurePanel()
        if !panel.isVisible {
            let v = (NSScreen.main ?? NSScreen.screens.first)?.visibleFrame
                ?? NSRect(x: 0, y: 0, width: 1440, height: 900)
            panel.setFrame(
                NSRect(x: v.maxX - Self.petSize.width - 16, y: v.minY + 16,
                       width: Self.petSize.width, height: Self.petSize.height),
                display: true
            )
        }
        panel.orderFrontRegardless()
        setUpDistributedHooks()
        // Wake, look alert, then doze off if nothing happens — so enabling
        // it feels like it noticed you, not like a static sticker.
        becomeReady()
    }

    private func hide() {
        cancelAllTimers()
        pointingAngle = nil
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
        panel.level = .floating
        panel.isOpaque = false
        panel.backgroundColor = .clear
        // The pet draws its own soft contact shadow; a window shadow would
        // wrap the square panel bounds, not the round body.
        panel.hasShadow = false
        panel.hidesOnDeactivate = false
        panel.isMovableByWindowBackground = true
        panel.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary, .stationary]
        panel.isReleasedWhenClosed = false
        let hosting = NSHostingView(rootView: EaonPetRootView())
        // The controller owns the window size; stop the hosting view from
        // resizing the panel to SwiftUI's ideal size behind our back.
        hosting.sizingOptions = []
        panel.contentView = hosting
        self.panel = panel
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
    /// while you're reading the reply was disruptive anyway). Roaming still
    /// happens when it's bored (`armWander`) and when it flies over to point.
    ///
    /// The one deliberate exception: if you JUST triggered an emotion (praise
    /// or an insult a beat ago), that feeling is allowed to finish its short
    /// hold before working takes over, so a "thanks!"→happy doesn't get
    /// stomped to working in the same frame.
    func noteGenerationStarted() {
        guard EaonPetStore.shared.isEnabled else { return }
        cancelIdle()
        cancelWander()
        driftWork?.cancel()
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
    func handleTap() {
        guard EaonPetStore.shared.isEnabled else { return }
        if mood == .sleep { becomeReady() }
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

    /// The one place "settle into ready" happens: arms both the boredom
    /// wander and the doze-off timer so every path back to idle behaves
    /// the same.
    private func becomeReady() {
        setMood(.ready)
        armIdleTimer()
        armWander()
    }

    private func setMood(_ next: EaonPetMood) {
        mood = next
    }

    // MARK: - Roaming

    /// Glance toward the destination, then glide there and land in
    /// `arrival`. Destination defaults to a random hop — capped at a
    /// stroll's distance so the pet reads as roaming the screen, not
    /// teleporting across it.
    private func drift(arrival: EaonPetMood, to destination: NSRect? = nil) {
        guard let panel, panel.isVisible else { setMood(arrival); return }
        let dest = destination ?? randomHopFrame()
        setMood(dest.midX >= panel.frame.midX ? .lookRight : .lookLeft)
        driftWork?.cancel()
        let move = DispatchWorkItem { [weak self, weak panel] in
            guard let self, let panel else { return }
            panel.setFrame(dest, display: true, animate: true)
            self.setMood(arrival)
            if arrival == .ready { self.armWander() }
        }
        driftWork = move
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.28, execute: move)
    }

    /// A nearby random spot on the pet's current screen: far enough to be a
    /// visible stroll (≥120pt), near enough to stay neighborly with where
    /// the user last dragged it.
    private func randomHopFrame() -> NSRect {
        let size = Self.petSize
        let screen = panel?.screen ?? NSScreen.main ?? NSScreen.screens.first
        let v = screen?.visibleFrame ?? NSRect(x: 0, y: 0, width: 1440, height: 900)
        let margin: CGFloat = 14
        let minX = v.minX + margin, maxX = v.maxX - size.width - margin
        let minY = v.minY + margin, maxY = v.maxY - size.height - margin
        let current = panel?.frame.origin ?? CGPoint(x: maxX, y: minY)
        for _ in 0..<6 {
            let dx = CGFloat.random(in: 140...480) * (Bool.random() ? 1 : -1)
            let dy = CGFloat.random(in: 90...300) * (Bool.random() ? 1 : -1)
            let x = min(max(current.x + dx, minX), maxX)
            let y = min(max(current.y + dy, minY), maxY)
            if abs(x - current.x) + abs(y - current.y) >= 120 {
                return NSRect(x: x, y: y, width: size.width, height: size.height)
            }
        }
        return NSRect(x: minX == maxX ? minX : CGFloat.random(in: min(minX, maxX)...max(minX, maxX)),
                      y: minY == maxY ? minY : CGFloat.random(in: min(minY, maxY)...max(minY, maxY)),
                      width: size.width, height: size.height)
    }

    /// Boredom stroll: while just sitting ready, occasionally wander to a
    /// new spot. Suppressed during conversations, emotions, and pointing;
    /// strolling does NOT reset the doze-off timer, so a bored pet still
    /// falls asleep eventually.
    private func armWander() {
        cancelWander()
        let work = DispatchWorkItem { [weak self] in
            guard let self, self.mood == .ready, self.pointingAngle == nil else { return }
            self.drift(arrival: .ready)
        }
        wanderWork = work
        DispatchQueue.main.asyncAfter(deadline: .now() + .random(in: 22...45), execute: work)
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
        cancelWander()
        cancelIdle()
        pointingWork?.cancel()
        pointingAngle = nil

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

        // Retract after the hold.
        let retract = DispatchWorkItem { [weak self] in
            guard let self else { return }
            self.pointingAngle = nil
            if self.mood == .ready { self.becomeReady() }
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
            self.cancelWander()
            self.setMood(.sleep)
        }
        idleWork = work
        DispatchQueue.main.asyncAfter(deadline: .now() + Self.idleToSleep, execute: work)
    }

    private func cancelIdle() { idleWork?.cancel(); idleWork = nil }
    private func cancelWander() { wanderWork?.cancel(); wanderWork = nil }
    private func cancelAllTimers() {
        cancelIdle()
        cancelWander()
        holdWork?.cancel(); holdWork = nil
        driftWork?.cancel(); driftWork = nil
        pointingWork?.cancel(); pointingWork = nil
    }
}
