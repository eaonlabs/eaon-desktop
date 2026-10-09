import Foundation
import Observation

/// Something to tell the person about signing in.
struct AuthIssue: Identifiable, Equatable {
    let id = UUID()
    var title: String
    var message: String?
    var detail: String?

    init(title: String, message: String? = nil, detail: String? = nil) {
        self.title = title
        self.message = message
        self.detail = detail
    }

    init(_ error: AuthError) {
        title = error.errorDescription ?? "Couldn't sign in."
        message = error.recovery
        detail = nil
    }
}

/// Runs the three ways in: Apple's sheet, GitHub's device flow, or none.
///
/// The landing screen's buttons call `choose`, and Settings uses the same
/// functions to sign a guest in later. `busy` says which button is working;
/// `githubCode` is the code on its sheet while GitHub is being waited for.
@MainActor
@Observable
final class AuthController {
    var busy: EntryChoice?
    var issue: AuthIssue?
    var githubCode: GitHubDeviceCode?

    private let session: SessionStore
    private let apple = AppleSignIn()
    private var githubTask: Task<Void, Never>?
    private var dismissal: Task<Void, Never>?

    init(session: SessionStore) {
        self.session = session
    }

    func choose(_ choice: EntryChoice) {
        guard busy == nil, githubCode == nil else { return }
        dismissIssue()
        switch choice {
        case .guest:
            Haptic.tap()
            session.continueAsGuest()
        case .apple:
            Haptic.tap()
            Task { await signInWithApple() }
        case .github:
            Haptic.tap()
            Task { await startGitHub() }
        }
    }

    func signInWithApple() async {
        busy = .apple
        defer { busy = nil }
        do {
            let account = try await apple.signIn()
            session.signIn(account)
            Haptic.success()
        } catch {
            present(AppleSignIn.map(error))
        }
    }

    func startGitHub() async {
        guard let clientID = GitHubDeviceFlow.configuredClientID else {
            Haptic.failure()
            issue = AuthIssue(
                title: AuthError.notConfigured.errorDescription ?? "GitHub isn't set up.",
                message: "You can still continue with Apple, or without an account.",
                detail: "Register a GitHub OAuth App, turn on Device Flow for it, and build with EAON_GITHUB_CLIENT_ID=<its client ID>."
            )
            scheduleDismissal()
            return
        }
        busy = .github
        let flow = GitHubDeviceFlow(clientID: clientID)
        do {
            let code = try await flow.requestCode()
            busy = nil
            githubCode = code
            wait(for: code, with: flow)
        } catch {
            busy = nil
            present(error)
        }
    }

    /// Closes the code sheet and stops asking GitHub.
    func cancelGitHub() {
        githubTask?.cancel()
        githubTask = nil
        githubCode = nil
    }

    func dismissIssue() {
        dismissal?.cancel()
        issue = nil
    }

    #if DEBUG
    /// Shows a sign-in problem, for looking at it.
    func showDemoIssue() {
        issue = AuthIssue(
            title: AuthError.notConfigured.errorDescription ?? "",
            message: "You can still continue with Apple, or without an account.",
            detail: "Register a GitHub OAuth App, turn on Device Flow for it, and build with EAON_GITHUB_CLIENT_ID=<its client ID>."
        )
    }

    /// Shows the code sheet with a made-up code and no polling, for looking at it.
    func showDemoGitHubCode() {
        githubCode = GitHubDeviceCode(
            userCode: "WDJB-MJHT",
            deviceCode: "demo",
            verificationURL: URL(string: "https://github.com/login/device")!,
            expiresAt: Date().addingTimeInterval(14 * 60 + 41),
            interval: 5
        )
    }
    #endif

    private func wait(for code: GitHubDeviceCode, with flow: GitHubDeviceFlow) {
        githubTask?.cancel()
        githubTask = Task { [weak self] in
            do {
                let account = try await flow.awaitAccount(for: code)
                guard let self, !Task.isCancelled else { return }
                self.githubCode = nil
                self.githubTask = nil
                self.session.signIn(account)
                Haptic.success()
            } catch {
                guard let self, !Task.isCancelled else { return }
                self.githubCode = nil
                self.githubTask = nil
                self.present(error)
            }
        }
    }

    private func present(_ error: Error) {
        if error is CancellationError { return }
        let authError = error as? AuthError ?? .failed(error.localizedDescription)
        if authError == .cancelled { return }
        Haptic.failure()
        issue = AuthIssue(authError)
        scheduleDismissal()
    }

    /// An error stays up long enough to read, then goes.
    private func scheduleDismissal() {
        dismissal?.cancel()
        dismissal = Task { [weak self] in
            try? await Task.sleep(for: .seconds(9))
            guard !Task.isCancelled else { return }
            self?.issue = nil
        }
    }
}
