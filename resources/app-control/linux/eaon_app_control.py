#!/usr/bin/env python3
# Eaon app control, Linux engine.
#
# Reads apps' accessibility trees and acts on their elements through AT-SPI,
# the desktop's accessibility bus, using PyGObject's Atspi bindings
# (python3-gi and gir1.2-atspi-2.0 on Debian and Ubuntu, which desktops
# install with the screen reader stack). No screenshots and no pointer.
#
# Same protocol as the macOS engine (native/app-control/mac/main.swift): one
# JSON request per line on stdin, one JSON answer per line on stdout. Started
# by src/main/features/appControl/platform.ts; exits when stdin closes.

import json
import os
import random
import shutil
import signal
import string
import subprocess
import sys
import time

VERSION = "1.0.0"
IMPORT_PROBLEM = None
try:
    import gi

    gi.require_version("Atspi", "2.0")
    from gi.repository import Atspi
except Exception as error:  # noqa: BLE001 - any failure here means "not installed"
    IMPORT_PROBLEM = (
        "AT-SPI's Python bindings aren't installed (%s). On Debian or Ubuntu: sudo apt install python3-gi gir1.2-atspi-2.0" % error
    )


class Failure(Exception):
    def __init__(self, code, message):
        super().__init__(message)
        self.code = code
        self.message = message


def emit(obj):
    sys.stdout.write(json.dumps(obj, ensure_ascii=False) + "\n")
    sys.stdout.flush()


# ------------------------------------------------------------- snapshots

snapshots = {}
order = []
KEPT = 48


def new_snapshot(pid, store=True):
    if not store:
        return "ephemeral", {"pid": pid, "elements": []}
    while True:
        sid = "s" + "".join(random.choice(string.ascii_lowercase + string.digits) for _ in range(7))
        if sid not in snapshots:
            break
    snap = {"pid": pid, "elements": []}
    snapshots[sid] = snap
    order.append(sid)
    while len(order) > KEPT:
        snapshots.pop(order.pop(0), None)
    return sid, snap


def register(snap, acc):
    snap["elements"].append(acc)
    return len(snap["elements"])


def states_of(acc):
    try:
        return acc.get_state_set()
    except Exception:  # noqa: BLE001
        return None


def has(states, name):
    return bool(states) and states.contains(getattr(Atspi.StateType, name))


def lookup(req):
    sid = req.get("sid")
    n = req.get("n")
    if not isinstance(sid, str) or not isinstance(n, int):
        raise Failure("INVALID_ARGS", "A ref is required.")
    snap = snapshots.get(sid)
    if snap is None:
        raise Failure("STALE_REF", "That ref's snapshot is gone. Take a new snapshot.")
    if n < 1 or n > len(snap["elements"]):
        raise Failure("BAD_REF", "That snapshot has no element e%d." % n)
    acc = snap["elements"][n - 1]
    states = states_of(acc)
    if states is None or has(states, "DEFUNCT"):
        raise Failure("STALE_REF", "That element is no longer there (its window closed or the app redrew it). Take a new snapshot.")
    return acc, snap["pid"]


# ------------------------------------------------------------- properties

TEXT_ROLES = {"text", "entry", "password text", "paragraph", "label", "static", "caption", "heading", "document text", "terminal", "editbar"}
TOGGLE_ROLES = {"check box", "radio button", "toggle button", "check menu item", "radio menu item", "switch"}


def safe(fn, default=None):
    try:
        return fn()
    except Exception:  # noqa: BLE001
        return default


def clip(text, limit):
    if text is None:
        return None
    return text if len(text) <= limit else text[:limit] + "…"


def text_of(acc, limit):
    iface = safe(acc.get_text_iface)
    if iface is None:
        return None
    count = safe(iface.get_character_count, 0) or 0
    return clip(safe(lambda: iface.get_text(0, min(count, limit + 1)), "") or "", limit)


def extents(acc):
    comp = safe(acc.get_component_iface)
    if comp is None:
        return None
    rect = safe(lambda: comp.get_extents(Atspi.CoordType.SCREEN))
    # Hidden elements (a closed menu's items) report INT_MIN coordinates.
    if rect is None or rect.width <= 1 or rect.height <= 1 or rect.x <= -1000000 or rect.y <= -1000000:
        return None
    return [rect.x, rect.y, rect.width, rect.height]


def action_names(acc):
    iface = safe(acc.get_action_iface)
    if iface is None:
        return []
    return [safe(lambda i=i: iface.get_action_name(i), "") or "" for i in range(safe(iface.get_n_actions, 0) or 0)]


def identifier(acc):
    ident = safe(acc.get_accessible_id)
    if ident:
        return ident
    attrs = safe(acc.get_attributes) or {}
    return attrs.get("id") or attrs.get("html-id")


def describe(acc, value_limit=400, with_actions=True):
    role = safe(acc.get_role_name, "unknown") or "unknown"
    states = states_of(acc)
    node = {"role": role}
    name = safe(acc.get_name, "") or ""
    if name:
        node["title"] = clip(name, 300)
    description = safe(acc.get_description, "") or ""
    if description:
        node["description"] = clip(description, 300)
    secure = role == "password text"
    if secure:
        node["secure"] = True
    else:
        value = None
        value_iface = safe(acc.get_value_iface)
        if value_iface is not None and role not in TEXT_ROLES:
            current = safe(value_iface.get_current_value)
            if current is not None:
                value = ("%g" % current)
        if value is None and role in TEXT_ROLES:
            value = text_of(acc, value_limit)
            if role in ("label", "static", "caption", "heading", "paragraph") and value == name:
                value = None
        if value:
            node["value"] = value
    ident = identifier(acc)
    if ident:
        node["identifier"] = ident
    if states is not None:
        if not (has(states, "ENABLED") or has(states, "SENSITIVE")):
            node["enabled"] = False
        if has(states, "FOCUSED"):
            node["focused"] = True
        if has(states, "SELECTED"):
            node["selected"] = True
        if has(states, "EXPANDABLE"):
            node["expanded"] = has(states, "EXPANDED")
        if role in TOGGLE_ROLES:
            node["checked"] = "mixed" if has(states, "INDETERMINATE") else has(states, "CHECKED") or has(states, "PRESSED")
        if has(states, "MODAL"):
            node["modal"] = True
        if has(states, "REQUIRED"):
            node["required"] = True
        if has(states, "VISITED"):
            node["visited"] = True
        if has(states, "ICONIFIED"):
            node["minimized"] = True
        if has(states, "EDITABLE") and safe(acc.get_editable_text_iface) is not None:
            node["valueSettable"] = True
    rect = extents(acc)
    if rect:
        node["bounds"] = rect
    if with_actions:
        actions = [a for a in action_names(acc) if a]
        if actions:
            node["actions"] = actions
    return node


def children(acc):
    count = safe(acc.get_child_count, 0) or 0
    out = []
    for i in range(min(count, 2000)):
        child = safe(lambda i=i: acc.get_child_at_index(i))
        if child is not None:
            out.append(child)
    return out


def walk(acc, snap, limits, depth=0):
    node = describe(acc, limits["value"])
    node["n"] = register(snap, acc)
    limits["count"] += 1
    kids = children(acc)
    if not kids:
        return node
    if depth >= limits["depth"] or limits["count"] >= limits["max"]:
        node["more"] = len(kids)
        return node
    out = []
    for index, kid in enumerate(kids):
        if limits["count"] >= limits["max"]:
            node["more"] = len(kids) - index
            break
        out.append(walk(kid, snap, limits, depth + 1))
    node["children"] = out
    return node


# ------------------------------------------------------------------ apps

WINDOW_ROLES = {"frame", "dialog", "window", "alert", "file chooser"}


def desktop_apps():
    desktop = Atspi.get_desktop(0)
    return [app for app in children(desktop) if app is not None]


def app_pid(app):
    return safe(app.get_process_id, 0) or 0


def app_info(app):
    pid = app_pid(app)
    info = {"pid": pid, "name": safe(app.get_name, "") or ("pid %d" % pid)}
    exe = safe(lambda: os.readlink("/proc/%d/exe" % pid))
    if exe:
        info["path"] = exe
    windows = app_windows(app)
    info["active"] = any(has(states_of(w), "ACTIVE") for w in windows)
    info["regular"] = len(windows) > 0
    return info


def app_windows(app):
    return [w for w in children(app) if (safe(w.get_role_name, "") or "") in WINDOW_ROLES]


def find_app(pid):
    for app in desktop_apps():
        if app_pid(app) == pid:
            return app
    raise Failure("APP_NOT_FOUND", "That app (pid %d) isn't on the accessibility bus. It may have quit, or not expose accessibility." % pid)


def pid_of(req):
    pid = req.get("pid")
    if not isinstance(pid, int):
        raise Failure("INVALID_ARGS", "An app is required.")
    return pid


def active_window(app):
    windows = app_windows(app)
    for window in windows:
        if has(states_of(window), "ACTIVE"):
            return window
    return windows[0] if windows else None


def first_with_role(acc, role, budget=4000):
    stack = [acc]
    seen = 0
    while stack and seen < budget:
        current = stack.pop(0)
        seen += 1
        if (safe(current.get_role_name, "") or "") == role:
            return current
        stack.extend(children(current))
    return None


def focused_in(acc, budget=4000):
    stack = [acc]
    seen = 0
    while stack and seen < budget:
        current = stack.pop()
        seen += 1
        if has(states_of(current), "FOCUSED"):
            return current
        stack.extend(children(current))
    return None


# ----------------------------------------------------------------- keys

NAMED_KEYSYMS = {
    "return": 0xFF0D, "kpenter": 0xFF8D, "tab": 0xFF09, "space": 0x20, "escape": 0xFF1B, "backspace": 0xFF08,
    "delete": 0xFFFF, "insert": 0xFF63, "home": 0xFF50, "end": 0xFF57, "pageup": 0xFF55, "pagedown": 0xFF56,
    "left": 0xFF51, "up": 0xFF52, "right": 0xFF53, "down": 0xFF54, "capslock": 0xFFE5, "menu": 0xFF67,
    "printscreen": 0xFF61, "help": 0xFF6A, "minus": ord("-"), "equal": ord("="), "comma": ord(","),
    "period": ord("."), "slash": ord("/"), "semicolon": ord(";"), "quote": ord("'"), "grave": ord("`"),
    "bracketleft": ord("["), "bracketright": ord("]"), "backslash": ord("\\"),
}
MODIFIER_MASKS = {"shift": 1, "ctrl": 4, "control": 4, "alt": 8, "option": 8, "cmd": 64, "super": 64, "meta": 64, "win": 64}


def keysym(name):
    key = name.lower()
    if key in NAMED_KEYSYMS:
        return NAMED_KEYSYMS[key]
    if len(key) == 1:
        return ord(key)
    if key.startswith("f") and key[1:].isdigit() and 1 <= int(key[1:]) <= 20:
        return 0xFFBE + int(key[1:]) - 1
    raise Failure("INVALID_ARGS", 'Unknown key "%s".' % name)


def raise_app(pid):
    """Keyboard events go to the focused window on Linux, so focus the app's first."""
    app = find_app(pid)
    window = active_window(app)
    comp = safe(window.get_component_iface) if window is not None else None
    if comp is not None:
        safe(comp.grab_focus)


def press(pid, key, modifiers, times):
    raise_app(pid)
    mask = 0
    for modifier in modifiers:
        if modifier.lower() not in MODIFIER_MASKS:
            raise Failure("INVALID_ARGS", 'Unknown modifier "%s".' % modifier)
        mask |= MODIFIER_MASKS[modifier.lower()]
    sym = keysym(key)
    for _ in range(max(1, min(50, times))):
        if mask:
            Atspi.generate_keyboard_event(mask, None, Atspi.KeySynthType.LOCKMODIFIERS)
        Atspi.generate_keyboard_event(sym, None, Atspi.KeySynthType.SYM)
        if mask:
            Atspi.generate_keyboard_event(mask, None, Atspi.KeySynthType.UNLOCKMODIFIERS)
        time.sleep(0.03)
    time.sleep(0.05)


def settle_typing(text):
    """Synthesized keys reach the app asynchronously; give it time to take them in before anything reads the field."""
    time.sleep(min(3.0, 0.08 + 0.012 * len(text)))


def type_text(pid, text):
    raise_app(pid)
    Atspi.generate_keyboard_event(0, text, Atspi.KeySynthType.STRING)
    settle_typing(text)


# --------------------------------------------------------------- actions

PRESS_ACTIONS = ("click", "press", "activate", "toggle", "jump", "open", "select")


def do_named(acc, names):
    iface = safe(acc.get_action_iface)
    if iface is None:
        return False
    actions = action_names(acc)
    for wanted in names:
        for index, name in enumerate(actions):
            if name.lower() == wanted:
                return bool(safe(lambda index=index: iface.do_action(index), False))
    return False


def scroll_bar(area, vertical):
    for child in children(area):
        if (safe(child.get_role_name, "") or "") == "scroll bar":
            states = states_of(child)
            if vertical == has(states, "VERTICAL") or (not has(states, "VERTICAL") and not has(states, "HORIZONTAL")):
                return child
    return None


def act(acc, pid, req):
    action = req.get("action", "")
    note = None
    if action == "press":
        if not do_named(acc, PRESS_ACTIONS):
            iface = safe(acc.get_action_iface)
            if iface is None or not (safe(iface.get_n_actions, 0) or 0) or not safe(lambda: iface.do_action(0), False):
                raise Failure("ACTION_UNSUPPORTED", "That element can't be pressed (it offers: %s)." % (", ".join(action_names(acc)) or "nothing"))
    elif action == "open":
        if not do_named(acc, ("activate", "open")):
            raise Failure("ACTION_UNSUPPORTED", "That element has no open action; a double click needs the pointer (computer use).")
    elif action == "showmenu":
        if not do_named(acc, ("popup", "menu", "showmenu", "show menu", "context menu")):
            raise Failure("ACTION_UNSUPPORTED", "That element has no context menu.")
    elif action in ("increment", "decrement"):
        value = safe(acc.get_value_iface)
        if value is None:
            raise Failure("ACTION_UNSUPPORTED", "That element can't %s." % action)
        step = safe(value.get_minimum_increment, 0) or 1
        current = safe(value.get_current_value, 0) or 0
        value.set_current_value(current + (step if action == "increment" else -step))
    elif action == "setvalue":
        new = req.get("value")
        editable = safe(acc.get_editable_text_iface)
        value = safe(acc.get_value_iface)
        if editable is not None and isinstance(new, str):
            if not safe(lambda: editable.set_text_contents(new), False):
                raise Failure("ACTION_FAILED", "The app refused the new text.")
        elif value is not None:
            try:
                number = float(new)
            except (TypeError, ValueError):
                raise Failure("INVALID_ARGS", "That element takes a number.")
            if not safe(lambda: value.set_current_value(number), False):
                raise Failure("ACTION_FAILED", "The app refused the new value.")
        else:
            raise Failure("ACTION_UNSUPPORTED", "That element has no value to set.")
    elif action == "inserttext":
        text = req.get("text")
        if not isinstance(text, str):
            raise Failure("INVALID_ARGS", "Text is required.")
        comp = safe(acc.get_component_iface)
        if comp is not None and not has(states_of(acc), "FOCUSED"):
            safe(comp.grab_focus)
        editable = safe(acc.get_editable_text_iface)
        text_iface = safe(acc.get_text_iface)
        caret = safe(text_iface.get_caret_offset, -1) if text_iface is not None else -1
        if editable is not None and caret is not None and caret >= 0 and safe(lambda: editable.insert_text(caret, text, len(text)), False):
            note = "inserted"
        else:
            Atspi.generate_keyboard_event(0, text, Atspi.KeySynthType.STRING)
            settle_typing(text)
            note = "keys"
    elif action == "focus":
        comp = safe(acc.get_component_iface)
        if comp is None or not safe(comp.grab_focus, False):
            if not do_named(acc, ("activate",)):
                raise Failure("ACTION_FAILED", "The app wouldn't move focus there.")
    elif action == "select":
        parent = safe(acc.get_parent)
        selection = safe(parent.get_selection_iface) if parent is not None else None
        index = safe(acc.get_index_in_parent, -1)
        if not (selection is not None and index is not None and index >= 0 and safe(lambda: selection.select_child(index), False)):
            if not do_named(acc, PRESS_ACTIONS):
                raise Failure("ACTION_UNSUPPORTED", "That element can't be selected.")
    elif action in ("expand", "collapse"):
        want = action == "expand"
        if has(states_of(acc), "EXPANDED") != want:
            if not do_named(acc, ("expand or contract", "expand or collapse", action, "toggle", "activate")):
                raise Failure("ACTION_UNSUPPORTED", "That element can't %s." % action)
    elif action == "scrolltovisible":
        comp = safe(acc.get_component_iface)
        if comp is None or not safe(lambda: comp.scroll_to(Atspi.ScrollType.ANYWHERE), False):
            raise Failure("ACTION_UNSUPPORTED", "The app can't scroll that element into view.")
    elif action == "scroll":
        direction = req.get("direction", "down")
        units = max(1, int(req.get("units", 3)))
        vertical = direction in ("up", "down")
        sign = 1 if direction in ("down", "right") else -1
        area = acc
        for _ in range(12):
            if area is None:
                break
            if (safe(area.get_role_name, "") or "") in ("scroll pane", "viewport"):
                break
            area = safe(area.get_parent)
        bar = scroll_bar(area, vertical) if area is not None else None
        value = safe(bar.get_value_iface) if bar is not None else None
        if value is None:
            raise Failure("ACTION_UNSUPPORTED", "There is no scroll bar to move there.")
        low = safe(value.get_minimum_value, 0) or 0
        high = safe(value.get_maximum_value, 0) or 0
        step = (high - low) * 0.08 or 1
        current = safe(value.get_current_value, 0) or 0
        target = min(high, max(low, current + sign * step * units))
        value.set_current_value(target)
        note = "scrolled to %d%%" % (0 if high == low else round((target - low) * 100 / (high - low)))
    elif action == "setframe":
        comp = safe(acc.get_component_iface)
        if comp is None:
            raise Failure("ACTION_UNSUPPORTED", "That window can't be moved or resized.")
        ok = True
        if "x" in req and "y" in req:
            ok = safe(lambda: comp.set_position(int(req["x"]), int(req["y"]), Atspi.CoordType.SCREEN), False) and ok
        if "w" in req and "h" in req:
            ok = safe(lambda: comp.set_size(int(req["w"]), int(req["h"])), False) and ok
        if not ok:
            raise Failure("ACTION_FAILED", "The window manager didn't let it move or resize (common on Wayland).")
    elif action in ("close", "zoom", "minimize", "unminimize", "fullscreen", "unfullscreen", "raise"):
        labels = {"close": ("close",), "zoom": ("maximize", "maximise", "restore"), "minimize": ("minimize", "minimise")}.get(action)
        button = None
        if labels:
            stack, seen = [acc], 0
            while stack and seen < 400 and button is None:
                current = stack.pop(0)
                seen += 1
                if (safe(current.get_role_name, "") or "") == "push button" and (safe(current.get_name, "") or "").lower() in labels:
                    button = current
                stack.extend(children(current))
        if action == "raise":
            comp = safe(acc.get_component_iface)
            if comp is None or not safe(comp.grab_focus, False):
                raise Failure("ACTION_UNSUPPORTED", "That window can't be raised from here.")
        elif button is None or not do_named(button, PRESS_ACTIONS):
            raise Failure("ACTION_UNSUPPORTED", "Linux doesn't offer %s through accessibility for this window." % action)
    elif action in ("cancel", "confirm", "pick"):
        if not do_named(acc, (action,)):
            raise Failure("ACTION_UNSUPPORTED", "That element can't %s." % action)
    else:
        raise Failure("INVALID_ARGS", 'Unknown action "%s".' % action)
    result = {}
    if note:
        result["note"] = note
    time.sleep(0.05)
    states = states_of(acc)
    if states is None or has(states, "DEFUNCT"):
        result["gone"] = True
    else:
        result["after"] = describe(acc, 400, False)
    return result


# --------------------------------------------------------------- requests


def launch(req):
    target = req.get("path") or req.get("name") or req.get("bundleId")
    if not target:
        raise Failure("APP_NOT_FOUND", "Couldn't find that app.")
    wanted = os.path.basename(target).lower()
    for app in desktop_apps():
        if (safe(app.get_name, "") or "").lower() == wanted:
            info = app_info(app)
            info["alreadyRunning"] = True
            return info
    exe = target if os.path.sep in target else shutil.which(target)
    try:
        if exe:
            proc = subprocess.Popen([exe], stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, start_new_session=True)
        elif shutil.which("gtk-launch"):
            proc = subprocess.Popen(["gtk-launch", target], stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, start_new_session=True)
        else:
            raise Failure("APP_NOT_FOUND", "Couldn't find that app.")
    except OSError as error:
        raise Failure("ACTION_FAILED", "Couldn't start it: %s" % error)
    deadline = time.time() + float(req.get("timeout", 20))
    while time.time() < deadline:
        for app in desktop_apps():
            if app_pid(app) == proc.pid or (safe(app.get_name, "") or "").lower() == wanted:
                return app_info(app)
        time.sleep(0.2)
    raise Failure("TIMEOUT", "The app started but didn't show up on the accessibility bus in time.")


def handle(req):
    op = req.get("op", "")
    if op == "status":
        result = {"trusted": None, "version": VERSION}
        if IMPORT_PROBLEM:
            result["problem"] = IMPORT_PROBLEM
        else:
            try:
                Atspi.get_desktop(0).get_child_count()
            except Exception as error:  # noqa: BLE001
                result["problem"] = "No accessibility bus (AT-SPI) answers in this session: %s" % error
        return result
    if op == "ping":
        return {"pong": True}
    if IMPORT_PROBLEM:
        raise Failure("ENGINE_UNAVAILABLE", IMPORT_PROBLEM)

    if op == "apps":
        apps = [app_info(app) for app in desktop_apps()]
        return apps if req.get("all") else [app for app in apps if app.get("regular")]
    if op == "frontmost":
        for app in desktop_apps():
            if any(has(states_of(w), "ACTIVE") for w in app_windows(app)):
                return app_info(app)
        raise Failure("APP_NOT_FOUND", "No app is in front.")
    if op == "launch":
        return launch(req)
    if op == "quit":
        pid = pid_of(req)
        try:
            os.kill(pid, signal.SIGKILL if req.get("force") else signal.SIGTERM)
        except OSError as error:
            raise Failure("ACTION_FAILED", "Couldn't quit it: %s" % error)
        return {"requested": True}
    if op in ("hide", "unhide"):
        raise Failure("ACTION_UNSUPPORTED", "Linux doesn't offer hiding apps through accessibility.")
    if op == "activate":
        raise_app(pid_of(req))
        return {"done": True}
    if op == "windows":
        pids = [req["pid"]] if isinstance(req.get("pid"), int) else None
        out = []
        for app in desktop_apps():
            pid = app_pid(app)
            if pids is not None and pid not in pids:
                continue
            windows = app_windows(app)
            if not windows:
                continue
            sid, snap = new_snapshot(pid)
            for window in windows:
                info = describe(window, 100, False)
                info["focused"] = has(states_of(window), "ACTIVE")
                info["n"] = register(snap, window)
                info["sid"] = sid
                info["pid"] = pid
                out.append(info)
        return out
    if op == "snapshot":
        limits = {"depth": int(req.get("depth", 30)), "max": int(req.get("maxNodes", 4000)), "value": int(req.get("valueLimit", 400)), "count": 0}
        if req.get("sid") is not None:
            root, pid = lookup(req)
        else:
            pid = pid_of(req)
            app = find_app(pid)
            scope = req.get("scope", "window")
            if scope == "app":
                root = app
            elif scope == "menubar":
                window = active_window(app)
                root = first_with_role(window, "menu bar") if window is not None else None
                if root is None:
                    raise Failure("ELEMENT_NOT_FOUND", "That app has no menu bar.")
            else:
                root = active_window(app) or app
        sid, snap = new_snapshot(pid, not req.get("ephemeral"))
        tree = walk(root, snap, limits)
        return {"sid": sid, "pid": pid, "tree": tree, "count": limits["count"], "truncated": limits["count"] >= limits["max"]}
    if op == "surfaces":
        pid = pid_of(req)
        app = find_app(pid)
        sid, snap = new_snapshot(pid)
        out = []
        for window in children(app):
            role = safe(window.get_role_name, "") or ""
            if role in ("dialog", "alert", "file chooser", "popup menu", "menu", "window") or (role == "frame" and has(states_of(window), "MODAL")):
                info = describe(window, 100, False)
                info["n"] = register(snap, window)
                info["sid"] = sid
                out.append(info)
        return out
    if op == "focused":
        apps = [find_app(req["pid"])] if isinstance(req.get("pid"), int) else desktop_apps()
        for app in apps:
            window = active_window(app)
            if window is None or (not isinstance(req.get("pid"), int) and not has(states_of(window), "ACTIVE")):
                continue
            element = focused_in(window)
            if element is not None:
                pid = app_pid(app)
                sid, snap = new_snapshot(pid)
                node = describe(element)
                node["n"] = register(snap, element)
                return {"sid": sid, "pid": pid, "node": node}
        raise Failure("ELEMENT_NOT_FOUND", "Nothing has keyboard focus.")
    if op == "read":
        acc, pid = lookup(req)
        node = describe(acc, int(req.get("valueLimit", 20000)))
        node["n"] = req.get("n")
        node["pid"] = pid
        return node
    if op == "act":
        acc, pid = lookup(req)
        return act(acc, pid, req)
    if op == "keys":
        press(pid_of(req), str(req.get("key", "")), list(req.get("modifiers") or []), int(req.get("repeat", 1)))
        return {"done": True}
    if op == "text":
        text = req.get("text")
        if not isinstance(text, str):
            raise Failure("INVALID_ARGS", "Text is required.")
        type_text(pid_of(req), text)
        return {"done": True}
    raise Failure("INVALID_ARGS", 'Unknown op "%s".' % op)


def main():
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            req = json.loads(line)
            if not isinstance(req, dict):
                raise ValueError
        except ValueError:
            emit({"id": None, "ok": False, "code": "INVALID_ARGS", "message": "Not a JSON object."})
            continue
        try:
            emit({"id": req.get("id"), "ok": True, "result": handle(req)})
        except Failure as failure:
            emit({"id": req.get("id"), "ok": False, "code": failure.code, "message": failure.message})
        except Exception as error:  # noqa: BLE001
            emit({"id": req.get("id"), "ok": False, "code": "INTERNAL", "message": str(error)})


if __name__ == "__main__":
    main()
