import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Tauri expects a fixed dev port; clearScreen off keeps Rust build output
// visible in the same terminal during `tauri dev`.
export default defineConfig({
  plugins: [react()],
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
  },
  envPrefix: ["VITE_", "TAURI_ENV_"],
  build: {
    // WebView2 (Win) and WebKitGTK (Linux) are both evergreen enough for
    // modern output; es2022 keeps async/await untranspiled.
    target: "es2022",
    sourcemap: false,
  },
});
