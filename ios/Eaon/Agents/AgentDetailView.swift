import SwiftUI

/// One agent: who it is and what it's doing, its conversation, anything it is
/// waiting on you for, and a box to write to it.
struct AgentDetailView: View {
    let key: AgentKey

    @Environment(AgentsStore.self) private var store
    @Environment(ModelCatalog.self) private var catalog
    @Environment(\.dismiss) private var dismiss

    @State private var draft = ""
    @State private var asGoal = false
    @State private var sendError: String?
    @State private var editing = false
    @State private var confirmsRemove = false
    @State private var confirmsClear = false
    @FocusState private var focused: Bool

    private var source: any AgentSource { store.source(key.place) }
    private var agent: Agent? { store.agent(key) }

    var body: some View {
        ZStack {
            ScreenBackground()
            if let agent {
                content(agent)
            } else {
                ContentUnavailableView("This agent is gone", systemImage: "person.crop.circle.badge.xmark")
            }
        }
        .navigationTitle(agent?.name ?? "")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            if let agent {
                ToolbarItem(placement: .topBarTrailing) { menu(agent) }
            }
        }
        .task {
            await source.loadThread(key.id)
            await source.markRead(key.id)
            store.phone.selected = key.place == .phone ? key.id : nil
        }
        .onDisappear {
            if store.phone.selected == key.id { store.phone.selected = nil }
        }
        .sheet(isPresented: $editing) {
            if let agent { NewAgentView(place: key.place, editing: agent) { _ in } }
        }
        .confirmationDialog("Remove \(agent?.name ?? "this agent")?", isPresented: $confirmsRemove, titleVisibility: .visible) {
            Button("Remove", role: .destructive) {
                Task {
                    try? await source.remove(key.id)
                    dismiss()
                }
            }
        } message: {
            Text(key.place == .mac ? "It stops and is forgotten on your Mac. Its folder stays there." : "Its conversation and notes are deleted from this iPhone.")
        }
        .confirmationDialog("Clear this conversation?", isPresented: $confirmsClear, titleVisibility: .visible) {
            Button("Clear", role: .destructive) { Task { await source.clear(key.id) } }
        } message: {
            Text("The agent keeps its notes, schedule and settings.")
        }
    }

    // MARK: Content

    @ViewBuilder
    private func content(_ agent: Agent) -> some View {
        let messages = source.messages(for: key.id)
        ScrollViewReader { proxy in
            ScrollView {
                VStack(spacing: 22) {
                    AgentHeader(agent: agent, notes: store.phone.record(key.id)?.notes, onGoal: { command in
                        Task { await source.setGoal(key.id, command) }
                    })
                    AgentThread(messages: messages, agent: agent, onRetry: { retry(agent) })
                    Color.clear.frame(height: 4).id(Self.bottom)
                }
                .padding(.horizontal, Metrics.gutter)
                .padding(.top, 8)
                .padding(.bottom, 12)
            }
            .scrollDismissesKeyboard(.interactively)
            .defaultScrollAnchor(.bottom, for: .initialOffset)
            .onChange(of: messages.last?.parts.count) {
                withAnimation(.smooth(duration: 0.3)) { proxy.scrollTo(Self.bottom, anchor: .bottom) }
            }
            .onChange(of: messages.count) {
                withAnimation(.smooth(duration: 0.3)) { proxy.scrollTo(Self.bottom, anchor: .bottom) }
            }
            .onChange(of: messages.last?.text) {
                proxy.scrollTo(Self.bottom, anchor: .bottom)
            }
            // The thread arrives after the page does; once it has, start at its end (above the composer).
            .task(id: key) {
                await source.loadThread(key.id)
                try? await Task.sleep(for: .milliseconds(150))
                proxy.scrollTo(Self.bottom, anchor: .bottom)
            }
        }
        .safeAreaInset(edge: .bottom, spacing: 0) {
            VStack(spacing: 8) {
                ForEach(agent.asks) { ask in
                    AskCard(ask: ask) { text, approved in
                        Haptic.tap()
                        Task { await source.answer(key.id, askID: ask.id, text: text, approved: approved) }
                    }
                    .transition(.move(edge: .bottom).combined(with: .opacity).combined(with: .scale(scale: 0.96, anchor: .bottom)))
                }
                if let sendError {
                    Callout(kind: .error, title: "Couldn't send that", message: sendError, onDismiss: { self.sendError = nil })
                        .padding(.horizontal, 12)
                        .transition(.move(edge: .bottom).combined(with: .opacity))
                }
                AgentComposer(
                    text: $draft,
                    asGoal: $asGoal,
                    focused: $focused,
                    placeholder: "Message \(agent.name)",
                    isWorking: agent.isWorking,
                    canSend: source.isAvailable && !draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty,
                    onSend: { send() },
                    onStop: {
                        Haptic.tap()
                        Task { await source.stop(key.id) }
                    }
                )
            }
            .animation(Springs.smooth, value: agent.asks)
            .animation(Springs.smooth, value: sendError)
            .padding(.top, 10)
            .padding(.bottom, 4)
            .background {
                // The conversation fades out behind the composer rather than stopping at a hard edge.
                LinearGradient(
                    stops: [
                        .init(color: Palette.background.opacity(0), location: 0),
                        .init(color: Palette.background, location: 0.3)
                    ],
                    startPoint: .top,
                    endPoint: .bottom
                )
                .ignoresSafeArea(edges: .bottom)
                .allowsHitTesting(false)
            }
        }
    }

    private static let bottom = "agent-bottom"

    private func send() {
        let text = draft
        let goal = asGoal
        Haptic.tap()
        draft = ""
        asGoal = false
        Task {
            do {
                try await source.send(key.id, text: text, asGoal: goal)
                sendError = nil
            } catch {
                draft = text
                asGoal = goal
                Haptic.failure()
                sendError = (error as? LocalizedError)?.errorDescription ?? error.localizedDescription
            }
        }
    }

    /// Asks a failed turn to go again, by waking the agent.
    private func retry(_ agent: Agent) {
        Haptic.tap()
        Task { await source.wake(key.id) }
    }

    // MARK: Menu

    private func menu(_ agent: Agent) -> some View {
        Menu {
            if agent.isWorking {
                Button("Stop", systemImage: "stop.fill") { Task { await source.stop(key.id) } }
            } else {
                Button("Check in now", systemImage: "bolt.fill") { Task { await source.wake(key.id) } }
            }
            Button(agent.isPaused ? "Resume" : "Pause", systemImage: agent.isPaused ? "play.fill" : "pause.fill") {
                Task { await source.setPaused(key.id, paused: !agent.isPaused) }
            }
            Divider()
            Button("Edit", systemImage: "slider.horizontal.3") { editing = true }
            Button("Clear conversation", systemImage: "eraser") { confirmsClear = true }
            Button("Remove", systemImage: "trash", role: .destructive) { confirmsRemove = true }
        } label: {
            Image(systemName: "ellipsis")
        }
        .accessibilityLabel("More")
    }
}

// MARK: - Header

/// Who the agent is: its face, where it runs, what it's doing, its goal.
private struct AgentHeader: View {
    let agent: Agent
    var notes: String?
    var onGoal: (GoalCommand) -> Void

    @State private var showsAbout = false

    var body: some View {
        VStack(spacing: 16) {
            AgentFace(agent: agent, size: 84)
                .frame(width: 100, height: 100)
                .padding(.top, 6)
                .entrance(rise: 10, scale: 0.6, animation: Springs.bouncy)

            VStack(spacing: 6) {
                Text(agent.name)
                    .font(.title2.weight(.semibold))
                    .foregroundStyle(Palette.ink)
                HStack(spacing: 8) {
                    Label(agent.place.title, systemImage: agent.place == .phone ? "iphone" : "laptopcomputer")
                    Text("·")
                    Text(AgentWords.status(for: agent))
                        .contentTransition(.opacity)
                }
                .font(.footnote.weight(.medium))
                .foregroundStyle(Palette.secondary)
                if agent.status != .asleep || !agent.activity.isEmpty {
                    Text(AgentWords.line(for: agent))
                        .font(.subheadline)
                        .foregroundStyle(Palette.secondary)
                        .multilineTextAlignment(.center)
                        .contentTransition(.opacity)
                }
            }
            .animation(Springs.smooth, value: AgentWords.line(for: agent))
            .entrance(delay: 0.08)

            if let goal = agent.goalRun {
                GoalCard(run: goal, onCommand: onGoal)
                    .transition(.opacity.combined(with: .scale(scale: 0.96)))
            }

            DisclosureGroup(isExpanded: $showsAbout) {
                VStack(alignment: .leading, spacing: 12) {
                    about("What it's for", agent.purpose)
                    if !agent.personality.isEmpty { about("Its manner", agent.personality) }
                    about("Access", "\(agent.access.title). \(agent.access.summary(on: agent.place))")
                    if let model = agent.modelName { about("Model", model) }
                    if let next = agent.nextWakeAt, !agent.isPaused { about("Next check-in", next.formatted(date: .abbreviated, time: .shortened)) }
                    if let notes, !notes.isEmpty { about("What it remembers", notes) }
                }
                .padding(.top, 10)
            } label: {
                Text("About")
                    .font(.subheadline.weight(.semibold))
                    .foregroundStyle(Palette.ink)
            }
            .tint(Palette.secondary)
        }
        .frame(maxWidth: .infinity)
        .card(padding: 18)
        .animation(Springs.smooth, value: agent.goalRun == nil)
    }

    private func about(_ title: String, _ text: String) -> some View {
        VStack(alignment: .leading, spacing: 2) {
            Text(title).font(.caption.weight(.semibold)).foregroundStyle(Palette.secondary)
            Text(text).font(.subheadline).foregroundStyle(Palette.ink).fixedSize(horizontal: false, vertical: true)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }
}

private struct GoalCard: View {
    let run: AgentGoalRun
    var onCommand: (GoalCommand) -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack(spacing: 8) {
                Image(systemName: icon).foregroundStyle(color)
                Text("Goal · \(stateText)").font(.footnote.weight(.semibold)).foregroundStyle(color)
                Spacer()
                if run.turns > 0 { Text("\(run.turns) turn\(run.turns == 1 ? "" : "s")").font(.caption).foregroundStyle(Palette.secondary) }
            }
            Text(run.text)
                .font(.subheadline)
                .foregroundStyle(Palette.ink)
                .frame(maxWidth: .infinity, alignment: .leading)
            if let summary = run.summary, !summary.isEmpty {
                Text(summary).font(.footnote).foregroundStyle(Palette.secondary)
            }
            HStack(spacing: 8) {
                switch run.state {
                case .active: small("Pause", "pause.fill") { onCommand(.pause) }
                case .paused: small("Continue", "play.fill") { onCommand(.resume) }
                case .achieved, .blocked: EmptyView()
                }
                small("Clear", "xmark") { onCommand(.clear) }
            }
        }
        .padding(14)
        .background(color.opacity(0.08), in: RoundedRectangle(cornerRadius: 18, style: .continuous))
    }

    private var stateText: String {
        switch run.state {
        case .active: "working on it"
        case .paused: "paused"
        case .achieved: "done"
        case .blocked: "blocked"
        }
    }

    private var icon: String {
        switch run.state {
        case .active: "scope"
        case .paused: "pause.circle"
        case .achieved: "checkmark.circle.fill"
        case .blocked: "exclamationmark.circle.fill"
        }
    }

    private var color: Color {
        switch run.state {
        case .active: Palette.tint
        case .paused: Palette.caution
        case .achieved: Palette.positive
        case .blocked: Palette.negative
        }
    }

    private func small(_ title: String, _ symbol: String, action: @escaping () -> Void) -> some View {
        Button {
            Haptic.select()
            action()
        } label: {
            Label(title, systemImage: symbol)
                .font(.footnote.weight(.semibold))
                .padding(.horizontal, 12)
                .frame(height: 30)
                .background(Palette.background, in: Capsule())
                .foregroundStyle(Palette.ink)
        }
        .buttonStyle(PressableStyle(scale: 0.95))
    }
}

// MARK: - A question

/// Something the agent is waiting on you for: a question with quick answers, or a thing it asks to do.
struct AskCard: View {
    let ask: AgentAsk
    var onAnswer: (_ text: String?, _ approved: Bool?) -> Void

    @State private var text = ""

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack(alignment: .top, spacing: 10) {
                Image(systemName: ask.approval == nil ? "questionmark.bubble.fill" : "hand.raised.fill")
                    .foregroundStyle(Palette.tint)
                    .padding(.top, 1)
                Text(ask.question)
                    .font(.subheadline.weight(.semibold))
                    .foregroundStyle(Palette.ink)
                    .fixedSize(horizontal: false, vertical: true)
            }
            if let approval = ask.approval {
                Text(approval)
                    .font(.footnote)
                    .foregroundStyle(Palette.secondary)
                    .fixedSize(horizontal: false, vertical: true)
                HStack(spacing: 10) {
                    Button("Not now") { onAnswer(nil, false) }
                        .buttonStyle(PillButtonStyle(kind: .secondary))
                    Button("Allow") { onAnswer(nil, true) }
                        .buttonStyle(PillButtonStyle(kind: .primary))
                }
                .controlSize(.small)
            } else {
                if !ask.options.isEmpty {
                    ChipFlow(spacing: 8) {
                        ForEach(ask.options, id: \.self) { option in
                            Button(option) { onAnswer(option, nil) }
                                .font(.footnote.weight(.semibold))
                                .padding(.horizontal, 14)
                                .frame(height: 34)
                                .background(Palette.surface, in: Capsule())
                                .foregroundStyle(Palette.ink)
                                .buttonStyle(PressableStyle(scale: 0.95))
                        }
                    }
                }
                HStack(spacing: 8) {
                    TextField("Or write an answer", text: $text)
                        .font(.subheadline)
                        .padding(.horizontal, 14)
                        .frame(height: 38)
                        .background(Palette.surface, in: Capsule())
                        .submitLabel(.send)
                        .onSubmit(send)
                    Button(action: send) {
                        Image(systemName: "arrow.up")
                    }
                    .buttonStyle(RoundButtonStyle(diameter: 34))
                    .disabled(text.trimmingCharacters(in: .whitespaces).isEmpty)
                    .accessibilityLabel("Send answer")
                }
            }
        }
        .padding(14)
        .background(Palette.background, in: RoundedRectangle(cornerRadius: 22, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: 22, style: .continuous).strokeBorder(Palette.tint.opacity(0.3), lineWidth: 1))
        .shadow(color: .black.opacity(0.06), radius: 14, y: 4)
        .padding(.horizontal, 12)
    }

    private func send() {
        let answer = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !answer.isEmpty else { return }
        text = ""
        onAnswer(answer, nil)
    }
}

/// Wraps its children onto lines, like text.
struct ChipFlow: Layout {
    var spacing: CGFloat = 8

    func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) -> CGSize {
        arrange(width: proposal.width ?? .infinity, subviews: subviews).size
    }

    func placeSubviews(in bounds: CGRect, proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) {
        let result = arrange(width: bounds.width, subviews: subviews)
        for (index, frame) in result.frames.enumerated() {
            subviews[index].place(at: CGPoint(x: bounds.minX + frame.minX, y: bounds.minY + frame.minY), proposal: ProposedViewSize(frame.size))
        }
    }

    private func arrange(width: CGFloat, subviews: Subviews) -> (size: CGSize, frames: [CGRect]) {
        var frames: [CGRect] = []
        var x: CGFloat = 0
        var y: CGFloat = 0
        var rowHeight: CGFloat = 0
        var maxX: CGFloat = 0
        for subview in subviews {
            let size = subview.sizeThatFits(.unspecified)
            if x > 0, x + size.width > width {
                x = 0
                y += rowHeight + spacing
                rowHeight = 0
            }
            frames.append(CGRect(x: x, y: y, width: size.width, height: size.height))
            x += size.width + spacing
            rowHeight = max(rowHeight, size.height)
            maxX = max(maxX, x - spacing)
        }
        return (CGSize(width: maxX, height: y + rowHeight), frames)
    }
}

// MARK: - The composer

struct AgentComposer: View {
    @Binding var text: String
    @Binding var asGoal: Bool
    var focused: FocusState<Bool>.Binding
    var placeholder: String
    var isWorking: Bool
    var canSend: Bool
    var onSend: () -> Void
    var onStop: () -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            TextField(placeholder, text: $text, axis: .vertical)
                .lineLimit(1...5)
                .font(.body)
                .foregroundStyle(Palette.ink)
                .tint(Palette.ink)
                .focused(focused)
                .padding(.top, 2)
                .padding(.trailing, 8)

            HStack(spacing: 8) {
                Button {
                    Haptic.select()
                    withAnimation(Springs.bouncy) { asGoal.toggle() }
                } label: {
                    HStack(spacing: 6) {
                        Image(systemName: "scope")
                            .symbolEffect(.bounce, value: asGoal)
                        Text("Goal")
                    }
                    .font(.footnote.weight(.semibold))
                    .foregroundStyle(asGoal ? Palette.background : Palette.ink.opacity(0.75))
                    .padding(.horizontal, 12)
                    .frame(height: 34)
                    .background(asGoal ? Palette.ink : Palette.fill, in: Capsule())
                }
                .buttonStyle(PressableStyle(scale: 0.94))
                .accessibilityLabel("Send as a goal")
                .accessibilityValue(asGoal ? "On" : "Off")
                .accessibilityHint("The agent keeps working on it until it's done")

                Spacer(minLength: 0)

                Button(action: isWorking ? onStop : onSend) {
                    Image(systemName: isWorking ? "stop.fill" : "arrow.up")
                        .contentTransition(.symbolEffect(.replace))
                }
                .buttonStyle(RoundButtonStyle(diameter: 36))
                .disabled(!isWorking && !canSend)
                .accessibilityLabel(isWorking ? "Stop" : "Send")
                .animation(Springs.snappy, value: isWorking)
            }
        }
        .padding(.leading, 18)
        .padding(.trailing, 8)
        .padding(.top, 14)
        .padding(.bottom, 8)
        .background(Palette.surface, in: RoundedRectangle(cornerRadius: 26, style: .continuous))
        .padding(.horizontal, 12)
        .padding(.bottom, 4)
    }
}
