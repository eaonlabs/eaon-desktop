// Importing memories from another assistant (ChatGPT, Claude, Gemini, …).
//
// The flow is deliberately one prompt, not a file format: every assistant
// worth importing from can already introspect what it knows about you, but
// almost none of them export it as a machine-readable file a user can find.
// So Eaon ships the prompt, the user pastes it over there, and pastes the
// reply back — no account linking, no scraping, nothing leaves this PC
// except the prompt the user sends themselves.
//
// The parser is deliberately forgiving. A model asked for strict JSON will
// still sometimes wrap it in a ```json fence, prepend "Here's what I know
// about you:", or ignore JSON entirely and answer with a markdown bullet
// list. All of those are the user's real data and must import cleanly —
// bouncing them back to "invalid format" would be blaming the user for the
// other app's model being chatty.

import type { Memory } from "../types";
import { uid } from "../utils";

export interface ImportedMemory {
  kind: "fact" | "event";
  text: string;
}

/** The prompt the user copies into the other assistant. Written to be
 *  pasted verbatim as a single message, and to survive a model that only
 *  half-follows it (hence the parser's fallbacks). Third person is asked for
 *  explicitly: these get injected into Eaon's own system prompt later, where
 *  a first-person "I live in Toronto" would read as Eaon's own biography. */
export const MEMORY_IMPORT_PROMPT = `Export everything you know and remember about me, so I can move it into another assistant.

Use your saved memory / personalization data about me if you have any. Otherwise, use what you know about me from our conversations.

Reply with ONLY a JSON array — no explanation before or after it, no markdown code fence. Each item must look like:
{"kind": "fact", "text": "..."}
{"kind": "event", "text": "..."}

Use "fact" for durable things about me: my name, where I live, my job or studies, my relationships, my preferences, and a one-line summary of each ongoing project.
Use "event" for things happening in my life worth asking about later: a trip, an exam, an interview, an illness, plans I mentioned.

Rules:
- Write each item as one self-contained sentence in the third person — "lives in Toronto", "is building an app called Lume", "prefers concise answers".
- Keep any timing inside the text itself, e.g. "has a math final on Friday".
- Stay high level. Do NOT include file paths, function names, code, or step-by-step details of tasks you did for me.
- Leave out anything you are not confident about, and anything sensitive I did not clearly volunteer.
- Do not include facts about yourself or about our chats as chats.

If you have nothing about me, reply with exactly: []`;

/** Ceiling on one paste — a runaway model dumping its whole context should
 *  not be able to bury the user's real memory list. */
export const MAX_IMPORT_ITEMS = 200;

const MIN_TEXT = 3;
const MAX_TEXT = 300;

/** Strips ```json … ``` (or any fenced block) down to its contents. */
function stripFences(raw: string): string {
  const fence = /```[a-zA-Z]*\s*\n([\s\S]*?)```/;
  const match = fence.exec(raw);
  return match ? match[1] : raw;
}

function normalizeKind(value: unknown): "fact" | "event" {
  return typeof value === "string" && value.trim().toLowerCase() === "event" ? "event" : "fact";
}

/** Accepts a bare string item, or an object under any of the key names
 *  models actually emit ("text", "memory", "content", "fact"). */
function itemFromUnknown(item: unknown): ImportedMemory | null {
  if (typeof item === "string") {
    const text = item.trim();
    return text ? { kind: inferKind(text), text } : null;
  }
  if (!item || typeof item !== "object") return null;
  const record = item as Record<string, unknown>;
  const raw = record.text ?? record.memory ?? record.content ?? record.fact ?? record.value;
  if (typeof raw !== "string") return null;
  const text = raw.trim();
  if (!text) return null;
  return {
    kind: "kind" in record || "type" in record
      ? normalizeKind(record.kind ?? record.type)
      : inferKind(text),
    text,
  };
}

/** When the source didn't label an item, guess from its wording. Only
 *  time-bound phrasing becomes an "event"; everything else stays a fact,
 *  which is both the safer default and the far more common case. */
function inferKind(text: string): "fact" | "event" {
  return /\b(yesterday|today|tomorrow|tonight|next week|last week|this week|this weekend|on (mon|tue|wed|thu|fri|sat|sun)|upcoming|has an? (exam|interview|appointment|flight|trip)|is (travel|flying|visiting|moving)ing)\b/i.test(
    text,
  )
    ? "event"
    : "fact";
}

/** One list item's leading marker, if any: "- ", "* ", "• ", "1. ", "1) ". */
const LIST_MARKER = /^\s*(?:[-*•–—]|\d+[.)])\s+/;

/** A `[fact]` / `(event)` / `fact:` label some models prepend per line.
 *  Either the brackets or the separator must be present — matching a bare
 *  leading "fact"/"event" would eat the first word of a real sentence
 *  ("Fact checking is my job" → "checking is my job"). */
const KIND_LABEL = /^\s*(?:[[(]\s*(fact|event)\s*[\])]|(fact|event)\s*[:\-–])\s*/i;

/** Lines that are the model talking, not data. Only ever applied to the
 *  plain-text fallback path — never to items that came out of real JSON. */
function isCommentaryLine(line: string): boolean {
  if (line.endsWith(":")) return true; // "Here's what I know about you:"
  if (/^#{1,6}\s/.test(line)) return true; // markdown heading
  return /^(here('s| is| are)|based on|sure[,!]|of course|i (don'?t|do not|have|can)|from (our|what)|as an? (ai|assistant)|note:|these are|below (is|are)|that'?s (all|everything))/i.test(
    line,
  );
}

/** Parses whatever the other assistant replied with. Tries strict-ish JSON
 *  first, then JSONL, then a plain/markdown list — returning [] only when
 *  there is genuinely nothing usable in the text. */
export function parseImportedMemories(raw: string): ImportedMemory[] {
  const body = stripFences(raw).trim();
  if (!body) return [];

  const out: ImportedMemory[] = [];

  // 1. A JSON array anywhere in the reply (tolerates surrounding prose).
  const start = body.indexOf("[");
  const end = body.lastIndexOf("]");
  if (start !== -1 && end > start) {
    try {
      const parsed = JSON.parse(body.slice(start, end + 1));
      if (Array.isArray(parsed)) {
        for (const item of parsed) {
          const memory = itemFromUnknown(item);
          if (memory) out.push(memory);
        }
        if (out.length || parsed.length === 0) return finalize(out);
      }
    } catch {
      // Fall through — a truncated or malformed array still has usable
      // lines in it, which the fallbacks below will find.
    }
  }

  // 2. JSONL / one object per line.
  const lines = body.split("\n");
  let jsonlHits = 0;
  for (const line of lines) {
    const trimmed = line.trim().replace(/,$/, "");
    if (!trimmed.startsWith("{")) continue;
    try {
      const memory = itemFromUnknown(JSON.parse(trimmed));
      if (memory) {
        out.push(memory);
        jsonlHits += 1;
      }
    } catch {
      /* not an object line — the list fallback may still catch it */
    }
  }
  if (jsonlHits) return finalize(out);

  // 3. Plain or markdown list. When the reply contains real list markers,
  //    trust ONLY the marked lines — that's how the model's own preamble
  //    and sign-off get dropped without guessing at prose.
  const marked = lines.filter((l) => LIST_MARKER.test(l));
  const candidates = marked.length ? marked : lines;
  for (const line of candidates) {
    let text = line.replace(LIST_MARKER, "").trim();
    let kind: "fact" | "event" | null = null;
    const label = KIND_LABEL.exec(text);
    if (label) {
      kind = (label[1] ?? label[2]).toLowerCase() === "event" ? "event" : "fact";
      text = text.slice(label[0].length).trim();
    }
    // Strip stray wrapping quotes/backticks a list item may carry.
    text = text.replace(/^["'`]+|["'`,]+$/g, "").trim();
    if (!text) continue;
    if (!marked.length && isCommentaryLine(text)) continue;
    out.push({ kind: kind ?? inferKind(text), text });
  }
  return finalize(out);
}

/** Shared tail: length bounds, de-duplication within the paste itself, and
 *  the per-import ceiling. */
function finalize(items: ImportedMemory[]): ImportedMemory[] {
  const seen = new Set<string>();
  const out: ImportedMemory[] = [];
  for (const item of items) {
    const text = item.text.trim();
    if (text.length < MIN_TEXT || text.length > MAX_TEXT) continue;
    const fingerprint = text.toLowerCase();
    if (seen.has(fingerprint)) continue;
    seen.add(fingerprint);
    out.push({ kind: item.kind, text });
    if (out.length >= MAX_IMPORT_ITEMS) break;
  }
  return out;
}

/** Turns reviewed import items into real Memory records. Timestamped now —
 *  the source assistant never tells us when it learned something, and a
 *  fabricated older date would be a lie in the UI's "learned on" column. */
export function toMemories(items: ImportedMemory[]): Memory[] {
  const now = Date.now();
  return items.map((item) => ({
    id: uid(),
    text: item.text,
    kind: item.kind,
    createdAt: now,
  }));
}
