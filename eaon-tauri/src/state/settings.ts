// Settings store — every user preference, mirrored to state.json via the
// persist wiring. Appearance changes also stamp the DOM (data-theme +
// CSS variables) so the whole app restyles without re-render storms.

import { create } from "zustand";
import type { Settings } from "../core/types";
import { ACCENT_OPTIONS, DEFAULT_MONO_STACK, FONT_OPTIONS } from "../core/catalog";
import { DEFAULT_SETTINGS } from "../core/persistence";
import { setProxy } from "../core/ipc";

interface SettingsStore {
  settings: Settings;
  /** Replace everything (initial load). */
  hydrate: (settings: Settings) => void;
  /** Shallow-merge a patch — the one mutation path, so persistence and DOM
   *  side effects can't be forgotten at a call site. */
  update: (patch: Partial<Settings>) => void;
}

const CHAT_SIZES: Record<Settings["fontSize"], string> = {
  Small: "13px",
  Medium: "15px",
  Large: "17px",
};
const UI_SCALES: Record<Settings["fontSize"], string> = {
  Small: "0.9",
  Medium: "1",
  Large: "1.1",
};

function resolvedTheme(choice: Settings["theme"]): "dark" | "light" {
  if (choice === "System") {
    return window.matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark";
  }
  return choice === "Light" ? "light" : "dark";
}

/** Stamps theme/font/accent/size onto the document root. */
export function applyAppearance(settings: Settings): void {
  const root = document.documentElement;
  root.dataset.theme = resolvedTheme(settings.theme);
  root.style.setProperty("--chat-size", CHAT_SIZES[settings.fontSize]);
  root.style.setProperty("--ui-scale", UI_SCALES[settings.fontSize]);
  const accent = ACCENT_OPTIONS.find((a) => a.id === settings.accentColorId);
  root.style.setProperty("--accent", accent?.color ?? "#8E8E9C");
  const font = FONT_OPTIONS.find((f) => f.id === settings.fontId) ?? FONT_OPTIONS[0];
  root.style.setProperty("--font-sans", font.stack);
  // Choosing a monospaced face means the user wants a monospaced APP — code
  // included — the Mac app's "one font, one axis" behavior. A proportional
  // face leaves code on the mono default instead: picking Montserrat should
  // restyle the UI, not render diffs and terminal output proportionally.
  root.style.setProperty("--font-mono", font.kind === "mono" ? font.stack : DEFAULT_MONO_STACK);
}

// Re-apply on OS scheme change while in System mode.
window.matchMedia("(prefers-color-scheme: light)").addEventListener("change", () => {
  const { settings } = useSettings.getState();
  if (settings.theme === "System") applyAppearance(settings);
});

export const useSettings = create<SettingsStore>((set, get) => ({
  settings: structuredClone(DEFAULT_SETTINGS),
  hydrate: (settings) => {
    set({ settings });
    applyAppearance(settings);
    void setProxy(settings.proxyEnabled ? settings.proxyUrl : null);
  },
  update: (patch) => {
    const next = { ...get().settings, ...patch };
    set({ settings: next });
    if (
      "theme" in patch ||
      "fontSize" in patch ||
      "accentColorId" in patch ||
      "fontId" in patch
    ) {
      applyAppearance(next);
    }
    if ("proxyEnabled" in patch || "proxyUrl" in patch) {
      void setProxy(next.proxyEnabled ? next.proxyUrl : null);
    }
  },
}));
