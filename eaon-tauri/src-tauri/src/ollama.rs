// Ollama management — installed-model list, pulls with live NDJSON
// progress, and deletes that verify the model actually disappeared.

use futures_util::StreamExt;
use serde::Serialize;
use tauri::ipc::Channel;

use crate::net::http_client;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OllamaModelInfo {
    pub name: String,
    pub size_bytes: u64,
    pub param_size: Option<String>,
    pub quantization: Option<String>,
    pub family: Option<String>,
    /// Ollama's real capability tags ("completion", "vision", "image",
    /// "thinking", …) — how diffusion models are told apart from chat ones.
    pub capabilities: Option<Vec<String>>,
}

#[derive(Clone, Serialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum PullEvent {
    Progress { status: String, completed: u64, total: u64 },
    Done,
    Error { message: String },
}

/// Detailed installed-model list from `/api/tags` — name, on-disk size, and
/// the real spec fields Ollama reports (mirrors the Mac app's Models page).
#[tauri::command]
pub async fn ollama_tags(base_url: String) -> Result<Vec<OllamaModelInfo>, String> {
    let url = format!("{}/api/tags", base_url.trim_end_matches('/'));
    let response = http_client(Some(10))
        .get(&url)
        .send()
        .await
        .map_err(|e| format!("Couldn't reach Ollama at {url}. Is it installed and running? ({e})"))?;
    let json: serde_json::Value = response.json().await.map_err(|e| e.to_string())?;
    let models = json["models"]
        .as_array()
        .map(|arr| {
            arr.iter()
                .filter_map(|m| {
                    let name = m["name"].as_str()?.to_string();
                    Some(OllamaModelInfo {
                        name,
                        size_bytes: m["size"].as_u64().unwrap_or(0),
                        param_size: m["details"]["parameter_size"].as_str().map(str::to_string),
                        quantization: m["details"]["quantization_level"].as_str().map(str::to_string),
                        family: m["details"]["family"].as_str().map(str::to_string),
                        capabilities: m["capabilities"].as_array().map(|caps| {
                            caps.iter().filter_map(|c| c.as_str().map(str::to_string)).collect()
                        }),
                    })
                })
                .collect()
        })
        .unwrap_or_default();
    Ok(models)
}

/// Downloads a model through Ollama's own `/api/pull`, streaming NDJSON
/// progress lines back as real completed/total byte counts.
#[tauri::command]
pub async fn ollama_pull(base_url: String, model: String, on_event: Channel<PullEvent>) -> Result<(), String> {
    let url = format!("{}/api/pull", base_url.trim_end_matches('/'));
    // No timeout: a multi-gigabyte model on home broadband legitimately takes
    // longer than any fixed allowance.
    let client = http_client(None);
    let response = client
        .post(&url)
        .json(&serde_json::json!({ "model": model, "stream": true }))
        .send()
        .await
        .map_err(|e| {
            let message = format!("Couldn't reach Ollama: {e}");
            let _ = on_event.send(PullEvent::Error { message: message.clone() });
            message
        })?;

    if !response.status().is_success() {
        let message = format!("Ollama returned {}", response.status());
        let _ = on_event.send(PullEvent::Error { message: message.clone() });
        return Err(message);
    }

    // Line-buffered NDJSON parse: chunks can split mid-line, so accumulate
    // and only parse complete lines.
    let mut stream = response.bytes_stream();
    let mut buffer = String::new();
    while let Some(chunk) = stream.next().await {
        let bytes = chunk.map_err(|e| {
            let message = format!("Download interrupted: {e}");
            let _ = on_event.send(PullEvent::Error { message: message.clone() });
            message
        })?;
        buffer.push_str(&String::from_utf8_lossy(&bytes));
        while let Some(newline) = buffer.find('\n') {
            let line: String = buffer.drain(..=newline).collect();
            let line = line.trim();
            if line.is_empty() {
                continue;
            }
            let Ok(json) = serde_json::from_str::<serde_json::Value>(line) else { continue };
            if let Some(err) = json["error"].as_str() {
                let message = err.to_string();
                let _ = on_event.send(PullEvent::Error { message: message.clone() });
                return Err(message);
            }
            let status = json["status"].as_str().unwrap_or("").to_string();
            let completed = json["completed"].as_u64().unwrap_or(0);
            let total = json["total"].as_u64().unwrap_or(0);
            let _ = on_event.send(PullEvent::Progress { status, completed, total });
        }
    }
    let _ = on_event.send(PullEvent::Done);
    Ok(())
}

/// Deletes a model AND verifies it's actually gone afterward (re-checks the
/// tags list) — returns an error message instead of pretending success, the
/// same says-deleted-but-storage-unchanged guard the Mac app has.
#[tauri::command]
pub async fn ollama_delete(base_url: String, model: String) -> Result<(), String> {
    let base = base_url.trim_end_matches('/').to_string();
    let client = http_client(Some(30));
    let response = client
        .delete(format!("{base}/api/delete"))
        .json(&serde_json::json!({ "model": model }))
        .send()
        .await
        .map_err(|e| format!("Couldn't reach Ollama: {e}"))?;

    if !response.status().is_success() {
        let detail = response.text().await.unwrap_or_default();
        return Err(format!("Ollama refused to delete {model}: {detail}"));
    }

    // Verify: even on 200, confirm the model is really gone.
    let tags: serde_json::Value = client
        .get(format!("{base}/api/tags"))
        .send()
        .await
        .map_err(|e| e.to_string())?
        .json()
        .await
        .map_err(|e| e.to_string())?;
    let still_there = tags["models"]
        .as_array()
        .map(|arr| arr.iter().any(|m| m["name"].as_str() == Some(model.as_str())))
        .unwrap_or(false);
    if still_there {
        return Err(format!("Ollama reported success but {model} is still installed — nothing was freed."));
    }
    Ok(())
}
