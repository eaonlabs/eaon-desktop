import SwiftUI

/// The Skill Library — install, toggle, and remove skills; invoke one from
/// the composer with `/name`. Mirrors `PluginsSettingsView`'s card-list
/// conventions so the two extensibility surfaces (outside services via
/// MCP, model behavior via skills) read as one family rather than two
/// differently-designed features.
struct SkillsSettingsView: View {
    @Environment(\.themeColors) private var colors
    @Bindable private var store = SkillStore.shared

    @State private var isAddingFromGitHub = false
    @State private var isAddingManually = false
    @State private var isBrowsingLocalSkills = false

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            Text("Skills")
                .font(AppFont.mono(20, weight: .bold))
                .foregroundColor(colors.textPrimary)
                .padding(.horizontal, 32)
                .padding(.top, 28)
                .padding(.bottom, 4)

            Text("Reusable instructions a model follows on request. Type /name in the message box, or let it run automatically by turning it on here first.")
                .font(AppFont.sans(12))
                .foregroundColor(colors.textSecondary)
                .padding(.horizontal, 32)
                .padding(.bottom, 16)

            addButtonsRow
                .padding(.horizontal, 32)
                .padding(.bottom, 20)

            ScrollView {
                SettingsCard {
                    VStack(spacing: 0) {
                        ForEach(Array(store.sortedSkills.enumerated()), id: \.element.id) { index, skill in
                            if index > 0 {
                                Divider().overlay(colors.borderSubtle)
                            }
                            SkillRow(skill: skill)
                        }
                        if store.sortedSkills.isEmpty {
                            Text("No skills installed yet.")
                                .font(AppFont.sans(12))
                                .foregroundColor(colors.textTertiary)
                                .padding(16)
                        }
                    }
                }
                .padding(.horizontal, 32)
                .padding(.bottom, 32)
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
        .background(colors.backgroundPrimary)
        .sheet(isPresented: $isAddingFromGitHub) {
            AddSkillFromGitHubSheet(isPresented: $isAddingFromGitHub)
        }
        .sheet(isPresented: $isAddingManually) {
            AddSkillManuallySheet(isPresented: $isAddingManually)
        }
        .sheet(isPresented: $isBrowsingLocalSkills) {
            ImportLocalSkillsSheet(isPresented: $isBrowsingLocalSkills)
        }
    }

    private var addButtonsRow: some View {
        HStack(spacing: 10) {
            addButton("From GitHub", icon: "link") { isAddingFromGitHub = true }
            addButton("From Claude Code", icon: "arrow.down.doc") { isBrowsingLocalSkills = true }
            addButton("Write One", icon: "square.and.pencil") { isAddingManually = true }
            Spacer(minLength: 0)
        }
    }

    private func addButton(_ title: String, icon: String, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            HStack(spacing: 6) {
                Image(systemName: icon)
                    .iconHoverEffect(for: icon)
                Text(title)
            }
            .font(AppFont.mono(12, weight: .medium))
            .foregroundColor(colors.textPrimary)
            .padding(.horizontal, 12)
            .padding(.vertical, 8)
            .background(colors.backgroundChip)
            .clipShape(RoundedRectangle(cornerRadius: 8, style: .continuous))
            .overlay(RoundedRectangle(cornerRadius: 8, style: .continuous).stroke(colors.borderSubtle, lineWidth: 1))
        }
        .buttonStyle(.plain)
    }
}

/// One installed skill's row: name (as it's invoked), summary, a small
/// source tag, an enable/disable toggle, and a remove button.
private struct SkillRow: View {
    @Environment(\.themeColors) private var colors
    @Bindable private var store = SkillStore.shared
    let skill: Skill
    @State private var isHovered = false

    private var sourceLabel: String {
        switch skill.source {
        case .starter: return "Starter"
        case .localImport: return "Claude Code"
        case .github: return "GitHub"
        case .manual: return "Manual"
        }
    }

    var body: some View {
        HStack(spacing: 12) {
            Image(systemName: "bolt.fill")
                .font(.system(size: 13))
                .foregroundStyle(skill.isEnabled ? colors.textSecondary : colors.textTertiary)
                .frame(width: 30, height: 30)
                .background(RoundedRectangle(cornerRadius: 8, style: .continuous).fill(Color.white.opacity(0.08)))
                .overlay(RoundedRectangle(cornerRadius: 8, style: .continuous).stroke(colors.borderSubtle, lineWidth: 1))

            VStack(alignment: .leading, spacing: 2) {
                HStack(spacing: 6) {
                    Text("/\(skill.name)")
                        .font(AppFont.mono(13.5, weight: .semibold))
                        .foregroundColor(skill.isEnabled ? colors.textPrimary : colors.textTertiary)
                    Text(sourceLabel)
                        .font(AppFont.mono(10, weight: .medium))
                        .foregroundColor(colors.textTertiary)
                        .padding(.horizontal, 6)
                        .padding(.vertical, 2)
                        .background(Capsule().fill(colors.backgroundChipSecondary))
                }
                Text(skill.summary)
                    .font(AppFont.sans(12))
                    .foregroundColor(colors.textSecondary)
                    .lineLimit(2)
            }

            Spacer(minLength: 12)

            if isHovered {
                Button {
                    store.remove(skill.id)
                } label: {
                    Image(systemName: "trash")
                        .font(.system(size: 12))
                        .foregroundStyle(colors.destructive)
                        .iconHoverEffect(for: "trash")
                }
                .buttonStyle(.plain)
                .help("Remove")
            }

            Toggle("", isOn: Binding(
                get: { skill.isEnabled },
                set: { _ in store.toggle(skill.id) }
            ))
            .labelsHidden()
            .toggleStyle(.switch)
            .controlSize(.small)
            .tint(AppearanceSettings.toggleTint)
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 12)
        .contentShape(Rectangle())
        .onHover { isHovered = $0 }
    }
}

private struct AddSkillFromGitHubSheet: View {
    @Environment(\.themeColors) private var colors
    @Binding var isPresented: Bool
    @State private var url = ""
    @State private var isInstalling = false
    @State private var errorMessage: String?

    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            Text("Add Skill from GitHub")
                .font(AppFont.mono(16, weight: .bold))
                .foregroundColor(colors.textPrimary)

            Text("Paste a link to a SKILL.md file, its folder, or a repo (tries SKILL.md at the root).")
                .font(AppFont.sans(12))
                .foregroundColor(colors.textSecondary)
                .fixedSize(horizontal: false, vertical: true)
                .lineSpacing(3)

            TextField("https://github.com/org/repo/blob/main/some-skill/SKILL.md", text: $url)
                .textFieldStyle(.plain)
                .font(AppFont.mono(13))
                .padding(.horizontal, 12)
                .padding(.vertical, 9)
                .background(colors.backgroundInput)
                .clipShape(RoundedRectangle(cornerRadius: 8, style: .continuous))
                .overlay(RoundedRectangle(cornerRadius: 8, style: .continuous).stroke(colors.borderSubtle, lineWidth: 1))
                .onSubmit(install)

            if let errorMessage {
                Text(errorMessage)
                    .font(AppFont.mono(12))
                    .foregroundColor(colors.destructive)
                    .fixedSize(horizontal: false, vertical: true)
                    .lineSpacing(3)
            }

            HStack {
                Spacer()
                Button("Cancel") { isPresented = false }.buttonStyle(.bordered)
                AccentButton(title: isInstalling ? "Installing…" : "Install", isDisabled: url.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || isInstalling) {
                    install()
                }
            }
        }
        .padding(24)
        .frame(width: 460)
    }

    private func install() {
        errorMessage = nil
        isInstalling = true
        Task {
            do {
                _ = try await SkillStore.shared.addFromGitHub(url: url)
                isInstalling = false
                isPresented = false
            } catch {
                isInstalling = false
                errorMessage = error.localizedDescription
            }
        }
    }
}

private struct AddSkillManuallySheet: View {
    @Environment(\.themeColors) private var colors
    @Binding var isPresented: Bool
    @State private var name = ""
    @State private var summary = ""
    @State private var instructions = ""
    @State private var errorMessage: String?

    private var canSave: Bool {
        !name.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
            && !summary.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
            && !instructions.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            Text("Write a Skill")
                .font(AppFont.mono(16, weight: .bold))
                .foregroundColor(colors.textPrimary)

            field("Name", text: $name, placeholder: "e.g. terse-summaries")
            field("Description", text: $summary, placeholder: "One line — when should the model reach for this?")

            VStack(alignment: .leading, spacing: 6) {
                Text("Instructions")
                    .font(AppFont.mono(12, weight: .medium))
                    .foregroundColor(colors.textSecondary)
                TextEditor(text: $instructions)
                    .font(AppFont.mono(12.5))
                    .foregroundColor(colors.textPrimary)
                    .scrollContentBackground(.hidden)
                    .frame(height: 160)
                    .padding(8)
                    .background(colors.backgroundInput)
                    .clipShape(RoundedRectangle(cornerRadius: 8, style: .continuous))
                    .overlay(RoundedRectangle(cornerRadius: 8, style: .continuous).stroke(colors.borderSubtle, lineWidth: 1))
            }

            if let errorMessage {
                Text(errorMessage)
                    .font(AppFont.mono(12))
                    .foregroundColor(colors.destructive)
                    .fixedSize(horizontal: false, vertical: true)
                    .lineSpacing(3)
            }

            HStack {
                Spacer()
                Button("Cancel") { isPresented = false }.buttonStyle(.bordered)
                AccentButton(title: "Save", isDisabled: !canSave) {
                    save()
                }
            }
        }
        .padding(24)
        .frame(width: 460)
    }

    private func field(_ label: String, text: Binding<String>, placeholder: String) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(label)
                .font(AppFont.mono(12, weight: .medium))
                .foregroundColor(colors.textSecondary)
            TextField(placeholder, text: text)
                .textFieldStyle(.plain)
                .font(AppFont.mono(13))
                .padding(.horizontal, 12)
                .padding(.vertical, 9)
                .background(colors.backgroundInput)
                .clipShape(RoundedRectangle(cornerRadius: 8, style: .continuous))
                .overlay(RoundedRectangle(cornerRadius: 8, style: .continuous).stroke(colors.borderSubtle, lineWidth: 1))
        }
    }

    private func save() {
        do {
            _ = try SkillStore.shared.addManual(name: name, summary: summary, instructions: instructions)
            isPresented = false
        } catch {
            errorMessage = error.localizedDescription
        }
    }
}

/// Scans `~/.claude/skills/` once on appear and lists everything not
/// already in the library — real local files, not a fabricated API (see
/// `SkillStore.localClaudeSkillCandidates`).
private struct ImportLocalSkillsSheet: View {
    @Environment(\.themeColors) private var colors
    @Binding var isPresented: Bool
    @State private var candidates: [LocalSkillCandidate] = []
    @State private var importedPaths: Set<String> = []
    @State private var didScan = false

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            Text("Import from Claude Code")
                .font(AppFont.mono(16, weight: .bold))
                .foregroundColor(colors.textPrimary)

            Text("Skills found in ~/.claude/skills/ on this Mac that aren't already in your library.")
                .font(AppFont.sans(12))
                .foregroundColor(colors.textSecondary)
                .fixedSize(horizontal: false, vertical: true)
                .lineSpacing(3)

            if !didScan {
                Text("Scanning…")
                    .font(AppFont.mono(12))
                    .foregroundColor(colors.textTertiary)
            } else if candidates.isEmpty {
                Text("Nothing new to import. Either none were found, or everything there is already in your library.")
                    .font(AppFont.sans(12))
                    .foregroundColor(colors.textTertiary)
                    .fixedSize(horizontal: false, vertical: true)
                    .lineSpacing(3)
            } else {
                // Bounded height + its own ScrollView — a real Mac with
                // dozens of skills under ~/.claude/skills/ (20, on this
                // one) must never make the SHEET itself grow past the
                // screen; only this list should scroll.
                ScrollView {
                    SettingsCard {
                        VStack(spacing: 0) {
                            ForEach(Array(candidates.enumerated()), id: \.element.id) { index, candidate in
                                if index > 0 { Divider().overlay(colors.borderSubtle) }
                                HStack(spacing: 12) {
                                    VStack(alignment: .leading, spacing: 2) {
                                        Text("/\(candidate.parsed.name)")
                                            .font(AppFont.mono(14, weight: .semibold))
                                            .foregroundColor(colors.textPrimary)
                                        Text(candidate.parsed.summary)
                                            .font(AppFont.sans(11.5))
                                            .foregroundColor(colors.textSecondary)
                                            .lineLimit(2)
                                    }
                                    Spacer(minLength: 8)
                                    if importedPaths.contains(candidate.path) {
                                        Text("Imported")
                                            .font(AppFont.mono(11, weight: .medium))
                                            .foregroundColor(colors.textTertiary)
                                    } else {
                                        Button("Import") {
                                            SkillStore.shared.importLocal(candidate)
                                            importedPaths.insert(candidate.path)
                                        }
                                        .buttonStyle(.bordered)
                                        .controlSize(.small)
                                    }
                                }
                                .padding(.horizontal, 16)
                                .padding(.vertical, 10)
                            }
                        }
                    }
                }
                .frame(maxHeight: 420)
            }

            HStack {
                Spacer()
                Button("Done") { isPresented = false }.buttonStyle(.bordered)
            }
        }
        .padding(24)
        .frame(width: 460)
        .onAppear {
            candidates = SkillStore.shared.localClaudeSkillCandidates()
            didScan = true
        }
    }
}
