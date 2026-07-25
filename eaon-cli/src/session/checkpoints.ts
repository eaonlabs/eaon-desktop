// File checkpoints — the safety net that makes high-autonomy runs
// survivable. Before the agent modifies a file, its prior contents are
// snapshotted here; /rewind lists those snapshots and restores one.
//
// Deliberately NOT git-based: the project may not be a repo, may have a
// dirty tree the user cares about, or may have the change staged already.
// Snapshots live entirely under ~/.eaon/cli/checkpoints/<session>/ so
// rewinding never touches git state or the user's index.
//
// Scope is honest and worth knowing: this snapshots files the AGENT edited
// through write_file/edit_file/move_item/trash_item. It does NOT capture
// changes made by `run_shell` (a command that rewrites a file, or `npm
// install` churning node_modules) — recording those would mean snapshotting
// the whole tree on every command, which isn't affordable. /rewind says so.

import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { configDir } from "../platform.js";

export interface CheckpointEntry {
  id: string;
  /** What the agent was doing — shown in the /rewind list. */
  label: string;
  /** Absolute path of the file this snapshot restores. */
  filePath: string;
  /** Where the prior contents live, or null when the file did not exist
   * before (restoring then means deleting it again). */
  snapshotPath: string | null;
  createdAt: number;
}

const MAX_SNAPSHOT_BYTES = 5 * 1024 * 1024;

function checkpointsRoot(): string {
  return path.join(configDir(), "checkpoints");
}

function sessionDir(sessionId: string): string {
  return path.join(checkpointsRoot(), sessionId);
}

function indexFile(sessionId: string): string {
  return path.join(sessionDir(sessionId), "index.json");
}

function loadIndex(sessionId: string): CheckpointEntry[] {
  try {
    return JSON.parse(fs.readFileSync(indexFile(sessionId), "utf8")) as CheckpointEntry[];
  } catch {
    return [];
  }
}

function saveIndex(sessionId: string, entries: CheckpointEntry[]): void {
  const dir = sessionDir(sessionId);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = indexFile(sessionId) + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(entries, null, 2), "utf8");
  fs.renameSync(tmp, indexFile(sessionId));
}

/** Snapshots a file's CURRENT contents before it's changed. Safe to call
 * for a path that doesn't exist yet — that records a "was absent" marker,
 * so restoring correctly deletes a file the agent created. Never throws:
 * a checkpoint failure must not block the edit the user asked for. */
export function recordCheckpoint(sessionId: string, filePath: string, label: string): void {
  try {
    const entries = loadIndex(sessionId);
    let snapshotPath: string | null = null;

    if (fs.existsSync(filePath)) {
      const stat = fs.statSync(filePath);
      if (!stat.isFile()) return;
      if (stat.size > MAX_SNAPSHOT_BYTES) return; // too big to snapshot; skip rather than half-record
      const dir = path.join(sessionDir(sessionId), "files");
      fs.mkdirSync(dir, { recursive: true });
      snapshotPath = path.join(dir, `${randomUUID()}.snap`);
      fs.copyFileSync(filePath, snapshotPath);
    }

    entries.push({
      id: randomUUID().slice(0, 8),
      label,
      filePath,
      snapshotPath,
      createdAt: Date.now(),
    });
    saveIndex(sessionId, entries);
  } catch {
    // Best effort by design — see the module comment.
  }
}

export function listCheckpoints(sessionId: string): CheckpointEntry[] {
  return loadIndex(sessionId);
}

export interface RestoreResult {
  restored: string[];
  failed: Array<{ filePath: string; reason: string }>;
}

/** Restores every checkpoint from `checkpointId` onward (inclusive),
 * newest first, so the tree ends up as it was immediately BEFORE that
 * change. Restored entries are dropped from the index — rewinding twice
 * to the same point is a no-op rather than a confusing partial re-apply. */
export function restoreToCheckpoint(sessionId: string, checkpointId: string): RestoreResult | null {
  const entries = loadIndex(sessionId);
  const index = entries.findIndex((e) => e.id === checkpointId);
  if (index === -1) return null;

  const toRestore = entries.slice(index).reverse();
  const result: RestoreResult = { restored: [], failed: [] };

  for (const entry of toRestore) {
    try {
      if (entry.snapshotPath === null) {
        // The file didn't exist before this change — undo means remove it.
        if (fs.existsSync(entry.filePath)) fs.rmSync(entry.filePath, { force: true });
        result.restored.push(entry.filePath);
        continue;
      }
      if (!fs.existsSync(entry.snapshotPath)) {
        result.failed.push({ filePath: entry.filePath, reason: "snapshot file is missing" });
        continue;
      }
      fs.mkdirSync(path.dirname(entry.filePath), { recursive: true });
      fs.copyFileSync(entry.snapshotPath, entry.filePath);
      result.restored.push(entry.filePath);
    } catch (e) {
      result.failed.push({ filePath: entry.filePath, reason: (e as Error).message });
    }
  }

  saveIndex(sessionId, entries.slice(0, index));
  return result;
}

export function clearCheckpoints(sessionId: string): void {
  try {
    fs.rmSync(sessionDir(sessionId), { recursive: true, force: true });
  } catch {
    // best effort
  }
}

/** Deletes checkpoint data for sessions that no longer matter. Called at
 * startup so snapshots don't accumulate forever in ~/.eaon. */
export function pruneOldCheckpoints(keepSessionIds: Set<string>, maxAgeMs = 7 * 24 * 60 * 60 * 1000): void {
  try {
    const root = checkpointsRoot();
    if (!fs.existsSync(root)) return;
    const now = Date.now();
    for (const name of fs.readdirSync(root)) {
      if (keepSessionIds.has(name)) continue;
      const dir = path.join(root, name);
      try {
        if (now - fs.statSync(dir).mtimeMs > maxAgeMs) fs.rmSync(dir, { recursive: true, force: true });
      } catch {
        // skip unreadable entries
      }
    }
  } catch {
    // best effort
  }
}
