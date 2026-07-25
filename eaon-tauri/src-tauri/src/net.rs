// Outbound HTTP — one place to build clients so the user's optional proxy
// (Settings → General → Network) applies to ALL provider/search/image
// traffic, the AppHTTP/ProxyStore pattern from macOS. Off by default, in
// which case clients behave exactly like direct connections.

use std::sync::{LazyLock, Mutex};
use std::time::Duration;

/// The proxy URL every subsequent outbound client routes through, when set.
/// A plain global rather than Tauri managed state because clients are built
/// from free functions all over the crate (chat, search, images, trial).
pub static PROXY_URL: LazyLock<Mutex<Option<String>>> = LazyLock::new(|| Mutex::new(None));

/// Sets (or clears, with None/empty) the proxy. Validates eagerly via
/// reqwest so the UI can say "that address doesn't parse" instead of
/// silently sending traffic direct.
#[tauri::command]
pub fn set_proxy(url: Option<String>) -> Result<(), String> {
    let cleaned = url.map(|u| u.trim().to_string()).filter(|u| !u.is_empty());
    if let Some(u) = cleaned.as_ref() {
        reqwest::Proxy::all(u.clone())
            .map_err(|e| format!("That proxy address doesn't parse: {e}"))?;
    }
    *PROXY_URL.lock().unwrap() = cleaned;
    Ok(())
}

/// A reqwest client honoring the configured proxy. `timeout_secs: None`
/// leaves streaming responses unbounded (a chat stream can legitimately run
/// minutes); requests with a natural bound pass one.
pub fn http_client(timeout_secs: Option<u64>) -> reqwest::Client {
    let mut builder = reqwest::Client::builder();
    if let Some(secs) = timeout_secs {
        builder = builder.timeout(Duration::from_secs(secs));
    }
    if let Some(proxy_url) = PROXY_URL.lock().unwrap().clone() {
        if let Ok(proxy) = reqwest::Proxy::all(proxy_url) {
            builder = builder.proxy(proxy);
        }
    }
    builder.build().unwrap_or_default()
}

/// Sends a request, retrying ONLY transient gateway statuses (502/503/504)
/// — up to 5 attempts with 400ms → 3.2s exponential backoff. Those statuses
/// mean an upstream hiccuped before any tokens flowed, so a retry is
/// invisible to the user. Nothing mid-stream is ever retried (that would
/// replay already-delivered tokens): callers use this for the initial send
/// only, and transport errors / other statuses return immediately.
pub async fn send_with_retry(
    builder: reqwest::RequestBuilder,
) -> Result<reqwest::Response, reqwest::Error> {
    const MAX_ATTEMPTS: u32 = 5;
    let mut delay = Duration::from_millis(400);
    let mut attempt = 1;
    loop {
        // Chat bodies are plain in-memory bytes, so cloning succeeds; a
        // hypothetical streaming body can't replay and just sends once.
        let this_try = match builder.try_clone() {
            Some(b) => b,
            None => return builder.send().await,
        };
        match this_try.send().await {
            Ok(resp)
                if attempt < MAX_ATTEMPTS
                    && matches!(resp.status().as_u16(), 502 | 503 | 504) =>
            {
                tokio::time::sleep(delay).await;
                delay *= 2;
                attempt += 1;
            }
            other => return other,
        }
    }
}

#[cfg(test)]
mod tests {
    #[test]
    fn set_proxy_validates_and_clears() {
        // Garbage must be rejected BEFORE it's stored…
        assert!(super::set_proxy(Some("http://[".into())).is_err());
        // …a real address accepted…
        assert!(super::set_proxy(Some("http://127.0.0.1:8080".into())).is_ok());
        assert_eq!(
            super::PROXY_URL.lock().unwrap().clone(),
            Some("http://127.0.0.1:8080".to_string())
        );
        // …and whitespace/empty clears back to direct.
        assert!(super::set_proxy(Some("  ".into())).is_ok());
        assert!(super::PROXY_URL.lock().unwrap().is_none());
    }
}
