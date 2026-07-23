import Foundation

enum EaonHostedAPI {
    static let baseURL = URL(string: "https://api.aquadevs.com/v1")!

    static var modelsURL: URL {
        baseURL.appendingPathComponent("models")
    }

    static var chatCompletionsURL: URL {
        baseURL.appendingPathComponent("chat/completions")
    }
}

struct EaonHostedAPIService {
    /// The "Eaon" provider's own list — authenticated with the user's own
    /// key when one is saved, else the public unauthenticated preview list
    /// (browsable, not usable for a real request). Deliberately independent
    /// of trial state now: the Free Trial has its own separate fetch below,
    /// so a saved key having "nothing to do with the trial" is true here
    /// too, not just at request-send time.
    func fetchModels() async throws -> [APIModel] {
        var request = URLRequest(url: EaonHostedAPI.modelsURL)
        if let key = APIKeyStore.loadAPIKey(), !key.isEmpty {
            EaonAccess.authorize(&request, apiKey: key)
        }
        request.timeoutInterval = 30
        // Same gateway that flaps 502 on chat completions serves this list —
        // retry transient 5xx so one blip during an origin hiccup doesn't
        // leave the model picker empty.
        let (data, response) = try await TransientHTTPRetry.sendData(request)

        guard response.statusCode == 200 else {
            throw EaonHostedAPIError.badResponse
        }

        let decoded = try JSONDecoder().decode(APIModelResponse.self, from: data)
        return EaonHostedModels.filterSupported(decoded.data)
            .sorted { lhs, rhs in
                lhs.id.localizedCaseInsensitiveCompare(rhs.id) == .orderedAscending
            }
    }

    /// The "Eaon Free Trial" provider's own list — always fetched via the
    /// trial gateway with the trial's own credential (`EaonAccess.trial`),
    /// regardless of whether a user key exists. Returns `[]` when there's
    /// no active trial, so callers can just merge the result in without an
    /// extra existence check.
    func fetchTrialModels() async throws -> [APIModel] {
        guard let access = EaonAccess.trial else { return [] }
        var request = URLRequest(url: access.modelsURL)
        EaonAccess.authorize(&request, apiKey: access.apiKey)
        request.timeoutInterval = 30
        let (data, response) = try await TransientHTTPRetry.sendData(request)

        guard response.statusCode == 200 else {
            throw EaonHostedAPIError.badResponse
        }

        let decoded = try JSONDecoder().decode(APIModelResponse.self, from: data)
        return EaonHostedModels.filterSupported(decoded.data)
            .sorted { lhs, rhs in
                lhs.id.localizedCaseInsensitiveCompare(rhs.id) == .orderedAscending
            }
    }
}

enum EaonHostedAPIError: LocalizedError {
    case badResponse

    var errorDescription: String? {
        switch self {
        case .badResponse:
            return "Could not load models from Eaon's hosted API."
        }
    }
}

extension APIModel {
    /// Chat completions only support text models from the Aqua catalog.
    var isChatModel: Bool {
        (type ?? "text").lowercased() == "text"
    }
}
