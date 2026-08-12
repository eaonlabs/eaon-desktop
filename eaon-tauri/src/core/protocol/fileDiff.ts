// Turning an agent's write_file / edit_file fence into a reviewable diff —
// the port of the Mac app's FileDiffCard model (AssistantMessageContentView).
//
// Two shapes are handled, matching what the executor actually accepts:
//   write_file — every line is an addition (the file as it will be written).
//                No "before" exists at this layer, so there is nothing to
//                show as removed.
//   edit_file  — carries its own before/after (`search`/`replace`), so that
//                IS a real diff. Both sides are numbered independently from
//                1, since no absolute file position is available here either:
//                accurate framing beats a cosmetic match to a real gutter.
//
// The lenient field decoder is what makes the card grow live token by token
// while the model is still streaming the fence, instead of appearing all at
// once when the JSON finally closes.

/** Tools whose fences render as a diff rather than a plain code block. */
export const DIFF_TOOLS = ["write_file", "edit_file"] as const;

export interface DiffLine {
  number: number;
  text: string;
  isAdded: boolean;
}

export interface FileDiff {
  toolName: string;
  fileName: string;
  path: string | null;
  lines: DiffLine[];
  addedCount: number;
  removedCount: number;
}

/** Finds `"key":"` in a possibly-truncated JSON fragment and decodes forward
 *  from the opening quote exactly like a JSON string literal — honoring \",
 *  \\, \/, \n, \t, \r and \uXXXX — stopping at an unescaped closing quote
 *  (field complete) or simply running out of characters (field still
 *  arriving; whatever decoded so far is returned). A lone trailing escape,
 *  or a \u with fewer than four hex digits yet, stops the decode right
 *  before it rather than guessing — the next tokens will complete it. */
export function partialStringField(key: string, json: string): string | null {
  const marker = new RegExp(`"${key}"\\s*:\\s*"`).exec(json);
  if (!marker) return null;
  let i = marker.index + marker[0].length;
  let out = "";
  while (i < json.length) {
    const ch = json[i];
    if (ch === "\\") {
      const next = json[i + 1];
      if (next === undefined) break; // incomplete escape — wait for more
      switch (next) {
        case "n": out += "\n"; i += 2; break;
        case "t": out += "\t"; i += 2; break;
        case "r": out += "\r"; i += 2; break;
        case "b": out += "\b"; i += 2; break;
        case "f": out += "\f"; i += 2; break;
        case '"': out += '"'; i += 2; break;
        case "\\": out += "\\"; i += 2; break;
        case "/": out += "/"; i += 2; break;
        case "u": {
          const hex = json.slice(i + 2, i + 6);
          if (hex.length < 4 || !/^[0-9a-fA-F]{4}$/.test(hex)) return out;
          out += String.fromCharCode(parseInt(hex, 16));
          i += 6;
          break;
        }
        default: out += next; i += 2; break;
      }
      continue;
    }
    if (ch === '"') return out; // unescaped close — the field is complete
    out += ch;
    i += 1;
  }
  return out;
}

function lastPathComponent(path: string): string {
  const parts = path.split(/[/\\]/).filter(Boolean);
  return parts.length ? parts[parts.length - 1] : path;
}

/** Splits into lines for display. `keepTrailingEmpty` false drops a single
 *  trailing empty line, which a `search`/`replace` block almost always has
 *  from its closing newline and which would render as a phantom row. */
function toLines(text: string, keepTrailingEmpty: boolean): string[] {
  const lines = text.split("\n");
  if (!keepTrailingEmpty && lines.length > 1 && lines[lines.length - 1] === "") lines.pop();
  return lines;
}

/** Builds the diff model from one fence. `rawBody` is the fence body (a JSON
 *  object, possibly still truncated mid-stream); `fencePath` is the fence
 *  line's own path="…" attribute, used by the raw-write form where the body
 *  IS the literal file text rather than JSON. */
export function buildFileDiff(opts: {
  toolName: string;
  rawBody: string;
  fencePath?: string | null;
}): FileDiff {
  const { toolName, rawBody } = opts;
  const fencePath = opts.fencePath ?? null;

  // Strict parse once; the lenient decoder only steps in when the document
  // isn't valid JSON yet (i.e. it is still streaming).
  let strict: Record<string, unknown> | null = null;
  try {
    const parsed: unknown = rawBody ? JSON.parse(rawBody) : null;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      strict = parsed as Record<string, unknown>;
    }
  } catch {
    strict = null;
  }

  const field = (key: string): string | null => {
    const value = strict?.[key];
    if (typeof value === "string") return value;
    if (strict !== null) return null;
    return partialStringField(key, rawBody);
  };

  // Raw write form: the fence names the path and the body is the file
  // itself — exactly what the executor accepts, so preview and write can
  // never disagree.
  const bodyIsArgsJSON = typeof strict?.path === "string" || typeof strict?.content === "string";
  const rawForm = toolName === "write_file" && fencePath !== null && !bodyIsArgsJSON;

  const path = rawForm ? fencePath : (field("path") ?? fencePath);
  const lines: DiffLine[] = [];

  if (toolName === "edit_file") {
    const removed = field("search");
    const added = field("replace");
    if (removed !== null) {
      toLines(removed, false).forEach((text, i) => lines.push({ number: i + 1, text, isAdded: false }));
    }
    if (added !== null) {
      toLines(added, false).forEach((text, i) => lines.push({ number: i + 1, text, isAdded: true }));
    }
  } else {
    // Absent means "content" hasn't started arriving yet (still on "path") —
    // genuinely nothing to show, unlike present-but-empty, a real empty file.
    const content = rawForm ? rawBody : field("content");
    if (content !== null) {
      toLines(content, true).forEach((text, i) => lines.push({ number: i + 1, text, isAdded: true }));
    }
  }

  const addedCount = lines.filter((l) => l.isAdded).length;
  return {
    toolName,
    fileName: path ? lastPathComponent(path) : "file",
    path,
    lines,
    addedCount,
    removedCount: lines.length - addedCount,
  };
}

// ---------------------------------------------------------------------------
// Segmenting an assistant reply
// ---------------------------------------------------------------------------

export type ContentSegment =
  | { kind: "markdown"; text: string }
  | { kind: "fileDiff"; diff: FileDiff; isStreaming: boolean };

// Same fence shape the executor parses (core/protocol/agent.ts), plus an
// optional unterminated tail so a fence still arriving renders as it grows.
const CLOSED_FENCE = /```[^\S\n]*eaon:computer[^\n]*\n([\s\S]*?)```/g;
const OPEN_FENCE = /```[^\S\n]*eaon:computer[^\n]*\n([\s\S]*)$/;

function headerAttrs(header: string): { tool: string; path: string | null } {
  const tool = /tool\s*=\s*"([^"]+)"/.exec(header)?.[1] ?? "";
  const path = /path\s*=\s*"([^"]+)"/.exec(header)?.[1] ?? null;
  return { tool, path };
}

/** Splits an assistant reply into prose and file-diff cards. Any fence whose
 *  tool isn't a diff tool is left in the markdown, so it still renders as an
 *  ordinary code block and nothing is ever silently swallowed. */
export function segmentAssistantContent(content: string): ContentSegment[] {
  const segments: ContentSegment[] = [];
  let cursor = 0;

  const pushMarkdown = (text: string) => {
    if (text.trim()) segments.push({ kind: "markdown", text });
  };

  CLOSED_FENCE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = CLOSED_FENCE.exec(content)) !== null) {
    const header = content.slice(match.index, match.index + match[0].indexOf("\n"));
    const { tool, path } = headerAttrs(header);
    if (!(DIFF_TOOLS as readonly string[]).includes(tool)) continue;

    pushMarkdown(content.slice(cursor, match.index));
    segments.push({
      kind: "fileDiff",
      diff: buildFileDiff({ toolName: tool, rawBody: match[1].trim(), fencePath: path }),
      isStreaming: false,
    });
    cursor = match.index + match[0].length;
  }

  // A fence still being written has no closing marker yet.
  const tail = content.slice(cursor);
  const open = OPEN_FENCE.exec(tail);
  if (open) {
    const header = tail.slice(open.index, open.index + open[0].indexOf("\n"));
    const { tool, path } = headerAttrs(header);
    if ((DIFF_TOOLS as readonly string[]).includes(tool)) {
      pushMarkdown(tail.slice(0, open.index));
      segments.push({
        kind: "fileDiff",
        diff: buildFileDiff({ toolName: tool, rawBody: open[1], fencePath: path }),
        isStreaming: true,
      });
      return segments;
    }
  }

  pushMarkdown(tail);
  return segments;
}

/** True when a reply contains a diff fence at all — lets the bubble skip
 *  segmenting entirely for the overwhelming majority of messages. */
export function hasFileDiff(content: string): boolean {
  return content.includes("eaon:computer") && DIFF_TOOLS.some((t) => content.includes(`"${t}"`));
}
