import AppKit
import Foundation
import SwiftUI

// MARK: - Keep-alive

/// How long an idle Ollama model stays loaded before Ollama frees its RAM.
/// Maps directly to Ollama's own `keep_alive` duration string format.
enum OllamaKeepAliveDuration: String, CaseIterable, Identifiable {
    case fiveMinutes = "5m"
    case thirtyMinutes = "30m"
    case oneHour = "1h"
    case untilRestart = "-1"

    var id: String { rawValue }

    var displayName: String {
        switch self {
        case .fiveMinutes: return "5 minutes (Ollama's default)"
        case .thirtyMinutes: return "30 minutes"
        case .oneHour: return "1 hour"
        case .untilRestart: return "Until Ollama restarts"
        }
    }
}

// MARK: - Backends

/// The three local-inference engines the app can drive. All of them expose
/// an OpenAI-compatible HTTP endpoint on localhost, so chat streaming reuses
/// the exact same wire code as remote providers — the only genuinely new
/// machinery is discovery and process management.
enum LocalBackend: String, Codable, CaseIterable, Identifiable {
    case ollama
    case llamaCpp
    case mlx

    var id: String { rawValue }

    var displayName: String {
        switch self {
        case .ollama: return "Ollama"
        case .llamaCpp: return "Llama.cpp"
        case .mlx: return "MLX"
        }
    }

    var blurb: String {
        switch self {
        case .ollama: return "Run models you've pulled with Ollama — private, on this Mac."
        case .llamaCpp: return "Run GGUF models from Hugging Face or files on disk, via llama.cpp."
        case .mlx: return "Run MLX models from Hugging Face on Apple silicon."
        }
    }

    var systemIcon: String {
        switch self {
        case .ollama: return "shippingbox.fill"
        case .llamaCpp: return "cpu.fill"
        case .mlx: return "memorychip.fill"
        }
    }

    var tint: Color {
        switch self {
        case .ollama: return Color(hex: "#9CA3AF")
        case .llamaCpp: return Color(hex: "#F59E0B")
        case .mlx: return Color(hex: "#64D2FF")
        }
    }

    /// Localhost port the backend serves on. Ollama's is its own fixed
    /// default; the spawned servers use uncommon ports to avoid clashes.
    var port: Int {
        switch self {
        case .ollama: return 11434
        case .llamaCpp: return 8586
        case .mlx: return 8587
        }
    }

    var baseURL: URL {
        URL(string: "http://127.0.0.1:\(port)/v1")!
    }

    var installCommand: String {
        switch self {
        case .ollama: return "brew install ollama"
        case .llamaCpp: return "brew install llama.cpp"
        case .mlx: return "pip3 install mlx-lm"
        }
    }

    var installNote: String {
        switch self {
        case .ollama:
            return "Ollama isn't on this Mac yet. Install it with Homebrew (or download the app from ollama.com), then come back here."
        case .llamaCpp:
            return "llama.cpp isn't on this Mac yet. Install it with Homebrew, then come back here."
        case .mlx:
            return "The MLX language-model server isn't on this Mac yet. Install it with pip, then come back here."
        }
    }

    /// The executable that proves the backend is installed.
    var binaryName: String {
        switch self {
        case .ollama: return "ollama"
        case .llamaCpp: return "llama-server"
        case .mlx: return "mlx_lm.server"
        }
    }
}

/// User-chosen GPU-offload behavior for a llama.cpp model, mapped straight
/// to llama-server's own `-ngl`/`--gpu-layers` flag. Hugging-Face-sourced
/// llama.cpp models only: MLX exposes no CPU/GPU switch at all (`mlx_lm.server
/// --help` has nothing like it — MLX is Metal-only by design on Apple
/// Silicon), and Ollama manages its own GPU/CPU split with no per-model hook
/// Eaon controls.
enum GPUOffloadMode: String, Codable, CaseIterable, Identifiable {
    case auto
    case cpuOnly
    case maxGPU

    var id: String { rawValue }

    var label: String {
        switch self {
        case .auto: return "Auto"
        case .cpuOnly: return "CPU only"
        case .maxGPU: return "Max GPU"
        }
    }

    var helpText: String {
        switch self {
        case .auto: return "Let llama.cpp decide how many layers fit in GPU memory."
        case .cpuOnly: return "Run entirely on the CPU — slower, but avoids GPU memory pressure."
        case .maxGPU: return "Force every layer onto the GPU."
        }
    }

    /// The value to pass to `-ngl`, or nil to omit the flag entirely —
    /// llama-server's own default is already "auto", so `.auto` here should
    /// leave the spawned command identical to today's (unset) behavior.
    var gpuLayersArgument: String? {
        switch self {
        case .auto: return nil
        case .cpuOnly: return "0"
        case .maxGPU: return "all"
        }
    }
}

/// The context window (`-c`) a llama.cpp model is launched with. This is the
/// single biggest speed/memory lever for local models: llama-server's own
/// default is the model's *entire trained* context (128K–256K for modern
/// models), which allocates a multi-gigabyte KV cache — measured live, a
/// 0.5 GB model pulled a 3 GB KV cache at its 256K default, which swaps to
/// disk and crawls on a RAM-constrained Mac. Every option here is far
/// smaller; `.balanced` (8192) is the default and already roomier than
/// Ollama's own 4096.
enum LlamaContextSize: String, Codable, CaseIterable, Identifiable {
    case compact
    case balanced
    case large
    case huge

    var id: String { rawValue }

    /// The number handed to `-c`.
    var tokens: Int {
        switch self {
        case .compact: return 4096
        case .balanced: return 8192
        case .large: return 16384
        case .huge: return 32768
        }
    }

    var label: String {
        switch self {
        case .compact: return "Compact · 4K"
        case .balanced: return "Balanced · 8K"
        case .large: return "Large · 16K"
        case .huge: return "Huge · 32K"
        }
    }

    var helpText: String {
        switch self {
        case .compact: return "Smallest memory use and fastest to load — enough for short back-and-forth chats."
        case .balanced: return "The recommended default — roomy for normal conversations without a heavy memory cost."
        case .large: return "More room for longer chats or pasting in documents. Uses noticeably more memory."
        case .huge: return "For feeding in large documents. Uses a lot of memory — only worth it if you have RAM to spare."
        }
    }

    static let defaultValue: LlamaContextSize = .balanced
}

/// Whether to force llama.cpp's Flash Attention on or off. llama-server's own
/// default is `auto` (it decides per-model), which `.auto` here preserves by
/// omitting the flag. Exposed because forcing it `on` can speed up
/// generation and shrink the KV cache on models where `auto` leaves it off.
enum FlashAttentionMode: String, Codable, CaseIterable, Identifiable {
    case auto
    case on
    case off

    var id: String { rawValue }

    /// The `-fa` value, or nil to omit the flag (keep llama-server's default).
    var argument: String? {
        switch self {
        case .auto: return nil
        case .on: return "on"
        case .off: return "off"
        }
    }

    var label: String {
        switch self {
        case .auto: return "Auto"
        case .on: return "On"
        case .off: return "Off"
        }
    }

    var helpText: String {
        switch self {
        case .auto: return "Let llama.cpp decide — the safe default."
        case .on: return "Force it on — often faster and lighter on memory, if the model supports it."
        case .off: return "Force it off — only if a model misbehaves with it on."
        }
    }
}

// MARK: - Model record

/// One locally-runnable model. `id` is namespaced ("ollama:llama3.2:latest")
/// so a local model can never collide with an Aqua or BYOK model id — Aqua
/// really does serve ids like "deepseek-v4-pro" that also exist as Ollama
/// tags on this machine.
struct LocalModelRecord: Identifiable, Codable, Equatable {
    var id: String
    /// What actually goes in the request's "model" field.
    var requestModelId: String
    var backend: LocalBackend
    var displayName: String
    var detail: String
    /// llama.cpp/MLX: the Hugging Face repo or GGUF file path to launch with.
    /// Optional (not `= ""`) because every Ollama-sourced record is built
    /// without passing this at all — real evidence this field was added
    /// after Ollama-only records already existed and got persisted, so a
    /// non-optional default here would silently wipe the user's whole
    /// added-local-model list on decode (same class of bug as
    /// `ChatMessage.wasColdLoad` — see its doc comment).
    var source: String?
    var isFile: Bool?
    var addedAt: Date?
    /// Real spec fields straight from Ollama's own `/api/tags` `details`
    /// object for Ollama-sourced records (nil for llama.cpp/MLX ones, which
    /// have no equivalent endpoint) — optional for the same decode-safety
    /// reason as `source`/`isFile` above: old persisted records were saved
    /// before these existed.
    var paramSize: String?
    var quantization: String?
    var family: String?
    var contextLength: Int?
    /// True for an Ollama model whose real `/api/tags` `capabilities`
    /// includes `"image"` — a genuinely different kind of model (diffusion,
    /// not text) that `/api/chat` flatly 400s on ("does not support chat"),
    /// discovered live against a real pulled model (x/flux2-klein). Optional
    /// so older persisted records — everything before Ollama itself started
    /// serving non-chat models — decode fine without this key.
    var isImageGeneration: Bool?
    /// User override for `-ngl`, llama.cpp-only (see `GPUOffloadMode`). Nil
    /// means "auto" — both for records predating this field and for anyone
    /// who's never touched the control — decode-safe for the same reason as
    /// every other optional added here after records already existed.
    var gpuMode: GPUOffloadMode?
    /// User override for the context window (`-c`), llama.cpp-only. Nil means
    /// `LlamaContextSize.defaultValue` (8192) — decode-safe on older records.
    var contextSize: LlamaContextSize?
    /// User override for Flash Attention (`-fa`), llama.cpp-only. Nil means
    /// `.auto` (omit the flag) — decode-safe on older records.
    var flashAttention: FlashAttentionMode?
    /// True for an Ollama model whose real `/api/tags` `capabilities`
    /// includes `"thinking"` — the real, structured signal (not a name
    /// guess) for whether the composer's Thinking toggle can actually do
    /// anything for this model. Verified live: Ollama's OpenAI-compatible
    /// `/v1/chat/completions` endpoint DOES forward a top-level `"think"`
    /// field through to the model for these — `think: false` measurably
    /// shortened a real DeepSeek/Nemotron reasoning trace, not a no-op.
    /// Optional/decode-safe for records saved before this field existed.
    var supportsThinkingToggle: Bool?
}

// MARK: - Curated catalog (data-driven)

/// Loads and validates `CuratedOllamaModels.json` — the bundled, data-driven
/// source for the Models page's "Popular"/family/use-case sections. This is
/// deliberately the one part of the model catalog kept as data rather than
/// Swift: it changes weekly as new models ship, unlike `ProviderBrand`
/// (still a Swift enum on purpose — a new *company* is rare, and the
/// compiler's exhaustive-switch checking on brand identity is worth more
/// than it costs).
enum CuratedOllamaCatalog {
    private struct File: Decodable {
        struct Entry: Decodable {
            let name: String
            let blurb: String
            let approxSize: String
            let sizeBytes: Int64
            /// The raw `ProviderBrand` case name (e.g. `"meta"`), or absent
            /// entirely for an entry with no single company to credit — see
            /// `LocalAIManager.CuratedOllamaModel.brand`'s own doc comment.
            let brand: String?
            let category: String
            /// Absent on most entries — defaults to `false` on decode, so
            /// existing entries don't all need touching just to add this
            /// field.
            let isNew: Bool?
        }
        let categoryOrder: [String]
        let models: [Entry]
    }

    private static let bundle: Bundle = {
        if let url = Bundle.main.url(forResource: "Eaon-desktop_Eaon-desktop", withExtension: "bundle"),
           let resourceBundle = Bundle(url: url) {
            return resourceBundle
        }
        return Bundle.module
    }()

    /// Loads, decodes, and validates the bundled JSON. Every failure mode —
    /// missing file, malformed JSON, or a `brand` string that doesn't match
    /// any real `ProviderBrand` case — crashes immediately and says exactly
    /// what's wrong, rather than silently dropping an entry or falling back
    /// to something that quietly ships broken. A typo here should be
    /// impossible to miss during any normal test pass, not a subtle bug a
    /// user discovers later.
    static func loadOrFail() -> (categoryOrder: [String], models: [LocalAIManager.CuratedOllamaModel]) {
        guard let url = bundle.url(forResource: "CuratedOllamaModels", withExtension: "json") else {
            fatalError("CuratedOllamaModels.json is missing from the app bundle — the curated Ollama model list can't load.")
        }

        let data: Data
        do {
            data = try Data(contentsOf: url)
        } catch {
            fatalError("Could not read CuratedOllamaModels.json: \(error)")
        }

        let file: File
        do {
            file = try JSONDecoder().decode(File.self, from: data)
        } catch {
            fatalError("CuratedOllamaModels.json failed to decode — check its structure against CuratedOllamaCatalog.File: \(error)")
        }

        let models = file.models.map { entry -> LocalAIManager.CuratedOllamaModel in
            let brand: ProviderBrand?
            if let brandString = entry.brand {
                guard let resolved = ProviderBrand(rawValue: brandString) else {
                    fatalError("""
                        CuratedOllamaModels.json: "\(entry.name)" references brand \"\(brandString)\", \
                        which isn't a real ProviderBrand case. Fix the JSON entry, or add \
                        `case \(brandString)` to ProviderBrand in ModelCatalog.swift if it's a real new company.
                        """)
                }
                brand = resolved
            } else {
                brand = nil
            }
            return LocalAIManager.CuratedOllamaModel(
                name: entry.name,
                blurb: entry.blurb,
                approxSize: entry.approxSize,
                sizeBytes: entry.sizeBytes,
                brand: brand,
                category: entry.category,
                isNew: entry.isNew ?? false
            )
        }

        return (file.categoryOrder, models)
    }
}

// MARK: - Manager

/// Owns local-backend detection, Ollama's live model list, the user's added
/// llama.cpp/MLX models, and the lifecycle of spawned inference servers.
@MainActor
@Observable
final class LocalAIManager {
    static let shared = LocalAIManager()

    private(set) var installed: Set<LocalBackend> = []
    private(set) var ollamaReachable = false
    private(set) var ollamaModels: [LocalModelRecord] = []
    /// Persisted llama.cpp/MLX models the user added by repo or file.
    private(set) var userModels: [LocalModelRecord] = []
    /// Tail of each backend's server output — shown in its settings page.
    private(set) var serverLogs: [LocalBackend: String] = [:]
    /// The spawned inference server currently running (one at a time — these
    /// models eat RAM; running several at once would drown the machine).
    private(set) var activeSpawned: (backend: LocalBackend, modelId: String)?
    private(set) var isStartingServer = false
    private(set) var startupStatus: String?
    private(set) var isPulling = false
    private(set) var pullStatus: String?
    /// 0...1 whenever Ollama's pull stream reports real completed/total
    /// byte counts for the current layer, nil otherwise (a status line with
    /// no byte counts, e.g. "verifying sha256 digest") — so the UI can draw
    /// a real determinate bar instead of guessing.
    private(set) var pullFraction: Double?
    /// How long an idle Ollama model stays resident before Ollama frees its
    /// RAM — user-configurable because the right tradeoff depends on the
    /// machine (a Studio with 128GB might want models to just stay loaded;
    /// a 16GB laptop wants them gone fast). Only takes effect via
    /// `primeOllamaModel` — see its doc comment for why.
    var ollamaKeepAliveDuration: OllamaKeepAliveDuration {
        didSet { UserDefaults.standard.set(ollamaKeepAliveDuration.rawValue, forKey: Self.keepAliveDurationKey) }
    }

    private var spawnedProcess: Process?
    private var managedOllama: Process?
    private static let userModelsKey = "aqua_local_models"
    private static let keepAliveDurationKey = "ollama_keep_alive_duration"

    private init() {
        ollamaKeepAliveDuration = OllamaKeepAliveDuration(
            rawValue: UserDefaults.standard.string(forKey: Self.keepAliveDurationKey) ?? ""
        ) ?? .fiveMinutes
        loadUserModels()
        NotificationCenter.default.addObserver(
            forName: NSApplication.willTerminateNotification, object: nil, queue: .main
        ) { [weak self] _ in
            MainActor.assumeIsolated { self?.stopAllServers() }
        }
        // Installing a backend means leaving Eaon (Terminal, an installer),
        // so coming back is exactly the moment its state is most likely to
        // have changed. Without this, detection only ever ran at launch and
        // a freshly-installed backend stayed invisible until the app was
        // restarted — which reads as "Eaon doesn't see that I installed it."
        NotificationCenter.default.addObserver(
            forName: NSApplication.didBecomeActiveNotification, object: nil, queue: .main
        ) { [weak self] _ in
            Task { @MainActor in await self?.refreshInstalledBackends() }
        }
        Task { await bootstrap() }
    }

    func bootstrap() async {
        await refreshInstalledBackends()
        await refreshOllamaModels()
    }

    // MARK: Detection

    func detectInstalledBackends() {
        var found: Set<LocalBackend> = []
        for backend in LocalBackend.allCases {
            if resolveBinary(backend.binaryName) != nil {
                found.insert(backend)
            }
        }
        installed = found
    }

    /// The thorough re-check: the fast directory scan first, then — for
    /// anything still missing — ask the user's own login shell where the
    /// binary is.
    ///
    /// That second pass exists because the fast scan can only look in places
    /// we thought to list, and Python tooling installs console scripts almost
    /// anywhere: a venv, conda/miniforge, pyenv, a pipx venv, or a python.org
    /// framework build. Someone who runs `pip install mlx-lm`, sees it
    /// succeed, and can run `mlx_lm.server` in their own Terminal is
    /// (correctly) going to call it a bug when Eaon says it isn't installed.
    /// A login shell resolves exactly the PATH that user has, including
    /// whatever their shell profile sets up — so if they can run it, so can
    /// we. Slower (it sources the profile), hence: fallback only, off the
    /// main thread, and the result is cached.
    func refreshInstalledBackends(force: Bool = false) async {
        detectInstalledBackends()

        let missing = LocalBackend.allCases.filter { !installed.contains($0) }
        guard !missing.isEmpty else { return }

        // Spawning a login shell costs a few hundred ms, and this runs on
        // every app activation — throttle it so focusing the window
        // repeatedly doesn't launch a shell each time. An explicit "Check
        // again" passes force, because that click means "look right now."
        if !force, let last = lastLoginShellProbe, Date().timeIntervalSince(last) < 10 {
            return
        }
        lastLoginShellProbe = Date()

        let names = missing.map(\.binaryName)
        let located = await Task.detached { Self.locateViaLoginShell(names) }.value
        guard !located.isEmpty else { return }

        for (name, path) in located { resolvedBinaryPaths[name] = path }
        for backend in missing where located[backend.binaryName] != nil {
            installed.insert(backend)
        }
    }

    private var lastLoginShellProbe: Date?

    /// Asks a login shell to resolve each name, returning only the ones it
    /// found. One shell invocation for all of them rather than one each.
    private nonisolated static func locateViaLoginShell(_ names: [String]) -> [String: String] {
        guard !names.isEmpty else { return [:] }
        let process = Process()
        process.executableURL = URL(fileURLWithPath: "/bin/zsh")
        // -l sources the login profile (where conda/pyenv/custom PATH live).
        // `command -v` per name, each echoed as "name<TAB>path" so one call
        // covers every backend.
        let script = names
            .map { "p=$(command -v \($0) 2>/dev/null); [ -n \"$p\" ] && printf '%s\\t%s\\n' \($0) \"$p\"" }
            .joined(separator: "; ")
        process.arguments = ["-lc", script]
        let pipe = Pipe()
        process.standardOutput = pipe
        process.standardError = FileHandle.nullDevice
        process.standardInput = FileHandle.nullDevice

        do {
            try process.run()
        } catch {
            return [:]
        }
        // A pathological shell profile can hang; don't wedge detection on it.
        let deadline = Date().addingTimeInterval(5)
        while process.isRunning, Date() < deadline {
            usleep(50_000)
        }
        if process.isRunning {
            process.terminate()
            return [:]
        }

        let data = pipe.fileHandleForReading.readDataToEndOfFile()
        guard let output = String(data: data, encoding: .utf8) else { return [:] }

        var result: [String: String] = [:]
        for line in output.split(separator: "\n") {
            let parts = line.split(separator: "\t", maxSplits: 1).map(String.init)
            guard parts.count == 2 else { continue }
            let path = parts[1].trimmingCharacters(in: .whitespaces)
            // Trust it only if it's really there and runnable — a shell
            // function or alias would resolve to something we can't spawn.
            guard FileManager.default.isExecutableFile(atPath: path) else { continue }
            result[parts[0]] = path
        }
        return result
    }

    /// Paths discovered by the login-shell pass, so spawning a server uses
    /// the same binary detection found rather than re-scanning directories
    /// that never contained it.
    private var resolvedBinaryPaths: [String: String] = [:]

    /// Finds an executable the way a login shell would, plus the usual
    /// Homebrew/pip locations a GUI app's bare PATH misses.
    private func resolveBinary(_ name: String) -> String? {
        if let cached = resolvedBinaryPaths[name],
           FileManager.default.isExecutableFile(atPath: cached) {
            return cached
        }

        var directories = (ProcessInfo.processInfo.environment["PATH"] ?? "")
            .split(separator: ":").map(String.init)
        let home = NSHomeDirectory()
        directories += [
            "/opt/homebrew/bin",
            "/usr/local/bin",
            "/usr/bin",
            home + "/.local/bin",
        ]
        // pip --user installs console scripts under ~/Library/Python/<ver>/bin
        let pythonRoot = home + "/Library/Python"
        if let versions = try? FileManager.default.contentsOfDirectory(atPath: pythonRoot) {
            directories += versions.map { pythonRoot + "/" + $0 + "/bin" }
        }
        // python.org's own installer — a very common way to get a pip that
        // isn't blocked by Homebrew's externally-managed-environment rule,
        // and its scripts land nowhere else on this list.
        let frameworkRoot = "/Library/Frameworks/Python.framework/Versions"
        if let versions = try? FileManager.default.contentsOfDirectory(atPath: frameworkRoot) {
            directories += versions.map { frameworkRoot + "/" + $0 + "/bin" }
        }
        // conda/miniforge/miniconda, the other common Python on Apple Silicon.
        directories += [
            home + "/miniforge3/bin",
            home + "/miniconda3/bin",
            home + "/anaconda3/bin",
            "/opt/miniforge3/bin",
            "/opt/miniconda3/bin",
            "/opt/homebrew/Caskroom/miniforge/base/bin",
        ]
        // pipx keeps each package in its own venv and symlinks into
        // ~/.local/bin, but a `pipx install --suffix`ed or partially-linked
        // install can leave the real script only inside the venv.
        let pipxVenvs = home + "/.local/pipx/venvs"
        if let packages = try? FileManager.default.contentsOfDirectory(atPath: pipxVenvs) {
            directories += packages.map { pipxVenvs + "/" + $0 + "/bin" }
        }

        for directory in directories {
            let candidate = directory + "/" + name
            if FileManager.default.isExecutableFile(atPath: candidate) {
                return candidate
            }
        }
        return nil
    }

    // MARK: Ollama models

    struct OllamaTagsResponse: Codable {
        struct Details: Codable {
            let family: String?
            let parameter_size: String?
            let quantization_level: String?
            let context_length: Int?
        }
        struct Model: Codable {
            let name: String
            let size: Int64?
            let remote_host: String?
            let details: Details?
            /// Verified live: `["completion","tools",...]` for a normal chat
            /// model, `["embedding"]` for an embedding model, `["image"]`
            /// for a real diffusion model (x/flux2-klein) — the actual
            /// structured signal Ollama itself gives for "can this take
            /// /api/chat," instead of guessing from the name.
            let capabilities: [String]?
        }
        let models: [Model]
    }

    /// Refreshes the live list of Ollama models. Cloud-proxied entries
    /// (remote_host set) are excluded — they run on ollama.com, not this Mac
    /// — and embedding models are excluded because they can't chat.
    func refreshOllamaModels(startServerIfNeeded: Bool = false) async {
        guard installed.contains(.ollama) else {
            ollamaModels = []
            ollamaReachable = false
            return
        }

        if let tags = await fetchOllamaTags() {
            applyOllamaTags(tags)
            return
        }

        if startServerIfNeeded, startManagedOllamaServe() {
            for _ in 0..<20 {
                try? await Task.sleep(nanoseconds: 700_000_000)
                if let tags = await fetchOllamaTags() {
                    applyOllamaTags(tags)
                    return
                }
            }
        }

        ollamaReachable = false
        // Deliberately NOT clearing `ollamaModels` here anymore: a
        // transient fetch failure (server restarting, briefly busy) used
        // to blank every Ollama row at once — which, right after a delete
        // attempt, read as "everything was deleted" while 20GB sat
        // untouched on disk. Keeping the last-known list with
        // `ollamaReachable = false` stays truthful: the models genuinely
        // are still on this Mac; only the server is momentarily not
        // answering. The list corrects itself on the next successful
        // fetch, and the genuinely-uninstalled case is already handled by
        // the `installed` guard above (which does clear).
    }

    private func applyOllamaTags(_ tags: OllamaTagsResponse) {
        ollamaReachable = true
        ollamaModels = tags.models
            .filter { $0.remote_host == nil && !$0.name.localizedCaseInsensitiveContains("embed") }
            .map { model in
                // Ollama sends these as "" rather than omitting the key when
                // a model has no meaningful value (e.g. an image model's
                // quantization_level) — nilify so the UI's "only show a
                // chip when there's real data" logic doesn't render blanks.
                let nonEmpty: (String?) -> String? = { $0?.isEmpty == false ? $0 : nil }
                return LocalModelRecord(
                    id: "ollama:\(model.name)",
                    requestModelId: model.name,
                    backend: .ollama,
                    displayName: model.name,
                    detail: Self.formatBytes(model.size),
                    paramSize: nonEmpty(model.details?.parameter_size),
                    quantization: nonEmpty(model.details?.quantization_level),
                    family: nonEmpty(model.details?.family),
                    contextLength: model.details?.context_length,
                    isImageGeneration: model.capabilities?.contains("image") == true,
                    supportsThinkingToggle: model.capabilities?.contains("thinking") == true
                )
            }
            .sorted { $0.displayName.localizedCaseInsensitiveCompare($1.displayName) == .orderedAscending }
    }

    private func fetchOllamaTags() async -> OllamaTagsResponse? {
        var request = URLRequest(url: URL(string: "http://127.0.0.1:11434/api/tags")!)
        request.timeoutInterval = 3
        guard let (data, response) = try? await URLSession.shared.data(for: request),
              (response as? HTTPURLResponse)?.statusCode == 200 else { return nil }
        return try? JSONDecoder().decode(OllamaTagsResponse.self, from: data)
    }

    /// A model only actually loads into memory on its first real request —
    /// Ollama itself stays running independent of this app, so "the server
    /// is up" says nothing about whether *this specific* model still needs
    /// a cold load. `/api/ps` lists everything currently resident, with its
    /// real memory footprint — verified live against this Mac's own Ollama
    /// (confirmed: `models[].name` matches the request model id exactly,
    /// `size_vram` is the real resident byte count).
    struct OllamaModelStatus {
        let sizeVRAMBytes: Int64
        let contextLength: Int?
    }

    func ollamaModelStatus(_ modelId: String) async -> OllamaModelStatus? {
        var request = URLRequest(url: URL(string: "http://127.0.0.1:11434/api/ps")!)
        request.timeoutInterval = 3
        guard let (data, response) = try? await URLSession.shared.data(for: request),
              (response as? HTTPURLResponse)?.statusCode == 200,
              let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let models = json["models"] as? [[String: Any]],
              let match = models.first(where: { ($0["name"] as? String) == modelId }),
              let sizeVRAM = match["size_vram"] as? NSNumber else { return nil }
        let contextLength = (match["context_length"] as? NSNumber)?.intValue
        return OllamaModelStatus(sizeVRAMBytes: sizeVRAM.int64Value, contextLength: contextLength)
    }

    /// Everything currently resident in Ollama's memory, keyed by request
    /// model id with its real byte footprint — what the per-model "in
    /// memory" badges and eject buttons in Settings read, refreshed in one
    /// `/api/ps` call instead of every row firing its own.
    private(set) var loadedOllamaModels: [String: Int64] = [:]

    func refreshLoadedOllamaModels() async {
        var request = URLRequest(url: URL(string: "http://127.0.0.1:11434/api/ps")!)
        request.timeoutInterval = 3
        guard let (data, response) = try? await URLSession.shared.data(for: request),
              (response as? HTTPURLResponse)?.statusCode == 200,
              let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let models = json["models"] as? [[String: Any]] else {
            loadedOllamaModels = [:]
            return
        }
        var loaded: [String: Int64] = [:]
        for model in models {
            guard let name = model["name"] as? String,
                  let size = model["size_vram"] as? NSNumber else { continue }
            loaded[name] = size.int64Value
        }
        loadedOllamaModels = loaded
    }

    /// Immediately evicts a model from Ollama's memory — `keep_alive: 0`
    /// on the same native ping `primeOllamaModel` uses, which is Ollama's
    /// own documented unload (verified live on this Mac: the call returns
    /// `done_reason: "unload"` and `/api/ps` empties immediately). Weights
    /// on disk are untouched; the next message to this model just
    /// cold-loads it again.
    func unloadOllamaModel(_ modelId: String) async {
        await primeOllamaModel(modelId, keepAlive: "0")
        await refreshLoadedOllamaModels()
    }

    private static func formatBytes(_ bytes: Int64?) -> String {
        guard let bytes, bytes > 0 else { return "On this Mac" }
        let gigabytes = Double(bytes) / 1_000_000_000
        if gigabytes >= 1 { return String(format: "%.1f GB on this Mac", gigabytes) }
        return String(format: "%.0f MB on this Mac", gigabytes * 1000)
    }

    /// Loads a model into memory (if not already) and/or (re)sets how long
    /// it stays resident, via a native `/api/generate` ping with no
    /// `prompt` field — verified empirically to load-without-generating
    /// (Ollama returns `done_reason: "load"`, zero tokens) and to honor
    /// `keep_alive` exactly. This has to be a separate native call: actual
    /// chat completions stream through the OpenAI-compatible endpoint
    /// (`CustomProviderAPIService`), and that endpoint silently ignores a
    /// `keep_alive` field in the body — verified live, it just falls back
    /// to Ollama's hardcoded 5-minute default regardless of what's sent.
    /// Fire-and-forget: any failure here just means that 5-minute default
    /// applies instead, never worse than before this existed.
    @discardableResult
    func primeOllamaModel(_ modelId: String, keepAlive: String) async -> Bool {
        guard let url = URL(string: "http://127.0.0.1:11434/api/generate") else { return false }
        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.timeoutInterval = 30
        request.httpBody = try? JSONSerialization.data(withJSONObject: [
            "model": modelId,
            "keep_alive": keepAlive,
        ])
        guard let (_, response) = try? await URLSession.shared.data(for: request) else { return false }
        return (response as? HTTPURLResponse)?.statusCode == 200
    }

    // MARK: Pull (Ollama)

    /// Streams `ollama pull` progress via the NDJSON /api/pull endpoint.
    func pullOllamaModel(_ name: String) async {
        let trimmed = name.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty, !isPulling else { return }
        isPulling = true
        pullingModelName = trimmed
        pullStatus = "Starting download of \(trimmed)…"
        pullFraction = nil
        defer {
            isPulling = false
            pullingModelName = nil
            pullFraction = nil
        }

        var request = URLRequest(url: URL(string: "http://127.0.0.1:11434/api/pull")!)
        request.httpMethod = "POST"
        request.timeoutInterval = 3600
        request.httpBody = try? JSONSerialization.data(withJSONObject: ["model": trimmed, "stream": true])

        do {
            let (bytes, response) = try await URLSession.shared.bytes(for: request)
            guard (response as? HTTPURLResponse)?.statusCode == 200 else {
                pullStatus = "Could not start the download — is the model name right?"
                return
            }
            for try await line in bytes.lines {
                guard let data = line.data(using: .utf8),
                      let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else { continue }
                if let error = json["error"] as? String {
                    pullStatus = "Error: \(error)"
                    return
                }
                let status = json["status"] as? String ?? ""
                if let completed = json["completed"] as? Double, let total = json["total"] as? Double, total > 0 {
                    let fraction = completed / total
                    pullFraction = fraction
                    pullStatus = "\(status) — \(Int(fraction * 100))%"
                } else {
                    // A status with no byte counts (e.g. "verifying sha256
                    // digest") isn't part of the same 0...1 progression —
                    // clearing it keeps the bar from freezing at the last
                    // layer's fraction while a different phase runs.
                    pullFraction = nil
                    if !status.isEmpty { pullStatus = status }
                }
            }
            pullStatus = "Done — \(trimmed) is ready."
            await refreshOllamaModels()
        } catch {
            pullStatus = "Download failed: \(error.localizedDescription)"
        }
    }

    /// Looks up a model's real download size from Ollama's own public
    /// registry — used to show a fit estimate for a name the user typed in
    /// that isn't part of the curated list, before they actually pull it.
    /// Returns nil for a name that doesn't exist (the pull itself will
    /// surface that error) or on any network failure.
    nonisolated func fetchOllamaRegistrySize(name: String) async -> Int64? {
        let trimmed = name.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return nil }
        let parts = trimmed.split(separator: ":", maxSplits: 1)
        let repo = String(parts[0])
        let tag = parts.count > 1 ? String(parts[1]) : "latest"
        guard let url = URL(string: "https://registry.ollama.ai/v2/library/\(repo)/manifests/\(tag)") else { return nil }

        var request = URLRequest(url: url)
        request.timeoutInterval = 10
        request.addValue("application/vnd.docker.distribution.manifest.v2+json", forHTTPHeaderField: "Accept")

        guard let (data, response) = try? await URLSession.shared.data(for: request),
              (response as? HTTPURLResponse)?.statusCode == 200,
              let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else { return nil }

        // JSONSerialization hands back numbers as NSNumber, not directly as
        // Int64 — going through .int64Value is the safe unwrap.
        let configSize = ((json["config"] as? [String: Any])?["size"] as? NSNumber)?.int64Value ?? 0
        let layers = json["layers"] as? [[String: Any]] ?? []
        let layersSize = layers.reduce(Int64(0)) { $0 + (($1["size"] as? NSNumber)?.int64Value ?? 0) }
        let total = configSize + layersSize
        return total > 0 ? total : nil
    }

    struct OllamaModelSpecs: Equatable {
        let paramSize: String?
        let quantization: String?
        let family: String?
    }

    /// Real parameter count, quantization, and architecture family for a
    /// model that isn't downloaded yet — straight from Ollama's own public
    /// registry, the same source `fetchOllamaRegistrySize` already reads.
    /// The manifest's `config` layer digest points at a second small JSON
    /// blob (`model_type`/`file_type`/`model_family`) that isn't in the
    /// manifest itself, so this is a second request — verified live against
    /// the real registry (2026-07-12) rather than assumed from docs, since
    /// this shape isn't publicly documented anywhere. Context length isn't
    /// available here (only for models already pulled — see
    /// `LocalModelRecord.contextLength`, sourced from local `/api/tags`).
    /// `nonisolated` on purpose. `LocalAIManager` is `@MainActor`, so this
    /// used to run its whole body — two HTTPS round trips and two
    /// `JSONSerialization` parses — ON THE MAIN THREAD. Opening the Models
    /// page prefetches specs for every model in the open "Popular" category,
    /// which is 14 models and therefore 28 requests, all landing back on the
    /// main actor to be parsed while it is also trying to lay the page out.
    /// The function reads nothing but its own parameter, so hoisting it off
    /// the actor is free and keeps that work entirely on background threads.
    nonisolated func fetchOllamaRegistrySpecs(name: String) async -> OllamaModelSpecs? {
        let trimmed = name.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return nil }
        let parts = trimmed.split(separator: ":", maxSplits: 1)
        let repo = String(parts[0])
        let tag = parts.count > 1 ? String(parts[1]) : "latest"
        guard let manifestURL = URL(string: "https://registry.ollama.ai/v2/library/\(repo)/manifests/\(tag)") else { return nil }

        var manifestRequest = URLRequest(url: manifestURL)
        manifestRequest.timeoutInterval = 10
        manifestRequest.addValue("application/vnd.docker.distribution.manifest.v2+json", forHTTPHeaderField: "Accept")

        guard let (manifestData, manifestResponse) = try? await URLSession.shared.data(for: manifestRequest),
              (manifestResponse as? HTTPURLResponse)?.statusCode == 200,
              let manifestJSON = try? JSONSerialization.jsonObject(with: manifestData) as? [String: Any],
              let configDigest = (manifestJSON["config"] as? [String: Any])?["digest"] as? String,
              let configURL = URL(string: "https://registry.ollama.ai/v2/library/\(repo)/blobs/\(configDigest)") else { return nil }

        var configRequest = URLRequest(url: configURL)
        configRequest.timeoutInterval = 10
        guard let (configData, configResponse) = try? await URLSession.shared.data(for: configRequest),
              (configResponse as? HTTPURLResponse)?.statusCode == 200,
              let configJSON = try? JSONSerialization.jsonObject(with: configData) as? [String: Any] else { return nil }

        let paramSize = configJSON["model_type"] as? String
        let quantization = configJSON["file_type"] as? String
        let family = configJSON["model_family"] as? String
        guard paramSize != nil || quantization != nil || family != nil else { return nil }
        return OllamaModelSpecs(paramSize: paramSize, quantization: quantization, family: family)
    }

    struct OllamaPageSummary: Equatable {
        /// Ollama's own one-line summary for the model (its `<meta
        /// name="description">`) — short enough to quote directly with
        /// attribution, unlike the page's full multi-paragraph "Highlights"
        /// copy, which this deliberately does NOT fetch or reproduce.
        let description: String?
        /// URL of the model's benchmark chart image, still hosted on
        /// ollama.com — meant to be loaded live (e.g. via `AsyncImage`)
        /// rather than downloaded and cached by this app, so it's always
        /// their real, current server response, never a stored copy.
        let chartImageURL: URL?
        let pageURL: URL
    }

    /// Reads just two things off a model's real ollama.com library page: its
    /// short one-line description and the URL of its benchmark chart image
    /// — never the page's longer "Highlights" prose, and never a downloaded
    /// copy of the chart itself. There's no API for this (Ollama doesn't
    /// publish one), so this parses the live HTML response directly; it's
    /// deliberately narrow (two regex reads, not a general scraper) since
    /// the goal is two verifiably-safe-to-show facts, not the whole page.
    /// Also `nonisolated`, for the reason on `fetchOllamaRegistrySpecs`:
    /// parsing a whole HTML page on the main actor while the UI is laying
    /// out is exactly the kind of work that has no business being there.
    nonisolated func fetchOllamaPageSummary(name: String) async -> OllamaPageSummary? {
        let trimmed = name.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return nil }
        let base = String(trimmed.split(separator: ":", maxSplits: 1).first ?? Substring(trimmed))
        guard let pageURL = URL(string: "https://ollama.com/library/\(base)") else { return nil }

        var request = URLRequest(url: pageURL)
        request.timeoutInterval = 10
        guard let (data, response) = try? await URLSession.shared.data(for: request),
              (response as? HTTPURLResponse)?.statusCode == 200,
              let html = String(data: data, encoding: .utf8) else { return nil }

        let description = Self.extractMetaDescription(from: html)
        let chartImageURL = Self.extractBenchmarkChartURL(from: html, base: base)
        guard description != nil || chartImageURL != nil else { return nil }
        return OllamaPageSummary(description: description, chartImageURL: chartImageURL, pageURL: pageURL)
    }

    nonisolated private static func extractMetaDescription(from html: String) -> String? {
        guard let range = html.range(of: #"<meta name="description" content="([^"]*)""#, options: .regularExpression) else { return nil }
        let tag = String(html[range])
        guard let contentRange = tag.range(of: #"(?<=content=")[^"]*"#, options: .regularExpression) else { return nil }
        let raw = String(tag[contentRange]).trimmingCharacters(in: .whitespacesAndNewlines)
        guard !raw.isEmpty else { return nil }
        return raw
            .replacingOccurrences(of: "&#39;", with: "'")
            .replacingOccurrences(of: "&quot;", with: "\"")
            .replacingOccurrences(of: "&amp;", with: "&")
            .replacingOccurrences(of: "&lt;", with: "<")
            .replacingOccurrences(of: "&gt;", with: ">")
    }

    /// Matches `ollama.com/assets/library/<base>/<id>` specifically (not
    /// just any `/assets/library/` URL on the page) so a generic site asset
    /// unrelated to this model's own benchmark chart is never picked up.
    nonisolated private static func extractBenchmarkChartURL(from html: String, base: String) -> URL? {
        let escapedBase = NSRegularExpression.escapedPattern(for: base)
        let pattern = #"https://ollama\.com/assets/library/"# + escapedBase + #"/[a-f0-9-]+"#
        guard let range = html.range(of: pattern, options: .regularExpression) else { return nil }
        return URL(string: String(html[range]))
    }

    // MARK: Ollama delete

    /// Removes a model from Ollama's local store (DELETE /api/delete).
    /// Returns nil on VERIFIED success, or a user-facing reason on failure.
    /// The old version fired the request and ignored everything about the
    /// outcome (`_ = try? …`) — combined with the refresh below, a failed
    /// delete looked exactly like a successful one, which is precisely how
    /// "the app says deleted but my storage didn't change" happens (seen
    /// live: 20GB of Ollama models intact after in-app deletion). Verified
    /// means verified: even a 200 is only trusted after the tags list
    /// confirms the model is actually gone.
    func deleteOllamaModel(_ name: String) async -> String? {
        var request = URLRequest(url: URL(string: "http://127.0.0.1:11434/api/delete")!)
        request.httpMethod = "DELETE"
        request.timeoutInterval = 30
        request.addValue("application/json", forHTTPHeaderField: "Content-Type")
        let payload = (try? JSONSerialization.data(withJSONObject: ["model": name])) ?? Data()

        let statusCode: Int
        let responseBody: String
        do {
            // upload(for:from:) rather than data(for:) with httpBody — both
            // tested working against a live Ollama today, but upload's
            // explicit body can't be silently dropped by intermediaries
            // that special-case DELETE.
            let (data, response) = try await URLSession.shared.upload(for: request, from: payload)
            statusCode = (response as? HTTPURLResponse)?.statusCode ?? -1
            responseBody = String(data: data, encoding: .utf8) ?? ""
        } catch {
            return "Couldn't reach the Ollama server to delete \(name) — is it running? (\(error.localizedDescription))"
        }

        await refreshOllamaModels()

        guard (200...299).contains(statusCode) else {
            let detail = responseBody.isEmpty ? "HTTP \(statusCode)" : responseBody
            return "Ollama refused to delete \(name): \(detail)"
        }
        if ollamaReachable, ollamaModels.contains(where: { $0.requestModelId == name }) {
            return "Ollama reported success deleting \(name), but it's still in the model list — try again, or run `ollama rm \(name)` in Terminal."
        }
        return nil
    }

    /// The single, backend-aware place to delete any local model — Ollama's
    /// own store for Ollama models, the app's own record (and file, if it's
    /// one the app downloaded) for llama.cpp/MLX ones. Every delete button
    /// in the app should route through this rather than picking a backend's
    /// method itself: `removeUserModel` only touches the llama.cpp/MLX list,
    /// so calling it directly for an Ollama model silently does nothing.
    /// Returns nil on verified success, or a user-facing failure reason —
    /// callers must show it, never swallow it.
    func deleteModel(_ record: LocalModelRecord) async -> String? {
        switch record.backend {
        case .ollama:
            return await deleteOllamaModel(record.requestModelId)
        case .llamaCpp, .mlx:
            return removeUserModel(id: record.id)
        }
    }

    // MARK: Hugging Face discovery + downloads

    struct HFSearchResult: Identifiable, Equatable {
        let id: String
        let downloads: Int
        let likes: Int
    }

    /// Which runtime a Hugging Face search targets — GGUF for llama.cpp,
    /// MLX for Apple's own framework (often faster than GGUF on Apple
    /// Silicon, since it's built for this hardware specifically rather than
    /// llama.cpp's broad-CPU/GPU portability).
    enum HFModelFormat: CaseIterable, Hashable {
        case gguf, mlx

        var hfFilterValue: String {
            switch self {
            case .gguf: return "gguf"
            case .mlx: return "mlx"
            }
        }

        var backend: LocalBackend {
            switch self {
            case .gguf: return .llamaCpp
            case .mlx: return .mlx
            }
        }

        var displayName: String {
            switch self {
            case .gguf: return "GGUF"
            case .mlx: return "MLX"
            }
        }
    }

    struct ModelDownloadState: Equatable {
        var status: String
        /// 0...1 when the total size is known, nil while indeterminate.
        var fraction: Double?
        var failed = false
        var finished = false
    }

    /// Active/finished Hugging Face downloads, keyed by repo id.
    private(set) var hfDownloads: [String: ModelDownloadState] = [:]
    private var hfDownloadTasks: [String: Task<Void, Never>] = [:]

    /// Live search of Hugging Face's public model API, restricted to
    /// text-generation repos in the given runtime's format (what llama.cpp
    /// or MLX can actually run — verified live that Hugging Face's own
    /// `filter=mlx` correctly returns real MLX-format repos like
    /// mlx-community/Kimi-K2.5, not a guessed/unverified param).
    /// An empty query returns the current most-downloaded models across all
    /// of Hugging Face in that format instead of matching nothing — used to
    /// show a live "Trending" list by default, so the tab never opens to a
    /// blank "type something" prompt (verified: an empty `search=` param
    /// behaves identically to omitting it, so this is the same call either
    /// way).
    nonisolated func searchHuggingFace(_ query: String, format: HFModelFormat, limit: Int = 25) async -> [HFSearchResult] {
        var components = URLComponents(string: "https://huggingface.co/api/models")!
        var items = [
            URLQueryItem(name: "filter", value: format.hfFilterValue),
            URLQueryItem(name: "pipeline_tag", value: "text-generation"),
            URLQueryItem(name: "sort", value: "downloads"),
            URLQueryItem(name: "limit", value: "\(limit)"),
        ]
        if !query.isEmpty {
            items.append(URLQueryItem(name: "search", value: query))
        }
        components.queryItems = items
        guard let url = components.url else { return [] }
        var request = URLRequest(url: url)
        request.timeoutInterval = 15

        struct APIEntry: Codable {
            let id: String
            let downloads: Int?
            let likes: Int?
        }
        guard let (data, response) = try? await URLSession.shared.data(for: request),
              (response as? HTTPURLResponse)?.statusCode == 200,
              let entries = try? JSONDecoder().decode([APIEntry].self, from: data) else { return [] }
        return entries.map { HFSearchResult(id: $0.id, downloads: $0.downloads ?? 0, likes: $0.likes ?? 0) }
    }

    /// Where in-app Hugging Face downloads live — files here are ours to
    /// delete when their model is removed (never user-picked files).
    static var managedModelsDirectory: URL {
        AppDataLocation.directory.appendingPathComponent("Models", isDirectory: true)
    }

    /// True once a repo's file has been downloaded and registered.
    func isHFRepoDownloaded(_ repo: String) -> Bool {
        userModels.contains { $0.detail.contains(repo) }
    }

    func downloadedModelId(forRepo repo: String) -> String? {
        userModels.first { $0.detail.contains(repo) }?.id
    }

    /// `file` lets the user override the auto-picked quantization (from
    /// `listGGUFFiles`) — nil keeps the one-click default behavior.
    /// `onComplete` fires exactly once, with the newly-downloaded model's
    /// id (nil on failure/cancel) — the one-click "download it and take me
    /// to chat with it" flow hangs off this rather than the caller having
    /// to poll or diff `hfDownloads` itself.
    func startHFDownload(repo: String, file: GGUFFile? = nil, onComplete: @escaping (String?) -> Void = { _ in }) {
        guard hfDownloadTasks[repo] == nil else { return }
        hfDownloads[repo] = ModelDownloadState(status: file == nil ? "Finding the best file…" : "Starting download…", fraction: nil)
        hfDownloadTasks[repo] = Task { [weak self] in
            let resultId = await self?.runHFDownload(repo: repo, file: file)
            self?.hfDownloadTasks[repo] = nil
            onComplete(resultId)
        }
    }

    func cancelHFDownload(repo: String) {
        hfDownloadTasks[repo]?.cancel()
    }

    /// Returns the resulting `LocalModelRecord.id` on success, nil on
    /// failure/cancellation.
    @discardableResult
    private func runHFDownload(repo: String, file explicitFile: GGUFFile? = nil) async -> String? {
        do {
            let file: (path: String, size: Int64)
            if let explicitFile {
                file = (explicitFile.path, explicitFile.size)
            } else {
                file = try await resolveGGUFFile(repo: repo)
            }
            let sizeText = Self.formatBytes(file.size).replacingOccurrences(of: " on this Mac", with: "")

            let directory = Self.managedModelsDirectory
            try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
            let fileName = repo.replacingOccurrences(of: "/", with: "_") + "__" + (file.path as NSString).lastPathComponent
            let destination = directory.appendingPathComponent(fileName)

            if !FileManager.default.fileExists(atPath: destination.path) {
                hfDownloads[repo] = ModelDownloadState(status: "Downloading \(sizeText)…", fraction: file.size > 0 ? 0 : nil)
                guard let sourceURL = URL(string: "https://huggingface.co/\(repo)/resolve/main/\(file.path)") else {
                    throw URLError(.badURL)
                }
                try await Self.downloadFile(from: sourceURL, to: destination, expectedSize: file.size) { [weak self] fraction in
                    Task { @MainActor in
                        guard let self, var state = self.hfDownloads[repo], !state.finished else { return }
                        state.fraction = fraction
                        state.status = "Downloading \(sizeText) — \(Int(fraction * 100))%"
                        self.hfDownloads[repo] = state
                    }
                }
            }

            let quant = Self.quantLabel(from: file.path)
            let record = LocalModelRecord(
                id: "llamacpp:\(destination.path)",
                requestModelId: (repo as NSString).lastPathComponent,
                backend: .llamaCpp,
                displayName: (repo as NSString).lastPathComponent + (quant.isEmpty ? "" : " · \(quant)"),
                detail: "\(sizeText) · from \(repo)",
                source: destination.path,
                isFile: true
            )
            if !userModels.contains(where: { $0.id == record.id }) {
                userModels.append(record)
                persistUserModels()
            }
            hfDownloads[repo] = ModelDownloadState(status: "Ready — it's under \"On this Mac\"", fraction: 1, finished: true)
            return record.id
        } catch is CancellationError {
            hfDownloads[repo] = nil
            return nil
        } catch let error as URLError where error.code == .cancelled {
            hfDownloads[repo] = nil
            return nil
        } catch {
            hfDownloads[repo] = ModelDownloadState(status: "Failed: \(error.localizedDescription)", fraction: nil, failed: true)
            return nil
        }
    }

    func clearHFDownloadState(repo: String) {
        hfDownloads[repo] = nil
    }

    struct GGUFFile: Identifiable, Equatable {
        let path: String
        let size: Int64
        var id: String { path }
        var quantLabel: String { LocalAIManager.quantLabel(from: path) }
    }

    /// Every single-file GGUF candidate in a repo (skipping multi-part
    /// splits and vision projector files) — the raw list behind both
    /// `resolveGGUFFile`'s auto-pick and the quantization picker in the UI.
    private func fetchGGUFCandidates(repo: String) async throws -> [GGUFFile] {
        guard let url = URL(string: "https://huggingface.co/api/models/\(repo)/tree/main") else {
            throw URLError(.badURL)
        }
        var request = URLRequest(url: url)
        request.timeoutInterval = 15

        struct TreeEntry: Codable {
            let path: String
            let size: Int64?
        }
        let (data, response) = try await URLSession.shared.data(for: request)
        guard (response as? HTTPURLResponse)?.statusCode == 200,
              let entries = try? JSONDecoder().decode([TreeEntry].self, from: data) else {
            throw LocalAIError.startFailed(.llamaCpp, "couldn't read that Hugging Face repo — check the name")
        }

        let candidates = entries.filter { entry in
            let lower = entry.path.lowercased()
            return lower.hasSuffix(".gguf") && !lower.contains("-of-") && !lower.contains("mmproj")
        }
        guard !candidates.isEmpty else {
            throw LocalAIError.startFailed(.llamaCpp, "that repo has no single-file GGUF models")
        }
        return candidates.map { GGUFFile(path: $0.path, size: $0.size ?? 0) }
    }

    /// Every downloadable quantization for a repo, smallest-to-largest —
    /// backs the quantization picker so a user can trade quality for size
    /// instead of always getting the one auto-picked default.
    nonisolated func listGGUFFiles(repo: String) async throws -> [GGUFFile] {
        try await fetchGGUFCandidates(repo: repo).sorted { $0.size < $1.size }
    }

    /// Picks the single-file GGUF to download from a repo — Q4_K_M when
    /// available (the standard quality/size sweet spot), skipping multi-part
    /// splits and vision projector files.
    func resolveGGUFFile(repo: String) async throws -> (path: String, size: Int64) {
        let candidates = try await fetchGGUFCandidates(repo: repo)
        let preferences = ["q4_k_m", "q4_k_s", "q4_0", "q5_k_m", "q8_0"]
        for preference in preferences {
            if let match = candidates.first(where: { $0.path.lowercased().contains(preference) }) {
                return (match.path, match.size)
            }
        }
        let smallest = candidates.min { $0.size < $1.size }!
        return (smallest.path, smallest.size)
    }

    /// An MLX repo has no single downloadable file the way GGUF does — it's
    /// a folder of safetensors shards plus small config/tokenizer files that
    /// `mlx_lm.server` fetches itself on first launch. For the same
    /// before-you-commit "will this fit" estimate GGUF gets, this sums the
    /// real per-file sizes from the same `/tree/main` listing GGUF discovery
    /// already uses — just filtered to the files that actually carry the
    /// weights instead of a single `.gguf` match.
    func resolveMLXRepoSize(repo: String) async throws -> Int64 {
        guard let url = URL(string: "https://huggingface.co/api/models/\(repo)/tree/main") else {
            throw URLError(.badURL)
        }
        var request = URLRequest(url: url)
        request.timeoutInterval = 15

        struct TreeEntry: Codable {
            let path: String
            let size: Int64?
        }
        let (data, response) = try await URLSession.shared.data(for: request)
        guard (response as? HTTPURLResponse)?.statusCode == 200,
              let entries = try? JSONDecoder().decode([TreeEntry].self, from: data) else {
            throw LocalAIError.startFailed(.mlx, "couldn't read that Hugging Face repo — check the name")
        }
        let weightFiles = entries.filter { $0.path.lowercased().hasSuffix(".safetensors") }
        guard !weightFiles.isEmpty else {
            throw LocalAIError.startFailed(.mlx, "that repo has no MLX weight files")
        }
        return weightFiles.reduce(0) { $0 + ($1.size ?? 0) }
    }

    nonisolated private static func quantLabel(from path: String) -> String {
        let lower = path.lowercased()
        for quant in ["q4_k_m", "q4_k_s", "q4_0", "q5_k_m", "q8_0", "q3_k_m", "q2_k"] where lower.contains(quant) {
            return quant.uppercased()
        }
        return ""
    }

    /// Delegate-based download so we get byte-level progress (the async
    /// `download(from:)` API offers none) without a per-byte async loop.
    private static func downloadFile(
        from url: URL,
        to destination: URL,
        expectedSize: Int64,
        onProgress: @escaping @Sendable (Double) -> Void
    ) async throws {
        final class Delegate: NSObject, URLSessionDownloadDelegate {
            let destination: URL
            let expectedSize: Int64
            let onProgress: @Sendable (Double) -> Void
            var continuation: CheckedContinuation<Void, Error>?
            private var lastReported = -1

            init(destination: URL, expectedSize: Int64, onProgress: @escaping @Sendable (Double) -> Void) {
                self.destination = destination
                self.expectedSize = expectedSize
                self.onProgress = onProgress
            }

            func urlSession(_ session: URLSession, downloadTask: URLSessionDownloadTask,
                            didWriteData bytesWritten: Int64, totalBytesWritten: Int64,
                            totalBytesExpectedToWrite: Int64) {
                let total = totalBytesExpectedToWrite > 0 ? totalBytesExpectedToWrite : expectedSize
                guard total > 0 else { return }
                let percent = Int(Double(totalBytesWritten) / Double(total) * 100)
                if percent != lastReported {
                    lastReported = percent
                    onProgress(min(1, Double(totalBytesWritten) / Double(total)))
                }
            }

            func urlSession(_ session: URLSession, downloadTask: URLSessionDownloadTask,
                            didFinishDownloadingTo location: URL) {
                do {
                    try? FileManager.default.removeItem(at: destination)
                    try FileManager.default.moveItem(at: location, to: destination)
                } catch {
                    continuation?.resume(throwing: error)
                    continuation = nil
                }
            }

            func urlSession(_ session: URLSession, task: URLSessionTask, didCompleteWithError error: Error?) {
                if let error {
                    continuation?.resume(throwing: error)
                } else {
                    continuation?.resume()
                }
                continuation = nil
            }
        }

        let delegate = Delegate(destination: destination, expectedSize: expectedSize, onProgress: onProgress)
        let session = URLSession(configuration: .default, delegate: delegate, delegateQueue: nil)
        defer { session.finishTasksAndInvalidate() }

        var request = URLRequest(url: url)
        request.timeoutInterval = 3600
        let task = session.downloadTask(with: request)

        try await withTaskCancellationHandler {
            try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, Error>) in
                delegate.continuation = continuation
                task.resume()
            }
        } onCancel: {
            task.cancel()
        }
    }

    // MARK: Curated Ollama picks

    struct CuratedOllamaModel: Identifiable {
        let name: String
        let blurb: String
        let approxSize: String
        /// The real download size in bytes (from the model's own registry
        /// manifest, not an estimate) — feeds `ModelFitEstimator` so the fit
        /// badge is judged against the exact bytes, not a re-parsed string.
        let sizeBytes: Int64
        /// The company that actually trained/released this specific model —
        /// hand-assigned per entry rather than guessed from the name at
        /// render time, since name-based heuristics have real false
        /// positives here (e.g. "tinyllama" isn't Meta's despite containing
        /// "llama"; "mixtral"/"codestral"/"devstral" are Mistral AI's own
        /// models despite not containing the substring "mistral"). `nil`
        /// means no single company can be honestly credited — a community
        /// fine-tune or research-group release (e.g. LLaVA, Vicuna) — shown
        /// with a neutral icon rather than misattributed to anyone.
        let brand: ProviderBrand?
        let category: String
        /// True for a genuinely current release (checked against the live
        /// Ollama registry, not just "hasn't been removed yet") — drives a
        /// small "New" badge in the picker so a recent model is visibly
        /// distinct from the long tail of older ones sitting in the same
        /// list, instead of something only recognizable if you already know
        /// which release dates are current.
        let isNew: Bool
        var id: String { name }
    }

    /// Both the category order and the model list itself are loaded from a
    /// bundled JSON file (`CuratedOllamaModels.json`) rather than hardcoded
    /// here — this is the part of the catalog that changes weekly as new
    /// models ship, so it shouldn't need a rebuild. `ProviderBrand` itself
    /// stays a Swift enum (compile-time exhaustive switches for anything
    /// brand-identity-related — logo, color, fallback icon — are worth
    /// keeping; new *companies* are rare enough that a Swift case is fine).
    /// Loaded once, lazily, via `static let`'s normal thread-safe semantics;
    /// `AppDelegate.applicationDidFinishLaunching` also touches this
    /// eagerly so a bad entry fails loudly at launch rather than whenever a
    /// user first happens to open the Models tab.
    private static let curatedCatalog = CuratedOllamaCatalog.loadOrFail()

    static var curatedCategoryOrder: [String] { curatedCatalog.categoryOrder }
    static var curatedOllamaModels: [CuratedOllamaModel] { curatedCatalog.models }

    /// Best-effort brand detection for a model name/repo that isn't in the
    /// hand-curated list above — a Hugging Face repo path, a manually typed
    /// Ollama name, or an already-downloaded model. If the name resolves
    /// exactly to a curated entry, that entry's hand-checked `brand` is used
    /// instead of guessing. Otherwise the substring rules below are
    /// deliberately conservative (never guess when unsure) to avoid known
    /// false positives — e.g. "tinyllama"/"vicuna"/"orca-mini" contain
    /// enough of a hint to look Meta/Microsoft-affiliated but genuinely
    /// aren't official releases from those companies.
    static func guessBrand(forName rawName: String) -> ProviderBrand? {
        let name = rawName.lowercased()

        if let curated = curatedOllamaModels.first(where: { $0.name.lowercased() == name }) {
            return curated.brand
        }

        let neverGuess = ["tinyllama", "vicuna", "orca-mini", "wizardlm2-uncensored", "dolphin"]
        if neverGuess.contains(where: { name.contains($0) }) { return nil }

        // Checked before the generic "mistral" substring rule — these are
        // Mistral AI's own models but don't contain that substring.
        if name.contains("mixtral") || name.contains("codestral") || name.contains("devstral") || name.contains("magistral") {
            return .mistral
        }
        if name.contains("mistral") { return .mistral }
        if name.contains("llama") { return .meta }
        if name.contains("qwen") || name.contains("qwq") { return .qwen }
        if name.contains("gemma") || name.contains("gemini") { return .google }
        if name.contains("phi-3") || name.contains("phi-4") || name.contains("phi3") || name.contains("phi4") { return .microsoft }
        if name.contains("deepseek") { return .deepSeek }
        if name.contains("claude") { return .anthropic }
        if name.contains("gpt") { return .openAI }
        if name.contains("grok") { return .xAI }
        if name.contains("command-r") || name.contains("aya-") { return .cohere }
        if name.contains("granite") { return .ibm }
        if name.contains("falcon") { return .tii }
        if name.contains("olmo") { return .allenAI }
        if name.contains("exaone") { return .lg }
        if name.contains("solar") { return .upstage }
        if name.contains("stablelm") || name.contains("stable-code") { return .stabilityAI }
        if name.contains("nemotron") { return .nvidia }
        if name.contains("hermes") { return .nous }
        if name.contains("dbrx") { return .databricks }
        if name.contains("yi-") { return .zeroOneAI }
        if name.contains("ernie") { return .baidu }
        if name.contains("doubao") || name.contains("bytedance") { return .byteDance }

        return nil
    }

    /// Whether an Ollama-library name (with or without a tag) is already
    /// pulled locally.
    func isOllamaModelInstalled(_ name: String) -> Bool {
        let target = name.contains(":") ? name : name + ":latest"
        return ollamaModels.contains { $0.requestModelId == target || $0.requestModelId == name }
    }

    func installedOllamaModelId(_ name: String) -> String? {
        let target = name.contains(":") ? name : name + ":latest"
        return ollamaModels.first { $0.requestModelId == target || $0.requestModelId == name }?.id
    }

    /// The library page shows per-row progress; this tracks which model the
    /// single in-flight pull belongs to.
    private(set) var pullingModelName: String?

    // MARK: User models (llama.cpp / MLX)

    func addUserModel(backend: LocalBackend, source: String, isFile: Bool) {
        let trimmed = source.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return }
        let prefix = backend == .llamaCpp ? "llamacpp" : "mlx"
        let record = LocalModelRecord(
            id: "\(prefix):\(trimmed)",
            requestModelId: trimmed,
            backend: backend,
            displayName: isFile ? (trimmed as NSString).lastPathComponent : trimmed,
            // The repo id has to actually appear in `detail` for a non-file
            // entry — `downloadedModelId(forRepo:)`/`isHFRepoDownloaded`
            // both match by `detail.contains(repo)` (the only signal they
            // have, since `source` here is the repo string itself, not a
            // local path the way a completed GGUF download's is). The old
            // fixed generic string never matched, so an MLX repo added this
            // way could never be recognized as already-added anywhere else
            // in the app that checks those two functions.
            detail: isFile ? "GGUF file on this Mac" : "Downloads on first chat · \(trimmed)",
            source: trimmed,
            isFile: isFile
        )
        guard !userModels.contains(where: { $0.id == record.id }) else { return }
        userModels.append(record)
        persistUserModels()
    }

    /// Returns nil on success, or a user-facing reason when the on-disk
    /// cleanup didn't actually happen — the registry row is removed either
    /// way (the model disappears from the app regardless), but the caller
    /// can then tell the user their disk space was NOT freed instead of
    /// implying it was.
    @discardableResult
    func removeUserModel(id: String) -> String? {
        var failure: String?
        let record = userModels.first { $0.id == id }

        // Delete the file too, but ONLY if it lives in our own managed
        // downloads folder — never a file the user picked from elsewhere.
        if let record, record.isFile == true,
           let source = record.source, source.hasPrefix(Self.managedModelsDirectory.path) {
            try? FileManager.default.removeItem(atPath: source)
            if FileManager.default.fileExists(atPath: source) {
                failure = "The model file couldn't be deleted — it's still at \(source)."
            }
        }

        // An MLX model's weights don't live in our managed folder at all —
        // `mlx_lm.server` downloads them into Hugging Face's shared cache.
        // Deleting only the registry row silently left multi-GB snapshot
        // directories behind (the "says deleted but storage is unchanged"
        // class of bug). Remove exactly this model's own cache directory,
        // never anything else in the shared cache.
        if let record, record.backend == .mlx, record.isFile != true,
           let repo = record.source, repo.contains("/") {
            let cacheDir = FileManager.default.homeDirectoryForCurrentUser
                .appendingPathComponent(".cache/huggingface/hub/models--\(repo.replacingOccurrences(of: "/", with: "--"))", isDirectory: true)
            if FileManager.default.fileExists(atPath: cacheDir.path) {
                try? FileManager.default.removeItem(at: cacheDir)
                if FileManager.default.fileExists(atPath: cacheDir.path) {
                    failure = "The model's downloaded weights couldn't be deleted — they're still in \(cacheDir.path)."
                }
            }
        }

        userModels.removeAll { $0.id == id }
        if activeSpawned?.modelId == id { stopSpawnedServer() }
        persistUserModels()
        return failure
    }

    /// llama.cpp only — see `GPUOffloadMode`. Stops a currently-running
    /// server for this model so the next chat send respawns it with the
    /// new `-ngl` value instead of silently continuing to run under the
    /// old one until the app restarts.
    func setGPUMode(_ mode: GPUOffloadMode, for id: String) {
        updateLlamaSetting(for: id) { $0.gpuMode = mode }
    }

    /// llama.cpp only — see `LlamaContextSize`. Respawns on next send with
    /// the new `-c`, same as `setGPUMode`.
    func setContextSize(_ size: LlamaContextSize, for id: String) {
        updateLlamaSetting(for: id) { $0.contextSize = size }
    }

    /// llama.cpp only — see `FlashAttentionMode`. Respawns on next send with
    /// the new `-fa`, same as `setGPUMode`.
    func setFlashAttention(_ mode: FlashAttentionMode, for id: String) {
        updateLlamaSetting(for: id) { $0.flashAttention = mode }
    }

    /// Shared plumbing for the per-model llama.cpp run settings: mutate the
    /// record, stop any running server for it (so the next send respawns
    /// with the new flags rather than silently keeping the old ones until
    /// restart), and persist.
    private func updateLlamaSetting(for id: String, _ mutate: (inout LocalModelRecord) -> Void) {
        guard let index = userModels.firstIndex(where: { $0.id == id }), userModels[index].backend == .llamaCpp else { return }
        mutate(&userModels[index])
        if activeSpawned?.modelId == id { stopSpawnedServer() }
        persistUserModels()
    }

    private func loadUserModels() {
        guard let data = UserDefaults.standard.data(forKey: Self.userModelsKey),
              let decoded = try? JSONDecoder().decode([LocalModelRecord].self, from: data) else { return }
        userModels = decoded
    }

    private func persistUserModels() {
        if let encoded = try? JSONEncoder().encode(userModels) {
            UserDefaults.standard.set(encoded, forKey: Self.userModelsKey)
        }
    }

    // MARK: Catalog integration

    var allLocalModels: [LocalModelRecord] { ollamaModels + userModels }

    /// Stand-in `APIModel`s so local models flow through the same picker and
    /// chat plumbing as everything else. Excludes image-generation models
    /// (see `LocalModelRecord.isImageGeneration`) — those go through
    /// `imageSyntheticModels` instead, since `/api/chat` genuinely 400s on
    /// them ("does not support chat"), confirmed live.
    var syntheticModels: [APIModel] {
        allLocalModels
            .filter { $0.isImageGeneration != true }
            .map { APIModel(id: $0.id, name: $0.displayName, type: "text", tier: nil) }
    }

    /// The image-generation counterpart — local Ollama models tagged with
    /// the real `"image"` capability. Feeds `ChatViewModel.imageModels`.
    var imageSyntheticModels: [APIModel] {
        allLocalModels
            .filter { $0.isImageGeneration == true }
            .map { APIModel(id: $0.id, name: $0.displayName, type: "image", tier: nil) }
    }

    func record(withId id: String) -> LocalModelRecord? {
        allLocalModels.first { $0.id == id }
    }

    func owns(_ id: String) -> Bool {
        record(withId: id) != nil
    }

    // MARK: Readiness / server lifecycle

    /// Makes sure the backend serving this model is up, starting it if
    /// needed, and returns the OpenAI-compatible base URL to chat against.
    func ensureReady(for record: LocalModelRecord) async throws -> URL {
        switch record.backend {
        case .ollama:
            if await fetchOllamaTags() != nil {
                ollamaReachable = true
                return LocalBackend.ollama.baseURL
            }
            guard installed.contains(.ollama) else {
                throw LocalAIError.notInstalled(.ollama)
            }
            startupStatus = "Starting Ollama…"
            defer { startupStatus = nil }
            guard startManagedOllamaServe() else {
                throw LocalAIError.startFailed(.ollama, "couldn't launch `ollama serve`")
            }
            for _ in 0..<20 {
                try await Task.sleep(nanoseconds: 700_000_000)
                if await fetchOllamaTags() != nil {
                    ollamaReachable = true
                    Task { await refreshOllamaModels() }
                    return LocalBackend.ollama.baseURL
                }
            }
            throw LocalAIError.startFailed(.ollama, "the server didn't come up — try running `ollama serve` yourself")

        case .llamaCpp, .mlx:
            if let active = activeSpawned,
               active.modelId == record.id,
               spawnedProcess?.isRunning == true,
               await probeSpawnedReady(record.backend) {
                return record.backend.baseURL
            }
            try await startSpawnedServer(for: record)
            return record.backend.baseURL
        }
    }

    /// Launches `ollama serve` as a managed child when the app itself needs
    /// it. Returns false if the binary can't be found.
    @discardableResult
    func startManagedOllamaServe() -> Bool {
        if managedOllama?.isRunning == true { return true }
        guard let binary = resolveBinary("ollama") else { return false }

        let process = Process()
        process.executableURL = URL(fileURLWithPath: binary)
        process.arguments = ["serve"]
        attachLog(process, backend: .ollama)
        do {
            try process.run()
            managedOllama = process
            return true
        } catch {
            return false
        }
    }

    private func startSpawnedServer(for record: LocalModelRecord) async throws {
        stopSpawnedServer()
        guard let binary = resolveBinary(record.backend.binaryName) else {
            throw LocalAIError.notInstalled(record.backend)
        }

        isStartingServer = true
        startupStatus = (record.isFile ?? false) || record.backend == .ollama
            ? "Loading \(record.displayName)…"
            : "Starting \(record.backend.displayName) — first run downloads the model, which can take a while…"
        defer {
            isStartingServer = false
            startupStatus = nil
        }

        let process = Process()
        process.executableURL = URL(fileURLWithPath: binary)
        switch record.backend {
        case .llamaCpp:
            let source = record.source ?? ""
            let modelArgs = (record.isFile ?? false) ? ["-m", source] : ["-hf", source]
            // `.auto` omits the flag entirely — llama-server's own default
            // is already "auto" (fit to device memory), so leaving this
            // unset for anyone who's never touched the control changes
            // nothing about today's spawned command.
            let gpuArgs = (record.gpuMode ?? .auto).gpuLayersArgument.map { ["-ngl", $0] } ?? []
            // Pin the context window and use a single chat slot. Without
            // `-c`, llama-server allocates the model's *full trained*
            // context and splits it across 4 parallel slots — for a modern
            // model that's a 128K–256K KV cache. Measured live: a 0.8B GGUF
            // whose weights are ~0.5 GB pulled a 3072 MiB (3 GB) KV cache at
            // the 256K default; `-c 8192 -np 1` drops that to 96 MiB. On a
            // RAM-constrained Mac the 3 GB allocation swaps to disk and the
            // model "takes forever to respond" despite being tiny. The size
            // is user-tunable per model (see `LlamaContextSize`); `-np 1`
            // gives that whole window to the one chat rather than quartering
            // it.
            let context = record.contextSize ?? .defaultValue
            let contextArgs = ["-c", "\(context.tokens)", "-np", "1"]
            let flashArgs = (record.flashAttention ?? .auto).argument.map { ["-fa", $0] } ?? []
            // llama-server's default thread count uses EVERY core,
            // efficiency cores included — whenever any layers land on the
            // CPU (auto mode under GPU-memory pressure, or CPU-only mode),
            // that saturates the whole machine and the app itself janks
            // along with it. Pinning generation threads to the performance
            // cores is the standard Apple Silicon fix: same speed when the
            // GPU is doing the real work, and a responsive Mac when the
            // CPU is.
            let threadArgs = ["-t", "\(Self.performanceCoreCount)"]
            process.arguments = modelArgs + gpuArgs + contextArgs + flashArgs + threadArgs + ["--port", "\(LocalBackend.llamaCpp.port)", "--host", "127.0.0.1"]
        case .mlx:
            process.arguments = ["--model", record.source ?? "", "--port", "\(LocalBackend.mlx.port)", "--host", "127.0.0.1"]
        case .ollama:
            throw LocalAIError.startFailed(.ollama, "internal: ollama is not a spawned backend")
        }

        var environment = ProcessInfo.processInfo.environment
        let basePath = environment["PATH"] ?? "/usr/bin:/bin"
        environment["PATH"] = basePath + ":/opt/homebrew/bin:/usr/local/bin"
        process.environment = environment

        serverLogs[record.backend] = ""
        attachLog(process, backend: record.backend)

        do {
            try process.run()
        } catch {
            throw LocalAIError.startFailed(record.backend, error.localizedDescription)
        }
        spawnedProcess = process
        activeSpawned = (record.backend, record.id)

        // Poll until the server answers. Generous ceiling because a first
        // run may be downloading gigabytes — the process dying ends the wait
        // immediately with its log tail as the error.
        for _ in 0..<1800 {
            try Task.checkCancellation()
            if !process.isRunning {
                // 400 was too short: llama.cpp repeats the full model path
                // (often 100+ chars for an HF `<repo>__<file>.gguf` name)
                // two or three times in its last lines, which pushed the
                // one line that actually names the failure — "unknown model
                // architecture: 'x'", "invalid ggml type" — out of the
                // window entirely, leaving only the generic "failed to load
                // model" wrapper. 1500 keeps real headroom above that.
                let tail = String((serverLogs[record.backend] ?? "").suffix(1500))
                activeSpawned = nil
                throw LocalAIError.startFailed(record.backend, tail.isEmpty ? "the server exited immediately" : tail)
            }
            if await probeSpawnedReady(record.backend) {
                return
            }
            try await Task.sleep(nanoseconds: 1_000_000_000)
        }
        stopSpawnedServer()
        throw LocalAIError.startFailed(record.backend, "timed out waiting for the server to become ready")
    }

    private func probeSpawnedReady(_ backend: LocalBackend) async -> Bool {
        switch backend {
        case .llamaCpp:
            // llama-server: /health returns {"status":"ok"} once the model
            // is loaded (verified live on this machine).
            var request = URLRequest(url: URL(string: "http://127.0.0.1:\(backend.port)/health")!)
            request.timeoutInterval = 2
            guard let (data, response) = try? await URLSession.shared.data(for: request),
                  (response as? HTTPURLResponse)?.statusCode == 200 else { return false }
            return String(data: data, encoding: .utf8)?.contains("\"ok\"") == true
        case .mlx:
            // mlx_lm.server loads the model before listening — any HTTP
            // response at all means it's up.
            var request = URLRequest(url: URL(string: "http://127.0.0.1:\(backend.port)/v1/models")!)
            request.timeoutInterval = 2
            let result = try? await URLSession.shared.data(for: request)
            return result != nil
        case .ollama:
            return await fetchOllamaTags() != nil
        }
    }

    /// Real performance-core count via sysctl, falling back to half the
    /// active cores if the key is unavailable (pre-Apple-Silicon Macs have
    /// no perflevel split; half is a safe stand-in for "leave the system
    /// room to breathe").
    private static let performanceCoreCount: Int = {
        var count: Int32 = 0
        var size = MemoryLayout<Int32>.size
        if sysctlbyname("hw.perflevel0.physicalcpu", &count, &size, nil, 0) == 0, count > 0 {
            return Int(count)
        }
        return max(2, ProcessInfo.processInfo.activeProcessorCount / 2)
    }()

    private func attachLog(_ process: Process, backend: LocalBackend) {
        let pipe = Pipe()
        process.standardOutput = pipe
        process.standardError = pipe
        // Coalesced, NOT per-chunk: llama-server (and Ollama) log
        // continuously — model-load progress during startup, then slot/
        // request lines throughout every generation. The old handler hopped
        // to the main actor and mutated `serverLogs` (an @Observable
        // property) for EVERY chunk, so a chatty server meant a steady
        // stream of main-thread work and SwiftUI invalidations for the
        // whole time a local model was loading or answering — reported
        // live as the app "lagging pretty badly" while running a Hugging
        // Face model. Batching to 4 flushes/second changes nothing anyone
        // can see in a log view while cutting that churn by an order of
        // magnitude or more.
        let coalescer = ServerLogCoalescer { [weak self] chunk in
            guard let self else { return }
            var log = (self.serverLogs[backend] ?? "") + chunk
            if log.count > 6000 { log = String(log.suffix(6000)) }
            self.serverLogs[backend] = log
            if self.isStartingServer,
               let lastLine = chunk.split(separator: "\n").last.map(String.init),
               !lastLine.trimmingCharacters(in: .whitespaces).isEmpty {
                self.startupStatus = String(lastLine.prefix(120))
            }
        }
        pipe.fileHandleForReading.readabilityHandler = { handle in
            let data = handle.availableData
            guard !data.isEmpty, let text = String(data: data, encoding: .utf8) else { return }
            coalescer.ingest(text)
        }
        process.terminationHandler = { [weak self] _ in
            Task { @MainActor in
                pipe.fileHandleForReading.readabilityHandler = nil
                guard let self else { return }
                if self.spawnedProcess === process {
                    self.spawnedProcess = nil
                    self.activeSpawned = nil
                }
                if self.managedOllama === process {
                    self.managedOllama = nil
                }
            }
        }
    }

    func stopSpawnedServer() {
        if let process = spawnedProcess, process.isRunning {
            process.terminate()
        }
        spawnedProcess = nil
        activeSpawned = nil
    }

    /// Called on app quit — takes down whatever we started (never an Ollama
    /// server the user was already running themselves).
    func stopAllServers() {
        stopSpawnedServer()
        if let process = managedOllama, process.isRunning {
            process.terminate()
        }
        managedOllama = nil
    }
}

// MARK: - Errors

enum LocalAIError: LocalizedError {
    case notInstalled(LocalBackend)
    case startFailed(LocalBackend, String)

    var errorDescription: String? {
        switch self {
        case .notInstalled(let backend):
            return "\(backend.displayName) isn't installed on this Mac. Install it (\(backend.installCommand)) — see Settings → \(backend.displayName)."
        case .startFailed(let backend, let detail):
            // A model-load failure gets a plain-words headline BEFORE the
            // raw server output — seen live with a quantization llama.cpp
            // doesn't support yet ("invalid ggml type 42"), where the bare
            // stderr tail read as a wall of paths and told the user nothing
            // about what to actually do. The raw detail stays: it's what
            // makes the failure diagnosable.
            //
            // Unknown-architecture and bad-quantization are different
            // failures and need different advice: an unsupported ggml
            // tensor type can genuinely be a single bad quant, so "try
            // another quantization" is real advice — but an unrecognized
            // *architecture* (seen live with PrismML's "dspark", a
            // diffusion-style architecture llama.cpp has no code for at
            // all) means every file in that repo shares the same
            // architecture and will fail identically; telling someone to
            // pick a different quant there is false hope.
            if let architecture = Self.unsupportedArchitecture(in: detail) {
                return """
                \(backend.displayName) downloaded this model but can't run it — its architecture ("\(architecture)") isn't implemented in the \(backend.displayName) version on this Mac. This isn't a quantization problem: every file in this repo shares the same architecture, so a different quantization of the same model won't help. Pick a different model, or check back after updating \(backend.displayName) in case a later release adds support. You can remove this model in Settings → Models.

                Server output:
                \(detail)
                """
            }
            if detail.contains("failed to load model") || detail.contains("invalid ggml type") {
                return """
                \(backend.displayName) downloaded this model but couldn't load it — the file's format or quantization isn't supported by the \(backend.displayName) version on this Mac. This is a property of the model file itself, not a download error: try a different quantization of the same model (the sliders icon next to its download button), another model, or updating \(backend.displayName). You can remove this model in Settings → Models.

                Server output:
                \(detail)
                """
            }
            return "\(backend.displayName) couldn't start: \(detail)"
        }
    }

    /// Pulls the architecture name out of llama.cpp's
    /// `unknown model architecture: 'x'` line, if present.
    private static func unsupportedArchitecture(in detail: String) -> String? {
        guard let markerRange = detail.range(of: "unknown model architecture: '") else { return nil }
        let afterMarker = detail[markerRange.upperBound...]
        guard let endQuote = afterMarker.firstIndex(of: "'") else { return nil }
        return String(afterMarker[afterMarker.startIndex..<endQuote])
    }
}

/// Batches a spawned server's chatty stdout/stderr into at most ~4 UI
/// updates a second. The readability handler feeding `ingest` runs on a
/// background dispatch thread; the buffer lives behind this class's own
/// serial queue, and only the periodic flush hops to the main actor —
/// where `LocalAIManager.serverLogs` (an @Observable property SwiftUI
/// watches) actually gets touched. See `attachLog` for the live lag report
/// that motivated this.
private final class ServerLogCoalescer: @unchecked Sendable {
    private let queue = DispatchQueue(label: "dev.eaon.local-server-logs")
    private var buffer = ""
    private var flushScheduled = false
    private let onFlush: @MainActor (String) -> Void

    init(onFlush: @escaping @MainActor (String) -> Void) {
        self.onFlush = onFlush
    }

    func ingest(_ text: String) {
        queue.async {
            self.buffer += text
            // The main-actor side keeps only the last 6000 characters —
            // holding more than that here would be work thrown away at
            // flush time.
            if self.buffer.count > 8000 { self.buffer = String(self.buffer.suffix(8000)) }
            guard !self.flushScheduled else { return }
            self.flushScheduled = true
            self.queue.asyncAfter(deadline: .now() + 0.25) {
                let chunk = self.buffer
                self.buffer = ""
                self.flushScheduled = false
                guard !chunk.isEmpty else { return }
                let deliver = self.onFlush
                Task { @MainActor in deliver(chunk) }
            }
        }
    }
}
