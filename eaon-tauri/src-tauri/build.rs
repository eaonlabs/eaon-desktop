fn main() {
    // tauri::generate_context!() embeds ../dist into the binary at compile
    // time, but cargo's own change detection only watches this crate's
    // sources — a frontend-only edit (no Rust file touched) can leave cargo
    // thinking there's nothing to rebuild, silently shipping a stale
    // embedded UI. Watching the whole dist tree (Vite's content-hashed
    // filenames mean the directory's entries change on any real edit)
    // forces a rebuild whenever the frontend actually changed.
    println!("cargo:rerun-if-changed=../dist");
    tauri_build::build()
}
