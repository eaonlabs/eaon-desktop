// Filesystem tools: write / edit / read / list / create / move / trash.
// Every mutation goes through `guard_modifiable`, so nothing here can touch
// anything outside the user's home folder or the OS temp dir. Deleting is
// always the OS trash (Recycle Bin / Trash / gio trash) — recoverable, never
// a permanent delete.

use super::safety::{guard_modifiable, normalize};
use super::{arg_str, ToolOutcome};
use serde_json::Value;

const READ_CAP_CHARS: usize = 12_000;

pub(crate) fn list_directory(args: &Value) -> ToolOutcome {
    let raw = match arg_str(args, "path") {
        Some(p) => p,
        None => return ToolOutcome::err("missing \"path\""),
    };
    let path = normalize(raw);
    if !path.exists() {
        return ToolOutcome::err(format!("No such directory: {}", path.display()));
    }
    if !path.is_dir() {
        return ToolOutcome::err(format!("Not a directory (it's a file): {}", path.display()));
    }
    let mut names: Vec<String> = match std::fs::read_dir(&path) {
        Ok(rd) => rd
            .flatten()
            .map(|e| {
                let n = e.file_name().to_string_lossy().to_string();
                if e.file_type().map(|t| t.is_dir()).unwrap_or(false) {
                    format!("{n}/")
                } else {
                    n
                }
            })
            .collect(),
        Err(e) => return ToolOutcome::err(format!("Couldn't list {}: {e}", path.display())),
    };
    if names.is_empty() {
        return ToolOutcome::ok(format!("{} is empty.", path.display()));
    }
    names.sort();
    let total = names.len();
    let shown: Vec<String> = names.into_iter().take(500).collect();
    let more = if total > 500 { format!("\n…and {} more", total - 500) } else { String::new() };
    ToolOutcome::ok(format!("{total} item(s) in {}:\n{}{more}", path.display(), shown.join("\n")))
}

pub(crate) fn create_folder(args: &Value) -> ToolOutcome {
    let raw = match arg_str(args, "path") {
        Some(p) => p,
        None => return ToolOutcome::err("missing \"path\""),
    };
    let path = normalize(raw);
    if let Some(denied) = guard_modifiable(&path, "creating a folder") {
        return denied;
    }
    if path.is_dir() {
        return ToolOutcome::ok(format!("Already exists: {} — the folder is there, use it.", path.display()));
    }
    if path.is_file() {
        return ToolOutcome::err(format!("A file (not a folder) already exists at {}.", path.display()));
    }
    match std::fs::create_dir_all(&path) {
        Ok(_) => ToolOutcome::ok(format!("Created folder {}", path.display())),
        Err(e) => ToolOutcome::err(format!("Couldn't create it: {e}")),
    }
}

pub(crate) fn write_file(args: &Value) -> ToolOutcome {
    let raw = match arg_str(args, "path") {
        Some(p) => p,
        None => return ToolOutcome::err("missing \"path\""),
    };
    let content = match arg_str(args, "content") {
        Some(c) => c,
        None => return ToolOutcome::err("missing \"content\""),
    };
    let path = normalize(raw);
    if let Some(denied) = guard_modifiable(&path, "writing a file") {
        return denied;
    }
    if path.is_dir() {
        return ToolOutcome::err(format!("That path is a folder, not a file: {}", path.display()));
    }
    if let Some(parent) = path.parent() {
        if !parent.as_os_str().is_empty() && !parent.exists() {
            if let Err(e) = std::fs::create_dir_all(parent) {
                return ToolOutcome::err(format!("Couldn't create parent folder: {e}"));
            }
        }
    }
    match std::fs::write(&path, content) {
        Ok(_) => {
            let lines = if content.is_empty() { 0 } else { content.split('\n').count() };
            ToolOutcome::ok(format!("Wrote {} ({lines} line(s), {} byte(s)).", path.display(), content.len()))
        }
        Err(e) => ToolOutcome::err(format!("Couldn't write it: {e}")),
    }
}

pub(crate) fn read_file(args: &Value) -> ToolOutcome {
    let raw = match arg_str(args, "path") {
        Some(p) => p,
        None => return ToolOutcome::err("missing \"path\""),
    };
    let path = normalize(raw);
    if !path.exists() {
        return ToolOutcome::err(format!("No such file: {}", path.display()));
    }
    if path.is_dir() {
        return ToolOutcome::err(format!("That's a folder, not a file: {} — use list_directory.", path.display()));
    }
    let bytes = match std::fs::read(&path) {
        Ok(b) => b,
        Err(e) => return ToolOutcome::err(format!("Couldn't read {}: {e}", path.display())),
    };
    if bytes.len() > 5_000_000 {
        return ToolOutcome::err(format!("Too large to read whole ({} bytes).", bytes.len()));
    }
    let content = match String::from_utf8(bytes) {
        Ok(s) => s,
        Err(_) => return ToolOutcome::err(format!("Not a UTF-8 text file: {}", path.display())),
    };
    let lines = if content.is_empty() { 0 } else { content.split('\n').count() };
    let capped: String = if content.chars().count() > READ_CAP_CHARS {
        let head: String = content.chars().take(READ_CAP_CHARS).collect();
        format!("{head}\n…(truncated at 12k characters)")
    } else {
        content
    };
    ToolOutcome::ok(format!("{} ({lines} line(s)):\n{capped}", path.display()))
}

pub(crate) fn edit_file(args: &Value) -> ToolOutcome {
    let raw = match arg_str(args, "path") {
        Some(p) => p,
        None => return ToolOutcome::err("missing \"path\""),
    };
    let search = match arg_str(args, "search") {
        Some(s) if !s.is_empty() => s,
        _ => return ToolOutcome::err("missing a non-empty \"search\" — the exact existing text to find."),
    };
    let replace = match arg_str(args, "replace") {
        Some(r) => r,
        None => return ToolOutcome::err("missing \"replace\" — use \"\" to delete the matched text."),
    };
    let path = normalize(raw);
    if let Some(denied) = guard_modifiable(&path, "editing a file") {
        return denied;
    }
    if !path.exists() {
        return ToolOutcome::err(format!("No such file: {} — to create a new file, use write_file.", path.display()));
    }
    let content = match std::fs::read_to_string(&path) {
        Ok(c) => c,
        Err(_) => return ToolOutcome::err(format!("Couldn't read {} as UTF-8 text.", path.display())),
    };
    // Exactly-once semantics, matching the Mac WorkspaceParser.applyEdit.
    let count = content.matches(search).count();
    if count == 0 {
        return ToolOutcome::err("Edit not applied — the search text wasn't found. Use read_file to see the current contents, then retry with an exact match.".to_string());
    }
    if count > 1 {
        return ToolOutcome::err(format!("Edit not applied — the search text appears {count} times; it must occur exactly once. Include more surrounding lines to make it unique."));
    }
    let new_content = content.replacen(search, replace, 1);
    match std::fs::write(&path, &new_content) {
        Ok(_) => {
            let lines = if new_content.is_empty() { 0 } else { new_content.split('\n').count() };
            ToolOutcome::ok(format!("Edited {} — replaced 1 occurrence. The file is now {lines} line(s).", path.display()))
        }
        Err(e) => ToolOutcome::err(format!("Couldn't write the edit: {e}")),
    }
}

pub(crate) fn move_item(args: &Value) -> ToolOutcome {
    let from_raw = match arg_str(args, "from") {
        Some(p) => p,
        None => return ToolOutcome::err("missing \"from\""),
    };
    let to_raw = match arg_str(args, "to") {
        Some(p) => p,
        None => return ToolOutcome::err("missing \"to\""),
    };
    let from = normalize(from_raw);
    let to = normalize(to_raw);
    if let Some(d) = guard_modifiable(&from, "moving an item") {
        return d;
    }
    if let Some(d) = guard_modifiable(&to, "moving an item") {
        return d;
    }
    if !from.exists() {
        return ToolOutcome::err(format!("Nothing to move — no such path: {}", from.display()));
    }
    if to.exists() {
        return ToolOutcome::err(format!("Something already exists at {} — refused rather than overwrite it.", to.display()));
    }
    if let Some(parent) = to.parent() {
        if !parent.as_os_str().is_empty() && !parent.exists() {
            let _ = std::fs::create_dir_all(parent);
        }
    }
    match std::fs::rename(&from, &to) {
        Ok(_) => ToolOutcome::ok(format!("Moved {} → {}", from.display(), to.display())),
        Err(e) => ToolOutcome::err(format!("Couldn't move it: {e}")),
    }
}

/// Move a file/folder to the OS trash (Recycle Bin / Trash / gio trash) —
/// recoverable, never a permanent delete, same guard as every write.
pub(crate) fn trash_item(args: &Value) -> ToolOutcome {
    let Some(raw) = arg_str(args, "path") else {
        return ToolOutcome::err("trash_item needs a \"path\".");
    };
    let path = normalize(raw);
    if let Some(refusal) = guard_modifiable(&path, "moving to trash") {
        return refusal;
    }
    if !path.exists() {
        return ToolOutcome::err(format!("No such file or folder: {}", path.display()));
    }
    match trash::delete(&path) {
        Ok(()) => ToolOutcome::ok(format!("Moved to trash: {}", path.display())),
        Err(e) => ToolOutcome::err(format!("Couldn't move to trash: {e}")),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::tools::testutil::temp_project;
    use serde_json::json;

    #[test]
    fn refuses_system_paths() {
        // A protected root must never be modifiable.
        let sys = if cfg!(windows) { "C:\\Windows\\System32\\x.txt" } else { "/usr/bin/x" };
        let out = write_file(&json!({ "path": sys, "content": "x" }));
        assert!(!out.ok, "must refuse writing to system path");
        assert!(out.text.contains("Refused"));
    }

    #[test]
    fn refuses_parent_escape() {
        // A ~/../../etc/passwd style escape normalizes out of home → refused.
        let out = write_file(&json!({ "path": "~/../../../../etc/passwd", "content": "x" }));
        assert!(!out.ok, "must refuse an escape above home");
    }

    #[test]
    fn write_read_edit_roundtrip() {
        let dir = temp_project("roundtrip");
        let file = dir.join("main.py").to_string_lossy().to_string();

        let w = write_file(&json!({ "path": &file, "content": "print('a')\nprint('b')\n" }));
        assert!(w.ok, "write failed: {}", w.text);

        let r = read_file(&json!({ "path": &file }));
        assert!(r.ok && r.text.contains("print('a')"));

        let e = edit_file(&json!({ "path": &file, "search": "print('a')", "replace": "print('z')" }));
        assert!(e.ok, "edit failed: {}", e.text);
        let after = std::fs::read_to_string(&file).unwrap();
        assert!(after.contains("print('z')") && !after.contains("print('a')"));

        // Ambiguous edit (2 occurrences) must be refused.
        std::fs::write(&file, "x\nx\n").unwrap();
        let bad = edit_file(&json!({ "path": &file, "search": "x", "replace": "y" }));
        assert!(!bad.ok, "must refuse a non-unique edit");

        let _ = std::fs::remove_dir_all(&dir);
    }

    // The trash half of REF's `device_tool_gates_hold`, moved next to
    // `trash_item` now that it lives here (the app-name and URL halves stay
    // with openers.rs).
    #[test]
    fn trash_is_guarded_and_recoverable() {
        // trash_item: refuses system locations outright.
        let refused = trash_item(
            &json!({"path": if cfg!(windows) { "C:\\Windows\\notepad.exe" } else { "/usr/bin/env" }}),
        );
        assert!(!refused.ok && refused.text.contains("Refused"));

        // trash_item works on a real temp file (recoverable delete).
        let dir = temp_project("trash");
        let victim = dir.join("bye.txt");
        std::fs::write(&victim, "x").unwrap();
        let ok = trash_item(&json!({"path": victim.to_string_lossy()}));
        assert!(ok.ok, "{}", ok.text);
        assert!(!victim.exists());
    }
}
