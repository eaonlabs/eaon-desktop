/**
 * The part of Codex's app-server protocol Eaon speaks (`codex app-server`,
 * JSON-RPC 2.0 without the `jsonrpc` header, one JSON object per line on
 * stdio).
 *
 * Hand-copied from the bindings `codex app-server generate-ts` writes for
 * Codex 0.160 (the `v2/` API), keeping only the fields Eaon reads or sends.
 * Every field Eaon reads is treated as optional at runtime: older and newer
 * servers add and drop fields, and a missing one must degrade, not throw.
 */

export type RequestId = string | number

/** `{ id, method, params }` from either side; a response has `result` or `error` instead of `method`. */
export interface RpcMessage {
  id?: RequestId
  method?: string
  params?: unknown
  result?: unknown
  error?: { code?: number; message?: string; data?: unknown }
}

export interface InitializeResponse {
  userAgent?: string
  codexHome?: string
  platformOs?: string
}

/* ----------------------------------------------------------------- account */

export type PlanType = string

export type Account =
  | { type: 'apiKey' }
  | { type: 'chatgpt'; email?: string | null; planType?: PlanType }
  | { type: 'amazonBedrock'; usesCodexManagedCredentials?: boolean }
  | { type: string }

export interface GetAccountResponse {
  account: Account | null
  requiresOpenaiAuth: boolean
}

export type LoginAccountResponse =
  | { type: 'chatgpt'; loginId: string; authUrl: string }
  | { type: string; loginId?: string; authUrl?: string }

export interface AccountLoginCompletedNotification {
  loginId: string | null
  success: boolean
  error: string | null
}

/* ------------------------------------------------------------------- models */

export interface ReasoningEffortOption {
  reasoningEffort: string
  description?: string
}

export interface Model {
  id: string
  model?: string
  upgrade?: string | null
  displayName?: string
  description?: string
  hidden?: boolean
  supportedReasoningEfforts?: ReasoningEffortOption[]
  defaultReasoningEffort?: string | null
  inputModalities?: string[]
  isDefault?: boolean
}

export interface ModelListResponse {
  data: Model[]
  nextCursor: string | null
}

/* ----------------------------------------------------------- threads, turns */

export type AskForApproval = 'untrusted' | 'on-request' | 'never'
export type SandboxMode = 'read-only' | 'workspace-write' | 'danger-full-access'
export type SandboxPolicy =
  | { type: 'readOnly'; networkAccess?: boolean }
  | { type: 'workspaceWrite'; writableRoots?: string[]; networkAccess?: boolean }

export interface Thread {
  id: string
  modelProvider?: string
  model?: string | null
}

export interface ThreadStartResponse {
  thread: Thread
  model?: string
  modelProvider?: string
}

export type UserInput =
  | { type: 'text'; text: string; text_elements: never[] }
  | { type: 'localImage'; path: string }

export type TurnStatus = 'completed' | 'interrupted' | 'failed' | 'inProgress'

/** `CodexErrorInfo`: a plain string, or a one-key object carrying an HTTP status. */
export type CodexErrorInfo = string | Record<string, { httpStatusCode?: number | null } | undefined>

export interface TurnError {
  message: string
  codexErrorInfo?: CodexErrorInfo | null
  additionalDetails?: string | null
}

export interface Turn {
  id: string
  status: TurnStatus
  error?: TurnError | null
}

export interface TokenUsageBreakdown {
  totalTokens: number
  inputTokens: number
  cachedInputTokens: number
  cacheWriteInputTokens?: number
  outputTokens: number
  reasoningOutputTokens?: number
}

export interface ThreadTokenUsage {
  /** Everything the thread has used so far, restored on resume. */
  total: TokenUsageBreakdown
  /** The latest model request only. */
  last: TokenUsageBreakdown
}

export interface TurnPlanStep {
  step: string
  status: 'pending' | 'inProgress' | 'completed'
}

export interface FileUpdateChange {
  path: string
  kind?: { type: string; move_path?: string | null }
  diff?: string
}

export interface CommandAction {
  type?: string
  command?: string
}

/** `ThreadItem`, the kinds Eaon draws; everything else is ignored. */
export type ThreadItem =
  | { type: 'agentMessage'; id: string; text?: string; phase?: 'commentary' | 'final_answer' | null }
  | { type: 'reasoning'; id: string; summary?: string[]; content?: string[] }
  | {
      type: 'commandExecution'
      id: string
      command?: string
      cwd?: string
      status?: 'inProgress' | 'completed' | 'failed' | 'declined'
      commandActions?: CommandAction[]
      aggregatedOutput?: string | null
      exitCode?: number | null
    }
  | { type: 'fileChange'; id: string; changes?: FileUpdateChange[]; status?: 'inProgress' | 'completed' | 'failed' | 'declined' }
  | {
      type: 'mcpToolCall'
      id: string
      server?: string
      tool?: string
      status?: 'inProgress' | 'completed' | 'failed'
      arguments?: unknown
      readOnlyHint?: boolean | null
      result?: { content?: unknown[] } | null
      error?: { message?: string } | null
    }
  | { type: 'webSearch'; id: string; query?: string; action?: unknown }
  | { type: 'imageView'; id: string; path?: string }
  | { type: string; id: string }

/* ------------------------------------------------- server → client requests */

export interface CommandExecutionRequestApprovalParams {
  threadId: string
  turnId: string
  itemId: string
  kind?: 'command' | 'writeStdin'
  reason?: string | null
  command?: string | null
  cwd?: string | null
  commandActions?: CommandAction[] | null
  networkApprovalContext?: { host?: string; protocol?: string } | null
}

export interface FileChangeRequestApprovalParams {
  threadId: string
  turnId: string
  itemId: string
  reason?: string | null
  grantRoot?: string | null
}

export interface PermissionsRequestApprovalParams {
  threadId: string
  turnId: string
  itemId: string
  reason?: string | null
  permissions?: {
    network?: { enabled?: boolean | null } | null
    fileSystem?: { read?: string[] | null; write?: string[] | null } | null
  }
}

export interface ToolRequestUserInputParams {
  threadId: string
  turnId: string
  itemId: string
  questions: { id: string; header?: string; question?: string; options?: { label: string }[] | null }[]
}

export interface McpServerElicitationRequestParams {
  threadId: string
  turnId: string | null
  serverName: string
  mode?: string
  message?: string
  _meta?: Record<string, unknown> | null
}

/**
 * The question id prefix and answers Codex uses when it asks to approve an MCP
 * tool call through `item/tool/requestUserInput` (codex-rs mcp_tool_call.rs).
 */
export const MCP_APPROVAL_QUESTION_PREFIX = 'mcp_tool_call_approval'
export const MCP_APPROVAL_ALLOW = 'Allow'
export const MCP_APPROVAL_CANCEL = 'Cancel'
