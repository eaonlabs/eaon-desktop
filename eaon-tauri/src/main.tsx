import React from "react";
import ReactDOM from "react-dom/client";
import { getCurrentWindow } from "@tauri-apps/api/window";
import App from "./App";
import QuickPanel from "./ui/quick/QuickPanel";
import "./styles/tokens.css";
import "./styles/fonts.css";
import "./styles/base.css";
import "./styles/markdown.css";
import "./ui/quick/quick.css";

// Both windows load this same bundle; the label decides which app is mounted.
// The Quick Assistant is a separate root rather than a route inside App so it
// never pays for the sidebar, the conversation store hydration, or settings.
const isQuickPanel = getCurrentWindow().label === "quick";
if (isQuickPanel) document.documentElement.dataset.window = "quick";

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>{isQuickPanel ? <QuickPanel /> : <App />}</React.StrictMode>,
);
