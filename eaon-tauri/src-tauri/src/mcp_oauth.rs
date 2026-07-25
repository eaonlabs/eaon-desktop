// OAuth 2.1 for MCP plugins — the cross-platform port of the Mac app's
// MCPOAuth.swift. Implements the MCP authorization spec (2025-06-18):
// discovery via RFC 9728 (Protected Resource Metadata) + RFC 8414
// (Authorization Server Metadata), RFC 7591 Dynamic Client Registration,
// PKCE (RFC 7636, S256), and RFC 8707 Resource Indicators. Not hardcoded to
// any one vendor — any MCP server implementing the spec works the same way.
//
// No dedicated randomness crate: PKCE verifiers and the CSRF `state` value
// are sourced from `uuid::Uuid::new_v4()` (already a dependency, backed by
// the OS CSPRNG via `getrandom`), the same way `trial.rs` already does for
// its device nonce.
//
// Redirect URI is a loopback HTTP listener, not a custom URL scheme — the
// spec's security section requires "localhost or HTTPS," and a scheme is
// neither. That also means no OS-level URI-scheme registration is needed.

use base64::Engine as _;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::time::Duration;
use tauri_plugin_opener::OpenerExt;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpListener;

use crate::mcp::{connect_http, McpToolInfo};

/// Fixed, not random. Dynamic Client Registration happens once per server
/// and its `redirect_uris` are reused for every future sign-in — but an
/// authorization server only accepts a `redirect_uri` that exactly matches
/// one registered at DCR time. A fresh random port per sign-in would
/// register one port and then listen on a different one next time, which is
/// exactly the bug this constant avoids. Distinct from the Mac app's own
/// port (51847) purely so the two could never collide if ever run under the
/// same loopback namespace; chosen from the private/ephemeral range.
const REDIRECT_PORT: u16 = 51849;
fn redirect_uri() -> String {
    format!("http://127.0.0.1:{REDIRECT_PORT}/callback")
}

struct ServerMetadata {
    authorization_endpoint: String,
    token_endpoint: String,
    registration_endpoint: Option<String>,
    /// The canonical resource URI (RFC 8707) — sent on every authorize/token
    /// request so the issued token is bound to this specific MCP server.
    resource: String,
}

#[derive(Serialize, Clone)]
pub struct McpOAuthClientCredentials {
    #[serde(rename = "clientId")]
    client_id: String,
    #[serde(rename = "clientSecret")]
    client_secret: Option<String>,
}

#[derive(Serialize, Clone)]
pub struct McpOAuthTokens {
    #[serde(rename = "accessToken")]
    access_token: String,
    #[serde(rename = "refreshToken")]
    refresh_token: Option<String>,
    /// Milliseconds since epoch, matching the frontend's Date.now() unit.
    #[serde(rename = "expiresAt")]
    expires_at: Option<f64>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct McpOAuthConnectArgs {
    pub server_id: String,
    pub endpoint: String,
    /// `true` only in direct response to the user clicking "Sign in" —
    /// opens the system browser. `false` (used at launch) only attempts a
    /// silent token reuse/refresh and never pops a browser window.
    pub interactive: bool,
    pub client_id: Option<String>,
    pub client_secret: Option<String>,
    pub access_token: Option<String>,
    pub refresh_token: Option<String>,
    pub expires_at: Option<f64>,
    /// Only consulted when the server (per live discovery) doesn't support
    /// Dynamic Client Registration.
    pub manual_client_id: Option<String>,
    /// Catalog `extraHeaders` for this server — forwarded to every MCP
    /// request once signed in, same as the pasted-token path.
    pub extra_headers: Option<std::collections::HashMap<String, String>>,
}

#[derive(Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum McpOAuthResult {
    Connected {
        credentials: McpOAuthClientCredentials,
        tokens: McpOAuthTokens,
        tools: Vec<McpToolInfo>,
    },
    /// Discovery succeeded but this server doesn't support Dynamic Client
    /// Registration, so there's no way to sign in without a client ID the
    /// user creates themselves first. Not an error — a real fork in the
    /// flow the UI offers a way forward for.
    NeedsManualClientId,
    /// `interactive: false` and nothing usable/refreshable was on hand —
    /// leave the row showing "Connect"/"Sign in" again, silently.
    NotConnected,
}

// ---------------------------------------------------------------------------
// Discovery
// ---------------------------------------------------------------------------

/// Step 1 of the spec's flow: an unauthenticated request to the MCP endpoint
/// returns 401 with a `WWW-Authenticate` header pointing at the
/// protected-resource-metadata document, which names the authorization
/// server, whose own metadata document has the real authorize/token/register
/// endpoints.
async fn discover(mcp_endpoint: &str) -> Result<ServerMetadata, String> {
    let client = crate::net::http_client(Some(15));
    let probe = client
        .post(mcp_endpoint)
        .header("Content-Type", "application/json")
        .header("Accept", "application/json, text/event-stream")
        .json(&serde_json::json!({ "jsonrpc": "2.0", "id": 1, "method": "initialize", "params": {} }))
        .send()
        .await
        .map_err(|e| format!("Couldn't reach {mcp_endpoint}: {e}"))?;

    if probe.status().as_u16() != 401 {
        return Err("This server didn't advertise an OAuth discovery document.".to_string());
    }
    let www_authenticate = probe
        .headers()
        .get("www-authenticate")
        .and_then(|v| v.to_str().ok())
        .ok_or("This server didn't advertise an OAuth discovery document.")?
        .to_string();
    let resource_metadata_url = extract_resource_metadata_url(&www_authenticate)
        .ok_or("This server didn't advertise an OAuth discovery document.")?;

    let resource_metadata = fetch_json(&client, &resource_metadata_url).await?;
    let auth_server_base = resource_metadata["authorization_servers"]
        .as_array()
        .and_then(|arr| arr.first())
        .and_then(|v| v.as_str())
        .ok_or("No authorization server was listed.")?;
    let resource = resource_metadata["resource"]
        .as_str()
        .unwrap_or(mcp_endpoint)
        .to_string();

    let as_metadata_url = well_known_auth_server_metadata_url(auth_server_base)?;
    let as_metadata = fetch_json(&client, &as_metadata_url).await?;
    let authorization_endpoint = as_metadata["authorization_endpoint"]
        .as_str()
        .ok_or("The authorization server's metadata was missing required endpoints.")?
        .to_string();
    let token_endpoint = as_metadata["token_endpoint"]
        .as_str()
        .ok_or("The authorization server's metadata was missing required endpoints.")?
        .to_string();
    let registration_endpoint = as_metadata["registration_endpoint"].as_str().map(str::to_string);

    Ok(ServerMetadata { authorization_endpoint, token_endpoint, registration_endpoint, resource })
}

/// RFC 8414 §3.1: the well-known suffix is inserted right after the host,
/// with the issuer's own path (if any) appended AFTER it —
/// `https://host/.well-known/oauth-authorization-server/issuer/path`, NOT
/// `https://host/issuer/path/.well-known/oauth-authorization-server`. A
/// naive path-join (the second, wrong form) 404s for any issuer whose URL
/// has a path component.
fn well_known_auth_server_metadata_url(issuer: &str) -> Result<String, String> {
    let url = reqwest::Url::parse(issuer).map_err(|_| "The authorization server URL was malformed.".to_string())?;
    let mut base = format!(
        "{}://{}",
        url.scheme(),
        url.host_str().ok_or("The authorization server URL was malformed.")?
    );
    if let Some(port) = url.port() {
        base.push_str(&format!(":{port}"));
    }
    base.push_str("/.well-known/oauth-authorization-server");
    base.push_str(url.path().trim_end_matches('/'));
    Ok(base)
}

fn extract_resource_metadata_url(www_authenticate: &str) -> Option<String> {
    let marker = "resource_metadata=\"";
    let start = www_authenticate.find(marker)? + marker.len();
    let rest = &www_authenticate[start..];
    let end = rest.find('"')?;
    Some(rest[..end].to_string())
}

async fn fetch_json(client: &reqwest::Client, url: &str) -> Result<Value, String> {
    let response = client.get(url).send().await.map_err(|e| format!("{url} didn't respond: {e}"))?;
    if !response.status().is_success() {
        return Err(format!("{url} didn't return valid metadata."));
    }
    response.json::<Value>().await.map_err(|_| format!("{url} didn't return valid metadata."))
}

// ---------------------------------------------------------------------------
// Dynamic Client Registration (RFC 7591)
// ---------------------------------------------------------------------------

async fn register(metadata: &ServerMetadata) -> Result<McpOAuthClientCredentials, String> {
    let endpoint = metadata
        .registration_endpoint
        .as_ref()
        .ok_or("This server requires a pre-registered client, which Eaon doesn't have for it yet.")?;
    let client = crate::net::http_client(Some(15));
    let response = client
        .post(endpoint)
        .header("Content-Type", "application/json")
        .json(&serde_json::json!({
            "client_name": "Eaon",
            "redirect_uris": [redirect_uri()],
            "grant_types": ["authorization_code", "refresh_token"],
            "response_types": ["code"],
            "token_endpoint_auth_method": "none",
        }))
        .send()
        .await
        .map_err(|e| format!("Couldn't register with this service: {e}"))?;

    if !response.status().is_success() {
        let body = response.text().await.unwrap_or_default();
        return Err(format!("Couldn't register with this service: {body}"));
    }
    let json: Value = response.json().await.map_err(|e| format!("Couldn't register with this service: {e}"))?;
    let client_id = json["client_id"]
        .as_str()
        .ok_or("Couldn't register with this service: no client id was returned.")?
        .to_string();
    Ok(McpOAuthClientCredentials { client_id, client_secret: json["client_secret"].as_str().map(str::to_string) })
}

// ---------------------------------------------------------------------------
// PKCE (RFC 7636) — S256 only, matching the Mac client
// ---------------------------------------------------------------------------

fn base64_url(bytes: &[u8]) -> String {
    base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(bytes)
}

/// 32 random bytes (two UUIDv4s' worth) — well past RFC 7636's 43-character
/// minimum once base64url-encoded.
fn random_token(uuid_count: usize) -> String {
    let mut bytes = Vec::with_capacity(uuid_count * 16);
    for _ in 0..uuid_count {
        bytes.extend_from_slice(uuid::Uuid::new_v4().as_bytes());
    }
    base64_url(&bytes)
}

fn generate_pkce() -> (String, String) {
    let verifier = random_token(2);
    let challenge = base64_url(&Sha256::digest(verifier.as_bytes()));
    (verifier, challenge)
}

fn generate_state() -> String {
    random_token(1)
}

fn authorization_url(metadata: &ServerMetadata, client_id: &str, challenge: &str, state: &str) -> String {
    let mut url = reqwest::Url::parse(&metadata.authorization_endpoint).expect("validated during discovery");
    url.query_pairs_mut()
        .append_pair("response_type", "code")
        .append_pair("client_id", client_id)
        .append_pair("redirect_uri", &redirect_uri())
        .append_pair("code_challenge", challenge)
        .append_pair("code_challenge_method", "S256")
        .append_pair("state", state)
        .append_pair("resource", &metadata.resource);
    url.to_string()
}

// ---------------------------------------------------------------------------
// Token exchange / refresh
// ---------------------------------------------------------------------------

async fn token_request(endpoint: &str, resource: &str, mut form: Vec<(&str, String)>) -> Result<McpOAuthTokens, String> {
    form.push(("resource", resource.to_string()));
    let client = crate::net::http_client(Some(15));
    let response = client
        .post(endpoint)
        .header("Content-Type", "application/x-www-form-urlencoded")
        .form(&form)
        .send()
        .await
        .map_err(|e| format!("Sign-in succeeded but exchanging the code for a token failed: {e}"))?;

    if !response.status().is_success() {
        let body = response.text().await.unwrap_or_default();
        return Err(format!("Sign-in succeeded but exchanging the code for a token failed: {body}"));
    }
    let json: Value = response
        .json()
        .await
        .map_err(|e| format!("Sign-in succeeded but exchanging the code for a token failed: {e}"))?;
    let access_token = json["access_token"]
        .as_str()
        .ok_or("Sign-in succeeded but exchanging the code for a token failed: no access token was returned.")?
        .to_string();
    let expires_at = json["expires_in"].as_f64().map(|secs| now_ms() + secs * 1000.0);
    Ok(McpOAuthTokens { access_token, refresh_token: json["refresh_token"].as_str().map(str::to_string), expires_at })
}

async fn exchange_code(metadata: &ServerMetadata, client_id: &str, code: &str, verifier: &str) -> Result<McpOAuthTokens, String> {
    token_request(
        &metadata.token_endpoint,
        &metadata.resource,
        vec![
            ("grant_type", "authorization_code".to_string()),
            ("code", code.to_string()),
            ("redirect_uri", redirect_uri()),
            ("client_id", client_id.to_string()),
            ("code_verifier", verifier.to_string()),
        ],
    )
    .await
}

async fn refresh(metadata: &ServerMetadata, client_id: &str, refresh_token: &str) -> Result<McpOAuthTokens, String> {
    token_request(
        &metadata.token_endpoint,
        &metadata.resource,
        vec![
            ("grant_type", "refresh_token".to_string()),
            ("refresh_token", refresh_token.to_string()),
            ("client_id", client_id.to_string()),
        ],
    )
    .await
}

/// `f64` milliseconds since epoch — Rust has no infallible way to ask for
/// "now" without `std::time`, and this crate's workflow-script constraints
/// (no `Date.now()`) are a JS-side rule only, not a Rust one; this is a
/// plain runtime clock read, not something that needs to be replayable.
fn now_ms() -> f64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as f64
}

// ---------------------------------------------------------------------------
// Loopback redirect listener
// ---------------------------------------------------------------------------

/// Listens on `REDIRECT_PORT` for exactly one incoming request — the
/// authorization server's redirect after the user approves (or denies) —
/// reads its query string, and closes. The real security boundary is the
/// `state` parameter checked here (OAuth's own native-app guidance relies on
/// exactly this pattern): a request without the correct high-entropy state
/// is rejected regardless of who sent it.
async fn await_redirect(expected_state: &str, timeout: Duration) -> Result<String, String> {
    let listener = TcpListener::bind(("127.0.0.1", REDIRECT_PORT))
        .await
        .map_err(|e| format!("Couldn't listen for the sign-in redirect: {e}"))?;

    tokio::time::timeout(timeout, async {
        loop {
            let (mut stream, _) = listener.accept().await.map_err(|e| e.to_string())?;
            let mut buf = [0u8; 8192];
            let n = match stream.read(&mut buf).await {
                Ok(n) => n,
                Err(_) => continue,
            };
            let text = String::from_utf8_lossy(&buf[..n]);
            let Some(request_line) = text.lines().next() else { continue };
            let Some(path) = request_line.split(' ').nth(1) else { continue };
            let Ok(url) = reqwest::Url::parse(&format!("http://127.0.0.1{path}")) else { continue };
            let query: std::collections::HashMap<String, String> = url.query_pairs().into_owned().collect();

            let _ = stream.write_all(CALLBACK_RESPONSE.as_bytes()).await;
            let _ = stream.shutdown().await;

            if let Some(error) = query.get("error") {
                return Err(format!("Sign-in failed: {error}"));
            }
            match (query.get("state"), query.get("code")) {
                (Some(state), Some(code)) if state == expected_state => return Ok(code.clone()),
                (Some(_), _) => return Err("The sign-in response didn't match what was requested — try again.".to_string()),
                _ => return Err("Sign-in was cancelled or denied.".to_string()),
            }
        }
    })
    .await
    .map_err(|_| "Sign-in timed out waiting for the browser. Try again.".to_string())?
}

const CALLBACK_RESPONSE: &str = "HTTP/1.1 200 OK\r\nContent-Type: text/html; charset=utf-8\r\nConnection: close\r\n\r\n<html><body style=\"font-family:-apple-system,sans-serif;text-align:center;padding-top:4em;color:#888;background:#111\">You can close this tab and go back to Eaon.</body></html>";

// ---------------------------------------------------------------------------
// Command
// ---------------------------------------------------------------------------

/// Full OAuth lifecycle for one MCP server — the cross-platform port of the
/// Mac app's `MCPConnectionStore.connectOAuth`. The frontend owns
/// persistence (this command is stateless per-call, matching every other
/// Rust command here): it passes in whatever credentials/tokens it has on
/// file, and gets back fresh ones to save whenever the state changes.
#[tauri::command]
pub async fn mcp_oauth_connect(app: tauri::AppHandle, args: McpOAuthConnectArgs) -> Result<McpOAuthResult, String> {
    let metadata = discover(&args.endpoint).await?;
    let extra_headers: Vec<(String, String)> =
        args.extra_headers.clone().unwrap_or_default().into_iter().collect();

    // A still-valid access token: use it as-is (60s safety margin).
    if let (Some(access_token), Some(client_id)) = (args.access_token.clone(), args.client_id.clone()) {
        let still_valid = args.expires_at.map(|exp| exp > now_ms() + 60_000.0).unwrap_or(true);
        if still_valid {
            let tools = connect_http(&args.server_id, args.endpoint.clone(), Some(("Bearer".to_string(), access_token.clone())), extra_headers.clone()).await?;
            return Ok(McpOAuthResult::Connected {
                credentials: McpOAuthClientCredentials { client_id, client_secret: args.client_secret.clone() },
                tokens: McpOAuthTokens { access_token, refresh_token: args.refresh_token.clone(), expires_at: args.expires_at },
                tools,
            });
        }
    }

    // Expired but refreshable — silent either way, no browser needed.
    if let (Some(refresh_token), Some(client_id)) = (args.refresh_token.clone(), args.client_id.clone()) {
        let refreshed = refresh(&metadata, &client_id, &refresh_token).await;
        if let Ok(refreshed) = refreshed {
            let tools = connect_http(&args.server_id, args.endpoint.clone(), Some(("Bearer".to_string(), refreshed.access_token.clone())), extra_headers.clone()).await?;
            return Ok(McpOAuthResult::Connected {
                credentials: McpOAuthClientCredentials { client_id, client_secret: args.client_secret.clone() },
                tokens: refreshed,
                tools,
            });
        } else if !args.interactive {
            return Ok(McpOAuthResult::NotConnected);
        }
        // Refresh failed but the user explicitly asked to sign in — fall
        // through to a full interactive flow below.
    }

    if !args.interactive {
        return Ok(McpOAuthResult::NotConnected);
    }

    // DCR happens once per server and is cached by the frontend forever
    // after — re-registering on every sign-in would leave orphaned client
    // registrations on the server for no benefit.
    let credentials = if let Some(client_id) = args.client_id.clone() {
        McpOAuthClientCredentials { client_id, client_secret: args.client_secret.clone() }
    } else if metadata.registration_endpoint.is_some() {
        register(&metadata).await?
    } else if let Some(manual) = args.manual_client_id.as_ref().map(|s| s.trim()).filter(|s| !s.is_empty()) {
        McpOAuthClientCredentials { client_id: manual.to_string(), client_secret: None }
    } else {
        // No DCR and nothing supplied — a real fork in the flow, not a
        // failure, so the UI can offer the client-id field.
        return Ok(McpOAuthResult::NeedsManualClientId);
    };

    let (verifier, challenge) = generate_pkce();
    let state = generate_state();
    let auth_url = authorization_url(&metadata, &credentials.client_id, &challenge, &state);

    app.opener()
        .open_url(auth_url, None::<String>)
        .map_err(|e| format!("Couldn't open your browser: {e}"))?;

    let code = await_redirect(&state, Duration::from_secs(180)).await?;
    let tokens = exchange_code(&metadata, &credentials.client_id, &code, &verifier).await?;
    let tools = connect_http(&args.server_id, args.endpoint.clone(), Some(("Bearer".to_string(), tokens.access_token.clone())), extra_headers).await?;

    Ok(McpOAuthResult::Connected { credentials, tokens, tools })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn well_known_url_inserts_suffix_before_issuer_path_not_after() {
        // Confirmed the hard way on the Mac app: a naive path-join
        // (appending the suffix AFTER the issuer's path) 404s for any
        // issuer that actually has one — this is the form that works for
        // every real authorization server, path or no path.
        assert_eq!(
            well_known_auth_server_metadata_url("https://mcp.example.com").unwrap(),
            "https://mcp.example.com/.well-known/oauth-authorization-server"
        );
        assert_eq!(
            well_known_auth_server_metadata_url("https://mcp.example.com/issuer/path").unwrap(),
            "https://mcp.example.com/.well-known/oauth-authorization-server/issuer/path"
        );
    }

    #[test]
    fn resource_metadata_url_extracted_from_www_authenticate() {
        let header = r#"Bearer realm="OAuth", resource_metadata="https://mcp.example.com/.well-known/oauth-protected-resource", error="invalid_token""#;
        assert_eq!(
            extract_resource_metadata_url(header).as_deref(),
            Some("https://mcp.example.com/.well-known/oauth-protected-resource")
        );
        assert_eq!(extract_resource_metadata_url("Bearer realm=\"OAuth\""), None);
    }

    #[test]
    fn pkce_challenge_is_the_s256_hash_of_the_verifier() {
        let (verifier, challenge) = generate_pkce();
        assert!(verifier.len() >= 43);
        let expected = base64_url(&Sha256::digest(verifier.as_bytes()));
        assert_eq!(challenge, expected);
        // Two calls never reuse a verifier — a fresh CSPRNG draw each time.
        let (verifier2, _) = generate_pkce();
        assert_ne!(verifier, verifier2);
    }

    #[test]
    fn state_is_high_entropy_and_url_safe() {
        let state = generate_state();
        assert!(state.len() >= 20);
        assert!(state.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_'));
    }
}
