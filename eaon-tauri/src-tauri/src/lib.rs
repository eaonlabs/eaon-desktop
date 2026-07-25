// Eaon's Rust core. All network I/O and disk persistence live here, not in
// the webview: the frontend calls these commands and streamed tokens come
// back over Tauri `Channel`s. The webview's CSP allows no outbound requests
// at all, so this boundary is enforced, not just conventional.

/// Outbound HTTP plumbing — the shared client factory and the user's
/// optional proxy, applied to every provider/search/image request.
mod net;

/// Chat streaming and one-shot completions across all three BYOK wire
/// formats (OpenAI-compatible, Anthropic Messages, Gemini) plus the hosted
/// gateway's trial-signed variant.
mod chat;

/// Ollama management — installed-model list, pulls with live progress,
/// verified deletes.
mod ollama;

/// Provider model listing and generic text fetches (skills, update manifest).
mod providers;

/// Web search — MIKLIUM's keyless search API.
mod search;

/// Image generation — every wire shape the Mac app speaks.
mod images;

/// Attachments — user files/images stored under the app data dir.
mod attachments;

/// Persistence — the single state.json blob, written atomically.
mod storage;

/// Skills — scanning this PC's Claude Code skills folder for import.
mod skills;

/// Hardware specs — RAM/cores/OS for the Models page fit estimates.
mod specs;

/// Free Week trial — minting, HMAC request signing, status and gift lookups.
mod trial;

/// Agent mode's tools (write/edit/read/run/search/…) with the safety model:
/// writes confined to the user's space, no privilege escalation, timeouts.
mod tools;

/// The Local API Server — a loopback OpenAI-compatible endpoint other tools
/// can point at, proxying to the user's configured providers.
mod server;

/// MCP plugins — Model Context Protocol clients over Streamable HTTP and
/// local stdio processes.
mod mcp;

/// OAuth 2.1 sign-in for MCP plugins that require it (discovery, Dynamic
/// Client Registration, PKCE, the loopback redirect listener).
mod mcp_oauth;

/// Eaon CLI install + credential linking — copies the bundled `eaon-cli`
/// payload to a writable location, links a global `eaon` command, and
/// merges this app's saved API keys into the CLI's own config.json.
mod eaon_cli;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        // single-instance must be first so a second launch focuses the
        // existing window instead of racing plugin setup.
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            use tauri::Manager;
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.show();
                let _ = window.unminimize();
                let _ = window.set_focus();
            }
        }))
        .plugin(tauri_plugin_window_state::Builder::default().build())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .invoke_handler(tauri::generate_handler![
            net::set_proxy,
            chat::chat_stream,
            chat::chat_complete,
            chat::cancel_stream,
            ollama::ollama_tags,
            ollama::ollama_pull,
            ollama::ollama_delete,
            providers::fetch_provider_models,
            providers::fetch_text_url,
            search::web_search,
            images::generate_image,
            attachments::save_attachment,
            attachments::read_attachment,
            storage::load_app_state,
            storage::save_app_state,
            storage::app_data_dir_path,
            skills::scan_claude_skills,
            specs::system_specs,
            trial::trial_start,
            trial::trial_status,
            trial::trial_gift,
            trial::trial_device_hash,
            tools::run_agent_tool,
            server::start_local_server,
            server::stop_local_server,
            server::local_server_running,
            mcp::mcp_connect,
            mcp::mcp_call,
            mcp::mcp_disconnect,
            mcp_oauth::mcp_oauth_connect,
            eaon_cli::eaon_cli_status,
            eaon_cli::eaon_cli_install,
            eaon_cli::eaon_cli_link_credentials
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
