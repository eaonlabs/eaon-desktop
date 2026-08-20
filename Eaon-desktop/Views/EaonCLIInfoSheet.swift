import AppKit
import SwiftUI

/// Everything about the Eaon CLI in one place: what it is, whether it's
/// runnable right now, how to install the global `eaon` command, where its
/// config lives, and the full command/mode reference — the "control
/// everything about the CLI" hub reached from Settings → General.
///
/// The CLI is a separate Node.js program (`eaon-cli`) that powers Eaon Code's
/// embedded terminal and also runs standalone in any terminal. This panel is
/// read-and-launch: it surfaces status and the exact commands to run, and
/// opens the CLI's own config file for editing, rather than reimplementing
/// the CLI's settings as native forms (the config file is the one source of
/// truth both the CLI and this app already share).
struct EaonCLIInfoSheet: View {
    @Environment(\.themeColors) private var colors
    @Environment(\.dismiss) private var dismiss

    @State private var status: EaonCLILauncher.Status?
    @State private var isLoading = true
    @State private var copiedField: String?
    @State private var isInstalling = false
    @State private var installErrorMessage: String?
    @State private var isUpdating = false
    @State private var updateErrorMessage: String?

    var body: some View {
        VStack(spacing: 0) {
            header
            Divider()
            ScrollView {
                VStack(alignment: .leading, spacing: 16) {
                    aboutCard
                    statusCard
                    if status?.canInstall == true {
                        installCard
                    }
                    if status?.updateAvailable != nil {
                        updateCard
                    }
                    terminalCard
                    configCard
                    referenceCard
                }
                .padding(20)
            }
        }
        .frame(width: 620, height: 680)
        .background(colors.backgroundPrimary)
        .task {
            let resolved = await Task.detached { EaonCLILauncher.status() }.value
            status = resolved
            isLoading = false
        }
    }

    // MARK: Header

    private var header: some View {
        HStack(spacing: 10) {
            Image(systemName: "terminal.fill")
                .font(.system(size: 15, weight: .semibold))
                .foregroundStyle(colors.textSecondary)
            VStack(alignment: .leading, spacing: 1) {
                HStack(spacing: 8) {
                    Text("Eaon CLI")
                        .font(AppFont.mono(16, weight: .semibold))
                        .foregroundStyle(colors.textPrimary)
                    if let version = status?.version {
                        Text("v\(version)")
                            .font(AppFont.mono(12, weight: .medium))
                            .foregroundStyle(colors.textTertiary)
                    }
                    if let newer = status?.updateAvailable {
                        Text("v\(newer) available")
                            .font(AppFont.mono(12, weight: .semibold))
                            .foregroundStyle(Color(hex: "#3B82F6"))
                            .padding(.horizontal, 6)
                            .padding(.vertical, 2)
                            .background(Capsule().fill(Color(hex: "#3B82F6").opacity(0.14)))
                    }
                }
                Text("Eaon in your terminal, for any model, local or hosted.")
                    .font(AppFont.sans(12))
                    .foregroundStyle(colors.textTertiary)
            }
            Spacer()
            statusPill
            Button {
                dismiss()
            } label: {
                Image(systemName: "xmark")
                    .font(.system(size: 12, weight: .semibold))
                    .foregroundStyle(colors.textSecondary)
                    .iconHoverEffect(for: "xmark")
                    .frame(width: 26, height: 26)
                    .background(Circle().fill(colors.backgroundSubtle))
            }
            .buttonStyle(.plain)
        }
        .padding(16)
        .background(colors.backgroundSidebar)
    }

    @ViewBuilder
    private var statusPill: some View {
        if isLoading {
            HStack(spacing: 5) {
                ProgressView().controlSize(.mini)
                Text("Checking…").font(AppFont.mono(10))
            }
            .foregroundStyle(colors.textTertiary)
        } else {
            let ready = status?.isReady == true
            HStack(spacing: 4) {
                Image(systemName: ready ? "checkmark.circle.fill" : "exclamationmark.triangle.fill")
                    .font(.system(size: 9, weight: .semibold))
                Text(ready ? "Ready" : "Needs setup")
                    .font(AppFont.mono(10, weight: .medium))
            }
            .foregroundStyle(ready ? Color(hex: "#34C759") : Color(hex: "#F59E0B"))
            .padding(.horizontal, 7)
            .padding(.vertical, 3)
            .background(Capsule().fill((ready ? Color(hex: "#34C759") : Color(hex: "#F59E0B")).opacity(0.14)))
        }
    }

    // MARK: About

    private var aboutCard: some View {
        SettingsCard {
            VStack(alignment: .leading, spacing: 8) {
                Text("What it is")
                    .font(AppFont.mono(14, weight: .semibold))
                    .foregroundStyle(colors.textPrimary)
                Text("A real terminal agent that does agentic coding, Eaon Claw, and plain chat. It runs on any model you have, whether that's a local Ollama model or a hosted/BYOK key. It's the same engine behind Eaon Code inside this app, and it also runs standalone in any terminal window. Works on macOS, Linux, and Windows.")
                    .font(AppFont.sans(12))
                    .foregroundStyle(colors.textSecondary)
                    .fixedSize(horizontal: false, vertical: true)
                    .lineSpacing(3)
            }
            .padding(16)
            .frame(maxWidth: .infinity, alignment: .leading)
        }
    }

    // MARK: Status

    private var statusCard: some View {
        SettingsCard {
            VStack(alignment: .leading, spacing: 10) {
                Text("Status")
                    .font(AppFont.mono(14, weight: .semibold))
                    .foregroundStyle(colors.textPrimary)

                statusLine(
                    label: "Node.js",
                    ok: status?.nodePath != nil,
                    detail: status?.nodePath ?? "Not found — install Node 18.17+ (e.g. brew install node)"
                )
                statusLine(
                    label: "CLI build",
                    ok: status?.entryPoint != nil,
                    detail: status?.entryPoint ?? (
                        status?.canInstall == true
                            ? "Not installed yet — click Install below"
                            : "Not built yet — run the setup commands below"
                    )
                )

                if status?.isReady == true {
                    Text("Eaon Code (in the mode switcher) will launch this automatically.")
                        .font(AppFont.sans(12))
                        .foregroundStyle(colors.textTertiary)
                }
            }
            .padding(16)
            .frame(maxWidth: .infinity, alignment: .leading)
        }
    }

    private func statusLine(label: String, ok: Bool, detail: String) -> some View {
        HStack(alignment: .top, spacing: 8) {
            Image(systemName: ok ? "checkmark.circle.fill" : "xmark.circle.fill")
                .font(.system(size: 12))
                .foregroundStyle(ok ? Color(hex: "#34C759") : colors.textTertiary)
            VStack(alignment: .leading, spacing: 1) {
                Text(label)
                    .font(AppFont.mono(12, weight: .medium))
                    .foregroundStyle(colors.textPrimary)
                Text(detail)
                    .font(AppFont.mono(10))
                    .foregroundStyle(colors.textTertiary)
                    .lineLimit(1)
                    .truncationMode(.middle)
                    .textSelection(.enabled)
            }
            Spacer(minLength: 0)
        }
    }

    // MARK: Install

    private var installCard: some View {
        SettingsCard {
            VStack(alignment: .leading, spacing: 10) {
                Text("Install Eaon CLI")
                    .font(AppFont.mono(14, weight: .semibold))
                    .foregroundStyle(colors.textPrimary)
                Text("A ready-to-run copy ships inside this app. Installing copies it to \(displayPath(EaonCLILauncher.installedDirectory)) and links a global `eaon` command. No download, no npm, and it works offline.")
                    .font(AppFont.sans(12))
                    .foregroundStyle(colors.textSecondary)
                    .fixedSize(horizontal: false, vertical: true)
                    .lineSpacing(3)

                if let installErrorMessage {
                    Text(installErrorMessage)
                        .font(AppFont.sans(12))
                        .foregroundStyle(Color(hex: "#F59E0B"))
                        .fixedSize(horizontal: false, vertical: true)
                        .lineSpacing(3)
                }

                HStack {
                    Button {
                        installEaonCLI()
                    } label: {
                        HStack(spacing: 6) {
                            if isInstalling {
                                ProgressView().controlSize(.mini)
                            } else {
                                Image(systemName: "arrow.down.circle.fill").font(.system(size: 11))
                            }
                            Text(isInstalling ? "Installing…" : "Install Eaon CLI")
                                .font(AppFont.mono(12, weight: .medium))
                        }
                    }
                    .buttonStyle(.borderedProminent)
                    .controlSize(.regular)
                    .disabled(isInstalling)
                    Spacer()
                }

                Text("If `eaon` doesn't run in a new terminal afterward, add `~/.local/bin` to your PATH. macOS shells don't include it by default.")
                    .font(AppFont.sans(10))
                    .foregroundStyle(colors.textTertiary)
                    .fixedSize(horizontal: false, vertical: true)
                    .lineSpacing(3)
            }
            .padding(16)
            .frame(maxWidth: .infinity, alignment: .leading)
        }
    }

    private func displayPath(_ path: String) -> String {
        path.replacingOccurrences(of: NSHomeDirectory(), with: "~")
    }

    private func installEaonCLI() {
        isInstalling = true
        installErrorMessage = nil
        Task {
            do {
                try await Task.detached { try EaonCLILauncher.install() }.value
                let resolved = await Task.detached { EaonCLILauncher.status() }.value
                status = resolved
            } catch {
                installErrorMessage = error.localizedDescription
            }
            isInstalling = false
        }
    }

    // MARK: Update

    private var updateCard: some View {
        SettingsCard {
            VStack(alignment: .leading, spacing: 10) {
                Text("Update available")
                    .font(AppFont.mono(14, weight: .semibold))
                    .foregroundStyle(colors.textPrimary)
                if let installed = status?.version, let newer = status?.updateAvailable {
                    Text("This app now bundles Eaon CLI v\(newer), and you have v\(installed) installed. Updating replaces the program files at \(displayPath(EaonCLILauncher.installedDirectory)); your config and sessions in \(displayPath(EaonCLILauncher.configDirectory)) are untouched.")
                        .font(AppFont.sans(12))
                        .foregroundStyle(colors.textSecondary)
                        .fixedSize(horizontal: false, vertical: true)
                        .lineSpacing(3)
                }

                if let updateErrorMessage {
                    Text(updateErrorMessage)
                        .font(AppFont.sans(12))
                        .foregroundStyle(Color(hex: "#F59E0B"))
                        .fixedSize(horizontal: false, vertical: true)
                        .lineSpacing(3)
                }

                HStack {
                    Button {
                        updateEaonCLI()
                    } label: {
                        HStack(spacing: 6) {
                            if isUpdating {
                                ProgressView().controlSize(.mini)
                            } else {
                                Image(systemName: "arrow.triangle.2.circlepath").font(.system(size: 11))
                            }
                            Text(isUpdating ? "Updating…" : "Update Eaon CLI")
                                .font(AppFont.mono(12, weight: .medium))
                        }
                    }
                    .buttonStyle(.borderedProminent)
                    .controlSize(.regular)
                    .disabled(isUpdating)
                    Spacer()
                }
            }
            .padding(16)
            .frame(maxWidth: .infinity, alignment: .leading)
        }
    }

    private func updateEaonCLI() {
        isUpdating = true
        updateErrorMessage = nil
        Task {
            do {
                try await Task.detached { try EaonCLILauncher.update() }.value
                let resolved = await Task.detached { EaonCLILauncher.status() }.value
                status = resolved
            } catch {
                updateErrorMessage = error.localizedDescription
            }
            isUpdating = false
        }
    }

    // MARK: Terminal setup

    private var terminalCard: some View {
        SettingsCard {
            VStack(alignment: .leading, spacing: 10) {
                Text("Run it in any terminal")
                    .font(AppFont.mono(14, weight: .semibold))
                    .foregroundStyle(colors.textPrimary)
                Text("Build it once and link a global `eaon` command, then run `eaon` from any project folder, outside this app.")
                    .font(AppFont.sans(12))
                    .foregroundStyle(colors.textSecondary)
                    .fixedSize(horizontal: false, vertical: true)
                    .lineSpacing(3)

                commandRow(id: "cd", command: cdCommand)
                commandRow(id: "install", command: "npm install")
                commandRow(id: "build", command: "npm run build")
                commandRow(id: "link", command: "npm link")

                Text("After that, just type `eaon` in any terminal. Run `eaon --help` for every flag.")
                    .font(AppFont.sans(12))
                    .foregroundStyle(colors.textTertiary)
                    .fixedSize(horizontal: false, vertical: true)
                    .lineSpacing(3)
            }
            .padding(16)
            .frame(maxWidth: .infinity, alignment: .leading)
        }
    }

    private var cdCommand: String {
        if let dir = status?.cliDirectory {
            return "cd \"\(dir)\""
        }
        return "cd eaon-cli"
    }

    private func commandRow(id: String, command: String) -> some View {
        HStack(spacing: 8) {
            Text(command)
                .font(AppFont.mono(12))
                .foregroundStyle(colors.textPrimary)
                .lineLimit(1)
                .truncationMode(.middle)
                .textSelection(.enabled)
                .frame(maxWidth: .infinity, alignment: .leading)
            Button(copiedField == id ? "Copied" : "Copy") {
                copy(command, field: id)
            }
            .buttonStyle(.bordered)
            .controlSize(.small)
        }
        .padding(.horizontal, 10)
        .padding(.vertical, 8)
        .background(colors.backgroundInput)
        .clipShape(RoundedRectangle(cornerRadius: 7, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: 7, style: .continuous).stroke(colors.borderSubtle, lineWidth: 1))
    }

    // MARK: Config

    private var configCard: some View {
        SettingsCard {
            VStack(alignment: .leading, spacing: 10) {
                Text("Configuration")
                    .font(AppFont.mono(14, weight: .semibold))
                    .foregroundStyle(colors.textPrimary)
                Text("The CLI keeps its own settings file. It holds your Eaon and BYOK keys, Ollama URL, custom providers, default mode, permission mode, and custom instructions. Edit it directly to control how the CLI behaves.")
                    .font(AppFont.sans(12))
                    .foregroundStyle(colors.textSecondary)
                    .fixedSize(horizontal: false, vertical: true)
                    .lineSpacing(3)

                HStack(spacing: 8) {
                    Text(EaonCLILauncher.configFilePath.replacingOccurrences(of: NSHomeDirectory(), with: "~"))
                        .font(AppFont.mono(12))
                        .foregroundStyle(colors.textTertiary)
                        .lineLimit(1)
                        .truncationMode(.middle)
                        .frame(maxWidth: .infinity, alignment: .leading)
                    Button("Open") { openConfigFile() }
                        .buttonStyle(.bordered)
                        .controlSize(.small)
                    Button("Reveal") { revealConfig() }
                        .buttonStyle(.bordered)
                        .controlSize(.small)
                }
                .padding(.horizontal, 10)
                .padding(.vertical, 8)
                .background(colors.backgroundInput)
                .clipShape(RoundedRectangle(cornerRadius: 7, style: .continuous))
                .overlay(RoundedRectangle(cornerRadius: 7, style: .continuous).stroke(colors.borderSubtle, lineWidth: 1))
            }
            .padding(16)
            .frame(maxWidth: .infinity, alignment: .leading)
        }
    }

    // MARK: Reference

    private var referenceCard: some View {
        SettingsCard {
            VStack(alignment: .leading, spacing: 12) {
                HStack {
                    Text("Reference")
                        .font(AppFont.mono(14, weight: .semibold))
                        .foregroundStyle(colors.textPrimary)
                    Spacer()
                    if status?.cliDirectory != nil {
                        Button {
                            openReadme()
                        } label: {
                            HStack(spacing: 5) {
                                Image(systemName: "book").font(.system(size: 10))
                                    .iconHoverEffect(for: "book")
                                Text("Full README").font(AppFont.mono(12, weight: .medium))
                            }
                        }
                        .buttonStyle(.bordered)
                        .controlSize(.small)
                    }
                }

                referenceGroup("Modes", rows: [
                    ("Chat", "Plain conversation, no tools."),
                    ("Agent", "A coding agent scoped to your project. It can write, edit, read, run shell, and more."),
                    ("Claw", "Agent's tools plus the wider system: trash, open/quit apps, open URLs, AppleScript (macOS)."),
                ])

                referenceGroup("Key commands", rows: [
                    ("/mode <chat|agent|claw>", "Switch mode"),
                    ("/model [name]", "Switch model, or list all"),
                    ("/pull <name>", "Download a model via Ollama"),
                    ("/permission [sandboxed|auto]", "Show or set the permission mode"),
                    ("/init", "Scan the project and write EAON.md"),
                    ("/resume [id]", "List or reopen a past session"),
                    ("/help", "List every command"),
                ])

                referenceGroup("Permission modes", rows: [
                    ("Sandboxed", "Every non-read action asks first (default)."),
                    ("Auto", "Actions run immediately. Toggle with Shift+Tab."),
                ])
            }
            .padding(16)
            .frame(maxWidth: .infinity, alignment: .leading)
        }
    }

    private func referenceGroup(_ title: String, rows: [(String, String)]) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(title.uppercased())
                .font(AppFont.mono(10, weight: .semibold))
                .foregroundStyle(colors.textTertiary)
            ForEach(rows, id: \.0) { row in
                HStack(alignment: .top, spacing: 10) {
                    Text(row.0)
                        .font(AppFont.mono(12, weight: .medium))
                        .foregroundStyle(colors.textPrimary)
                        .frame(width: 200, alignment: .leading)
                    Text(row.1)
                        .font(AppFont.sans(12))
                        .foregroundStyle(colors.textSecondary)
                        .fixedSize(horizontal: false, vertical: true)
                        .lineSpacing(3)
                    Spacer(minLength: 0)
                }
            }
        }
    }

    // MARK: Actions

    private func copy(_ text: String, field: String) {
        NSPasteboard.general.clearContents()
        NSPasteboard.general.setString(text, forType: .string)
        copiedField = field
        DispatchQueue.main.asyncAfter(deadline: .now() + 1.5) {
            if copiedField == field { copiedField = nil }
        }
    }

    private func openConfigFile() {
        let path = EaonCLILauncher.configFilePath
        let fm = FileManager.default
        if !fm.fileExists(atPath: path) {
            // The CLI creates this on its first run; make a minimal valid
            // file so "Open" always lands on something editable rather than
            // failing silently before the CLI has ever been launched.
            try? fm.createDirectory(atPath: EaonCLILauncher.configDirectory, withIntermediateDirectories: true)
            try? "{}\n".write(toFile: path, atomically: true, encoding: .utf8)
        }
        NSWorkspace.shared.open(URL(fileURLWithPath: path))
    }

    private func revealConfig() {
        let dir = EaonCLILauncher.configDirectory
        try? FileManager.default.createDirectory(atPath: dir, withIntermediateDirectories: true)
        NSWorkspace.shared.activateFileViewerSelecting([URL(fileURLWithPath: dir)])
    }

    private func openReadme() {
        guard let dir = status?.cliDirectory else { return }
        let readme = dir + "/README.md"
        if FileManager.default.fileExists(atPath: readme) {
            NSWorkspace.shared.open(URL(fileURLWithPath: readme))
        }
    }
}
