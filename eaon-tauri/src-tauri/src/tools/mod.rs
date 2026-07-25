// Agent mode's coding tools — the cross-platform Rust port of the macOS
// app's `DesktopControlService` (Eaon-desktop/Services/DesktopControl.swift).
// Same tool set, same safety model, same result shape, so the Windows/Linux
// Agent behaves identically to the Mac one: create a project folder, write
// real source files, run them, read output, search an existing codebase, and
// iterate.
//
// Everything routes through one `run_agent_tool` command (mirrors the Mac
// `execute(tool:arguments:)` dispatcher) so the frontend's invoke surface is
// tiny. The implementation is split by concern:
//   safety.rs    — the path/privilege guard rails every other file leans on
//   fsops.rs     — write / edit / read / list / create / move / trash
//   shell.rs     — run_shell (60s timeout, output cap, no escalation)
//   searchops.rs — search_code + find_files
//   openers.rs   — open/quit apps, open URLs and paths
// All file mutation is confined to the user's home folder or the OS temp
// dir — the cross-platform equivalent of the Mac guard (home / /Volumes /
// /tmp). System locations are refused outright, and privilege escalation
// (`sudo`, `runas`, and friends) is blocked in the shell.

mod fsops;
mod openers;
mod safety;
mod searchops;
mod shell;

use serde::Serialize;
use serde_json::Value;

/// One tool result — `ok` distinguishes success from failure so the frontend
/// can render "### tool\nOK:" vs "ERROR:" exactly like the Mac agent loop.
#[derive(Serialize, Clone)]
pub struct ToolOutcome {
    pub ok: bool,
    pub text: String,
}

impl ToolOutcome {
    pub(crate) fn ok(text: impl Into<String>) -> Self {
        ToolOutcome { ok: true, text: text.into() }
    }
    pub(crate) fn err(text: impl Into<String>) -> Self {
        ToolOutcome { ok: false, text: text.into() }
    }
}

pub(crate) fn arg_str<'a>(args: &'a Value, key: &str) -> Option<&'a str> {
    args.get(key).and_then(|v| v.as_str())
}

/// The full catalog, quoted back on an unknown name — a model that
/// hallucinates a tool gets the real list instead of a dead end.
const VALID_TOOLS: &str = "write_file, edit_file, read_file, search_code, \
    find_files, run_shell, list_directory, create_folder, move_item, \
    trash_item, open_app, quit_app, open_url, open_path";

/// The single entry point the frontend agent loop calls. `run_shell` stays on
/// the async runtime — its 60-second timeout is tokio-driven. Everything else
/// does blocking filesystem work (`search_code` and `find_files` can be
/// slow), so it runs on a blocking thread to keep the UI responsive.
///
/// Failures are reported through `ok: false`, never `Err`, so the frontend
/// has a single rendering path for tool results.
#[tauri::command]
pub async fn run_agent_tool(name: String, args: Value) -> Result<ToolOutcome, String> {
    if name == "run_shell" {
        return Ok(shell::run_shell(&args).await);
    }
    let outcome = tauri::async_runtime::spawn_blocking(move || match name.as_str() {
        "list_directory" => fsops::list_directory(&args),
        "create_folder" => fsops::create_folder(&args),
        "write_file" => fsops::write_file(&args),
        "read_file" => fsops::read_file(&args),
        "edit_file" => fsops::edit_file(&args),
        "move_item" => fsops::move_item(&args),
        "trash_item" => fsops::trash_item(&args),
        "search_code" => searchops::search_code(&args),
        "find_files" => searchops::find_files(&args),
        "open_app" => openers::open_app(&args),
        "quit_app" => openers::quit_app(&args),
        "open_url" => openers::open_url(&args),
        "open_path" => openers::open_path(&args),
        other => ToolOutcome::err(format!("no such tool: {other}. Valid tools: {VALID_TOOLS}.")),
    })
    .await
    .unwrap_or_else(|e| ToolOutcome::err(format!("tool crashed: {e}")));
    Ok(outcome)
}

#[cfg(test)]
pub(crate) mod testutil {
    use std::path::PathBuf;

    /// A fresh scratch folder under the OS temp dir (inside the allowed
    /// write bases), unique per test + process so parallel tests never
    /// collide.
    pub(crate) fn temp_project(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("eaon_tool_test_{name}_{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }
}
