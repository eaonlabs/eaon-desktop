// Shared internals of the chat orchestration — the pieces send.ts,
// agentLoop.ts, and postTurn.ts all need without importing each other in a
// cycle: the turn context shape, the connected-MCP registry, the
// per-conversation "Always allow" list, the user-gate promises, and error
// phrasing. Not part of the UI's import surface (send.ts re-exports what
// the settings UI needs).

import type { EaonMode, McpToolInfo, ModelEntry } from "../core/types";
import type { WireMessage } from "../core/ipc";
import type { ResolvedRoute } from "./modelRouting";
import { useGeneration } from "../state/generation";

/** Everything one send carries through the multi-turn loop. `history` is
 *  the wire conversation (system block + turns); the loop appends
 *  assistant/tool-result entries as it goes. */
export interface TurnContext {
  conversationId: string;
  entry: ModelEntry;
  route: ResolvedRoute;
  sampling: Record<string, unknown> | null;
  mode: EaonMode;
  history: WireMessage[];
  /** The placeholder send.ts already appended for the first streamed turn. */
  firstAssistantId: string;
  /** The requestId the session was begun with (turn 1's cancel target). */
  firstRequestId: number;
  /** The user's text this send answers — memory extraction's input. */
  userText: string;
}

// ---------------------------------------------------------------------------
// Connected MCP tools — a module-level registry the settings UI fills when a
// server connects (REF kept this in mcpConnections state; the chat layer
// only ever needs "which servers are live and what tools do they carry").
// ---------------------------------------------------------------------------

export interface ConnectedMcpServer {
  serverId: string;
  name: string;
  tools: McpToolInfo[];
}

const mcpRegistry = new Map<string, { name: string; tools: McpToolInfo[] }>();

export function setConnectedMcpTools(serverId: string, name: string, tools: McpToolInfo[]): void {
  mcpRegistry.set(serverId, { name, tools });
}

export function clearConnectedMcpTools(serverId: string): void {
  mcpRegistry.delete(serverId);
}

export function connectedMcpTools(): ConnectedMcpServer[] {
  return [...mcpRegistry.entries()].map(([serverId, e]) => ({ serverId, name: e.name, tools: e.tools }));
}

// ---------------------------------------------------------------------------
// "Allow for this chat" — conversations where the user chose "always";
// skips further confirmations for the rest of that conversation only
// (REF allowAllConversations). Runtime-only by design: quitting the app
// re-arms the gate.
// ---------------------------------------------------------------------------

const allowAllConversations = new Set<string>();

export function conversationAllowsAll(conversationId: string): boolean {
  return allowAllConversations.has(conversationId);
}

export function allowAllForConversation(conversationId: string): void {
  allowAllConversations.add(conversationId);
}

// ---------------------------------------------------------------------------
// User gates — promises the agent loop awaits while a dialog is up. The
// resolver clears the pending slot first so a second resolve (e.g. from
// stopGeneration) is a harmless no-op.
// ---------------------------------------------------------------------------

/** Pause on the tool-confirmation dialog (Sandboxed mode) — REF confirmTool. */
export function requestToolConfirm(
  conversationId: string,
  summary: string,
  detail: string | null,
): Promise<"once" | "always" | "deny"> {
  return new Promise((resolve) => {
    useGeneration.getState().setPendingConfirm({
      conversationId,
      summary,
      detail,
      resolve: (decision) => {
        useGeneration.getState().setPendingConfirm(null);
        resolve(decision);
      },
    });
  });
}

/** Pause on the agent's ask_user dialog — REF askAgentQuestion. */
export function requestAgentAnswer(
  conversationId: string,
  question: string,
  options: string[],
): Promise<string> {
  return new Promise((resolve) => {
    useGeneration.getState().setPendingQuestion({
      conversationId,
      question,
      options,
      resolve: (answer) => {
        useGeneration.getState().setPendingQuestion(null);
        resolve(answer);
      },
    });
  });
}

// ---------------------------------------------------------------------------
// Error phrasing
// ---------------------------------------------------------------------------

/** The Rust layer phrases HTTP failures as "Server returned <status>. …".
 *  A 5xx is the provider's outage, not the user's setup — say so, and point
 *  at the one action that actually helps (switching model). */
export function friendlyStreamError(message: string): string {
  if (/Server returned 5\d\d/.test(message)) {
    return `${message}\n\nThis is a provider-side error — trying again or switching to a different model usually gets past it.`;
  }
  return message;
}

/** Appended to a reply's content when its stream ended without ever
 *  receiving the provider's real completion signal ([DONE] / message_stop)
 *  — the connection dropped, was closed by an intermediary, or otherwise
 *  ended mid-generation. The partial content received up to that point is
 *  real and kept; this just says so honestly instead of silently
 *  presenting a cut-off reply as finished. Mirrors the Mac app's identical
 *  streamTruncatedNotice (ChatViewModel.swift). */
export const streamTruncatedNotice =
  "\n\n⚠️ *This response may have been cut off before finishing — the connection ended unexpectedly. Ask the model to continue if something looks incomplete.*";

/** Who the model is on an ordinary Chat turn — short on purpose. Mirrors the
 *  Mac app's ChatViewModel.chatIdentityPrompt.
 *
 *  Chat mode had no general identity at all: with default settings the system
 *  block was assembled entirely from optional pieces (custom instructions,
 *  memory, search, plugins), so an untouched install sent a system block of
 *  literally zero messages and the model answered a greeting out of whatever
 *  its provider defaults to. The last line is not filler — with an
 *  instruction-heavy prompt and no real task, a small model will complete the
 *  *user's* turn instead of its own. */
export const CHAT_IDENTITY_PROMPT = `You are Eaon, a helpful AI assistant in a desktop chat app.

Match the message you're answering: a greeting or a quick question gets a short, natural reply — not a summary of what you can do, and not a menu of things you could build for the user.

Reply only as yourself, to what the user actually said. Never write the user's side of the conversation, and never invent a task they haven't asked for.`;

/** Whether this model gets the compact system prompt — small enough that the
 *  full instruction stack is actively harmful. Mirrors the Mac app's
 *  ChatViewModel.usesCompactPrompt, including its ordering: an explicit
 *  parameter count in the id settles the question either way, so a hosted
 *  `gemma-3-27b-it` is not treated as small just because it says "gemma". */
export function usesCompactPrompt(modelId: string, isLocal: boolean): boolean {
  const id = modelId.toLowerCase();
  const sizes = [...id.matchAll(/(\d+(?:\.\d+)?)\s*b\b/g)];
  if (sizes.length) return parseFloat(sizes[sizes.length - 1][1]) <= 7;

  // Hosted vendors publish a tier name instead of a parameter count, and the
  // small tiers behave exactly like the small local models this guard was
  // written for — GPT-5 Nano answered "hello" with a pitch for its coding
  // tools, then invented a project and started writing files.
  const smallTiers = ["nano", "mini", "haiku", "flash-lite", "flash lite", "tiny", "smol", "gemma", "phi-3", "phi3", "phi-4", "phi4"];
  if (smallTiers.some((t) => id.includes(t))) return true;

  // A local model whose id carries no size at all (`gemma3:latest`,
  // `mistral`, `llama3.2`) is overwhelmingly likely to be small — assume so,
  // which is the safe direction: worst case a capable model gets a leaner
  // prompt.
  return isLocal;
}
