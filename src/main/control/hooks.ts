import type { IncomingMessage, ServerResponse } from 'node:http'
import { audit } from '../enterprise/audit'

/**
 * Automations' webhooks, on the Local API Server that already runs:
 *
 *   POST /hooks/automation/<secret>    start that automation; the body, if any, is its input
 *
 * Nothing new listens: this is one more route on the server bound to
 * 127.0.0.1, behind the same Host and Origin checks as the rest of it, so only
 * apps on this computer reach it. The secret in the address is the key, one per
 * automation and off until the user makes it (features/scheduler/hooks.ts), so
 * the model key and the control key don't open it and it opens nothing else.
 * The body is data for the run (fenced and labelled as untrusted there), never
 * instructions, and is read only up to `MAX_HOOK_BYTES`.
 */

export const HOOK_PREFIX = '/hooks/'
const ROUTE = /^\/hooks\/automation\/([A-Za-z0-9_-]{16,128})\/?$/
export const MAX_HOOK_BYTES = 256 * 1024
/** Wrong secrets past this many in a minute are answered 429 until the minute is out. */
export const MAX_MISSES_PER_MINUTE = 20

/** A refusal with the status to answer it with, and a sentence for whoever called. */
export class HookError extends Error {
  constructor(
    readonly status: number,
    message: string
  ) {
    super(message)
  }
}

export interface HookTarget {
  /** Starts the automation this secret belongs to with `text` as its input; throws `HookError` when it can't. */
  start: (secret: string, text: string) => { automation: string; runId: string }
}

let target: HookTarget | null = null
let misses: number[] = []

/** The scheduler says it is running (or not). */
export function setHookTarget(next: HookTarget | null): void {
  target = next
}

/**
 * The body as the run's input text: JSON is laid out readably, anything else
 * is taken as it is. A body that says it is JSON and isn't is refused rather
 * than guessed at.
 */
export function hookInputText(contentType: string | undefined, raw: string): string {
  const body = raw.trim()
  if (!body) return ''
  const json = /json/i.test(contentType ?? '')
  if (json || body.startsWith('{') || body.startsWith('[')) {
    try {
      return JSON.stringify(JSON.parse(body), null, 2)
    } catch {
      if (json) throw new HookError(400, 'The body says it is JSON but isn’t valid JSON.')
    }
  }
  return body
}

function reply(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  res.writeHead(status, { 'Content-Type': 'application/json', ...headers })
  res.end(JSON.stringify(body))
}

async function readText(req: IncomingMessage): Promise<string> {
  if (Number(req.headers['content-length'] ?? 0) > MAX_HOOK_BYTES) throw new HookError(413, `The body is larger than ${MAX_HOOK_BYTES / 1024} KB.`)
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req) {
    size += (chunk as Buffer).byteLength
    if (size > MAX_HOOK_BYTES) throw new HookError(413, `The body is larger than ${MAX_HOOK_BYTES / 1024} KB.`)
    chunks.push(chunk as Buffer)
  }
  return Buffer.concat(chunks).toString('utf8')
}

/**
 * Answers a `/hooks/*` request. Returns false for any other path, so the
 * caller carries on with its own routes. The address is never written to a
 * log or echoed back: it holds the secret.
 */
export async function handleHook(req: IncomingMessage, res: ServerResponse, pathname: string, now: () => number = Date.now): Promise<boolean> {
  if (!pathname.startsWith(HOOK_PREFIX)) return false
  const secret = ROUTE.exec(pathname)?.[1]
  const recent = misses.filter((at) => at > now() - 60_000)
  misses = recent
  if (recent.length >= MAX_MISSES_PER_MINUTE) {
    reply(res, 429, { error: { message: 'Too many calls to webhooks that don’t exist. Try again in a minute.' } }, { 'Retry-After': '60' })
    return true
  }
  const miss = (): true => {
    misses.push(now())
    audit('automation_hook.rejected', {}, { via: 'local-api', outcome: 'failure' })
    reply(res, 404, { error: { message: 'No such webhook.' } })
    return true
  }
  if (!secret) return miss()
  if (!target) {
    reply(res, 503, { error: { message: 'Eaon’s automations aren’t running.' } })
    return true
  }
  if (req.method !== 'POST') {
    reply(res, 405, { error: { message: 'Webhooks answer POST.' } }, { Allow: 'POST' })
    return true
  }
  try {
    const text = hookInputText(req.headers['content-type'], await readText(req))
    const started = target.start(secret, text)
    audit('automation_hook.started', { automation: started.automation }, { via: 'local-api' })
    reply(res, 202, { started: true, automation: started.automation, runId: started.runId })
  } catch (error) {
    if (error instanceof HookError) {
      if (error.status === 404) return miss()
      reply(res, error.status, { error: { message: error.message } })
      if (error.status === 413) res.once('finish', () => req.destroy())
    } else {
      console.error('[automation-hook] a call failed:', error instanceof Error ? error.message : error)
      reply(res, 500, { error: { message: 'Eaon could not start the automation.' } })
    }
  }
  return true
}

/** For tests: forget the wrong guesses counted so far. */
export function resetHookMisses(): void {
  misses = []
}
