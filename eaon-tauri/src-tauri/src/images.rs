// Image generation — one command speaking every wire shape the Mac app's
// ImageGeneration.swift speaks: OpenAI-compatible `/images/generations`
// (b64_json, URL fallback), Automatic1111's `/sdapi/v1/txt2img` (DrawThings/
// ComfyUI-compatible), Ollama's `/api/generate` (its diffusion models), and
// the hosted Eaon `{url}` shape (legacy persisted configs still say "aqua"
// for it, so both tags are accepted). Returns base64 bytes + a suggested
// file name; the frontend stores it through the same attachments path as
// user uploads.

use serde::{Deserialize, Serialize};

use crate::attachments::sanitize_file_name;
use crate::net::http_client;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ImageGenRequest {
    /// "openai" | "automatic1111" | "ollama" | "eaon" (legacy alias "aqua")
    pub format: String,
    pub base_url: String,
    pub model: String,
    pub prompt: String,
    pub api_key: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImageGenResult {
    pub data_base64: String,
    pub suggested_file_name: String,
}

fn suggested_image_name(prefix: &str) -> String {
    let secs = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    format!("{}-{}.png", sanitize_file_name(prefix), secs)
}

async fn fetch_image_url(client: &reqwest::Client, url: &str) -> Result<Vec<u8>, String> {
    let resp = client
        .get(url)
        .send()
        .await
        .map_err(|e| format!("couldn't fetch the generated image: {e}"))?;
    if !resp.status().is_success() {
        return Err(format!("couldn't fetch the generated image ({})", resp.status()));
    }
    resp.bytes().await.map(|b| b.to_vec()).map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn generate_image(request: ImageGenRequest) -> Result<ImageGenResult, String> {
    use base64::Engine as _;
    let b64 = &base64::engine::general_purpose::STANDARD;
    // Local diffusion on CPU can genuinely take minutes — same generous
    // allowance as the Mac app's local paths; cloud calls finish long before.
    let client = http_client(Some(300));
    let base = request.base_url.trim_end_matches('/');

    let (url, body): (String, serde_json::Value) = match request.format.as_str() {
        "openai" => (
            format!("{base}/images/generations"),
            serde_json::json!({ "model": request.model, "prompt": request.prompt, "response_format": "b64_json" }),
        ),
        "automatic1111" => (
            format!("{base}/sdapi/v1/txt2img"),
            serde_json::json!({ "prompt": request.prompt }),
        ),
        "ollama" => (
            format!("{base}/api/generate"),
            serde_json::json!({ "model": request.model, "prompt": request.prompt, "stream": false }),
        ),
        "eaon" | "aqua" => (
            format!("{base}/images/generations"),
            serde_json::json!({ "model": request.model, "prompt": request.prompt }),
        ),
        other => return Err(format!("unknown image format: {other}")),
    };

    let mut builder = client.post(&url).json(&body);
    if let Some(key) = request.api_key.as_ref().filter(|k| !k.is_empty()) {
        builder = builder.bearer_auth(key);
    }
    let resp = builder
        .send()
        .await
        .map_err(|e| {
            if e.is_connect() {
                format!("Couldn't reach the image server at {url}. Is it running? ({e})")
            } else {
                format!("Image request failed: {e}")
            }
        })?;
    let status = resp.status();
    let text = resp.text().await.unwrap_or_default();
    if !status.is_success() {
        let detail = if text.is_empty() { "no further detail from the server.".to_string() } else { text };
        return Err(format!("Image generation failed ({status}): {detail}"));
    }
    let json: serde_json::Value =
        serde_json::from_str(&text).map_err(|_| "The server responded, but didn't include an image.".to_string())?;

    let no_image = || "The server responded, but didn't include an image.".to_string();
    let bytes: Vec<u8> = match request.format.as_str() {
        "openai" => {
            let first = json["data"][0].clone();
            if let Some(encoded) = first["b64_json"].as_str() {
                b64.decode(encoded).map_err(|_| no_image())?
            } else if let Some(image_url) = first["url"].as_str() {
                // A provider that ignores response_format and sends a URL
                // anyway — fall back rather than failing outright.
                fetch_image_url(&client, image_url).await?
            } else {
                return Err(no_image());
            }
        }
        "automatic1111" => {
            let encoded = json["images"][0].as_str().ok_or_else(no_image)?;
            b64.decode(encoded).map_err(|_| no_image())?
        }
        "ollama" => {
            let encoded = json["image"].as_str().ok_or_else(no_image)?;
            b64.decode(encoded).map_err(|_| no_image())?
        }
        "eaon" | "aqua" => {
            let image_url = json["url"].as_str().ok_or_else(no_image)?;
            fetch_image_url(&client, image_url).await?
        }
        _ => unreachable!(),
    };

    Ok(ImageGenResult {
        data_base64: b64.encode(bytes),
        suggested_file_name: suggested_image_name(if request.model.is_empty() { "image" } else { &request.model }),
    })
}
