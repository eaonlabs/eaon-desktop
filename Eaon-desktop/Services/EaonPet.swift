import AppKit
import SwiftUI

/// The expressions the desktop pet can wear. Each maps to something Eaon is
/// actually doing, so the face reads as a status indicator rather than
/// decoration. `working` renders as a two-frame seesaw in the view, and
/// `lookLeft`/`lookRight` double as the glance the pet throws in the direction
/// it's about to drift.
enum EaonPetMood: Equatable, Sendable {
    case sleep      // idle — no active conversation
    case ready      // awake, waiting for a prompt
    case working    // generating a reply
    case lookLeft
    case lookRight
    case wink       // finished a reply cleanly
    case angry      // pushback / refusal
    case error      // a run failed
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

/// A borderless, non-activating, always-present panel that hosts the pet. It
/// never takes keyboard focus (there's no text field) and never activates the
/// app when clicked, so it sits over other apps like a sticker — the same
/// window recipe as the Quick Assistant panel, minus the key-window ability.
final class EaonPetPanel: NSPanel {
    override var canBecomeKey: Bool { false }
    override var canBecomeMain: Bool { false }
}

/// Owns the pet: its floating window, where it perches, and — the observable
/// bit the face reads — its current `mood`. `EaonPetView` renders and animates
/// whatever mood this holds. Callers never set mood directly; they call the
/// semantic `note…`/`wake`/`handlePoke` methods so the whole state machine
/// (drift to a new spot on a new question, wink on success, wear the error
/// face on a failure, doze off when idle) lives in exactly one place.
@MainActor
@Observable
final class EaonPetController {
    static let shared = EaonPetController()

    /// Read by the face. Private setter: outside code goes through the
    /// `note…` methods so timers and drifts stay coordinated.
    private(set) var mood: EaonPetMood = .sleep

    @ObservationIgnored private var panel: EaonPetPanel?
    @ObservationIgnored private var idleWork: DispatchWorkItem?
    @ObservationIgnored private var holdWork: DispatchWorkItem?
    @ObservationIgnored private var driftWork: DispatchWorkItem?
    @ObservationIgnored private var perchIndex = 0

    private static let petSize = NSSize(width: 150, height: 172)
    private static let idleToSleep: TimeInterval = 40

    private init() {}

    // MARK: - Enable / window

    func applyEnabledState() {
        EaonPetStore.shared.isEnabled ? show() : hide()
    }

    private func show() {
        let panel = ensurePanel()
        panel.setFrame(perchFrame(at: perchIndex), display: true)
        panel.orderFrontRegardless()
        // Wake, look alert, then doze off if nothing happens — so enabling it
        // feels like it noticed you, not like a static sticker.
        setMood(.ready)
        armIdleTimer()
    }

    private func hide() {
        cancelAllTimers()
        panel?.orderOut(nil)
    }

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

    /// A new generation started — the pet drifts to a fresh perch (glancing
    /// that way first), then settles into its working seesaw.
    func noteGenerationStarted() {
        guard EaonPetStore.shared.isEnabled else { return }
        cancelIdle()
        cancelHold()
        driftToNextPerch()
    }

    /// A generation finished. A clean run gets a quick wink; a failed one
    /// wears the error face for a beat. Either way it returns to ready and
    /// then dozes off after a while.
    func noteGenerationEnded(hadError: Bool) {
        guard EaonPetStore.shared.isEnabled else { return }
        cancelHold()
        if hadError {
            setMood(.error)
            holdThen(2.4) { [weak self] in
                self?.setMood(.ready)
                self?.armIdleTimer()
            }
        } else {
            setMood(.wink)
            holdThen(1.2) { [weak self] in
                self?.setMood(.ready)
                self?.armIdleTimer()
            }
        }
    }

    /// Bring it to attention (e.g. the app came forward) without implying work.
    func wake() {
        guard EaonPetStore.shared.isEnabled, mood == .sleep else { return }
        cancelHold()
        setMood(.ready)
        armIdleTimer()
    }

    /// Playful reaction to a click on the pet: a wink if it's awake, or just
    /// wake it up if it was asleep.
    func handlePoke() {
        guard EaonPetStore.shared.isEnabled else { return }
        cancelHold()
        if mood == .sleep {
            setMood(.ready)
            armIdleTimer()
            return
        }
        setMood(.wink)
        holdThen(0.9) { [weak self] in
            self?.setMood(.ready)
            self?.armIdleTimer()
        }
    }

    private func setMood(_ next: EaonPetMood) {
        mood = next
    }

    // MARK: - Drift ("moves around based on the questions you ask it")

    private func driftToNextPerch() {
        guard let panel else { setMood(.working); return }
        perchIndex = (perchIndex + 1) % Self.perchCount
        let target = perchFrame(at: perchIndex)
        let goingRight = target.midX >= panel.frame.midX
        // Anticipation: glance toward where it's about to go, THEN glide there.
        setMood(goingRight ? .lookRight : .lookLeft)
        driftWork?.cancel()
        let move = DispatchWorkItem { [weak self, weak panel] in
            panel?.setFrame(target, display: true, animate: true)
            self?.setMood(.working)
        }
        driftWork = move
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.28, execute: move)
    }

    // MARK: - Perches

    private static let perchCount = 4

    /// Four resting spots on the current screen, alternating sides so every
    /// hop is a clear left/right move (making the anticipation glance read).
    private func perchFrame(at index: Int) -> NSRect {
        let size = Self.petSize
        let screen = panel?.screen ?? NSScreen.main ?? NSScreen.screens.first
        let v = screen?.visibleFrame ?? NSRect(x: 0, y: 0, width: 1440, height: 900)
        let margin: CGFloat = 20
        let right = v.maxX - size.width - margin
        let left = v.minX + margin
        let low = v.minY + margin
        let mid = v.midY - size.height / 2
        switch index {
        case 0: return NSRect(x: right, y: low, width: size.width, height: size.height)
        case 1: return NSRect(x: left, y: low, width: size.width, height: size.height)
        case 2: return NSRect(x: right, y: mid, width: size.width, height: size.height)
        default: return NSRect(x: left, y: mid, width: size.width, height: size.height)
        }
    }

    // MARK: - Timers (DispatchWorkItem so they're cheap to cancel/replace)

    private func armIdleTimer() {
        cancelIdle()
        let work = DispatchWorkItem { [weak self] in self?.setMood(.sleep) }
        idleWork = work
        DispatchQueue.main.asyncAfter(deadline: .now() + Self.idleToSleep, execute: work)
    }

    private func holdThen(_ delay: TimeInterval, _ action: @escaping () -> Void) {
        let work = DispatchWorkItem(block: action)
        holdWork = work
        DispatchQueue.main.asyncAfter(deadline: .now() + delay, execute: work)
    }

    private func cancelIdle() { idleWork?.cancel(); idleWork = nil }
    private func cancelHold() { holdWork?.cancel(); holdWork = nil }
    private func cancelAllTimers() {
        cancelIdle()
        cancelHold()
        driftWork?.cancel(); driftWork = nil
    }
}
