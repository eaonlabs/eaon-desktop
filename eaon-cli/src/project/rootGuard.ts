// Detects launch roots that are never a real coding project — home and
// filesystem root. Exploring those with list/grep/glob is how "hi" turned
// into a full-home raid; tools refuse explore there and the UI warns.

import os from "node:os";
import path from "node:path";

/** True when `cwd` is the user's home directory or a filesystem root. */
export function isUnsafeProjectRoot(cwd: string): boolean {
  let resolved: string;
  try {
    resolved = path.resolve(cwd);
  } catch {
    return true;
  }
  const home = path.resolve(os.homedir());
  if (resolved === home) return true;
  // Unix root, or Windows drive root (C:\).
  const parsed = path.parse(resolved);
  if (resolved === parsed.root) return true;
  return false;
}

/** Short reason for prompts / tool errors / banner. */
export function unsafeRootReason(cwd: string): string {
  let resolved: string;
  try {
    resolved = path.resolve(cwd);
  } catch {
    return "the current directory";
  }
  const home = path.resolve(os.homedir());
  if (resolved === home) return "your home folder (~)";
  return "the filesystem root";
}

export function unsafeRootToolError(cwd: string): string {
  const where = unsafeRootReason(cwd);
  return `Explore tools are disabled here — the project root is ${where}, not a project. Ask the user to \`cd\` into a real project (or relaunch with \`eaon --cwd <path>\`), then try again. Do not list or search the whole home directory.`;
}
