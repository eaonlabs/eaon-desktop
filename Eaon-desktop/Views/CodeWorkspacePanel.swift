import AppKit
import SwiftUI
import WebKit

/// The right-side agentic-coding panel: a VS Code-style workspace that opens
/// when the model creates files. Explorer tree + tabbed editor with line
/// numbers in Code mode, a real rendered browser in Preview mode (for web
/// projects), and one-click export of the whole project to disk.
struct CodeWorkspacePanel: View {
    @Environment(\.themeColors) private var colors
    @Bindable var viewModel: ChatViewModel

    private enum Mode {
        case code, preview
    }

    @State private var mode: Mode = .code
    @State private var collapsedFolders: Set<String> = []
    @State private var previewEntryURL: URL?
    @State private var previewRootURL: URL?
    @State private var previewReloadToken = 0
    @State private var justExported = false
    @State private var showConsole = false

    private var runner: WorkspaceRunner { .shared }

    private var files: [WorkspaceFile] { viewModel.workspaceFiles }

    private var selectedFile: WorkspaceFile? {
        files.first { $0.path == viewModel.selectedWorkspacePath } ?? files.first
    }

    /// What Preview renders: index.html if present, else the first HTML file.
    private var htmlEntryFile: WorkspaceFile? {
        files.first { $0.fileName.lowercased() == "index.html" }
            ?? files.first { ["html", "htm"].contains(($0.path as NSString).pathExtension.lowercased()) }
    }

    private var isStreamingFiles: Bool {
        viewModel.isGenerating && files.contains { !$0.isComplete }
    }

    /// What the Run button executes for a non-web project: the file you're
    /// looking at if it's runnable, otherwise the first runnable file.
    private var runEntryFile: WorkspaceFile? {
        if let selected = selectedFile, WorkspaceRunner.isRunnable(selected.path) { return selected }
        return files.first { WorkspaceRunner.isRunnable($0.path) }
    }

    private var canRun: Bool {
        htmlEntryFile != nil || runEntryFile != nil
    }

    private var runHelp: String {
        if runner.isRunning { return "Stop the running program" }
        if htmlEntryFile != nil { return "Run the site in a live preview" }
        if let entry = runEntryFile { return "Run \(entry.fileName)" }
        return "Nothing runnable yet. Supported: websites, Python, JavaScript, Swift, Ruby, PHP, Bash, Go"
    }

    var body: some View {
        VStack(spacing: 0) {
            header
            Divider().overlay(colors.borderSubtle)

            if files.isEmpty {
                emptyState
            } else {
                if mode == .preview, htmlEntryFile != nil {
                    previewBody
                } else {
                    codeBody
                }
                Divider().overlay(colors.borderSubtle)
                statusBar
            }
        }
        .background(colors.backgroundSidebar)
        .onChange(of: isStreamingFiles) { wasStreaming, nowStreaming in
            // Refresh an open preview once the model finishes writing —
            // reloading on every streamed character would thrash disk and
            // flicker the web view.
            if wasStreaming, !nowStreaming, mode == .preview, htmlEntryFile != nil {
                reloadPreview()
            }
        }
        .onChange(of: runner.isRunning) { _, nowRunning in
            // Agent-initiated runs surface the console so the user watches
            // the loop work.
            if nowRunning { showConsole = true }
        }
    }

    // MARK: - Header

    private var header: some View {
        HStack(spacing: 8) {
            Image(systemName: "chevron.left.forwardslash.chevron.right")
                .font(.system(size: 11, weight: .semibold))
                .foregroundStyle(colors.textSecondary)
                .frame(width: 24, height: 24)
                .background(
                    RoundedRectangle(cornerRadius: 6, style: .continuous)
                        .fill(colors.backgroundChipSecondary)
                )

            Text("Workspace")
                .font(.system(size: 13, weight: .semibold))
                .foregroundStyle(colors.textPrimary)

            if !files.isEmpty {
                Text("\(files.count) file\(files.count == 1 ? "" : "s")")
                    .font(.system(size: 11))
                    .foregroundStyle(colors.textTertiary)
            }

            Spacer(minLength: 8)

            if !files.isEmpty {
                runButton

                modeToggle

                PanelIconButton(
                    systemName: justExported ? "checkmark" : "square.and.arrow.down",
                    help: "Save project to your Mac"
                ) {
                    exportProject()
                }
            }

            PanelIconButton(systemName: "xmark", help: "Close workspace") {
                viewModel.closeWorkspace()
            }
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 9)
    }

    /// Run: websites open in the live preview; scripts execute locally with
    /// their output streamed into the console below the editor.
    private var runButton: some View {
        Button {
            if runner.isRunning {
                runner.stop()
            } else if htmlEntryFile != nil {
                mode = .preview
                reloadPreview()
            } else if let entry = runEntryFile {
                mode = .code
                showConsole = true
                runner.run(
                    files: files,
                    entry: entry,
                    workspaceKey: viewModel.currentConversationId?.uuidString ?? "draft"
                )
            }
        } label: {
            HStack(spacing: 4) {
                Image(systemName: runner.isRunning ? "stop.fill" : "play.fill")
                    .font(.system(size: 9, weight: .bold))
                    .iconHoverEffect(for: runner.isRunning ? "stop.fill" : "play.fill")
                Text(runner.isRunning ? "Stop" : "Run")
                    .font(.system(size: 11, weight: .semibold))
            }
            .foregroundStyle(colors.backgroundPrimary)
            .padding(.horizontal, 10)
            .padding(.vertical, 5)
            .background(Capsule().fill(colors.textPrimary))
            .contentShape(Capsule())
        }
        .buttonStyle(.plain)
        .disabled(!runner.isRunning && !canRun)
        .opacity(!runner.isRunning && !canRun ? 0.4 : 1)
        .help(runHelp)
    }

    private var modeToggle: some View {
        HStack(spacing: 2) {
            modeButton("Code", mode: .code)
            modeButton("Preview", mode: .preview)
                .disabled(htmlEntryFile == nil)
                .opacity(htmlEntryFile == nil ? 0.4 : 1)
                .help(htmlEntryFile == nil ? "Preview needs an HTML file" : "Open the site in a live preview")
        }
        .padding(2)
        .background(Capsule().fill(colors.backgroundChip))
    }

    private func modeButton(_ title: String, mode target: Mode) -> some View {
        Button {
            guard mode != target else { return }
            mode = target
            if target == .preview { reloadPreview() }
        } label: {
            Text(title)
                .font(.system(size: 11, weight: .medium))
                .foregroundStyle(mode == target ? colors.textPrimary : colors.textSecondary)
                .padding(.horizontal, 10)
                .padding(.vertical, 4)
                .background(Capsule().fill(mode == target ? colors.backgroundSelected : .clear))
                .contentShape(Capsule())
        }
        .buttonStyle(.plain)
    }

    // MARK: - Empty state

    private var emptyState: some View {
        VStack(spacing: 10) {
            Image(systemName: "folder.badge.gearshape")
                .font(.system(size: 30, weight: .light))
                .foregroundStyle(colors.textTertiary)
            Text("No files yet")
                .font(.system(size: 13, weight: .semibold))
                .foregroundStyle(colors.textPrimary)
            Text("Ask the model to build something, like a website,\na script, or an app. Its files appear here.")
                .font(.system(size: 12))
                .foregroundStyle(colors.textSecondary)
                .multilineTextAlignment(.center)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }

    // MARK: - Code mode

    private var codeBody: some View {
        HStack(spacing: 0) {
            fileExplorer
                .frame(width: 150)
            Divider().overlay(colors.borderSubtle)
            editorColumn
        }
    }

    private var fileExplorer: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 1) {
                Text("EXPLORER")
                    .font(.system(size: 10, weight: .semibold))
                    .foregroundStyle(colors.textTertiary)
                    .padding(.horizontal, 8)
                    .padding(.top, 8)
                    .padding(.bottom, 6)

                treeRows(WorkspaceTree.build(from: files), depth: 0)
            }
            .padding(.horizontal, 6)
            .padding(.bottom, 8)
            .frame(maxWidth: .infinity, alignment: .leading)
        }
    }

    private func treeRows(_ nodes: [WorkspaceTreeNode], depth: Int) -> AnyView {
        AnyView(
            ForEach(nodes) { node in
                VStack(alignment: .leading, spacing: 1) {
                    TreeRowButton(
                        node: node,
                        depth: depth,
                        isSelected: !node.isFolder && node.path == selectedFile?.path,
                        isCollapsed: collapsedFolders.contains(node.path),
                        isStreaming: isStreamingFiles && files.first(where: { $0.path == node.path })?.isComplete == false
                    ) {
                        if node.isFolder {
                            if collapsedFolders.contains(node.path) {
                                collapsedFolders.remove(node.path)
                            } else {
                                collapsedFolders.insert(node.path)
                            }
                        } else {
                            viewModel.selectedWorkspacePath = node.path
                        }
                    }
                    if node.isFolder, !collapsedFolders.contains(node.path) {
                        treeRows(node.children, depth: depth + 1)
                    }
                }
            }
        )
    }

    private var editorColumn: some View {
        VStack(spacing: 0) {
            tabStrip
            Divider().overlay(colors.borderSubtle)
            if let file = selectedFile {
                codeEditor(file)
            } else {
                Color.clear
            }
            if showConsole {
                Divider().overlay(colors.borderSubtle)
                consoleView
            }
        }
        .background(colors.backgroundCode)
        .onAppear {
            if runner.isRunning { showConsole = true }
        }
    }

    // MARK: - Console

    private var consoleView: some View {
        VStack(spacing: 0) {
            HStack(spacing: 8) {
                Text("CONSOLE")
                    .font(.system(size: 10, weight: .semibold))
                    .foregroundStyle(colors.textTertiary)
                if runner.isRunning {
                    ProgressView()
                        .controlSize(.mini)
                }
                Spacer()
                if runner.isRunning {
                    PanelIconButton(systemName: "stop.fill", help: "Stop") { runner.stop() }
                } else if !runner.chunks.isEmpty {
                    PanelIconButton(systemName: "trash", help: "Clear console") { runner.clear() }
                }
                PanelIconButton(systemName: "chevron.down", help: "Hide console") { showConsole = false }
            }
            .padding(.horizontal, 10)
            .padding(.vertical, 3)
            .background(colors.backgroundCodeHeader)

            Divider().overlay(colors.borderSubtle)

            ScrollViewReader { proxy in
                ScrollView {
                    Group {
                        if runner.chunks.isEmpty {
                            Text(runEntryFile.map { "Press Run to execute \($0.fileName)." } ?? "Program output will appear here.")
                                .font(.system(size: 11, design: .monospaced))
                                .foregroundStyle(colors.textTertiary)
                        } else {
                            consoleText
                                .textSelection(.enabled)
                        }
                    }
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(10)
                    Color.clear.frame(height: 1).id(consoleBottomAnchor)
                }
                .onChange(of: runner.chunks) { _, _ in
                    proxy.scrollTo(consoleBottomAnchor, anchor: .bottom)
                }
                .onAppear {
                    proxy.scrollTo(consoleBottomAnchor, anchor: .bottom)
                }
            }
        }
        .frame(height: 170)
    }

    private let consoleBottomAnchor = "workspace-console-bottom"

    /// One combined Text so output flows exactly as the process printed it,
    /// with per-stream coloring (chunks are already coalesced by kind).
    private var consoleText: Text {
        runner.chunks.reduce(Text("")) { partial, chunk in
            partial + Text(chunk.text).foregroundColor(consoleColor(for: chunk.kind))
        }
        .font(.system(size: 11, design: .monospaced))
    }

    private func consoleColor(for kind: WorkspaceRunner.ChunkKind) -> Color {
        switch kind {
        case .command: return colors.textSecondary
        case .stdout: return colors.textCode
        case .stderr: return colors.destructive
        case .status: return colors.textTertiary
        }
    }

    private var tabStrip: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 0) {
                ForEach(files) { file in
                    tab(for: file)
                }
            }
        }
        .frame(height: 30)
        .background(colors.backgroundCodeHeader)
    }

    private func tab(for file: WorkspaceFile) -> some View {
        let isSelected = file.path == selectedFile?.path
        return Button {
            viewModel.selectedWorkspacePath = file.path
        } label: {
            HStack(spacing: 5) {
                Image(systemName: WorkspaceFileIcon.systemName(forPath: file.path))
                    .font(.system(size: 9))
                    .foregroundStyle(colors.textTertiary)
                Text(file.fileName)
                    .font(.system(size: 11.5))
                    .foregroundStyle(isSelected ? colors.textPrimary : colors.textSecondary)
                if !file.isComplete && viewModel.isGenerating {
                    StreamingDot()
                }
            }
            .padding(.horizontal, 11)
            .frame(height: 30)
            .background(isSelected ? colors.backgroundCode : .clear)
            .overlay(alignment: .top) {
                Rectangle()
                    .fill(colors.textPrimary.opacity(isSelected ? 0.55 : 0))
                    .frame(height: 2)
            }
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
    }

    private func codeEditor(_ file: WorkspaceFile) -> some View {
        ScrollView(.vertical) {
            HStack(alignment: .top, spacing: 0) {
                Text(lineNumbers(for: file))
                    .font(.system(size: 12, design: .monospaced))
                    .foregroundStyle(colors.textTertiary.opacity(0.7))
                    .multilineTextAlignment(.trailing)
                    .padding(.leading, 10)
                    .padding(.trailing, 10)
                    .padding(.vertical, 10)

                ScrollView(.horizontal, showsIndicators: false) {
                    editorText(for: file)
                        .font(.system(size: 12, design: .monospaced))
                        .textSelection(.enabled)
                        .padding(.trailing, 16)
                        .padding(.vertical, 10)
                        .frame(maxWidth: .infinity, alignment: .leading)
                }
            }
        }
        .background(colors.backgroundCode)
    }

    private func detectedLanguage(for file: WorkspaceFile) -> SyntaxLanguage {
        SyntaxLanguage.detect(fileExtension: (file.path as NSString).pathExtension)
    }

    @ViewBuilder
    private func editorText(for file: WorkspaceFile) -> some View {
        // Same memoization as CodeBlockView — the editor re-highlighted the
        // whole open file on every panel re-render; a finished file's
        // content never changes, so it's a lookup after the first time.
        let highlighted = RenderCache.shared.value("ws|\(file.path)|\(colors == .dark)|\(file.content)", store: file.isComplete) {
            SyntaxHighlighter.highlight(file.content, language: detectedLanguage(for: file), colors: colors)
        }
        if !file.isComplete, viewModel.isGenerating {
            TimelineView(.periodic(from: .now, by: 0.5)) { context in
                let cursorVisible = Int(context.date.timeIntervalSince1970 * 2) % 2 == 0
                (Text(highlighted)
                    + Text("▎").foregroundColor(colors.textPrimary.opacity(cursorVisible ? 0.95 : 0.2)))
            }
        } else {
            Text(highlighted)
        }
    }

    private func lineNumbers(for file: WorkspaceFile) -> String {
        (1...max(file.lineCount, 1)).map(String.init).joined(separator: "\n")
    }

    // MARK: - Preview mode

    private var previewBody: some View {
        VStack(spacing: 0) {
            HStack(spacing: 8) {
                Image(systemName: "globe")
                    .font(.system(size: 11))
                    .foregroundStyle(colors.textTertiary)
                Text(htmlEntryFile?.path ?? "")
                    .font(.system(size: 11, design: .monospaced))
                    .foregroundStyle(colors.textSecondary)
                    .lineLimit(1)
                Spacer()
                PanelIconButton(systemName: "arrow.clockwise", help: "Reload preview") {
                    reloadPreview()
                }
            }
            .padding(.horizontal, 12)
            .padding(.vertical, 6)
            .background(colors.backgroundCodeHeader)

            Divider().overlay(colors.borderSubtle)

            WorkspacePreviewWebView(
                entryURL: previewEntryURL,
                rootURL: previewRootURL,
                reloadToken: previewReloadToken,
                onRuntimeError: { viewModel.recordPreviewRuntimeError($0) }
            )
            .background(Color.white)
        }
    }

    /// Writes the workspace's files into a throwaway temp folder so the
    /// preview loads real files — relative CSS/JS/image links between the
    /// generated files resolve exactly as they would on a real site.
    private func reloadPreview() {
        guard let entry = htmlEntryFile else { return }
        let key = viewModel.currentConversationId?.uuidString ?? "draft"
        let root = FileManager.default.temporaryDirectory
            .appendingPathComponent("EaonDesktopPreview", isDirectory: true)
            .appendingPathComponent(key, isDirectory: true)

        do {
            try? FileManager.default.removeItem(at: root)
            for file in files {
                let destination = root.appendingPathComponent(file.path)
                try FileManager.default.createDirectory(
                    at: destination.deletingLastPathComponent(),
                    withIntermediateDirectories: true
                )
                try file.content.write(to: destination, atomically: true, encoding: .utf8)
            }
            previewRootURL = root
            previewEntryURL = root.appendingPathComponent(entry.path)
            previewReloadToken += 1
        } catch {
            previewEntryURL = nil
        }
    }

    // MARK: - Status bar

    private var statusBar: some View {
        HStack(spacing: 10) {
            if isStreamingFiles {
                HStack(spacing: 5) {
                    StreamingDot()
                    Text("Generating…")
                }
            } else if runner.isRunning {
                HStack(spacing: 5) {
                    StreamingDot()
                    Text("Running…")
                }
            } else {
                HStack(spacing: 5) {
                    Circle()
                        .fill(colors.textTertiary)
                        .frame(width: 6, height: 6)
                    Text("Ready")
                }
            }

            if !runner.chunks.isEmpty || runner.isRunning {
                Button {
                    if mode == .preview { mode = .code }
                    showConsole.toggle()
                } label: {
                    HStack(spacing: 4) {
                        Image(systemName: "terminal")
                            .font(.system(size: 9))
                            .iconHoverEffect(for: "terminal")
                        Text("Console")
                    }
                    .foregroundStyle(showConsole && mode == .code ? colors.textPrimary : colors.textTertiary)
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .help(showConsole ? "Hide console" : "Show console")
            }

            Spacer()

            if let file = selectedFile {
                Text("\(file.lineCount) lines")
                if let language = file.language, !language.isEmpty {
                    Text(language.uppercased())
                }
            }
        }
        .font(.system(size: 10.5))
        .foregroundStyle(colors.textTertiary)
        .padding(.horizontal, 12)
        .padding(.vertical, 5)
    }

    // MARK: - Export

    private func exportProject() {
        let panel = NSOpenPanel()
        panel.canChooseFiles = false
        panel.canChooseDirectories = true
        panel.canCreateDirectories = true
        panel.prompt = "Save Here"
        panel.message = "Choose a folder — the workspace's \(files.count) file\(files.count == 1 ? "" : "s") will be saved into it."

        guard panel.runModal() == .OK, let directory = panel.url else { return }

        do {
            var firstWritten: URL?
            for file in files {
                let destination = directory.appendingPathComponent(file.path)
                try FileManager.default.createDirectory(
                    at: destination.deletingLastPathComponent(),
                    withIntermediateDirectories: true
                )
                try file.content.write(to: destination, atomically: true, encoding: .utf8)
                if firstWritten == nil { firstWritten = destination }
            }
            if let firstWritten {
                NSWorkspace.shared.activateFileViewerSelecting([firstWritten])
            }
            justExported = true
            DispatchQueue.main.asyncAfter(deadline: .now() + 2) { justExported = false }
        } catch {
            NSSound.beep()
        }
    }
}

// MARK: - Explorer row

private struct TreeRowButton: View {
    @Environment(\.themeColors) private var colors
    let node: WorkspaceTreeNode
    let depth: Int
    let isSelected: Bool
    let isCollapsed: Bool
    let isStreaming: Bool
    let action: () -> Void

    @State private var isHovered = false

    var body: some View {
        Button(action: action) {
            HStack(spacing: 5) {
                Spacer().frame(width: CGFloat(depth) * 12)

                if node.isFolder {
                    Image(systemName: "chevron.right")
                        .font(.system(size: 8, weight: .semibold))
                        .rotationEffect(.degrees(isCollapsed ? 0 : 90))
                        .iconHoverEffect(for: "chevron.right")
                        .foregroundStyle(colors.textTertiary)
                        .frame(width: 10)
                    Image(systemName: isCollapsed ? "folder" : "folder.fill")
                        .font(.system(size: 10))
                        .foregroundStyle(colors.textSecondary)
                } else {
                    Spacer().frame(width: 10)
                    Image(systemName: WorkspaceFileIcon.systemName(forPath: node.path))
                        .font(.system(size: 10))
                        .foregroundStyle(colors.textSecondary)
                }

                Text(node.name)
                    .font(.system(size: 12))
                    .foregroundStyle(isSelected ? colors.textPrimary : colors.textSecondary)
                    .lineLimit(1)

                if isStreaming {
                    StreamingDot()
                }

                Spacer(minLength: 0)
            }
            .padding(.horizontal, 5)
            .padding(.vertical, 3.5)
            .background(
                RoundedRectangle(cornerRadius: 5, style: .continuous)
                    .fill(colors.rowBackground(isSelected: isSelected, isHovered: isHovered))
            )
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .onHover { isHovered = $0 }
    }
}

// MARK: - Small shared bits

private struct PanelIconButton: View {
    @Environment(\.themeColors) private var colors
    let systemName: String
    var help: String = ""
    let action: () -> Void
    @State private var isHovered = false

    var body: some View {
        Button(action: action) {
            Image(systemName: systemName)
                .font(.system(size: 11, weight: .medium))
                .foregroundStyle(colors.textSecondary)
                .iconHoverEffect(for: systemName)
                .frame(width: 24, height: 24)
                .background(
                    RoundedRectangle(cornerRadius: 6, style: .continuous)
                        .fill(isHovered ? colors.backgroundHover : .clear)
                )
                .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .onHover { isHovered = $0 }
        .help(help)
    }
}

/// The small pulsing dot shown next to whatever the model is writing.
private struct StreamingDot: View {
    @Environment(\.themeColors) private var colors
    @State private var pulse = false

    var body: some View {
        Circle()
            .fill(colors.textPrimary)
            .frame(width: 5, height: 5)
            .opacity(pulse ? 0.25 : 0.9)
            .animation(.easeInOut(duration: 0.6).repeatForever(autoreverses: true), value: pulse)
            .onAppear { pulse = true }
    }
}

// MARK: - Preview web view

private struct WorkspacePreviewWebView: NSViewRepresentable {
    let entryURL: URL?
    let rootURL: URL?
    let reloadToken: Int
    var onRuntimeError: ((String) -> Void)? = nil

    private static let errorHandlerName = "aquaPreviewError"

    /// Injected into every previewed page: forwards JS runtime errors to the
    /// app so the agent can see (and fix) its own website bugs.
    private static let errorReporterScript = """
    window.addEventListener('error', function (e) {
        try { window.webkit.messageHandlers.aquaPreviewError.postMessage(
            (e.message || 'Script error') + ' @ ' + ((e.filename || '?').split('/').pop()) + ':' + (e.lineno || 0)); } catch (_) {}
    });
    window.addEventListener('unhandledrejection', function (e) {
        try { window.webkit.messageHandlers.aquaPreviewError.postMessage(
            'Unhandled promise rejection: ' + e.reason); } catch (_) {}
    });
    """

    final class Coordinator: NSObject, WKScriptMessageHandler {
        var lastLoadedToken = -1
        var onRuntimeError: ((String) -> Void)?

        func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) {
            guard message.name == WorkspacePreviewWebView.errorHandlerName,
                  let text = message.body as? String else { return }
            onRuntimeError?(text)
        }
    }

    func makeCoordinator() -> Coordinator { Coordinator() }

    func makeNSView(context: Context) -> WKWebView {
        let configuration = WKWebViewConfiguration()
        configuration.userContentController.addUserScript(
            WKUserScript(source: Self.errorReporterScript, injectionTime: .atDocumentStart, forMainFrameOnly: false)
        )
        configuration.userContentController.add(context.coordinator, name: Self.errorHandlerName)
        return WKWebView(frame: .zero, configuration: configuration)
    }

    func updateNSView(_ webView: WKWebView, context: Context) {
        context.coordinator.onRuntimeError = onRuntimeError
        guard context.coordinator.lastLoadedToken != reloadToken,
              let entryURL, let rootURL else { return }
        context.coordinator.lastLoadedToken = reloadToken
        webView.loadFileURL(entryURL, allowingReadAccessTo: rootURL)
    }

    static func dismantleNSView(_ webView: WKWebView, coordinator: Coordinator) {
        webView.configuration.userContentController.removeScriptMessageHandler(forName: errorHandlerName)
    }
}
