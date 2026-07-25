// Persistence — one JSON blob (state.json) in the app data dir: the
// UserDefaults-equivalent single source of truth the Mac app uses. The
// frontend owns the schema and its legacy migration; Rust only does
// crash-safe bytes-to-disk. Same file and identifier as the shipped
// 2026.3.x builds, so existing installs load through unchanged.

use std::path::{Path, PathBuf};

use tauri::Manager;

/// Directory comes from the caller so tests can point at a temp dir;
/// production always passes the resolved app_data_dir.
fn state_path_in(dir: &Path) -> Result<PathBuf, String> {
    std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    Ok(dir.join("state.json"))
}

fn state_path(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    state_path_in(&dir)
}

fn read_state(path: &Path) -> Result<String, String> {
    // Absent file → empty string, not an error: first launch isn't a
    // fault, and the frontend treats "" as "start from defaults".
    if !path.exists() {
        return Ok(String::new());
    }
    std::fs::read_to_string(path).map_err(|e| e.to_string())
}

/// This file holds every API key, the trial secret, and OAuth access/refresh
/// tokens in plaintext. On Windows the per-user %APPDATA% ACL already keeps
/// other accounts out, but on Linux/macOS a default umask leaves it 0644 —
/// world-readable on any shared box. Tighten to owner-only.
///
/// Applied to the temp file BEFORE the rename, so the real path never exists
/// with loose permissions even momentarily. Best-effort: a filesystem that
/// can't represent Unix modes must not break saving.
#[cfg(unix)]
fn restrict_to_owner(path: &Path) {
    use std::os::unix::fs::PermissionsExt;
    let _ = std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600));
}

#[cfg(not(unix))]
fn restrict_to_owner(_path: &Path) {}

/// Atomic write (temp file + rename) so a crash mid-save can never corrupt
/// the whole conversation history — a rename within one directory is
/// atomic on every platform we ship.
fn write_state(path: &Path, json: &str) -> Result<(), String> {
    let tmp = path.with_extension("json.tmp");
    std::fs::write(&tmp, json).map_err(|e| e.to_string())?;
    restrict_to_owner(&tmp);
    std::fs::rename(&tmp, path).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn load_app_state(app: tauri::AppHandle) -> Result<String, String> {
    read_state(&state_path(&app)?)
}

#[tauri::command]
pub fn save_app_state(app: tauri::AppHandle, json: String) -> Result<(), String> {
    write_state(&state_path(&app)?, &json)
}

/// The app data directory as a display string — Settings → General shows it
/// (and offers to reveal it), so the user always knows where their
/// conversations and downloaded models actually live on disk.
#[tauri::command]
pub fn app_data_dir_path(app: tauri::AppHandle) -> Result<String, String> {
    let dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir.to_string_lossy().into_owned())
}

#[cfg(test)]
mod tests {
    use super::{read_state, state_path_in, write_state};

    #[test]
    fn state_round_trips_and_missing_file_reads_empty() {
        let dir = std::env::temp_dir().join(format!("eaon-storage-test-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let path = state_path_in(&dir).expect("state dir under temp");

        // First launch: no file yet — must read as empty, not error.
        assert_eq!(read_state(&path).unwrap(), "");

        let payload = r#"{"schemaVersion":2,"conversations":[]}"#;
        write_state(&path, payload).unwrap();
        assert_eq!(read_state(&path).unwrap(), payload);

        // Overwrite goes through the same tmp+rename path and must leave
        // no straggler tmp file behind on success.
        write_state(&path, "{}").unwrap();
        assert_eq!(read_state(&path).unwrap(), "{}");
        assert!(!path.with_extension("json.tmp").exists());

        let _ = std::fs::remove_dir_all(&dir);
    }

    /// state.json carries API keys, the trial secret, and OAuth tokens in
    /// plaintext — it must never land world-readable via the default umask.
    #[test]
    #[cfg(unix)]
    fn state_file_is_owner_only() {
        use std::os::unix::fs::PermissionsExt;
        let dir = std::env::temp_dir().join(format!("eaon-perm-test-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let path = state_path_in(&dir).expect("state dir under temp");

        write_state(&path, r#"{"apiKey":"secret"}"#).unwrap();
        let mode = std::fs::metadata(&path).unwrap().permissions().mode() & 0o777;
        assert_eq!(mode, 0o600, "state.json must be owner read/write only, got {mode:o}");

        let _ = std::fs::remove_dir_all(&dir);
    }
}
