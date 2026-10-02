import type { McpServerStatus } from './types'

/** What a browser sign-in came back with. */
export interface PluginSignInResult {
  ok: boolean
  error?: string
  /**
   * The server offers no Dynamic Client Registration, so the user has to
   * create an OAuth app with the vendor and enter its client id (and secret).
   */
  needsClientId?: boolean
  statuses: McpServerStatus[]
}

/** A browser sign-in target: a catalog plugin, or a hand-added HTTP server. */
export type SignInTarget = { pluginId: string } | { serverId: string }

export interface ManualClient {
  clientId: string
  clientSecret?: string
}

/**
 * A stdio server's arguments as typed in one field. Whitespace separates
 * them; a token that opens with a quote runs to the matching quote, so a path
 * with spaces can be one argument. Quotes inside a token are kept as typed —
 * `{"key":1}` stays JSON — and backslashes are never escapes, since they are
 * Windows path separators.
 */
export function splitArgs(text: string): string[] {
  const args: string[] = []
  let current = ''
  let started = false
  let quote: string | null = null
  for (let i = 0; i < text.length; i++) {
    const c = text[i]
    if (quote) {
      if (c === quote) quote = null
      else if (quote === '"' && c === '\\' && text[i + 1] === '"') current += text[++i]
      else current += c
    } else if (!started && (c === '"' || c === "'")) {
      quote = c
      started = true
    } else if (/\s/.test(c)) {
      if (started) args.push(current)
      current = ''
      started = false
    } else {
      current += c
      started = true
    }
  }
  if (started) args.push(current)
  return args
}

/** The inverse of `splitArgs`, for showing saved arguments in that field again. */
export function joinArgs(args: string[]): string {
  return args
    .map((arg) => {
      if (arg !== '' && !/\s/.test(arg) && !/^["']/.test(arg)) return arg
      return arg.includes('"') && !arg.includes("'") ? `'${arg}'` : `"${arg.replace(/"/g, '\\"')}"`
    })
    .join(' ')
}
