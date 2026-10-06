import type { ConnectAppId, ConnectAppStatus, ConnectChoice, ConnectResult, RestartResult } from '@shared/connectApps'
import type { GatewayInfo } from '@shared/gateway'
import { chatgpt, codexCli } from './apps/codex'
import { claudeCode, droid, openclaw, opencode, pi, qwenCode } from './apps/jsonApps'
import { cline, copilotCli, deepseekHarness, poolside, terminal } from './apps/otherApps'
import { hermes, hermesDesktop, ohMyPi } from './apps/yamlApps'
import type { ConnectContext, Connector } from './connector'
import { ConfigError, readJson, tilde } from './files'
import type { LaunchSpec } from './launch'
import type { AppRecord, StateFile } from './state'

/** In the order the page lists them: the two recommended, then the rest. */
export const CONNECTORS: Connector[] = [
  claudeCode,
  chatgpt,
  codexCli,
  openclaw,
  opencode,
  hermes,
  hermesDesktop,
  droid,
  pi,
  cline,
  copilotCli,
  ohMyPi,
  deepseekHarness,
  poolside,
  qwenCode,
  terminal
]

/** Hermes Agent and Hermes Desktop share ~/.hermes/config.yaml, so one record covers both. */
const stateKey = (id: ConnectAppId): ConnectAppId => (id === 'hermes-desktop' ? 'hermes' : id)

export interface ConnectDeps {
  home: string
  platform: NodeJS.Platform
  state: StateFile
  /** The gateway as it is now. */
  info: () => GatewayInfo
  /** Starts the gateway if it's off (and has it start with Eaon from then on). */
  ensureRunning: () => Promise<GatewayInfo>
  which: (bin: string) => string | null
  run?: ConnectContext['run']
  /** Opens a terminal running `spec`; `name` is the app id, for the script's file name. */
  openTerminal?: (name: string, title: string, spec: LaunchSpec) => Promise<{ ok: true } | { ok: false; error: string }>
  /** Quits the Mac app called `name` if it's open, and opens it (again). */
  restartApp?: (name: string) => Promise<RestartResult>
  /** Whether the Mac app called `name` is open. */
  appRunning?: (name: string) => Promise<boolean>
}

export class ConnectApps {
  constructor(private readonly deps: ConnectDeps) {}

  private context(info: GatewayInfo = this.deps.info()): ConnectContext {
    return { home: this.deps.home, info, platform: this.deps.platform, which: this.deps.which, run: this.deps.run }
  }

  private find(id: ConnectAppId): Connector {
    const connector = CONNECTORS.find((c) => c.id === id)
    if (!connector) throw new Error(`Unknown app: ${id}`)
    return connector
  }

  list(): ConnectAppStatus[] {
    const ctx = this.context()
    const state = this.deps.state.read()
    return CONNECTORS.map((c) => this.statusOf(c, ctx, state[stateKey(c.id)] ?? null))
  }

  status(id: ConnectAppId): ConnectAppStatus {
    const connector = this.find(id)
    return this.statusOf(connector, this.context(), this.deps.state.get(stateKey(id)))
  }

  private statusOf(c: Connector, ctx: ConnectContext, record: AppRecord | null): ConnectAppStatus {
    let installed = false
    try {
      installed = c.installed(ctx)
    } catch {
      /* treated as not installed */
    }
    const base = {
      id: c.id,
      name: c.name,
      kind: c.kind,
      blurb: c.blurb,
      installed,
      ...(c.installHint ? { installHint: c.installHint } : {}),
      hasSmallModel: c.hasSmallModel,
      multiModel: Boolean(c.multiModel),
      restartable: Boolean(c.desktopApp) && ctx.platform === 'darwin' && installed && Boolean(this.deps.restartApp),
      canOpen: Boolean(c.launch),
      files: c.files(ctx).map((f) => tilde(f, ctx.home)),
      ...(c.note ? { note: c.note } : {})
    }
    if (c.kind === 'manual') return { ...base, connected: false, model: null, models: [], smallModel: null }
    if (c.kind === 'launch' || !c.inspect) {
      const model = record?.model ?? null
      return { ...base, connected: Boolean(record), model, models: model ? [model] : [], smallModel: record?.smallModel ?? null }
    }
    const error = this.problem(c, ctx)
    const found = c.inspect(ctx, record)
    const model = found.connected ? (found.model ?? record?.model ?? null) : null
    // The app's own list when it can be read back, else what Eaon wrote; the default first either way.
    const models = model ? [...new Set([model, ...(found.models ?? record?.models ?? [])])] : []
    return {
      ...base,
      connected: found.connected,
      ...(found.connected && found.stale ? { stale: true } : {}),
      model,
      models: c.multiModel ? models : models.slice(0, 1),
      smallModel: found.connected ? (record?.smallModel ?? null) : null,
      ...(error ? { error } : {})
    }
  }

  /** A settings file Eaon would refuse to rewrite (comments, a typo), said up front rather than on Connect. */
  private problem(c: Connector, ctx: ConnectContext): string | null {
    const owned = c.owned?.(ctx) ?? []
    for (const file of c.files(ctx)) {
      if (!file.endsWith('.json') || owned.includes(file)) continue
      try {
        readJson(file, ctx.home)
      } catch (err) {
        if (err instanceof ConfigError) return err.message
      }
    }
    return null
  }

  /**
   * The models to use: the ones asked for, else the last ones used, else the
   * gateway's defaults. A model asked for that Eaon no longer has is refused;
   * one remembered from last time is quietly left out. A new default with no
   * list takes the old default's place among the models listed last time.
   */
  private choose(c: Connector, info: GatewayInfo, choice: Partial<ConnectChoice> | undefined, record: AppRecord | null): ConnectChoice {
    const known = (id: string | null | undefined): string | null => (id && info.models.some((m) => m.id === id) ? id : null)
    for (const id of [choice?.model, ...(choice?.models ?? []), choice?.smallModel]) {
      if (id && !known(id)) throw new ConfigError(`${id} isn't one of your models in Eaon any more. Pick another.`)
    }
    const model = known(choice?.model) ?? known(record?.model) ?? known(info.defaultModel) ?? info.models[0]?.id
    if (!model) throw new ConfigError('Eaon has no models to share yet. Add a provider in Settings → Models first.')
    const others = !c.multiModel ? [] : (choice?.models ?? (record?.models ?? []).filter((id) => id !== record?.model)).filter((id) => known(id))
    const models = [...new Set([model, ...others])]
    if (!c.hasSmallModel) return { model, models }
    const smallModel = choice && 'smallModel' in choice ? known(choice.smallModel) : (known(record?.smallModel) ?? known(info.smallModel))
    return { model, models, smallModel }
  }

  async connect(id: ConnectAppId, choice?: Partial<ConnectChoice>): Promise<ConnectResult> {
    try {
      const c = this.find(id)
      if (c.kind === 'manual' || !c.connect) {
        return { ok: false, error: `Eaon can't change ${c.name}'s settings itself. Use Copy settings and paste them in.` }
      }
      const previous = this.deps.state.get(stateKey(id))
      const info = await this.deps.ensureRunning()
      const picked = this.choose(c, info, choice, previous)
      const outcome = await c.connect(this.context(info), picked, previous)
      this.deps.state.set(stateKey(id), outcome.record)
      return {
        ok: true,
        status: this.status(id),
        written: outcome.written.map((w) => ({ ...w, path: tilde(w.path, this.deps.home) }))
      }
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) }
    }
  }

  /**
   * Brings connections Eaon made back in line when they've drifted: the
   * gateway's port or key changed, or the app was connected by an older Eaon
   * (ChatGPT without a model catalog, so its picker showed none of the
   * models). Each is reconnected with the models it had. Run at startup, so
   * nobody has to find the app's settings file or press Reconnect. Returns
   * the apps it fixed.
   */
  async refreshStale(): Promise<ConnectAppId[]> {
    const fixed: ConnectAppId[] = []
    const ctx = this.context()
    for (const c of CONNECTORS) {
      if (c.kind !== 'config' || !c.inspect || !c.connect) continue
      // Hermes Desktop shares Hermes Agent's record and file; one pass is enough.
      if (stateKey(c.id) !== c.id) continue
      const record = this.deps.state.get(c.id)
      if (!record) continue
      try {
        const found = c.inspect(ctx, record)
        if (!found.connected || !found.stale || this.problem(c, ctx)) continue
        // The model the app has now, when it's one of Eaon's (picked in the app's own picker), else Eaon's last.
        const model = found.model && ctx.info.models.some((m) => m.id === found.model) ? found.model : record.model
        const models = (record.models ?? []).filter((id) => ctx.info.models.some((m) => m.id === id))
        const picked = this.choose(c, ctx.info, { model, models, ...(c.hasSmallModel ? { smallModel: record.smallModel } : {}) }, record)
        const outcome = await c.connect(ctx, picked, record)
        this.deps.state.set(c.id, outcome.record)
        fixed.push(c.id)
      } catch {
        /* left as it is; the page shows it as needing a reconnect */
      }
    }
    return fixed
  }

  /** Whether the app is open now, so the page can offer to restart it rather than open it. */
  async running(id: ConnectAppId): Promise<boolean> {
    const c = this.find(id)
    return Boolean(c.desktopApp && this.deps.appRunning && (await this.deps.appRunning(c.desktopApp)))
  }

  /** Quits the app if it's open and opens it again, so it loads what Eaon wrote. */
  async restart(id: ConnectAppId): Promise<RestartResult> {
    const c = this.find(id)
    if (!c.desktopApp || !this.deps.restartApp || this.deps.platform !== 'darwin') {
      return { ok: false, error: `Eaon can't restart ${c.name} here. Quit it and open it again.` }
    }
    return this.deps.restartApp(c.desktopApp)
  }

  async disconnect(id: ConnectAppId): Promise<ConnectResult> {
    try {
      const c = this.find(id)
      const record = this.deps.state.get(stateKey(id))
      if (c.kind === 'config' && c.disconnect) {
        const ctx = this.context()
        // No record, but connected: the earlier Claude Code page, which the connector knows how to undo.
        await c.disconnect(ctx, record ?? { model: '', smallModel: null, connectedAt: 0, keys: {} })
      }
      this.deps.state.set(stateKey(id), null)
      const status = this.status(id)
      if (status.connected) {
        return {
          ok: false,
          error: `Eaon has no record of what it changed in ${c.name}'s settings, so it left them alone. Remove Eaon's entries from ${status.files.join(' and ')} by hand.`
        }
      }
      return { ok: true, status, written: [] }
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) }
    }
  }

  /**
   * Opens the app in a terminal. For apps that read only environment
   * variables this is how they connect, so it saves the choice too.
   */
  async launch(id: ConnectAppId, choice?: Partial<ConnectChoice>): Promise<{ ok: true } | { ok: false; error: string }> {
    try {
      const c = this.find(id)
      if (!c.launch || !this.deps.openTerminal) return { ok: false, error: `Eaon can't open ${c.name} from here.` }
      const previous = this.deps.state.get(stateKey(id))
      const info = await this.deps.ensureRunning()
      const picked = this.choose(c, info, choice, previous)
      if (c.kind === 'launch' && c.connect) {
        const outcome = await c.connect(this.context(info), picked, previous)
        this.deps.state.set(stateKey(id), outcome.record)
      }
      return await this.deps.openTerminal(id, c.name, c.launch(this.context(info), picked))
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) }
    }
  }

  /** What to paste or set by hand: the Copy settings text. */
  manual(id: ConnectAppId, choice?: Partial<ConnectChoice>): { ok: true; text: string } | { ok: false; error: string } {
    try {
      const c = this.find(id)
      const info = this.deps.info()
      return { ok: true, text: c.manual(this.context(info), this.choose(c, info, choice, this.deps.state.get(stateKey(id)))) }
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) }
    }
  }
}
