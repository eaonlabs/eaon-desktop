import { execFile } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { ClaudeToolsResult, ClaudeToolsStatus } from '@shared/connectApps'
import { tilde } from './files'

/**
 * Eaon's tools in Claude Code: the user's own Claude Code gets Eaon's control
 * API (main/control: chats, workers, models, the ADE) as an MCP server, added
 * for every folder with Claude Code's own `claude mcp add`.
 *
 * This is how someone with a Claude plan uses it with Eaon. Anthropic doesn't
 * let other apps sign in with a Claude plan, so Eaon never does: it doesn't
 * read Claude Code's sign-in, start it, type into it, read its answers or add
 * to its system prompt. Claude Code stays the app the user runs and talks to;
 * Eaon is a tool server it calls like any other, and Claude Code's own
 * permission settings decide when it asks first (the ADE's panes start it
 * with --dangerously-skip-permissions). The entry carries its own key
 * (gateway/models.ts `claudeCodeToken`), which opens the control API but not
 * the model routes, and disconnecting deletes it.
 */

export const CLAUDE_TOOLS_NAME = 'eaon-app'

export interface ClaudeToolsDeps {
  home: string
  /** Where Claude Code keeps its user settings, MCP servers among them. */
  configFile: string
  which: (bin: string) => string | null
  /** Runs Claude Code's CLI; never throws. */
  run: (bin: string, args: string[]) => Promise<{ ok: boolean; output: string }>
  /** The gateway's port now, running or not. */
  port: () => number
  /** Starts the gateway if it's off (and from then on with Eaon). */
  ensureRunning: () => Promise<{ port: number }>
  token: (create: boolean) => string | null
  forgetToken: () => void
}

interface Entry {
  type?: string
  url?: string
  headers?: Record<string, string>
}

export class ClaudeTools {
  constructor(private deps: ClaudeToolsDeps) {}

  private url(port: number): string {
    return `http://127.0.0.1:${port}/control/mcp`
  }

  /** Claude Code's entry for Eaon, if it has one. A file it can't read counts as none. */
  private entry(): Entry | null {
    try {
      const config = JSON.parse(readFileSync(this.deps.configFile, 'utf8')) as { mcpServers?: Record<string, Entry> }
      const found = config.mcpServers?.[CLAUDE_TOOLS_NAME]
      return found && typeof found === 'object' ? found : null
    } catch {
      return null
    }
  }

  status(): ClaudeToolsStatus {
    const entry = this.entry()
    const token = this.deps.token(false)
    const current = entry !== null && token !== null && entry.url === this.url(this.deps.port()) && entry.headers?.Authorization === `Bearer ${token}`
    return {
      installed: this.deps.which('claude') !== null,
      connected: entry !== null,
      stale: entry !== null && !current,
      name: CLAUDE_TOOLS_NAME,
      file: tilde(this.deps.configFile, this.deps.home)
    }
  }

  /** The arguments that add Eaon to Claude Code. The header goes last: `--header` takes every value after it. */
  private async addArgs(): Promise<string[]> {
    const { port } = await this.deps.ensureRunning()
    const token = this.deps.token(true)
    if (!token) throw new Error('Eaon couldn’t make a key for Claude Code.')
    return ['mcp', 'add', '--transport', 'http', '--scope', 'user', CLAUDE_TOOLS_NAME, this.url(port), '--header', `Authorization: Bearer ${token}`]
  }

  async connect(): Promise<ClaudeToolsResult> {
    const bin = this.deps.which('claude')
    if (!bin) return this.failed('Claude Code isn’t installed (no `claude` on PATH). Install it with npm install -g @anthropic-ai/claude-code.')
    let args: string[]
    try {
      args = await this.addArgs()
    } catch (error) {
      return this.failed(error instanceof Error ? error.message : String(error))
    }
    // `mcp add` won't replace an entry, so one from an earlier connect (another port) goes first.
    if (this.entry()) await this.deps.run(bin, ['mcp', 'remove', '--scope', 'user', CLAUDE_TOOLS_NAME])
    const added = await this.deps.run(bin, args)
    if (!added.ok) return this.failed(`\`claude mcp add\` failed: ${tail(added.output)}`)
    return { ok: true, status: this.status() }
  }

  async disconnect(): Promise<ClaudeToolsResult> {
    // The key goes first: whatever happens to the entry, it no longer opens anything.
    this.deps.forgetToken()
    if (!this.entry()) return { ok: true, status: this.status() }
    const bin = this.deps.which('claude')
    const removed = bin ? await this.deps.run(bin, ['mcp', 'remove', '--scope', 'user', CLAUDE_TOOLS_NAME]) : null
    if (removed?.ok) return { ok: true, status: this.status() }
    const why = removed ? `\`claude mcp remove\` failed: ${tail(removed.output)}` : 'Claude Code isn’t on PATH, so Eaon can’t change its settings.'
    return this.failed(`${why} Eaon’s key no longer works, so Claude Code can’t reach Eaon; to remove the entry, run claude mcp remove --scope user ${CLAUDE_TOOLS_NAME}.`)
  }

  /** The command to run by hand, for a `claude` Eaon can't find. Makes the key and starts the gateway, like connecting. */
  async command(): Promise<string> {
    const args = await this.addArgs()
    return ['claude', ...args.map((arg) => (/[\s"]/.test(arg) ? `"${arg}"` : arg))].join(' ')
  }

  /** Re-adds an entry left behind by a change of port, as the apps are. Returns whether it did. */
  async refreshStale(): Promise<boolean> {
    const now = this.status()
    if (!now.connected || !now.stale || !now.installed || this.deps.token(false) === null) return false
    return (await this.connect()).ok
  }

  private failed(error: string): ClaudeToolsResult {
    return { ok: false, error, status: this.status() }
  }
}

const tail = (output: string): string => output.trim().split('\n').slice(-3).join(' ') || 'it exited with an error'

/** Claude Code's user settings file: `~/.claude.json`, or inside CLAUDE_CONFIG_DIR when that's set. */
export function claudeConfigFile(home: string, env: NodeJS.ProcessEnv = process.env): string {
  return env.CLAUDE_CONFIG_DIR ? join(env.CLAUDE_CONFIG_DIR, '.claude.json') : join(home, '.claude.json')
}

/**
 * Runs `claude`. npm's install on Windows is a .cmd shim, which only runs
 * through cmd.exe; nothing passed here needs quoting beyond spaces. `home`
 * stands in for the user's home folder (EAON_CONNECT_APPS_HOME), so a test
 * run edits that one's settings rather than the real ones.
 */
export function runClaude(home: string | null) {
  return (bin: string, args: string[]): Promise<{ ok: boolean; output: string }> => {
    const shim = process.platform === 'win32' && /\.(cmd|bat)$/i.test(bin)
    const quote = (arg: string): string => (/[\s"]/.test(arg) ? `"${arg}"` : arg)
    const env = home ? { ...process.env, HOME: home, USERPROFILE: home } : process.env
    return new Promise((resolve) => {
      execFile(
        shim ? quote(bin) : bin,
        shim ? args.map(quote) : args,
        { env, shell: shim, timeout: 30_000, windowsHide: true, maxBuffer: 1024 * 1024 },
        (error, stdout, stderr) => resolve({ ok: !error, output: `${String(stdout ?? '')}${String(stderr ?? '')}` })
      )
    })
  }
}
