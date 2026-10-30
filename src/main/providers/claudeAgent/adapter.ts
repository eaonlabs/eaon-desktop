import { createHash } from 'node:crypto'
import type { EngineAuth } from '@shared/engines'
import type { Adapter, NeutralMessage, TurnRequest, TurnResult } from '../adapters/types'
import { TO_SDK } from '../../engines/claude'
import { fingerprint, sameKeys, userContent, userKey, withCheckpoint } from './history'
import { ClaudeAgentError, ClaudeSession, type QueryFn, type SessionSpec, type StepResult } from './session'

/**
 * Claude Agent as a provider: Claude models running Eaon's own agent (its
 * loop, tools, approvals, memory and history), through the user's own Claude
 * Code and its sign-in, so on their Claude plan. The Claude engine
 * (engines/claude) is the other way round: Claude Code's agent, with its own
 * tools, inside Eaon's chat.
 *
 * A conversation keeps one Claude session while Eaon's history and Claude's
 * agree (history.ts):
 * - within a turn, each step continues the session the last step left: with
 *   the result of the call Claude is waiting on, or the loop's next message;
 * - a new turn whose earlier history still matches sends just the new message,
 *   into the same process, or a new one resuming the session when the process
 *   has gone or the prompt, tools or model changed;
 * - anything else (an edit, a compaction, another model's turns, a relaunch)
 *   starts a new session whose first message carries the conversation so far.
 * A request with no tools (a chat's title) is a one-off of its own.
 */

/** A process with nothing to do is closed after this long; its session can be resumed. */
const IDLE_MS = 10 * 60_000
/** While Claude waits on a tool, it may wait long: an approval, a subagent. */
const WAITING_MS = 60 * 60_000
/** How old a sign-in check may be before a turn checks again that nothing would be charged. */
const CHARGE_CHECK_MS = 60_000

export interface ClaudeAgentDeps {
  /** The user's `claude`, or null when it isn't installed. */
  executable: () => string | null
  /** The environment Claude Code runs in (engines/claude `claudeCodeEnv`). */
  env: () => Record<string, string | undefined>
  /** How Claude Code is signed in; `force` asks again. */
  auth: (force: boolean) => Promise<{ auth: EngineAuth; checkedAt: number }>
  /** The folder sessions run in when the request names none. */
  defaultCwd: () => string
  query: () => Promise<QueryFn>
  now?: () => number
}

interface Live {
  session: ClaudeSession
  /** How many of the request's messages the session has answered, counting the reply the loop adds. */
  seen: number
  /** The chat this session is the record of, or null for one of its own (a subagent's). */
  chat: string | null
}

interface ChatRecord {
  live: Live | null
  claudeSessionId: string | null
  /** What Claude's session holds, as history.ts keys. */
  keys: string[]
}

export function createClaudeAgentAdapter(deps: ClaudeAgentDeps): Adapter & { dispose(): void } {
  const now = (): number => deps.now?.() ?? Date.now()
  const byMessages = new WeakMap<NeutralMessage[], Live>()
  const chats = new Map<string, ChatRecord>()
  const sessions = new Set<ClaudeSession>()
  let extraUsageUntil = 0

  /** Nothing that could be charged: signed in with a Claude account, the plan not on extra usage. */
  async function checkPlan(): Promise<void> {
    let { auth, checkedAt } = await deps.auth(false)
    if (now() - checkedAt > CHARGE_CHECK_MS || auth.state !== 'signed-in') ({ auth } = await deps.auth(true))
    if (auth.state === 'signed-out' || auth.state === 'expired') {
      throw new ClaudeAgentError('Claude isn’t signed in. Sign in with Claude Code (claude auth login), then try again.')
    }
    if (auth.state === 'signed-in' && auth.method !== 'Claude account') {
      throw new ClaudeAgentError('Claude Code is signed in with an API key, which Anthropic charges per use. To use your Claude plan, sign in with your Claude account: claude auth login.')
    }
    if (now() < extraUsageUntil) {
      const at = new Date(extraUsageUntil).toLocaleString(undefined, { weekday: 'short', hour: 'numeric', minute: '2-digit' })
      throw new ClaudeAgentError(`Your Claude plan’s limit is used up, and going on would use extra usage, which Anthropic charges for. Try again after ${at}.`)
    }
  }

  function specOf(request: TurnRequest, executable: string): { spec: Omit<SessionSpec, 'resume' | 'persist'>; signature: string } {
    const model = request.modelId && request.modelId !== 'default' ? request.modelId : undefined
    const effort = request.model?.efforts?.includes(request.effort) ? TO_SDK[request.effort] : undefined
    const cwd = request.cwd ?? deps.defaultCwd()
    const spec = { executable, env: deps.env(), cwd, model, effort, system: request.system, tools: request.tools }
    const signature = createHash('sha256')
      .update(JSON.stringify([model, effort, cwd, request.system, request.tools]))
      .digest('hex')
    return { spec, signature }
  }

  function open(signature: string, spec: SessionSpec, query: QueryFn): ClaudeSession {
    const session = new ClaudeSession(signature, spec, query)
    sessions.add(session)
    return session
  }

  /** Closes a session's process; its chat's record stays, so the session can be resumed. */
  function retire(live: Live): void {
    live.session.close()
    sessions.delete(live.session)
  }

  /** Closes a session that can't go on (it failed, or was stopped), and forgets it as the chat's record. */
  function forget(live: Live | undefined, messages: NeutralMessage[]): void {
    byMessages.delete(messages)
    if (!live) return
    retire(live)
    if (live.chat && chats.get(live.chat)?.live === live) chats.delete(live.chat)
  }

  /** The step that continues a session within a turn, when the loop's messages pick up where it left off. */
  function continuing(live: Live, request: TurnRequest): Promise<StepResult> | null {
    if (live.session.dead) return null
    // The loop adds the reply first (except after a reply with nothing in it), then what answers it.
    let delta = request.messages.slice(live.seen - 1)
    if (delta[0]?.role === 'assistant') delta = delta.slice(1)
    if (delta.length !== 1) return null
    const [next] = delta
    const pending = live.session.pending
    const handlers = { onText: request.onText, onReasoning: request.onReasoning }
    if (pending && next.role === 'tool') {
      const result = next.results.find((r) => r.id === pending.call.id) ?? (next.results.length === 1 ? next.results[0] : undefined)
      return result ? live.session.answer(result, handlers) : null
    }
    // A nudge of the loop's own ("Go ahead and do it now…"): sent, but not part of the record, as it isn't saved.
    if (!pending && next.role === 'user') return live.session.send(userContent(next), handlers)
    return null
  }

  /** A turn's first step: the chat's session continued, resumed, or started anew. */
  function starting(request: TurnRequest, base: Omit<SessionSpec, 'resume' | 'persist'>, signature: string, query: QueryFn): { live: Live; step: Promise<StepResult> } {
    const { messages, cacheKey } = request
    const handlers = { onText: request.onText, onReasoning: request.onReasoning }
    const last = messages[messages.length - 1]
    const asked = last?.role === 'user' ? last : null
    const earlier = asked ? messages.slice(0, -1) : messages
    const keys = fingerprint(earlier)
    let record = chats.get(cacheKey)

    const busy = record?.live && !record.live.session.dead ? record.live.session.pending : null
    if (busy) {
      if (!keys.includes(`c:${busy.call.id}`)) {
        // A subagent while its parent waits on it: a session of its own, outside the chat's record.
        const session = open(signature, { ...base, persist: false }, query)
        const live: Live = { session, seen: 0, chat: null }
        return { live, step: session.send(userContent(asked ?? { role: 'user', text: '' }, withCheckpoint(earlier, asked?.text ?? 'Continue.')), handlers) }
      }
      // The turn that call belonged to was stopped while it ran: that session can't go on.
      forget(record!.live!, [])
      record = undefined
    }

    if (record?.claudeSessionId && asked && sameKeys(keys, record.keys)) {
      let session = record.live?.session
      if (!session || session.dead || session.signature !== signature) {
        // A new prompt, tools or model: a new process, resuming the same session.
        if (record.live) retire(record.live)
        session = open(signature, { ...base, persist: true, resume: record.claudeSessionId }, query)
      }
      const live: Live = { session, seen: 0, chat: cacheKey }
      record.live = live
      record.keys = [...keys, userKey(asked.text)]
      return { live, step: session.send(userContent(asked), handlers) }
    }

    if (record?.live) retire(record.live)
    const session = open(signature, { ...base, persist: true }, query)
    const live: Live = { session, seen: 0, chat: cacheKey }
    chats.set(cacheKey, { live, claudeSessionId: null, keys: asked ? [...keys, userKey(asked.text)] : keys })
    const text = asked ? withCheckpoint(earlier, asked.text) : withCheckpoint(messages, 'Continue from where this left off.')
    return { live, step: session.send(userContent(asked ?? { role: 'user', text: '' }, text), handlers) }
  }

  /** A request with no tools, such as a chat's title: one session, closed when it answers. */
  async function oneOff(request: TurnRequest, base: Omit<SessionSpec, 'resume' | 'persist'>, signature: string, query: QueryFn): Promise<TurnResult> {
    const last = request.messages[request.messages.length - 1]
    const asked = last?.role === 'user' ? last : null
    const earlier = asked ? request.messages.slice(0, -1) : request.messages
    const session = open(signature, { ...base, persist: false, utility: true }, query)
    const stop = (): void => session.close()
    request.signal.addEventListener('abort', stop, { once: true })
    try {
      const result = await session.send(userContent(asked ?? { role: 'user', text: '' }, withCheckpoint(earlier, asked?.text ?? 'Continue.')), {
        onText: request.onText,
        onReasoning: request.onReasoning
      })
      return { text: result.text, calls: [], stop: 'end', usage: result.usage }
    } finally {
      request.signal.removeEventListener('abort', stop)
      session.close()
      sessions.delete(session)
    }
  }

  return {
    id: 'claude-agent',
    // Claude Code keeps the session's context itself: the loop leaves the transcript in flight alone.
    managesContext: true,

    async turn(request: TurnRequest): Promise<TurnResult> {
      await checkPlan()
      const executable = deps.executable()
      if (!executable) throw new ClaudeAgentError('Claude Code isn’t installed. Install it with npm install -g @anthropic-ai/claude-code, then sign in with claude auth login.')
      if (request.signal.aborted) throw new Error('aborted')
      const query = await deps.query()
      const { spec, signature } = specOf(request, executable)
      if (request.tools.length === 0) return oneOff(request, spec, signature, query)

      let live = byMessages.get(request.messages)
      let step = live ? continuing(live, request) : null
      if (!step) {
        if (live) forget(live, request.messages)
        ;({ live, step } = starting(request, spec, signature, query))
      }
      const current = live!
      const stop = (): void => void current.session.stop()
      request.signal.addEventListener('abort', stop, { once: true })
      let result: StepResult
      try {
        result = await step
      } catch (error) {
        if (current.session.extraUsageUntil) extraUsageUntil = Math.max(extraUsageUntil, current.session.extraUsageUntil)
        forget(current, request.messages)
        if (request.signal.aborted) throw new Error('aborted')
        throw error
      } finally {
        request.signal.removeEventListener('abort', stop)
      }
      if (request.signal.aborted) {
        forget(current, request.messages)
        throw new Error('aborted')
      }

      current.seen = request.messages.length + 1
      byMessages.set(request.messages, current)
      const record = current.chat ? chats.get(current.chat) : undefined
      if (record && record.live === current) {
        record.claudeSessionId = current.session.claudeSessionId ?? record.claudeSessionId
        for (const call of result.calls) record.keys.push(`c:${call.id}`)
      }
      current.session.closeWhenIdle(result.stop === 'tool_use' ? WAITING_MS : IDLE_MS)
      return { text: result.text, calls: result.calls, stop: result.stop, usage: result.usage }
    },

    dispose(): void {
      for (const session of sessions) session.close()
      sessions.clear()
      chats.clear()
    }
  }
}
