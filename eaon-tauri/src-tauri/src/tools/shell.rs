// run_shell — the agent's terminal. `cmd /C` on Windows, `sh -c` elsewhere,
// a hard 60-second tokio timeout, merged stdout+stderr with a 12k-char cap,
// and no stdin (an interactive prompt would just eat the whole timeout).

use super::safety::{home_dir, mentions_escalation, normalize};
use super::{arg_str, ToolOutcome};
use serde_json::Value;
use std::process::Stdio;
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tokio::io::AsyncReadExt;

const SHELL_TIMEOUT_SECS: u64 = 60;
const SHELL_OUTPUT_CAP: usize = 12_000;

/// Stream one pipe into a shared buffer. Shared rather than returned so a
/// reader we have to abandon (a killed command's grandchild can keep the
/// pipe open forever) still leaves everything read so far for the report.
fn drain<R>(pipe: Option<R>) -> (Arc<Mutex<Vec<u8>>>, tokio::task::JoinHandle<()>)
where
    R: tokio::io::AsyncRead + Unpin + Send + 'static,
{
    let buf = Arc::new(Mutex::new(Vec::new()));
    let sink = Arc::clone(&buf);
    let handle = tokio::spawn(async move {
        let Some(mut pipe) = pipe else { return };
        let mut chunk = [0u8; 8192];
        loop {
            match pipe.read(&mut chunk).await {
                Ok(0) | Err(_) => break,
                Ok(n) => {
                    if let Ok(mut b) = sink.lock() {
                        b.extend_from_slice(&chunk[..n]);
                    }
                }
            }
        }
    });
    (buf, handle)
}

pub(crate) async fn run_shell(args: &Value) -> ToolOutcome {
    let command = match arg_str(args, "command").map(|c| c.trim()) {
        Some(c) if !c.is_empty() => c.to_string(),
        _ => return ToolOutcome::err("missing a non-empty \"command\""),
    };
    if mentions_escalation(&command) {
        return ToolOutcome::err(
            "Refused: this runs commands as you, never as an administrator. Drop the sudo/runas."
                .to_string(),
        );
    }

    let mut working_dir = home_dir();
    if let Some(wd_raw) = arg_str(args, "working_directory") {
        let wd = normalize(wd_raw);
        if !wd.is_dir() {
            return ToolOutcome::err(format!("working_directory isn't a directory: {}", wd.display()));
        }
        working_dir = wd;
    }

    let mut cmd = if cfg!(windows) {
        let mut c = tokio::process::Command::new("cmd");
        c.args(["/C", &command]);
        c
    } else {
        let mut c = tokio::process::Command::new("sh");
        c.args(["-c", &command]);
        c
    };
    // The app is a GUI-subsystem process on Windows; without CREATE_NO_WINDOW
    // every tool call would flash a black console window at the user.
    #[cfg(windows)]
    cmd.creation_flags(0x0800_0000);
    cmd.current_dir(&working_dir)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);

    let mut child = match cmd.spawn() {
        Ok(c) => c,
        Err(e) => return ToolOutcome::err(format!("Couldn't run it: {e}")),
    };

    // Drain both pipes concurrently with the wait — a chatty child would
    // otherwise fill the pipe buffer and deadlock against its own timeout.
    let (out_buf, mut out_task) = drain(child.stdout.take());
    let (err_buf, mut err_task) = drain(child.stderr.take());

    let (timed_out, code) =
        match tokio::time::timeout(Duration::from_secs(SHELL_TIMEOUT_SECS), child.wait()).await {
            Ok(Ok(status)) => (false, status.code()),
            Ok(Err(e)) => return ToolOutcome::err(format!("Couldn't wait on the command: {e}")),
            Err(_) => {
                // Time's up — kill and reap, then report what it printed.
                let _ = child.start_kill();
                let _ = child.wait().await;
                (true, None)
            }
        };

    // Give the readers a moment to hit EOF, then abandon them — the shared
    // buffers keep whatever partial output was captured either way.
    let grace = tokio::time::Instant::now() + Duration::from_millis(1500);
    let _ = tokio::time::timeout_at(grace, &mut out_task).await;
    let _ = tokio::time::timeout_at(grace, &mut err_task).await;
    out_task.abort();
    err_task.abort();

    let mut combined = String::new();
    for buf in [&out_buf, &err_buf] {
        if let Ok(bytes) = buf.lock() {
            combined.push_str(&String::from_utf8_lossy(&bytes));
        }
    }
    let capped: String = if combined.chars().count() > SHELL_OUTPUT_CAP {
        let head: String = combined.chars().take(SHELL_OUTPUT_CAP).collect();
        format!("{head}\n…(output truncated at 12k characters)")
    } else {
        combined
    };
    if timed_out {
        return ToolOutcome::err(format!(
            "Command killed after {SHELL_TIMEOUT_SECS}s (still running).\n{capped}"
        ));
    }
    let ok = code == Some(0);
    let header = match code {
        Some(0) => "exit code: 0".to_string(),
        Some(n) => format!("exit code: {n}"),
        None => "exited by signal".to_string(),
    };
    let body = if capped.trim().is_empty() { "(no output)".to_string() } else { capped };
    ToolOutcome { ok, text: format!("{header}\n{body}") }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[tokio::test]
    async fn shell_runs_and_blocks_escalation() {
        let echo = run_shell(&json!({ "command": "echo eaon_ok" })).await;
        assert!(echo.ok, "echo failed: {}", echo.text);
        assert!(echo.text.contains("eaon_ok"));

        let sudo = run_shell(&json!({ "command": "sudo rm -rf /" })).await;
        assert!(!sudo.ok, "must refuse sudo");
        assert!(sudo.text.contains("Refused"));

        // The wider escalation family — and mid-pipeline, not just as the
        // first word.
        for cmd in ["doas rm -rf /", "echo x | gsudo del C:\\x", "runas /user:Administrator cmd"] {
            let out = run_shell(&json!({ "command": cmd })).await;
            assert!(!out.ok, "must refuse escalation: {cmd}");
            assert!(out.text.contains("Refused"), "{}", out.text);
        }
    }
}
