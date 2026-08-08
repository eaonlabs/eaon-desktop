import SwiftUI

/// The agent's question, as a stepped flow.
///
/// Replaces a dialog whose options were bare labels in a stack of identical
/// buttons. Three things make this a better place to answer from:
///
/// - **Options carry a description.** "Python — fastest to prototype" is a
///   decision; "Python" is a guess. This is the single biggest difference,
///   and it's why the model is now asked for descriptions in its schema.
/// - **A numbered chip per row**, which doubles as the keyboard shortcut.
///   Press 2, get option 2 — answering a question shouldn't require reaching
///   for the mouse.
/// - **Multi-select and skip** exist, so the model can ask "which of these"
///   without forcing a false single choice, and the user can decline without
///   having to invent an answer.
///
/// The answer goes back to the model as plain prose, because that's what it
/// reads — the structure here is for the person, not the protocol.
struct AskUserQuestions: View {
    @Environment(\.themeColors) private var colors
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    let flow: PendingAgentQuestion
    /// Called once with the whole flow's answer, or nil if it was dismissed.
    let onComplete: (String?) -> Void

    @State private var index = 0
    @State private var answers: [String: String] = [:]
    /// Selections for the question on screen. Reset on every step.
    @State private var selected: Set<String> = []
    @State private var otherText = ""
    @State private var appeared = false
    @FocusState private var otherFocused: Bool

    private var question: AgentQuestionItem { flow.questions[min(index, flow.questions.count - 1)] }
    private var isLast: Bool { index >= flow.questions.count - 1 }
    private var hasAnswer: Bool {
        !selected.isEmpty || !otherText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    }

    var body: some View {
        ZStack {
            colors.backgroundOverlay
                .ignoresSafeArea()
                .onTapGesture { onComplete(nil) }

            VStack(alignment: .leading, spacing: 0) {
                header
                Text(question.title)
                    .font(AppFont.sans(15, weight: .semibold))
                    .foregroundStyle(colors.textPrimary)
                    .fixedSize(horizontal: false, vertical: true)
                    .lineSpacing(3)
                    .padding(.bottom, 14)

                VStack(spacing: 6) {
                    ForEach(Array(question.options.enumerated()), id: \.element.id) { position, option in
                        optionRow(option, number: position + 1)
                    }
                }

                if question.allowOther || question.isFreeTextOnly {
                    otherField
                        .padding(.top, question.options.isEmpty ? 0 : 8)
                }

                footer
            }
            .padding(22)
            .frame(width: 460)
            .background(
                RoundedRectangle(cornerRadius: 20, style: .continuous)
                    .fill(colors.backgroundPopover)
            )
            .overlay(
                RoundedRectangle(cornerRadius: 20, style: .continuous)
                    .stroke(colors.borderSubtle, lineWidth: 1)
            )
            .shadow(color: .black.opacity(0.3), radius: 40, y: 16)
            .scaleEffect(appeared ? 1 : 0.94)
            .opacity(appeared ? 1 : 0)
        }
        .onAppear {
            withAnimation(reduceMotion ? nil : .easeOut(duration: 0.18)) { appeared = true }
            if question.isFreeTextOnly { otherFocused = true }
        }
        // Digit keys pick an option, so a keyboard answer never needs the
        // mouse. Registered as hidden buttons because SwiftUI has no plain
        // "key pressed" hook on macOS 14.
        .background(numberShortcuts)
    }

    // MARK: - Header

    private var header: some View {
        HStack(spacing: 10) {
            Image(systemName: "questionmark.bubble.fill")
                .font(.system(size: 15))
                .foregroundStyle(AppearanceSettings.shared.accentColor)
            Text("Eaon has a question")
                .font(AppFont.mono(16, weight: .semibold))
                .foregroundStyle(colors.textPrimary)

            Spacer(minLength: 8)

            if flow.questions.count > 1 {
                Text("\(index + 1) of \(flow.questions.count)")
                    .font(AppFont.mono(11))
                    .foregroundStyle(colors.textTertiary)
            }
            if question.skippable {
                Button("Skip") { advance(with: nil) }
                    .buttonStyle(.plain)
                    .font(AppFont.mono(11))
                    .foregroundStyle(colors.textTertiary)
            }
        }
        .padding(.bottom, 12)
    }

    // MARK: - Options

    private func optionRow(_ option: AgentQuestionOption, number: Int) -> some View {
        let isOn = selected.contains(option.id)
        return Button {
            choose(option)
        } label: {
            HStack(alignment: .top, spacing: 10) {
                VStack(alignment: .leading, spacing: 2) {
                    Text(option.title)
                        .font(AppFont.sans(13.5, weight: .medium))
                        .foregroundStyle(colors.textPrimary)
                        .fixedSize(horizontal: false, vertical: true)
                        .frame(maxWidth: .infinity, alignment: .leading)
                    if let description = option.description, !description.isEmpty {
                        Text(description)
                            .font(AppFont.sans(11.5))
                            .foregroundStyle(colors.textTertiary)
                            .fixedSize(horizontal: false, vertical: true)
                            .frame(maxWidth: .infinity, alignment: .leading)
                    }
                }

                // The numbered chip, which is also the shortcut. In
                // multi-select it becomes the checked state, so one mark
                // carries both "this is number 3" and "3 is chosen".
                Text(isOn ? "✓" : "\(number)")
                    .font(AppFont.mono(10.5, weight: .semibold))
                    .foregroundStyle(isOn ? colors.backgroundPrimary : colors.textTertiary)
                    .frame(width: 18, height: 18)
                    .background(
                        RoundedRectangle(cornerRadius: 5, style: .continuous)
                            .fill(isOn ? AppearanceSettings.shared.accentColor : colors.backgroundChip)
                    )
                    .padding(.top, 1)
            }
            .padding(.horizontal, 13)
            .padding(.vertical, 10)
            .background(
                RoundedRectangle(cornerRadius: 10, style: .continuous)
                    .fill(isOn ? AppearanceSettings.shared.accentColor.opacity(0.10) : colors.backgroundInput)
            )
            .overlay(
                RoundedRectangle(cornerRadius: 10, style: .continuous)
                    .stroke(isOn ? AppearanceSettings.shared.accentColor.opacity(0.55) : colors.borderMedium, lineWidth: 1)
            )
            .contentShape(RoundedRectangle(cornerRadius: 10, style: .continuous))
        }
        .buttonStyle(PressableButtonStyle())
    }

    private var otherField: some View {
        TextField(
            question.isFreeTextOnly ? "Type your answer…" : "Or describe it in your own words…",
            text: $otherText,
            axis: .vertical
        )
        .textFieldStyle(.plain)
        .font(AppFont.sans(13))
        .foregroundStyle(colors.textPrimary)
        .lineLimit(1...4)
        .focused($otherFocused)
        .padding(.horizontal, 13)
        .padding(.vertical, 10)
        .background(
            RoundedRectangle(cornerRadius: 10, style: .continuous)
                .fill(colors.backgroundInput)
        )
        .overlay(
            RoundedRectangle(cornerRadius: 10, style: .continuous)
                .stroke(otherFocused ? AppearanceSettings.shared.accentColor.opacity(0.5) : colors.borderSubtle, lineWidth: 1)
        )
        // Enter submits a typed answer — the field is the answer, so making
        // someone reach for a button after typing one would be friction for
        // its own sake.
        .onSubmit { if hasAnswer { advance(with: currentAnswerText()) } }
    }

    // MARK: - Footer

    @ViewBuilder
    private var footer: some View {
        // Single-select with no typed text needs no button at all: clicking
        // the option IS the submit. A button appears only when a click can't
        // finish the job — multi-select, or free text.
        let needsButton = question.multiSelect || question.isFreeTextOnly || !otherText.isEmpty
        if needsButton {
            HStack {
                Spacer()
                DialogButton(
                    title: isLast ? "Done" : "Next",
                    style: hasAnswer ? .primary : .secondary
                ) {
                    if hasAnswer { advance(with: currentAnswerText()) }
                }
                .opacity(hasAnswer ? 1 : 0.5)
            }
            .padding(.top, 14)
        }
    }

    // MARK: - Behaviour

    private func choose(_ option: AgentQuestionOption) {
        if question.multiSelect {
            if selected.contains(option.id) { selected.remove(option.id) } else { selected.insert(option.id) }
            return
        }
        // Single-select: the click is the answer.
        selected = [option.id]
        advance(with: currentAnswerText())
    }

    /// What the user actually said, as one line the model can read.
    private func currentAnswerText() -> String {
        let picked = question.options
            .filter { selected.contains($0.id) }
            .map(\.title)
        let typed = otherText.trimmingCharacters(in: .whitespacesAndNewlines)
        var parts = picked
        if !typed.isEmpty { parts.append(typed) }
        return parts.joined(separator: ", ")
    }

    /// Records this step and moves on, finishing the flow on the last one.
    private func advance(with answer: String?) {
        if let answer, !answer.isEmpty {
            answers[question.title] = answer
        } else {
            answers[question.title] = nil
        }

        guard !isLast else {
            onComplete(summary())
            return
        }
        withAnimation(reduceMotion ? nil : .easeOut(duration: 0.16)) {
            index += 1
            selected = []
            otherText = ""
        }
        if flow.questions[index].isFreeTextOnly { otherFocused = true }
    }

    /// The whole flow as prose. One question answers as a bare value (the
    /// model asked one thing and gets one thing back); several are labelled,
    /// so the model can tell which answer belongs to which question.
    private func summary() -> String? {
        let ordered = flow.questions.compactMap { item -> String? in
            guard let answer = answers[item.title], !answer.isEmpty else { return nil }
            return flow.questions.count == 1 ? answer : "\(item.title) → \(answer)"
        }
        guard !ordered.isEmpty else { return nil }
        return ordered.joined(separator: "\n")
    }

    /// 1–5 select the matching option. Hidden buttons rather than a key
    /// monitor: they're scoped to this view's lifetime automatically, so
    /// there's no global handler left installed if the dialog goes away
    /// mid-flight.
    private var numberShortcuts: some View {
        ForEach(Array(question.options.enumerated()), id: \.element.id) { position, option in
            Button("") { choose(option) }
                .keyboardShortcut(
                    KeyEquivalent(Character("\(position + 1)")),
                    modifiers: []
                )
                .opacity(0)
                .frame(width: 0, height: 0)
                .accessibilityHidden(true)
        }
    }
}
