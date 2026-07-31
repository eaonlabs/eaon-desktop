import Foundation

/// Long-running commands the agent starts and then checks on.
///
/// ## The gap this closes
///
/// `run_shell` waits for the command and kills it at 60 seconds, which is
/// right for `swift build` and wrong for everything a real coding session
/// actually needs to keep alive: `npm run dev`, `python -m http.server`,
/// `vite`, `cargo watch`, a test suite in watch mode. The old system prompt
/// simply told the model not to try — "don't launch long-running servers" —
/// so the loop could write a web app and then had no way to *look* at it.
/// An agent that can't start a server can't check its own work on anything
/// with a front end.
///
/// A background job here is started, left running, and polled: `run_shell`
/// with `background: true` returns immediately with a job id, `check_output`
/// reads whatever it has printed so far, and `stop_process` ends it.
///
/// ## Why output goes to a file, not a pipe
///
/// A `Pipe` has a fixed OS buffer (typically 64KB). A dev server that logs
/// steadily fills it, and the child then blocks forever on its next write
/// because nobody is draining the read end — the classic way a "background"
/// process silently freezes. Draining it needs a reader thread per job,
/// which then needs its own synchronisation to be readable from anywhere.
/// A file has neither problem: the kernel handles the writes, the process
/// never blocks, and any reader can open it at any time and read as much or
/// as little as it wants.
///
/// ## Lifetime
///
/// Jobs are the session's, not the app's: `stopAll()` runs at quit, so a
/// forgotten dev server doesn't outlive the app that started it and hold a
/// port hostage until the user goes looking in Activity Monitor.
final class BackgroundJobs: @unchecked Sendable {
    static let shared = BackgroundJobs()

    struct Job {
        let id: String
        let command: String
        let workingDirectory: String
        let logURL: URL
        let startedAt: Date
        var exitCode: Int32?
        /// Set when the job was ended by `stop_process` rather than
        /// finishing on its own, so "exited" and "you stopped it" don't read
        /// the same in the output.
        var wasStopped = false

        var isRunning: Bool { exitCode == nil }
    }

    /// Enough for a dev server, an API, a watcher and a test runner at once.
    /// Past that, something has gone wrong with the loop rather than the
    /// user needing a fifth process.
    private static let maxConcurrent = 6
    /// Most recent output is what matters when checking on a server — the
    /// startup banner is long since irrelevant once it's serving.
    private static let defaultTailCharacters = 6_000

    private let lock = NSLock()
    private var jobs: [String: Job] = [:]
    private var processes: [String: Process] = [:]
    private var nextNumber = 1

    private init() {}

    // MARK: - Starting

    enum StartOutcome {
        case started(id: String, logPath: String)
        case failed(reason: String)
    }

    func start(command: String, workingDirectory: String) -> StartOutcome {
        lock.lock()
        let runningCount = jobs.values.filter(\.isRunning).count
        let id = "job-\(nextNumber)"
        nextNumber += 1
        lock.unlock()

        guard runningCount < Self.maxConcurrent else {
            return .failed(reason: "\(Self.maxConcurrent) background jobs are already running. Stop one with stop_process before starting another.")
        }

        let logURL = FileManager.default.temporaryDirectory
            .appendingPathComponent("eaon-\(id)-\(UUID().uuidString.prefix(8)).log")
        guard FileManager.default.createFile(atPath: logURL.path, contents: nil) else {
            return .failed(reason: "Couldn't create a log file for the job.")
        }
        guard let handle = FileHandle(forWritingAtPath: logURL.path) else {
            return .failed(reason: "Couldn't open the job's log file for writing.")
        }

        let process = Process()
        process.executableURL = URL(fileURLWithPath: "/bin/zsh")
        process.arguments = ["-c", command]
        process.currentDirectoryURL = URL(fileURLWithPath: workingDirectory)
        process.standardOutput = handle
        process.standardError = handle
        // Never a terminal: a background job that stops to ask something has
        // nobody to answer it, and would hang until it was stopped.
        process.standardInput = FileHandle.nullDevice

        var environment = ProcessInfo.processInfo.environment
        let basePath = environment["PATH"] ?? "/usr/bin:/bin"
        environment["PATH"] = basePath + ":/opt/homebrew/bin:/usr/local/bin"
        process.environment = environment

        process.terminationHandler = { [weak self] finished in
            try? handle.close()
            guard let self else { return }
            self.lock.lock()
            self.jobs[id]?.exitCode = finished.terminationStatus
            self.processes[id] = nil
            self.lock.unlock()
        }

        do {
            try process.run()
        } catch {
            try? handle.close()
            return .failed(reason: error.localizedDescription)
        }

        lock.lock()
        jobs[id] = Job(
            id: id,
            command: command,
            workingDirectory: workingDirectory,
            logURL: logURL,
            startedAt: Date()
        )
        processes[id] = process
        lock.unlock()

        return .started(id: id, logPath: logURL.path)
    }

    // MARK: - Checking on

    /// The tail of a job's output plus its current state. `nil` when there's
    /// no such job.
    func report(id: String, tailCharacters: Int? = nil) -> String? {
        lock.lock()
        let job = jobs[id]
        lock.unlock()
        guard let job else { return nil }

        let raw = (try? String(contentsOf: job.logURL, encoding: .utf8)) ?? ""
        let limit = tailCharacters ?? Self.defaultTailCharacters
        let body: String
        if raw.count > limit {
            body = "…(earlier output trimmed)\n" + String(raw.suffix(limit))
        } else {
            body = raw
        }

        let elapsed = Int(Date().timeIntervalSince(job.startedAt))
        let state: String
        if job.isRunning {
            state = "still running (\(elapsed)s)"
        } else if job.wasStopped {
            state = "stopped by you after \(elapsed)s"
        } else {
            state = "exited with code \(job.exitCode ?? 0) after \(elapsed)s"
        }

        let header = "\(job.id): `\(job.command)` — \(state)"
        return body.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
            ? header + "\n(no output yet)"
            : header + "\n\n" + body
    }

    /// One line per job, for when the model has lost track of what it started.
    func summaryList() -> String {
        lock.lock()
        let all = jobs.values.sorted { $0.startedAt < $1.startedAt }
        lock.unlock()
        guard !all.isEmpty else { return "No background jobs have been started." }
        return all.map { job in
            let state = job.isRunning ? "running" : (job.wasStopped ? "stopped" : "exited \(job.exitCode ?? 0)")
            return "\(job.id) [\(state)] \(job.command)"
        }.joined(separator: "\n")
    }

    // MARK: - Stopping

    enum StopOutcome {
        case stopped
        case alreadyFinished
        case notFound
    }

    /// SIGTERM first so a server can close its listeners, SIGKILL shortly
    /// after for anything wedged in native code that ignores it — the same
    /// escalation the speech-model subprocess uses, and for the same reason:
    /// "stop" has to actually mean stopped.
    @discardableResult
    func stop(id: String) -> StopOutcome {
        lock.lock()
        let job = jobs[id]
        let process = processes[id]
        if jobs[id] != nil { jobs[id]?.wasStopped = true }
        lock.unlock()

        guard job != nil else { return .notFound }
        guard let process, process.isRunning else { return .alreadyFinished }

        process.terminate()
        let pid = process.processIdentifier
        DispatchQueue.global().asyncAfter(deadline: .now() + 2) {
            if process.isRunning { kill(pid, SIGKILL) }
        }
        return .stopped
    }

    /// Called at app quit. Nothing the agent started should outlive the app.
    func stopAll() {
        lock.lock()
        let running = processes
        lock.unlock()
        for (_, process) in running where process.isRunning {
            process.terminate()
        }
    }

    var runningCount: Int {
        lock.lock(); defer { lock.unlock() }
        return jobs.values.filter(\.isRunning).count
    }
}
