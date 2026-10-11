/**
 * Eaon Remote (rc.eaon.dev): this computer linked to a GitHub account so its
 * ADE sessions and Workers can be used from a browser anywhere. The desktop
 * keeps one WebSocket open to the relay (cloud/rc); see features/rc.
 */

export const RC_DEFAULT_SERVER = 'https://rc.eaon.dev'

export type RcConnection = 'off' | 'connecting' | 'connected' | 'offline'

export interface RcInfo {
  server: string
  linked: boolean
  enabled: boolean
  login: string | null
  avatar: string | null
  connection: RcConnection
  /** Why it isn't connected, in words, when it should be. */
  problem: string | null
  /** A link in progress: the code to check on the website, and where to go. */
  linking: { code: string; url: string; expiresAt: number } | null
}
