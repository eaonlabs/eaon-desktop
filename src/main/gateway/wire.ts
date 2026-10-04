import { randomBytes } from 'node:crypto'
import type { ServerResponse } from 'node:http'
import type { EffortLevel } from '@shared/types'
import type { NeutralImage, NeutralMessage, NeutralToolCall } from '../providers/adapters/types'

/** Pieces every wire format of the gateway shares. */

export const newId = (prefix: string): string => `${prefix}${randomBytes(12).toString('hex')}`

/**
 * A tool call id the app will accept back. Anthropic clients validate ids
 * (`[a-zA-Z0-9_-]`); some providers send none, or ones with other characters.
 */
export function clientToolId(id: string | undefined, prefix: string): string {
  return id && /^[A-Za-z0-9_-]{1,128}$/.test(id) ? id : newId(prefix)
}

/** The arguments of a call as the JSON string OpenAI-style clients expect. */
export function argumentsJson(call: NeutralToolCall): string {
  const raw = call.input.__invalid_json
  if (typeof raw === 'string' && Object.keys(call.input).length === 1) return raw
  return JSON.stringify(call.input)
}

/** `data:image/png;base64,…` as an image; anything else (an https URL) is not fetched. */
export function dataUrlImage(url: unknown): NeutralImage | null {
  if (typeof url !== 'string') return null
  const match = /^data:([\w/+.-]+);base64,(.+)$/s.exec(url)
  return match ? { mime: match[1], data: match[2] } : null
}

/** OpenAI's `reasoning_effort` / `reasoning.effort` as Eaon's level. */
export function openaiEffort(value: unknown): EffortLevel | undefined {
  switch (value) {
    case 'none':
      return 'none'
    case 'minimal':
      return 'minimal'
    case 'low':
      return 'light'
    case 'medium':
      return 'medium'
    case 'high':
      return 'high'
    case 'xhigh':
      return 'extra-high'
    case 'max':
      return 'ultra'
    default:
      return undefined
  }
}

/** Anthropic's thinking budget (or `output_config.effort`) as Eaon's level. */
export function anthropicEffort(thinking: unknown, outputConfig: unknown): EffortLevel | undefined {
  const effort = (outputConfig as { effort?: unknown } | undefined)?.effort
  if (effort === 'low') return 'light'
  if (effort === 'medium') return 'medium'
  if (effort === 'high') return 'high'
  if (effort === 'max') return 'ultra'
  const t = thinking as { type?: unknown; budget_tokens?: unknown } | undefined
  if (!t || typeof t !== 'object') return undefined
  if (t.type === 'disabled') return 'none'
  if (t.type === 'adaptive') return undefined
  const budget = Number(t.budget_tokens)
  if (!Number.isFinite(budget) || budget <= 0) return undefined
  if (budget >= 32_000) return 'extra-high'
  if (budget >= 16_000) return 'high'
  if (budget >= 4_000) return 'medium'
  return 'light'
}

/** A positive integer token cap, or undefined. */
export function cap(value: unknown): number | undefined {
  const n = Number(value)
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : undefined
}

/**
 * Drops what the providers would reject: assistant turns left empty once
 * their thinking was dropped, and tool results whose call is not in the
 * transcript (the app trimmed it).
 */
export function tidy(messages: NeutralMessage[]): NeutralMessage[] {
  const calls = new Set<string>()
  const out: NeutralMessage[] = []
  for (const message of messages) {
    if (message.role === 'assistant') {
      if (!message.text && message.calls.length === 0) continue
      for (const call of message.calls) calls.add(call.id)
      out.push(message)
    } else if (message.role === 'tool') {
      const results = message.results.filter((r) => calls.has(r.id))
      if (results.length > 0) out.push({ role: 'tool', results })
    } else {
      out.push(message)
    }
  }
  return out
}

/** The name of the call a tool result answers, from the transcript before it. */
export function callNames(messages: NeutralMessage[]): Map<string, string> {
  const names = new Map<string, string>()
  for (const message of messages) if (message.role === 'assistant') for (const call of message.calls) names.set(call.id, call.name)
  return names
}

export function sendJson(res: ServerResponse, status: number, body: unknown): void {
  if (res.headersSent) {
    res.end()
    return
  }
  res.writeHead(status, { 'Content-Type': 'application/json' })
  res.end(JSON.stringify(body))
}

export function startSse(res: ServerResponse): void {
  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' })
  // Nagle's delay would hold back the small writes a stream is made of.
  res.socket?.setNoDelay(true)
}

/** `event: <name>` + `data: <json>`, the Anthropic and Responses framing. */
export function sseEvent(res: ServerResponse, event: string, data: Record<string, unknown>): void {
  if (!res.writableEnded) res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)
}

/** `data: <json>`, the chat-completions framing. */
export function sseData(res: ServerResponse, data: unknown): void {
  if (!res.writableEnded) res.write(`data: ${typeof data === 'string' ? data : JSON.stringify(data)}\n\n`)
}

export function errorMessage(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).replace(/^\d{3}:\s*/, '')
}
