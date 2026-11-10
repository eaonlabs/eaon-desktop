// Eaon app control, macOS engine.
//
// A long-lived helper that Eaon runs as its own child, so macOS charges its
// Accessibility use to Eaon (the "responsible" process) and the user grants
// Eaon and nothing else. It reads apps' accessibility trees and acts on their
// elements through the AX API: no screenshots, and no moving the user's
// pointer. Keys and text are posted to the target process, not to whatever
// has focus.
//
// Protocol: one JSON object per line on stdin, `{"id": n, "op": "...", ...}`,
// answered by one line on stdout, `{"id": n, "ok": true, "result": ...}` or
// `{"id": n, "ok": false, "code": "...", "message": "..."}`. Requests are
// handled one at a time. Elements live in numbered snapshots that last until
// the helper exits; Eaon turns them into refs (`@<snapshot>:e<n>`).
//
// Built by scripts/build-app-control.mjs; driven by
// src/main/features/appControl/helper.ts. It exits when stdin closes.

import AppKit
import ApplicationServices
import Carbon
import Foundation

let helperVersion = "1.0.0"

// MARK: - Output

let outLock = NSLock()

func emit(_ object: [String: Any]) {
  guard let data = try? JSONSerialization.data(withJSONObject: object, options: []) else { return }
  outLock.lock()
  FileHandle.standardOutput.write(data)
  FileHandle.standardOutput.write(Data([0x0A]))
  outLock.unlock()
}

struct Failure: Error {
  let code: String
  let message: String
}

func fail(_ code: String, _ message: String) -> Failure { Failure(code: code, message: message) }

// MARK: - Snapshots

final class Snapshot {
  let pid: pid_t
  var elements: [AXUIElement] = []
  init(pid: pid_t) { self.pid = pid }
}

var snapshots: [String: Snapshot] = [:]
var snapshotOrder: [String] = []
/** Older snapshots are dropped; a ref into one is stale. */
let keptSnapshots = 48

func newSnapshot(pid: pid_t) -> (String, Snapshot) {
  let letters = Array("abcdefghijklmnopqrstuvwxyz0123456789")
  var id = ""
  repeat {
    id = "s" + String((0..<7).map { _ in letters[Int.random(in: 0..<letters.count)] })
  } while snapshots[id] != nil
  let snapshot = Snapshot(pid: pid)
  snapshots[id] = snapshot
  snapshotOrder.append(id)
  while snapshotOrder.count > keptSnapshots {
    snapshots.removeValue(forKey: snapshotOrder.removeFirst())
  }
  return (id, snapshot)
}

func register(_ element: AXUIElement, in snapshot: Snapshot) -> Int {
  snapshot.elements.append(element)
  return snapshot.elements.count
}

func lookup(_ req: [String: Any]) throws -> (AXUIElement, pid_t) {
  guard let sid = req["sid"] as? String, let n = req["n"] as? Int else {
    throw fail("INVALID_ARGS", "A ref is required.")
  }
  guard let snapshot = snapshots[sid] else {
    throw fail("STALE_REF", "That ref's snapshot is gone. Take a new snapshot.")
  }
  guard n >= 1, n <= snapshot.elements.count else {
    throw fail("BAD_REF", "That snapshot has no element e\(n).")
  }
  let element = snapshot.elements[n - 1]
  var role: CFTypeRef?
  let error = AXUIElementCopyAttributeValue(element, kAXRoleAttribute as CFString, &role)
  if error == .invalidUIElement {
    throw fail("STALE_REF", "That element is no longer there (its window closed or the app redrew it). Take a new snapshot.")
  }
  return (element, snapshot.pid)
}

// MARK: - Attributes

func copyAttr(_ element: AXUIElement, _ name: String) -> CFTypeRef? {
  var value: CFTypeRef?
  return AXUIElementCopyAttributeValue(element, name as CFString, &value) == .success ? value : nil
}

func copyAttrs(_ element: AXUIElement, _ names: [String]) -> [String: CFTypeRef] {
  var values: CFArray?
  let error = AXUIElementCopyMultipleAttributeValues(element, names as CFArray, AXCopyMultipleAttributeOptions(rawValue: 0), &values)
  var out: [String: CFTypeRef] = [:]
  guard error == .success, let array = values as? [AnyObject] else { return out }
  for (index, name) in names.enumerated() where index < array.count {
    let value = array[index] as CFTypeRef
    if CFGetTypeID(value) == AXValueGetTypeID(), AXValueGetType(value as! AXValue) == .axError { continue }
    out[name] = value
  }
  return out
}

func settable(_ element: AXUIElement, _ name: String) -> Bool {
  var result = DarwinBoolean(false)
  return AXUIElementIsAttributeSettable(element, name as CFString, &result) == .success && result.boolValue
}

func actionNames(_ element: AXUIElement) -> [String] {
  var names: CFArray?
  guard AXUIElementCopyActionNames(element, &names) == .success, let list = names as? [String] else { return [] }
  return list
}

/** A value as JSON: text, a number, a boolean, a point or size; nil for elements and anything else. */
func plain(_ value: CFTypeRef?) -> Any? {
  guard let value = value else { return nil }
  let type = CFGetTypeID(value)
  if type == CFStringGetTypeID() { return value as! String }
  if type == CFBooleanGetTypeID() { return CFBooleanGetValue((value as! CFBoolean)) }
  if type == CFNumberGetTypeID() {
    let number = value as! NSNumber
    let double = number.doubleValue
    return double.isFinite ? number : nil
  }
  if type == CFAttributedStringGetTypeID() { return (value as! NSAttributedString).string }
  if type == CFURLGetTypeID() { return (value as! URL).absoluteString }
  if type == AXValueGetTypeID() {
    let ax = value as! AXValue
    switch AXValueGetType(ax) {
    case .cgPoint:
      var point = CGPoint.zero
      AXValueGetValue(ax, .cgPoint, &point)
      return ["x": point.x, "y": point.y]
    case .cgSize:
      var size = CGSize.zero
      AXValueGetValue(ax, .cgSize, &size)
      return ["w": size.width, "h": size.height]
    case .cgRect:
      var rect = CGRect.zero
      AXValueGetValue(ax, .cgRect, &rect)
      return ["x": rect.origin.x, "y": rect.origin.y, "w": rect.size.width, "h": rect.size.height]
    case .cfRange:
      var range = CFRange()
      AXValueGetValue(ax, .cfRange, &range)
      return ["location": range.location, "length": range.length]
    default:
      return nil
    }
  }
  return nil
}

func text(_ value: CFTypeRef?, limit: Int) -> String? {
  guard let raw = plain(value) else { return nil }
  var string: String
  if let s = raw as? String { string = s }
  else if let b = raw as? Bool { string = b ? "1" : "0" }
  else if let n = raw as? NSNumber { string = n.stringValue }
  else { return nil }
  if string.count > limit { string = String(string.prefix(limit)) + "…" }
  return string
}

func bounds(_ attrs: [String: CFTypeRef]) -> [Double]? {
  guard let position = plain(attrs["AXPosition"]) as? [String: CGFloat],
        let size = plain(attrs["AXSize"]) as? [String: CGFloat],
        let x = position["x"], let y = position["y"], let w = size["w"], let h = size["h"] else { return nil }
  return [Double(x), Double(y), Double(w), Double(h)].map { ($0 * 10).rounded() / 10 }
}

let nodeAttrs = [
  "AXRole", "AXSubrole", "AXRoleDescription", "AXTitle", "AXValue", "AXDescription", "AXHelp",
  "AXPlaceholderValue", "AXIdentifier", "AXEnabled", "AXFocused", "AXSelected", "AXExpanded",
  "AXPosition", "AXSize", "AXMinimized", "AXTitleUIElement", "AXChildren", "AXModal", "AXMain",
  "AXRequired", "AXVisited", "AXDOMIdentifier", "AXURL",
]

/** Roles whose AXValue is a document, not a short value: kept short in snapshots. */
let longValueRoles: Set<String> = ["AXTextArea", "AXWebArea", "AXScrollArea", "AXLayoutArea"]

/** One element's properties, without its children. */
func describe(_ element: AXUIElement, _ attrs: [String: CFTypeRef], valueLimit: Int, withActions: Bool) -> [String: Any] {
  var node: [String: Any] = [:]
  let role = (plain(attrs["AXRole"]) as? String) ?? "AXUnknown"
  node["role"] = role
  if let subrole = plain(attrs["AXSubrole"]) as? String { node["subrole"] = subrole }
  if let roleDescription = plain(attrs["AXRoleDescription"]) as? String { node["roleDescription"] = roleDescription }
  var title = text(attrs["AXTitle"], limit: 300)
  if title?.isEmpty ?? true, let label = attrs["AXTitleUIElement"], CFGetTypeID(label) == AXUIElementGetTypeID() {
    let labelElement = label as! AXUIElement
    title = text(copyAttr(labelElement, "AXValue"), limit: 300) ?? text(copyAttr(labelElement, "AXTitle"), limit: 300)
  }
  if let title = title, !title.isEmpty { node["title"] = title }
  let secure = (plain(attrs["AXSubrole"]) as? String) == "AXSecureTextField"
  if !secure, let value = text(attrs["AXValue"], limit: longValueRoles.contains(role) ? min(valueLimit, 200) : valueLimit), !value.isEmpty {
    node["value"] = value
  }
  if let description = text(attrs["AXDescription"], limit: 300), !description.isEmpty { node["description"] = description }
  if let help = text(attrs["AXHelp"], limit: 300), !help.isEmpty { node["help"] = help }
  if let placeholder = text(attrs["AXPlaceholderValue"], limit: 200), !placeholder.isEmpty { node["placeholder"] = placeholder }
  if let identifier = (plain(attrs["AXIdentifier"]) as? String) ?? (plain(attrs["AXDOMIdentifier"]) as? String), !identifier.isEmpty {
    node["identifier"] = identifier
  }
  if let url = plain(attrs["AXURL"]) as? String { node["url"] = url }
  for (key, name) in [("enabled", "AXEnabled"), ("focused", "AXFocused"), ("selected", "AXSelected"), ("expanded", "AXExpanded"), ("minimized", "AXMinimized"), ("modal", "AXModal"), ("main", "AXMain"), ("required", "AXRequired"), ("visited", "AXVisited")] {
    if let flag = plain(attrs[name]) as? Bool { node[key] = flag }
  }
  if let rect = bounds(attrs) { node["bounds"] = rect }
  if withActions {
    let actions = actionNames(element)
    if !actions.isEmpty { node["actions"] = actions }
  }
  if settable(element, "AXValue") { node["valueSettable"] = true }
  return node
}

func children(_ attrs: [String: CFTypeRef]) -> [AXUIElement] {
  guard let value = attrs["AXChildren"], CFGetTypeID(value) == CFArrayGetTypeID() else { return [] }
  return (value as! [AnyObject]).compactMap { item in
    CFGetTypeID(item as CFTypeRef) == AXUIElementGetTypeID() ? (item as! AXUIElement) : nil
  }
}

struct Limits {
  var depth: Int
  var maxNodes: Int
  var valueLimit: Int
  var count = 0
}

/** The element and what it contains, depth-first, registering each in the snapshot. */
func walk(_ element: AXUIElement, _ snapshot: Snapshot, _ limits: inout Limits, depth: Int, skipMenuBar: Bool) -> [String: Any] {
  let attrs = copyAttrs(element, nodeAttrs)
  var node = describe(element, attrs, valueLimit: limits.valueLimit, withActions: true)
  node["n"] = register(element, in: snapshot)
  limits.count += 1
  var kids = children(attrs)
  if skipMenuBar { kids = kids.filter { (plain(copyAttr($0, "AXRole")) as? String) != "AXMenuBar" } }
  if kids.isEmpty { return node }
  if depth >= limits.depth || limits.count >= limits.maxNodes {
    node["more"] = kids.count
    return node
  }
  var out: [[String: Any]] = []
  for (index, child) in kids.enumerated() {
    if limits.count >= limits.maxNodes {
      node["more"] = kids.count - index
      break
    }
    out.append(walk(child, snapshot, &limits, depth: depth + 1, skipMenuBar: false))
  }
  node["children"] = out
  return node
}

// MARK: - Apps

func appInfo(_ app: NSRunningApplication) -> [String: Any] {
  var info: [String: Any] = [
    "pid": Int(app.processIdentifier),
    "name": app.localizedName ?? app.bundleIdentifier ?? "pid \(app.processIdentifier)",
    "active": app.isActive,
    "hidden": app.isHidden,
    "launched": app.isFinishedLaunching,
  ]
  if let bundle = app.bundleIdentifier { info["bundleId"] = bundle }
  if let url = app.bundleURL { info["path"] = url.path }
  info["regular"] = app.activationPolicy == .regular
  return info
}

func runningApp(_ pid: pid_t) throws -> NSRunningApplication {
  guard let app = NSRunningApplication(processIdentifier: pid), !app.isTerminated else {
    throw fail("APP_NOT_FOUND", "That app (pid \(pid)) is not running.")
  }
  return app
}

func pidOf(_ req: [String: Any]) throws -> pid_t {
  guard let pid = req["pid"] as? Int else { throw fail("INVALID_ARGS", "An app is required.") }
  _ = try runningApp(pid_t(pid))
  return pid_t(pid)
}

/** Chromium and Electron build their accessibility tree only once asked; this asks. */
var enabledWebTrees = Set<pid_t>()

func enableWebTree(_ pid: pid_t, _ app: AXUIElement) {
  if enabledWebTrees.contains(pid) { return }
  enabledWebTrees.insert(pid)
  if AXUIElementSetAttributeValue(app, "AXManualAccessibility" as CFString, kCFBooleanTrue) == .success {
    // The tree is built asynchronously after the switch.
    spin(0.35)
  }
}

func spin(_ seconds: TimeInterval) {
  let until = Date().addingTimeInterval(seconds)
  while Date() < until {
    RunLoop.current.run(mode: .default, before: min(until, Date().addingTimeInterval(0.05)))
  }
}

func appElement(_ pid: pid_t) -> AXUIElement {
  let element = AXUIElementCreateApplication(pid)
  enableWebTree(pid, element)
  return element
}

func windowsOf(_ pid: pid_t) -> [AXUIElement] {
  guard let value = copyAttr(appElement(pid), "AXWindows"), CFGetTypeID(value) == CFArrayGetTypeID() else { return [] }
  return (value as! [AnyObject]).map { $0 as! AXUIElement }
}

func findApplication(_ req: [String: Any]) -> URL? {
  let fm = FileManager.default
  if let path = req["path"] as? String, fm.fileExists(atPath: path) { return URL(fileURLWithPath: path) }
  if let bundle = req["bundleId"] as? String, let url = NSWorkspace.shared.urlForApplication(withBundleIdentifier: bundle) { return url }
  guard let name = req["name"] as? String, !name.isEmpty else { return nil }
  if name.contains("."), let url = NSWorkspace.shared.urlForApplication(withBundleIdentifier: name) { return url }
  let wanted = name.lowercased().hasSuffix(".app") ? name.lowercased() : name.lowercased() + ".app"
  let home = fm.homeDirectoryForCurrentUser.path
  let roots = ["/Applications", "/System/Applications", "/System/Applications/Utilities", "/Applications/Utilities", "\(home)/Applications", "/System/Library/CoreServices"]
  for root in roots {
    guard let items = try? fm.contentsOfDirectory(atPath: root) else { continue }
    if let hit = items.first(where: { $0.lowercased() == wanted }) { return URL(fileURLWithPath: "\(root)/\(hit)") }
  }
  if let path = NSWorkspace.shared.fullPath(forApplication: name) { return URL(fileURLWithPath: path) }
  return nil
}

// MARK: - Keyboard

/**
 * Virtual key codes that don't depend on the keyboard layout, by the names
 * Eaon's combo parser (computer/keys.ts) gives keys: `delete` is the forward
 * delete, `backspace` the one above Return.
 */
let namedKeys: [String: CGKeyCode] = [
  "return": 36, "kpenter": 76, "tab": 48, "space": 49, "backspace": 51, "delete": 117, "insert": 114,
  "escape": 53, "left": 123, "right": 124, "down": 125, "up": 126, "home": 115, "end": 119,
  "pageup": 116, "pagedown": 121, "help": 114, "capslock": 57,
  "f1": 122, "f2": 120, "f3": 99, "f4": 118, "f5": 96, "f6": 97, "f7": 98, "f8": 100, "f9": 101,
  "f10": 109, "f11": 103, "f12": 111, "f13": 105, "f14": 107, "f15": 113, "f16": 106, "f17": 64,
  "f18": 79, "f19": 80, "f20": 90,
]

/** Character → key code on the current layout, so cmd+s is ⌘S on AZERTY and Dvorak too. */
var layoutKeys: [String: CGKeyCode] = {
  var map: [String: CGKeyCode] = [:]
  guard let source = TISCopyCurrentKeyboardLayoutInputSource()?.takeRetainedValue(),
        let pointer = TISGetInputSourceProperty(source, kTISPropertyUnicodeKeyLayoutData) else { return map }
  let data = Unmanaged<CFData>.fromOpaque(pointer).takeUnretainedValue() as Data
  data.withUnsafeBytes { raw in
    guard let layout = raw.bindMemory(to: UCKeyboardLayout.self).baseAddress else { return }
    for code in 0..<128 {
      var dead: UInt32 = 0
      var length = 0
      var chars = [UniChar](repeating: 0, count: 4)
      let status = UCKeyTranslate(layout, UInt16(code), UInt16(kUCKeyActionDisplay), 0, UInt32(LMGetKbdType()), OptionBits(kUCKeyTranslateNoDeadKeysBit), &dead, 4, &length, &chars)
      guard status == noErr, length > 0 else { continue }
      let key = String(utf16CodeUnits: chars, count: length).lowercased()
      if map[key] == nil { map[key] = CGKeyCode(code) }
    }
  }
  return map
}()

/** Punctuation keys by name, found on the layout by the character they type. */
let punctuation: [String: String] = [
  "minus": "-", "equal": "=", "comma": ",", "period": ".", "slash": "/", "semicolon": ";", "quote": "'",
  "grave": "`", "bracketleft": "[", "bracketright": "]", "backslash": "\\",
]

func keyCode(_ name: String) -> CGKeyCode? {
  let key = name.lowercased()
  if let code = namedKeys[key] { return code }
  return layoutKeys[punctuation[key] ?? key]
}

func modifierFlags(_ names: [String]) throws -> CGEventFlags {
  var flags: CGEventFlags = []
  for name in names {
    switch name.lowercased() {
    case "cmd", "command", "meta", "super", "win": flags.insert(.maskCommand)
    case "ctrl", "control": flags.insert(.maskControl)
    case "alt", "option", "opt": flags.insert(.maskAlternate)
    case "shift": flags.insert(.maskShift)
    case "fn": flags.insert(.maskSecondaryFn)
    default: throw fail("INVALID_ARGS", "Unknown modifier \"\(name)\".")
    }
  }
  return flags
}

let eventSource = CGEventSource(stateID: .privateState)

func postKey(_ pid: pid_t, _ code: CGKeyCode, _ flags: CGEventFlags) throws {
  guard let down = CGEvent(keyboardEventSource: eventSource, virtualKey: code, keyDown: true),
        let up = CGEvent(keyboardEventSource: eventSource, virtualKey: code, keyDown: false) else {
    throw fail("ACTION_FAILED", "Could not create the key event.")
  }
  down.flags = flags
  up.flags = flags
  down.postToPid(pid)
  usleep(8000)
  up.postToPid(pid)
  usleep(8000)
}

func postText(_ pid: pid_t, _ string: String) throws {
  let units = Array(string.utf16)
  var index = 0
  while index < units.count {
    let chunk = Array(units[index..<min(index + 16, units.count)])
    index += chunk.count
    guard let down = CGEvent(keyboardEventSource: eventSource, virtualKey: 0, keyDown: true),
          let up = CGEvent(keyboardEventSource: eventSource, virtualKey: 0, keyDown: false) else {
      throw fail("ACTION_FAILED", "Could not create the key event.")
    }
    chunk.withUnsafeBufferPointer { buffer in
      down.keyboardSetUnicodeString(stringLength: buffer.count, unicodeString: buffer.baseAddress)
      up.keyboardSetUnicodeString(stringLength: buffer.count, unicodeString: buffer.baseAddress)
    }
    down.postToPid(pid)
    usleep(6000)
    up.postToPid(pid)
    usleep(6000)
  }
}

// MARK: - Actions

func perform(_ element: AXUIElement, _ action: String) -> Bool {
  AXUIElementPerformAction(element, action as CFString) == .success
}

func setAttr(_ element: AXUIElement, _ name: String, _ value: CFTypeRef) -> AXError {
  AXUIElementSetAttributeValue(element, name as CFString, value)
}

func cfValue(_ value: Any?) throws -> CFTypeRef {
  if let b = value as? Bool { return (b ? kCFBooleanTrue : kCFBooleanFalse)! }
  if let n = value as? NSNumber { return n }
  if let s = value as? String { return s as CFString }
  throw fail("INVALID_ARGS", "A value is required.")
}

func role(_ element: AXUIElement) -> String { (plain(copyAttr(element, "AXRole")) as? String) ?? "" }

func childButton(_ element: AXUIElement, _ attribute: String) -> AXUIElement? {
  guard let value = copyAttr(element, attribute), CFGetTypeID(value) == AXUIElementGetTypeID() else { return nil }
  return (value as! AXUIElement)
}

/** The nearest scroll area at or above the element. */
func scrollArea(_ element: AXUIElement) -> AXUIElement? {
  var current: AXUIElement? = element
  for _ in 0..<12 {
    guard let el = current else { return nil }
    if role(el) == "AXScrollArea" { return el }
    guard let parent = copyAttr(el, "AXParent"), CFGetTypeID(parent) == AXUIElementGetTypeID() else { return nil }
    current = (parent as! AXUIElement)
  }
  return nil
}

func act(_ element: AXUIElement, _ pid: pid_t, _ req: [String: Any]) throws -> [String: Any] {
  let action = (req["action"] as? String) ?? ""
  var note: String? = nil
  switch action {
  case "press":
    let actions = actionNames(element)
    if let first = ["AXPress", "AXConfirm", "AXPick", "AXOpen"].first(where: { actions.contains($0) }), perform(element, first) {
      break
    }
    if settable(element, "AXSelected"), setAttr(element, "AXSelected", kCFBooleanTrue) == .success {
      note = "selected"
      break
    }
    throw fail("ACTION_UNSUPPORTED", "That element can't be pressed (it offers: \(actions.isEmpty ? "nothing" : actions.joined(separator: ", "))).")
  case "open":
    guard actionNames(element).contains("AXOpen"), perform(element, "AXOpen") else {
      throw fail("ACTION_UNSUPPORTED", "That element has no open action; a double click needs the pointer (computer use).")
    }
  case "showmenu":
    guard perform(element, "AXShowMenu") else { throw fail("ACTION_UNSUPPORTED", "That element has no context menu.") }
  case "increment", "decrement", "cancel", "confirm", "raise", "pick":
    let name = "AX" + action.prefix(1).uppercased() + action.dropFirst()
    guard perform(element, name) else { throw fail("ACTION_UNSUPPORTED", "That element can't \(action).") }
  case "setvalue":
    let value = try cfValue(req["value"])
    let error = setAttr(element, "AXValue", value)
    guard error == .success else { throw fail("ACTION_FAILED", "The app refused the new value (AX error \(error.rawValue)).") }
  case "focus":
    if role(element) == "AXWindow" {
      _ = setAttr(appElement(pid), "AXFrontmost", kCFBooleanTrue)
      _ = setAttr(element, "AXMain", kCFBooleanTrue)
      _ = perform(element, "AXRaise")
    } else {
      let error = setAttr(element, "AXFocused", kCFBooleanTrue)
      guard error == .success else { throw fail("ACTION_FAILED", "The app wouldn't move focus there (AX error \(error.rawValue)).") }
    }
  case "select":
    if settable(element, "AXSelected"), setAttr(element, "AXSelected", kCFBooleanTrue) == .success { break }
    if perform(element, "AXPress") || perform(element, "AXPick") { break }
    throw fail("ACTION_UNSUPPORTED", "That element can't be selected.")
  case "expand", "collapse":
    let open = action == "expand"
    if settable(element, "AXExpanded"), setAttr(element, "AXExpanded", (open ? kCFBooleanTrue : kCFBooleanFalse)!) == .success { break }
    if settable(element, "AXDisclosing"), setAttr(element, "AXDisclosing", (open ? kCFBooleanTrue : kCFBooleanFalse)!) == .success { break }
    if let current = plain(copyAttr(element, "AXExpanded")) as? Bool, current == open { break }
    if perform(element, "AXPress") { break }
    throw fail("ACTION_UNSUPPORTED", "That element can't \(action).")
  case "scrolltovisible":
    guard perform(element, "AXScrollToVisible") else {
      throw fail("ACTION_UNSUPPORTED", "The app can't scroll that element into view.")
    }
  case "scroll":
    let direction = (req["direction"] as? String) ?? "down"
    let units = max(1, (req["units"] as? Int) ?? 3)
    guard let area = scrollArea(element) else { throw fail("ACTION_UNSUPPORTED", "There is no scroll area there.") }
    let vertical = direction == "up" || direction == "down"
    let sign: Double = (direction == "down" || direction == "right") ? 1 : -1
    let barAttr = vertical ? "AXVerticalScrollBar" : "AXHorizontalScrollBar"
    if let bar = childButton(area, barAttr), let current = plain(copyAttr(bar, "AXValue")) as? NSNumber, settable(bar, "AXValue") {
      let next = min(1, max(0, current.doubleValue + sign * 0.08 * Double(units)))
      if setAttr(bar, "AXValue", NSNumber(value: next)) == .success {
        note = String(format: "scrolled to %.0f%%", next * 100)
        break
      }
    }
    // No settable scroll bar: wheel events, posted to the app at the area's
    // centre. The pointer itself doesn't move.
    let attrs = copyAttrs(area, ["AXPosition", "AXSize"])
    guard let rect = bounds(attrs) else { throw fail("ACTION_FAILED", "Could not tell where the scroll area is.") }
    let lines = Int32(units * 3) * Int32(-sign)
    guard let event = CGEvent(scrollWheelEvent2Source: eventSource, units: .line, wheelCount: 2, wheel1: vertical ? lines : 0, wheel2: vertical ? 0 : lines, wheel3: 0) else {
      throw fail("ACTION_FAILED", "Could not create the scroll event.")
    }
    event.location = CGPoint(x: rect[0] + rect[2] / 2, y: rect[1] + rect[3] / 2)
    event.postToPid(pid)
    note = "wheel"
  case "inserttext":
    guard let string = req["text"] as? String else { throw fail("INVALID_ARGS", "Text is required.") }
    if (plain(copyAttr(element, "AXFocused")) as? Bool) != true { _ = setAttr(element, "AXFocused", kCFBooleanTrue) }
    if settable(element, "AXSelectedText"), setAttr(element, "AXSelectedText", string as CFString) == .success {
      note = "inserted"
      break
    }
    try postText(pid, string)
    note = "keys"
  case "setframe":
    if let x = req["x"] as? Double, let y = req["y"] as? Double {
      var point = CGPoint(x: x, y: y)
      guard let value = AXValueCreate(.cgPoint, &point), setAttr(element, "AXPosition", value) == .success else {
        throw fail("ACTION_FAILED", "The window can't be moved.")
      }
    }
    if let w = req["w"] as? Double, let h = req["h"] as? Double {
      var size = CGSize(width: w, height: h)
      guard let value = AXValueCreate(.cgSize, &size), setAttr(element, "AXSize", value) == .success else {
        throw fail("ACTION_FAILED", "The window can't be resized.")
      }
    }
  case "minimize", "unminimize":
    guard setAttr(element, "AXMinimized", (action == "minimize" ? kCFBooleanTrue : kCFBooleanFalse)!) == .success else {
      throw fail("ACTION_FAILED", "The window can't be \(action == "minimize" ? "minimized" : "restored").")
    }
  case "fullscreen", "unfullscreen":
    guard setAttr(element, "AXFullScreen", (action == "fullscreen" ? kCFBooleanTrue : kCFBooleanFalse)!) == .success else {
      throw fail("ACTION_FAILED", "The window can't change full screen.")
    }
  case "close", "zoom":
    guard let button = childButton(element, action == "close" ? "AXCloseButton" : "AXZoomButton"), perform(button, "AXPress") else {
      throw fail("ACTION_UNSUPPORTED", "That window has no \(action) button.")
    }
  default:
    throw fail("INVALID_ARGS", "Unknown action \"\(action)\".")
  }
  var result: [String: Any] = [:]
  if let note = note { result["note"] = note }
  // What the element looks like now, to check the action did what was meant.
  var roleValue: CFTypeRef?
  if AXUIElementCopyAttributeValue(element, kAXRoleAttribute as CFString, &roleValue) != .invalidUIElement {
    result["after"] = describe(element, copyAttrs(element, nodeAttrs), valueLimit: 400, withActions: false)
  } else {
    result["gone"] = true
  }
  return result
}

// MARK: - Requests

func trusted() -> Bool { AXIsProcessTrusted() }

func requireTrust() throws {
  if !trusted() {
    throw fail("PERMISSION_DENIED", "macOS hasn't given Eaon Accessibility access. Turn Eaon on in System Settings → Privacy & Security → Accessibility.")
  }
}

func handle(_ req: [String: Any]) throws -> Any {
  let op = (req["op"] as? String) ?? ""
  switch op {
  case "status":
    return ["trusted": trusted(), "version": helperVersion, "os": ProcessInfo.processInfo.operatingSystemVersionString]

  case "apps":
    let all = (req["all"] as? Bool) ?? false
    return NSWorkspace.shared.runningApplications
      .filter { !$0.isTerminated && (all || $0.activationPolicy == .regular) }
      .map(appInfo)

  case "frontmost":
    guard let app = NSWorkspace.shared.frontmostApplication else { throw fail("APP_NOT_FOUND", "No app is in front.") }
    return appInfo(app)

  case "launch":
    guard let url = findApplication(req) else { throw fail("APP_NOT_FOUND", "Couldn't find that app.") }
    let bundle = Bundle(url: url)?.bundleIdentifier
    if let bundle = bundle, let running = NSRunningApplication.runningApplications(withBundleIdentifier: bundle).first(where: { !$0.isTerminated }) {
      if (req["activate"] as? Bool) == true { _ = setAttr(appElement(running.processIdentifier), "AXFrontmost", kCFBooleanTrue) }
      var info = appInfo(running)
      info["alreadyRunning"] = true
      return info
    }
    let configuration = NSWorkspace.OpenConfiguration()
    configuration.activates = (req["activate"] as? Bool) ?? false
    var launched: NSRunningApplication?
    var launchError: Error?
    var done = false
    NSWorkspace.shared.openApplication(at: url, configuration: configuration) { app, error in
      DispatchQueue.main.async {
        launched = app
        launchError = error
        done = true
      }
    }
    let deadline = Date().addingTimeInterval((req["timeout"] as? Double) ?? 20)
    while !done && Date() < deadline { spin(0.05) }
    if let error = launchError { throw fail("ACTION_FAILED", "macOS couldn't open it: \(error.localizedDescription)") }
    guard let app = launched else { throw fail("TIMEOUT", "The app didn't start in time.") }
    while !app.isFinishedLaunching && Date() < deadline { spin(0.05) }
    return appInfo(app)

  case "quit":
    let app = try runningApp(pid_t(try pidOf(req)))
    let ok = (req["force"] as? Bool) == true ? app.forceTerminate() : app.terminate()
    return ["requested": ok]

  case "hide", "unhide":
    let app = try runningApp(pid_t(try pidOf(req)))
    return ["done": op == "hide" ? app.hide() : app.unhide()]

  case "activate":
    try requireTrust()
    let pid = try pidOf(req)
    let error = setAttr(appElement(pid), "AXFrontmost", kCFBooleanTrue)
    if error != .success { _ = try runningApp(pid).activate(options: [.activateAllWindows]) }
    return ["done": true]

  case "windows":
    try requireTrust()
    var pids: [pid_t] = []
    if let pid = req["pid"] as? Int { pids = [pid_t(pid)] }
    else { pids = NSWorkspace.shared.runningApplications.filter { $0.activationPolicy == .regular && !$0.isTerminated }.map { $0.processIdentifier } }
    var out: [[String: Any]] = []
    for pid in pids {
      let windows = windowsOf(pid)
      if windows.isEmpty { continue }
      let (sid, snapshot) = newSnapshot(pid: pid)
      for window in windows {
        let attrs = copyAttrs(window, ["AXRole", "AXSubrole", "AXTitle", "AXPosition", "AXSize", "AXMain", "AXFocused", "AXMinimized", "AXModal", "AXFullScreen"])
        var info = describe(window, attrs, valueLimit: 100, withActions: false)
        if let full = plain(attrs["AXFullScreen"]) as? Bool { info["fullscreen"] = full }
        info["n"] = register(window, in: snapshot)
        info["sid"] = sid
        info["pid"] = Int(pid)
        out.append(info)
      }
    }
    return out

  case "snapshot":
    try requireTrust()
    var limits = Limits(depth: (req["depth"] as? Int) ?? 30, maxNodes: (req["maxNodes"] as? Int) ?? 4000, valueLimit: (req["valueLimit"] as? Int) ?? 400)
    var root: AXUIElement
    var pid: pid_t
    var skipMenuBar = false
    if req["sid"] != nil {
      (root, pid) = try lookup(req)
    } else {
      pid = try pidOf(req)
      let app = appElement(pid)
      switch (req["scope"] as? String) ?? "window" {
      case "app":
        root = app
        skipMenuBar = (req["skipMenuBar"] as? Bool) ?? false
      case "menubar":
        guard let bar = childButton(app, "AXMenuBar") else { throw fail("ELEMENT_NOT_FOUND", "That app has no menu bar.") }
        root = bar
      default:
        // The focused window, else the main one, else the first; the app itself when it has none.
        if let focused = childButton(app, "AXFocusedWindow") { root = focused }
        else if let main = childButton(app, "AXMainWindow") { root = main }
        else if let first = windowsOf(pid).first { root = first }
        else {
          root = app
          skipMenuBar = true
        }
      }
    }
    // A wait polls with throwaway snapshots, so the refs an agent holds aren't pushed out.
    let (sid, snapshot) = (req["ephemeral"] as? Bool) == true ? ("ephemeral", Snapshot(pid: pid)) : newSnapshot(pid: pid)
    let tree = walk(root, snapshot, &limits, depth: 0, skipMenuBar: skipMenuBar)
    return ["sid": sid, "pid": Int(pid), "tree": tree, "count": limits.count, "truncated": limits.count >= limits.maxNodes]

  case "surfaces":
    try requireTrust()
    let pid = try pidOf(req)
    let app = appElement(pid)
    let (sid, snapshot) = newSnapshot(pid: pid)
    var out: [[String: Any]] = []
    let surfaceRoles: Set<String> = ["AXSheet", "AXMenu", "AXPopover", "AXDrawer"]
    func scan(_ element: AXUIElement, depth: Int) {
      for child in children(copyAttrs(element, ["AXChildren"])) {
        let attrs = copyAttrs(child, ["AXRole", "AXSubrole", "AXTitle", "AXDescription", "AXPosition", "AXSize", "AXModal"])
        let r = (plain(attrs["AXRole"]) as? String) ?? ""
        let sub = (plain(attrs["AXSubrole"]) as? String) ?? ""
        if surfaceRoles.contains(r) || (r == "AXWindow" && (sub == "AXDialog" || sub == "AXSystemDialog" || sub == "AXFloatingWindow")) {
          var info = describe(child, attrs, valueLimit: 100, withActions: false)
          info["n"] = register(child, in: snapshot)
          info["sid"] = sid
          out.append(info)
        } else if depth < 2 && (r == "AXWindow" || r == "AXMenuBar" || r == "AXMenuBarItem" || r == "AXGroup") {
          scan(child, depth: depth + 1)
        }
      }
    }
    scan(app, depth: 0)
    return out

  case "focused":
    try requireTrust()
    let system = AXUIElementCreateSystemWide()
    var element: AXUIElement?
    if let pid = req["pid"] as? Int {
      element = childButton(appElement(pid_t(pid)), "AXFocusedUIElement")
    } else {
      element = childButton(system, "AXFocusedUIElement")
    }
    guard let focused = element else { throw fail("ELEMENT_NOT_FOUND", "Nothing has keyboard focus.") }
    var pid: pid_t = 0
    AXUIElementGetPid(focused, &pid)
    let (sid, snapshot) = newSnapshot(pid: pid)
    var node = describe(focused, copyAttrs(focused, nodeAttrs), valueLimit: 400, withActions: true)
    node["n"] = register(focused, in: snapshot)
    return ["sid": sid, "pid": Int(pid), "node": node]

  case "read":
    try requireTrust()
    let (element, pid) = try lookup(req)
    var node = describe(element, copyAttrs(element, nodeAttrs), valueLimit: (req["valueLimit"] as? Int) ?? 20000, withActions: true)
    node["n"] = req["n"]
    node["pid"] = Int(pid)
    if let attribute = req["attribute"] as? String { node["raw"] = plain(copyAttr(element, attribute)) ?? NSNull() }
    return node

  case "act":
    try requireTrust()
    let (element, pid) = try lookup(req)
    return try act(element, pid, req)

  case "keys":
    try requireTrust()
    let pid = try pidOf(req)
    guard let key = req["key"] as? String, let code = keyCode(key) else {
      throw fail("INVALID_ARGS", "Unknown key \"\((req["key"] as? String) ?? "")\".")
    }
    let flags = try modifierFlags((req["modifiers"] as? [String]) ?? [])
    let times = max(1, min(50, (req["repeat"] as? Int) ?? 1))
    for _ in 0..<times { try postKey(pid, code, flags) }
    return ["done": true]

  case "text":
    try requireTrust()
    let pid = try pidOf(req)
    guard let string = req["text"] as? String else { throw fail("INVALID_ARGS", "Text is required.") }
    try postText(pid, string)
    return ["done": true]

  case "ping":
    return ["pong": true]

  default:
    throw fail("INVALID_ARGS", "Unknown op \"\(op)\".")
  }
}

// MARK: - Main loop

// AX calls to an app that has hung give up after this long, rather than the default six seconds.
AXUIElementSetMessagingTimeout(AXUIElementCreateSystemWide(), 2.5)

let reader = Thread {
  while let line = readLine(strippingNewline: true) {
    if line.isEmpty { continue }
    DispatchQueue.main.async {
      guard let data = line.data(using: .utf8),
            let req = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] else {
        emit(["id": NSNull(), "ok": false, "code": "INVALID_ARGS", "message": "Not a JSON object."])
        return
      }
      let id = req["id"] ?? NSNull()
      do {
        let result = try handle(req)
        emit(["id": id, "ok": true, "result": result])
      } catch let failure as Failure {
        emit(["id": id, "ok": false, "code": failure.code, "message": failure.message])
      } catch {
        emit(["id": id, "ok": false, "code": "INTERNAL", "message": "\(error)"])
      }
    }
  }
  // Eaon closed our stdin (or exited): so do we, once what was asked is answered.
  DispatchQueue.main.async { exit(0) }
}
reader.start()
RunLoop.main.run()
