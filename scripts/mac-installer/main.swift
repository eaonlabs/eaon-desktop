// Install Eaon Beta: puts the Eaon build inside this app (Contents/Resources/Eaon.app)
// in place of the Eaon already on the Mac — found, quit, replaced, reopened — so
// nobody has to uninstall anything first. Chats, settings and keys live in
// ~/Library/Application Support/Eaon and the keychain, so they stay.
//
// Built and signed by scripts/build-mac-installer.sh. For testing from a terminal:
//   --dry-run        say what would be replaced, change nothing
//   --target <path>  replace this app instead of the one found
//   --yes            no dialogs (prints instead)
//   --no-open        don't open Eaon afterwards
import AppKit

let bundleID = "dev.eaon.desktop"
let teamID = "W9MHT9V982"
let warning = "UPDATE IF YOU WANT YOUR APP TO BE UNSTABLE, BETA UPDATE ONLY"

struct Options {
  var target: URL?
  var yes = false
  var dryRun = false
  var open = true
}

func parseOptions() -> Options {
  var options = Options()
  var args = CommandLine.arguments.dropFirst().makeIterator()
  while let arg = args.next() {
    switch arg {
    case "--target": if let path = args.next() { options.target = URL(fileURLWithPath: path) }
    case "--yes": options.yes = true
    case "--dry-run": options.dryRun = true
    case "--no-open": options.open = false
    default: break // Finder adds -psn_… on old systems
    }
  }
  return options
}

struct Failure: Error { let message: String }

func appVersion(of app: URL) -> String? {
  (NSDictionary(contentsOf: app.appendingPathComponent("Contents/Info.plist")) as? [String: Any])?["CFBundleShortVersionString"] as? String
}

func identifier(of app: URL) -> String? {
  (NSDictionary(contentsOf: app.appendingPathComponent("Contents/Info.plist")) as? [String: Any])?["CFBundleIdentifier"] as? String
}

@discardableResult
func run(_ tool: String, _ arguments: [String]) throws -> String {
  let process = Process()
  process.executableURL = URL(fileURLWithPath: tool)
  process.arguments = arguments
  let pipe = Pipe()
  process.standardOutput = pipe
  process.standardError = pipe
  try process.run()
  let data = pipe.fileHandleForReading.readDataToEndOfFile()
  process.waitUntilExit()
  let output = String(data: data, encoding: .utf8) ?? ""
  if process.terminationStatus != 0 { throw Failure(message: output.trimmingCharacters(in: .whitespacesAndNewlines)) }
  return output
}

/// An app somewhere it can be replaced: not on a disk image, not a translocated
/// copy macOS runs from a random folder, and not the copy inside this installer.
func replaceable(_ url: URL) -> Bool {
  let path = url.resolvingSymlinksInPath().path
  return !path.hasPrefix("/Volumes/") && !path.contains("/AppTranslocation/") && !path.hasPrefix(Bundle.main.bundleURL.resolvingSymlinksInPath().path)
    && identifier(of: url) == bundleID
}

/// The Eaon to replace: the one running, else Eaon.app in Applications, else
/// the one macOS opens for Eaon. nil: none is installed.
func findInstalled() -> URL? {
  for app in NSRunningApplication.runningApplications(withBundleIdentifier: bundleID) {
    if let url = app.bundleURL, replaceable(url) { return url }
  }
  let home = FileManager.default.homeDirectoryForCurrentUser
  for url in [URL(fileURLWithPath: "/Applications/Eaon.app"), home.appendingPathComponent("Applications/Eaon.app")] where replaceable(url) {
    return url
  }
  if let url = NSWorkspace.shared.urlForApplication(withBundleIdentifier: bundleID), replaceable(url) { return url }
  return nil
}

func running(at target: URL) -> [NSRunningApplication] {
  NSRunningApplication.runningApplications(withBundleIdentifier: bundleID).filter {
    $0.bundleURL?.resolvingSymlinksInPath().path == target.resolvingSymlinksInPath().path
  }
}

/// The payload must be Eaon signed by Eaon's team, whole and unmodified.
func verify(_ app: URL) throws {
  do {
    try run("/usr/bin/codesign", ["--verify", "--deep", "--strict", "-R=anchor apple generic and certificate leaf[subject.OU] = \"\(teamID)\"", app.path])
  } catch let failure as Failure {
    throw Failure(message: "The Eaon inside this installer isn't intact (\(failure.message)). Download the installer again.")
  }
}

func shellQuote(_ s: String) -> String { "'" + s.replacingOccurrences(of: "'", with: "'\\''") + "'" }

/// Copies the payload beside the target, then swaps it in. A copy that fails
/// halfway leaves the old Eaon as it was.
func install(_ payload: URL, over target: URL) throws {
  let folder = target.deletingLastPathComponent()
  let staging = folder.appendingPathComponent(".Eaon-installing-\(getpid()).app")
  let fm = FileManager.default
  if !fm.isWritableFile(atPath: folder.path) || !canReplace(target) { return try installAsAdmin(payload, over: target) }
  do {
    try? fm.removeItem(at: staging)
    try run("/usr/bin/ditto", [payload.path, staging.path])
    // Installed by the user's own choice, as a .pkg would be: without the
    // quarantine flag, macOS would run it from a translocated read-only copy
    // that can't update itself.
    _ = try? run("/usr/bin/xattr", ["-dr", "com.apple.quarantine", staging.path])
    if fm.fileExists(atPath: target.path) {
      _ = try fm.replaceItemAt(target, withItemAt: staging)
    } else {
      try fm.moveItem(at: staging, to: target)
    }
  } catch {
    try? fm.removeItem(at: staging)
    throw error
  }
}

/// Whether this user can take the old Eaon apart: it has to be removed once the new one is in.
func canReplace(_ target: URL) -> Bool {
  let fm = FileManager.default
  guard fm.fileExists(atPath: target.path) else { return true }
  return fm.isWritableFile(atPath: target.path) && fm.isWritableFile(atPath: target.appendingPathComponent("Contents").path)
}

/// The same steps with an administrator's password, for an Eaon the user can't
/// change (installed by another account). The new copy belongs to this user, so
/// it can update itself afterwards.
func installAsAdmin(_ payload: URL, over target: URL) throws {
  let staging = target.deletingLastPathComponent().appendingPathComponent(".Eaon-installing-\(getpid()).app").path
  let old = target.deletingLastPathComponent().appendingPathComponent(".Eaon-old-\(getpid()).app").path
  let (p, t, s, o) = (shellQuote(payload.path), shellQuote(target.path), shellQuote(staging), shellQuote(old))
  let script = [
    "set -e", "/bin/rm -rf \(s) \(o)", "/usr/bin/ditto \(p) \(s)", "/usr/bin/xattr -dr com.apple.quarantine \(s) || true",
    "/usr/sbin/chown -R \(shellQuote(NSUserName())) \(s)",
    "if [ -e \(t) ]; then /bin/mv \(t) \(o); fi", "/bin/mv \(s) \(t)", "/bin/rm -rf \(o)"
  ].joined(separator: "; ")
  let escaped = script.replacingOccurrences(of: "\\", with: "\\\\").replacingOccurrences(of: "\"", with: "\\\"")
  do {
    try run("/usr/bin/osascript", ["-e", "do shell script \"\(escaped)\" with prompt \"Install Eaon Beta needs to replace Eaon.\" with administrator privileges"])
  } catch let failure as Failure {
    throw Failure(message: failure.message.contains("-128") ? "Cancelled. Eaon wasn't changed." : "Eaon couldn't be replaced: \(failure.message)")
  }
}

final class Installer: NSObject, NSApplicationDelegate {
  let options = parseOptions()
  var panel: NSPanel?

  func say(_ title: String, _ detail: String, style: NSAlert.Style = .informational, buttons: [String] = ["OK"]) -> Int {
    if options.yes {
      print("\(title)\n\(detail)")
      return 0
    }
    NSApp.activate(ignoringOtherApps: true)
    let alert = NSAlert()
    alert.alertStyle = style
    alert.messageText = title
    alert.informativeText = detail
    for button in buttons { alert.addButton(withTitle: button) }
    if buttons.count > 1 { alert.buttons.last?.keyEquivalent = "\u{1b}" }
    return alert.runModal().rawValue - NSApplication.ModalResponse.alertFirstButtonReturn.rawValue
  }

  func finish(_ code: Int32) {
    panel?.close()
    exit(code)
  }

  func applicationDidFinishLaunching(_ notification: Notification) {
    let payload = Bundle.main.resourceURL!.appendingPathComponent("Eaon.app")
    guard let newVersion = appVersion(of: payload) else {
      _ = say("This installer is incomplete", "It has no Eaon inside it. Download it again.", style: .critical)
      return finish(1)
    }
    let found = options.target ?? findInstalled()
    let target = found ?? URL(fileURLWithPath: "/Applications/Eaon.app")
    let oldVersion = found.flatMap(appVersion(of:))

    if options.dryRun {
      print("payload: \(newVersion)\ntarget: \(target.path)\ninstalled: \(oldVersion ?? "none")\nrunning: \(!running(at: target).isEmpty)")
      return finish(0)
    }

    let what = oldVersion.map { "Eaon \($0) is installed at \(target.path). This replaces it with Eaon \(newVersion)" }
      ?? "Eaon isn't installed yet. This installs Eaon \(newVersion) in Applications"
    let answer = say(warning, """
      \(what), a beta. It can crash, behave oddly or lose work, and it is meant for testing, not for everyday use.

      Your chats, settings and keys stay. The beta updates them in place, so if they matter, copy ~/Library/Application Support/Eaon first.

      To go back later: Settings → General → Switch to stable.
      """, style: .warning, buttons: ["Install Beta", "Cancel"])
    if answer != 0 { return finish(0) }

    // Eaon has to be closed to be replaced; it's asked to quit like any app,
    // so anything it wants to ask first (work in progress) it can.
    while !running(at: target).isEmpty {
      running(at: target).forEach { $0.terminate() }
      let deadline = Date().addingTimeInterval(20)
      while !running(at: target).isEmpty && Date() < deadline { RunLoop.current.run(until: Date().addingTimeInterval(0.25)) }
      if running(at: target).isEmpty { break }
      if options.yes || say("Eaon is still open", "Quit Eaon (it may be asking you something), then choose Try Again.", buttons: ["Try Again", "Cancel"]) != 0 {
        return finish(1)
      }
    }

    showProgress("Installing Eaon \(newVersion)…")
    DispatchQueue.global(qos: .userInitiated).async {
      var failure: String?
      do {
        try verify(payload)
        try install(payload, over: target)
        if appVersion(of: target) != newVersion { throw Failure(message: "Eaon \(newVersion) didn't end up at \(target.path).") }
      } catch let error as Failure {
        failure = error.message
      } catch {
        failure = error.localizedDescription
      }
      DispatchQueue.main.async { self.done(target: target, version: newVersion, failure: failure) }
    }
  }

  func done(target: URL, version: String, failure: String?) {
    panel?.close()
    if let failure {
      _ = say("Eaon wasn't installed", failure, style: .critical)
      return finish(1)
    }
    if options.open {
      let configuration = NSWorkspace.OpenConfiguration()
      NSWorkspace.shared.openApplication(at: target, configuration: configuration) { _, _ in
        DispatchQueue.main.async { self.finish(0) }
      }
      if options.yes { print("Installed Eaon \(version) at \(target.path)") }
    } else {
      if options.yes { print("Installed Eaon \(version) at \(target.path)") }
      else { _ = say("Eaon \(version) is installed", "It's in \(target.deletingLastPathComponent().path).") }
      finish(0)
    }
  }

  func showProgress(_ text: String) {
    if options.yes { return }
    let panel = NSPanel(contentRect: NSRect(x: 0, y: 0, width: 340, height: 90), styleMask: [.titled], backing: .buffered, defer: false)
    panel.title = "Install Eaon Beta"
    let label = NSTextField(labelWithString: text)
    label.frame = NSRect(x: 20, y: 50, width: 300, height: 20)
    let bar = NSProgressIndicator(frame: NSRect(x: 20, y: 22, width: 300, height: 16))
    bar.isIndeterminate = true
    bar.startAnimation(nil)
    panel.contentView?.addSubview(label)
    panel.contentView?.addSubview(bar)
    panel.center()
    panel.makeKeyAndOrderFront(nil)
    self.panel = panel
  }
}

let app = NSApplication.shared
let delegate = Installer()
app.delegate = delegate
app.setActivationPolicy(.regular)
app.run()
