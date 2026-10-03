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
   * The key flow signs in an account whose own token is used (Hugging Face),
   * rather than minting a key: shown as an Account section above the keys.
   */
  accountSignIn?: boolean
}

/**
 * A change to a provider's model list. Removing hides the model (one added by
 * hand is deleted), so it can always be restored; renames survive refreshes.
 */
export type ModelEdit =
  | { remove: string }
  | { restore: string }
  | { restoreAll: true }
  | { add: string }
  | { rename: string; label: string | null }

/** What the Refresh button found. */
export interface ModelsRefresh {
  ok: boolean
  message: string
  /** Labels of models that were not in the list before. */
  added: string[]
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
