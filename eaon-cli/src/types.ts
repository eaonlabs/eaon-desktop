// Shared types across the whole CLI. Mirrors the shape of the Mac app's
// ChatMessage/DesktopTool/ModelEntry (ChatViewModel.swift, DesktopControl.swift)
// and the Tauri core's ModelEntry (types.ts) so the three surfaces agree on
// what a "model", a "turn", and a "tool" mean — even though this file is a
// fresh implementation, not a code port.

export type EaonMode = "chat" | "agent" | "claw";
/** How much the agent may do without asking:
 *  - plan:      read/search freely, but every mutating tool is refused —
 *               the model researches and proposes, the user approves before
 *               anything changes. The tier that makes big autonomous work
 *               safe to start.
 *  - sandboxed: every mutating action asks first (the default).
 *  - auto:      mutating actions run immediately (unattended). */
export type PermissionMode = "plan" | "sandboxed" | "auto";
export type Role = "system" | "user" | "assistant" | "tool";

export interface ToolCallRequest {
  id: string;
  name: string;
  /** Raw JSON text as streamed/returned by the model — parsed lazily so a
   * malformed call can be reported instead of throwing mid-stream. */
  arguments: string;
}

/** One turn in the conversation sent to / received from a provider. */
export interface Turn {
  role: Role;
  content: string;
  /** Assistant chain-of-thought (reasoning models). Shown to the user,
   * stripped before the turn is replayed back to the model as history. */
  reasoning?: string;
  /** Present on an assistant turn that is requesting tool execution. */
  toolCalls?: ToolCallRequest[];
  /** Present on a tool-role turn: which call this is answering. */
  toolCallId?: string;
  /** Present on a tool-role turn: the tool's name (some APIs want this). */
  name?: string;
  isError?: boolean;
}

export interface ToolParameterSchema {
  type: "object";
  properties: Record<string, unknown>;
  required: string[];
}

export interface ToolDefinition {
  name: string;
  description: string;
  parameters: ToolParameterSchema;
  /** Runs without a permission prompt even in Sandboxed mode. */
  readOnly?: boolean;
}

export interface ToolResult {
  isError: boolean;
  text: string;
}

export type ProviderRef =
  | { kind: "aqua" }
  | { kind: "ollama" }
  | { kind: "custom"; id: string; displayName: string };

/** A selectable chat model with its serving connection resolved. */
export interface ModelEntry {
  /** Unique picker key, e.g. "aqua:gpt-5.5", "ollama:gemma4:e2b", "custom:<id>:<model>". */
  key: string;
  /** What goes in the request's "model" field. */
  requestId: string;
  display: string;
  provider: ProviderRef;
  tier?: string | null;
  /** Best-effort hint from the backend (Ollama's `capabilities` list
   * includes "tools" when known) — undefined means "unknown, try native
   * tool-calling and fall back to the text fence on failure." */
  supportsTools?: boolean;
}

/** Which wire shape a BYOK connection speaks — mirrors the Mac app's
 * `APIRequestFormat` exactly, since a provider imported via /link carries
 * this straight over from Eaon Desktop's own saved config. */
export type CustomProviderFormat = "openAICompatible" | "anthropicMessages" | "googleGemini";

export interface CustomProviderConfig {
  id: string;
  displayName: string;
  baseURL: string;
  apiKey: string;
  /** User-entered model ids this connection serves (BYOK endpoints aren't
   * assumed to expose a working /models listing). */
  modelIDs: string[];
  /** Defaults to "openAICompatible" when absent — every provider config
   * saved before this field existed (or entered via /link before it
   * carried format) is one, so this keeps old config files decoding as
   * exactly what they always were. */
  format?: CustomProviderFormat;
}

export interface EaonConfig {
  aquaApiKey: string;
  ollamaBaseUrl: string;
  customProviders: CustomProviderConfig[];
  selectedModelKey: string | null;
  permissionMode: PermissionMode;
  defaultMode: EaonMode;
  customInstructions: string;
}

export type ChatStreamEvent =
  | { type: "token"; text: string }
  | { type: "reasoning"; text: string }
  | { type: "tool_call_start"; index: number; id: string; name: string }
  | { type: "tool_call_delta"; index: number; argumentsFragment: string }
  | { type: "done"; finishReason: string | null }
  | { type: "error"; message: string; status?: number };

export interface ChatRequestOptions {
  baseUrl: string;
  apiKey: string | null;
  model: string;
  turns: Turn[];
  tools?: ToolDefinition[];
  signal?: AbortSignal;
  /** Defaults to "openAICompatible" — Aqua and Ollama are always this
   * shape; only a BYOK custom provider can be anything else. */
  format?: CustomProviderFormat;
}
