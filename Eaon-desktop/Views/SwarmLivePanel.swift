import SwiftUI

/// The Agent Swarm discussion, shown live while it's happening.
///
/// The finished discussion already persists as a collapsible card on the
/// reply (`SwarmPanelExtractor`), but that only appears once everything is
/// over. While the swarm was actually running — the part that can take a
/// minute or more — the only thing on screen was a single status line
/// ("Swarm — round 2: Security Reviewer is weighing in…"). That reports who
/// is busy and nothing else: not who has already spoken, not what any of
/// them decided, not whether anyone has voted to wrap up, not how close the
/// whole thing is to finishing.
///
/// The discussion is the entire point of the feature. Watching specialists
/// disagree and converge is what makes a swarm worth waiting for, and hiding
/// it behind a spinner turns the wait into dead time. This shows it as it
/// happens.
struct SwarmLivePanel: View {
    @Environment(\.themeColors) private var colors
    let transcript: SwarmTranscript
    /// The runner's own status line — kept alongside the panel so "who is
    /// speaking right now" stays visible even before that persona's remark
    /// has landed and become a row.
    let statusText: String?

    /// Votes needed to hand off, mirroring `AgentSwarmRunner.votesToEnd`.
    /// Read from the runner rather than hardcoded so the two can't drift.
    private var votesNeeded: Int { AgentSwarmRunner.votesToEnd }

    private var currentRound: Int {
        max(transcript.roundsUsed, transcript.remarks.map(\.round).max() ?? 1)
    }

    private var votesThisRound: Int {
        transcript.remarks.filter { $0.round == currentRound && $0.wantsToEnd }.count
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            header
            if !transcript.personas.isEmpty {
                divider
                roster
            }
            if !transcript.remarks.isEmpty {
                divider
                discussion
            }
        }
        .background(
            RoundedRectangle(cornerRadius: 12)
                .fill(colors.backgroundElevated)
                .overlay(
                    RoundedRectangle(cornerRadius: 12)
                        .stroke(colors.borderSubtle, lineWidth: 1)
                )
        )
    }

    // MARK: - Header

    private var header: some View {
        HStack(spacing: 9) {
            Image(systemName: "person.3.fill")
                .font(.system(size: 12))
                .foregroundColor(AppearanceSettings.shared.accentColor)
            Text("Agent Swarm")
                .font(AppFont.mono(12, weight: .semibold))
                .foregroundColor(colors.textPrimary)
            Spacer(minLength: 0)
            // Real numbers rather than a spinner: how far in, and how close
            // the vote is to ending it.
            Text("Round \(currentRound)")
                .font(AppFont.mono(11))
                .foregroundColor(colors.textTertiary)
            if votesThisRound > 0 {
                Text("· \(votesThisRound)/\(votesNeeded) to hand off")
                    .font(AppFont.mono(11))
                    .foregroundColor(AppearanceSettings.shared.accentColor)
            }
        }
        .padding(.horizontal, 14)
        .padding(.vertical, 11)
    }

    private var divider: some View {
        Divider().overlay(colors.borderSubtle)
    }

    // MARK: - Roster

    private var roster: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text("SPECIALISTS")
                .font(AppFont.mono(9, weight: .semibold))
                .tracking(0.6)
                .foregroundColor(colors.textTertiary)
            // Wraps rather than scrolling sideways — a roster is chosen per
            // task, so it can be three names or six.
            FlowLayout(spacing: 6) {
                ForEach(transcript.personas, id: \.name) { persona in
                    HStack(spacing: 5) {
                        Circle()
                            .fill(hasSpokenThisRound(persona.name)
                                  ? AppearanceSettings.shared.accentColor
                                  : colors.textTertiary.opacity(0.4))
                            .frame(width: 5, height: 5)
                        Text(persona.name)
                            .font(AppFont.mono(10, weight: .medium))
                            .foregroundColor(colors.textSecondary)
                    }
                    .padding(.horizontal, 8)
                    .padding(.vertical, 4)
                    .background(Capsule().fill(colors.backgroundChip))
                }
            }
        }
        .padding(.horizontal, 14)
        .padding(.vertical, 11)
    }

    private func hasSpokenThisRound(_ name: String) -> Bool {
        transcript.remarks.contains { $0.personaName == name && $0.round == currentRound }
    }

    // MARK: - Discussion

    private var discussion: some View {
        VStack(alignment: .leading, spacing: 10) {
            ForEach(Array(transcript.remarks.enumerated()), id: \.offset) { _, remark in
                VStack(alignment: .leading, spacing: 3) {
                    HStack(spacing: 6) {
                        Text(remark.personaName)
                            .font(AppFont.mono(11, weight: .semibold))
                            .foregroundColor(colors.textPrimary)
                        Text("round \(remark.round)")
                            .font(AppFont.mono(9))
                            .foregroundColor(colors.textTertiary)
                        // The vote is the decision worth surfacing: it's what
                        // actually ends the discussion.
                        if remark.wantsToEnd {
                            Text("voted to hand off")
                                .font(AppFont.mono(9, weight: .medium))
                                .foregroundColor(AppearanceSettings.shared.accentColor)
                                .padding(.horizontal, 5)
                                .padding(.vertical, 1)
                                .background(Capsule().fill(AppearanceSettings.shared.accentColor.opacity(0.12)))
                        }
                        Spacer(minLength: 0)
                    }
                    if remark.isError {
                        Text("didn't answer")
                            .font(AppFont.sans(11))
                            .foregroundColor(colors.destructive)
                    } else {
                        Text(remark.text)
                            .font(AppFont.sans(11.5))
                            .foregroundColor(colors.textSecondary)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                }
            }
            if let statusText {
                HStack(spacing: 7) {
                    ProgressView().controlSize(.small).scaleEffect(0.7)
                    Text(statusText.replacingOccurrences(of: "Swarm — ", with: ""))
                        .font(AppFont.mono(10))
                        .foregroundColor(colors.textTertiary)
                }
                .padding(.top, 2)
            }
        }
        .padding(.horizontal, 14)
        .padding(.vertical, 11)
    }
}

/// Minimal wrapping row layout — the roster is a handful of short capsules
/// whose count depends on the task, so they need to wrap rather than clip or
/// scroll. Not worth a dependency or a general-purpose grid.
struct FlowLayout: Layout {
    var spacing: CGFloat = 6

    func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) -> CGSize {
        let maxWidth = proposal.width ?? .infinity
        var x: CGFloat = 0, y: CGFloat = 0, rowHeight: CGFloat = 0
        for view in subviews {
            let size = view.sizeThatFits(.unspecified)
            if x + size.width > maxWidth, x > 0 {
                x = 0; y += rowHeight + spacing; rowHeight = 0
            }
            x += size.width + spacing
            rowHeight = max(rowHeight, size.height)
        }
        return CGSize(width: maxWidth == .infinity ? x : maxWidth, height: y + rowHeight)
    }

    func placeSubviews(in bounds: CGRect, proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) {
        var x = bounds.minX, y = bounds.minY, rowHeight: CGFloat = 0
        for view in subviews {
            let size = view.sizeThatFits(.unspecified)
            if x + size.width > bounds.maxX, x > bounds.minX {
                x = bounds.minX; y += rowHeight + spacing; rowHeight = 0
            }
            view.place(at: CGPoint(x: x, y: y), proposal: ProposedViewSize(size))
            x += size.width + spacing
            rowHeight = max(rowHeight, size.height)
        }
    }
}
