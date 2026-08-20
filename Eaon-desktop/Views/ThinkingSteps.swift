import SwiftUI

/// A sweep of light travelling across a label, for text that means "this is
/// happening right now".
///
/// Eaon already had `WaveText`, which lifts each character in turn. That
/// works for a single short status but not for a list: a column of rows all
/// bobbing at once is a lot of independent motion, and per-character layout
/// can't wrap. A shimmer is one moving highlight over ordinary, wrapping
/// text, so it stays calm at any length.
struct ShimmerText: View {
    let text: String
    var font: Font
    var color: Color

    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    /// Seconds per sweep. Slow by default: a step row runs for the whole
    /// length of the step, and a quick sweep on a row you're trying to read
    /// is genuinely irritating. The live status indicator overrides this —
    /// there the shimmer IS the "still working" signal, so it wants the
    /// faster 1.5s of the reference component rather than a calm crawl.
    var period: Double = 2.6

    var body: some View {
        let base = Text(text).font(font).foregroundColor(color)
        if reduceMotion {
            // The dimming alone still separates "running" from "done".
            base
        } else {
            TimelineView(.animation(minimumInterval: 1.0 / 30.0)) { timeline in
                let p = timeline.date.timeIntervalSinceReferenceDate
                    .truncatingRemainder(dividingBy: period) / period
                base.overlay(
                    LinearGradient(
                        stops: [
                            .init(color: .clear, location: max(0, p - 0.18)),
                            .init(color: color.opacity(0.95), location: p),
                            .init(color: .clear, location: min(1, p + 0.18)),
                        ],
                        startPoint: .leading, endPoint: .trailing
                    )
                    // Clipped to the glyphs, so the highlight rides the
                    // letters instead of painting a bar across the row.
                    .mask(base)
                )
            }
        }
    }
}

/// The calls folded into one step, behind a second-level disclosure.
///
/// A row that says "Searched the web" and nothing else has thrown away the
/// queries; a row that lists all six has become the wall of chips this
/// replaced. So the count is the headline and the list is one click away —
/// collapsed by default, because the point of the trail is that it stays
/// small enough to scroll past.
private struct StepDetailsDisclosure: View {
    @Environment(\.themeColors) private var colors
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    let summary: String
    let lines: [String]

    @State private var isOpen = false

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            Button {
                withAnimation(reduceMotion ? nil : .easeOut(duration: 0.16)) { isOpen.toggle() }
            } label: {
                HStack(spacing: 4) {
                    Text(summary)
                        .font(AppFont.mono(12))
                        .foregroundColor(colors.textTertiary)
                    Image(systemName: "chevron.right")
                        .font(.system(size: 8, weight: .semibold))
                        .foregroundStyle(colors.textTertiary)
                        .rotationEffect(.degrees(isOpen ? 90 : 0))
                }
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)

            if isOpen {
                VStack(alignment: .leading, spacing: 3) {
                    ForEach(Array(lines.enumerated()), id: \.offset) { _, line in
                        Text(line)
                            .font(AppFont.mono(12))
                            .foregroundColor(colors.textTertiary)
                            .fixedSize(horizontal: false, vertical: true)
                            .frame(maxWidth: .infinity, alignment: .leading)
                    }
                }
                // Indented under its own summary, and held off the connector
                // line so the nesting is legible at a glance.
                .padding(.leading, 10)
                .transition(.opacity)
            }
        }
    }
}

/// The agent's chain of work, as one collapsible block.
///
/// Replaces a status line that overwrote itself on every tool call. The
/// problem with one line is that a long agent turn leaves no evidence: you
/// look away, look back, and whatever it did in between is gone.
///
/// Structure follows the pattern this was asked to match: a header you can
/// collapse, then steps carrying an icon, a label, optional detail text, and
/// the sources they touched. Three states — done, running, pending — where
/// pending is simply not drawn, so the list grows downward as the agent works
/// instead of showing it a future it might not follow.
struct ThinkingSteps: View {
    @Environment(\.themeColors) private var colors
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    let steps: [AgentStep]
    /// Shown beside the chevron. "Thinking" unless a run has a name of its
    /// own (a swarm, a named agent).
    var title: String = "Thinking"
    /// Dot mode. With icons off every step gets the same small dot, which is
    /// the right call when the steps are prose rather than tool calls: a
    /// column of different glyphs beside paragraphs of reasoning claims a
    /// taxonomy that isn't really there, and the eye reads the icons instead
    /// of the words.
    var showIcons: Bool = true

    /// Closed by default, always. The block is a receipt, not the answer:
    /// somewhere to look when you want to know how a reply was reached,
    /// which is the exception rather than the rule. Opening on its own
    /// pushed the actual answer down the screen on every single turn, and
    /// that is what the row-limiting below was really compensating for.
    ///
    /// Deliberately NOT "open while running, closed when done" either: a
    /// block that collapses itself the moment you start reading it is worse
    /// than one that was never open, because it takes the thing you were
    /// looking at away mid-sentence.
    @State private var isExpanded = false

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            header

            if isExpanded {
                // Every step, never a window onto the last few. Once the
                // block is closed by default it costs nothing to be
                // complete when opened, and a trail that silently drops its
                // own middle ("12 earlier steps") is worse than useless for
                // the one thing it exists for: seeing what actually
                // happened.
                VStack(alignment: .leading, spacing: 0) {
                    ForEach(Array(steps.enumerated()), id: \.offset) { index, step in
                        // Keyed by position, not `step.id`: the message-bubble
                        // callers rebuild this whole array from scratch on every
                        // streaming tick — new `AgentStep`s, fresh UUIDs — even
                        // when a step's content hasn't actually changed.
                        // Position is what's genuinely stable, so the row stays
                        // mounted while it streams and its entrance animations
                        // fire once, not sixty times a second.
                        ThinkingStepRow(step: step, isLast: index == steps.count - 1, showIcons: showIcons)
                    }
                }
                .padding(.top, 8)
                .transition(.opacity)
            }
        }
        .animation(reduceMotion ? nil : .easeOut(duration: 0.2), value: isExpanded)
        .animation(reduceMotion ? nil : .easeOut(duration: 0.24), value: steps.count)
    }

    // MARK: - Header

    private var header: some View {
        Button {
            withAnimation(.easeOut(duration: 0.18)) { isExpanded.toggle() }
        } label: {
            HStack(spacing: 6) {
                Image(systemName: "chevron.right")
                    .font(.system(size: 10, weight: .semibold))
                    .foregroundStyle(colors.textTertiary)
                    .rotationEffect(.degrees(isExpanded ? 90 : 0))

                // While work is running the header shimmers too, so a
                // collapsed block still reads as live rather than as a
                // finished summary someone left open.
                if isRunning {
                    ShimmerText(text: title, font: AppFont.mono(14), color: colors.textSecondary)
                } else {
                    Text(title)
                        .font(AppFont.mono(14))
                        .foregroundStyle(colors.textSecondary)
                }

                // Collapsed is the normal state now, so this line is what
                // the block says most of the time and it has to earn its
                // row. While running that means the live step — it doubles
                // as the status line. Once finished the current step is
                // just the last thing that happened, which tells you
                // nothing about the run; the count does, and it's also the
                // hint that there's something in here worth opening.
                if !isExpanded {
                    if isRunning, let active = steps.last {
                        Text("· \(active.title)")
                            .font(AppFont.mono(12))
                            .foregroundStyle(colors.textTertiary)
                            .lineLimit(1)
                    } else if steps.count > 1 {
                        Text("· \(steps.count) steps")
                            .font(AppFont.mono(12))
                            .foregroundStyle(colors.textTertiary)
                    }
                }
            }
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
    }

    private var isRunning: Bool { steps.contains { $0.status == .running } }
}

/// Fades a step's secondary content in shortly after its row mounts, so a
/// step reads as two beats — the row itself, then what it carries — instead
/// of one flat pop. The default delay matches the reference component this
/// was asked to bring over.
///
/// Safe to drive from `onAppear`: rows are keyed by position, not by
/// `AgentStep.id` (see `ThinkingSteps.body`), so an already-visible row keeps
/// its identity while its text streams in. This only replays when the row
/// is genuinely new — never on every tick that just updates it in place.
private struct StepContentReveal: ViewModifier {
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    var delay: Double = 0.08

    @State private var visible = false

    func body(content: Content) -> some View {
        content
            .opacity(visible ? 1 : 0)
            .offset(y: visible ? 0 : 3)
            .onAppear {
                guard !reduceMotion else { visible = true; return }
                withAnimation(.easeOut(duration: 0.22).delay(delay)) { visible = true }
            }
    }
}

private extension View {
    func stepContentReveal(delay: Double = 0.08) -> some View {
        modifier(StepContentReveal(delay: delay))
    }
}

/// One row of the trail: an icon, a label, and whatever the step carries.
///
/// Its own view, rather than a method on `ThinkingSteps` the way this used
/// to be, because the connector line's grow-in needs somewhere to keep
/// `@State` — a method has nowhere to put it.
private struct ThinkingStepRow: View {
    @Environment(\.themeColors) private var colors
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    let step: AgentStep
    let isLast: Bool
    let showIcons: Bool

    /// Drives the connector line's grow-from-top entrance. Without it the
    /// line is simply always there; matching it to the row's own fade-in is
    /// what makes the trail read as reaching toward the next step, instead
    /// of arriving pre-drawn.
    @State private var lineGrown = false

    var body: some View {
        HStack(alignment: .top, spacing: 9) {
            // Icon column with the connector running through it. The line is
            // what makes a stack of rows read as one sequence rather than as
            // unrelated notices.
            VStack(spacing: 3) {
                iconView
                if !isLast {
                    Rectangle()
                        .fill(colors.borderSubtle)
                        .frame(width: 1)
                        .frame(maxHeight: .infinity)
                        .scaleEffect(x: 1, y: lineGrown ? 1 : 0, anchor: .top)
                }
            }
            .frame(width: 16)

            VStack(alignment: .leading, spacing: 5) {
                if step.status == .running {
                    ShimmerText(text: step.title, font: AppFont.mono(12), color: colors.textTertiary)
                        .fixedSize(horizontal: false, vertical: true)
                } else {
                    Text(step.title)
                        .font(AppFont.mono(12))
                        .foregroundColor(colors.textSecondary)
                        .fixedSize(horizontal: false, vertical: true)
                }

                if let detail = step.detail, !detail.isEmpty {
                    Text(detail)
                        .font(AppFont.sans(12))
                        .foregroundColor(colors.textTertiary)
                        .fixedSize(horizontal: false, vertical: true)
                        .lineSpacing(3)
                        .stepContentReveal()
                }

                if !step.details.isEmpty {
                    StepDetailsDisclosure(
                        summary: step.detailsSummary ?? "\(step.details.count) item\(step.details.count == 1 ? "" : "s")",
                        lines: step.details
                    )
                    .stepContentReveal()
                }

                if !step.chips.isEmpty {
                    // Wraps: a step can touch three long domains, and an
                    // HStack would run them off the message column.
                    FlowLayout(spacing: 5) {
                        ForEach(Array(step.chips.enumerated()), id: \.offset) { index, chip in
                            Text(chip)
                                .font(AppFont.mono(12))
                                .foregroundColor(colors.textSecondary)
                                .lineLimit(1)
                                .padding(.horizontal, 7)
                                .padding(.vertical, 3)
                                .background(Capsule().fill(colors.backgroundChip))
                                // Staggered, one chip after another — the
                                // sources arrive as a small burst rather than
                                // all at once.
                                .stepContentReveal(delay: Double(index + 1) * 0.05)
                        }
                    }
                }
            }
            .padding(.bottom, isLast ? 0 : 10)

            Spacer(minLength: 0)
        }
        .transition(.asymmetric(
            insertion: .opacity.combined(with: .move(edge: .top)),
            removal: .opacity
        ))
        .onAppear {
            guard !reduceMotion else { lineGrown = true; return }
            withAnimation(.easeOut(duration: 0.3).delay(0.05)) { lineGrown = true }
        }
    }

    /// A running step gets a hollow ring rather than its tool glyph. The
    /// glyph says *what kind* of work it is, which only becomes worth
    /// knowing once the step is real; while it's still in flight the useful
    /// signal is simply that something is open, and a ring reads as that at
    /// a glance in a column of solid marks.
    @ViewBuilder
    private var iconView: some View {
        if !showIcons {
            // Dot mode: hollow while running, filled once done, so the
            // single mark still carries the one distinction that matters.
            Circle()
                .strokeBorder(colors.textTertiary, lineWidth: 1.4)
                .background(
                    Circle().fill(step.status == .done ? colors.textSecondary : .clear)
                )
                .frame(width: 7, height: 7)
                .frame(width: 16, height: 16)
        } else {
            iconGlyphView
        }
    }

    @ViewBuilder
    private var iconGlyphView: some View {
        switch step.status {
        case .running:
            Circle()
                .strokeBorder(colors.textTertiary, lineWidth: 1.4)
                .frame(width: 9, height: 9)
                .frame(width: 16, height: 16)
        case .done:
            Image(systemName: step.kind.symbol)
                .font(.system(size: 11, weight: .medium))
                .foregroundColor(colors.textSecondary)
                .frame(width: 16, height: 16)
        }
    }
}
