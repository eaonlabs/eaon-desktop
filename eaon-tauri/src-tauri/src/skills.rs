// Skills import — scanning this PC's Claude Code skills folder. Parsing
// (frontmatter + normalizeName) lives in TS (core/protocol/skills.ts),
// shared with the Mac-mirrored starter skills; this command only does the
// I/O the webview's CSP wouldn't allow directly.

use serde::Serialize;
use tauri::Manager;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ClaudeSkillCandidate {
    pub path: String,
    pub text: String,
}

/// Every `SKILL.md` under `~/.claude/skills/<folder>/` on this PC — feeds
/// the "Import from Claude Code" picker. Frontmatter parsing, existing-name
/// dedup, and skipping anything that fails to parse all happen in TS, same
/// as the Mac app's own `localClaudeSkillCandidates`.
#[tauri::command]
pub fn scan_claude_skills(app: tauri::AppHandle) -> Vec<ClaudeSkillCandidate> {
    // No home dir / no skills folder → an empty picker, never an error:
    // most users simply don't have Claude Code installed.
    let Ok(home) = app.path().home_dir() else { return Vec::new() };
    let base = home.join(".claude").join("skills");
    let Ok(entries) = std::fs::read_dir(&base) else { return Vec::new() };

    let mut candidates = Vec::new();
    for entry in entries.flatten() {
        let path = entry.path();
        if !path.is_dir() {
            continue;
        }
        let skill_file = path.join("SKILL.md");
        if let Ok(text) = std::fs::read_to_string(&skill_file) {
            candidates.push(ClaudeSkillCandidate { path: skill_file.to_string_lossy().into_owned(), text });
        }
    }
    // Stable order so the picker doesn't reshuffle between opens
    // (read_dir order is filesystem-dependent).
    candidates.sort_by(|a, b| a.path.cmp(&b.path));
    candidates
}
