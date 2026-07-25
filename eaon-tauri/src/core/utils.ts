// Small shared helpers with no dependencies.

/** Collision-safe id: time base36 + 8 random chars. */
export function uid(): string {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 10);
}

/** Conversation auto-title from the first user message — 42 chars, cut at a
 *  word boundary, whitespace collapsed (matches the Mac deriveTitle). */
export function deriveTitle(text: string): string {
  const flat = text.replace(/\s+/g, " ").trim();
  if (!flat) return "New chat";
  if (flat.length <= 42) return flat;
  const cut = flat.slice(0, 42);
  const lastSpace = cut.lastIndexOf(" ");
  return (lastSpace > 24 ? cut.slice(0, lastSpace) : cut) + "…";
}

/** "3.2 GB" style byte formatting. */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  const power = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  const value = bytes / 1024 ** power;
  return `${value >= 10 || power === 0 ? Math.round(value) : value.toFixed(1)} ${units[power]}`;
}

/** ~4 chars/token — the same estimator the Mac context badge uses. */
export function estimateTokens(chars: number): number {
  return Math.ceil(chars / 4);
}

/** Ctrl on Windows/Linux (the platforms this app ships to). */
export function shortcutLabel(key: string): string {
  return `Ctrl+${key}`;
}

/** Date-bucket label for the sidebar (Today/Yesterday/…/by month). */
export function dateBucket(timestamp: number, now: number = Date.now()): string {
  const day = 24 * 60 * 60 * 1000;
  const startOfToday = new Date(now).setHours(0, 0, 0, 0);
  if (timestamp >= startOfToday) return "Today";
  if (timestamp >= startOfToday - day) return "Yesterday";
  if (timestamp >= startOfToday - 7 * day) return "Previous 7 Days";
  if (timestamp >= startOfToday - 30 * day) return "Previous 30 Days";
  return new Date(timestamp).toLocaleDateString(undefined, { month: "long", year: "numeric" });
}
