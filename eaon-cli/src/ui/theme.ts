// Shared palette. Coral accent matches Eaon's brand mark across macOS and
// Tauri. Chrome stays quiet and monochrome so color always means something:
// accent = brand/focus, success/error/warning = outcome, permission colors =
// mode. Transcript rhythm borrows Claude Code / Cursor (● ⎿ dim echoes);
// the wordmark is the one loud identity moment.

export const theme = {
  /** Brand coral — wordmark bands, focus, interactive highlights. */
  accent: "#F17455",
  /** Soft coral for secondary brand moments (banner tips, soft fills). */
  accentSoft: "#F59A82",
  /** Deep coral for wordmark shadow / depth. */
  accentDeep: "#8B3A28",
  assistant: "#E8E8EE",
  user: "#8FD6FF",
  reasoning: "#7A7A88",
  toolName: "#E8E8EE",
  success: "#3FB950",
  error: "#FF6467",
  warning: "#E3B341",
  diffAdded: "#B9E6C3",
  diffRemoved: "#F3B8BD",
  diffAddedBg: "#1C3A26",
  diffRemovedBg: "#42232A",
  muted: "#6A6A76",
  border: "#3A3A44",
  /** Slightly warmer border for the composer when idle — reads as a soft
   * frame rather than a hard chrome line. */
  composerBorder: "#454550",
} as const;

export const PERMISSION_COLORS = {
  plan: "#6FD3FB",
  sandboxed: "#C7A6FF",
  auto: "#E3B341",
} as const;

export const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"] as const;

/** Pulsing star for the working line — Claude Code's breathe rhythm. */
export const STAR_FRAMES = ["·", "✢", "✳", "✻", "✽", "✻", "✳", "✢"] as const;

export const WORKING_VERBS = ["Working", "Thinking", "Brewing", "Tinkering", "Considering"] as const;

export const MODE_LABEL: Record<string, string> = {
  chat: "Chat",
  agent: "Agent",
  claw: "Agent", // old sessions saved as claw resume into Agent
};
