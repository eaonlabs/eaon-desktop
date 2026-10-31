import { spawn, execFile } from 'node:child_process'
import fs from 'node:fs'
import { readFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { claudeCodeEnv } from '../../engines/claude/env'
import type { CliTool } from '@shared/cliAccounts'
import { onPath } from '../../shellEnv'
import { launcherEnv } from '../terminals/ptyManager'

/**
 * Asking Claude Code and Codex themselves. Eaon starts the CLI — for an
 * account of Eaon's, pointed at its folder the way the CLI documents — and
 * asks over the CLI's own protocol what /usage would show. The CLI signs its
 * own requests with its own login and refreshes it itself: Eaon never sees,
 * copies or refreshes a token, and nothing is ever sent to a model.
 */

const TIMEOUT_MS = 25_000
const CLIENT = { name: 'eaon_desktop', title: 'Eaon', version: '1' }

/** The folder variable each CLI documents for keeping its login and settings somewhere else. */
export const DIR_VARIABLE: Record<CliTool, string> = { claude: 'CLAUDE_CONFIG_DIR', codex: 'CODEX_HOME' }

/** Names a CLI to use instead of searching (`none`: not installed). Codex's is the one Eaon's Codex engine honours too. */
export const BIN_VARIABLE: Record<CliTool, string> = { claude: 'EAON_CLAUDE_BIN', codex: 'EAON_CODEX_BIN' }

/** Where each CLI is: as set in BIN_VARIABLE, on PATH, else (Codex) the copy the ChatGPT app ships. */
export function findCli(
  tool: CliTool,
  which: (bin: string) => string | null = onPath,
  exists: (file: string) => boolean = fs.existsSync,
  env: NodeJS.ProcessEnv = process.env
): string | null {
  const pinned = env[BIN_VARIABLE[tool]]?.trim()
  if (pinned) return pinned === 'none' || !exists(pinned) ? null : pinned
  if (tool === 'claude') return which('claude')
  const found = which('codex')
  if (found) return found
  if (process.platform !== 'darwin') return null
  const bundled = ['ChatGPT.app/Contents/Resources/codex-cli/bin/codex', 'Codex.app/Contents/Resources/codex-cli/bin/codex', 'Codex.app/Contents/Resources/codex']
  for (const root of ['/Applications', path.join(os.homedir(), 'Applications')]) {
    for (const rel of bundled) {
      const file = path.join(root, rel)
      if (exists(file)) return file
    }
  }
  return null
}

/** The CLI's environment: a terminal's, with the account's folder when it isn't the default. */
export function cliEnv(tool: CliTool, dir: string | null): Record<string, string> {
  const env = launcherEnv(process.env)
  if (dir) env[DIR_VARIABLE[tool]] = dir
  return env
}

/** A quiet place to run from: no project, no CLAUDE.md, nothing to trust. */
const quietCwd = (): string => os.tmpdir()

/**
 * One JSON-lines conversation with a CLI over stdin/stdout: write the opening
 * lines, hand every line that comes back to `onLine` until it returns a
 * result, then end the CLI. A CLI that says nothing useful in time fails.
 */
function converse<T>(
  bin: string,
  args: string[],
  env: Record<string, string>,
  start: (send: (message: unknown) => void) => void,
  onLine: (message: Record<string, unknown>, send: (message: unknown) => void) => T | undefined
): Promise<T> {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { cwd: quietCwd(), env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true })
    let buffer = ''
    let stderr = ''
    let settled = false
    const finish = (error: Error | null, value?: T): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      try {
        child.stdin.end()
      } catch {
        /* already closed */
      }
      child.kill()
      if (error) reject(error)
      else resolve(value as T)
    }
    const send = (message: unknown): void => {
      if (!settled && child.stdin.writable) child.stdin.write(JSON.stringify(message) + '\n')
    }
    const timer = setTimeout(() => finish(new Error(`${path.basename(bin)} didn't answer in time`)), TIMEOUT_MS)
    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (chunk: string) => {
      buffer += chunk
      let newline
      while ((newline = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, newline).trim()
        buffer = buffer.slice(newline + 1)
        if (!line.startsWith('{')) continue
        let message: Record<string, unknown>
        try {
          message = JSON.parse(line)
        } catch {
          continue
        }
        try {
          const result = onLine(message, send)
          if (result !== undefined) return finish(null, result)
        } catch (error) {
          return finish(error instanceof Error ? error : new Error(String(error)))
        }
      }
    })
    child.stderr.setEncoding('utf8')
    child.stderr.on('data', (chunk: string) => {
      stderr = (stderr + chunk).slice(-2000)
    })
    child.on('error', (error) => finish(error))
    child.on('exit', (code) => finish(new Error(lastLine(stderr) || `${path.basename(bin)} exited (${code})`)))
    child.stdin.on('error', () => {
      /* the CLI closed its end first */
    })
    start(send)
  })
}

const lastLine = (text: string): string =>
  text
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .pop() ?? ''

/* --------------------------------------------------------------- Claude Code */

/**
 * Claude Code's settings file for an account: `.claude.json` in its folder
 * (CLAUDE_CONFIG_DIR), or in the home folder for the default one. Only read,
 * for the limits Claude Code keeps there (parse.ts, claudeCachedUsage); null
 * when there's none.
 */
export async function claudeConfig(dir: string | null): Promise<unknown> {
  const folder = dir ?? process.env.CLAUDE_CONFIG_DIR ?? null
  const file = folder ? path.join(folder, '.claude.json') : path.join(os.homedir(), '.claude.json')
  try {
    return JSON.parse(await readFile(file, 'utf8'))
  } catch {
    return null
  }
}

/**
 * A plan's limits, asked of Claude Code itself: Eaon starts it for a moment
 * through the Agent SDK, sends it no message (so no model is asked and
 * nothing is used), and requests the data behind its /usage. Claude Code
 * fetches that from Anthropic with its own sign-in; Eaon never sees the
 * token. Null when this Claude Code can't answer: the request is marked
 * experimental in the SDK, so an older or newer one may not have it.
 */
export async function claudeLimits(bin: string, dir: string | null, clientVersion: string): Promise<unknown> {
  const { query } = await import('@anthropic-ai/claude-agent-sdk')
  const controller = new AbortController()
  // A session with nothing in it: Claude Code starts, answers control requests, and is stopped.
  const idle: AsyncIterable<never> = {
    [Symbol.asyncIterator]: () => ({ next: () => new Promise((resolve) => controller.signal.addEventListener('abort', () => resolve({ done: true, value: undefined as never }), { once: true })) })
  }
  const session = query({
    prompt: idle,
    options: {
      cwd: quietCwd(),
      pathToClaudeCodeExecutable: bin,
      env: claudeCodeEnv(cliEnv('claude', dir), clientVersion),
      persistSession: false,
      // Nothing of the user's to load for this: no settings, hooks, MCP servers or tools.
      settingSources: [],
      strictMcpConfig: true,
      tools: [],
      abortController: controller
    }
  })
  try {
    const ask = (session as unknown as { usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET?: (o: { skipBehaviors: boolean }) => Promise<unknown> })
      .usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET
    if (typeof ask !== 'function') return null
    return await Promise.race([
      ask.call(session, { skipBehaviors: true }),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error('Claude Code didn’t report its limits in time')), TIMEOUT_MS).unref?.())
    ])
  } finally {
    controller.abort()
    session.close()
  }
}

/** `claude auth status --json`: who is signed in. */
export function claudeAuthStatus(bin: string, dir: string | null): Promise<unknown> {
  return new Promise((resolve, reject) => {
    execFile(bin, ['auth', 'status', '--json'], { cwd: quietCwd(), env: cliEnv('claude', dir), timeout: TIMEOUT_MS, windowsHide: true }, (error, stdout) => {
      // Signed out exits non-zero but still prints its JSON.
      const text = String(stdout ?? '').trim()
      try {
        return resolve(JSON.parse(text.slice(text.indexOf('{'))))
      } catch {
        reject(error ?? new Error('Claude Code gave no sign-in status'))
      }
    })
  })
}

/* --------------------------------------------------------------------- Codex */

export interface CodexAnswer {
  account: unknown
  /** Null when there is nothing to read: signed out, or an API key. */
  limits: unknown | null
}

/**
 * Codex's app server, the protocol its own editor extensions use: who is
 * signed in (`account/read`, without forcing a token refresh), then — for a
 * ChatGPT sign-in — `account/rateLimits/read`.
 */
export function codexRead(bin: string, dir: string | null): Promise<CodexAnswer> {
  let account: unknown = null
  return converse<CodexAnswer>(
    bin,
    ['app-server'],
    cliEnv('codex', dir),
    (send) => send({ id: 1, method: 'initialize', params: { clientInfo: CLIENT, capabilities: { experimentalApi: true } } }),
    (message, send) => {
      if (message.id === 1) {
        if (message.error) throw new Error(errorText(message.error) || 'Codex would not start')
        send({ method: 'initialized' })
        send({ id: 2, method: 'account/read', params: { refreshToken: false } })
        return undefined
      }
      if (message.id === 2) {
        if (message.error) throw new Error(errorText(message.error) || 'Codex could not read the account')
        account = message.result ?? null
        const type = (account as { account?: { type?: string } } | null)?.account?.type
        if (type !== 'chatgpt') return { account, limits: null }
        send({ id: 3, method: 'account/rateLimits/read' })
        return undefined
      }
      if (message.id === 3) {
        if (message.error) throw new Error(errorText(message.error) || 'Codex could not read usage')
        return { account, limits: message.result ?? null }
      }
      return undefined
    }
  )
}

function errorText(error: unknown): string {
  const e = error as { message?: unknown } | null
  return typeof e?.message === 'string' ? e.message : ''
}

/** The command that signs a folder in, run in a terminal so the CLI can ask what it needs. */
export function loginArgs(tool: CliTool): string[] {
  return tool === 'claude' ? ['auth', 'login'] : ['login']
}

/** And the one that signs it out, before Eaon forgets the folder. */
export function logoutArgs(tool: CliTool): string[] {
  return tool === 'claude' ? ['auth', 'logout'] : ['logout']
}
