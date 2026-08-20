import SwiftUI

// MARK: - Mode switcher

/// Reports one segment's real on-screen frame (in the control's own
/// coordinate space) so the highlight pill can be positioned exactly on top
/// of it — segments aren't equal width ("Agent" vs "Image"), so this can't
/// be computed from index alone.
private struct SegmentFramePreferenceKey: PreferenceKey {
    static var defaultValue: [EaonMode: CGRect] = [:]
    static func reduce(value: inout [EaonMode: CGRect], nextValue: () -> [EaonMode: CGRect]) {
        value.merge(nextValue()) { _, new in new }
    }
}

/// Stops `NSWindow.isMovableByWindowBackground` (set on this app's own
/// title-bar-less window — see `WindowChrome`) from hijacking a press-drag
/// meant for the segmented control underneath. Without this, AppKit resolves
/// a mouse-down that lands on plain SwiftUI content as "background," and
/// with background-dragging on, that drags the whole window instead of the
/// pill — and fighting that resolution before it wins is also why the
/// gesture felt like it was landing a beat late. A single real `NSView`
/// covering the control's own bounds, with `mouseDownCanMoveWindow`
/// overridden to `false`, makes AppKit's hit-test resolve to "not
/// draggable" right here, before it ever considers the window.
private struct WindowDragBlocker: NSViewRepresentable {
    func makeNSView(context: Context) -> NSView { NonMovingView() }
    func updateNSView(_ nsView: NSView, context: Context) {}

    private final class NonMovingView: NSView {
        override var mouseDownCanMoveWindow: Bool { false }
    }
}

/// The mode switcher, sitting at the very top of the sidebar above "New
/// Chat" — the first thing in the window, framing everything under it as
/// belonging to the mode you're in.
///
/// It spans the sidebar's full width with two equal halves rather than
/// hugging its labels. At the top of a fixed-width column an intrinsically
/// sized control reads as a stray object floating in the corner; filling the
/// column makes it read as the header of what follows, and equal halves say
/// the two modes are peers. The rounded rectangle (rather than a capsule)
/// matches the radius of the nav rows directly beneath it, so the top of the
/// sidebar looks like one designed stack instead of two unrelated widgets.
///
/// Both a tap and a press-and-slide work: a `DragGesture(minimumDistance:
/// 0)` covers both, since a plain tap is just a drag that never moves. While
/// a press is active, the highlight follows the cursor/finger directly and
/// continuously (a real slide, not a jump between fixed slots) — per Emil's
/// "spring-based mouse interaction" guidance, tying a visual straight to
/// live pointer position is what makes a drag feel physically connected to
/// the hand. On release it springs the rest of the way to the nearest
/// segment's exact frame; that's the one moment worth a real animation, so
/// it's a real (if restrained) spring rather than the instant tracking
/// during the drag itself. Kept deliberately subtle everywhere else — this
/// sits in the composer, visible in literally every conversation, so it
/// gets the "seen constantly → shortest and subtlest" treatment throughout.
struct ModeSegmentedControl: View {
    @Environment(\.themeColors) private var colors
    let currentMode: EaonMode
    let onSelect: (EaonMode) -> Void

    @State private var segmentFrames: [EaonMode: CGRect] = [:]
    /// Non-nil only while a press is down — the live X the pill's center is
    /// tracking. nil the rest of the time, when the pill just sits settled
    /// on `currentMode`'s own frame.
    @State private var liveDragX: CGFloat?
    /// Down-state for press feedback. A control this central has to feel like
    /// it heard you the instant you touch it — the pill's travel is the
    /// *result*, which arrives a beat later.
    @State private var isPressed = false
    /// Motion is the whole point of the sliding pill, so reduced-motion gets
    /// the same control with the travel removed rather than a degraded one.
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    private func label(for mode: EaonMode) -> String {
        switch mode {
        case .chat: return "Chat"
        case .agent: return "Work"
        case .code: return "Code"
        }
    }

    /// Hover explanation for each mode — new users have no way to tell Chat,
    /// Agent, and Code apart from the three-word labels alone.
    private func tooltip(for mode: EaonMode) -> String {
        switch mode {
        case .chat:
            return "Chat — just talk and ask anything. Never touches your files or runs commands."
        case .agent:
            return "Eaon Work — writes, runs, and debugs real code on your Mac, and (with Device Control on) organizes files, drives apps, and researches for you."
        case .code:
            return "Code — a real terminal running Eaon's CLI agent, for git, test runners, and the developer workflows a chat window doesn't fit."
        }
    }

    /// The segment whose center is closest to a given X — used both to pick
    /// the live drag's width/height (a slid pill still borrows whichever
    /// segment it's currently over) and to decide where a release settles.
    private func nearestMode(toX x: CGFloat) -> EaonMode {
        EaonMode.switcherCases.min { a, b in
            abs((segmentFrames[a]?.midX ?? .infinity) - x) < abs((segmentFrames[b]?.midX ?? .infinity) - x)
        } ?? currentMode
    }

    var body: some View {
        ZStack(alignment: .leading) {
            if let pill = pillFrame {
                RoundedRectangle(cornerRadius: 8, style: .continuous)
                    .fill(colors.backgroundChip)
                    .frame(width: pill.width, height: pill.height)
                    .offset(x: pill.minX, y: pill.minY)
                    // Also animates when the mode is changed from somewhere
                    // else entirely (a keyboard shortcut, restoring a saved
                    // mode) — without this the pill teleports in those cases
                    // and only the in-control path looks considered.
                    .animation(pillMotion, value: currentMode)
                    .animation(.interactiveSpring(duration: 0.2), value: liveDragX == nil)
            }

            HStack(spacing: 2) {
                ForEach(EaonMode.switcherCases) { mode in
                    let isActive = mode == currentMode
                    HStack(spacing: 6) {
                        Image(systemName: mode.icon)
                            .font(.system(size: 11, weight: .semibold))
                        Text(label(for: mode))
                            .font(AppFont.mono(14, weight: .medium))
                    }
                    .foregroundStyle(isActive ? colors.textPrimary : colors.textSecondary)
                    // Timed to land with the pill. Snapping the colour makes
                    // the label change look like a separate event from the
                    // pill's arrival instead of one movement.
                    .animation(.easeOut(duration: 0.18), value: currentMode)
                    .padding(.vertical, 6)
                    // Equal halves, so the pill travels a fixed distance and
                    // neither mode looks like the "main" one.
                    .frame(maxWidth: .infinity)
                    .background(
                        GeometryReader { proxy in
                            Color.clear.preference(
                                key: SegmentFramePreferenceKey.self,
                                value: [mode: proxy.frame(in: .named("modeSegmentedControl"))]
                            )
                        }
                    )
                    .help(tooltip(for: mode))
                }
            }
        }
        .coordinateSpace(name: "modeSegmentedControl")
        .onPreferenceChange(SegmentFramePreferenceKey.self) { segmentFrames = $0 }
        .padding(3)
        .background(
            RoundedRectangle(cornerRadius: 11, style: .continuous)
                .fill(colors.backgroundInputSecondary)
        )
        .scaleEffect(isPressed ? 0.97 : 1)
        .animation(.easeOut(duration: 0.12), value: isPressed)
        .background(WindowDragBlocker())
        .contentShape(Rectangle())
        .gesture(
            DragGesture(minimumDistance: 0, coordinateSpace: .named("modeSegmentedControl"))
                .onChanged { value in
                    if !isPressed { isPressed = true }
                    // Deliberately outside withAnimation — this needs to
                    // track the cursor with zero lag every frame, not ease
                    // toward it.
                    liveDragX = reduceMotion ? nil : value.location.x
                }
                .onEnded { value in
                    let landed = nearestMode(toX: value.location.x)
                    // Both state changes — clearing the live drag AND
                    // committing the new mode — need to land in the SAME
                    // animation transaction, or only half the motion (the
                    // drag-to-nil part) would animate while the mode's own
                    // frame change snapped in instantly right after.
                    isPressed = false
                    withAnimation(pillMotion) {
                        liveDragX = nil
                        if landed != currentMode {
                            onSelect(landed)
                        }
                    }
                }
        )
    }

    /// How the pill travels. Deliberately quick — switching modes is a
    /// frequent action, and past roughly 250ms a control you use constantly
    /// starts feeling like it's waiting on you. The slight bounce is what
    /// makes it read as a physical object sliding rather than a rectangle
    /// being redrawn; any more would turn a utility control into a toy.
    private var pillMotion: Animation {
        reduceMotion ? .easeOut(duration: 0.01) : .spring(duration: 0.24, bounce: 0.18)
    }

    /// Where the pill actually draws right now: the live-tracked X while a
    /// press is down (clamped to whichever segment is currently under it —
    /// so the pill's own width/height stay coherent instead of stretching),
    /// or the settled current segment's real frame otherwise.
    private var pillFrame: CGRect? {
        guard let liveDragX else { return segmentFrames[currentMode] }
        let hovered = nearestMode(toX: liveDragX)
        guard let hoveredFrame = segmentFrames[hovered] else { return nil }
        // The pill's center follows the cursor continuously (the actual
        // "slide" feel); its width/height snap to whichever segment that
        // center currently sits over. Clamped to the real measured extent of
        // all segments (not any one assumed to be "last") so it never drifts
        // past the first/last segment's own bounds.
        let allFrames = segmentFrames.values
        guard let trackMinX = allFrames.map(\.minX).min(), let trackMaxX = allFrames.map(\.maxX).max() else {
            return hoveredFrame
        }
        let clampedMidX = min(max(liveDragX, trackMinX + hoveredFrame.width / 2), trackMaxX - hoveredFrame.width / 2)
        return CGRect(x: clampedMidX - hoveredFrame.width / 2, y: hoveredFrame.minY, width: hoveredFrame.width, height: hoveredFrame.height)
    }
}

// MARK: - Device control opt-in

/// A small, dismissible hint shown inside Agent mode while device control
/// (formerly Eaon Claw's own separate mode, with its own full-screen enable
/// gate) is still off. Agent already works fully as a coding agent without
/// it, so this is an invitation, not a gate — unlike the old Claw enable
/// card, it never blocks the chat surface underneath. Dismissal is
/// persisted so it doesn't nag on every launch once someone's made their
/// choice either way.
struct DeviceControlOptInHint: View {
    @Environment(\.themeColors) private var colors
    @AppStorage("eaon_device_control_hint_dismissed") private var dismissed = false
    let onOpenSettings: () -> Void

    var body: some View {
        if !dismissed {
            HStack(spacing: 10) {
                Image(systemName: "macwindow")
                    .font(.system(size: 12))
                    .foregroundStyle(colors.textSecondary)
                Text("Turn on Device Control so Agent can organize files, drive apps, and use the browser, not just write code.")
                    .font(AppFont.sans(12))
                    .foregroundStyle(colors.textSecondary)
                    .lineLimit(2)
                Spacer(minLength: 8)
                Button("Turn On", action: onOpenSettings)
                    .buttonStyle(.plain)
                    .font(AppFont.mono(12, weight: .semibold))
                    .foregroundStyle(AppearanceSettings.shared.accentColor)
                Button {
                    dismissed = true
                } label: {
                    Image(systemName: "xmark")
                        .font(.system(size: 10, weight: .semibold))
                        .foregroundStyle(colors.textTertiary)
                        .iconHoverEffect(for: "xmark")
                }
                .buttonStyle(.plain)
                .help("Don't show this again")
            }
            .padding(.horizontal, 14)
            .padding(.vertical, 9)
            .background(RoundedRectangle(cornerRadius: 10, style: .continuous).fill(colors.backgroundChip.opacity(0.5)))
            .overlay(RoundedRectangle(cornerRadius: 10, style: .continuous).stroke(colors.borderSubtle, lineWidth: 1))
            .padding(.horizontal, 20)
            .padding(.top, 10)
        }
    }
}
