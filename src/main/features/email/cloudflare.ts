import { createHmac } from 'node:crypto'
import PostalMime, { decodeWords } from 'postal-mime'
import {
  AgentMailError,
  messageText,
  type AgentMailDomain,
  type AgentMailDomainItem,
  type AgentMailInbox,
  type AgentMailMessage,
  type AgentMailMessageItem,
  type AgentMailRecord,
  type AgentMailSent
} from './agentmail'

/**
 * The agent's email on the user's own domain, run entirely on the user's
 * Cloudflare account — no AgentMail. Built on two Cloudflare products:
 *
 * - **Email Sending** (`POST /accounts/{id}/email/sending/send`) sends as any
 *   address on a domain onboarded for sending. Sending to people outside the
 *   account needs the Workers Paid plan; Eaon says so when Cloudflare refuses.
 * - **Without it**, the Worker sends instead, through its `send_email`
 *   binding: free on any plan, but only to destination addresses verified in
 *   the account. It answers `POST /send` on workers.dev, to Eaon alone (a
 *   secret derived from the token). Once Email Sending is available, Eaon
 *   notices on its own and switches (`tryEnableSending`).
 * - **Email Routing** delivers mail for each agent address to `eaon-mail`, a
 *   small Worker Eaon uploads (`MAIL_WORKER_SOURCE`). It keeps every message,
 *   raw, in the `eaon-mail` KV namespace. Eaon reads that namespace through the
 *   API; the Worker has no web endpoint at all.
 *
 * `setUp` does the whole job and is safe to run again ("Check again" runs it):
 * KV namespace, Worker, Email Routing, the sending domain, the DNS records
 * sending needs, and one routing rule per address. It refuses to turn on
 * Email Routing where the domain already receives mail elsewhere, so the
 * user's existing email is never taken over; a subdomain is the answer then.
 *
 * The class has the same shape as `AgentMailClient` (inboxes are addresses,
 * the one domain is the configured one), so `EmailService` — its daily cap,
 * notifications and the agent's tools — works the same on either.
 */

export const CLOUDFLARE_API = 'https://api.cloudflare.com/client/v4'
export const MAIL_WORKER_NAME = 'eaon-mail'
export const MAIL_NAMESPACE_TITLE = 'eaon-mail'
const COMPATIBILITY_DATE = '2026-09-01'
const TIMEOUT_MS = 20_000
const RETRY_DELAY_MS = 800
/** How many stored messages one listing looks through. */
const SCAN_LIMIT = 1000
/** Messages whose text is fetched for the preview line; the rest show subject only. */
const PREVIEW_LIMIT = 30
const KEY_PREFIX = 'm/'
/** Bumped when the Worker changes; an older one is re-uploaded on the next start. */
export const MAIL_WORKER_VERSION = 2
/** Keys sort ascending, so an inverted clock puts the newest first. */
const CLOCK_CEILING = 9_999_999_999_999

/**
 * The Worker Eaon uploads. Kept dependency-free and tiny: it only stores what
 * arrives. Eaon parses the MIME itself when reading. Metadata carries just
 * enough to list and filter without fetching (KV allows 1024 bytes of it).
 */
export const MAIL_WORKER_SOURCE = `// Eaon's mail Worker. Cloudflare Email Routing hands it the mail for Eaon's
// addresses; it keeps each message, as received, in the MAIL KV namespace for
// the Eaon app to read. It has no web endpoint and sends nothing.
const MAX_BYTES = 25 * 1024 * 1024
const CEILING = 9999999999999
const cut = (value, n) => (typeof value === 'string' ? value.slice(0, n) : '')

export default {
  async email(message, env) {
    if (message.rawSize > MAX_BYTES) {
      message.setReject('Message too large')
      return
    }
    const raw = await new Response(message.raw).arrayBuffer()
    const now = Date.now()
    const key = 'm/' + String(CEILING - now).padStart(13, '0') + '-' + crypto.randomUUID().slice(0, 8)
    const headers = message.headers
    const full = {
      d: 'in',
      r: cut(String(message.to).toLowerCase(), 120),
      f: cut(headers.get('from') || message.from, 160),
      t: cut(headers.get('to') || message.to, 160),
      s: cut(headers.get('subject') || '', 200),
      at: now,
      z: message.rawSize
    }
    try {
      await env.MAIL.put(key, raw, { metadata: full })
    } catch (error) {
      // Metadata over KV's limit: keep the message with the minimum needed to find it.
      await env.MAIL.put(key, raw, { metadata: { d: 'in', r: full.r, at: now, z: full.z } })
    }
  },

  // Sending for an account without Email Sending: Cloudflare lets a Worker email
  // the account's verified destination addresses for free. Only Eaon knows SECRET;
  // anything else gets a 404, as if nothing were here.
  async fetch(request, env) {
    const url = new URL(request.url)
    if (request.method !== 'POST' || url.pathname !== '/send' || !env.SEND || !env.SECRET) return notFound()
    if (!same(request.headers.get('authorization') || '', 'Bearer ' + env.SECRET)) return notFound()
    let body
    try {
      body = await request.json()
    } catch (error) {
      return reply({ ok: false, code: 'E_VALIDATION_ERROR', message: 'The request wasn’t JSON' })
    }
    const message = { from: body.from, to: body.to, subject: body.subject, text: body.text }
    if (body.cc && body.cc.length) message.cc = body.cc
    if (body.headers && Object.keys(body.headers).length) message.headers = body.headers
    try {
      const result = await env.SEND.send(message)
      return reply({ ok: true, messageId: (result && result.messageId) || null })
    } catch (error) {
      return reply({ ok: false, code: (error && error.code) || null, message: String((error && error.message) || error) })
    }
  }
}

const notFound = () => new Response('Not found', { status: 404 })
const reply = (value) => new Response(JSON.stringify(value), { headers: { 'content-type': 'application/json' } })
const same = (a, b) => {
  if (a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i)
  return diff === 0
}
`

export interface CloudflareAddress {
  address: string
  displayName: string | null
  /** The Email Routing rule that sends this address to the Worker. */
  ruleId: string | null
}

/** Where Eaon's mail lives on the user's Cloudflare account. Saved in email.json; the token is in the vault. */
export interface CloudflareMailConfig {
  accountId: string
  zoneId: string
  /** The domain on Cloudflare, e.g. example.com. */
  zoneName: string
  /** What comes after the @: the zone itself or a subdomain of it. */
  domain: string
  namespaceId: string | null
  workerName: string
  /** The sending domain's id at Email Sending; null until the account has Email Sending. */
  sendingTag: string | null
  /** Where the Worker takes sends to verified addresses (its workers.dev URL); null when it can't. */
  workerUrl?: string | null
  /** MAIL_WORKER_VERSION of the uploaded Worker; older ones are re-uploaded. */
  workerVersion?: number
  addresses: CloudflareAddress[]
}

export interface CloudflareZone {
  id: string
  name: string
  status: string
  accountId: string
  accountName: string | null
}

interface Envelope<T> {
  success?: boolean
  errors?: { code?: number; message?: string }[]
  result?: T
  result_info?: { cursor?: string; page?: number; total_pages?: number; count?: number }
}

interface KvKey {
  name: string
  metadata?: { d?: string; r?: string; f?: string; t?: string; s?: string; at?: number; z?: number; p?: string; th?: string }
}

interface DnsRecord {
  id?: string
  type: string
  name: string
  content: string
  priority?: number
}

interface RoutingRule {
  id?: string
  tag?: string
  matchers?: { type?: string; field?: string; value?: string }[]
  actions?: { type?: string; value?: string[] }[]
}

/**
 * What Cloudflare answers for a credential it won't take (checked live, Oct 2026):
 * - a well-formed token it doesn't know (deleted, rolled, expired, mistyped): 403, 9109 "Invalid access token";
 * - anything not shaped like a token (a Global API Key or an ID sent as one): 400, 6003 + 6111 "Invalid format for Authorization header";
 * - a Global API Key with the wrong email: 403, 9103 "Unknown X-Auth-Key or X-Auth-Email";
 * - nothing at all: 403, 9106 + 9107.
 * - a good token without the permission: 403 10000 "Authentication error" (most APIs),
 *   403 9109 "Unauthorized to access requested resource", or 401 2036 "Unauthorized" (Email Sending).
 *   Seen on the co-founder's account, Oct 1 2026.
 * 9109 also reads "Unauthorized to access requested resource" for a good token
 * without the permission, which is not a token problem.
 */
const FORMAT_CODES = new Set([6003, 6111])
const GLOBAL_KEY_CODES = new Set([9103, 9106, 9107])

export interface CloudflareClientOptions {
  baseUrl?: string
  timeoutMs?: number
  retryDelayMs?: number
  /** Makes `token` a Global API Key, sent with this login email (X-Auth-Email / X-Auth-Key). Only used to make a token. */
  globalKeyEmail?: string
  /** Tests: where the Worker's endpoint is, instead of its workers.dev address. */
  workerOrigin?: string
}

/**
 * The permissions Eaon's email needs, as Cloudflare's permission groups name
 * them: "Write" through the API where the dashboard says "Edit"; either, and
 * the dashboard's colon, are accepted.
 */
const EMAIL_PERMISSIONS: { label: string; match: RegExp; scope: 'zone' | 'account'; optional?: boolean }[] = [
  { label: 'Zone: Read', match: /^zone:? read$/i, scope: 'zone' },
  { label: 'DNS: Edit', match: /^dns:? (write|edit)$/i, scope: 'zone' },
  { label: 'Zone Settings: Edit', match: /^zone settings:? (write|edit)$/i, scope: 'zone' },
  { label: 'Email Routing Rules: Edit', match: /^email routing rules:? (write|edit)$/i, scope: 'zone' },
  { label: 'Workers Scripts: Edit', match: /^workers scripts:? (write|edit)$/i, scope: 'account' },
  { label: 'Workers KV Storage: Edit', match: /^workers kv storage:? (write|edit)$/i, scope: 'account' },
  { label: 'Email Sending: Edit', match: /^email sending:? (write|edit)$/i, scope: 'account' },
  // Lets Eaon verify recipients for the free route itself; the dashboard does it too.
  { label: 'Email Routing Addresses: Edit', match: /^email routing addresses:? (write|edit)$/i, scope: 'account', optional: true }
]

/** Parsed messages by namespace and key: stored mail never changes, so each is fetched once. */
const parsedCache = new Map<string, ParsedSummary>()
const CACHE_CAP = 500

interface ParsedSummary {
  from: string
  to: string[]
  cc: string[]
  subject: string
  preview: string
  text: string
  messageId: string | null
  references: string | null
  replyTo: string[]
  attachments: { attachment_id: string; filename: string | null; size: number; content_type: string | null }[]
}

/**
 * An error from Cloudflare. Unlike AgentMail, a 401 doesn't mean the key is
 * bad: Email Sending answers 401 "Unauthorized" (2036) to a good token that
 * lacks its permission. Only `cloudflareError`'s verdict (`unauthorized`) does.
 */
export class CloudflareError extends AgentMailError {
  override get keyRefused(): boolean {
    return this.code === 'unauthorized'
  }
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))
const seg = (value: string): string => encodeURIComponent(value)

export class CloudflareMailClient {
  private readonly baseUrl: string
  private readonly timeoutMs: number
  private readonly retryDelayMs: number
  private readonly globalKeyEmail: string | null
  private readonly workerOrigin: string | null

  constructor(
    private readonly token: string | null,
    /** The saved setup; null before `setUp`. */
    private readonly getConfig: () => CloudflareMailConfig | null,
    /** Persists a changed setup (addresses added, ids learned). */
    private readonly saveConfig: (config: CloudflareMailConfig) => void,
    options: CloudflareClientOptions = {}
  ) {
    this.baseUrl = (options.baseUrl ?? CLOUDFLARE_API).replace(/\/+$/, '')
    this.timeoutMs = options.timeoutMs ?? TIMEOUT_MS
    this.retryDelayMs = options.retryDelayMs ?? RETRY_DELAY_MS
    this.globalKeyEmail = options.globalKeyEmail?.trim() || null
    this.workerOrigin = options.workerOrigin?.replace(/\/+$/, '') || null
  }

  // — Account ———————————————————————————————————————————————————

  /**
   * A token with only what Eaon's email needs: the zone permissions on
   * `zone`, the account permissions on its account. Made with the Global API
   * Key (this client must have `globalKeyEmail`); returns the token's secret.
   */
  async createEmailToken(zone: { id: string; name: string; accountId: string }): Promise<string> {
    const { result: groups } = await this.api<{ id: string; name: string; scopes?: string[] }[]>('GET', '/user/tokens/permission_groups')
    const chosen = EMAIL_PERMISSIONS.map((wanted) => {
      const matches = (groups ?? []).filter((g) => wanted.match.test(g.name.trim()))
      const scoped = matches.find((g) => (g.scopes ?? []).some((sc) => (wanted.scope === 'zone' ? sc.endsWith('.zone') : !sc.endsWith('.zone'))))
      return { wanted, group: scoped ?? matches[0] ?? null }
    })
    const missing = chosen.filter((c) => !c.group && !c.wanted.optional).map((c) => c.wanted.label)
    if (missing.length) {
      throw new CloudflareError(
        `Cloudflare didn’t offer ${missing.join(', ')} to this account, so Eaon couldn’t make the token. Make one by hand on the API Tokens page instead.`,
        422,
        'missing_permission_groups'
      )
    }
    const policy = (scope: 'zone' | 'account', resource: string): { effect: string; resources: Record<string, string>; permission_groups: { id: string }[] } => ({
      effect: 'allow',
      resources: { [resource]: '*' },
      permission_groups: chosen.filter((c) => c.wanted.scope === scope && c.group).map((c) => ({ id: c.group!.id }))
    })
    const { result } = await this.api<{ id?: string; value?: string }>('POST', '/user/tokens', {
      body: {
        name: `Eaon email (${zone.name})`,
        policies: [policy('zone', `com.cloudflare.api.account.zone.${zone.id}`), policy('account', `com.cloudflare.api.account.${zone.accountId}`)]
      }
    })
    if (!result?.value) throw new CloudflareError('Cloudflare made the token but didn’t return it. Make one by hand on the API Tokens page instead.', 502)
    return result.value
  }

  /** The domains this token can see. Also how a token is checked. */
  async listZones(): Promise<CloudflareZone[]> {
    const zones: CloudflareZone[] = []
    for (let page = 1; page <= 10; page++) {
      const { result, info } = await this.api<{ id: string; name: string; status?: string; account?: { id?: string; name?: string } }[]>('GET', '/zones', {
        query: { per_page: 50, page }
      })
      for (const zone of result ?? []) {
        if (!zone?.id || !zone.name || !zone.account?.id) continue
        zones.push({ id: zone.id, name: zone.name, status: zone.status ?? 'active', accountId: zone.account.id, accountName: zone.account.name ?? null })
      }
      if (!info?.total_pages || page >= info.total_pages) break
    }
    return zones
  }

  /**
   * Everything the agent's email needs, created where missing and left alone
   * where it is already right. Returns the finished setup (also saved).
   */
  async setUp(draft: CloudflareMailConfig): Promise<CloudflareMailConfig> {
    const config: CloudflareMailConfig = structuredClone(draft)
    const { accountId, zoneId, domain } = config
    const { sending: canSend } = await this.checkPermissions(config)

    config.namespaceId = await step('make the storage for Eaon’s mail (Workers KV)', 'Workers KV Storage: Edit', async () => {
      if (config.namespaceId) {
        const known = await this.findNamespace(accountId, (n) => n.id === config.namespaceId)
        if (known) return known.id
      }
      const existing = await this.findNamespace(accountId, (n) => n.title === MAIL_NAMESPACE_TITLE)
      if (existing) return existing.id
      const { result } = await this.api<{ id: string }>('POST', `/accounts/${seg(accountId)}/storage/kv/namespaces`, { body: { title: MAIL_NAMESPACE_TITLE } })
      return result.id
    })

    await step('upload the Worker that receives Eaon’s mail', 'Workers Scripts: Edit', async () => {
      const form = new FormData()
      form.set(
        'metadata',
        JSON.stringify({
          main_module: 'worker.js',
          compatibility_date: COMPATIBILITY_DATE,
          bindings: [
            { type: 'kv_namespace', name: 'MAIL', namespace_id: config.namespaceId },
            { type: 'send_email', name: 'SEND' },
            { type: 'secret_text', name: 'SECRET', text: this.workerSecret() }
          ]
        })
      )
      form.set('worker.js', new Blob([MAIL_WORKER_SOURCE], { type: 'application/javascript+module' }), 'worker.js')
      await this.api('PUT', `/accounts/${seg(accountId)}/workers/scripts/${seg(config.workerName)}`, { form })
      config.workerVersion = MAIL_WORKER_VERSION
    })
    // Its sending endpoint lives on workers.dev. Without a workers.dev subdomain on the account
    // there is no free route; full Email Sending doesn't need it.
    config.workerUrl = await this.openWorkerUrl(config).catch(() => null)

    await step(`turn on Email Routing for ${domain}`, 'Zone Settings: Edit', async () => {
      await this.refuseForeignMx(config)
      if (await this.receives(config)) return
      let refused: unknown = null
      await this.api('POST', `/zones/${seg(zoneId)}/email/routing/dns`, { body: { name: domain } }).catch((error: unknown) => (refused = error))
      if (await this.receives(config)) return
      // Turned on, but without MX records at a subdomain: add the ones Cloudflare lists for the zone, at the subdomain.
      if (!refused && domain !== config.zoneName) {
        for (const record of await this.routingRecords(config)) await this.createRecord(zoneId, { ...record, name: domain })
        if (await this.receives(config)) return
      }
      throw refused ?? new CloudflareError(`Cloudflare turned on Email Routing, but ${domain} has no MX records pointing at it yet.`, 409)
    })

    // Without Email Sending on the account, receiving is set up now and sending when it is ("Check again").
    config.sendingTag = !canSend
      ? null
      : await step(`set up sending from ${domain}`, 'Email Sending: Edit', async () => {
          const existing = await this.findSendingDomain(zoneId, domain)
          if (existing?.tag && existing.enabled !== false) return existing.tag
          const { result } = await this.api<{ tag: string }>('POST', `/zones/${seg(zoneId)}/email/sending/subdomains`, { body: { name: domain } })
          return result.tag
        })

    if (config.sendingTag) await step(`add the DNS records for ${domain}`, 'DNS: Edit', () => this.addSendingRecords(config))

    for (const entry of config.addresses) {
      entry.ruleId = await this.ensureRule(config, entry.address)
    }
    this.saveConfig(config)
    return config
  }

  /**
   * Email Sending, if the account has it now: onboards the domain and adds its
   * records, as setUp would. False while Cloudflare still refuses it. Called
   * before a send and on each background check, so turning Email Sending on
   * in the dashboard is all it takes — no "Check again".
   */
  async tryEnableSending(): Promise<boolean> {
    const config = this.requireConfig()
    if (config.sendingTag) return true
    let existing: { tag?: string; enabled?: boolean } | null
    try {
      existing = await this.findSendingDomain(config.zoneId, config.domain)
    } catch (error) {
      if (error instanceof AgentMailError && isDenied(error)) return false
      throw error
    }
    config.sendingTag =
      existing?.tag && existing.enabled !== false
        ? existing.tag
        : (await this.api<{ tag: string }>('POST', `/zones/${seg(config.zoneId)}/email/sending/subdomains`, { body: { name: config.domain } })).result.tag
    await this.addSendingRecords(config)
    this.saveConfig(config)
    return true
  }

  /** Destination addresses verified in the account (the free route's recipients); null when the token can't read them. */
  async verifiedAddresses(): Promise<string[] | null> {
    const config = this.requireConfig()
    try {
      const { result } = await this.api<{ email?: string; verified?: string | null }[]>('GET', `/accounts/${seg(config.accountId)}/email/routing/addresses`, { query: { per_page: 50 } })
      return (result ?? []).filter((a) => a.email && a.verified).map((a) => a.email!.toLowerCase())
    } catch {
      return null
    }
  }

  /** Adds a destination address; Cloudflare emails it a link, and it can be sent to once that is clicked. */
  async addDestinationAddress(email: string): Promise<void> {
    const config = this.requireConfig()
    try {
      await this.api('POST', `/accounts/${seg(config.accountId)}/email/routing/addresses`, { body: { email } })
    } catch (error) {
      if (error instanceof AgentMailError && isDenied(error)) {
        throw new CloudflareError(
          `Eaon’s token can’t add addresses. Add ${email} in Cloudflare → Email Service → Email Routing → Destination addresses instead — Cloudflare emails it a link to click.`,
          error.status,
          'missing_permissions'
        )
      }
      throw error
    }
  }

  /**
   * Every permission setup needs, tried with a read before anything is
   * changed, so a token short of several hears about all of them at once.
   * A read stands in for its Edit permission (Edit includes Read).
   */
  async checkPermissions(config: Pick<CloudflareMailConfig, 'accountId' | 'zoneId'>): Promise<{ sending: boolean }> {
    const account = seg(config.accountId)
    const zone = seg(config.zoneId)
    const probes: { permission: string; scope: 'Account' | 'Zone'; path: string }[] = [
      { permission: 'Workers KV Storage: Edit', scope: 'Account', path: `/accounts/${account}/storage/kv/namespaces?per_page=5` },
      { permission: 'Workers Scripts: Edit', scope: 'Account', path: `/accounts/${account}/workers/scripts` },
      { permission: 'Email Sending: Edit', scope: 'Account', path: `/zones/${zone}/email/sending/subdomains` },
      { permission: 'Zone Settings: Edit', scope: 'Zone', path: `/zones/${zone}/email/routing` },
      { permission: 'DNS: Edit', scope: 'Zone', path: `/zones/${zone}/dns_records?per_page=5` },
      { permission: 'Email Routing Rules: Edit', scope: 'Zone', path: `/zones/${zone}/email/routing/rules?per_page=5` }
    ]
    const outcomes = await Promise.all(
      probes.map((probe) =>
        this.api('GET', probe.path).then(
          () => null,
          (error: unknown) => ({ probe, error })
        )
      )
    )
    const failed = outcomes.filter((o): o is { probe: (typeof probes)[number]; error: unknown } => o !== null)
    const badToken = failed.find((f) => f.error instanceof AgentMailError && f.error.keyRefused)
    if (badToken) throw badToken.error
    const denied = failed.filter((f) => f.error instanceof AgentMailError && isDenied(f.error)).map((f) => f.probe)
    // Sending is the one thing setup can do without: receiving works, and sending is turned on later.
    const sending = !denied.some((m) => m.permission.startsWith('Email Sending'))
    const missing = denied.filter((m) => !m.permission.startsWith('Email Sending'))
    if (missing.length === 0) return { sending }
    const list = (scope: 'Account' | 'Zone'): string => missing.filter((m) => m.scope === scope).map((m) => m.permission).join(', ')
    const parts = [list('Zone') && `${list('Zone')} (under Zone, for your domain)`, list('Account') && `${list('Account')} (under Account)`].filter(Boolean)
    throw new CloudflareError(
      `The token is missing ${missing.length === 1 ? 'a permission' : `${missing.length} permissions`} Eaon needs: ${parts.join(' and ')}. ` +
        'On Cloudflare, open My Profile → API Tokens, choose Edit on this token, add them, and try again — the token stays the same.',
      403,
      'missing_permissions'
    )
  }

  // — Inboxes: the addresses routed to the Worker ————————————————

  async listInboxes(): Promise<AgentMailInbox[]> {
    return this.requireConfig().addresses.map(toInbox)
  }

  async getInbox(inboxId: string): Promise<AgentMailInbox> {
    const found = this.requireConfig().addresses.find((a) => a.address === inboxId.toLowerCase())
    if (!found) throw new CloudflareError(`${inboxId} isn’t one of Eaon’s addresses.`, 404)
    return toInbox(found)
  }

  /** A new address on the domain, routed to the Worker. */
  async createInbox(input: { username?: string; domain?: string; display_name?: string }): Promise<AgentMailInbox> {
    const config = this.requireConfig()
    if (!input.username) throw new CloudflareError('Pick the part before the @.', 400)
    if (input.domain && input.domain !== config.domain) throw new CloudflareError(`Addresses here are on ${config.domain}.`, 400)
    const address = `${input.username}@${config.domain}`.toLowerCase()
    const existing = config.addresses.find((a) => a.address === address)
    const entry: CloudflareAddress = existing ?? { address, displayName: input.display_name?.trim() || null, ruleId: null }
    if (!existing) config.addresses.push(entry)
    else if (input.display_name?.trim()) entry.displayName = input.display_name.trim()
    entry.ruleId = await this.ensureRule(config, address)
    this.saveConfig(config)
    return toInbox(entry)
  }

  async updateInbox(inboxId: string, input: { display_name: string }): Promise<AgentMailInbox> {
    const config = this.requireConfig()
    const entry = config.addresses.find((a) => a.address === inboxId.toLowerCase())
    if (!entry) throw new CloudflareError(`${inboxId} isn’t one of Eaon’s addresses.`, 404)
    entry.displayName = input.display_name.trim() || null
    this.saveConfig(config)
    return toInbox(entry)
  }

  /** Stops routing an address to Eaon. Mail already stored stays. */
  async deleteInbox(inboxId: string): Promise<void> {
    const config = this.requireConfig()
    const entry = config.addresses.find((a) => a.address === inboxId.toLowerCase())
    if (!entry) return
    const ruleId = entry.ruleId ?? (await this.findRule(config.zoneId, entry.address))?.id ?? null
    if (ruleId) {
      await step(`stop routing ${entry.address}`, 'Email Routing Rules: Edit', async () => {
        await this.api('DELETE', `/zones/${seg(config.zoneId)}/email/routing/rules/${seg(ruleId)}`).catch((error: unknown) => {
          if (!(error instanceof AgentMailError && error.status === 404)) throw error
        })
      })
    }
    config.addresses = config.addresses.filter((a) => a !== entry)
    this.saveConfig(config)
  }

  // — Messages ——————————————————————————————————————————————————

  /** Mail to or from `inboxId`, newest first. Read state is kept by Eaon, so every received message is labelled `received`. */
  async listMessages(inboxId: string, options: { limit?: number; labels?: string[] } = {}): Promise<AgentMailMessageItem[]> {
    const config = this.requireConfig()
    const address = inboxId.toLowerCase()
    const limit = Math.max(1, Math.min(options.limit ?? 20, 100))
    const keys = (await this.listKeys(config)).filter((key) => {
      const m = key.metadata ?? {}
      return m.d === 'out' ? bareAddress(m.f ?? '') === address : (m.r ?? '').toLowerCase() === address
    })
    const chosen = keys.slice(0, limit)
    // Previews need the text; only the newest few are worth fetching.
    const summaries = await Promise.all(chosen.map((key, i) => (i < PREVIEW_LIMIT ? this.summary(config, key.name).catch(() => null) : Promise.resolve(cached(config, key.name)))))
    return chosen.map((key, i) => toItem(inboxId, key, summaries[i]))
  }

  async getMessage(inboxId: string, messageId: string): Promise<AgentMailMessage> {
    const config = this.requireConfig()
    const key = await this.findKey(config, messageId)
    const parsed = await this.summary(config, messageId)
    return { ...toItem(inboxId, key ?? { name: messageId }, parsed), cc: parsed.cc, reply_to: parsed.replyTo, text: parsed.text, body: parsed.text, attachments: parsed.attachments }
  }

  /** Read state isn't stored at Cloudflare; Eaon remembers it instead. */
  async updateMessage(): Promise<{ message_id: string; labels: string[] }> {
    throw new CloudflareError('Read state is kept in Eaon for Cloudflare mail.', 400, 'unsupported')
  }

  async send(inboxId: string, message: { to: string[]; cc?: string[]; subject: string; text: string }): Promise<AgentMailSent> {
    const config = this.requireConfig()
    const sender = config.addresses.find((a) => a.address === inboxId.toLowerCase()) ?? { address: inboxId.toLowerCase(), displayName: null, ruleId: null }
    await this.deliver(config, sender, { to: message.to, cc: message.cc ?? [], subject: message.subject, text: message.text })
    const key = await this.storeSent(config, sender, message.to, message.cc ?? [], message.subject, message.text, null).catch(() => null)
    return { message_id: key ?? `sent-${Date.now()}`, thread_id: key ?? '' }
  }

  /** Answers in the thread: Re: subject, In-Reply-To and References from the original. */
  async reply(inboxId: string, messageId: string, message: { text: string; reply_all?: boolean }): Promise<AgentMailSent> {
    const config = this.requireConfig()
    const own = inboxId.toLowerCase()
    const sender = config.addresses.find((a) => a.address === own) ?? { address: own, displayName: null, ruleId: null }
    const key = await this.findKey(config, messageId)
    const original = await this.summary(config, messageId)
    const fromUs = key?.metadata?.d === 'out'
    const primary = fromUs ? original.to.map(bareAddress) : (original.replyTo.length ? original.replyTo : [original.from]).map(bareAddress)
    const others = message.reply_all ? [...original.to, ...original.cc].map(bareAddress) : []
    const to = unique(primary).filter((a) => a && a !== own)
    const cc = unique(others).filter((a) => a && a !== own && !to.includes(a))
    if (to.length === 0) throw new CloudflareError('There’s no one to reply to on that email.', 400)
    const subject = /^re:/i.test(original.subject) ? original.subject : `Re: ${original.subject || '(no subject)'}`
    const headers: Record<string, string> = {}
    if (original.messageId) {
      headers['In-Reply-To'] = original.messageId
      headers.References = [original.references, original.messageId].filter(Boolean).join(' ').slice(-1900)
    }
    await this.deliver(config, sender, { to, cc, subject, text: message.text, headers })
    const thread = key?.metadata?.th || messageId
    const stored = await this.storeSent(config, sender, to, cc, subject, message.text, thread).catch(() => null)
    return { message_id: stored ?? `sent-${Date.now()}`, thread_id: thread }
  }

  // — The domain ————————————————————————————————————————————————

  async listDomains(): Promise<AgentMailDomainItem[]> {
    const config = this.getConfig()
    return config ? [{ domain_id: config.domain, domain: config.domain }] : []
  }

  /** The domain's state: Email Routing, the sending domain and each DNS record sending needs. */
  async getDomain(): Promise<AgentMailDomain> {
    const config = this.requireConfig()
    const problems: string[] = []
    const routing = await this.routingSettings(config.zoneId).catch(() => null)
    if (!routing?.enabled) problems.push('Email Routing is off, so replies can’t reach Eaon.')
    else if (!(await this.receives(config).catch(() => false))) problems.push(`Mail for ${config.domain} doesn’t reach Cloudflare yet: its MX records are missing.`)
    let sendingRefused = false
    const sending = await this.findSendingDomain(config.zoneId, config.domain).catch((error: unknown) => {
      sendingRefused = error instanceof AgentMailError && isDenied(error)
      return null
    })
    if (sendingRefused) problems.push(SENDING_OFF(config.domain))
    else if (!sending || sending.enabled === false) problems.push(`Sending isn’t set up for ${config.domain} yet. Check again to set it up.`)

    const records: AgentMailRecord[] = []
    for (const record of await this.sendingRecords(config).catch(() => [] as DnsRecord[])) {
      const present = await this.findRecords(config.zoneId, record.type, record.name).catch(() => [] as DnsRecord[])
      const valid = present.some((r) => sameRecord(r, record) || (r.type === 'TXT' && isDmarc(record.content) && isDmarc(r.content)))
      const clash = !valid && present.some((r) => r.type === 'TXT' && conflicting(r.content, record.content))
      records.push({
        type: record.type,
        name: record.name,
        value: record.content,
        priority: record.type === 'MX' ? (record.priority ?? null) : null,
        status: valid ? 'VALID' : clash ? 'INVALID' : 'MISSING',
        reason: clash ? 'There’s already an SPF record here. Add include:_spf.mx.cloudflare.net to it instead of a second one.' : null
      })
    }
    const missing = records.filter((r) => r.status !== 'VALID').length
    if (missing) problems.push(`${missing} DNS record${missing === 1 ? ' isn’t' : 's aren’t'} in place yet.`)
    return { domain_id: config.domain, domain: config.domain, status: problems.length ? 'PENDING' : 'VERIFIED', records, reason: problems.join(' ') || null }
  }

  /** Not used: the domain is created by `setUp`. */
  async createDomain(): Promise<AgentMailDomain> {
    throw new CloudflareError('Set up the domain from Settings → Email → Cloudflare.', 400)
  }

  /** "Check again": runs the setup once more, which fixes whatever is missing. */
  async verifyDomain(): Promise<void> {
    await this.setUp(this.requireConfig())
  }

  /** Eaon stops using the domain: its routing rules go. DNS records, the Worker and stored mail stay. */
  async deleteDomain(): Promise<void> {
    const config = this.requireConfig()
    for (const entry of [...config.addresses]) await this.deleteInbox(entry.address)
  }

  // — Pieces ————————————————————————————————————————————————————

  private requireConfig(): CloudflareMailConfig {
    const config = this.getConfig()
    if (!config) throw new CloudflareError('Your domain isn’t set up on Cloudflare yet. Set it up in Settings → Email.', 400)
    return config
  }

  private async findNamespace(accountId: string, match: (n: { id: string; title: string }) => boolean): Promise<{ id: string; title: string } | null> {
    for (let page = 1; page <= 10; page++) {
      const { result, info } = await this.api<{ id: string; title: string }[]>('GET', `/accounts/${seg(accountId)}/storage/kv/namespaces`, { query: { per_page: 100, page } })
      const found = (result ?? []).find(match)
      if (found) return found
      if (!info?.total_pages || page >= info.total_pages) return null
    }
    return null
  }

  /** Mail for the domain reaches Cloudflare: its MX records point at Email Routing. */
  private async receives(config: CloudflareMailConfig): Promise<boolean> {
    const mx = await this.findRecords(config.zoneId, 'MX', config.domain)
    return mx.some((r) => /\.mx\.cloudflare\.net\.?$/i.test(r.content))
  }

  /** The MX and SPF records Email Routing lists for the zone. */
  private async routingRecords(config: CloudflareMailConfig): Promise<DnsRecord[]> {
    const { result } = await this.api<DnsRecord[]>('GET', `/zones/${seg(config.zoneId)}/email/routing/dns`)
    return (result ?? [])
      .filter((r) => r && (String(r.type).toUpperCase() === 'MX' || (String(r.type).toUpperCase() === 'TXT' && isSpf(String(r.content)))))
      .map((r) => ({ type: String(r.type).toUpperCase(), name: config.zoneName, content: String(r.content), priority: r.priority }))
  }

  /** The records Email Sending wants, added where missing; never a second SPF or DMARC record beside the user's own. */
  private async addSendingRecords(config: CloudflareMailConfig): Promise<void> {
    for (const record of await this.sendingRecords(config)) {
      const present = await this.findRecords(config.zoneId, record.type, record.name)
      if (present.some((r) => sameRecord(r, record))) continue
      if (present.some((r) => r.type === 'TXT' && conflicting(r.content, record.content))) continue
      await this.createRecord(config.zoneId, record)
    }
  }

  /** Turns on the Worker's workers.dev address and returns it: https://<worker>.<account subdomain>.workers.dev. */
  private async openWorkerUrl(config: CloudflareMailConfig): Promise<string | null> {
    const { result } = await this.api<{ subdomain?: string }>('GET', `/accounts/${seg(config.accountId)}/workers/subdomain`)
    if (!result?.subdomain) return null
    await this.api('POST', `/accounts/${seg(config.accountId)}/workers/scripts/${seg(config.workerName)}/subdomain`, { body: { enabled: true, previews_enabled: false } })
    return this.workerOrigin ? `${this.workerOrigin}/${config.workerName}` : `https://${config.workerName}.${result.subdomain}.workers.dev`
  }

  /** What only Eaon and the Worker know: derived from the token, so it needs no storage of its own. */
  private workerSecret(): string {
    return createHmac('sha256', this.token ?? '').update('eaon-mail-send').digest('hex')
  }

  private async createRecord(zoneId: string, record: DnsRecord): Promise<void> {
    await this.api('POST', `/zones/${seg(zoneId)}/dns_records`, {
      body: { type: record.type, name: record.name, content: record.content, ttl: 1, ...(record.type === 'MX' ? { priority: record.priority ?? 10 } : {}), comment: 'Eaon email' }
    })
  }

  private async routingSettings(zoneId: string): Promise<{ enabled?: boolean; status?: string; name?: string }> {
    return (await this.api<{ enabled?: boolean; status?: string; name?: string }>('GET', `/zones/${seg(zoneId)}/email/routing`)).result ?? {}
  }

  /**
   * Turning on Email Routing replaces the domain's MX records. If they point
   * at another mail service, the user's existing email would stop arriving.
   */
  private async refuseForeignMx(config: CloudflareMailConfig): Promise<void> {
    const mx = await this.findRecords(config.zoneId, 'MX', config.domain)
    const foreign = mx.filter((r) => !/\.mx\.cloudflare\.net\.?$/i.test(r.content))
    if (foreign.length === 0) return
    const hosts = [...new Set(foreign.map((r) => r.content.replace(/\.$/, '')))].slice(0, 2).join(', ')
    const example = config.domain === config.zoneName ? `agents.${config.zoneName}` : `agents.${config.domain}`
    throw new CloudflareError(
      `${config.domain} already receives email through ${hosts}, and turning on Email Routing would take that over. Use a subdomain for Eaon instead, like ${example}.`,
      409,
      'existing_mail'
    )
  }

  private async findSendingDomain(zoneId: string, domain: string): Promise<{ tag?: string; name?: string; enabled?: boolean } | null> {
    const { result } = await this.api<{ tag?: string; name?: string; enabled?: boolean }[]>('GET', `/zones/${seg(zoneId)}/email/sending/subdomains`)
    return (result ?? []).find((s) => s.name?.toLowerCase() === domain) ?? null
  }

  /** The records Email Sending wants for the domain, as Cloudflare lists them. */
  private async sendingRecords(config: CloudflareMailConfig): Promise<DnsRecord[]> {
    // No sending domain yet (or Email Sending not on for the account): no records to want.
    const tag = config.sendingTag ?? (await this.findSendingDomain(config.zoneId, config.domain).catch(() => null))?.tag
    if (!tag) return []
    const { result } = await this.api<DnsRecord[]>('GET', `/zones/${seg(config.zoneId)}/email/sending/subdomains/${seg(tag)}/dns`)
    return (result ?? [])
      .filter((r) => r && ['MX', 'TXT', 'CNAME'].includes(String(r.type).toUpperCase()))
      .map((r) => ({ type: String(r.type).toUpperCase(), name: absoluteName(String(r.name), config.zoneName), content: String(r.content), priority: r.priority }))
  }

  private async findRecords(zoneId: string, type: string, name: string): Promise<DnsRecord[]> {
    const { result } = await this.api<DnsRecord[]>('GET', `/zones/${seg(zoneId)}/dns_records`, { query: { type, name, per_page: 100 } })
    return result ?? []
  }

  private async findRule(zoneId: string, address: string): Promise<RoutingRule | null> {
    for (let page = 1; page <= 10; page++) {
      const { result, info } = await this.api<RoutingRule[]>('GET', `/zones/${seg(zoneId)}/email/routing/rules`, { query: { per_page: 50, page } })
      const found = (result ?? []).find((rule) => rule.matchers?.some((m) => m.type === 'literal' && m.field === 'to' && m.value?.toLowerCase() === address))
      if (found) return found
      if (!info?.total_pages || page >= info.total_pages) return null
    }
    return null
  }

  /** The rule sending `address` to the Worker; made, or pointed at the Worker, when it isn't. */
  private async ensureRule(config: CloudflareMailConfig, address: string): Promise<string> {
    return step(`route ${address} to Eaon`, 'Email Routing Rules: Edit', async () => {
      const body = {
        name: `Eaon: ${address}`,
        enabled: true,
        matchers: [{ type: 'literal', field: 'to', value: address }],
        actions: [{ type: 'worker', value: [config.workerName] }]
      }
      const existing = await this.findRule(config.zoneId, address)
      const id = existing?.id ?? existing?.tag
      if (id) {
        const right = existing?.actions?.some((a) => a.type === 'worker' && a.value?.includes(config.workerName))
        if (!right) await this.api('PUT', `/zones/${seg(config.zoneId)}/email/routing/rules/${seg(id)}`, { body })
        return id
      }
      const { result } = await this.api<RoutingRule>('POST', `/zones/${seg(config.zoneId)}/email/routing/rules`, { body })
      return result.id ?? result.tag ?? ''
    })
  }

  private async listKeys(config: CloudflareMailConfig): Promise<KvKey[]> {
    if (!config.namespaceId) return []
    const keys: KvKey[] = []
    let cursor: string | undefined
    while (keys.length < SCAN_LIMIT) {
      const { result, info } = await this.api<KvKey[]>('GET', `/accounts/${seg(config.accountId)}/storage/kv/namespaces/${seg(config.namespaceId)}/keys`, {
        query: { prefix: KEY_PREFIX, limit: 1000, cursor }
      })
      keys.push(...(result ?? []))
      cursor = info?.cursor || undefined
      if (!cursor || !(result ?? []).length) break
    }
    return keys.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
  }

  private async findKey(config: CloudflareMailConfig, messageId: string): Promise<KvKey | null> {
    if (!messageId.startsWith(KEY_PREFIX)) throw new CloudflareError('That isn’t a message id from this inbox.', 404)
    const { result } = await this.api<KvKey[]>('GET', `/accounts/${seg(config.accountId)}/storage/kv/namespaces/${seg(config.namespaceId ?? '')}/keys`, {
      query: { prefix: messageId, limit: 10 }
    })
    return (result ?? []).find((k) => k.name === messageId) ?? null
  }

  /** The message parsed: fetched once, then from the cache. */
  private async summary(config: CloudflareMailConfig, key: string): Promise<ParsedSummary> {
    const hit = cached(config, key)
    if (hit) return hit
    if (!config.namespaceId) throw new CloudflareError('Eaon’s mail storage isn’t set up yet.', 404)
    const raw = await this.bytes(`/accounts/${seg(config.accountId)}/storage/kv/namespaces/${seg(config.namespaceId)}/values/${seg(key)}`)
    const parsed = await summarize(raw)
    parsedCache.set(`${config.namespaceId}/${key}`, parsed)
    if (parsedCache.size > CACHE_CAP) parsedCache.delete(parsedCache.keys().next().value as string)
    return parsed
  }

  private async deliver(
    config: CloudflareMailConfig,
    sender: CloudflareAddress,
    message: { to: string[]; cc: string[]; subject: string; text: string; headers?: Record<string, string> }
  ): Promise<void> {
    // Email Sending turned on since the last look? Then use it.
    if (!config.sendingTag) await this.tryEnableSending().catch(() => false)
    if (!config.sendingTag) {
      if (config.workerUrl) return this.deliverThroughWorker(config, sender, message)
      throw new CloudflareError(SENDING_OFF(config.domain), 403, 'sending_off')
    }
    const body = {
      from: sender.displayName ? { address: sender.address, name: sender.displayName } : sender.address,
      to: message.to,
      ...(message.cc.length ? { cc: message.cc } : {}),
      subject: message.subject,
      text: message.text,
      ...(message.headers && Object.keys(message.headers).length ? { headers: message.headers } : {})
    }
    let result: { delivered?: string[]; queued?: string[]; permanent_bounces?: string[] } | undefined
    try {
      result = (await this.api<typeof result>('POST', `/accounts/${seg(config.accountId)}/email/sending/send`, { body })).result
    } catch (error) {
      if (!(error instanceof AgentMailError) || error.keyRefused) throw error
      const hint =
        isDenied(error) || /plan|entitle|verified|destination|not allowed|subscription/i.test(error.message)
          ? ' Sending to people outside your Cloudflare account needs the Workers Paid plan ($5 a month, 3,000 emails included), and the token needs the Email Sending: Edit permission.'
          : ''
      throw new CloudflareError(`Cloudflare didn’t send it: ${error.message.replace(/\.$/, '')}.${hint}`, error.status, error.code)
    }
    const bounced = result?.permanent_bounces ?? []
    if (bounced.length && !(result?.delivered?.length || result?.queued?.length)) {
      throw new CloudflareError(`Cloudflare couldn’t deliver to ${bounced.join(', ')}: the address bounced before.`, 422, 'bounced')
    }
  }

  /**
   * The free route: the Worker's send_email binding, which reaches only the
   * account's verified destination addresses. Known-unverified recipients are
   * refused before anything is sent. A response that isn't the Worker's own
   * (workers.dev still coming up, or the old Worker) is retried, then explained.
   */
  private async deliverThroughWorker(
    config: CloudflareMailConfig,
    sender: CloudflareAddress,
    message: { to: string[]; cc: string[]; subject: string; text: string; headers?: Record<string, string> }
  ): Promise<void> {
    const recipients = [...message.to, ...message.cc].map(bareAddress)
    const verified = await this.verifiedAddresses()
    const unverified = verified ? recipients.filter((r) => !verified.includes(r)) : []
    if (unverified.length) throw new CloudflareError(notVerified(unverified, config.domain), 403, 'not_verified')
    const body = {
      from: sender.displayName ? { email: sender.address, name: sender.displayName } : sender.address,
      to: message.to,
      cc: message.cc,
      subject: message.subject,
      text: message.text,
      headers: message.headers ?? {}
    }
    type WorkerReply = { ok?: unknown; code?: unknown; message?: unknown }
    for (let attempt = 1; ; attempt++) {
      let data: WorkerReply | null = null
      try {
        const response = await fetch(`${config.workerUrl}/send`, {
          method: 'POST',
          headers: { authorization: `Bearer ${this.workerSecret()}`, 'content-type': 'application/json' },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(this.timeoutMs)
        })
        data = (await response.json().catch(() => null)) as WorkerReply | null
      } catch {
        data = null
      }
      if (data && typeof data.ok === 'boolean') {
        if (data.ok) return
        const said = `${String(data.code ?? '')} ${String(data.message ?? '')}`
        if (/verif|not allowed|RECIPIENT|destination/i.test(said)) throw new CloudflareError(notVerified(recipients, config.domain), 403, 'not_verified')
        throw new CloudflareError(`Cloudflare didn’t send it: ${String(data.message ?? data.code ?? 'unknown error').replace(/\.$/, '')}.`, 502, String(data.code ?? '') || null)
      }
      if (attempt >= 3) {
        throw new CloudflareError('Eaon’s mail Worker isn’t answering for sending yet. Press Check again in Settings → Email to update it.', 503, 'worker_unavailable')
      }
      await sleep(this.retryDelayMs * 2)
    }
  }

  /** A copy of what was sent, in the same store, so the agent sees its side of the conversation. */
  private async storeSent(config: CloudflareMailConfig, sender: CloudflareAddress, to: string[], cc: string[], subject: string, text: string, thread: string | null): Promise<string | null> {
    if (!config.namespaceId) return null
    const now = Date.now()
    const key = `${KEY_PREFIX}${String(CLOCK_CEILING - now).padStart(13, '0')}-${Math.random().toString(16).slice(2, 10)}`
    const from = sender.displayName ? `${encodeWord(sender.displayName)} <${sender.address}>` : sender.address
    const raw = [
      `From: ${from}`,
      `To: ${to.join(', ')}`,
      ...(cc.length ? [`Cc: ${cc.join(', ')}`] : []),
      `Subject: ${encodeWord(subject)}`,
      `Date: ${new Date(now).toUTCString()}`,
      'MIME-Version: 1.0',
      'Content-Type: text/plain; charset=utf-8',
      'Content-Transfer-Encoding: 8bit',
      '',
      text
    ].join('\r\n')
    const metadata = {
      d: 'out',
      f: sender.address,
      t: to.join(', ').slice(0, 160),
      s: subject.slice(0, 200),
      at: now,
      p: text.replace(/\s+/g, ' ').trim().slice(0, 120),
      ...(thread ? { th: thread.slice(0, 40) } : {})
    }
    const form = new FormData()
    form.set('value', new Blob([raw], { type: 'message/rfc822' }))
    form.set('metadata', JSON.stringify(metadata))
    await this.api('PUT', `/accounts/${seg(config.accountId)}/storage/kv/namespaces/${seg(config.namespaceId)}/values/${seg(key)}`, { form })
    return key
  }

  // — Transport —————————————————————————————————————————————————

  private async api<T>(
    method: string,
    path: string,
    options: { body?: unknown; form?: FormData; query?: Record<string, string | number | undefined> } = {}
  ): Promise<{ result: T; info: Envelope<T>['result_info'] }> {
    const response = await this.fetchWithRetry(method, path, options)
    const raw = await response.text().catch(() => '')
    let data: Envelope<T> | null = null
    try {
      data = raw ? (JSON.parse(raw) as Envelope<T>) : null
    } catch {
      data = null
    }
    if (!response.ok || data?.success === false) throw cloudflareError(response.status, data, Boolean(this.globalKeyEmail))
    return { result: (data?.result ?? null) as T, info: data?.result_info }
  }

  private async bytes(path: string): Promise<Uint8Array> {
    const response = await this.fetchWithRetry('GET', path, {})
    if (!response.ok) {
      const raw = await response.text().catch(() => '')
      let data: Envelope<unknown> | null = null
      try {
        data = raw ? (JSON.parse(raw) as Envelope<unknown>) : null
      } catch {
        data = null
      }
      throw cloudflareError(response.status, data, Boolean(this.globalKeyEmail))
    }
    return new Uint8Array(await response.arrayBuffer())
  }

  /** Reads are retried once after a dropped connection or a hiccup on Cloudflare's side; writes never are. */
  private async fetchWithRetry(method: string, path: string, options: { body?: unknown; form?: FormData; query?: Record<string, string | number | undefined> }): Promise<Response> {
    if (!this.token) throw new CloudflareError('Paste a Cloudflare API token first.', 401, 'unauthorized')
    const url = new URL(`${this.baseUrl}${path}`)
    for (const [name, value] of Object.entries(options.query ?? {})) if (value !== undefined) url.searchParams.set(name, String(value))
    const headers: Record<string, string> = this.globalKeyEmail
      ? { 'x-auth-email': this.globalKeyEmail, 'x-auth-key': this.token, accept: 'application/json' }
      : { authorization: `Bearer ${this.token}`, accept: 'application/json' }
    let body: RequestInit['body']
    if (options.form) body = options.form
    else if (options.body !== undefined) {
      headers['content-type'] = 'application/json'
      body = JSON.stringify(options.body)
    }
    for (let attempt = 1; ; attempt++) {
      let response: Response
      try {
        response = await fetch(url, { method, headers, body, signal: AbortSignal.timeout(this.timeoutMs) })
      } catch (error) {
        const reason = error instanceof Error && error.name === 'TimeoutError' ? 'it took too long to answer' : error instanceof Error ? (error.cause instanceof Error ? error.cause.message : error.message) : String(error)
        if (method === 'GET' && attempt < 2) {
          await sleep(this.retryDelayMs)
          continue
        }
        throw new CloudflareError(`Couldn’t reach Cloudflare (${reason}). Check your internet connection and try again.`, 0)
      }
      if (method === 'GET' && attempt < 2 && (response.status === 429 || response.status >= 500)) {
        await sleep(this.retryDelayMs)
        continue
      }
      return response
    }
  }
}

// — Helpers ———————————————————————————————————————————————————————

/**
 * Cloudflare's answer as a sentence, and a code the service understands: a
 * credential that is wrong altogether reads as `unauthorized`, and says why.
 */
function cloudflareError(status: number, data: Envelope<unknown> | null, globalKey = false): AgentMailError {
  const first = data?.errors?.find((e) => e && (e.message || e.code)) ?? null
  const code = typeof first?.code === 'number' ? first.code : null
  const text = first?.message?.trim() || (status === 404 ? 'Not found' : `Cloudflare answered ${status}`)
  let refused: string | null = null
  if (globalKey && (status === 401 || (code !== null && (GLOBAL_KEY_CODES.has(code) || FORMAT_CODES.has(code))))) {
    refused = 'Cloudflare didn’t accept that Global API Key with that email. Use the email you sign in to Cloudflare with, and copy the key again from My Profile → API Tokens → Global API Key → View.'
  } else if (!globalKey && code !== null && FORMAT_CODES.has(code)) {
    refused = 'Cloudflare says that isn’t an API token. Paste the token itself — it starts with cfut_ or cfat_ (older ones are 40 letters and numbers) — not the Global API Key, a token’s name or an ID.'
  } else if (!globalKey && (code === 1000 || (code === 9109 && /invalid/i.test(text)) || (status === 401 && code === null))) {
    // Not every 401: Email Sending answers 401 "Unauthorized" (2036) to a good token without its permission.
    refused =
      'Cloudflare doesn’t recognise this token: it may have been deleted, rolled or expired, or part of it was lost when copying. Make a new one — Cloudflare shows a token only once, right after it’s created.'
  }
  if (refused) return new CloudflareError(refused, status, 'unauthorized')
  return new CloudflareError(text.replace(/\.$/, '') + '.', status, code !== null ? String(code) : null)
}

/**
 * Runs one setup step. A refusal for want of a permission names the missing
 * permission, which is the one thing the user has to change.
 */
/**
 * What to do when Cloudflare refuses Email Sending. Until the account has it
 * (Email Service → Email Sending, on the Workers Paid plan), the token
 * permission only offers Read and the API answers 401 "Unauthorized".
 */
/** The free route's refusal: who isn't verified, and the two ways out. */
export const notVerified = (addresses: string[], domain: string): string =>
  `Without Cloudflare Email Sending, ${domain} can only email addresses verified in your Cloudflare account, and ${addresses.join(', ')} ${addresses.length === 1 ? 'isn’t' : 'aren’t'}. Verify ${addresses.length === 1 ? 'it' : 'them'} in Settings → Email (Cloudflare emails a link to click), or turn on Email Sending to email anyone.`

export const SENDING_OFF = (domain: string): string =>
  `Receiving works; sending isn’t on yet. Email Sending isn’t turned on for this Cloudflare account: in the Cloudflare dashboard open Email Service → Email Sending and onboard ${domain} (it needs the Workers Paid plan, $5 a month). Then edit the token to give it Email Sending: Edit — Cloudflare only offers Read until sending is on — and press Check again.`

/** Refused for want of a permission (403 "Authentication error", 9109 "Unauthorized to access…", or Email Sending's 401 "Unauthorized"). */
function isDenied(error: AgentMailError): boolean {
  if (error.keyRefused) return false
  return error.status === 401 || error.status === 403 || error.code === '10000' || /unauthori[sz]ed|authenticat|permission|forbidden/i.test(error.message)
}

async function step<T>(what: string, permission: string, run: () => Promise<T>): Promise<T> {
  try {
    return await run()
  } catch (error) {
    if (!(error instanceof AgentMailError) || error.keyRefused || error.code === 'existing_mail' || error.code === 'missing_permissions') throw error
    const denied = isDenied(error)
    throw new CloudflareError(
      denied
        ? `Eaon couldn’t ${what}: the Cloudflare token needs the “${permission}” permission. Add it to the token, or make a new one, and try again.`
        : `Eaon couldn’t ${what}. ${error.message}`,
      error.status,
      error.code
    )
  }
}

function toInbox(entry: CloudflareAddress): AgentMailInbox {
  return { inbox_id: entry.address, email: entry.address, display_name: entry.displayName }
}

function cached(config: CloudflareMailConfig, key: string): ParsedSummary | null {
  return parsedCache.get(`${config.namespaceId}/${key}`) ?? null
}

/** A stored message as the list item EmailService expects. The parsed message, when at hand, beats the Worker's truncated metadata. */
function toItem(inboxId: string, key: KvKey, parsed: ParsedSummary | null): AgentMailMessageItem {
  const m = key.metadata ?? {}
  const sent = m.d === 'out'
  return {
    inbox_id: inboxId,
    thread_id: m.th || key.name,
    message_id: key.name,
    labels: [sent ? 'sent' : 'received'],
    timestamp: new Date(m.at ?? atFromKey(key.name)).toISOString(),
    from: parsed?.from || decode(m.f ?? ''),
    to: parsed?.to.length ? parsed.to : decode(m.t ?? '').split(/,\s*/).filter(Boolean),
    cc: parsed?.cc ?? [],
    subject: parsed?.subject ?? decode(m.s ?? ''),
    preview: parsed?.preview ?? m.p ?? '',
    attachments: parsed?.attachments ?? []
  }
}

function atFromKey(name: string): number {
  const inverted = Number(/^m\/(\d{13})-/.exec(name)?.[1])
  return Number.isFinite(inverted) ? CLOCK_CEILING - inverted : 0
}

function decode(text: string): string {
  try {
    return decodeWords(text)
  } catch {
    return text
  }
}

type ParsedAddress = { name?: string; address?: string; group?: ParsedAddress[] }

function formatAddresses(list: ParsedAddress[] | ParsedAddress | undefined): string[] {
  const items = Array.isArray(list) ? list : list ? [list] : []
  return items.flatMap((a) => (a.group ? formatAddresses(a.group) : a.address ? [a.name ? `${a.name} <${a.address}>` : a.address] : []))
}

export async function summarize(raw: Uint8Array | string): Promise<ParsedSummary> {
  const email = await PostalMime.parse(raw)
  const text = messageText({ text: email.text, html: email.html })
  return {
    from: formatAddresses(email.from as ParsedAddress | undefined)[0] ?? '',
    to: formatAddresses(email.to as ParsedAddress[] | undefined),
    cc: formatAddresses(email.cc as ParsedAddress[] | undefined),
    replyTo: formatAddresses(email.replyTo as ParsedAddress[] | undefined),
    subject: email.subject ?? '',
    preview: text.replace(/\s+/g, ' ').trim().slice(0, 240),
    text,
    messageId: email.messageId ?? null,
    references: email.references ?? null,
    attachments: email.attachments.map((a, i) => ({
      attachment_id: String(i),
      filename: a.filename ?? null,
      size: typeof a.content === 'string' ? a.content.length : (a.content as ArrayBuffer).byteLength,
      content_type: a.mimeType ?? null
    }))
  }
}

function bareAddress(entry: string): string {
  const match = /<([^<>]+)>\s*$/.exec(entry)
  return (match ? match[1] : entry).trim().toLowerCase()
}

function unique(list: string[]): string[] {
  return [...new Set(list)]
}

/** RFC 2047 for a header that isn't plain ASCII. */
function encodeWord(text: string): string {
  return /^[\x20-\x7e]*$/.test(text) ? text : `=?UTF-8?B?${Buffer.from(text, 'utf8').toString('base64')}?=`
}

/** Cloudflare lists names relative to the zone ("cf-bounce") or whole; the DNS API wants them whole. */
function absoluteName(name: string, zone: string): string {
  const clean = name.replace(/\.$/, '').toLowerCase()
  if (clean === '@' || clean === '') return zone
  return clean === zone || clean.endsWith(`.${zone}`) ? clean : `${clean}.${zone}`
}

const unquote = (value: string): string => value.replace(/^"|"$/g, '').replace(/"\s*"/g, '').trim()
const isSpf = (value: string): boolean => /^v=spf1\b/i.test(unquote(value))
const isDmarc = (value: string): boolean => /^v=DMARC1\b/i.test(unquote(value))

function sameRecord(present: DnsRecord, wanted: DnsRecord): boolean {
  if (present.type.toUpperCase() !== wanted.type) return false
  const a = unquote(present.content).replace(/\.$/, '').toLowerCase()
  const b = unquote(wanted.content).replace(/\.$/, '').toLowerCase()
  return a === b
}

/** A second SPF (or DMARC) record at the same name would break the first. */
function conflicting(present: string, wanted: string): boolean {
  return (isSpf(present) && isSpf(wanted)) || (isDmarc(present) && isDmarc(wanted))
}
