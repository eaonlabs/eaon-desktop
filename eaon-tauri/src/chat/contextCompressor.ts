// Keeps a long conversation from sending its entire raw history on every
// message — the port of the Mac app's Services/ContextCompressor.swift.
//
// Below the trigger threshold this does nothing at all, so short chats pay
// zero extra cost or latency. Past it, everything older than the most recent
// `KEEP_VERBATIM_COUNT` messages is replaced by one compact running summary
// instead of being sent verbatim (or silently falling off the front of the
// window, which is what happens otherwise once the model or the provider
// behind it truncates on its own).
//
// The summary is incremental, not recomputed each time: a later compression
// re-reads only the newly-eligible span and folds it into the existing
// summary, so a conversation that keeps growing doesn't keep re-processing
// everything from message zero.

import type { ChatMessage, ConversationSummary } from "../core/types";
import { chatComplete } from "../core/ipc";
import { nextRequestId } from "../state/generation";
import type { ResolvedRoute } from "./modelRouting";

/** Below this many estimated tokens of prior history, never compress — a
 *  short chat has nothing worth compressing and the extra round trip would
 *  be pure latency for no benefit. */
export const MIN_TOKENS_TO_CONSIDER = 6_000;

/** Compress once prior history crosses this fraction of the model's context
 *  limit. Leaves real headroom for the system block, the new message and the
 *  reply, rather than waiting until the conversation is already at the wall. */
export const TRIGGER_FRACTION = 0.6;

/** However much gets summarized, the most recent this many messages always
 *  ride along verbatim — recent turns are what a reply most needs intact,
 *  and keeping them out of the summarized span means they are never
 *  re-paraphrased while they are still the active thread. */
export const KEEP_VERBATIM_COUNT = 16;

/** Cheap enough to call before every send. */
export function shouldCompress(
  messageCount: number,
  estimatedTokens: number,
  contextLimitTokens: number,
): boolean {
  if (messageCount <= KEEP_VERBATIM_COUNT) return false;
  if (estimatedTokens < MIN_TOKENS_TO_CONSIDER) return false;
  if (contextLimitTokens <= 0) return false;
  return estimatedTokens >= contextLimitTokens * TRIGGER_FRACTION;
}

/** The index that should stay verbatim from here on — everything before it
 *  is eligible to be folded into the summary. */
export function verbatimCutoff(messageCount: number): number {
  return Math.max(0, messageCount - KEEP_VERBATIM_COUNT);
}

function buildPrompt(transcript: string, existingText: string): string {
  if (existingText) {
    return `Here is a running summary of an ongoing conversation so far:
${existingText}

Here is what was said next, continuing from where that summary left off:
${transcript}

Write one updated summary that folds the new part into the existing one. Plain prose, concise, preserving names, decisions, numbers, and anything said that would be expected to still be remembered later. Do not mention that this is a summary or refer to "the conversation" — just state what's true. Reply with only the updated summary text, nothing else.`;
  }
  return `Summarize the following conversation concisely, in plain prose. Preserve names, decisions, numbers, and anything said that would be expected to still be remembered later. Do not mention that this is a summary or refer to "the conversation" — just state what's true. Reply with only the summary text, nothing else.

${transcript}`;
}

/** Produces an updated summary covering `messages[0..cutoffIndex)`, extending
 *  `existing` rather than re-summarizing the whole span again. Returns
 *  `existing` unchanged (possibly undefined) when there is nothing new to
 *  fold in, or when the model call fails — a failed attempt falls back to
 *  whatever summary already existed rather than losing it or silently
 *  sending nothing for the older span. */
export async function compress(opts: {
  messages: ChatMessage[];
  cutoffIndex: number;
  existing: ConversationSummary | undefined;
  route: ResolvedRoute;
}): Promise<ConversationSummary | undefined> {
  const { messages, cutoffIndex, existing, route } = opts;
  const startIndex = Math.min(existing?.coversMessagesUpTo ?? 0, messages.length);
  if (startIndex >= cutoffIndex) return existing;

  const newSpan = messages
    .slice(startIndex, cutoffIndex)
    .filter((m) => !m.isError && m.content.trim().length > 0);
  if (!newSpan.length) return existing;

  const transcript = newSpan
    .map((m) => `${m.role === "user" ? "User" : "Assistant"}: ${m.content}`)
    .join("\n\n");

  try {
    const raw = await chatComplete({
      baseUrl: route.baseUrl,
      apiKey: route.apiKey,
      trialDevice: route.trialDevice,
      trialSecret: route.trialSecret,
      trialKey: route.trialKey,
      model: route.requestModel,
      format: route.format,
      requestId: nextRequestId(),
      messages: [{ role: "user", content: buildPrompt(transcript, existing?.text ?? "") }],
    });
    const text = raw.trim();
    if (!text) return existing;
    return { text, coversMessagesUpTo: cutoffIndex, updatedAt: Date.now() };
  } catch {
    // Best-effort: keep the previous summary rather than dropping context.
    return existing;
  }
}

/** How the compressed span is reintroduced to the model. Kept here next to
 *  the prompt that produced it so the two stay consistent. */
export function summaryBlock(summary: ConversationSummary): string {
  return `Earlier in this conversation:\n${summary.text}`;
}
