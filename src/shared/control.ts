/**
 * Eaon's control API: what Eaon CLI (and any other app holding the install's
 * key) can ask the desktop app to do — find and download models, load them,
 * open ADE folders and terminals, switch tabs, read workers and chats. Served
 * at `/control/mcp` (MCP, which Eaon CLI connects to by itself) and
 * `/control/v1/*` (plain JSON) by the Local API Server.
 */

import type { TerminalAgentId } from './terminals'

/** Where the app can be sent: the three top-bar tabs, and the pages behind the sidebar. */
export const CONTROL_TARGETS = [
  'chat',
  'workers',
  'ade',
  'models',
  'library',
  'plugins',
  'integrations',
  'scheduled',
  'trading',
  'pull-requests',
  'settings'
] as const
export type ControlTarget = (typeof CONTROL_TARGETS)[number]

/** An action only the window can carry out — main sends it, the renderer does it. */
export type ControlAction =
  | { type: 'navigate'; to: ControlTarget; settingsPage?: string }
  | { type: 'open-folder'; path: string }
  | { type: 'new-terminal'; agent: TerminalAgentId; folder?: string }
  | { type: 'settings'; patch: Record<string, unknown> }

/**
 * `read` only looks. `write` changes something the user can undo or ignore
 * (a download, a tab). `danger` removes something (a model's files, a
 * worker): Eaon CLI asks before it runs.
 */
export type ControlRisk = 'read' | 'write' | 'danger'

export interface ControlToolInfo {
  name: string
  description: string
  risk: ControlRisk
  /** JSON Schema of the arguments. */
  input: Record<string, unknown>
}
