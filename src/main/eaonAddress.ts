import { FREE_BASE_URL, FREE_PROVIDER_ID, GATEWAY_PROVIDER_ID } from '@shared/freeCredits'
import type { ProviderIssue } from '@shared/providers'
import type { Provider } from '@shared/types'

/**
 * The app never shows the address of Eaon's gateway: not in a provider's
 * settings, an error, the usage table or the CLI. Main makes the requests
 * and keeps it to itself; what it hands the pages and the CLI about a
 * provider goes through here first. A custom provider someone points at the
 * gateway (named after its address unless renamed) shows as Eaon, and no new
 * one can be added: Eaon Lite already is that.
 */

const HOST = new URL(FREE_BASE_URL).hostname
const escape = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
/** The id a custom provider is given from the address: `https-gateway-eaon-dev-v1`. */
const SLUG = `https?-${escape(HOST.replace(/\./g, '-'))}[\\w-]*`
/** The address with or without its scheme, port and path, and that id. */
const MENTION = new RegExp(`(?:https?://)?${escape(HOST)}\\.?(?::\\d+)?(?:/[^\\s"'<>)\\]]*)?|\\b${SLUG}`, 'gi')

/** Where Eaon Lite and Eaon Event send their requests: the gateway, or a stand-in for it in tests. */
export const gatewayBaseUrl = (): string => process.env.EAON_FREE_GATEWAY_URL || FREE_BASE_URL

/** Whether a request goes to the gateway (or its stand-in): those are signed (gatewaySignature.ts). */
export function isGatewayRequest(url: string): boolean {
  if (isEaonGateway(url)) return true
  try {
    return new URL(url).origin === new URL(gatewayBaseUrl()).origin
  } catch {
    return false
  }
}

/** Whether a base URL is the gateway's, written any way the provider settings accept. */
export function isEaonGateway(baseUrl: string): boolean {
  const value = baseUrl.trim()
  if (!value) return false
  try {
    const url = new URL(/^[a-z][\w+.-]*:\/\//i.test(value) ? value : `https://${value}`)
    return url.hostname.toLowerCase().replace(/\.$/, '') === HOST
  } catch {
    return false
  }
}

/** Text with every mention of the gateway's address put as "Eaon". */
export const hideEaonAddress = (text: string): string => text.replace(MENTION, 'Eaon')

/** Whether a provider id was made from the gateway's address. */
export const isGatewaySlug = (id: string): boolean => new RegExp(`^${SLUG}$`, 'i').test(id)

/** A usage row's provider as the usage table shows it: one made from the gateway's address counts as Eaon Lite. */
export const shownProviderId = (id: string): string => (isGatewaySlug(id) ? GATEWAY_PROVIDER_ID : id)

function hideInIssue(issue: ProviderIssue): ProviderIssue {
  return { ...issue, message: hideEaonAddress(issue.message), ...(issue.detail ? { detail: hideEaonAddress(issue.detail) } : {}) }
}

/** Eaon's own providers, and any provider that sends to the gateway. */
export function goesToEaonGateway(provider: Pick<Provider, 'id' | 'baseUrl'>): boolean {
  return provider.id === GATEWAY_PROVIDER_ID || provider.id === FREE_PROVIDER_ID || isEaonGateway(provider.baseUrl)
}

/** A provider as the pages and the CLI get it: without the gateway's address anywhere in it. */
export function forScreen(provider: Provider): Provider {
  if (!goesToEaonGateway(provider)) return provider
  const issue = provider.health?.issue
  return {
    ...provider,
    baseUrl: '',
    name: hideEaonAddress(provider.name),
    ...(provider.health && issue ? { health: { ...provider.health, issue: hideInIssue(issue) } } : {})
  }
}

/** Every provider as the pages and the CLI get them. */
export const forScreens = (providers: Provider[]): Provider[] => providers.map(forScreen)

/** Why a provider can't be pointed at the gateway. */
export const GATEWAY_REFUSED = 'That’s Eaon’s own service, and Eaon Lite already uses it. Pick Eaon Lite in the model picker instead.'
