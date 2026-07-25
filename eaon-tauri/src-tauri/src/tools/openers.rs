// Device tools — the portable subset of the Mac app's wider (formerly "Eaon
// Claw") catalog: open/quit apps, open URLs/paths. `run_applescript` has no
// cross-platform analogue and is deliberately absent. Trash lives with the
// other file mutations in fsops.rs.

use super::safety::{is_protected, normalize};
use super::{arg_str, ToolOutcome};
use serde_json::Value;
use std::process::Command;

/// A sanity gate for app names fed to shell-adjacent launchers — letters,
/// digits, spaces, and a few name chars only, so a "name" can never smuggle
/// shell metacharacters or path traversal.
fn valid_app_name(name: &str) -> bool {
    !name.is_empty()
        && name.len() <= 80
        && name
            .chars()
            .all(|c| c.is_alphanumeric() || matches!(c, ' ' | '-' | '_' | '.' | '+'))
}

/// Open (launch or focus) an application by name, per platform.
pub(crate) fn open_app(args: &Value) -> ToolOutcome {
    let Some(name) = arg_str(args, "name").map(str::trim).filter(|n| !n.is_empty()) else {
        return ToolOutcome::err("open_app needs a \"name\".");
    };
    if !valid_app_name(name) {
        return ToolOutcome::err("open_app: that doesn't look like an application name.");
    }
    let result = if cfg!(target_os = "macos") {
        Command::new("open").arg("-a").arg(name).status()
    } else if cfg!(target_os = "windows") {
        // `start` resolves App Paths/PATH the way a user's Run box would.
        let mut c = Command::new("cmd");
        c.args(["/C", "start", "", name]);
        #[cfg(windows)]
        {
            // CREATE_NO_WINDOW — the helper cmd must not flash a console.
            use std::os::windows::process::CommandExt;
            c.creation_flags(0x0800_0000);
        }
        c.status()
    } else {
        // Linux: try the binary name directly (most launchable apps are on
        // PATH); gtk-launch would need the .desktop id, which models rarely
        // know. Fire-and-forget — waiting on the status of a GUI app would
        // block until the user closes it.
        return match Command::new(name).spawn() {
            Ok(_) => ToolOutcome::ok(format!("Opened {name}.")),
            Err(e) => ToolOutcome::err(format!("Couldn't open \"{name}\": {e}")),
        };
    };
    match result {
        Ok(status) if status.success() => ToolOutcome::ok(format!("Opened {name}.")),
        Ok(_) => ToolOutcome::err(format!("Couldn't open \"{name}\" — is it installed?")),
        Err(e) => ToolOutcome::err(format!("Couldn't open \"{name}\": {e}")),
    }
}

/// Ask an application to quit, per platform — graceful where the OS allows.
pub(crate) fn quit_app(args: &Value) -> ToolOutcome {
    let Some(name) = arg_str(args, "name").map(str::trim).filter(|n| !n.is_empty()) else {
        return ToolOutcome::err("quit_app needs a \"name\".");
    };
    if !valid_app_name(name) {
        return ToolOutcome::err("quit_app: that doesn't look like an application name.");
    }
    let result = if cfg!(target_os = "macos") {
        Command::new("osascript")
            .args(["-e", &format!("tell application \"{name}\" to quit")])
            .status()
    } else if cfg!(target_os = "windows") {
        let image = if name.to_lowercase().ends_with(".exe") {
            name.to_string()
        } else {
            format!("{name}.exe")
        };
        // No /F — a graceful close request, not a kill.
        let mut c = Command::new("taskkill");
        c.args(["/IM", &image]);
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            c.creation_flags(0x0800_0000);
        }
        c.status()
    } else {
        // SIGTERM by exact process name — the polite Linux ask.
        Command::new("pkill").args(["-x", name]).status()
    };
    match result {
        Ok(status) if status.success() => ToolOutcome::ok(format!("Asked {name} to quit.")),
        Ok(_) => ToolOutcome::err(format!("Couldn't quit \"{name}\" — is it running?")),
        Err(e) => ToolOutcome::err(format!("Couldn't quit \"{name}\": {e}")),
    }
}

/// Open a URL in the default browser. http/https only — no file:, no custom
/// schemes a model could abuse to launch arbitrary handlers.
pub(crate) fn open_url(args: &Value) -> ToolOutcome {
    let Some(url) = arg_str(args, "url").map(str::trim).filter(|u| !u.is_empty()) else {
        return ToolOutcome::err("open_url needs a \"url\".");
    };
    let lower = url.to_lowercase();
    if !lower.starts_with("http://") && !lower.starts_with("https://") {
        return ToolOutcome::err("open_url only opens http(s) URLs.");
    }
    match tauri_plugin_opener::open_url(url, None::<&str>) {
        Ok(()) => ToolOutcome::ok(format!("Opened {url} in the browser.")),
        Err(e) => ToolOutcome::err(format!("Couldn't open the URL: {e}")),
    }
}

/// Open a file/folder with its default app (Explorer/Files/Finder for
/// folders). Read-side: allowed anywhere that exists except protected
/// system roots.
pub(crate) fn open_path(args: &Value) -> ToolOutcome {
    let Some(raw) = arg_str(args, "path") else {
        return ToolOutcome::err("open_path needs a \"path\".");
    };
    let path = normalize(raw);
    if !path.exists() {
        return ToolOutcome::err(format!("No such file or folder: {}", path.display()));
    }
    if is_protected(&path) {
        return ToolOutcome::err("Refused: that's a system location.");
    }
    match tauri_plugin_opener::open_path(path.to_string_lossy().into_owned(), None::<&str>) {
        Ok(()) => ToolOutcome::ok(format!("Opened {}.", path.display())),
        Err(e) => ToolOutcome::err(format!("Couldn't open it: {e}")),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    // REF's `device_tool_gates_hold`, minus the trash half — that moved next
    // to `trash_item` in fsops.rs.
    #[test]
    fn device_tool_gates_hold() {
        // App names: plain names pass, shell metacharacters and traversal don't.
        assert!(valid_app_name("Firefox"));
        assert!(valid_app_name("Visual Studio Code"));
        assert!(valid_app_name("notepad.exe"));
        assert!(!valid_app_name("firefox; rm -rf ~"));
        assert!(!valid_app_name("../../bin/sh"));
        assert!(!valid_app_name("a&b"));
        assert!(!valid_app_name(""));

        // open_url: only http(s) may reach the OS opener.
        let bad = open_url(&json!({"url": "file:///etc/passwd"}));
        assert!(!bad.ok && bad.text.contains("http"));
        let scheme = open_url(&json!({"url": "javascript:alert(1)"}));
        assert!(!scheme.ok);
    }
}
