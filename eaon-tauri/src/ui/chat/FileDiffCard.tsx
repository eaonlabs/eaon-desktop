// A file write/edit rendered as a reviewable, line-numbered diff instead of
// a wall of JSON — the port of the Mac app's FileDiffCard.
//
// Collapsed by default past a threshold: an agent writing a 400-line file
// should not bury the rest of the reply, but a short edit is more useful open
// than hidden behind another click.

import { useMemo, useState } from "react";
import { ChevronRight, FilePlus2, FilePenLine } from "lucide-react";
import type { FileDiff } from "../../core/protocol/fileDiff";

/** Beyond this many lines the card starts collapsed. */
const COLLAPSE_THRESHOLD = 24;

export interface FileDiffCardProps {
  diff: FileDiff;
  isStreaming: boolean;
}

export default function FileDiffCard({ diff, isStreaming }: FileDiffCardProps) {
  const long = diff.lines.length > COLLAPSE_THRESHOLD;
  // While it streams the card stays open regardless — watching the file
  // arrive is the point, and collapsing mid-write reads as a glitch.
  const [open, setOpen] = useState(!long);
  const expanded = isStreaming || open;

  const Icon = diff.toolName === "edit_file" ? FilePenLine : FilePlus2;
  const counts = useMemo(() => {
    const parts: string[] = [];
    if (diff.addedCount) parts.push(`+${diff.addedCount}`);
    if (diff.removedCount) parts.push(`−${diff.removedCount}`);
    return parts.join(" ");
  }, [diff.addedCount, diff.removedCount]);

  return (
    <div className="diff-card">
      <button
        className="diff-card-head"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={expanded}
        disabled={isStreaming}
      >
        <ChevronRight size={13} className={`diff-chevron${expanded ? " open" : ""}`} aria-hidden />
        <Icon size={13} aria-hidden />
        <span className="diff-file">{diff.fileName}</span>
        {counts && <span className="diff-counts">{counts}</span>}
        {isStreaming && <span className="diff-writing">writing…</span>}
      </button>

      {expanded && diff.lines.length > 0 && (
        <div className="diff-body">
          {diff.lines.map((line, index) => (
            <div
              key={index}
              className={`diff-line${line.isAdded ? " added" : " removed"}`}
            >
              <span className="diff-num" aria-hidden>{line.number}</span>
              <span className="diff-sign" aria-hidden>{line.isAdded ? "+" : "−"}</span>
              {/* A genuinely empty line still needs to hold its row height. */}
              <span className="diff-text">{line.text === "" ? " " : line.text}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
