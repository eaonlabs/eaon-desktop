// The terminal turns of an agent run — tool output sent back to the model —
// rendered as a compact collapsed card instead of prose, so a long file
// listing never shouts over the conversation.

import { useMemo, useState } from "react";
import { ChevronRight, Wrench } from "lucide-react";

/** The send pipeline prefixes tool turns with a bracketed header line, e.g.
 *  "[Tool results (3 actions)]". Turn that into a calm summary; anything
 *  unexpected falls back to a generic label with the full content below. */
function parseToolResult(content: string): { summary: string; body: string } {
  const newline = content.indexOf("\n");
  const firstLine = (newline === -1 ? content : content.slice(0, newline)).trim();
  const bracketed = /^\[([^\]]+)\]$/.exec(firstLine);
  if (bracketed) {
    const inner = bracketed[1];
    const count = /(\d+)\s+action/.exec(inner);
    const summary = count
      ? `Ran ${count[1]} action${count[1] === "1" ? "" : "s"}`
      : inner;
    const body = newline === -1 ? "" : content.slice(newline).trim();
    return { summary, body };
  }
  return { summary: "Tool activity", body: content };
}

export interface ToolResultCardProps {
  content: string;
}

export default function ToolResultCard({ content }: ToolResultCardProps) {
  const [open, setOpen] = useState(false);
  const { summary, body } = useMemo(() => parseToolResult(content), [content]);

  return (
    <div className="tool-card">
      <button
        className="tool-card-head"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
      >
        <Wrench size={12} aria-hidden />
        <span>{summary}</span>
        <span className={"tool-card-chevron" + (open ? " open" : "")} aria-hidden>
          <ChevronRight size={11} strokeWidth={2.4} />
        </span>
      </button>
      {open && (
        <pre className="tool-card-body" data-selectable>
          {body || "No output."}
        </pre>
      )}
    </div>
  );
}
