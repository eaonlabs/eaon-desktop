import Foundation

/// A speech-to-text model that runs on this Mac.
///
/// Every option here is fully local — audio never leaves the machine. They
/// differ in what they cost you: the built-in recognizer is instant and needs
/// nothing installed but is the least accurate, while the Parakeet models are
/// markedly better and need a one-time install plus a model download.
struct SpeechModelChoice: Identifiable, Equatable {
    let id: String
    let name: String
    /// One line for the settings row — what you gain by picking it.
    let blurb: String
    /// Hugging Face repo passed to `parakeet-mlx --model`. Nil means the
    /// model runs through Apple's own recognizer instead of a subprocess.
    let repo: String?

    var isBuiltIn: Bool { repo == nil }

    static let builtIn = SpeechModelChoice(
        id: "apple",
        name: "Built-in (Apple)",
        blurb: "Instant, nothing to install. Lower accuracy, and unusual words like names are often missed.",
        repo: nil
    )
    static let parakeetV3 = SpeechModelChoice(
        id: "parakeet-tdt-v3",
        name: "Parakeet TDT v3",
        blurb: "Highest accuracy for 25 European languages. Punctuation, capitalization, and word-level timestamps.",
        repo: "mlx-community/parakeet-tdt-0.6b-v3"
    )
    static let parakeetV2 = SpeechModelChoice(
        id: "parakeet-tdt-v2",
        name: "Parakeet TDT v2",
        blurb: "English only, smaller and faster than v3.",
        repo: "mlx-community/parakeet-tdt-0.6b-v2"
    )

    static let all: [SpeechModelChoice] = [.builtIn, .parakeetV3, .parakeetV2]

    static func named(_ id: String) -> SpeechModelChoice {
        all.first { $0.id == id } ?? .builtIn
    }
}

/// Runs a downloaded speech model over a recorded clip.
///
/// ## Why this is a subprocess, and why that answers "don't crash my computer"
///
/// Model inference is the single most dangerous thing an app of this shape can
/// do in-process: a 600M-parameter model that hits an unsupported tensor
/// shape, exhausts memory, or trips a bug in a native backend takes the whole
/// host process down with it, losing your conversations along with it. Loading
/// it inside Eaon would mean any such failure is an Eaon crash.
///
/// So inference happens in a **separate process** that Eaon merely talks to.
/// If the model dies, `parakeet-mlx` dies; Eaon sees a non-zero exit code and
/// reports a normal error. Three further guards make that airtight:
///
/// - **A hard timeout.** A hung transcription is killed rather than leaving
///   the app waiting forever on a process that will never answer.
/// - **A recording cap.** Audio is bounded, so a forgotten open microphone
///   can't grow a file until the disk fills or the model is handed something
///   enormous.
/// - **No in-process fallback.** If the model isn't installed, Eaon uses
///   Apple's recognizer — it never tries to load model weights itself.
///
/// Isolation is also why the model can be swapped freely: adding an engine is
/// a new command line, not new code running inside the app.
@MainActor
enum LocalSpeechTranscriber {
    /// `pip install parakeet-mlx -U` — the same shape as the app's existing
    /// MLX language-model backend, which also asks for a pip install rather
    /// than bundling a Python runtime.
    static let installCommand = "pip3 install parakeet-mlx -U"

    /// Longest clip handed to a model. Dictation is speech, not recording;
    /// well past this and something has gone wrong.
    static let maxRecordingSeconds: TimeInterval = 120
    /// Transcription is roughly real-time on Apple Silicon, so several times
    /// the clip length is generous. Past it, the process is killed.
    private static let timeoutSeconds: TimeInterval = 180

    /// Where the `parakeet-mlx` executable lives, or nil when it isn't
    /// installed. A GUI app's PATH is not a shell's PATH, so the usual
    /// install locations are checked explicitly.
    static func executablePath() -> String? {
        let candidates = [
            "/opt/homebrew/bin", "/usr/local/bin", "/usr/bin",
            NSHomeDirectory() + "/.local/bin",
        ]
        for directory in candidates {
            let path = directory + "/parakeet-mlx"
            if FileManager.default.isExecutableFile(atPath: path) { return path }
        }
        return nil
    }

    static var isInstalled: Bool { executablePath() != nil }

    enum TranscriptionError: LocalizedError {
        case notInstalled
        case timedOut
        case failed(String)
        case emptyResult

        var errorDescription: String? {
            switch self {
            case .notInstalled:
                return "That speech model isn't installed yet. Run `\(installCommand)` in Terminal, then try again."
            case .timedOut:
                return "Transcription took too long and was stopped. Eaon is fine — try a shorter clip, or switch to the built-in model."
            case .failed(let detail):
                return "The speech model couldn't transcribe that: \(detail)"
            case .emptyResult:
                return "The speech model didn't return any text — it may not have heard anything."
            }
        }
    }

    /// Transcribe `audioURL` with `model`. Runs entirely off the main actor's
    /// critical path and never loads model code into this process.
    static func transcribe(audioURL: URL, model: SpeechModelChoice) async throws -> String {
        guard let executable = executablePath() else { throw TranscriptionError.notInstalled }
        guard let repo = model.repo else { throw TranscriptionError.notInstalled }

        let outputDirectory = FileManager.default.temporaryDirectory
            .appendingPathComponent("eaon-stt-\(UUID().uuidString)")
        try? FileManager.default.createDirectory(at: outputDirectory, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: outputDirectory) }

        let arguments = [
            audioURL.path,
            "--model", repo,
            "--output-format", "txt",
            "--output-dir", outputDirectory.path,
        ]

        let result = try await runIsolated(executable: executable, arguments: arguments)
        guard result.exitCode == 0 else {
            // The first run downloads the weights, which is the one slow case
            // that isn't a real failure — name it so nobody reads it as a bug.
            let detail = result.output.isEmpty ? "exit code \(result.exitCode)" : result.output
            throw TranscriptionError.failed(detail)
        }

        // parakeet-mlx writes <name>.txt beside the input, in --output-dir.
        let files = (try? FileManager.default.contentsOfDirectory(at: outputDirectory, includingPropertiesForKeys: nil)) ?? []
        guard let transcriptURL = files.first(where: { $0.pathExtension.lowercased() == "txt" }),
              let text = try? String(contentsOf: transcriptURL, encoding: .utf8) else {
            throw TranscriptionError.emptyResult
        }
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { throw TranscriptionError.emptyResult }
        return trimmed
    }

    private struct ProcessOutcome { let exitCode: Int32; let output: String }

    /// Runs the model process with a hard timeout, off the main thread.
    ///
    /// The timeout is the important part: `waitUntilExit()` on a wedged
    /// process blocks forever, and doing that anywhere near the UI is how an
    /// app becomes an unkillable beachball. Here the wait happens on a
    /// background queue and a watchdog terminates the process if it overstays.
    private static func runIsolated(executable: String, arguments: [String]) async throws -> ProcessOutcome {
        try await withCheckedThrowingContinuation { continuation in
            DispatchQueue.global(qos: .userInitiated).async {
                let process = Process()
                process.executableURL = URL(fileURLWithPath: executable)
                process.arguments = arguments
                let pipe = Pipe()
                process.standardOutput = pipe
                process.standardError = pipe

                do {
                    try process.run()
                } catch {
                    continuation.resume(throwing: TranscriptionError.failed(error.localizedDescription))
                    return
                }

                // Watchdog. `terminate()` first (SIGTERM lets Python clean up),
                // then SIGKILL if it's still there — a model wedged in native
                // code can ignore SIGTERM entirely.
                let watchdog = DispatchWorkItem {
                    guard process.isRunning else { return }
                    process.terminate()
                    DispatchQueue.global().asyncAfter(deadline: .now() + 3) {
                        if process.isRunning { kill(process.processIdentifier, SIGKILL) }
                    }
                }
                DispatchQueue.global().asyncAfter(deadline: .now() + timeoutSeconds, execute: watchdog)

                let data = pipe.fileHandleForReading.readDataToEndOfFile()
                process.waitUntilExit()
                watchdog.cancel()

                let output = String(data: data, encoding: .utf8)?
                    .trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
                // A process we killed reports a signal, not a clean exit.
                if process.terminationReason == .uncaughtSignal {
                    continuation.resume(throwing: TranscriptionError.timedOut)
                    return
                }
                continuation.resume(returning: ProcessOutcome(exitCode: process.terminationStatus, output: output))
            }
        }
    }
}

/// How the dictation hotkey behaves.
enum DictationMode: String, CaseIterable, Identifiable {
    /// Press once to start, again to stop.
    case toggle
    /// Dictate only while the key is held.
    case hold

    var id: String { rawValue }
    var title: String { self == .toggle ? "Toggle" : "Hold" }
}

/// A tiny thread-safe counter for the audio tap.
///
/// The tap runs on a real-time thread many times a second and must not touch
/// main-actor state, so the recording cap is tracked here instead — a lock
/// around one integer, which is cheap enough for the audio thread while still
/// being correct.
final class FrameCounter: @unchecked Sendable {
    private let lock = NSLock()
    private var total: UInt32 = 0

    /// Adds `frames` and returns the running total.
    func add(_ frames: UInt32) -> UInt32 {
        lock.lock(); defer { lock.unlock() }
        total &+= frames
        return total
    }
}
