import AuthenticationServices
import UIKit

/// "Continue with Apple", through the system sheet.
///
/// Apple sends a person's name and email only the first time they approve an
/// app; `SessionStore.signIn` keeps what arrives so later sign-ins still have it.
@MainActor
final class AppleSignIn: NSObject {
    private var continuation: CheckedContinuation<ASAuthorizationAppleIDCredential, Error>?
    private var controller: ASAuthorizationController?

    func signIn() async throws -> Account {
        let request = ASAuthorizationAppleIDProvider().createRequest()
        request.requestedScopes = [.fullName, .email]

        let credential: ASAuthorizationAppleIDCredential = try await withCheckedThrowingContinuation { continuation in
            self.continuation = continuation
            let controller = ASAuthorizationController(authorizationRequests: [request])
            controller.delegate = self
            controller.presentationContextProvider = self
            self.controller = controller
            controller.performRequests()
        }
        controller = nil

        var name: String?
        if let components = credential.fullName {
            let formatted = PersonNameComponentsFormatter().string(from: components)
            name = formatted.isEmpty ? nil : formatted
        }
        return Account(provider: .apple, id: credential.user, name: name, email: credential.email, handle: nil, avatarURL: nil)
    }

    /// Whether Apple still lets this app know the person. False once they stop
    /// using Apple Account with Eaon from their Apple Account settings.
    static func credentialIsValid(userID: String) async -> Bool {
        await withCheckedContinuation { continuation in
            ASAuthorizationAppleIDProvider().getCredentialState(forUserID: userID) { state, error in
                // If Apple can't say (no network, say), the person stays signed in.
                if error != nil {
                    continuation.resume(returning: true)
                    return
                }
                switch state {
                case .revoked, .notFound: continuation.resume(returning: false)
                default: continuation.resume(returning: true)
                }
            }
        }
    }

    static func map(_ error: Error) -> AuthError {
        let ns = error as NSError
        if ns.domain == ASAuthorizationError.errorDomain {
            switch ASAuthorizationError.Code(rawValue: ns.code) {
            case .canceled: return .cancelled
            case .notHandled, .invalidResponse, .failed, .unknown, .notInteractive:
                return .failed("Apple couldn't sign you in. Check that you're signed in to iCloud on this iPhone.")
            default: break
            }
        }
        if (error as? URLError) != nil { return .offline }
        return .failed("Apple couldn't sign you in.")
    }
}

extension AppleSignIn: ASAuthorizationControllerDelegate {
    func authorizationController(controller: ASAuthorizationController, didCompleteWithAuthorization authorization: ASAuthorization) {
        guard let credential = authorization.credential as? ASAuthorizationAppleIDCredential else {
            continuation?.resume(throwing: AuthError.failed("Apple sent something Eaon didn't expect."))
            continuation = nil
            return
        }
        continuation?.resume(returning: credential)
        continuation = nil
    }

    func authorizationController(controller: ASAuthorizationController, didCompleteWithError error: Error) {
        continuation?.resume(throwing: error)
        continuation = nil
    }
}

extension AppleSignIn: ASAuthorizationControllerPresentationContextProviding {
    func presentationAnchor(for controller: ASAuthorizationController) -> ASPresentationAnchor {
        let scenes = UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }
        let window = scenes.first(where: { $0.activationState == .foregroundActive })?.keyWindow
            ?? scenes.first?.windows.first
        return window ?? ASPresentationAnchor()
    }
}
