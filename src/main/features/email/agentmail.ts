import { randomUUID } from 'node:crypto'

/**
 * A small client for AgentMail's REST API (docs.agentmail.to), hand-rolled
 * on `fetch` like the Telegram and Discord connectors: the official SDK would
 * be a dependency for a dozen calls.
 *
 * Every failure becomes an `AgentMailError` whose message is a sentence for
 * the user. AgentMail's errors carry `{name, code, message, fix}`, where
 * `code` names the cause and `fix` the remedy; `message` keeps old values
 * like "Forbidden" for compatibility, so it is the least useful part.
 *
 * The API key travels only in the Authorization header. Nothing here logs a
 * request, so the key never reaches a log or an error message.
 */

export const AGENTMAIL_API = 'https://api.agentmail.to/v0'
/** Who is signing up, as AgentMail's sign-up asks. */
export const AGENTMAIL_SOURCE = 'eaon-desktop'

const TIMEOUT_MS = 20_000
const RETRY_DELAY_MS = 800
/** Longest Retry-After honoured before giving up on the retry; a user is waiting. */
const MAX_RETRY_WAIT_MS = 5_000

export interface AgentMailInbox {
  inbox_id: string
  email: string
  display_name?: string | null
  pod_id?: string
  created_at?: string
  updated_at?: string
}

export interface AgentMailAttachment {
  attachment_id: string
  size: number
  filename?: string | null
  content_type?: string | null
  content_disposition?: string | null
}

/** A message as listed: headers and a preview, no body. */
export interface AgentMailMessageItem {
  inbox_id: string
  thread_id: string
  message_id: string
  labels: string[]
  timestamp: string
  from: string
  to: string[]
  cc?: string[]
  bcc?: string[]
  subject?: string
  preview?: string
  attachments?: AgentMailAttachment[]
  created_at?: string
  updated_at?: string
  in_reply_to?: string
}

/** A message read in full. `body` is added here: the readable text, see `messageText`. */
export interface AgentMailMessage extends AgentMailMessageItem {
  reply_to?: string[]
  text?: string
  html?: string
  extracted_text?: string
  extracted_html?: string
  body: string
}

export interface AgentMailRecord {
  type: string
  name: string
  value: string
  status: string
  priority?: number | null
  reason?: string | null
}

export interface AgentMailDomain {
  domain_id: string
  domain: string
  status: string
  records: AgentMailRecord[]
  reason?: string | null
}

/** A domain as listed: no status or records, which only the single-domain read returns. */
export interface AgentMailDomainItem {
  domain_id: string
  domain: string
}

export interface AgentMailSent {
  message_id: string
  thread_id: string
}

interface ErrorBody {
  name?: string
  code?: string
  message?: string
  fix?: string
  errors?: unknown
}

export class AgentMailError extends Error {
  constructor(
    message: string,
    /** HTTP status; 0 when AgentMail could not be reached at all. */
    readonly status: number,
    readonly code: string | null = null,
    readonly fix: string | null = null
  ) {
    super(message)
    this.name = 'AgentMailError'
  }

  /** From a Retry-After header, when AgentMail sent one. */
  retryAfterMs?: number

  /**
   * AgentMail refused the key itself. A wrong or revoked key reaches the API
   * gateway's authorizer, which answers a bare 403 `{"message":"Forbidden"}`
   * with no `code`; a missing one gets 401 `{"message":"Unauthorized"}`. Real
   * permission problems always carry a code.
   */
  get keyRefused(): boolean {
    if (this.status === 401) return true
    if (this.code && KEY_CODES.has(this.code)) return true
    return this.status === 403 && !this.code
  }

  /** Unreachable, or failing on AgentMail's side: worth trying again later. */
  get transient(): boolean {
    return this.status === 0 || this.status === 429 || this.status >= 500
  }
}

const KEY_CODES = new Set(['missing_authorization', 'invalid_token_type', 'unknown_api_key', 'unauthorized'])

/** How a request field is named to the user in a validation error. */
const FIELD_NAMES: Record<string, string> = {
  username: 'the username',
  human_email: 'your email address',
  otp_code: 'the code',
  domain: 'the domain',
  to: 'the recipients',
  cc: 'the Cc recipients',
  subject: 'the subject',
  text: 'the message',
  display_name: 'the display name'
}

/** Ends a fragment with a full stop unless it already has one. */
function sentence(text: string): string {
  const trimmed = text.trim()
  return /[.!?…]$/.test(trimmed) ? trimmed : `${trimmed}.`
}

function joinSentences(...parts: (string | null | undefined)[]): string {
  return parts
    .filter((part): part is string => Boolean(part && part.trim()))
    .map(sentence)
    .join(' ')
}

function validationDetail(errors: unknown): string | null {
  if (!Array.isArray(errors) || errors.length === 0) return null
  const parts = errors.slice(0, 3).map((entry) => {
    const e = entry as { path?: unknown; message?: unknown }
    const path = Array.isArray(e.path) ? e.path.map(String) : []
    const field = path[0] ? (FIELD_NAMES[path[0]] ?? path.join('.')) : 'the request'
    const message = typeof e.message === 'string' ? e.message.replace(/\.$/, '') : 'not valid'
    return `${field}: ${message}`
  })
  return `AgentMail didn’t accept ${parts.join('; ')}`
}

/**
 * The sentence the user sees for an error response. A lead sentence in plain
 * words for the causes a user can act on, then AgentMail's own `fix` when it
 * sent one. Validation errors are the exception: their `fix` only says to
 * read the `errors` array, so the field-level messages are used instead.
 */
export function describeError(status: number, body: ErrorBody | null): AgentMailError {
  const code = typeof body?.code === 'string' ? body.code : null
  const fix = typeof body?.fix === 'string' && body.fix.trim() ? body.fix.trim() : null
  const said = typeof body?.message === 'string' && body.message.trim() ? body.message.trim() : null
  // AgentMail's legacy messages are a bare status name; they add nothing.
  const detail = said && !/^(forbidden|unauthorized|not found|bad request|internal server error)$/i.test(said) ? said : null
  const error = (message: string): AgentMailError => new AgentMailError(message, status, code, fix)

  if (status === 401 || (code && KEY_CODES.has(code)) || (status === 403 && !code)) {
    return error(
      joinSentences(
        'AgentMail didn’t accept the API key',
        fix ?? 'Check that you copied all of it (AgentMail keys start with am_), or make a new one at console.agentmail.to'
      )
    )
  }
  switch (code) {
    case 'validation_error':
      return error(sentence(validationDetail(body?.errors) ?? joinSentences('AgentMail didn’t accept that request', detail, fix)))
    case 'missing_permission':
    case 'forbidden':
      return error(joinSentences('AgentMail says this key isn’t allowed to do that', fix ?? 'Use a key with full access to the account'))
    case 'message_rejected':
      return error(joinSentences(`AgentMail didn’t send the email${detail ? `: ${detail.replace(/\.$/, '')}` : ''}`, fix))
    case 'resource_taken':
      return error(joinSentences('That address is already taken', fix ?? 'Pick a different username'))
    case 'already_exists':
      return error(joinSentences('That already exists on this AgentMail account', fix))
    case 'domain_not_verified':
      return error(joinSentences('That domain isn’t verified yet. Publish its DNS records, then check it again', fix))
    case 'limit_exceeded':
      return error(joinSentences(`AgentMail’s limit was reached${detail ? `: ${detail.replace(/\.$/, '')}` : ''}`, fix))
    case 'not_found':
      return error(joinSentences('AgentMail couldn’t find that — it may have been deleted', fix))
  }
  if (status === 404) return error(joinSentences('AgentMail couldn’t find that — it may have been deleted', fix))
  if (status === 413) return error('That email is too large for AgentMail.')
  if (status === 429) return error(joinSentences('AgentMail is limiting requests right now. Wait a minute and try again', fix))
  if (status >= 500) return error(`AgentMail is having trouble right now (HTTP ${status}). Try again in a few minutes.`)
  return error(joinSentences(detail ? `AgentMail said: ${detail}` : `AgentMail answered HTTP ${status}`, fix))
}

/**
 * The readable text of a message. `extracted_text` is the new part of a
 * reply with quoted history and signatures stripped, which is what an agent
 * should read; it can come back empty for forwarded mail, so the full `text`
 * follows. Some clients (Gmail and Outlook forwards) send HTML only.
 */
export function messageText(message: { extracted_text?: string; text?: string; extracted_html?: string; html?: string }): string {
  for (const text of [message.extracted_text, message.text]) {
    if (typeof text === 'string' && text.trim()) return text.trim()
  }
  for (const html of [message.extracted_html, message.html]) {
    if (typeof html === 'string' && html.trim()) return stripHtml(html)
  }
  return ''
}

const ENTITIES: Record<string, string> = { nbsp: ' ', amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", mdash: '—', ndash: '–', hellip: '…', rsquo: '’', lsquo: '‘', rdquo: '”', ldquo: '“', copy: '©' }

function decodeEntities(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z0-9]+);/gi, (match, entity: string) => {
    const lower = entity.toLowerCase()
    if (lower.startsWith('#x')) return safeChar(parseInt(lower.slice(2), 16)) ?? match
    if (lower.startsWith('#')) return safeChar(parseInt(lower.slice(1), 10)) ?? match
    return ENTITIES[lower] ?? match
  })
}

function safeChar(code: number): string | null {
  return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : null
}

/**
 * HTML mail reduced to text. Links keep their address, since the address is
 * often the point of an email (a confirmation link); hidden blocks, styles
 * and comments go; paragraphs, rows and list items keep their line breaks.
 */
export function stripHtml(html: string): string {
  return decodeEntities(
    html
      .replace(/<(script|style|head|title|noscript|svg)[^>]*>[\s\S]*?<\/\1>/gi, ' ')
      .replace(/<!--[\s\S]*?-->/g, ' ')
      .replace(/<li[^>]*>/gi, '\n- ')
      .replace(/<(br|hr)[^>]*>/gi, '\n')
      .replace(/<\/(p|div|tr|h[1-6]|ul|ol|table|section|article|blockquote)>/gi, '\n')
      .replace(/<a\s[^>]*href\s*=\s*["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi, (_m, href: string, inner: string) => {
        const label = inner.replace(/<[^>]+>/g, '').trim()
        if (!/^(https?:|mailto:)/i.test(href)) return label
        const target = href.replace(/^mailto:/i, '')
        return !label || label === target ? target : `${label} (${target})`
      })
      .replace(/<[^>]+>/g, ' ')
  )
    .replace(/[ \t ]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

export interface AgentMailClientOptions {
  baseUrl?: string
  timeoutMs?: number
  /** Pause before the one retry of a request that failed for a passing reason. */
  retryDelayMs?: number
}

interface RequestOptions {
  body?: unknown
  query?: Record<string, string | number | boolean | string[] | undefined>
  /** Sign-up is the one call made before there is a key. */
  auth?: boolean
  idempotencyKey?: string
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))
const seg = (value: string): string => encodeURIComponent(value)

export class AgentMailClient {
  private readonly baseUrl: string
  private readonly timeoutMs: number
  private readonly retryDelayMs: number

  constructor(
    private readonly key: string | null,
    options: AgentMailClientOptions = {}
  ) {
    this.baseUrl = (options.baseUrl ?? AGENTMAIL_API).replace(/\/+$/, '')
    this.timeoutMs = options.timeoutMs ?? TIMEOUT_MS
    this.retryDelayMs = options.retryDelayMs ?? RETRY_DELAY_MS
  }

  // — Agent sign-up —————————————————————————————————————————————

  /**
   * A new AgentMail organization with one inbox and an API key. AgentMail
   * emails a six-digit code to `human_email`; until it is entered the key is
   * limited and the inbox can't send. The key can never be fetched again.
   */
  signUp(input: { username: string; human_email: string; source?: string }): Promise<{ organization_id: string; inbox_id: string; api_key: string }> {
    return this.request('POST', '/agent/sign-up', { auth: false, body: { source: AGENTMAIL_SOURCE, ...input } })
  }

  verify(otpCode: string): Promise<{ verified: boolean }> {
    return this.request('POST', '/agent/verify', { body: { otp_code: otpCode } })
  }

  /**
   * Sends the code again (or a new one once the old expired) without
   * rotating the key. Only until the organization is verified.
   */
  attachHuman(humanEmail: string): Promise<{ human_email: string; instructions: string }> {
    return this.request('POST', '/agent/human', { body: { human_email: humanEmail } })
  }

  resendCode(humanEmail: string): Promise<{ human_email: string; instructions: string }> {
    return this.attachHuman(humanEmail)
  }

  // — Inboxes ———————————————————————————————————————————————————

  /** Newest first. */
  async listInboxes(limit = 100): Promise<AgentMailInbox[]> {
    const data = await this.request<{ inboxes?: AgentMailInbox[] }>('GET', '/inboxes', { query: { limit } })
    return data.inboxes ?? []
  }

  getInbox(inboxId: string): Promise<AgentMailInbox> {
    return this.request('GET', `/inboxes/${seg(inboxId)}`)
  }

  /** `domain` must be a verified domain on the account; it defaults to agentmail.to. */
  createInbox(input: { username?: string; domain?: string; display_name?: string }): Promise<AgentMailInbox> {
    return this.request('POST', '/inboxes', { body: compact(input) })
  }

  updateInbox(inboxId: string, input: { display_name: string }): Promise<AgentMailInbox> {
    return this.request('PATCH', `/inboxes/${seg(inboxId)}`, { body: input })
  }

  // — Messages ——————————————————————————————————————————————————

  /** Newest first. `labels` must all match; received mail carries `unread` until marked read. */
  async listMessages(inboxId: string, options: { limit?: number; labels?: string[] } = {}): Promise<AgentMailMessageItem[]> {
    const data = await this.request<{ messages?: AgentMailMessageItem[] }>('GET', `/inboxes/${seg(inboxId)}/messages`, {
      query: { limit: options.limit, labels: options.labels }
    })
    return data.messages ?? []
  }

  async getMessage(inboxId: string, messageId: string): Promise<AgentMailMessage> {
    const raw = await this.request<Omit<AgentMailMessage, 'body'>>('GET', `/inboxes/${seg(inboxId)}/messages/${seg(messageId)}`)
    return { ...raw, body: messageText(raw) }
  }

  /** AgentMail has no read flag; read state is the `unread` label, which this adds or removes. */
  updateMessage(inboxId: string, messageId: string, change: { add_labels?: string[]; remove_labels?: string[] }): Promise<{ message_id: string; labels: string[] }> {
    return this.request('PATCH', `/inboxes/${seg(inboxId)}/messages/${seg(messageId)}`, { body: change })
  }

  /**
   * Sends a new message. Every send carries an Idempotency-Key: a retry with
   * the same key returns the first send instead of emailing twice, which is
   * what makes retrying a send after a dropped connection safe.
   */
  send(
    inboxId: string,
    message: { to: string[]; cc?: string[]; subject: string; text: string },
    options: { idempotencyKey?: string } = {}
  ): Promise<AgentMailSent> {
    return this.request('POST', `/inboxes/${seg(inboxId)}/messages/send`, {
      body: compact({ to: message.to, cc: message.cc?.length ? message.cc : undefined, subject: message.subject, text: message.text }),
      idempotencyKey: options.idempotencyKey ?? randomUUID()
    })
  }

  /** Replies in the message's thread; `reply_all` includes everyone on the original. */
  reply(inboxId: string, messageId: string, message: { text: string; reply_all?: boolean }, options: { idempotencyKey?: string } = {}): Promise<AgentMailSent> {
    return this.request('POST', `/inboxes/${seg(inboxId)}/messages/${seg(messageId)}/reply`, {
      body: { text: message.text, reply_all: Boolean(message.reply_all) },
      idempotencyKey: options.idempotencyKey ?? randomUUID()
    })
  }

  // — Domains ———————————————————————————————————————————————————

  async listDomains(limit = 100): Promise<AgentMailDomainItem[]> {
    const data = await this.request<{ domains?: AgentMailDomainItem[] }>('GET', '/domains', { query: { limit } })
    return data.domains ?? []
  }

  /** Registers a domain; the answer lists the DNS records to publish. */
  createDomain(domain: string): Promise<AgentMailDomain> {
    return this.request('POST', '/domains', { body: { domain } })
  }

  getDomain(domainId: string): Promise<AgentMailDomain> {
    return this.request('GET', `/domains/${seg(domainId)}`)
  }

  /** Asks AgentMail to check the records now. It answers with no body; read the domain again for the result. */
  async verifyDomain(domainId: string): Promise<void> {
    await this.request('POST', `/domains/${seg(domainId)}/verify`)
  }

  async deleteDomain(domainId: string): Promise<void> {
    await this.request('DELETE', `/domains/${seg(domainId)}`)
  }

  // — Transport —————————————————————————————————————————————————

  private async request<T>(method: string, path: string, options: RequestOptions = {}): Promise<T> {
    const url = new URL(`${this.baseUrl}${path}`)
    for (const [name, value] of Object.entries(options.query ?? {})) {
      if (value === undefined) continue
      // Lists repeat the parameter: labels=unread&labels=x.
      if (Array.isArray(value)) value.forEach((item) => url.searchParams.append(name, item))
      else url.searchParams.set(name, String(value))
    }
    const headers: Record<string, string> = { accept: 'application/json' }
    if (options.body !== undefined) headers['content-type'] = 'application/json'
    if (options.auth !== false) {
      if (!this.key) throw new AgentMailError('Email isn’t set up yet. Sign up or paste an AgentMail API key in Settings → Email.', 401, 'missing_authorization')
      headers.authorization = `Bearer ${this.key}`
    }
    if (options.idempotencyKey) headers['idempotency-key'] = options.idempotencyKey

    // Reads, and sends protected by their idempotency key, are retried once
    // after a dropped connection or a hiccup on AgentMail's side. Anything
    // else that changes state is not: a retry could do it twice.
    const retryable = method === 'GET' || Boolean(options.idempotencyKey)
    for (let attempt = 1; ; attempt++) {
      try {
        return await this.once<T>(method, url, headers, options.body)
      } catch (error) {
        if (!(error instanceof AgentMailError) || !error.transient || !retryable || attempt >= 2) throw error
        const wait = error.retryAfterMs ?? this.retryDelayMs
        if (wait > MAX_RETRY_WAIT_MS) throw error
        await sleep(wait)
      }
    }
  }

  private async once<T>(method: string, url: URL, headers: Record<string, string>, body: unknown): Promise<T> {
    let response: Response
    try {
      response = await fetch(url, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(this.timeoutMs)
      })
    } catch (error) {
      const reason = error instanceof Error && error.name === 'TimeoutError' ? 'it took too long to answer' : error instanceof Error ? (error.cause instanceof Error ? error.cause.message : error.message) : String(error)
      throw new AgentMailError(`Couldn’t reach AgentMail (${reason}). Check your internet connection and try again.`, 0)
    }
    const raw = await response.text().catch(() => '')
    let data: unknown = undefined
    if (raw) {
      try {
        data = JSON.parse(raw)
      } catch {
        data = undefined
      }
    }
    if (!response.ok) {
      const error = describeError(response.status, data && typeof data === 'object' ? (data as ErrorBody) : null)
      const retryAfter = Number(response.headers.get('retry-after'))
      if (Number.isFinite(retryAfter) && retryAfter > 0) error.retryAfterMs = retryAfter * 1000
      throw error
    }
    return (data ?? {}) as T
  }
}

function compact<T extends Record<string, unknown>>(value: T): Partial<T> {
  return Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined && v !== null && v !== '')) as Partial<T>
}
