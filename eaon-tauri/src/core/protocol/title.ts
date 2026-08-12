// Naming a conversation with the model instead of the first thing the user
// typed — the port of the Mac app's Services/ConversationTitler.swift.
//
// A truncated-first-message title is a poor name and gets worse the more you
// have: a sidebar of "hi", "hi", "hello how are you doin…" is unusable for
// finding anything, and a long opening question clips mid-word into a
// fragment. The model has just read the whole exchange and is the only
// participant that actually knows what the conversation turned out to be
// about.

/** Short enough to read at a glance in a narrow sidebar without truncation.
 *  The prompt asks for this; `sanitizeTitle` enforces it, because a model
 *  asked for "2 to 5 words" will still occasionally write a sentence. */
export const MAX_TITLE_CHARACTERS = 38;

export const TITLE_SYSTEM_PROMPT = `You name chat conversations. Reply with ONLY the title — no quotes, no punctuation at the end, no preamble, no explanation.

Rules:
- 2 to 5 words. Never a full sentence.
- Describe what the conversation is ABOUT, not what the user said.
- Use the conversation's own language.
- No trailing period.

Examples:
"hey can you help me center a div in css" -> CSS centering help
"write me a snake game in python" -> Python snake game
"hi" -> Casual greeting`;

/** Both sides are capped: a title needs the gist, not the transcript, and
 *  sending a 40-message code dump to name a chat would cost more than the
 *  chat did. */
export function buildTitlePrompt(userText: string, assistantReply: string): string {
  return `User: ${userText.trim().slice(0, 600)}

Assistant: ${assistantReply.trim().slice(0, 600)}`;
}

// Leading/trailing junk a model wraps a title in: quotes, markdown emphasis,
// list bullets, dashes. Kept as one class so both ends strip identically.
const WRAPPER_CHARS = /^[\s"'`*_#–—•-]+|[\s"'`*_#–—•-]+$/g;
const TRAILING_STOPS = /^[.!,;:]+|[.!,;:]+$/g;
const LABEL_PREFIXES = ["title:", "chat title:", "conversation title:", "name:"];

/** Turns whatever the model actually said into something that belongs in a
 *  sidebar, or null if it gave nothing usable — in which case the caller
 *  keeps whatever title it already had. Assumes the worst, because models
 *  ignore formatting instructions often enough: a reasoning model emits
 *  <think> spans, a chatty one writes `Title: "CSS centering help"`, a small
 *  one returns a whole paragraph. */
export function sanitizeTitle(raw: string): string | null {
  let text = raw;

  // Strip a reasoning model's thinking block — the real answer follows it.
  for (;;) {
    const open = text.toLowerCase().indexOf("<think>");
    if (open === -1) break;
    const close = text.toLowerCase().indexOf("</think>", open);
    text = close === -1 ? text.slice(0, open) : text.slice(0, open) + text.slice(close + "</think>".length);
  }

  // First non-empty line only: anything after it is commentary the model was
  // asked not to write.
  let line = text
    .split("\n")
    .map((l) => l.trim())
    .find((l) => l.length > 0);
  if (!line) return null;

  // "Title: X" / "Conversation title: X" — drop the label, keep X.
  for (const prefix of LABEL_PREFIXES) {
    if (line.toLowerCase().startsWith(prefix)) {
      line = line.slice(prefix.length).trim();
    }
  }

  line = line.replace(WRAPPER_CHARS, "");
  line = line.replace(TRAILING_STOPS, "");
  line = line.replace(/\s+/g, " ").trim();

  if (!line) return null;
  // A model that returned a paragraph despite the instruction has not
  // produced a title; the caller's existing fallback beats a clipped essay.
  if (line.length > 120) return null;
  if (line.length > MAX_TITLE_CHARACTERS) {
    line = line.slice(0, MAX_TITLE_CHARACTERS).trim() + "…";
  }
  return line;
}
