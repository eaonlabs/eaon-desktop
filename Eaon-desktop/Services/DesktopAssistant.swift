import AppKit
import Carbon.HIToolbox
import SwiftUI

/// Settings-backed switch for the floating desktop assistant (the menu bar
/// sparkle + Gemini-style "Ask Eaon" pill). On by default — turning it off
/// removes the status item, the panel, and the global hotkey together.
@MainActor
@Observable
final class DesktopAssistantStore {
    static let shared = DesktopAssistantStore()

    private static let key = "desktop_assistant_enabled"

    var isEnabled: Bool {
        didSet {
            UserDefaults.standard.set(isEnabled, forKey: Self.key)
            DesktopAssistantController.shared.applyEnabledState()
        }
    }

    private init() {
        isEnabled = UserDefaults.standard.object(forKey: Self.key) as? Bool ?? true
    }
}

/// A borderless, non-activating floating panel — Spotlight-style: it can
/// take keyboard focus for its text field without pulling the whole app
/// (and its main window) to the front over whatever the user is doing.
final class QuickAssistantPanel: NSPanel {
    override var canBecomeKey: Bool { true }
    override var canBecomeMain: Bool { false }

    /// Bring Eaon to the front the moment this panel is actually clicked.
    ///
    /// `.nonactivatingPanel` means clicking never activates the app — the
    /// panel becomes key while Eaon itself stays inactive. Plenty works in
    /// that state (typing, and anything that only moves the window, which is
    /// why the close button always behaved), but anything needing an ACTIVE
    /// app silently does nothing: SwiftUI `.popover`s never appear, so the +
    /// attachment menu is dead; `NSOpenPanel` won't open, so images and
    /// files can't be picked; and menus don't post. The result is a panel
    /// where a couple of controls work and the rest ignore you after you've
    /// clicked any other window — reported exactly that way.
    ///
    /// Activating on `becomeKey` rather than on show keeps the good half of
    /// the original design: summoning the panel still doesn't steal focus
    /// from whatever you were doing, and focus only moves once you
    /// deliberately click into it — the same bargain Spotlight makes.
    override func becomeKey() {
        super.becomeKey()
        activateAppIfNeeded()
    }

    /// The reliable hook. `becomeKey` is not enough on its own: a
    /// `.nonactivatingPanel` belonging to an INACTIVE app frequently isn't
    /// granted key status at all, so the override above never runs and the
    /// app stays inactive with its controls half-dead (measured — summoning
    /// the panel from an inactive Eaon left another app frontmost). Catching
    /// the mouse-down here fires on every click into the panel regardless of
    /// key status, which is exactly the case people hit: click another
    /// window, click back on the assistant, expect it to work.
    override func sendEvent(_ event: NSEvent) {
        switch event.type {
        case .leftMouseDown, .rightMouseDown, .otherMouseDown:
            activateAppIfNeeded()
        default:
            break
        }
        super.sendEvent(event)
    }

    private func activateAppIfNeeded() {
        guard !NSApp.isActive else { return }
        NSApp.activate(ignoringOtherApps: true)
    }
}

/// Hosting view that answers the FIRST click arriving while Eaon is inactive.
///
/// Both floating surfaces (this panel and the desktop pet) are
/// `.nonactivatingPanel`, which is the entire point of them: you can use Eaon
/// over Chrome without yanking focus away from Chrome. The cost, and it is a
/// real bug rather than a quirk, is that AppKit treats a click that lands
/// while the app is inactive as the click that *would have* activated it and
/// by default does NOT forward it to the view underneath. Every button in the
/// panel — send, close, new chat, the model picker — therefore did nothing
/// after you'd clicked any other window.
///
/// What made it read as random is that typing still worked: keystrokes go to
/// the focused text field once the panel is key, while clicks are routed by
/// hit-testing and were being swallowed. Activating the app some other way
/// (clicking the menu bar icon) restored normal routing — the "click the thing
/// at the top of the screen to un-stick it" dance.
///
/// Accepting first mouse hands that click straight to the content, which is
/// what an always-available overlay wants. Note this is deliberately NOT the
/// same as activating the app: focus stays where the user put it.
final class FirstMouseHostingView<Content: View>: NSHostingView<Content> {
    override func acceptsFirstMouse(for event: NSEvent?) -> Bool { true }
}

/// Owns everything window-side about the desktop assistant: the menu bar
/// status item, the floating panel, the ⌥Space global hotkey, and the
/// pill ↔ expanded frame animation. The chat engine lives separately in
/// `QuickAssistantViewModel`; the SwiftUI content in
/// `QuickAssistantPanelView`.
@MainActor
final class DesktopAssistantController: NSObject {
    static let shared = DesktopAssistantController()

    /// Posted by the controller right after the panel becomes key, so the
    /// SwiftUI content focuses its text field — scoped, unlike watching
    /// `NSWindow.didBecomeKeyNotification`, which fires for every window.
    static let focusInputNotification = Notification.Name("eaon.quickassistant.focus-input")
    /// External toggle hook: `DistributedNotificationCenter` name any
    /// script/launcher (Shortcuts, Raycast, a shell one-liner) can post to
    /// summon or dismiss the assistant without touching the menu bar.
    static let distributedToggleName = Notification.Name("dev.eaon.desktop.toggle-assistant")
    /// Posted whenever the panel appears, disappears, resizes (pill ↔
    /// expanded) or is dragged. The desktop pet listens so it can step aside
    /// rather than sit underneath the panel — see `EaonPetController.settle`.
    /// `nonisolated`: an immutable name, read from the window-move observer's
    /// Sendable closure as well as from main-actor code.
    nonisolated static let panelFrameChangedNotification = Notification.Name("eaon.quickassistant.frame-changed")

    private static let pillSize = NSSize(width: 440, height: 60)
    private static let expandedSize = NSSize(width: 440, height: 620)

    private var panel: QuickAssistantPanel?
    private var statusItem: NSStatusItem?
    private var hotKey: QuickAssistantHotKey?
    private var observingDistributed = false

    func applyEnabledState() {
        if DesktopAssistantStore.shared.isEnabled { setUp() } else { tearDown() }
    }

    /// The menu bar icon — the app's own `AquaMark` (the same orange
    /// rounded-square + glyph used in the sidebar and provider rows, not a
    /// generic SF Symbol), rasterized once and cached. Rendered explicitly
    /// non-template so it stays full-color in the menu bar, matching how
    /// most third-party status items already look rather than forcing it
    /// into the monochrome system-icon style.
    private static let menuBarIcon: NSImage = {
        let size: CGFloat = 18
        let renderer = ImageRenderer(content: AquaMark(size: size))
        renderer.scale = 2 // crisp on Retina; NSImage.size below fixes the logical point size regardless of backing pixels.
        let image = renderer.nsImage ?? NSImage(systemSymbolName: "sparkle", accessibilityDescription: nil) ?? NSImage()
        image.size = NSSize(width: size, height: size)
        image.isTemplate = false
        image.accessibilityDescription = "Eaon Assistant"
        return image
    }()

    private func setUp() {
        if statusItem == nil {
            let item = NSStatusBar.system.statusItem(withLength: NSStatusItem.squareLength)
            item.button?.image = Self.menuBarIcon
            item.button?.target = self
            item.button?.action = #selector(statusItemClicked)
            statusItem = item
        }
        if hotKey == nil {
            // nil when another app already owns ⌥Space (Raycast, ChatGPT…)
            // — the menu bar icon still works; no error surfaced because
            // there's nothing the user must fix.
            hotKey = QuickAssistantHotKey { [weak self] in self?.toggle() }
        }
        if !observingDistributed {
            observingDistributed = true
            DistributedNotificationCenter.default().addObserver(
                self,
                selector: #selector(distributedToggle),
                name: Self.distributedToggleName,
                object: nil,
                suspensionBehavior: .deliverImmediately
            )
        }
    }

    private func tearDown() {
        hidePanel()
        if let statusItem { NSStatusBar.system.removeStatusItem(statusItem) }
        statusItem = nil
        hotKey = nil
        if observingDistributed {
            DistributedNotificationCenter.default().removeObserver(self)
            observingDistributed = false
        }
    }

    @objc private func statusItemClicked() { toggle() }
    @objc private func distributedToggle() { toggle() }

    // MARK: - Show / hide / expand

    func toggle() {
        if let panel, panel.isVisible { hidePanel() } else { showPanel() }
    }

    func showPanel() {
        let panel = ensurePanel()
        let target = summonFrame(expanded: QuickAssistantViewModel.shared.isExpanded)
        panel.setFrame(target, display: true)
        panel.makeKeyAndOrderFront(nil)
        panel.orderFrontRegardless()
        // Re-asserted after ordering: window-server side effects during the
        // first order-front (hosting-view sizing, screen constraint) were
        // observed displacing the very first show.
        panel.setFrame(target, display: true)
        // Summoning is a deliberate act — you pressed ⌥Space, clicked the
        // menu bar icon, or clicked the pet — so bring Eaon forward. Without
        // this the panel appears while the app stays inactive, and every
        // control that needs an active app (the + menu's popover, the image
        // and file pickers) does nothing when clicked.
        if !NSApp.isActive { NSApp.activate(ignoringOtherApps: true) }
        NotificationCenter.default.post(name: Self.focusInputNotification, object: nil)
        notePanelGeometryChanged()
    }

    /// Every summon lands at the bottom-right of the screen the cursor is
    /// on — the Spotlight/Gemini convention. Dragging it elsewhere sticks
    /// for as long as it stays visible (pill ↔ expanded transitions anchor
    /// to the dragged spot via `frame(expanded:)`); the next fresh summon
    /// re-anchors here.
    private func summonFrame(expanded: Bool) -> NSRect {
        let size = expanded ? Self.expandedSize : Self.pillSize
        let mouse = NSEvent.mouseLocation
        let screen = NSScreen.screens.first { NSMouseInRect(mouse, $0.frame, false) }
            ?? NSScreen.main ?? NSScreen.screens[0]
        let visible = screen.visibleFrame
        return NSRect(
            x: visible.maxX - size.width - 24,
            y: visible.minY + 24,
            width: size.width,
            height: size.height
        )
    }

    func hidePanel() {
        panel?.orderOut(nil)
        notePanelGeometryChanged()
    }

    /// The panel's window number and current screen — read by the desktop
    /// pet so a screen capture taken for "My screen" can exclude the
    /// assistant's own chrome and target the display it's actually sitting
    /// on, without this controller needing to know anything about the pet.
    var panelWindowNumber: Int? { panel?.windowNumber }
    var currentScreen: NSScreen? { panel?.screen ?? NSScreen.main }

    /// The screen area the panel currently occupies, or nil when it isn't up.
    /// The pet reads this to keep itself out from under the panel.
    var panelFrame: NSRect? {
        guard let panel, panel.isVisible else { return nil }
        return panel.frame
    }

    private func notePanelGeometryChanged() {
        NotificationCenter.default.post(name: Self.panelFrameChangedNotification, object: nil)
    }

    /// Switches pill ↔ chat panel: flips the view model's state and animates
    /// the window to match, keeping the bottom-right corner planted where
    /// the user has it (so the panel grows upward out of the pill).
    func setExpanded(_ expanded: Bool) {
        guard QuickAssistantViewModel.shared.isExpanded != expanded else { return }
        QuickAssistantViewModel.shared.isExpanded = expanded
        guard let panel, panel.isVisible else { return }
        panel.setFrame(frame(expanded: expanded), display: true, animate: true)
        notePanelGeometryChanged()
    }

    /// Hands the quick conversation off to the main window: imports the
    /// transcript as a real conversation (via `ChatViewModel`'s observer),
    /// hides the panel, and brings the main app forward.
    func openMainApp(handOffTranscript: Bool) {
        if handOffTranscript {
            let turns = QuickAssistantViewModel.shared.transcript
                .filter { !$0.isError && !$0.text.isEmpty }
                .map { ["role": $0.isUser ? "user" : "assistant", "text": $0.text] }
            if !turns.isEmpty {
                NotificationCenter.default.post(
                    name: .eaonQuickAssistantHandoff,
                    object: nil,
                    userInfo: ["turns": turns]
                )
                QuickAssistantViewModel.shared.clear()
                setExpanded(false)
            }
        }
        hidePanel()
        NSApp.activate(ignoringOtherApps: true)
        let mainWindow = NSApp.windows.first { !($0 is NSPanel) && $0.canBecomeMain && $0.isVisible }
            ?? NSApp.windows.first { !($0 is NSPanel) && $0.canBecomeMain }
        mainWindow?.makeKeyAndOrderFront(nil)
    }

    // MARK: - Window plumbing

    private func ensurePanel() -> QuickAssistantPanel {
        if let panel { return panel }
        let panel = QuickAssistantPanel(
            contentRect: NSRect(origin: .zero, size: Self.pillSize),
            styleMask: [.borderless, .nonactivatingPanel],
            backing: .buffered,
            defer: false
        )
        panel.level = .floating
        panel.isOpaque = false
        panel.backgroundColor = .clear
        panel.hasShadow = true
        // NSPanel defaults to vanishing when the app deactivates — this one
        // lives on the desktop across app switches, like Spotlight.
        panel.hidesOnDeactivate = false
        panel.isMovableByWindowBackground = true
        panel.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary]
        panel.isReleasedWhenClosed = false
        let hosting = FirstMouseHostingView(rootView: QuickAssistantRootView())
        // The controller owns this window's size (pill vs. expanded) — an
        // empty sizing-options set stops the hosting view from re-sizing or
        // re-placing the window to SwiftUI's ideal size behind our back.
        hosting.sizingOptions = []
        panel.contentView = hosting
        panel.setFrame(defaultFrame(size: Self.pillSize), display: false)
        // Dragging the panel by its background moves it without going through
        // any method here, so the pet would keep dodging the OLD location —
        // republish the geometry as it actually moves.
        NotificationCenter.default.addObserver(
            forName: NSWindow.didMoveNotification, object: panel, queue: .main
        ) { _ in
            NotificationCenter.default.post(name: Self.panelFrameChangedNotification, object: nil)
        }
        self.panel = panel
        return panel
    }

    /// The frame for a state, anchored to the panel's current bottom-right
    /// corner (which follows the user's drags), clamped on-screen.
    private func frame(expanded: Bool) -> NSRect {
        let size = expanded ? Self.expandedSize : Self.pillSize
        guard let panel else { return defaultFrame(size: size) }
        let anchor = CGPoint(x: panel.frame.maxX, y: panel.frame.minY)
        var rect = NSRect(x: anchor.x - size.width, y: anchor.y, width: size.width, height: size.height)
        if let visible = (panel.screen ?? NSScreen.main)?.visibleFrame {
            if rect.maxY > visible.maxY { rect.origin.y = visible.maxY - size.height }
            if rect.minY < visible.minY { rect.origin.y = visible.minY }
            if rect.minX < visible.minX { rect.origin.x = visible.minX }
            if rect.maxX > visible.maxX { rect.origin.x = visible.maxX - size.width }
        }
        return rect
    }

    /// First-ever position: bottom-right of the main screen, Gemini-style,
    /// with a margin clear of the Dock (visibleFrame already excludes it).
    private func defaultFrame(size: NSSize) -> NSRect {
        let visible = (NSScreen.main ?? NSScreen.screens.first)?.visibleFrame
            ?? NSRect(x: 0, y: 0, width: 1440, height: 900)
        return NSRect(
            x: visible.maxX - size.width - 24,
            y: visible.minY + 24,
            width: size.width,
            height: size.height
        )
    }
}

extension Notification.Name {
    /// Carries the quick assistant's transcript into `ChatViewModel`, which
    /// imports it as a real conversation. userInfo: `["turns": [[String:
    /// String]]]` with `role` ("user"/"assistant") and `text`.
    static let eaonQuickAssistantHandoff = Notification.Name("eaon.quickassistant.handoff")
}

/// A single Carbon global hotkey (⌥Space) — the same mechanism ChatGPT's
/// and Gemini's Mac apps use for their overlays, and the only sanctioned
/// way to *consume* a system-wide keystroke without the Accessibility
/// permission an event tap would demand. `init` fails (returns nil) if
/// another app already registered the combination.
private final class QuickAssistantHotKey {
    private var hotKeyRef: EventHotKeyRef?
    private var handlerRef: EventHandlerRef?
    private let callback: @MainActor () -> Void

    init?(callback: @escaping @MainActor () -> Void) {
        self.callback = callback

        var eventType = EventTypeSpec(
            eventClass: OSType(kEventClassKeyboard),
            eventKind: UInt32(kEventHotKeyPressed)
        )
        let selfPointer = Unmanaged.passUnretained(self).toOpaque()
        let installStatus = InstallEventHandler(
            GetEventDispatcherTarget(),
            { _, _, userData -> OSStatus in
                guard let userData else { return noErr }
                let hotKey = Unmanaged<QuickAssistantHotKey>.fromOpaque(userData).takeUnretainedValue()
                Task { @MainActor in hotKey.callback() }
                return noErr
            },
            1,
            &eventType,
            selfPointer,
            &handlerRef
        )
        guard installStatus == noErr else { return nil }

        let hotKeyID = EventHotKeyID(signature: OSType(0x45414F4E) /* "EAON" */, id: 1)
        let registerStatus = RegisterEventHotKey(
            UInt32(kVK_Space),
            UInt32(optionKey),
            hotKeyID,
            GetEventDispatcherTarget(),
            0,
            &hotKeyRef
        )
        guard registerStatus == noErr, hotKeyRef != nil else {
            if let handlerRef { RemoveEventHandler(handlerRef) }
            return nil
        }
    }

    deinit {
        if let hotKeyRef { UnregisterEventHotKey(hotKeyRef) }
        if let handlerRef { RemoveEventHandler(handlerRef) }
    }
}
