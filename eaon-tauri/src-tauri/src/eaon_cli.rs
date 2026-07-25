// Eaon CLI install + credential linking — the cross-platform port of the Mac
// app's EaonCLILauncher.swift, minus the embedded-terminal launch path (this
// app has no in-app terminal; the point here is a standalone `eaon` command
// the user runs in their own terminal).
//
// Three things this owns:
// 1. `eaon_cli_status` — where a runnable CLI would come from (installed
//    copy, bundled resource, or a dev checkout of this repo) and whether an
//    install/update is on offer.
// 2. `eaon_cli_install` — copies the bundled payload to a writable location
//    and writes a global `eaon` shim (a batch file on Windows, a POSIX
//    script everywhere else).
// 3. `eaon_cli_link_credentials` — the part the Mac app's `/link` command
//    does by shelling out to `defaults`/`plutil` against UserDefaults; this
//    app already has the settings in memory on the frontend, so it's just a
//    direct JSON merge into the CLI's own config.json. Never blanks an
//    existing CLI-configured key when nothing new was supplied, and updates
//    an existing custom provider by id rather than duplicating it — same
//    contract as the Mac CLI's `applyDiscoveryToConfig`.

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::path::{Path, PathBuf};
use tauri::{AppHandle, Manager};

fn home_dir(app: &AppHandle) -> Result<PathBuf, String> {
    app.path().home_dir().map_err(|e| e.to_string())
}

/// The writable copy `install()` produces `dist/cli.js` runs from — same
/// `~/.eaon/cli-app` path the Mac app uses, distinct from `config_dir`
/// (`~/.eaon/cli`), which is the CLI's own config/session storage.
fn installed_dir(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(home_dir(app)?.join(".eaon").join("cli-app"))
}

/// Where the CLI's own config + sessions live — the same path the Node
/// CLI's `platform.ts configDir()` computes (`~/.eaon/cli`), so the app and
/// the CLI point at the exact same file regardless of platform.
fn config_dir(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(home_dir(app)?.join(".eaon").join("cli"))
}

fn config_file(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(config_dir(app)?.join("config.json"))
}

/// Where a global `eaon` command gets written — not guaranteed to be on
/// PATH (neither macOS shells nor a stock Windows install add `~/.local/bin`
/// by default); the Settings panel says so plainly rather than pretending
/// this always works, same as the Mac app.
fn global_command_path(app: &AppHandle) -> Result<PathBuf, String> {
    let bin_dir = home_dir(app)?.join(".local").join("bin");
    Ok(if cfg!(windows) { bin_dir.join("eaon.cmd") } else { bin_dir.join("eaon") })
}

// ---------------------------------------------------------------------------
// Node.js discovery
// ---------------------------------------------------------------------------

/// Common install locations, checked before falling back to a shell lookup —
/// GUI apps don't inherit the user's shell PATH (nvm/Homebrew/nvm-windows
/// installs that never launch through a shell is the actual failure mode
/// this guards against, mirroring the Mac launcher's own comment).
fn common_node_paths(home: &Path) -> Vec<PathBuf> {
    if cfg!(windows) {
        vec![
            PathBuf::from(r"C:\Program Files\nodejs\node.exe"),
            PathBuf::from(r"C:\Program Files (x86)\nodejs\node.exe"),
            home.join("AppData\\Roaming\\nvm").join("node.exe"),
        ]
    } else {
        vec![
            PathBuf::from("/opt/homebrew/bin/node"),
            PathBuf::from("/usr/local/bin/node"),
            home.join(".local/bin/node"),
            home.join(".nvm/current/bin/node"),
            PathBuf::from("/usr/bin/node"),
        ]
    }
}

fn find_node(home: &Path) -> Option<PathBuf> {
    for candidate in common_node_paths(home) {
        if candidate.is_file() {
            return Some(candidate);
        }
    }
    // Last resort: ask a real shell to resolve it, which picks up
    // nvm/asdf-style shims a fixed path list can't anticipate.
    let output = if cfg!(windows) {
        std::process::Command::new("cmd").args(["/C", "where node"]).output().ok()?
    } else {
        std::process::Command::new("/bin/zsh").args(["-l", "-c", "command -v node"]).output().ok()?
    };
    if !output.status.success() {
        return None;
    }
    let text = String::from_utf8_lossy(&output.stdout);
    let first = text.lines().next()?.trim();
    if first.is_empty() {
        return None;
    }
    let path = PathBuf::from(first);
    path.is_file().then_some(path)
}

// ---------------------------------------------------------------------------
// Entry-point / payload discovery
// ---------------------------------------------------------------------------

/// Where `dist/cli.js` might live, checked in priority order:
/// 1. **Installed** (`~/.eaon/cli-app/dist/cli.js`) — the writable copy
///    `install()` produces; the only location a real end-user install runs
///    from.
/// 2. **Dev checkout** — the `eaon-cli` sibling directory next to this
///    crate's own source, resolved from `CARGO_MANIFEST_DIR` (a compile-time
///    constant — the Rust equivalent of the Mac launcher's `#filePath`
///    trick) so it works from a raw `cargo run`/`tauri dev` without
///    hardcoding a developer's home directory.
///
/// Deliberately does NOT count the read-only bundled resource as a runnable
/// entry point — that copy is install *source*, not something to execute in
/// place (see `bundled_payload_dir`); `can_install` reports its presence
/// separately.
fn find_entry_point(app: &AppHandle) -> Option<PathBuf> {
    let installed = installed_dir(app).ok()?.join("dist").join("cli.js");
    if installed.is_file() {
        return Some(installed);
    }
    let manifest_dir = PathBuf::from(env!("CARGO_MANIFEST_DIR")); // .../eaon-tauri/src-tauri
    let repo_root = manifest_dir.parent()?.parent()?; // -> eaon-tauri -> repo root
    let dev_entry = repo_root.join("eaon-cli").join("dist").join("cli.js");
    dev_entry.is_file().then_some(dev_entry)
}

fn cli_directory_for(entry_point: &Path) -> Option<PathBuf> {
    Some(entry_point.parent()?.parent()?.to_path_buf()) // dist/cli.js -> dist -> cli dir
}

/// The read-only, pre-built `eaon-cli` copy shipped as a Tauri bundle
/// resource (see `tauri.conf.json`'s `bundle.resources` and
/// `scripts/stage-cli.sh`, which produces it) — the install source. None in
/// a raw dev run, where nothing is bundled and the dev-checkout fallback in
/// `find_entry_point` is used directly instead, same as the Mac app.
fn bundled_payload_dir(app: &AppHandle) -> Option<PathBuf> {
    let resource_dir = app.path().resource_dir().ok()?;
    let candidate = resource_dir.join("eaon-cli");
    candidate.join("dist").join("cli.js").is_file().then_some(candidate)
}

fn read_version(dir: &Path) -> Option<String> {
    let text = std::fs::read_to_string(dir.join("package.json")).ok()?;
    let json: Value = serde_json::from_str(&text).ok()?;
    json.get("version")?.as_str().map(str::to_string)
}

/// Plain dot-separated integer comparison — works for both this app's
/// CalVer (2026.4.0) and eaon-cli's semver (0.1.2) alike, since it's just
/// component-wise integer comparison either way.
fn is_newer_version(candidate: &str, current: &str) -> bool {
    let a: Vec<u32> = candidate.split('.').map(|s| s.parse().unwrap_or(0)).collect();
    let b: Vec<u32> = current.split('.').map(|s| s.parse().unwrap_or(0)).collect();
    let len = a.len().max(b.len());
    for i in 0..len {
        let x = a.get(i).copied().unwrap_or(0);
        let y = b.get(i).copied().unwrap_or(0);
        if x != y {
            return x > y;
        }
    }
    false
}

// ---------------------------------------------------------------------------
// Status
// ---------------------------------------------------------------------------

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CliStatus {
    pub node_path: Option<String>,
    pub node_hint: String,
    pub entry_point: Option<String>,
    pub cli_directory: Option<String>,
    /// Version of whatever `entry_point` resolves to — display only.
    pub version: Option<String>,
    /// Version of the real writable install specifically — what
    /// `can_install`/`update_available` are based on, not `version`.
    pub installed_version: Option<String>,
    pub bundled_version: Option<String>,
    pub is_ready: bool,
    pub can_install: bool,
    pub update_available: Option<String>,
    /// The writable program-files directory Install/Update copy into
    /// (`~/.eaon/cli-app`) — distinct from `config_directory`, which is the
    /// CLI's own settings/session storage and is never touched by either.
    pub installed_directory: String,
    pub config_file: String,
    pub config_directory: String,
    pub global_command_path: String,
}

#[tauri::command]
pub fn eaon_cli_status(app: AppHandle) -> Result<CliStatus, String> {
    let home = home_dir(&app)?;
    let node = find_node(&home);
    let entry_point = find_entry_point(&app);
    let cli_directory = entry_point.as_deref().and_then(cli_directory_for);
    let version = cli_directory.as_deref().and_then(read_version);

    let installed_entry = installed_dir(&app)?.join("dist").join("cli.js");
    let installed_version = if installed_entry.is_file() { read_version(&installed_dir(&app)?) } else { None };
    let bundled_dir = bundled_payload_dir(&app);
    let bundled_version = bundled_dir.as_deref().and_then(read_version);

    let update_available = match (&installed_version, &bundled_version) {
        (Some(installed), Some(bundled)) if is_newer_version(bundled, installed) => Some(bundled.clone()),
        _ => None,
    };

    Ok(CliStatus {
        is_ready: node.is_some() && entry_point.is_some(),
        can_install: installed_version.is_none() && bundled_version.is_some(),
        node_path: node.map(|p| p.display().to_string()),
        node_hint: if cfg!(windows) {
            "Not found — install Node 18.17+ from nodejs.org".to_string()
        } else {
            "Not found — install Node 18.17+ (e.g. brew install node)".to_string()
        },
        entry_point: entry_point.map(|p| p.display().to_string()),
        cli_directory: cli_directory.map(|p| p.display().to_string()),
        version,
        installed_version,
        bundled_version,
        update_available,
        installed_directory: installed_dir(&app)?.display().to_string(),
        config_file: config_file(&app)?.display().to_string(),
        config_directory: config_dir(&app)?.display().to_string(),
        global_command_path: global_command_path(&app)?.display().to_string(),
    })
}

// ---------------------------------------------------------------------------
// Install / update
// ---------------------------------------------------------------------------

fn copy_dir_recursive(src: &Path, dst: &Path) -> std::io::Result<()> {
    std::fs::create_dir_all(dst)?;
    for entry in std::fs::read_dir(src)? {
        let entry = entry?;
        let file_type = entry.file_type()?;
        let dest_path = dst.join(entry.file_name());
        if file_type.is_dir() {
            copy_dir_recursive(&entry.path(), &dest_path)?;
        } else if file_type.is_symlink() {
            // npm's node_modules/.bin symlinks (POSIX only — npm on Windows
            // writes .cmd/.ps1 shims instead, which hit the plain-file arm
            // below) — recreated as symlinks rather than followed, so a
            // broken/self-referential link can't turn into infinite copying.
            let target = std::fs::read_link(entry.path())?;
            #[cfg(unix)]
            std::os::unix::fs::symlink(&target, &dest_path)?;
            #[cfg(not(unix))]
            let _ = target;
        } else {
            std::fs::copy(entry.path(), &dest_path)?;
        }
    }
    Ok(())
}

/// A shim script rather than a hardcoded `node` path, so it keeps working if
/// the user's Node install moves (nvm version switch, a later upgrade, …) —
/// mirrors `common_node_paths`' search order in script form.
fn write_global_shim(app: &AppHandle) -> Result<(), String> {
    let shim_path = global_command_path(app)?;
    let bin_dir = shim_path.parent().ok_or("Invalid shim path.")?;
    std::fs::create_dir_all(bin_dir).map_err(|e| e.to_string())?;
    let entry = installed_dir(app)?.join("dist").join("cli.js");
    let entry_str = entry.display().to_string();

    let script = if cfg!(windows) {
        format!(
            "@echo off\r\nrem Written by Eaon's \"Install Eaon CLI\" — safe to delete.\r\nwhere node >nul 2>nul\r\nif errorlevel 1 (\r\n  echo eaon: Node.js not found. Install it from nodejs.org and try again. 1>&2\r\n  exit /b 1\r\n)\r\nnode \"{entry_str}\" %*\r\n"
        )
    } else {
        format!(
            "#!/bin/sh\n# Written by Eaon's \"Install Eaon CLI\" — safe to delete.\nfor candidate in /opt/homebrew/bin/node /usr/local/bin/node \"$HOME/.local/bin/node\" \"$HOME/.nvm/current/bin/node\" /usr/bin/node; do\n  if [ -x \"$candidate\" ]; then NODE=\"$candidate\"; break; fi\ndone\nif [ -z \"$NODE\" ]; then NODE=$(command -v node); fi\nif [ -z \"$NODE\" ]; then\n  echo \"eaon: Node.js not found. Install it (e.g. apt install nodejs) and try again.\" >&2\n  exit 1\nfi\nexec \"$NODE\" \"{entry_str}\" \"$@\"\n"
        )
    };
    std::fs::write(&shim_path, script).map_err(|e| e.to_string())?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let mut perms = std::fs::metadata(&shim_path).map_err(|e| e.to_string())?.permissions();
        perms.set_mode(0o755);
        std::fs::set_permissions(&shim_path, perms).map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// Copies the bundled CLI to the writable install location and writes the
/// global `eaon` shim. Pure file I/O — no network, no npm — so it's fast and
/// works offline. Also what an update is: replacing a newer bundled copy
/// over an older install is the exact same operation as a fresh one — the
/// CLI's config/sessions live in the separate `config_dir` and are never
/// touched by this.
#[tauri::command]
pub fn eaon_cli_install(app: AppHandle) -> Result<(), String> {
    let source = bundled_payload_dir(&app)
        .ok_or("This build doesn't have Eaon CLI bundled — nothing to install.")?;
    let dest = installed_dir(&app)?;
    if dest.exists() {
        std::fs::remove_dir_all(&dest).map_err(|e| format!("Couldn't remove the previous install: {e}"))?;
    }
    if let Some(parent) = dest.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    copy_dir_recursive(&source, &dest).map_err(|e| format!("Couldn't install Eaon CLI: {e}"))?;
    write_global_shim(&app)?;
    Ok(())
}

// ---------------------------------------------------------------------------
// Credential linking
// ---------------------------------------------------------------------------

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LinkProviderIn {
    pub id: String,
    pub display_name: String,
    pub base_url: String,
    pub api_key: String,
    pub model_ids: Vec<String>,
    /// This app's `ProviderFormat` — "openai" | "anthropic" | "gemini".
    pub format: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LinkCredentialsArgs {
    pub eaon_api_key: Option<String>,
    pub custom_providers: Vec<LinkProviderIn>,
}

/// This app's `ProviderFormat` differs in naming from eaon-cli's
/// `CustomProviderFormat` (`openAICompatible`/`anthropicMessages`/
/// `googleGemini`) even though both mean the same three wire shapes —
/// eaon-cli's naming predates this app's own and matches the Mac app's
/// `APIRequestFormat`, so this is the one place that reconciles them.
fn map_provider_format(app_format: &str) -> &'static str {
    match app_format {
        "anthropic" => "anthropicMessages",
        "gemini" => "googleGemini",
        _ => "openAICompatible",
    }
}

/// Merges the given credentials into the CLI's own config.json — updates an
/// existing custom provider by id (in case this is re-run after a key
/// rotation) rather than duplicating it, and leaves the Eaon key untouched
/// when nothing/empty was supplied, so a link never blanks out a key the
/// user configured directly in the CLI. Same contract as the Mac CLI's own
/// `applyDiscoveryToConfig`, just implemented as a direct JSON merge instead
/// of a UserDefaults reader, since this app already has the settings in
/// memory — nothing to shell out and discover.
#[tauri::command]
pub fn eaon_cli_link_credentials(app: AppHandle, args: LinkCredentialsArgs) -> Result<(), String> {
    let path = config_file(&app)?;
    let mut config: Value = std::fs::read_to_string(&path)
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
        .filter(Value::is_object)
        .unwrap_or_else(|| json!({}));
    let obj = config.as_object_mut().expect("filtered to object above");

    if let Some(key) = args.eaon_api_key.as_deref().map(str::trim).filter(|k| !k.is_empty()) {
        obj.insert("aquaApiKey".to_string(), json!(key));
    }

    let mut providers: Vec<Value> = obj
        .get("customProviders")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    for incoming in &args.custom_providers {
        let entry = json!({
            "id": incoming.id,
            "displayName": incoming.display_name,
            "baseURL": incoming.base_url,
            "apiKey": incoming.api_key,
            "modelIDs": incoming.model_ids,
            "format": map_provider_format(&incoming.format),
        });
        match providers.iter_mut().find(|p| p.get("id").and_then(Value::as_str) == Some(incoming.id.as_str())) {
            Some(existing) => *existing = entry,
            None => providers.push(entry),
        }
    }
    obj.insert("customProviders".to_string(), Value::Array(providers));

    let dir = config_dir(&app)?;
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let tmp = path.with_extension("json.tmp");
    let text = serde_json::to_string_pretty(&config).map_err(|e| e.to_string())?;
    std::fs::write(&tmp, text).map_err(|e| e.to_string())?;
    std::fs::rename(&tmp, &path).map_err(|e| e.to_string())?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn newer_version_compares_componentwise() {
        assert!(is_newer_version("0.1.2", "0.1.1"));
        assert!(is_newer_version("0.2.0", "0.1.9"));
        assert!(is_newer_version("1.0.0", "0.9.9"));
        assert!(!is_newer_version("0.1.1", "0.1.1"));
        assert!(!is_newer_version("0.1.0", "0.1.1"));
        // CalVer shape, matching this app's own version scheme.
        assert!(is_newer_version("2026.5.0", "2026.4.0"));
        assert!(!is_newer_version("2026.4.0", "2026.5.0"));
    }

    #[test]
    fn provider_format_maps_to_cli_naming() {
        assert_eq!(map_provider_format("anthropic"), "anthropicMessages");
        assert_eq!(map_provider_format("gemini"), "googleGemini");
        assert_eq!(map_provider_format("openai"), "openAICompatible");
        assert_eq!(map_provider_format("anything-else"), "openAICompatible");
    }

    #[test]
    fn link_credentials_merge_updates_by_id_and_never_blanks_missing_key() {
        // Pure-logic mirror of eaon_cli_link_credentials's merge, since the
        // real command needs an AppHandle — exercises the exact same JSON
        // shape/behavior the command produces.
        fn merge(mut config: Value, eaon_api_key: Option<&str>, incoming: &[(&str, &str)]) -> Value {
            let obj = config.as_object_mut().unwrap();
            if let Some(key) = eaon_api_key.map(str::trim).filter(|k| !k.is_empty()) {
                obj.insert("aquaApiKey".to_string(), json!(key));
            }
            let mut providers: Vec<Value> = obj.get("customProviders").and_then(Value::as_array).cloned().unwrap_or_default();
            for (id, api_key) in incoming {
                let entry = json!({"id": id, "apiKey": api_key});
                match providers.iter_mut().find(|p| p.get("id").and_then(Value::as_str) == Some(*id)) {
                    Some(existing) => *existing = entry,
                    None => providers.push(entry),
                }
            }
            obj.insert("customProviders".to_string(), Value::Array(providers));
            config
        }

        // A key already in the CLI's config survives an empty/missing incoming key.
        let existing = json!({"aquaApiKey": "sk-existing", "customProviders": [{"id": "p1", "apiKey": "old"}]});
        let after_blank = merge(existing.clone(), None, &[]);
        assert_eq!(after_blank["aquaApiKey"], "sk-existing");

        // A real incoming key overwrites it.
        let after_real = merge(existing.clone(), Some("sk-new"), &[]);
        assert_eq!(after_real["aquaApiKey"], "sk-new");

        // Re-linking the same provider id updates it in place, not duplicates it.
        let after_update = merge(existing, Some("sk-new"), &[("p1", "rotated"), ("p2", "brand-new")]);
        let providers = after_update["customProviders"].as_array().unwrap();
        assert_eq!(providers.len(), 2);
        assert_eq!(providers[0]["apiKey"], "rotated");
        assert_eq!(providers[1]["apiKey"], "brand-new");
    }
}
