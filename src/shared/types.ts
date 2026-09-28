/** Types shared between the main and renderer processes. */

/**
 * Wire format a provider speaks. `openai-responses` is OpenAI's Responses API
 * (also what ChatGPT/Codex subscriptions are served over); everything else that
 * is not Anthropic speaks chat-completions.
 */
export type ProviderKind = 'openai' | 'anthropic' | 'openai-compatible' | 'ollama' | 'openai-responses'

/** How a provider authenticates: a pasted key, a browser sign-in, or nothing (local runtimes). */
export type ProviderAuth = 'key' | 'oauth' | 'none'

export interface ModelInfo {
  id: string
  /** Short display name shown in the model picker, e.g. "5.6 Sol". */
  label: string
  providerId: string
  /** Reasoning-effort levels this model accepts, if any. */
  efforts?: EffortLevel[]
  contextWindow?: number
  /** Largest `max_tokens` the model accepts; used to size requests. */
  maxOutput?: number
  /** Capability badges shown next to the model name in the provider detail panel. */
  tools?: boolean
  vision?: boolean
  /** True for models that think before answering (reasoning / extended thinking). */
  reasoning?: boolean
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
  /** Defaults to 'key' for remote providers and 'none' for local runtimes. */
  auth?: ProviderAuth
  /** Id of the OAuth flow in `main/providers/oauth`, when `auth` is 'oauth'. */
  oauthFlow?: string
  /** True once an OAuth sign-in has completed and its tokens are stored. */
  signedIn?: boolean
  /** Grouping in the providers list. */
  category?: 'local' | 'subscription' | 'frontier' | 'gateway' | 'inference' | 'regional' | 'custom'
  /** One line shown under the provider name. */
  description?: string
  /** Where to create an API key for this provider. */
  keyUrl?: string
  /** Extra headers every request to this provider carries (OpenRouter attribution, etc.). */
  headers?: Record<string, string>
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
  /**
   * Images the tool returned (screenshots), as absolute paths under the app's
   * attachments folder. Kept on disk rather than inline so chats.json stays
   * small; only the newest one is ever replayed to the model.
   */
  images?: string[]
  /** Live output while a long command is still running, replaced by `output` when it ends. */
  progress?: string
  /** Sub-agents a swarm call started, in the order they were launched. */
  agents?: SubagentRun[]
}

/** One sub-agent inside a swarm tool call. */
export interface SubagentRun {
  index: number
  role: string
  task: string
  status: 'queued' | 'running' | 'done' | 'error'
  /** Final text the sub-agent reported back. */
  output?: string
  toolCalls: number
  /** The step the sub-agent is on right now, e.g. "Read src/main/store.ts". */
  activity?: string
}

/** Token accounting for one assistant turn, summed across its tool rounds. */
export interface TokenUsage {
  input: number
  output: number
  /** Input tokens served from the provider's prompt cache. */
  cacheRead: number
  /** Input tokens written to the prompt cache this turn. */
  cacheWrite: number
}

/** A plan the agent proposed in plan mode, waiting for the user's go-ahead. */
export interface PlanProposal {
  title: string
  summary: string
  steps: string[]
  status: 'pending' | 'approved' | 'revising'
}

/** The agent's own running checklist (`update_plan`), shown pinned above the composer. */
export interface TodoItem {
  text: string
  status: 'pending' | 'in_progress' | 'done'
}

/** A long-running objective the agent keeps pursuing across rounds (goal mode). */
export interface GoalState {
  text: string
  status: 'active' | 'achieved' | 'blocked' | 'paused'
  /** How many times the agent has been sent back to keep working on it. */
  iterations: number
  /** Set when the agent reports the goal achieved or blocked. */
  summary?: string
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
  /** Tokens this turn spent, including cache reads and writes. */
  usage?: TokenUsage
  /** Plan proposed in this turn (plan mode). */
  plan?: PlanProposal
  /** Latest checklist the agent published during this turn. */
  todos?: TodoItem[]
  /** Files the user attached to this message, as absolute paths. */
  attachments?: string[]
  /** Set on messages a scheduled task produced, so the UI can label them. */
  scheduledTaskId?: string
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
  /** Goal mode: the objective this chat keeps working toward. */
  goal?: GoalState | null
  /**
   * Compaction: a summary standing in for every message up to and including
   * `throughMessageId`, so a long chat stops resending its whole history.
   */
  summary?: { text: string; throughMessageId: string } | null
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
  /**
   * 'chat' is the plain assistant (web search only), 'work' is the agent that
   * acts on the computer, and 'code' is the Eaon Code session UI.
   */
  kind: 'chat' | 'work' | 'code'
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
  /**
   * Which provider serves the selected model. The id alone is ambiguous once a
   * ChatGPT sign-in, Copilot and an OpenAI key all offer the same model.
   */
  selectedProviderId: string | null
  effort: EffortLevel
  approvalMode: ApprovalMode
  /** Plan mode (Work): read-only research, then a plan the user approves before anything changes. */
  planMode: boolean
  work: {
    /** Swarm mode: the agent may split work across parallel sub-agents. */
    swarm: boolean
    /** How many times goal mode may send the agent back to keep working before it stops and reports. */
    goalMaxIterations: number
    /** Goal mode pauses once one reply has run this long, in minutes. 0 = no limit. */
    goalMaxMinutes: number
    /** Goal mode pauses once one reply has used this many tokens (input + output). 0 = no limit. */
    goalMaxTokens: number
    /** Model sub-agents run on; null means the chat's own model. */
    subagentModelId: string | null
    /** Folder Work mode acts in when no project folder has been chosen; null means ~/Eaon. */
    defaultFolder: string | null
  }
  /** Token-saving behaviour shared by Chat and Work. */
  context: {
    /** Summarise older turns once a chat nears the model's context window. */
    autoCompact: boolean
    /** Fraction of the context window (0–1) at which compaction kicks in. */
    compactAt: number
    /** Tool output from turns older than this many user messages is trimmed before it is resent. */
    keepFullToolTurns: number
  }
  computerUse: {
    enabled: boolean
    /** Ask before every click and keystroke, even in "Approve for me". */
    confirmEachAction: boolean
    /** Sharper screenshots cost more tokens per step. */
    quality: 'balanced' | 'sharp'
  }
  browserExtension: {
    enabled: boolean
    /** Loopback port the Chrome extension connects to. */
    port: number
  }
  pets: {
    enabled: boolean
    species: string
    name: string
    size: 'small' | 'medium' | 'large'
    /** Also float the pet over the desktop in its own always-on-top window. */
    desktop: boolean
  }
  eaonCode: {
    /** Explicit path to the eaon-code binary; null means find it on PATH. */
    binaryPath: string | null
    /** Folder the Code tab last opened. */
    lastCwd: string | null
    /** Hand the API keys saved in Eaon to Eaon Code sessions as environment variables. */
    shareKeys: boolean
  }
  notifications: {
    /** System notification when a Work task or scheduled run finishes while the window is in the background. */
    taskComplete: boolean
  }
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
  /** MCP tool annotations: whether the tool only reads, or can destroy data. */
  readOnly?: boolean
  destructive?: boolean
}

export interface McpServerStatus {
  serverId: string
  /** `needs-auth`: the server wants a browser sign-in (none yet, or it expired and could not be refreshed). */
  state: 'stopped' | 'starting' | 'ready' | 'error' | 'needs-auth'
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

export type AgentMode = 'chat' | 'work'

/** Per-turn Work options, read from the composer when the turn starts. */
export interface WorkOptions {
  swarm: boolean
  plan: boolean
}

export interface StreamRequest {
  chatId: string
  messageId: string
  providerId: string
  modelId: string
  effort: EffortLevel
  /** Chat gets web search only; Work gets the full agent. */
  mode: AgentMode
  /**
   * The conversation before this turn, oldest first, in its stored shape.
   * The main process decides what of it to resend — old tool output is
   * trimmed and older screenshots dropped there, not here.
   */
  history: ChatMessage[]
  /** Compaction summary standing in for every message before `history`. */
  summary: string | null
  /** The project's own instructions, appended to the system prompt. */
  projectInstructions: string
  /** Project folder Work mode acts in. Null uses the default Work folder. */
  cwd: string | null
  work: WorkOptions
  /** Goal mode objective for this chat, if one is active. */
  goal: GoalState | null
  /**
   * Replaces the built system prompt and turns every tool off — used by the
   * Local API Server, which proxies other apps' requests verbatim.
   */
  rawSystem?: string
}

export type StreamEvent =
  | { type: 'delta'; messageId: string; text: string }
  | { type: 'reasoning'; messageId: string; text: string }
  | { type: 'done'; messageId: string }
  | { type: 'error'; messageId: string; error: string }
  | {
      type: 'approval-request'
      messageId: string
      requestId: string
      tool: string
      input: Record<string, unknown>
      /** The tool's own one-line description of this call, e.g. `click [2] button "Place order"`. */
      summary?: string
    }
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
      images?: string[]
    }
  // Live output from a tool that is still running (a build, a test run).
  | { type: 'tool-progress'; messageId: string; toolId: string; output: string }
  | { type: 'subagent'; messageId: string; toolId: string; run: SubagentRun }
  | { type: 'usage'; messageId: string; usage: TokenUsage }
  | { type: 'plan'; messageId: string; plan: PlanProposal }
  | { type: 'todos'; messageId: string; todos: TodoItem[] }
  | { type: 'goal'; messageId: string; chatId: string; goal: GoalState }
  | { type: 'compacted'; messageId: string; chatId: string; summary: string; throughMessageId: string }

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
