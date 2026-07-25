// Read-only code intelligence: `search_code` (regex over file contents) and
// `find_files` (filename globs). Both walk from a safety-checked root,
// skip dependency/build noise directories, and cap their output so a broad
// query can't flood the model's context window.

use super::safety::resolve_search_root;
use super::{arg_str, ToolOutcome};
use serde_json::Value;
use std::path::Path;

const SEARCH_MAX_HITS: usize = 120;
const SEARCH_MAX_FILES: usize = 20_000;
const FIND_MAX_VISITED: usize = 80_000;

fn is_noise_dir(name: &str) -> bool {
    const NOISE: &[&str] = &[
        ".git", ".hg", ".svn", "node_modules", ".build", "build", "dist",
        ".next", ".nuxt", "out", ".venv", "venv", "env", "__pycache__",
        ".mypy_cache", ".pytest_cache", "Pods", "Carthage", "DerivedData",
        ".gradle", "target", ".idea", ".cache", "vendor", ".terraform",
    ];
    NOISE.contains(&name)
}

fn looks_binary(bytes: &[u8]) -> bool {
    bytes.iter().take(8_000).any(|&b| b == 0)
}

/// Glob (`*`, `?`) → anchored, filename-only regex string.
fn glob_to_regex(glob: &str) -> String {
    let mut out = String::from("^");
    for ch in glob.chars() {
        match ch {
            '*' => out.push_str("[^/\\\\]*"),
            '?' => out.push_str("[^/\\\\]"),
            '.' | '(' | ')' | '+' | '|' | '^' | '$' | '{' | '}' | '[' | ']' | '\\' => {
                out.push('\\');
                out.push(ch);
            }
            other => out.push(other),
        }
    }
    out.push('$');
    out
}

fn relative_to(full: &Path, root: &Path) -> String {
    full.strip_prefix(root)
        .map(|p| p.to_string_lossy().replace('\\', "/"))
        .unwrap_or_else(|_| full.to_string_lossy().to_string())
}

/// Recursive directory walk that skips noise dirs, calling `visit` for each
/// file. `visit` returns false to stop the whole walk early. Returns whether
/// it stopped early (truncated).
fn walk_files<F: FnMut(&Path) -> bool>(root: &Path, budget: &mut usize, visit: &mut F) -> bool {
    let entries = match std::fs::read_dir(root) {
        Ok(e) => e,
        Err(_) => return false,
    };
    for entry in entries.flatten() {
        if *budget == 0 {
            return true;
        }
        *budget -= 1;
        let path = entry.path();
        let name = entry.file_name().to_string_lossy().to_string();
        let is_dir = entry.file_type().map(|t| t.is_dir()).unwrap_or(false);
        if is_dir {
            if is_noise_dir(&name) {
                continue;
            }
            if walk_files(&path, budget, visit) {
                return true;
            }
        } else if !visit(&path) {
            return true;
        }
    }
    false
}

pub(crate) fn find_files(args: &Value) -> ToolOutcome {
    let raw_path = match arg_str(args, "path") {
        Some(p) => p,
        None => return ToolOutcome::err("missing \"path\" — the folder to search under."),
    };
    let pattern = match arg_str(args, "name_pattern").map(|p| p.trim()) {
        Some(p) if !p.is_empty() => p.to_string(),
        _ => return ToolOutcome::err("missing \"name_pattern\" — a glob like \"*.rs\" or part of a filename."),
    };
    let root = match resolve_search_root(raw_path) {
        Ok(r) => r,
        Err(e) => return e,
    };
    let max_results = args.get("max_results").and_then(|v| v.as_u64()).unwrap_or(200).clamp(1, 1000) as usize;

    let is_glob = pattern.contains('*') || pattern.contains('?');
    let glob_re = if is_glob {
        regex::RegexBuilder::new(&glob_to_regex(&pattern)).case_insensitive(true).build().ok()
    } else {
        None
    };
    let needle = pattern.to_lowercase();

    let mut matches: Vec<String> = Vec::new();
    let mut budget = FIND_MAX_VISITED;
    let mut truncated = false;
    walk_files(&root, &mut budget, &mut |file| {
        let name = file.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_default();
        let hit = match &glob_re {
            Some(re) => re.is_match(&name),
            None => name.to_lowercase().contains(&needle),
        };
        if hit {
            matches.push(relative_to(file, &root));
            if matches.len() >= max_results {
                truncated = true;
                return false;
            }
        }
        true
    });
    if matches.is_empty() {
        return ToolOutcome::ok(format!("No files matching \"{pattern}\" under {}.", root.display()));
    }
    matches.sort();
    let note = if truncated { "\n…(more matches exist — narrow name_pattern or raise max_results)" } else { "" };
    ToolOutcome::ok(format!(
        "{} file(s) matching \"{pattern}\" under {}:\n{}{note}",
        matches.len(),
        root.display(),
        matches.join("\n")
    ))
}

pub(crate) fn search_code(args: &Value) -> ToolOutcome {
    let raw_pattern = match arg_str(args, "pattern") {
        Some(p) if !p.is_empty() => p,
        _ => return ToolOutcome::err("missing a non-empty \"pattern\"."),
    };
    let raw_path = match arg_str(args, "path") {
        Some(p) => p,
        None => return ToolOutcome::err("missing \"path\" — the project folder to search."),
    };
    let root = match resolve_search_root(raw_path) {
        Ok(r) => r,
        Err(e) => return e,
    };
    let case_sensitive = args.get("case_sensitive").and_then(|v| v.as_bool()).unwrap_or(false);

    // Invalid regex falls back to a literal substring search — a model often
    // types plain text it means literally.
    let regex = regex::RegexBuilder::new(raw_pattern)
        .case_insensitive(!case_sensitive)
        .build()
        .or_else(|_| {
            regex::RegexBuilder::new(&regex::escape(raw_pattern))
                .case_insensitive(!case_sensitive)
                .build()
        });
    let regex = match regex {
        Ok(r) => r,
        Err(_) => return ToolOutcome::err(format!("Couldn't build a search out of \"{raw_pattern}\".")),
    };

    let file_glob = arg_str(args, "file_glob").map(|g| g.trim()).filter(|g| !g.is_empty());
    let glob_re = file_glob.and_then(|g| {
        regex::RegexBuilder::new(&glob_to_regex(g)).case_insensitive(true).build().ok()
    });

    let mut hits: Vec<String> = Vec::new();
    let mut files_with_hits = std::collections::HashSet::new();
    let mut files_scanned = 0usize;
    let mut budget = SEARCH_MAX_FILES * 4;
    let mut truncated = false;

    walk_files(&root, &mut budget, &mut |file| {
        let name = file.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_default();
        if let Some(re) = &glob_re {
            if !re.is_match(&name) {
                return true;
            }
        }
        if let Ok(meta) = file.metadata() {
            if meta.len() > 2_000_000 {
                return true;
            }
        }
        files_scanned += 1;
        if files_scanned > SEARCH_MAX_FILES {
            truncated = true;
            return false;
        }
        let bytes = match std::fs::read(file) {
            Ok(b) => b,
            Err(_) => return true,
        };
        if looks_binary(&bytes) {
            return true;
        }
        let content = match String::from_utf8(bytes) {
            Ok(s) => s,
            Err(_) => return true,
        };
        let rel = relative_to(file, &root);
        for (idx, line) in content.split('\n').enumerate() {
            if regex.is_match(line) {
                let trimmed = line.trim();
                let shown: String = if trimmed.chars().count() > 200 {
                    format!("{}…", trimmed.chars().take(200).collect::<String>())
                } else {
                    trimmed.to_string()
                };
                hits.push(format!("{rel}:{}: {shown}", idx + 1));
                files_with_hits.insert(rel.clone());
                if hits.len() >= SEARCH_MAX_HITS {
                    truncated = true;
                    return false;
                }
            }
        }
        true
    });

    if hits.is_empty() {
        return ToolOutcome::ok(format!("No matches for /{raw_pattern}/ under {}.", root.display()));
    }
    let note = if truncated { "\n…(more matches — narrow the pattern or add a file_glob)" } else { "" };
    ToolOutcome::ok(format!(
        "{} match(es) in {} file(s) for /{raw_pattern}/ under {}:\n{}{note}",
        hits.len(),
        files_with_hits.len(),
        root.display(),
        hits.join("\n")
    ))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::tools::testutil::temp_project;
    use serde_json::json;

    #[test]
    fn search_and_find_work_and_skip_noise() {
        let dir = temp_project("search");
        std::fs::write(dir.join("app.rs"), "fn handle_login() {}\nlet x = 1;\n").unwrap();
        std::fs::write(dir.join("util.rs"), "fn helper() {}\n").unwrap();
        // A noise dir that must be skipped.
        std::fs::create_dir_all(dir.join("node_modules")).unwrap();
        std::fs::write(dir.join("node_modules").join("junk.rs"), "fn handle_login() {}\n").unwrap();

        let s = search_code(&json!({ "pattern": "fn handle_login", "path": dir.to_string_lossy() }));
        assert!(s.ok, "{}", s.text);
        assert!(s.text.contains("app.rs:1"), "should find the real hit: {}", s.text);
        assert!(!s.text.contains("node_modules"), "must skip noise dirs: {}", s.text);

        let f = find_files(&json!({ "path": dir.to_string_lossy(), "name_pattern": "*.rs" }));
        assert!(f.ok && f.text.contains("app.rs") && f.text.contains("util.rs"));
        assert!(!f.text.contains("junk.rs"), "find must skip noise dirs too");

        let _ = std::fs::remove_dir_all(&dir);
    }
}
