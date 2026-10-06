/**
 * Connect apps: pointing other coding apps (Claude Code, Codex, OpenCode…) at
 * the models the user has set up in Eaon, through Eaon's local gateway (see
 * shared/gateway.ts). Each app is connected one of three ways:
 *
 * - `config`: Eaon writes the app's own settings file, merging only the keys
 *   it owns, and puts back what was there when the app is disconnected.
 * - `launch`: the app only reads environment variables, so Eaon remembers the
 *   choice and opens the app in a terminal with them set.
 * - `manual`: the app keeps its settings where Eaon can't safely write them (a
 *   VS Code extension, a web UI); Eaon gives the steps and the values to paste.
 */

export type ConnectAppId =
  | 'claude-code'
  | 'chatgpt'
  | 'codex-cli'
  | 'openclaw'
  | 'opencode'
  | 'hermes'
  | 'hermes-desktop'
  | 'droid'
  | 'pi'
  | 'cline'
  | 'copilot-cli'
  | 'oh-my-pi'
  | 'deepseek-harness'
  | 'poolside'
  | 'qwen-code'
  | 'terminal'

export type ConnectKind = 'config' | 'launch' | 'manual'

/** Which of the user's models the app should use, as gateway ids (`provider/model`). */
export interface ConnectChoice {
  /** The default: what the app starts with. */
  model: string
  /**
   * Every model the app should list in its own picker, for apps that keep a
   * list (`multiModel`). `model` is always among them, first.
   */
  models?: string[]
  /** The app's small/fast model, for apps with that slot; falls back to `model`. */
  smallModel?: string | null
}

export interface ConnectAppStatus {
  id: ConnectAppId
  name: string
  kind: ConnectKind
  /** One line under the name: what connecting does. */
  blurb: string
  installed: boolean
  /** Where to get it, when it isn't installed. */
  installHint?: string
  /** Eaon's settings are in the app's config (config), or a choice is saved (launch). */
  connected: boolean
  /** Connected, but to a different port or token than the gateway has now: connect again. */
  stale?: boolean
  model: string | null
  /** The models the app lists, default first (just `model` for apps with one slot). */
  models: string[]
  smallModel: string | null
  /** Whether the app has a separate small/fast model setting. */
  hasSmallModel: boolean
  /** Whether the app keeps a list of models, so the user can pick as many as they like. */
  multiModel: boolean
  /** A desktop app Eaon can quit and reopen so it loads the change (ChatGPT on a Mac). */
  restartable: boolean
  /** Eaon can open the app in a terminal (Open in Terminal). */
  canOpen: boolean
  /** The files Eaon writes for this app, as the user would type them (`~/…`). */
  files: string[]
  /** Something to know after connecting: restart the app, pick the model with /model… */
  note?: string
  /** Set when the app's config can't be read (malformed, comments Eaon won't rewrite). */
  error?: string
}

export interface ConnectWritten {
  path: string
  keys: string[]
}

export type ConnectResult =
  | { ok: true; status: ConnectAppStatus; written: ConnectWritten[] }
  | { ok: false; error: string }

/** Restarting a desktop app: `reopened` when it was open and Eaon quit it first, `opened` when it wasn't. */
export type RestartResult = { ok: true; action: 'reopened' | 'opened' } | { ok: false; error: string }
