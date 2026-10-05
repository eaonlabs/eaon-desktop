/**
 * Matching an approval the user gave for one call against the call the
 * agent then makes. An approve-once grant (a worker's ask_user with
 * approve_tool / approve_input) must cover exactly one action: the same
 * tool, with the same arguments, compared so that only differences that
 * change what happens count.
 *
 * Not differences: the order of an object's keys, a namespace the model put
 * in front of the tool's name when it named it as data (`functions.x`,
 * `default_api.x`), how the provider spelled a number (`1` and `1.0` parse
 * the same), or a key whose value is undefined.
 *
 * Differences: any character of a string (whitespace included — `rm a b`
 * is not `rm  a b` to every program), a number sent as a string, an array's
 * order, a key that is present versus missing, null versus absent.
 */

/**
 * A tool's own name, without the namespace some models put in front of it
 * when they name a tool as data: GPT-style models write "functions.email_send"
 * in ask_user's approve_tool, Gemini "default_api.email_send". Compared
 * literally, an approval for "functions.email_send" never matched the real
 * call to email_send (Oct 1 2026). Real tool names can't contain `.`, `:` or
 * `/` (see safeToolName), so stripping one such prefix can't merge two tools.
 */
export function bareToolName(name: unknown): string {
  return String(name ?? '')
    .trim()
    .replace(/^(functions|default_api|tools?|api)[.:/]/i, '')
}

/** JSON with object keys sorted at every level, so key order never matters. */
export function canonicalJson(value: unknown): string {
  if (value === null || value === undefined) return 'null'
  if (typeof value === 'number') return Number.isFinite(value) ? JSON.stringify(value === 0 ? 0 : value) : 'null'
  if (typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value)
  if (typeof value === 'bigint') return value.toString()
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  if (typeof value === 'object') {
    const record = value as Record<string, unknown>
    const keys = Object.keys(record)
      .filter((key) => record[key] !== undefined && typeof record[key] !== 'function')
      .sort()
    return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(',')}}`
  }
  // Functions and symbols have no JSON form; they never come from a model.
  return 'null'
}

/** The key one approved call is stored under, and a later call is looked up by. */
export function approvalKey(tool: unknown, input: unknown): string {
  return `${bareToolName(tool)}\u0000${canonicalJson(input)}`
}

/** Whether a call is the one the user approved. */
export function sameCall(approved: { tool: unknown; input: unknown }, call: { tool: unknown; input: unknown }): boolean {
  return approvalKey(approved.tool, approved.input) === approvalKey(call.tool, call.input)
}
