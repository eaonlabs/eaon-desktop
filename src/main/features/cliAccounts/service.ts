import { randomUUID } from 'node:crypto'
import os from 'node:os'
import path from 'node:path'
import {
  CLI_TOOLS,
  CLI_TOOL_NAME,
  DEFAULT_ACCOUNT_ID,
  usageKey,
  type AccountUsage,
  type CliAccount,
  type CliAccountsState,
  type CliLogin,
  type CliTool,
  type CliToolAccounts
} from '@shared/cliAccounts'
import { claudeStatus, claudeUsage, codexAccount, codexUsage } from './parse'
import { DIR_VARIABLE } from './cli'
import { prepareFolder, removeFolder } from './folders'

/**
 * The accounts each CLI can run as, which one Eaon's terminals use, and the
 * last figures read for each. Everything that touches a CLI comes in through
 * `CliRunner`, so tests drive this with scripted answers.
 */

/** Figures are read again only once they are this old… */
export const FRESH_MS = 60_000
/** …or this old when the user asks (the refresh button). */
export const FORCED_FRESH_MS = 15_000

export interface CliRunner {
  find: (tool: CliTool) => string | null
  claudeUsage: (bin: string, dir: string | null) => Promise<unknown>
  claudeStatus: (bin: string, dir: string | null) => Promise<unknown>
  codexRead: (bin: string, dir: string | null) => Promise<{ account: unknown; limits: unknown | null }>
  logout: (tool: CliTool, bin: string, dir: string) => Promise<void>
}

/** A running sign-in: the CLI's login in a terminal Eaon holds. */
export interface LoginProcess {
  write: (data: string) => void
  kill: () => void
  onData: (listener: (data: string) => void) => void
  onExit: (listener: (code: number) => void) => void
}

export interface CliAccountsDeps {
  runner: CliRunner
  /** Where Eaon makes extra accounts' folders. */
  root: string
  load: () => Partial<Saved>
  save: (saved: Saved) => void
  startLogin: (tool: CliTool, bin: string, dir: string) => LoginProcess
  changed: () => void
  now?: () => number
  /** The default folders the shared links point at (tests). */
  defaultDirs?: Partial<Record<CliTool, string>>
}

interface Saved {
  tools: Record<CliTool, { active: string; accounts: CliAccount[] }>
  usage: Record<string, AccountUsage>
}

const defaultAccount = (at: number): CliAccount => ({ id: DEFAULT_ACCOUNT_ID, dir: null, label: '', email: null, plan: null, addedAt: at })

export class CliAccounts {
  private saved: Saved
  private loading = new Map<string, Promise<void>>()
  private login: CliLogin = { state: 'idle' }
  private loginProcess: LoginProcess | null = null
  /** The running sign-in made its account: failing, it takes the account with it. */
  private loginIsNew = false
  private now: () => number

  constructor(private readonly deps: CliAccountsDeps) {
    this.now = deps.now ?? Date.now
    const raw = deps.load()
    const tools = {} as Saved['tools']
    for (const tool of CLI_TOOLS) {
      const saved = raw.tools?.[tool]
      const accounts = (Array.isArray(saved?.accounts) ? saved.accounts : []).filter((a) => a && typeof a.id === 'string')
      if (!accounts.some((a) => a.id === DEFAULT_ACCOUNT_ID)) accounts.unshift(defaultAccount(0))
      const active = accounts.some((a) => a.id === saved?.active) ? (saved!.active as string) : DEFAULT_ACCOUNT_ID
      tools[tool] = { active, accounts }
    }
    this.saved = { tools, usage: raw.usage && typeof raw.usage === 'object' ? raw.usage : {} }
  }

  /* -------------------------------------------------------------- reading */

  state(): CliAccountsState {
    const tools = {} as Record<CliTool, CliToolAccounts>
    for (const tool of CLI_TOOLS) {
      tools[tool] = { installed: Boolean(this.deps.runner.find(tool)), active: this.saved.tools[tool].active, accounts: this.saved.tools[tool].accounts.map((a) => ({ ...a })) }
    }
    return { tools, usage: { ...this.saved.usage }, loading: [...this.loading.keys()], login: { ...this.login } }
  }

  /**
   * The folder variables Eaon's terminals get: for each CLI whose active
   * account isn't the default, where that account lives. Running `claude`
   * or `codex` in any pane then uses it.
   */
  terminalEnv(): Record<string, string> {
    const env: Record<string, string> = {}
    for (const tool of CLI_TOOLS) {
      const account = this.active(tool)
      if (account.dir) env[DIR_VARIABLE[tool]] = account.dir
    }
    return env
  }

  active(tool: CliTool): CliAccount {
    const { active, accounts } = this.saved.tools[tool]
    return accounts.find((a) => a.id === active) ?? accounts[0]
  }

  /**
   * Reads the figures again, for the active accounts (or every account of
   * `tool`, for Settings) — unless what is known is fresh. Calls already
   * under way are shared, never doubled.
   */
  async refresh(options: { tool?: CliTool; all?: boolean; force?: boolean } = {}): Promise<void> {
    const tools = options.tool ? [options.tool] : CLI_TOOLS
    const jobs: Promise<void>[] = []
    for (const tool of tools) {
      const accounts = options.all ? this.saved.tools[tool].accounts : [this.active(tool)]
      for (const account of accounts) jobs.push(this.read(tool, account.id, options.force === true))
    }
    await Promise.all(jobs)
  }

  /** `force`: the refresh button's shorter wait; `'now'`: no wait at all (a sign-in just ended). */
  private read(tool: CliTool, accountId: string, force: boolean | 'now'): Promise<void> {
    const key = usageKey(tool, accountId)
    const running = this.loading.get(key)
    if (running && force !== 'now') return running
    const last = this.saved.usage[key]
    if (force !== 'now' && last && this.now() - last.at < (force ? FORCED_FRESH_MS : FRESH_MS)) return Promise.resolve()
    const bin = this.deps.runner.find(tool)
    if (!bin) return Promise.resolve()
    const job = this.readNow(tool, accountId, bin)
      .catch((error: unknown) => {
        this.saved.usage[key] = { ok: false, at: this.now(), reason: 'failed', message: messageOf(error) }
      })
      .finally(() => {
        this.loading.delete(key)
        this.persist()
      })
    this.loading.set(key, job)
    this.deps.changed()
    return job
  }

  private async readNow(tool: CliTool, accountId: string, bin: string): Promise<void> {
    const account = this.find(tool, accountId)
    if (!account) return
    const key = usageKey(tool, accountId)
    const at = this.now()
    if (tool === 'claude') {
      const status = claudeStatus(await this.deps.runner.claudeStatus(bin, account.dir).catch(() => null))
      if (status.email || status.plan) this.describe(tool, accountId, status.email, status.plan)
      if (!status.loggedIn) {
        this.saved.usage[key] = { ok: false, at, reason: 'signed-out', message: 'Not signed in' }
        return
      }
      if (status.method && status.method !== 'claude.ai') {
        this.saved.usage[key] = { ok: false, at, reason: 'no-limits', message: 'Signed in with an API key: billed per use, no plan limits' }
        return
      }
      const usage = claudeUsage(await this.deps.runner.claudeUsage(bin, account.dir))
      if (usage.plan) this.describe(tool, accountId, null, usage.plan)
      this.saved.usage[key] = usage.available
        ? { ok: true, at, plan: usage.plan, windows: usage.windows }
        : { ok: false, at, reason: 'no-limits', message: 'No plan limits for this sign-in' }
      return
    }
    const answer = await this.deps.runner.codexRead(bin, account.dir)
    const who = codexAccount(answer.account)
    if (who.email || who.plan) this.describe(tool, accountId, who.email, who.plan)
    if (!who.signedIn) {
      this.saved.usage[key] = { ok: false, at, reason: 'signed-out', message: 'Not signed in' }
      return
    }
    if (!who.chatgpt || !answer.limits) {
      this.saved.usage[key] = { ok: false, at, reason: 'no-limits', message: 'Signed in with an API key: billed per use, no plan limits' }
      return
    }
    const usage = codexUsage(answer.limits)
    this.saved.usage[key] = { ok: true, at, plan: usage.plan ?? who.plan, windows: usage.windows }
  }

  /** Keeps what the CLI says about who an account is. */
  private describe(tool: CliTool, accountId: string, email: string | null, plan: string | null): void {
    const account = this.find(tool, accountId)
    if (!account) return
    if (email) account.email = email
    if (plan) account.plan = plan
  }

  /* -------------------------------------------------------------- changing */

  /** Makes `accountId` the one Eaon's terminals use. Panes already running keep theirs. */
  use(tool: CliTool, accountId: string): void {
    if (!this.find(tool, accountId)) throw new Error('No such account')
    this.saved.tools[tool].active = accountId
    this.persist()
    void this.refresh({ tool })
  }

  rename(tool: CliTool, accountId: string, label: string): void {
    const account = this.find(tool, accountId)
    if (!account) throw new Error('No such account')
    account.label = label.trim().slice(0, 60)
    this.persist()
  }

  /**
   * Forgets an extra account: the CLI signs it out of its own folder first
   * (its login goes with it), then the folder is deleted. The default
   * account is the CLI's own and is never removed.
   */
  async remove(tool: CliTool, accountId: string): Promise<void> {
    if (accountId === DEFAULT_ACCOUNT_ID) throw new Error('The default account is the CLI’s own; sign out of it in a terminal instead')
    const account = this.find(tool, accountId)
    if (!account?.dir) return
    if (this.login.state === 'running' && this.login.accountId === accountId) this.cancelLogin()
    const bin = this.deps.runner.find(tool)
    if (bin) await this.deps.runner.logout(tool, bin, account.dir).catch(() => undefined)
    removeFolder(account.dir, this.deps.root)
    const entry = this.saved.tools[tool]
    entry.accounts = entry.accounts.filter((a) => a.id !== accountId)
    if (entry.active === accountId) entry.active = DEFAULT_ACCOUNT_ID
    delete this.saved.usage[usageKey(tool, accountId)]
    this.persist()
  }

  /**
   * Adds an account: a new folder, and the CLI's own sign-in run in it. It
   * becomes the active one once the CLI says it is signed in; a sign-in that
   * is cancelled or fails leaves nothing behind.
   */
  addAccount(tool: CliTool): CliLogin {
    if (this.login.state === 'running') throw new Error('Finish the sign-in that is already open first')
    const bin = this.deps.runner.find(tool)
    if (!bin) throw new Error(`${CLI_TOOL_NAME[tool]} isn’t installed`)
    const id = randomUUID().slice(0, 8)
    const dir = path.join(this.deps.root, tool, id)
    prepareFolder(tool, dir, this.deps.defaultDirs?.[tool])
    const account: CliAccount = { id, dir, label: '', email: null, plan: null, addedAt: this.now() }
    this.saved.tools[tool].accounts.push(account)
    this.persist()
    return this.runLogin(tool, bin, account, true)
  }

  /**
   * Signs an extra account in again (its login expired, or was signed out in
   * a terminal): the CLI's sign-in in the folder it already has. Failing
   * leaves the account as it was. The default account signs in in a terminal.
   */
  signIn(tool: CliTool, accountId: string): CliLogin {
    if (this.login.state === 'running') throw new Error('Finish the sign-in that is already open first')
    const bin = this.deps.runner.find(tool)
    if (!bin) throw new Error(`${CLI_TOOL_NAME[tool]} isn’t installed`)
    const account = this.find(tool, accountId)
    if (!account?.dir) throw new Error('Sign the default account in by running the CLI in a terminal')
    prepareFolder(tool, account.dir, this.deps.defaultDirs?.[tool])
    return this.runLogin(tool, bin, account, false)
  }

  private runLogin(tool: CliTool, bin: string, account: CliAccount, isNew: boolean): CliLogin {
    const id = account.id
    const proc = this.deps.startLogin(tool, bin, account.dir as string)
    this.loginProcess = proc
    this.loginIsNew = isNew
    this.login = { state: 'running', tool, accountId: id, url: null, output: '' }
    let output = ''
    proc.onData((data) => {
      if (this.loginProcess !== proc || this.login.state !== 'running') return
      output = (output + stripAnsi(data)).slice(-4000)
      const url = this.login.url ?? firstUrl(output)
      this.login = { ...this.login, url, output: tail(output) }
      this.deps.changed()
    })
    proc.onExit((code) => {
      if (this.loginProcess !== proc) return
      this.loginProcess = null
      void this.finishLogin(tool, id, code)
    })
    this.deps.changed()
    return { ...this.login }
  }

  /** Something the CLI's sign-in asks for (a code pasted from the browser). */
  loginInput(text: string): void {
    if (this.login.state !== 'running' || !this.loginProcess) return
    this.loginProcess.write(text.replace(/[\r\n]+$/, '') + '\r')
  }

  cancelLogin(): void {
    const proc = this.loginProcess
    const login = this.login
    if (!proc || login.state !== 'running') return
    this.login = { ...login, state: 'failed', message: 'Cancelled' }
    this.loginProcess = null
    proc.kill()
    if (this.loginIsNew) void this.discard(login.tool, login.accountId)
    else this.deps.changed()
  }

  dismissLogin(): void {
    if (this.login.state === 'running') return
    this.login = { state: 'idle' }
    this.deps.changed()
  }

  private async finishLogin(tool: CliTool, accountId: string, code: number): Promise<void> {
    if (this.login.state !== 'running') return
    const output = this.login.output
    // Whether it worked is what the CLI says now, not just how it exited —
    // never figures from before the sign-in.
    await this.loading.get(usageKey(tool, accountId))?.catch(() => undefined)
    await this.read(tool, accountId, 'now')
    const usage = this.saved.usage[usageKey(tool, accountId)]
    const signedIn = usage && !(usage.ok === false && usage.reason === 'signed-out')
    const account = this.find(tool, accountId)
    if (!signedIn || !account) {
      this.login = { state: 'failed', tool, accountId, url: null, output, message: code === 0 ? 'The sign-in didn’t finish' : `The sign-in stopped (${code})` }
      if (this.loginIsNew) await this.discard(tool, accountId)
      else this.persist()
      return
    }
    if (!this.loginIsNew) {
      this.login = { state: 'done', tool, accountId, url: null, output, message: `Signed in${account.email ? ` as ${account.email}` : ''}` }
      this.persist()
      return
    }
    const twin = account.email ? this.saved.tools[tool].accounts.find((a) => a.id !== accountId && a.email === account.email) : undefined
    if (twin) {
      this.login = { state: 'failed', tool, accountId, url: null, output, message: `${account.email} is already here` }
      await this.remove(tool, accountId)
      return
    }
    this.saved.tools[tool].active = accountId
    this.login = { state: 'done', tool, accountId, url: null, output, message: `Signed in${account.email ? ` as ${account.email}` : ''}` }
    this.persist()
  }

  /** A sign-in that went nowhere: its folder and entry go. */
  private async discard(tool: CliTool, accountId: string): Promise<void> {
    const account = this.find(tool, accountId)
    if (account?.dir) {
      try {
        removeFolder(account.dir, this.deps.root)
      } catch {
        /* outside root: never deleted */
      }
    }
    const entry = this.saved.tools[tool]
    entry.accounts = entry.accounts.filter((a) => a.id !== accountId)
    if (entry.active === accountId) entry.active = DEFAULT_ACCOUNT_ID
    delete this.saved.usage[usageKey(tool, accountId)]
    this.persist()
  }

  dispose(): void {
    this.loginProcess?.kill()
    this.loginProcess = null
  }

  private find(tool: CliTool, accountId: string): CliAccount | undefined {
    return this.saved.tools[tool].accounts.find((a) => a.id === accountId)
  }

  private persist(): void {
    this.deps.save(this.saved)
    this.deps.changed()
  }
}

/** Where Eaon keeps extra accounts by default. */
export const accountsRoot = (userData: string = path.join(os.homedir(), '.eaon')): string => path.join(userData, 'cli-accounts')

function messageOf(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error)
  return text.slice(0, 200) || 'Couldn’t read usage'
}

// eslint-disable-next-line no-control-regex
const ANSI = /\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[@-_]/g
export const stripAnsi = (text: string): string => text.replace(ANSI, '').replace(/\r(?!\n)/g, '\n')

/** The first sign-in page in what the CLI printed (its terminal is wide enough that links never wrap). */
export function firstUrl(text: string): string | null {
  const match = /https:\/\/[^\s"'<>]+/.exec(text)
  return match ? match[0].replace(/[.,)\]]+$/, '') : null
}

const tail = (text: string): string =>
  text
    .split('\n')
    .map((line) => line.trimEnd())
    .filter(Boolean)
    .slice(-8)
    .join('\n')
