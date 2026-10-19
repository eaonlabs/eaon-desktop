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

/** Someone this computer, or one of its terminals, is shared with (shared on rc.eaon.dev). */
export interface RcShare {
  id: string
  /** Their GitHub login. */
  login: string
  /** One terminal, by what it was called when shared; null for the whole computer. */
  paneLabel: string | null
  pane: string | null
  access: 'watch' | 'control'
  /** The invite hasn't been accepted yet. */
  pending: boolean
  expired: boolean
  createdAt: number
  /** Connected to it right now. */
  online: boolean
}

/**
 * A terminal shared with a friend, locked to one folder by the operating
 * system's sandbox (main/features/terminals/guestSandbox.ts). It travels as an
 * ordinary one-terminal share on rc.eaon.dev; the folder, the mode and the
 * lock live only on this computer.
 */
export type LockedMode = 'shell' | 'cli'

export interface LockedTerminal {
  id: string
  /** The share on rc.eaon.dev that carries it; null if it couldn't be made. */
  shareId: string | null
  folder: string
  /** What the friend sees it called: the folder's name unless you gave one. */
  label: string
  mode: LockedMode
  /** In `cli` mode, the CLI they're locked to. */
  agent: string | null
  /** Shell mode: whether it may reach the internet. CLI mode always may. */
  network: boolean
  /** Their GitHub login. */
  login: string
  createdAt: number
  /** When it stops working on its own; null to last until revoked. */
  expiresAt: number | null
  /** Their terminal is running now. */
  running?: boolean
  /** They're connected right now. */
  online?: boolean
  /** The invite hasn't been accepted yet. */
  pending?: boolean
}

export interface LockedTerminalDraft {
  folder: string
  label?: string
  mode: LockedMode
  agent?: string | null
  network?: boolean
  login: string
  /** Hours until it stops working; 0 or absent for until revoked. */
  hours?: number
}

/** Whether this computer can share locked terminals, and why not. */
export type LockedSupport = { ok: true } | { ok: false; reason: string }
