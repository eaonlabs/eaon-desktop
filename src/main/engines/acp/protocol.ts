/**
 * The parts of the Agent Client Protocol (v1, agentclientprotocol.com) Eaon
 * uses, as the agent sends them. Fields Eaon doesn't read are left out; an
 * agent may send more, and newer kinds of update are ignored.
 */

export const ACP_PROTOCOL_VERSION = 1

/** `session/new` and `session/prompt` fail with this when the agent isn't signed in. */
export const AUTH_REQUIRED = -32000

export interface AcpAuthMethod {
  id: string
  name: string
  description?: string | null
  /** `terminal`: the client runs a command for the user; absent or `agent`: the agent signs in through `authenticate`. */
  type?: string
  _meta?: Record<string, unknown> | null
}

export interface AcpInitializeResponse {
  protocolVersion: number
  agentCapabilities?: {
    loadSession?: boolean
    promptCapabilities?: { image?: boolean }
    sessionCapabilities?: { close?: unknown }
  }
  authMethods?: AcpAuthMethod[]
  agentInfo?: { name?: string; title?: string | null; version?: string } | null
}

export interface AcpSelectOption {
  value: string
  name: string
  description?: string | null
}

export interface AcpConfigOption {
  id: string
  name: string
  type?: string
  category?: string | null
  currentValue?: string
  options?: AcpSelectOption[] | { group?: string; options: AcpSelectOption[] }[]
}

/** ACP's draft model list, which some agents send before config options. */
export interface AcpModelState {
  currentModelId: string
  availableModels: { modelId: string; name: string; description?: string | null }[]
}

export interface AcpNewSessionResponse {
  sessionId: string
  configOptions?: AcpConfigOption[] | null
  models?: AcpModelState | null
}

export type AcpContentBlock = { type: 'text'; text: string } | { type: 'image'; mimeType: string; data: string } | { type: string; [key: string]: unknown }

export type AcpToolContent =
  | { type: 'content'; content: AcpContentBlock }
  | { type: 'diff'; path: string; oldText?: string | null; newText: string }
  | { type: string; [key: string]: unknown }

export interface AcpToolCall {
  toolCallId: string
  title?: string | null
  kind?: string | null
  status?: 'pending' | 'in_progress' | 'completed' | 'failed' | null
  content?: AcpToolContent[] | null
  locations?: { path: string; line?: number | null }[] | null
  rawInput?: unknown
  rawOutput?: unknown
}

export type AcpSessionUpdate =
  | { sessionUpdate: 'agent_message_chunk'; content: AcpContentBlock }
  | { sessionUpdate: 'agent_thought_chunk'; content: AcpContentBlock }
  | ({ sessionUpdate: 'tool_call' } & AcpToolCall)
  | ({ sessionUpdate: 'tool_call_update' } & AcpToolCall)
  | { sessionUpdate: 'plan'; entries: { content: string; status: 'pending' | 'in_progress' | 'completed' }[] }
  | { sessionUpdate: 'available_commands_update'; availableCommands: { name: string; description?: string | null }[] }
  | { sessionUpdate: string; [key: string]: unknown }

export interface AcpPermissionRequest {
  sessionId: string
  toolCall: AcpToolCall
  options: { optionId: string; name: string; kind: 'allow_once' | 'allow_always' | 'reject_once' | 'reject_always' | string }[]
}

export type AcpStopReason = 'end_turn' | 'max_tokens' | 'max_turn_requests' | 'refusal' | 'cancelled'
