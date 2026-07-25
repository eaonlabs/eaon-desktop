import AVFoundation
import Foundation

/// Which engine actually produces the pet's voice.
enum EaonSpeechEngine: String, CaseIterable, Identifiable, Codable {
    /// `AVSpeechSynthesizer` — always available, zero setup, but limited to
    /// the voices macOS has installed. On a stock Mac those are all the
    /// `compact`/`super-compact` ones, which is why people describe it as
    /// robotic (measured on a clean machine: 180 voices, every one `default`
    /// quality). Downloading Apple's free Premium voices fixes most of that.
    case system
    /// **Kokoro-82M** running locally through `mlx-audio` on Apple Silicon —
    /// an actual neural TTS model, and the reason this option exists: it
    /// sounds like a person rather than a speech synthesiser. Apache-2.0,
    /// ~600MB resident, faster than real time on an M-series chip, and
    /// entirely on-device, so it keeps the app's no-cloud promise intact.
    case kokoro

    var id: String { rawValue }

    var title: String {
        switch self {
        case .system: return "System voice (built into macOS)"
        case .kokoro: return "Kokoro — neural, human-sounding (local)"
        }
    }
}

/// Kokoro-82M speech, served locally by `mlx-audio`.
///
/// This deliberately mirrors how `LocalAIManager` already handles the MLX
/// language-model backend — the user pip-installs a package, the app spawns
/// a localhost server and talks HTTP to it — rather than inventing a second
/// convention for the same problem. Nothing leaves the machine either way.
///
/// Not bundled, for two honest reasons: it's a Python package with heavy
/// native dependencies that would balloon the app and break under every
/// Python version mismatch, and Apple Silicon is required for the MLX
/// acceleration that makes it fast enough to speak in real time.
@MainActor
final class KokoroSpeech: NSObject {
    static let shared = KokoroSpeech()

    static let installCommand = "pip3 install mlx-audio"
    static let defaultModel = "mlx-community/Kokoro-82M-bf16"
    /// A representative slice of Kokoro's 54 presets — the English ones, which
    /// are the ones worth offering in a picker. `af_`/`am_` are American
    /// female/male, `bf_`/`bm_` British.
    static let voices: [(id: String, label: String)] = [
        ("af_heart", "Heart — American female, warm"),
        ("af_bella", "Bella — American female, bright"),
        ("af_nova", "Nova — American female, neutral"),
        ("af_sky", "Sky — American female, light"),
        ("am_adam", "Adam — American male, steady"),
        ("am_echo", "Echo — American male, soft"),
        ("bf_alice", "Alice — British female"),
        ("bf_emma", "Emma — British female, warm"),
        ("bm_daniel", "Daniel — British male"),
        ("bm_george", "George — British male, deep"),
    ]

    private static let port = 8765
    private var server: Process?
    private var player: AVAudioPlayer?
    private var onFinish: (() -> Void)?

    /// Whether `mlx_audio.server` is on this Mac at all — the same "does the
    /// binary exist" check `LocalBackend.binaryName` performs.
    static var isInstalled: Bool {
        resolvedServerPath() != nil
    }

    private static func resolvedServerPath() -> String? {
        // Homebrew, framework Python, and pipx all put console scripts in
        // different places, and a GUI app's PATH is not a shell's PATH.
        let candidates = [
            "/opt/homebrew/bin", "/usr/local/bin", "/usr/bin",
            NSHomeDirectory() + "/.local/bin",
        ]
        for directory in candidates {
            let path = directory + "/mlx_audio.server"
            if FileManager.default.isExecutableFile(atPath: path) { return path }
        }
        return nil
    }

    /// Boots the local server if it isn't already up. Idempotent.
    func ensureServerRunning() {
        guard server == nil || server?.isRunning != true else { return }
        guard let path = Self.resolvedServerPath() else { return }
        let process = Process()
        process.executableURL = URL(fileURLWithPath: path)
        process.arguments = ["--host", "127.0.0.1", "--port", "\(Self.port)"]
        // Silenced: the server is chatty on stdout and none of it belongs in
        // the app's own output.
        process.standardOutput = FileHandle.nullDevice
        process.standardError = FileHandle.nullDevice
        do {
            try process.run()
            server = process
        } catch {
            server = nil
        }
    }

    func stopServer() {
        server?.terminate()
        server = nil
    }

    /// Synthesize one utterance. Returns audio bytes, or nil if the server
    /// isn't reachable — callers fall back to the system voice rather than
    /// going silent, so a half-configured Kokoro never costs you the reply.
    func synthesize(_ text: String, voice: String) async -> Data? {
        ensureServerRunning()
        guard let url = URL(string: "http://127.0.0.1:\(Self.port)/v1/audio/speech") else { return nil }
        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.timeoutInterval = 60
        request.addValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = try? JSONSerialization.data(withJSONObject: [
            "model": Self.defaultModel,
            "input": text,
            "voice": voice,
        ])
        // The server loads a ~600MB model on its first request, so the first
        // line the pet ever speaks is slow; everything after is warm.
        guard let (data, response) = try? await URLSession.shared.data(for: request),
              (response as? HTTPURLResponse)?.statusCode == 200,
              !data.isEmpty else { return nil }
        return data
    }

    /// Play synthesized audio, calling `completion` when it finishes — the
    /// same contract `AVSpeechSynthesizerDelegate` gives the system engine,
    /// so the voice loop's state machine doesn't care which one is speaking.
    func play(_ data: Data, completion: @escaping () -> Void) {
        stopPlayback()
        do {
            let player = try AVAudioPlayer(data: data)
            player.delegate = self
            onFinish = completion
            self.player = player
            player.play()
        } catch {
            completion()
        }
    }

    func stopPlayback() {
        player?.stop()
        player = nil
        onFinish = nil
    }

    var isPlaying: Bool { player?.isPlaying == true }
}

extension KokoroSpeech: AVAudioPlayerDelegate {
    nonisolated func audioPlayerDidFinishPlaying(_ player: AVAudioPlayer, successfully flag: Bool) {
        Task { @MainActor in
            let finish = self.onFinish
            self.onFinish = nil
            self.player = nil
            finish?()
        }
    }
}
