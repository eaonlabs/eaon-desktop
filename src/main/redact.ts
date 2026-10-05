/**
 * Blanks credentials out of text that is written to a log or shown as
 * "details": API keys, bearer tokens, OAuth codes and tokens in URLs, bot
 * tokens, private keys, card numbers. Logs outlive the session, sit in
 * plain files, and get pasted into bug reports; none of that should carry a
 * key. Each match keeps a few characters so a log still says which key it
 * was.
 *
 * A pattern list, like the command risk list: it catches the shapes keys
 * actually come in, not every secret a program could print.
 */

const keep = (value: string, head = 4): string => `${value.slice(0, head)}…[redacted]`

/** Vendor key shapes, matched anywhere in text. */
const KEYS: RegExp[] = [
  /\bsk-(?:ant-|proj-|or-v1-|svcacct-)?[A-Za-z0-9_-]{16,}/g, // Anthropic, OpenAI, OpenRouter
  /\beaon-[A-Za-z0-9_-]{20,}/g, // the gateway's own key
  /\b(?:ghp|gho|ghu|ghs|ghr|github_pat)_[A-Za-z0-9_]{20,}/g, // GitHub
  /\bxox[abprs]-[A-Za-z0-9-]{10,}/g, // Slack
  /\bAIza[0-9A-Za-z_-]{30,}/g, // Google
  /\bAKIA[0-9A-Z]{16}\b/g, // AWS access key id
  /\bgsk_[A-Za-z0-9]{20,}/g, // Groq
  /\bhf_[A-Za-z0-9]{20,}/g, // Hugging Face
  /\bxai-[A-Za-z0-9]{20,}/g, // xAI
  /\bpplx-[A-Za-z0-9]{20,}/g, // Perplexity
  /\b(?:sk|rk|pk)_(?:live|test)_[A-Za-z0-9]{16,}/g, // Stripe
  /(?<=\bbot|\b)\d{6,12}:[A-Za-z0-9_-]{30,}/g, // Telegram bot token, bare or in an API path
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g // JWT
]

/** Luhn, so ordinary long numbers (ids, timestamps) are left alone. */
function luhn(digits: string): boolean {
  let sum = 0
  for (let i = 0; i < digits.length; i++) {
    let d = Number(digits[digits.length - 1 - i])
    if (i % 2 === 1) {
      d *= 2
      if (d > 9) d -= 9
    }
    sum += d
  }
  return sum % 10 === 0
}

export function redactSecrets(text: string): string {
  if (!text) return text
  let out = text
  // Private keys, whole.
  out = out.replace(/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(-----END [A-Z ]*PRIVATE KEY-----|$)/g, '[private key redacted]')
  // Authorization headers and their kin, in any quoting.
  out = out.replace(/\b(authorization|proxy-authorization)(["']?\s*[:=]\s*["']?)(bearer|basic|token)?(\s*)([^\s"',}]{6,})/gi, (_m, name: string, sep: string, scheme: string | undefined, space: string, value: string) =>
    `${name}${sep}${scheme ?? ''}${space}${keep(value)}`
  )
  out = out.replace(/\b(bearer)\s+([A-Za-z0-9._~+/=-]{12,})/gi, (_m, scheme: string, value: string) => `${scheme} ${keep(value)}`)
  // Header and field names that carry a key, in JSON, headers or env lines.
  out = out.replace(
    /\b(x-api-key|api[-_]?key|apikey|x-goog-api-key|access[-_]?token|refresh[-_]?token|id[-_]?token|client[-_]?secret|secret|password|passwd|token)(["']?\s*[:=]\s*["']?)([^\s"'&,}]{6,})/gi,
    (_m, name: string, sep: string, value: string) => `${name}${sep}${keep(value)}`
  )
  // Credentials in URLs: user:password@ and key-bearing query parameters.
  out = out.replace(/(\b[a-z][a-z0-9+.-]*:\/\/)([^\s/:@]+):([^\s/@]+)@/gi, (_m, scheme: string, user: string) => `${scheme}${user}:[redacted]@`)
  out = out.replace(/([?&#](?:key|api_key|apikey|token|access_token|refresh_token|code|client_secret|sig|signature|password)=)([^&#\s"']+)/gi, (_m, name: string, value: string) =>
    `${name}${keep(value, 2)}`
  )
  for (const pattern of KEYS) out = out.replace(pattern, (match) => keep(match, match.startsWith('sk-') || match.startsWith('eaon-') ? 7 : 4))
  // Card numbers: 13–19 digits, spaced or dashed, that pass Luhn.
  out = out.replace(/\b\d(?:[ -]?\d){12,18}\b/g, (match) => {
    const digits = match.replace(/\D/g, '')
    return digits.length >= 13 && digits.length <= 19 && luhn(digits) ? `•••• ${digits.slice(-4)}` : match
  })
  return out
}
