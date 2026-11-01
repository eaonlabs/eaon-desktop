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
/** A subagent's session, once it has answered: kept only for the loop's own nudge right after. */
const LOOSE_IDLE_MS = 60_000

export interface ClaudeAgentDeps {
  /** The user's `claude`, or null when it isn't installed. */
  executable: () => string | null
  /** The environment Claude Code runs in (engines/claude `claudeCodeEnv`). */
  env: () => Record<string, string | undefined>
  /** How Claude Code is signed in; `force` asks again. */
  auth: (force: boolean) => Promise<{ auth: EngineAuth; checkedAt: number }>
  /** The folder sessions run in when the request names none; it must exist, or Claude Code can't start. */
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
  /** The agent turn it is a step of (TurnRequest `turnId`), when the caller says. */
  turnId: string | null
}

interface ChatRecord {
  live: Live | null
  claudeSessionId: string | null
  /** What Claude's session holds, as history.ts keys. */
  keys: string[]
}

export function createClaudeAgentAdapter(deps: ClaudeAgentDeps): Adapter & {
  endTurn(turnId: string): void
  /** How many Claude Code processes are open, for tests and diagnostics. */
  openSessions(): number
  dispose(): void
} {
  const now = (): number => deps.now?.() ?? Date.now()
  const byMessages = new WeakMap<NeutralMessage[], Live>()
  const chats = new Map<string, ChatRecord>()
  const sessions = new Set<ClaudeSession>()
  /** Sessions outside any chat's record (subagents', a busy chat's second request), until they close. */
  const loose = new Set<Live>()
  let extraUsageUntil = 0

  /** The plan isn't on extra usage: checked before every step, as it costs nothing. */
  function checkExtraUsage(): void {
    if (now() < extraUsageUntil) {
      const at = new Date(extraUsageUntil).toLocaleString(undefined, { weekday: 'short', hour: 'numeric', minute: '2-digit' })
      throw new ClaudeAgentError(`Your Claude plan’s limit is used up, and going on would use extra usage, which Anthropic charges for. Try again after ${at}.`)
    }
  }

  /**
   * Signed in with a Claude account, so nothing is charged: checked before a
   * new process or a new turn, not for each step of one (that process was
   * checked when it started: `apiKeySource`).
   */
  async function checkSignIn(): Promise<void> {
    let { auth, checkedAt } = await deps.auth(false)
    if (now() - checkedAt > CHARGE_CHECK_MS || auth.state !== 'signed-in') ({ auth } = await deps.auth(true))
    if (auth.state === 'signed-out' || auth.state === 'expired') {
      throw new ClaudeAgentError('Claude isn’t signed in. Sign in with Claude Code (claude auth login), then try again.')
    }
    if (auth.state === 'signed-in' && auth.method !== 'Claude account') {
      throw new ClaudeAgentError('Claude Code is signed in with an API key, which Anthropic charges per use. To use your Claude plan, sign in with your Claude account: claude auth login.')
    }
  }

  function specOf(request: TurnRequest, executable: string): { spec: Omit<SessionSpec, 'resume' | 'persist'>; signature: string } {
    const model = request.modelId && request.modelId !== 'default' ? request.modelId : undefined
    const effort = request.model?.efforts?.includes(request.effort) ? TO_SDK[request.effort] : undefined
    // Chat's turns have no folder (''), nor do titles: Claude Code still needs one to start in.
    const cwd = request.cwd || deps.defaultCwd()
    const spec = { executable, env: deps.env(), cwd, model, effort, system: request.system, tools: request.tools }
    const signature = createHash('sha256')
      .update(JSON.stringify([model, effort, cwd, request.system, request.tools]))
      .digest('hex')
    return { spec, signature }
  }

  function open(signature: string, spec: SessionSpec, query: QueryFn): ClaudeSession {
    // However it closes (the idle timer too), nothing goes on holding it: a chat's record keeps only the session's id.
    const session: ClaudeSession = new ClaudeSession(signature, spec, query, () => {
      sessions.delete(session)
      for (const record of chats.values()) if (record.live?.session === session) record.live = null
      for (const live of loose) if (live.session === session) loose.delete(live)
    })
    sessions.add(session)
    return session
  }

  /** Closes a session's process; its chat's record stays, so the session can be resumed. */
  function retire(live: Live): void {
    live.session.close()
    sessions.delete(live.session)
    loose.delete(live)
  }

  /** Closes a session that can't go on (it failed, or was stopped), and forgets it as the chat's record. */
  function forget(live: Live | undefined, messages?: NeutralMessage[]): void {
    if (messages) byMessages.delete(messages)
    if (!live) return
    const record = live.chat ? chats.get(live.chat) : undefined
    if (record?.live === live) chats.delete(live.chat!)
    retire(live)
  }

  /** A session of its own, outside the chat's record, caught up on what its request holds. */
  function apart(request: TurnRequest, base: Omit<SessionSpec, 'resume' | 'persist'>, signature: string, query: QueryFn): { live: Live; step: Promise<StepResult> } {
    const last = request.messages[request.messages.length - 1]
    const asked = last?.role === 'user' ? last : null
    const earlier = asked ? request.messages.slice(0, -1) : request.messages
    const session = open(signature, { ...base, persist: false }, query)
    const live: Live = { session, seen: 0, chat: null, turnId: request.turnId ?? null }
    loose.add(live)
    const handlers = { onText: request.onText, onReasoning: request.onReasoning }
    return { live, step: session.send(userContent(asked ?? { role: 'user', text: '' }, withCheckpoint(earlier, asked?.text ?? 'Continue.')), handlers) }
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
    const turnId = request.turnId ?? null
    const last = messages[messages.length - 1]
    const asked = last?.role === 'user' ? last : null
    const earlier = asked ? messages.slice(0, -1) : messages
    const keys = fingerprint(earlier)
    let record = chats.get(cacheKey)

    const held = record?.live && !record.live.session.dead ? record.live : null
    // Another request of the chat's while its session is answering one: kept apart, so neither is lost.
    if (held?.session.stepping) return apart(request, base, signature, query)
    const waiting = held?.session.pending
    if (held && waiting) {
      // A subagent while its parent waits on it: a session of its own, outside the chat's record.
      // Its turn says so; a caller that doesn't name turns is told by the call's absence from the history.
      const subagent = request.turnId !== undefined ? held.turnId === request.turnId : !keys.includes(`c:${waiting.call.id}`)
      if (subagent) return apart(request, base, signature, query)
      // The turn that call belonged to is over (stopped, or it ended on a plan or a worker's sleep): nothing will answer it.
      forget(held)
      record = undefined
    }

    if (record?.claudeSessionId && asked && sameKeys(keys, record.keys)) {
      let session = record.live?.session
      if (!session || session.dead || session.signature !== signature) {
        // A new prompt, tools or model: a new process, resuming the same session.
        if (record.live) retire(record.live)
        session = open(signature, { ...base, persist: true, resume: record.claudeSessionId }, query)
      }
      const live: Live = { session, seen: 0, chat: cacheKey, turnId }
      record.live = live
      record.keys = [...keys, userKey(asked.text)]
      return { live, step: session.send(userContent(asked), handlers) }
    }

    if (record?.live) retire(record.live)
    const session = open(signature, { ...base, persist: true }, query)
    const live: Live = { session, seen: 0, chat: cacheKey, turnId }
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
      checkExtraUsage()
      const executable = deps.executable()
      if (!executable) throw new ClaudeAgentError('Claude Code isn’t installed. Install it with npm install -g @anthropic-ai/claude-code, then sign in with claude auth login.')
      if (request.signal.aborted) throw new Error('aborted')
      const query = await deps.query()
      const { spec, signature } = specOf(request, executable)
      if (request.tools.length === 0) {
        await checkSignIn()
        return oneOff(request, spec, signature, query)
      }

      let live = byMessages.get(request.messages)
      let step = live ? continuing(live, request) : null
      if (!step) {
        if (live) forget(live, request.messages)
        await checkSignIn()
        if (request.signal.aborted) throw new Error('aborted')
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
      current.session.closeWhenIdle(result.stop === 'tool_use' ? WAITING_MS : current.chat ? IDLE_MS : LOOSE_IDLE_MS)
      return { text: result.text, calls: result.calls, stop: result.stop, usage: result.usage }
    },

    endTurn(turnId: string): void {
      // The chat's session waiting on a call of that turn: nothing will answer it now.
      for (const record of chats.values()) {
        const live = record.live
        if (live && live.turnId === turnId && live.session.pending) forget(live)
      }
      // The turn's subagents, and whatever else it ran apart, are done with it.
      for (const live of [...loose]) if (live.turnId === turnId) retire(live)
    },

    openSessions: () => sessions.size,

    dispose(): void {
      for (const session of sessions) session.close()
      sessions.clear()
      loose.clear()
      chats.clear()
    }
  }
}
