/**
 * ADE sessions on another machine, over SSH. Ported from the standalone Eaon
 * ADE (`shared/ssh.ts`).
 *
 * A host is a connection descriptor (where to connect, which key file to
 * offer), never a credential: there is no passphrase field, on purpose. A
 * remote pane runs the real `ssh` binary in a real pty, exactly as Terminal
 * would, so `~/.ssh/config`, ssh-agent and the Keychain authenticate it, and a
 * key that needs unlocking prompts in the pane itself.
 *
 * A remote session's folder is written `ssh://<host id>/<absolute path>`.
 * Everything keyed by a session's folder (the session list, the grid of
 * terminals, the last folder open) keeps working unchanged, and a remote
 * folder can never be mistaken for a local one.
 */

import type { AdeSession } from './adeSessions'

export interface SshHost {
  id: string
  /** What the picker shows: the config alias, or user@hostname. */
  label: string
  hostname: string
  user: string | null
  port: number | null
  /** A private key file to offer, or null to let ssh's own rules decide. */
  identityFile: string | null
  /**
   * `config`: a `Host` entry in ~/.ssh/config, reached as `ssh <alias>` so the
   * user's own ProxyJump, IdentityFile lines and the rest apply. `manual`:
   * added in Eaon, so every flag is passed explicitly.
   */
  source: 'config' | 'manual'
  alias: string | null
}

export interface ManualHostInput {
  label?: string
  hostname: string
  user?: string
  port?: number
  identityFile?: string
}

export interface NewRemoteSessionRequest {
  hostId: string
  /** A folder on the host; `~` and `~/…` are the remote user's home. */
  path: string
  title?: string
}

export type NewRemoteSessionResult = { ok: true; session: AdeSession } | { ok: false; error: string }

export function hostLabel(h: Pick<SshHost, 'alias' | 'user' | 'hostname' | 'label'>): string {
  if (h.label) return h.label
  if (h.alias) return h.alias
  return h.user ? `${h.user}@${h.hostname}` : h.hostname
}

export const REMOTE_PREFIX = 'ssh://'

/** The session folder for `path` on a host. */
export function remoteCwd(hostId: string, path: string): string {
  return `${REMOTE_PREFIX}${encodeURIComponent(hostId)}${path.startsWith('/') ? path : `/${path}`}`
}

/** The host and remote path a session folder stands for, or null for a local folder. */
export function remoteLocation(cwd: string): { hostId: string; path: string } | null {
  if (!cwd.startsWith(REMOTE_PREFIX)) return null
  const rest = cwd.slice(REMOTE_PREFIX.length)
  const slash = rest.indexOf('/')
  if (slash <= 0) return null
  try {
    return { hostId: decodeURIComponent(rest.slice(0, slash)), path: rest.slice(slash) }
  } catch {
    return null
  }
}

export const isRemote = (cwd: string): boolean => remoteLocation(cwd) !== null
