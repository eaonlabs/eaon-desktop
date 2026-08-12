// llama.cpp as a first-class local backend — discovery, server lifecycle and
// status. The port of the Mac app's LocalAI llamaCpp path.
//
// llama-server speaks an OpenAI-compatible API, so once it is running the
// existing provider machinery talks to it with no special casing: this module
// only has to find the binary, spawn it with sane flags, and say whether it
// is up.
//
// MLX, the Mac's third local backend, deliberately has no counterpart here —
// it is Apple-silicon only and has no Windows or Linux build at all.

use std::path::{Path, PathBuf};
use std::process::{Child, Command};
use std::sync::Mutex;

use serde::Serialize;

use crate::net::http_client;

/// Same port the Mac app uses for llama.cpp, so a user's notes, docs and
/// muscle memory carry across platforms.
pub const LLAMA_PORT: u16 = 8586;

/// Default context window. Without `-c`, llama-server allocates the model's
/// FULL trained context and splits it across 4 parallel slots — on a modern
/// model that is a 128K–256K KV cache. Measured on the Mac: a 0.8B GGUF whose
/// weights are ~0.5 GB pulled a 3 GB KV cache at the 256K default; `-c 8192
/// -np 1` drops that to 96 MiB. On a RAM-constrained machine the big
/// allocation swaps to disk and a tiny model "takes forever to respond".
pub const DEFAULT_CONTEXT_TOKENS: u32 = 8192;

struct RunningLlama {
    child: Child,
    model_path: String,
}

static RUNNING: Mutex<Option<RunningLlama>> = Mutex::new(None);

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LlamaStatus {
    /// Whether a llama-server binary was found on this machine.
    pub installed: bool,
    pub binary_path: Option<String>,
    /// Whether OUR spawned server is alive and answering.
    pub running: bool,
    pub model_path: Option<String>,
    pub port: u16,
    pub base_url: String,
}

fn executable_name() -> &'static str {
    if cfg!(windows) { "llama-server.exe" } else { "llama-server" }
}

/// Extra places llama.cpp commonly lands that are not always on PATH —
/// winget/scoop on Windows, the usual prefixes on Linux.
fn extra_candidate_dirs() -> Vec<PathBuf> {
    let mut dirs: Vec<PathBuf> = Vec::new();
    if cfg!(windows) {
        for var in ["LOCALAPPDATA", "ProgramFiles", "ProgramFiles(x86)", "USERPROFILE"] {
            if let Ok(base) = std::env::var(var) {
                let base = PathBuf::from(base);
                dirs.push(base.join("Programs").join("llama.cpp"));
                dirs.push(base.join("llama.cpp"));
                dirs.push(base.join("scoop").join("shims"));
            }
        }
        dirs.push(PathBuf::from(r"C:\llama.cpp"));
    } else {
        for path in ["/usr/local/bin", "/usr/bin", "/opt/llama.cpp/bin", "/snap/bin"] {
            dirs.push(PathBuf::from(path));
        }
        if let Ok(home) = std::env::var("HOME") {
            dirs.push(PathBuf::from(&home).join(".local").join("bin"));
        }
    }
    dirs
}

/// First directory in `dirs` holding `name`. Split out from `find_binary` so
/// the search order is testable without mutating the process environment.
fn find_in_dirs<I: IntoIterator<Item = PathBuf>>(dirs: I, name: &str) -> Option<PathBuf> {
    for dir in dirs {
        let candidate = dir.join(name);
        if candidate.is_file() {
            return Some(candidate);
        }
    }
    None
}

/// Finds llama-server on PATH first (the user's own choice wins), then in the
/// well-known install locations.
pub fn find_binary() -> Option<PathBuf> {
    let name = executable_name();
    let path_dirs = std::env::var("PATH")
        .map(|p| std::env::split_paths(&p).collect::<Vec<_>>())
        .unwrap_or_default();
    find_in_dirs(path_dirs, name).or_else(|| find_in_dirs(extra_candidate_dirs(), name))
}

/// llama.cpp wants PHYSICAL cores: its default uses every logical thread,
/// which on an SMT machine oversubscribes and makes the app itself jank
/// alongside the model. Halving the logical count approximates the physical
/// count on the SMT chips this actually matters for, and never returns zero.
fn generation_threads() -> usize {
    let logical = std::thread::available_parallelism().map(|n| n.get()).unwrap_or(4);
    (logical / 2).max(1)
}

fn base_url() -> String {
    format!("http://127.0.0.1:{LLAMA_PORT}")
}

/// True when something is actually answering on our port. Checked over HTTP
/// rather than trusting the child handle: the process can be alive while the
/// model is still loading, and it can die without us reaping it.
async fn server_answering() -> bool {
    let url = format!("{}/v1/models", base_url());
    match http_client(Some(2)).get(&url).send().await {
        Ok(response) => response.status().is_success(),
        Err(_) => false,
    }
}

/// Reads (and prunes) the spawned-child record. A child that has already
/// exited is cleared here, so status never reports a corpse as running.
fn current_model_path() -> Option<String> {
    let mut guard = RUNNING.lock().ok()?;
    let running = guard.as_mut()?;
    match running.child.try_wait() {
        Ok(Some(_)) => {
            *guard = None;
            None
        }
        _ => Some(running.model_path.clone()),
    }
}

#[tauri::command]
pub async fn llama_status() -> LlamaStatus {
    let binary = find_binary();
    let model_path = current_model_path();
    // Only claim "running" when the port really answers.
    let running = model_path.is_some() && server_answering().await;
    LlamaStatus {
        installed: binary.is_some(),
        binary_path: binary.map(|p| p.to_string_lossy().to_string()),
        running,
        model_path,
        port: LLAMA_PORT,
        base_url: base_url(),
    }
}

/// Spawns llama-server for one GGUF file. `gpu_layers` of None leaves the
/// flag off entirely, which is llama-server's own "auto" (fit to device
/// memory) — the right default for anyone who has never touched the control.
#[tauri::command]
pub async fn llama_start(
    model_path: String,
    gpu_layers: Option<i32>,
    context_size: Option<u32>,
) -> Result<LlamaStatus, String> {
    let binary = find_binary().ok_or_else(|| {
        "Couldn't find llama-server. Install llama.cpp and make sure llama-server is on your PATH.".to_string()
    })?;

    let model = Path::new(&model_path);
    if !model.is_file() {
        return Err(format!("No model file at {model_path}"));
    }

    // Replace whatever was running — one llama-server at a time, since they
    // would fight over the port anyway.
    stop_inner()?;

    let context = context_size.unwrap_or(DEFAULT_CONTEXT_TOKENS).max(512);
    let mut args: Vec<String> = vec!["-m".into(), model_path.clone()];
    if let Some(layers) = gpu_layers {
        args.push("-ngl".into());
        args.push(layers.to_string());
    }
    // `-np 1` gives the whole window to the one chat rather than quartering
    // it across parallel slots we never use.
    args.extend([
        "-c".into(),
        context.to_string(),
        "-np".into(),
        "1".into(),
        "-t".into(),
        generation_threads().to_string(),
        "--port".into(),
        LLAMA_PORT.to_string(),
        "--host".into(),
        "127.0.0.1".into(),
    ]);

    let mut command = Command::new(&binary);
    command.args(&args);
    // Detach the console window Windows would otherwise pop for a
    // console subsystem child.
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        command.creation_flags(CREATE_NO_WINDOW);
    }
    let child = command
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .spawn()
        .map_err(|e| format!("Couldn't start llama-server: {e}"))?;

    if let Ok(mut guard) = RUNNING.lock() {
        *guard = Some(RunningLlama { child, model_path: model_path.clone() });
    }

    // Loading a multi-gigabyte model off disk takes a moment; poll rather
    // than returning a "running: false" the UI would have to re-ask about.
    for _ in 0..60 {
        if server_answering().await {
            break;
        }
        // Bail early if the child died (bad flags, unsupported GGUF).
        if current_model_path().is_none() {
            return Err("llama-server exited while starting — check the model file is a valid GGUF.".to_string());
        }
        tokio::time::sleep(std::time::Duration::from_millis(500)).await;
    }

    Ok(llama_status().await)
}

fn stop_inner() -> Result<(), String> {
    let mut guard = RUNNING.lock().map_err(|_| "llama.cpp state was poisoned".to_string())?;
    if let Some(mut running) = guard.take() {
        let _ = running.child.kill();
        let _ = running.child.wait();
    }
    Ok(())
}

#[tauri::command]
pub fn llama_stop() -> Result<(), String> {
    stop_inner()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    fn temp_dir(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("eaon-llama-test-{tag}-{}", std::process::id()));
        let _ = fs::create_dir_all(&dir);
        dir
    }

    #[test]
    fn executable_name_matches_platform() {
        if cfg!(windows) {
            assert_eq!(executable_name(), "llama-server.exe");
        } else {
            assert_eq!(executable_name(), "llama-server");
        }
    }

    #[test]
    fn generation_threads_is_at_least_one_and_below_logical() {
        let threads = generation_threads();
        assert!(threads >= 1, "must never ask llama.cpp for zero threads");
        let logical = std::thread::available_parallelism().map(|n| n.get()).unwrap_or(4);
        assert!(
            threads <= logical,
            "must never oversubscribe: {threads} > {logical} logical"
        );
    }

    #[test]
    fn finds_the_binary_in_a_listed_directory() {
        let dir = temp_dir("found");
        let binary = dir.join(executable_name());
        fs::write(&binary, b"#!/bin/sh\n").unwrap();

        let found = find_in_dirs(vec![dir.clone()], executable_name());
        assert_eq!(found.as_deref(), Some(binary.as_path()));
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn earlier_directories_win() {
        // PATH order is the user's own preference — the first hit must win,
        // so a hand-installed build shadows a packaged one.
        let first = temp_dir("first");
        let second = temp_dir("second");
        let preferred = first.join(executable_name());
        fs::write(&preferred, b"first").unwrap();
        fs::write(second.join(executable_name()), b"second").unwrap();

        let found = find_in_dirs(vec![first.clone(), second.clone()], executable_name());
        assert_eq!(found.as_deref(), Some(preferred.as_path()));
        let _ = fs::remove_dir_all(&first);
        let _ = fs::remove_dir_all(&second);
    }

    #[test]
    fn missing_binary_reports_none_rather_than_guessing() {
        let dir = temp_dir("empty");
        assert!(find_in_dirs(vec![dir.clone()], executable_name()).is_none());
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_directory_named_like_the_binary_is_not_mistaken_for_it() {
        // is_file() rather than exists(): a folder called llama-server would
        // otherwise be "found" and then fail confusingly at spawn time.
        let dir = temp_dir("dirtrap");
        let decoy = dir.join(executable_name());
        let _ = fs::create_dir_all(&decoy);
        assert!(find_in_dirs(vec![dir.clone()], executable_name()).is_none());
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn extra_candidates_are_platform_appropriate() {
        let dirs = extra_candidate_dirs();
        assert!(!dirs.is_empty(), "there should always be fallback locations to try");
        let joined = dirs
            .iter()
            .map(|d| d.to_string_lossy().to_lowercase())
            .collect::<Vec<_>>()
            .join(" ");
        if cfg!(windows) {
            assert!(joined.contains("llama.cpp") || joined.contains("scoop"));
        } else {
            assert!(joined.contains("/usr/local/bin"));
        }
    }

    #[test]
    fn default_context_avoids_the_full_trained_window() {
        // The whole point of pinning -c: the default would allocate a
        // 128K-256K KV cache. Anything in that range defeats it.
        assert!(DEFAULT_CONTEXT_TOKENS >= 2048, "too small to be useful for chat");
        assert!(DEFAULT_CONTEXT_TOKENS <= 32_768, "large enough to reintroduce the KV-cache blowup");
    }
}
