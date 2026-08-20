import SwiftUI

/// The agent's plan for the current task, ticked off as it goes.
///
/// A long agent turn is otherwise an opaque stream of tool calls: you can
/// see it doing things, but not what it thinks it's doing or how much is
/// left. This is the answer to "is it nearly done, and did it forget the
/// part I actually cared about" — the one question a progress spinner
/// cannot answer.
///
/// It sits above the composer rather than in the transcript because it is
/// not a message: it's the current state of one thing, rewritten in place.
/// Scrolled into the transcript it would leave a trail of stale copies, and
/// the live one would be wherever you last left the scroll position.
struct AgentPlanCard: View {
    @Environment(\.themeColors) private var colors
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    let steps: [PlanStep]

    @State private var isCollapsed = false

    private var doneCount: Int { steps.filter { $0.status == .done }.count }
    private var isFinished: Bool { doneCount == steps.count }

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            header

            if !isCollapsed {
                VStack(alignment: .leading, spacing: 5) {
                    ForEach(steps) { step in
                        row(for: step)
                    }
                }
                .padding(.horizontal, 12)
                .padding(.bottom, 10)
                .transition(.opacity)
            }
        }
        .background(
            RoundedRectangle(cornerRadius: 12, style: .continuous)
                .fill(colors.backgroundInputSecondary.opacity(0.6))
        )
        .overlay(
            RoundedRectangle(cornerRadius: 12, style: .continuous)
                .stroke(colors.borderSubtle, lineWidth: 1)
        )
        .animation(reduceMotion ? nil : .easeOut(duration: 0.18), value: isCollapsed)
        .animation(reduceMotion ? nil : .easeOut(duration: 0.2), value: steps)
    }

    private var header: some View {
        Button {
            isCollapsed.toggle()
        } label: {
            HStack(spacing: 7) {
                Image(systemName: "chevron.right")
                    .font(.system(size: 9, weight: .semibold))
                    .foregroundStyle(colors.textTertiary)
                    .rotationEffect(.degrees(isCollapsed ? 0 : 90))

                Text(isFinished ? "Plan complete" : "Plan")
                    .font(AppFont.mono(12, weight: .semibold))
                    .foregroundStyle(colors.textSecondary)

                Text("\(doneCount)/\(steps.count)")
                    .font(AppFont.sans(12))
                    .foregroundStyle(colors.textTertiary)

                Spacer(minLength: 0)

                // Collapsed, the active step stands in for the whole list —
                // folding the plan away shouldn't cost you the one line that
                // says what's happening right now.
                if isCollapsed, let active = steps.first(where: { $0.status == .active }) {
                    Text(active.text)
                        .font(AppFont.sans(12))
                        .foregroundStyle(colors.textTertiary)
                        .lineLimit(1)
                        .truncationMode(.tail)
                }
            }
            .padding(.horizontal, 12)
            .padding(.vertical, 8)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
    }

    private func row(for step: PlanStep) -> some View {
        HStack(alignment: .firstTextBaseline, spacing: 8) {
            marker(for: step.status)
                .frame(width: 12)

            Text(step.text)
                .font(AppFont.sans(12))
                .foregroundStyle(color(for: step.status))
                // Struck through rather than removed: a plan that deletes
                // what it finished looks like it keeps shrinking, and you
                // lose the record of what was actually done.
                .strikethrough(step.status == .done, color: colors.textTertiary)
                .fixedSize(horizontal: false, vertical: true)
                .frame(maxWidth: .infinity, alignment: .leading)
        }
    }

    @ViewBuilder
    private func marker(for status: PlanStep.Status) -> some View {
        switch status {
        case .done:
            Image(systemName: "checkmark")
                .font(.system(size: 9, weight: .bold))
                .foregroundStyle(Color(hex: "#4ADE80"))
        case .active:
            // The one moving thing in the card, and only ever on one row —
            // that's what makes it findable at a glance.
            ProgressView()
                .controlSize(.small)
                .scaleEffect(0.5)
                .frame(width: 12, height: 12)
        case .pending:
            Circle()
                .strokeBorder(colors.textTertiary.opacity(0.5), lineWidth: 1)
                .frame(width: 8, height: 8)
        }
    }

    private func color(for status: PlanStep.Status) -> Color {
        switch status {
        case .done: return colors.textTertiary
        case .active: return colors.textPrimary
        case .pending: return colors.textSecondary
        }
    }
}
