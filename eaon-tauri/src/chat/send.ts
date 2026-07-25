// The chat send pipeline — the modular port of REF state.svelte.ts's send()
// half: append the user turn, resolve the model's route, assemble the
// system block (the Mac app's prompt order), rebuild the wire history, and
// hand the streamed multi-turn loop to agentLoop.runTurns.

import type { ChatMessage, McpServer, McpToolInfo, MessageAttachment, Skill } from "../core/types";
import type { WireMessage } from "../core/ipc";
import { cancelStream } from "../core/ipc";
import { uid } from "../core/utils";
import { buildContent } from "../core/attachments";
import { memoryBlock } from "../core/protocol/memory";
import { searchInstruction } from "../core/protocol/search";
import { IMAGE_INSTRUCTION } from "../core/protocol/images";
import { mcpInstructionBlock } from "../core/protocol/mcp";
import { agentInstruction } from "../core/protocol/agent";
import { useConversations } from "../state/conversations";
import { useGeneration, nextRequestId } from "../state/generation";
import { useModels } from "../state/models";
import { useSettings } from "../state/settings";
import { useUi } from "../state/ui";
import { resolveRoute, samplingBody } from "./modelRouting";
import { CHAT_IDENTITY_PROMPT, connectedMcpTools, usesCompactPrompt, type TurnContext } from "./internal";
import { runTurns } from "./agentLoop";
import { deriveTitleIfNeeded, resolveImageBackend } from "./postTurn";

// The settings UI records live MCP connections here (and clears them on
// disconnect) so the send pipeline knows which tools are real right now.
export { setConnectedMcpTools, clearConnectedMcpTools, connectedMcpTools } from "./internal";

/** Appends a failed-reply bubble — route problems and other pre-stream
 *  errors surface exactly like a streamed error would (REF isError flow). */
function appendErrorMessage(conversationId: string, text: string, modelKey?: string, modelDisplay?: string): void {
  useConversations.getState().appendMessage(conversationId, {
    id: uid(),
    role: "assistant",
    content: text,
    reasoning: "",
    isError: true,
    modelId: modelKey,
    modelDisplay,
    timestamp: Date.now(),
  });
}

/** Connected-and-enabled servers with their live tools, shaped for
 *  mcpInstructionBlock (REF connectedMcpEntries). The registry is keyed by
 *  id; the settings row supplies the record — a row mid-edit falls back to
 *  a minimal stand-in so a live connection is never silently untaught. */
function mcpPromptEntries(): Array<{ server: McpServer; tools: McpToolInfo[] }> {
  const { settings } = useSettings.getState();
  const entries: Array<{ server: McpServer; tools: McpToolInfo[] }> = [];
  for (const { serverId, name, tools } of connectedMcpTools()) {
    if (!tools.length) continue;
    const configured = settings.mcpServers.find((s) => s.id === serverId);
    if (configured && !configured.enabled) continue;
    entries.push({
      server: configured ?? {
        id: serverId, name, transport: "http", url: "", authScheme: "", token: "", command: "", args: "", enabled: true,
      },
      tools,
    });
  }
  return entries;
}

export async function sendMessage(opts: {
  conversationId: string;
  text: string;
  attachments?: MessageAttachment[];
  skill?: Skill | null;
}): Promise<void> {
  const { conversationId } = opts;
  const attachments = opts.attachments ?? [];
  const skill = opts.skill ?? null;
  const trimmed = opts.text.trim();
  // A message can be text, attachments, or both (the Mac composer's rule);
  // one generation per conversation at a time.
  if (!trimmed && !attachments.length) return;
  if (useGeneration.getState().isStreaming(conversationId)) return;

  const conversations = useConversations.getState();
  const entry = useModels.getState().entryFor(useModels.getState().selectedModelKey);

  const userMessage: ChatMessage = {
    id: uid(),
    role: "user",
    content: trimmed,
    reasoning: "",
    timestamp: Date.now(),
    invokedSkillName: skill?.name,
    attachments: attachments.length ? attachments : undefined,
  };
  conversations.appendMessage(conversationId, userMessage);
  deriveTitleIfNeeded(conversationId);

  if (!entry) {
    appendErrorMessage(conversationId, "No model is selected — pick one from the model menu first.");
    return;
  }
  conversations.recordPrompt(entry.key);

  // The session opens HERE — before route resolution and before the wire
  // history rebuilds attachments off disk. Both can take a visible moment,
  // and until the session exists there is no streaming flag, so the thread
  // rendered nothing and the app looked asleep between Send and the first
  // token. Everything below is wrapped so the session always closes.
  const requestId = nextRequestId();
  useGeneration.getState().begin(conversationId, requestId);
  try {
    const route = await resolveRoute(entry);
    if ("error" in route) {
      appendErrorMessage(conversationId, route.error, entry.key, entry.display);
      return;
    }

    const { settings } = useSettings.getState();
    const mode = useUi.getState().mode;

    // System block — the ARCHITECTURE/Mac order: the user's own directives
    // first, remembered context next, then tool teaching, mode instruction,
    // and a one-off /skill invocation freshest-last before the conversation.
    const system: WireMessage[] = [];
    // Chat's general identity, first and always. Agent mode has its own
    // identity inside agentInstruction ("You are Eaon's agent, working
    // directly on the user's machine"), so this would only compete there.
    if (mode !== "agent") {
      system.push({ role: "system", content: CHAT_IDENTITY_PROMPT });
    }
    // Small models drown in the plugin catalog — the same guard the Mac app
    // applies, and the reason a bare "hello" used to come back as a recital
    // of the tool instructions instead of a greeting.
    const compactPrompt = usesCompactPrompt(entry.requestId, entry.provider.kind === "ollama");
    const instructions = settings.customInstructions.trim();
    if (instructions) system.push({ role: "system", content: instructions });
    if (settings.memoryEnabled && settings.memories.length) {
      system.push({ role: "system", content: memoryBlock(settings.memories) });
    }
    if (settings.webSearchEnabled) {
      system.push({ role: "system", content: searchInstruction(new Date()) });
    }
    // Image teaching only when the fence could actually run — never teach a
    // tool with no backend (REF hasImageBackend gate).
    if (settings.imageToolEnabled && resolveImageBackend() !== null) {
      system.push({ role: "system", content: IMAGE_INSTRUCTION });
    }
    // Plugins ride in BOTH modes — the Agent gets the user's connected MCP
    // services alongside its computer tools, same as Cursor pairs codebase
    // tools with integrations.
    const pluginEntries = mcpPromptEntries();
    const mcpBlock = compactPrompt ? null : mcpInstructionBlock(pluginEntries);
    if (mcpBlock) system.push({ role: "system", content: mcpBlock });
    if (mode === "agent") {
      system.push({
        role: "system",
        content: agentInstruction({
          includeWiderTools: settings.deviceControlEnabled,
          hasPlugins: pluginEntries.length > 0,
          workspace: settings.agentWorkspace,
        }),
      });
    }
    if (skill) {
      system.push({
        role: "system",
        content: `The user has explicitly invoked the "${skill.name}" skill for this request — follow its instructions:\n\n${skill.instructions}`,
      });
    }

    // Wire history: every prior turn except failed replies (they teach
    // nothing), tool-result cards re-sent as user-role turns, attachments
    // rebuilt per the model's vision support. Reasoning is intentionally
    // never re-sent — chain-of-thought is display-only (REF wireHistory).
    const conversation = useConversations.getState().conversations.find((c) => c.id === conversationId);
    if (!conversation) return;
    const history: WireMessage[] = [...system];
    for (const m of conversation.messages) {
      if (m.isError) continue;
      const role = m.isToolResult ? "user" : m.role;
      if (m.attachments?.length) {
        history.push({ role, content: await buildContent(m.content, m.attachments, entry.supportsVision ?? false) });
      } else {
        history.push({ role, content: m.content });
      }
    }

    // Stopped while the route/history were still being prepared — the user
    // pressed stop before anything was ever sent, so don't open a stream (or
    // leave a stray empty bubble) now.
    if (useGeneration.getState().sessions[conversationId]?.stopped === true) return;

    // The assistant placeholder the first turn streams into.
    const assistantId = uid();
    conversations.appendMessage(conversationId, {
      id: assistantId,
      role: "assistant",
      content: "",
      reasoning: "",
      modelId: entry.key,
      modelDisplay: entry.display,
      timestamp: Date.now(),
      generationStartTime: Date.now(),
    });

    const ctx: TurnContext = {
      conversationId,
      entry,
      route,
      sampling: samplingBody(settings.modelParams),
      mode,
      history,
      firstAssistantId: assistantId,
      firstRequestId: requestId,
      userText: trimmed,
    };
    await runTurns(ctx);
  } finally {
    useGeneration.getState().end(conversationId);
  }
}

/** Stop this conversation's generation: flag the session so the turn loop
 *  breaks, cancel the in-flight stream, and unstick any paused dialog gate
 *  so the awaiting loop can actually exit (REF stopGeneration). */
export function stopGeneration(conversationId: string): void {
  const gen = useGeneration.getState();
  const session = gen.sessions[conversationId];
  gen.markStopped(conversationId);
  if (session) void cancelStream(session.requestId);
  if (gen.pendingConfirm?.conversationId === conversationId) gen.pendingConfirm.resolve("deny");
  if (gen.pendingQuestion?.conversationId === conversationId) {
    gen.pendingQuestion.resolve("(the user stopped the run)");
  }
}

/** The enabled skill behind a persisted invokedSkillName, if it still
 *  exists — a re-send should re-apply the skill the turn was sent with. */
function skillNamed(name: string | undefined): Skill | null {
  if (!name) return null;
  const { settings } = useSettings.getState();
  return settings.skills.find((s) => s.isEnabled && s.name === name) ?? null;
}

/** Drop this assistant reply (and everything after it) and re-send the user
 *  turn that produced it — REF regenerate, but for any reply, not just the
 *  last one. */
export async function regenerate(conversationId: string, assistantMessageId: string): Promise<void> {
  if (useGeneration.getState().isStreaming(conversationId)) return;
  const conversation = useConversations.getState().conversations.find((c) => c.id === conversationId);
  if (!conversation) return;
  const index = conversation.messages.findIndex((m) => m.id === assistantMessageId);
  if (index === -1) return;
  // Walk back to the real user turn (skipping tool-result cards, which are
  // user-role on the wire but not user-authored).
  let user: ChatMessage | null = null;
  for (let i = index - 1; i >= 0; i--) {
    const m = conversation.messages[i];
    if (m.role === "user" && !m.isToolResult) {
      user = m;
      break;
    }
  }
  if (!user) return;
  useConversations.getState().truncateFrom(conversationId, user.id);
  await sendMessage({
    conversationId,
    text: user.content,
    attachments: user.attachments,
    skill: skillNamed(user.invokedSkillName),
  });
}

/** Replace a user turn's text and re-run the conversation from there. The
 *  original attachments ride along — editing a caption must not silently
 *  drop the image it captioned. */
export async function editAndResend(conversationId: string, userMessageId: string, newText: string): Promise<void> {
  if (useGeneration.getState().isStreaming(conversationId)) return;
  const conversation = useConversations.getState().conversations.find((c) => c.id === conversationId);
  const original = conversation?.messages.find((m) => m.id === userMessageId);
  if (!conversation || !original || original.role !== "user" || original.isToolResult) return;
  useConversations.getState().truncateFrom(conversationId, userMessageId);
  await sendMessage({
    conversationId,
    text: newText,
    attachments: original.attachments,
    skill: skillNamed(original.invokedSkillName),
  });
}
