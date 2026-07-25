// Attachments — files/images the user attaches to a message, stored under
// the app data dir exactly like the Mac app's AttachmentStore (a UUID-ish
// prefixed copy, referenced from the message by stored name only, so the
// conversation JSON never carries megabytes of base64).

use tauri::Manager;

fn attachments_dir(app: &tauri::AppHandle) -> Result<std::path::PathBuf, String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| e.to_string())?
        .join("attachments");
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir)
}

/// Keeps a user-supplied filename safe to embed in a stored name: path
/// separators and anything exotic dropped, `..` sequences eliminated (so the
/// name always passes `validated_stored_name` on the way back out), never
/// empty.
pub(crate) fn sanitize_file_name(name: &str) -> String {
    let mut cleaned: String = name
        .chars()
        .map(|c| {
            if c.is_alphanumeric() || matches!(c, '.' | '-' | '_' | ' ') {
                c
            } else {
                '-'
            }
        })
        .collect();
    while cleaned.contains("..") {
        cleaned = cleaned.replace("..", "-");
    }
    let trimmed = cleaned.trim_matches(['.', ' ', '-']).to_string();
    if trimmed.is_empty() { "file".to_string() } else { trimmed }
}

/// A stored name must be exactly one path component we generated — anything
/// with separators or `..` is refused before touching the filesystem.
pub(crate) fn validated_stored_name(name: &str) -> Result<&str, String> {
    if name.is_empty()
        || name.contains('/')
        || name.contains('\\')
        || name.contains("..")
        || name.starts_with('.')
    {
        return Err("invalid attachment name".to_string());
    }
    Ok(name)
}

/// Saves attachment bytes (base64 from the webview) under the attachments
/// dir and returns the stored file name the message should reference.
#[tauri::command]
pub fn save_attachment(app: tauri::AppHandle, data_base64: String, file_name: String) -> Result<String, String> {
    use base64::Engine as _;
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(data_base64.as_bytes())
        .map_err(|e| format!("bad attachment data: {e}"))?;
    // 50 MB cap — same ballpark guard as every provider's own payload limit;
    // stops a mis-picked video from silently eating the data dir.
    if bytes.len() > 50 * 1024 * 1024 {
        return Err("attachment is too large (over 50 MB)".to_string());
    }
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    let stored = format!("{}-{}", nanos, sanitize_file_name(&file_name));
    let path = attachments_dir(&app)?.join(&stored);
    std::fs::write(&path, bytes).map_err(|e| e.to_string())?;
    Ok(stored)
}

/// Reads a stored attachment back as base64 — for thumbnails and for
/// building vision payloads at send time.
#[tauri::command]
pub fn read_attachment(app: tauri::AppHandle, stored_file_name: String) -> Result<String, String> {
    use base64::Engine as _;
    let name = validated_stored_name(&stored_file_name)?;
    let path = attachments_dir(&app)?.join(name);
    let bytes = std::fs::read(&path).map_err(|e| e.to_string())?;
    Ok(base64::engine::general_purpose::STANDARD.encode(bytes))
}

#[cfg(test)]
mod attachment_tests {
    use super::{sanitize_file_name, validated_stored_name};

    #[test]
    fn sanitize_strips_separators_and_traversal() {
        // Every sanitized name must survive the read-side validation — the
        // exact cosmetic result matters less than that invariant.
        for hostile in ["../../etc/passwd", "a/b\\c.png", "....", "..\\..\\x", ""] {
            let cleaned = sanitize_file_name(hostile);
            assert!(!cleaned.is_empty());
            let stored = format!("12345-{cleaned}");
            assert!(validated_stored_name(&stored).is_ok(), "{hostile:?} -> {stored:?}");
        }
        assert_eq!(sanitize_file_name("photo (1).png"), "photo -1-.png");
        assert_eq!(sanitize_file_name("report.pdf"), "report.pdf");
    }

    #[test]
    fn stored_name_validation_refuses_escapes() {
        assert!(validated_stored_name("123-photo.png").is_ok());
        assert!(validated_stored_name("../state.json").is_err());
        assert!(validated_stored_name("a/b.png").is_err());
        assert!(validated_stored_name("a\\b.png").is_err());
        assert!(validated_stored_name(".hidden").is_err());
        assert!(validated_stored_name("").is_err());
    }
}
