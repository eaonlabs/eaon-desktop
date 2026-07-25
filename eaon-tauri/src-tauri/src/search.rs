// Web search — the Mac app's WebSearchService: MIKLIUM's free, keyless
// Search API (github.com/MIKLIUM-Team/MIKLIUM). Short search-engine
// snippets only (maxLargeSnippets: 0) so a mid-conversation search stays
// fast instead of scraping full pages.

use serde::Serialize;

use crate::net::http_client;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WebSearchHit {
    pub url: String,
    pub snippet: String,
}

#[tauri::command]
pub async fn web_search(query: String) -> Result<Vec<WebSearchHit>, String> {
    let trimmed = query.trim();
    if trimmed.is_empty() {
        return Err("Empty search query.".to_string());
    }
    let client = http_client(Some(25));
    let body = serde_json::json!({
        "search": [trimmed],
        "type": "default",
        "maxSmallSnippets": 8,
        "maxLargeSnippets": 0,
    });
    let resp = client
        .post("https://miklium.vercel.app/api/search")
        .json(&body)
        .send()
        .await
        .map_err(|e| format!("Search failed: {e}"))?;
    // MIKLIUM reports failure (including zero results) via a 4xx status but
    // always with the same {success, error} JSON body — `success` alone is
    // the branch, matching the Mac implementation.
    let json: serde_json::Value = resp
        .json()
        .await
        .map_err(|_| "The search service returned an unexpected response.".to_string())?;
    if json["success"].as_bool() != Some(true) {
        return Err(json["error"].as_str().unwrap_or("No results found.").to_string());
    }
    let results = json["results"]
        .as_array()
        .map(|arr| {
            arr.iter()
                .filter_map(|entry| {
                    Some(WebSearchHit {
                        url: entry["url"].as_str()?.to_string(),
                        snippet: entry["snippet"].as_str()?.to_string(),
                    })
                })
                .collect()
        })
        .unwrap_or_default();
    Ok(results)
}
