import { adapterFor, getProvider } from '../providers'
import { credentialAttempts, isAuthError } from '../providers/credentials'

/**
 * A name for a new chat, written by the model the chat runs on once its first
 * reply is in: a few words saying what it is about, in place of the first
 * line of the first message. One short request with no tools, each saved key
 * tried in turn as in the agent loop. Null when the model gives nothing
 * usable or the request fails; the chat then keeps the name it had.
 */

export interface ChatTitleRequest {
  providerId: string
  modelId: string
  /** The first message, as sent. */
  message: string
  /** What the first reply said, when it said anything. */
  reply: string
}

const SYSTEM = [
  'You name conversations for a sidebar list.',
  'Reply with a title of two to six words that says what the conversation is about.',
  'Use the language the user wrote in. Sentence case. No quotes, no ending punctuation, no emoji, no preamble.'
].join(' ')

/** How much of the message and the reply go along: enough to tell what it's about. */
const MESSAGE_CHARS = 1500
const REPLY_CHARS = 800
const TIMEOUT_MS = 30_000

export async function writeChatTitle(request: ChatTitleRequest): Promise<string | null> {
  const provider = getProvider(request.providerId)
  if (!provider || !request.message.trim()) return null
  const adapter = adapterFor(provider)
  const model = provider.models.find((m) => m.id === request.modelId)
  const reply = request.reply.trim()
  const text = [
    `The user wrote:\n${clip(request.message, MESSAGE_CHARS)}`,
    reply ? `The assistant answered:\n${clip(reply, REPLY_CHARS)}` : '',
    'Title:'
  ]
    .filter(Boolean)
    .join('\n\n')

  // A sign-in that has run out has nothing to try with: the chat keeps its name.
  const attempts = await credentialAttempts(provider).catch(() => [])
  for (let k = 0; k < attempts.length; k++) {
    const signal = AbortSignal.timeout(TIMEOUT_MS)
    try {
      const result = await adapter.turn({
        provider,
        modelId: request.modelId,
        model,
        credentials: attempts[k],
        system: SYSTEM,
        messages: [{ role: 'user', text }],
        tools: [],
        // The least thinking the model allows: a name isn't worth reasoning over.
        effort: 'none',
        signal,
        cacheKey: `eaon-chat-title-${provider.id}-${request.modelId}`,
        agentic: false,
        outputCap: 300,
        onText: () => {},
        onReasoning: () => {}
      })
      return cleanTitle(result.text)
    } catch (error) {
      if (isAuthError(error) && k < attempts.length - 1) continue
      return null
    }
  }
  return null
}

/** The title out of what the model wrote: its first line, without the quotes, labels and full stop models add. */
export function cleanTitle(raw: string): string | null {
  const line = raw
    .replace(/<think>[\s\S]*?<\/think>/gi, '')
    .split('\n')
    .map((l) => l.trim())
    .find(Boolean)
  if (!line) return null
  const title = line
    .replace(/^(?:#+\s*|\*\*)/, '')
    .replace(/\*\*$/, '')
    .replace(/^(?:title|chat title|name)\s*[:：-]\s*/i, '')
    .replace(/^["'“”‘’`«]+|["'“”‘’`»]+$/g, '')
    .replace(/[.。!！]+$/, '')
    .replace(/\s+/g, ' ')
    .trim()
  if (!title) return null
  return title.length > 60 ? `${title.slice(0, 59).trimEnd()}…` : title
}

function clip(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}…` : text
}
