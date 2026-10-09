import Foundation

/// Who is signed in. Kept on this iPhone only, in the Keychain.
struct Account: Codable, Equatable, Sendable, Identifiable {
    enum Provider: String, Codable, Sendable {
        case apple
        case github

        var title: String {
            switch self {
            case .apple: "Apple"
            case .github: "GitHub"
            }
        }
    }

    var provider: Provider
    /// Apple's user identifier, or GitHub's numeric id.
    var id: String
    var name: String?
    var email: String?
    /// The GitHub login.
    var handle: String?
    var avatarURL: URL?

    var displayName: String {
        for candidate in [name, handle] {
            if let candidate, !candidate.trimmingCharacters(in: .whitespaces).isEmpty { return candidate }
        }
        return provider == .apple ? "Apple account" : "GitHub account"
    }

    /// For greetings: "Alex", not "Alex Rivera".
    var firstName: String? {
        if let name, let first = name.split(separator: " ").first { return String(first) }
        return handle
    }

    var initials: String {
        let words = (name ?? handle ?? "").split(whereSeparator: { $0 == " " || $0 == "-" || $0 == "_" })
        let letters = words.prefix(2).compactMap(\.first).map { String($0).uppercased() }.joined()
        return letters.isEmpty ? "E" : letters
    }

    /// The line under the name: the handle for GitHub, the email for Apple
    /// (unless it's Apple's relay address, which says nothing to the person).
    var detail: String? {
        if provider == .github, let handle { return "@\(handle)" }
        guard let email, !email.isEmpty else { return nil }
        return email.hasSuffix("@privaterelay.appleid.com") ? "Email hidden by Apple" : email
    }
}

/// Why signing in didn't happen.
enum AuthError: LocalizedError, Equatable {
    /// The person closed the sheet. Not worth an error.
    case cancelled
    case notConfigured
    case denied
    case expired
    case offline
    case failed(String)

    var errorDescription: String? {
        switch self {
        case .cancelled: nil
        case .notConfigured: "GitHub sign-in isn't set up in this build."
        case .denied: "GitHub didn't get your approval."
        case .expired: "That code ran out before it was used."
        case .offline: "Couldn't reach the internet."
        case .failed(let message): message
        }
    }

    var recovery: String? {
        switch self {
        case .cancelled: nil
        case .notConfigured: "Add your GitHub OAuth App's client ID as EAON_GITHUB_CLIENT_ID and turn on Device Flow for it."
        case .denied: "Try again and choose Authorize on GitHub."
        case .expired: "Start again to get a new code."
        case .offline: "Check your connection and try again."
        case .failed: "Try again in a moment."
        }
    }
}
