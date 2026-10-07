import Foundation

/// A code to type in at github.com/login/device.
struct GitHubDeviceCode: Equatable, Sendable, Identifiable {
    var userCode: String
    var deviceCode: String
    var verificationURL: URL
    var expiresAt: Date
    /// Seconds between asking GitHub whether it's been approved.
    var interval: TimeInterval

    var id: String { deviceCode }
}

/// GitHub's OAuth device flow (RFC 8628).
///
/// It's the way in that needs no server and no client secret, so a build with
/// no backend can still say "Continue with GitHub": the app asks GitHub for a
/// code, the person types it in at github.com/login/device and approves, and
/// the app, which has been asking meanwhile, is handed a token. The token is
/// used once, to read the profile, and isn't kept: Eaon only needs to know who
/// you are, and asks for no more than `read:user`.
///
/// Needs an OAuth App with "Enable Device Flow" on; its client ID goes in the
/// build setting `EAON_GITHUB_CLIENT_ID`.
struct GitHubDeviceFlow: Sendable {
    var clientID: String
    var session: URLSession = .shared
    var now: @Sendable () -> Date = { Date() }
    /// Waits between polls. Tests replace it so they don't.
    var sleep: @Sendable (TimeInterval) async throws -> Void = { seconds in
        try await Task.sleep(for: .seconds(seconds))
    }

    /// The client ID this build was configured with, if it was.
    static var configuredClientID: String? {
        #if DEBUG
        // `-githubClientID none` pretends there isn't one, `-githubClientID <id>` swaps it.
        if let override = DebugLaunch.value(after: "-githubClientID") {
            return clientID(from: override == "none" ? nil : override)
        }
        #endif
        return clientID(from: Bundle.main.object(forInfoDictionaryKey: "EaonGitHubClientID") as? String)
    }

    /// A build setting that wasn't set comes through as "" or as the literal "$(EAON_GITHUB_CLIENT_ID)".
    static func clientID(from value: String?) -> String? {
        let value = value?.trimmingCharacters(in: .whitespacesAndNewlines)
        guard let value, !value.isEmpty, !value.hasPrefix("$(") else { return nil }
        return value
    }

    private static let codeURL = URL(string: "https://github.com/login/device/code")!
    private static let tokenURL = URL(string: "https://github.com/login/oauth/access_token")!
    private static let userURL = URL(string: "https://api.github.com/user")!

    // MARK: Step 1: the code

    func requestCode() async throws -> GitHubDeviceCode {
        let data = try await post(Self.codeURL, form: ["client_id": clientID, "scope": "read:user"])
        let reply = try decode(CodeReply.self, from: data)
        if let error = reply.error {
            // GitHub answers a client ID without Device Flow switched on with
            // "device_flow_disabled", and an unknown one with "incorrect_client_credentials".
            if error == "device_flow_disabled" {
                throw AuthError.failed("Device Flow is off for this GitHub OAuth App. Turn it on in the app's settings on GitHub.")
            }
            throw AuthError.failed(reply.errorDescription ?? "GitHub refused the sign-in request.")
        }
        guard let deviceCode = reply.deviceCode, let userCode = reply.userCode,
              let uri = reply.verificationURI.flatMap(URL.init(string:)) else {
            throw AuthError.failed("GitHub's answer wasn't what Eaon expected.")
        }
        return GitHubDeviceCode(
            userCode: userCode,
            deviceCode: deviceCode,
            verificationURL: uri,
            expiresAt: now().addingTimeInterval(TimeInterval(reply.expiresIn ?? 900)),
            interval: TimeInterval(max(reply.interval ?? 5, 1))
        )
    }

    // MARK: Step 2: wait for the approval, then read who it was

    func awaitAccount(for code: GitHubDeviceCode) async throws -> Account {
        var interval = code.interval
        while true {
            try Task.checkCancellation()
            try await sleep(interval)
            try Task.checkCancellation()
            if now() >= code.expiresAt { throw AuthError.expired }

            let data = try await post(Self.tokenURL, form: [
                "client_id": clientID,
                "device_code": code.deviceCode,
                "grant_type": "urn:ietf:params:oauth:grant-type:device_code"
            ])
            let reply = try decode(TokenReply.self, from: data)
            if let token = reply.accessToken { return try await profile(token: token) }

            switch reply.error {
            case "authorization_pending": continue
            // GitHub asks for five more seconds between polls.
            case "slow_down": interval = (reply.interval.map(TimeInterval.init) ?? interval + 5)
            case "expired_token": throw AuthError.expired
            case "access_denied": throw AuthError.denied
            default: throw AuthError.failed(reply.errorDescription ?? "GitHub refused the sign-in.")
            }
        }
    }

    private func profile(token: String) async throws -> Account {
        var request = URLRequest(url: Self.userURL)
        request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        request.setValue("application/vnd.github+json", forHTTPHeaderField: "Accept")
        request.setValue("2022-11-28", forHTTPHeaderField: "X-GitHub-Api-Version")
        let (data, response) = try await send(request)
        guard (response as? HTTPURLResponse)?.statusCode == 200 else {
            throw AuthError.failed("GitHub wouldn't share your profile.")
        }
        let user = try decode(UserReply.self, from: data)
        return Account(
            provider: .github,
            id: String(user.id),
            name: user.name,
            email: user.email,
            handle: user.login,
            avatarURL: user.avatarURL.flatMap(URL.init(string:))
        )
    }

    // MARK: Plumbing

    private func post(_ url: URL, form: [String: String]) async throws -> Data {
        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.timeoutInterval = 20
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        request.setValue("application/x-www-form-urlencoded", forHTTPHeaderField: "Content-Type")
        var components = URLComponents()
        components.queryItems = form.sorted(by: { $0.key < $1.key }).map { URLQueryItem(name: $0.key, value: $0.value) }
        request.httpBody = components.percentEncodedQuery.map { Data($0.utf8) }
        let (data, response) = try await send(request)
        if let http = response as? HTTPURLResponse, http.statusCode >= 500 {
            throw AuthError.failed("GitHub is having trouble right now.")
        }
        return data
    }

    private func send(_ request: URLRequest) async throws -> (Data, URLResponse) {
        do {
            return try await session.data(for: request)
        } catch let error as URLError where error.code == .cancelled {
            throw CancellationError()
        } catch is URLError {
            throw AuthError.offline
        }
    }

    private func decode<T: Decodable>(_ type: T.Type, from data: Data) throws -> T {
        do {
            return try JSONDecoder().decode(type, from: data)
        } catch {
            throw AuthError.failed("GitHub's answer wasn't what Eaon expected.")
        }
    }

    private struct CodeReply: Decodable {
        var deviceCode: String?
        var userCode: String?
        var verificationURI: String?
        var expiresIn: Int?
        var interval: Int?
        var error: String?
        var errorDescription: String?

        enum CodingKeys: String, CodingKey {
            case deviceCode = "device_code"
            case userCode = "user_code"
            case verificationURI = "verification_uri"
            case expiresIn = "expires_in"
            case interval
            case error
            case errorDescription = "error_description"
        }
    }

    private struct TokenReply: Decodable {
        var accessToken: String?
        var error: String?
        var errorDescription: String?
        var interval: Int?

        enum CodingKeys: String, CodingKey {
            case accessToken = "access_token"
            case error
            case errorDescription = "error_description"
            case interval
        }
    }

    private struct UserReply: Decodable {
        var id: Int
        var login: String
        var name: String?
        var email: String?
        var avatarURL: String?

        enum CodingKeys: String, CodingKey {
            case id, login, name, email
            case avatarURL = "avatar_url"
        }
    }
}
