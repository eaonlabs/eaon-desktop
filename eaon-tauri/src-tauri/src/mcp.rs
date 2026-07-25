// MCP (Model Context Protocol) client — the cross-platform port of the Mac
// app's MCPClient.swift, plus a stdio transport the Mac app doesn't need yet
// (local servers launched as a child process, `npx`-style). No SDK, matching
// the app's zero-dependency design: JSON-RPC 2.0 over Streamable HTTP
// (POST, JSON-or-SSE responses, Mcp-Session-Id) or over newline-delimited
// stdin/stdout.
//
// Connections persist in a global registry across commands; the frontend
// drives connect / list / call / disconnect through the commands at the
// bottom.

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::io::{BufRead, BufReader, Write};
use std::sync::mpsc;
use std::sync::{Arc, LazyLock, Mutex};
use std::time::Duration;

const PROTOCOL_VERSION: &str = "2025-06-18";
const HTTP_TIMEOUT_SECS: u64 = 30;
const STDIO_RPC_TIMEOUT_SECS: u64 = 60;

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

struct HttpMeta {
    endpoint: String,
    /// ("Bearer" | "Sentry-Bearer" | "Apikey" | …, token) — every server
    /// surveyed puts the token in Authorization, they just disagree on the
    /// scheme word (see the Mac MCPClient's authScheme note).
    auth: Option<(String, String)>,
    /// Extra per-request headers beyond auth (catalog `extraHeaders`, e.g.
    /// GitHub's `X-MCP-Toolsets`) — sent on EVERY request, initialize
    /// included; GitHub scopes the tool list at initialize time.
    extra_headers: Vec<(String, String)>,
    session_id: Option<String>,
    initialized: bool,
    next_id: i64,
}

struct StdioConn {
    child: std::process::Child,
    stdin: std::process::ChildStdin,
    /// Lines from the child's stdout, pumped by a dedicated reader thread —
    /// so an unresponsive server times out instead of blocking a call
    /// forever on a pipe read.
    rx: mpsc::Receiver<String>,
    next_id: i64,
}

impl Drop for StdioConn {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

enum Conn {
    Http(Arc<tokio::sync::Mutex<HttpMeta>>),
    Stdio(Arc<Mutex<StdioConn>>),
}

static CONNECTIONS: LazyLock<Mutex<HashMap<String, Conn>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));

fn get_conn(id: &str) -> Option<Conn> {
    let map = CONNECTIONS.lock().unwrap();
    map.get(id).map(|c| match c {
        Conn::Http(m) => Conn::Http(m.clone()),
        Conn::Stdio(s) => Conn::Stdio(s.clone()),
    })
}

// ---------------------------------------------------------------------------
// Wire shapes to/from the frontend
// ---------------------------------------------------------------------------

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct McpConnectArgs {
    /// The registry key — the frontend's server id.
    pub server_id: String,
    /// "http" | "stdio"
    pub transport: String,
    pub url: Option<String>,
    pub auth_scheme: Option<String>,
    pub token: Option<String>,
    pub extra_headers: Option<HashMap<String, String>>,
    pub command: Option<String>,
    pub args: Option<Vec<String>>,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct McpToolInfo {
    pub name: String,
    pub description: Option<String>,
    /// The raw JSON Schema — the frontend formats parameter lines/specs
    /// from it (port of MCPTool.parameters).
    pub input_schema: Value,
}

/// Parsed outcome of tools/call. `is_error` is true when the TOOL reported
/// failure (a successful RPC carrying an error result, per spec) —
/// transport/protocol failures reject the whole command instead.
struct CallOutcome {
    is_error: bool,
    text: String,
}

// ---------------------------------------------------------------------------
// HTTP transport (Streamable HTTP — port of MCPClient.send/extractPayload)
// ---------------------------------------------------------------------------

/// The server may answer as one plain JSON object or as an SSE stream of
/// `data: {...}` records — take the first record whose `id` matches.
fn extract_payload(body: &str, content_type: &str, matching_id: i64) -> Result<Value, String> {
    if content_type.contains("text/event-stream") {
        for line in body.lines() {
            let trimmed = line.trim();
            let Some(rest) = trimmed.strip_prefix("data:") else { continue };
            let Ok(obj) = serde_json::from_str::<Value>(rest.trim()) else { continue };
            if obj["id"].as_i64() == Some(matching_id) {
                return Ok(obj);
            }
        }
        return Err("Got a response that didn't look like a valid MCP reply.".to_string());
    }
    serde_json::from_str(body).map_err(|_| "Got a response that didn't look like a valid MCP reply.".to_string())
}

async fn http_rpc(
    meta: &Arc<tokio::sync::Mutex<HttpMeta>>,
    method: &str,
    params: Option<Value>,
    expects_reply: bool,
) -> Result<Value, String> {
    // Snapshot request state briefly; never hold the lock across the await.
    let (endpoint, auth, extra_headers, session, initialized, request_id) = {
        let mut m = meta.lock().await;
        let id = m.next_id;
        if expects_reply {
            m.next_id += 1;
        }
        (m.endpoint.clone(), m.auth.clone(), m.extra_headers.clone(), m.session_id.clone(), m.initialized, id)
    };

    let mut body = json!({ "jsonrpc": "2.0", "method": method });
    if let Some(p) = params {
        body["params"] = p;
    }
    if expects_reply {
        body["id"] = json!(request_id);
    }

    let client = crate::net::http_client(Some(HTTP_TIMEOUT_SECS));
    let mut builder = client
        .post(&endpoint)
        // Both values, one header — the spec's literal requirement.
        .header("Accept", "application/json, text/event-stream")
        .header("Content-Type", "application/json");
    if let Some((scheme, token)) = auth.as_ref() {
        builder = builder.header("Authorization", format!("{scheme} {token}"));
    }
    for (name, value) in extra_headers.iter() {
        builder = builder.header(name.as_str(), value.as_str());
    }
    // MUST accompany every request *after* initialize — not initialize
    // itself, which is what negotiates the version.
    if initialized {
        builder = builder.header("MCP-Protocol-Version", PROTOCOL_VERSION);
    }
    if let Some(session) = session.as_ref() {
        builder = builder.header("Mcp-Session-Id", session);
    }

    let response = builder.json(&body).send().await.map_err(|e| {
        if e.is_connect() {
            format!("Couldn't reach the MCP server at {endpoint}: {e}")
        } else {
            format!("MCP request failed: {e}")
        }
    })?;

    // The server may assign a session on any response — capture whenever
    // present.
    if let Some(new_session) = response
        .headers()
        .get("mcp-session-id")
        .and_then(|v| v.to_str().ok())
        .map(str::to_string)
    {
        meta.lock().await.session_id = Some(new_session);
    }

    let status = response.status();
    let content_type = response
        .headers()
        .get("content-type")
        .and_then(|v| v.to_str().ok())
        .unwrap_or("")
        .to_string();
    let text = response.text().await.unwrap_or_default();

    if !status.is_success() {
        return Err(match status.as_u16() {
            401 | 403 => "That token doesn't look valid — check it has the right scopes and try again.".to_string(),
            code => format!("The server returned an error (HTTP {code})."),
        });
    }
    if !expects_reply {
        return Ok(Value::Null);
    }

    let payload = extract_payload(&text, &content_type, request_id)?;
    if let Some(error) = payload.get("error") {
        return Err(error["message"].as_str().unwrap_or("Unknown MCP error").to_string());
    }
    Ok(payload.get("result").cloned().unwrap_or_else(|| json!({})))
}

// ---------------------------------------------------------------------------
// stdio transport (newline-delimited JSON-RPC)
// ---------------------------------------------------------------------------

fn stdio_rpc(
    conn: &mut StdioConn,
    method: &str,
    params: Option<Value>,
    expects_reply: bool,
) -> Result<Value, String> {
    let request_id = conn.next_id;
    if expects_reply {
        conn.next_id += 1;
    }
    let mut body = json!({ "jsonrpc": "2.0", "method": method });
    if let Some(p) = params {
        body["params"] = p;
    }
    if expects_reply {
        body["id"] = json!(request_id);
    }
    let line = serde_json::to_string(&body).map_err(|e| e.to_string())? + "\n";
    conn.stdin
        .write_all(line.as_bytes())
        .and_then(|_| conn.stdin.flush())
        .map_err(|e| format!("The MCP server's stdin closed: {e}"))?;

    if !expects_reply {
        return Ok(Value::Null);
    }

    let deadline = std::time::Instant::now() + Duration::from_secs(STDIO_RPC_TIMEOUT_SECS);
    loop {
        let remaining = deadline
            .checked_duration_since(std::time::Instant::now())
            .ok_or_else(|| "The MCP server didn't reply in time.".to_string())?;
        let line = conn
            .rx
            .recv_timeout(remaining)
            .map_err(|_| "The MCP server didn't reply in time (or exited).".to_string())?;
        let Ok(obj) = serde_json::from_str::<Value>(&line) else { continue };
        // Skip server-initiated notifications/requests and other ids —
        // we only await OUR reply.
        if obj["id"].as_i64() != Some(request_id) || obj.get("method").is_some() {
            continue;
        }
        if let Some(error) = obj.get("error") {
            return Err(error["message"].as_str().unwrap_or("Unknown MCP error").to_string());
        }
        return Ok(obj.get("result").cloned().unwrap_or_else(|| json!({})));
    }
}

fn spawn_stdio(command: &str, args: &[String]) -> Result<StdioConn, String> {
    use std::process::{Command, Stdio};
    #[cfg(target_os = "windows")]
    let mut cmd = {
        // `cmd /C` so PATHEXT resolution works — an MCP server is very
        // often `npx …`, which is npx.cmd on Windows and unfindable
        // through CreateProcess directly.
        let mut c = Command::new("cmd");
        c.arg("/C").arg(command).args(args);
        // CREATE_NO_WINDOW (0x08000000): a console child spawned from a GUI
        // app otherwise flashes a visible console window on every launch.
        use std::os::windows::process::CommandExt;
        c.creation_flags(0x0800_0000);
        c
    };
    #[cfg(not(target_os = "windows"))]
    let mut cmd = {
        let mut c = Command::new(command);
        c.args(args);
        c
    };
    let mut child = cmd
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|e| format!("Couldn't launch \"{command}\": {e}"))?;

    let stdin = child.stdin.take().ok_or("no stdin")?;
    let stdout = child.stdout.take().ok_or("no stdout")?;
    let (tx, rx) = mpsc::channel::<String>();
    // Dedicated pump thread: ends by itself when the child's stdout closes.
    std::thread::spawn(move || {
        let reader = BufReader::new(stdout);
        for line in reader.lines() {
            match line {
                Ok(l) => {
                    if tx.send(l).is_err() {
                        break;
                    }
                }
                Err(_) => break,
            }
        }
    });
    Ok(StdioConn { child, stdin, rx, next_id: 1 })
}

// ---------------------------------------------------------------------------
// Shared protocol steps
// ---------------------------------------------------------------------------

fn initialize_params() -> Value {
    json!({
        "protocolVersion": PROTOCOL_VERSION,
        "capabilities": {},
        "clientInfo": { "name": "Eaon", "version": env!("CARGO_PKG_VERSION") },
    })
}

fn tools_from_list_result(result: &Value) -> (Vec<McpToolInfo>, Option<String>) {
    let tools = result["tools"]
        .as_array()
        .map(|arr| {
            arr.iter()
                .filter_map(|entry| {
                    Some(McpToolInfo {
                        name: entry["name"].as_str()?.to_string(),
                        description: entry["description"].as_str().map(str::to_string),
                        input_schema: entry.get("inputSchema").cloned().unwrap_or_else(|| json!({})),
                    })
                })
                .collect()
        })
        .unwrap_or_default();
    let cursor = result["nextCursor"].as_str().map(str::to_string);
    (tools, cursor)
}

fn call_outcome_from(result: &Value) -> CallOutcome {
    let is_error = result["isError"].as_bool().unwrap_or(false);
    let text = result["content"]
        .as_array()
        .map(|blocks| {
            blocks
                .iter()
                .filter_map(|b| {
                    if b["type"].as_str() == Some("text") {
                        b["text"].as_str().map(str::to_string)
                    } else {
                        None
                    }
                })
                .collect::<Vec<_>>()
                .join("\n")
        })
        .unwrap_or_default();
    CallOutcome {
        is_error,
        text: if text.is_empty() { "(no text content returned)".to_string() } else { text },
    }
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

/// The part shared by every HTTP-transport connect path regardless of how
/// the token was obtained (pasted, or OAuth-issued) — initialize +
/// initialized + full tools/list, then registered under `server_id`,
/// replacing any previous connection. Also used by `mcp_oauth::mcp_oauth_connect`
/// once it has a fresh access token, so an OAuth-authenticated server ends up
/// in the exact same registry `mcp_call`/`mcp_disconnect` already handle.
pub(crate) async fn connect_http(
    server_id: &str,
    url: String,
    auth: Option<(String, String)>,
    extra_headers: Vec<(String, String)>,
) -> Result<Vec<McpToolInfo>, String> {
    CONNECTIONS.lock().unwrap().remove(server_id);

    let meta = Arc::new(tokio::sync::Mutex::new(HttpMeta {
        endpoint: url,
        auth,
        extra_headers,
        session_id: None,
        initialized: false,
        next_id: 1,
    }));

    http_rpc(&meta, "initialize", Some(initialize_params()), true).await?;
    meta.lock().await.initialized = true;
    http_rpc(&meta, "notifications/initialized", None, false).await?;

    let mut tools: Vec<McpToolInfo> = Vec::new();
    let mut cursor: Option<String> = None;
    loop {
        let params = cursor.as_ref().map(|c| json!({ "cursor": c })).unwrap_or_else(|| json!({}));
        let result = http_rpc(&meta, "tools/list", Some(params), true).await?;
        let (mut page, next) = tools_from_list_result(&result);
        tools.append(&mut page);
        cursor = next;
        if cursor.is_none() {
            break;
        }
    }

    CONNECTIONS.lock().unwrap().insert(server_id.to_string(), Conn::Http(meta));
    Ok(tools)
}

/// Connect (initialize + initialized + full tools/list) and register the
/// connection under `args.server_id`, replacing any previous one.
#[tauri::command]
pub async fn mcp_connect(args: McpConnectArgs) -> Result<Vec<McpToolInfo>, String> {
    // Drop any prior connection for this id first (stdio children get
    // killed by StdioConn's Drop).
    CONNECTIONS.lock().unwrap().remove(&args.server_id);

    match args.transport.as_str() {
        "http" => {
            let url = args.url.clone().filter(|u| !u.trim().is_empty()).ok_or("This server needs a URL.")?;
            let token = args.token.clone().unwrap_or_default();
            let auth = if token.trim().is_empty() {
                None
            } else {
                Some((args.auth_scheme.clone().unwrap_or_else(|| "Bearer".to_string()), token.trim().to_string()))
            };
            let extra = args.extra_headers.clone().unwrap_or_default().into_iter().collect();
            connect_http(&args.server_id, url, auth, extra).await
        }
        "stdio" => {
            let command = args
                .command
                .clone()
                .filter(|c| !c.trim().is_empty())
                .ok_or("This server needs a command to launch.")?;
            let cmd_args = args.args.clone().unwrap_or_default();
            let (conn, tools) = tauri::async_runtime::spawn_blocking(move || -> Result<(StdioConn, Vec<McpToolInfo>), String> {
                let mut conn = spawn_stdio(command.trim(), &cmd_args)?;
                stdio_rpc(&mut conn, "initialize", Some(initialize_params()), true)?;
                stdio_rpc(&mut conn, "notifications/initialized", None, false)?;
                let mut tools: Vec<McpToolInfo> = Vec::new();
                let mut cursor: Option<String> = None;
                loop {
                    let params = cursor.as_ref().map(|c| json!({ "cursor": c })).unwrap_or_else(|| json!({}));
                    let result = stdio_rpc(&mut conn, "tools/list", Some(params), true)?;
                    let (mut page, next) = tools_from_list_result(&result);
                    tools.append(&mut page);
                    cursor = next;
                    if cursor.is_none() {
                        break;
                    }
                }
                Ok((conn, tools))
            })
            .await
            .map_err(|e| format!("connect crashed: {e}"))??;

            CONNECTIONS
                .lock()
                .unwrap()
                .insert(args.server_id.clone(), Conn::Stdio(Arc::new(Mutex::new(conn))));
            Ok(tools)
        }
        other => Err(format!("unknown transport: {other}")),
    }
}

/// Call one tool on a connected server. Resolves to the tool's joined text
/// output; a tool-reported failure (isError, per spec) rejects with that
/// text — the wire contract is a plain string, so there's no side-band for
/// a "soft" error flag, and the caller sees every failure on one channel.
#[tauri::command]
pub async fn mcp_call(server_id: String, tool: String, args: Value) -> Result<String, String> {
    let conn = get_conn(&server_id).ok_or("Not connected yet.")?;
    let params = json!({ "name": tool, "arguments": args });
    let outcome = match conn {
        Conn::Http(meta) => {
            let result = http_rpc(&meta, "tools/call", Some(params), true).await?;
            call_outcome_from(&result)
        }
        Conn::Stdio(cell) => tauri::async_runtime::spawn_blocking(move || -> Result<CallOutcome, String> {
            let mut guard = cell.lock().map_err(|_| "connection is busy/poisoned".to_string())?;
            let result = stdio_rpc(&mut guard, "tools/call", Some(params), true)?;
            Ok(call_outcome_from(&result))
        })
        .await
        .map_err(|e| format!("call crashed: {e}"))??,
    };
    if outcome.is_error {
        Err(outcome.text)
    } else {
        Ok(outcome.text)
    }
}

/// Drop a connection (stdio children are killed).
#[tauri::command]
pub async fn mcp_disconnect(server_id: String) -> Result<(), String> {
    CONNECTIONS.lock().unwrap().remove(&server_id);
    Ok(())
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn payload_extraction_handles_json_and_sse() {
        // Plain JSON.
        let plain = r#"{"jsonrpc":"2.0","id":3,"result":{"ok":true}}"#;
        let v = extract_payload(plain, "application/json", 3).unwrap();
        assert_eq!(v["result"]["ok"], true);

        // SSE with noise records and the matching one in the middle.
        let sse = "event: message\ndata: {\"jsonrpc\":\"2.0\",\"id\":9,\"result\":{}}\n\ndata: {\"jsonrpc\":\"2.0\",\"id\":4,\"result\":{\"tools\":[]}}\n\n";
        let v = extract_payload(sse, "text/event-stream", 4).unwrap();
        assert!(v["result"]["tools"].as_array().unwrap().is_empty());

        // SSE with no matching id → clean error, not a hang or panic.
        assert!(extract_payload(sse, "text/event-stream", 99).is_err());
    }

    #[test]
    fn tool_and_call_parsing_match_spec_shapes() {
        let list: Value = serde_json::from_str(
            r#"{"tools":[{"name":"a","description":"d","inputSchema":{"type":"object"}},{"bogus":1}],"nextCursor":"n"}"#,
        )
        .unwrap();
        let (tools, cursor) = tools_from_list_result(&list);
        assert_eq!(tools.len(), 1);
        assert_eq!(tools[0].name, "a");
        assert_eq!(cursor.as_deref(), Some("n"));

        let call: Value = serde_json::from_str(
            r#"{"isError":false,"content":[{"type":"text","text":"hello"},{"type":"image","data":"x"},{"type":"text","text":"world"}]}"#,
        )
        .unwrap();
        let outcome = call_outcome_from(&call);
        assert!(!outcome.is_error);
        assert_eq!(outcome.text, "hello\nworld");

        let empty: Value = serde_json::from_str(r#"{"content":[]}"#).unwrap();
        assert_eq!(call_outcome_from(&empty).text, "(no text content returned)");
    }

    /// The catalog's `extraHeaders` (e.g. GitHub's X-MCP-Toolsets) must
    /// actually reach the wire, alongside auth — asserted against a real
    /// socket capturing the raw request bytes.
    #[tokio::test]
    async fn http_rpc_sends_auth_and_extra_headers() {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        let listener = tokio::net::TcpListener::bind(("127.0.0.1", 0u16)).await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let captured = Arc::new(tokio::sync::Mutex::new(String::new()));
        let capture = captured.clone();
        tokio::spawn(async move {
            if let Ok((mut stream, _)) = listener.accept().await {
                let mut buf = vec![0u8; 8192];
                let n = stream.read(&mut buf).await.unwrap_or(0);
                *capture.lock().await = String::from_utf8_lossy(&buf[..n]).to_string();
                let body = r#"{"jsonrpc":"2.0","id":1,"result":{}}"#;
                let resp = format!(
                    "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                    body.len()
                );
                let _ = stream.write_all(resp.as_bytes()).await;
            }
        });

        let meta = Arc::new(tokio::sync::Mutex::new(HttpMeta {
            endpoint: format!("http://127.0.0.1:{port}"),
            auth: Some(("Bearer".to_string(), "tok-123".to_string())),
            extra_headers: vec![("X-MCP-Toolsets".to_string(), "repos,issues".to_string())],
            session_id: None,
            initialized: false,
            next_id: 1,
        }));
        http_rpc(&meta, "initialize", Some(initialize_params()), true).await.unwrap();

        let request = captured.lock().await.to_lowercase();
        assert!(request.contains("authorization: bearer tok-123"), "auth header missing: {request}");
        assert!(request.contains("x-mcp-toolsets: repos,issues"), "extra header missing: {request}");
    }

    /// A REAL end-to-end stdio round-trip against a minimal in-test MCP
    /// server (python3, newline-delimited JSON-RPC): initialize →
    /// initialized → tools/list → tools/call. Unix-only — python3 isn't a
    /// given on Windows CI.
    #[cfg(unix)]
    #[test]
    fn stdio_end_to_end_against_fake_server() {
        let server = r#"
import sys, json
for line in sys.stdin:
    msg = json.loads(line)
    if "id" not in msg:
        continue
    mid = msg["id"]
    m = msg.get("method")
    if m == "initialize":
        out = {"jsonrpc": "2.0", "id": mid, "result": {"protocolVersion": "2025-06-18", "capabilities": {}, "serverInfo": {"name": "fake"}}}
    elif m == "tools/list":
        out = {"jsonrpc": "2.0", "id": mid, "result": {"tools": [{"name": "echo", "description": "echoes", "inputSchema": {"type": "object", "properties": {"text": {"type": "string"}}, "required": ["text"]}}]}}
    elif m == "tools/call":
        text = msg["params"]["arguments"]["text"]
        out = {"jsonrpc": "2.0", "id": mid, "result": {"isError": False, "content": [{"type": "text", "text": "echo: " + text}]}}
    else:
        out = {"jsonrpc": "2.0", "id": mid, "error": {"code": -32601, "message": "nope"}}
    sys.stdout.write(json.dumps(out) + "\n")
    sys.stdout.flush()
"#;
        let mut conn = spawn_stdio("python3", &["-c".to_string(), server.to_string()]).unwrap();
        stdio_rpc(&mut conn, "initialize", Some(initialize_params()), true).unwrap();
        stdio_rpc(&mut conn, "notifications/initialized", None, false).unwrap();
        let list = stdio_rpc(&mut conn, "tools/list", Some(json!({})), true).unwrap();
        let (tools, _) = tools_from_list_result(&list);
        assert_eq!(tools.len(), 1);
        assert_eq!(tools[0].name, "echo");
        let result = stdio_rpc(
            &mut conn,
            "tools/call",
            Some(json!({ "name": "echo", "arguments": { "text": "hi" } })),
            true,
        )
        .unwrap();
        assert_eq!(call_outcome_from(&result).text, "echo: hi");
    }
}
