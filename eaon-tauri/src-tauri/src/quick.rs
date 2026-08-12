// The Quick Assistant — a floating always-on-top panel summoned by a global
// hotkey from anywhere on the machine. The port of the Mac app's
// DesktopAssistant / QuickAssistantPanelView.
//
// The window itself is declared in tauri.conf.json (label "quick", hidden,
// always-on-top, no decorations, off the taskbar); this module owns the
// hotkey and the show/hide behaviour.
//
// No tray icon on purpose. Tauri's tray needs libayatana-appindicator3-dev
// present at BUILD time on Linux, and adding that silently breaks the
// existing Linux release job until CI installs it. The hotkey is the part
// that carries the feature; a tray entry can follow once CI is updated.

use tauri::{AppHandle, Manager, WebviewWindow};

/// Ctrl+Shift+Space — deliberately not a bare Ctrl+Space, which conflicts
/// with IME switching on Windows and with completion in most editors.
pub const QUICK_HOTKEY: &str = "CmdOrCtrl+Shift+Space";

pub const QUICK_LABEL: &str = "quick";

fn quick_window(app: &AppHandle) -> Option<WebviewWindow> {
    app.get_webview_window(QUICK_LABEL)
}

/// Summons the panel, or dismisses it if it is already up. Toggling on the
/// same chord is what makes the hotkey feel like a spotlight rather than a
/// launcher: the key that opened it also puts it away.
pub fn toggle(app: &AppHandle) {
    let Some(window) = quick_window(app) else { return };
    let visible = window.is_visible().unwrap_or(false);
    // `is_focused` matters as much as visibility: a panel sitting behind the
    // window you are working in should come FORWARD on the hotkey, not
    // vanish, which is what a visibility-only toggle would do.
    let focused = window.is_focused().unwrap_or(false);
    if visible && focused {
        let _ = window.hide();
    } else {
        show(app);
    }
}

pub fn show(app: &AppHandle) {
    let Some(window) = quick_window(app) else { return };
    let _ = window.center();
    let _ = window.show();
    let _ = window.set_focus();
}

pub fn hide(app: &AppHandle) {
    if let Some(window) = quick_window(app) {
        let _ = window.hide();
    }
}

/// Called from the frontend when the panel should dismiss itself (Esc, or
/// after handing a question off to the main window).
#[tauri::command]
pub fn quick_hide(app: AppHandle) {
    hide(&app);
}

#[tauri::command]
pub fn quick_show(app: AppHandle) {
    show(&app);
}

/// The chord to display in Settings, so the UI never hardcodes a second copy
/// that can drift from what is actually registered.
#[tauri::command]
pub fn quick_hotkey() -> String {
    QUICK_HOTKEY.to_string()
}

/// Registers the global hotkey. Failure is non-fatal and deliberately quiet:
/// another app may already own this chord, and that must not stop Eaon from
/// launching — the panel is still reachable from the main window.
pub fn register_hotkey(app: &AppHandle) {
    use tauri_plugin_global_shortcut::{Code, Modifiers, Shortcut, ShortcutState};

    let shortcut = Shortcut::new(
        Some(Modifiers::CONTROL | Modifiers::SHIFT),
        Code::Space,
    );

    let handle = app.clone();
    if let Err(error) = app.plugin(
        tauri_plugin_global_shortcut::Builder::new()
            .with_handler(move |_app, _shortcut, event| {
                // Fire on press only — without this the panel toggles twice
                // per keypress (down and up) and appears not to open at all.
                if event.state() == ShortcutState::Pressed {
                    toggle(&handle);
                }
            })
            .with_shortcut(shortcut)
            .expect("the quick-assistant chord should be a valid shortcut")
            .build(),
    ) {
        eprintln!("[quick] global hotkey unavailable ({error}) — the panel is still reachable from the app window");
    }
}
