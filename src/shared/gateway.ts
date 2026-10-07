/**
 * Eaon's local gateway: the Local API Server, speaking the OpenAI (chat
 * completions and Responses) and Anthropic (Messages) formats, so apps like
 * Claude Code and Codex can use the models the user has set up in Eaon.
 */

import type { EffortLevel } from './types'

/** One model the gateway serves. `id` is `provider/model`, what apps are configured with. */
export interface GatewayModel {
  id: string
  label: string
  /** The Eaon provider id. */
  provider: string
  providerName: string
  /** What Eaon knows about the model, for apps that want it described (Codex's model catalog). */
  contextWindow?: number
  vision?: boolean
  efforts?: EffortLevel[]
}

/**
 * Which models a request may use. `all` is every model set up in Eaon;
 * `local` — the `/local/v1` routes, which Eaon CLI uses — only the open-source
 * models downloaded in Eaon, and a name it doesn't know is an error rather
 * than a cloud model standing in for it.
 */
export type GatewayScope = 'all' | 'local'

/** A downloaded model as `/local/v1/models` lists it: OpenAI's shape, plus what a coding agent needs to know. */
export interface LocalGatewayModel {
  id: string
  object: 'model'
  created: number
  owned_by: string
  name: string
  context_window: number
  capabilities: { tools: boolean; vision: boolean; reasoning: boolean }
}

export interface GatewayInfo {
  running: boolean
  port: number
  /** For OpenAI-style apps: `http://127.0.0.1:<port>/v1`. */
  openaiBaseUrl: string
  /** For Anthropic-style apps, which add `/v1/messages` themselves: `http://127.0.0.1:<port>`. */
  anthropicBaseUrl: string
  /** This install's key; apps send it as `Authorization: Bearer` or `x-api-key`. */
  token: string
  models: GatewayModel[]
  /** What a request for a model Eaon doesn't have gets (`provider/model`), if set. */
  defaultModel: string | null
  /** The same for a small/fast model name (haiku, mini). */
  smallModel: string | null
}

export interface GatewayDefaults {
  defaultModel?: string | null
  smallModel?: string | null
}
