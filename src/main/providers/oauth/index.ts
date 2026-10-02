import type { Provider } from '@shared/types'
import type { OAuthClientSetup, ProviderAuthPrompt } from '@shared/providers'
import type { Credentials } from '../adapters/types'

/**
 * Browser sign-in for subscription providers (ChatGPT/Codex, GitHub Copilot…).
 *
 * Each flow stores its tokens in the encrypted vault and hands the loop fresh
 * credentials per request, refreshing them when they are about to expire.
 * The flows themselves live next to this file and register in `flows.ts`.
 */

export interface OAuthFlow {
  id: string
  /** Opens the browser (or shows a device code) and resolves once tokens are stored. */
  signIn(onPrompt: (prompt: ProviderAuthPrompt) => void, signal: AbortSignal): Promise<void>
  signOut(): Promise<void>
  isSignedIn(): boolean
  /** Fresh credentials for one request; refreshes the access token first if it is close to expiry. */
  credentials(provider: Provider): Promise<Credentials>
  /** Who is signed in, for the settings page ("you@example.com · Plus"). */
  account?(): string | undefined
  /**
   * Manual fallback for loopback sign-ins: the redirect URL (or bare code)
   * pasted by a user whose browser could not reach the callback server.
   */
  submitCode?(input: string): void
  /** Marks the stored access token stale after the provider rejected it, so the next request refreshes. */
  expire?(): void
  /**
   * For a key provider's sign-in (`ProviderMeta.keyFlow`): true when the
   * signed-in account's own token is used for requests, alongside any API
   * key — Hugging Face — rather than minting a key that is stored as the
   * provider's key (OpenRouter, Poe).
   */
  providesCredentials?: boolean
  /** Set for providers that only sign in apps with a registered OAuth client. */
  clientSetup?: OAuthClientSetup
  /** The registered client id in use, or null when none is configured yet. */
  clientId?(): string | null
  setClientId?(id: string | null): void
}

const flows = new Map<string, OAuthFlow>()

export function registerOAuthFlow(flow: OAuthFlow): void {
  flows.set(flow.id, flow)
}

export function oauthFlow(id: string | undefined): OAuthFlow | undefined {
  return id ? flows.get(id) : undefined
}
