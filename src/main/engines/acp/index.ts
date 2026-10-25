import { execFile } from 'node:child_process'
import { mkdirSync } from 'node:fs'
import type { EngineAuth, EngineModel, EngineModels, EngineStatus } from '@shared/engines'
import { AppServer, AppServerExited, RpcError, RpcTimeout } from '../codex/appServer'
import { spawnSpec } from '../../features/eaonCode/locate'
import { EngineError, type EngineAdapter, type EngineTurnInput, type EngineTurnResult } from '../types'
import { modelLabel, type AcpAgentSpec, type AcpEngineId } from './agents'
import {
  ACP_PROTOCOL_VERSION,
  AUTH_REQUIRED,
  type AcpAuthMethod,
  type AcpConfigOption,
  type AcpInitializeResponse,
  type AcpNewSessionResponse,
  type AcpPermissionRequest,
  type AcpSelectOption,
  type AcpSessionUpdate,
  type AcpStopReason
} from './protocol'
import { AcpTurn } from './turn'

/**
 * An agent CLI as an Eaon engine, over the Agent Client Protocol: GitHub
 * Copilot CLI or Gemini CLI (agents.ts), the user's own install, signed in
 * its own way. Eaon starts its documented ACP mode and talks to it as an
 * editor would; the CLI makes every model request itself, against the
 * user's own plan.
 *
 * What Eaon never does with these CLIs: read their sign-in or tokens, call
 * their makers' services itself, change how they identify themselves, or
 * add a system prompt. A turn carries only what the user wrote, with their
 * own project instructions or worker role at the start of a new session.
 *
 * Sign-in is read from the protocol alone: a `session/new` that fails with
 * ACP's "authentication required" means signed out. Every session leaves a
 * folder behind (Copilot keeps even an empty, closed one, and can't load it
 * again), so that session is opened only when the answer may have changed:
 * the first check after Eaon starts, a check the user asks for, or one after
 * a check that didn't find it signed in. The checks in between only shake
 * hands; a turn that finds the sign-in gone says so at once (`signedOut`).
 *
 * Each session runs in its own process, kept between turns for a while; a
 * later turn on a process that has gone resumes the session with
 * `session/load` when the agent supports it. Turns on one session run one at
 * a time.
 */

const STATUS_FRESH_MS = 5 * 60_000
const SESSION_IDLE_MS = 10 * 60_000
const HANDSHAKE_MS = 30_000
const LOGIN_WAIT_MS = 5 * 60_000
const LOGIN_POLL_MS = 3_000
/** The plan check (agents.ts `planCheck`) gives up after this long in all, offering the models it didn't reach. */
const PLAN_CHECK_MS = 20_000
const PLAN_ANSWER_MS = 10_000
/** How long a new session gets to list its slash commands before the plan check goes without. */
const COMMANDS_WAIT_MS = 2_000

export interface AcpEngineDeps {
  /** The executable for a name, on the user's PATH; null when it isn't there. */
  which: (bin: string) => string | null
  env: () => NodeJS.ProcessEnv
  /** An empty folder for the sign-in check's session, so it reads no project. */
  probeDir: () => string
  clientVersion: string
  /** Opens the user's terminal running `command`, for a CLI that signs in only there. */
  openTerminal: (command: string, title: string) => Promise<void>
  now?: () => number
}

interface Live {
  server: AppServer
  sessionId: string
  model: string | null
  /** The session can pick a model through this config option or the draft `session/set_model`. */
  modelOption: string | null
  draftModels: boolean
  /** Turns on this session, one after another. */
  queue: Promise<unknown>
  idle: ReturnType<typeof setTimeout> | null
}

const EMPTY_USAGE = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }

/** The model selector a session reports, as a flat list of options. */
function modelOptionOf(options: AcpConfigOption[] | null | undefined): { id: string; options: AcpSelectOption[]; current: string | null } | null {
  const option = options?.find((o) => o.category === 'model' && (o.type ?? 'select') === 'select')
  if (!option?.options) return null
  const flat = (option.options as unknown[]).flatMap((entry) => {
    const item = entry as AcpSelectOption & { options?: AcpSelectOption[] }
    return Array.isArray(item.options) ? item.options : [item]
  })
  return { id: option.id, options: flat, current: option.currentValue ?? null }
}

/**
 * The account sign-in among an agent's methods: one it runs itself (a browser
 * login), never one that needs a key typed in. A method described with
 * `_meta["terminal-auth"]` (Copilot's, from before ACP had a terminal type)
 * is a terminal one, whatever its type says.
 */
export function accountMethod(methods: AcpAuthMethod[]): AcpAuthMethod | null {
  const agent = methods.filter((m) => (!m.type || m.type === 'agent') && !m._meta?.['terminal-auth'])
  return agent.find((m) => !/key|vertex|gateway|token/i.test(`${m.id} ${m.name}`)) ?? null
}

/**
 * The slash commands a new session lists (ACP's `available_commands_update`),
 * collected from before `session/new` is sent: an agent may list them before
 * or just after it answers. `has` waits a moment for the list.
 */
function listedCommands(server: AppServer): { has: (name: string) => Promise<boolean>; stop: () => void } {
  const names = new Set<string>()
  let listed: (() => void) | null = null
  const stop = server.onNotification((method, params) => {
    const update = (params as { update?: AcpSessionUpdate } | undefined)?.update
    if (method !== 'session/update' || update?.sessionUpdate !== 'available_commands_update') return
    for (const command of (update as { availableCommands?: { name?: unknown }[] }).availableCommands ?? []) {
      if (typeof command.name === 'string') names.add(command.name)
    }
    listed?.()
  })
  return {
    has: async (name) => {
      if (!names.has(name)) {
        await new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, COMMANDS_WAIT_MS)
          listed = () => {
            if (!names.has(name)) return
            clearTimeout(timer)
            resolve()
          }
        })
        listed = null
      }
      return names.has(name)
    },
    stop
  }
}

/** The command a terminal sign-in runs, from the agent's own description of it, else the spec's. */
function terminalCommand(methods: AcpAuthMethod[], fallback: string): string {
  for (const method of methods) {
    const meta = method._meta?.['terminal-auth'] as { command?: unknown; args?: unknown } | undefined
    if (typeof meta?.command === 'string') {
      const args = Array.isArray(meta.args) ? meta.args.filter((a): a is string => typeof a === 'string') : []
      return [meta.command, ...args].map((part) => (/[\s"'$`\\]/.test(part) ? `'${part.replace(/'/g, `'\\''`)}'` : part)).join(' ')
    }
  }
  return fallback
}

export class AcpEngine implements EngineAdapter {
  readonly id: AcpEngineId
  private status: EngineStatus | null = null
  /** Models the last signed-in session reported, when it reported any. */
  private sessionModels: { options: AcpSelectOption[]; current: string | null } | null = null
  private models: EngineModels | null = null
  private readonly live = new Map<string, Live>()
  private readonly listeners = new Set<(status: EngineStatus) => void>()
  private login_: { cancelled: boolean } | null = null
  /** A session-opening check found it signed in, this run. */
  private signedInSeen = false
  /** What the last plan check found: the models the account's plan refuses, and whether it offers Auto only. */
  private plan: { refused: Set<string>; autoOnly: boolean } | null = null

  constructor(
    private readonly spec: AcpAgentSpec,
    private readonly deps: AcpEngineDeps
  ) {
    this.id = spec.id
  }

  private now(): number {
    return this.deps.now?.() ?? Date.now()
  }

  private path(): string | null {
    for (const bin of this.spec.bins) {
      const found = this.deps.which(bin)
      if (found) return found
    }
    return null
  }

  /** Starts the CLI's ACP mode and completes the handshake. */
  private async connect(command: string, cwd: string, extraArgs: string[] = []): Promise<{ server: AppServer; info: AcpInitializeResponse }> {
    const server = AppServer.spawn({
      command,
      args: [...this.spec.args, ...extraArgs],
      cwd,
      env: this.deps.env(),
      clientVersion: this.deps.clientVersion,
      jsonrpc: true,
      label: this.spec.name
    })
    try {
      const info = await server.request<AcpInitializeResponse>(
        'initialize',
        {
          protocolVersion: ACP_PROTOCOL_VERSION,
          // No file system or terminal of Eaon's: the agent uses its own tools, and asks before it runs them.
          clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
          clientInfo: { name: 'eaon', title: 'Eaon', version: this.deps.clientVersion }
        },
        HANDSHAKE_MS
      )
      return { server, info: info ?? { protocolVersion: ACP_PROTOCOL_VERSION } }
    } catch (error) {
      await server.stop(1000)
      throw error
    }
  }

  private base(path: string | null): EngineStatus {
    return {
      id: this.id,
      name: this.spec.name,
      installed: path !== null,
      path,
      foundIn: path ? 'PATH' : null,
      version: null,
      latestVersion: null,
      updateAvailable: false,
      outdated: false,
      minVersion: null,
      updateHint: this.spec.install,
      auth: { state: 'unknown', method: null, plan: null },
      error: null,
      checkedAt: this.now()
    }
  }

  async detect(options: { force?: boolean } = {}): Promise<EngineStatus> {
    if (!options.force && this.status && this.now() - this.status.checkedAt < STATUS_FRESH_MS) return this.status
    const path = this.path()
    const status = this.base(path)
    if (!path) return (this.status = status)
    let server: AppServer | null = null
    try {
      const probe = this.deps.probeDir()
      mkdirSync(probe, { recursive: true })
      const connected = await this.connect(path, probe)
      server = connected.server
      status.version = connected.info.agentInfo?.version ?? null
      const known = !options.force && this.signedInSeen && this.status?.auth.state === 'signed-in'
      if (known) {
        status.auth = this.status!.auth
        return (this.status = status)
      }
      const commands = listedCommands(server)
      try {
        const session = await server.request<AcpNewSessionResponse>('session/new', { cwd: probe, mcpServers: [] }, HANDSHAKE_MS)
        this.signedInSeen = true
        status.auth = { state: 'signed-in', method: null, plan: null }
        const found = modelOptionOf(session.configOptions)
        this.sessionModels = found
          ? { options: found.options, current: found.current }
          : session.models
            ? { options: session.models.availableModels.map((m) => ({ value: m.modelId, name: m.name, description: m.description })), current: session.models.currentModelId }
            : null
        const check = this.spec.planCheck
        if (check && (await commands.has(check.command))) await this.checkPlan(server, session.sessionId, path).catch(() => undefined)
        // The check's session isn't the user's: closed where the agent can, so it doesn't sit in their history as a live one.
        if (connected.info.agentCapabilities?.sessionCapabilities?.close !== undefined) {
          await server.request('session/close', { sessionId: session.sessionId }, 5_000).catch(() => undefined)
        }
      } catch (error) {
        if (error instanceof RpcError && error.code === AUTH_REQUIRED) status.auth = { state: 'signed-out', method: null, plan: null }
        else status.error = describe(error, this.spec.name)
      } finally {
        commands.stop()
      }
    } catch (error) {
      status.error = describe(error, this.spec.name)
    } finally {
      await server?.stop(1500)
    }
    return (this.status = status)
  }

  /** The models to offer: the session's own list when it reported one, else the one in the CLI's help. */
  private async modelIds(path: string | null): Promise<{ id: string; label: string; description?: string }[]> {
    if (this.sessionModels?.options.length) {
      return this.sessionModels.options.map((o) => ({ id: o.value, label: o.name || modelLabel(o.value), ...(o.description ? { description: o.description } : {}) }))
    }
    if (!this.spec.modelsCommand || !path) return []
    return this.spec.modelsCommand.parse(await runText(path, this.spec.modelsCommand.args, this.deps.env())).map((id) => ({ id, label: modelLabel(id) }))
  }

  async listModels(options: { force?: boolean } = {}): Promise<EngineModels> {
    if (!options.force && this.models && this.now() - (this.models.retrievedAt ?? 0) < STATUS_FRESH_MS) return this.models
    const at = this.now()
    const source = { kind: 'engine-live' as const, retrievedAt: at }
    const ids = await this.modelIds(this.path())
    const plan = this.plan
    // The CLI's own default (its saved choice, or what it picks) always comes first, so there is something to choose.
    // On a plan that offers Auto only, that is all there is.
    if (plan?.autoOnly) {
      const auto: EngineModel = { id: '', label: 'Auto', description: `${this.spec.name} picks the model for each message`, efforts: [], defaultEffort: null, vision: null, isDefault: true, source }
      return (this.models = {
        engine: this.id,
        models: [auto],
        retrievedAt: at,
        staleBecause: null,
        note: `Your ${this.spec.name} plan offers Auto only, so ${this.spec.name} picks the model for each message.`
      })
    }
    const fallback: EngineModel = { id: '', label: 'Default', description: `What ${this.spec.name} is set to use`, efforts: [], defaultEffort: null, vision: null, isDefault: true, source }
    const models: EngineModel[] = [
      fallback,
      ...ids.map((m) => ({
        id: m.id,
        label: m.label,
        ...(m.description ? { description: m.description } : {}),
        ...(plan?.refused.has(m.id) ? { unavailable: `Your ${this.spec.name} plan doesn’t include ${m.label}.` } : {}),
        efforts: [],
        defaultEffort: null,
        vision: null,
        isDefault: false,
        source
      }))
    ]
    return (this.models = { engine: this.id, models, retrievedAt: at, staleBecause: null })
  }

  /**
   * Which models the account's plan refuses, asked in the check's own session
   * with the CLI's plan command (agents.ts `planCheck`), one model at a time.
   * A plan that offers Auto only says so at the first answer. An answer that
   * isn't a refusal, or a model the time ran out before, stays offered.
   */
  private async checkPlan(server: AppServer, sessionId: string, path: string): Promise<void> {
    const check = this.spec.planCheck!
    const refused = new Set<string>()
    let autoOnly = false
    const until = this.now() + PLAN_CHECK_MS
    for (const { id } of await this.modelIds(path)) {
      if (this.now() > until) break
      const answer = await this.ask(server, sessionId, `/${check.command} ${id}`)
      if (check.autoOnly.test(answer)) {
        autoOnly = true
        break
      }
      if (check.refused.test(answer)) refused.add(id)
    }
    this.plan = { refused, autoOnly }
  }

  /** Sends one of the CLI's own slash commands and returns its answer's text. */
  private async ask(server: AppServer, sessionId: string, text: string): Promise<string> {
    let answer = ''
    const stop = server.onNotification((method, params) => {
      const p = params as { sessionId?: string; update?: AcpSessionUpdate }
      if (method !== 'session/update' || p?.sessionId !== sessionId || p.update?.sessionUpdate !== 'agent_message_chunk') return
      const content = (p.update as { content?: { type?: string; text?: unknown } }).content
      if (content?.type === 'text' && typeof content.text === 'string') answer += content.text
    })
    try {
      await server.request('session/prompt', { sessionId, prompt: [{ type: 'text', text }] }, PLAN_ANSWER_MS)
    } finally {
      stop()
    }
    return answer
  }

  async login(): Promise<void> {
    const path = this.path()
    if (!path) throw new Error(`${this.spec.name} isn’t installed. Install it with ${this.spec.install}.`)
    const attempt = { cancelled: false }
    this.login_ = attempt
    try {
      const probe = this.deps.probeDir()
      mkdirSync(probe, { recursive: true })
      const { server, info } = await this.connect(path, probe)
      const methods = info.authMethods ?? []
      const method = accountMethod(methods)
      try {
        // The agent signs in itself (a browser window of its own); Eaon only asks it to start.
        if (method) {
          await server.request('authenticate', { methodId: method.id }, LOGIN_WAIT_MS)
          return
        }
      } finally {
        await server.stop(1500)
      }
      // Only a terminal sign-in: it runs where the user can see it, and Eaon waits for the check to pass.
      await this.deps.openTerminal(terminalCommand(methods, this.spec.loginCommand), `Sign in to ${this.spec.name}`)
      const until = this.now() + LOGIN_WAIT_MS
      while (this.now() < until) {
        await new Promise((resolve) => setTimeout(resolve, LOGIN_POLL_MS))
        if (attempt.cancelled) throw new Error('Sign-in cancelled.')
        if ((await this.detect({ force: true })).auth.state === 'signed-in') return
      }
      throw new Error(`${this.spec.name} isn’t signed in yet. Finish signing in in the terminal, then check again.`)
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
    this.signedInSeen = false
    if (!this.status) return
    this.status = { ...this.status, auth: { state: 'signed-out', method: null, plan: null } satisfies EngineAuth, checkedAt: this.now() }
    for (const listener of this.listeners) listener(this.status)
  }

  /** The session's process: the warm one, or a new one that resumes or starts the session. */
  private async open(input: EngineTurnInput, path: string): Promise<{ live: Live; replaced: boolean }> {
    const model = input.model || null
    const warm = input.sessionId ? this.live.get(input.sessionId) : undefined
    if (warm && warm.server.running && warm.model === model) return { live: warm, replaced: false }
    if (warm) this.close(warm)
    // The model goes on the command line: neither CLI lets a session pick one over ACP yet.
    const { server, info } = await this.connect(path, input.cwd, model ? [this.spec.modelFlag, model] : [])
    try {
      let sessionId: string | null = null
      let replaced = false
      let session: AcpNewSessionResponse | null = null
      if (input.sessionId && info.agentCapabilities?.loadSession) {
        try {
          // The agent replays the conversation as updates while loading; nothing listens yet, so none of it reaches the transcript.
          session = { sessionId: input.sessionId, ...(await server.request<Partial<AcpNewSessionResponse>>('session/load', { sessionId: input.sessionId, cwd: input.cwd, mcpServers: [] }, HANDSHAKE_MS)) }
          sessionId = input.sessionId
        } catch (error) {
          if (error instanceof RpcError && error.code === AUTH_REQUIRED) throw error
          replaced = true
        }
      } else if (input.sessionId) {
        replaced = true
      }
      if (!sessionId) {
        session = await server.request<AcpNewSessionResponse>('session/new', { cwd: input.cwd, mcpServers: [] }, HANDSHAKE_MS)
        sessionId = session.sessionId
      }
      const option = modelOptionOf(session?.configOptions)
      const live: Live = { server, sessionId, model, modelOption: option?.id ?? null, draftModels: Boolean(session?.models), queue: Promise.resolve(), idle: null }
      if (model && live.modelOption) {
        await server.request('session/set_config_option', { sessionId, configId: live.modelOption, value: model }, HANDSHAKE_MS).catch(() => undefined)
      } else if (model && live.draftModels) {
        await server.request('session/set_model', { sessionId, modelId: model }, HANDSHAKE_MS).catch(() => undefined)
      }
      this.live.set(sessionId, live)
      return { live, replaced }
    } catch (error) {
      await server.stop(1000)
      throw error
    }
  }

  private close(live: Live): void {
    if (live.idle) clearTimeout(live.idle)
    this.live.delete(live.sessionId)
    void live.server.stop(1500)
  }

  async runTurn(input: EngineTurnInput): Promise<EngineTurnResult> {
    const failed = (error: unknown, sessionId: string | null): EngineTurnResult => {
      const kind = classify(error)
      if (kind === 'signed-out') this.signedOut()
      return {
        sessionId,
        text: '',
        usage: EMPTY_USAGE,
        cancelled: false,
        error: kind === 'signed-out' ? `${this.spec.name} isn’t signed in. Sign in in Settings → Agent engines.` : describe(error, this.spec.name),
        errorKind: kind,
        errorDetail: error instanceof Error ? error.message : String(error),
        sideEffects: false,
        billing: 'plan'
      }
    }
    const path = this.path()
    if (!path) return failed(new EngineError('not-installed', `${this.spec.name} isn’t installed. Install it with ${this.spec.install}.`), input.sessionId)
    // A plan that offers Auto only runs every model on Auto: a model chosen before Eaon knew is left out, as the picker shows.
    if (this.plan?.autoOnly && input.model) input = { ...input, model: null }
    let opened: { live: Live; replaced: boolean }
    try {
      opened = await this.open(input, path)
    } catch (error) {
      return failed(error, input.sessionId)
    }
    const { live, replaced } = opened
    if (live.idle) clearTimeout(live.idle)
    const run = live.queue.then(() => this.prompt(live, input, replaced || !input.sessionId))
    live.queue = run.catch(() => undefined)
    const result = await run.catch((error: unknown) => failed(error, live.sessionId))
    if (live.server.running) {
      live.idle = setTimeout(() => this.close(live), SESSION_IDLE_MS)
      live.idle.unref?.()
    } else {
      this.close(live)
    }
    const notices = [
      replaced ? `${this.spec.name} no longer had this conversation, so it started a new one.` : null,
      // The CLI runs a model the plan lacks on Auto without a word; Eaon says so.
      input.model && this.plan?.refused.has(input.model)
        ? `Your ${this.spec.name} plan doesn’t include ${modelLabel(input.model)}, so ${this.spec.name} picked the model.`
        : null,
      result.notice ?? null
    ].filter((n): n is string => Boolean(n))
    return { ...result, ...(replaced ? { sessionReplaced: true } : {}), ...(notices.length ? { notice: notices.join(' ') } : {}) }
  }

  private async prompt(live: Live, input: EngineTurnInput, fresh: boolean): Promise<EngineTurnResult> {
    const { server, sessionId } = live
    const turn = new AcpTurn(input.messageId, input.emit, input.approve)
    const stopListening = server.onNotification((method, params) => {
      const p = params as { sessionId?: string; update?: AcpSessionUpdate }
      if (method === 'session/update' && p?.sessionId === sessionId && p.update) turn.update(p.update)
    })
    server.setRequestHandler(async (method, params) => {
      if (method === 'session/request_permission') return turn.permission(params as AcpPermissionRequest)
      throw new RpcError(-32601, `Eaon doesn’t offer ${method}.`)
    })
    let cancelled = false
    const onAbort = (): void => {
      cancelled = true
      server.notify('session/cancel', { sessionId })
      turn.cancelPending()
    }
    if (input.signal.aborted) onAbort()
    else input.signal.addEventListener('abort', onAbort, { once: true })
    try {
      // The user's own project instructions or worker role, at the start of a session: their words, not a system prompt of Eaon's.
      const lead = fresh && input.instructions.trim() ? `${input.instructions.trim()}\n\n---\n\n` : ''
      const prompt: unknown[] = [{ type: 'text', text: `${lead}${input.text}` }]
      for (const image of input.images) {
        const block = await imageBlock(image)
        if (block) prompt.push(block)
      }
      const { stopReason } = await server.request<{ stopReason: AcpStopReason }>('session/prompt', { sessionId, prompt }, 0)
      return {
        sessionId,
        text: turn.text,
        usage: EMPTY_USAGE,
        cancelled: cancelled || stopReason === 'cancelled',
        sideEffects: turn.sideEffects,
        billing: 'plan',
        ...(stopReason === 'refusal' ? { error: `${this.spec.name} declined to answer.`, errorKind: 'other' as const } : {}),
        ...(stopReason === 'max_tokens' || stopReason === 'max_turn_requests' ? { notice: `${this.spec.name} stopped at its limit for one turn.` } : {})
      }
    } catch (error) {
      if (cancelled) return { sessionId, text: turn.text, usage: EMPTY_USAGE, cancelled: true, sideEffects: turn.sideEffects, billing: 'plan' }
      throw error
    } finally {
      input.signal.removeEventListener('abort', onAbort)
      stopListening()
      server.setRequestHandler(null)
    }
  }

  async dispose(): Promise<void> {
    await Promise.allSettled([...this.live.values()].map((live) => {
      if (live.idle) clearTimeout(live.idle)
      return live.server.stop(1500)
    }))
    this.live.clear()
  }
}

/** An image the user attached, as an ACP image block; skipped when it can't be read. */
async function imageBlock(path: string): Promise<{ type: 'image'; mimeType: string; data: string } | null> {
  const { readFile } = await import('node:fs/promises')
  const ext = path.toLowerCase().split('.').pop() ?? ''
  const mimeType = ext === 'png' ? 'image/png' : ext === 'gif' ? 'image/gif' : ext === 'webp' ? 'image/webp' : ext === 'jpg' || ext === 'jpeg' ? 'image/jpeg' : null
  if (!mimeType) return null
  try {
    return { type: 'image', mimeType, data: (await readFile(path)).toString('base64') }
  } catch {
    return null
  }
}

function classify(error: unknown): EngineTurnResult['errorKind'] {
  if (error instanceof EngineError) return error.kind
  if (error instanceof RpcError && error.code === AUTH_REQUIRED) return 'signed-out'
  if (error instanceof AppServerExited) return /ENOENT/.test(error.exit.stderr) ? 'not-installed' : 'engine-crashed'
  if (error instanceof RpcTimeout) return 'engine-crashed'
  return 'other'
}

function describe(error: unknown, name: string): string {
  if (error instanceof EngineError) return error.message
  if (error instanceof AppServerExited) return /ENOENT/.test(error.exit.stderr) ? `${name} couldn’t be started.` : `${name} stopped unexpectedly.`
  if (error instanceof RpcTimeout) return `${name} didn’t answer in time.`
  if (error instanceof RpcError) return `${name}: ${error.message}`
  return error instanceof Error ? error.message : String(error)
}

/** A command's output; empty when it fails. `.cmd` shims need a shell on Windows. */
function runText(command: string, args: string[], env: NodeJS.ProcessEnv): Promise<string> {
  const spec = spawnSpec(command, args)
  return new Promise((resolve) => {
    execFile(spec.command, spec.args, { env, shell: spec.shell, timeout: 15_000, windowsHide: true, maxBuffer: 2 * 1024 * 1024 }, (error, stdout) =>
      resolve(error ? '' : String(stdout ?? ''))
    )
  })
}
