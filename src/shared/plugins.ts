import type { McpServerStatus } from './types'

/** What a browser sign-in came back with. */
export interface PluginSignInResult {
  ok: boolean
  error?: string
  /**
   * The server offers no Dynamic Client Registration, so the user has to
   * create an OAuth app with the vendor and enter its client id (and secret).
   */
  needsClientId?: boolean
  statuses: McpServerStatus[]
}

/** A browser sign-in target: a catalog plugin, or a hand-added HTTP server. */
export type SignInTarget = { pluginId: string } | { serverId: string }

export interface ManualClient {
  clientId: string
  clientSecret?: string
}
