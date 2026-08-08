// Code-search tools: grep (regex over file contents) and glob (find files
// by name pattern). These are what turn "an agent with write_file" into an
// actual coding agent — without them the model has to guess where things
// live or list directories one at a time. Both are pure-Node walkers (no
// external ripgrep dependency to install), read-only, and skip the
// directories that are never what you're looking for and always enormous
// (node_modules, .git, build output).

import fs from "node:fs";
import path from "node:path";
import type { ToolResult } from "../types.js";
import { normalizePath, type PathGuardContext } from "./pathGuard.js";
import { isUnsafeProjectRoot, unsafeRootToolError } from "../project/rootGuard.js";

const SKIP_DIRS = new Set([
  "node_modules", ".git", ".hg", ".svn", "dist", "build", ".next", ".nuxt",
  "target", ".build", ".venv", "venv", "__pycache__", ".cache", ".DS_Store",
  "coverage", ".turbo", ".output", "DerivedData", "Pods",
  "site-packages", "tf-env", ".cargo", ".bun", ".npm", ".android", "Library",
  ".local", ".tox", ".conda", "conda-meta", ".mamba", ".pyenv", ".rbenv",
  ".nvm", ".sdkman", ".gradle", ".m2", ".ivy2", "vendor", "bower_components",
  ".pnpm-store", ".yarn", ".parcel-cache", ".svelte-kit", "out", "tmp", "temp",
  ".Trash", "Applications", "Movies", "Music", "Pictures", "Public",
]);

/** Dot-dirs worth searching (CI / project config). Everything else starting
 * with `.` is skip — home trees are full of .android/.cargo/.cache noise. */
const SEARCHABLE_DOT_DIRS = new Set([".github", ".gitlab", ".circleci", ".vscode", ".idea", ".eaon"]);

/** Extra skip for env-ish folder names that aren't in the fixed set. */
function shouldSkipDir(name: string): boolean {
  if (SKIP_DIRS.has(name)) return true;
  if (name.startsWith(".") && !SEARCHABLE_DOT_DIRS.has(name)) return true;
  if (name.endsWith("-env") || name.endsWith("_env")) return true;
  if (name.startsWith("venv") || name.endsWith("venv")) return true;
  if (name.startsWith("conda") || name.endsWith("conda")) return true;
  return false;
}

const MAX_FILE_BYTES = 2 * 1024 * 1024; // skip files bigger than 2 MB — binaries/bundles, not source
const MAX_RESULTS = 200;
const MAX_SCANNED_FILES = 20_000;

function looksBinary(buf: Buffer): boolean {
  const len = Math.min(buf.length, 512);
  for (let i = 0; i < len; i++) if (buf[i] === 0) return true;
  return false;
}

/** Depth-first file walk rooted at `root`, skipping the noise dirs. */
function* walkFiles(root: string): Generator<string> {
  const stack = [root];
  let scanned = 0;
  while (stack.length > 0) {
    const dir = stack.pop()!;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue; // unreadable dir — skip, don't fail the whole search
    }
    for (const entry of entries) {
      if (entry.isDirectory() && shouldSkipDir(entry.name)) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        stack.push(full);
      } else if (entry.isFile()) {
        if (++scanned > MAX_SCANNED_FILES) return;
        yield full;
      }
    }
  }
}

/** Converts a glob pattern (*, **, ?) to a RegExp. Only the subset that
 * matters for file matching — not a full glob engine, but honest about it:
 * `**` crosses directory separators, `*`/`?` don't. */
function globToRegExp(pattern: string): RegExp {
  let out = "";
  for (let i = 0; i < pattern.length; i++) {
    const ch = pattern[i];
    if (ch === "*") {
      if (pattern[i + 1] === "*") {
        out += ".*";
        i++;
        if (pattern[i + 1] === "/") i++; // "**/" also matches zero directories
      } else {
        out += "[^/]*";
      }
    } else if (ch === "?") {
      out += "[^/]";
    } else if ("\\^$.|+()[]{}".includes(ch)) {
      out += "\\" + ch;
    } else {
      out += ch;
    }
  }
  return new RegExp(`(^|/)${out}$`);
}

/** Relative paths of files under `root`, most-recently-modified first —
 * backs the composer's `@`-mention autocomplete. Reuses the same skip-list
 * walker as grep/glob so it never surfaces node_modules/build noise, and is
 * bounded (walkFiles caps its own scan) so it stays cheap even on a big
 * tree. Returns [] on any error rather than throwing into the UI. */
export function listProjectFiles(root: string, limit = 2000): string[] {
  if (isUnsafeProjectRoot(root)) return [];
  try {
    const out: { rel: string; mtime: number }[] = [];
    for (const file of walkFiles(root)) {
      let mtime = 0;
      try {
        mtime = fs.statSync(file).mtimeMs;
      } catch {
        // keep 0 — still listed, just sorts last
      }
      out.push({ rel: path.relative(root, file).split(path.sep).join("/"), mtime });
      if (out.length >= limit) break;
    }
    out.sort((a, b) => b.mtime - a.mtime);
    return out.map((f) => f.rel);
  } catch {
    return [];
  }
}

export function grepSearch(args: Record<string, unknown>, ctx: PathGuardContext): ToolResult {
  if (isUnsafeProjectRoot(ctx.projectRoot)) {
    return { isError: true, text: unsafeRootToolError(ctx.projectRoot) };
  }
  const pattern = typeof args.pattern === "string" ? args.pattern : "";
  if (!pattern) return { isError: true, text: 'ERROR: "pattern" (a regular expression) is required.' };
  const rawPath = typeof args.path === "string" && args.path.trim().length > 0 ? args.path : ".";
  const include = typeof args.include === "string" && args.include.trim().length > 0 ? globToRegExp(args.include.trim()) : null;

  let regex: RegExp;
  try {
    regex = new RegExp(pattern);
  } catch (e) {
    return { isError: true, text: `ERROR: "${pattern}" isn't a valid regular expression: ${e instanceof Error ? e.message : String(e)}` };
  }

  const root = normalizePath(rawPath, ctx);
  let stat: fs.Stats;
  try {
    stat = fs.statSync(root);
  } catch {
    return { isError: true, text: `ERROR: no such file or directory: ${root}` };
  }

  const files = stat.isDirectory() ? walkFiles(root) : [root];
  const lines: string[] = [];
  let matchCount = 0;
  let truncated = false;

  for (const file of files) {
    if (include && !include.test(file.split(path.sep).join("/"))) continue;
    let buf: Buffer;
    try {
      const size = fs.statSync(file).size;
      if (size > MAX_FILE_BYTES) continue;
      buf = fs.readFileSync(file);
    } catch {
      continue;
    }
    if (looksBinary(buf)) continue;
    const text = buf.toString("utf8");
    if (!regex.test(text)) continue;
    const rel = path.relative(ctx.projectRoot, file) || file;
    const fileLines = text.split("\n");
    for (let i = 0; i < fileLines.length; i++) {
      if (regex.test(fileLines[i])) {
        matchCount++;
        if (matchCount > MAX_RESULTS) {
          truncated = true;
          break;
        }
        const shown = fileLines[i].length > 300 ? fileLines[i].slice(0, 300) + "…" : fileLines[i];
        lines.push(`${rel}:${i + 1}: ${shown.trimEnd()}`);
      }
    }
    if (truncated) break;
  }

  if (lines.length === 0) return { isError: false, text: `No matches for /${pattern}/ under ${root}.` };
  const header = truncated ? `First ${MAX_RESULTS} matches (more exist — narrow the pattern or path):` : `${lines.length} match${lines.length === 1 ? "" : "es"}:`;
  return { isError: false, text: [header, ...lines].join("\n") };
}

export function globSearch(args: Record<string, unknown>, ctx: PathGuardContext): ToolResult {
  if (isUnsafeProjectRoot(ctx.projectRoot)) {
    return { isError: true, text: unsafeRootToolError(ctx.projectRoot) };
  }
  const pattern = typeof args.pattern === "string" ? args.pattern.trim() : "";
  if (!pattern) return { isError: true, text: 'ERROR: "pattern" is required, e.g. "**/*.ts" or "src/*.py".' };
  const rawPath = typeof args.path === "string" && args.path.trim().length > 0 ? args.path : ".";
  const root = normalizePath(rawPath, ctx);
  if (!fs.existsSync(root)) return { isError: true, text: `ERROR: no such directory: ${root}` };

  const regex = globToRegExp(pattern);
  const matches: { file: string; mtime: number }[] = [];
  for (const file of walkFiles(root)) {
    const rel = path.relative(root, file).split(path.sep).join("/");
    if (regex.test(rel)) {
      let mtime = 0;
      try {
        mtime = fs.statSync(file).mtimeMs;
      } catch {
        // keep 0 — still listed, just sorts last
      }
      matches.push({ file: path.relative(ctx.projectRoot, file) || file, mtime });
      if (matches.length >= MAX_RESULTS) break;
    }
  }

  if (matches.length === 0) return { isError: false, text: `No files matching "${pattern}" under ${root}.` };
  // Most-recently-modified first — the file you're iterating on is almost
  // always the one you want at the top.
  matches.sort((a, b) => b.mtime - a.mtime);
  const suffix = matches.length >= MAX_RESULTS ? `\n…capped at ${MAX_RESULTS} — narrow the pattern if what you need isn't here.` : "";
  return { isError: false, text: matches.map((m) => m.file).join("\n") + suffix };
}
