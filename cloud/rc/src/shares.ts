/**
 * Sharing: one of your computers, or one terminal on it, with another GitHub
 * account, until you revoke it.
 *
 * You name who it's for (their GitHub login) and get a link to send them. The
 * link works once, only for that login, and only for a week; accepting binds
 * the share to their account id, so a renamed login can't inherit it. From
 * then on their tabs connect to your account's relay as guests, and every
 * message they send is checked here against what was shared. A pane share
 * reaches that terminal and nothing else; the whole computer reaches what
 * your own tabs do. "Watch" never types, starts or changes anything.
 */

export type Access = 'watch' | 'control'

export interface Share {
  id: string
  /** The computer. */
  dev: string
  /** One terminal on it; null for the whole computer. */
  pane: string | null
  /** What the terminal was called when shared, so the guest sees a name before anything loads. */
  paneLabel: string | null
  access: Access
  /** The GitHub login it's for, as typed (matched without case). */
  login: string
  /** The account id that accepted it; null while the invite is open. */
  uid: string | null
  /** SHA-256 of the invite secret; cleared once accepted, so the link works once. */
  hash: string | null
  /** Who shared it, for the guest's view. */
  ownerLogin: string
  createdAt: number
  acceptedAt: number | null
}

export interface Grant {
  pane: string | null
  paneLabel: string | null
  access: Access
}

/** An invite nobody accepted stops working after this long. */
export const INVITE_MS = 7 * 24 * 60 * 60 * 1000
export const MAX_SHARES = 50

export const isLogin = (value: unknown): value is string => typeof value === 'string' && /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/.test(value)

/** What one guest account may do on one computer: every accepted share it holds there. */
export function grantsFor(shares: readonly Share[], uid: string, dev: string): Grant[] {
  return shares.filter((s) => s.uid === uid && s.dev === dev).map((s) => ({ pane: s.pane, paneLabel: s.paneLabel, access: s.access }))
}

const pathOf = (raw: unknown): string => (String(raw ?? '/').split('?')[0].replace(/\/+$/, '') || '/')

/**
 * Whether a guest's message may reach the computer. A request, a terminal
 * subscription or typing is let through only when one of the guest's grants
 * on that computer covers it; anything else (a message type this doesn't
 * know) is refused.
 */
export function permits(grants: readonly Grant[], message: Record<string, unknown>): boolean {
  if (!grants.length) return false
  const whole = grants.filter((g) => g.pane === null)
  const canAll = whole.length > 0
  const typeAll = whole.some((g) => g.access === 'control')
  const pane = String(message.pane ?? '')
  const onPane = (control: boolean): boolean => grants.some((g) => g.pane !== null && g.pane === pane && (!control || g.access === 'control'))

  switch (message.t) {
    case 'req': {
      const method = String(message.method ?? 'GET').toUpperCase()
      const path = pathOf(message.path)
      const read = method === 'GET' || method === 'HEAD'
      if (canAll) return read || typeAll
      const one = /^\/ade\/panes\/([\w-]+)(\/start)?$/.exec(path)
      if (!one) return false
      if (read) return !one[2] && grants.some((g) => g.pane === one[1])
      return Boolean(one[2]) && method === 'POST' && grants.some((g) => g.pane === one[1] && g.access === 'control')
    }
    case 'sub':
    case 'unsub':
      return canAll || onPane(false)
    case 'input':
      return typeAll || onPane(true)
    case 'bsub':
    case 'bunsub':
      return canAll
    default:
      return false
  }
}

/** A share as its owner's tabs see it: never the invite secret's hash. */
export function publicShare(s: Share): Omit<Share, 'hash'> & { pending: boolean; expired: boolean } {
  const { hash: _hash, ...rest } = s
  return { ...rest, pending: !s.uid, expired: !s.uid && Date.now() - s.createdAt > INVITE_MS }
}
