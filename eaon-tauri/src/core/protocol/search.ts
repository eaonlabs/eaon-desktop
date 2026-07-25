// Web search — the cross-platform port of WebSearchTool: the `eaon:search`
// fence channel and its system-prompt teaching text. The actual HTTP call
// lives in Rust (web_search command); this module is the pure fence/format
// logic, shaped exactly like images.ts's fence handling.

import type { WebSearchHit } from "../ipc";

/** One page-snippet result — mirrors WebSearchResult (the ipc wire shape). */
export type { WebSearchHit } from "../ipc";

/** "Friday, July 10, 2026 at 6:57 PM PDT" — en-US text regardless of the
 *  PC's locale, but the user's own time zone (mirrors contextDateFormatter). */
export function contextDate(now: Date = new Date()): string {
  return now.toLocaleString("en-US", {
    weekday: "long",
    year: "numeric",
    month: "long",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZoneName: "short",
  });
}

/** Mirrors WebSearchTool.agentInstructionBlock — leads with the real device
 *  clock so "what's today" never becomes a search. */
export function searchInstruction(now: Date = new Date()): string {
  return `The current date and time is ${contextDate(now)}. Use this directly for anything about today, "now", or the current date/time — never search the web for it.

You also have live web search — real internet search, not just what you already know. Use it ONLY when a question genuinely needs current, real-world information you can't be sure of:
- Recent or breaking news, current events, an unfolding situation
- Today's prices, scores, weather, exchange rates, or similar live figures
- The latest version, release, result, or status of something
- Any fact that may have changed since your training, or that you'd otherwise be guessing at

Do NOT search for things you already know or can work out yourself — general knowledge, explanations, math, coding, writing, reasoning, definitions — or for the current date/time given above. Never search speculatively or "just to check."

To search, use a fenced block with the query as JSON:

\`\`\`eaon:search
{"query": "focused search keywords"}
\`\`\`

Always close the fence with \`\`\` on its own line. After your reply, any eaon:search calls run and their results (page snippets with source URLs) come back to you in a message beginning "[Tool results". You then continue — this loops until you reply with no tool calls. When you use what search returned, cite the source URLs. Once you can answer, reply in plain language — never end your turn on a raw tool call.`;
}

/** Extracts every \`\`\`eaon:search fence's query. */
export function parseSearchQueries(text: string): string[] {
  const queries: string[] = [];
  const fence = /```[^\S\n]*eaon:search[^\n]*\n([\s\S]*?)```/g;
  let m: RegExpExecArray | null;
  while ((m = fence.exec(text)) !== null) {
    const body = m[1].trim();
    try {
      const parsed = JSON.parse(body);
      if (parsed && typeof parsed.query === "string" && parsed.query.trim()) {
        queries.push(parsed.query.trim());
        continue;
      }
    } catch {
      // Not JSON — a bare-keywords body still counts as the query.
    }
    if (body && !body.startsWith("{")) queries.push(body);
  }
  return queries;
}

/** Removes executed search fences from the visible reply. */
export function stripSearchFences(text: string): string {
  return text
    .replace(/```[^\S\n]*eaon:search[^\n]*\n[\s\S]*?```/g, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** Numbered so the model can cite "result 2" unambiguously — mirrors
 *  formattedResultsForModel. */
export function formatSearchResults(results: WebSearchHit[]): string {
  if (!results.length) return "No results found.";
  return results.map((r, i) => `${i + 1}. ${r.url}\n   ${r.snippet}`).join("\n\n");
}
