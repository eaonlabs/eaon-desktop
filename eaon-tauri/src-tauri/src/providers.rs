// Provider model listing and generic text fetches. The webview's CSP can't
// fetch anything, so even a plain "GET this URL as text" must round-trip
// through Rust.

use serde::Serialize;

use crate::net::http_client;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderModel {
    pub id: String,
    pub name: Option<String>,
    pub model_type: Option<String>,
    pub tier: Option<String>,
}

/// GET `{base}/models` (OpenAI-compatible shape `{data: [{id, ...}]}`) —
/// serves both the hosted Eaon catalog refresh and BYOK connections.
/// `name`/`type`/`tier` are optional extras some gateways attach; entries
/// without an `id` are dropped rather than failing the whole list.
#[tauri::command]
pub async fn fetch_provider_models(base_url: String, api_key: Option<String>) -> Result<Vec<ProviderModel>, String> {
    let url = format!("{}/models", base_url.trim_end_matches('/'));
    let client = http_client(Some(30));
    let mut builder = client.get(&url);
    // Keyless endpoints (llama-server, some proxies) exist — only attach
    // the bearer when there's actually a non-empty key to attach.
    if let Some(key) = api_key.filter(|k| !k.is_empty()) {
        builder = builder.bearer_auth(key);
    }
    let response = builder.send().await.map_err(|e| format!("Couldn't reach {url}: {e}"))?;
    if !response.status().is_success() {
        return Err(format!("Server returned {} for {url}", response.status()));
    }
    let json: serde_json::Value = response.json().await.map_err(|e| e.to_string())?;
    let models = json["data"]
        .as_array()
        .map(|arr| {
            arr.iter()
                .filter_map(|m| {
                    Some(ProviderModel {
                        id: m["id"].as_str()?.to_string(),
                        name: m["name"].as_str().map(str::to_string),
                        model_type: m["type"].as_str().map(str::to_string),
                        tier: m["tier"].as_str().map(str::to_string),
                    })
                })
                .collect()
        })
        .unwrap_or_default();
    Ok(models)
}

/// Fetches a URL as plain text — GitHub-hosted SKILL.md files and the
/// update manifest. Generic on purpose (any raw text URL), kept here
/// because skills and the update card are its only callers.
#[tauri::command]
pub async fn fetch_text_url(url: String) -> Result<String, String> {
    let response = http_client(Some(30))
        .get(&url)
        .send()
        .await
        .map_err(|e| format!("Couldn't reach {url}: {e}"))?;
    if !response.status().is_success() {
        return Err(format!("{} for {url}", response.status()));
    }
    response.text().await.map_err(|e| e.to_string())
}
