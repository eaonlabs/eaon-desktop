import type { McpTool } from '@shared/types'
import { store } from './store'
import { capOutput, registerToolSource, type AgentTool } from './agent/tools'

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
export async function runWebSearch(args: Record<string, unknown>): Promise<string> {
  const query = String(args.query ?? '').trim()
  if (!query) return 'No search query was provided.'

  const { enabled, largeSnippets } = searchMode()
  if (!enabled) return 'Web search is turned off in Settings → Configuration.'

  const site = typeof args.site === 'string' && args.site.trim() ? args.site.trim() : undefined

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS)
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
  }
}

/* ---------------------------------------------------------------- web_fetch */

const FETCH_LIMIT = 24_000

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

async function fetchPage(args: Record<string, unknown>): Promise<string> {
  const url = String(args.url ?? '').trim()
  if (!/^https?:\/\//i.test(url)) return 'Pass a full http(s) URL.'
  const response = await fetch(url, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130 Safari/537.36 Eaon',
      Accept: 'text/html,application/json,text/plain;q=0.9,*/*;q=0.5'
    },
    redirect: 'follow',
    signal: AbortSignal.timeout(TIMEOUT_MS)
  })
  const type = response.headers.get('content-type') ?? ''
  if (!response.ok) return `Fetching ${url} failed: HTTP ${response.status}.`
  if (!/text|json|xml|javascript/.test(type)) return `${url} is ${type || 'binary'} content, which cannot be read as text.`
  const raw = await response.text()
  const text = /html/.test(type) ? htmlToText(raw) : raw
  const offset = Math.max(0, Number(args.offset) || 0)
  const slice = text.slice(offset, offset + FETCH_LIMIT)
  const more = text.length > offset + FETCH_LIMIT ? `\n\n…[${(text.length - offset - FETCH_LIMIT).toLocaleString()} more characters — call again with offset ${offset + FETCH_LIMIT}]` : ''
  return `${response.url}\n\n${slice}${more}`
}

const webSearchTool = (): AgentTool => {
  const [spec] = webSearchTools()
  return {
    ...spec,
    mutating: false,
    describe: (input) => String(input.query ?? ''),
    run: (input) => runWebSearch(input)
  }
}

const webFetchTool: AgentTool = {
  name: 'web_fetch',
  description: 'Read a web page (or JSON/text URL) as plain text. Use after web_search to read a result in full, or for any URL the user gives.',
  inputSchema: {
    type: 'object',
    properties: {
      url: { type: 'string' },
      offset: { type: 'number', description: 'Character offset to continue a long page' }
    },
    required: ['url']
  },
  mutating: false,
  describe: (input) => String(input.url ?? ''),
  run: (input) => fetchPage(input)
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
