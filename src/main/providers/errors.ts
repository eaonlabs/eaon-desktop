import type { Provider } from '@shared/types'
import type { ProviderIssue } from '@shared/providers'
import { retryAfterFrom } from './adapters/types'

/**
 * Provider failures as something a person can act on.
 *
 * Adapters, listings and sign-in flows fail in a dozen shapes: a
 * `ProviderHttpError` with a status, the Anthropic SDK's `APIError`, Node's
 * "fetch failed" with the real reason in `cause.code`, a `TimeoutError`, or a
 * sentence from one of Eaon's own sign-in flows. `classifyProviderError`
 * turns any of them into a `ProviderIssue`: which of a fixed set of things
 * went wrong, one sentence saying what to do, the button that does it, and
 * the provider's own words (secrets scrubbed) for "Copy details".
 *
 * The order of the rules matters: a 429 that says "insufficient_quota" is
 * out of credit, not a rate limit; a 403 that names a country is a region
 * block, not a permission problem; a 401 on a browser sign-in is an expired
 * session, never "invalid API key"; and none of them is "model unavailable".
 */

type ProviderLike = Pick<Provider, 'id' | 'name' | 'auth' | 'local' | 'baseUrl'>

/** Where the failure happened: a model request, or reading the provider's model list. */
export type FailureContext = 'request' | 'listing'

/** An Error that already knows what it is. `refreshModels` throws these. */
export class ProviderIssueError extends Error {
  constructor(readonly issue: ProviderIssue) {
    super(issue.message)
    this.name = 'ProviderIssueError'
  }
}

/** Keys, bearer tokens and long secret-looking strings out of text that may be shown or copied. */
export function redactSecrets(text: string): string {
  return text
    .replace(/([?&](?:key|api_key|apikey|token|access_token)=)[^&\s]+/gi, '$1[redacted]')
    .replace(/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{8,}/gi, '$1 [redacted]')
    .replace(/\b(sk|rk|pk|gsk|xai|hf|ghu|gho|ghp|github_pat|csk|nvapi|pplx|fw|tgp)[-_][A-Za-z0-9._-]{8,}/g, '[redacted key]')
    .replace(/\bAIza[0-9A-Za-z_-]{20,}/g, '[redacted key]')
    .replace(/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{5,}/g, '[redacted token]')
}

const NETWORK_CODES = new Set(['ENOTFOUND', 'EAI_AGAIN', 'ENETUNREACH', 'EHOSTUNREACH', 'ECONNREFUSED', 'ECONNRESET', 'EPIPE', 'UND_ERR_SOCKET', 'ENETDOWN'])
const TIMEOUT_CODES = new Set(['ETIMEDOUT', 'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_HEADERS_TIMEOUT', 'UND_ERR_BODY_TIMEOUT', 'ESOCKETTIMEDOUT'])
const OFFLINE_CODES = new Set(['ENOTFOUND', 'EAI_AGAIN', 'ENETUNREACH', 'ENETDOWN'])

interface Facts {
  status: number | undefined
  /** The error's message and its cause's, joined; what the regexes read. */
  text: string
  /** The first error code found on the error or its causes. */
  code: string | undefined
  name: string | undefined
  retryAfterMs: number | undefined
}

function facts(error: unknown): Facts {
  const e = error as { status?: unknown; message?: unknown; name?: unknown; code?: unknown; cause?: unknown; retryAfterMs?: unknown; error?: unknown } | null
  const messages: string[] = []
  let code: string | undefined
  let name: string | undefined
  let cursor: unknown = error
  for (let depth = 0; cursor && depth < 4; depth++) {
    const c = cursor as { message?: unknown; code?: unknown; name?: unknown; cause?: unknown }
    if (typeof c.message === 'string') messages.push(c.message)
    else if (typeof cursor === 'string') messages.push(cursor)
    if (!code && typeof c.code === 'string') code = c.code
    if (!name && typeof c.name === 'string' && c.name !== 'Error') name = c.name
    cursor = c.cause
  }
  // The SDK's parsed body (`APIError.error`) often says more than its message.
  if (e?.error && typeof e.error === 'object') messages.push(JSON.stringify(e.error))
  const text = messages.join(' — ')
  let status = typeof e?.status === 'number' ? e.status : undefined
  // Our own errors carry the status as their first word ("401: …", "503 Service Unavailable").
  if (status === undefined) {
    const lead = /^(?:Error:\s*)?(\d{3})\b/.exec(text)
    if (lead) status = Number(lead[1])
  }
  return { status, text, code, name, retryAfterMs: typeof e?.retryAfterMs === 'number' ? e.retryAfterMs : retryAfterOf((error as { headers?: unknown } | null)?.headers) }
}

/** The SDK's errors keep the response headers (a `Headers`, or a plain record in older versions). */
function retryAfterOf(headers: unknown): number | undefined {
  if (!headers || typeof headers !== 'object') return undefined
  if (headers instanceof Headers) return retryAfterFrom(headers)
  const record = headers as Record<string, unknown>
  const value = record['retry-after-ms'] ?? record['retry-after']
  return typeof value === 'string' ? retryAfterFrom(new Headers({ [record['retry-after-ms'] ? 'retry-after-ms' : 'retry-after']: value })) : undefined
}

const issue = (
  provider: ProviderLike,
  kind: ProviderIssue['kind'],
  message: string,
  action: ProviderIssue['action'],
  f: Facts,
  extra: Partial<ProviderIssue> = {}
): ProviderIssue => ({
  kind,
  message,
  action,
  providerId: provider.id,
  ...(f.text ? { detail: redactSecrets(f.text).slice(0, 600) } : {}),
  ...extra
})

const seconds = (ms: number): string => (ms < 60_000 ? `${Math.max(1, Math.round(ms / 1000))} s` : `${Math.round(ms / 60_000)} min`)

/** Where a local runtime is, for "Couldn't reach Ollama at http://127.0.0.1:11434". */
const where = (provider: ProviderLike): string => provider.baseUrl.replace(/\/v1\/?$/, '')

/** A provider failure in plain words, with the one action that fixes it. Never throws. */
export function classifyProviderError(error: unknown, provider: ProviderLike, context: FailureContext = 'request'): ProviderIssue {
  if (error instanceof ProviderIssueError) return error.issue
  const f = facts(error)
  const { status, text } = f
  const name = provider.name
  const oauth = provider.auth === 'oauth'

  // ---- the request never got an answer
  const timedOut =
    f.name === 'TimeoutError' ||
    (f.code !== undefined && TIMEOUT_CODES.has(f.code)) ||
    status === 408 ||
    (!status && /\b(timed out|timeout)\b/i.test(text))
  if (timedOut) {
    return issue(provider, 'timeout', provider.local ? `${name} didn’t answer in time. It may still be loading the model; try again.` : `${name} didn’t answer in time. Try again.`, 'retry', f)
  }
  const network = (f.code !== undefined && NETWORK_CODES.has(f.code)) || (!status && /fetch failed|network error|socket hang up|Connection error|getaddrinfo|ECONNREFUSED|ENOTFOUND/i.test(text))
  if (network) {
    if (provider.local) return issue(provider, 'network', `Couldn’t reach ${name} at ${where(provider)}. Start it and try again.`, 'retry', f)
    if (f.code && OFFLINE_CODES.has(f.code)) return issue(provider, 'network', `Couldn’t reach ${name}. Check your internet connection and try again.`, 'retry', f)
    if (f.code === 'ECONNREFUSED') return issue(provider, 'network', `${name} refused the connection. Check its base URL.`, 'open-settings', f)
    return issue(provider, 'network', `The connection to ${name} dropped. Check your internet connection and try again.`, 'retry', f)
  }

  // ---- the provider answered with a refusal
  if (/unsupported_country|country,? region,? or territory|not available in your (country|region)|location is not supported|region is not supported|unsupported (region|location)/i.test(text)) {
    return issue(provider, 'region', `${name} isn’t available in your country or region.`, 'choose-model', f)
  }

  // Our own sign-in flows' words for a session that can't be refreshed.
  const signedOut = /^Sign in (to|with) .* first|sign in again|sign-in (has )?(expired|ended)/i.test(text)
  if (oauth && (status === 401 || signedOut || /invalid_grant|refresh[_ ]token|token (has )?(expired|revoked)|session (has )?expired/i.test(text))) {
    if (/revoked|invalidated|refresh_token_reused|signed out|^Sign in (to|with) .* first|ended/i.test(text)) {
      return issue(provider, 'auth-revoked', `You’re signed out of ${name}. Sign in again to keep using it.`, 'reconnect', f)
    }
    return issue(provider, 'auth-expired', `Your ${name} session expired. Sign in again.`, 'reconnect', f)
  }

  if (/usage[_ ]limit|usage_limit_reached|plan limit|reached your (usage|plan)/i.test(text)) {
    return issue(provider, 'quota', `You’ve reached your ${name} plan’s usage limit. It resets later, or choose another model.`, 'choose-model', f)
  }
  if (status === 402 || /insufficient_quota|exceeded your current quota|credit balance is too low|insufficient (credits|balance|funds)|payment required|out of credits|billing (hard )?limit|requires more credits/i.test(text)) {
    return issue(provider, 'quota', `${name} says the account is out of credit or over its quota. Add credit with ${name}, or use another key.`, 'fix-key', f)
  }

  const keyWords = /invalid[_ ]api[_ ]key|incorrect api key|invalid x-api-key|api key not valid|API_KEY_INVALID|invalid authentication|authentication_error|invalid_api_key|no auth credentials|missing (api )?key|unauthenticated/i.test(text)
  if (!oauth && (status === 401 || keyWords)) {
    return issue(provider, 'key-invalid', `${name} rejected the API key. Check it, or paste a new one.`, 'fix-key', f)
  }

  if (status === 403 || /permission|not allowed to|insufficient[_ ]scope|does not have access|access denied|forbidden|not authorized/i.test(text)) {
    // A model the key can't use reads as a permission problem on some hosts; name the model case when it says so.
    if (context === 'request' && /(no|not have|n[’']t have) access to (the |this )?model|not (allowed|permitted) to (use|access) (the |this )?model/i.test(text)) {
      return issue(provider, 'insufficient-scope', `Your ${name} ${oauth ? 'account' : 'key'} isn’t allowed to use this model. Choose another model, or check the ${oauth ? 'plan' : 'key’s permissions'}.`, 'choose-model', f)
    }
    return issue(
      provider,
      'insufficient-scope',
      oauth ? `Your ${name} account isn’t allowed to do this. Check your plan, or sign in again.` : `${name} accepted the key, but it isn’t allowed to do this. Check the key’s permissions or project.`,
      oauth ? 'reconnect' : 'fix-key',
      f
    )
  }

  if (status === 429 || /rate[_ ]limit|too many requests/i.test(text)) {
    const wait = f.retryAfterMs
    return issue(provider, 'rate-limit', `${name} is limiting how fast requests can be made.${wait ? ` Try again in ${seconds(wait)}.` : ' Wait a moment and try again.'}`, 'retry', f, wait ? { retryAfterMs: wait } : {})
  }

  if (context === 'listing' && status === 404) {
    return issue(provider, 'other', `${name}’s model list wasn’t found at its address. Check the base URL.`, 'open-settings', f)
  }
  if (status === 404 || /model[_ ]not[_ ]found|model .{0,80}(does not exist|not found|is not supported|not available)|unknown model|no such model|not a valid model|decommissioned|invalid model/i.test(text)) {
    return issue(provider, 'model-unavailable', `${name} doesn’t offer this model to your account. Choose another model.`, 'choose-model', f)
  }

  if ((status !== undefined && status >= 500) || /overloaded|service unavailable|bad gateway|internal server error|upstream error/i.test(text)) {
    return issue(provider, 'outage', `${name} is having problems right now${status ? ` (${status})` : ''}. Try again in a few minutes.`, 'retry', f)
  }

  // Nothing recognisable: the message itself, minus secrets, is the best there is.
  const plain = redactSecrets(text.replace(/^Error:\s*/, '')).slice(0, 300) || `${name} returned an error.`
  return issue(provider, 'other', plain, null, f)
}

/** The issue for a provider whose listing worked but offered nothing Eaon can use. */
export function noModelsIssue(provider: ProviderLike): ProviderIssue {
  return {
    kind: 'no-models',
    message: `${provider.name} answered, but offers no chat models this account can use.`,
    action: 'open-settings',
    providerId: provider.id
  }
}
