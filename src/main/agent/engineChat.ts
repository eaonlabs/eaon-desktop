import type { ChatMessage, Settings, StreamEvent, StreamRequest, TokenUsage } from '@shared/types'
import { ENGINE_LABEL, type EngineId } from '@shared/engines'
import { isCatastrophicCommand } from '@shared/commandRisk'
import type { EngineAccess, EngineAdapter, EngineApprovalRequest, EngineTurnResult } from '../engines/types'

/**
 * A Chat turn on an agent engine (Codex) instead of Eaon's own loop: the
 * same transcript events, Stop and approval dialog as any chat reply, with
 * the engine's own tools, models and sign-in doing the work.
 *
 * The engine keeps its own conversation (a Codex thread), remembered per chat
 * so the next message continues it. The first time a chat moves to an engine
 * part-way through, the engine is given what was said so far.
 */

export interface EngineChatDeps {
  adapter: (id: EngineId) => EngineAdapter | undefined
  /** The engine conversation a chat continues, if any; and remembering a new one. */
  session: (chatId: string, engine: EngineId) => string | null
  saveSession: (chatId: string, engine: EngineId, sessionId: string | null) => void
  /** Asks the user (the approval dialog) and resolves with their answer. */
  ask: (tool: string, input: Record<string, unknown>, summary: string) => Promise<boolean>
  record: (account: string, model: string, usage: TokenUsage) => void
}

export interface EngineChatInput {
  request: StreamRequest
  engine: EngineId
  cwd: string
  settings: Settings
  signal: AbortSignal
  emit: (event: StreamEvent) => void
}

/** Text of a message, for handing an engine what was said before it took over. */
function messageText(message: ChatMessage): string {
  return message.parts
    .map((part) => (part.type === 'text' ? part.text : ''))
    .join('')
    .trim()
}

/** Up to this much of the earlier conversation goes to an engine that joins a chat late. */
const CATCH_UP_CHARS = 12_000

/**
 * What came before the latest message, as a short transcript, for an engine
 * starting its own conversation in a chat that already has one. Newest kept
 * when it doesn't all fit.
 */
export function catchUp(history: ChatMessage[], summary: string | null): string {
  const lines: string[] = []
  let size = 0
  for (const message of history.slice().reverse()) {
    if (message.role !== 'user' && message.role !== 'assistant') continue
    const text = messageText(message)
    if (!text) continue
    const line = `${message.role === 'user' ? 'User' : 'Assistant'}: ${text}`
    if (size + line.length > CATCH_UP_CHARS) break
    lines.unshift(line)
    size += line.length
  }
  if (summary) lines.unshift(`Summary of the conversation before that: ${summary}`)
  return lines.join('\n\n')
}

/**
 * Whether an engine's call may run without asking. Chat's own rule: reading
 * never asks; nothing that could wreck the computer runs; in Plan mode
 * nothing changes; with Full access the rest runs; otherwise anything that
 * changes something asks (null = ask the user).
 */
export function chatEngineApproval(settings: Settings, plan: boolean, request: EngineApprovalRequest): boolean | null {
  if (!request.mutating) return true
  const command = typeof request.input.command === 'string' ? request.input.command : Array.isArray(request.input.command) ? request.input.command.join(' ') : ''
  if (command && isCatastrophicCommand(command)) return false
  if (plan) return false
  if (settings.approvalMode === 'full') return true
  return null
}

/** One sentence for a failed engine turn, with what fixes it. */
export function engineChatError(engine: EngineId, result: EngineTurnResult, model: string | null): string {
  const name = ENGINE_LABEL[engine] ?? engine
  switch (result.errorKind) {
    case 'auth-expired':
      return `${name}’s sign-in expired. Sign in again under Settings → Model providers → ${name}, then retry.`
    case 'signed-out':
      return `${name} isn’t signed in. Sign in under Settings → Model providers → ${name}, then retry.`
    case 'not-installed':
      return `${name} isn’t installed on this computer (or Eaon can’t find it). Install it, or pick another model.`
    case 'outdated':
      return `This copy of ${name} is too old for Eaon to drive. Update it, then retry.`
    case 'model-unavailable':
      return model ? `${name} doesn’t offer ${model} on your account. Pick another ${name} model.` : `${name} has no model it can use on your account.`
    case 'rate-limited':
      return `${name} hit a usage limit on your account. Try again later, or pick another model.`
    case 'network':
      return `${name} couldn’t reach its service. Check your connection, then retry.`
    case 'engine-crashed':
      return `${name} stopped responding and was restarted. Retry the message.`
    case 'misconfigured':
      return `${name} is set up to send its requests through Eaon, so Eaon can’t run it (that would loop back into itself). Switch it back in Settings → Connect apps.`
    default:
      return result.error || `${name} couldn’t finish this reply.`
  }
}

export async function runEngineChat(input: EngineChatInput, deps: EngineChatDeps): Promise<{ text: string; error?: string; usage: TokenUsage }> {
  const { request, engine, signal, emit } = input
  const empty: TokenUsage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }
  const adapter = deps.adapter(engine)
  if (!adapter) {
    const error = `${ENGINE_LABEL[engine] ?? engine} isn’t available in this build of Eaon.`
    emit({ type: 'error', messageId: request.messageId, error })
    return { text: '', error, usage: empty }
  }

  const history = request.history
  const latest = history[history.length - 1]
  const asked = latest?.role === 'user' ? messageText(latest) : ''
  const images = (latest?.attachments ?? []).filter((path) => /\.(png|jpe?g|gif|webp)$/i.test(path))
  const others = (latest?.attachments ?? []).filter((path) => !images.includes(path))
  const sessionId = deps.session(request.chatId, engine)
  // An engine joining a conversation already under way hears what was said so far.
  const before = sessionId ? '' : catchUp(history.slice(0, -1), request.summary)
  const text = [
    before ? `Earlier in this conversation (for context; answer the latest message):\n\n${before}\n\n---\n` : '',
    asked,
    others.length ? `\n\nAttached files:\n${others.map((path) => `- ${path}`).join('\n')}` : ''
  ].join('')

  const plan = request.mode === 'work' && request.work.plan
  const access: EngineAccess = plan ? 'read-only' : input.settings.approvalMode === 'full' ? 'autonomous' : 'safe'
  const model = request.modelId || null

  const result = await adapter.runTurn({
    sessionId,
    messageId: request.messageId,
    cwd: input.cwd,
    model,
    effort: request.effort ?? null,
    instructions: request.projectInstructions ? `The user's instructions for this project:\n${request.projectInstructions}` : '',
    text,
    images,
    access,
    signal,
    emit,
    approve: async (call) => {
      if (signal.aborted) return false
      const allowed = chatEngineApproval(input.settings, plan, call)
      return allowed ?? deps.ask(call.tool, call.input, call.summary)
    }
  })

  if (result.sessionId !== sessionId) deps.saveSession(request.chatId, engine, result.sessionId)
  const used = result.usage.input + result.usage.output + result.usage.cacheRead + result.usage.cacheWrite
  if (used > 0) {
    const paidFor = result.billing === 'api-key' ? ':api' : result.billing === 'provider' ? ':provider' : ''
    deps.record(`${engine}${paidFor}`, model ?? 'default', result.usage)
  }

  if (result.cancelled) {
    emit({ type: 'done', messageId: request.messageId })
    return { text: result.text, usage: result.usage }
  }
  if (result.error || result.errorKind) {
    const error = engineChatError(engine, result, model)
    emit({ type: 'error', messageId: request.messageId, error })
    return { text: result.text, error, usage: result.usage }
  }
  emit({ type: 'done', messageId: request.messageId })
  return { text: result.text, usage: result.usage }
}
