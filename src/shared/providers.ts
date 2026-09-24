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
}
