import SwiftUI

/// Eaon Code's home surface — phase one of the "both, phased" plan: a real,
/// embedded terminal running the already-built `eaon-cli`, framed with the
/// same top-bar chrome (sidebar toggle) every other mode uses. Native
/// panels (file tree, test runner, deploy-to-URL) are a later phase; this
/// intentionally does the minimum to make the CLI usable inside the app
/// rather than half-building panels around an unfinished terminal.
struct EaonCodeHomeView: View {
    @Environment(\.themeColors) private var colors
    var isSidebarCollapsed: Bool = false
    var onExpandSidebar: () -> Void = {}
    /// Leaves Code and returns to the normal chat surface — the embedded
    /// terminal captures the keyboard (Esc, ⌘ combos are all meaningful to
    /// the CLI), so this needs a visible control in the chrome above it,
    /// not a shortcut the terminal would swallow.
    var onExit: () -> Void = {}

    /// Resolved once per appearance of this view, not per keystroke — a
    /// missing `node`/CLI build doesn't change while the pane is open.
    @State private var launch: EaonCLILauncher.Launch?
    @State private var didResolveLaunch = false

    var body: some View {
        VStack(spacing: 0) {
            topBar
            Group {
                if didResolveLaunch, launch == nil {
                    missingCLIState
                } else {
                    EmbeddedTerminalView(launch: launch)
                }
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)
        }
        .background(Color.black)
        .onAppear {
            guard !didResolveLaunch else { return }
            launch = EaonCLILauncher.resolve()
            didResolveLaunch = true
        }
    }

    private var topBar: some View {
        HStack(spacing: 8) {
            if isSidebarCollapsed {
                Spacer().frame(width: 80)
                TopBarIconButton(systemName: "sidebar.left", label: nil) {
                    onExpandSidebar()
                }
                .help("Show sidebar")
            }

            HStack(spacing: 6) {
                Image(systemName: "terminal.fill")
                    .font(.system(size: 12, weight: .semibold))
                Text("Eaon Code")
                    .font(AppFont.mono(14, weight: .semibold))
            }
            .foregroundStyle(colors.textSecondary)

            Spacer(minLength: 0)

            TopBarIconButton(systemName: "xmark", label: "Exit Code") {
                onExit()
            }
            .help("Leave Code and return to Chat")
        }
        .padding(.horizontal, 14)
        .frame(height: 50)
        .padding(.top, 10)
        .background(colors.backgroundPrimary)
    }

    private var missingCLIState: some View {
        VStack(spacing: 10) {
            Image(systemName: "terminal")
                .font(.system(size: 30, weight: .semibold))
                .foregroundStyle(.white.opacity(0.6))
            Text("Couldn't find eaon-cli")
                .font(AppFont.mono(18, weight: .bold))
                .foregroundStyle(.white)
            Text("This needs a Node.js install and a built eaon-cli (dist/cli.js). Run `npm run build` in the eaon-cli project first.")
                .font(AppFont.sans(14))
                .foregroundStyle(.white.opacity(0.6))
                .multilineTextAlignment(.center)
                .frame(maxWidth: 380)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }
}
