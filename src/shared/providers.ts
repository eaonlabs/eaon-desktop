/**
 * Provider types the renderer needs beyond `Provider` itself: browser sign-in
 * state for subscription providers, and catalog metadata (URL templates,
 * listing support) the settings page uses to render the right controls.
 *
 * Kept apart from `types.ts` so the provider feature can grow without every
 * feature touching the one shared file.
 */

/** What the user has to do to finish a sign-in that is in progress. */
export interface ProviderAuthPrompt {
  /** Page to open: the authorization page, or the device-code verification page. */
  url: string
  /** Code to type on the verification page (GitHub device flow). */
  code?: string
  message?: string
}

export interface ProviderAuthStatus {
  providerId: string
  /** Id of the OAuth flow in `main/providers/oauth`. */
  flow: string
  signedIn: boolean
  /** Who is signed in, when the flow can tell ("you@example.com · Plus", a GitHub login). */
  account?: string
  /** Whether a sign-in is running for this provider right now. */
  state: 'idle' | 'pending' | 'error'
  error?: string
  /** Set while `state` is 'pending'. */
  prompt?: ProviderAuthPrompt
  /**
   * The provider only signs apps in that registered an OAuth client with it,
   * and Eaon has no client id for it yet — the settings page shows how to
   * create one and a field to paste its id.
   */
  needsClientId?: boolean
  /** How to register that client; set for flows that need one. */
  clientSetup?: OAuthClientSetup
  /** The client id in use (not a secret for public PKCE clients). */
  clientId?: string
}

/** What registering an OAuth app for a provider involves. */
export interface OAuthClientSetup {
  /** Where the app is created. */
  registerUrl: string
  /** Redirect URIs to register, exactly as the provider must see them. */
  redirectUris: string[]
  /** Scopes (or permissions) to tick. */
  scopes?: string
  /** One line of anything else that matters ("no client secret"). */
  note?: string
}

/** One value the user fills into a templated base URL. */
export interface ProviderUrlField {
  /** Placeholder name in the template, without braces. */
  key: string
  label: string
  placeholder?: string
  /** Value used when the user has not set one (an AWS region, say). */
  defaultValue?: string
}

export interface ProviderMeta {
  id: string
  /**
   * Base URL with `{key}` placeholders — Cloudflare's account and gateway ids,
   * a Bedrock region. The settings page shows one field per placeholder and
   * writes the filled-in URL back as the provider's base URL.
   */
  baseUrlTemplate?: string
  fields?: ProviderUrlField[]
  /**
   * Set for providers whose base URL is the user's own (an Azure resource):
   * the URL field is shown up front under this label instead of in Advanced.
   */
  baseUrlLabel?: string
  baseUrlPlaceholder?: string
  /** False when the provider has no model-listing endpoint; refresh then keeps the built-in list. */
  listsModels: boolean
  /** Label for the browser sign-in button, when the provider has one. */
  signInLabel?: string
  /**
   * OAuth flow that mints an ordinary API key (OpenRouter), offered next to the
   * key field rather than replacing it.
   */
  keyFlow?: string
  /**
   * Why this provider has no account sign-in, for providers people expect one
   * from (a Claude or Gemini subscription) — shown instead of a button.
   */
  noSignInReason?: string
  /**
   * The provider's own CLI that a plan *can* be used with, run as itself in
   * the ADE's terminal view (Claude Code for Anthropic): offered as a button
   * under `noSignInReason`.
   */
  planInAde?: 'claude' | 'antigravity' | 'codex'
  /**
   * How a plan's own API allowance reaches Eaon the allowed way — through an
   * API key from the account the plan funds (Anthropic: Max and Team plans'
   * monthly API credits, from a Console organization linked to the plan).
   */
  planCredits?: { title: string; detail: string; steps: string[]; links: { label: string; url: string }[] }
  /**
   * The key flow signs in an account whose own token is used (Hugging Face),
   * rather than minting a key: shown as an Account section above the keys.
   */
  accountSignIn?: boolean
}

/**
 * A change to a provider's model list. Removing hides the model (one added by
 * hand is deleted), so it can always be restored; renames survive refreshes.
 */
/**
 * A model's details the user can set in Settings → Model providers → Edit,
 * over what the catalog and the provider's listing say. null puts the
 * catalog's value back.
 */
export interface ModelEditFields {
  contextWindow?: number | null
  maxOutput?: number | null
  tools?: boolean | null
  vision?: boolean | null
  /** Thinks before answering: shows the effort control (low, medium, high unless the catalog knows better). */
  reasoning?: boolean | null
}

export type ModelEdit =
  | { remove: string }
  | { restore: string }
  | { restoreAll: true }
  | { add: string }
  | { rename: string; label: string | null }
  /** Edit model: the name, the details, and for a model added by hand its id. */
  | { update: string; label?: string | null; id?: string; fields?: ModelEditFields }
  /** Back to the catalog's name and details. */
  | { reset: string }

/** What the Refresh button found. */
export interface ModelsRefresh {
  ok: boolean
  message: string
  /** Labels of models that were not in the list before. */
  added: string[]
  /** Labels of models that were in the list before and are gone now. */
  removed?: string[]
  /** When this check ran. */
  checkedAt?: number
  /** Set when the provider's own listing failed: why, and what to do about it. */
  issue?: ProviderIssue
}

/**
 * Why a request to a provider failed, as something the user can act on.
 * Kept apart from the raw error so "401" never reaches the screen as the
 * explanation, and an expired sign-in is never reported as a missing model.
 */
export type ProviderErrorKind =
  /** A browser sign-in ran out (the refresh was refused). Reconnect. */
  | 'auth-expired'
  /** A browser sign-in was revoked or signed out elsewhere. Reconnect. */
  | 'auth-revoked'
  /** The provider rejected the API key. */
  | 'key-invalid'
  /** The key can't be right as typed: whitespace, the wrong provider's prefix. */
  | 'key-malformed'
  /** The key or account works but may not use this (missing scope, model or project permission). */
  | 'insufficient-scope'
  /** The account is out of credit or over its plan's quota. */
  | 'quota'
  /** Too many requests right now; waiting helps. */
  | 'rate-limit'
  /** The provider is down or overloaded (5xx). */
  | 'outage'
  /** No network: DNS failed, the connection was refused or dropped. */
  | 'network'
  /** The provider didn't answer in time. */
  | 'timeout'
  /** The provider doesn't serve this country or region. */
  | 'region'
  /** The model isn't offered (any more) to this account. */
  | 'model-unavailable'
  /** The account works but offers no model Eaon can use. */
  | 'no-models'
  | 'other'

/** The one thing to do about a provider failure, as a button. */
export type ProviderAction =
  /** Run the provider's sign-in again. */
  | 'reconnect'
  /** Open the provider in Settings → Model providers to fix or add a key. */
  | 'fix-key'
  /** Open the provider's settings (turn it on, check its endpoint, restore a model). */
  | 'open-settings'
  /** Open the model picker to choose another model. */
  | 'choose-model'
  /** Try the same thing again. */
  | 'retry'

export interface ProviderIssue {
  kind: ProviderErrorKind
  /** One or two plain sentences: what happened and what to do. Never a secret. */
  message: string
  action: ProviderAction | null
  providerId?: string
  /** The provider's own words, for a "Copy details" button; never the headline. */
  detail?: string
  /** For rate limits: how long the provider asked to wait. */
  retryAfterMs?: number
}

/**
 * Failures that stay until the user does something (sign in again, fix the
 * key, top up), which make a provider "Needs attention". A dropped
 * connection, a timeout, an outage or a rate limit passes by itself and
 * never marks a provider.
 */
export function isLastingIssue(kind: ProviderErrorKind): boolean {
  return (
    kind === 'auth-expired' ||
    kind === 'auth-revoked' ||
    kind === 'key-invalid' ||
    kind === 'key-malformed' ||
    kind === 'insufficient-scope' ||
    kind === 'quota' ||
    kind === 'region' ||
    kind === 'no-models'
  )
}

/** The last time Eaon checked a provider's credentials, and what it found. */
export interface ProviderHealth {
  ok: boolean
  /** Why the check failed; null when it worked. */
  issue: ProviderIssue | null
  checkedAt: number
}

/**
 * The id a custom provider named `name` is stored under: a slug of the name,
 * suffixed until it is free. Settings and API keys are keyed by provider id,
 * so reusing one would overwrite that provider — a custom endpoint named
 * "OpenAI" replaced the built-in OpenAI's base URL and saved key.
 */
export function customProviderId(name: string, taken: Iterable<string>): string {
  const slug = name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
  if (!slug) return ''
  const used = new Set(taken)
  if (!used.has(slug)) return slug
  let n = 2
  while (used.has(`${slug}-${n}`)) n++
  return `${slug}-${n}`
}

/**
 * Key prefixes that identify a provider for sure. Used only to catch a key
 * pasted under the wrong provider (an Anthropic key in OpenAI's field), never
 * to reject a key whose provider changed its format.
 */
const KEY_PREFIXES: { prefix: string; providerId: string; name: string }[] = [
  { prefix: 'sk-ant-', providerId: 'anthropic', name: 'Anthropic' },
  { prefix: 'sk-or-', providerId: 'openrouter', name: 'OpenRouter' },
  { prefix: 'gsk_', providerId: 'groq', name: 'Groq' },
  { prefix: 'xai-', providerId: 'xai', name: 'xAI' },
  { prefix: 'AIza', providerId: 'gemini', name: 'Google' },
  { prefix: 'pplx-', providerId: 'perplexity', name: 'Perplexity' },
  { prefix: 'nvapi-', providerId: 'nvidia-nim', name: 'NVIDIA' }
]

/**
 * A pasted key, tidied (surrounding spaces and quotes, a leading "Bearer "
 * dropped), or why it can't be right as typed. Catches the mistakes that
 * otherwise come back from the provider as a bare 401: a key with a line
 * break in it, half a key, another provider's key.
 */
/** Why a Claude subscription login token is refused, and what to use instead. */
export const CLAUDE_LOGIN_TOKEN =
  "That's a Claude subscription login token, not an API key. Anthropic doesn't allow other apps to use Claude logins, and accounts that do can be suspended, so Eaon won't use it. Make an API key in the Claude Console instead — on Max and Team plans, your plan's monthly API credits pay for it."

/** A Claude subscription's login (or refresh) token rather than an API key. */
export function isClaudeLoginToken(key: string): boolean {
  return /^(Bearer\s+)?sk-ant-(oat|ort)\d*-/i.test(key.trim())
}

export function checkKeyShape(providerId: string, providerName: string, raw: string): { key: string; problem: string | null } {
  const key = raw
    .trim()
    .replace(/^["'`]+|["'`]+$/g, '')
    .replace(/^Bearer\s+/i, '')
    .trim()
  if (!key) return { key, problem: 'Paste a key first.' }
  // A Claude subscription's login token (Claude Code's, from `claude setup-token` or its credentials),
  // not an API key. Apps other than Anthropic's may not use one: accounts that do risk suspension.
  if (isClaudeLoginToken(key)) return { key, problem: CLAUDE_LOGIN_TOKEN }
  if (/\s/.test(key)) return { key, problem: 'That key has a space or a line break in it. Copy it again, in one piece.' }
  if (key.length < 8) return { key, problem: 'That key looks cut short. Copy the whole key again.' }
  const other = KEY_PREFIXES.find((entry) => key.startsWith(entry.prefix))
  // Gateways and custom endpoints proxy other labs and may take their keys as they are.
  const strict = KEY_PREFIXES.some((entry) => entry.providerId === providerId) || providerId === 'openai'
  if (other && other.providerId !== providerId && strict) {
    return { key, problem: `That looks like a key for ${other.name}, not ${providerName}. Paste it under ${other.name} instead.` }
  }
  return { key, problem: null }
}
