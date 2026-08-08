// Filesystem tools — ported from DesktopControlService's file operations
// (DesktopControl.swift), same semantics and same user-facing wording where
// it's not platform-specific: create_folder is mkdir-p (existing folder =
// success, only a file-in-the-way errors), edit_file requires an exact,
// exactly-once search match, write_file always sends the complete file.

import fs from "node:fs";
import path from "node:path";
import trash from "trash";
import type { ToolResult } from "../types.js";
import { guardModifiable, normalizePath, type PathGuardContext } from "./pathGuard.js";
import { isFileKnown, markFileKnown } from "./readTracker.js";
import { isUnsafeProjectRoot, unsafeRootToolError } from "../project/rootGuard.js";

const LIST_CAP = 80;

function byteString(bytes: number): string {
  const units = ["B", "KB", "MB", "GB", "TB"];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  return unit === 0 ? `${bytes} B` : `${value.toFixed(1)} ${units[unit]}`;
}

function ok(text: string): ToolResult {
  return { isError: false, text };
}
function err(text: string): ToolResult {
  return { isError: true, text };
}

export function listDirectory(args: Record<string, unknown>, ctx: PathGuardContext): ToolResult {
  if (isUnsafeProjectRoot(ctx.projectRoot)) {
    return err(unsafeRootToolError(ctx.projectRoot));
  }
  const raw = args.path;
  if (typeof raw !== "string") return err('missing "path"');
  const target = normalizePath(raw, ctx);
  let stat: fs.Stats;
  try {
    stat = fs.statSync(target);
  } catch {
    return err(`No such directory: ${target}`);
  }
  if (!stat.isDirectory()) return err(`Not a directory (it's a file): ${target}`);

  // Hide dotfiles by default unless the user/model asked for a path that
  // itself is a dotfile (e.g. listing .github). Home-folder raids were
  // mostly noise from .android / .cache / .cargo.
  const listingDotDir = path.basename(target).startsWith(".");
  const allEntries = fs.readdirSync(target).sort((a, b) => a.localeCompare(b));
  const hidden = listingDotDir ? 0 : allEntries.filter((n) => n.startsWith(".")).length;
  const entries = listingDotDir ? allEntries : allEntries.filter((n) => !n.startsWith("."));
  if (entries.length === 0) {
    return ok(
      hidden > 0
        ? `${target} has no non-hidden entries (${hidden} dotfile${hidden === 1 ? "" : "s"} hidden).`
        : `${target} is empty.`
    );
  }
  const shown = entries.slice(0, LIST_CAP);
  const lines = shown.map((name) => {
    const full = path.join(target, name);
    try {
      const entryStat = fs.statSync(full);
      if (entryStat.isDirectory()) return `${name}/`;
      return `${name}  (${byteString(entryStat.size)})`;
    } catch {
      return name;
    }
  });
  const omitted = entries.length - shown.length;
  const parts = [`${entries.length} item${entries.length === 1 ? "" : "s"} in ${target}`];
  if (hidden > 0) parts.push(`${hidden} dotfile${hidden === 1 ? "" : "s"} hidden`);
  if (omitted > 0) parts.push(`${omitted} more not shown — narrow the path`);
  return ok(`${parts.join(" · ")}:\n${lines.join("\n")}`);
}

export function createFolder(args: Record<string, unknown>, ctx: PathGuardContext): ToolResult {
  const raw = args.path;
  if (typeof raw !== "string") return err('missing "path"');
  const target = normalizePath(raw, ctx);
  const denied = guardModifiable(target, "creating a folder", ctx);
  if (denied) return err(denied);
  if (fs.existsSync(target)) {
    const stat = fs.statSync(target);
    if (!stat.isDirectory()) {
      return err(`A file (not a folder) already exists at ${target} — pick a different name or move it aside first.`);
    }
    // mkdir -p semantics: an existing folder is success, not an error.
    return ok(`Already exists: ${target} — the folder is there, use it.`);
  }
  try {
    fs.mkdirSync(target, { recursive: true });
    return ok(`Created folder ${target}`);
  } catch (e) {
    return err(`Couldn't create it: ${(e as Error).message}`);
  }
}

export function writeFile(args: Record<string, unknown>, ctx: PathGuardContext): ToolResult {
  const raw = args.path;
  const content = args.content;
  if (typeof raw !== "string") return err('missing "path"');
  if (typeof content !== "string") return err('missing "content"');
  const target = normalizePath(raw, ctx);
  const denied = guardModifiable(target, "writing a file", ctx);
  if (denied) return err(denied);
  if (fs.existsSync(target) && fs.statSync(target).isDirectory()) {
    return err(`That path is a folder, not a file: ${target}`);
  }
  // Read-before-overwrite: refuse to blind-clobber an existing non-empty
  // file the model hasn't actually seen this session — it's almost always
  // guessing at what it's about to destroy. Creating a new file, or
  // rewriting one it already read/wrote, is fine.
  if (fs.existsSync(target) && !isFileKnown(target)) {
    let existingSize = 0;
    try {
      existingSize = fs.statSync(target).size;
    } catch {
      // treat unreadable-stat as empty — don't block on it
    }
    if (existingSize > 0) {
      return err(`${target} already exists and you haven't read it this session — read_file it first so you don't overwrite something you haven't seen, then write_file again to replace it.`);
    }
  }
  try {
    const parent = path.dirname(target);
    fs.mkdirSync(parent, { recursive: true });
    const tmp = target + ".eaon-tmp";
    fs.writeFileSync(tmp, content, "utf8");
    fs.renameSync(tmp, target);
    markFileKnown(target);
    const bytes = Buffer.byteLength(content, "utf8");
    const lines = content.length === 0 ? 0 : content.split("\n").length;
    return ok(`Wrote ${target} (${lines} line${lines === 1 ? "" : "s"}, ${bytes} byte${bytes === 1 ? "" : "s"}).`);
  } catch (e) {
    return err(`Couldn't write it: ${(e as Error).message}`);
  }
}

export type EditOutcome = { applied: true; content: string; count: number } | { applied: false; reason: string };

/** Exact search→replace. Single-occurrence by default (must match exactly
 * once); `replaceAll` swaps every occurrence. The multi-match refusal
 * reports HOW MANY matches there were and points at replace_all — turning
 * what used to be a read→guess→retry cycle into a one-shot fix. */
export function applyEdit(content: string, search: string, replace: string, replaceAll = false): EditOutcome {
  const count = content.split(search).length - 1;
  if (count === 0) {
    return { applied: false, reason: "no exact match for \"search\" was found in the file" };
  }
  if (replaceAll) {
    return { applied: true, content: content.split(search).join(replace), count };
  }
  if (count > 1) {
    return { applied: false, reason: `"search" matches ${count} times — include more surrounding context to pinpoint one occurrence, or pass replace_all: true to change all ${count}` };
  }
  const first = content.indexOf(search);
  return { applied: true, content: content.slice(0, first) + replace + content.slice(first + search.length), count: 1 };
}

export function editFile(args: Record<string, unknown>, ctx: PathGuardContext): ToolResult {
  const raw = args.path;
  const search = args.search;
  const replace = args.replace;
  if (typeof raw !== "string") return err('missing "path"');
  if (typeof search !== "string" || search.length === 0) return err('missing a non-empty "search" — the exact existing text to find.');
  if (typeof replace !== "string") return err('missing "replace" — use "" to delete the matched text.');
  const target = normalizePath(raw, ctx);
  const denied = guardModifiable(target, "editing a file", ctx);
  if (denied) return err(denied);
  if (!fs.existsSync(target)) return err(`No such file: ${target} — to create a new file, use write_file.`);
  if (fs.statSync(target).isDirectory()) return err(`That path is a folder, not a file: ${target}`);
  // Read-before-edit: if the model hasn't seen this file this session, make
  // it read first rather than editing against a guessed current state.
  if (!isFileKnown(target)) {
    return err(`You haven't read ${target} this session — read_file it first so your search text matches the real current contents, then edit_file.`);
  }
  let content: string;
  try {
    content = fs.readFileSync(target, "utf8");
  } catch (e) {
    return err(`Couldn't read ${target} as UTF-8 text: ${(e as Error).message}`);
  }
  const outcome = applyEdit(content, search, replace, args.replace_all === true);
  if (!outcome.applied) {
    return err(`Edit not applied — ${outcome.reason}. Use read_file to see the file's current contents, then retry with an exact match.`);
  }
  try {
    fs.writeFileSync(target, outcome.content, "utf8");
    markFileKnown(target);
    const lines = outcome.content.length === 0 ? 0 : outcome.content.split("\n").length;
    return ok(`Edited ${target} — replaced ${outcome.count} occurrence${outcome.count === 1 ? "" : "s"}. The file is now ${lines} line${lines === 1 ? "" : "s"}.`);
  } catch (e) {
    return err(`Couldn't write the edit: ${(e as Error).message}`);
  }
}

/** Tolerant number coercion — models send numeric args as strings often
 * enough that rejecting "40" where 40 was meant would waste a round-trip. */
function numberArg(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return Math.floor(value);
  if (typeof value === "string" && /^\d+$/.test(value.trim())) return parseInt(value.trim(), 10);
  return null;
}

export function readFile(args: Record<string, unknown>, ctx: PathGuardContext): ToolResult {
  const raw = args.path;
  if (typeof raw !== "string") return err('missing "path"');
  const target = normalizePath(raw, ctx);
  if (!fs.existsSync(target)) {
    return err(`No such file: ${target}. If you're about to create this file, just use write_file directly — you don't need to read a file that doesn't exist yet. If you expected it to exist, check the path with list_directory or glob.`);
  }
  const stat = fs.statSync(target);
  if (stat.isDirectory()) return err(`That's a folder, not a file: ${target} — use list_directory for folders.`);
  if (stat.size > 5_000_000) {
    return err(`Too large to read whole (${byteString(stat.size)}) — read a slice with offset/limit, e.g. {"path": "${raw}", "offset": 1, "limit": 200}.`);
  }
  let content: string;
  try {
    content = fs.readFileSync(target, "utf8");
  } catch {
    return err(`Not a UTF-8 text file: ${target}`);
  }
  markFileKnown(target);
  const allLines = content.length === 0 ? [] : content.split("\n");
  const totalLines = allLines.length;

  // Optional slice: offset is a 1-based start line, limit a line count —
  // the round-trip-free way to read the rest of a file past the size cap.
  const offset = numberArg(args.offset);
  const limit = numberArg(args.limit);
  if (offset !== null || limit !== null) {
    const start = Math.max(1, offset ?? 1);
    if (start > totalLines) {
      return err(`offset ${start} is past the end — ${target} has ${totalLines} line${totalLines === 1 ? "" : "s"}.`);
    }
    const count = Math.max(1, limit ?? totalLines);
    const slice = allLines.slice(start - 1, start - 1 + count);
    const body = slice.join("\n");
    const capped = body.length > 12_000 ? body.slice(0, 12_000) + "\n…(truncated at 12k characters — use a smaller limit)" : body;
    const end = start + slice.length - 1;
    return ok(`${target} (lines ${start}–${end} of ${totalLines}):\n${capped}`);
  }

  const capped = content.length > 12_000
    ? content.slice(0, 12_000) + `\n…(truncated at 12k characters — the file has ${totalLines} lines; read the rest with offset/limit, e.g. {"offset": 300, "limit": 200})`
    : content;
  return ok(`${target} (${totalLines} line${totalLines === 1 ? "" : "s"}):\n${capped}`);
}

export function moveItem(args: Record<string, unknown>, ctx: PathGuardContext): ToolResult {
  const fromRaw = args.from;
  const toRaw = args.to;
  if (typeof fromRaw !== "string") return err('missing "from"');
  if (typeof toRaw !== "string") return err('missing "to"');
  const from = normalizePath(fromRaw, ctx);
  const to = normalizePath(toRaw, ctx);
  const deniedFrom = guardModifiable(from, "moving an item", ctx);
  if (deniedFrom) return err(deniedFrom);
  const deniedTo = guardModifiable(to, "moving an item", ctx);
  if (deniedTo) return err(deniedTo);
  if (!fs.existsSync(from)) return err(`Nothing to move — no such path: ${from}`);
  if (fs.existsSync(to)) {
    return err(`Something already exists at ${to} — refused rather than overwrite it. Pick a different destination or move that aside first.`);
  }
  try {
    const parent = path.dirname(to);
    fs.mkdirSync(parent, { recursive: true });
    fs.renameSync(from, to);
    return ok(`Moved ${from} → ${to}`);
  } catch (e) {
    return err(`Couldn't move it: ${(e as Error).message}`);
  }
}

export async function trashItem(args: Record<string, unknown>, ctx: PathGuardContext): Promise<ToolResult> {
  const raw = args.path;
  if (typeof raw !== "string") return err('missing "path"');
  const target = normalizePath(raw, ctx);
  const denied = guardModifiable(target, "trashing an item", ctx);
  if (denied) return err(denied);
  if (!fs.existsSync(target)) return err(`Nothing to trash — no such path: ${target}`);
  try {
    await trash([target]);
    return ok(`Moved to the Trash/Recycle Bin: ${target} (recoverable from there)`);
  } catch (e) {
    return err(`Couldn't trash it: ${(e as Error).message}`);
  }
}
