import Foundation
import Network

/// The link between Eaon and the Eaon browser extension.
///
/// ## Why an extension, when AppleScript already "works"
///
/// Driving a browser through AppleScript runs into two walls that no amount of
/// better code gets past:
///
/// 1. Reading page text, clicking, or filling a form needs the browser's
///    hidden **"Allow JavaScript from Apple Events"** developer setting. It
///    can't be enabled programmatically, and almost nobody has it on.
/// 2. Scrolling without that setting means synthesising key events, which
///    needs **Accessibility** permission — and still only scrolls whatever
///    happens to have focus.
///
/// An extension has neither problem. It already lives inside the page with
/// full DOM access, so clicking a button is a real DOM click rather than a
/// keystroke aimed at a guess, and it needs no macOS permission at all.
///
/// ## How they talk
///
/// The extension long-polls `GET /poll`; Eaon holds that request open until it
/// has something to do (or ~25s passes), then answers with one command. The
/// extension runs it and POSTs the outcome to `/result`.
///
/// Long-polling rather than WebSockets is deliberate. A WebSocket over
/// `NWConnection` means hand-rolling the upgrade handshake plus frame
/// masking/fragmentation — a few hundred lines of protocol code whose failures
/// are silent and awkward to debug. Long-polling reuses the plain HTTP parsing
/// this app already does, is trivially inspectable with `curl`, and for
/// browser automation the latency difference is irrelevant: commands are
/// human-paced, not high-frequency.
///
/// ## Security
///
/// The listener binds to loopback only, so nothing off this machine can reach
/// it. That alone isn't enough: any web page your browser loads can also issue
/// requests to `127.0.0.1`. It couldn't *read* the replies (CORS), but it
/// could still *send* commands, which is quite enough to matter when the
/// commands drive your logged-in browser. So every request must carry a
/// pairing token generated fresh at launch and shown in Settings; requests
/// without it are refused before anything is queued.
@MainActor
@Observable
final class BrowserBridge {
    static let shared = BrowserBridge()

    /// Ports to try, in order. A single fixed port looked simpler but fails
    /// badly: anything else already bound to it (a stray `python -m
    /// http.server`, another dev server) means the listener silently doesn't
    /// start and every browser command fails with no clue why — hit exactly
    /// that during testing. The extension walks the same list, so a collision
    /// costs one extra probe rather than the whole feature.
    static let candidatePorts: [UInt16] = [8823, 8824, 8825, 8826, 8827]

    /// The port actually claimed, once listening.
    private(set) var activePort: UInt16?

    /// True while the extension is actively polling — i.e. the browser is
    /// paired and reachable right now.
    private(set) var isConnected = false
    /// When the extension last polled. Connection is inferred from this rather
    /// than tracked as state, because a browser that quits never says goodbye.
    @ObservationIgnored private var lastPollAt: Date?
    private(set) var lastError: String?
    /// Title/URL of the tab the extension last reported, for the Settings row.
    private(set) var connectedTabDescription: String?

    /// Stable across launches, minted once.
    ///
    /// It regenerated every launch at first, on the theory that a leaked token
    /// dying with the process is strictly safer. In practice that made the
    /// feature unusable: every app restart silently un-paired the extension,
    /// which then got 401s, stopped polling, and every browser command fell
    /// back to AppleScript — surfacing as an unrelated "Accessibility
    /// permission" error that sends you chasing the wrong fix entirely. A
    /// security property nobody can keep working isn't one.
    ///
    /// It lives in UserDefaults rather than the Keychain deliberately: it
    /// authorises nothing beyond talking to a loopback port on this machine,
    /// and any process that could read the plist could equally well read the
    /// Keychain item at that point. `regenerateToken()` is there for when you
    /// do want to invalidate it.
    private static let tokenKey = "eaon_browser_bridge_token"

    @ObservationIgnored private(set) var token: String = ""

    private static func loadOrMintToken() -> String {
        if let existing = UserDefaults.standard.string(forKey: tokenKey), !existing.isEmpty {
            return existing
        }
        let fresh = UUID().uuidString
        UserDefaults.standard.set(fresh, forKey: tokenKey)
        return fresh
    }

    /// Invalidate the current pairing — every extension must be re-paired.
    func regenerateToken() {
        let fresh = UUID().uuidString
        UserDefaults.standard.set(fresh, forKey: Self.tokenKey)
        token = fresh
        isConnected = false
        connectedTabDescription = nil
    }

    @ObservationIgnored private var listener: NWListener?
    @ObservationIgnored private var isRunning = false
    /// Ports whose listener failed to bind. Without remembering these, the
    /// retry-on-failure path restarts from the top of the candidate list and
    /// picks the same occupied port forever — `NWListener`'s initializer
    /// SUCCEEDS on a taken port and only reports the failure asynchronously,
    /// so "did init work" is not a bind check. Observed live: 8823 was held by
    /// a stray `python -m http.server` and the bridge never advanced to 8824.
    @ObservationIgnored private var failedPorts: Set<UInt16> = []

    // MARK: - Command plumbing

    struct Command {
        let id: String
        let action: String
        let params: [String: Any]
    }

    /// Commands waiting for the extension to collect them.
    @ObservationIgnored private var queue: [Command] = []
    /// Callers waiting on a result, keyed by command id.
    @ObservationIgnored private var waiting: [String: CheckedContinuation<String, Error>] = [:]
    /// A long-poll being held open, waiting for something to hand back.
    @ObservationIgnored private var parkedPoll: ((Command) -> Void)?

    enum BridgeError: LocalizedError {
        case notConnected
        case timedOut
        case failed(String)

        var errorDescription: String? {
            switch self {
            case .notConnected:
                return "The Eaon browser extension isn't connected. Install it and pair it in Settings → Device Control, or Eaon will fall back to AppleScript (which needs extra browser permissions)."
            case .timedOut:
                return "The browser extension didn't respond in time."
            case .failed(let detail):
                return detail
            }
        }
    }

    private init() {
        token = Self.loadOrMintToken()
    }

    // MARK: - Lifecycle

    func start() {
        guard !isRunning else { return }
        let parameters = NWParameters.tcp
        // Loopback only — never reachable from another machine.
        parameters.requiredInterfaceType = .loopback
        parameters.allowLocalEndpointReuse = true

        for candidate in Self.candidatePorts where !failedPorts.contains(candidate) {
            guard let nwPort = NWEndpoint.Port(rawValue: candidate),
                  let listener = try? NWListener(using: parameters, on: nwPort) else { continue }
            // `NWListener` init succeeding isn't proof of a bind — the failure
            // surfaces asynchronously, so a port in use is caught here and the
            // next candidate tried rather than leaving a dead listener.
            listener.stateUpdateHandler = { [weak self] state in
                Task { @MainActor in
                    guard let self else { return }
                    if case .failed = state {
                        self.failedPorts.insert(candidate)
                        self.listener?.cancel()
                        self.listener = nil
                        self.isRunning = false
                        self.activePort = nil
                        self.start()   // now skips `candidate`
                    }
                }
            }
            listener.newConnectionHandler = { [weak self] connection in
                connection.start(queue: .main)
                Task { @MainActor in self?.receive(on: connection, buffer: Data()) }
            }
            listener.start(queue: .main)
            self.listener = listener
            self.activePort = candidate
            isRunning = true
            lastError = nil
            return
        }
        lastError = "Couldn't open a local port for the browser extension — all of \(Self.candidatePorts.map(String.init).joined(separator: ", ")) are in use."
    }

    func stop() {
        failedPorts.removeAll()
        listener?.cancel()
        listener = nil
        isRunning = false
        activePort = nil
        isConnected = false
        parkedPoll = nil
        for (_, continuation) in waiting { continuation.resume(throwing: BridgeError.notConnected) }
        waiting.removeAll()
        queue.removeAll()
    }

    /// The extension counts as connected only if it polled recently — a
    /// browser that was quit never sends a disconnect.
    func refreshConnectionState() {
        guard let last = lastPollAt else { isConnected = false; return }
        isConnected = Date().timeIntervalSince(last) < 40
    }

    // MARK: - Sending work to the browser

    /// Queue a command and wait for the extension's answer.
    func send(action: String, params: [String: Any] = [:], timeout: TimeInterval = 20) async throws -> String {
        refreshConnectionState()
        guard isConnected else { throw BridgeError.notConnected }
        let command = Command(id: UUID().uuidString, action: action, params: params)

        // Hand it straight to a parked poll if one is waiting, otherwise queue
        // it for the next one.
        if let deliver = parkedPoll {
            parkedPoll = nil
            deliver(command)
        } else {
            queue.append(command)
        }

        return try await withThrowingTaskGroup(of: String.self) { group in
            group.addTask { @MainActor in
                try await withCheckedThrowingContinuation { continuation in
                    self.waiting[command.id] = continuation
                }
            }
            group.addTask {
                try await Task.sleep(for: .seconds(timeout))
                throw BridgeError.timedOut
            }
            defer { group.cancelAll() }
            let result = try await group.next()!
            await MainActor.run { self.waiting[command.id] = nil }
            return result
        }
    }

    // MARK: - HTTP

    private func receive(on connection: NWConnection, buffer: Data) {
        connection.receive(minimumIncompleteLength: 1, maximumLength: 64 * 1024) { [weak self] data, _, isComplete, _ in
            Task { @MainActor in
                guard let self else { return }
                var accumulated = buffer
                if let data { accumulated.append(data) }
                if let request = BridgeHTTP.parse(accumulated) {
                    self.route(request, on: connection)
                } else if isComplete {
                    connection.cancel()
                } else {
                    self.receive(on: connection, buffer: accumulated)
                }
            }
        }
    }

    private func route(_ request: BridgeHTTP.Request, on connection: NWConnection) {
        // CORS preflight — the extension's fetch() needs it.
        if request.method == "OPTIONS" {
            respond(connection, status: "204 No Content", json: nil)
            return
        }
        guard request.headers["x-eaon-token"] == token else {
            respond(connection, status: "401 Unauthorized", json: ["error": "bad or missing token"])
            return
        }

        switch request.path {
        case "/health":
            lastPollAt = Date()
            refreshConnectionState()
            respond(connection, status: "200 OK", json: ["ok": true, "app": "Eaon"])

        case "/poll":
            lastPollAt = Date()
            refreshConnectionState()
            if let body = try? JSONSerialization.jsonObject(with: request.body) as? [String: Any],
               let tab = body["tab"] as? String {
                connectedTabDescription = tab
            }
            if !queue.isEmpty {
                let command = queue.removeFirst()
                respond(connection, status: "200 OK", json: payload(for: command))
            } else {
                // Park it. Answering immediately would make the extension spin
                // at whatever its retry interval is; holding the request open
                // means a command reaches the browser the moment it exists.
                var answered = false
                parkedPoll = { [weak self] command in
                    guard !answered else { return }
                    answered = true
                    self?.respond(connection, status: "200 OK", json: self?.payload(for: command) ?? [:])
                }
                DispatchQueue.main.asyncAfter(deadline: .now() + 25) { [weak self] in
                    guard !answered else { return }
                    answered = true
                    self?.parkedPoll = nil
                    self?.respond(connection, status: "200 OK", json: ["action": "none"])
                }
            }

        case "/result":
            lastPollAt = Date()
            let body = (try? JSONSerialization.jsonObject(with: request.body)) as? [String: Any] ?? [:]
            if let id = body["id"] as? String, let continuation = waiting[id] {
                waiting[id] = nil
                if let error = body["error"] as? String, !error.isEmpty {
                    continuation.resume(throwing: BridgeError.failed(error))
                } else {
                    continuation.resume(returning: (body["result"] as? String) ?? "Done.")
                }
            }
            respond(connection, status: "200 OK", json: ["ok": true])

        default:
            respond(connection, status: "404 Not Found", json: ["error": "unknown path"])
        }
    }

    private func payload(for command: Command) -> [String: Any] {
        ["id": command.id, "action": command.action, "params": command.params]
    }

    private func respond(_ connection: NWConnection, status: String, json: [String: Any]?) {
        let body = json.flatMap { try? JSONSerialization.data(withJSONObject: $0) } ?? Data()
        var head = "HTTP/1.1 \(status)\r\n"
        head += "Content-Type: application/json\r\n"
        // The extension's service worker has no page origin, so it sends
        // `Origin: chrome-extension://…`; echoing * keeps this simple and is
        // safe because the token, not the origin, is what authorises anything.
        head += "Access-Control-Allow-Origin: *\r\n"
        head += "Access-Control-Allow-Headers: content-type, x-eaon-token\r\n"
        head += "Content-Length: \(body.count)\r\n"
        head += "Connection: close\r\n\r\n"
        var data = Data(head.utf8)
        data.append(body)
        connection.send(content: data, completion: .contentProcessed { _ in connection.cancel() })
    }
}

/// The smallest HTTP/1.1 parse that serves this bridge — headers plus a
/// `Content-Length` body. Separate from `LocalAPIServer`'s copy on purpose:
/// that one is part of the OpenAI-compatible surface people point real clients
/// at, and coupling the two would mean a change for one silently altering the
/// other.
enum BridgeHTTP {
    struct Request {
        let method: String
        let path: String
        let headers: [String: String]
        let body: Data
    }

    static func parse(_ buffer: Data) -> Request? {
        guard let headerEnd = buffer.range(of: Data("\r\n\r\n".utf8)) else { return nil }
        let headerText = String(decoding: buffer[..<headerEnd.lowerBound], as: UTF8.self)
        var lines = headerText.components(separatedBy: "\r\n")
        guard !lines.isEmpty else { return nil }
        let requestLine = lines.removeFirst().components(separatedBy: " ")
        guard requestLine.count >= 2 else { return nil }

        var headers: [String: String] = [:]
        for line in lines {
            guard let colon = line.firstIndex(of: ":") else { continue }
            let name = line[..<colon].trimmingCharacters(in: .whitespaces).lowercased()
            let value = line[line.index(after: colon)...].trimmingCharacters(in: .whitespaces)
            headers[name] = value
        }

        let declared = Int(headers["content-length"] ?? "0") ?? 0
        let bodyStart = headerEnd.upperBound
        let available = buffer.count - bodyStart
        guard available >= declared else { return nil }  // keep accumulating
        let body = declared > 0 ? buffer[bodyStart..<(bodyStart + declared)] : Data()
        return Request(
            method: requestLine[0].uppercased(),
            path: requestLine[1].components(separatedBy: "?").first ?? requestLine[1],
            headers: headers,
            body: Data(body)
        )
    }
}
