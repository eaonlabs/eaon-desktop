// The live palette. Every component imports this object directly.
//
// It is deliberately ONE stable object whose fields are reassigned by
// `applyTheme`, rather than a value swapped out per render. ~20 components do
// `import { theme }` and read `theme.accent` at render time, so mutating in
// place means switching schemes is a single call instead of threading a context
// through all of them. Ink re-renders the whole tree from App, so a state bump
// there (see `subscribeTheme`) is enough to repaint with the new colours.
//
// The honest caveat: a mutable module-level palette would be wrong in anything
// serving more than one consumer. This is one process painting one terminal.

import { DEFAULT_THEME_NAME, resolveTheme, THEMES, type Theme } from "./themes.js";

/** Mutable so applyTheme can swap schemes; treat as read-only when rendering. */
export const theme: Theme = { ...resolveTheme(DEFAULT_THEME_NAME) };

let activeName: string = DEFAULT_THEME_NAME;
const listeners = new Set<() => void>();

export function activeThemeName(): string {
  return activeName;
}

/**
 * Repoint the palette at a named scheme. An unknown name falls back to the
 * default rather than throwing — a stale name in a config file should never be
 * the reason a terminal session fails to start.
 */
export function applyTheme(name: string | null | undefined): void {
  activeName = name && name in THEMES ? name : DEFAULT_THEME_NAME;
  Object.assign(theme, THEMES[activeName]);
  for (const fn of listeners) fn();
}

/** Called by App to repaint when the scheme changes. Returns an unsubscribe. */
export function subscribeTheme(fn: () => void): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

export const PERMISSION_COLORS = {
  plan: "#6FD3FB",
  sandboxed: "#C7A6FF",
  auto: "#E3B341",
} as const;

/** Braille spinner — used sparingly; the busy line prefers a steady •. */
export const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"] as const;

/** One Agent — chat/claw labels only appear on old saved sessions. */
export const MODE_LABEL: Record<string, string> = {
  chat: "Agent",
  agent: "Agent",
  claw: "Agent",
};
