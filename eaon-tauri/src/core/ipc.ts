// The typed boundary to the Rust core. Every command the backend exposes has
// exactly one wrapper here — UI code never calls invoke() directly, so the
// full Rust surface is greppable from this one file.

import { invoke, Channel } from "@tauri-apps/api/core";
import type {
  ContentPart,
  McpToolInfo,
  OllamaModel,
  ProviderFormat,
  ProviderModel,
  SystemSpecs,
} from "./types";

// ---------------------------------------------------------------------------
// Chat
// ---------------------------------------------------------------------------

export interface WireMessage {
  role: string;
  /** Plain string, or OpenAI content-parts for vision turns. Rust translates
   *  to the Anthropic/Gemini shapes when the format demands it. */
  content: string | ContentPart[];
}

export interface ChatRequestArgs {
  baseUrl: string;
  apiKey?: string | null;
  /** Free Week signing material — used only when apiKey is absent. All
   *  three travel together: trialKey is the Bearer credential itself
   *  (the gateway's first gate, before it even looks at the signature),
   *  trialDevice/trialSecret produce the X-Eaon-* signature headers. */
  trialDevice?: string | null;
  trialSecret?: string | null;
  trialKey?: string | null;
  model: string;
  messages: WireMessage[];
  requestId: number;
  /** User-opted sampling fields merged into the body verbatim; absent
   *  fields are NOT sent (reasoning models reject a neutral temperature). */
  sampling?: Record<string, unknown> | null;
  /** Wire format of the target endpoint. Defaults to "openai". */
  format?: ProviderFormat;
}

export type StreamEvent =
  | { type: "token"; text: string }
  | { type: "reasoning"; text: string }
  /** The attempt so far was cut off and is being re-requested from scratch —
   *  discard everything received for this reply and start accumulating
   *  again. Rust re-asks rather than leaving a half-written answer; see
   *  STREAM_MAX_ATTEMPTS in chat.rs. */
  | { type: "restart" }
  /** truncated: the byte stream ended without ever seeing the provider's
   *  real completion signal ([DONE] / message_stop) — the connection
   *  dropped mid-generation rather than the model actually finishing.
   *  Always false when cancelled is true (that's a deliberate stop, not a
   *  mystery drop) and always false for Gemini, which has no completion
   *  signal by protocol — the stream ending IS its done signal there. */
  | { type: "done"; cancelled: boolean; truncated: boolean }
  | { type: "error"; message: string };

/** Opens a streaming chat; events arrive on the returned channel until a
 *  `done`/`error`. Cancel with cancelStream(requestId). */
export async function chatStream(
  request: ChatRequestArgs,
  onEvent: (event: StreamEvent) => void,
): Promise<void> {
  const channel = new Channel<StreamEvent>();
  channel.onmessage = onEvent;
  await invoke("chat_stream", { request, onEvent: channel });
}

/** One non-streaming completion — background work (memory extraction,
 *  titles), never a visible chat. */
export function chatComplete(request: ChatRequestArgs): Promise<string> {
  return invoke<string>("chat_complete", { request });
}

export function cancelStream(requestId: number): Promise<void> {
  return invoke("cancel_stream", { requestId });
}

// ---------------------------------------------------------------------------
// Models
// ---------------------------------------------------------------------------

export function ollamaTags(baseUrl: string): Promise<OllamaModel[]> {
  return invoke<OllamaModel[]>("ollama_tags", { baseUrl });
}

export type PullEvent =
  | { type: "progress"; status: string; completed: number; total: number }
  | { type: "done" }
  | { type: "error"; message: string };

export async function ollamaPull(
  baseUrl: string,
  model: string,
  onEvent: (event: PullEvent) => void,
): Promise<void> {
  const channel = new Channel<PullEvent>();
  channel.onmessage = onEvent;
  await invoke("ollama_pull", { baseUrl, model, onEvent: channel });
}

export function ollamaDelete(baseUrl: string, model: string): Promise<void> {
  return invoke("ollama_delete", { baseUrl, model });
}

/** llama.cpp — whether llama-server exists on this PC, and whether ours is
 *  currently serving a model. (There is no MLX counterpart: MLX is
 *  Apple-silicon only.) */
export interface LlamaStatus {
  installed: boolean;
  binaryPath: string | null;
  running: boolean;
  modelPath: string | null;
  port: number;
  baseUrl: string;
}

export function llamaStatus(): Promise<LlamaStatus> {
  return invoke<LlamaStatus>("llama_status");
}

/** Starts llama-server for one GGUF file. Resolves once it answers, so the
 *  caller can trust `running` rather than having to poll. */
export function llamaStart(opts: {
  modelPath: string;
  gpuLayers?: number | null;
  contextSize?: number | null;
}): Promise<LlamaStatus> {
  return invoke<LlamaStatus>("llama_start", {
    modelPath: opts.modelPath,
    gpuLayers: opts.gpuLayers ?? null,
    contextSize: opts.contextSize ?? null,
  });
}

export function llamaStop(): Promise<void> {
  return invoke("llama_stop");
}

/** Browser control — the loopback bridge the Eaon browser extension pairs
 *  with. Wire-compatible with the Mac app's, so the same extension works. */
export interface BrowserStatus {
  running: boolean;
  port: number | null;
  token: string;
  /** The extension has polled recently enough to count as paired. */
  connected: boolean;
  tab: string | null;
}

export function browserStatus(): Promise<BrowserStatus> {
  return invoke<BrowserStatus>("browser_status");
}

export function browserStart(): Promise<BrowserStatus> {
  return invoke<BrowserStatus>("browser_start");
}

export function browserRegenerateToken(): Promise<BrowserStatus> {
  return invoke<BrowserStatus>("browser_regenerate_token");
}

export function fetchProviderModels(
  baseUrl: string,
  apiKey?: string | null,
): Promise<ProviderModel[]> {
  return invoke<ProviderModel[]>("fetch_provider_models", { baseUrl, apiKey });
}

// ---------------------------------------------------------------------------
// Fetches, search, images
// ---------------------------------------------------------------------------

export function fetchTextUrl(url: string): Promise<string> {
  return invoke<string>("fetch_text_url", { url });
}

export interface WebSearchHit {
  url: string;
  snippet: string;
}

export function webSearch(query: string): Promise<WebSearchHit[]> {
  return invoke<WebSearchHit[]>("web_search", { query });
}

export interface ImageGenArgs {
  /** "openai" | "automatic1111" | "ollama" | "eaon" */
  format: string;
  baseUrl: string;
  model: string;
  prompt: string;
  apiKey?: string | null;
}

export interface ImageGenResult {
  dataBase64: string;
  suggestedFileName: string;
}

export function generateImage(request: ImageGenArgs): Promise<ImageGenResult> {
  return invoke<ImageGenResult>("generate_image", { request });
}

// ---------------------------------------------------------------------------
// Attachments & persistence
// ---------------------------------------------------------------------------

export function saveAttachment(dataBase64: string, fileName: string): Promise<string> {
  return invoke<string>("save_attachment", { dataBase64, fileName });
}

export function readAttachment(storedFileName: string): Promise<string> {
  return invoke<string>("read_attachment", { storedFileName });
}

export function loadAppState(): Promise<string> {
  return invoke<string>("load_app_state");
}

export function saveAppState(json: string): Promise<void> {
  return invoke("save_app_state", { json });
}

/** Where state.json/attachments/downloaded models actually live on disk —
 *  Settings → General shows this path and offers to reveal it. */
export function appDataDirPath(): Promise<string> {
  return invoke<string>("app_data_dir_path");
}

// ---------------------------------------------------------------------------
// Skills, specs, proxy
// ---------------------------------------------------------------------------

export interface ClaudeSkillCandidate {
  path: string;
  text: string;
}

export function scanClaudeSkills(): Promise<ClaudeSkillCandidate[]> {
  return invoke<ClaudeSkillCandidate[]>("scan_claude_skills");
}

export function systemSpecs(): Promise<SystemSpecs> {
  return invoke<SystemSpecs>("system_specs");
}

/** Sets (or clears, with null/"") the outbound proxy for ALL Rust HTTP. */
export function setProxy(url: string | null): Promise<void> {
  return invoke("set_proxy", { url });
}

// ---------------------------------------------------------------------------
// Free Week trial
// ---------------------------------------------------------------------------

export interface TrialStartResult {
  key: string;
  secret: string;
  /** Unix seconds. */
  expiresAt: number;
}

export function trialStart(): Promise<TrialStartResult> {
  return invoke<TrialStartResult>("trial_start");
}

export interface TrialStatusResult {
  active: boolean;
  expiresAt: number | null;
  totalRequests: number | null;
  /** Server revocation code ("trial_revoked"/"trial_invalid") when dead. */
  revokedCode: string | null;
}

export function trialStatus(device: string, secret: string): Promise<TrialStatusResult> {
  return invoke<TrialStatusResult>("trial_status", { device, secret });
}

export interface TrialGiftStatus {
  claimed: number;
  total: number;
  remaining: number;
  expiresAt: number | null;
  available: boolean;
  supportEmail: string | null;
}

export function trialGift(): Promise<TrialGiftStatus> {
  return invoke<TrialGiftStatus>("trial_gift");
}

/** The stable per-device hash used for trial binding (Rust reads the OS
 *  machine id; falls back to a persisted random id). */
export function trialDeviceHash(): Promise<string> {
  return invoke<string>("trial_device_hash");
}

// ---------------------------------------------------------------------------
// Agent tools
// ---------------------------------------------------------------------------

export interface ToolOutcome {
  ok: boolean;
  text: string;
}

export function runAgentTool(
  name: string,
  args: Record<string, unknown>,
): Promise<ToolOutcome> {
  return invoke<ToolOutcome>("run_agent_tool", { name, args });
}

// ---------------------------------------------------------------------------
// Local API server
// ---------------------------------------------------------------------------

export interface LocalServerUpstream {
  modelIds: string[];
  baseUrl: string;
  apiKey?: string | null;
}

export interface LocalServerConfig {
  port: number;
  requireApiKey: boolean;
  apiKey: string;
  upstreams: LocalServerUpstream[];
}

export function startLocalServer(config: LocalServerConfig): Promise<void> {
  return invoke("start_local_server", { config });
}

export function stopLocalServer(): Promise<void> {
  return invoke("stop_local_server");
}

export function localServerRunning(): Promise<boolean> {
  return invoke<boolean>("local_server_running");
}

// ---------------------------------------------------------------------------
// MCP
// ---------------------------------------------------------------------------

export interface McpConnectArgs {
  serverId: string;
  transport: "http" | "stdio";
  url?: string | null;
  authScheme?: string | null;
  token?: string | null;
  /** Extra per-request headers (catalog `extraHeaders`, e.g. GitHub's
   *  X-MCP-Toolsets) — sent on every MCP request for this connection. */
  extraHeaders?: Record<string, string> | null;
  command?: string | null;
  args?: string[] | null;
}

export function mcpConnect(args: McpConnectArgs): Promise<McpToolInfo[]> {
  return invoke<McpToolInfo[]>("mcp_connect", { args });
}

export function mcpCall(
  serverId: string,
  tool: string,
  callArgs: Record<string, unknown>,
): Promise<string> {
  return invoke<string>("mcp_call", { serverId, tool, args: callArgs });
}

export function mcpDisconnect(serverId: string): Promise<void> {
  return invoke("mcp_disconnect", { serverId });
}

// ---------------------------------------------------------------------------
// MCP OAuth — sign-in for catalog servers that require it (core/mcpCatalog.ts)
// ---------------------------------------------------------------------------

export interface McpOAuthConnectArgs {
  serverId: string;
  endpoint: string;
  /** true only in direct response to the user clicking "Sign in" — opens
   *  the system browser. false (launch-time reconnect) only attempts a
   *  silent token reuse/refresh. */
  interactive: boolean;
  clientId?: string | null;
  clientSecret?: string | null;
  accessToken?: string | null;
  refreshToken?: string | null;
  expiresAt?: number | null;
  manualClientId?: string | null;
  /** Catalog `extraHeaders` for this server, forwarded once signed in. */
  extraHeaders?: Record<string, string> | null;
}

export interface McpOAuthCredentials {
  clientId: string;
  clientSecret: string | null;
}

export interface McpOAuthTokens {
  accessToken: string;
  refreshToken: string | null;
  expiresAt: number | null;
}

export type McpOAuthResult =
  | { kind: "connected"; credentials: McpOAuthCredentials; tokens: McpOAuthTokens; tools: McpToolInfo[] }
  | { kind: "needsManualClientId" }
  | { kind: "notConnected" };

export function mcpOAuthConnect(args: McpOAuthConnectArgs): Promise<McpOAuthResult> {
  return invoke<McpOAuthResult>("mcp_oauth_connect", { args });
}

// ---------------------------------------------------------------------------
// Eaon CLI — install + credential linking (Settings → Tools → Eaon CLI)
// ---------------------------------------------------------------------------

export interface CliStatus {
  nodePath: string | null;
  nodeHint: string;
  entryPoint: string | null;
  cliDirectory: string | null;
  version: string | null;
  installedVersion: string | null;
  bundledVersion: string | null;
  isReady: boolean;
  canInstall: boolean;
  updateAvailable: string | null;
  installedDirectory: string;
  configFile: string;
  configDirectory: string;
  globalCommandPath: string;
}

export function eaonCliStatus(): Promise<CliStatus> {
  return invoke<CliStatus>("eaon_cli_status");
}

export function eaonCliInstall(): Promise<void> {
  return invoke("eaon_cli_install");
}

export interface LinkProviderArgs {
  id: string;
  displayName: string;
  baseUrl: string;
  apiKey: string;
  modelIds: string[];
  /** This app's ProviderFormat — "openai" | "anthropic" | "gemini". */
  format: string;
}

export interface LinkCredentialsArgs {
  eaonApiKey?: string | null;
  customProviders: LinkProviderArgs[];
}

export function eaonCliLinkCredentials(args: LinkCredentialsArgs): Promise<void> {
  return invoke("eaon_cli_link_credentials", { args });
}
