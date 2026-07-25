// Format translation for chat.rs — the pure request-body builders for the
// Anthropic Messages and Gemini generateContent wire formats (ARCHITECTURE
// "Wire formats for BYOK"). Message history arrives in OpenAI shape (role +
// string-or-content-parts) and is translated here; the OpenAI path itself
// needs no translation and lives in chat.rs. Child module of chat.rs — not
// declared in lib.rs.

use super::ChatMessagePayload;

// ---------------------------------------------------------------------------
// Anthropic Messages
// ---------------------------------------------------------------------------

/// Anthropic Messages body. System turns can't ride in `messages` (the API
/// rejects the role), so they concatenate into the top-level `system`
/// string. OpenAI vision parts translate to the base64 image source shape.
/// `max_tokens` is mandatory on this API — default 4096 when the user set
/// none — and temperature caps at 1.0 (Anthropic's range is 0–1 where
/// OpenAI's is 0–2). Only sampling knobs this API knows are forwarded;
/// penalties etc. would 400 the whole request.
pub(super) fn build_anthropic_body(
    model: &str,
    messages: &[ChatMessagePayload],
    sampling: Option<&serde_json::Map<String, serde_json::Value>>,
) -> serde_json::Value {
    let mut system_parts: Vec<String> = Vec::new();
    let mut wire_messages: Vec<serde_json::Value> = Vec::new();
    for message in messages {
        if message.role == "system" {
            // Leading in practice; folding any stray one keeps the request valid.
            system_parts.push(content_text(&message.content));
            continue;
        }
        let content = match &message.content {
            serde_json::Value::Array(parts) => {
                serde_json::Value::Array(parts.iter().filter_map(anthropic_part).collect())
            }
            other => other.clone(), // plain strings pass through
        };
        wire_messages.push(serde_json::json!({ "role": message.role, "content": content }));
    }

    let max_tokens = sampling
        .and_then(|s| s.get("max_tokens"))
        .and_then(|v| v.as_u64())
        .unwrap_or(4096);
    let mut body = serde_json::json!({
        "model": model,
        "max_tokens": max_tokens,
        "messages": wire_messages,
        "stream": true,
    });
    let obj = body.as_object_mut().expect("literal object");
    if !system_parts.is_empty() {
        obj.insert("system".into(), serde_json::Value::String(system_parts.join("\n\n")));
    }
    if let Some(s) = sampling {
        if let Some(t) = s.get("temperature").and_then(|v| v.as_f64()) {
            obj.insert("temperature".into(), serde_json::json!(t.min(1.0)));
        }
        for key in ["top_p", "top_k"] {
            if let Some(v) = s.get(key) {
                obj.insert(key.into(), v.clone());
            }
        }
    }
    body
}

/// One OpenAI content part → Anthropic's shape. Unknown parts (and remote
/// image URLs — attachments always ship as data URLs) are dropped rather
/// than failing the turn.
fn anthropic_part(part: &serde_json::Value) -> Option<serde_json::Value> {
    match part["type"].as_str() {
        Some("text") => Some(serde_json::json!({
            "type": "text", "text": part["text"].as_str().unwrap_or_default()
        })),
        Some("image_url") => {
            let (media_type, data) = parse_data_url(part["image_url"]["url"].as_str()?)?;
            Some(serde_json::json!({
                "type": "image",
                "source": { "type": "base64", "media_type": media_type, "data": data }
            }))
        }
        _ => None,
    }
}

// ---------------------------------------------------------------------------
// Gemini generateContent
// ---------------------------------------------------------------------------

/// Gemini generateContent body. Roles map user→"user", assistant→"model";
/// there is no system role, so system messages fold into the first user
/// turn's text under a "System instructions:" prefix. Sampling maps to
/// generationConfig's camelCase names — only the keys the user actually set.
pub(super) fn build_gemini_body(
    messages: &[ChatMessagePayload],
    sampling: Option<&serde_json::Map<String, serde_json::Value>>,
) -> serde_json::Value {
    let mut system_parts: Vec<String> = Vec::new();
    let mut contents: Vec<serde_json::Value> = Vec::new();
    for message in messages {
        if message.role == "system" {
            system_parts.push(content_text(&message.content));
            continue;
        }
        let role = if message.role == "assistant" { "model" } else { "user" };
        let parts: Vec<serde_json::Value> = match &message.content {
            serde_json::Value::Array(list) => list.iter().filter_map(gemini_part).collect(),
            other => vec![serde_json::json!({ "text": content_text(other) })],
        };
        contents.push(serde_json::json!({ "role": role, "parts": parts }));
    }
    if !system_parts.is_empty() {
        let prefix = format!("System instructions:\n{}\n\n", system_parts.join("\n\n"));
        prepend_to_first_user_text(&mut contents, &prefix);
    }

    let mut body = serde_json::json!({ "contents": contents });
    if let Some(s) = sampling {
        let mut config = serde_json::Map::new();
        for (from, to) in [
            ("temperature", "temperature"),
            ("top_p", "topP"),
            ("max_tokens", "maxOutputTokens"),
        ] {
            if let Some(v) = s.get(from) {
                config.insert(to.to_string(), v.clone());
            }
        }
        if !config.is_empty() {
            body.as_object_mut()
                .expect("literal object")
                .insert("generationConfig".into(), serde_json::Value::Object(config));
        }
    }
    body
}

/// Prefixes the first user turn's first text part (inserting one when that
/// turn is image-only, or a whole turn when the history has no user turn).
fn prepend_to_first_user_text(contents: &mut Vec<serde_json::Value>, prefix: &str) {
    for turn in contents.iter_mut() {
        if turn["role"].as_str() != Some("user") {
            continue;
        }
        if let Some(parts) = turn["parts"].as_array_mut() {
            if let Some(text_part) = parts.iter_mut().find(|p| p.get("text").is_some()) {
                let old = text_part["text"].as_str().unwrap_or_default();
                text_part["text"] = serde_json::Value::String(format!("{prefix}{old}"));
            } else {
                parts.insert(0, serde_json::json!({ "text": prefix }));
            }
        }
        return;
    }
    contents.insert(0, serde_json::json!({ "role": "user", "parts": [{ "text": prefix }] }));
}

fn gemini_part(part: &serde_json::Value) -> Option<serde_json::Value> {
    match part["type"].as_str() {
        Some("text") => Some(serde_json::json!({
            "text": part["text"].as_str().unwrap_or_default()
        })),
        Some("image_url") => {
            let (mime_type, data) = parse_data_url(part["image_url"]["url"].as_str()?)?;
            Some(serde_json::json!({ "inline_data": { "mime_type": mime_type, "data": data } }))
        }
        _ => None,
    }
}

// ---------------------------------------------------------------------------
// Small shared translators
// ---------------------------------------------------------------------------

/// Plain text of a message content — a string as-is, a parts array's text
/// parts joined. Used where the target format wants prose (system strings).
fn content_text(content: &serde_json::Value) -> String {
    match content {
        serde_json::Value::String(s) => s.clone(),
        serde_json::Value::Array(parts) => parts
            .iter()
            .filter_map(|p| p["text"].as_str())
            .collect::<Vec<_>>()
            .join("\n"),
        _ => String::new(),
    }
}

/// Splits `data:image/png;base64,XXX` into ("image/png", "XXX").
fn parse_data_url(url: &str) -> Option<(String, String)> {
    let rest = url.strip_prefix("data:")?;
    let (media_type, data) = rest.split_once(";base64,")?;
    Some((media_type.to_string(), data.to_string()))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn msg(role: &str, content: serde_json::Value) -> ChatMessagePayload {
        ChatMessagePayload { role: role.to_string(), content }
    }

    #[test]
    fn anthropic_body_folds_system_defaults_max_tokens_and_clamps_temp() {
        let messages = vec![
            msg("system", serde_json::json!("Be brief.")),
            msg("system", serde_json::json!("Use metric.")),
            msg("user", serde_json::json!("hi")),
            msg("assistant", serde_json::json!("hello")),
        ];
        let mut sampling = serde_json::Map::new();
        sampling.insert("temperature".into(), serde_json::json!(1.7));
        let body = build_anthropic_body("claude-x", &messages, Some(&sampling));
        assert_eq!(body["system"], serde_json::json!("Be brief.\n\nUse metric."));
        assert_eq!(body["max_tokens"], serde_json::json!(4096)); // mandatory default
        assert_eq!(body["temperature"], serde_json::json!(1.0)); // clamped from 1.7
        assert_eq!(body["stream"], serde_json::json!(true));
        let wire = body["messages"].as_array().unwrap();
        assert_eq!(wire.len(), 2); // system turns folded out of messages
        assert_eq!(wire[0]["role"], "user");
        assert_eq!(wire[0]["content"], "hi"); // strings pass through untouched

        // Vision: OpenAI parts → Anthropic base64 image source.
        let vision = vec![msg("user", serde_json::json!([
            { "type": "text", "text": "what is this" },
            { "type": "image_url", "image_url": { "url": "data:image/png;base64,QUJD" } },
        ]))];
        let body = build_anthropic_body("claude-x", &vision, None);
        let parts = body["messages"][0]["content"].as_array().unwrap();
        assert_eq!(parts[0], serde_json::json!({ "type": "text", "text": "what is this" }));
        assert_eq!(parts[1]["type"], "image");
        assert_eq!(parts[1]["source"]["media_type"], "image/png");
        assert_eq!(parts[1]["source"]["data"], "QUJD");
    }

    #[test]
    fn gemini_body_maps_roles_and_folds_system() {
        let messages = vec![
            msg("system", serde_json::json!("Always rhyme.")),
            msg("user", serde_json::json!("hi")),
            msg("assistant", serde_json::json!("yo")),
        ];
        let mut sampling = serde_json::Map::new();
        sampling.insert("temperature".into(), serde_json::json!(0.5));
        sampling.insert("max_tokens".into(), serde_json::json!(256));
        sampling.insert("frequency_penalty".into(), serde_json::json!(0.3)); // not a Gemini knob
        let body = build_gemini_body(&messages, Some(&sampling));
        let contents = body["contents"].as_array().unwrap();
        assert_eq!(contents.len(), 2); // system folded into the first user turn
        assert_eq!(contents[0]["role"], "user");
        assert_eq!(
            contents[0]["parts"][0]["text"],
            serde_json::json!("System instructions:\nAlways rhyme.\n\nhi")
        );
        assert_eq!(contents[1]["role"], "model"); // assistant renamed
        let config = body["generationConfig"].as_object().unwrap();
        assert_eq!(config["temperature"], serde_json::json!(0.5));
        assert_eq!(config["maxOutputTokens"], serde_json::json!(256));
        assert_eq!(config.len(), 2); // unknown knobs never reach the wire
    }
}
