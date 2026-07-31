import AppKit
import Foundation
import Observation

/// The folder Eaon Work builds in.
///
/// Before this, every Work session began with the agent inventing a folder
/// ("I'll put this in ~/snake-game") — fine for something built from
/// nothing, useless the moment the task is about code that already exists.
/// Saying "fix the login bug" meant first telling it where your project even
/// is, every single time. Picking the folder once, up front, is the whole
/// difference between a code generator and something that works on *your*
/// code.
///
/// Selecting a folder changes three things:
/// - the agent is told, in its system prompt, that this is the project and
///   not to go creating another one (`DesktopControlTool.codingInstructionBlock`)
/// - `run_shell` runs there by default instead of in the home directory
/// - the bar above the composer shows it, along with the git branch it's on
///
/// Reading is deliberately available off the main actor: the tool layer that
/// needs the path runs on a background queue and can't hop actors mid-call,
/// so the value of record is `UserDefaults` (thread-safe by contract) and the
/// `@Observable` store is a UI mirror of it, not the source of truth.
enum WorkFolder {
    static let selectedKey = "eaon_work_folder"
    static let recentsKey = "eaon_work_folder_recents"
    /// Enough to cover the handful of projects anyone actually alternates
    /// between; past that a "recent" list is just a second file browser.
    static let maxRecents = 6

    /// The chosen folder, or nil when the agent should pick its own as it
    /// always has. Verified to still exist on every read — a folder that was
    /// moved or deleted since it was chosen must not silently become the
    /// working directory of a shell command.
    nonisolated static func currentPath() -> String? {
        guard let path = UserDefaults.standard.string(forKey: selectedKey), !path.isEmpty else { return nil }
        var isDirectory: ObjCBool = false
        guard FileManager.default.fileExists(atPath: path, isDirectory: &isDirectory), isDirectory.boolValue else {
            return nil
        }
        return path
    }

    /// `~`-abbreviated for display — an absolute path in a chip is mostly
    /// the same twenty leading characters on every machine.
    static func displayName(for path: String) -> String {
        URL(fileURLWithPath: path).lastPathComponent
    }

    static func abbreviated(_ path: String) -> String {
        path.replacingOccurrences(of: NSHomeDirectory(), with: "~")
    }
}

/// Git facts about a folder, read by running git itself.
///
/// Parsing `.git` by hand would be faster and wrong: worktrees, submodules,
/// detached heads, and packed refs all have edge cases git already handles.
/// These calls are cheap and only run when the folder changes or the user
/// asks for a refresh, never per keystroke.
enum GitInfo {
    struct Status: Equatable {
        var branch: String
        /// Uncommitted changes present. Shown as a dot on the branch chip,
        /// and it's what makes removing a worktree refuse rather than
        /// discard work.
        var isDirty: Bool
    }

    /// Runs a git command in `directory`, returning trimmed stdout, or nil
    /// if git isn't installed, the folder isn't a repo, or it failed.
    static func run(_ arguments: [String], in directory: String) -> String? {
        let candidates = ["/usr/bin/git", "/opt/homebrew/bin/git", "/usr/local/bin/git"]
        guard let executable = candidates.first(where: { FileManager.default.isExecutableFile(atPath: $0) }) else {
            return nil
        }

        let process = Process()
        process.executableURL = URL(fileURLWithPath: executable)
        process.arguments = arguments
        process.currentDirectoryURL = URL(fileURLWithPath: directory)
        let pipe = Pipe()
        process.standardOutput = pipe
        // Discarded rather than merged: git's diagnostics ("not a git
        // repository") would otherwise come back as if they were the branch
        // name and get rendered in the chip.
        process.standardError = FileHandle.nullDevice

        do { try process.run() } catch { return nil }
        let data = pipe.fileHandleForReading.readDataToEndOfFile()
        process.waitUntilExit()
        guard process.terminationStatus == 0 else { return nil }
        return String(data: data, encoding: .utf8)?.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    static func status(of directory: String) -> Status? {
        guard let branch = run(["rev-parse", "--abbrev-ref", "HEAD"], in: directory), !branch.isEmpty else {
            return nil
        }
        let porcelain = run(["status", "--porcelain"], in: directory) ?? ""
        return Status(branch: branch, isDirty: !porcelain.isEmpty)
    }

    /// The repository root of `directory` — its own root when it's a normal
    /// checkout, and the *main* repository's root when it's a linked
    /// worktree.
    static func mainRepoPath(of directory: String) -> String? {
        guard let commonDir = run(["rev-parse", "--git-common-dir"], in: directory) else { return nil }
        // Git returns a relative path here on older versions, so resolve it
        // against the folder it was asked about rather than assuming.
        let absolute = commonDir.hasPrefix("/")
            ? commonDir
            : URL(fileURLWithPath: directory).appendingPathComponent(commonDir).standardized.path
        return URL(fileURLWithPath: absolute).deletingLastPathComponent().path
    }

    static func topLevel(of directory: String) -> String? {
        run(["rev-parse", "--show-toplevel"], in: directory)
    }

    /// True when `directory` is a linked worktree rather than the repo
    /// itself — its own root differs from the main repository's.
    static func isLinkedWorktree(_ directory: String) -> Bool {
        guard let top = topLevel(of: directory), let main = mainRepoPath(of: directory) else { return false }
        return URL(fileURLWithPath: top).standardized.path != URL(fileURLWithPath: main).standardized.path
    }

    /// Where Eaon keeps its worktrees. Deliberately outside the repository:
    /// a worktree created *inside* the project shows up in its own status,
    /// its own searches, and its own builds.
    static var worktreeRoot: URL {
        URL(fileURLWithPath: NSHomeDirectory())
            .appendingPathComponent("Library/Application Support/Eaon/Worktrees")
    }

    enum WorktreeOutcome {
        case created(path: String)
        case failed(reason: String)
    }

    /// Creates a worktree on a fresh branch off the current HEAD. Returns
    /// its path, or a message explaining why not.
    static func addWorktree(repo: String, id: String) -> WorktreeOutcome {
        let name = URL(fileURLWithPath: repo).lastPathComponent
        let destination = worktreeRoot.appendingPathComponent("\(name)-\(id)")
        try? FileManager.default.createDirectory(at: worktreeRoot, withIntermediateDirectories: true)
        guard run(["worktree", "add", "-b", "eaon/\(id)", destination.path], in: repo) != nil else {
            return .failed(reason: "Couldn't create a worktree here. Check that this is a git repository with at least one commit.")
        }
        return .created(path: destination.path)
    }

    /// Removes a worktree. Git itself refuses when there are modified or
    /// untracked files inside, which is the behaviour we want — this is a
    /// throwaway checkout right up until it isn't, and forcing it would
    /// silently delete whatever the agent had just written.
    static func removeWorktree(at path: String, repo: String) -> String? {
        guard run(["worktree", "remove", path], in: repo) != nil else {
            return "That worktree still has uncommitted changes, so it wasn't removed. Commit or discard them first — or keep working in it."
        }
        return nil
    }
}

@MainActor
@Observable
final class WorkFolderStore {
    static let shared = WorkFolderStore()

    private(set) var selectedPath: String?
    private(set) var recents: [String] = []
    /// Git status of `selectedPath`, or nil when it isn't a repo. Refreshed
    /// on selection and on demand — not polled, because a chip that re-runs
    /// `git status` on a timer is a chip that spins up a process every few
    /// seconds forever.
    private(set) var git: GitInfo.Status?
    /// True when the selected folder is one of Eaon's throwaway checkouts
    /// rather than the repository itself.
    private(set) var isInWorktree = false
    /// Set when an action couldn't be carried out (a worktree that would
    /// discard uncommitted work, a folder that vanished), shown in the bar
    /// instead of failing silently.
    var notice: String?

    private init() {
        selectedPath = WorkFolder.currentPath()
        recents = (UserDefaults.standard.array(forKey: WorkFolder.recentsKey) as? [String] ?? [])
            .filter { FileManager.default.fileExists(atPath: $0) }
        refreshGit()
    }

    var displayName: String? {
        selectedPath.map(WorkFolder.displayName(for:))
    }

    func select(path: String) {
        var isDirectory: ObjCBool = false
        guard FileManager.default.fileExists(atPath: path, isDirectory: &isDirectory), isDirectory.boolValue else {
            notice = "That folder no longer exists."
            recents.removeAll { $0 == path }
            persistRecents()
            return
        }
        selectedPath = path
        UserDefaults.standard.set(path, forKey: WorkFolder.selectedKey)
        // Most-recent-first, no duplicates — reselecting a folder should
        // move it up the list, not add a second copy of it.
        recents.removeAll { $0 == path }
        recents.insert(path, at: 0)
        if recents.count > WorkFolder.maxRecents { recents = Array(recents.prefix(WorkFolder.maxRecents)) }
        persistRecents()
        refreshGit()
    }

    func clear() {
        selectedPath = nil
        UserDefaults.standard.removeObject(forKey: WorkFolder.selectedKey)
        git = nil
    }

    func removeRecent(_ path: String) {
        recents.removeAll { $0 == path }
        persistRecents()
    }


    /// Opens the system folder chooser. `canChooseFiles` is off deliberately:
    /// this names the project Eaon works *in*, and a single file is not a
    /// project — pointing at one would leave every relative path and every
    /// `run_shell` without a directory to resolve against.
    func chooseFolder() {
        let panel = NSOpenPanel()
        panel.canChooseDirectories = true
        panel.canChooseFiles = false
        panel.allowsMultipleSelection = false
        panel.prompt = "Use Folder"
        panel.message = "Choose the project folder Eaon Work should build in."
        if let current = selectedPath {
            panel.directoryURL = URL(fileURLWithPath: current)
        }
        // The app has to be active for a panel to come forward — the same
        // reason the desktop assistant activates on mouse-down.
        NSApp.activate(ignoringOtherApps: true)
        guard panel.runModal() == .OK, let url = panel.url else { return }
        select(path: url.path)
    }

    func refreshGit() {
        guard let selectedPath else { git = nil; isInWorktree = false; return }
        git = GitInfo.status(of: selectedPath)
        isInWorktree = git != nil && GitInfo.isLinkedWorktree(selectedPath)
    }

    // MARK: - Worktree

    /// Puts the session in a throwaway checkout of the same repository, so
    /// the agent's edits never land in the tree you have open in your
    /// editor. Turning it off brings you back to the repo — and refuses if
    /// that would throw away work.
    func toggleWorktree() {
        guard let selectedPath, git != nil else { return }
        notice = nil

        if isInWorktree {
            guard let repo = GitInfo.mainRepoPath(of: selectedPath) else {
                notice = "Couldn't find the repository this worktree belongs to."
                return
            }
            if let failure = GitInfo.removeWorktree(at: selectedPath, repo: repo) {
                notice = failure
                return
            }
            select(path: repo)
        } else {
            // Short and time-ordered rather than a UUID: this becomes a
            // branch name and a folder name a human has to read.
            let id = String(Int(Date().timeIntervalSince1970) % 100_000)
            switch GitInfo.addWorktree(repo: selectedPath, id: id) {
            case .created(let path):
                select(path: path)
            case .failed(let reason):
                notice = reason
            }
        }
    }

    private func persistRecents() {
        UserDefaults.standard.set(recents, forKey: WorkFolder.recentsKey)
    }
}
