import fs from 'node:fs'
import { createRequire } from 'node:module'
import os from 'node:os'
import path from 'node:path'
import { app } from 'electron'
import type * as NodePty from 'node-pty'
import type { TerminalSpawnRequest, TerminalSpawnResult } from '@shared/terminals'

/**
 * Owns every pseudo-terminal behind the ADE's terminal view. Ported from Eaon
 * ADE's pty-manager (the standalone app), minus SSH, accounts and brain
 * provisioning.
 *
 * Shells live here, not in the renderer, so they outlive it: switching the ADE
 * back to its agent view, changing folder, a renderer reload — none of them
 * may end an agent that is mid-task.
 *
 * Nothing thrown inside a node-pty callback may escape. node-pty delivers reads
 * on a thread-safe function, and an exception there becomes a C++ throw with no
 * JS scope to catch it, which aborts the whole process. Every callback body is
 * wrapped for that reason.
 */

/**
 * Variables that describe whatever launched Eaon rather than the terminal we
 * are about to open. A shell started from Finder never sees these, so neither
 * should ours — a CLI agent that inherits another agent's session markers
 * thinks it is a child session and quietly degrades itself. The login shell
 * re-sources the user's profile, so anything they set themselves comes back.
 */
const DROP_PREFIXES = ['npm_', 'ELECTRON_', 'VITE_', 'CLAUDE_CODE_', 'VSCODE_', 'CURSOR_', 'ZELLIJ']
const DROP_EXACT = new Set([
  // Eaon started from a terminal inside tmux or screen: a pane is not inside
  // that multiplexer, and an agent that thinks so wraps its output for it.
  'TMUX',
  'TMUX_PANE',
  'STY',
  'KITTY_WINDOW_ID',
  'WEZTERM_PANE',
  'WT_SESSION',
  'ALACRITTY_WINDOW_ID',
  'CLAUDECODE',
  'CLAUDE_PID',
  'CLAUDE_EFFORT',
  'AI_AGENT',
  'INIT_CWD',
  'NODE_ENV',
  'NODE_OPTIONS',
  'TERM_PROGRAM',
  'TERM_PROGRAM_VERSION',
  'TERM_SESSION_ID',
  'ITERM_SESSION_ID',
  'ITERM_PROFILE',
  'COLORFGBG'
])

/** The variables a fresh terminal window would inherit from `source`: what launched Eaon left out. */
export function launcherEnv(source: NodeJS.ProcessEnv): Record<string, string> {
  const env: Record<string, string> = {}
  for (const [key, value] of Object.entries(source)) {
    if (value === undefined || DROP_EXACT.has(key)) continue
    if (DROP_PREFIXES.some((prefix) => key.startsWith(prefix))) continue
    env[key] = value
  }
  return env
}

interface Session {
  proc: NodePty.IPty
  buffer: string[]
  buffered: number
  timer: NodeJS.Timeout | null
  alive: boolean
  /** Command waiting for the shell to print its prompt. */
  pendingCommand: string | null
  commandTimer: NodeJS.Timeout | null
  /** When the launch command was typed, for `settling`. */
  typedAt: number
  sawOutput: boolean
  /** Unique per spawn, so a restarted pane never settles the old one's wait. */
  token: number
  pid: number
  /** The folder the pane belongs to, as asked for — a reattach must match it. */
  folder: string
  /** Recent output, replayed to a renderer that reattaches after a reload. */
  history: string[]
  historyLen: number
}

type Sender = (channel: string, payload: unknown) => void

/** How a pane brought back from the last run starts instead of how it was asked to. */
export interface RestorePlan {
  /** Where its shell starts: the folder it was last in. */
  cwd: string
  /** What is typed into it: the agent resumed, the program reopened, or nothing. */
  command: string | null
  /** What it showed last time, drawn before the shell starts. */
  screen: string | null
}

/** How long after its launch command is typed a pane counts as still starting. */
const SETTLE_MS = 8000

/**
 * Loaded on first use: a native module that fails to load must cost the
 * terminal view, not the whole app. The main bundle is an ES module, so this
 * goes through createRequire — node-pty is CommonJS.
 */
let ptyModule: typeof NodePty | null = null
function loadPty(): typeof NodePty {
  if (!ptyModule) ptyModule = createRequire(import.meta.url)('node-pty') as typeof NodePty
  return ptyModule
}

function isDir(dir: string): boolean {
  try {
    return fs.statSync(dir).isDirectory()
  } catch {
    return false
  }
}

/** Shells that exist to refuse a login; a passwd entry can name one. */
const NON_INTERACTIVE = new Set(['nologin', 'false', 'sync', 'shutdown', 'halt'])

function usable(candidate: string | null | undefined): candidate is string {
  if (!candidate || NON_INTERACTIVE.has(path.basename(candidate))) return false
  try {
    return fs.existsSync(candidate)
  } catch {
    return false
  }
}

/** The user's login shell: $SHELL, then the passwd entry, then the usual suspects. */
export function loginShell(): string {
  if (process.platform === 'win32') {
    const pwsh = path.join(process.env.ProgramFiles || 'C:\\Program Files', 'PowerShell', '7', 'pwsh.exe')
    const legacy = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
    for (const candidate of [pwsh, legacy]) if (usable(candidate)) return candidate
    return process.env.COMSPEC || 'powershell.exe'
  }
  if (usable(process.env.SHELL)) return process.env.SHELL as string
  try {
    const fromPasswd = os.userInfo().shell
    if (usable(fromPasswd)) return fromPasswd as string
  } catch {
    /* no passwd entry (some containers); fall through */
  }
  for (const candidate of ['/bin/zsh', '/bin/bash', '/usr/bin/bash', '/bin/sh']) if (usable(candidate)) return candidate
  return '/bin/sh'
}

/** `-l` for shells known to take it: a login shell sources the profile, which is where `claude` gets onto PATH. */
function shellArgs(shell: string): string[] {
  if (process.platform === 'win32') return /(pwsh|powershell)\.exe$/i.test(shell) ? ['-NoLogo'] : []
  return ['bash', 'zsh', 'fish', 'sh', 'dash', 'ksh'].includes(path.basename(shell).toLowerCase()) ? ['-l'] : []
}

export class PtyManager {
  private sessions = new Map<string, Session>()
  private readonly flushMs = 12
  /** Most one shell may queue between flushes; past it the oldest bytes go — a terminal only shows the tail. */
  private readonly maxBuffered = 256 * 1024
  /** How much output each shell remembers for a reattaching renderer. */
  private readonly maxHistory = 512 * 1024
  private send: Sender = () => {}
  private muted = false
  private nextToken = 1
  private reaping = new Map<number, () => void>()

  constructor(private readonly settleMs = SETTLE_MS) {}

  setSender(sender: Sender): void {
    this.send = sender
    this.muted = false
  }

  private emit(channel: string, payload: unknown): void {
    if (this.muted) return
    try {
      this.send(channel, payload)
    } catch {
      /* the window went away between the check and the send */
    }
  }

  private settle(token: number): void {
    const done = this.reaping.get(token)
    if (!done) return
    this.reaping.delete(token)
    done()
  }

  /** The environment a freshly opened terminal window would have. */
  private buildEnv(paneId: string, extra: Record<string, string> = {}): Record<string, string> {
    const env = launcherEnv(process.env)
    env.TERM = 'xterm-256color'
    env.COLORTERM = 'truecolor'
    env.TERM_PROGRAM = 'EaonADE'
    env.TERM_PROGRAM_VERSION = app.getVersion()
    env.EAON_PANE = paneId
    Object.assign(env, extra)
    // Launched from the Dock there is no locale, and every box-drawing
    // character in a CLI's UI turns to mojibake without one.
    if (process.platform !== 'win32' && !env.LC_ALL && !env.LC_CTYPE && !env.LANG) env.LANG = 'en_US.UTF-8'
    return env
  }

  spawn(req: TerminalSpawnRequest, extraEnv: Record<string, string> = {}, restore: RestorePlan | null = null): TerminalSpawnResult {
    const folder = req.cwd && fs.existsSync(req.cwd) ? req.cwd : os.homedir()
    const cwd = restore?.cwd && isDir(restore.cwd) ? restore.cwd : folder
    const command = restore ? restore.command : req.command

    // A pane asking for the shell it already has gets the one it has — a
    // renderer reload must not kill a healthy agent mid-task. Only when the
    // folder matches; restart() and close kill theirs first.
    const existing = this.sessions.get(req.paneId)
    if (existing?.alive && existing.folder === folder) {
      try {
        existing.proc.resize(Math.max(20, req.cols || 80), Math.max(5, req.rows || 24))
      } catch {
        /* died between the check and the resize */
      }
      return { ok: true, reattached: true, replay: existing.history.join('') }
    }
    this.kill(req.paneId)

    const shell = loginShell()
    try {
      const pty = loadPty()
      const proc = pty.spawn(shell, shellArgs(shell), {
        name: 'xterm-256color',
        cols: Math.max(20, req.cols || 80),
        rows: Math.max(5, req.rows || 24),
        cwd,
        env: this.buildEnv(req.paneId, extraEnv)
      })
      const session: Session = {
        proc,
        buffer: [],
        buffered: 0,
        timer: null,
        alive: true,
        pendingCommand: command?.trim() || null,
        commandTimer: null,
        typedAt: 0,
        sawOutput: false,
        token: this.nextToken++,
        pid: proc.pid,
        folder,
        history: [],
        historyLen: 0
      }
      this.sessions.set(req.paneId, session)
      // What a restored pane showed last time is part of its history now: a
      // window reload draws it again, and the next quit keeps it.
      if (restore?.screen) {
        session.history.push(restore.screen)
        session.historyLen += restore.screen.length
      }

      proc.onData((chunk) => {
        try {
          // Type the launch command once the shell has printed something; a
          // dozen shells starting at once makes fixed delays unsafe.
          if (session.pendingCommand && !session.sawOutput) {
            session.sawOutput = true
            this.scheduleCommand(session, 400)
          }
          session.buffer.push(chunk)
          session.buffered += chunk.length
          while (session.buffered > this.maxBuffered && session.buffer.length > 1) {
            session.buffered -= session.buffer.shift()!.length
          }
          if (session.timer) return
          session.timer = setTimeout(() => {
            session.timer = null
            const data = session.buffer.join('')
            session.buffer.length = 0
            session.buffered = 0
            if (!data) return
            session.history.push(data)
            session.historyLen += data.length
            while (session.historyLen > this.maxHistory && session.history.length > 1) {
              session.historyLen -= session.history.shift()!.length
            }
            this.emit('terminal:data', { paneId: req.paneId, data })
          }, this.flushMs)
        } catch {
          /* never let this reach node-pty's thread-safe function */
        }
      })

      proc.onExit(({ exitCode, signal }) => {
        try {
          // kill() clears `alive` before signalling, so still-alive here means
          // nothing in the app asked: the shell exited on its own.
          const requested = !session.alive
          session.alive = false
          if (session.timer) clearTimeout(session.timer)
          if (session.commandTimer) clearTimeout(session.commandTimer)
          session.timer = session.commandTimer = null
          const tail = session.buffer.join('')
          session.buffer.length = 0
          session.buffered = 0
          if (tail) this.emit('terminal:data', { paneId: req.paneId, data: tail })
          this.emit('terminal:exit', { paneId: req.paneId, exitCode, signal, requested })
        } catch {
          /* never let this reach node-pty's thread-safe function */
        } finally {
          if (this.sessions.get(req.paneId)?.token === session.token) this.sessions.delete(req.paneId)
          this.settle(session.token)
        }
      })

      // For shells that print nothing before their prompt.
      if (session.pendingCommand) this.scheduleCommand(session, 2500)
      return restore?.screen ? { ok: true, restored: restore.screen } : { ok: true }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      console.error(`[terminals] spawn failed for ${req.paneId} in ${cwd}:`, message)
      return { ok: false, error: message }
    }
  }

  private scheduleCommand(session: Session, delay: number): void {
    if (session.commandTimer) clearTimeout(session.commandTimer)
    session.commandTimer = setTimeout(() => {
      session.commandTimer = null
      const line = session.pendingCommand
      if (!line || !session.alive) return
      session.pendingCommand = null
      session.typedAt = Date.now()
      try {
        session.proc.write(`${line}\r`)
      } catch {
        /* exited before it could be driven */
      }
    }, delay)
  }

  write(paneId: string, data: string): void {
    const s = this.sessions.get(paneId)
    if (!s?.alive) return
    try {
      s.proc.write(data)
    } catch {
      /* exited between the check and the write */
    }
  }

  resize(paneId: string, cols: number, rows: number): void {
    const s = this.sessions.get(paneId)
    if (!s?.alive) return
    try {
      s.proc.resize(Math.max(20, Math.floor(cols)), Math.max(5, Math.floor(rows)))
    } catch {
      /* exited between the check and the resize */
    }
  }

  kill(paneId: string): void {
    const s = this.sessions.get(paneId)
    if (!s) return
    s.alive = false
    if (s.timer) clearTimeout(s.timer)
    if (s.commandTimer) clearTimeout(s.commandTimer)
    s.buffer.length = 0
    try {
      s.proc.kill()
    } catch {
      /* already gone */
    }
    this.sessions.delete(paneId)
  }

  has(paneId: string): boolean {
    return this.sessions.get(paneId)?.alive === true
  }

  /** Each live pane's shell pid. */
  pids(): Map<string, number> {
    const out = new Map<string, number>()
    for (const [paneId, s] of this.sessions) if (s.alive && s.pid) out.set(paneId, s.pid)
    return out
  }

  /** True while a pane is still starting what it was launched with: its command not yet typed, or only just. */
  settling(paneId: string): boolean {
    const s = this.sessions.get(paneId)
    if (!s?.alive) return false
    return s.pendingCommand !== null || (s.typedAt > 0 && Date.now() - s.typedAt < this.settleMs)
  }

  /** What a pane has printed, as far back as it is remembered — including what is still waiting to be sent. */
  historyOf(paneId: string): string {
    const s = this.sessions.get(paneId)
    return s ? s.history.join('') + s.buffer.join('') : ''
  }

  /**
   * Ends every shell and waits for the kernel to reap them. The difference
   * between quitting and aborting: node-pty reports each exit through a
   * thread-safe function, and one that lands after V8 has begun tearing down
   * cannot be delivered — std::terminate, then SIGABRT. Waiting here means
   * those callbacks run while the environment is still whole. Anything still
   * standing after `graceMs` gets SIGKILL.
   */
  async shutdown(timeoutMs = 2000, graceMs = 600): Promise<void> {
    this.muted = true
    const doomed = [...this.sessions.values()].map((s) => ({ token: s.token, pid: s.pid }))
    if (!doomed.length) return
    const reaped = doomed.map(({ token }) => new Promise<void>((resolve) => this.reaping.set(token, resolve)))
    const outstanding = (): boolean => doomed.some((d) => this.reaping.has(d.token))
    for (const id of [...this.sessions.keys()]) this.kill(id)
    const wait = (ms: number): Promise<void> => new Promise<void>((resolve) => setTimeout(resolve, ms).unref())
    await Promise.race([Promise.all(reaped).then(() => undefined), wait(graceMs)])
    if (outstanding()) {
      for (const { token, pid } of doomed) {
        if (!this.reaping.has(token) || !pid) continue
        try {
          process.kill(pid, 'SIGKILL')
        } catch {
          /* already gone */
        }
      }
      await Promise.race([Promise.all(reaped).then(() => undefined), wait(timeoutMs - graceMs)])
    }
    this.reaping.clear()
  }
}
