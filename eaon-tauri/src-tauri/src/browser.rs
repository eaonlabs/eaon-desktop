// Browser control — the loopback bridge the Eaon browser extension talks to.
// The port of the Mac app's BrowserBridge.swift.
//
// Deliberately wire-compatible with the Mac implementation, so the SAME
// unmodified extension pairs with either app: same candidate ports, same
// `x-eaon-token` header, same /health, /poll and /result shapes.
//
// The extension long-polls GET/POST /poll; Eaon holds that request open until
// it has a command, then answers with it. Long-polling rather than WebSockets
// on purpose: an upgrade handshake inside a hand-rolled HTTP server is a lot
// of protocol for one duplex channel, and its failures are silent and awkward
// to debug. This reuses the plain request parsing that already exists.
//
// The listener binds to loopback only, so nothing off this machine can reach
// it, and every request must carry the pairing token.

use std::collections::HashMap;
use std::sync::Mutex;
use std::time::{Duration, Instant};

use serde::Serialize;
use tokio::net::TcpListener;
use tokio::sync::oneshot;

use crate::server::{read_request, write_simple};

/// Ports to try, in order. A single fixed port looks simpler but fails badly:
/// anything else already holding it (another Eaon, a dev server) means the
/// listener silently doesn't come up.
const CANDIDATE_PORTS: [u16; 5] = [8823, 8824, 8825, 8826, 8827];

/// How long a poll is parked before answering "nothing to do". Comfortably
/// under the extension's own timeout, so the connection is recycled by us
/// rather than dropped by it.
const POLL_PARK: Duration = Duration::from_secs(25);

/// How long a queued command waits for the browser to carry it out.
const COMMAND_TIMEOUT: Duration = Duration::from_secs(45);

/// The extension is considered connected if it has polled this recently.
/// Inferred from polling rather than tracked as a connection, because a
/// long-poll that has been answered is no longer an open socket.
const CONNECTED_WINDOW: Duration = Duration::from_secs(40);

struct Command {
    id: String,
    action: String,
    params: serde_json::Value,
}

#[derive(Default)]
struct BridgeState {
    port: Option<u16>,
    token: String,
    queue: Vec<Command>,
    /// Commands handed to the browser, awaiting their /result.
    waiting: HashMap<String, oneshot::Sender<Result<String, String>>>,
    /// A parked long-poll waiting for something to hand back.
    parked: Option<oneshot::Sender<Command>>,
    last_poll: Option<Instant>,
    tab: Option<String>,
}

static STATE: Mutex<Option<BridgeState>> = Mutex::new(None);

fn with_state<T>(f: impl FnOnce(&mut BridgeState) -> T) -> Option<T> {
    let mut guard = STATE.lock().ok()?;
    let state = guard.get_or_insert_with(BridgeState::default);
    Some(f(state))
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowserStatus {
    pub running: bool,
    pub port: Option<u16>,
    pub token: String,
    /// Whether the extension has polled recently enough to count as paired.
    pub connected: bool,
    /// Title/URL of the tab the extension last reported.
    pub tab: Option<String>,
}

fn generate_token() -> String {
    uuid::Uuid::new_v4().simple().to_string()
}

#[tauri::command]
pub fn browser_status() -> BrowserStatus {
    with_state(|state| {
        let connected = state
            .last_poll
            .map(|at| at.elapsed() < CONNECTED_WINDOW)
            .unwrap_or(false);
        BrowserStatus {
            running: state.port.is_some(),
            port: state.port,
            token: state.token.clone(),
            connected,
            tab: state.tab.clone(),
        }
    })
    .unwrap_or(BrowserStatus {
        running: false,
        port: None,
        token: String::new(),
        connected: false,
        tab: None,
    })
}

/// Binds the first free candidate port and starts accepting. Idempotent: a
/// second call while already listening is a no-op rather than a second
/// listener fighting for the port.
#[tauri::command]
pub async fn browser_start() -> Result<BrowserStatus, String> {
    if with_state(|s| s.port).flatten().is_some() {
        return Ok(browser_status());
    }

    let mut bound: Option<(std::net::TcpListener, u16)> = None;
    for port in CANDIDATE_PORTS {
        if let Ok(listener) = std::net::TcpListener::bind(("127.0.0.1", port)) {
            let _ = listener.set_nonblocking(true);
            bound = Some((listener, port));
            break;
        }
    }
    let (listener, port) = bound.ok_or_else(|| {
        format!("Every bridge port is in use ({}–{}).", CANDIDATE_PORTS[0], CANDIDATE_PORTS[4])
    })?;

    with_state(|state| {
        state.port = Some(port);
        if state.token.is_empty() {
            state.token = generate_token();
        }
    });

    let listener = TcpListener::from_std(listener).map_err(|e| e.to_string())?;
    tauri::async_runtime::spawn(async move {
        loop {
            match listener.accept().await {
                Ok((stream, _)) => {
                    tauri::async_runtime::spawn(handle_connection(stream));
                }
                Err(_) => break,
            }
        }
    });

    Ok(browser_status())
}

#[tauri::command]
pub fn browser_regenerate_token() -> BrowserStatus {
    with_state(|state| state.token = generate_token());
    browser_status()
}

fn header<'a>(req: &'a crate::server::ParsedRequest, name: &str) -> Option<&'a str> {
    req.headers
        .iter()
        .find(|(k, _)| k == name)
        .map(|(_, v)| v.as_str())
}

async fn handle_connection(mut stream: tokio::net::TcpStream) {
    let Some(req) = read_request(&mut stream).await else { return };

    // Every request must carry the pairing token. A web page CAN issue
    // requests to 127.0.0.1 — it could not read the replies (CORS), but it
    // could still fire commands, so the token is what stops that.
    let expected = with_state(|s| s.token.clone()).unwrap_or_default();
    if expected.is_empty() || header(&req, "x-eaon-token") != Some(expected.as_str()) {
        write_simple(&mut stream, "401 Unauthorized", "application/json", r#"{"error":"bad token"}"#).await;
        return;
    }

    let body: serde_json::Value = serde_json::from_slice(&req.body).unwrap_or(serde_json::Value::Null);

    match req.path.as_str() {
        "/health" => {
            write_simple(&mut stream, "200 OK", "application/json", r#"{"ok":true}"#).await;
        }

        "/poll" => {
            let tab = body.get("tab").and_then(|t| t.as_str()).map(str::to_string);
            let ready = with_state(|state| {
                state.last_poll = Some(Instant::now());
                if tab.is_some() {
                    state.tab = tab.clone();
                }
                if state.queue.is_empty() {
                    None
                } else {
                    Some(state.queue.remove(0))
                }
            })
            .flatten();

            if let Some(command) = ready {
                write_simple(&mut stream, "200 OK", "application/json", &payload(&command)).await;
                return;
            }

            // Park it. Answering immediately would make the extension spin at
            // its retry interval; holding the request open means a command
            // reaches the browser the moment it exists.
            let (tx, rx) = oneshot::channel::<Command>();
            with_state(|state| state.parked = Some(tx));
            match tokio::time::timeout(POLL_PARK, rx).await {
                Ok(Ok(command)) => {
                    write_simple(&mut stream, "200 OK", "application/json", &payload(&command)).await;
                }
                _ => {
                    with_state(|state| state.parked = None);
                    write_simple(&mut stream, "200 OK", "application/json", r#"{"action":"none"}"#).await;
                }
            }
        }

        "/result" => {
            let id = body.get("id").and_then(|v| v.as_str()).unwrap_or("").to_string();
            let error = body.get("error").and_then(|v| v.as_str()).unwrap_or("").to_string();
            let result = body
                .get("result")
                .and_then(|v| v.as_str())
                .unwrap_or("Done.")
                .to_string();

            let sender = with_state(|state| {
                state.last_poll = Some(Instant::now());
                state.waiting.remove(&id)
            })
            .flatten();
            if let Some(sender) = sender {
                let _ = sender.send(if error.is_empty() { Ok(result) } else { Err(error) });
            }
            write_simple(&mut stream, "200 OK", "application/json", r#"{"ok":true}"#).await;
        }

        _ => {
            write_simple(&mut stream, "404 Not Found", "application/json", r#"{"error":"unknown path"}"#).await;
        }
    }
}

fn payload(command: &Command) -> String {
    serde_json::json!({
        "id": command.id,
        "action": command.action,
        "params": command.params,
    })
    .to_string()
}

/// Queues one command for the browser and waits for its result. Handed
/// straight to a parked poll when one is waiting, so the round trip is as
/// fast as the browser can act rather than as slow as the next poll.
pub async fn run_command(action: &str, params: serde_json::Value) -> Result<String, String> {
    if with_state(|s| s.port).flatten().is_none() {
        return Err("The browser bridge isn't running — turn on browser control in Settings.".into());
    }
    let connected = browser_status().connected;
    if !connected {
        return Err("The Eaon browser extension isn't connected. Install it and open a tab.".into());
    }

    let id = uuid::Uuid::new_v4().simple().to_string();
    let (tx, rx) = oneshot::channel::<Result<String, String>>();

    with_state(|state| {
        state.waiting.insert(id.clone(), tx);
        let command = Command { id: id.clone(), action: action.to_string(), params };
        // Hand it to a parked poll if one is waiting; otherwise queue it for
        // the next one.
        match state.parked.take() {
            Some(parked) => {
                if let Err(returned) = parked.send(command) {
                    state.queue.push(returned);
                }
            }
            None => state.queue.push(command),
        }
    });

    match tokio::time::timeout(COMMAND_TIMEOUT, rx).await {
        Ok(Ok(outcome)) => outcome,
        // Timed out, or the sender was dropped: clear the slot so a late
        // /result can't resolve a command nobody is waiting on any more.
        _ => {
            with_state(|state| state.waiting.remove(&id));
            Err("The browser didn't respond in time.".into())
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn status_is_safe_before_the_bridge_ever_starts() {
        // Called by the settings pane on mount, before anything is running.
        let status = browser_status();
        assert!(!status.running);
        assert!(!status.connected);
    }

    #[test]
    fn tokens_are_long_and_unique() {
        let a = generate_token();
        let b = generate_token();
        assert_ne!(a, b, "a repeated pairing token would let one pairing authorise another");
        assert!(a.len() >= 32, "token too short to resist guessing: {}", a.len());
        assert!(a.chars().all(|c| c.is_ascii_alphanumeric()), "token must survive a header verbatim");
    }

    #[tokio::test]
    async fn a_command_fails_cleanly_when_nothing_is_connected() {
        // The agent must get a real message it can relay, never a hang.
        let outcome = run_command("browser_read", serde_json::json!({})).await;
        assert!(outcome.is_err());
        let message = outcome.unwrap_err();
        assert!(
            message.contains("bridge isn't running") || message.contains("isn't connected"),
            "unhelpful failure: {message}"
        );
    }

    #[test]
    fn payload_carries_the_id_so_results_can_be_matched() {
        let command = Command {
            id: "abc".into(),
            action: "browser_click".into(),
            params: serde_json::json!({ "text": "Sign in" }),
        };
        let json: serde_json::Value = serde_json::from_str(&payload(&command)).unwrap();
        assert_eq!(json["id"], "abc");
        assert_eq!(json["action"], "browser_click");
        assert_eq!(json["params"]["text"], "Sign in");
    }
}
