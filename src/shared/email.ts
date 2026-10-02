/**
 * The agent's own email. Two ways to have it (`EmailProvider`):
 *
 * - **Cloudflare**: an address on the user's own domain, run on their own
 *   Cloudflare account (Email Sending to send, Email Routing and a small Worker
 *   to receive). Eaon sets all of it up, DNS records included, from an API token.
 * - **AgentMail** (agentmail.to): an inbox made for agents, created from inside Eaon.
 *
 * About AgentMail: Signing up needs only a username and the
 * user's own address, where AgentMail sends a six-digit code; until that code
 * is entered the inbox can receive but not send. A custom domain is added
 * from Settings too: AgentMail returns the DNS records to publish, and Eaon
 * re-checks them on request.
 *
 * Sending is the outward action here, so it is held to the app's approval
 * rules like any other change, and capped per day.
 *
 * Main owns email (`features/email/`); the API key lives in the secrets vault.
 */

export type EmailProvider = 'agentmail' | 'cloudflare'

export type EmailStatus =
  /** Not set up. */
  | 'off'
  /** Signed up; waiting for the code AgentMail emailed the user. */
  | 'verifying'
  | 'ready'
  /** Set up, but AgentMail is refusing the key or unreachable. */
  | 'error'

export interface EmailInbox {
  id: string
  /** The address itself, e.g. "nova@agentmail.to". */
  address: string
  displayName: string | null
}

export interface EmailDomainRecord {
  type: 'TXT' | 'CNAME' | 'MX'
  name: string
  value: string
  status: 'MISSING' | 'INVALID' | 'VALID'
  priority: number | null
  /** Why an INVALID record is wrong, in plain words, when AgentMail says. */
  reason?: string | null
}

export interface EmailDomain {
  id: string
  domain: string
  status: 'NOT_STARTED' | 'PENDING' | 'INVALID' | 'FAILED' | 'VERIFYING' | 'VERIFIED'
  records: EmailDomainRecord[]
  /** Why it isn't verified yet, in AgentMail's words, when known. */
  reason: string | null
}

export interface EmailAttachment {
  id: string
  filename: string
  size: number
  contentType: string | null
}

export interface EmailMessage {
  id: string
  threadId: string
  from: string
  to: string[]
  cc: string[]
  subject: string
  preview: string
  /** The new text of the message, quoted history removed; only on a message read in full. */
  text?: string
  at: number
  labels: string[]
  unread: boolean
  /** True for mail the agent sent. */
  sent: boolean
  attachments: EmailAttachment[]
}

export interface EmailState {
  status: EmailStatus
  provider: EmailProvider
  /** The domain on Cloudflare, when that's where the email runs. */
  cloudflare: {
    zoneName: string
    domain: string
    /** Email Sending is set up: Eaon can email anyone. */
    canSend: boolean
    /**
     * Who Eaon can email: anyone (Email Sending), only the account's verified
     * destination addresses (the Worker's free route), or nobody yet.
     */
    sendsTo: 'anyone' | 'verified' | 'nobody'
    /** The verified destination addresses, when the token can read them. */
    verified: string[] | null
    /** An AgentMail key was kept when switching: disconnecting Cloudflare goes back to it. */
    returnsToAgentMail: boolean
  } | null
  /** Workers with an address of their own; the rest use Eaon's. */
  workerAddresses: { workerId: string; inbox: EmailInbox }[]
  /** The inbox the agent uses. */
  inbox: EmailInbox | null
  /** Every inbox on the account, to switch between. */
  inboxes: EmailInbox[]
  /** The user's own address, where verification codes go. */
  humanEmail: string | null
  domains: EmailDomain[]
  /** Newest first, at most 30. */
  recent: EmailMessage[]
  unread: number
  sentToday: number
  maxPerDay: number
  /** How often Eaon checks for new mail in the background; 0 = only when asked. */
  checkEveryMinutes: number
  /** A desktop notification when new mail arrives. */
  notifyNew: boolean
  lastCheckedAt: number | null
  error: string | null
}

export interface EmailSignUp {
  /** The part before the @ — "nova" becomes nova@agentmail.to. */
  username: string
  /** The user's own address: AgentMail sends the code here, and only then can the inbox send. */
  humanEmail: string
  displayName?: string
}

export interface EmailOutgoing {
  to: string[]
  cc?: string[]
  subject: string
  text: string
}

/** A domain on the user's Cloudflare account, to pick from. */
export interface CloudflareZoneChoice {
  id: string
  name: string
  /** "active" once the domain's nameservers point at Cloudflare. */
  status: string
  accountName: string | null
}

export interface CloudflareSetup {
  /**
   * An API token — or the Global API Key, with `email`: Eaon then uses the key
   * once to make a token with only the permissions email needs, and keeps
   * just that token. Optional when Cloudflare is already connected.
   */
  token?: string
  /** The Cloudflare login email, needed with a Global API Key only. */
  email?: string
  zoneId: string
  /** "agents" for agents.example.com; empty for the domain itself. */
  subdomain?: string
  /** The part before the @. */
  username: string
  displayName?: string
}

/**
 * What was pasted, by its shape (developers.cloudflare.com → Token formats):
 * user and account API tokens are `cfut_`/`cfat_` + 40 characters + an 8-hex
 * checksum, or 40 letters, digits, `-` and `_` before 2026; the Global API Key
 * is `cfk_` + 40 + checksum, or 37–45 lowercase hex before; account and zone
 * IDs are 32 hex. Anything else is cut short or something else entirely.
 */
export type CloudflareKeyKind = 'token' | 'global-key' | 'id' | 'cut-short' | 'unknown'

/** Strips what comes along when a token is copied: spaces, invisible characters, quotes, "Bearer ". */
export function cleanCloudflareKey(input: unknown): string {
  return String(input ?? '')
    .replace(/[\u200B-\u200D\u2060\uFEFF\u00A0]/g, '')
    .trim()
    .replace(/^authorization:\s*/i, '')
    .replace(/^bearer\s+/i, '')
    .replace(/^["'`“”‘’]+|["'`“”‘’]+$/g, '')
    .trim()
}

export function cloudflareKeyKind(clean: string): CloudflareKeyKind {
  if (/^cf(ut|at)_[A-Za-z0-9_-]{40}[0-9a-fA-F]{8}$/.test(clean)) return 'token'
  if (/^cfk_[A-Za-z0-9_-]{40}[0-9a-fA-F]{8}$/.test(clean)) return 'global-key'
  if (/^cf(ut|at|k)_/.test(clean)) return 'cut-short'
  if (/^[0-9a-f]{32}$/i.test(clean)) return 'id'
  if (/^[0-9a-f]{37,45}$/.test(clean)) return 'global-key'
  if (/^[A-Za-z0-9_-]{40}$/.test(clean)) return 'token'
  return 'unknown'
}

/**
 * What the Cloudflare API token needs, in the dashboard's words. The link
 * fills in the ones Cloudflare's token templates know by key; the rest are
 * added by hand.
 */
export const CLOUDFLARE_TOKEN_PERMISSIONS: { scope: 'Account' | 'Zone'; name: string; prefilled: boolean }[] = [
  { scope: 'Zone', name: 'Zone: Read', prefilled: true },
  { scope: 'Zone', name: 'DNS: Edit', prefilled: true },
  { scope: 'Zone', name: 'Zone Settings: Edit', prefilled: false },
  { scope: 'Zone', name: 'Email Routing Rules: Edit', prefilled: false },
  { scope: 'Account', name: 'Workers Scripts: Edit', prefilled: true },
  { scope: 'Account', name: 'Workers KV Storage: Edit', prefilled: true },
  { scope: 'Account', name: 'Email Sending: Edit', prefilled: false }
]

/** The token page with the prefillable permissions already chosen. */
export const CLOUDFLARE_TOKEN_URL = `https://dash.cloudflare.com/profile/api-tokens?permissionGroupKeys=${encodeURIComponent(
  JSON.stringify([
    { key: 'zone', type: 'read' },
    { key: 'dns', type: 'edit' },
    { key: 'workers_scripts', type: 'edit' },
    { key: 'workers_kv_storage', type: 'edit' }
  ])
)}&accountId=*&zoneId=all&name=${encodeURIComponent('Eaon email')}`

export type EmailOptions = Partial<Pick<EmailState, 'maxPerDay' | 'checkEveryMinutes' | 'notifyNew'>>

export const DEFAULT_EMAILS_PER_DAY = 50
/** How often Eaon looks for new mail unless the user changes it. */
export const DEFAULT_EMAIL_CHECK_MINUTES = 5
