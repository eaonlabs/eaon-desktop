/**
 * Types shared by the Code tab's main-process bridge, its preload API and the
 * renderer. They describe the subset of Eaon Code's RPC protocol the tab uses
 * (see `packages/coding-agent/docs/rpc.md` in the Eaon Code repo) — loosely,
 * because the installed Eaon Code may be older or newer than this app, and a
 * field we do not know about must pass through rather than break parsing.
 */

export type EaonThinkingLevel = 'off' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max'

export interface EaonModel {
  id: string
  name?: string
  provider: string
  api?: string
  reasoning?: boolean
  input?: string[]
  contextWindow?: number
  maxTokens?: number
  cost?: { input: number; output: number; cacheRead?: number; cacheWrite?: number }
}

export interface EaonSessionState {
  model: EaonModel | null
  thinkingLevel: EaonThinkingLevel
  isStreaming: boolean
  isCompacting: boolean
  steeringMode?: 'all' | 'one-at-a-time'
  followUpMode?: 'all' | 'one-at-a-time'
  sessionFile?: string
  sessionId: string
  sessionName?: string
  autoCompactionEnabled?: boolean
  messageCount: number
  pendingMessageCount: number
  /** Only reported by builds that have `set_plan_mode`; absent means unsupported. */
  planMode?: boolean
  /** Only reported by builds that have `set_swarm_mode`; absent means unsupported. */
  swarmMode?: boolean
}

export interface EaonSessionStats {
  sessionFile?: string
  sessionId: string
  userMessages: number
  assistantMessages: number
  toolCalls: number
  toolResults: number
  totalMessages: number
  tokens: { input: number; output: number; cacheRead: number; cacheWrite: number; total: number }
  cost: number
  /** Absent without a model; tokens/percent are null right after a compaction. */
  contextUsage?: { tokens: number | null; contextWindow: number; percent: number | null }
}

export interface EaonSlashCommand {
  name: string
  description?: string
  source: 'extension' | 'prompt' | 'skill' | 'builtin'
}

/** Where Eaon Code is and whether it can run. */
export interface EaonCodeStatus {
  /** `ready`: found and answered `--version`. `missing`: nothing found. `broken`: found but would not run. */
  state: 'ready' | 'missing' | 'broken'
  /** What was found: the installer's built `cli.js`, or an `eaon-code` binary. */
  binaryPath: string | null
  /**
   * How to start it. The installer's copy runs as `node <cli.js>`, never
   * through the `eaon-code` wrapper it also writes: that wrapper fetches from
   * GitHub and may rebuild on every start, which would stall the ADE.
   */
  launch: { command: string; args: string[] } | null
  /** How it was found. */
  source: 'setting' | 'installer' | 'path' | 'npm-prefix' | null
  /** What `--version` printed. Not shown: the installer builds from main, so it doesn't say how current a copy is. */
  version: string | null
  /** The installer's checkout, for a copy it made. */
  installDir?: string
  /** When the installer last finished, for a copy it made. */
  updatedAt?: number
  /** The `node` on PATH, which is what `#!/usr/bin/env node` will run. */
  node: { path: string | null; version: string | null; ok: boolean }
  /** Eaon Code's `engines.node`, e.g. ">=22.19.0". */
  nodeRequirement: string
  /** Why state is `broken`, or why a configured path was ignored. */
  error?: string
}

/** A saved session file, summarised for the sidebar. */
export interface EaonSessionInfo {
  path: string
  id: string
  cwd: string
  name?: string
  created: number
  modified: number
  messageCount: number
  firstMessage: string
}

/** The child process, as the renderer sees it. */
export interface EaonProcessInfo {
  state: 'idle' | 'starting' | 'running' | 'exited'
  cwd: string | null
  pid?: number
  exitCode?: number | null
  signal?: string | null
  /** Tail of stderr, for crash reports. */
  stderr: string
  /** Set when the process ended without being asked to. */
  crashed?: boolean
}

/**
 * One RPC event, as forwarded by the bridge. The bridge strips payloads the
 * UI never reads (full message lists on `agent_end`, the system prompt) and
 * coalesces streamed deltas, but otherwise passes events through as-is.
 */
export interface EaonEvent {
  type: string
  [key: string]: unknown
}

export type EaonUiRequest =
  | { id: string; method: 'select'; title: string; options: string[]; timeout?: number }
  | { id: string; method: 'confirm'; title: string; message: string; timeout?: number }
  | { id: string; method: 'input'; title: string; placeholder?: string; timeout?: number }
  | { id: string; method: 'editor'; title: string; prefill?: string }

export type EaonUiResponse = { value: string } | { confirmed: boolean } | { cancelled: true }

export interface EaonStartOptions {
  /** Resume this session file instead of starting a new session. */
  sessionPath?: string
  /** Modes to turn on right after start, when the build supports them. */
  planMode?: boolean
  swarmMode?: boolean
}

/** Everything the view needs once a session is up, fetched in one round trip. */
export interface EaonSnapshot {
  state: EaonSessionState
  models: EaonModel[]
  thinkingLevels: EaonThinkingLevel[]
  commands: EaonSlashCommand[]
  stats: EaonSessionStats | null
  /** The session's messages, for a resumed session; empty for a new one. */
  messages: unknown[]
}

/** Commands the renderer may send. The bridge refuses any other `type`. */
export type EaonCommand =
  | { type: 'prompt'; message: string; streamingBehavior?: 'steer' | 'followUp' }
  | { type: 'steer'; message: string }
  | { type: 'follow_up'; message: string }
  | { type: 'abort' }
  | { type: 'clear_queue' }
  | { type: 'new_session' }
  | { type: 'switch_session'; sessionPath: string }
  | { type: 'get_state' }
  | { type: 'get_messages' }
  | { type: 'get_available_models' }
  | { type: 'set_model'; provider: string; modelId: string }
  | { type: 'set_thinking_level'; level: EaonThinkingLevel }
  | { type: 'get_available_thinking_levels' }
  | { type: 'compact'; customInstructions?: string }
  | { type: 'get_session_stats' }
  | { type: 'get_commands' }
  | { type: 'bash'; command: string; excludeFromContext?: boolean; id?: string }
  | { type: 'abort_bash' }
  | { type: 'set_session_name'; name: string }
  | { type: 'set_plan_mode'; enabled: boolean }
  | { type: 'set_swarm_mode'; enabled: boolean }

export type EaonResult<T = unknown> = { ok: true; data: T } | { ok: false; error: string }

export const EAON_CODE_REPO = 'https://github.com/eaonlabs/eaon-code'
/**
 * Eaon Code's installer. It clones (or fast-forwards) the repo into
 * ~/.local/share/eaon-code and builds it there, so running it again is how an
 * install is updated. Eaon Code isn't kept current on npm.
 */
export const EAON_CODE_INSTALLER = 'https://raw.githubusercontent.com/eaonlabs/eaon-code/main/install.sh'
