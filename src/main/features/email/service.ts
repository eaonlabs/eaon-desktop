import { randomUUID } from 'node:crypto'
import {
  DEFAULT_EMAILS_PER_DAY,
  DEFAULT_EMAIL_CHECK_MINUTES,
  type EmailDomain,
  type EmailDomainRecord,
  type EmailInbox,
  type EmailMessage,
  type EmailOptions,
  type EmailOutgoing,
  type EmailProvider,
  type EmailSignUp,
  type EmailState,
  type EmailStatus,
  type CloudflareSetup,
  type CloudflareZoneChoice,
  cleanCloudflareKey,
  cloudflareKeyKind
} from '@shared/email'
import { AgentMailError, type AgentMailClient, type AgentMailDomain, type AgentMailInbox, type AgentMailMessageItem } from './agentmail'
import { MAIL_WORKER_NAME, MAIL_WORKER_VERSION, type CloudflareMailClient, type CloudflareMailConfig } from './cloudflare'

/**
 * The agent's own email: one inbox the agent reads and sends from, at
 * AgentMail or on the user's own domain through their Cloudflare account
 * (`provider`). Both backends have the same shape (`MailClient`), so the cap,
 * notifications and tools below don't care which it is. A worker can have an
 * address of its own on the same domain (`workerInboxes`); its tools use it.
 *
 * Everything outside is injected — the AgentMail client, the secrets vault,
 * the state file, the clock, desktop notifications — so `test/email.test.ts`
 * drives the real thing against a fake AgentMail server.
 *
 * What lives where:
 * - The API key is in the secrets vault and in memory, never in `email.json`
 *   and never in `EmailState`.
 * - `email.json` holds the rest that must survive a restart: which inbox,
 *   whether the code was entered, domains, options, today's send count, and
 *   which messages have already been seen (so a restart doesn't announce old
 *   mail again). Mail itself is not written to disk; it is fetched again.
 */

/** How many messages `recent` holds, newest first. */
const RECENT = 30
/** How far back the unread count looks. */
const UNREAD_SCAN = 100
const SEEN_CAP = 300
const READ_CAP = 500
/** More new messages than this at once make one summary notification. */
const MAX_NOTICES = 3
const MAX_RECIPIENTS = 50
const MAX_PER_DAY_LIMIT = 1000
const MAX_CHECK_MINUTES = 24 * 60

/** What the service needs from a mail backend: AgentMail's client, or Cloudflare's in the same shape. */
export type MailClient = Pick<
  AgentMailClient,
  | 'listInboxes'
  | 'getInbox'
  | 'createInbox'
  | 'updateInbox'
  | 'listMessages'
  | 'getMessage'
  | 'updateMessage'
  | 'send'
  | 'reply'
  | 'listDomains'
  | 'getDomain'
  | 'createDomain'
  | 'verifyDomain'
  | 'deleteDomain'
>

export interface EmailNotice {
  title: string
  body: string
  /** The message it is about; null for a summary of several. */
  messageId: string | null
}

export interface SavedEmail {
  version: 1
  /** Which backend `inbox` lives on. Its key is in the vault under the provider's own name. */
  provider: EmailProvider
  /** The setup on the user's Cloudflare account, when `provider` is cloudflare. */
  cloudflare: CloudflareMailConfig | null
  /** Workers with an address of their own, by worker id. */
  workerInboxes: Record<string, EmailInbox>
  inbox: EmailInbox | null
  inboxes: EmailInbox[]
  humanEmail: string | null
  /** The code AgentMail emailed was entered (or the key came from an existing account). */
  verified: boolean
  domains: EmailDomain[]
  maxPerDay: number
  checkEveryMinutes: number
  notifyNew: boolean
  /** Sends on one local day ("2026-09-30"). */
  sent: { day: string; count: number }
  /** Message ids already looked at, oldest first, so each new one is announced once. */
  seen: string[]
  /** False until the first look at this inbox, which records what is there without announcing it. */
  seeded: boolean
  /**
   * Messages read in Eaon that AgentMail couldn't be told about (or that
   * carry no read label at all). Normally the `unread` label is the record.
   */
  read: string[]
  lastCheckedAt: number | null
}

export interface EmailServiceDeps {
  /** A client for the key, or for no key (sign-up is the one call that needs none). */
  createClient: (key: string | null) => AgentMailClient
  getKey: () => string | null | undefined
  /** Null forgets it. May throw: the vault refuses writes while the keychain is locked. */
  setKey: (key: string | null) => void
  load: () => unknown
  save: (saved: SavedEmail) => void
  now?: () => number
  notify?: (notice: EmailNotice) => void
  onChange?: (state: EmailState) => void
  /** Idempotency keys for sends. */
  newId?: () => string
  /** Length of a minute for the background check; tests shorten it. */
  minuteMs?: number
  /**
   * A Cloudflare client for a token and the saved setup — or, with
   * `globalKeyEmail`, for a Global API Key (used only to make a token).
   * Without it, Cloudflare isn't offered.
   */
  createCloudflare?: (
    token: string | null,
    getConfig: () => CloudflareMailConfig | null,
    saveConfig: (config: CloudflareMailConfig) => void,
    auth?: { globalKeyEmail?: string }
  ) => CloudflareMailClient
  /** Pause while a token Eaon just made becomes usable; tests skip it. */
  tokenSettleMs?: number
  getCloudflareToken?: () => string | null | undefined
  /** Null forgets it. May throw, like setKey. */
  setCloudflareToken?: (token: string | null) => void
}

interface Problem {
  message: string
  /** AgentMail refuses the key or can't be reached: status becomes 'error'. */
  blocking: boolean
  /** Survives a successful check (a key that couldn't be saved stays a problem until it is). */
  keep?: boolean
}

export class EmailService {
  private saved: SavedEmail = blank()
  private key: string | null = null
  private recent: EmailMessage[] = []
  private unreadIds = new Set<string>()
  private readSet = new Set<string>()
  private problem: Problem | null = null
  /**
   * Bumped whenever the account or inbox changes. A check that started
   * before then drops its results instead of mixing the old inbox's mail
   * into the new one's.
   */
  private generation = 0
  private refreshing: Promise<void> | null = null
  /** Cloudflare: destination addresses verified in the account (who the free route reaches); null when unknown. */
  private verified: string[] | null = null
  private timer: ReturnType<typeof setTimeout> | null = null
  private started = false
  private readonly now: () => number
  private readonly minuteMs: number
  private readonly newId: () => string

  constructor(private readonly deps: EmailServiceDeps) {
    this.now = deps.now ?? Date.now
    this.minuteMs = deps.minuteMs ?? 60_000
    this.newId = deps.newId ?? randomUUID
  }

  load(): void {
    this.saved = sanitize(this.deps.load())
    this.readSet = new Set(this.saved.read)
    // A missing key reads as "off" without wiping the rest: a locked
    // keychain hides the key for a while, and the inbox is still there after.
    this.key = (this.saved.provider === 'cloudflare' ? this.deps.getCloudflareToken?.() : this.deps.getKey()) || null
  }

  // — State —————————————————————————————————————————————————————

  status(): EmailStatus {
    if (!this.key) return 'off'
    if (this.problem?.blocking) return 'error'
    return this.saved.verified ? 'ready' : 'verifying'
  }

  state(): EmailState {
    const s = this.saved
    const on = Boolean(this.key)
    const workerIds = new Set(Object.values(s.workerInboxes).map((i) => i.id))
    return {
      status: this.status(),
      provider: s.provider,
      cloudflare:
        on && s.provider === 'cloudflare' && s.cloudflare
          ? {
              zoneName: s.cloudflare.zoneName,
              domain: s.cloudflare.domain,
              canSend: Boolean(s.cloudflare.sendingTag),
              sendsTo: s.cloudflare.sendingTag ? 'anyone' : s.cloudflare.workerUrl ? 'verified' : 'nobody',
              verified: this.verified ? [...this.verified] : null,
              returnsToAgentMail: Boolean(this.deps.getKey())
            }
          : null,
      workerAddresses: on ? Object.entries(s.workerInboxes).map(([workerId, inbox]) => ({ workerId, inbox })) : [],
      inbox: on ? s.inbox : null,
      inboxes: on ? s.inboxes.filter((i) => !workerIds.has(i.id)) : [],
      humanEmail: on ? s.humanEmail : null,
      domains: on ? [...s.domains] : [],
      recent: on ? [...this.recent] : [],
      unread: on ? this.unreadIds.size : 0,
      sentToday: this.sentToday(),
      maxPerDay: s.maxPerDay,
      checkEveryMinutes: s.checkEveryMinutes,
      notifyNew: s.notifyNew,
      lastCheckedAt: on ? s.lastCheckedAt : null,
      error: on ? (this.problem?.message ?? null) : null
    }
  }

  /** A message from the last look, for one-line descriptions; no request. */
  peek(messageId: string): EmailMessage | null {
    return this.recent.find((m) => m.id === messageId) ?? null
  }

  // — Setting up ————————————————————————————————————————————————

  /**
   * A new AgentMail account and inbox. AgentMail emails a six-digit code to
   * the user; until it is entered (`verify`) the inbox receives but can't
   * send. Signing up again before that is allowed (a typo in the username);
   * AgentMail treats the same address as the same sign-up.
   */
  async signUp(input: EmailSignUp): Promise<EmailState> {
    if (this.key && (this.saved.verified || this.saved.provider !== 'agentmail')) throw new Error('Email is already set up. Disconnect it first to make a new account.')
    const username = normalizeUsername(input?.username)
    const humanEmail = normalizeEmail(input?.humanEmail, 'Enter your own email address — AgentMail sends the code there.')
    const displayName = typeof input?.displayName === 'string' && input.displayName.trim() ? input.displayName.trim() : null

    const created = await this.deps.createClient(null).signUp({ username, human_email: humanEmail })
    const client = this.deps.createClient(created.api_key)
    let inbox: EmailInbox
    try {
      inbox = toInbox(await client.getInbox(created.inbox_id))
    } catch {
      // The key is limited until verified; the id is the address anyway.
      inbox = { id: created.inbox_id, address: created.inbox_id.includes('@') ? created.inbox_id : `${username}@agentmail.to`, displayName: null }
    }
    if (displayName && displayName !== inbox.displayName) {
      try {
        inbox = toInbox(await client.updateInbox(inbox.id, { display_name: displayName }))
      } catch {
        /* the name is a nicety; the inbox works without it */
      }
    }

    this.resetAccount()
    this.saved.provider = 'agentmail'
    this.storeKey(created.api_key)
    Object.assign(this.saved, { inbox, inboxes: [inbox], humanEmail, verified: false })
    // Brand new and empty: anything that arrives from now on is news.
    this.saved.seeded = true
    this.persist()
    this.schedule()
    this.emit()
    return this.state()
  }

  /** The six-digit code AgentMail emailed the user. Lifts the limits on sending. */
  async verify(code: string): Promise<EmailState> {
    this.requireKey()
    if (this.saved.verified) return this.state()
    const otp = String(code ?? '').replace(/[\s-]/g, '')
    if (!/^\d{6}$/.test(otp)) throw new Error('Enter the six-digit code from AgentMail’s email.')
    let result: { verified: boolean }
    try {
      result = await this.callAgentMail((client) => client.verify(otp))
    } catch (error) {
      if (error instanceof AgentMailError && !error.keyRefused && !error.transient) throw new Error(`That code didn’t work. ${error.message}`)
      throw error
    }
    if (!result.verified) {
      throw new Error(`That code didn’t work. Check the newest email from AgentMail${this.saved.humanEmail ? ` at ${this.saved.humanEmail}` : ''} and try again.`)
    }
    this.saved.verified = true
    this.persist()
    this.emit()
    return this.refresh()
  }

  /** Sends the code again, or a new one once the old expired (24 hours). The key stays the same. */
  async resendCode(): Promise<EmailState> {
    this.requireKey()
    if (this.saved.verified) throw new Error('This inbox is already verified.')
    const humanEmail = this.saved.humanEmail
    if (!humanEmail) throw new Error('There’s no address to send the code to. Sign up again with your email address.')
    await this.callAgentMail((client) => client.attachHuman(humanEmail))
    return this.state()
  }

  /**
   * An existing AgentMail account. The key is checked by listing its
   * inboxes; the newest becomes the agent's, or one is made if there are none.
   */
  async useApiKey(input: string): Promise<EmailState> {
    const key = String(input ?? '').trim()
    if (!key || /\s/.test(key)) throw new Error('Paste the whole API key — AgentMail keys start with am_.')
    const client = this.deps.createClient(key)
    const inboxes = (await client.listInboxes()).map(toInbox)
    const inbox = inboxes[0] ?? toInbox(await client.createInbox({}))
    if (!inboxes.length) inboxes.push(inbox)
    const domains = await loadDomains(client).catch(() => [] as EmailDomain[])

    this.resetAccount()
    this.saved.provider = 'agentmail'
    this.storeKey(key)
    Object.assign(this.saved, { inbox, inboxes, humanEmail: null, verified: true, domains })
    this.persist()
    this.schedule()
    this.emit()
    return this.refresh()
  }

  /**
   * Another inbox on the account, which becomes the agent's. `username` may
   * be a whole address ("bot@example.com"); the domain must be verified.
   */
  async createInbox(input: { username?: string; domain?: string; displayName?: string }): Promise<EmailState> {
    this.requireKey()
    let username = typeof input?.username === 'string' ? input.username.trim().toLowerCase() : ''
    let domain = typeof input?.domain === 'string' && input.domain.trim() ? normalizeDomain(input.domain, true) : undefined
    if (username.includes('@')) {
      const at = username.lastIndexOf('@')
      domain ??= normalizeDomain(username.slice(at + 1), true)
      username = username.slice(0, at)
    }
    if (domain === 'agentmail.to') domain = undefined
    if (this.saved.provider === 'cloudflare') domain = this.saved.cloudflare?.domain
    const name = username ? normalizeUsername(username, domain) : undefined
    if (domain && this.saved.provider === 'agentmail') {
      const known = this.saved.domains.find((d) => d.domain === domain)
      if (known && known.status !== 'VERIFIED') throw new Error(`${domain} isn’t verified yet. Publish its DNS records and check it again first.`)
    }
    const displayName = typeof input?.displayName === 'string' && input.displayName.trim() ? input.displayName.trim() : undefined
    const inbox = toInbox(await this.call((client) => client.createInbox({ username: name, domain, display_name: displayName })))
    this.saved.inboxes = [inbox, ...this.saved.inboxes.filter((i) => i.id !== inbox.id)]
    return this.switchTo(inbox)
  }

  /** Makes another inbox on the account the agent's. */
  async useInbox(id: string): Promise<EmailState> {
    this.requireKey()
    let inbox = this.saved.inboxes.find((i) => i.id === id)
    if (!inbox) {
      const listed = (await this.call((client) => client.listInboxes())).map(toInbox)
      this.saved.inboxes = listed
      inbox = listed.find((i) => i.id === id)
    }
    if (!inbox) throw new Error('That inbox isn’t on this AgentMail account anymore.')
    if (this.saved.inbox?.id === inbox.id) return this.refresh()
    return this.switchTo(inbox)
  }

  /** Registers a domain; its DNS records come back in `domains` for the user to publish. */
  async addDomain(input: string): Promise<EmailState> {
    this.requireKey()
    if (this.saved.provider === 'cloudflare') throw new Error(`Eaon’s email runs on ${this.saved.cloudflare?.domain ?? 'your domain'} through Cloudflare. To use another domain, disconnect and set it up again.`)
    const domain = normalizeDomain(input)
    const existing = this.saved.domains.find((d) => d.domain === domain)
    const raw = await this.call((client) => (existing ? client.getDomain(existing.id) : client.createDomain(domain)))
    this.upsertDomain(toDomain(raw))
    this.persist()
    this.emit()
    return this.state()
  }

  /** Asks AgentMail to check the records now, then reads where it got to. */
  async verifyDomain(id: string): Promise<EmailState> {
    this.requireKey()
    await this.call((client) => client.verifyDomain(id))
    this.upsertDomain(toDomain(await this.call((client) => client.getDomain(id))))
    this.persist()
    this.emit()
    return this.state()
  }

  /** Deletes the domain at AgentMail. */
  async removeDomain(id: string): Promise<EmailState> {
    this.requireKey()
    if (this.saved.provider === 'cloudflare') throw new Error('This domain is how Eaon’s email works now. Disconnect to stop using it.')
    try {
      await this.call((client) => client.deleteDomain(id))
    } catch (error) {
      if (!(error instanceof AgentMailError && error.status === 404)) throw error
    }
    this.saved.domains = this.saved.domains.filter((d) => d.id !== id)
    this.persist()
    this.emit()
    return this.state()
  }

  setOptions(options: EmailOptions): EmailState {
    const s = this.saved
    if (options?.maxPerDay !== undefined) s.maxPerDay = clampInt(options.maxPerDay, 0, MAX_PER_DAY_LIMIT, s.maxPerDay)
    if (options?.checkEveryMinutes !== undefined) s.checkEveryMinutes = clampInt(options.checkEveryMinutes, 0, MAX_CHECK_MINUTES, s.checkEveryMinutes)
    if (options?.notifyNew !== undefined) s.notifyNew = Boolean(options.notifyNew)
    this.persist()
    this.schedule()
    this.emit()
    return this.state()
  }

  /**
   * Forgets the key and the account. Nothing is deleted at AgentMail: the
   * inbox and its mail are still there for the key, or the console. The
   * options and today's send count stay — they belong to this machine.
   */
  disconnect(): EmailState {
    const wasCloudflare = this.saved.provider === 'cloudflare'
    if (wasCloudflare) this.deps.setCloudflareToken?.(null)
    else this.deps.setKey(null)
    this.key = null
    this.resetAccount()
    this.saved.provider = 'agentmail'
    // Switched from AgentMail to Cloudflare earlier: AgentMail's key was kept, so go back to that inbox.
    const agentMailKey = wasCloudflare ? this.deps.getKey() || null : null
    if (agentMailKey) {
      this.key = agentMailKey
      this.saved.verified = true
    }
    this.persist()
    this.schedule()
    this.emit()
    if (agentMailKey) void this.refresh()
    return this.state()
  }

  // — Cloudflare ————————————————————————————————————————————————

  /** The domains a Cloudflare token (or Global API Key and email) can see. Checks it; changes nothing. */
  async cloudflareZones(token: string, email?: string): Promise<CloudflareZoneChoice[]> {
    const credential = cloudflareCredential(token, email)
    const zones = await this.cloudflare(credential.key, credential.email).listZones()
    if (zones.length === 0) {
      throw new Error('This token can’t see any domains. Give it Zone: Read for the domain Eaon should use — and add the domain to Cloudflare first, if it isn’t there yet.')
    }
    return zones.map((z) => ({ id: z.id, name: z.name, status: z.status, accountName: z.accountName }))
  }

  /**
   * Eaon's email on the user's own domain, run on their Cloudflare account.
   * Sets up everything there (see CloudflareMailClient.setUp), then switches
   * to it. An AgentMail key, if there was one, stays in the vault so
   * disconnecting Cloudflare goes back to it.
   */
  async setUpCloudflare(input: CloudflareSetup): Promise<EmailState> {
    const typed = typeof input?.token === 'string' && cleanCloudflareKey(input.token) ? cloudflareCredential(input.token, input.email) : null
    let token = typed && !typed.email ? typed.key : typed ? null : ((this.saved.provider === 'cloudflare' ? this.key : null) ?? this.deps.getCloudflareToken?.() ?? null)
    if (!typed && !token) throw new Error('Paste a Cloudflare API token first.')
    const lister = typed?.email ? this.cloudflare(typed.key, typed.email) : this.cloudflare(token)
    const zones = await lister.listZones()
    const zone = zones.find((z) => z.id === input?.zoneId)
    if (!zone) throw new Error('That domain isn’t on this Cloudflare account, or the token can’t see it.')
    if (typed?.email) {
      // The Global API Key is used for this one request and never kept: Eaon keeps the narrow token it makes.
      token = await lister.createEmailToken(zone)
      await this.settle(token)
    }
    if (!token) throw new Error('Paste a Cloudflare API token first.')
    const sub = normalizeSubdomain(input?.subdomain)
    const domain = sub ? `${sub}.${zone.name}` : zone.name
    const username = normalizeUsername(input?.username, domain)
    const address = `${username}@${domain}`
    const displayName = typeof input?.displayName === 'string' && input.displayName.trim() ? input.displayName.trim().slice(0, 80) : null
    const previous = this.saved.provider === 'cloudflare' && this.saved.cloudflare?.accountId === zone.accountId ? this.saved.cloudflare : null

    let config: CloudflareMailConfig = {
      accountId: zone.accountId,
      zoneId: zone.id,
      zoneName: zone.name,
      domain,
      namespaceId: previous?.namespaceId ?? null,
      workerName: MAIL_WORKER_NAME,
      sendingTag: previous?.domain === domain ? previous.sendingTag : null,
      addresses: [{ address, displayName, ruleId: null }]
    }
    const client = this.deps.createCloudflare!(token, () => config, (next) => (config = next))
    config = await client.setUp(config)
    const domainState = toDomain(await client.getDomain())

    this.resetAccount()
    this.saved.provider = 'cloudflare'
    this.storeKey(token)
    const inbox: EmailInbox = { id: address, address, displayName }
    Object.assign(this.saved, { cloudflare: config, inbox, inboxes: [inbox], humanEmail: null, verified: true, domains: [domainState] })
    this.persist()
    this.schedule()
    this.emit()
    return this.refresh()
  }

  // — Workers' own addresses ————————————————————————————————————

  /**
   * An address for one worker, on the same domain as Eaon's: its email tools
   * read and send as that address. A new address replaces the worker's old one.
   */
  async setWorkerAddress(workerId: string, input: { username: string; displayName?: string }): Promise<EmailState> {
    this.requireKey()
    const id = String(workerId ?? '').trim()
    if (!id) throw new Error('Which worker?')
    const domain = this.ownDomain()
    const username = normalizeUsername(input?.username, domain)
    const address = `${username}@${domain}`
    if (address === this.saved.inbox?.address.toLowerCase()) throw new Error('That’s Eaon’s own address. Pick another one for this worker.')
    const taken = Object.entries(this.saved.workerInboxes).find(([other, inbox]) => other !== id && inbox.address.toLowerCase() === address)
    if (taken) throw new Error(`${address} already belongs to another worker.`)
    const displayName = typeof input?.displayName === 'string' && input.displayName.trim() ? input.displayName.trim().slice(0, 80) : undefined
    const inbox = toInbox(
      await this.call((client) => client.createInbox({ username, domain: domain === 'agentmail.to' ? undefined : domain, display_name: displayName }))
    )
    const before = this.saved.workerInboxes[id]
    this.saved.workerInboxes = { ...this.saved.workerInboxes, [id]: inbox }
    if (before && before.id !== inbox.id) await this.retireAddress(before)
    this.persist()
    this.emit()
    return this.state()
  }

  /** The worker goes back to using Eaon's address. On Cloudflare its address stops receiving mail; at AgentMail the inbox stays. */
  async removeWorkerAddress(workerId: string): Promise<EmailState> {
    const before = this.saved.workerInboxes[String(workerId ?? '')]
    if (!before) return this.state()
    await this.retireAddress(before)
    const rest = { ...this.saved.workerInboxes }
    delete rest[String(workerId)]
    this.saved.workerInboxes = rest
    this.persist()
    this.emit()
    return this.state()
  }

  /** The address a worker reads and sends as: its own, or Eaon's. */
  addressFor(workerId?: string | null): EmailInbox | null {
    return (workerId ? this.saved.workerInboxes[workerId] : null) ?? this.saved.inbox
  }

  // — Reading ———————————————————————————————————————————————————

  /**
   * The newest mail and the unread count. Records what it saw, so the
   * background check doesn't announce mail the user has already looked at.
   * Never throws for AgentMail's sake: a failure lands in `state().error`.
   */
  async refresh(): Promise<EmailState> {
    await this.look(false)
    return this.state()
  }

  /** The background check: a refresh that announces mail nobody has seen yet. */
  async check(): Promise<void> {
    await this.look(true)
  }

  /** Lists the inbox for the agent, without touching what counts as seen. */
  async list(options: { unreadOnly?: boolean; limit?: number } = {}, workerId?: string | null): Promise<EmailMessage[]> {
    const inbox = this.requireInbox(workerId)
    const limit = clampInt(options.limit ?? 20, 1, 50, 20)
    const items = await this.call((client) => client.listMessages(inbox.id, { limit, labels: options.unreadOnly ? ['unread'] : undefined }))
    const messages = items.map((m) => this.toMessage(m, inbox))
    return options.unreadOnly ? messages.filter((m) => m.unread) : messages
  }

  /** One message in full, which also marks it read. */
  async read(messageId: string, workerId?: string | null): Promise<EmailMessage> {
    const inbox = this.requireInbox(workerId)
    const id = String(messageId ?? '').trim()
    if (!id) throw new Error('Which email? Pass its message id.')
    const raw = await this.call((client) => client.getMessage(inbox.id, id))
    const message: EmailMessage = { ...this.toMessage(raw, inbox), text: raw.body }
    if (message.unread) {
      let told = false
      if (message.labels.includes('unread')) {
        try {
          const updated = await this.call((client) => client.updateMessage(inbox.id, id, { add_labels: ['read'], remove_labels: ['unread'] }))
          message.labels = Array.isArray(updated.labels) ? updated.labels.map(String) : message.labels.filter((l) => l !== 'unread').concat('read')
          told = true
        } catch {
          /* remembered here instead */
        }
      }
      if (!told) this.rememberRead(id)
      message.unread = false
      this.unreadIds.delete(id)
      this.recent = this.recent.map((m) => (m.id === id ? { ...m, unread: false, labels: message.labels } : m))
      this.persist()
      this.emit()
    }
    return message
  }

  // — Sending ———————————————————————————————————————————————————

  async send(outgoing: EmailOutgoing, workerId?: string | null): Promise<{ messageId: string }> {
    const inbox = this.sendingInbox(workerId)
    const to = cleanAddresses(outgoing?.to)
    const cc = cleanAddresses(outgoing?.cc).filter((a) => !to.includes(a))
    if (to.length === 0) throw new Error('Add at least one recipient.')
    if (to.length + cc.length > MAX_RECIPIENTS) throw new Error(`Send to at most ${MAX_RECIPIENTS} people at once.`)
    const subject = String(outgoing?.subject ?? '').trim()
    const text = String(outgoing?.text ?? '')
    if (!subject) throw new Error('Add a subject.')
    if (!text.trim()) throw new Error('Write the message first.')
    return this.sending(async (client, idempotencyKey) => {
      const sent = await client.send(inbox.id, { to, cc, subject, text }, { idempotencyKey })
      return { messageId: sent.message_id }
    })
  }

  async reply(messageId: string, text: string, replyAll = false, workerId?: string | null): Promise<{ messageId: string }> {
    const inbox = this.sendingInbox(workerId)
    const id = String(messageId ?? '').trim()
    if (!id) throw new Error('Which email? Pass its message id.')
    if (!String(text ?? '').trim()) throw new Error('Write the reply first.')
    return this.sending(async (client, idempotencyKey) => {
      const sent = await client.reply(inbox.id, id, { text: String(text), reply_all: Boolean(replyAll) }, { idempotencyKey })
      return { messageId: sent.message_id }
    })
  }

  // — Background check ——————————————————————————————————————————

  /** Starts the background check: one look now, then every `checkEveryMinutes`. */
  start(): void {
    if (this.started) return
    this.started = true
    void this.upgradeWorker()
      .catch(() => {})
      .then(() => this.check())
      .finally(() => this.schedule())
  }

  /** A Cloudflare setup made by an older Eaon gets the current Worker (its sending route came later). */
  private async upgradeWorker(): Promise<void> {
    const config = this.saved.cloudflare
    if (this.saved.provider !== 'cloudflare' || !config || !this.key || config.workerVersion === MAIL_WORKER_VERSION) return
    try {
      await this.cloudflare(this.key).setUp(config)
      this.emit()
    } catch (error) {
      console.error('[email] could not update the mail Worker:', error)
    }
  }

  /** Cloudflare: asks for a destination address to be verified; Cloudflare emails it a link. */
  async addVerifiedAddress(email: string): Promise<EmailState> {
    this.requireKey()
    if (this.saved.provider !== 'cloudflare') throw new Error('Verified addresses are for email on your own domain through Cloudflare.')
    const address = normalizeEmail(email, 'Enter an email address to verify.')
    await this.guard(() => this.cloudflare(this.key).addDestinationAddress(address))
    this.verified = await this.cloudflare(this.key).verifiedAddresses()
    this.emit()
    return this.state()
  }

  stop(): void {
    this.started = false
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
  }

  /** Resolves once a check in progress has finished; for tests and orderly shutdown. */
  async idle(): Promise<void> {
    await this.refreshing?.catch(() => {})
  }

  /**
   * One timer, re-armed after each check finishes, so a slow check never
   * overlaps the next. Unref'd: it must not keep the process alive.
   */
  private schedule(): void {
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
    const minutes = this.saved.checkEveryMinutes
    if (!this.started || !this.key || minutes <= 0) return
    this.timer = setTimeout(() => {
      this.timer = null
      void this.check().finally(() => this.schedule())
    }, minutes * this.minuteMs)
    this.timer.unref?.()
  }

  // — Internals —————————————————————————————————————————————————

  /** A manual refresh and a background check at the same moment share one request. */
  private look(announce: boolean): Promise<void> {
    if (!this.key) return Promise.resolve()
    if (this.refreshing) return this.refreshing
    const run: Promise<void> = this.lookOnce(announce).finally(() => {
      if (this.refreshing === run) this.refreshing = null
    })
    this.refreshing = run
    return run
  }

  private async lookOnce(announce: boolean): Promise<void> {
    const generation = this.generation
    const client = this.client()
    try {
      let inbox = this.saved.inbox
      if (!inbox) {
        // The state file was lost but the key wasn't: pick the inbox up again.
        const inboxes = (await client.listInboxes()).map(toInbox)
        if (generation !== this.generation) return
        if (inboxes.length === 0) throw new Error('This AgentMail account has no inbox yet. Create one in Settings → Email.')
        this.saved.inboxes = inboxes
        this.saved.inbox = inbox = inboxes[0]
        this.resetInboxTracking()
      }
      const [items, unreadItems] = await Promise.all([
        client.listMessages(inbox.id, { limit: RECENT }),
        client.listMessages(inbox.id, { limit: UNREAD_SCAN, labels: ['unread'] })
      ])
      if (generation !== this.generation) return
      const recent = items.map((m) => this.toMessage(m))
      this.recent = recent
      this.unreadIds = new Set([...unreadItems.map((m) => this.toMessage(m)), ...recent].filter((m) => m.unread).map((m) => m.id))
      this.markSeen(recent, announce)
      if (this.saved.provider === 'cloudflare' && this.saved.cloudflare) {
        const cf = this.cloudflare(this.key)
        // Email Sending turned on in the dashboard since the last look: pick it up without "Check again".
        if (!this.saved.cloudflare.sendingTag) await cf.tryEnableSending().catch(() => false)
        if (generation !== this.generation) return
        this.verified = this.saved.cloudflare.sendingTag ? null : await cf.verifiedAddresses()
      }
      await this.refreshPendingDomains(client, generation)
      if (generation !== this.generation) return
      this.saved.lastCheckedAt = this.now()
      if (this.problem && !this.problem.keep) this.problem = null
      this.persist()
    } catch (error) {
      if (generation !== this.generation) return
      const message = error instanceof Error ? error.message : String(error)
      const blocking = error instanceof AgentMailError && (error.keyRefused || error.status === 0 || error.status >= 500)
      if (!this.problem?.keep) this.problem = { message, blocking }
    }
    this.emit()
  }

  /**
   * Announces incoming unread mail that hasn't been seen before, then
   * records everything listed as seen. The first look at an inbox only
   * records: what was already there isn't news.
   */
  private markSeen(recent: EmailMessage[], announce: boolean): void {
    const seen = new Set(this.saved.seen)
    const fresh = recent.filter((m) => !seen.has(m.id) && !m.sent && m.unread).sort((a, b) => a.at - b.at)
    if (announce && this.saved.seeded && this.saved.notifyNew && fresh.length > 0 && this.deps.notify) {
      const notices: EmailNotice[] =
        fresh.length <= MAX_NOTICES
          ? fresh.map((m) => ({ title: `New email from ${senderName(m.from)}`, body: m.subject || m.preview || '(no subject)', messageId: m.id }))
          : [{ title: `${fresh.length} new emails`, body: summary(fresh), messageId: null }]
      for (const notice of notices) {
        try {
          this.deps.notify(notice)
        } catch (error) {
          console.error('[email] notification failed:', error)
        }
      }
    }
    for (const m of recent) {
      if (seen.has(m.id)) continue
      seen.add(m.id)
      this.saved.seen.push(m.id)
    }
    if (this.saved.seen.length > SEEN_CAP) this.saved.seen = this.saved.seen.slice(-SEEN_CAP)
    this.saved.seeded = true
  }

  /** AgentMail keeps checking records on its own; a domain on its way gets re-read with each look. */
  private async refreshPendingDomains(client: MailClient, generation: number): Promise<void> {
    const pending = this.saved.domains.filter((d) => d.status !== 'VERIFIED')
    for (const domain of pending) {
      try {
        const fresh = toDomain(await client.getDomain(domain.id))
        if (generation === this.generation) this.upsertDomain(fresh)
      } catch (error) {
        if (error instanceof AgentMailError && error.status === 404 && generation === this.generation) {
          this.saved.domains = this.saved.domains.filter((d) => d.id !== domain.id)
        }
      }
    }
  }

  private async switchTo(inbox: EmailInbox): Promise<EmailState> {
    this.saved.inbox = inbox
    this.resetInboxTracking()
    this.persist()
    this.emit()
    return this.refresh()
  }

  /** Forgets what was seen in the last inbox; the next look at this one only records. */
  private resetInboxTracking(): void {
    this.generation += 1
    this.refreshing = null
    this.saved.seen = []
    this.saved.seeded = false
    this.saved.lastCheckedAt = null
    this.recent = []
    this.unreadIds = new Set()
  }

  /** Everything about the account goes; the options and the day's send count stay. */
  private resetAccount(): void {
    const { maxPerDay, checkEveryMinutes, notifyNew, sent, provider } = this.saved
    this.saved = { ...blank(), maxPerDay, checkEveryMinutes, notifyNew, sent, provider }
    this.readSet = new Set()
    this.problem = null
    this.verified = null
    this.resetInboxTracking()
  }

  /**
   * Keeps the key in memory either way, so a sign-up isn't lost to a locked
   * keychain: AgentMail shows a key once. The user is told it won't survive
   * a restart; signing up again with the same address issues a new one.
   */
  private storeKey(key: string): void {
    this.key = key
    try {
      if (this.saved.provider === 'cloudflare') this.deps.setCloudflareToken?.(key)
      else this.deps.setKey(key)
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error)
      this.problem = {
        message: `Email works for now, but Eaon couldn’t save its key, so it will be forgotten when Eaon quits. ${reason}`,
        blocking: false,
        keep: true
      }
    }
  }

  private upsertDomain(domain: EmailDomain): void {
    const index = this.saved.domains.findIndex((d) => d.id === domain.id)
    if (index === -1) this.saved.domains = [domain, ...this.saved.domains]
    else this.saved.domains = this.saved.domains.map((d, i) => (i === index ? domain : d))
  }

  private rememberRead(id: string): void {
    if (this.readSet.has(id)) return
    this.readSet.add(id)
    this.saved.read.push(id)
    if (this.saved.read.length > READ_CAP) {
      this.saved.read = this.saved.read.slice(-READ_CAP)
      this.readSet = new Set(this.saved.read)
    }
  }

  private toMessage(raw: AgentMailMessageItem, inbox: EmailInbox | null = this.saved.inbox): EmailMessage {
    const labels = Array.isArray(raw.labels) ? raw.labels.map(String) : []
    const own = inbox?.address.toLowerCase()
    const sent = labels.includes('sent') || (Boolean(own) && addressOf(String(raw.from ?? '')) === own)
    const id = String(raw.message_id)
    // AgentMail's own record is the `unread` label. A message with no read
    // label either way falls back to what was read here.
    const unread = !sent && !this.readSet.has(id) && (labels.includes('unread') || !labels.includes('read'))
    return {
      id,
      threadId: String(raw.thread_id ?? ''),
      from: String(raw.from ?? ''),
      to: Array.isArray(raw.to) ? raw.to.map(String) : [],
      cc: Array.isArray(raw.cc) ? raw.cc.map(String) : [],
      subject: typeof raw.subject === 'string' ? raw.subject : '',
      preview: typeof raw.preview === 'string' ? raw.preview.replace(/\s+/g, ' ').trim().slice(0, 240) : '',
      at: Date.parse(raw.timestamp) || Date.parse(raw.created_at ?? '') || 0,
      labels,
      unread,
      sent,
      attachments: (raw.attachments ?? []).map((a) => ({
        id: String(a.attachment_id),
        filename: a.filename || 'attachment',
        size: Number(a.size) || 0,
        contentType: a.content_type ?? null
      }))
    }
  }

  /** Counts a send before it goes, so two at once can't both slip under the cap. */
  private async sending<T>(send: (client: MailClient, idempotencyKey: string) => Promise<T>): Promise<T> {
    const today = dayKey(this.now())
    if (this.saved.sent.day !== today) this.saved.sent = { day: today, count: 0 }
    const max = this.saved.maxPerDay
    if (this.saved.sent.count >= max) {
      throw new Error(
        max === 0
          ? 'Sending email is off: the daily limit is 0. Raise it in Settings → Email.'
          : `The agent has sent ${max} email${max === 1 ? '' : 's'} today, the daily limit. It resets at midnight, or raise it in Settings → Email.`
      )
    }
    this.saved.sent.count += 1
    this.persist()
    try {
      const result = await this.call((client) => send(client, this.newId()))
      this.emit()
      return result
    } catch (error) {
      if (this.saved.sent.day === today && this.saved.sent.count > 0) this.saved.sent.count -= 1
      this.persist()
      this.emit()
      throw error
    }
  }

  /** Runs a request with the current key; a refused key turns the status to 'error'. */
  private call<T>(request: (client: MailClient) => Promise<T>): Promise<T> {
    return this.guard(() => request(this.client()))
  }

  /** The AgentMail-only calls: the sign-up code. */
  private callAgentMail<T>(request: (client: AgentMailClient) => Promise<T>): Promise<T> {
    if (this.saved.provider !== 'agentmail') return Promise.reject(new Error('That’s for AgentMail inboxes; this one runs on Cloudflare.'))
    return this.guard(() => request(this.deps.createClient(this.key)))
  }

  private async guard<T>(run: () => Promise<T>): Promise<T> {
    try {
      const result = await run()
      if (this.problem?.blocking) {
        this.problem = null
        this.emit()
      }
      return result
    } catch (error) {
      if (error instanceof AgentMailError && error.keyRefused && !this.problem?.keep) {
        this.problem = { message: error.message, blocking: true }
        this.emit()
      }
      throw error
    }
  }

  private client(): MailClient {
    return this.saved.provider === 'cloudflare' ? this.cloudflare(this.key) : this.deps.createClient(this.key)
  }

  private cloudflare(token: string | null, globalKeyEmail?: string | null): CloudflareMailClient {
    if (!this.deps.createCloudflare) throw new Error('Cloudflare email isn’t available in this build.')
    return this.deps.createCloudflare(
      token,
      () => this.saved.cloudflare,
      (config) => {
        this.saved.cloudflare = config
        this.persist()
      },
      globalKeyEmail ? { globalKeyEmail } : undefined
    )
  }

  /** A token Cloudflare just made can take a moment to work everywhere; wait until it lists zones. */
  private async settle(token: string): Promise<void> {
    const wait = this.deps.tokenSettleMs ?? 1500
    for (let attempt = 1; ; attempt++) {
      try {
        await this.cloudflare(token).listZones()
        return
      } catch (error) {
        if (attempt >= 6 || !(error instanceof AgentMailError && error.keyRefused)) throw error
        await new Promise((resolve) => setTimeout(resolve, wait))
      }
    }
  }

  /** The domain addresses are made on: Cloudflare's, or the one Eaon's AgentMail address uses. */
  private ownDomain(): string {
    if (this.saved.provider === 'cloudflare') {
      const domain = this.saved.cloudflare?.domain
      if (!domain) throw new Error('Set up your domain in Settings → Email first.')
      return domain
    }
    return this.saved.inbox?.address.split('@')[1]?.toLowerCase() || 'agentmail.to'
  }

  /** An address a worker no longer uses: on Cloudflare it stops receiving; at AgentMail the inbox is left as it is. */
  private async retireAddress(inbox: EmailInbox): Promise<void> {
    if (this.saved.provider !== 'cloudflare') return
    if (inbox.address.toLowerCase() === this.saved.inbox?.address.toLowerCase()) return
    try {
      await this.guard(() => this.cloudflare(this.key).deleteInbox(inbox.id))
    } catch (error) {
      console.error('[email] could not stop routing', inbox.address, error)
    }
  }

  private requireKey(): void {
    if (!this.key) throw new Error('Email isn’t set up. Set it up in Settings → Email first.')
  }

  private requireInbox(workerId?: string | null): EmailInbox {
    this.requireKey()
    const inbox = this.addressFor(workerId)
    if (!inbox) throw new Error('Pick an inbox in Settings → Email first.')
    return inbox
  }

  private sendingInbox(workerId?: string | null): EmailInbox {
    const inbox = this.requireInbox(workerId)
    if (!this.saved.verified) {
      throw new Error(
        `The inbox can’t send yet: AgentMail emailed a six-digit code to ${this.saved.humanEmail ?? 'the user'}, and it has to be entered in Settings → Email first.`
      )
    }
    return inbox
  }

  private sentToday(): number {
    return this.saved.sent.day === dayKey(this.now()) ? this.saved.sent.count : 0
  }

  private persist(): void {
    this.saved.read = [...this.readSet].slice(-READ_CAP)
    this.deps.save(structuredClone(this.saved))
  }

  private emit(): void {
    this.deps.onChange?.(this.state())
  }
}

// — Mapping and checks ——————————————————————————————————————————

function blank(): SavedEmail {
  return {
    version: 1,
    provider: 'agentmail',
    cloudflare: null,
    workerInboxes: {},
    inbox: null,
    inboxes: [],
    humanEmail: null,
    verified: false,
    domains: [],
    maxPerDay: DEFAULT_EMAILS_PER_DAY,
    checkEveryMinutes: DEFAULT_EMAIL_CHECK_MINUTES,
    notifyNew: true,
    sent: { day: '', count: 0 },
    seen: [],
    seeded: false,
    read: [],
    lastCheckedAt: null
  }
}

const isRecord = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === 'object' && !Array.isArray(value)
const strings = (value: unknown): string[] => (Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : [])
const isInbox = (value: unknown): value is EmailInbox => isRecord(value) && typeof value.id === 'string' && typeof value.address === 'string'
const isCloudflareConfig = (value: unknown): value is CloudflareMailConfig =>
  isRecord(value) &&
  typeof value.accountId === 'string' &&
  typeof value.zoneId === 'string' &&
  typeof value.zoneName === 'string' &&
  typeof value.domain === 'string' &&
  typeof value.workerName === 'string' &&
  Array.isArray(value.addresses)
const isDomain = (value: unknown): value is EmailDomain => isRecord(value) && typeof value.id === 'string' && typeof value.domain === 'string' && Array.isArray(value.records)

/** `email.json` as written by this or an older version, or hand-edited: anything odd falls back to defaults. */
function sanitize(raw: unknown): SavedEmail {
  const base = blank()
  if (!isRecord(raw)) return base
  const sent = isRecord(raw.sent) && typeof raw.sent.day === 'string' && Number.isFinite(raw.sent.count) ? { day: raw.sent.day, count: Math.max(0, Number(raw.sent.count)) } : base.sent
  return {
    version: 1,
    provider: raw.provider === 'cloudflare' && isCloudflareConfig(raw.cloudflare) ? 'cloudflare' : 'agentmail',
    cloudflare: isCloudflareConfig(raw.cloudflare) ? raw.cloudflare : null,
    workerInboxes: isRecord(raw.workerInboxes)
      ? Object.fromEntries(Object.entries(raw.workerInboxes).filter((entry): entry is [string, EmailInbox] => isInbox(entry[1])))
      : {},
    inbox: isInbox(raw.inbox) ? { id: raw.inbox.id, address: raw.inbox.address, displayName: raw.inbox.displayName ?? null } : null,
    inboxes: Array.isArray(raw.inboxes) ? raw.inboxes.filter(isInbox) : [],
    humanEmail: typeof raw.humanEmail === 'string' ? raw.humanEmail : null,
    verified: raw.verified === true,
    domains: Array.isArray(raw.domains) ? raw.domains.filter(isDomain) : [],
    maxPerDay: clampInt(raw.maxPerDay, 0, MAX_PER_DAY_LIMIT, base.maxPerDay),
    checkEveryMinutes: clampInt(raw.checkEveryMinutes, 0, MAX_CHECK_MINUTES, base.checkEveryMinutes),
    notifyNew: typeof raw.notifyNew === 'boolean' ? raw.notifyNew : base.notifyNew,
    sent,
    seen: strings(raw.seen).slice(-SEEN_CAP),
    seeded: raw.seeded === true,
    read: strings(raw.read).slice(-READ_CAP),
    lastCheckedAt: typeof raw.lastCheckedAt === 'number' ? raw.lastCheckedAt : null
  }
}

function clampInt(value: unknown, min: number, max: number, fallback: number): number {
  const n = Number(value)
  if (value === null || value === '' || !Number.isFinite(n)) return fallback
  return Math.min(max, Math.max(min, Math.round(n)))
}

/** The local calendar day, which is what "per day" means to the user. */
function dayKey(time: number): string {
  const d = new Date(time)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

function toInbox(raw: AgentMailInbox): EmailInbox {
  return { id: String(raw.inbox_id), address: String(raw.email || raw.inbox_id), displayName: raw.display_name?.trim() || null }
}

const DOMAIN_STATUSES: EmailDomain['status'][] = ['NOT_STARTED', 'PENDING', 'INVALID', 'FAILED', 'VERIFYING', 'VERIFIED']
const RECORD_TYPES: EmailDomainRecord['type'][] = ['TXT', 'CNAME', 'MX']
const RECORD_STATUSES: EmailDomainRecord['status'][] = ['MISSING', 'INVALID', 'VALID']

function oneOf<T extends string>(value: unknown, allowed: T[], fallback: T): T {
  const upper = String(value ?? '').toUpperCase() as T
  return allowed.includes(upper) ? upper : fallback
}

/** AgentMail's reason codes, in words a user can act on. Unknown codes pass through. */
const DOMAIN_REASONS: Record<string, string> = {
  dns_records_missing: 'Some DNS records aren’t published yet.',
  dns_records_invalid: 'Some DNS records don’t match what AgentMail expects.',
  ses_dkim_pending: 'The records look right; AgentMail is still checking them.',
  ses_mail_from_pending: 'The records look right; AgentMail is still checking them.',
  ses_dkim_temporary_failure: 'The records look right. AgentMail hit a passing error checking them and keeps retrying on its own.',
  ses_mail_from_temporary_failure: 'The records look right. AgentMail hit a passing error checking them and keeps retrying on its own.',
  ses_dkim_failed: 'AgentMail couldn’t confirm the DKIM record. Fix it, then check again.',
  ses_mail_from_failed: 'AgentMail couldn’t confirm the mail-from records. Fix them, then check again.',
  ses_dkim_not_started: 'AgentMail hasn’t started checking yet. Check again to start it.',
  ses_mail_from_not_started: 'AgentMail hasn’t started checking yet. Check again to start it.',
  ses_not_verified_for_sending: 'The records look right, but the domain isn’t cleared for sending yet.'
}

const RECORD_REASONS: Record<string, string> = {
  duplicate_records: 'The right value is there, but so are other records at this name. Remove the extras.',
  value_mismatch: 'There is a record at this name, but its value doesn’t match.'
}

function toDomain(raw: AgentMailDomain): EmailDomain {
  const status = oneOf(raw.status, DOMAIN_STATUSES, 'PENDING')
  return {
    id: String(raw.domain_id),
    domain: String(raw.domain),
    status,
    records: (Array.isArray(raw.records) ? raw.records : []).map((r) => ({
      type: oneOf(r.type, RECORD_TYPES, 'TXT'),
      name: String(r.name ?? ''),
      value: String(r.value ?? ''),
      status: oneOf(r.status, RECORD_STATUSES, 'MISSING'),
      priority: typeof r.priority === 'number' ? r.priority : null,
      reason: r.reason ? (RECORD_REASONS[r.reason] ?? r.reason) : null
    })),
    reason: status === 'VERIFIED' || !raw.reason ? null : (DOMAIN_REASONS[raw.reason] ?? raw.reason)
  }
}

/** Every domain with its records: the list has neither, so each is read on its own. */
async function loadDomains(client: MailClient): Promise<EmailDomain[]> {
  const items = (await client.listDomains()).slice(0, 20)
  const domains = await Promise.all(items.map((d) => client.getDomain(d.domain_id).then(toDomain).catch(() => null)))
  return domains.filter((d): d is EmailDomain => d !== null)
}

const EMAIL = /^[^\s@<>(),;:"[\]]+@[^\s@<>(),;:"[\]]+\.[^\s@<>(),;:"[\]]+$/

/** The bare address in "Jo <jo@x.com>" or "jo@x.com", lowercased. */
export function addressOf(entry: string): string {
  const match = /<([^<>]+)>\s*$/.exec(entry)
  return (match ? match[1] : entry).trim().toLowerCase()
}

/** "Jo" from "Jo <jo@x.com>"; the address when there is no name. */
export function senderName(from: string): string {
  const match = /^\s*"?([^"<]*?)"?\s*<[^<>]+>\s*$/.exec(from)
  return match?.[1]?.trim() || addressOf(from) || 'someone'
}

function summary(messages: EmailMessage[]): string {
  const names = [...new Set(messages.map((m) => senderName(m.from)))]
  return `From ${names.slice(0, 3).join(', ')}${names.length > 3 ? ` and ${names.length - 3} more` : ''}`
}

/**
 * Recipient entries from a list, a string with commas, or both — models and
 * people write all of them. A comma inside a quoted name ("Smith, Jo"
 * <jo@x.com>) or angle brackets doesn't split.
 */
export function splitAddresses(input: unknown): string[] {
  const items = Array.isArray(input) ? input : typeof input === 'string' ? [input] : []
  return items
    .flatMap((item) => (typeof item === 'string' ? (item.match(/(?:"[^"]*"|<[^>]*>|[^,;\n])+/g) ?? []) : []))
    .map((entry) => entry.trim())
    .filter(Boolean)
}

/** Recipients as plain addresses, refusing anything that isn't one. */
function cleanAddresses(input: unknown): string[] {
  const entries = splitAddresses(input)
  const out: string[] = []
  for (const entry of entries) {
    const address = addressOf(entry)
    if (!EMAIL.test(address)) throw new Error(`“${entry}” isn’t an email address.`)
    if (!out.includes(address)) out.push(address)
  }
  return out
}

function normalizeEmail(input: unknown, message: string): string {
  const address = addressOf(String(input ?? ''))
  if (!EMAIL.test(address)) throw new Error(message)
  return address
}

/** The part before the @. A whole address on `domain` is accepted too. */
function normalizeUsername(input: unknown, domain = 'agentmail.to'): string {
  let name = String(input ?? '')
    .trim()
    .toLowerCase()
  if (name.endsWith(`@${domain}`)) name = name.slice(0, -(domain.length + 1))
  if (!/^[a-z0-9](?:[a-z0-9._-]{0,62}[a-z0-9])?$/.test(name)) {
    throw new Error(`Pick a username of letters, numbers, dots, hyphens or underscores — “nova” becomes nova@${domain}.`)
  }
  return name
}

/** "agents", "mail.agents" or "" (the domain itself). */
function normalizeSubdomain(input: unknown): string {
  const sub = String(input ?? '')
    .trim()
    .toLowerCase()
    .replace(/^\.+|\.+$/g, '')
  if (!sub) return ''
  if (!/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)*[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(sub)) throw new Error('A subdomain is letters, numbers and hyphens, like “agents”.')
  return sub
}

/**
 * What was pasted, cleaned, and refused early when its shape says it can't
 * work — with the reason. A Global API Key needs the login email beside it.
 */
function cloudflareCredential(input: unknown, email?: unknown): { key: string; email: string | null } {
  const key = cleanCloudflareKey(input)
  if (!key) throw new Error('Paste a Cloudflare API token first.')
  switch (cloudflareKeyKind(key)) {
    case 'id':
      throw new Error('That’s an account or zone ID, not a token. Make an API token on Cloudflare’s API Tokens page and paste its value.')
    case 'cut-short':
      throw new Error('That looks cut short: a Cloudflare token is cfut_ (or cfat_) and 48 more letters and numbers. Copy it again — Cloudflare shows it once, right after it’s made.')
    case 'global-key': {
      const address = addressOf(String(email ?? ''))
      if (!EMAIL.test(address)) {
        throw new Error('That’s your Global API Key. Add the email you sign in to Cloudflare with, and Eaon will use the key once to make a token with only the permissions email needs.')
      }
      return { key, email: address }
    }
    default:
      if (key.length < 20 || /\s/.test(key)) throw new Error('Paste the whole Cloudflare API token.')
      return { key, email: null }
  }
}

/** "https://Example.com/", "@example.com" and "me@example.com" all mean example.com. */
function normalizeDomain(input: unknown, allowAgentMail = false): string {
  let domain = String(input ?? '')
    .trim()
    .toLowerCase()
    .replace(/^[a-z][a-z0-9+.-]*:\/\//, '')
    .replace(/[/?#].*$/, '')
    .replace(/\.$/, '')
  if (domain.includes('@')) domain = domain.slice(domain.lastIndexOf('@') + 1)
  if (domain === 'agentmail.to' && !allowAgentMail) throw new Error('agentmail.to is AgentMail’s own domain. Enter one you own, like example.com.')
  if (!/^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9-]{2,63}$/.test(domain)) throw new Error('Enter a domain like example.com.')
  return domain
}
