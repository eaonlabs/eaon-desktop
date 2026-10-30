import { mkdirSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import type { ModelInfo, Options, Query, SDKUserMessage } from '@anthropic-ai/claude-agent-sdk'
import type { EngineAuth, EngineModel, EngineModels, EngineStatus } from '@shared/engines'
import type { EffortLevel } from '@shared/types'
import { EngineError, type EngineAdapter, type EngineTurnInput, type EngineTurnResult } from '../types'
import { ClaudeTurn } from './turn'

/**
 * Claude as an Eaon engine: the user's own Claude Code, run through
 * Anthropic's Agent SDK, signed in the way Claude Code signs in. With a
 * Claude account that is their Pro or Max plan; with a key, their key.
 *
 * Anthropic's terms for running Claude Code in other products
 * (code.claude.com/docs/en/legal-and-compliance) are what this keeps to:
 * - the Claude Code binary runs as Anthropic published it: the user's own
 *   install, never a copy of Eaon's;
 * - sign-in happens only in Claude Code's own flow (`claude auth login`, in
 *   the user's terminal); Eaon never reads, stores or passes on a Claude
 *   sign-in or token, and reads only "signed in", how, and the plan from
 *   `claude auth status`;
 * - Eaon doesn't pay for, resell or route anyone else's usage: each turn is
 *   the user's own, on their own account;
 * - Claude Code's own system prompt, untouched. The user's project
 *   instructions or worker role open a new session as their own words, as
 *   for the ACP engines;
 * - it says who it is: `CLAUDE_AGENT_SDK_CLIENT_APP` names Eaon.
 *
 * Each turn is a Claude Code process of its own, resuming the session by id;
 * its sessions are the user's, in Claude Code's own history.
 */

const STATUS_FRESH_MS = 5 * 60_000
const PROBE_MS = 30_000
const LOGIN_WAIT_MS = 5 * 60_000
const LOGIN_POLL_MS = 3_000
const STDERR_LIMIT = 8_000
/** How old a sign-in check may be before a turn checks again that nothing would be charged. */
const CHARGE_CHECK_MS = 60_000
const INSTALL = 'npm install -g @anthropic-ai/claude-code'
const EMPTY_USAGE = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }

type QueryFn = (args: { prompt: AsyncIterable<SDKUserMessage>; options?: Options }) => Query

export interface ClaudeEngineDeps {
  /** The executable for a name, on the user's PATH; null when it isn't there. */
  which: (bin: string) => string | null
  /** The environment Claude Code runs in: the user's, with the Claude account chosen in Settings → Accounts. */
  env: () => Record<string, string | undefined>
  /** Runs a command and returns what it printed; never throws. */
  run: (command: string, args: string[], env: Record<string, string | undefined>) => Promise<{ ok: boolean; stdout: string; stderr: string }>
  /** An empty folder for the model check's session, so it reads no project. */
  probeDir: () => string
  clientVersion: string
  /** Opens the user's terminal running `command`: Claude Code signs in only there. */
  openTerminal: (command: string, title: string) => Promise<void>
  /** The Agent SDK's `query`; a stand-in in tests. */
  query?: QueryFn
  now?: () => number
}

/** Eaon's effort names and the Agent SDK's. */
const TO_SDK: Partial<Record<EffortLevel, 'low' | 'medium' | 'high' | 'xhigh' | 'max'>> = {
  minimal: 'low',
  light: 'low',
  medium: 'medium',
  high: 'high',
  'extra-high': 'xhigh',
  ultra: 'max'
}
const FROM_SDK: Record<string, EffortLevel> = { low: 'light', medium: 'medium', high: 'high', xhigh: 'extra-high', max: 'ultra' }

/** What `claude auth status --json` says, without anything that names the person. */
export function authOf(stdout: string): EngineAuth {
  let report: { loggedIn?: unknown; authMethod?: unknown; subscriptionType?: unknown; apiProvider?: unknown }
  try {
    report = JSON.parse(stdout)
  } catch {
    return { state: 'unknown', method: null, plan: null }
  }
  if (report.loggedIn !== true) return { state: 'signed-out', method: null, plan: null }
  const account = report.authMethod === 'claude.ai'
  const plan = account && typeof report.subscriptionType === 'string' && report.subscriptionType ? report.subscriptionType[0].toUpperCase() + report.subscriptionType.slice(1) : null
  const method = account ? 'Claude account' : typeof report.apiProvider === 'string' && report.apiProvider !== 'firstParty' ? report.apiProvider : 'API key'
  return { state: 'signed-in', method, plan }
}

/** Claude Code's model list, as the pickers draw it: its own default first. */
export function modelsOf(list: ModelInfo[], at: number): EngineModel[] {
  const source = { kind: 'engine-live' as const, retrievedAt: at }
  const efforts = (m: ModelInfo): EffortLevel[] => (m.supportsEffort ? (m.supportedEffortLevels ?? []).map((e) => FROM_SDK[e]).filter(Boolean) : [])
  const fallback = list.find((m) => m.value === 'default')
  const models: EngineModel[] = [
    {
      id: '',
      label: 'Default',
      description: fallback?.description || 'What Claude Code is set to use',
      efforts: fallback ? efforts(fallback) : [],
      defaultEffort: null,
      vision: true,
      isDefault: true,
      source
    }
  ]
  for (const m of list) {
    if (m.value === 'default') continue
    models.push({ id: m.value, label: m.displayName || m.value, description: m.description, efforts: efforts(m), defaultEffort: null, vision: true, isDefault: false, source })
  }
  return models
}

/** The models to offer when Claude Code couldn't be asked: its own aliases, which it maps to the newest of each. */
function shippedModels(): EngineModel[] {
  const source = { kind: 'shipped' as const, retrievedAt: null }
  const row = (id: string, label: string, description: string, isDefault = false): EngineModel => ({ id, label, description, efforts: [], defaultEffort: null, vision: true, isDefault, source })
  return [
    row('', 'Default', 'What Claude Code is set to use', true),
    row('opus', 'Opus', 'The most capable Claude model'),
    row('sonnet', 'Sonnet', 'Claude’s everyday model'),
    row('haiku', 'Haiku', 'The fastest Claude model')
  ]
}

/** An attached image as a message block; skipped when it can't be read. */
async function imageBlock(path: string): Promise<Record<string, unknown> | null> {
  const ext = path.toLowerCase().split('.').pop() ?? ''
  const media = ext === 'png' ? 'image/png' : ext === 'gif' ? 'image/gif' : ext === 'webp' ? 'image/webp' : ext === 'jpg' || ext === 'jpeg' ? 'image/jpeg' : null
  if (!media) return null
  try {
    return { type: 'image', source: { type: 'base64', media_type: media, data: (await readFile(path)).toString('base64') } }
  } catch {
    return null
  }
}

/** A message for Claude Code's stream input, from the person at the keyboard. */
function userMessage(content: Record<string, unknown>[]): SDKUserMessage {
  return { type: 'user', message: { role: 'user', content }, parent_tool_use_id: null, origin: { kind: 'human' } } as unknown as SDKUserMessage
}

export class ClaudeEngine implements EngineAdapter {
  readonly id = 'claude' as const
  private status: EngineStatus | null = null
  private models: EngineModels | null = null
  private readonly listeners = new Set<(status: EngineStatus) => void>()
  private readonly running = new Set<AbortController>()
  private login_: { cancelled: boolean } | null = null
  /** The plan went on to extra usage: no turn starts before this, so nothing more is charged. */
  private extraUsageUntil = 0

  constructor(private readonly deps: ClaudeEngineDeps) {}

  private now(): number {
    return this.deps.now?.() ?? Date.now()
  }

  private path(): string | null {
    return this.deps.which('claude')
  }

  private async query(): Promise<QueryFn> {
    // Loaded on first use: most launches never start a Claude turn.
    return this.deps.query ?? ((await import('@anthropic-ai/claude-agent-sdk')).query as QueryFn)
  }

  /**
   * Claude Code's environment, without a key in it: a key there would win
   * over the user's sign-in and be charged per use, and this engine is for
   * their Claude plan.
   */
  private env(): Record<string, string | undefined> {
    const env: Record<string, string | undefined> = { ...this.deps.env(), CLAUDE_AGENT_SDK_CLIENT_APP: `eaon/${this.deps.clientVersion}` }
    delete env.ANTHROPIC_API_KEY
    delete env.ANTHROPIC_AUTH_TOKEN
    return env
  }

  async detect(options: { force?: boolean } = {}): Promise<EngineStatus> {
    if (!options.force && this.status && this.now() - this.status.checkedAt < STATUS_FRESH_MS) return this.status
    const path = this.path()
    const status: EngineStatus = {
      id: this.id,
      name: 'Claude Agent',
      installed: path !== null,
      path,
      foundIn: path ? 'PATH' : null,
      version: null,
      latestVersion: null,
      updateAvailable: false,
      outdated: false,
      minVersion: null,
      updateHint: INSTALL,
      auth: { state: 'unknown', method: null, plan: null },
      error: null,
      checkedAt: this.now()
    }
    if (!path) return (this.status = status)
    const env = this.env()
    const [version, auth] = await Promise.all([this.deps.run(path, ['--version'], env), this.deps.run(path, ['auth', 'status', '--json'], env)])
    status.version = /\d+\.\d+\.\d+/.exec(version.stdout)?.[0] ?? null
    if (!version.ok || !status.version) status.error = 'Claude Code didn’t start. Try running claude in a terminal.'
    // `auth status` exits non-zero when signed out, with the JSON still printed.
    else status.auth = authOf(auth.stdout)
    return (this.status = status)
  }

  async listModels(options: { force?: boolean } = {}): Promise<EngineModels> {
    if (!options.force && this.models && this.models.retrievedAt && this.now() - this.models.retrievedAt < STATUS_FRESH_MS) return this.models
    const path = this.path()
    const fallback = (why: string): EngineModels => ({
      engine: this.id,
      models: this.models?.models ?? shippedModels(),
      retrievedAt: this.models?.retrievedAt ?? null,
      staleBecause: why
    })
    if (!path) return fallback('Claude Code isn’t installed.')
    const probe = this.deps.probeDir()
    mkdirSync(probe, { recursive: true })
    const controller = new AbortController()
    this.running.add(controller)
    const query = await this.query()
    // A session that is never sent a message: Claude Code starts, says what it offers, and stops. No request is made.
    const idle: AsyncIterable<SDKUserMessage> = {
      [Symbol.asyncIterator]: () => ({ next: () => new Promise((resolve) => controller.signal.addEventListener('abort', () => resolve({ done: true, value: undefined }), { once: true })) })
    }
    const session = query({ prompt: idle, options: { cwd: probe, pathToClaudeCodeExecutable: path, env: this.env(), persistSession: false, abortController: controller } })
    try {
      const at = this.now()
      const list = await Promise.race([
        session.supportedModels(),
        new Promise<never>((_, reject) => setTimeout(() => reject(new Error('Claude Code didn’t list its models in time.')), PROBE_MS).unref?.())
      ])
      return (this.models = { engine: this.id, models: modelsOf(list, at), retrievedAt: at, staleBecause: null })
    } catch (error) {
      return fallback(error instanceof Error ? error.message : String(error))
    } finally {
      controller.abort()
      session.close()
      this.running.delete(controller)
    }
  }

  async login(): Promise<void> {
    const path = this.path()
    if (!path) throw new Error(`Claude Code isn’t installed. Install it with ${INSTALL}.`)
    const attempt = { cancelled: false }
    this.login_ = attempt
    try {
      // Claude Code's own sign-in, where the user can see it: Eaon only opens the terminal and waits.
      await this.deps.openTerminal(`${/\s/.test(path) ? `'${path.replace(/'/g, `'\\''`)}'` : path} auth login`, 'Sign in to Claude')
      const until = this.now() + LOGIN_WAIT_MS
      while (this.now() < until) {
        await new Promise((resolve) => setTimeout(resolve, LOGIN_POLL_MS))
        if (attempt.cancelled) throw new Error('Sign-in cancelled.')
        if ((await this.detect({ force: true })).auth.state === 'signed-in') return
      }
      throw new Error('Claude isn’t signed in yet. Finish signing in in the terminal, then check again.')
    } finally {
      if (this.login_ === attempt) this.login_ = null
    }
  }

  async cancelLogin(): Promise<void> {
    if (this.login_) this.login_.cancelled = true
  }

  subscribe(listener: (status: EngineStatus) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  /** A turn found the sign-in gone: say so everywhere, not only in this turn's error. */
  private signedOut(): void {
    if (!this.status) return
    this.status = { ...this.status, auth: { state: 'signed-out', method: null, plan: null }, checkedAt: this.now() }
    for (const listener of this.listeners) listener(this.status)
  }

  async runTurn(input: EngineTurnInput): Promise<EngineTurnResult> {
    const path = this.path()
    if (!path) return this.failed(new EngineError('not-installed', `Claude Code isn’t installed. Install it with ${INSTALL}.`), input.sessionId)
    // Nothing that could be charged: Claude Code signed in with a Claude account, and the plan not on extra usage.
    const stale = !this.status || this.now() - this.status.checkedAt > CHARGE_CHECK_MS
    const { auth } = await this.detect({ force: stale })
    if (auth.state === 'signed-out') return this.failed(new EngineError('signed-out', 'Claude isn’t signed in. Sign in in Settings → Agent engines.'), input.sessionId)
    if (auth.state === 'signed-in' && auth.method !== 'Claude account') {
      return this.failed(
        new EngineError('misconfigured', 'Claude Code is signed in with an API key, which Anthropic charges per use. To use your Claude plan instead, sign in with your Claude account: claude auth login.'),
        input.sessionId
      )
    }
    if (this.now() < this.extraUsageUntil) {
      const at = new Date(this.extraUsageUntil).toLocaleString(undefined, { weekday: 'short', hour: 'numeric', minute: '2-digit' })
      return this.failed(new EngineError('rate-limited', `Your Claude plan’s limit is used up, and going on would use extra usage, which Anthropic charges for. Try again after ${at}.`), input.sessionId)
    }
    const first = await this.attempt(input, path, input.sessionId)
    // Claude Code no longer has the session (deleted, or another computer's): a new one, saying so.
    if (input.sessionId && first.missingSession && !input.signal.aborted) {
      const fresh = await this.attempt(input, path, null)
      return { ...fresh.result, sessionReplaced: true, notice: ['Claude no longer had this conversation, so it started a new one.', fresh.result.notice].filter(Boolean).join(' ') }
    }
    return first.result
  }

  private failed(error: unknown, sessionId: string | null, detail?: string): EngineTurnResult {
    const kind = error instanceof EngineError ? error.kind : 'engine-crashed'
    if (kind === 'signed-out') this.signedOut()
    const message = error instanceof Error ? error.message : String(error)
    return {
      sessionId,
      text: '',
      usage: EMPTY_USAGE,
      cancelled: false,
      error: error instanceof EngineError ? message : 'Claude Code stopped unexpectedly.',
      errorKind: kind,
      errorDetail: detail || message,
      sideEffects: false,
      billing: 'unknown'
    }
  }

  private async attempt(input: EngineTurnInput, path: string, sessionId: string | null): Promise<{ result: EngineTurnResult; missingSession: boolean }> {
    const turn = new ClaudeTurn(input.messageId, input.emit, input.approve)
    const controller = new AbortController()
    this.running.add(controller)
    let stderr = ''
    let cancelled = false
    /** Eaon ended it, before anything could be charged (ClaudeTurn `stop`). */
    let stopped = false
    const onAbort = (): void => {
      cancelled = true
      turn.cancelPending()
      controller.abort()
    }
    if (input.signal.aborted) onAbort()
    else input.signal.addEventListener('abort', onAbort, { once: true })

    // The user's own project instructions or worker role, at the start of a session: their words, not a system prompt of Eaon's.
    const lead = !sessionId && input.instructions.trim() ? `${input.instructions.trim()}\n\n---\n\n` : ''
    const content: Record<string, unknown>[] = [{ type: 'text', text: `${lead}${input.text}` }]
    for (const image of input.images) {
      const block = await imageBlock(image)
      if (block) content.push(block)
    }
    // The input stays open until the result: Claude Code answers its permission questions over it.
    let ended = (): void => {}
    const over = new Promise<void>((resolve) => (ended = resolve))
    async function* prompt(): AsyncGenerator<SDKUserMessage> {
      yield userMessage(content)
      await over
    }
    const model = input.model || undefined
    const known = this.models?.models.find((m) => m.id === (input.model ?? ''))
    const effort = input.effort && known?.efforts.includes(input.effort) ? TO_SDK[input.effort] : undefined
    try {
      const query = await this.query()
      const session = query({
        prompt: prompt(),
        options: {
          cwd: input.cwd,
          ...(model ? { model } : {}),
          ...(sessionId ? { resume: sessionId } : {}),
          ...(effort ? { effort } : {}),
          pathToClaudeCodeExecutable: path,
          env: this.env(),
          includePartialMessages: true,
          // Claude Code's own read-only mode for a plan; otherwise it asks, and Eaon's approval policy answers.
          permissionMode: input.access === 'read-only' ? 'plan' : 'default',
          canUseTool: (name, toolInput, options) => turn.permission(name, toolInput, options),
          abortController: controller,
          stderr: (data: string) => {
            if (stderr.length < STDERR_LIMIT) stderr += data
          }
        }
      })
      for await (const message of session) {
        turn.handle(message)
        if (message.type === 'result') ended()
        if (turn.stop) {
          stopped = true
          controller.abort()
          break
        }
      }
    } catch (error) {
      if (!cancelled && !stopped) {
        const said = `${error instanceof Error ? error.message : String(error)}\n${stderr}`.trim()
        if (sessionId && /no conversation found/i.test(said)) return { result: this.failed(error, sessionId, said), missingSession: true }
        if (/ENOENT/.test(said)) return { result: this.failed(new EngineError('not-installed', 'Claude Code couldn’t be started.'), sessionId, said), missingSession: false }
        if (!turn.finished) return { result: this.failed(turn.error ? new EngineError(turn.error.kind, turn.error.message) : error, turn.sessionId ?? sessionId, said), missingSession: false }
      }
    } finally {
      ended()
      input.signal.removeEventListener('abort', onAbort)
      this.running.delete(controller)
    }

    if (turn.error?.kind === 'signed-out') this.signedOut()
    if (turn.extraUsageUntil) this.extraUsageUntil = turn.extraUsageUntil
    const missingSession = Boolean(sessionId && !turn.text && turn.error && /no conversation found/i.test(turn.error.detail))
    return {
      missingSession,
      result: {
        sessionId: turn.sessionId ?? sessionId,
        text: turn.answer ?? turn.text,
        usage: turn.usage,
        cancelled,
        sideEffects: turn.sideEffects,
        billing: turn.billing,
        ...(turn.notice ? { notice: turn.notice } : {}),
        ...(turn.error && !cancelled ? { error: turn.error.message, errorKind: turn.error.kind, errorDetail: turn.error.detail } : {})
      }
    }
  }

  async dispose(): Promise<void> {
    for (const controller of this.running) controller.abort()
    this.running.clear()
  }
}
