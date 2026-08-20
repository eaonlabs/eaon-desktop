import AppKit
import SwiftUI

/// The strip above the composer in Work mode: where the work runs, which
/// folder it happens in, and which branch that folder is on.
///
/// It sits above the composer rather than inside it because these aren't
/// message options — they're the standing context every message in the
/// session inherits. Put them among the send-time toggles and "which folder
/// am I working in" becomes a question you re-ask on every turn.
///
/// Chips are quiet by default and only light up when they carry real
/// information: no folder chosen reads as a plain "Choose folder", and the
/// branch chip isn't drawn at all outside a git repo rather than sitting
/// there empty.
struct WorkContextBar: View {
    @Environment(\.themeColors) private var colors
    @Bindable private var store = WorkFolderStore.shared
    /// Starting a fresh session from the "+" button, which is the one action
    /// here that isn't about context.
    var onNewSession: () -> Void = {}

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack(spacing: 6) {
                locationChip
                folderChip
                if store.git != nil { branchChip }
                newSessionButton
                Spacer(minLength: 0)
            }

            if let notice = store.notice {
                HStack(spacing: 6) {
                    Image(systemName: "exclamationmark.triangle.fill")
                        .font(.system(size: 10))
                    Text(notice)
                        .font(AppFont.sans(12))
                    Button("Dismiss") { store.notice = nil }
                        .buttonStyle(.plain)
                        .font(AppFont.sans(12, weight: .medium))
                        .foregroundStyle(colors.textSecondary)
                }
                .foregroundStyle(Color(hex: "#F59E0B"))
            }
        }
    }

    // MARK: - Chips

    /// Where the work physically happens. Eaon only runs on this Mac, so
    /// this states a fact rather than offering a choice it can't honour —
    /// a menu whose only entry is the current value is a menu that wastes a
    /// click to tell you nothing.
    private var locationChip: some View {
        ChipShell {
            HStack(spacing: 5) {
                Image(systemName: "laptopcomputer")
                    .font(.system(size: 11))
                Text("Local")
                    .font(AppFont.sans(12))
            }
            .foregroundStyle(colors.textSecondary)
        }
        .help("Everything runs on this Mac. Eaon never uploads your project to run it somewhere else.")
    }

    private var folderChip: some View {
        Menu {
            if !store.recents.isEmpty {
                Section("Recent") {
                    ForEach(store.recents, id: \.self) { path in
                        Button {
                            store.select(path: path)
                        } label: {
                            // The whole path, not just the folder name: half
                            // of everyone's projects are called "app", "web",
                            // or "src", and the name alone can't tell two of
                            // them apart in a list.
                            Text(WorkFolder.abbreviated(path))
                        }
                    }
                }
            }
            Divider()
            Button("Open Folder…") { store.chooseFolder() }
            if store.selectedPath != nil {
                Button("Reveal in Finder") {
                    guard let path = store.selectedPath else { return }
                    NSWorkspace.shared.selectFile(nil, inFileViewerRootedAtPath: path)
                }
                Divider()
                Button("Work Anywhere (No Folder)") { store.clear() }
            }
        } label: {
            HStack(spacing: 5) {
                Image(systemName: store.selectedPath == nil ? "folder.badge.questionmark" : "folder.fill")
                    .font(.system(size: 11))
                Text(store.displayName ?? "Choose folder")
                    .font(AppFont.sans(12, weight: store.selectedPath == nil ? .regular : .medium))
                    .lineLimit(1)
            }
            .foregroundStyle(store.selectedPath == nil ? colors.textSecondary : colors.textPrimary)
        }
        .menuStyle(.borderlessButton)
        .menuIndicator(.hidden)
        .fixedSize()
        .modifier(ChipBackground(isActive: store.selectedPath != nil))
        .help(store.selectedPath.map { "Eaon Work builds in \(WorkFolder.abbreviated($0))" }
            ?? "Pick the project folder Eaon Work should build in. Without one it invents a new folder for each task.")
    }

    /// The branch of the selected folder. Read-only on purpose: switching
    /// branches from a chat composer would be a `git checkout` fired at a
    /// tree that may have uncommitted work in it, and there's no good way to
    /// ask about that mid-sentence. Shown so you can catch the case that
    /// actually bites — being on the wrong branch before you ask for changes.
    @ViewBuilder
    private var branchChip: some View {
        if let git = store.git {
            ChipShell {
                HStack(spacing: 7) {
                    HStack(spacing: 5) {
                        Image(systemName: "arrow.triangle.branch")
                            .font(.system(size: 11))
                        Text(git.branch)
                            .font(AppFont.sans(12))
                            .lineLimit(1)
                        if git.isDirty {
                            Circle()
                                .fill(Color(hex: "#F59E0B"))
                                .frame(width: 5, height: 5)
                        }
                    }
                    .foregroundStyle(colors.textSecondary)
                    .help(git.isDirty
                        ? "On \(git.branch), with uncommitted changes. Anything Eaon edits lands on top of them."
                        : "On \(git.branch), working tree clean.")
                    .onTapGesture { store.refreshGit() }

                    Rectangle()
                        .fill(colors.borderSubtle)
                        .frame(width: 1, height: 13)

                    worktreeToggle
                }
            }
        }
    }

    /// Runs the session in a throwaway checkout of the same repo, so nothing
    /// the agent does touches the tree open in your editor. A checkbox and
    /// not a switch: it's a property of this session, and it reads as one
    /// choice among the branch facts beside it rather than a mode.
    private var worktreeToggle: some View {
        Button {
            store.toggleWorktree()
        } label: {
            HStack(spacing: 5) {
                Image(systemName: store.isInWorktree ? "checkmark.square.fill" : "square")
                    .font(.system(size: 11))
                Text("worktree")
                    .font(AppFont.sans(12))
            }
            .foregroundStyle(store.isInWorktree ? colors.textPrimary : colors.textSecondary)
            .contentShape(Rectangle())
        }
        .buttonStyle(PressableButtonStyle())
        .help(store.isInWorktree
            ? "Working in a separate checkout, so your own copy of the repo is untouched. Turning this off removes it, and refuses if there's uncommitted work in it."
            : "Work in a separate checkout of this repo on its own branch, so Eaon's edits never land in the tree you have open.")
    }

    private var newSessionButton: some View {
        Button(action: onNewSession) {
            Image(systemName: "plus")
                .font(.system(size: 11, weight: .medium))
                .foregroundStyle(colors.textSecondary)
                .frame(width: 26, height: 24)
                .background(
                    RoundedRectangle(cornerRadius: 8, style: .continuous)
                        .fill(colors.backgroundInputSecondary)
                )
                .contentShape(RoundedRectangle(cornerRadius: 8, style: .continuous))
        }
        .buttonStyle(PressableButtonStyle())
        .help("Start a new Work session in this folder")
    }
}

// MARK: - Chip chrome

private struct ChipBackground: ViewModifier {
    @Environment(\.themeColors) private var colors
    var isActive = false

    func body(content: Content) -> some View {
        content
            .padding(.horizontal, 9)
            .padding(.vertical, 5)
            .background(
                RoundedRectangle(cornerRadius: 8, style: .continuous)
                    .fill(isActive ? colors.backgroundSelected : colors.backgroundInputSecondary)
            )
    }
}

private struct ChipShell<Content: View>: View {
    @ViewBuilder var content: Content

    var body: some View {
        content.modifier(ChipBackground())
    }
}
