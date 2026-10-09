import XCTest
@testable import Eaon

final class GitHubDeviceFlowTests: XCTestCase {
    private let codeURL = "https://github.com/login/device/code"
    private let tokenURL = "https://github.com/login/oauth/access_token"
    private let userURL = "https://api.github.com/user"

    override func setUp() { StubProtocol.reset() }
    override func tearDown() { StubProtocol.reset() }

    private func flow(sleeps: Recorder<Double> = Recorder(), now: @escaping @Sendable () -> Date = { Date() }) -> GitHubDeviceFlow {
        GitHubDeviceFlow(clientID: "Iv1.test", session: StubProtocol.session(), now: now, sleep: { sleeps.add($0) })
    }

    private let code = GitHubDeviceCode(
        userCode: "WDJB-MJHT",
        deviceCode: "dev123",
        verificationURL: URL(string: "https://github.com/login/device")!,
        expiresAt: Date().addingTimeInterval(900),
        interval: 5
    )

    func testRequestCodeAsksForReadUserAndParsesTheCode() async throws {
        StubProtocol.handler = { request in
            StubProtocol.respond(request.url!, json: [
                "device_code": "dev123", "user_code": "WDJB-MJHT",
                "verification_uri": "https://github.com/login/device", "expires_in": 900, "interval": 5
            ])
        }
        let result = try await flow().requestCode()
        XCTAssertEqual(result.userCode, "WDJB-MJHT")
        XCTAssertEqual(result.deviceCode, "dev123")
        XCTAssertEqual(result.interval, 5)
        XCTAssertEqual(result.verificationURL.absoluteString, "https://github.com/login/device")

        let request = try XCTUnwrap(StubProtocol.recorded.first)
        XCTAssertEqual(request.url?.absoluteString, codeURL)
        XCTAssertEqual(request.value(forHTTPHeaderField: "Accept"), "application/json")
        XCTAssertTrue(request.bodyString.contains("client_id=Iv1.test"))
        XCTAssertTrue(request.bodyString.contains("scope=read%3Auser") || request.bodyString.contains("scope=read:user"))
    }

    func testDeviceFlowSwitchedOffSaysSo() async {
        StubProtocol.handler = { request in
            StubProtocol.respond(request.url!, json: ["error": "device_flow_disabled", "error_description": "Device Flow must be explicitly enabled for this App"])
        }
        do {
            _ = try await flow().requestCode()
            XCTFail("expected an error")
        } catch let error as AuthError {
            guard case .failed(let message) = error else { return XCTFail("\(error)") }
            XCTAssertTrue(message.contains("Device Flow"))
        } catch {
            XCTFail("\(error)")
        }
    }

    func testWaitsThroughPendingAndSlowDownThenReadsTheProfile() async throws {
        let replies: [String] = [
            #"{"error":"authorization_pending"}"#,
            #"{"error":"slow_down","interval":10}"#,
            #"{"error":"authorization_pending"}"#,
            #"{"access_token":"gho_secret","token_type":"bearer"}"#
        ]
        let next = Recorder<Int>()

        StubProtocol.handler = { [self] request in
            let url = request.url!.absoluteString
            if url == tokenURL {
                let index = next.values.count
                next.add(index)
                return StubProtocol.respond(request.url!, body: Data(replies[index].utf8))
            }
            XCTAssertEqual(url, userURL)
            XCTAssertEqual(request.value(forHTTPHeaderField: "Authorization"), "Bearer gho_secret")
            return StubProtocol.respond(request.url!, json: [
                "id": 4242, "login": "alexrivera", "name": "Alex Rivera", "email": NSNull(),
                "avatar_url": "https://avatars.githubusercontent.com/u/4242"
            ])
        }

        let sleeps = Recorder<Double>()
        let account = try await flow(sleeps: sleeps).awaitAccount(for: code)

        XCTAssertEqual(account.provider, .github)
        XCTAssertEqual(account.id, "4242")
        XCTAssertEqual(account.handle, "alexrivera")
        XCTAssertEqual(account.name, "Alex Rivera")
        XCTAssertNil(account.email)
        XCTAssertEqual(account.avatarURL?.absoluteString, "https://avatars.githubusercontent.com/u/4242")
        // Five seconds, then (after slow_down) ten, then ten again.
        XCTAssertEqual(sleeps.values, [5, 5, 10, 10])
        XCTAssertEqual(next.values.count, 4)
    }

    func testDeniedAndExpiredAreTheirOwnErrors() async {
        for (reply, expected) in [("access_denied", AuthError.denied), ("expired_token", AuthError.expired)] {
            StubProtocol.handler = { request in StubProtocol.respond(request.url!, json: ["error": reply]) }
            do {
                _ = try await flow().awaitAccount(for: code)
                XCTFail("expected \(reply) to throw")
            } catch {
                XCTAssertEqual(error as? AuthError, expected)
            }
        }
    }

    func testACodeThatRanOutIsExpiredWithoutAskingGitHub() async {
        StubProtocol.handler = { request in StubProtocol.respond(request.url!, json: ["error": "authorization_pending"]) }
        let late = Date().addingTimeInterval(3600)
        do {
            _ = try await flow(now: { late }).awaitAccount(for: code)
            XCTFail("expected expiry")
        } catch {
            XCTAssertEqual(error as? AuthError, .expired)
        }
        XCTAssertTrue(StubProtocol.recorded.isEmpty)
    }

    func testNoNetworkIsOffline() async {
        StubProtocol.handler = { _ in throw URLError(.notConnectedToInternet) }
        do {
            _ = try await flow().requestCode()
            XCTFail("expected an error")
        } catch {
            XCTAssertEqual(error as? AuthError, .offline)
        }
    }

    func testCancellingStopsThePolling() async {
        StubProtocol.handler = { request in StubProtocol.respond(request.url!, json: ["error": "authorization_pending"]) }
        let flow = GitHubDeviceFlow(clientID: "x", session: StubProtocol.session(), sleep: { _ in try await Task.sleep(for: .milliseconds(20)) })
        let code = self.code
        let task = Task { try await flow.awaitAccount(for: code) }
        try? await Task.sleep(for: .milliseconds(80))
        task.cancel()
        do {
            _ = try await task.value
            XCTFail("expected cancellation")
        } catch {
            XCTAssertTrue(error is CancellationError, "\(error)")
        }
    }

    func testClientIDsFromTheBuildSetting() {
        XCTAssertEqual(GitHubDeviceFlow.clientID(from: " Ov23abc "), "Ov23abc")
        // Not set: empty, nothing, or the placeholder Xcode leaves when the setting is missing.
        XCTAssertNil(GitHubDeviceFlow.clientID(from: ""))
        XCTAssertNil(GitHubDeviceFlow.clientID(from: "   "))
        XCTAssertNil(GitHubDeviceFlow.clientID(from: nil))
        XCTAssertNil(GitHubDeviceFlow.clientID(from: "$(EAON_GITHUB_CLIENT_ID)"))
    }

    func testThisBuildKnowsEaonsClientID() {
        // The OAuth App "Eaon" under eaonlabs.
        XCTAssertEqual(GitHubDeviceFlow.configuredClientID, "Ov23liGgk4qIW9VPTkR1")
    }
}
