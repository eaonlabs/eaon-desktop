import type { McpTool } from '@shared/types'
import { store } from './store'
import { capOutput, registerToolSource, type AgentTool } from './agent/tools'
import { isPrivateHostname, privateAddressOf, resolveAll, targetsPrivateNetwork, type Resolver } from './netGuard'

/**
 * Web search, backed by the MIKLIUM search API (https://miklium.vercel.app/api/search).
 *
 * Free and keyless, which is why it suits a BYOK app: the user already supplies
 * a model key, and asking them for a second search key just to let the model
 * look something up would be a poor trade. The API wraps Yahoo Search and can
 * additionally scrape full page text.
 *
 * Unlike the Eaon Work tools in `localTools.ts`, this is available in ordinary
 * chat too — a model wanting current information is not a coding-mode concern.
 */

const ENDPOINT = 'https://miklium.vercel.app/api/search'

/** Scraping full pages is slow; the request is capped rather than left to hang. */
const TIMEOUT_MS = 30_000

export const WEB_SEARCH_TOOL = 'web_search'

/** One row of the API's `results` array for a `type: 'default'` search. */
interface SearchResult {
  query?: string
  url?: string
  /** `short` is the engine's own description, `long` a full-text scrape. */
  type?: string
  snippet?: string
  symbols?: number
}

/**
 * The Configuration page's "Web search" setting, mapped onto what the API can
 * actually vary. `Off` withholds the tool entirely; the other two differ in
 * whether full page text is scraped, which is the slow part of a request.
 */
function searchMode(): { enabled: boolean; largeSnippets: number } {
  const mode = store.getSettings().configuration.webSearch
  if (mode === 'Off') return { enabled: false, largeSnippets: 0 }
  // "Cached" takes the search engine's own snippets only — fast, no scraping.
  if (mode === 'Cached') return { enabled: true, largeSnippets: 0 }
  return { enabled: true, largeSnippets: 2 }
}

/** The tool offered to the model, or nothing when web search is switched off. */
export function webSearchTools(): McpTool[] {
  if (!searchMode().enabled) return []
  return [
    {
      name: WEB_SEARCH_TOOL,
      description:
        'Search the web for current information. Use this whenever the answer depends on something recent, changeable, or outside your training data — news, releases, prices, documentation, or any claim the user expects to be up to date. Returns page snippets with their source URLs, which you should cite.',
      serverId: 'web',
      inputSchema: {
        type: 'object',
        properties: {
          query: {
            type: 'string',
            description: 'What to search for, phrased as a search query rather than a question'
          },
          site: {
            type: 'string',
            description: 'Optional: restrict results to one domain, e.g. "wikipedia.org"'
          }
        },
        required: ['query']
      }
    }
  ]
}

export function isWebSearchTool(name: string): boolean {
  return name === WEB_SEARCH_TOOL
}

/**
 * Runs a search and formats it for the model: numbered results, each with its
 * source URL, so the reply can attribute claims to a page. Returns a plain
 * sentence rather than throwing on an empty result — a model handles "nothing
 * found" far better than a tool error, and can simply rephrase and retry.
 */
export async function runWebSearch(args: Record<string, unknown>, signal?: AbortSignal): Promise<string> {
  const query = String(args.query ?? '').trim()
  if (!query) return 'No search query was provided.'

  const { enabled, largeSnippets } = searchMode()
  if (!enabled) return 'Web search is turned off in Settings → Configuration.'

  const site = typeof args.site === 'string' && args.site.trim() ? args.site.trim() : undefined

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS)
  // Stop cancels the request too, rather than leaving it to run out its timeout.
  const stop = (): void => controller.abort()
  signal?.addEventListener('abort', stop, { once: true })
  try {
    const response = await fetch(ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      signal: controller.signal,
      body: JSON.stringify({
        search: [query],
        type: 'default',
        maxSmallSnippets: 5,
        maxLargeSnippets: largeSnippets,
        ...(site ? { site } : {})
      })
    })

    if (!response.ok) {
      return `Web search failed (HTTP ${response.status}). Answer from what you know, and say the search was unavailable.`
    }

    const payload = (await response.json()) as { results?: SearchResult[]; error?: string }
    if (payload.error) return `Web search failed: ${payload.error}`

    const results = (payload.results ?? []).filter((r) => r.snippet && r.url)
    if (results.length === 0) return `No web results for "${query}".`

    // Scraped page text can run to tens of thousands of characters a result;
    // each is capped so one verbose page cannot crowd out the rest.
    const body = results
      .map((result, index) => `[${index + 1}] ${result.url}\n${capOutput((result.snippet ?? '').trim(), 3000)}`)
      .join('\n\n')
    return `Web results for "${query}":\n\n${body}`
  } catch (error) {
    // A timeout surfaces as an AbortError; both cases are reported to the model
    // as a result so the turn continues instead of failing outright.
    const reason = error instanceof Error && error.name === 'AbortError' ? 'timed out' : String(error)
    return `Web search ${reason}. Answer from what you know, and say the search was unavailable.`
  } finally {
    clearTimeout(timer)
    signal?.removeEventListener('abort', stop)
  }
}

/* ---------------------------------------------------------------- web_fetch */

const FETCH_LIMIT = 24_000
/** Bytes of a body read at most. A URL can be a multi-gigabyte file, and only 24k characters of it are shown at a time. */
const FETCH_MAX_BYTES = 5 * 1024 * 1024

async function readCapped(response: Response): Promise<{ text: string; cut: boolean }> {
  const reader = response.body?.getReader()
  if (!reader) return { text: await response.text(), cut: false }
  const chunks: Uint8Array[] = []
  let size = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    chunks.push(value)
    size += value.byteLength
    if (size >= FETCH_MAX_BYTES) {
      await reader.cancel().catch(() => {})
      return { text: new TextDecoder().decode(Buffer.concat(chunks).subarray(0, FETCH_MAX_BYTES)), cut: true }
    }
  }
  return { text: new TextDecoder().decode(Buffer.concat(chunks)), cut: false }
}

/**
 * Reduces an HTML page to its readable text: scripts, styles, navigation and
 * markup go, headings and list items keep a marker so the structure survives.
 * Crude next to a real readability pass, and far cheaper in tokens than
 * handing the model raw HTML.
 */
export function htmlToText(html: string): string {
  return html
    .replace(/<(script|style|noscript|svg|nav|footer|header|form|iframe)[^>]*>[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<h([1-6])[^>]*>/gi, (_m, level: string) => `\n\n${'#'.repeat(Number(level))} `)
    .replace(/<li[^>]*>/gi, '\n- ')
    .replace(/<(br|\/p|\/div|\/tr|\/h[1-6]|\/li|\/section|\/article)[^>]*>/gi, '\n')
    .replace(/<a [^>]*href="(http[^"]+)"[^>]*>([\s\S]*?)<\/a>/gi, (_m, href: string, label: string) => `${label.replace(/<[^>]+>/g, '')} (${href})`)
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/[ \t]+/g, ' ')
    .replace(/\n\s*\n\s*\n+/g, '\n\n')
    .trim()
}

/** Redirects followed at most, as browsers do (they allow 20; pages that need more are broken). */
const MAX_REDIRECTS = 10

export interface FetchPageOptions {
  /** DNS, replaceable in tests. */
  resolve?: Resolver
  /** Which addresses count as private, replaceable in tests (whose servers are all on loopback). */
  isPrivateHost?: (hostname: string) => boolean
}

/**
 * Why web_fetch won't go to `url`, or null when it may. The one private host
 * a call may reach is the one its own URL names — that call was approved as
 * a local fetch (see the tool's `mutating`). Anywhere else on this computer
 * or the local network, reached by a redirect or through a public-looking
 * name that resolves there, is refused: that is how a page the agent reads
 * would make it fetch the router, a dev server's admin route, or a service
 * on localhost that trusts whatever reaches it.
 */
async function refusal(url: URL, approvedHost: string | null, options: FetchPageOptions): Promise<string | null> {
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return `web_fetch reads only http(s) pages, and ${url.href.slice(0, 200)} is not one.`
  if (url.username || url.password) return 'web_fetch does not send credentials written into a URL.'
  if (approvedHost !== null && url.host === approvedHost) return null
  const isPrivate = options.isPrivateHost ?? isPrivateHostname
  if (isPrivate(url.hostname)) {
    return `${url.host} is on this computer or the local network, and this call was for ${approvedHost ?? 'a public page'}, so it was not fetched. To read a page there, call web_fetch with that address itself, so the user can approve it.`
  }
  const address = options.isPrivateHost ? null : await privateAddressOf(url.hostname, options.resolve ?? resolveAll)
  if (address) {
    return `${url.hostname} points to ${address}, which is on this computer or the local network, so it was not fetched. To read a page there, call web_fetch with the local address itself, so the user can approve it.`
  }
  return null
}

export async function fetchPage(args: Record<string, unknown>, signal?: AbortSignal, options: FetchPageOptions = {}): Promise<string> {
  const requested = String(args.url ?? '').trim()
  if (!/^https?:\/\//i.test(requested)) return 'Pass a full http(s) URL.'
  let url: URL
  try {
    url = new URL(requested)
  } catch {
    return `${requested.slice(0, 200)} is not a valid URL.`
  }
  // A URL that itself names a local address was approved as such (it is
  // mutating and risky, below); that host, and only that host, may be read.
  const approvedHost = (options.isPrivateHost ?? isPrivateHostname)(url.hostname) ? url.host : null
  const deadline = signal ? AbortSignal.any([signal, AbortSignal.timeout(TIMEOUT_MS)]) : AbortSignal.timeout(TIMEOUT_MS)
  let response: Response | null = null
  // Redirects are followed by hand so that every hop is checked, not only the first.
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    const refused = await refusal(url, approvedHost, options)
    if (refused) return refused
    response = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130 Safari/537.36 Eaon',
        Accept: 'text/html,application/json,text/plain;q=0.9,*/*;q=0.5'
      },
      redirect: 'manual',
      signal: deadline
    })
    const location = response.headers.get('location')
    if (response.status < 300 || response.status > 399 || !location) break
    await response.body?.cancel().catch(() => {})
    try {
      url = new URL(location, url)
    } catch {
      return `${url.href} redirected to an address that isn't valid.`
    }
    if (hop === MAX_REDIRECTS) return `${requested} redirected more than ${MAX_REDIRECTS} times, so it was not followed further.`
  }
  if (!response) return `Fetching ${requested} failed.`
  const type = response.headers.get('content-type') ?? ''
  if (!response.ok) return `Fetching ${url.href} failed: HTTP ${response.status}.`
  if (!/text|json|xml|javascript/.test(type)) return `${url.href} is ${type || 'binary'} content, which cannot be read as text.`
  const { text: raw, cut } = await readCapped(response)
  const text = /html/.test(type) ? htmlToText(raw) : raw
  const offset = Math.max(0, Number(args.offset) || 0)
  const slice = text.slice(offset, offset + FETCH_LIMIT)
  const more = text.length > offset + FETCH_LIMIT ? `\n\n…[${(text.length - offset - FETCH_LIMIT).toLocaleString()} more characters — call again with offset ${offset + FETCH_LIMIT}]` : ''
  const cutNote = cut ? `\n\n(Only the first ${FETCH_MAX_BYTES / 1024 / 1024} MB of this URL were read.)` : ''
  return `${url.href}\n\n${slice}${more}${cutNote}`
}

const webSearchTool = (): AgentTool => {
  const [spec] = webSearchTools()
  return {
    ...spec,
    mutating: false,
    describe: (input) => String(input.query ?? ''),
    run: (input, ctx) => runWebSearch(input, ctx.signal)
  }
}

const webFetchTool: AgentTool = {
  name: 'web_fetch',
  description:
    'Read a web page (or JSON/text URL) as plain text. Use after web_search to read a result in full, or for any URL the user gives. A page on this computer or the local network (localhost, 192.168.x.x) needs the user\'s approval.',
  inputSchema: {
    type: 'object',
    properties: {
      url: { type: 'string' },
      offset: { type: 'number', description: 'Character offset to continue a long page' }
    },
    required: ['url']
  },
  // Reading a public page changes nothing. A page on this computer or the
  // local network is another matter (an admin route, a service that trusts
  // whatever reaches it), so a URL naming one goes through approval like a
  // change: asked about, refused in plan mode and read-only runs.
  mutating: (input) => targetsPrivateNetwork(input.url),
  risky: (input) => targetsPrivateNetwork(input.url),
  describe: (input) => String(input.url ?? ''),
  run: (input, ctx) => fetchPage(input, ctx.signal)
}

// Chat's only tool is web search, by design: the chat product is a clean
// assistant, and every tool schema offered is paid for on every request.
registerToolSource({
  id: 'web',
  tools: (query) => {
    if (!searchMode().enabled) return query.mode === 'work' ? [webFetchTool] : []
    return query.mode === 'work' ? [webSearchTool(), webFetchTool] : [webSearchTool()]
  }
})
