// The bottom status row: project path and git branch on the left, version on the
// right, matching the reference layout.
//
// The branch is read straight out of .git/HEAD rather than by spawning `git`.
// This renders on every repaint, and a child process per repaint would be both
// slow and visible as a stutter. HEAD is a single line, and its two forms are
// documented and stable: a ref path when on a branch, a raw sha when detached.

import React, { useEffect, useState } from "react";
import { Box, Text } from "ink";
import { existsSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { theme } from "./theme.js";

/** Nearest ancestor containing .git, or null outside a repository. */
function findGitDir(from: string): string | null {
  let dir = from;
  for (let i = 0; i < 24; i++) {
    const candidate = path.join(dir, ".git");
    if (existsSync(candidate)) return candidate;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

/** Branch name, a short sha when detached, or null when not a repo. */
export function readBranch(root: string): string | null {
  try {
    const gitDir = findGitDir(root);
    if (!gitDir) return null;

    // A worktree's .git is a file pointing at the real directory.
    let resolved = gitDir;
    if (!existsSync(path.join(gitDir, "HEAD"))) {
      const pointer = readFileSync(gitDir, "utf8").trim();
      const match = /^gitdir:\s*(.+)$/.exec(pointer);
      if (!match) return null;
      resolved = match[1]!;
    }

    const head = readFileSync(path.join(resolved, "HEAD"), "utf8").trim();
    const ref = /^ref:\s*refs\/heads\/(.+)$/.exec(head);
    if (ref) return ref[1]!;
    return head.slice(0, 7) || null;
  } catch {
    return null;
  }
}

/** `~/projects/thing` — home collapsed, the way a shell prompt shows it. */
export function tildePath(abs: string): string {
  const home = os.homedir();
  if (abs === home) return "~";
  return abs.startsWith(`${home}${path.sep}`) ? `~${abs.slice(home.length)}` : abs;
}

interface Props {
  projectRoot: string;
  version: string;
  width: number;
  /** Extra dim text between the two ends — e.g. an update notice. */
  notice?: string | null;
}

export function Footer({ projectRoot, version, width, notice }: Props): React.ReactElement {
  const [branch, setBranch] = useState<string | null>(null);

  // Re-read on a timer rather than every render: cheap, but not free, and a
  // branch change between two keystrokes does not need to be instant.
  useEffect(() => {
    const read = () => setBranch(readBranch(projectRoot));
    read();
    const id = setInterval(read, 5000);
    return () => clearInterval(id);
  }, [projectRoot]);

  const left = branch ? `${tildePath(projectRoot)}:${branch}` : tildePath(projectRoot);
  const right = version;

  // Drop the path before the version when the terminal is too narrow — the
  // version is one short token and stays legible where a long path would wrap.
  const room = width - right.length - 2;
  const leftShown = left.length <= room ? left : room > 4 ? `…${left.slice(-(room - 1))}` : "";

  return (
    <Box flexDirection="column" marginTop={1}>
      {notice && (
        <Box justifyContent="center" marginBottom={1}>
          <Text color={theme.warning}>{notice}</Text>
        </Box>
      )}
      <Box justifyContent="space-between">
        <Text color={theme.mutedDim}>{leftShown}</Text>
        <Text color={theme.mutedDim}>{right}</Text>
      </Box>
    </Box>
  );
}

/** The keyboard hint row that sits under the composer. */
export function Hints(): React.ReactElement {
  return (
    <Box justifyContent="flex-end">
      <Text color={theme.assistant}>tab </Text>
      <Text color={theme.mutedDim}>agents </Text>
      <Text color={theme.assistant}>  ctrl+p </Text>
      <Text color={theme.mutedDim}>commands</Text>
    </Box>
  );
}
