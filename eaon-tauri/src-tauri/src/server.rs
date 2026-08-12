// Eaon's Local API Server — the cross-platform port of the macOS
// LocalAPIServer. Turns this machine into an OpenAI-compatible endpoint any
// script/CLI/other app can point at (GET /v1/models, POST
// /v1/chat/completions), transparently proxying to whichever provider serves
// the requested model (Ollama / Eaon hosted / BYOK) using the keys the user
// already configured — so the caller never handles those keys itself.
//
// SECURITY (identical model to the hardened macOS server):
//   - Binds the loopback interface ONLY — never reachable off the machine.
//   - Anti-DNS-rebinding: the Host header must be loopback, and any browser
//     Origin is rejected outright (a real CLI never sends one). Together these
//     kill the "malicious web page reaches 127.0.0.1 and drains your keys"
//     attack that the loopback bind alone does not stop.
//   - Bearer auth on by default, compared in constant time.
//   - No `Access-Control-Allow-Origin` (browsers can't read responses), plus
//     `X-Content-Type-Options: nosniff`.
// The security-critical helpers are unit-tested below.

use serde::Deserialize;
use std::sync::{Arc, Mutex, RwLock};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpListener;

/// One upstream the server can route to — a set of model ids and the endpoint
/// (+ optional key) that serves them. Passed from the frontend at start.
#[derive(Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct Upstream {
    pub model_ids: Vec<String>,
    pub base_url: String,
    pub api_key: Option<String>,
}

#[derive(Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct LocalServerConfig {
    pub port: u16,
    pub require_api_key: bool,
    pub api_key: String,
    pub upstreams: Vec<Upstream>,
}

struct RunningServer {
    handle: tauri::async_runtime::JoinHandle<()>,
}

static CONFIG: RwLock<Option<Arc<LocalServerConfig>>> = RwLock::new(None);
static RUNNING: Mutex<Option<RunningServer>> = Mutex::new(None);

fn current_config() -> Option<Arc<LocalServerConfig>> {
    CONFIG.read().ok().and_then(|g| g.clone())
}

// MARK: - Security helpers (unit-tested)

/// Length-independent, byte-for-byte compare so the auth check can't be
/// narrowed by a timing side channel.
fn constant_time_eq(a: &str, b: &str) -> bool {
    let (a, b) = (a.as_bytes(), b.as_bytes());
    let mut diff = a.len() ^ b.len();
    for i in 0..a.len().max(b.len()) {
        let x = *a.get(i).unwrap_or(&0);
        let y = *b.get(i).unwrap_or(&0);
        diff |= (x ^ y) as usize;
    }
    diff == 0
}

/// The bare hostname out of a `host:port` authority — handling bracketed
/// IPv6 (`[::1]:1234` → `::1`) as well as `name:port` and a bare name.
fn hostname_of(authority: &str) -> String {
    if let Some(rest) = authority.strip_prefix('[') {
        // IPv6: everything up to the closing bracket.
        rest.split(']').next().unwrap_or(rest).to_ascii_lowercase()
    } else {
        authority.split(':').next().unwrap_or(authority).to_ascii_lowercase()
    }
}

fn is_loopback_name(name: &str) -> bool {
    name == "127.0.0.1" || name == "localhost" || name == "::1"
}

/// Only loopback hostnames pass — the anti-rebinding gate. A missing Host
/// (raw-socket tools, not browsers) is allowed; any real non-loopback
/// hostname is refused.
fn host_is_loopback(host: Option<&str>) -> bool {
    let Some(host) = host else { return true };
    if host.is_empty() {
        return true;
    }
    is_loopback_name(&hostname_of(host))
}

/// A loopback Origin is fine; any real web origin is not.
fn origin_is_loopback(origin: &str) -> bool {
    let after_scheme = origin.splitn(2, "://").nth(1).unwrap_or(origin);
    let authority = after_scheme.split('/').next().unwrap_or(after_scheme);
    is_loopback_name(&hostname_of(authority))
}

// MARK: - Tiny HTTP request parse

pub(crate) struct ParsedRequest {
    pub(crate) method: String,
    pub(crate) path: String,
    pub(crate) headers: Vec<(String, String)>,
    pub(crate) body: Vec<u8>,
}

impl ParsedRequest {
    fn header(&self, name: &str) -> Option<&str> {
        let lower = name.to_ascii_lowercase();
        self.headers.iter().find(|(k, _)| *k == lower).map(|(_, v)| v.as_str())
    }
}

const MAX_BODY: usize = 8 * 1024 * 1024;
/// Headers get their own, far smaller ceiling than the body. Sharing the 8 MB
/// body cap meant a peer could stream 8 MB without ever sending the
/// end-of-headers marker — and because the marker search rescans the whole
/// buffer each pass, that degraded quadratically while it did. No legitimate
/// client sends 64 KB of headers.
const MAX_HEADERS: usize = 64 * 1024;
/// Wall clock for reading one whole request. Without it a peer that connects
/// and then sends nothing (or dribbles a byte at a time) pins a task forever;
/// enough of those and the accept loop is the only thing still working.
/// Loopback-only means the attacker is already a local process, but "local
/// process" includes anything the user ran by accident.
const READ_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(20);

pub(crate) async fn read_request(stream: &mut tokio::net::TcpStream) -> Option<ParsedRequest> {
    let mut buf: Vec<u8> = Vec::with_capacity(2048);
    let mut chunk = [0u8; 4096];
    // Read until end of headers.
    let header_end = loop {
        if let Some(pos) = find_subsequence(&buf, b"\r\n\r\n") {
            break pos + 4;
        }
        if buf.len() > MAX_HEADERS {
            return None;
        }
        let n = stream.read(&mut chunk).await.ok()?;
        if n == 0 {
            return None;
        }
        buf.extend_from_slice(&chunk[..n]);
    };

    let head = String::from_utf8_lossy(&buf[..header_end]).to_string();
    let mut lines = head.split("\r\n");
    let request_line = lines.next()?;
    let mut parts = request_line.split_whitespace();
    let method = parts.next()?.to_string();
    let path = parts.next()?.to_string();

    let mut headers = Vec::new();
    let mut content_length = 0usize;
    for line in lines {
        if line.is_empty() {
            continue;
        }
        if let Some((k, v)) = line.split_once(':') {
            let key = k.trim().to_ascii_lowercase();
            let val = v.trim().to_string();
            if key == "content-length" {
                content_length = val.parse().unwrap_or(0);
            }
            headers.push((key, val));
        }
    }

    let mut body = buf[header_end..].to_vec();
    while body.len() < content_length {
        if body.len() > MAX_BODY {
            break;
        }
        let n = stream.read(&mut chunk).await.ok()?;
        if n == 0 {
            break;
        }
        body.extend_from_slice(&chunk[..n]);
    }

    Some(ParsedRequest { method, path, headers, body })
}

pub(crate) fn find_subsequence(haystack: &[u8], needle: &[u8]) -> Option<usize> {
    haystack.windows(needle.len()).position(|w| w == needle)
}

// MARK: - Responses

const SECURITY_HEADERS: &str = "X-Content-Type-Options: nosniff\r\n";

pub(crate) async fn write_simple(stream: &mut tokio::net::TcpStream, status: &str, content_type: &str, body: &str) {
    let response = format!(
        "HTTP/1.1 {status}\r\nContent-Type: {content_type}\r\nContent-Length: {}\r\nConnection: close\r\n{SECURITY_HEADERS}\r\n{body}",
        body.len()
    );
    let _ = stream.write_all(response.as_bytes()).await;
    let _ = stream.flush().await;
}

async fn write_error(stream: &mut tokio::net::TcpStream, status: &str, message: &str) {
    let body = serde_json::json!({ "error": { "message": message, "type": "invalid_request_error" } });
    write_simple(stream, status, "application/json", &body.to_string()).await;
}

// MARK: - Routing

async fn handle_connection(mut stream: tokio::net::TcpStream) {
    let Ok(Some(req)) = tokio::time::timeout(READ_TIMEOUT, read_request(&mut stream)).await else {
        return;
    };
    let Some(config) = current_config() else {
        write_error(&mut stream, "503 Service Unavailable", "server not configured").await;
        return;
    };

    // Anti-rebinding gate — before anything else.
    if !host_is_loopback(req.header("host")) {
        write_error(&mut stream, "403 Forbidden", "Invalid Host header — loopback requests only.").await;
        return;
    }
    if let Some(origin) = req.header("origin") {
        if !origin.is_empty() && !origin_is_loopback(origin) {
            write_error(&mut stream, "403 Forbidden", "Cross-origin requests are not allowed. Call from a script or CLI, not a web page.").await;
            return;
        }
    }

    if req.method == "OPTIONS" {
        write_simple(&mut stream, "204 No Content", "text/plain", "").await;
        return;
    }

    let path = req.path.split('?').next().unwrap_or(&req.path);

    // GET / stays reachable even with an API key configured, same as any
    // service's unauthenticated health check — a tool probing whether
    // something is listening on this port before it has (or needs) a key
    // shouldn't have to authenticate just to find out. The rebinding gates
    // above still guard it.
    if req.method == "GET" && path == "/" {
        handle_discovery(&mut stream).await;
        return;
    }

    if config.require_api_key {
        let expected = format!("Bearer {}", config.api_key);
        let provided = req.header("authorization").unwrap_or("");
        if !constant_time_eq(provided, &expected) {
            write_error(&mut stream, "401 Unauthorized", "Missing or incorrect Authorization header.").await;
            return;
        }
    }

    match (req.method.as_str(), path) {
        ("GET", "/v1/models") => handle_models(&mut stream, &config).await,
        ("POST", "/v1/chat/completions") => handle_chat(&mut stream, &config, &req).await,
        _ => write_error(&mut stream, "404 Not Found", "No such endpoint. Serves GET /v1/models and POST /v1/chat/completions.").await,
    }
}

/// GET / (discovery/health-check) — what a script or a tool's "test
/// connection" button sees before it commits to using this server: enough to
/// confirm "this is Eaon, and here's what it speaks" without requiring the
/// caller to already know the two real routes.
async fn handle_discovery(stream: &mut tokio::net::TcpStream) {
    let body = serde_json::json!({
        "name": "Eaon Local API Server",
        "openai_compatible": true,
        "endpoints": ["GET /v1/models", "POST /v1/chat/completions"],
    });
    write_simple(stream, "200 OK", "application/json", &body.to_string()).await;
}

async fn handle_models(stream: &mut tokio::net::TcpStream, config: &LocalServerConfig) {
    let data: Vec<serde_json::Value> = config
        .upstreams
        .iter()
        .flat_map(|u| u.model_ids.iter())
        .map(|id| serde_json::json!({ "id": id, "object": "model", "owned_by": "eaon" }))
        .collect();
    let body = serde_json::json!({ "object": "list", "data": data });
    write_simple(stream, "200 OK", "application/json", &body.to_string()).await;
}

async fn handle_chat(stream: &mut tokio::net::TcpStream, config: &LocalServerConfig, req: &ParsedRequest) {
    let Ok(json) = serde_json::from_slice::<serde_json::Value>(&req.body) else {
        write_error(stream, "400 Bad Request", "Body must be JSON with a \"model\" and \"messages\".").await;
        return;
    };
    let Some(model) = json.get("model").and_then(|v| v.as_str()) else {
        write_error(stream, "400 Bad Request", "Missing \"model\".").await;
        return;
    };
    let Some(upstream) = config.upstreams.iter().find(|u| u.model_ids.iter().any(|m| m == model)) else {
        write_error(stream, "404 Not Found", &format!("No configured provider serves model \"{model}\".")).await;
        return;
    };

    // Transparent proxy: forward the caller's exact body to the upstream's
    // /chat/completions with the upstream's own key, then stream the response
    // bytes straight back (close-delimited, so it works for both streamed SSE
    // and a single JSON body without re-parsing either). Shared client
    // factory so the user's proxy setting applies here too; no timeout —
    // a streamed completion legitimately runs for minutes.
    let url = format!("{}/chat/completions", upstream.base_url.trim_end_matches('/'));
    let client = crate::net::http_client(None);
    let mut builder = client.post(&url).header("content-type", "application/json").body(req.body.clone());
    if let Some(key) = upstream.api_key.as_ref().filter(|k| !k.is_empty()) {
        builder = builder.bearer_auth(key);
    }

    let response = match builder.send().await {
        Ok(r) => r,
        Err(e) => {
            write_error(stream, "502 Bad Gateway", &format!("Couldn't reach the upstream provider: {e}")).await;
            return;
        }
    };

    let status = response.status();
    let content_type = response
        .headers()
        .get("content-type")
        .and_then(|v| v.to_str().ok())
        .unwrap_or("application/json")
        .to_string();

    let head = format!(
        "HTTP/1.1 {} {}\r\nContent-Type: {content_type}\r\nCache-Control: no-cache\r\nConnection: close\r\n{SECURITY_HEADERS}\r\n",
        status.as_u16(),
        status.canonical_reason().unwrap_or("OK"),
    );
    if stream.write_all(head.as_bytes()).await.is_err() {
        return;
    }

    let mut body_stream = response.bytes_stream();
    use futures_util::StreamExt;
    while let Some(chunk) = body_stream.next().await {
        match chunk {
            Ok(bytes) => {
                if stream.write_all(&bytes).await.is_err() {
                    return;
                }
                let _ = stream.flush().await;
            }
            Err(_) => break,
        }
    }
    let _ = stream.flush().await;
}

// MARK: - Commands

/// Abort the accept-loop task — the shutdown mechanism. Aborting drops the
/// listener, freeing the port immediately; connections already accepted run
/// on their own tasks and drain naturally, so stopping never cuts off an
/// in-flight response.
fn halt() {
    if let Ok(mut guard) = RUNNING.lock() {
        if let Some(server) = guard.take() {
            server.handle.abort();
        }
    }
}

#[tauri::command]
pub async fn start_local_server(config: LocalServerConfig) -> Result<(), String> {
    halt();
    let port = config.port;
    *CONFIG.write().map_err(|_| "config lock poisoned")? = Some(Arc::new(config));

    // Bind synchronously so a port-in-use error is reported to the caller
    // immediately, before we claim the server is running. 127.0.0.1, never
    // 0.0.0.0 — the loopback-only bind is the first security layer.
    let listener = std::net::TcpListener::bind(("127.0.0.1", port))
        .map_err(|e| format!("Couldn't start a server on port {port} — it may already be in use. ({e})"))?;
    listener
        .set_nonblocking(true)
        .map_err(|e| format!("Couldn't configure the listener: {e}"))?;

    let handle = tauri::async_runtime::spawn(async move {
        let Ok(listener) = TcpListener::from_std(listener) else { return };
        loop {
            match listener.accept().await {
                Ok((stream, _addr)) => {
                    tauri::async_runtime::spawn(handle_connection(stream));
                }
                Err(_) => break,
            }
        }
    });

    *RUNNING.lock().map_err(|_| "running lock poisoned")? = Some(RunningServer { handle });
    Ok(())
}

#[tauri::command]
pub async fn stop_local_server() -> Result<(), String> {
    halt();
    Ok(())
}

#[tauri::command]
pub fn local_server_running() -> bool {
    RUNNING.lock().map(|g| g.is_some()).unwrap_or(false)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn constant_time_eq_matches_and_rejects() {
        assert!(constant_time_eq("Bearer abc123", "Bearer abc123"));
        assert!(!constant_time_eq("Bearer abc123", "Bearer abc124"));
        assert!(!constant_time_eq("short", "a much longer string"));
        assert!(!constant_time_eq("", "x"));
        assert!(constant_time_eq("", ""));
    }

    #[test]
    fn host_gate_blocks_rebinding() {
        assert!(host_is_loopback(Some("127.0.0.1:1234")));
        assert!(host_is_loopback(Some("localhost:1234")));
        assert!(host_is_loopback(Some("[::1]:1234")));
        assert!(host_is_loopback(None)); // raw socket tools
        // The DNS-rebinding attack arrives with the attacker's hostname:
        assert!(!host_is_loopback(Some("evil.com")));
        assert!(!host_is_loopback(Some("attacker.example:1234")));
    }

    #[test]
    fn origin_gate_blocks_browsers() {
        assert!(origin_is_loopback("http://127.0.0.1:3000"));
        assert!(origin_is_loopback("http://localhost"));
        // A real web page's origin must be refused:
        assert!(!origin_is_loopback("https://evil.com"));
        assert!(!origin_is_loopback("https://app.example.com:8443"));
    }

    #[test]
    fn header_lookup_is_case_insensitive() {
        let req = ParsedRequest {
            method: "GET".into(),
            path: "/v1/models".into(),
            headers: vec![("authorization".into(), "Bearer k".into())],
            body: vec![],
        };
        assert_eq!(req.header("Authorization"), Some("Bearer k"));
        assert_eq!(req.header("AUTHORIZATION"), Some("Bearer k"));
        assert_eq!(req.header("missing"), None);
    }

    /// End-to-end over a REAL socket: bind the server's own accept loop, then
    /// hit it with an HTTP client and assert every security gate, discovery,
    /// the models endpoint, AND the chat proxy behave — the full read_request
    /// → route → auth → write/proxy path, not just the helpers. One test (not
    /// two) so the two halves don't race on the shared global CONFIG the way
    /// two parallel #[tokio::test]s would (production has one global server).
    #[tokio::test]
    async fn server_end_to_end() {
        *CONFIG.write().unwrap() = Some(Arc::new(LocalServerConfig {
            port: 0,
            require_api_key: true,
            api_key: "secret-key-123".into(),
            upstreams: vec![Upstream {
                model_ids: vec!["test-model".into()],
                base_url: "http://127.0.0.1:9".into(), // unused for /v1/models
                api_key: None,
            }],
        }));

        let listener = TcpListener::bind(("127.0.0.1", 0u16)).await.unwrap();
        let port = listener.local_addr().unwrap().port();
        tokio::spawn(async move {
            loop {
                if let Ok((stream, _)) = listener.accept().await {
                    tokio::spawn(handle_connection(stream));
                }
            }
        });

        let base = format!("http://127.0.0.1:{port}");
        let client = reqwest::Client::new();

        // No auth → 401
        let r = client.get(format!("{base}/v1/models")).send().await.unwrap();
        assert_eq!(r.status(), 401, "no-auth must be rejected");

        // Wrong key → 401
        let r = client.get(format!("{base}/v1/models")).bearer_auth("nope").send().await.unwrap();
        assert_eq!(r.status(), 401, "wrong key must be rejected");

        // Spoofed Host (DNS-rebinding) → 403 even with the right key
        let r = client
            .get(format!("{base}/v1/models"))
            .header("host", "evil.com")
            .bearer_auth("secret-key-123")
            .send()
            .await
            .unwrap();
        assert_eq!(r.status(), 403, "rebinding host must be blocked");

        // Browser Origin → 403
        let r = client
            .get(format!("{base}/v1/models"))
            .header("origin", "https://evil.com")
            .bearer_auth("secret-key-123")
            .send()
            .await
            .unwrap();
        assert_eq!(r.status(), 403, "browser origin must be blocked");

        // Discovery: GET / must answer WITHOUT auth (it's the probe a tool
        // sends before it has a key) — but the rebinding gates still apply.
        let r = client.get(format!("{base}/")).send().await.unwrap();
        assert_eq!(r.status(), 200, "discovery must not require auth");
        let v: serde_json::Value = r.json().await.unwrap();
        assert_eq!(v["name"], "Eaon Local API Server");
        assert_eq!(v["openai_compatible"], true);
        assert!(v["endpoints"].as_array().is_some_and(|e| !e.is_empty()));
        let r = client.get(format!("{base}/")).header("host", "evil.com").send().await.unwrap();
        assert_eq!(r.status(), 403, "discovery still sits behind the rebinding gate");

        // Correct key, loopback host, no origin → 200 with the model listed,
        // and no wildcard CORS header leaked.
        let r = client.get(format!("{base}/v1/models")).bearer_auth("secret-key-123").send().await.unwrap();
        assert_eq!(r.status(), 200, "legit CLI request must succeed");
        assert!(r.headers().get("access-control-allow-origin").is_none(), "must not send wildcard CORS");
        let body = r.text().await.unwrap();
        assert!(body.contains("test-model"), "models list must include the configured model: {body}");

        // ---- Part 2: the transparent chat proxy ----
        // Mock upstream: replies to any request with a canned SSE body.
        let upstream = TcpListener::bind(("127.0.0.1", 0u16)).await.unwrap();
        let upstream_port = upstream.local_addr().unwrap().port();
        tokio::spawn(async move {
            if let Ok((mut s, _)) = upstream.accept().await {
                let mut buf = [0u8; 4096];
                let _ = s.read(&mut buf).await; // read+discard the request
                let sse = "data: {\"choices\":[{\"delta\":{\"content\":\"proxied-hi\"}}]}\n\ndata: [DONE]\n\n";
                let resp = format!(
                    "HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{sse}",
                    sse.len()
                );
                let _ = s.write_all(resp.as_bytes()).await;
                let _ = s.flush().await;
            }
        });

        *CONFIG.write().unwrap() = Some(Arc::new(LocalServerConfig {
            port: 0,
            require_api_key: false, // focus this test on the proxy path
            api_key: String::new(),
            upstreams: vec![Upstream {
                model_ids: vec!["test-model".into()],
                base_url: format!("http://127.0.0.1:{upstream_port}"),
                api_key: None,
            }],
        }));

        let server = TcpListener::bind(("127.0.0.1", 0u16)).await.unwrap();
        let port = server.local_addr().unwrap().port();
        tokio::spawn(async move {
            if let Ok((stream, _)) = server.accept().await {
                tokio::spawn(handle_connection(stream));
            }
        });

        let client = reqwest::Client::new();
        let r = client
            .post(format!("http://127.0.0.1:{port}/v1/chat/completions"))
            .json(&serde_json::json!({ "model": "test-model", "messages": [{"role":"user","content":"hi"}], "stream": true }))
            .send()
            .await
            .unwrap();
        assert_eq!(r.status(), 200);
        let body = r.text().await.unwrap();
        assert!(body.contains("proxied-hi"), "upstream body must be proxied back to the caller: {body}");

        // An unknown model must 404, not silently hang.
        *CONFIG.write().unwrap() = Some(Arc::new(LocalServerConfig {
            port: 0, require_api_key: false, api_key: String::new(),
            upstreams: vec![Upstream { model_ids: vec!["known".into()], base_url: "http://127.0.0.1:9".into(), api_key: None }],
        }));
        let server2 = TcpListener::bind(("127.0.0.1", 0u16)).await.unwrap();
        let port2 = server2.local_addr().unwrap().port();
        tokio::spawn(async move {
            if let Ok((stream, _)) = server2.accept().await { tokio::spawn(handle_connection(stream)); }
        });
        let r2 = client
            .post(format!("http://127.0.0.1:{port2}/v1/chat/completions"))
            .json(&serde_json::json!({ "model": "nonexistent", "messages": [] }))
            .send().await.unwrap();
        assert_eq!(r2.status(), 404, "unknown model must 404");
    }
}
