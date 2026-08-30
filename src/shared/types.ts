/** Types shared between the main and renderer processes. */

export type ProviderKind = 'openai' | 'anthropic' | 'openai-compatible' | 'ollama'

export interface ModelInfo {
  id: string
  /** Short display name shown in the model picker, e.g. "5.6 Sol". */
  label: string
  providerId: string
  /** Reasoning-effort levels this model accepts, if any. */
  efforts?: EffortLevel[]
  contextWindow?: number
  /** Capability badges shown next to the model name in the provider detail panel. */
  tools?: boolean
  vision?: boolean
}

export type EffortLevel = 'light' | 'medium' | 'high' | 'extra-high' | 'ultra'

export interface Provider {
  id: string
  name: string
  kind: ProviderKind
  baseUrl: string
  /** True once an API key has been stored for this provider. */
  hasKey: boolean
  enabled: boolean
  models: ModelInfo[]
  /** Providers we ship out of the box cannot be deleted, only disabled. */
  builtIn: boolean
  /** Local runtimes (llama.cpp, MLX, Ollama) are grouped separately and never require a key. */
  local: boolean
  /** How many fallback keys are configured, tried in order if the primary key fails. */
  fallbackCount: number
}

export interface ChatTextPart {
  type: 'text' | 'reasoning'
  text: string
}

/**
 * One tool call and its result, kept in the transcript rather than only in the
 * agent loop's local scratch array.
 *
 * Without this the next turn cannot see that the previous one edited a file or
 * that a test failed — history was rebuilt from text parts alone, so every tool
 * call the agent made vanished the moment the turn ended. Stored in a
 * provider-neutral shape rather than as raw Anthropic/OpenAI blocks so a chat
 * survives switching models mid-conversation, and so the transcript UI has the
 * arguments and output it needs to render the call.
 */
export interface ChatToolPart {
  type: 'tool'
  /** Provider-assigned call id, needed to pair results back up on replay. */
  id: string
  name: string
  input: Record<string, unknown>
  /** Null while the tool is still running. */
  output: string | null
  status: 'running' | 'done' | 'denied' | 'error'
}

export type ChatMessagePart = ChatTextPart | ChatToolPart

export interface ChatMessage {
  id: string
  role: 'user' | 'assistant' | 'system'
  parts: ChatMessagePart[]
  createdAt: number
  /** Set when a request failed so the UI can show an inline error. */
  error?: string
  model?: string
}

export interface Chat {
  id: string
  workspaceId: string
  projectId: string | null
  title: string
  messages: ChatMessage[]
  createdAt: number
  updatedAt: number
  archived: boolean
  pinned: boolean
  unread: boolean
  modelId: string | null
  effort: EffortLevel
}

export interface Project {
  id: string
  workspaceId: string
  name: string
  instructions: string
  createdAt: number
}

export interface Workspace {
  id: string
  name: string
  /** 'work' is the agentic coding product (Eaon Work); 'chat' is the regular assistant. */
  kind: 'chat' | 'work'
  /** Project folder Eaon Work runs commands and file edits against. Null until chosen. */
  cwd?: string | null
}

export type ThemeMode = 'system' | 'light' | 'dark'
export type ApprovalMode = 'ask' | 'auto'

export interface ThemePalette {
  preset: string
  accent: string
  background: string
  foreground: string
  fontFamily: string
  fontWeight: string
  translucentSidebar: boolean
  contrast: number
}

export interface Settings {
  general: {
    defaultPermissions: boolean
    fullAccess: boolean
    fileOpenDestination: string
    language: string
    showInMenuBar: boolean
    bottomPanel: boolean
    preventSleep: boolean
    suggestedPrompts: boolean
    launchAtLogin: boolean
  }
  appearance: {
    mode: ThemeMode
    light: ThemePalette
    dark: ThemePalette
    pointerCursors: boolean
    dockIcon: 'mono' | 'color'
    reduceMotion: 'system' | 'on' | 'off'
    fontSize: number
    fontSmoothing: boolean
  }
  configuration: {
    configScope: string
    approvalPolicy: string
    sandbox: string
    webSearch: string
    outputDetail: string
    reasoningSummary: string
    availableEfforts: EffortLevel[]
    ultraInPicker: boolean
    workspaceDependencies: boolean
  }
  browser: {
    homepage: string
    importedFromChrome: boolean
    dismissedImportBanner: boolean
  }
  mcp: {
    allowAllToolPermissions: boolean
    toolCallTimeoutSeconds: number
    smartRouting: boolean
    useDedicatedRoutingModel: boolean
    routingModelId: string | null
  }
  localServer: {
    autoStart: boolean
    port: number
    defaultModelId: string | null
  }
  claudeCode: {
    largeModelId: string | null
    mediumModelId: string | null
    smallModelId: string | null
    env: { id: string; key: string; value: string }[]
    enabled: boolean
  }
  codeIndex: {
    /** Provider used for embeddings; null means keyword-only search. */
    embeddingProviderId: string | null
    embeddingModelId: string | null
    /** Re-index the project folder automatically when Eaon Work opens it. */
    autoIndex: boolean
    /** Ceiling on agent tool round-trips per turn — agentic coding needs many. */
    maxToolRounds: number
  }
  shortcuts: Record<string, string | null>
  /** Ids of plugins the user has installed from the directory. */
  installedPlugins: string[]
  disabledPlugins: string[]
  disabledSkills: string[]
  activeWorkspaceId: string
  selectedModelId: string | null
  effort: EffortLevel
  approvalMode: ApprovalMode
  planMode: boolean
}

export interface McpServer {
  id: string
  name: string
  /** STDIO spawns a local process; HTTP connects to a streamable HTTP endpoint. */
  transport: 'stdio' | 'http'
  command: string
  args: string[]
  env: Record<string, string>
  /** Used when transport is 'http'. */
  url: string
  enabled: boolean
  /** Bundled servers we ship, shown with an "Official" badge. */
  official: boolean
  /**
   * Set when this server came from the built-in plugin catalog rather than
   * being added by hand. Holds the catalog entry's id, which is also the key
   * its token is stored under in the encrypted vault — the token itself is
   * never kept here, since this file is written to disk in the clear.
   */
  pluginId?: string
}

export interface McpTool {
  name: string
  description: string
  serverId: string
  inputSchema: Record<string, unknown>
}

export interface McpServerStatus {
  serverId: string
  state: 'stopped' | 'starting' | 'ready' | 'error'
  toolCount: number
  error?: string
}

export interface Skill {
  id: string
  name: string
  description: string
  source: 'personal' | 'system'
  enabled: boolean
}

export interface StreamRequest {
  chatId: string
  messageId: string
  providerId: string
  modelId: string
  effort: EffortLevel
  system: string
  messages: {
    role: 'user' | 'assistant' | 'system'
    content: string
    /**
     * Tool calls this assistant turn made, in order. Replayed into whichever
     * provider's wire format is in use so the agent can see what it already did
     * on earlier turns.
     */
    tools?: ChatToolPart[]
  }[]
  /** Project folder for Eaon Work — enables the read_file/write_file/run_command tools when set. */
  cwd: string | null
}

export type StreamEvent =
  | { type: 'delta'; messageId: string; text: string }
  | { type: 'reasoning'; messageId: string; text: string }
  | { type: 'done'; messageId: string }
  | { type: 'error'; messageId: string; error: string }
  | { type: 'approval-request'; messageId: string; requestId: string; tool: string; input: Record<string, unknown> }
  // A tool started and finished, as two events, so the transcript can show the
  // call the moment it is made rather than only once its output lands — a
  // `run_command` can take two minutes.
  | { type: 'tool-call'; messageId: string; toolId: string; name: string; input: Record<string, unknown> }
  | {
      type: 'tool-result'
      messageId: string
      toolId: string
      output: string
      status: 'done' | 'denied' | 'error'
    }

export type UpdateStatus =
  | { state: 'idle' }
  | { state: 'checking' }
  | { state: 'available'; version: string }
  | { state: 'not-available' }
  | { state: 'downloading'; percent: number }
  | { state: 'downloaded'; version: string }
  | { state: 'error'; message: string }

export interface LocalServerStatus {
  running: boolean
  port: number
  /** Populated only while running, e.g. http://127.0.0.1:1337 */
  url: string | null
  error?: string
}

/** One chunk returned by the code index, with the code it came from. */
export interface SearchHit {
  path: string
  startLine: number
  endLine: number
  symbols: string[]
  text: string
}

export interface IndexStatus {
  state: 'idle' | 'indexing' | 'ready' | 'error'
  files: number
  chunks: number
  /** True when vectors exist; false means search falls back to keywords. */
  embedded: boolean
  /** Human-readable step shown while indexing, e.g. "Embedding 300/1200". */
  phase?: string
  updatedAt?: number
  /** Set when the project exceeded the chunk ceiling and was only partly indexed. */
  truncated?: boolean
  error?: string
}

export interface PullRequestSummary {
  id: string
  title: string
  repo: string
  branch: string
  url: string
  updatedAt: string
  additions: number
  deletions: number
  state: 'open' | 'closed' | 'merged' | 'draft'
}

export interface PullRequestsResult {
  authored: PullRequestSummary[]
  reviewing: PullRequestSummary[]
  /** Set when the `gh` CLI is missing or unauthenticated; lists are empty in that case. */
  error: string | null
}

export interface SystemInfo {
  os: { name: string; version: string }
  cpu: { model: string; architecture: string; cores: number; usagePercent: number }
  memory: { totalBytes: number; availableBytes: number; usagePercent: number }
}

/** A single downloadable GGUF file within a Hugging Face model repo. */
export interface ModelVariant {
  filename: string
  /** Quantization label parsed from the filename, e.g. "Q4_K_M". */
  quant: string
  sizeBytes: number
  /** Whether this file comfortably fits in the machine's total memory. */
  fits: boolean
}

export interface ModelSearchResult {
  /** Hugging Face repo id, e.g. "janhq/Jan-v3.5-4B-Gguf". */
  repoId: string
  name: string
  author: string
  downloads: number
  description: string
  tags: string[]
  capabilities: ('tools' | 'multimodal')[]
  fileCount: number
  /** The variant shown on the card itself — Q4_K_M when available, else the first file. */
  defaultVariant: ModelVariant | null
}

export interface ModelDetail {
  repoId: string
  name: string
  author: string
  downloads: number
  description: string
  parameterSize: string | null
  variants: ModelVariant[]
}

export interface DownloadedModel {
  repoId: string
  filename: string
  quant: string
  sizeBytes: number
  path: string
  downloadedAt: number
  /** Name it was registered under with the local Ollama daemon, if that succeeded. */
  ollamaName: string | null
  /** Set when the download succeeded but Ollama registration failed. */
  ollamaError: string | null
}

export interface ModelDownloadProgress {
  repoId: string
  filename: string
  receivedBytes: number
  totalBytes: number
  phase: 'downloading' | 'registering'
}
