/** Addresses in the in-app browser: what the address bar makes of what was typed, and how a tab names a page. */

/** What the address bar makes of what was typed: an address, a dev server's port, or a search. */
export function toUrl(input: string): string | null {
  const text = input.trim()
  if (!text) return null
  if (/^[a-z][a-z\d+.-]*:\/\//i.test(text) || /^(about|data|file):/i.test(text)) return text
  if (/^\d{2,5}$/.test(text)) return `http://localhost:${text}`
  if (/^(localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\]|[\w-]+\.local)(:\d+)?([/?#].*)?$/i.test(text)) return `http://${text}`
  if (/^[\w-]+(\.[\w-]+)+(:\d+)?([/?#].*)?$/.test(text) && !/\s/.test(text)) return `https://${text}`
  return `https://duckduckgo.com/?q=${encodeURIComponent(text)}`
}

export function hostOf(url: string): string {
  try {
    const parsed = new URL(url)
    return parsed.host.replace(/^www\./, '') || url
  } catch {
    return url || 'New tab'
  }
}

export const isLocalUrl = (url: string): boolean => /^https?:\/\/(localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1?\]|[\w-]+\.local)(:\d+)?(\/|$)/i.test(url)
