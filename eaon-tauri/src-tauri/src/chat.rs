// Chat — streaming and one-shot completions for every provider the app
// talks to. Three wire formats ship (ARCHITECTURE "Wire formats for BYOK"):
// OpenAI-compatible (local Ollama, the hosted Eaon gateway, most BYOK
// endpoints), Anthropic Messages, and Gemini streamGenerateContent. Tokens
// flow back over a Tauri `Channel`; the Free Week trial rides the hosted
// OpenAI path with HMAC-signed headers instead of a key.

/// The pure Anthropic/Gemini request-body builders — a child module (file
/// lives beside this one; lib.rs stays a plain command registry).
#[path = "chat_formats.rs"]
mod formats;

use crate::net;
use futures_util::StreamExt;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, LazyLock, Mutex};
use std::time::Duration;
use tauri::ipc::Channel;

// ---------------------------------------------------------------------------
// Cancellation
// ---------------------------------------------------------------------------

/// Live cancellation flags, keyed by the frontend-chosen request id. Set by
/// `cancel_stream`, checked between chunks by the SSE pump — dropping the
/// reqwest stream aborts the HTTP request, so the model server stops
/// generating too (Ollama honors disconnects).
static CANCEL_FLAGS: LazyLock<Mutex<HashMap<u64, Arc<AtomicBool>>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));

fn cancel_flag(id: u64) -> Arc<AtomicBool> {
    CANCEL_FLAGS
        .lock()
        .unwrap()
        .entry(id)
        .or_insert_with(|| Arc::new(AtomicBool::new(false)))
        .clone()
}

fn clear_cancel_flag(id: u64) {
    CANCEL_FLAGS.lock().unwrap().remove(&id);
}

/// Stop an in-flight `chat_stream` — the stop button. Real cancellation:
/// the streaming loop checks this flag per chunk and drops the connection.
#[tauri::command]
pub fn cancel_stream(request_id: u64) {
    cancel_flag(request_id).store(true, Ordering::Relaxed);
}

// ---------------------------------------------------------------------------
// Request / event shapes
// ---------------------------------------------------------------------------

#[derive(Deserialize)]
pub struct ChatMessagePayload {
    pub role: String,
    /// A plain string for text-only turns, or an OpenAI content-parts array
    /// (`[{type:"text",…},{type:"image_url",…}]`) for vision turns — passed
    /// to the wire verbatim on the OpenAI path and translated for
    /// Anthropic/Gemini, like the Mac app's `HistoryTurn.openAICompatibleJSON`.
    pub content: serde_json::Value,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatRequest {
    /// Provider root, e.g. `http://127.0.0.1:11434/v1` for local Ollama.
    /// The per-format path (`/chat/completions`, `/messages`, …) is appended.
    pub base_url: String,
    pub api_key: Option<String>,
    /// Free Week credentials — present only when the hosted gateway is used
    /// without a real key; those requests carry HMAC-signed headers instead.
    /// `trial_key` is the minted trial token itself — the gateway's very
    /// first gate (extractEaonApiKey) requires it as a Bearer credential
    /// before it will even attempt to verify the device/ts/sig headers, so
    /// all three fields must travel together.
    pub trial_device: Option<String>,
    pub trial_secret: Option<String>,
    pub trial_key: Option<String>,
    pub model: String,
    pub messages: Vec<ChatMessagePayload>,
    /// Frontend-chosen id used to target `cancel_stream`.
    pub request_id: u64,
    /// User-opted sampling fields (temperature, top_p, max_tokens, …) merged
    /// into the OpenAI body verbatim — absent fields are simply not sent,
    /// which is NOT the same as sending a neutral value (reasoning models
    /// reject temperature outright). Mirrors SamplingParameters.
    #[serde(default)]
    pub sampling: Option<serde_json::Map<String, serde_json::Value>>,
    /// Wire format: "openai" (default when absent), "anthropic", "gemini".
    #[serde(default)]
    pub format: Option<String>,
}

#[derive(Clone, Serialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum StreamEvent {
    Token { text: String },
    Reasoning { text: String },
    /// The previous attempt was cut off and is being re-requested from
    /// scratch — throw away everything received so far for this reply. See
    /// `STREAM_MAX_ATTEMPTS`.
    Restart,
    /// `truncated`: the byte stream ended without ever receiving the
    /// provider's real completion signal ([DONE] / message_stop) — the
    /// connection dropped, was closed by an intermediary, or otherwise
    /// ended mid-generation rather than the model actually finishing.
    /// Always false when `cancelled` is true (a deliberate stop, not a
    /// mystery drop) and always false for Gemini, which has no completion
    /// signal by protocol — the stream ending IS its done signal there.
    Done { cancelled: bool, truncated: bool },
    Error { message: String },
}

/// Total tries for one streamed reply, so two extra requests at most.
///
/// This is the actual fix for "the reply just stops partway, with no error."
/// A gateway (or any intermediary) closing an in-flight SSE response looks,
/// at the socket, exactly like the model finishing — which is why it used to
/// surface as a silently half-written answer. Detecting it only labelled the
/// damage; the reply is still gone. So it is re-requested from scratch, with
/// the abandoned partial discarded via `StreamEvent::Restart` — the model
/// re-answers the identical prompt and the user sees a brief re-type instead
/// of a dead reply.
///
/// Re-asking (rather than asking the model to continue from the partial) is
/// deliberate: continuation depends on assistant-prefill support most
/// OpenAI-compatible endpoints don't have, and getting it wrong duplicates
/// text. A clean re-ask can only cost tokens. Kept low because each attempt
/// is a real billed completion, and a provider that drops three streams in a
/// row has a problem no retry will paper over.
const STREAM_MAX_ATTEMPTS: u32 = 3;

/// 300ms, 600ms — long enough to miss the tail of a gateway blip, short
/// enough that a retried reply still feels immediate.
fn stream_retry_backoff(attempt: u32) -> Duration {
    Duration::from_millis((300u64 << (attempt - 1)).min(1200))
}

/// Whether an HTTP error body reads like the server rejecting a sampling
/// field — the cue to retry once without them rather than surfacing a broken
/// chat (mirrors SamplingParameters.looksLikeRejection).
fn looks_like_sampling_rejection(message: &str) -> bool {
    let lower = message.to_lowercase();
    [
        "temperature", "top_p", "top-p", "max_tokens", "max tokens",
        "frequency_penalty", "presence_penalty", "penalty",
        "unsupported value", "unsupported parameter", "unknown parameter",
        "does not support", "not supported", "unexpected parameter",
    ]
    .iter()
    .any(|marker| lower.contains(marker))
}

// ---------------------------------------------------------------------------
// Shared plumbing
// ---------------------------------------------------------------------------

/// Sends the error to the UI channel AND returns it — every failure path
/// both surfaces in the chat and rejects the invoke promise.
fn fail(on_event: &Channel<StreamEvent>, message: String) -> Result<(), String> {
    let _ = on_event.send(StreamEvent::Error { message: message.clone() });
    Err(message)
}

fn connect_error(url: &str, e: &reqwest::Error) -> String {
    if e.is_connect() {
        format!("Couldn't reach the model server at {url}. Is it running? ({e})")
    } else {
        format!("Request failed: {e}")
    }
}

/// Unix seconds now — the trial signature timestamp.
fn unix_now() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or_default()
}

/// Attaches auth for the OpenAI-format paths: a real API key always wins
/// (bearer); otherwise, with Free Week credentials present, sign the exact
/// body bytes the hosted gateway will hash (recipe in trial.rs). Only the
/// hosted gateway speaks the trial, and it is OpenAI-format — the BYOK
/// Anthropic/Gemini paths always carry their own keys.
///
/// The trial branch MUST set the Authorization bearer too, not just the
/// X-Eaon-* signature headers: the gateway's extractEaonApiKey() reads the
/// trial token from the Authorization header first and uses it to look up
/// which trial record to verify the signature against — sans that header,
/// the gateway never even attempts trial verification, and falls straight
/// through to "this model requires an API key" for anything that isn't its
/// no-auth-required instant tier (which is why only that tier ever worked).
fn openai_auth(
    builder: reqwest::RequestBuilder,
    request: &ChatRequest,
    body_bytes: &[u8],
) -> reqwest::RequestBuilder {
    if let Some(key) = request.api_key.as_ref().filter(|k| !k.is_empty()) {
        return builder.bearer_auth(key);
    }
    if let (Some(key), Some(device), Some(secret)) = (
        request.trial_key.as_ref().filter(|k| !k.is_empty()),
        request.trial_device.as_ref().filter(|d| !d.is_empty()),
        request.trial_secret.as_ref().filter(|s| !s.is_empty()),
    ) {
        let ts = unix_now();
        let sig =
            crate::trial::signature(secret, device, ts, &crate::trial::body_sha256_hex(body_bytes));
        return builder
            .bearer_auth(key)
            .header("X-Eaon-Device", device.as_str())
            .header("X-Eaon-TS", ts.to_string())
            .header("X-Eaon-Sig", sig);
    }
    builder // anonymous is fine for local servers
}

/// A JSON POST whose bytes are serialized exactly once: the trial signature
/// hashes these bytes and the gateway hashes what it receives, so `.json()`'s
/// re-serialization is off the table.
fn openai_post(
    client: &reqwest::Client,
    url: &str,
    request: &ChatRequest,
    body: &serde_json::Value,
) -> reqwest::RequestBuilder {
    let bytes = serde_json::to_vec(body).unwrap_or_default();
    let builder = client
        .post(url)
        .header(reqwest::header::CONTENT_TYPE, "application/json")
        .body(bytes.clone());
    openai_auth(builder, request, &bytes)
}

enum LineOutcome {
    Continue,
    /// The provider's own terminal signal ([DONE] / message_stop /
    /// finish_reason) — the reply really is complete.
    Finished,
}

/// How one `pump_sse` pass ended. The caller decides what to do about it,
/// because only it knows whether a signal-less end is expected (Gemini) or a
/// dropped connection worth re-requesting (OpenAI/Anthropic).
enum PumpOutcome {
    /// The provider said it was finished.
    Finished,
    /// The user pressed stop.
    Cancelled,
    /// The byte stream simply ran out, with no terminal signal.
    StreamEnded,
    /// The connection died mid-body with a real transport error. Carries the
    /// message so the caller can surface it if it runs out of retries.
    Dropped(String),
}

/// Strips an SSE `data:` prefix, tolerating the optional space after the
/// colon — `data:{...}` with no space is equally valid SSE, and several
/// gateways send it that way. Matching only `"data: "` silently skipped
/// every frame those produce.
fn sse_payload(line: &str) -> Option<&str> {
    line.strip_prefix("data:").map(str::trim_start)
}

/// Shared SSE pump: buffers network chunks into whole lines (frames split
/// across chunks freely), strips the `data:` prefix, and hands each payload
/// to the per-format handler. Checks the cancel flag between chunks.
///
/// Buffers BYTES, not text. The previous version pushed
/// `String::from_utf8_lossy` of each raw network chunk into a `String`: a
/// multi-byte character straddling a chunk boundary — every emoji, dash, and
/// accented letter has a real chance of landing there — became two U+FFFD
/// replacements, which broke that frame's JSON and made the whole delta
/// vanish from the reply. A line that ends in `\n` can't split a UTF-8
/// sequence, so decoding per completed line is safe.
async fn pump_sse(
    response: reqwest::Response,
    on_event: &Channel<StreamEvent>,
    cancel: &AtomicBool,
    mut handle_data: impl FnMut(&str) -> LineOutcome,
) -> PumpOutcome {
    fn handle_line(line: &[u8], handle_data: &mut impl FnMut(&str) -> LineOutcome) -> LineOutcome {
        let text = String::from_utf8_lossy(line);
        match sse_payload(text.trim()) {
            Some(data) => handle_data(data),
            None => LineOutcome::Continue,
        }
    }

    let mut stream = response.bytes_stream();
    let mut buffer: Vec<u8> = Vec::new();

    while let Some(chunk) = stream.next().await {
        if cancel.load(Ordering::Relaxed) {
            let _ = on_event.send(StreamEvent::Done { cancelled: true, truncated: false });
            return PumpOutcome::Cancelled;
        }
        // Deliberately NOT reported to the UI here: the caller may still
        // retry, and an Error event already delivered would leave the reply
        // flagged as failed even after a successful re-ask.
        let bytes = match chunk {
            Ok(b) => b,
            Err(e) => return PumpOutcome::Dropped(format!("Stream interrupted: {e}")),
        };
        buffer.extend_from_slice(&bytes);
        while let Some(newline) = buffer.iter().position(|&b| b == b'\n') {
            let line: Vec<u8> = buffer.drain(..=newline).collect();
            if let LineOutcome::Finished = handle_line(&line, &mut handle_data) {
                return PumpOutcome::Finished;
            }
        }
    }

    // The stream ended with bytes still buffered — a final frame that arrived
    // without its trailing newline. Servers legitimately close right after
    // `data: [DONE]`, and dropping this tail reported those perfectly healthy
    // replies as cut off (and, with the retry below, would have re-asked for
    // every single one of them).
    if !buffer.is_empty() {
        if let LineOutcome::Finished = handle_line(&buffer, &mut handle_data) {
            return PumpOutcome::Finished;
        }
    }
    PumpOutcome::StreamEnded
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

#[tauri::command]
pub async fn chat_stream(request: ChatRequest, on_event: Channel<StreamEvent>) -> Result<(), String> {
    let flag = cancel_flag(request.request_id);
    let result = match request.format.as_deref() {
        Some("anthropic") => anthropic_stream_inner(&request, &on_event, &flag).await,
        Some("gemini") => gemini_stream_inner(&request, &on_event, &flag).await,
        _ => openai_stream_inner(&request, &on_event, &flag).await,
    };
    clear_cancel_flag(request.request_id);
    result
}

/// A non-streaming completion — one request, the whole answer returned as a
/// string. Used for background work that isn't a live chat: memory
/// extraction and title derivation. Always OpenAI wire format (those jobs
/// run on the hosted gateway or Ollama, both of which speak it), and trial
/// signing applies the same way so Free Week users get memory/titles too.
#[tauri::command]
pub async fn chat_complete(request: ChatRequest) -> Result<String, String> {
    let client = net::http_client(Some(120));
    let url = format!("{}/chat/completions", request.base_url.trim_end_matches('/'));
    let body = serde_json::json!({
        "model": request.model,
        "messages": request.messages.iter()
            .map(|m| serde_json::json!({ "role": m.role, "content": m.content }))
            .collect::<Vec<_>>(),
        "stream": false,
    });
    let resp = net::send_with_retry(openai_post(&client, &url, &request, &body))
        .await
        .map_err(|e| format!("request failed: {e}"))?;
    if !resp.status().is_success() {
        return Err(format!("server returned {}", resp.status()));
    }
    let json: serde_json::Value = resp.json().await.map_err(|e| format!("bad response: {e}"))?;
    Ok(json["choices"][0]["message"]["content"].as_str().unwrap_or("").to_string())
}

// ---------------------------------------------------------------------------
// OpenAI-compatible path (the REF chat_stream_inner, plus retry + trial)
// ---------------------------------------------------------------------------

async fn openai_stream_inner(
    request: &ChatRequest,
    on_event: &Channel<StreamEvent>,
    cancel: &AtomicBool,
) -> Result<(), String> {
    let client = net::http_client(None);
    let url = format!("{}/chat/completions", request.base_url.trim_end_matches('/'));

    let body_with = |sampling: Option<&serde_json::Map<String, serde_json::Value>>| {
        let mut body = serde_json::json!({
            "model": request.model,
            "messages": request.messages.iter()
                .map(|m| serde_json::json!({ "role": m.role, "content": m.content }))
                .collect::<Vec<_>>(),
            "stream": true,
        });
        if let (Some(fields), Some(obj)) = (sampling, body.as_object_mut()) {
            for (key, value) in fields {
                obj.insert(key.clone(), value.clone());
            }
        }
        body
    };

    let mut sampling = request.sampling.as_ref().filter(|m| !m.is_empty());

    // One attempt per pass — a stream cut off before the provider ever said
    // it was finished is re-requested from scratch. See STREAM_MAX_ATTEMPTS.
    for attempt in 1..=STREAM_MAX_ATTEMPTS {
        let mut response =
            match net::send_with_retry(openai_post(&client, &url, request, &body_with(sampling)))
                .await
            {
                Ok(r) => r,
                Err(e) if attempt < STREAM_MAX_ATTEMPTS && !e.is_connect() => {
                    // Not a "server isn't there" failure — the connection got
                    // as far as being made and then died. Worth another go.
                    tokio::time::sleep(stream_retry_backoff(attempt)).await;
                    continue;
                }
                Err(e) => return fail(on_event, connect_error(&url, &e)),
            };

        if !response.status().is_success() {
            let status = response.status();
            let detail = response.text().await.unwrap_or_default();
            // A model that refuses a user-set sampling field (reasoning models
            // and temperature, most commonly) gets one retry without them —
            // costs one request, saves a broken chat.
            let retried = if sampling.is_some() && looks_like_sampling_rejection(&detail) {
                net::send_with_retry(openai_post(&client, &url, request, &body_with(None)))
                    .await
                    .ok()
                    .filter(|r| r.status().is_success())
            } else {
                None
            };
            match retried {
                Some(r) => {
                    // Sticky for any later retry pass too — re-sending the
                    // rejected fields would just fail the same way again.
                    sampling = None;
                    response = r;
                }
                None => return fail(on_event, format!("Server returned {status}. {detail}")),
            }
        }

        let outcome = pump_sse(response, on_event, cancel, |data| {
            if data == "[DONE]" {
                return LineOutcome::Finished;
            }
            let Ok(json) = serde_json::from_str::<serde_json::Value>(data) else {
                return LineOutcome::Continue;
            };
            let choice = &json["choices"][0];
            let delta = &choice["delta"];
            if let Some(text) = delta.get("content").and_then(|v| v.as_str()) {
                if !text.is_empty() {
                    let _ = on_event.send(StreamEvent::Token { text: text.to_string() });
                }
            }
            // Reasoning models (DeepSeek-R1, Nemotron, …) send chain-of-thought
            // as a separate `reasoning`/`reasoning_content` delta field.
            let reasoning = delta
                .get("reasoning")
                .and_then(|v| v.as_str())
                .or_else(|| delta.get("reasoning_content").and_then(|v| v.as_str()));
            if let Some(text) = reasoning {
                if !text.is_empty() {
                    let _ = on_event.send(StreamEvent::Reasoning { text: text.to_string() });
                }
            }
            // Plenty of OpenAI-compatible gateways and proxies never emit the
            // `[DONE]` sentinel but always set `finish_reason` on the final
            // choice. Accepting only `[DONE]` would mean treating every reply
            // those serve as cut off — and, with the retry above, re-asking
            // for all of them.
            match choice.get("finish_reason") {
                Some(v) if !v.is_null() => LineOutcome::Finished,
                _ => LineOutcome::Continue,
            }
        })
        .await;

        match outcome {
            PumpOutcome::Cancelled => return Ok(()),
            PumpOutcome::Finished => {
                let _ = on_event.send(StreamEvent::Done { cancelled: false, truncated: false });
                return Ok(());
            }
            PumpOutcome::StreamEnded | PumpOutcome::Dropped(_)
                if attempt < STREAM_MAX_ATTEMPTS && !cancel.load(Ordering::Relaxed) =>
            {
                let _ = on_event.send(StreamEvent::Restart);
                tokio::time::sleep(stream_retry_backoff(attempt)).await;
            }
            // Out of retries. A clean signal-less end keeps whatever arrived
            // and flags it; a transport error reports what actually happened.
            PumpOutcome::StreamEnded => {
                let _ = on_event.send(StreamEvent::Done { cancelled: false, truncated: true });
                return Ok(());
            }
            PumpOutcome::Dropped(message) => return fail(on_event, message),
        }
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// Anthropic Messages path
// ---------------------------------------------------------------------------

async fn anthropic_stream_inner(
    request: &ChatRequest,
    on_event: &Channel<StreamEvent>,
    cancel: &AtomicBool,
) -> Result<(), String> {
    let client = net::http_client(None);
    let url = format!("{}/messages", request.base_url.trim_end_matches('/'));
    let body =
        formats::build_anthropic_body(&request.model, &request.messages, request.sampling.as_ref());

    // Same cut-off-stream retry as the OpenAI path — see STREAM_MAX_ATTEMPTS.
    for attempt in 1..=STREAM_MAX_ATTEMPTS {
        let mut builder = client
            .post(&url)
            // Anthropic's pinned API revision — same one the Mac app sends.
            .header("anthropic-version", "2023-06-01")
            .json(&body);
        if let Some(key) = request.api_key.as_ref().filter(|k| !k.is_empty()) {
            builder = builder.header("x-api-key", key.as_str());
        }
        let response = match net::send_with_retry(builder).await {
            Ok(r) => r,
            Err(e) if attempt < STREAM_MAX_ATTEMPTS && !e.is_connect() => {
                tokio::time::sleep(stream_retry_backoff(attempt)).await;
                continue;
            }
            Err(e) => return fail(on_event, connect_error(&url, &e)),
        };
        if !response.status().is_success() {
            let status = response.status();
            let detail = response.text().await.unwrap_or_default();
            return fail(on_event, format!("Server returned {status}. {detail}"));
        }

        let outcome = pump_sse(response, on_event, cancel, |data| {
            let Ok(json) = serde_json::from_str::<serde_json::Value>(data) else {
                return LineOutcome::Continue;
            };
            match json["type"].as_str() {
                Some("content_block_delta") => {
                    let delta = &json["delta"];
                    match delta["type"].as_str() {
                        Some("text_delta") => {
                            if let Some(text) = delta["text"].as_str().filter(|t| !t.is_empty()) {
                                let _ =
                                    on_event.send(StreamEvent::Token { text: text.to_string() });
                            }
                        }
                        // Extended thinking streams as its own delta kind — feeds
                        // the UI's reasoning disclosure, same as OpenAI reasoning.
                        Some("thinking_delta") => {
                            if let Some(text) = delta["thinking"].as_str().filter(|t| !t.is_empty())
                            {
                                let _ = on_event
                                    .send(StreamEvent::Reasoning { text: text.to_string() });
                            }
                        }
                        _ => {}
                    }
                    LineOutcome::Continue
                }
                // `message_delta` carries the stop_reason and always precedes
                // `message_stop`; accepting it too means a proxy that closes
                // right after it isn't mistaken for a cut-off reply.
                Some("message_delta") if !json["delta"]["stop_reason"].is_null() => {
                    LineOutcome::Finished
                }
                Some("message_stop") => LineOutcome::Finished,
                _ => LineOutcome::Continue,
            }
        })
        .await;

        match outcome {
            PumpOutcome::Cancelled => return Ok(()),
            PumpOutcome::Finished => {
                let _ = on_event.send(StreamEvent::Done { cancelled: false, truncated: false });
                return Ok(());
            }
            PumpOutcome::StreamEnded | PumpOutcome::Dropped(_)
                if attempt < STREAM_MAX_ATTEMPTS && !cancel.load(Ordering::Relaxed) =>
            {
                let _ = on_event.send(StreamEvent::Restart);
                tokio::time::sleep(stream_retry_backoff(attempt)).await;
            }
            PumpOutcome::StreamEnded => {
                let _ = on_event.send(StreamEvent::Done { cancelled: false, truncated: true });
                return Ok(());
            }
            PumpOutcome::Dropped(message) => return fail(on_event, message),
        }
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// Gemini path
// ---------------------------------------------------------------------------

async fn gemini_stream_inner(
    request: &ChatRequest,
    on_event: &Channel<StreamEvent>,
    cancel: &AtomicBool,
) -> Result<(), String> {
    let client = net::http_client(None);
    // Gemini authenticates via a query key, not a header; alt=sse turns its
    // chunked JSON into standard SSE lines. Error messages use the key-less
    // endpoint so the API key never lands in the chat transcript.
    let endpoint = format!(
        "{}/models/{}:streamGenerateContent",
        request.base_url.trim_end_matches('/'),
        request.model
    );
    let url = format!(
        "{endpoint}?alt=sse&key={}",
        request.api_key.clone().unwrap_or_default()
    );
    let body = formats::build_gemini_body(&request.messages, request.sampling.as_ref());

    let response = match net::send_with_retry(client.post(&url).json(&body)).await {
        Ok(r) => r,
        Err(e) => return fail(on_event, connect_error(&endpoint, &e)),
    };
    if !response.status().is_success() {
        let status = response.status();
        let detail = response.text().await.unwrap_or_default();
        return fail(on_event, format!("Server returned {status}. {detail}"));
    }

    // No [DONE]/message_stop equivalent — the HTTP stream ending IS the done
    // signal here, so a signal-less end is never flagged as truncated and
    // never retried, unlike the OpenAI/Anthropic paths.
    let outcome = pump_sse(response, on_event, cancel, |data| {
        let Ok(json) = serde_json::from_str::<serde_json::Value>(data) else {
            return LineOutcome::Continue;
        };
        if let Some(parts) = json["candidates"][0]["content"]["parts"].as_array() {
            for part in parts {
                if let Some(text) = part["text"].as_str().filter(|t| !t.is_empty()) {
                    let _ = on_event.send(StreamEvent::Token { text: text.to_string() });
                }
            }
        }
        LineOutcome::Continue
    })
    .await;

    match outcome {
        PumpOutcome::Cancelled => Ok(()),
        PumpOutcome::Finished | PumpOutcome::StreamEnded => {
            let _ = on_event.send(StreamEvent::Done { cancelled: false, truncated: false });
            Ok(())
        }
        PumpOutcome::Dropped(message) => fail(on_event, message),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // Ported verbatim from the old lib.rs — the retry heuristic must not
    // drift while moving files.
    #[test]
    fn rejection_matcher_catches_real_provider_errors() {
        // Real shapes seen from OpenAI/compatible servers.
        assert!(looks_like_sampling_rejection(
            r#"{"error":{"message":"Unsupported value: 'temperature' does not support 0.7 with this model."}}"#
        ));
        assert!(looks_like_sampling_rejection("unknown parameter: 'presence_penalty'"));
        assert!(looks_like_sampling_rejection("max_tokens is too large"));
        // Ordinary errors must NOT trigger a silent parameter drop.
        assert!(!looks_like_sampling_rejection("invalid api key"));
        assert!(!looks_like_sampling_rejection("model not found"));
        assert!(!looks_like_sampling_rejection("rate limit exceeded"));
    }

    // The Anthropic/Gemini body-builder tests live with the builders in
    // chat_formats.rs.

    #[test]
    fn trial_signature_is_stable_64_char_hex() {
        let a = crate::trial::signature("s", "d", 1_700_000_000, "abc");
        let b = crate::trial::signature("s", "d", 1_700_000_000, "abc");
        assert_eq!(a, b); // deterministic — the gateway recomputes the same value
        assert_eq!(a.len(), 64);
        assert!(a.chars().all(|c| c.is_ascii_hexdigit()));
    }

    // -----------------------------------------------------------------------
    // pump_sse truncation detection — real integration tests, not a logic
    // mirror: a genuine local TCP server stands in for the model provider,
    // and the actual (private, in-module) pump_sse runs against a real
    // reqwest::Response from it. `Connection: close` + no Content-Length
    // means closing the socket early is exactly "the connection dropped
    // mid-generation" — indistinguishable, on the wire, from a real network
    // failure or an intermediary cutting the response short.
    // -----------------------------------------------------------------------

    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    use tokio::net::TcpListener;

    /// Starts a one-shot mock HTTP server on localhost, serves exactly the
    /// given raw SSE body (caller includes or omits the terminal marker),
    /// and returns the base URL to hit. `Connection: close`, no
    /// Content-Length — the socket closing IS the end of the body, whether
    /// or not the body reached a "real" ending.
    async fn mock_sse_server(body: &'static str) -> String {
        mock_sse_server_chunked(vec![body.as_bytes()]).await
    }

    /// Same, but writes the body as a caller-chosen sequence of raw byte
    /// writes with a flush between each — the only way to reproduce a frame
    /// (or a single UTF-8 character) split across two network chunks.
    async fn mock_sse_server_chunked(parts: Vec<&'static [u8]>) -> String {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        tokio::spawn(async move {
            let (mut socket, _) = listener.accept().await.unwrap();
            // Drain the request until the blank line ending the headers —
            // don't care about the request itself, just need it fully read
            // before writing the response.
            let mut buf = [0u8; 4096];
            loop {
                let n = socket.read(&mut buf).await.unwrap();
                if n == 0 || buf[..n].windows(4).any(|w| w == b"\r\n\r\n") {
                    break;
                }
            }
            socket
                .write_all(
                    b"HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nConnection: close\r\n\r\n",
                )
                .await
                .unwrap();
            socket.flush().await.unwrap();
            for part in parts {
                socket.write_all(part).await.unwrap();
                socket.flush().await.unwrap();
                // Force the parts onto separate reads at the client.
                tokio::time::sleep(Duration::from_millis(20)).await;
            }
            socket.shutdown().await.ok();
        });
        format!("http://127.0.0.1:{port}")
    }

    /// Collects every StreamEvent sent through a Channel as its serialized
    /// JSON, in order — Channel::new needs no live app/webview, just a
    /// plain closure, so this runs against the real IPC type.
    fn collecting_channel() -> (Channel<StreamEvent>, Arc<Mutex<Vec<String>>>) {
        let collected = Arc::new(Mutex::new(Vec::new()));
        let sink = collected.clone();
        let channel = Channel::new(move |body| {
            if let tauri::ipc::InvokeResponseBody::Json(json) = body {
                sink.lock().unwrap().push(json);
            }
            Ok(())
        });
        (channel, collected)
    }

    /// Runs the real `pump_sse` against a mock server, using the OpenAI
    /// handler's own terminal-signal rules ([DONE] or a non-null
    /// finish_reason), and returns how the pass ended plus every text token
    /// it emitted.
    async fn run_pump_sse(parts: Vec<&'static [u8]>, cancelled: bool) -> (PumpOutcome, Vec<String>) {
        let url = mock_sse_server_chunked(parts).await;
        let client = reqwest::Client::new();
        let response = client.get(&url).send().await.unwrap();
        let (channel, collected) = collecting_channel();
        let cancel = AtomicBool::new(cancelled);
        let outcome = pump_sse(response, &channel, &cancel, |data| {
            if data == "[DONE]" {
                return LineOutcome::Finished;
            }
            let Ok(json) = serde_json::from_str::<serde_json::Value>(data) else {
                return LineOutcome::Continue;
            };
            if let Some(text) = json["choices"][0]["delta"]["content"].as_str() {
                let _ = channel.send(StreamEvent::Token { text: text.to_string() });
            }
            match json["choices"][0].get("finish_reason") {
                Some(v) if !v.is_null() => LineOutcome::Finished,
                _ => LineOutcome::Continue,
            }
        })
        .await;
        // `collecting_channel`'s closure holds a second Arc<Mutex<..>>
        // reference for as long as `channel` is alive. Drop it explicitly so
        // `collected` is left as the sole owner.
        drop(channel);
        let events = Arc::try_unwrap(collected).unwrap().into_inner().unwrap();
        let tokens = events
            .iter()
            .map(|s| serde_json::from_str::<serde_json::Value>(s).unwrap())
            .filter(|v| v["type"] == "token")
            .map(|v| v["text"].as_str().unwrap().to_string())
            .collect();
        (outcome, tokens)
    }

    #[tokio::test]
    async fn pump_sse_clean_done_is_finished() {
        let (outcome, _) = run_pump_sse(vec![b"data: [DONE]\n\n"], false).await;
        assert!(matches!(outcome, PumpOutcome::Finished));
    }

    #[tokio::test]
    async fn pump_sse_terminal_frame_without_trailing_newline_still_finishes() {
        // A server that closes the socket the instant it writes [DONE], with
        // no trailing newline, is completely ordinary. The old line-splitter
        // only ever looked for a '\n' and so left this final frame rotting in
        // the buffer — reporting a perfectly healthy reply as cut off (and,
        // now that a cut-off reply is re-requested, it would have re-asked
        // for every single one of them).
        let (outcome, _) = run_pump_sse(vec![b"data: [DONE]"], false).await;
        assert!(
            matches!(outcome, PumpOutcome::Finished),
            "the last frame must still be parsed when the stream ends without a newline"
        );
    }

    #[tokio::test]
    async fn pump_sse_finish_reason_counts_as_a_terminal_signal() {
        // Plenty of OpenAI-compatible gateways never send [DONE] at all.
        let (outcome, _) = run_pump_sse(
            vec![b"data: {\"choices\":[{\"delta\":{},\"finish_reason\":\"stop\"}]}\n\n"],
            false,
        )
        .await;
        assert!(matches!(outcome, PumpOutcome::Finished));
    }

    #[tokio::test]
    async fn pump_sse_null_finish_reason_is_not_a_terminal_signal() {
        // Every ordinary mid-stream chunk carries `"finish_reason": null`;
        // treating that as the end would truncate every reply at its first
        // token.
        let (outcome, tokens) = run_pump_sse(
            vec![b"data: {\"choices\":[{\"delta\":{\"content\":\"hi\"},\"finish_reason\":null}]}\n\n"],
            false,
        )
        .await;
        assert!(matches!(outcome, PumpOutcome::StreamEnded));
        assert_eq!(tokens, vec!["hi".to_string()]);
    }

    #[tokio::test]
    async fn pump_sse_connection_drop_without_terminal_signal_is_stream_ended() {
        // Body never reaches a terminal signal — the mock server just closes
        // the socket, simulating a dropped connection mid-generation. The
        // caller retries this; being unable to tell it apart from a real
        // ending is what made replies stop mid-sentence with no error.
        let (outcome, _) =
            run_pump_sse(vec![b"data: {\"choices\":[{\"delta\":{}}]}\n\n"], false).await;
        assert!(matches!(outcome, PumpOutcome::StreamEnded));
    }

    #[tokio::test]
    async fn pump_sse_survives_a_utf8_character_split_across_chunks() {
        // "—" is three bytes; this splits it down the middle across two
        // network writes. Decoding each raw chunk with from_utf8_lossy turned
        // the halves into two U+FFFD replacements, which broke the frame's
        // JSON and made the WHOLE delta vanish from the reply — text silently
        // missing mid-answer.
        let frame = "data: {\"choices\":[{\"delta\":{\"content\":\"a—b\"}}]}\n\n".as_bytes();
        let split = frame
            .windows(2)
            .position(|w| w == [0xE2, 0x80])
            .expect("the em dash's leading bytes must be present")
            + 1;
        let (_, tokens) = run_pump_sse(vec![&frame[..split], &frame[split..]], false).await;
        assert_eq!(
            tokens,
            vec!["a—b".to_string()],
            "a character straddling a chunk boundary must not corrupt its frame"
        );
    }

    #[tokio::test]
    async fn pump_sse_accepts_data_prefix_without_a_space() {
        // `data:{...}` with no space is equally valid SSE and several
        // gateways send it that way; matching only "data: " skipped every
        // frame they produced, so those replies arrived completely empty.
        let (outcome, tokens) = run_pump_sse(
            vec![b"data:{\"choices\":[{\"delta\":{\"content\":\"hi\"}}]}\n\ndata:[DONE]\n\n"],
            false,
        )
        .await;
        assert!(matches!(outcome, PumpOutcome::Finished));
        assert_eq!(tokens, vec!["hi".to_string()]);
    }

    #[tokio::test]
    async fn pump_sse_cancellation_reports_cancelled_and_sends_one_done() {
        let (outcome, _) = run_pump_sse(
            vec![b"data: {\"choices\":[{\"delta\":{\"content\":\"hi\"}}]}\n\n"],
            true, // already cancelled before the first chunk
        )
        .await;
        assert!(
            matches!(outcome, PumpOutcome::Cancelled),
            "a deliberate stop must never be reported as a mystery drop, or it would be retried"
        );
    }

    #[test]
    fn stream_retry_backoff_grows_and_is_capped() {
        assert_eq!(stream_retry_backoff(1), Duration::from_millis(300));
        assert_eq!(stream_retry_backoff(2), Duration::from_millis(600));
        assert_eq!(stream_retry_backoff(9), Duration::from_millis(1200));
    }
}
