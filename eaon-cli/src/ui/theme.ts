// Shared palette. Accent orange matches Eaon's brand mark across the macOS
// app and the Tauri build; the rest is a plain, readable dark-terminal set.

export const theme = {
  accent: "#F17455",
  assistant: "#ECECEC",
  user: "#8FD6FF",
  reasoning: "#8E8E9C",
  toolName: "#ECECEC",
  success: "#3FB950",
  error: "#FF6467",
  warning: "#E3B341",
  diffAdded: "#B9E6C3",
  diffRemoved: "#F3B8BD",
  /** Background fills for changed diff lines — the Claude-Code/Cursor look
   * (a solid tinted line, not just a colored +/-). Dark enough to keep
   * normal-weight text readable on truecolor terminals. */
  diffAddedBg: "#1C3A26",
  diffRemovedBg: "#42232A",
  muted: "#6E6E7A",
  border: "#3A3A42",
} as const;

export const PERMISSION_COLORS = {
  plan: "#6FD3FB",
  sandboxed: "#C7A6FF",
  auto: "#E3B341",
} as const;

export const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"] as const;

/** The pulsing star of the whole-turn working indicator — the same
 * breathe-in/breathe-out glyph rhythm Claude Code's own working line uses,
 * instead of a braille spinner (which reads as "loading a file", not
 * "thinking"). */
export const STAR_FRAMES = ["·", "✢", "✳", "✻", "✽", "✻", "✳", "✢"] as const;

/** Rotating verbs for the working line — one is picked per turn (not per
 * frame) so the line doesn't jitter, and the occasional variety keeps the
 * wait from feeling mechanical. */
export const WORKING_VERBS = ["Working", "Thinking", "Brewing", "Tinkering", "Considering"] as const;

export const MODE_LABEL: Record<string, string> = {
  chat: "Chat",
  agent: "Agent",
  claw: "Agent", // old sessions saved as claw resume into Agent
};
