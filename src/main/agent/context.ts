import { readFileSync } from 'node:fs'
import { extname } from 'node:path'
import type { ChatMessage, ChatToolPart } from '@shared/types'
import type { NeutralImage, NeutralMessage, NeutralToolCall, NeutralToolResult } from '../providers/adapters/types'

/**
 * What of a conversation gets resent, and how much of it.
 *
 * The transcript on disk keeps everything; this decides what the model sees.
 * The rules are chosen for cost without losing what matters:
 *
 * - Reasoning is never resent. It was for producing the answer that followed.
 * - Tool output from turns older than the last few user messages is cut to a
 *   stub. The model's own replies from those turns already say what it found;
 *   the raw 16 KB of a file it read three questions ago rarely matters again,
 *   and when it does the model can read the file again.
 * - Large tool *inputs* from old turns (a whole file passed to write_file) are
 *   cut the same way. They are the most expensive thing in a coding chat's
 *   history and the least useful: the file is on disk.
 * - Only the newest screenshot is ever replayed. Every older one is a stale
 *   picture of a screen that has since changed, at ~1,500 tokens apiece.
 *
 * All of it is a pure function of the stored transcript, so the same history
 * always serialises the same way and the provider's prompt cache keeps
 * hitting between turns.
 */

/** Rough token estimate. Tokenizers vary; this errs slightly high, which is the safe side for compaction. */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 3.6)
}

const IMAGE_TOKENS = 1600

export function estimateMessages(messages: NeutralMessage[]): number {
  let total = 0
  for (const message of messages) {
    if (message.role === 'user') {
      total += estimateTokens(message.text) + (message.images?.length ?? 0) * IMAGE_TOKENS
    } else if (message.role === 'assistant') {
      total += estimateTokens(message.text)
      for (const call of message.calls) total += estimateTokens(JSON.stringify(call.input)) + 10
    } else {
      for (const result of message.results) total += estimateTokens(result.output) + (result.images?.length ?? 0) * IMAGE_TOKENS + 10
    }
  }
  return total
}

const OLD_OUTPUT_LIMIT = 600
const OLD_INPUT_LIMIT = 800

function stubOutput(output: string): string {
  if (output.length <= OLD_OUTPUT_LIMIT) return output
  return `${output.slice(0, 380)}\n…[earlier output trimmed — run the tool again if you need it]…\n${output.slice(-160)}`
}

function stubInput(input: Record<string, unknown>): Record<string, unknown> {
  let changed = false
  const out: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(input)) {
    if (typeof value === 'string' && value.length > OLD_INPUT_LIMIT) {
      out[key] = `${value.slice(0, 200)}…[${value.length.toLocaleString()} characters, trimmed from history]`
      changed = true
    } else {
      out[key] = value
    }
  }
  return changed ? out : input
}

const MIME: Record<string, string> = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif' }

export function loadImage(path: string): NeutralImage | null {
  const mime = MIME[extname(path).toLowerCase()]
  if (!mime) return null
  try {
    return { mime, data: readFileSync(path).toString('base64') }
  } catch {
    return null
  }
}

/** Small text files go into the message itself, so a chat without file tools can still read them. */
function readTextAttachment(path: string): string | null {
  try {
    const buffer = readFileSync(path)
    if (buffer.length > 60_000 || buffer.subarray(0, 4000).includes(0)) return null
    return buffer.toString('utf8')
  } catch {
    return null
  }
}

export interface BuiltHistory {
  messages: NeutralMessage[]
  /** For each neutral message, the id of the stored message it came from (compaction needs it). */
  sourceIds: string[]
}

/**
 * Stored transcript → the neutral messages to send.
 *
 * An assistant message's parts interleave text and tool calls in the order
 * they happened; they are split back into the assistant → tool-results pairs
 * every provider requires, so a replayed turn reads exactly as it ran.
 */
export function buildHistory(history: ChatMessage[], summary: string | null, keepFullToolTurns: number): BuiltHistory {
  const messages: NeutralMessage[] = []
  const sourceIds: string[] = []
  const push = (message: NeutralMessage, id: string): void => {
    messages.push(message)
    sourceIds.push(id)
  }

  if (summary) push({ role: 'user', text: `Summary of the conversation so far:\n${summary}` }, 'summary')

  // Turns before the Nth-last user message are "old".
  const userIndices = history.map((m, i) => (m.role === 'user' ? i : -1)).filter((i) => i >= 0)
  const oldBefore = userIndices.length > keepFullToolTurns ? userIndices[userIndices.length - keepFullToolTurns] : 0
  // Attachments are read from disk only for the last two user messages.
  const attachFrom = userIndices.length > 2 ? userIndices[userIndices.length - 2] : 0

  // The one screenshot worth replaying: the newest.
  let newestImagePart: ChatToolPart | null = null
  for (let i = history.length - 1; i >= 0 && !newestImagePart; i--) {
    const parts = history[i].parts
    for (let j = parts.length - 1; j >= 0; j--) {
      const part = parts[j]
      if (part.type === 'tool' && part.images && part.images.length > 0) {
        newestImagePart = part
        break
      }
    }
  }

  history.forEach((message, index) => {
    const old = index < oldBefore
    if (message.role === 'user') {
      const text = message.parts
        .filter((p) => p.type === 'text')
        .map((p) => (p as { text: string }).text)
        .join('')
      const recent = index >= attachFrom
      const images: NeutralImage[] = []
      const notes: string[] = []
      for (const path of message.attachments ?? []) {
        const image = recent ? loadImage(path) : null
        if (image) {
          images.push(image)
          continue
        }
        const inline = recent ? readTextAttachment(path) : null
        notes.push(inline ? `\n\nAttached file ${path}:\n\`\`\`\n${inline}\n\`\`\`` : `\n\n[Attached: ${path}]`)
      }
      const body = text + notes.join('')
      if (body || images.length > 0) push({ role: 'user', text: body, ...(images.length ? { images } : {}) }, message.id)
      return
    }
    if (message.role !== 'assistant') return

    let text = ''
    let calls: NeutralToolCall[] = []
    let results: NeutralToolResult[] = []
    const flush = (): void => {
      if (!text && calls.length === 0) return
      push({ role: 'assistant', text, calls }, message.id)
      if (results.length > 0) push({ role: 'tool', results }, message.id)
      text = ''
      calls = []
      results = []
    }

    for (const part of message.parts) {
      if (part.type === 'reasoning') continue
      if (part.type !== 'tool') {
        if (calls.length > 0) flush()
        text += part.text
        continue
      }
      const output = part.output === null ? '(no result — the turn was interrupted before this finished)' : part.output
      calls.push({ id: part.id, name: part.name, input: old ? stubInput(part.input) : part.input })
      const images =
        part === newestImagePart
          ? (part.images ?? []).map(loadImage).filter((img): img is NeutralImage => img !== null)
          : []
      results.push({
        id: part.id,
        name: part.name,
        output: old ? stubOutput(output) : output,
        ...(images.length > 0 ? { images } : {}),
        ...(part.status === 'error' ? { isError: true } : {})
      })
    }
    flush()
  })

  // Every provider wants the conversation to open with the user.
  if (messages.length > 0 && messages[0].role !== 'user') {
    messages.unshift({ role: 'user', text: '(continuing the conversation)' })
    sourceIds.unshift('placeholder')
  }
  return { messages, sourceIds }
}

/**
 * Flattens a neutral transcript to plain text for the summariser. Sending the
 * raw tool blocks would require offering every tool schema to a request that
 * is not allowed to call any, and costs far more than the text does.
 */
export function transcriptText(messages: NeutralMessage[], charBudget: number): string {
  const lines: string[] = []
  for (const message of messages) {
    if (message.role === 'user') lines.push(`USER: ${message.text}`)
    else if (message.role === 'assistant') {
      if (message.text) lines.push(`ASSISTANT: ${message.text}`)
      for (const call of message.calls) lines.push(`[called ${call.name} ${JSON.stringify(stubInput(call.input)).slice(0, 300)}]`)
    } else {
      for (const result of message.results) lines.push(`[${result.name} → ${stubOutput(result.output).slice(0, 700)}]`)
    }
  }
  let text = lines.join('\n')
  // Over budget: keep the start (the original ask) and the most recent work.
  if (text.length > charBudget) text = `${text.slice(0, charBudget * 0.25)}\n…\n${text.slice(-charBudget * 0.75)}`
  return text
}

/**
 * Client-side pruning inside one long agent turn, for providers that do not
 * clear context server-side. Runs only past a threshold and then clears a
 * large batch at once, so the prompt prefix changes rarely and the cache
 * survives between clearing events.
 */
export function pruneInFlight(messages: NeutralMessage[], budgetTokens: number): boolean {
  if (estimateMessages(messages) < budgetTokens) return false
  const toolIndices = messages.map((m, i) => (m.role === 'tool' ? i : -1)).filter((i) => i >= 0)
  const keep = new Set(toolIndices.slice(-4))
  let changed = false
  for (const index of toolIndices) {
    if (keep.has(index)) continue
    const message = messages[index] as Extract<NeutralMessage, { role: 'tool' }>
    const results = message.results.map((r) => {
      if (r.output.length <= OLD_OUTPUT_LIMIT && !r.images) return r
      changed = true
      return { ...r, output: stubOutput(r.output), images: undefined }
    })
    messages[index] = { role: 'tool', results }
  }
  // Older assistant tool inputs too (write_file bodies).
  const assistants = messages.map((m, i) => (m.role === 'assistant' ? i : -1)).filter((i) => i >= 0).slice(0, -4)
  for (const index of assistants) {
    const message = messages[index] as Extract<NeutralMessage, { role: 'assistant' }>
    const calls = message.calls.map((call) => ({ ...call, input: stubInput(call.input) }))
    if (calls.some((c, i) => c.input !== message.calls[i].input)) {
      changed = true
      messages[index] = { ...message, calls, replay: undefined }
    }
  }
  return changed
}

/**
 * Screenshots are the most expensive thing a computer-use turn accumulates
 * (~1,600 tokens each) and the least durable: every one after the newest shows
 * a screen that has since changed. Once more than `trigger` are in flight, all
 * but the newest `keep` are dropped in one batch — batching keeps the prompt
 * prefix stable between clearings, so caching still pays off in between.
 */
/**
 * Takes every image out of the transcript, for a model that can't see them:
 * screenshots and attachments become a line saying one was there. Messages
 * are replaced, not edited, so nothing outside this request changes. True
 * when there was anything to take out.
 */
export function stripImages(messages: NeutralMessage[]): boolean {
  let stripped = false
  const note = (count: number): string => `[${count === 1 ? 'an image was' : `${count} images were`} here; this model can't see images]`
  messages.forEach((m, i) => {
    if (m.role === 'user' && m.images && m.images.length > 0) {
      messages[i] = { role: 'user', text: `${m.text}${m.text ? '\n' : ''}${note(m.images.length)}` }
      stripped = true
    } else if (m.role === 'tool' && m.results.some((r) => r.images && r.images.length > 0)) {
      messages[i] = {
        role: 'tool',
        results: m.results.map((r) => (r.images && r.images.length > 0 ? { ...r, images: undefined, output: `${r.output}\n${note(r.images.length)}` } : r))
      }
      stripped = true
    }
  })
  return stripped
}

export function pruneImages(messages: NeutralMessage[], keep = 1, trigger = 4): boolean {
  const withImages: number[] = []
  messages.forEach((m, i) => {
    if (m.role === 'tool' && m.results.some((r) => r.images && r.images.length > 0)) withImages.push(i)
  })
  if (withImages.length <= trigger) return false
  for (const index of withImages.slice(0, -keep)) {
    const message = messages[index] as Extract<NeutralMessage, { role: 'tool' }>
    messages[index] = {
      role: 'tool',
      results: message.results.map((r) => (r.images ? { ...r, images: undefined, output: `${r.output}\n[older screenshot removed]` } : r))
    }
  }
  return true
}
