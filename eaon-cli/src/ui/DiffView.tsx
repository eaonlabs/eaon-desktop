// Renders write_file/edit_file diffs: dim gutter + tinted +/- lines (Codex/Cursor).
// write_file shows every line as added; edit_file diffs search→replace.

import React from "react";
import { Box, Text } from "ink";
import { diffLines } from "diff";
import { theme } from "./theme.js";

function splitTrailingBlank(value: string): string[] {
  const lines = value.split("\n");
  if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  return lines;
}

/** One diff line: dim gutter number, then the content on a tinted (or
 * plain, for context) background. The tint covers the sign + text so the
 * line reads as a single solid block, the way both reference CLIs do it. */
function DiffLine({ lineNo, sign, text }: { lineNo: number; sign: "+" | "-" | " "; text: string }): React.ReactElement {
  const fg = sign === "+" ? theme.diffAdded : sign === "-" ? theme.diffRemoved : theme.muted;
  const bg = sign === "+" ? theme.diffAddedBg : sign === "-" ? theme.diffRemovedBg : undefined;
  return (
    <Text>
      <Text color={theme.muted} dimColor>
        {String(lineNo).padStart(4)}{" "}
      </Text>
      <Text color={fg} backgroundColor={bg}>
        {sign} {text.length > 0 ? text : " "}
      </Text>
    </Text>
  );
}

function DiffStats({ added, removed }: { added?: number; removed?: number }): React.ReactElement | null {
  const parts: string[] = [];
  if (added && added > 0) parts.push(`+${added}`);
  if (removed && removed > 0) parts.push(`-${removed}`);
  if (parts.length === 0) return null;
  return (
    <Text color={theme.muted} dimColor>
      └ {parts.join(" ")}
    </Text>
  );
}

export function WriteFileDiff({ path: _path, content }: { path: string; content: string }): React.ReactElement {
  void _path;
  const lines = content.length === 0 ? [""] : content.split("\n");
  const capped = lines.slice(0, 400);
  return (
    <Box flexDirection="column">
      <DiffStats added={lines.length} />
      {capped.map((line, idx) => (
        <DiffLine key={idx} lineNo={idx + 1} sign="+" text={line} />
      ))}
      {lines.length > capped.length && <Text color={theme.muted}>     … +{lines.length - capped.length} more lines</Text>}
    </Box>
  );
}

export function EditFileDiff({ path: _path, search, replace }: { path: string; search: string; replace: string }): React.ReactElement {
  void _path;
  const parts = diffLines(search, replace);
  const rows: Array<{ sign: "-" | "+" | " "; text: string; lineNo: number }> = [];
  let oldNo = 1;
  let newNo = 1;
  for (const part of parts) {
    const lines = splitTrailingBlank(part.value);
    if (part.removed) {
      for (const l of lines) rows.push({ sign: "-", text: l, lineNo: oldNo++ });
    } else if (part.added) {
      for (const l of lines) rows.push({ sign: "+", text: l, lineNo: newNo++ });
    } else {
      for (const l of lines) {
        rows.push({ sign: " ", text: l, lineNo: newNo });
        oldNo++;
        newNo++;
      }
    }
  }
  const capped = rows.slice(0, 400);
  const added = rows.filter((r) => r.sign === "+").length;
  const removed = rows.filter((r) => r.sign === "-").length;
  return (
    <Box flexDirection="column">
      <DiffStats added={added} removed={removed} />
      {capped.map((row, idx) => (
        <DiffLine key={idx} lineNo={row.lineNo} sign={row.sign} text={row.text} />
      ))}
      {rows.length > capped.length && <Text color={theme.muted}>     … +{rows.length - capped.length} more lines</Text>}
    </Box>
  );
}
