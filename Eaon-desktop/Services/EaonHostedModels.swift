import Foundation

enum EaonHostedModels {
    /// Chat models supported by Aqua's hosted API (see `EaonHostedAPI.baseURL`),
    /// kept in sync with what the live `/v1/models` endpoint actually returns.
    /// Non-chat entries from the API (image, audio, etc.) are excluded.
    private static let catalog: [String: String] = [
        "agnes": "Agnes 2.0 Flash",
        "deepseek-v3": "DeepSeek V3",
        "deepseek-v3.1": "DeepSeek V3.1 Terminus",
        "deepseek-v3.2": "DeepSeek V3.2",
        "deepseek-v4": "DeepSeek V4 Flash",
        "deepseek-v4-pro": "DeepSeek V4 Pro",
        "diffusion-gemma": "Diffusion Gemma 26B",
        "gemini-3": "Gemini 3.0 Flash",
        "gemini-3.1-lite": "Gemini 3.1 Flash Lite",
        "gemini-3.1-pro": "Gemini 3.1 Pro",
        "gemini-3.5": "Gemini 3.5 Flash",
        "gemma-4": "Gemma 4 31B",
        "glm-5.1": "GLM 5.1",
        "glm-5.2": "GLM 5.2",
        "gpt-5-nano": "GPT 5 Nano",
        "gpt-5.3-codex": "GPT 5.3 Codex",
        "gpt-5.4": "GPT 5.4",
        "gpt-5.4-mini": "GPT 5.4 Mini",
        "gpt-5.5": "GPT 5.5",
        "gpt-oss": "GPT-OSS 120B",
        "grok": "Grok 4.2 Fast",
        "grok-4.2-thinking": "Grok 4.2 Reasoning",
        "grok-4.3": "Grok 4.3",
        "haiku-4.5": "Claude Haiku 4.5",
        "hermes": "Hermes 4 70B",
        "kimi-k2.5": "Kimi K2.5",
        "kimi-k2.6": "Kimi K2.6",
        "kimi-k2.7": "Kimi K2.7 Code",
        "llama-3.1": "Llama 3.1 8B",
        "llama-4": "Llama 4 Maverick",
        "mercury": "Mercury 2",
        "mimo-v2.5": "Mimo V2.5",
        "mimo-v2.5-pro": "Mimo V2.5 Pro",
        "minimax-m2.7": "MiniMax M2.7",
        "minimax-m3": "MiniMax M3",
        "mistral": "Mistral",
        "mistral-3.5": "Mistral 3.5 128B",
        "nemotron": "Nemotron 3 Ultra",
        "nova": "Amazon Nova Fast",
        "opus-4.7": "Claude Opus 4.7",
        "opus-4.8": "Claude Opus 4.8",
        "qwen": "Qwen Coder",
        "qwen-3.6": "Qwen 3.6 27B",
        "qwen-3.7": "Qwen 3.7 Plus",
        "sonar": "Perplexity Sonar",
        "sonnet-4.6": "Claude Sonnet 4.6",
        "sonnet-5": "Claude Sonnet 5",
        "step-3.7": "Step 3.7 Flash",
    ]

    static let supportedIDs: Set<String> = Set(catalog.keys)

    static func isSupported(_ modelId: String) -> Bool {
        supportedIDs.contains(modelId)
    }

    static func defaultDisplayName(for modelId: String, apiName: String?) -> String {
        if let apiName, !apiName.isEmpty {
            return apiName
        }
        // The catalog is keyed by the bare hosted-model id — a Free Trial
        // row's id carries an extra app-internal suffix (see
        // `FreeWeekTrial.trialModelSuffix`) that would otherwise miss this
        // lookup and fall through to showing the raw, suffixed id as text.
        let bare = FreeWeekTrial.strippingTrialSuffix(modelId)
        return catalog[bare] ?? bare
    }

    static func displayName(for modelId: String, apiName: String?) -> String {
        if let custom = ModelPreferencesStore.shared.nickname(for: modelId) {
            return custom
        }
        return defaultDisplayName(for: modelId, apiName: apiName)
    }

    /// Keeps API metadata but drops models Aqua does not expose for chat.
    static func filterSupported(_ models: [APIModel]) -> [APIModel] {
        models.filter { isSupported($0.id) }
    }
}
