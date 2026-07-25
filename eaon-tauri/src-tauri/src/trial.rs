// The Free Week trial — minting, HMAC request signing, and the status/gift
// lookups (port of the Mac app's FreeWeekTrial.swift). Security model,
// stated plainly: the app never holds a real provider key. It holds a
// device-bound, expiring, revocable trial credential that only works
// against Eaon's own gateway, which attaches the real upstream keys
// server-side — extracting the credential from a device buys an attacker
// at most that device's own capped week, nothing else.

use serde::Serialize;
use tauri::Manager;

/// Eaon's own gateway — NOT the user-key hosted endpoint. Real provider
/// keys live only behind it.
const TRIAL_BASE_URL: &str = "https://api.eaon.dev/v1";

/// Hex SHA-256 of a request body — half of the trial signature input.
pub fn body_sha256_hex(body: &[u8]) -> String {
    use sha2::{Digest, Sha256};
    hex::encode(Sha256::digest(body))
}

/// The Free Week request signature: hex HMAC-SHA256 over
/// `"<ts>.<deviceHash>.<sha256hex(body)>"` keyed by the trial secret —
/// exactly the Mac app's FreeWeekTrial recipe, so the gateway can't tell
/// the platforms apart by auth shape.
pub fn signature(secret: &str, device: &str, ts: i64, body_hash_hex: &str) -> String {
    use hmac::{Hmac, Mac};
    use sha2::Sha256;
    let mut mac = Hmac::<Sha256>::new_from_slice(secret.as_bytes())
        .expect("HMAC accepts any key length");
    mac.update(format!("{ts}.{device}.{body_hash_hex}").as_bytes());
    hex::encode(mac.finalize().into_bytes())
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TrialStartResult {
    pub key: String,
    pub secret: String,
    pub expires_at: i64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TrialStatusResult {
    pub active: bool,
    pub expires_at: Option<i64>,
    pub total_requests: Option<u64>,
    pub revoked_code: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TrialGiftStatus {
    pub claimed: u64,
    pub total: u64,
    pub remaining: u64,
    pub expires_at: Option<i64>,
    pub available: bool,
    pub support_email: Option<String>,
}

// ---------------------------------------------------------------------------
// Device identity
// ---------------------------------------------------------------------------

/// The strongest stable per-machine identifier each OS offers. Only ever
/// hashed before leaving the device (see `device_hash`); the raw id goes
/// nowhere.
fn machine_id(app: &tauri::AppHandle) -> Result<String, String> {
    #[cfg(windows)]
    {
        if let Some(id) = windows_machine_guid() {
            return Ok(id);
        }
    }
    #[cfg(target_os = "linux")]
    {
        if let Some(id) = linux_machine_id() {
            return Ok(id);
        }
    }
    // macOS dev builds and any machine whose OS identifier is unreadable:
    // a random UUID persisted in the app data dir — the counterpart of the
    // Mac app's eaon_free_week_device_salt fallback.
    let dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    persisted_salt(&dir)
}

/// Windows carries a stable per-install GUID in the registry — the
/// conventional machine identity for installers that don't do telemetry.
#[cfg(windows)]
fn windows_machine_guid() -> Option<String> {
    use winreg::enums::HKEY_LOCAL_MACHINE;
    use winreg::RegKey;
    let key = RegKey::predef(HKEY_LOCAL_MACHINE)
        .open_subkey("SOFTWARE\\Microsoft\\Cryptography")
        .ok()?;
    let guid: String = key.get_value("MachineGuid").ok()?;
    let trimmed = guid.trim();
    (!trimmed.is_empty()).then(|| trimmed.to_string())
}

/// systemd's machine id, with the older dbus location as a fallback for
/// distros that predate the merge. The file ends in a newline — trim it,
/// or the device hash would differ from the same id read elsewhere.
#[cfg(target_os = "linux")]
fn linux_machine_id() -> Option<String> {
    for path in ["/etc/machine-id", "/var/lib/dbus/machine-id"] {
        if let Ok(contents) = std::fs::read_to_string(path) {
            let trimmed = contents.trim();
            if !trimmed.is_empty() {
                return Some(trimmed.to_string());
            }
        }
    }
    None
}

/// Read-or-create the random fallback id. Takes the directory rather than
/// the app handle so tests can exercise it against a temp dir without a
/// running Tauri app.
fn persisted_salt(dir: &std::path::Path) -> Result<String, String> {
    std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    let path = dir.join("device-salt");
    if let Ok(existing) = std::fs::read_to_string(&path) {
        let trimmed = existing.trim();
        if !trimmed.is_empty() {
            return Ok(trimmed.to_string());
        }
    }
    let fresh = uuid::Uuid::new_v4().to_string();
    std::fs::write(&path, &fresh).map_err(|e| e.to_string())?;
    Ok(fresh)
}

/// SHA-256("eaon-free-week-v2:" + machine id) — the only device identity
/// that ever crosses the wire. Domain-prefixed so this hash can't be
/// correlated with the same machine id hashed by any other software.
fn device_hash(machine_id: &str) -> String {
    body_sha256_hex(format!("eaon-free-week-v2:{machine_id}").as_bytes())
}

#[tauri::command]
pub fn trial_device_hash(app: tauri::AppHandle) -> Result<String, String> {
    Ok(device_hash(&machine_id(&app)?))
}

// ---------------------------------------------------------------------------
// Gateway calls
// ---------------------------------------------------------------------------

/// The gateway wraps payloads as `{data: {...}}` (its trial.js style);
/// tolerate a flat body too so a server-side simplification can't strand
/// shipped clients.
fn payload_of(json: &serde_json::Value) -> &serde_json::Value {
    match json.get("data") {
        Some(data) if data.is_object() => data,
        _ => json,
    }
}

/// Best-effort extraction of the gateway's human-facing error, falling
/// back to the bare status — never invents a reason the server didn't
/// give.
fn server_message(json: &serde_json::Value, status: u16) -> String {
    json["error"]["message"]
        .as_str()
        .or_else(|| json["error"].as_str())
        .or_else(|| json["message"].as_str())
        .map(str::to_string)
        .unwrap_or_else(|| format!("The trial server returned HTTP {status}."))
}

fn unix_now() -> i64 {
    // A pre-1970 clock yields 0; the gateway then rejects the stale
    // timestamp and the UI reports it — better than a panic in a signer.
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

/// Activate (or recover) this device's free week — one network call, no
/// account. The server is idempotent per device: a re-mint rotates the
/// credential in place and never extends the original week.
#[tauri::command]
pub async fn trial_start(app: tauri::AppHandle) -> Result<TrialStartResult, String> {
    let device = device_hash(&machine_id(&app)?);
    let version = app.package_info().version.to_string();
    // Honest compile-time platform tag — the gateway gates the rollout per
    // platform and its refusal message is shown to the user verbatim.
    let platform = if cfg!(target_os = "windows") {
        "windows"
    } else if cfg!(target_os = "linux") {
        "linux"
    } else {
        "macos"
    };
    let response = crate::net::http_client(Some(30))
        .post(format!("{TRIAL_BASE_URL}/trial/start"))
        .header("X-Eaon-Client", format!("eaon-desktop/{version}"))
        .json(&serde_json::json!({
            "device": device,
            "platform": platform,
            "app_version": version,
        }))
        .send()
        .await
        .map_err(|e| format!("Couldn't reach eaon.dev — check your connection. ({e})"))?;

    let status = response.status().as_u16();
    let json: serde_json::Value = response.json().await.unwrap_or(serde_json::Value::Null);
    // The gateway minted with 201 historically; accept a plain 200 too so
    // an idempotent "already minted" answer keeps working.
    if status != 201 && status != 200 {
        // Surface the gateway's own words (e.g. "not available on this
        // platform yet") — no fake trial state, no invented reasons.
        return Err(server_message(&json, status));
    }
    let payload = payload_of(&json);
    let (Some(key), Some(secret)) = (payload["key"].as_str(), payload["secret"].as_str()) else {
        return Err("The trial server sent an unexpected response — try again in a moment.".into());
    };
    let Some(expires_at) = payload.get("expires_at").and_then(parse_expires_at) else {
        return Err("The trial server sent an unexpected response — try again in a moment.".into());
    };
    Ok(TrialStartResult { key: key.to_string(), secret: secret.to_string(), expires_at })
}

/// Usage/expiry snapshot for the settings card — and how the app discovers
/// a server-side revocation. Signed like every trial request; a GET has no
/// body, so the body-hash half of the signature is the hash of zero bytes.
#[tauri::command]
pub async fn trial_status(device: String, secret: String) -> Result<TrialStatusResult, String> {
    let ts = unix_now();
    let sig = signature(&secret, &device, ts, &body_sha256_hex(b""));
    let response = crate::net::http_client(Some(30))
        .get(format!("{TRIAL_BASE_URL}/trial/status"))
        .header("X-Eaon-Device", &device)
        .header("X-Eaon-TS", ts.to_string())
        .header("X-Eaon-Sig", sig)
        .send()
        .await
        .map_err(|e| format!("Couldn't reach eaon.dev — check your connection. ({e})"))?;

    let status = response.status().as_u16();
    let json: serde_json::Value = response.json().await.unwrap_or(serde_json::Value::Null);

    // Revocation is an answer, not an error: the caller clears the stored
    // credential and the UI falls back honestly (mirrors the Mac app's
    // refreshStatus()).
    if let Some(code) = json["error"]["code"].as_str().or_else(|| json["code"].as_str()) {
        if code == "trial_revoked" || code == "trial_invalid" {
            return Ok(TrialStatusResult {
                active: false,
                expires_at: None,
                total_requests: None,
                revoked_code: Some(code.to_string()),
            });
        }
    }
    if !(200..300).contains(&status) {
        return Err(server_message(&json, status));
    }
    let payload = payload_of(&json);
    Ok(TrialStatusResult {
        // A 2xx means the credential validated; only an explicit
        // `active: false` from the server overrides that.
        active: payload["active"].as_bool().unwrap_or(true),
        expires_at: payload.get("expires_at").and_then(parse_expires_at),
        // The gateway has called this figure both names across versions.
        total_requests: payload["total_requests"].as_u64().or_else(|| payload["usage"].as_u64()),
        revoked_code: None,
    })
}

/// Live snapshot of the "first 100" launch gift — public and unsigned on
/// the gateway side: there's no credential to check before someone has
/// even decided whether to redeem.
#[tauri::command]
pub async fn trial_gift() -> Result<TrialGiftStatus, String> {
    let response = crate::net::http_client(Some(30))
        .get(format!("{TRIAL_BASE_URL}/trial/gift"))
        .send()
        .await
        .map_err(|e| format!("Couldn't reach eaon.dev: {e}"))?;
    let status = response.status().as_u16();
    let json: serde_json::Value = response.json().await.unwrap_or(serde_json::Value::Null);
    if !(200..300).contains(&status) {
        return Err(server_message(&json, status));
    }
    let payload = payload_of(&json);
    // Defensive mapping: a missing count reads as zero and a missing
    // `available` as false — the Gifts card must never claim the offer is
    // open on a half-parsed answer.
    Ok(TrialGiftStatus {
        claimed: payload["claimed"].as_u64().unwrap_or(0),
        total: payload["total"].as_u64().unwrap_or(0),
        remaining: payload["remaining"].as_u64().unwrap_or(0),
        expires_at: payload.get("expires_at").and_then(parse_expires_at),
        available: payload["available"].as_bool().unwrap_or(false),
        support_email: payload["support_email"].as_str().map(str::to_string),
    })
}

// ---------------------------------------------------------------------------
// expires_at parsing
// ---------------------------------------------------------------------------

/// The gateway has emitted both epoch seconds and `Date.toISOString()`
/// strings for `expires_at` across versions — accept either so a gateway
/// deploy never strands shipped clients on a parse failure.
fn parse_expires_at(value: &serde_json::Value) -> Option<i64> {
    if let Some(n) = value.as_i64() {
        return Some(n);
    }
    if let Some(f) = value.as_f64() {
        return Some(f as i64);
    }
    let s = value.as_str()?.trim();
    if let Ok(n) = s.parse::<i64>() {
        return Some(n);
    }
    parse_iso_utc(s)
}

/// Minimal "YYYY-MM-DDTHH:MM:SS" (UTC) parser. Fractional seconds and the
/// trailing zone tag are ignored — the gateway only ever emits `Z`, and a
/// whole calendar dependency for one timestamp field isn't worth it.
fn parse_iso_utc(s: &str) -> Option<i64> {
    let b = s.as_bytes();
    if b.len() < 19
        || b[4] != b'-'
        || b[7] != b'-'
        || (b[10] != b'T' && b[10] != b' ')
        || b[13] != b':'
        || b[16] != b':'
    {
        return None;
    }
    let field = |from: usize, to: usize| -> Option<i64> {
        let text = std::str::from_utf8(&b[from..to]).ok()?;
        if !text.bytes().all(|c| c.is_ascii_digit()) {
            return None;
        }
        text.parse::<i64>().ok()
    };
    let (year, month, day) = (field(0, 4)?, field(5, 7)?, field(8, 10)?);
    let (hour, minute, second) = (field(11, 13)?, field(14, 16)?, field(17, 19)?);
    if !(1..=12).contains(&month) || !(1..=31).contains(&day) || hour > 23 || minute > 59 || second > 60 {
        return None;
    }
    Some(days_from_civil(year, month, day) * 86_400 + hour * 3_600 + minute * 60 + second)
}

/// Days since 1970-01-01 for a civil date (Howard Hinnant's civil-days
/// algorithm) — exact for every Gregorian date, leap years included.
fn days_from_civil(year: i64, month: i64, day: i64) -> i64 {
    let y = if month <= 2 { year - 1 } else { year };
    let era = if y >= 0 { y } else { y - 399 } / 400;
    let yoe = y - era * 400;
    let doy = (153 * (if month > 2 { month - 3 } else { month + 9 }) + 2) / 5 + day - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146_097 + doe - 719_468
}

// ---------------------------------------------------------------------------
// Tests. None of these ever touch the network: minting against production
// from a dev loop would burn real one-per-machine trials. The signature
// math is pinned to a fixed vector instead.
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::{body_sha256_hex, parse_expires_at, persisted_salt, signature};

    #[test]
    fn signature_matches_pinned_vector() {
        let body_hash = body_sha256_hex(b"");
        // SHA-256 of zero bytes — the constant every GET signature uses.
        assert_eq!(body_hash, "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
        let sig = signature("secret", "device", 1_700_000_000, &body_hash);
        // Pinned so any drift in the "<ts>.<device>.<bodyhash>" recipe —
        // which would silently lock every client out of the gateway —
        // fails here first. Vector computed independently (python hmac
        // and openssl agree).
        assert_eq!(sig, "0285b0ecf107ad5d7f56e7c79db9598752c75a48209369a080cb44a5c7432562");
        assert_eq!(sig, signature("secret", "device", 1_700_000_000, &body_hash));
        assert_eq!(sig.len(), 64);
        assert!(sig.chars().all(|c| c.is_ascii_hexdigit() && !c.is_ascii_uppercase()));
    }

    #[test]
    fn salt_fallback_creates_then_rereads_the_same_id() {
        let dir = std::env::temp_dir().join(format!("eaon-trial-salt-test-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);

        let first = persisted_salt(&dir).expect("create salt");
        assert!(!first.is_empty());
        // Stability is the whole point: the device hash must not change
        // between launches.
        assert_eq!(persisted_salt(&dir).expect("reread salt"), first);

        // Stored value is read back trimmed, so a stray newline in the
        // file can never alter the device hash.
        std::fs::write(dir.join("device-salt"), format!("  {first}\n")).unwrap();
        assert_eq!(persisted_salt(&dir).expect("trimmed reread"), first);

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn expires_at_accepts_unix_and_iso() {
        // Epoch seconds, as a number and as a numeric string.
        assert_eq!(parse_expires_at(&serde_json::json!(1_700_000_000)), Some(1_700_000_000));
        assert_eq!(parse_expires_at(&serde_json::json!("1700000000")), Some(1_700_000_000));
        // ISO-8601 UTC — with and without the fractional part
        // Date.toISOString() emits.
        assert_eq!(parse_expires_at(&serde_json::json!("2023-11-14T22:13:20Z")), Some(1_700_000_000));
        assert_eq!(parse_expires_at(&serde_json::json!("2023-11-14T22:13:20.123Z")), Some(1_700_000_000));
        assert_eq!(parse_expires_at(&serde_json::json!("1970-01-01T00:00:00Z")), Some(0));
        // Garbage must read as "unknown", never as some accidental date.
        assert_eq!(parse_expires_at(&serde_json::json!("definitely not a date")), None);
        assert_eq!(parse_expires_at(&serde_json::Value::Null), None);
    }
}
