import AppKit
import SwiftUI

final class AppDelegate: NSObject, NSApplicationDelegate {
    func applicationDidFinishLaunching(_ notification: Notification) {
        NSApp.setActivationPolicy(.regular)
        activateApp()
        // Registers the bundled Plex fonts before any view can ask for them
        // — AppFont also self-registers lazily on first use, so this is a
        // belt-and-suspenders call to avoid any first-render flash rather
        // than something the fonts strictly depend on.
        AppFonts.registerIfNeeded()
        // Build the shared network session from any saved proxy settings
        // before the first outbound request (update check, plugin reconnect,
        // chat) — otherwise a proxy-configured user's earliest traffic would
        // briefly bypass their proxy.
        MainActor.assumeIsolated { _ = ProxyStore.shared }
        // Menu bar sparkle + floating "Ask Eaon" panel (⌥Space) — created
        // here so it exists even before (or without) the main window.
        MainActor.assumeIsolated { DesktopAssistantController.shared.applyEnabledState() }
        // Hands-free voice, if the user already turned it on AND already
        // granted microphone access: resumes silently.
        //
        // `mayPrompt: false` is the important part and must stay that way.
        // Eaon must never ask for the microphone just because it opened —
        // an app that does that looks like it wants to listen to you no
        // matter how good its reasons are, and this one is a privacy-first
        // app whose voice feature is off by default anyway. Permission is
        // requested only when someone deliberately switches voice on.
        // With voice off (the default) this does nothing at all.
        MainActor.assumeIsolated { EaonVoiceController.shared.applyEnabledState(mayPrompt: false) }
        // Local, loopback-only listener the browser extension pairs with —
        // only when Device Control is already switched on.
        MainActor.assumeIsolated {
            if DesktopControlStore.shared.isEnabled { BrowserBridge.shared.start() }
        }
        // Forces the bundled curated-model JSON to load and validate right
        // now, at launch — rather than lazily whenever a user first opens
        // the Models tab — so a bad entry (missing file, bad JSON, an
        // unrecognized brand string) crashes immediately and obviously
        // during any normal test pass, not quietly later.
        Task { @MainActor in
            _ = LocalAIManager.curatedOllamaModels
        }
        // Background update check — shows the "New Version" card only when
        // a genuinely newer, non-snoozed release exists; silent otherwise
        // (including when the update server is unreachable).
        Task { @MainActor in
            await UpdateChecker.shared.checkOnLaunch()
        }
        // Same idea, for the bundled Eaon CLI install — silent unless
        // something's already installed and this app build bundles a
        // newer copy.
        Task { @MainActor in
            await EaonCLIUpdateStore.shared.checkOnLaunch()
        }
        // Silent, same as above — a stale/expired plugin token shouldn't
        // greet the user with an error before they've asked for anything,
        // it should just leave that Plugins row showing "Connect" again.
        Task { @MainActor in
            await MCPConnectionStore.shared.reconnectAllAtLaunch()
        }
        // Restarts the local API server if it was left on last session —
        // `applySettings()` reads `LocalAPIServerStore.isEnabled` itself,
        // so this is a no-op when the user never turned it on.
        Task { @MainActor in
            LocalAPIServer.shared.applySettings()
        }
    }

    /// Ends anything the coding agent left running in the background.
    ///
    /// A dev server the agent started is the session's, not the machine's:
    /// without this, quitting Eaon leaves `npm run dev` holding port 3000
    /// with no window anywhere to explain why, and the user has to go
    /// hunting in Activity Monitor for a process they never started
    /// themselves.
    func applicationWillTerminate(_ notification: Notification) {
        BackgroundJobs.shared.stopAll()
    }

    func applicationDidBecomeActive(_ notification: Notification) {
        activateApp()
    }

    private func activateApp() {
        NSApp.activate(ignoringOtherApps: true)
    }
}

@main
struct EaonDesktopApp: App {
    @NSApplicationDelegateAdaptor(AppDelegate.self) private var appDelegate

    var body: some Scene {
        WindowGroup {
            RootView()
                .frame(minWidth: 800, minHeight: 600)
                .background(AppWindowActivator())
        }
        .windowStyle(.hiddenTitleBar)
        .commands {
            SidebarCommands()
        }

        // A real, separate app window (not a modal sheet, not the system
        // browser) for viewing a model's actual page — one per distinct URL;
        // opening the same URL twice brings the existing pop-up forward
        // instead of duplicating it, which is `WindowGroup(for:)`'s default
        // behavior.
        WindowGroup("Model Page", for: URL.self) { $url in
            if let url {
                ModelBrowserWindow(url: url)
            }
        }
        .defaultSize(width: 920, height: 720)
    }
}

/// Brings the Aqua Chat window to the front and makes it the key window for keyboard input.
struct AppWindowActivator: NSViewRepresentable {
    func makeNSView(context: Context) -> NSView {
        let view = NSView(frame: .zero)
        view.isHidden = true
        Self.pollForWindow(view: view, attempts: 0)
        return view
    }

    func updateNSView(_ nsView: NSView, context: Context) {
        // Re-apply on every SwiftUI update, inside an async hop so the view is
        // actually attached to its window by the time we read `.window`.
        // ONLY this representable's own window — no first-visible-window
        // fallback here (unlike the launch-time poll below, which runs when
        // the main window is the only one): this runs for the app's whole
        // lifetime, and the fallback could grab a Model Page window and
        // restyle chrome that's supposed to stay stock.
        DispatchQueue.main.async {
            if let window = nsView.window {
                WindowChrome.shared.apply(to: window)
                window.makeKeyAndOrderFront(nil)
            }
        }
    }

    /// The window backing the SwiftUI scene often isn't attached (or visible)
    /// at the instant the representable is made, so poll briefly until it is.
    static func pollForWindow(view: NSView, attempts: Int) {
        DispatchQueue.main.async {
            if let window = view.window ?? NSApp.windows.first(where: { $0.isVisible }) {
                NSApp.activate(ignoringOtherApps: true)
                WindowChrome.shared.apply(to: window)
                window.makeKeyAndOrderFront(nil)
                window.orderFrontRegardless()
            } else if attempts < 80 {
                DispatchQueue.main.asyncAfter(deadline: .now() + 0.05) {
                    pollForWindow(view: view, attempts: attempts + 1)
                }
            }
        }
    }
}

/// Owns the window-chrome customizations: full-size content (so the sidebar
/// card can reach the top) and a rightward/downward nudge of the traffic-light
/// controls so they sit inset on the floating card rather than jammed into the
/// corner. Remembers each button's original origin so repeated calls don't
/// compound the offset.
///
/// Enforcement is CONTINUOUS, not event-enumerated. A previous version
/// re-applied the nudge only on six specific notifications (resize, key/
/// resign, exit-fullscreen, screen-change, move) — but AppKit also re-lays
/// out the titlebar on internal passes that fire none of those
/// (deminiaturize, appearance/backing changes, occlusion redraws, space
/// switches, …). When one of those hit, the buttons were re-centered inside
/// the taller container (landing visibly lower) and the private decoration
/// view was re-shown (a stray rounded outline floating over the sidebar) —
/// and because ordinary typing/clicking in an already-key window fires none
/// of the six, it then STAYED wrong indefinitely. Seen live repeatedly as
/// "the lights drift out of place after a while." Now `didUpdateNotification`
/// — posted after every event-loop pass for the window — funnels into the
/// same reposition with are-we-already-correct early-outs, so any AppKit
/// revert self-heals within one runloop turn and the steady-state cost is a
/// few frame comparisons.
final class WindowChrome {
    static let shared = WindowChrome()

    /// How far to nudge the traffic lights from their default corner
    /// position. The downward nudge centers them on the sidebar's 50pt
    /// header band, so they sit on the same line as the header's icons —
    /// matching the reference where lights and header controls share a row.
    static let insetX: CGFloat = 18
    static let insetDown: CGFloat = 21

    /// Width of the resized titlebar container — just enough to cover the
    /// three nudged lights plus hover padding, deliberately NOT the full
    /// window width: the taller strip must not sit over (and steal events
    /// from) real content beside the lights, like the sidebar header's own
    /// buttons.
    private static let containerWidth: CGFloat = 100

    /// Everything captured/observed for one specific window. Per-window
    /// (not singleton-global like before) so a second styled window can
    /// never read the first one's captured baselines, and keyed state can
    /// be cleanly torn down when its window closes.
    private final class WindowState {
        var originalOrigins: [NSWindow.ButtonType: CGPoint] = [:]
        var originalContainerHeight: CGFloat?
        var observers: [NSObjectProtocol] = []
    }

    private var states: [ObjectIdentifier: WindowState] = [:]

    func apply(to window: NSWindow) {
        window.titlebarAppearsTransparent = true
        window.titleVisibility = .hidden
        window.styleMask.insert(.fullSizeContentView)
        window.isMovableByWindowBackground = true

        if states[ObjectIdentifier(window)] == nil {
            let state = WindowState()
            states[ObjectIdentifier(window)] = state
            observe(window, state: state)
        }
        repositionButtons(in: window)
    }

    private func observe(_ window: NSWindow, state: WindowState) {
        let center = NotificationCenter.default
        // didUpdate is the catch-all that actually fixes the drift (see the
        // class doc). The semantic ones are kept alongside it as
        // belt-and-braces for moments where an update pass may lag the
        // layout change (screen/space transitions).
        for name: Notification.Name in [
            NSWindow.didUpdateNotification,
            NSWindow.didResizeNotification,
            NSWindow.didBecomeKeyNotification,
            NSWindow.didResignKeyNotification,
            NSWindow.didExitFullScreenNotification,
            NSWindow.didChangeScreenNotification,
            NSWindow.didChangeBackingPropertiesNotification,
            NSWindow.didDeminiaturizeNotification,
            NSWindow.didMoveNotification,
        ] {
            state.observers.append(center.addObserver(
                forName: name, object: window, queue: .main
            ) { [weak self, weak window] _ in
                guard let window else { return }
                self?.repositionButtons(in: window)
            })
        }
        // Teardown on close — with the factory geometry RESTORED first: if
        // the toolkit ever reuses this same NSWindow instance for a
        // reopened scene, a fresh WindowState would otherwise capture the
        // already-nudged origins/height as "factory" and compound the
        // offset by another 18/21pt per close-reopen cycle.
        state.observers.append(center.addObserver(
            forName: NSWindow.willCloseNotification, object: window, queue: .main
        ) { [weak self, weak window] _ in
            guard let self, let window else { return }
            self.restoreFactoryGeometry(in: window)
            if let state = self.states.removeValue(forKey: ObjectIdentifier(window)) {
                for observer in state.observers { center.removeObserver(observer) }
            }
        })
    }

    private func restoreFactoryGeometry(in window: NSWindow) {
        guard let state = states[ObjectIdentifier(window)] else { return }
        if let anyButton = window.standardWindowButton(.closeButton),
           let container = anyButton.superview?.superview,
           let baseHeight = state.originalContainerHeight,
           let themeFrame = container.superview {
            container.frame = CGRect(
                x: 0,
                y: themeFrame.bounds.height - baseHeight,
                width: themeFrame.bounds.width,
                height: baseHeight
            )
        }
        for (type, origin) in state.originalOrigins {
            window.standardWindowButton(type)?.setFrameOrigin(origin)
        }
    }

    private func repositionButtons(in window: NSWindow) {
        // In fullscreen the system owns the buttons (they live in the
        // auto-revealing menubar strip) — moving them there breaks them.
        guard !window.styleMask.contains(.fullScreen) else { return }
        guard let state = states[ObjectIdentifier(window)] else { return }

        // A moved button stays fully VISIBLE outside its parent's frame
        // (the titlebar doesn't clip drawing) but hover tracking and
        // clicks only land on the part still inside the parent — moving
        // the lights 21pt below a 28pt-tall titlebar container left a
        // ~1pt clickable sliver at their top edge. So the container has
        // to move/grow with them: extend its height by the downward
        // nudge, keeping the buttons at the same factory offset from its
        // (now lower) bottom edge — identical on-screen spot, but fully
        // inside the hit-testable area.
        if let anyButton = window.standardWindowButton(.closeButton),
           let container = anyButton.superview?.superview,
           let themeFrame = container.superview {
            if state.originalContainerHeight == nil, container.frame.height > 0 {
                state.originalContainerHeight = container.frame.height
            }
            if let baseHeight = state.originalContainerHeight {
                let height = baseHeight + Self.insetDown
                let desired = CGRect(
                    x: 0,
                    y: themeFrame.bounds.height - height,
                    width: Self.containerWidth,
                    height: height
                )
                // Early-out (here and below): this runs on every window
                // update pass, so writes must only happen when AppKit has
                // actually reverted something — an unconditional set would
                // dirty layout/display every pass for no reason.
                if container.frame != desired { container.frame = desired }
            }

            // The container holds an _NSTitlebarDecorationView (verified by
            // dumping the live hierarchy) that draws the system's rounded
            // titlebar decoration sized to the container — full-width it's
            // invisible against the window edge, but shrunk to the 100pt
            // frame above and nudged down over the sidebar it renders as a
            // stray rounded outline floating over the content. Hidden by
            // matching the class name, since the class is private; re-done
            // here every pass because AppKit re-shows it on its own
            // titlebar re-layouts (this exact outline is the artifact
            // visible in the drift screenshots).
            for subview in container.subviews
            where String(describing: type(of: subview)).contains("Decoration") {
                if !subview.isHidden { subview.isHidden = true }
            }
        }

        let types: [NSWindow.ButtonType] = [.closeButton, .miniaturizeButton, .zoomButton]
        for type in types {
            guard let button = window.standardWindowButton(type) else { continue }
            // Capture each button's factory origin once, before we ever move
            // it, so the offset is always applied to the same baseline.
            if state.originalOrigins[type] == nil {
                state.originalOrigins[type] = button.frame.origin
            }
            guard let base = state.originalOrigins[type] else { continue }
            // No explicit downward nudge here anymore: the container's
            // bottom edge itself moved down by insetDown, so keeping the
            // factory y inside it lands the button insetDown lower on
            // screen — the same place the old code put it, minus the
            // dead hit-area.
            let desired = CGPoint(x: base.x + Self.insetX, y: base.y)
            if button.frame.origin != desired { button.setFrameOrigin(desired) }
        }
    }
}

enum AppFocus {
    static func activate() {
        NSApp.activate(ignoringOtherApps: true)
        NSApp.windows.first(where: { $0.isVisible })?.makeKeyAndOrderFront(nil)
    }
}
