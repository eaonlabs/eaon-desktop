import Foundation

/// Driving a real web browser — reading a page, scrolling it, clicking things,
/// filling fields — as first-class tools rather than "write the AppleScript
/// yourself".
///
/// Why this exists: the agent could already call `run_applescript`, and in
/// theory that's enough. In practice it wasn't. Controlling Chrome from
/// AppleScript means embedding JavaScript inside an AppleScript string, so the
/// model has to emit correctly double-escaped quotes (`\\"` nested inside
/// `\\"`) inside a JSON tool argument — three layers of escaping, hand-written,
/// every single call. Smaller models get it wrong nearly every time, and the
/// failure is a syntax error rather than anything they can recover from.
/// Worse, the system prompt promised the model it could "click, scroll and
/// fill forms" while never showing it *how* to scroll, because there was no
/// scroll capability at all.
///
/// So the escaping lives here, in Swift, written once and correct. The model
/// says "scroll down" or "click Sign in" and this composes the script.
///
/// ## The two permissions, and why scrolling deliberately avoids one
///
/// - **Automation** (System Settings → Privacy & Security → Automation) is
///   needed to talk to Chrome/Safari at all. macOS prompts for it once.
/// - **"Allow JavaScript from Apple Events"** is a hidden per-browser
///   developer setting needed to read page text, click, or type. Almost
///   nobody has it on, and it can't be enabled programmatically.
///
/// Scrolling therefore does NOT use JavaScript. It sends real Page Down /
/// Page Up key events through System Events, which needs only Accessibility —
/// so the single most common browsing action works without asking anyone to
/// dig through a Develop menu. Reading and clicking still need the JS setting,
/// and say so plainly when it's off instead of failing silently.
@MainActor
enum BrowserControl {
    /// A browser this can drive. Chromium-family browsers all share Chrome's
    /// AppleScript dictionary (`active tab of front window`, `execute ...
    /// javascript`), so supporting them is a naming question, not a protocol
    /// one — verified live against Comet, which answered a Chrome-style tab
    /// query correctly.
    ///
    /// This list matters more than it looks. The original code hardcoded
    /// "Google Chrome" and "Safari", so for anyone browsing in Comet, Brave,
    /// Edge, Arc or Vivaldi every browser tool silently addressed an app that
    /// wasn't running and appeared to do nothing at all.
    struct Browser: Equatable {
        let appName: String
        /// Safari's scripting differs enough to need its own phrasing.
        let isSafari: Bool
    }

    static let known: [Browser] = [
        Browser(appName: "Google Chrome", isSafari: false),
        Browser(appName: "Comet", isSafari: false),
        Browser(appName: "Brave Browser", isSafari: false),
        Browser(appName: "Microsoft Edge", isSafari: false),
        Browser(appName: "Arc", isSafari: false),
        Browser(appName: "Vivaldi", isSafari: false),
        Browser(appName: "Chromium", isSafari: false),
        Browser(appName: "Opera", isSafari: false),
        Browser(appName: "Safari", isSafari: true),
    ]

    /// Resolve an optional user/model-supplied name. Nil means "whatever the
    /// user is actually looking at" rather than a guess.
    static func resolve(_ raw: String?) -> Browser? {
        guard let raw = raw?.trimmingCharacters(in: .whitespaces).lowercased(), !raw.isEmpty else { return nil }
        if let exact = known.first(where: { $0.appName.lowercased() == raw }) { return exact }
        return known.first { $0.appName.lowercased().contains(raw) || raw.contains($0.appName.lowercased()) }
    }

    /// The browser to act on: an explicit request, else the frontmost
    /// supported one, else one that's merely running, else Chrome.
    ///
    /// Safari is deliberately the LAST of the running candidates. It ships on
    /// every Mac and is frequently open without being the browser anyone
    /// actually uses, so picking it by position meant driving Safari for
    /// someone whose real browser was Comet — observed exactly that.
    static func target(_ requested: Browser?) -> Browser {
        if let requested { return requested }
        if let front = frontmostBrowser() { return front }
        let running = runningBrowsers()
        if let preferred = running.first(where: { !$0.isSafari }) { return preferred }
        if let any = running.first { return any }
        return known[0]
    }

    /// Supported browsers with a live process, in preference order.
    static func runningBrowsers() -> [Browser] {
        guard let names = try? runScriptRaw("tell application \"System Events\" to get name of every application process whose background only is false") else {
            return []
        }
        let lower = names.lowercased()
        return known.filter { lower.contains($0.appName.lowercased()) }
    }

    /// The frontmost supported browser, or nil when the user is looking at
    /// something else entirely.
    static func frontmostBrowser() -> Browser? {
        guard let name = try? runScriptRaw("tell application \"System Events\" to get name of first application process whose frontmost is true") else {
            return nil
        }
        let lower = name.lowercased()
        return known.first { lower.contains($0.appName.lowercased()) }
    }

    // MARK: - Escaping (the entire reason this file exists)

    /// A JavaScript source string, safely embedded as an AppleScript string
    /// literal. Backslashes first, then quotes — the other order double-escapes
    /// the backslashes it just inserted.
    private static func appleScriptLiteral(_ source: String) -> String {
        let escaped = source
            .replacingOccurrences(of: "\\", with: "\\\\")
            .replacingOccurrences(of: "\"", with: "\\\"")
        return "\"\(escaped)\""
    }

    /// A Swift string safely embedded as a JavaScript string literal, via
    /// JSON encoding — which already handles quotes, backslashes, newlines and
    /// control characters correctly.
    private static func jsLiteral(_ value: String) -> String {
        guard let data = try? JSONSerialization.data(withJSONObject: [value], options: []),
              let text = String(data: data, encoding: .utf8),
              text.count >= 2 else {
            return "\"\""
        }
        // Strip the array brackets JSONSerialization requires at top level.
        return String(text.dropFirst().dropLast())
    }

    // MARK: - Script plumbing

    private struct BrowserError: Error { let message: String }

    /// Runs AppleScript and returns stdout, throwing with the raw error text.
    /// Each line becomes its own `-e` argument, matching how
    /// `DesktopControl.runAppleScriptSource` invokes osascript.
    @discardableResult
    private static func runScriptRaw(_ source: String) throws -> String {
        let process = Process()
        process.executableURL = URL(fileURLWithPath: "/usr/bin/osascript")
        var arguments: [String] = []
        for line in source.components(separatedBy: "\n") {
            arguments.append("-e")
            arguments.append(line)
        }
        process.arguments = arguments
        let pipe = Pipe()
        process.standardOutput = pipe
        process.standardError = pipe
        do {
            try process.run()
        } catch {
            throw BrowserError(message: error.localizedDescription)
        }
        let data = pipe.fileHandleForReading.readDataToEndOfFile()
        process.waitUntilExit()
        let output = String(data: data, encoding: .utf8)?
            .trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        guard process.terminationStatus == 0 else { throw BrowserError(message: output) }
        return output
    }

    /// Evaluates JavaScript in the front tab and returns its result.
    ///
    /// The two failure modes here are completely different problems with
    /// completely different fixes, and a model given one generic error will
    /// keep retrying the wrong thing — so they're separated explicitly.
    private static func evaluateJavaScript(_ js: String, on requested: Browser?) throws -> String {
        let resolved = target(requested)
        let literal = appleScriptLiteral(js)
        let script = resolved.isSafari
            ? "tell application \"\(resolved.appName)\" to do JavaScript \(literal) in current tab of front window"
            : "tell application \"\(resolved.appName)\" to execute front window's active tab javascript \(literal)"
        do {
            return try runScriptRaw(script)
        } catch let error as BrowserError {
            let lower = error.message.lowercased()
            if lower.contains("javascript") && (lower.contains("not allowed") || lower.contains("disabled") || lower.contains("apple events")) {
                throw BrowserError(message: """
                \(resolved.appName) is blocking JavaScript from Apple Events, which is required to read or click a page. Turn it on once:
                \(resolved.isSafari
                    ? "Safari → Settings → Advanced → tick \"Show features for web developers\", then Develop → Allow JavaScript from Apple Events."
                    : "\(resolved.appName) → View menu → Developer → Allow JavaScript from Apple Events.")
                Scrolling and reading the tab title/URL work without this.
                """)
            }
            if lower.contains("not authorized") || lower.contains("assistive") || lower.contains("1743") {
                throw BrowserError(message: "macOS hasn't granted permission to control \(resolved.appName) yet. Approve the prompt, or enable Eaon under System Settings → Privacy & Security → Automation.")
            }
            throw error
        }
    }

    // MARK: - Preferred path: the extension

    /// Every tool tries the extension first and only falls back to AppleScript
    /// if it isn't paired.
    ///
    /// The extension is better in every way that matters — real DOM clicks
    /// instead of keystrokes aimed at whatever has focus, page text without
    /// the hidden "Allow JavaScript from Apple Events" setting, and no macOS
    /// permission prompts at all. AppleScript stays as the fallback so the
    /// feature still does something for anyone who hasn't installed it.
    private static func viaBridge(_ action: String, _ params: [String: Any] = [:]) async -> DesktopResult? {
        BrowserBridge.shared.refreshConnectionState()
        guard BrowserBridge.shared.isConnected else { return nil }
        _ = params
        do {
            return .ok(try await BrowserBridge.shared.send(action: action, params: params))
        } catch {
            return .error(error.localizedDescription)
        }
    }

    // MARK: - Tools

    /// Title, URL and visible text of the active tab. Title/URL come first and
    /// separately, because they need no JavaScript permission and already
    /// answer most questions ("what am I watching", "what page is this").
    static func read(target requested: Browser?, maxCharacters: Int = 6000) async -> DesktopResult {
        if let bridged = await viaBridge("read", ["maxCharacters": maxCharacters]) { return bridged }
        return readViaAppleScript(target: requested, maxCharacters: maxCharacters)
    }

    private static func readViaAppleScript(target requested: Browser?, maxCharacters: Int = 6000) -> DesktopResult {
        let resolved = target(requested)
        let header: String
        do {
            header = resolved.isSafari
                ? try runScriptRaw("tell application \"\(resolved.appName)\" to get (name of current tab of front window) & \"\\n\" & (URL of current tab of front window)")
                : try runScriptRaw("tell application \"\(resolved.appName)\" to get (title of active tab of front window) & \"\\n\" & (URL of active tab of front window)")
        } catch let error as BrowserError {
            return .error("Couldn't reach \(resolved.appName): \(error.message)")
        } catch {
            return .error("Couldn't reach \(resolved.appName).")
        }

        // Page text is best-effort: without the JavaScript setting the title
        // and URL alone are still a useful answer, so a failure here degrades
        // rather than losing the whole call.
        let js = "document.body ? document.body.innerText.replace(/\\n{3,}/g,'\\n\\n').slice(0, \(maxCharacters)) : ''"
        do {
            let body = try evaluateJavaScript(js, on: resolved)
            return .ok("\(header)\n\n--- page text ---\n\(body)")
        } catch let error as BrowserError {
            return .ok("\(header)\n\n(Page text unavailable — \(error.message))")
        } catch {
            return .ok(header)
        }
    }

    /// Every open tab's title and URL.
    static func tabs(target requested: Browser?) async -> DesktopResult {
        if let bridged = await viaBridge("tabs") { return bridged }
        return tabsViaAppleScript(target: requested)
    }

    private static func tabsViaAppleScript(target requested: Browser?) -> DesktopResult {
        let resolved = target(requested)
        let script = resolved.isSafari
            ? "tell application \"\(resolved.appName)\" to get {name, URL} of every tab of front window"
            : "tell application \"\(resolved.appName)\" to get {title, URL} of every tab of front window"
        do {
            return .ok(try runScriptRaw(script))
        } catch let error as BrowserError {
            return .error("Couldn't list tabs in \(resolved.appName): \(error.message)")
        } catch {
            return .error("Couldn't list tabs.")
        }
    }

    /// Scroll the page.
    ///
    /// Uses real key events, NOT JavaScript, so it works without the hidden
    /// "Allow JavaScript from Apple Events" setting — scrolling is the most
    /// common browsing action and shouldn't be gated behind a Develop menu.
    /// It also scrolls whatever pane actually has focus, the way a person
    /// pressing Page Down would, rather than only the top-level document.
    static func scroll(target requested: Browser?, direction: String, pages: Int) async -> DesktopResult {
        if let bridged = await viaBridge("scroll", ["direction": direction, "pages": pages]) { return bridged }
        return scrollViaAppleScript(target: requested, direction: direction, pages: pages)
    }

    private static func scrollViaAppleScript(target requested: Browser?, direction: String, pages: Int) -> DesktopResult {
        let resolved = target(requested)
        let count = max(1, min(pages, 20))
        let keyCode: Int
        switch direction.lowercased() {
        case "up": keyCode = 116          // Page Up
        case "top": keyCode = 115         // Home
        case "bottom", "end": keyCode = 119 // End
        default: keyCode = 121            // Page Down
        }
        // Home/End are a single jump; paging repeats.
        let repeats = (keyCode == 115 || keyCode == 119) ? 1 : count
        var lines = ["tell application \"\(resolved.appName)\" to activate", "delay 0.2"]
        for _ in 0..<repeats {
            lines.append("tell application \"System Events\" to key code \(keyCode)")
            lines.append("delay 0.12")
        }
        do {
            try runScriptRaw(lines.joined(separator: "\n"))
            let what = repeats == 1 ? "" : " ×\(repeats)"
            return .ok("Scrolled \(direction.lowercased())\(what) in \(resolved.appName).")
        } catch let error as BrowserError {
            let lower = error.message.lowercased()
            if lower.contains("not authorized") || lower.contains("assistive") || lower.contains("1002") {
                // Two very different fixes, and the extension is by far the
                // better one — naming Accessibility first sent people to
                // System Settings when the real problem was an unpaired
                // extension.
                return .error("""
                Couldn't scroll. Best fix: pair the Eaon browser extension (Settings → Device Control) — it drives the page directly and needs no macOS permission at all.
                Without the extension, scrolling falls back to sending keystrokes, which needs Accessibility: System Settings → Privacy & Security → Accessibility → enable Eaon.
                """)
            }
            return .error("Couldn't scroll \(resolved.appName): \(error.message)")
        } catch {
            return .error("Couldn't scroll.")
        }
    }

    /// Click the first clickable element whose visible text, value or
    /// aria-label contains `text`. Matching on what a person can SEE is
    /// deliberate — a model reliably knows the label on a button, and
    /// reliably does not know its CSS selector.
    static func click(target requested: Browser?, text: String) async -> DesktopResult {
        if let bridged = await viaBridge("click", ["text": text]) { return bridged }
        return clickViaAppleScript(target: requested, text: text)
    }

    private static func clickViaAppleScript(target requested: Browser?, text: String) -> DesktopResult {
        let needle = jsLiteral(text)
        let js = """
        (function(){var n=\(needle).trim().toLowerCase();if(!n)return'EMPTY';var q='a,button,input[type=submit],input[type=button],[role=button],[role=link],[onclick],summary';var els=document.querySelectorAll(q);for(var i=0;i<els.length;i++){var e=els[i];var s=((e.innerText||e.value||e.getAttribute('aria-label')||e.title||'')+'').trim().toLowerCase();if(s&&s.indexOf(n)>=0){e.scrollIntoView({block:'center'});e.click();return'CLICKED: '+s.slice(0,120);}}return'NOTFOUND';})()
        """.replacingOccurrences(of: "\n", with: "")
        do {
            let result = try evaluateJavaScript(js, on: requested)
            if result.hasPrefix("CLICKED") { return .ok(result) }
            if result == "EMPTY" { return .error("No text given to click.") }
            return .error("Nothing clickable on the page matched \"\(text)\". Read the page first to see the real labels.")
        } catch let error as BrowserError {
            return .error(error.message)
        } catch {
            return .error("Couldn't click.")
        }
    }

    /// Type into the field whose label, placeholder or name matches `field`
    /// (or the focused field when `field` is empty), firing the input events
    /// modern web apps listen for — setting `.value` alone leaves React and
    /// friends unaware anything changed.
    static func type(target requested: Browser?, field: String, text: String) async -> DesktopResult {
        if let bridged = await viaBridge("type", ["field": field, "text": text]) { return bridged }
        return typeViaAppleScript(target: requested, field: field, text: text)
    }

    private static func typeViaAppleScript(target requested: Browser?, field: String, text: String) -> DesktopResult {
        let needle = jsLiteral(field)
        let value = jsLiteral(text)
        let js = """
        (function(){var n=\(needle).trim().toLowerCase();var v=\(value);var el=null;if(!n){el=document.activeElement;}else{var q='input,textarea,[contenteditable=true]';var els=document.querySelectorAll(q);for(var i=0;i<els.length;i++){var e=els[i];var s=((e.placeholder||e.name||e.getAttribute('aria-label')||e.id||'')+'').toLowerCase();if(s&&s.indexOf(n)>=0){el=e;break;}}}if(!el)return'NOTFOUND';el.focus();if(el.isContentEditable){el.textContent=v;}else{el.value=v;}el.dispatchEvent(new Event('input',{bubbles:true}));el.dispatchEvent(new Event('change',{bubbles:true}));return'TYPED into '+((el.placeholder||el.name||el.tagName)+'').slice(0,80);})()
        """.replacingOccurrences(of: "\n", with: "")
        do {
            let result = try evaluateJavaScript(js, on: requested)
            if result.hasPrefix("TYPED") { return .ok(result) }
            return .error("No field matched \"\(field)\". Read the page first to see what's there.")
        } catch let error as BrowserError {
            return .error(error.message)
        } catch {
            return .error("Couldn't type.")
        }
    }
}
