/** The built-in browser's address bar: what a typed line opens. */

export const SEARCH_ENGINES = {
  DuckDuckGo: 'https://duckduckgo.com/?q=',
  Google: 'https://www.google.com/search?q=',
  Bing: 'https://www.bing.com/search?q='
} as const

export type SearchEngine = keyof typeof SEARCH_ENGINES

export const isSearchEngine = (value: unknown): value is SearchEngine =>
  typeof value === 'string' && Object.prototype.hasOwnProperty.call(SEARCH_ENGINES, value)

/**
 * A URL as typed, a bare domain made https, `localhost:3000` made http, and
 * anything else searched for. Null for an empty line.
 */
export function toBrowserUrl(input: string, engine: SearchEngine = 'DuckDuckGo'): string | null {
  const text = input.trim()
  if (!text) return null
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(text) || /^(about|data|file):/i.test(text)) return text
  if (/^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?([/?#].*)?$/i.test(text)) return `http://${text}`
  // A host whose last label is a name (example.com, not 1.5) or an IPv4 address.
  if (/^([\w-]+\.)+[a-z][a-z0-9-]*(:\d+)?([/?#]\S*)?$/i.test(text) || /^\d{1,3}(\.\d{1,3}){3}(:\d+)?([/?#]\S*)?$/.test(text)) {
    return `https://${text}`
  }
  return `${SEARCH_ENGINES[engine]}${encodeURIComponent(text)}`
}
