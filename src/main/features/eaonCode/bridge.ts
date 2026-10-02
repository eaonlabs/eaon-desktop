import { statSync } from 'node:fs'
import { dirname } from 'node:path'
import type {
  EaonCodeStatus,
  EaonCommand,
  EaonEvent,
  EaonModel,
  EaonProcessInfo,
  EaonSessionInfo,
  EaonSessionState,
  EaonSessionStats,
  EaonSlashCommand,
  EaonSnapshot,
  EaonStartOptions,
  EaonThinkingLevel,
  EaonUiResponse
} from '@shared/eaonCode'
import { createEventBatcher } from './batch'
import { buildChildEnv } from './env'
import { detectEaonCode, readPackageInfo, type EaonPackageInfo } from './locate'
import { RpcChild } from './rpc'
import { canonicalCwd, listSessions } from './sessions'

export interface BridgeDeps {
  /** Read on every start so a settings change applies to the next session. */
  getSettings: () => { binaryPath: string | null; shareKeys: boolean }
  getKey: (providerId: string) => string | undefined
  onEvents: (events: EaonEvent[]) => void
  onProcess: (info: EaonProcessInfo) => void
  env?: NodeJS.ProcessEnv
  batchMs?: number
  /** Swappable for tests. */
  detect?: (configured: string | null) => Promise<EaonCodeStatus>
}

/**
 * Commands the renderer may send, and how long each may take. 0 = no limit.
 * `prompt` is answered only after its preflight, which can run a whole
 * compaction or an extension command first; a limit there reported a failure
 * for a prompt that was in fact accepted and went on to run.
 */
const COMMAND_TIMEOUTS: Record<EaonCommand['type'], number> = {
  prompt: 0,
  steer: 30_000,
  follow_up: 30_000,
  abort: 60_000,
  clear_queue: 30_000,
  new_session: 60_000,
  switch_session: 60_000,
  get_state: 30_000,
  get_messages: 60_000,
  get_available_models: 30_000,
  set_model: 30_000,
  set_thinking_level: 30_000,
  get_available_thinking_levels: 30_000,
  compact: 0,
  get_session_stats: 30_000,
  get_commands: 30_000,
  bash: 0,
  abort_bash: 30_000,
  set_session_name: 30_000,
  set_plan_mode: 30_000,
  set_swarm_mode: 30_000
}

/**
 * Owns the one Eaon Code process behind the Code tab.
 *
 * One at a time: the tab shows one session, and a second idle Node process
 * per folder visited would add up. The process outlives tab switches — a turn
 * keeps running while the user reads a chat — and ends when the folder
 * changes, when asked, or when the app quits.
 */
export class EaonCodeBridge {
  private child: RpcChild | null = null
  private batcher: ReturnType<typeof createEventBatcher> | null = null
  private info: EaonProcessInfo = { state: 'idle', cwd: null, stderr: '' }
  private cachedStatus: { configured: string | null; status: EaonCodeStatus } | null = null
  private generation = 0
  private sessionFile: string | null = null

  constructor(private readonly deps: BridgeDeps) {}

  processInfo(): EaonProcessInfo {
    return this.info
  }

  /** Where Eaon Code is and whether it runs. Cached; `refresh` re-probes. */
  async status(refresh = false): Promise<EaonCodeStatus> {
    const configured = this.deps.getSettings().binaryPath
    if (!refresh && this.cachedStatus && this.cachedStatus.configured === configured) return this.cachedStatus.status
    const status = await (this.deps.detect ?? detectEaonCode)(configured)
    this.cachedStatus = { configured, status }
    return status
  }

  packageInfo(): EaonPackageInfo | null {
    const binary = this.cachedStatus?.status.binaryPath
    return binary ? readPackageInfo(binary) : null
  }

  /** Names of the variables a session would receive — never the values. */
  sharedKeyNames(): string[] {
    const { shareKeys } = this.deps.getSettings()
    return buildChildEnv(this.deps.env ?? process.env, shareKeys, this.deps.getKey).shared
  }

  /**
   * Starts a session in `cwd`, replacing any running one, and returns what
   * the view needs to draw it. A newer start supersedes an older one still in
   * flight; the older one's process is stopped and its promise rejects.
   */
  async start(cwd: string, options: EaonStartOptions = {}): Promise<EaonSnapshot> {
    const generation = ++this.generation
    let status = await this.status()
    if (status.state !== 'ready') status = await this.status(true)
    if (status.state !== 'ready' || !status.binaryPath) {
      throw new Error(status.error ?? 'Eaon Code is not installed.')
    }
    try {
      if (!statSync(cwd).isDirectory()) throw new Error()
    } catch {
      throw new Error(`The folder ${cwd} does not exist.`)
    }

    await this.stop()
    if (generation !== this.generation) throw new Error('Superseded by a newer start.')

    const { shareKeys } = this.deps.getSettings()
    const { env } = buildChildEnv(this.deps.env ?? process.env, shareKeys, this.deps.getKey)
    const args = ['--mode', 'rpc', ...(options.sessionPath ? ['--session', options.sessionPath] : [])]

    const batcher = createEventBatcher((events) => {
      if (this.batcher === batcher) this.deps.onEvents(events)
    }, this.deps.batchMs)
    const child: RpcChild = new RpcChild({
      command: status.binaryPath,
      args,
      cwd,
      env,
      onEvent: (event) => {
        if (this.child !== child) return
        batcher.push(event)
      },
      onExit: (exit) => {
        if (this.child !== child) return
        batcher.flush()
        this.setInfo({
          state: 'exited',
          cwd,
          pid: child.pid,
          exitCode: exit.code,
          signal: exit.signal,
          stderr: exit.stderr,
          crashed: !exit.expected
        })
      }
    })
    this.child = child
    this.batcher = batcher
    this.sessionFile = null
    this.setInfo({ state: 'starting', cwd, pid: child.pid, stderr: '' })

    try {
      let state = await child.request<EaonSessionState>({ type: 'get_state' }, 45_000)
      // Builds without the mode commands do not report the fields; send only when they do.
      if (options.planMode && typeof state.planMode === 'boolean') {
        await child.request({ type: 'set_plan_mode', enabled: true })
      }
      if (options.swarmMode && typeof state.swarmMode === 'boolean') {
        await child.request({ type: 'set_swarm_mode', enabled: true })
      }
      if (options.planMode || options.swarmMode) state = await child.request<EaonSessionState>({ type: 'get_state' })
      this.sessionFile = state.sessionFile ?? null

      const optional = <T>(promise: Promise<T>, fallback: T): Promise<T> => promise.catch(() => fallback)
      const [models, thinkingLevels, commands, stats, messages] = await Promise.all([
        optional(child.request<{ models: EaonModel[] }>({ type: 'get_available_models' }).then((d) => d.models), []),
        optional(
          child.request<{ levels: EaonThinkingLevel[] }>({ type: 'get_available_thinking_levels' }).then((d) => d.levels),
          [] as EaonThinkingLevel[]
        ),
        optional(
          child.request<{ commands: EaonSlashCommand[] }>({ type: 'get_commands' }).then((d) =>
            d.commands.map(({ name, description, source }) => ({ name, description, source }))
          ),
          []
        ),
        optional(child.request<EaonSessionStats>({ type: 'get_session_stats' }), null),
        options.sessionPath
          ? optional(child.request<{ messages: unknown[] }>({ type: 'get_messages' }, 60_000).then((d) => d.messages), [])
          : Promise.resolve([])
      ])
      if (generation !== this.generation) throw new Error('Superseded by a newer start.')
      this.setInfo({ state: 'running', cwd, pid: child.pid, stderr: child.stderrTail() })
      return { state, models, thinkingLevels, commands, stats, messages }
    } catch (error) {
      if (this.child === child) {
        const tail = child.stderrTail().trim().split('\n').slice(-6).join('\n')
        await child.stop(1500)
        this.child = null
        this.batcher = null
        batcher.dispose()
        // The binary may be what broke — uninstalled, or moved by an nvm or
        // npm update — so "Try again" looks for it afresh instead of reusing
        // a cached "ready" that would fail the same way every time.
        this.cachedStatus = null
        this.setInfo({ state: 'exited', cwd, stderr: child.stderrTail(), crashed: true, exitCode: null })
        const message = (error as Error).message
        throw new Error(tail && !message.includes(tail) ? `${message}\n${tail}` : message)
      }
      throw error
    }
  }

  /** Sends one command to the running session and resolves with its data. */
  async command(command: EaonCommand): Promise<unknown> {
    const child = this.child
    if (!child || !child.running) throw new Error('No Eaon Code session is running.')
    // hasOwn, not `in`: `in` also admits "constructor", "toString" and the rest of Object's prototype.
    if (!Object.hasOwn(COMMAND_TIMEOUTS, command.type)) throw new Error(`Unsupported command: ${command.type}`)
    // Anything not yet delivered must reach the renderer before the answer does,
    // or a state it asks for could land ahead of the events that produced it.
    this.batcher?.flush()
    const data = await child.request(command as unknown as { type: string }, COMMAND_TIMEOUTS[command.type])
    if (command.type === 'get_state') this.sessionFile = (data as EaonSessionState).sessionFile ?? this.sessionFile
    return data
  }

  respondUi(id: string, response: EaonUiResponse): void {
    this.child?.write({ type: 'extension_ui_response', id, ...response })
  }

  /** Stops the running session, waiting for the process to exit. */
  async stop(): Promise<void> {
    const child = this.child
    if (!child) return
    this.child = null
    this.batcher?.flush()
    this.batcher?.dispose()
    this.batcher = null
    await child.stop()
    this.setInfo({ state: 'idle', cwd: this.info.cwd, stderr: '' })
  }

  /** For app quit: signal the child without waiting. */
  dispose(): void {
    this.batcher?.dispose()
    this.child?.kill()
    this.child = null
  }

  /** Saved sessions for `cwd`, including the running session's own folder. */
  async sessions(cwd: string): Promise<EaonSessionInfo[]> {
    await this.status()
    const info = this.packageInfo()
    if (!info) return []
    const extraDirs =
      this.sessionFile && this.info.cwd && canonicalCwd(this.info.cwd) === canonicalCwd(cwd) ? [dirname(this.sessionFile)] : []
    return listSessions(cwd, info, { extraDirs, env: this.deps.env })
  }

  currentSessionFile(): string | null {
    return this.sessionFile
  }

  private setInfo(info: EaonProcessInfo): void {
    this.info = info
    this.deps.onProcess(info)
  }
}
