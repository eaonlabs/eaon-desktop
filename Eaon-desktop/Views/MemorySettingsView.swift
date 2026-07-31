import SwiftUI

/// Settings → Memory. Off by default — nothing is stored or sent until the
/// user turns it on here. Every remembered fact is listed, individually
/// deletable, and can also be added by hand: automatic extraction is a
/// convenience, not the only way in or out.
struct MemorySettingsView: View {
    @Environment(\.themeColors) private var colors
    @Bindable private var store = MemoryStore.shared
    @Bindable var chatViewModel: ChatViewModel
    @State private var draft = ""
    @State private var showingClearConfirm = false
    @State private var showingImportSheet = false
    /// Non-nil while the learn-from-file confirmation is up — the second
    /// half of that flow's heavy consent (the explicit file pick being the
    /// first). Holds the picked file so Confirm knows what to act on.
    @State private var pendingFileToLearn: URL?
    @FocusState private var isFocused: Bool

    private var isAddDisabled: Bool {
        draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || store.isFull
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            Text("Memory")
                .font(AppFont.mono(20, weight: .bold))
                .foregroundColor(colors.textPrimary)
                .padding(.horizontal, 32)
                .padding(.top, 28)
                .padding(.bottom, 8)

            Text("Eaon can remember what you tell it and use it in later chats, so you don't have to explain yourself twice. Nothing is stored or sent until you turn this on. You can read and delete anything it remembers, whenever you want.")
                .font(AppFont.sans(12))
                .foregroundColor(colors.textSecondary)
                .fixedSize(horizontal: false, vertical: true)
                .lineSpacing(3)
                .padding(.horizontal, 32)
                .padding(.bottom, 20)

            ScrollView {
                VStack(alignment: .leading, spacing: 16) {
                    toggleCard
                    backfillCard
                    fileLearnCard
                    importCard
                    addCard
                    memoriesCard
                }
                .padding(.horizontal, 32)
                .padding(.bottom, 32)
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
        .background(colors.backgroundPrimary)
        .sheet(isPresented: $showingImportSheet) {
            ImportMemorySheet()
        }
        .alert("Clear all memories?", isPresented: $showingClearConfirm) {
            Button("Cancel", role: .cancel) {}
            Button("Clear All", role: .destructive) { store.clearAll() }
        } message: {
            Text("This removes everything Eaon remembers about you. It can't be undone.")
        }
        .alert(
            "Learn from \"\(pendingFileToLearn?.lastPathComponent ?? "file")\"?",
            isPresented: Binding(
                get: { pendingFileToLearn != nil },
                set: { if !$0 { pendingFileToLearn = nil } }
            )
        ) {
            Button("Cancel", role: .cancel) { pendingFileToLearn = nil }
            Button("Learn") {
                if let url = pendingFileToLearn { chatViewModel.learnFromFile(url: url) }
                pendingFileToLearn = nil
            }
        } message: {
            Text("Eaon sends the first \(MemoryExtractor.maxFileCharacters / 1000),000 characters of this file to your selected model. The file stays on this Mac. Everything it finds appears below for review.")
        }
    }

    private var toggleCard: some View {
        SettingsCard {
            VStack(alignment: .leading, spacing: 0) {
                HStack(spacing: 14) {
                    VStack(alignment: .leading, spacing: 3) {
                        Text("Remember things about you")
                            .font(AppFont.mono(14, weight: .semibold))
                            .foregroundColor(colors.textPrimary)
                        Text(store.isEnabled ? "On. New chats can see what's remembered below." : "Off. Nothing is stored or sent.")
                            .font(AppFont.mono(12))
                            .foregroundColor(colors.textTertiary)
                    }
                    Spacer(minLength: 0)
                    Toggle("", isOn: $store.isEnabled)
                        .labelsHidden()
                        .toggleStyle(.switch)
                        .tint(AppearanceSettings.toggleTint)
                }
                .padding(16)

                Divider().overlay(colors.borderSubtle)

                HStack(spacing: 14) {
                    VStack(alignment: .leading, spacing: 3) {
                        Text("Automatically learn new things")
                            .font(AppFont.mono(14, weight: .semibold))
                            .foregroundColor(store.isEnabled ? colors.textPrimary : colors.textTertiary)
                        Text("Checks each message you send for anything worth keeping. Turning this off only stops new memories. What's already saved still works, and \"Learn from your existing chats\" below still runs when you ask it to.")
                            .font(AppFont.sans(12.5))
                            .foregroundColor(colors.textTertiary)
                            .fixedSize(horizontal: false, vertical: true)
                            .lineSpacing(3)
                        if store.isEnabled, store.isAutoLearnEnabled, let summary = store.lastAutoLearnSummary {
                            Text(summary)
                                .font(AppFont.mono(12))
                                .foregroundColor(colors.textSecondary)
                                .padding(.top, 2)
                        }
                    }
                    Spacer(minLength: 0)
                    Toggle("", isOn: $store.isAutoLearnEnabled)
                        .labelsHidden()
                        .toggleStyle(.switch)
                        .tint(AppearanceSettings.toggleTint)
                        .disabled(!store.isEnabled)
                }
                .padding(16)
                .opacity(store.isEnabled ? 1 : 0.5)

                Divider().overlay(colors.borderSubtle)

                HStack(spacing: 14) {
                    VStack(alignment: .leading, spacing: 3) {
                        Text("Also learn from connected plugins")
                            .font(AppFont.mono(14, weight: .semibold))
                            .foregroundColor(store.isEnabled ? colors.textPrimary : colors.textTertiary)
                        Text("When a chat uses a connected service like your calendar or issue tracker, what came back can be remembered too. Off by default, so memory only looks at what you and the model wrote.")
                            .font(AppFont.sans(12.5))
                            .foregroundColor(colors.textTertiary)
                            .fixedSize(horizontal: false, vertical: true)
                            .lineSpacing(3)
                    }
                    Spacer(minLength: 0)
                    Toggle("", isOn: $store.isPluginLearnEnabled)
                        .labelsHidden()
                        .toggleStyle(.switch)
                        .tint(AppearanceSettings.toggleTint)
                        .disabled(!store.isEnabled || !store.isAutoLearnEnabled)
                }
                .padding(16)
                .opacity(store.isEnabled && store.isAutoLearnEnabled ? 1 : 0.5)
            }
        }
    }

    /// Learn from a file the user explicitly picks — the "heavy consent"
    /// path: an open panel (nothing is ever scanned uninvited), then a
    /// confirmation spelling out exactly what gets sent where, then a
    /// reviewable result. Never recursive, never a folder, one file at a
    /// time.
    @ViewBuilder
    private var fileLearnCard: some View {
        if store.isEnabled {
            SettingsCard {
                VStack(alignment: .leading, spacing: 10) {
                    HStack(spacing: 14) {
                        VStack(alignment: .leading, spacing: 3) {
                            Text("Learn from a file on this Mac")
                                .font(AppFont.mono(14, weight: .semibold))
                                .foregroundColor(colors.textPrimary)
                            Text("Pick a text file such as notes or a journal, and Eaon pulls out anything worth remembering. It reads only that file, only after you confirm. Everything it finds appears below.")
                                .font(AppFont.sans(12.5))
                                .foregroundColor(colors.textTertiary)
                                .fixedSize(horizontal: false, vertical: true)
                                .lineSpacing(3)
                        }
                        Spacer(minLength: 0)
                        if chatViewModel.isLearningFromFile {
                            ProgressView().controlSize(.small)
                        } else {
                            Button("Choose File…") { pickFileToLearn() }
                                .buttonStyle(.bordered)
                                .disabled(store.isFull)
                        }
                    }
                }
                .padding(16)
            }
        }
    }

    private func pickFileToLearn() {
        let panel = NSOpenPanel()
        panel.canChooseDirectories = false
        panel.allowsMultipleSelection = false
        panel.allowedContentTypes = [.text]
        panel.message = "Choose a text file for Eaon to learn from"
        guard panel.runModal() == .OK, let url = panel.url else { return }
        pendingFileToLearn = url
    }

    /// Mines facts out of chats that already exist — not just ones going
    /// forward. Explicit and opt-in (a real API call per chat, which
    /// costs time and, on a paid model, money), so this is a button the
    /// user presses, never something that runs on its own.
    @ViewBuilder
    private var backfillCard: some View {
        if store.isEnabled {
            SettingsCard {
                VStack(alignment: .leading, spacing: 10) {
                    HStack(spacing: 14) {
                        VStack(alignment: .leading, spacing: 3) {
                            Text("Learn from your existing chats")
                                .font(AppFont.mono(14, weight: .semibold))
                                .foregroundColor(colors.textPrimary)
                            Text("Goes back through every saved chat looking for facts worth keeping, using the model you have selected. That's one request per chat, so it can take a while and costs real API calls.")
                                .font(AppFont.sans(12.5))
                                .foregroundColor(colors.textTertiary)
                                .fixedSize(horizontal: false, vertical: true)
                                .lineSpacing(3)
                        }
                        Spacer(minLength: 0)
                        if chatViewModel.isBackfillingMemory {
                            Button("Stop") { chatViewModel.cancelMemoryBackfill() }
                                .buttonStyle(.bordered)
                        } else {
                            Button("Learn Now") { chatViewModel.startMemoryBackfill() }
                                .buttonStyle(.bordered)
                                .disabled(store.isFull)
                        }
                    }

                    if chatViewModel.isBackfillingMemory {
                        HStack(spacing: 8) {
                            ProgressView().controlSize(.small)
                            if let status = chatViewModel.memoryBackfillStatus {
                                Text(status)
                                    .font(AppFont.mono(12))
                                    .foregroundColor(colors.textSecondary)
                            }
                        }
                    } else if let status = chatViewModel.memoryBackfillStatus {
                        Text(status)
                            .font(AppFont.mono(12))
                            .foregroundColor(colors.textSecondary)
                    }
                }
                .padding(16)
            }
        }
    }

    /// Bring over what another AI already knows — paste its memory list,
    /// no model call involved (see `MemoryParsing.parseProviderMemoryList`).
    /// Not gated on `store.isEnabled` (unlike the two model-powered learn
    /// cards above): like the manual add field, this is the user explicitly
    /// handing facts over, and it works offline.
    private var importCard: some View {
        SettingsCard {
            HStack(spacing: 14) {
                VStack(alignment: .leading, spacing: 3) {
                    Text("Import from another AI")
                        .font(AppFont.mono(14, weight: .semibold))
                        .foregroundColor(colors.textPrimary)
                    Text("Already told ChatGPT or Claude about yourself? Copy your memory list from there and paste it here. Everything imported appears below.")
                        .font(AppFont.sans(12.5))
                        .foregroundColor(colors.textTertiary)
                        .fixedSize(horizontal: false, vertical: true)
                        .lineSpacing(3)
                }
                Spacer(minLength: 0)
                Button("Import…") { showingImportSheet = true }
                    .buttonStyle(.bordered)
                    .disabled(store.isFull)
            }
            .padding(16)
        }
    }

    private var addCard: some View {
        SettingsCard {
            HStack(spacing: 10) {
                TextField("Add something for Eaon to remember…", text: $draft)
                    .textFieldStyle(.plain)
                    .font(AppFont.sans(13))
                    .foregroundColor(colors.textPrimary)
                    .focused($isFocused)
                    .onSubmit(addDraft)

                Button("Add", action: addDraft)
                    .buttonStyle(PressableButtonStyle())
                    .font(AppFont.mono(12, weight: .semibold))
                    .foregroundColor(isAddDisabled ? colors.textSecondary : AppearanceSettings.shared.onAccentColor)
                    .padding(.horizontal, 14)
                    .padding(.vertical, 7)
                    .background(Capsule().fill(isAddDisabled ? colors.borderMedium : AppearanceSettings.shared.accentColor))
                    .disabled(isAddDisabled)
            }
            .padding(14)
        }
    }

    @ViewBuilder
    private var memoriesCard: some View {
        if store.memories.isEmpty {
            SettingsCard {
                VStack(spacing: 6) {
                    Image(systemName: "brain")
                        .font(.system(size: 20))
                        .foregroundColor(colors.textTertiary)
                    Text("Nothing remembered yet")
                        .font(AppFont.mono(12, weight: .medium))
                        .foregroundColor(colors.textSecondary)
                }
                .frame(maxWidth: .infinity)
                .padding(28)
            }
        } else {
            SettingsCard {
                VStack(alignment: .leading, spacing: 0) {
                    HStack {
                        Text("\(store.memories.count) REMEMBERED")
                            .font(AppFont.mono(10, weight: .semibold))
                            .tracking(0.8)
                            .foregroundColor(colors.textTertiary)
                        Spacer()
                        Button("Clear All") { showingClearConfirm = true }
                            .buttonStyle(.plain)
                            .font(AppFont.mono(11, weight: .medium))
                            .foregroundColor(colors.destructive)
                    }
                    .padding(.horizontal, 16)
                    .padding(.top, 14)
                    .padding(.bottom, 8)

                    ForEach(store.memories) { item in
                        memoryRow(item)
                        if item.id != store.memories.last?.id {
                            Divider().overlay(colors.borderSubtle).padding(.leading, 16)
                        }
                    }
                    .padding(.bottom, 6)
                }
            }
        }
    }

    private func memoryRow(_ item: MemoryItem) -> some View {
        HStack(alignment: .top, spacing: 10) {
            VStack(alignment: .leading, spacing: 3) {
                Text(item.text)
                    .font(AppFont.sans(13))
                    .foregroundColor(colors.textPrimary)
                    .fixedSize(horizontal: false, vertical: true)
                    .lineSpacing(3)
                // Events show when they were mentioned — that date is what
                // makes "how did Friday's final go?" possible, so it's
                // worth surfacing to the user too. Facts stay undated:
                // they're meant to be currently true, and a stale-looking
                // date would just invite doubt about a fact that's fine.
                if item.resolvedKind == .event {
                    Text(item.createdAt.formatted(.dateTime.weekday(.abbreviated).month(.abbreviated).day()))
                        .font(AppFont.mono(10.5))
                        .foregroundColor(colors.textTertiary)
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)

            if item.resolvedKind == .event {
                Text("Event")
                    .font(AppFont.mono(10, weight: .medium))
                    .foregroundColor(colors.textTertiary)
                    .padding(.horizontal, 6)
                    .padding(.vertical, 2)
                    .background(Capsule().fill(colors.backgroundChipSecondary))
            }

            Button {
                withAnimation(.uiEaseOut(duration: 0.2)) { store.remove(item.id) }
            } label: {
                Image(systemName: "xmark")
                    .font(.system(size: 10, weight: .semibold))
                    .foregroundColor(colors.textTertiary)
                    .iconHoverEffect(for: "xmark")
            }
            .buttonStyle(.plain)
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 10)
    }

    private func addDraft() {
        guard store.addManual(draft) else { return }
        draft = ""
        isFocused = true
    }
}

/// The paste-and-import flow for another AI's memory of you. Everything
/// happens locally and deterministically — the pasted text is parsed
/// line-by-line (`MemoryParsing.parseProviderMemoryList`), passed through
/// the same junk gate and duplicate check automatic extraction uses, and
/// the outcome is reported number by number rather than a bare "done."
private struct ImportMemorySheet: View {
    @Environment(\.themeColors) private var colors
    @Environment(\.dismiss) private var dismiss
    @Bindable private var store = MemoryStore.shared

    @State private var source: ImportSource = .chatGPT
    @State private var pasted = ""
    @State private var resultMessage: String?

    private enum ImportSource: String, CaseIterable, Identifiable {
        case chatGPT = "ChatGPT"
        case claude = "Claude"
        case gemini = "Gemini"
        case other = "Other"

        var id: String { rawValue }

        var guidance: String {
            switch self {
            case .chatGPT:
                return "In ChatGPT: Settings → Personalization → Memory → Manage, and copy the list. Or just ask it \"List everything you remember about me as short bullet points\" and copy the reply."
            case .claude:
                return "Ask Claude \"List everything you remember about me as short bullet points\" and copy its reply."
            case .gemini:
                return "On gemini.google.com: Settings → Saved info, and copy the list. Or ask Gemini to list everything it's saved about you."
            case .other:
                return "Paste any list of facts about you. One per line works best."
            }
        }
    }

    private var candidates: [String] {
        MemoryParsing.parseProviderMemoryList(pasted)
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            Text("Import Memory")
                .font(AppFont.mono(16, weight: .bold))
                .foregroundColor(colors.textPrimary)

            Picker("", selection: $source) {
                ForEach(ImportSource.allCases) { candidate in
                    Text(candidate.rawValue).tag(candidate)
                }
            }
            .pickerStyle(.segmented)
            .labelsHidden()

            Text(source.guidance)
                .font(AppFont.sans(12.5))
                .foregroundColor(colors.textTertiary)
                .fixedSize(horizontal: false, vertical: true)
                .lineSpacing(3)

            TextEditor(text: $pasted)
                .font(AppFont.sans(12.5))
                .foregroundColor(colors.textPrimary)
                .scrollContentBackground(.hidden)
                .frame(height: 180)
                .padding(8)
                .background(colors.backgroundInput)
                .clipShape(RoundedRectangle(cornerRadius: 8, style: .continuous))
                .overlay(
                    RoundedRectangle(cornerRadius: 8, style: .continuous)
                        .stroke(colors.borderSubtle, lineWidth: 1)
                )
                .overlay(alignment: .topLeading) {
                    if pasted.isEmpty {
                        Text("Paste your memory list here…")
                            .font(AppFont.sans(12.5))
                            .foregroundColor(colors.textTertiary)
                            .padding(.top, 14)
                            .padding(.leading, 13)
                            .allowsHitTesting(false)
                    }
                }

            if let resultMessage {
                Text(resultMessage)
                    .font(AppFont.mono(12))
                    .foregroundColor(colors.textSecondary)
                    .fixedSize(horizontal: false, vertical: true)
                    .lineSpacing(3)
            } else if !candidates.isEmpty {
                Text("Found \(candidates.count) item\(candidates.count == 1 ? "" : "s") to import.")
                    .font(AppFont.mono(12))
                    .foregroundColor(colors.textSecondary)
            }

            HStack {
                Spacer()
                Button(resultMessage == nil ? "Cancel" : "Done") { dismiss() }
                    .buttonStyle(.plain)
                    .font(AppFont.mono(14, weight: .medium))
                    .foregroundColor(colors.textSecondary)
                if resultMessage == nil {
                    AccentButton(title: "Import", isDisabled: candidates.isEmpty) {
                        runImport()
                    }
                }
            }
        }
        .padding(24)
        .frame(width: 480)
        .background(colors.backgroundPopover)
    }

    private func runImport() {
        let outcome = store.importFacts(candidates)
        var parts: [String] = ["Imported \(outcome.added) memor\(outcome.added == 1 ? "y" : "ies")."]
        if outcome.skippedDuplicates > 0 {
            parts.append("Skipped \(outcome.skippedDuplicates) already remembered.")
        }
        if outcome.skippedFiltered > 0 {
            parts.append("Skipped \(outcome.skippedFiltered) that didn't look like durable facts about you.")
        }
        if outcome.skippedOverCap > 0 {
            parts.append("Memory is full — \(outcome.skippedOverCap) didn't fit.")
        }
        resultMessage = parts.joined(separator: " ")
    }
}
