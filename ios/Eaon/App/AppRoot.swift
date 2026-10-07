import AuthenticationServices
import SwiftUI

/// The whole app: the landing screen until someone comes in (Apple, GitHub,
/// or without an account), then the app proper.
struct AppRoot: View {
    private let model = AppModel.shared

    @AppStorage(AppTheme.storageKey) private var theme = AppTheme.system
    @Environment(\.scenePhase) private var scenePhase

    var body: some View {
        @Bindable var auth = model.auth
        @Bindable var navigator = model.navigator
        let session = model.session
        ZStack {
            if session.isEntered {
                AppShell()
                    .transition(.opacity.combined(with: .scale(scale: 0.97)))
            } else {
                LandingView(busy: auth.busy, onChoose: { auth.choose($0) })
                    .transition(.opacity)
            }
        }
        .animation(.smooth(duration: 0.6), value: session.isEntered)
        .overlay(alignment: .top) { banner }
        .animation(.spring(response: 0.45, dampingFraction: 0.82), value: auth.issue)
        .sheet(item: $auth.githubCode, onDismiss: { model.auth.cancelGitHub() }) { code in
            GitHubCodeSheet(code: code, onCancel: { model.auth.cancelGitHub() })
        }
        .environment(model.session)
        .environment(model.auth)
        .environment(model.catalog)
        .environment(model.store)
        .environment(model.chat)
        .environment(model.agents)
        .environment(model.navigator)
        .sheet(isPresented: $navigator.showsConnectMac) {
            ConnectMacView()
                .environment(model.catalog)
                .environment(model.agents)
                .environment(model.navigator)
        }
        .onOpenURL { url in
            // eaon://pair?…, from the QR code or a link a Mac shared.
            guard let link = PairingLink.parse(url) else { return }
            model.navigator.pairingLink = link
            model.navigator.showsConnectMac = true
        }
        .preferredColorScheme(theme.colorScheme)
        .task {
            #if DEBUG
            await DebugLaunch.afterLaunch(auth: model.auth, navigator: model.navigator, chat: model.chat, agents: model.agents, catalog: model.catalog)
            #endif
            #if DEBUG
            // A made-up Apple account would fail Apple's check, as it should.
            let checksApple = !DebugLaunch.has("-demoAccount")
            #else
            let checksApple = true
            #endif
            if checksApple {
                await model.session.validate(appleCredentialIsValid: AppleSignIn.credentialIsValid)
            }
            await model.catalog.refreshMac()
        }
        .onReceive(NotificationCenter.default.publisher(for: ASAuthorizationAppleIDProvider.credentialRevokedNotification)) { _ in
            if model.session.account?.provider == .apple { model.session.signOut() }
        }
        .onChange(of: scenePhase) { _, phase in
            switch phase {
            case .active:
                model.catalog.refreshOnDevice()
                Task { await model.catalog.refreshMac() }
                model.agents.phone.tick()
            case .background:
                model.store.flush()
                model.agents.phone.flush()
                keepTurnsRunning()
            default:
                break
            }
        }
    }

    /// A sign-in problem, over whatever's showing.
    @ViewBuilder private var banner: some View {
        if !model.session.isEntered, let issue = model.auth.issue {
            Callout(kind: .error, title: issue.title, message: issue.message, detail: issue.detail, onDismiss: { model.auth.dismissIssue() })
                .padding(.horizontal, 16)
                .padding(.top, 8)
                .transition(.move(edge: .top).combined(with: .opacity))
        }
    }

    /// iOS gives an app a short time after it's left; a turn that's mid-way gets it, so it can finish and be saved.
    private func keepTurnsRunning() {
        let phone = model.agents.phone
        guard phone.hasRunningTurns else { return }
        let background = BackgroundTask()
        background.begin()
        Task { @MainActor in
            while phone.hasRunningTurns, UIApplication.shared.backgroundTimeRemaining > 3 {
                try? await Task.sleep(for: .seconds(1))
            }
            phone.flush()
            background.end()
        }
    }
}

/// A grant of extra time from iOS, ended once, whichever comes first: the work or the deadline.
@MainActor
private final class BackgroundTask {
    private var identifier = UIBackgroundTaskIdentifier.invalid

    func begin() {
        identifier = UIApplication.shared.beginBackgroundTask(withName: "Agent turn") { [weak self] in
            Task { @MainActor in self?.end() }
        }
    }

    func end() {
        guard identifier != .invalid else { return }
        UIApplication.shared.endBackgroundTask(identifier)
        identifier = .invalid
    }
}
