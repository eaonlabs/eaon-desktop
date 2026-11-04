import {
  APP_CONTROL_CLI,
  APP_CONTROL_ENVELOPE_VERSION,
  type AppControlEnvelope,
  type AppControlError,
  type AppControlPermission,
  type AppControlSettings,
  type AppControlSource,
  type AppControlStatus
} from '@shared/appControl'
import { COMMAND_NAMES, findCommand, type CommandContext, type DisplayInfo } from './commands'
import { appControlGuide } from './guide'
import { AppControlFailure, type AppControlEngine, type RawStatus } from './protocol'
import { RefStore } from './refs'
import { PROTECTED_NAMES } from './safety'
import { AppControlTrace } from './trace'

/**
 * Runs app-control commands for whoever asks, and answers in the envelope:
 * checks the Settings switch, resolves the engine, records each command in
 * the activity list, and outlines what an action touched. Everything that
 * reaches the apps goes through here.
 */

export interface ServiceDeps {
  platform: NodeJS.Platform
  engine: () => AppControlEngine | null
  /** The engine's display name and why it may not work, for status. */
  engineInfo: () => { name: string; detail: string | null }
  settings: () => AppControlSettings
  ownPids: () => ReadonlySet<number>
  clipboard: CommandContext['clipboard']
  displays: () => DisplayInfo[]
  /** Outline an element that was just acted on; absent in tests and when the switch is off. */
  flash?: (bounds: [number, number, number, number], label: string) => void
  appVersion: string
  sleep?: (ms: number) => Promise<void>
}

/** Commands that answer even while app control is off: how to turn it on, and what it is. */
const ALWAYS = new Set(['status', 'version', 'guide'])
/** Not worth a line in the activity list. */
const QUIET = new Set(['status', 'version', 'guide', 'trace', 'list-displays', 'clipboard-get'])

export class AppControlService {
  readonly refs = new RefStore()
  readonly trace = new AppControlTrace()

  constructor(private readonly deps: ServiceDeps) {}

  private envelope(command: string, outcome: { data: unknown } | { error: AppControlError }): AppControlEnvelope {
    return 'error' in outcome
      ? { version: APP_CONTROL_ENVELOPE_VERSION, ok: false, command, error: outcome.error }
      : { version: APP_CONTROL_ENVELOPE_VERSION, ok: true, command, data: outcome.data }
  }

  async run(command: string, args: Record<string, unknown>, source: AppControlSource, signal?: AbortSignal, depth = 0): Promise<AppControlEnvelope> {
    const def = findCommand(command)
    const name = def?.name ?? command
    const started = Date.now()
    if (!def) {
      const pointerless = /screenshot|capture/i.test(command)
      return this.envelope(name, {
        error: {
          code: 'UNKNOWN_COMMAND',
          message: pointerless ? 'App control reads the accessibility tree and takes no screenshots.' : `No command "${command}".`,
          hint: pointerless ? 'Computer use takes screenshots.' : `Commands: ${COMMAND_NAMES.filter((n) => !/^(key|mouse)-(down|up)$/.test(n)).join(', ')}.`
        }
      })
    }
    if (!ALWAYS.has(name) && !this.deps.settings().enabled) {
      return this.envelope(name, { error: { code: 'DISABLED', message: 'App control is off.', hint: 'Turn it on in Eaon → Settings → App control.' } })
    }
    const engine = ALWAYS.has(name) ? null : this.deps.engine()
    if (!ALWAYS.has(name) && !engine) {
      const info = this.deps.engineInfo()
      return this.envelope(name, { error: { code: 'ENGINE_UNAVAILABLE', message: `App control can't run on this computer: ${info.detail ?? 'no engine for this OS.'}` } })
    }
    const ctx: CommandContext = {
      engine: engine ?? (null as unknown as AppControlEngine),
      refs: this.refs,
      ownPids: this.deps.ownPids(),
      platform: this.deps.platform,
      clipboard: this.deps.clipboard,
      displays: this.deps.displays,
      sleep: this.deps.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms))),
      signal,
      runStep: async (step, stepArgs) => {
        if (depth > 0) return { ok: false, error: { code: 'INVALID_ARGS', message: 'Batches don’t nest.' } }
        const result = await this.run(step, stepArgs, source, signal, depth + 1)
        return result.ok ? { ok: true, data: result.data } : { ok: false, error: result.error }
      },
      status: () => this.status(),
      guide: () => appControlGuide(),
      trace: (limit) => this.trace.recent(limit),
      version: async () => ({ envelope: APP_CONTROL_ENVELOPE_VERSION, eaon: this.deps.appVersion, platform: this.deps.platform, arch: process.arch, engine: await this.engineVersion() }),
      target: { label: null }
    }
    // Refs carry the engine's epoch, so after a restart (a timeout kills a
    // wedged engine) the old ones fail as stale on their own.
    let outcome: { data: unknown } | { error: AppControlError }
    try {
      const data = await def.run(args, ctx)
      outcome = { data }
    } catch (error) {
      outcome = { error: toError(error) }
    }
    const ok = !('error' in outcome)
    if (ok && def.acts && ctx.target.bounds && this.deps.settings().showActions) {
      try {
        this.deps.flash?.(ctx.target.bounds, `${source.name}: ${name.replace(/-/g, ' ')} ${ctx.target.label ?? ''}`.trim())
      } catch {
        // Only a picture.
      }
    }
    if (!QUIET.has(name) && name !== 'batch') {
      this.trace.add({
        at: started,
        source,
        command: name,
        target: ctx.target.label,
        ok,
        ...('error' in outcome ? { code: outcome.error.code, message: outcome.error.message } : {}),
        ms: Date.now() - started
      })
    }
    return this.envelope(name, outcome)
  }

  private async engineVersion(): Promise<string | null> {
    const engine = this.deps.engine()
    if (!engine) return null
    try {
      return (await engine.call<RawStatus>('status', {}, 8000)).version
    } catch {
      return null
    }
  }

  async status(): Promise<AppControlStatus> {
    const platform = (['darwin', 'win32'].includes(this.deps.platform) ? this.deps.platform : 'linux') as AppControlStatus['platform']
    const info = this.deps.engineInfo()
    const engine = this.deps.engine()
    let available = false
    let version: string | null = null
    let detail = info.detail
    let permission: AppControlPermission = platform === 'darwin' ? 'unknown' : 'not-needed'
    if (engine) {
      try {
        const status = await engine.call<RawStatus>('status', {}, 8000)
        version = status.version
        if (status.problem) detail = status.problem
        else available = true
        if (platform === 'darwin') permission = status.trusted ? 'granted' : 'denied'
      } catch (error) {
        detail = error instanceof Error ? error.message : String(error)
      }
    }
    return {
      platform,
      settings: this.deps.settings(),
      engine: { available, name: info.name, version, detail },
      permission,
      protectedApps: PROTECTED_NAMES,
      cli: { command: APP_CONTROL_CLI }
    }
  }
}

export function toError(error: unknown): AppControlError {
  if (error instanceof AppControlFailure) return { code: error.code, message: error.message, ...(error.hint ? { hint: error.hint } : {}) }
  return { code: 'INTERNAL', message: error instanceof Error ? error.message : String(error) }
}
