import AppKit
import SwiftUI

// MARK: - Run confirmation dialog

/// Shown the first time in a conversation the coding agent wants to
/// actually execute a file — it runs with the user's full permissions, no
/// sandbox, so this is a real decision, not a formality. Approving covers
/// the rest of *this* conversation only; a new chat asks again.
struct RunConfirmationDialog: View {
    @Environment(\.themeColors) private var colors
    let path: String
    let onAllow: () -> Void
    let onDeny: () -> Void

    @State private var appeared = false

    var body: some View {
        ZStack {
            colors.backgroundOverlay
                .ignoresSafeArea()
                .onTapGesture { onDeny() }

            VStack(alignment: .leading, spacing: 0) {
                HStack(spacing: 10) {
                    Image(systemName: "exclamationmark.triangle.fill")
                        .font(.system(size: 16))
                        .foregroundStyle(.orange)
                    Text("Run generated code?")
                        .font(AppFont.mono(18, weight: .semibold))
                        .foregroundStyle(colors.textPrimary)
                }
                .padding(.bottom, 14)

                (Text("The model wants to run ")
                    .foregroundStyle(colors.textSecondary)
                 + Text(path)
                    .foregroundStyle(colors.textPrimary)
                    .fontWeight(.semibold)
                 + Text(" on your Mac, with your full user permissions and no sandbox, so nothing is isolated from the rest of your system. Allowing this covers the rest of this conversation. A new chat asks again.")
                    .foregroundStyle(colors.textSecondary))
                    .font(AppFont.sans(14))
                    .fixedSize(horizontal: false, vertical: true)
                    .lineSpacing(3)
                    .padding(.bottom, 24)

                HStack(spacing: 10) {
                    Spacer()
                    DialogButton(title: "Don't Run", style: .secondary) { onDeny() }
                    DialogButton(title: "Allow for This Chat", style: .primary) { onAllow() }
                }
            }
            .padding(24)
            .frame(width: 440)
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
            withAnimation(.easeOut(duration: 0.18)) { appeared = true }
        }
    }
}

// MARK: - MCP call confirmation dialog

/// Shown before every single GitHub tool call the model wants to make —
/// unlike `RunConfirmationDialog`, this asks every time rather than once
/// per conversation, because the action itself happens on GitHub, not
/// sandboxed on this Mac (an issue, a comment, a pushed commit — all real,
/// all visible to other people, none of it undoable by closing the app).
struct MCPCallConfirmationDialog: View {
    @Environment(\.themeColors) private var colors
    let call: PendingMCPCall
    let onAllow: () -> Void
    let onDeny: () -> Void

    @State private var appeared = false

    private var prettyArguments: String {
        guard let data = call.argumentsJSON.data(using: .utf8),
              let object = try? JSONSerialization.jsonObject(with: data),
              let pretty = try? JSONSerialization.data(withJSONObject: object, options: [.prettyPrinted, .sortedKeys]),
              let text = String(data: pretty, encoding: .utf8) else {
            return call.argumentsJSON.isEmpty ? "(no arguments)" : call.argumentsJSON
        }
        return text
    }

    var body: some View {
        ZStack {
            colors.backgroundOverlay
                .ignoresSafeArea()
                .onTapGesture { onDeny() }

            VStack(alignment: .leading, spacing: 0) {
                HStack(spacing: 10) {
                    Image(systemName: "exclamationmark.triangle.fill")
                        .font(.system(size: 16))
                        .foregroundStyle(.orange)
                    Text("Run this GitHub action?")
                        .font(AppFont.mono(18, weight: .semibold))
                        .foregroundStyle(colors.textPrimary)
                }
                .padding(.bottom, 14)

                (Text("The model wants to call ")
                    .foregroundStyle(colors.textSecondary)
                 + Text(call.tool)
                    .foregroundStyle(colors.textPrimary)
                    .fontWeight(.semibold)
                 + Text(" on your connected \(call.serverDisplayName) account. This happens for real. Nothing here is sandboxed, and closing the app won't undo it.")
                    .foregroundStyle(colors.textSecondary))
                    .font(AppFont.sans(14))
                    .fixedSize(horizontal: false, vertical: true)
                    .lineSpacing(3)
                    .padding(.bottom, 14)

                ScrollView {
                    Text(prettyArguments)
                        .font(AppFont.mono(12))
                        .foregroundStyle(colors.textSecondary)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .padding(10)
                }
                .frame(maxHeight: 140)
                .background(colors.backgroundInput)
                .clipShape(RoundedRectangle(cornerRadius: 8, style: .continuous))
                .overlay(
                    RoundedRectangle(cornerRadius: 8, style: .continuous)
                        .stroke(colors.borderSubtle, lineWidth: 1)
                )
                .padding(.bottom, 24)

                HStack(spacing: 10) {
                    Spacer()
                    DialogButton(title: "Don't Allow", style: .secondary) { onDeny() }
                    DialogButton(title: "Allow", style: .primary) { onAllow() }
                }
            }
            .padding(24)
            .frame(width: 440)
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
            withAnimation(.easeOut(duration: 0.18)) { appeared = true }
        }
    }
}

// MARK: - Desktop control confirmation dialog

/// Shown before every action that changes something on this Mac — a move, a
/// trashed file, a shell command, an app being driven. `list_directory` (the
/// one read-only tool) never reaches here. "Allow for This Chat" grants the
/// task autonomy for the rest of this conversation only; a new chat starts
/// fresh. The full command or script is shown verbatim, so nothing risky
/// hides behind a tidy one-line summary.
struct DesktopCallConfirmationDialog: View {
    @Environment(\.themeColors) private var colors
    let call: PendingDesktopCall
    let onAllowOnce: () -> Void
    let onAllowAll: () -> Void
    let onDeny: () -> Void

    @State private var appeared = false

    var body: some View {
        ZStack {
            colors.backgroundOverlay
                .ignoresSafeArea()
                .onTapGesture { onDeny() }

            VStack(alignment: .leading, spacing: 0) {
                HStack(spacing: 10) {
                    Image(systemName: "exclamationmark.triangle.fill")
                        .font(.system(size: 16))
                        .foregroundStyle(.orange)
                    Text("Allow this action on your Mac?")
                        .font(AppFont.mono(18, weight: .semibold))
                        .foregroundStyle(colors.textPrimary)
                }
                .padding(.bottom, 14)

                Text(call.summary)
                    .font(AppFont.sans(15, weight: .semibold))
                    .foregroundStyle(colors.textPrimary)
                    .fixedSize(horizontal: false, vertical: true)
                    .lineSpacing(3)
                    .padding(.bottom, call.detail == nil ? 14 : 10)

                if let detail = call.detail {
                    ScrollView {
                        Text(detail)
                            .font(AppFont.mono(12))
                            .foregroundStyle(colors.textSecondary)
                            .frame(maxWidth: .infinity, alignment: .leading)
                            .textSelection(.enabled)
                            .padding(10)
                    }
                    .frame(maxHeight: 140)
                    .background(colors.backgroundInput)
                    .clipShape(RoundedRectangle(cornerRadius: 8, style: .continuous))
                    .overlay(
                        RoundedRectangle(cornerRadius: 8, style: .continuous)
                            .stroke(colors.borderSubtle, lineWidth: 1)
                    )
                    .padding(.bottom, 14)
                }

                Text("This runs on your Mac with your permissions. It's real, and closing the app won't undo it, though deletions go to the Trash so they're recoverable. \"Allow for This Chat\" stops the asking for the rest of this conversation.")
                    .font(AppFont.sans(13))
                    .foregroundStyle(colors.textSecondary)
                    .fixedSize(horizontal: false, vertical: true)
                    .lineSpacing(3)
                    .padding(.bottom, 22)

                HStack(spacing: 10) {
                    DialogButton(title: "Don't Allow", style: .secondary) { onDeny() }
                    Spacer()
                    DialogButton(title: "Allow for This Chat", style: .secondary) { onAllowAll() }
                    DialogButton(title: "Allow", style: .primary) { onAllowOnce() }
                }
            }
            .padding(24)
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
            withAnimation(.easeOut(duration: 0.18)) { appeared = true }
        }
    }
}

// MARK: - Agent question (ask_user tool)

/// The agent paused mid-task to ask the user something — clickable option
/// buttons for the choices it offered (tap = answer immediately), plus an
/// always-present free-text field for saying it in your own words instead.
struct AgentQuestionDialog: View {
    @Environment(\.themeColors) private var colors
    let question: PendingAgentQuestion
    /// Called with the user's answer, or nil for a dismissal.
    let onAnswer: (String?) -> Void

    @State private var customAnswer = ""
    @State private var appeared = false
    @FocusState private var fieldFocused: Bool

    var body: some View {
        ZStack {
            colors.backgroundOverlay
                .ignoresSafeArea()
                .onTapGesture { onAnswer(nil) }

            VStack(alignment: .leading, spacing: 0) {
                HStack(spacing: 10) {
                    Image(systemName: "questionmark.bubble.fill")
                        .font(.system(size: 16))
                        .foregroundStyle(AppearanceSettings.shared.accentColor)
                    Text("Eaon has a question")
                        .font(AppFont.mono(18, weight: .semibold))
                        .foregroundStyle(colors.textPrimary)
                }
                .padding(.bottom, 14)

                Text(question.question)
                    .font(AppFont.sans(15, weight: .semibold))
                    .foregroundStyle(colors.textPrimary)
                    .fixedSize(horizontal: false, vertical: true)
                    .lineSpacing(3)
                    .padding(.bottom, 16)

                if !question.options.isEmpty {
                    VStack(spacing: 8) {
                        ForEach(question.options, id: \.self) { option in
                            Button {
                                onAnswer(option)
                            } label: {
                                Text(option)
                                    .font(AppFont.sans(14, weight: .medium))
                                    .foregroundStyle(colors.textPrimary)
                                    .frame(maxWidth: .infinity, alignment: .leading)
                                    .padding(.horizontal, 14)
                                    .padding(.vertical, 11)
                                    .background(
                                        RoundedRectangle(cornerRadius: 10, style: .continuous)
                                            .fill(colors.backgroundInput)
                                    )
                                    .overlay(
                                        RoundedRectangle(cornerRadius: 10, style: .continuous)
                                            .stroke(colors.borderMedium, lineWidth: 1)
                                    )
                                    .contentShape(RoundedRectangle(cornerRadius: 10, style: .continuous))
                            }
                            .buttonStyle(PressableButtonStyle())
                        }
                    }
                    .padding(.bottom, 14)
                }

                HStack(spacing: 8) {
                    TextField(question.options.isEmpty ? "Type your answer…" : "Or type your own answer…", text: $customAnswer)
                        .textFieldStyle(.plain)
                        .font(AppFont.sans(14))
                        .focused($fieldFocused)
                        .onSubmit { submitCustom() }
                        .padding(.horizontal, 12)
                        .padding(.vertical, 9)
                        .background(colors.backgroundInput)
                        .clipShape(RoundedRectangle(cornerRadius: 9, style: .continuous))
                        .overlay(
                            RoundedRectangle(cornerRadius: 9, style: .continuous)
                                .stroke(colors.borderSubtle, lineWidth: 1)
                        )

                    DialogButton(title: "Answer", style: .primary) { submitCustom() }
                }
                .padding(.bottom, 14)

                HStack {
                    DialogButton(title: "Skip", style: .secondary) { onAnswer(nil) }
                        .help("Dismiss without answering. Eaon proceeds on its own judgment")
                    Spacer()
                }
            }
            .padding(24)
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
            withAnimation(.easeOut(duration: 0.18)) { appeared = true }
            // A free-form question (no options) is answered by typing —
            // put the caret there immediately.
            if question.options.isEmpty { fieldFocused = true }
        }
    }

    private func submitCustom() {
        let trimmed = customAnswer.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return }
        onAnswer(trimmed)
    }
}

// MARK: - Enter Auto mode confirmation (coding Agent)

/// The are-you-sure gate before the coding Agent's Auto (unsandboxed) mode.
/// Auto turns off the per-command confirmation entirely — the agent writes
/// files and runs shell commands on the real Mac without asking each time —
/// so switching *into* it (never out of it) is deliberately gated behind
/// this. Amber, not red: it's a real, informed power-user choice, not a
/// destructive action.
struct AutoModeConfirmationDialog: View {
    @Environment(\.themeColors) private var colors
    let onConfirm: () -> Void
    let onCancel: () -> Void

    @State private var appeared = false
    private let amber = Color(hex: "#F59E0B")

    var body: some View {
        ZStack {
            colors.backgroundOverlay
                .ignoresSafeArea()
                .onTapGesture { onCancel() }

            VStack(alignment: .leading, spacing: 0) {
                HStack(spacing: 10) {
                    Image(systemName: "bolt.fill")
                        .font(.system(size: 16))
                        .foregroundStyle(amber)
                    Text("Switch to Auto mode?")
                        .font(AppFont.mono(18, weight: .semibold))
                        .foregroundStyle(colors.textPrimary)
                }
                .padding(.bottom, 12)

                Text("In Auto mode, Eaon runs shell commands and writes files on your Mac **without asking each time**. It's faster for long coding tasks, but it means commands run the moment the agent decides to, including ones that overwrite or remove files.")
                    .font(AppFont.sans(13))
                    .foregroundStyle(colors.textSecondary)
                    .fixedSize(horizontal: false, vertical: true)
                    .lineSpacing(3)
                    .padding(.bottom, 10)

                Text("Only use it for a task you trust, and keep an eye on what it does. Press ⇧⇥ anytime to drop back to Sandboxed.")
                    .font(AppFont.sans(13))
                    .foregroundStyle(colors.textSecondary)
                    .fixedSize(horizontal: false, vertical: true)
                    .lineSpacing(3)
                    .padding(.bottom, 22)

                HStack(spacing: 10) {
                    Spacer()
                    DialogButton(title: "Cancel", style: .secondary) { onCancel() }
                    DialogButton(title: "Enable Auto mode", style: .primary) { onConfirm() }
                }
            }
            .padding(24)
            .frame(width: 440)
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
            withAnimation(.easeOut(duration: 0.18)) { appeared = true }
        }
    }
}

// MARK: - Delete chat dialog

struct DeleteChatDialog: View {
    @Environment(\.themeColors) private var colors
    let conversation: Conversation
    @Binding var isPresented: Bool
    let onConfirm: () -> Void

    @State private var appeared = false

    var body: some View {
        ZStack {
            colors.backgroundOverlay
                .ignoresSafeArea()
                .onTapGesture { dismiss() }

            VStack(alignment: .leading, spacing: 0) {
                Text("Delete Chat")
                    .font(AppFont.mono(18, weight: .semibold))
                    .foregroundStyle(colors.textPrimary)
                    .padding(.bottom, 14)

                // Names the chat AND says it's permanent. The name is what
                // stops you deleting the wrong one when two titles start
                // the same way; "cannot be undone" is what stops you
                // treating the button as reversible.
                (Text("Are you sure you want to delete ")
                    .foregroundStyle(colors.textSecondary)
                 + Text(conversation.title)
                    .foregroundStyle(colors.textPrimary)
                    .fontWeight(.semibold)
                 + Text("? This action cannot be undone.")
                    .foregroundStyle(colors.textSecondary))
                    .font(AppFont.sans(14))
                    .fixedSize(horizontal: false, vertical: true)
                    .lineSpacing(3)
                    .padding(.bottom, 24)

                HStack(spacing: 10) {
                    Spacer()
                    DialogButton(title: "Cancel", style: .secondary) { dismiss() }
                    DialogButton(title: "Delete", style: .destructive) {
                        onConfirm()
                    }
                }
            }
            .padding(24)
            .frame(width: 420)
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
            withAnimation(.easeOut(duration: 0.18)) { appeared = true }
        }
    }

    private func dismiss() {
        isPresented = false
    }
}

// MARK: - Delete all chats dialog

struct DeleteAllChatsDialog: View {
    @Environment(\.themeColors) private var colors
    @Binding var isPresented: Bool
    let onConfirm: () -> Void

    @State private var appeared = false

    var body: some View {
        ZStack {
            colors.backgroundOverlay
                .ignoresSafeArea()
                .onTapGesture { dismiss() }

            VStack(alignment: .leading, spacing: 0) {
                Text("Delete all chats?")
                    .font(AppFont.mono(18, weight: .semibold))
                    .foregroundStyle(colors.textPrimary)
                    .padding(.bottom, 14)

                Text("Chats not filed in a project will be deleted. This action cannot be undone.")
                    .font(AppFont.sans(14))
                    .foregroundStyle(colors.textSecondary)
                    .fixedSize(horizontal: false, vertical: true)
                    .lineSpacing(3)
                    .padding(.bottom, 24)

                HStack(spacing: 10) {
                    Spacer()
                    DialogButton(title: "Cancel", style: .secondary) { dismiss() }
                    DialogButton(title: "Delete All", style: .destructive) {
                        onConfirm()
                    }
                }
            }
            .padding(24)
            .frame(width: 420)
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
            withAnimation(.easeOut(duration: 0.18)) { appeared = true }
        }
    }

    private func dismiss() {
        isPresented = false
    }
}

enum DialogButtonStyle { case primary, secondary, destructive }

struct DialogButton: View {
    @Environment(\.themeColors) private var colors
    let title: String
    var style: DialogButtonStyle = .secondary
    let action: () -> Void
    @State private var isHovered = false

    var body: some View {
        Button(action: action) {
            Text(title)
                .font(AppFont.mono(14, weight: .medium))
                .foregroundStyle(foreground)
                .padding(.horizontal, 18)
                .frame(height: 38)
                .background(
                    Capsule().fill(background)
                )
                .overlay(
                    Capsule().stroke(style == .secondary ? colors.borderMedium : .clear, lineWidth: 1)
                )
                .contentShape(Capsule())
        }
        .buttonStyle(PressableButtonStyle())
        .onHover { isHovered = $0 }
    }

    private var foreground: Color {
        switch style {
        case .primary: return colors.backgroundPrimary
        case .secondary: return colors.textPrimary
        case .destructive: return .white
        }
    }

    private var background: Color {
        switch style {
        case .primary: return colors.textPrimary
        case .secondary: return isHovered ? colors.backgroundHover : .clear
        case .destructive: return colors.destructive.opacity(isHovered ? 0.9 : 1)
        }
    }
}

/// A filled, accent-colored action button. Replaces `.buttonStyle(.borderedProminent)`,
/// which assumes white label text works on any tint — that assumption breaks
/// the moment the user's accent color is white.
struct AccentButton: View {
    let title: String
    var isDisabled: Bool = false
    let action: () -> Void
    @State private var isHovered = false

    var body: some View {
        Button(action: action) {
            Text(title)
                .font(AppFont.mono(13, weight: .semibold))
                .foregroundStyle(AppearanceSettings.shared.onAccentColor)
                .padding(.horizontal, 16)
                .padding(.vertical, 7)
                .background(
                    Capsule().fill(AppearanceSettings.shared.accentColor.opacity(isHovered ? 0.9 : 1))
                )
                .contentShape(Capsule())
        }
        .buttonStyle(.plain)
        .opacity(isDisabled ? 0.5 : 1)
        .disabled(isDisabled)
        .onHover { isHovered = $0 }
    }
}

// MARK: - Rename chat dialog

struct RenameChatDialog: View {
    @Environment(\.themeColors) private var colors
    let conversation: Conversation
    @Binding var isPresented: Bool
    let onConfirm: (String) -> Void

    @State private var title: String
    @State private var appeared = false
    @FocusState private var isFocused: Bool

    init(conversation: Conversation, isPresented: Binding<Bool>, onConfirm: @escaping (String) -> Void) {
        self.conversation = conversation
        self._isPresented = isPresented
        self.onConfirm = onConfirm
        self._title = State(initialValue: conversation.title)
    }

    private var trimmedTitle: String {
        title.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    private var canRename: Bool {
        !trimmedTitle.isEmpty && trimmedTitle != conversation.title
    }

    var body: some View {
        ZStack {
            colors.backgroundOverlay
                .ignoresSafeArea()
                .onTapGesture { dismiss() }

            VStack(alignment: .leading, spacing: 0) {
                Text("Rename chat")
                    .font(AppFont.mono(18, weight: .semibold))
                    .foregroundStyle(colors.textPrimary)
                    .padding(.bottom, 14)

                TextField("Chat title", text: $title)
                    .textFieldStyle(.plain)
                    .font(AppFont.mono(14))
                    .foregroundStyle(colors.textPrimary)
                    .padding(.horizontal, 12)
                    .padding(.vertical, 9)
                    .background(
                        RoundedRectangle(cornerRadius: 8, style: .continuous)
                            .fill(colors.backgroundInputSecondary)
                    )
                    .overlay(
                        RoundedRectangle(cornerRadius: 8, style: .continuous)
                            .stroke(colors.borderMedium, lineWidth: 1)
                    )
                    .focused($isFocused)
                    .onSubmit { commit() }
                    .padding(.bottom, 24)

                HStack(spacing: 10) {
                    Spacer()
                    DialogButton(title: "Cancel", style: .secondary) { dismiss() }
                    DialogButton(title: "Rename", style: .primary) { commit() }
                        .disabled(!canRename)
                        .opacity(canRename ? 1 : 0.5)
                }
            }
            .padding(24)
            .frame(width: 420)
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
            withAnimation(.easeOut(duration: 0.18)) { appeared = true }
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.05) { isFocused = true }
        }
        .onExitCommand { dismiss() }
    }

    private func commit() {
        guard canRename else { return }
        onConfirm(trimmedTitle)
        isPresented = false
    }

    private func dismiss() {
        isPresented = false
    }
}

// MARK: - New project dialog

/// Create-folder flow — a name, nothing else. Deliberately no
/// assistant/instructions/knowledge-base step: Aqua projects are plain
/// folders for grouping chats.
struct NewProjectDialog: View {
    @Environment(\.themeColors) private var colors
    @Binding var isPresented: Bool
    let onConfirm: (String) -> Void

    @State private var name: String = ""
    @State private var appeared = false
    @FocusState private var isFocused: Bool

    private var trimmedName: String {
        name.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    private var canCreate: Bool { !trimmedName.isEmpty }

    var body: some View {
        ZStack {
            colors.backgroundOverlay
                .ignoresSafeArea()
                .onTapGesture { dismiss() }

            VStack(alignment: .leading, spacing: 0) {
                Text("New project")
                    .font(AppFont.mono(18, weight: .semibold))
                    .foregroundStyle(colors.textPrimary)
                    .padding(.bottom, 14)

                TextField("Project name", text: $name)
                    .textFieldStyle(.plain)
                    .font(AppFont.mono(14))
                    .foregroundStyle(colors.textPrimary)
                    .padding(.horizontal, 12)
                    .padding(.vertical, 9)
                    .background(
                        RoundedRectangle(cornerRadius: 8, style: .continuous)
                            .fill(colors.backgroundInputSecondary)
                    )
                    .overlay(
                        RoundedRectangle(cornerRadius: 8, style: .continuous)
                            .stroke(colors.borderMedium, lineWidth: 1)
                    )
                    .focused($isFocused)
                    .onSubmit { commit() }
                    .padding(.bottom, 24)

                HStack(spacing: 10) {
                    Spacer()
                    DialogButton(title: "Cancel", style: .secondary) { dismiss() }
                    DialogButton(title: "Create", style: .primary) { commit() }
                        .disabled(!canCreate)
                        .opacity(canCreate ? 1 : 0.5)
                }
            }
            .padding(24)
            .frame(width: 420)
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
            withAnimation(.easeOut(duration: 0.18)) { appeared = true }
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.05) { isFocused = true }
        }
        .onExitCommand { dismiss() }
    }

    private func commit() {
        guard canCreate else { return }
        onConfirm(trimmedName)
        isPresented = false
    }

    private func dismiss() {
        isPresented = false
    }
}

// MARK: - Rename project dialog

struct RenameProjectDialog: View {
    @Environment(\.themeColors) private var colors
    let project: Project
    @Binding var isPresented: Bool
    let onConfirm: (String) -> Void

    @State private var name: String
    @State private var appeared = false
    @FocusState private var isFocused: Bool

    init(project: Project, isPresented: Binding<Bool>, onConfirm: @escaping (String) -> Void) {
        self.project = project
        self._isPresented = isPresented
        self.onConfirm = onConfirm
        self._name = State(initialValue: project.name)
    }

    private var trimmedName: String {
        name.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    private var canRename: Bool {
        !trimmedName.isEmpty && trimmedName != project.name
    }

    var body: some View {
        ZStack {
            colors.backgroundOverlay
                .ignoresSafeArea()
                .onTapGesture { dismiss() }

            VStack(alignment: .leading, spacing: 0) {
                Text("Rename project")
                    .font(AppFont.mono(18, weight: .semibold))
                    .foregroundStyle(colors.textPrimary)
                    .padding(.bottom, 14)

                TextField("Project name", text: $name)
                    .textFieldStyle(.plain)
                    .font(AppFont.mono(14))
                    .foregroundStyle(colors.textPrimary)
                    .padding(.horizontal, 12)
                    .padding(.vertical, 9)
                    .background(
                        RoundedRectangle(cornerRadius: 8, style: .continuous)
                            .fill(colors.backgroundInputSecondary)
                    )
                    .overlay(
                        RoundedRectangle(cornerRadius: 8, style: .continuous)
                            .stroke(colors.borderMedium, lineWidth: 1)
                    )
                    .focused($isFocused)
                    .onSubmit { commit() }
                    .padding(.bottom, 24)

                HStack(spacing: 10) {
                    Spacer()
                    DialogButton(title: "Cancel", style: .secondary) { dismiss() }
                    DialogButton(title: "Rename", style: .primary) { commit() }
                        .disabled(!canRename)
                        .opacity(canRename ? 1 : 0.5)
                }
            }
            .padding(24)
            .frame(width: 420)
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
            withAnimation(.easeOut(duration: 0.18)) { appeared = true }
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.05) { isFocused = true }
        }
        .onExitCommand { dismiss() }
    }

    private func commit() {
        guard canRename else { return }
        onConfirm(trimmedName)
        isPresented = false
    }

    private func dismiss() {
        isPresented = false
    }
}

// MARK: - Delete project dialog

struct DeleteProjectDialog: View {
    @Environment(\.themeColors) private var colors
    let project: Project
    @Binding var isPresented: Bool
    let onConfirm: () -> Void

    @State private var appeared = false

    var body: some View {
        ZStack {
            colors.backgroundOverlay
                .ignoresSafeArea()
                .onTapGesture { dismiss() }

            VStack(alignment: .leading, spacing: 0) {
                Text("Delete project?")
                    .font(AppFont.mono(18, weight: .semibold))
                    .foregroundStyle(colors.textPrimary)
                    .padding(.bottom, 14)

                (Text("This deletes the ")
                    .foregroundStyle(colors.textSecondary)
                 + Text(project.name)
                    .foregroundStyle(colors.textPrimary)
                    .fontWeight(.semibold)
                 + Text(" folder. Its chats stay in your chat list.")
                    .foregroundStyle(colors.textSecondary))
                    .font(AppFont.sans(14))
                    .fixedSize(horizontal: false, vertical: true)
                    .lineSpacing(3)
                    .padding(.bottom, 24)

                HStack(spacing: 10) {
                    Spacer()
                    DialogButton(title: "Cancel", style: .secondary) { dismiss() }
                    DialogButton(title: "Delete", style: .destructive) {
                        onConfirm()
                    }
                }
            }
            .padding(24)
            .frame(width: 420)
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
            withAnimation(.easeOut(duration: 0.18)) { appeared = true }
        }
    }

    private func dismiss() {
        isPresented = false
    }
}

// MARK: - Share chat sheet

struct ShareChatSheet: View {
    @Environment(\.themeColors) private var colors
    let conversation: Conversation
    @Binding var isPresented: Bool

    @State private var appeared = false
    @State private var copied = false
    @State private var comingSoonTarget: String?

    private var firstUserPrompt: String {
        conversation.messages.first { $0.isUser }?.content ?? conversation.title
    }

    private func flashComingSoon(_ target: String) {
        withAnimation(.uiEaseOut(duration: 0.15)) { comingSoonTarget = target }
        DispatchQueue.main.asyncAfter(deadline: .now() + 1.5) {
            withAnimation(.uiEaseOut(duration: 0.15)) { comingSoonTarget = nil }
        }
    }

    var body: some View {
        ZStack {
            colors.backgroundOverlay
                .ignoresSafeArea()
                .onTapGesture { isPresented = false }

            VStack(alignment: .leading, spacing: 0) {
                HStack {
                    Text(conversation.title)
                        .font(AppFont.mono(20, weight: .semibold))
                        .foregroundStyle(colors.textPrimary)
                        .lineLimit(1)
                    Spacer()
                    Button { isPresented = false } label: {
                        Image(systemName: "xmark")
                            .font(.system(size: 14, weight: .medium))
                            .foregroundStyle(colors.textSecondary)
                            .iconHoverEffect(for: "xmark")
                            .frame(width: 30, height: 30)
                            .contentShape(Rectangle())
                    }
                    .buttonStyle(PressableButtonStyle())
                }
                .padding(.bottom, 16)

                Divider().overlay(colors.borderSubtle).padding(.bottom, 18)

                previewCard.padding(.bottom, 22)

                HStack(spacing: 22) {
                    // There's no hosted share-page backend behind a link yet
                    // — copying the transcript itself is a real action today
                    // instead of a URL that would 404.
                    ShareTarget(icon: copied ? "checkmark" : "doc.on.doc", label: copied ? "Copied" : "Copy chat") {
                        NSPasteboard.general.clearContents()
                        NSPasteboard.general.setString(ChatViewModel.exportConversationMarkdown(conversation), forType: .string)
                        copied = true
                        DispatchQueue.main.asyncAfter(deadline: .now() + 1.5) { copied = false }
                    }
                    ShareTarget(icon: comingSoonTarget == "X" ? "clock" : "bird", label: comingSoonTarget == "X" ? "Soon" : "X") {
                        flashComingSoon("X")
                    }
                    ShareTarget(icon: comingSoonTarget == "LinkedIn" ? "clock" : "briefcase", label: comingSoonTarget == "LinkedIn" ? "Soon" : "LinkedIn") {
                        flashComingSoon("LinkedIn")
                    }
                    ShareTarget(icon: comingSoonTarget == "Reddit" ? "clock" : "bubble.left.and.bubble.right", label: comingSoonTarget == "Reddit" ? "Soon" : "Reddit") {
                        flashComingSoon("Reddit")
                    }
                    Spacer()
                }
                .padding(.bottom, 18)

                Divider().overlay(colors.borderSubtle).padding(.bottom, 18)

                HStack(spacing: 22) {
                    ShareTarget(icon: "doc.plaintext", label: "Export Markdown") {
                        exportToFile(
                            content: ChatViewModel.exportConversationMarkdown(conversation),
                            suggestedName: "\(conversation.title).md"
                        )
                    }
                    ShareTarget(icon: "curlybraces", label: "Export JSON") {
                        guard let data = ChatViewModel.exportConversationJSON(conversation) else { return }
                        exportToFile(data: data, suggestedName: "\(conversation.title).json")
                    }
                    Spacer()
                }
            }
            .padding(24)
            .frame(width: 520)
            .background(
                RoundedRectangle(cornerRadius: 22, style: .continuous)
                    .fill(colors.backgroundPopover)
            )
            .overlay(
                RoundedRectangle(cornerRadius: 22, style: .continuous)
                    .stroke(colors.borderSubtle, lineWidth: 1)
            )
            .shadow(color: .black.opacity(0.3), radius: 44, y: 18)
            .scaleEffect(appeared ? 1 : 0.94)
            .opacity(appeared ? 1 : 0)
        }
        .onAppear { withAnimation(.easeOut(duration: 0.18)) { appeared = true } }
    }

    private func exportToFile(content: String, suggestedName: String) {
        exportToFile(data: Data(content.utf8), suggestedName: suggestedName)
    }

    private func exportToFile(data: Data, suggestedName: String) {
        let panel = NSSavePanel()
        panel.nameFieldStringValue = suggestedName
        panel.canCreateDirectories = true
        guard panel.runModal() == .OK, let url = panel.url else { return }
        try? data.write(to: url)
    }

    private var previewCard: some View {
        VStack(alignment: .trailing, spacing: 10) {
            HStack {
                Spacer(minLength: 40)
                Text(firstUserPrompt)
                    .font(AppFont.sans(13))
                    .foregroundStyle(colors.textPrimary)
                    .lineLimit(2)
                    .padding(.horizontal, 14)
                    .padding(.vertical, 8)
                    .background(
                        RoundedRectangle(cornerRadius: 16, style: .continuous)
                            .fill(colors.userBubble)
                    )
            }
            HStack {
                AquaMark(size: 22)
                AquaWordmark(size: 14)
                Spacer()
            }
        }
        .padding(16)
        .background(
            RoundedRectangle(cornerRadius: 16, style: .continuous)
                .fill(colors.backgroundPrimary)
        )
        .overlay(
            RoundedRectangle(cornerRadius: 16, style: .continuous)
                .stroke(colors.borderSubtle, lineWidth: 1)
        )
    }
}

private struct ShareTarget: View {
    @Environment(\.themeColors) private var colors
    let icon: String
    let label: String
    let action: () -> Void
    @State private var isHovered = false

    var body: some View {
        Button(action: action) {
            VStack(spacing: 8) {
                Image(systemName: icon)
                    .font(.system(size: 18, weight: .medium))
                    .foregroundStyle(colors.backgroundPrimary)
                    .iconHoverEffect(for: icon)
                    .frame(width: 52, height: 52)
                    .background(Circle().fill(colors.textPrimary.opacity(isHovered ? 0.85 : 1)))
                Text(label)
                    .font(AppFont.mono(12))
                    .foregroundStyle(colors.textSecondary)
            }
        }
        .buttonStyle(PressableButtonStyle())
        .onHover { isHovered = $0 }
    }
}
