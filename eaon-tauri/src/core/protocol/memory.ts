// Memory — the cross-platform port of the Mac app's MemoryExtractor +
// MemoryStore. Eaon silently mines durable facts about the user from a chat
// exchange (a background, non-streaming model call), stores them, and injects
// them into future chats so it feels like it remembers you. Same extraction
// prompt and "what qualifies" rules as macOS, so behavior matches.

import type { Memory } from "../types";

export interface ExtractedMemory {
  kind: "fact" | "event";
  text: string;
}

/** The shared "what to remember" contract — identical to the Mac app's
 *  current MemoryExtractor.whatToRemember (the post-quality-gate rewrite),
 *  so per-turn extraction never drifts from what the desktop app keeps.
 *  The Bad/Good examples and the "extract NOTHING when in doubt" rule are
 *  what stops a weak extractor model from mining implementation minutiae
 *  out of coding conversations. */
const WHAT_TO_REMEMBER = `Reply with ONLY a JSON array (no markdown, no commentary) of objects like {"kind": "fact", "text": "..."} or {"kind": "event", "text": "..."}.
- "fact": durable and HIGH-LEVEL — their name, role, location, relationships, preferences, and (at most) a single one-line summary of an ongoing project: what it's called and what it does. NEVER extract implementation detail as separate facts — file paths, folder structure, tool/function names, framework or library choices, entry points, build steps. That's the CONTENT of a coding task, not a fact about the user, and it's already useless the moment the project's architecture changes. Bad (never do this): {"text": "File structure: src/app.js, src/tools"}, {"text": "Tools: write_file, str_replace, read_file"}, {"text": "Framework: TypeScript"}, {"text": "Editor: Monaco"}. Good: {"text": "is building 'Lume Labs', an agentic AI coding platform"} — ONE fact, not ten.
- "event": a happening in their life a thoughtful friend would remember and ask about later — a trip, an exam, an interview, being sick, a hard week, weekend plans, something they're excited or worried about. Keep any stated timing in the text itself (e.g. "has a math final on Friday").
Extract ONLY from what the User themself wrote. The Assistant's words are context for understanding the User's message — never a source of facts; nothing the Assistant said, listed, or built qualifies on its own.
Never include: one-off requests to the assistant (like a coding task, including its implementation details), facts about the assistant, anything already in the known list, guesses, or sensitive details (health, finances, other people's private information) beyond what the user plainly volunteered as worth remembering.
When in doubt, extract NOTHING for that item — a handful of high-value facts beats a long list of granular ones; the model reading them back later has to make sense of the whole list at once, not just the one you're adding now.
Reply with [] if nothing qualifies.`;

export const MEMORY_SYSTEM_PROMPT = `You silently extract things worth remembering about a user, from one exchange of a chat, for a personalization feature.
${WHAT_TO_REMEMBER}`;

/** The user prompt for one exchange — the known facts, then the latest turn.
 *  The assistant reply is context only (the prompt says so explicitly) and
 *  capped hard: a long technical answer fed in wholesale is exactly where a
 *  weak extractor went mining for "facts" that were really implementation
 *  details of its own previous reply. The user's text keeps far more room —
 *  it's the only sanctioned source. */
export function buildExtractionPrompt(userText: string, assistantText: string, existing: string[]): string {
  const known = existing.length ? existing.map((t) => `- ${t}`).join("\n") : "(nothing yet)";
  return `Already known about the user:
${known}

Latest exchange:
User: ${userText.slice(0, 4000)}
Assistant (context only, never a source of facts): ${assistantText.slice(0, 1500)}

JSON array of NEW items worth remembering, or []:`;
}

/** Tolerant parse of the model's reply into memories — pulls the first JSON
 *  array even if the model wrapped it in prose or a ```json fence. */
export function parseExtraction(raw: string): ExtractedMemory[] {
  const start = raw.indexOf("[");
  const end = raw.lastIndexOf("]");
  if (start === -1 || end === -1 || end < start) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw.slice(start, end + 1));
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  const out: ExtractedMemory[] = [];
  for (const item of parsed) {
    if (item && typeof item === "object" && typeof (item as any).text === "string") {
      const text = (item as any).text.trim();
      const kind = (item as any).kind === "event" ? "event" : "fact";
      if (text) out.push({ kind, text });
    }
  }
  return out;
}

/** The system-message block injected into every request when memory is on. */
export function memoryBlock(memories: Memory[]): string {
  if (!memories.length) return "";
  const lines = memories.map((m) => `- ${m.text}`).join("\n");
  return `Things you remember about the user (from past conversations — use naturally, don't recite):\n${lines}`;
}

/** Lifetime storage ceiling, and how many items one extraction call may
 *  add — both matching the Mac MemoryStore's constants. */
export const MAX_MEMORIES = 250;
export const MAX_NEW_PER_EXTRACTION = 5;

/** Near-duplicate check by case-insensitive containment either way (the Mac
 *  store's isDuplicate) — not embeddings: this list is meant to stay short
 *  and human-readable, not grow an entry per slight rephrasing. */
export function isDuplicateMemory(existing: string[], candidate: string): boolean {
  const c = candidate.toLowerCase();
  return existing.some((t) => {
    const e = t.toLowerCase();
    return e.includes(c) || c.includes(e);
  });
}

/** Shape-based junk detector for AUTO-extracted memories — the port of the
 *  Mac MemoryStore.isLikelyUsefulMemory, a deterministic gate on top of the
 *  extraction prompt: the prompt asks for high-level durable facts, but the
 *  extractor runs on whatever model just answered, including small local
 *  ones that observably ignore the nuance and emit implementation minutiae
 *  ("Tools: write_file, str_replace", "File structure: src/app.js"). Code
 *  can hold the line a weak model won't. Manual entries are never filtered —
 *  what the user typed deliberately is theirs to keep. Every pattern here
 *  was taken from junk observed live in a real user's store: colon-label
 *  lists, file paths and extensions, snake_case identifiers, email/account
 *  plumbing, code fences, and fragments too short to be a sentence about a
 *  person. Deliberately conservative — a rejected real fact costs one
 *  forgotten detail; an accepted junk fact pollutes every future related
 *  conversation. */
export function isLikelyUsefulMemory(text: string): boolean {
  const trimmed = text.trim();
  if (trimmed.length < 8 || trimmed.length >= 300) return false;
  if (trimmed.split(/\s+/).length < 3) return false;
  if (trimmed.includes("```") || trimmed.includes("@")) return false;

  const junkPatterns = [
    /^[A-Za-z][A-Za-z ]{0,24}:\s/, // "Framework: …", "File structure: …"
    /[A-Za-z0-9]+_[A-Za-z0-9]+/, // write_file, Q4_K_M, snake_case anything
    /\b[\w-]+\.(js|jsx|ts|tsx|py|html?|css|json|md|swift|java|rb|go|rs|cpp|hpp|sh|ya?ml|toml|gguf|test)\b/i,
    /\w\/\w/, // path-ish: src/app, a/b
  ];
  return !junkPatterns.some((p) => p.test(trimmed));
}
