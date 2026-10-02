import { ipcRenderer } from 'electron'
import type { CloudflareSetup, CloudflareZoneChoice, EmailMessage, EmailOptions, EmailOutgoing, EmailSignUp, EmailState } from '@shared/email'

/**
 * Renderer bridge for the agent's own email (AgentMail, or the user's domain on Cloudflare). Exposed as
 * `window.api.email`. Main owns the account; the API key goes in and never
 * comes back out. Calls that fail reject with a sentence for the user. Keep
 * every channel this feature uses in this file.
 */

function subscribe<T>(channel: string, handler: (payload: T) => void): () => void {
  const listener = (_e: unknown, payload: T): void => handler(payload)
  ipcRenderer.on(channel, listener)
  return () => ipcRenderer.removeListener(channel, listener)
}

export const emailApi = {
  state: (): Promise<EmailState> => ipcRenderer.invoke('email:state'),
  /** Makes the account and inbox; AgentMail emails the user a six-digit code. Status becomes 'verifying'. */
  signUp: (input: EmailSignUp): Promise<EmailState> => ipcRenderer.invoke('email:sign-up', input),
  /** The code from AgentMail's email. Status becomes 'ready'. */
  verify: (code: string): Promise<EmailState> => ipcRenderer.invoke('email:verify', code),
  resendCode: (): Promise<EmailState> => ipcRenderer.invoke('email:resend-code'),
  /** An existing AgentMail account: checks the key, then uses its newest inbox (or makes one). */
  useApiKey: (key: string): Promise<EmailState> => ipcRenderer.invoke('email:use-api-key', key),
  /** A new inbox on the account, which becomes the agent's. `domain` must be verified. */
  createInbox: (input: { username: string; domain?: string; displayName?: string }): Promise<EmailState> =>
    ipcRenderer.invoke('email:create-inbox', input),
  useInbox: (id: string): Promise<EmailState> => ipcRenderer.invoke('email:use-inbox', id),
  /** Registers a domain; its DNS records appear in `state.domains`. */
  addDomain: (domain: string): Promise<EmailState> => ipcRenderer.invoke('email:add-domain', domain),
  /** Asks AgentMail to check the domain's records now. */
  verifyDomain: (id: string): Promise<EmailState> => ipcRenderer.invoke('email:verify-domain', id),
  /** Deletes the domain at AgentMail. */
  removeDomain: (id: string): Promise<EmailState> => ipcRenderer.invoke('email:remove-domain', id),
  /** Never rejects for AgentMail's sake: a failure is in `state.error`. */
  refresh: (): Promise<EmailState> => ipcRenderer.invoke('email:refresh'),
  /** One message with its text; marks it read. */
  read: (id: string): Promise<EmailMessage> => ipcRenderer.invoke('email:read', id),
  /** Counts toward the daily limit, like the agent's sends. */
  send: (outgoing: EmailOutgoing): Promise<{ messageId: string }> => ipcRenderer.invoke('email:send', outgoing),
  setOptions: (options: EmailOptions): Promise<EmailState> => ipcRenderer.invoke('email:set-options', options),
  /** Forgets the key and account here; nothing is deleted at AgentMail or Cloudflare. */
  disconnect: (): Promise<EmailState> => ipcRenderer.invoke('email:disconnect'),
  /** The domains a Cloudflare API token (or Global API Key with `email`) can see; also checks it. Changes nothing. */
  cloudflareZones: (token: string, email?: string): Promise<CloudflareZoneChoice[]> => ipcRenderer.invoke('email:cloudflare-zones', token, email),
  /** Sets up email on the domain in the user's Cloudflare account (DNS records included) and switches to it. */
  setUpCloudflare: (input: CloudflareSetup): Promise<EmailState> => ipcRenderer.invoke('email:cloudflare-setup', input),
  /** An address of the worker's own, on the same domain as Eaon's. */
  setWorkerAddress: (workerId: string, input: { username: string; displayName?: string }): Promise<EmailState> =>
    ipcRenderer.invoke('email:set-worker-address', workerId, input),
  removeWorkerAddress: (workerId: string): Promise<EmailState> => ipcRenderer.invoke('email:remove-worker-address', workerId),
  /** Cloudflare: asks Cloudflare to verify an address (it emails a link), so the free route can email it. */
  addVerifiedAddress: (address: string): Promise<EmailState> => ipcRenderer.invoke('email:add-verified-address', address),
  onChanged: (handler: (state: EmailState) => void): (() => void) => subscribe('email:changed', handler)
}
