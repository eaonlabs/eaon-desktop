import { existsSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import type { EngineAuth, EngineModels, EngineStatus } from '@shared/engines'
import { app, shell } from 'electron'
import { store } from '../../store'
import { isOwnServerUrl } from '../../providers/compat'
import { EngineError, type EngineAdapter, type EngineTurnInput, type EngineTurnResult } from '../types'
import { AppServer, RpcError } from './appServer'
import { authFromAccount, billingFor, checkChatgptSession, startChatgptLogin, type LoginHandle } from './auth'
import { providerTarget, selfRouteReason } from './guard'
import {
  INSTALL_HINT,
  MIN_CODEX_VERSION,
  SOURCE_LABEL,
  compareVersions,
  findCodexCandidates,
  inspectCopies,
  latestVersion,
  updateHint,
  type CodexCopy,
  type DiscoveryOptions,
  type LatestVersionCache
} from './locate'
import { fallbackModels, fetchModels, liveModels, toRecord, wireEffort, type CodexModelRecord, type ModelCache } from './models'
import type { GetAccountResponse, ThreadStartResponse } from './protocol'
import { accessPlan, runTurn, type TurnOutcome } from './turn'

/**
 * Codex as an Eaon engine: Eaon drives the user's own installed Codex through
 * its app-server (the protocol OpenAI's IDE extension and desktop app use),
 * with Codex's own sign-in, models, tools and sandbox.
 *
 * Processes:
 * - A *control* process answers status questions (account, models, config)
 *   and runs the sign-in. It is started on demand and stopped after a minute
 *   idle (never while a sign-in waits).
 * - Each session (Codex thread) runs in its own process, kept between turns
 *   for a while so a worker's next turn starts fast. A crash fails only that
 *   session's turn; the next turn starts a fresh process and resumes the
 *   thread from Codex's own history. Two sessions never share a process, so
 *   one can't block or crash the other. Turns on one session run one at a
 *   time, in order.
 */

const STATUS_FRESH_MS = 5 * 60_000
const CONTROL_IDLE_MS = 60_000
const SESSION_IDLE_MS = 10 * 60_000
/** Sessions kept warm at once; the least recently used one is stopped beyond this. */
const MAX_IDLE_SESSIONS = 4

const LATEST_DOC = 'engine-codex-latest.json'
const MODELS_DOC = 'engine-codex-models.json'

/** Notifications no part of Eaon reads; Codex doesn't send them at all. */
const OPT_OUT = [
  'thread/started',
  'remoteControl/status/changed',
  'rawResponseItem/completed',
  'fs/changed',
  'thread/realtime/started',
  'thread/realtime/outputAudio/delta',
  'item/autoApprovalReview/started',
  'item/autoApprovalReview/completed'
]

export interface CodexEngineOptions {
  discovery?: DiscoveryOptions
  /** Environment for Codex's processes (defaults to Eaon's, with the login shell's PATH). */
  env?: () => NodeJS.ProcessEnv
  store?: { getJson: <T>(name: string, fallback: T) => T; setJson: (name: string, value: unknown) => void }
  fetch?: typeof fetch
  openExternal?: (url: string) => void | Promise<void>
  /** Ports Eaon's own gateway listens on or is set to; a Codex pointed there is refused. */
  ownPorts?: () => (number | null)[]
  isOwnServerUrl?: (url: string) => boolean
  clientVersion?: string
  now?: () => number
  sessionIdleMs?: number
  controlIdleMs?: number
  interruptGraceMs?: number
  loginTimeoutMs?: number
}

interface Session {
  server: AppServer
  threadId: string | null
  /** The thread is loaded in this process (no resume needed). */
  loaded: boolean
  activeTurnId: string | null
  lastUsed: number
  idleTimer: ReturnType<typeof setTimeout> | null
}

export function createCodexEngine(options: CodexEngineOptions = {}): EngineAdapter & {
  /** For tests and diagnostics: process ids of every live Codex process this engine started. */
  livePids(): number[]
} {
  const now = options.now ?? Date.now
  const env = options.env ?? (() => process.env)
  const docs = options.store ?? store
  const clientVersion = options.clientVersion ?? safeVersion()
  const openExternal =
    options.openExternal ??
    ((url: string) => {
      const parsed = new URL(url)
      if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') throw new Error('Not a web address.')
      return shell.openExternal(parsed.href)
    })
  const ownPorts = options.ownPorts ?? (() => [store.getSettings().localServer?.port ?? 1337])
  const ownUrl = options.isOwnServerUrl ?? isOwnServerUrl

  let status: EngineStatus | null = null
  let chosen: CodexCopy | null = null
  let account: GetAccountResponse | null = null
  let detecting: Promise<EngineStatus> | null = null
  let listing: Promise<EngineModels> | null = null
  // The last list's effort spellings, read from disk on first use (not at import).
  let modelRecordsCache: CodexModelRecord[] | null = null
  const modelRecords = (): CodexModelRecord[] => (modelRecordsCache ??= docs.getJson<ModelCache | null>(MODELS_DOC, null)?.models ?? [])

  // The control process.
  let control: { server: AppServer; binary: string } | null = null
  let controlStarting: Promise<AppServer> | null = null
  let controlTimer: ReturnType<typeof setTimeout> | null = null
  let controlPins = 0
  let login: LoginHandle | null = null

  const sessions = new Map<string, Session>()
  /** Turns waiting on a session, chained so they run one at a time. */
  const queues = new Map<string, Promise<unknown>>()
  const starting = new Set<AppServer>()
  let disposed = false

  /* ------------------------------------------------------------ helpers */

  const spawnEnv = (): NodeJS.ProcessEnv => ({ ...env() })

  async function startServer(binary: string, cwd: string): Promise<AppServer> {
    const { server } = await AppServer.start({ command: binary, cwd, env: spawnEnv(), clientVersion, optOut: OPT_OUT })
    return server
  }

  function scheduleControlStop(): void {
    if (controlTimer) clearTimeout(controlTimer)
    controlTimer = null
    if (controlPins > 0 || !control) return
    controlTimer = setTimeout(() => {
      controlTimer = null
      if (controlPins > 0 || !control) return
      const { server } = control
      control = null
      void server.stop()
    }, options.controlIdleMs ?? CONTROL_IDLE_MS)
    controlTimer.unref?.()
  }

  /** Runs `fn` on the control process, starting it (for this binary) when needed. */
  async function withControl<T>(binary: string, fn: (server: AppServer) => Promise<T>): Promise<T> {
    controlPins++
    if (controlTimer) clearTimeout(controlTimer)
    try {
      if (control && (control.binary !== binary || !control.server.running)) {
        const old = control.server
        control = null
        void old.stop()
      }
      if (!control) {
        controlStarting ??= startServer(binary, homedir()).finally(() => (controlStarting = null))
        const server = await controlStarting
        if (disposed) {
          await server.stop()
          throw new EngineError('engine-crashed', 'Eaon is quitting.')
        }
        control = { server, binary }
        server.onExit(() => {
          if (control?.server === server) control = null
        })
      }
      return await fn(control.server)
    } finally {
      controlPins--
      scheduleControlStop()
    }
  }

  function baseStatus(): EngineStatus {
    return {
      id: 'codex',
      name: 'Codex',
      installed: false,
      path: null,
      foundIn: null,
      version: null,
      latestVersion: null,
      updateAvailable: false,
      outdated: false,
      minVersion: MIN_CODEX_VERSION,
      updateHint: null,
      auth: { state: 'unknown', method: null, plan: null },
      error: null,
      blockedReason: null,
      others: [],
      checkedAt: now()
    }
  }

  /* ------------------------------------------------------------- detect */

  async function detectNow(force: boolean): Promise<EngineStatus> {
    const result = baseStatus()
    const [candidates, latest] = await Promise.all([
      findCodexCandidates({ env: env(), ...options.discovery }),
      latestVersion(
        {
          read: () => docs.getJson<LatestVersionCache | null>(LATEST_DOC, null),
          write: (value) => docs.setJson(LATEST_DOC, value),
          fetch: options.fetch,
          now,
          offline: Boolean(env().EAON_OFFLINE)
        },
        force
      )
    ])
    result.latestVersion = latest
    if (candidates.length === 0) {
      chosen = null
      result.updateHint = INSTALL_HINT
      result.auth = { state: 'unknown', method: null, plan: null }
      return result
    }
    const copies = await inspectCopies(candidates)
    const pick = copies[0]
    chosen = pick
    result.installed = true
    result.path = pick.path
    result.foundIn = SOURCE_LABEL[pick.source]
    result.version = pick.version
    result.updateHint = updateHint(pick.source, pick.path)
    result.others = copies.slice(1).map((c) => ({ path: c.path, foundIn: SOURCE_LABEL[c.source], version: c.version }))
    if (!pick.version) {
      result.error = `Codex is installed but didn’t run. ${pick.error ?? ''}`.trim()
      return result
    }
    result.outdated = compareVersions(pick.version, MIN_CODEX_VERSION) < 0
    result.updateAvailable = Boolean(latest && compareVersions(latest, pick.version) > 0)
    if (result.outdated) {
      // An older app-server may not speak the protocol at all; don't start it.
      result.auth = { state: 'unknown', method: null, plan: null }
      return result
    }

    try {
      await withControl(pick.path, async (server) => {
        const read = await server.request<GetAccountResponse>('account/read', { refreshToken: false }, 15_000)
        account = read
        let auth: EngineAuth = authFromAccount(read)
        if (auth.state === 'signed-in' && read.account?.type === 'chatgpt') {
          const session = await checkChatgptSession(server)
          if (session === 'expired') auth = { ...auth, state: 'expired' }
        }
        result.auth = auth
        try {
          const config = await server.request<{ config?: Record<string, unknown> }>('config/read', { includeLayers: false }, 10_000)
          result.blockedReason = blockReason(config?.config)
        } catch {
          /* an older Codex without config/read: the per-turn check still runs */
        }
      })
    } catch (error) {
      result.auth = { state: 'unknown', method: null, plan: null }
      result.error = `Codex ${pick.version} is installed, but Eaon couldn’t talk to it: ${describe(error)}`
    }
    return result
  }

  function blockReason(config: Record<string, unknown> | undefined): string | null {
    if (!config) return null
    const target = providerTarget(config, env())
    const reason = selfRouteReason(target, ownPorts())
    if (reason) return reason
    if (target.baseUrl && ownUrl(target.baseUrl)) return selfRouteReason(target, [portOf(target.baseUrl)])
    return null
  }

  /* ------------------------------------------------------------- models */

  async function listNow(force: boolean): Promise<EngineModels> {
    const cache = docs.getJson<ModelCache | null>(MODELS_DOC, null)
    // Refresh asks detect first; don't check everything twice in a row.
    const current = !status || now() - status.checkedAt > (force ? 30_000 : STATUS_FRESH_MS) ? await detect({ force }) : status
    if (!current.installed || !chosen) return fallbackModels(cache, 'Codex isn’t installed, so its models can’t be checked.')
    if (current.outdated) return fallbackModels(cache, `Codex ${current.version} is too old to ask for its models. Update it to ${MIN_CODEX_VERSION} or newer.`)
    if (!chosen.version) return fallbackModels(cache, 'Codex didn’t start, so its models couldn’t be checked.')
    const binary = chosen.path
    const version = chosen.version
    try {
      const models = await withControl(binary, (server) => fetchModels(server))
      if (models.length === 0) throw new Error('Codex listed no models.')
      const next: ModelCache = { models: models.map(toRecord), retrievedAt: now(), binary, version }
      docs.setJson(MODELS_DOC, next)
      modelRecordsCache = next.models
      return liveModels(next)
    } catch (error) {
      return fallbackModels(cache, `Couldn’t refresh Codex’s models: ${describe(error)}`)
    }
  }

  /* ------------------------------------------------------------ sessions */

  function touch(key: string, session: Session): void {
    session.lastUsed = now()
    if (session.idleTimer) clearTimeout(session.idleTimer)
    session.idleTimer = setTimeout(() => void endSession(key), options.sessionIdleMs ?? SESSION_IDLE_MS)
    session.idleTimer.unref?.()
    // Too many warm processes: stop the least recently used idle one.
    const idle = [...sessions.entries()].filter(([k, s]) => k !== key && !s.activeTurnId && !queues.has(k))
    if (sessions.size > MAX_IDLE_SESSIONS && idle.length) {
      idle.sort((a, b) => a[1].lastUsed - b[1].lastUsed)
      void endSession(idle[0][0])
    }
  }

  async function endSession(key: string): Promise<void> {
    const session = sessions.get(key)
    if (!session || session.activeTurnId || queues.has(key)) return
    sessions.delete(key)
    if (session.idleTimer) clearTimeout(session.idleTimer)
    await session.server.stop()
  }

  /** Runs turns for one session in order: the next starts after the previous settled. */
  function serialize<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const previous = queues.get(key) ?? Promise.resolve()
    const next = previous.catch(() => undefined).then(fn)
    const tail = next.catch(() => undefined)
    queues.set(key, tail)
    void tail.then(() => {
      if (queues.get(key) === tail) queues.delete(key)
    })
    return next
  }

  function failure(input: EngineTurnInput, kind: EngineError['kind'], message: string, detail?: string): EngineTurnResult {
    return {
      sessionId: input.sessionId,
      text: '',
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      cancelled: false,
      error: message,
      errorKind: kind,
      ...(detail ? { errorDetail: detail } : {}),
      sideEffects: false,
      billing: billingFor(account)
    }
  }

  const statusListeners = new Set<(status: EngineStatus) => void>()
  function setStatus(next: EngineStatus): void {
    status = next
    for (const listener of statusListeners) {
      try {
        listener(next)
      } catch (error) {
        console.error('[codex] a status listener failed:', error)
      }
    }
  }

  async function preflight(input: EngineTurnInput): Promise<EngineTurnResult | null> {
    let current = status
    if (!current || now() - current.checkedAt > STATUS_FRESH_MS || current.auth.state === 'unknown') current = await detect()
    if (!current.installed || !chosen) return failure(input, 'not-installed', 'Codex isn’t installed. Install it (Settings → Agent engines shows how), then try again.')
    if (!current.version) return failure(input, 'engine-crashed', current.error ?? 'Codex is installed but didn’t run.')
    if (current.outdated) {
      return failure(input, 'outdated', `Codex ${current.version} is too old for Eaon (it needs ${MIN_CODEX_VERSION} or newer). ${current.updateHint ?? ''}`.trim())
    }
    if (current.blockedReason) return failure(input, 'misconfigured', current.blockedReason)
    if (current.auth.state === 'signed-out') return failure(input, 'signed-out', 'Codex isn’t signed in. Sign in under Settings → Agent engines.')
    if (current.auth.state === 'expired') return failure(input, 'auth-expired', 'Codex’s ChatGPT session has expired. Reconnect it under Settings → Agent engines.')
    if (!existsSync(input.cwd) || !statSync(input.cwd).isDirectory()) return failure(input, 'other', `The working folder doesn’t exist: ${input.cwd}`)
    return null
  }

  async function runTurnNow(input: EngineTurnInput, key: string): Promise<EngineTurnResult> {
    if (input.signal.aborted) return cancelledResult(input, input.sessionId)
    const pre = await preflight(input)
    if (pre) return pre
    const binary = chosen!.path

    // A process for this session: the warm one, or a fresh one.
    let session = input.sessionId ? sessions.get(input.sessionId) : undefined
    if (session && !session.server.running) {
      sessions.delete(input.sessionId!)
      session = undefined
    }
    let fresh = false
    if (!session) {
      let server: AppServer
      try {
        const pending = startServer(binary, input.cwd)
        server = await pending
      } catch (error) {
        return failure(input, 'engine-crashed', `Codex didn’t start: ${describe(error)}`, describe(error))
      }
      if (disposed || input.signal.aborted) {
        await server.stop()
        return cancelledResult(input, input.sessionId)
      }
      starting.add(server)
      session = { server, threadId: null, loaded: false, activeTurnId: null, lastUsed: now(), idleTimer: null }
      fresh = true
    }
    const server = session.server
    if (session.idleTimer) clearTimeout(session.idleTimer)

    const keep = (threadId: string): void => {
      starting.delete(server)
      session!.threadId = threadId
      session!.loaded = true
      sessions.set(threadId, session!)
    }
    const drop = async (): Promise<void> => {
      starting.delete(server)
      for (const [k, s] of sessions) if (s === session) sessions.delete(k)
      await server.stop()
    }

    try {
      // Codex pointed at Eaon's own gateway? Checked on the process that will run the turn.
      if (fresh) {
        const config = await server.request<{ config?: Record<string, unknown> }>('config/read', { includeLayers: false, cwd: input.cwd }, 10_000).catch(() => null)
        const reason = blockReason(config?.config)
        if (reason) {
          await drop()
          if (status) setStatus({ ...status, blockedReason: reason })
          return failure(input, 'misconfigured', reason)
        }
      }

      const plan = accessPlan(input.access)
      const threadSettings = {
        cwd: input.cwd,
        approvalPolicy: plan.approvalPolicy,
        approvalsReviewer: 'user',
        sandbox: plan.sandbox,
        ...(input.instructions.trim() ? { developerInstructions: input.instructions } : {})
      }
      let threadId = session.loaded ? session.threadId : null
      let replaced = false
      if (!threadId && input.sessionId) {
        try {
          const resumed = await server.request<ThreadStartResponse>('thread/resume', { threadId: input.sessionId, ...threadSettings }, 60_000)
          threadId = resumed?.thread?.id ?? input.sessionId
        } catch (error) {
          if (!(error instanceof RpcError) || !isMissingThread(error.message)) {
            await drop()
            if (error instanceof RpcError && /another|owned|in use|already/i.test(error.message)) {
              return failure(input, 'other', 'This Codex conversation is open somewhere else (another Codex window). Close it there, then try again.', error.message)
            }
            return turnStartFailure(input, error)
          }
          replaced = true
        }
      }
      if (!threadId) {
        const startedThread = await server.request<ThreadStartResponse>(
          'thread/start',
          { ...threadSettings, serviceName: 'eaon', ...(input.model ? { model: input.model } : {}) },
          60_000
        )
        threadId = startedThread?.thread?.id ?? null
        if (!threadId) throw new Error('Codex started no thread.')
      }
      keep(threadId)

      const record = input.model ? modelRecords().find((m) => m.id === input.model) : modelRecords().find((m) => m.isDefault)
      const outcome: TurnOutcome = await runTurn({
        server,
        threadId,
        input,
        effort: wireEffort(input.effort, record),
        auth: status?.auth ?? null,
        interruptGraceMs: options.interruptGraceMs,
        onStarted: (turnId) => (session!.activeTurnId = turnId)
      })
      session.activeTurnId = null

      if (outcome.crashed || outcome.stuck) await drop()
      else touch(threadId, session)
      if (outcome.errorKind === 'auth-expired' || outcome.errorKind === 'signed-out') {
        // The status must say so too, or Settings would keep showing "Signed in".
        if (status) setStatus({ ...status, auth: { ...status.auth, state: outcome.errorKind === 'auth-expired' ? 'expired' : 'signed-out' } })
      }
      return {
        sessionId: threadId,
        text: outcome.text,
        usage: outcome.usage,
        cancelled: outcome.cancelled,
        ...(outcome.error ? { error: outcome.error, errorKind: outcome.errorKind } : {}),
        ...(outcome.detail ? { errorDetail: outcome.detail } : {}),
        sideEffects: outcome.sideEffects,
        sessionReplaced: replaced,
        notice: replaced
          ? 'Codex no longer had this conversation (it may have been deleted in Codex), so this turn started a new one without the earlier messages.'
          : null,
        billing: billingFor(account)
      }
    } catch (error) {
      session.activeTurnId = null
      await drop()
      if (input.signal.aborted) return cancelledResult(input, input.sessionId)
      return turnStartFailure(input, error)
    }
  }

  function turnStartFailure(input: EngineTurnInput, error: unknown): EngineTurnResult {
    const message = describe(error)
    if (error instanceof Error && error.name === 'AppServerExited') {
      return failure(input, 'engine-crashed', 'Codex stopped unexpectedly while starting the turn. The next turn starts it again.', message)
    }
    if (/model/i.test(message) && /not supported|does not exist|not found|unavailable|unknown/i.test(message)) {
      return failure(input, 'model-unavailable', `That model isn’t available to Codex. Pick another Codex model. (${message})`, message)
    }
    return failure(input, 'other', `Codex couldn’t start the turn: ${message}`, message)
  }

  /* ------------------------------------------------------------- public */

  function detect(opts: { force?: boolean } = {}): Promise<EngineStatus> {
    detecting ??= detectNow(opts.force === true)
      .catch((error): EngineStatus => ({ ...baseStatus(), error: `Couldn’t check Codex: ${describe(error)}` }))
      .then((next) => {
        setStatus(next)
        return next
      })
      .finally(() => (detecting = null))
    return detecting
  }

  return {
    id: 'codex',

    detect,

    listModels(opts = {}) {
      listing ??= listNow(opts.force === true).finally(() => (listing = null))
      return listing
    },

    async login() {
      const current = status ?? (await detect())
      if (!current.installed || !chosen) throw new EngineError('not-installed', 'Codex isn’t installed.')
      if (current.outdated) throw new EngineError('outdated', `Update Codex first: ${current.updateHint ?? ''}`.trim())
      if (current.auth.state === 'not-required') throw new EngineError('other', 'Codex is set up with a provider that needs no sign-in.')
      if (login) throw new EngineError('other', 'A sign-in is already waiting in your browser. Finish it there, or cancel it.')
      const binary = chosen.path
      // withControl keeps the control process pinned (alive) until the sign-in settles.
      await withControl(binary, async (server) => {
        const handle = await startChatgptLogin(server, openExternal, options.loginTimeoutMs)
        login = handle
        try {
          await handle.done
        } finally {
          login = null
        }
      })
      await detect({ force: true })
    },

    async cancelLogin() {
      await login?.cancel()
    },

    subscribe(listener) {
      statusListeners.add(listener)
      return () => statusListeners.delete(listener)
    },

    runTurn(input) {
      const key = input.sessionId ?? `new:${input.messageId}:${Math.random().toString(36).slice(2)}`
      return serialize(key, () => runTurnNow(input, key))
    },

    async steer(sessionId, text) {
      const session = sessions.get(sessionId)
      if (!session?.activeTurnId || !session.server.running) return false
      try {
        await session.server.request(
          'turn/steer',
          { threadId: sessionId, input: [{ type: 'text', text, text_elements: [] }], expectedTurnId: session.activeTurnId },
          10_000
        )
        return true
      } catch {
        return false
      }
    },

    async dispose() {
      disposed = true
      await login?.cancel().catch(() => {})
      if (controlTimer) clearTimeout(controlTimer)
      const servers = new Set<AppServer>([...starting, ...[...sessions.values()].map((s) => s.server)])
      if (control) servers.add(control.server)
      for (const s of sessions.values()) if (s.idleTimer) clearTimeout(s.idleTimer)
      sessions.clear()
      starting.clear()
      control = null
      await Promise.all([...servers].map((s) => s.stop()))
    },

    livePids() {
      const pids = [...sessions.values()].map((s) => s.server.pid)
      if (control) pids.push(control.server.pid)
      for (const s of starting) pids.push(s.pid)
      return pids.filter((p): p is number => typeof p === 'number')
    }
  }
}

function cancelledResult(input: EngineTurnInput, sessionId: string | null): EngineTurnResult {
  return { sessionId, text: '', usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, cancelled: true, sideEffects: false }
}

/** Codex's answer to resuming a thread it has no history for. */
function isMissingThread(message: string): boolean {
  return /no rollout found|thread not found|unknown thread|no thread|does not exist|not found for thread/i.test(message)
}

function describe(error: unknown): string {
  if (error instanceof Error) return error.message
  return String(error)
}

function portOf(url: string): number | null {
  try {
    const parsed = new URL(url)
    return Number(parsed.port || (parsed.protocol === 'https:' ? 443 : 80))
  } catch {
    return null
  }
}

function safeVersion(): string {
  try {
    return app.getVersion()
  } catch {
    return '0.0.0'
  }
}

export const codexEngine = createCodexEngine()
