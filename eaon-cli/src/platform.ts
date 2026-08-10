// Every OS-specific decision in the whole CLI lives here — nowhere else
// should branch on process.platform directly, so a cross-platform gap is
// easy to audit for by grepping this one file.

import os from "node:os";
import path from "node:path";

export const isWindows = process.platform === "win32";
export const isMac = process.platform === "darwin";
export const isLinux = process.platform === "linux";

export function homeDir(): string {
  return os.homedir();
}

/**
 * Where settings, sessions and the request log live.
 *
 * `EAON_CONFIG_DIR` overrides it. That exists for two real cases beyond tests:
 * running more than one identity on a shared machine, and running on a box where
 * `$HOME` is not writable (some CI images, some locked-down servers) — both of
 * which otherwise fail at the first config write with nothing to do about it.
 */
export function configDir(): string {
  const override = process.env.EAON_CONFIG_DIR;
  if (override && override.trim()) return path.resolve(override.trim());
  return path.join(homeDir(), ".eaon", "cli");
}

/**
 * Whether this session can hand a URL to a desktop browser.
 *
 * False over SSH, in a container, or on a headless box — where `open()` either
 * fails or, worse, appears to succeed while launching a browser on a machine
 * nobody is looking at. In that case the URL is printed for the user to carry
 * across themselves, which is the only thing that can work.
 *
 * `EAON_NO_BROWSER=1` forces it off explicitly.
 */
export function canOpenBrowser(): boolean {
  if (process.env.EAON_NO_BROWSER) return false;
  if (isMac || isWindows) return true;
  // On Linux a graphical session is what makes xdg-open meaningful.
  return Boolean(process.env.DISPLAY || process.env.WAYLAND_DISPLAY);
}

/** True when the session looks remote, so copy can say so rather than guess. */
export function isRemoteSession(): boolean {
  return Boolean(process.env.SSH_CONNECTION || process.env.SSH_TTY);
}

export function sessionsDir(): string {
  return path.join(configDir(), "sessions");
}

/** The real OS temp dir (macOS: a per-process /var/folders/.../T path, not
 * literally /tmp — resolved via realpath in the path guard, not assumed). */
export function tempDir(): string {
  return os.tmpdir();
}

/** How to invoke a shell command on this OS, matching Node's own
 * child_process.exec conventions so behavior is unsurprising. */
export function shellInvocation(command: string): { cmd: string; args: string[] } {
  if (isWindows) {
    return { cmd: process.env.COMSPEC || "cmd.exe", args: ["/d", "/s", "/c", command] };
  }
  const shell = process.env.SHELL && process.env.SHELL.length > 0 ? process.env.SHELL : "/bin/bash";
  return { cmd: shell, args: ["-c", command] };
}

/** Extra PATH entries a GUI-less launch can still miss on each OS (Homebrew
 * on Apple Silicon, user-local pip/npm bins). Mirrors LocalAIManager's
 * resolveBinary search list. Deduped by the caller against the real PATH. */
export function extraPathEntries(): string[] {
  if (isWindows) return [];
  const home = homeDir();
  return ["/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", path.join(home, ".local", "bin")];
}

export function platformLabel(): string {
  if (isMac) return "macOS";
  if (isWindows) return "Windows";
  if (isLinux) return "Linux";
  return process.platform;
}
