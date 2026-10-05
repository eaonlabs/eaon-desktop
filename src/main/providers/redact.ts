/**
 * Keys, bearer tokens and long secret-looking strings out of text that may be
 * shown, logged or copied (provider error bodies, "Copy details").
 *
 * TODO(merge): the security branch adds `src/main/redact.ts` with its own
 * `redactSecrets`. Once both are on one branch, import that one here and
 * delete this body, so there is a single implementation. The call sites are
 * `describeErrorBody` (adapters/types.ts), `errors.ts`, the OAuth token
 * errors (oauth/codex.ts, oauth/copilot.ts) and the loop's error event.
 */
export function redactSecrets(text: string): string {
  return text
    .replace(/([?&](?:key|api_key|apikey|token|access_token)=)[^&\s]+/gi, '$1[redacted]')
    .replace(/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{8,}/gi, '$1 [redacted]')
    .replace(/\b(sk|rk|pk|gsk|xai|hf|ghu|gho|ghp|github_pat|csk|nvapi|pplx|fw|tgp)[-_][A-Za-z0-9._-]{8,}/g, '[redacted key]')
    .replace(/\bAIza[0-9A-Za-z_-]{20,}/g, '[redacted key]')
    .replace(/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{5,}/g, '[redacted token]')
}
