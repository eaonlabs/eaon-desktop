// After-the-turn work: image fence execution, first-exchange titling,
// background memory extraction, and per-turn stat/stamp bookkeeping — the
// port of REF state.svelte.ts's resolveImageFences / generateImageAttachment
// / extractMemories / streamStep-finalize pieces.

import { chatComplete, generateImage, saveAttachment } from "../core/ipc";
import type { MessageAttachment, Memory } from "../core/types";
import { EAON_HOSTED_BASE_URL } from "../core/catalog";
import { deriveTitle, estimateTokens, uid } from "../core/utils";
import {
  buildExtractionPrompt,
  isDuplicateMemory,
  isLikelyUsefulMemory,
  MAX_MEMORIES,
  MAX_NEW_PER_EXTRACTION,
  MEMORY_SYSTEM_PROMPT,
  parseExtraction,
} from "../core/protocol/memory";
import { useConversations } from "../state/conversations";
import { nextRequestId } from "../state/generation";
import { useModels } from "../state/models";
import { useSettings } from "../state/settings";
import { activeTrial, type ResolvedRoute } from "./modelRouting";

// ---------------------------------------------------------------------------
// Image generation
// ---------------------------------------------------------------------------

export interface ImageBackend {
  /** Wire format for ipc.generateImage — "openai" | "automatic1111" |
   *  "ollama" | "eaon" (Rust also accepts the legacy tag it aliases). */
  format: string;
  baseUrl: string;
  model: string;
  apiKey: string | null;
}

/** The first backend that can actually run, or null. Order: the user's own
 *  configured connections win (the first COMPLETE one — a half-filled card,
 *  like a fresh "Custom" preset with no base URL yet, is skipped instead of
 *  poisoning every request), then Eaon's hosted image models (a key or a
 *  live Free Week both qualify — same rule models.ts uses to list them),
 *  then a local Ollama diffusion model. Also gates the IMAGE_INSTRUCTION
 *  teaching block, so the model is never taught a tool that can't run. */
export function resolveImageBackend(): ImageBackend | null {
  const { settings } = useSettings.getState();
  const models = useModels.getState();

  for (const provider of settings.imageProviders) {
    const baseUrl = provider.baseURL.trim();
    if (!baseUrl) continue;
    const model = (provider.modelIDs[0] ?? "").trim();
    // A1111 runs whatever's loaded (the id is just a label); every other
    // format needs a real model id in the request body.
    if (provider.format !== "automatic1111" && !model) continue;
    return {
      format: provider.format,
      baseUrl,
      model,
      apiKey: provider.apiKey || null,
    };
  }

  const hostedKey = settings.eaonApiKey.trim() || activeTrial(settings.trialCredential)?.key || "";
  const hostedModel = models.hostedImageModels[0];
  if (hostedKey && hostedModel) {
    return { format: "eaon", baseUrl: EAON_HOSTED_BASE_URL, model: hostedModel.id, apiKey: hostedKey };
  }

  const diffusion = models.ollamaModels.find((m) => m.capabilities?.includes("image"));
  if (diffusion) {
    return { format: "ollama", baseUrl: settings.ollamaBaseUrl, model: diffusion.name, apiKey: null };
  }

  return null;
}

/** Generate each prompt's image, store it through the attachments dir, and
 *  attach onto the assistant message that asked. A failure lands as a short
 *  note instead of a broken fence (REF resolveImageFences). */
export async function executeImagePrompts(
  prompts: string[],
  conversationId: string,
  messageId: string,
): Promise<void> {
  const attachments: MessageAttachment[] = [];
  let failure: string | null = null;

  for (const prompt of prompts.slice(0, 3)) {
    // Re-resolved per prompt — cheap, and a mid-run settings change never
    // strands a stale credential.
    const backend = resolveImageBackend();
    if (!backend) {
      failure = "No image backend is set up — add one in Settings → Images.";
      break;
    }
    try {
      const result = await generateImage({
        format: backend.format,
        baseUrl: backend.baseUrl,
        model: backend.model,
        prompt,
        apiKey: backend.apiKey,
      });
      const stored = await saveAttachment(result.dataBase64, result.suggestedFileName);
      attachments.push({
        id: uid(),
        fileName: result.suggestedFileName,
        kind: "image",
        storedFileName: stored,
        mimeType: "image/png",
      });
    } catch (e) {
      failure = e instanceof Error ? e.message : String(e);
    }
  }

  useConversations.getState().updateMessage(conversationId, messageId, (m) => {
    let content = m.content;
    // The reply may have been nothing but the fence — give the image a line.
    if (attachments.length && !content.trim()) content = "Here you go.";
    if (failure) {
      content = content
        ? `${content}\n\n*Image generation failed: ${failure}*`
        : `Image generation failed: ${failure}`;
    }
    return {
      ...m,
      content,
      attachments: attachments.length ? [...(m.attachments ?? []), ...attachments] : m.attachments,
      isGeneratedImage: attachments.length ? true : m.isGeneratedImage,
    };
  });
}

// ---------------------------------------------------------------------------
// Titles
// ---------------------------------------------------------------------------

/** First-exchange auto-title: while the conversation is still "New chat",
 *  derive from the first real user turn (or its attachment names when the
 *  message was files-only — REF's titleSeed). */
export function deriveTitleIfNeeded(conversationId: string): void {
  const conversation = useConversations.getState().conversations.find((c) => c.id === conversationId);
  if (!conversation || conversation.title !== "New chat") return;
  const firstUser = conversation.messages.find((m) => m.role === "user" && !m.isToolResult);
  if (!firstUser) return;
  const seed = firstUser.content.trim() || (firstUser.attachments ?? []).map((a) => a.fileName).join(", ");
  if (seed) useConversations.getState().setTitle(conversationId, deriveTitle(seed));
}

// ---------------------------------------------------------------------------
// Memory extraction
// ---------------------------------------------------------------------------

/** Background fact-extraction from one exchange — one non-streaming call on
 *  the SAME route the chat used (no second credential path to break),
 *  deduped against what's already known. Best-effort: any failure is
 *  swallowed; personalization is never worth an error in the user's face
 *  (REF extractMemories / Mac MemoryExtractor.run). */
export async function extractMemories(
  route: ResolvedRoute,
  userText: string,
  assistantText: string,
): Promise<void> {
  try {
    const { settings } = useSettings.getState();
    if (!settings.memoryEnabled) return;
    if (settings.memories.length >= MAX_MEMORIES) return;
    if (!userText.trim()) return;
    const existing = settings.memories.map((m) => m.text);
    const raw = await chatComplete({
      baseUrl: route.baseUrl,
      apiKey: route.apiKey,
      trialDevice: route.trialDevice,
      trialSecret: route.trialSecret,
      trialKey: route.trialKey,
      model: route.requestModel,
      format: route.format,
      requestId: nextRequestId(),
      messages: [
        { role: "system", content: MEMORY_SYSTEM_PROMPT },
        { role: "user", content: buildExtractionPrompt(userText, assistantText, existing) },
      ],
    });
    // Re-read after the await — the user may have edited memories meanwhile.
    const fresh = useSettings.getState().settings;
    if (!fresh.memoryEnabled) return;
    const knownTexts = fresh.memories.map((m) => m.text);
    const additions: Memory[] = [];
    for (const item of parseExtraction(raw)) {
      // Same defenses as the Mac store's addExtracted, in the same order:
      // per-call cap, lifetime cap, containment dedup, then the deterministic
      // junk gate that holds the line when a weak extractor model ignores
      // the prompt's "high-level facts only" rule.
      if (additions.length >= MAX_NEW_PER_EXTRACTION) break;
      if (knownTexts.length + additions.length >= MAX_MEMORIES) break;
      const text = item.text.trim();
      if (!text || isDuplicateMemory(knownTexts, text)) continue;
      if (!isLikelyUsefulMemory(text)) continue;
      knownTexts.push(text);
      additions.push({ id: uid(), text, kind: item.kind, createdAt: Date.now() });
    }
    if (additions.length) {
      useSettings.getState().update({ memories: [...fresh.memories, ...additions] });
    }
  } catch {
    // Best-effort by design.
  }
}

// ---------------------------------------------------------------------------
// Per-turn bookkeeping
// ---------------------------------------------------------------------------

/** Stamp a completed streamed reply (end time, ~token count for the
 *  tokens/sec badge) and record its output in statistics — REF streamStep's
 *  finally block plus the perModel counters. */
export function finalizeTurn(
  conversationId: string,
  messageId: string,
  modelKey: string,
  content: string,
): void {
  useConversations.getState().updateMessage(conversationId, messageId, (m) => ({
    ...m,
    generationEndTime: Date.now(),
    generatedTokenCount: Math.max(1, estimateTokens(content.length)),
  }));
  if (content.length) useConversations.getState().recordGenerated(modelKey, content.length);
}
