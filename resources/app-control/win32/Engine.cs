// Eaon app control, Windows engine.
//
// Reads apps' accessibility trees and acts on their elements through UI
// Automation, which ships with Windows. No screenshots and no pointer: keys
// and text go to the target's window, which is brought forward first.
//
// Same protocol as the macOS engine (native/app-control/mac/main.swift): one
// JSON request per line on stdin, one JSON answer per line on stdout.
// Compiled by eaon-app-control.ps1 with Windows PowerShell's Add-Type, so it
// is written in C# 5 (no interpolated strings, no ?. operator).

using System;
using System.Collections;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Linq;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using System.Web.Script.Serialization;
using System.Windows.Automation;

namespace EaonAppControl
{
    public class Failure : Exception
    {
        public readonly string Code;
        public Failure(string code, string message) : base(message) { Code = code; }
    }

    class Snapshot
    {
        public int Pid;
        public List<AutomationElement> Elements = new List<AutomationElement>();
    }

    public static class Engine
    {
        const string Version = "1.0.0";
        const int Kept = 48;
        static readonly Dictionary<string, Snapshot> Snapshots = new Dictionary<string, Snapshot>();
        static readonly List<string> Order = new List<string>();
        static readonly Random Rng = new Random();
        static readonly JavaScriptSerializer Json = new JavaScriptSerializer { MaxJsonLength = int.MaxValue, RecursionLimit = 400 };

        // ------------------------------------------------------------ snapshots

        static string NewSnapshot(int pid, bool store, out Snapshot snapshot)
        {
            snapshot = new Snapshot { Pid = pid };
            if (!store) return "ephemeral";
            const string letters = "abcdefghijklmnopqrstuvwxyz0123456789";
            string id;
            do
            {
                var chars = new char[7];
                for (int i = 0; i < 7; i++) chars[i] = letters[Rng.Next(letters.Length)];
                id = "s" + new string(chars);
            } while (Snapshots.ContainsKey(id));
            Snapshots[id] = snapshot;
            Order.Add(id);
            while (Order.Count > Kept)
            {
                Snapshots.Remove(Order[0]);
                Order.RemoveAt(0);
            }
            return id;
        }

        static int Register(Snapshot snapshot, AutomationElement element)
        {
            snapshot.Elements.Add(element);
            return snapshot.Elements.Count;
        }

        static AutomationElement Lookup(Dictionary<string, object> req, out int pid)
        {
            object sidValue, nValue;
            req.TryGetValue("sid", out sidValue);
            req.TryGetValue("n", out nValue);
            var sid = sidValue as string;
            if (sid == null || !(nValue is int)) throw new Failure("INVALID_ARGS", "A ref is required.");
            int n = (int)nValue;
            Snapshot snapshot;
            if (!Snapshots.TryGetValue(sid, out snapshot)) throw new Failure("STALE_REF", "That ref's snapshot is gone. Take a new snapshot.");
            if (n < 1 || n > snapshot.Elements.Count) throw new Failure("BAD_REF", "That snapshot has no element e" + n + ".");
            var element = snapshot.Elements[n - 1];
            try
            {
                var unused = element.Current.ControlType;
            }
            catch (ElementNotAvailableException)
            {
                throw new Failure("STALE_REF", "That element is no longer there (its window closed or the app redrew it). Take a new snapshot.");
            }
            pid = snapshot.Pid;
            return element;
        }

        // ------------------------------------------------------------ properties

        static object Pattern(AutomationElement element, AutomationPattern pattern)
        {
            object found;
            try
            {
                return element.TryGetCurrentPattern(pattern, out found) ? found : null;
            }
            catch (Exception)
            {
                return null;
            }
        }

        static string Clip(string text, int limit)
        {
            if (text == null) return null;
            return text.Length <= limit ? text : text.Substring(0, limit) + "…";
        }

        static string RoleOf(AutomationElement element)
        {
            var name = element.Current.ControlType.ProgrammaticName;
            return name.StartsWith("ControlType.") ? name.Substring("ControlType.".Length) : name;
        }

        static Dictionary<string, object> Describe(AutomationElement element, int valueLimit, bool withActions)
        {
            var node = new Dictionary<string, object>();
            AutomationElement.AutomationElementInformation info;
            try
            {
                info = element.Current;
            }
            catch (ElementNotAvailableException)
            {
                throw new Failure("STALE_REF", "That element is no longer there. Take a new snapshot.");
            }
            node["role"] = RoleOf(element);
            if (!string.IsNullOrEmpty(info.Name)) node["title"] = Clip(info.Name, 300);
            if (!string.IsNullOrEmpty(info.HelpText)) node["help"] = Clip(info.HelpText, 300);
            if (!string.IsNullOrEmpty(info.AutomationId)) node["identifier"] = Clip(info.AutomationId, 200);
            if (!info.IsEnabled) node["enabled"] = false;
            if (info.HasKeyboardFocus) node["focused"] = true;
            if (info.IsPassword) node["secure"] = true;
            var rect = info.BoundingRectangle;
            if (!rect.IsEmpty && rect.Width > 0 && rect.Height > 0 && !double.IsInfinity(rect.X))
                node["bounds"] = new object[] { Math.Round(rect.X), Math.Round(rect.Y), Math.Round(rect.Width), Math.Round(rect.Height) };

            var actions = new List<string>();
            var value = Pattern(element, ValuePattern.Pattern) as ValuePattern;
            if (value != null)
            {
                if (!info.IsPassword)
                {
                    var text = Clip(value.Current.Value, valueLimit);
                    if (!string.IsNullOrEmpty(text)) node["value"] = text;
                }
                if (!value.Current.IsReadOnly) node["valueSettable"] = true;
            }
            var range = Pattern(element, RangeValuePattern.Pattern) as RangeValuePattern;
            if (range != null)
            {
                if (!node.ContainsKey("value")) node["value"] = range.Current.Value.ToString(System.Globalization.CultureInfo.InvariantCulture);
                if (!range.Current.IsReadOnly) { node["valueSettable"] = true; actions.Add("increment"); }
            }
            var toggle = Pattern(element, TogglePattern.Pattern) as TogglePattern;
            if (toggle != null)
            {
                var state = toggle.Current.ToggleState;
                if (state == ToggleState.Indeterminate) node["checked"] = "mixed";
                else node["checked"] = state == ToggleState.On;
                actions.Add("toggle");
            }
            var selection = Pattern(element, SelectionItemPattern.Pattern) as SelectionItemPattern;
            if (selection != null)
            {
                if (selection.Current.IsSelected) node["selected"] = true;
                actions.Add("select");
            }
            var expand = Pattern(element, ExpandCollapsePattern.Pattern) as ExpandCollapsePattern;
            if (expand != null)
            {
                var state = expand.Current.ExpandCollapseState;
                if (state == ExpandCollapseState.Expanded || state == ExpandCollapseState.PartiallyExpanded) node["expanded"] = true;
                else if (state == ExpandCollapseState.Collapsed) node["expanded"] = false;
                actions.Add("expand");
            }
            var window = Pattern(element, WindowPattern.Pattern) as WindowPattern;
            if (window != null)
            {
                if (window.Current.WindowVisualState == WindowVisualState.Minimized) node["minimized"] = true;
                if (window.Current.IsModal) node["modal"] = true;
            }
            if (Pattern(element, InvokePattern.Pattern) != null) actions.Insert(0, "invoke");
            if (withActions && actions.Count > 0) node["actions"] = actions;
            return node;
        }

        static readonly TreeWalker Walker = TreeWalker.ControlViewWalker;

        static List<AutomationElement> Children(AutomationElement element)
        {
            var list = new List<AutomationElement>();
            try
            {
                var child = Walker.GetFirstChild(element);
                while (child != null && list.Count < 2000)
                {
                    list.Add(child);
                    child = Walker.GetNextSibling(child);
                }
            }
            catch (ElementNotAvailableException) { }
            return list;
        }

        class Limits
        {
            public int Depth;
            public int Max;
            public int ValueLimit;
            public int Count;
        }

        static Dictionary<string, object> Walk(AutomationElement element, Snapshot snapshot, Limits limits, int depth)
        {
            var node = Describe(element, limits.ValueLimit, true);
            node["n"] = Register(snapshot, element);
            limits.Count++;
            var kids = Children(element);
            if (kids.Count == 0) return node;
            if (depth >= limits.Depth || limits.Count >= limits.Max)
            {
                node["more"] = kids.Count;
                return node;
            }
            var output = new List<object>();
            for (int i = 0; i < kids.Count; i++)
            {
                if (limits.Count >= limits.Max)
                {
                    node["more"] = kids.Count - i;
                    break;
                }
                try
                {
                    output.Add(Walk(kids[i], snapshot, limits, depth + 1));
                }
                catch (Failure) { }
            }
            node["children"] = output;
            return node;
        }

        // ------------------------------------------------------------------ apps

        static List<AutomationElement> TopWindows(int pid)
        {
            var condition = pid > 0
                ? (Condition)new PropertyCondition(AutomationElement.ProcessIdProperty, pid)
                : Condition.TrueCondition;
            var found = AutomationElement.RootElement.FindAll(TreeScope.Children, condition);
            var list = new List<AutomationElement>();
            foreach (AutomationElement element in found) list.Add(element);
            return list;
        }

        static Dictionary<string, object> AppInfo(int pid, int frontPid)
        {
            var info = new Dictionary<string, object>();
            info["pid"] = pid;
            string name = null;
            try
            {
                var process = Process.GetProcessById(pid);
                name = process.ProcessName;
                try
                {
                    var path = process.MainModule.FileName;
                    info["path"] = path;
                    var description = FileVersionInfo.GetVersionInfo(path).FileDescription;
                    if (!string.IsNullOrWhiteSpace(description)) name = description.Trim();
                }
                catch (Exception) { }
            }
            catch (Exception) { }
            info["name"] = name ?? ("pid " + pid);
            info["active"] = pid == frontPid;
            info["regular"] = true;
            return info;
        }

        static int PidOf(Dictionary<string, object> req)
        {
            object value;
            if (!req.TryGetValue("pid", out value) || !(value is int)) throw new Failure("INVALID_ARGS", "An app is required.");
            int pid = (int)value;
            try
            {
                Process.GetProcessById(pid);
            }
            catch (ArgumentException)
            {
                throw new Failure("APP_NOT_FOUND", "That app (pid " + pid + ") is not running.");
            }
            return pid;
        }

        static AutomationElement MainWindow(int pid)
        {
            var windows = TopWindows(pid);
            if (windows.Count == 0) return null;
            var front = Native.GetForegroundWindow();
            foreach (var window in windows)
            {
                if (new IntPtr(window.Current.NativeWindowHandle) == front) return window;
            }
            return windows[0];
        }

        // -------------------------------------------------------------- keyboard

        static readonly Dictionary<string, ushort> NamedKeys = new Dictionary<string, ushort>
        {
            { "return", 0x0D }, { "kpenter", 0x0D }, { "tab", 0x09 }, { "space", 0x20 }, { "escape", 0x1B },
            { "backspace", 0x08 }, { "delete", 0x2E }, { "insert", 0x2D }, { "home", 0x24 }, { "end", 0x23 },
            { "pageup", 0x21 }, { "pagedown", 0x22 }, { "left", 0x25 }, { "up", 0x26 }, { "right", 0x27 },
            { "down", 0x28 }, { "capslock", 0x14 }, { "menu", 0x5D }, { "printscreen", 0x2C }, { "help", 0x2F },
            { "minus", 0xBD }, { "equal", 0xBB }, { "comma", 0xBC }, { "period", 0xBE }, { "slash", 0xBF },
            { "semicolon", 0xBA }, { "quote", 0xDE }, { "grave", 0xC0 }, { "bracketleft", 0xDB },
            { "bracketright", 0xDD }, { "backslash", 0xDC }
        };

        static ushort KeyCode(string name)
        {
            var key = name.ToLowerInvariant();
            ushort code;
            if (NamedKeys.TryGetValue(key, out code)) return code;
            if (key.Length == 1 && char.IsLetterOrDigit(key[0])) return (ushort)char.ToUpperInvariant(key[0]);
            int f;
            if (key.StartsWith("f") && int.TryParse(key.Substring(1), out f) && f >= 1 && f <= 20) return (ushort)(0x70 + f - 1);
            throw new Failure("INVALID_ARGS", "Unknown key \"" + name + "\".");
        }

        static ushort ModifierCode(string name)
        {
            switch (name.ToLowerInvariant())
            {
                case "ctrl": case "control": return 0x11;
                case "shift": return 0x10;
                case "alt": case "option": return 0x12;
                case "cmd": case "win": case "meta": case "super": return 0x5B;
                default: throw new Failure("INVALID_ARGS", "Unknown modifier \"" + name + "\".");
            }
        }

        /** Keyboard input reaches whatever is in front, so bring the app's window forward first. */
        static void Raise(int pid)
        {
            var window = MainWindow(pid);
            if (window == null) throw new Failure("WINDOW_NOT_FOUND", "That app has no window to send keys to.");
            var handle = new IntPtr(window.Current.NativeWindowHandle);
            if (Native.GetForegroundWindow() == handle) return;
            // Windows lets a background process take the foreground only right after input; a lone Alt counts.
            Native.SendKeys(new[] { (ushort)0x12 }, true);
            Native.SendKeys(new[] { (ushort)0x12 }, false);
            Native.SetForegroundWindow(handle);
            Thread.Sleep(80);
        }

        // --------------------------------------------------------------- actions

        static void Act(AutomationElement element, int pid, Dictionary<string, object> req, Dictionary<string, object> result)
        {
            var action = Str(req, "action") ?? "";
            switch (action)
            {
                case "press":
                case "open":
                    {
                        var invoke = Pattern(element, InvokePattern.Pattern) as InvokePattern;
                        if (invoke != null) { invoke.Invoke(); break; }
                        if (action == "open") throw new Failure("ACTION_UNSUPPORTED", "That element has no open action; a double click needs the pointer (computer use).");
                        var toggle = Pattern(element, TogglePattern.Pattern) as TogglePattern;
                        if (toggle != null) { toggle.Toggle(); break; }
                        var select = Pattern(element, SelectionItemPattern.Pattern) as SelectionItemPattern;
                        if (select != null) { select.Select(); result["note"] = "selected"; break; }
                        var expand = Pattern(element, ExpandCollapsePattern.Pattern) as ExpandCollapsePattern;
                        if (expand != null)
                        {
                            if (expand.Current.ExpandCollapseState == ExpandCollapseState.Expanded) expand.Collapse(); else expand.Expand();
                            break;
                        }
                        throw new Failure("ACTION_UNSUPPORTED", "That element can't be pressed.");
                    }
                case "showmenu":
                    element.SetFocus();
                    Raise(pid);
                    Native.SendKeys(new ushort[] { 0x10, 0x79 }, true);
                    Native.SendKeys(new ushort[] { 0x79, 0x10 }, false);
                    break;
                case "increment":
                case "decrement":
                    {
                        var range = Pattern(element, RangeValuePattern.Pattern) as RangeValuePattern;
                        if (range == null) throw new Failure("ACTION_UNSUPPORTED", "That element can't " + action + ".");
                        var step = range.Current.SmallChange > 0 ? range.Current.SmallChange : 1;
                        range.SetValue(Math.Max(range.Current.Minimum, Math.Min(range.Current.Maximum, range.Current.Value + (action == "increment" ? step : -step))));
                        break;
                    }
                case "setvalue":
                    {
                        object raw;
                        req.TryGetValue("value", out raw);
                        var range = Pattern(element, RangeValuePattern.Pattern) as RangeValuePattern;
                        var value = Pattern(element, ValuePattern.Pattern) as ValuePattern;
                        if (range != null && (raw is int || raw is decimal || raw is double)) { range.SetValue(Convert.ToDouble(raw)); break; }
                        if (value != null) { value.SetValue(raw == null ? "" : Convert.ToString(raw, System.Globalization.CultureInfo.InvariantCulture)); break; }
                        if (range != null)
                        {
                            double number;
                            if (!double.TryParse(Convert.ToString(raw), System.Globalization.NumberStyles.Float, System.Globalization.CultureInfo.InvariantCulture, out number)) throw new Failure("INVALID_ARGS", "That element takes a number.");
                            range.SetValue(number);
                            break;
                        }
                        throw new Failure("ACTION_UNSUPPORTED", "That element has no value to set.");
                    }
                case "inserttext":
                    {
                        var text = Str(req, "text");
                        if (text == null) throw new Failure("INVALID_ARGS", "Text is required.");
                        try { element.SetFocus(); } catch (Exception) { }
                        Raise(pid);
                        Native.TypeText(text);
                        result["note"] = "keys";
                        break;
                    }
                case "focus":
                    {
                        var handle = element.Current.NativeWindowHandle;
                        if (handle != 0 && element.Current.ControlType == ControlType.Window)
                        {
                            Native.SendKeys(new[] { (ushort)0x12 }, true);
                            Native.SendKeys(new[] { (ushort)0x12 }, false);
                            Native.SetForegroundWindow(new IntPtr(handle));
                        }
                        element.SetFocus();
                        break;
                    }
                case "select":
                    {
                        var select = Pattern(element, SelectionItemPattern.Pattern) as SelectionItemPattern;
                        if (select != null) { select.Select(); break; }
                        var invoke = Pattern(element, InvokePattern.Pattern) as InvokePattern;
                        if (invoke != null) { invoke.Invoke(); break; }
                        throw new Failure("ACTION_UNSUPPORTED", "That element can't be selected.");
                    }
                case "expand":
                case "collapse":
                    {
                        var expand = Pattern(element, ExpandCollapsePattern.Pattern) as ExpandCollapsePattern;
                        if (expand == null) throw new Failure("ACTION_UNSUPPORTED", "That element can't " + action + ".");
                        if (action == "expand") expand.Expand(); else expand.Collapse();
                        break;
                    }
                case "scrolltovisible":
                    {
                        var item = Pattern(element, ScrollItemPattern.Pattern) as ScrollItemPattern;
                        if (item == null) throw new Failure("ACTION_UNSUPPORTED", "The app can't scroll that element into view.");
                        item.ScrollIntoView();
                        break;
                    }
                case "scroll":
                    {
                        var direction = Str(req, "direction") ?? "down";
                        int units = Math.Max(1, Int(req, "units", 3));
                        AutomationElement current = element;
                        ScrollPattern scroll = null;
                        for (int i = 0; i < 12 && current != null && scroll == null; i++)
                        {
                            scroll = Pattern(current, ScrollPattern.Pattern) as ScrollPattern;
                            if (scroll == null) current = Walker.GetParent(current);
                        }
                        if (scroll == null) throw new Failure("ACTION_UNSUPPORTED", "There is no scroll area there.");
                        var vertical = direction == "up" || direction == "down";
                        var amount = (direction == "down" || direction == "right") ? ScrollAmount.SmallIncrement : ScrollAmount.SmallDecrement;
                        for (int i = 0; i < units; i++)
                        {
                            if (vertical) scroll.ScrollVertical(amount); else scroll.ScrollHorizontal(amount);
                        }
                        break;
                    }
                case "setframe":
                    {
                        var transform = Pattern(element, TransformPattern.Pattern) as TransformPattern;
                        if (transform == null) throw new Failure("ACTION_UNSUPPORTED", "That window can't be moved or resized.");
                        if (req.ContainsKey("x") && req.ContainsKey("y"))
                        {
                            if (!transform.Current.CanMove) throw new Failure("ACTION_FAILED", "That window can't be moved.");
                            transform.Move(Dbl(req, "x"), Dbl(req, "y"));
                        }
                        if (req.ContainsKey("w") && req.ContainsKey("h"))
                        {
                            if (!transform.Current.CanResize) throw new Failure("ACTION_FAILED", "That window can't be resized.");
                            transform.Resize(Dbl(req, "w"), Dbl(req, "h"));
                        }
                        break;
                    }
                case "minimize":
                case "unminimize":
                case "zoom":
                case "close":
                case "unfullscreen":
                    {
                        var window = Pattern(element, WindowPattern.Pattern) as WindowPattern;
                        if (window == null) throw new Failure("ACTION_UNSUPPORTED", "That isn't a window.");
                        if (action == "close") window.Close();
                        else if (action == "minimize") window.SetWindowVisualState(WindowVisualState.Minimized);
                        else if (action == "zoom") window.SetWindowVisualState(WindowVisualState.Maximized);
                        else window.SetWindowVisualState(WindowVisualState.Normal);
                        break;
                    }
                case "raise":
                    element.SetFocus();
                    break;
                default:
                    throw new Failure("ACTION_UNSUPPORTED", "Windows doesn't offer \"" + action + "\" through UI Automation.");
            }
            Thread.Sleep(60);
            try
            {
                result["after"] = Describe(element, 400, false);
            }
            catch (Failure)
            {
                result["gone"] = true;
            }
        }

        // -------------------------------------------------------------- requests

        static string Str(Dictionary<string, object> req, string key)
        {
            object value;
            return req.TryGetValue(key, out value) ? value as string : null;
        }

        static int Int(Dictionary<string, object> req, string key, int fallback)
        {
            object value;
            if (!req.TryGetValue(key, out value) || value == null) return fallback;
            try { return Convert.ToInt32(value); } catch (Exception) { return fallback; }
        }

        static double Dbl(Dictionary<string, object> req, string key)
        {
            return Convert.ToDouble(req[key], System.Globalization.CultureInfo.InvariantCulture);
        }

        static bool Bool(Dictionary<string, object> req, string key)
        {
            object value;
            return req.TryGetValue(key, out value) && value is bool && (bool)value;
        }

        static int ForegroundPid()
        {
            uint pid;
            Native.GetWindowThreadProcessId(Native.GetForegroundWindow(), out pid);
            return (int)pid;
        }

        static object Handle(Dictionary<string, object> req)
        {
            var op = Str(req, "op") ?? "";
            switch (op)
            {
                case "status":
                    return new Dictionary<string, object> { { "trusted", null }, { "version", Version }, { "os", Environment.OSVersion.VersionString } };
                case "ping":
                    return new Dictionary<string, object> { { "pong", true } };
                case "apps":
                    {
                        var front = ForegroundPid();
                        var pids = new SortedSet<int>();
                        foreach (var window in TopWindows(0))
                        {
                            try { pids.Add(window.Current.ProcessId); } catch (ElementNotAvailableException) { }
                        }
                        pids.Remove(0);
                        return pids.Select(pid => (object)AppInfo(pid, front)).ToList();
                    }
                case "frontmost":
                    {
                        var pid = ForegroundPid();
                        if (pid == 0) throw new Failure("APP_NOT_FOUND", "No app is in front.");
                        return AppInfo(pid, pid);
                    }
                case "launch":
                    {
                        var target = Str(req, "path") ?? Str(req, "name") ?? Str(req, "bundleId");
                        if (string.IsNullOrEmpty(target)) throw new Failure("APP_NOT_FOUND", "Couldn't find that app.");
                        var wanted = Path.GetFileNameWithoutExtension(target).ToLowerInvariant();
                        var front = ForegroundPid();
                        foreach (var window in TopWindows(0))
                        {
                            int pid;
                            try { pid = window.Current.ProcessId; } catch (ElementNotAvailableException) { continue; }
                            var info = AppInfo(pid, front);
                            var path = info.ContainsKey("path") ? Path.GetFileNameWithoutExtension((string)info["path"]).ToLowerInvariant() : "";
                            if (path == wanted || ((string)info["name"]).ToLowerInvariant() == wanted)
                            {
                                info["alreadyRunning"] = true;
                                return info;
                            }
                        }
                        Process process;
                        try
                        {
                            process = Process.Start(new ProcessStartInfo(target) { UseShellExecute = true });
                        }
                        catch (Exception error)
                        {
                            throw new Failure("APP_NOT_FOUND", "Couldn't start it: " + error.Message);
                        }
                        var deadline = DateTime.UtcNow.AddSeconds(Int(req, "timeout", 20));
                        while (DateTime.UtcNow < deadline)
                        {
                            if (process != null)
                            {
                                try
                                {
                                    process.Refresh();
                                    if (!process.HasExited && TopWindows(process.Id).Count > 0) return AppInfo(process.Id, ForegroundPid());
                                }
                                catch (Exception) { }
                            }
                            foreach (var window in TopWindows(0))
                            {
                                int pid;
                                try { pid = window.Current.ProcessId; } catch (ElementNotAvailableException) { continue; }
                                var info = AppInfo(pid, 0);
                                var path = info.ContainsKey("path") ? Path.GetFileNameWithoutExtension((string)info["path"]).ToLowerInvariant() : "";
                                if (path == wanted) return info;
                            }
                            Thread.Sleep(200);
                        }
                        if (process != null) return AppInfo(process.Id, 0);
                        throw new Failure("TIMEOUT", "The app didn't open a window in time.");
                    }
                case "quit":
                    {
                        var process = Process.GetProcessById(PidOf(req));
                        if (Bool(req, "force")) process.Kill();
                        else process.CloseMainWindow();
                        return new Dictionary<string, object> { { "requested", true } };
                    }
                case "hide":
                case "unhide":
                    throw new Failure("ACTION_UNSUPPORTED", "Windows has no hiding apps; minimize their windows instead.");
                case "activate":
                    Raise(PidOf(req));
                    return new Dictionary<string, object> { { "done", true } };
                case "windows":
                    {
                        int only = req.ContainsKey("pid") ? PidOf(req) : 0;
                        var output = new List<object>();
                        var groups = new Dictionary<int, KeyValuePair<string, Snapshot>>();
                        var front = Native.GetForegroundWindow();
                        foreach (var window in TopWindows(only))
                        {
                            int pid;
                            try { pid = window.Current.ProcessId; } catch (ElementNotAvailableException) { continue; }
                            KeyValuePair<string, Snapshot> group;
                            if (!groups.TryGetValue(pid, out group))
                            {
                                Snapshot snapshot;
                                var sid = NewSnapshot(pid, true, out snapshot);
                                group = new KeyValuePair<string, Snapshot>(sid, snapshot);
                                groups[pid] = group;
                            }
                            Dictionary<string, object> info;
                            try { info = Describe(window, 100, false); } catch (Failure) { continue; }
                            info["focused"] = new IntPtr(window.Current.NativeWindowHandle) == front;
                            info["n"] = Register(group.Value, window);
                            info["sid"] = group.Key;
                            info["pid"] = pid;
                            output.Add(info);
                        }
                        return output;
                    }
                case "snapshot":
                    {
                        var limits = new Limits { Depth = Int(req, "depth", 30), Max = Int(req, "maxNodes", 4000), ValueLimit = Int(req, "valueLimit", 400) };
                        AutomationElement root;
                        int pid;
                        if (req.ContainsKey("sid")) root = Lookup(req, out pid);
                        else
                        {
                            pid = PidOf(req);
                            var scope = Str(req, "scope") ?? "window";
                            var main = MainWindow(pid);
                            if (main == null) throw new Failure("WINDOW_NOT_FOUND", "That app has no windows open.");
                            if (scope == "menubar")
                            {
                                root = main.FindFirst(TreeScope.Descendants, new PropertyCondition(AutomationElement.ControlTypeProperty, ControlType.MenuBar));
                                if (root == null) throw new Failure("ELEMENT_NOT_FOUND", "That app has no menu bar.");
                            }
                            else root = main;
                        }
                        Snapshot snapshot;
                        var sid = NewSnapshot(pid, !Bool(req, "ephemeral"), out snapshot);
                        Dictionary<string, object> tree;
                        if (!req.ContainsKey("sid") && Str(req, "scope") == "app")
                        {
                            // Every top-level window of the app, under a made-up root that is no
                            // element (e0 isn't a ref, so nothing can act on it).
                            tree = new Dictionary<string, object> { { "role", "Application" }, { "n", 0 }, { "title", AppInfo(pid, 0)["name"] } };
                            var windows = new List<object>();
                            foreach (var window in TopWindows(pid)) windows.Add(Walk(window, snapshot, limits, 1));
                            tree["children"] = windows;
                        }
                        else tree = Walk(root, snapshot, limits, 0);
                        return new Dictionary<string, object> { { "sid", sid }, { "pid", pid }, { "tree", tree }, { "count", limits.Count }, { "truncated", limits.Count >= limits.Max } };
                    }
                case "surfaces":
                    {
                        var pid = PidOf(req);
                        Snapshot snapshot;
                        var sid = NewSnapshot(pid, true, out snapshot);
                        var output = new List<object>();
                        foreach (var window in TopWindows(pid))
                        {
                            var type = window.Current.ControlType;
                            var pattern = Pattern(window, WindowPattern.Pattern) as WindowPattern;
                            if (type == ControlType.Menu || (pattern != null && pattern.Current.IsModal))
                            {
                                var info = Describe(window, 100, false);
                                info["n"] = Register(snapshot, window);
                                info["sid"] = sid;
                                output.Add(info);
                            }
                        }
                        return output;
                    }
                case "focused":
                    {
                        var element = AutomationElement.FocusedElement;
                        if (element == null) throw new Failure("ELEMENT_NOT_FOUND", "Nothing has keyboard focus.");
                        var pid = element.Current.ProcessId;
                        if (req.ContainsKey("pid") && PidOf(req) != pid) throw new Failure("ELEMENT_NOT_FOUND", "That app doesn't have keyboard focus.");
                        Snapshot snapshot;
                        var sid = NewSnapshot(pid, true, out snapshot);
                        var node = Describe(element, 400, true);
                        node["n"] = Register(snapshot, element);
                        return new Dictionary<string, object> { { "sid", sid }, { "pid", pid }, { "node", node } };
                    }
                case "read":
                    {
                        int pid;
                        var element = Lookup(req, out pid);
                        var node = Describe(element, Int(req, "valueLimit", 20000), true);
                        node["n"] = req["n"];
                        node["pid"] = pid;
                        return node;
                    }
                case "act":
                    {
                        int pid;
                        var element = Lookup(req, out pid);
                        var result = new Dictionary<string, object>();
                        Act(element, pid, req, result);
                        return result;
                    }
                case "keys":
                    {
                        var pid = PidOf(req);
                        var key = KeyCode(Str(req, "key") ?? "");
                        var modifiers = new List<ushort>();
                        object raw;
                        if (req.TryGetValue("modifiers", out raw) && raw is ArrayList)
                            foreach (var item in (ArrayList)raw) modifiers.Add(ModifierCode(Convert.ToString(item)));
                        Raise(pid);
                        int times = Math.Max(1, Math.Min(50, Int(req, "repeat", 1)));
                        for (int i = 0; i < times; i++)
                        {
                            var down = new List<ushort>(modifiers) { key };
                            Native.SendKeys(down.ToArray(), true);
                            down.Reverse();
                            Native.SendKeys(down.ToArray(), false);
                            Thread.Sleep(10);
                        }
                        return new Dictionary<string, object> { { "done", true } };
                    }
                case "text":
                    {
                        var pid = PidOf(req);
                        var text = Str(req, "text");
                        if (text == null) throw new Failure("INVALID_ARGS", "Text is required.");
                        Raise(pid);
                        Native.TypeText(text);
                        return new Dictionary<string, object> { { "done", true } };
                    }
                default:
                    throw new Failure("INVALID_ARGS", "Unknown op \"" + op + "\".");
            }
        }

        public static void Run()
        {
            var utf8 = new UTF8Encoding(false);
            var input = new StreamReader(Console.OpenStandardInput(), utf8);
            var output = new StreamWriter(Console.OpenStandardOutput(), utf8) { AutoFlush = true };
            string line;
            while ((line = input.ReadLine()) != null)
            {
                if (line.Trim().Length == 0) continue;
                Dictionary<string, object> req;
                try
                {
                    req = Json.Deserialize<Dictionary<string, object>>(line);
                }
                catch (Exception)
                {
                    output.WriteLine(Json.Serialize(new Dictionary<string, object> { { "id", null }, { "ok", false }, { "code", "INVALID_ARGS" }, { "message", "Not a JSON object." } }));
                    continue;
                }
                object id;
                req.TryGetValue("id", out id);
                Dictionary<string, object> answer;
                try
                {
                    answer = new Dictionary<string, object> { { "id", id }, { "ok", true }, { "result", Handle(req) } };
                }
                catch (Failure failure)
                {
                    answer = new Dictionary<string, object> { { "id", id }, { "ok", false }, { "code", failure.Code }, { "message", failure.Message } };
                }
                catch (ElementNotAvailableException)
                {
                    answer = new Dictionary<string, object> { { "id", id }, { "ok", false }, { "code", "STALE_REF" }, { "message", "That element is no longer there. Take a new snapshot." } };
                }
                catch (Exception error)
                {
                    answer = new Dictionary<string, object> { { "id", id }, { "ok", false }, { "code", "INTERNAL" }, { "message", error.Message } };
                }
                output.WriteLine(Json.Serialize(answer));
            }
        }
    }

    static class Native
    {
        [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
        [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
        [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint processId);
        [DllImport("user32.dll", SetLastError = true)] static extern uint SendInput(uint count, INPUT[] inputs, int size);

        const uint INPUT_KEYBOARD = 1;
        const uint KEYEVENTF_KEYUP = 0x0002;
        const uint KEYEVENTF_UNICODE = 0x0004;

        [StructLayout(LayoutKind.Sequential)]
        struct KEYBDINPUT
        {
            public ushort wVk;
            public ushort wScan;
            public uint dwFlags;
            public uint time;
            public IntPtr dwExtraInfo;
        }

        [StructLayout(LayoutKind.Sequential)]
        struct MOUSEINPUT
        {
            public int dx;
            public int dy;
            public uint mouseData;
            public uint dwFlags;
            public uint time;
            public IntPtr dwExtraInfo;
        }

        [StructLayout(LayoutKind.Explicit)]
        struct InputUnion
        {
            [FieldOffset(0)] public MOUSEINPUT mi;
            [FieldOffset(0)] public KEYBDINPUT ki;
        }

        [StructLayout(LayoutKind.Sequential)]
        struct INPUT
        {
            public uint type;
            public InputUnion u;
        }

        static INPUT Key(ushort vk, ushort scan, uint flags)
        {
            var input = new INPUT { type = INPUT_KEYBOARD };
            input.u.ki = new KEYBDINPUT { wVk = vk, wScan = scan, dwFlags = flags };
            return input;
        }

        public static void SendKeys(ushort[] keys, bool down)
        {
            var inputs = keys.Select(k => Key(k, 0, down ? 0 : KEYEVENTF_KEYUP)).ToArray();
            SendInput((uint)inputs.Length, inputs, Marshal.SizeOf(typeof(INPUT)));
        }

        public static void TypeText(string text)
        {
            foreach (var ch in text)
            {
                if (ch == '\n')
                {
                    SendKeys(new ushort[] { 0x0D }, true);
                    SendKeys(new ushort[] { 0x0D }, false);
                    continue;
                }
                if (ch == '\r') continue;
                var inputs = new[] { Key(0, ch, KEYEVENTF_UNICODE), Key(0, ch, KEYEVENTF_UNICODE | KEYEVENTF_KEYUP) };
                SendInput(2, inputs, Marshal.SizeOf(typeof(INPUT)));
                Thread.Sleep(2);
            }
        }
    }
}
