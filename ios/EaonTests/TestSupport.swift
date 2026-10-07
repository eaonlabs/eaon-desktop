import Foundation
import XCTest

/// A network that answers from the test. Every request goes through
/// `handler`, and is recorded, body included, in `requests`.
final class StubProtocol: URLProtocol, @unchecked Sendable {
    nonisolated(unsafe) static var handler: ((URLRequest) throws -> (HTTPURLResponse, Data))?
    nonisolated(unsafe) static var requests: [URLRequest] = []
    private static let lock = NSLock()

    static func reset() {
        lock.lock(); defer { lock.unlock() }
        handler = nil
        requests = []
    }

    static var recorded: [URLRequest] {
        lock.lock(); defer { lock.unlock() }
        return requests
    }

    static func session() -> URLSession {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [StubProtocol.self]
        return URLSession(configuration: configuration)
    }

    static func respond(_ url: URL, status: Int = 200, type: String = "application/json", body: Data) -> (HTTPURLResponse, Data) {
        (HTTPURLResponse(url: url, statusCode: status, httpVersion: "HTTP/1.1", headerFields: ["Content-Type": type])!, body)
    }

    static func respond(_ url: URL, status: Int = 200, json: Any) -> (HTTPURLResponse, Data) {
        respond(url, status: status, body: (try? JSONSerialization.data(withJSONObject: json)) ?? Data())
    }

    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }

    override func startLoading() {
        var request = self.request
        if request.httpBody == nil, let stream = request.httpBodyStream {
            stream.open()
            var data = Data()
            var buffer = [UInt8](repeating: 0, count: 4096)
            while stream.hasBytesAvailable {
                let count = stream.read(&buffer, maxLength: buffer.count)
                if count <= 0 { break }
                data.append(buffer, count: count)
            }
            stream.close()
            request.httpBody = data
        }
        Self.lock.lock()
        Self.requests.append(request)
        let handler = Self.handler
        Self.lock.unlock()

        do {
            guard let handler else { throw URLError(.notConnectedToInternet) }
            let (response, data) = try handler(request)
            client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
            client?.urlProtocol(self, didLoad: data)
            client?.urlProtocolDidFinishLoading(self)
        } catch {
            client?.urlProtocol(self, didFailWithError: error)
        }
    }

    override func stopLoading() {}
}

/// Collects values from `@Sendable` closures.
final class Recorder<Value: Sendable>: @unchecked Sendable {
    private let lock = NSLock()
    private var storage: [Value] = []

    func add(_ value: Value) {
        lock.lock(); defer { lock.unlock() }
        storage.append(value)
    }

    var values: [Value] {
        lock.lock(); defer { lock.unlock() }
        return storage
    }
}

extension URLRequest {
    var bodyString: String { httpBody.flatMap { String(data: $0, encoding: .utf8) } ?? "" }
}

/// An SSE body from pieces of text.
func sse(_ pieces: [String]) -> Data {
    var text = ""
    for piece in pieces {
        let event: [String: Any] = ["choices": [["delta": ["content": piece]]]]
        let json = String(data: try! JSONSerialization.data(withJSONObject: event), encoding: .utf8)!
        text += "data: \(json)\n\n"
    }
    text += "data: [DONE]\n\n"
    return Data(text.utf8)
}
