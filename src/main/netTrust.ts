import * as http from 'node:http'
import * as tls from 'node:tls'

/**
 * Makes the main process's own requests (Node's `fetch`: providers, the
 * Anthropic SDK, Eaon Event, the model catalog) trust what the computer trusts
 * and go where the computer's proxy says, as the browser windows already do.
 *
 * Certificates: Node ships its own list of root certificates and ignores the
 * operating system's. School and company laptops often sit behind a filter
 * (GoGuardian, Securly, Zscaler) that re-signs every HTTPS connection with a
 * root the IT department installed in the system store; to Node every request
 * then fails with SELF_SIGNED_CERT_IN_CHAIN. Adding the system's roots to
 * Node's own (never replacing them) makes those networks work and changes
 * nothing anywhere else.
 *
 * Proxy: Node's `fetch` ignores HTTPS_PROXY and HTTP_PROXY unless told to
 * read them. When one is set, the built-in proxy support is switched on with
 * the same variables, with this computer's loopback addresses always going
 * direct: a local model server or Eaon's own gateway is never behind a proxy.
 *
 * Both are best effort: a Node without the API, or a store that can't be
 * read, leaves things as they were.
 */

const LOOPBACK = ['localhost', '127.0.0.1', '::1', '[::1]']

type CaApi = {
  getCACertificates?: (type?: 'default' | 'system' | 'bundled' | 'extra') => string[]
  setDefaultCACertificates?: (certs: string[]) => void
}

type ProxyApi = { setGlobalProxyFromEnv?: (env?: NodeJS.ProcessEnv) => () => void }

/** Adds the operating system's trusted roots to Node's defaults. True when it did. */
export function trustSystemCertificates(api: CaApi = tls as CaApi): boolean {
  if (typeof api.getCACertificates !== 'function' || typeof api.setDefaultCACertificates !== 'function') return false
  try {
    const current = api.getCACertificates('default')
    const system = api.getCACertificates('system')
    if (system.length === 0) return false
    api.setDefaultCACertificates([...new Set([...current, ...system])])
    return true
  } catch (error) {
    console.warn('[net] could not add the system certificates:', error instanceof Error ? error.message : error)
    return false
  }
}

/** The proxy variables to hand Node, with loopback added to NO_PROXY; null when no proxy is set. */
export function proxyEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv | null {
  const proxy = env.HTTPS_PROXY || env.https_proxy || env.HTTP_PROXY || env.http_proxy
  if (!proxy) return null
  const noProxy = env.NO_PROXY ?? env.no_proxy ?? ''
  const listed = new Set(noProxy.split(',').map((entry) => entry.trim().toLowerCase()).filter(Boolean))
  const extra = LOOPBACK.filter((host) => !listed.has(host))
  const joined = [noProxy.trim(), ...extra].filter(Boolean).join(',')
  const next: NodeJS.ProcessEnv = { ...env, NO_PROXY: joined }
  delete next.no_proxy
  return next
}

/** Sends Node's own requests through the proxy in HTTPS_PROXY / HTTP_PROXY, when one is set. True when it did. */
export function useEnvironmentProxy(env: NodeJS.ProcessEnv = process.env, api: ProxyApi = http as ProxyApi): boolean {
  const config = proxyEnv(env)
  if (!config || typeof api.setGlobalProxyFromEnv !== 'function') return false
  try {
    api.setGlobalProxyFromEnv(config)
    return true
  } catch (error) {
    // A malformed proxy address: going direct beats failing every request.
    console.warn('[net] ignoring the proxy settings:', error instanceof Error ? error.message : error)
    return false
  }
}

let applied = false

/** Once, at startup, before the first request. */
export function trustSystemNetwork(): void {
  if (applied) return
  applied = true
  trustSystemCertificates()
  useEnvironmentProxy()
}
