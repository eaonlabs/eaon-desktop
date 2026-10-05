/**
 * `fetch` for requests that carry a provider's credentials.
 *
 * A fetch follows redirects by itself and strips `Authorization` when the
 * target is another origin, but not `x-api-key`, `api-key`, `x-goog-api-key`
 * or any other header a provider takes its key in. A custom endpoint (or a
 * compromised one) that answers 307 with another site's address would
 * receive the key. So redirects are handled here: one to the same origin is
 * followed (a trailing-slash or path move), one to another origin is refused
 * with a message saying so, and the credentials never go anywhere the user
 * didn't point them.
 */

/** Thrown when a provider tries to send the request, and so the key, to another site. */
export class RedirectRefusedError extends Error {
  constructor(
    readonly from: string,
    readonly to: string
  ) {
    super(`${hostOf(from)} redirected the request to ${hostOf(to)}. Eaon doesn’t send your key to another address, so the request was stopped. Check the base URL.`)
    this.name = 'RedirectRefusedError'
  }
}

const hostOf = (url: string): string => {
  try {
    return new URL(url).host
  } catch {
    return url
  }
}

const MAX_REDIRECTS = 3

export async function providerFetch(url: string | URL, init: RequestInit = {}): Promise<Response> {
  let target = String(url)
  let method = init.method ?? 'GET'
  let body = init.body
  for (let hops = 0; ; hops++) {
    const response = await fetch(target, { ...init, method, body, redirect: 'manual' })
    // A manual redirect comes back as the 3xx response itself, with its Location.
    if (response.status < 300 || response.status >= 400 || response.status === 304) return response
    const location = response.headers.get('location')
    if (!location) return response
    const next = new URL(location, target).href
    if (new URL(next).origin !== new URL(target).origin) throw new RedirectRefusedError(target, next)
    // 307 and 308 keep the method and body; the older codes turn a POST into a GET, which a model request can't survive.
    const keeps = response.status === 307 || response.status === 308
    if (!keeps && method !== 'GET' && method !== 'HEAD') return response
    if (hops >= MAX_REDIRECTS) throw new Error(`${hostOf(target)} redirected the request too many times.`)
    // Drain the redirect's own body so the connection is freed.
    await response.body?.cancel().catch(() => {})
    target = next
    if (!keeps) body = undefined
  }
}

/** The shape the Anthropic SDK takes for its `fetch` option. */
export const sdkFetch = (input: string | URL | Request, init?: RequestInit): Promise<Response> =>
  providerFetch(input instanceof Request ? input.url : input, init)
