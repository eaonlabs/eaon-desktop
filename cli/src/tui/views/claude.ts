import { existsSync, mkdirSync, realpathSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { homedir } from 'node:os'
import { delimiter, join } from 'node:path'
import type { TradingSnapshot } from '@shared/trading'
import { CLI_PACKAGE } from '../../core/version'
import { nextOpen } from '@main/features/trading/marketHours'
import { workFolderOf } from '../../core/chat'
import { events, hasHandler, invoke } from '../../runtime/ipc'
import { cliHome } from '../../runtime/paths'
import type { App, StatusSegment, View } from '../app'
import { setRawInput, type InputEvent } from '../input'
import type { Canvas } from '../screen'
import type { Style } from '../term'
import { C, S } from '../theme'
import { keyHints } from '../widgets'

/**
 * Claude Code, inside Eaon: the user's own, unmodified `claude`, running in
 * a terminal pane on a screen of its own. It isn't one of the tabs: `/claude`
 * opens it, and Esc goes back to the tab it was opened from while it keeps
 * running. The user types to it and signs in with its own /login, exactly
 * as in any terminal; Eaon only shows its screen. Eaon
 * never sends it prompts or reads its answers (see the brain note on the
 * removed Claude Code provider: hosting the real binary is the allowed way).
 *
 * What makes it part of Eaon is the MCP server it is started with —
 * `eaon mcp --control` — which gives it Eaon's tools: the session bus, the
 * trading desk with full control (orders, sessions, limits, the kill
 * switch), and the workers. Its own permission prompts still ask before it
 * uses them.
 *
 * While the pane has the keyboard every key goes to Claude Code untouched
 * (Esc, Tab, ⌃C included); ⌃] gives it back to Eaon. The wheel scrolls its
 * history.
 */

const require_ = createRequire(import.meta.url)
const RELEASE = '\x1d' // ⌃]
const SYSTEM_NOTE = [
  'You are running inside Eaon, a terminal app for chat, workers and agentic stock trading. The `eaon` MCP server is Eaon itself.',
  'Through its tools you can read and fully operate Eaon: the trading desk (eaon_trading for the account, positions, orders and the agent’s session; eaon_order, eaon_cancel, eaon_close_position and eaon_set_exit for trades; eaon_session to start, stop, check now or talk to the trading agent; eaon_limits, eaon_broker and eaon_kill_switch for its settings), the workers (eaon_workers, eaon_worker_message), and the other sessions on this computer (eaon_sessions, eaon_send, eaon_inbox).',
  'Every order passes the user’s trading limits and the kill switch inside Eaon. Trading only starts after the user has accepted Eaon’s trading disclaimer in the app; you can’t accept it for them. Real-money orders are refused unless the user has allowed them for Claude Code in Eaon.',
  'Treat real money with care: say what you are about to do before placing or changing anything that trades.'
].join(' ')

type Pty = { write(data: string): void; resize(cols: number, rows: number): void; kill(): void; onData(fn: (d: string) => void): void; onExit(fn: (e: { exitCode: number }) => void): void }
type Term = {
  cols: number
  rows: number
  write(data: string): void
  resize(cols: number, rows: number): void
  scrollLines(n: number): void
  scrollToBottom(): void
  buffer: { active: { viewportY: number; baseY: number; getLine(y: number): { getCell(x: number, cell?: unknown): XCell | undefined } | undefined; getNullCell(): XCell } }
}
type XCell = {
  getChars(): string
  getWidth(): number
  getFgColor(): number
  getBgColor(): number
  isFgRGB(): boolean
  isBgRGB(): boolean
  isFgDefault(): boolean
  isBgDefault(): boolean
  isBold(): number
  isItalic(): number
  isDim(): number
  isUnderline(): number
  isInverse(): number
}

/** The xterm 256-colour palette. */
const PALETTE = (() => {
  const base = ['#000000', '#cd3131', '#0dbc79', '#e5e510', '#2472c8', '#bc3fbc', '#11a8cd', '#e5e5e5', '#666666', '#f14c4c', '#23d18b', '#f5f543', '#3b8eea', '#d670d6', '#29b8db', '#ffffff']
  const out = [...base]
  const steps = [0, 95, 135, 175, 215, 255]
  for (let r = 0; r < 6; r++) for (let g = 0; g < 6; g++) for (let b = 0; b < 6; b++) out.push(`#${[steps[r], steps[g], steps[b]].map((v) => v.toString(16).padStart(2, '0')).join('')}`)
  for (let i = 0; i < 24; i++) {
    const v = (8 + i * 10).toString(16).padStart(2, '0')
    out.push(`#${v}${v}${v}`)
  }
  return out
})()

function onPath(bin: string): string | null {
  const names = process.platform === 'win32' ? [`${bin}.cmd`, `${bin}.exe`, bin] : [bin]
  for (const dir of (process.env.PATH ?? '').split(delimiter)) for (const name of names) if (dir && existsSync(join(dir, name))) return join(dir, name)
  // Claude Code's own installer puts it here.
  for (const candidate of [join(homedir(), '.claude', 'local', 'claude'), join(homedir(), '.local', 'bin', 'claude')]) if (existsSync(candidate)) return candidate
  return null
}

/** The `eaon` command that started this process, for Claude Code to start `eaon mcp` with. */
function eaonEntry(): string {
  try {
    return realpathSync(process.argv[1])
  } catch {
    return process.argv[1]
  }
}

/** Writes the MCP config Claude Code is started with: Eaon's server, with full control. */
function mcpConfigFile(): string {
  const dir = join(cliHome(), 'claude-code')
  mkdirSync(dir, { recursive: true })
  const file = join(dir, 'mcp.json')
  writeFileSync(
    file,
    JSON.stringify(
      { mcpServers: { eaon: { type: 'stdio', command: process.execPath, args: [eaonEntry(), 'mcp', '--control'], env: { EAON_CLI_HOME: cliHome() } } } },
      null,
      2
    )
  )
  return file
}

export class ClaudeView implements View {
  private pty: Pty | null = null
  private term: Term | null = null
  private focused = false
  private visible = false
  private exited: number | null = null
  private problem: string | null = null
  private size = { cols: 0, rows: 0 }
  private pendingDraw = false
  /** The trading desk, for the banner when a session is waiting for Claude Code. */
  private trading: TradingSnapshot | null = null

  constructor(private readonly app: App) {
    events.on('trading:changed', (snapshot: TradingSnapshot) => {
      this.trading = snapshot
      if (this.visible) this.app.invalidate()
    })
  }

  enter(): void {
    this.visible = true
    if (hasHandler('trading:snapshot'))
      void invoke<TradingSnapshot>('trading:snapshot')
        .then((snapshot) => ((this.trading = snapshot), this.app.invalidate()))
        .catch(() => {})
    // Opening it hands the keyboard to Claude Code, as opening a terminal would.
    if (this.pty && this.exited === null) this.focus(true)
  }

  leave(): void {
    this.visible = false
    this.focus(false)
  }

  typing(): boolean {
    return this.focused
  }

  /** Whether a session is running. */
  running(): boolean {
    return this.pty !== null && this.exited === null
  }

  private focus(on: boolean): void {
    this.focused = on
    setRawInput(on ? (chunk) => this.raw(chunk) : null)
    this.app.invalidate()
  }

  /** Keys while Claude Code has the keyboard: everything to it, except ⌃] and the mouse. */
  private raw(chunk: string): boolean {
    // The mouse belongs to Eaon: the wheel scrolls the pane's history; clicks do nothing in it.
    let data = chunk.replace(/\x1b\[<(\d+);\d+;\d+[Mm]/g, (_all, button: string) => {
      const b = Number(button)
      if (b & 64) {
        this.term?.scrollLines(b & 1 ? 3 : -3)
        this.app.invalidate()
      }
      return ''
    })
    const release = data.indexOf(RELEASE)
    if (release !== -1) {
      if (release > 0) this.pty?.write(data.slice(0, release))
      this.focus(false)
      this.app.toast('Back to Eaon — ⏎ returns to Claude Code, esc leaves it', 'info', 2500)
      return true
    }
    if (data) {
      this.term?.scrollToBottom()
      this.pty?.write(data)
    }
    return true
  }

  private start(cols: number, rows: number): void {
    this.problem = null
    this.exited = null
    const claude = onPath('claude')
    if (!claude) {
      this.problem = 'Claude Code isn’t installed. Install it (npm install -g @anthropic-ai/claude-code, or see claude.com/claude-code), then press ⏎ here.'
      return
    }
    let pty: { spawn: (file: string, args: string[], options: Record<string, unknown>) => Pty }
    let Terminal: new (options: Record<string, unknown>) => Term
    try {
      pty = require_('node-pty')
      Terminal = require_('@xterm/headless').Terminal
    } catch (error) {
      this.problem = `Couldn’t load the terminal (${error instanceof Error ? error.message : String(error)}). Reinstall Eaon CLI (npm install -g ${CLI_PACKAGE}), or run npm install in the Eaon folder for a source checkout.`
      return
    }
    this.term = new Terminal({ cols, rows, scrollback: 5000, allowProposedApi: true })
    try {
      this.pty = pty.spawn(claude, ['--append-system-prompt', SYSTEM_NOTE, '--mcp-config', mcpConfigFile()], {
        name: 'xterm-256color',
        cols,
        rows,
        cwd: workFolderOf(),
        // eaon_wait_for_check waits up to four hours (the next check, or overnight the next open).
        env: { ...process.env, TERM: 'xterm-256color', COLORTERM: 'truecolor', EAON_CLI_HOME: cliHome(), MCP_TOOL_TIMEOUT: process.env.MCP_TOOL_TIMEOUT ?? String(5 * 3_600_000) }
      })
    } catch (error) {
      this.problem = `Couldn’t start Claude Code: ${error instanceof Error ? error.message : String(error)}`
      this.term = null
      return
    }
    this.size = { cols, rows }
    this.pty.onData((data) => {
      this.term?.write(data)
      // Many small writes arrive at once; draw once they settle.
      if (!this.pendingDraw) {
        this.pendingDraw = true
        setTimeout(() => {
          this.pendingDraw = false
          if (this.visible) this.app.invalidate()
        }, 16)
      }
    })
    this.pty.onExit(({ exitCode }) => {
      this.exited = exitCode
      this.pty = null
      if (this.focused) this.focus(false)
      this.app.invalidate()
    })
    if (this.visible) this.focus(true)
  }

  /** Ends the session (when Eaon quits). */
  stop(): void {
    try {
      this.pty?.kill()
    } catch {
      /* already gone */
    }
    this.pty = null
  }

  draw(c: Canvas): void {
    // A bar on top: what this is, and how to get in and out.
    const bar = c.sub(0, 0, c.w, 1)
    bar.fill(0, 0, c.w, 1, { bg: '#1A1A1C' })
    bar.segments(1, 0, [
      { text: ' ✻ CLAUDE CODE ', style: { fg: C.ink, bg: '#D97757', bold: true } },
      { text: '  your own Claude Code, connected to Eaon: it can read and run the trading desk, the agent and the workers', style: { fg: C.muted, bg: '#1A1A1C' } }
    ])
    const state = this.focused
      ? [['⌃]', 'back to Eaon']]
      : this.running()
        ? [['⏎', 'type to Claude Code'], ['esc', 'leave']]
        : [['⏎', 'start Claude Code'], ['esc', 'leave']]
    const hintsW = state.reduce((n, [k, l]) => n + k.length + l.length + 4, 0)
    keyHints(bar, Math.max(0, c.w - hintsW - 1), 0, state as [string, string][], hintsW, '#1A1A1C')

    // A trading session run by Claude Code: hand it over, or how it's going.
    const session = this.trading?.activeSession?.driver === 'claude-code' ? this.trading.activeSession : null
    // Between the days of an every-day mission run by Claude Code.
    const mission = session ? null : (this.trading?.schedules.find((s) => s.enabled && s.marketHours && s.driver === 'claude-code') ?? null)
    let paneTop = 1
    if (mission) {
      const held = Boolean(this.trading?.claudeWaiting)
      const opens = nextOpen(Date.now())
      const at = `${new Date(opens).toLocaleDateString('en-GB', { weekday: 'short' })} ${new Date(opens).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })}`
      const bg = held ? '#2A1A14' : C.amber
      const banner = c.sub(0, 1, c.w, 1)
      banner.fill(0, 0, c.w, 1, { bg })
      banner.segments(
        1,
        0,
        held
          ? [
              { text: ' ✻ ', style: { fg: '#D97757', bg, bold: true } },
              { text: `Holding Eaon’s mission “${mission.name}”`, style: { fg: C.text, bg, bold: true } },
              { text: ` · every market day · waiting for the open, ${at} · its steps show on the trading desk`, style: { fg: C.muted, bg } }
            ]
          : [
              { text: ' ▶ ', style: { fg: C.ink, bg, bold: true } },
              { text: `Eaon’s mission “${mission.name}” (every market day, from ${at}) is waiting for Claude Code. Type `, style: { fg: C.ink, bg } },
              { text: '/mcp__eaon__trade', style: { fg: C.ink, bg, bold: true, underline: true } },
              { text: ' below to hand it over.', style: { fg: C.ink, bg } }
            ],
        c.w - 2
      )
      paneTop = 2
    }
    if (session) {
      const agent = this.trading?.agent
      const waiting = !agent?.checking && !agent?.connected
      const banner = c.sub(0, 1, c.w, 1)
      banner.fill(0, 0, c.w, 1, { bg: waiting ? C.amber : '#2A1A14' })
      banner.segments(
        1,
        0,
        waiting
          ? [
              { text: ' ▶ ', style: { fg: C.ink, bg: C.amber, bold: true } },
              { text: `Eaon’s trading session “${session.name}” is waiting for Claude Code. Type `, style: { fg: C.ink, bg: C.amber } },
              { text: '/mcp__eaon__trade', style: { fg: C.ink, bg: C.amber, bold: true, underline: true } },
              { text: ' below to hand it over.', style: { fg: C.ink, bg: C.amber } }
            ]
          : [
              { text: ' ✻ ', style: { fg: '#D97757', bg: '#2A1A14', bold: true } },
              { text: `Running Eaon’s trading session “${session.name}”`, style: { fg: C.text, bg: '#2A1A14', bold: true } },
              {
                text: ` · ${agent?.checking ? `check ${session.checks} in progress` : `${session.checks} check${session.checks === 1 ? '' : 's'} so far`} · until ${new Date(session.endsAt).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })}${session.scheduleId && this.trading?.schedules.some((s) => s.id === session.scheduleId && s.enabled && s.marketHours) ? ', and again at every open' : ''} · its steps show on the trading desk`,
                style: { fg: C.muted, bg: '#2A1A14' }
              }
            ],
        c.w - 2
      )
      paneTop = 2
    }
    const pane = c.sub(0, paneTop, c.w, c.h - paneTop)
    const cols = Math.max(20, pane.w)
    const rows = Math.max(5, pane.h)
    if (!this.pty && !this.term && !this.problem && this.exited === null) this.start(cols, rows)
    if (this.pty && this.term && (cols !== this.size.cols || rows !== this.size.rows)) {
      this.size = { cols, rows }
      this.term.resize(cols, rows)
      this.pty.resize(cols, rows)
    }
    if (this.problem) return this.drawNote(pane, this.problem, S.yellow)
    if (this.term) this.drawTerm(pane, this.term)
    if (this.exited !== null) {
      const note = ` Claude Code ended (exit ${this.exited}). ⏎ starts a new session. `
      pane.text(Math.max(0, Math.floor((pane.w - note.length) / 2)), pane.h - 1, note, { fg: C.ink, bg: C.amber, bold: true })
    } else if (!this.focused && this.term) {
      const note = ' ⏎ to type to Claude Code '
      pane.text(pane.w - note.length - 1, pane.h - 1, note, { fg: C.ink, bg: '#D97757', bold: true })
    }
  }

  private drawNote(c: Canvas, text: string, style: Style): void {
    const lines = text.match(new RegExp(`.{1,${Math.max(20, c.w - 8)}}(\\s|$)`, 'g')) ?? [text]
    lines.forEach((line, i) => c.text(4, Math.floor(c.h / 2) - 1 + i, line.trim(), style))
  }

  /** Copies the terminal's visible cells onto the canvas, colours and all. */
  private drawTerm(c: Canvas, term: Term): void {
    const buffer = term.buffer.active
    const cell = buffer.getNullCell()
    const color = (fg: boolean): string | undefined => {
      if (fg ? cell.isFgDefault() : cell.isBgDefault()) return undefined
      const v = fg ? cell.getFgColor() : cell.getBgColor()
      if (fg ? cell.isFgRGB() : cell.isBgRGB()) return `#${v.toString(16).padStart(6, '0')}`
      return PALETTE[v]
    }
    for (let y = 0; y < Math.min(c.h, term.rows); y++) {
      const line = buffer.getLine(buffer.viewportY + y)
      if (!line) continue
      for (let x = 0; x < Math.min(c.w, term.cols); x++) {
        line.getCell(x, cell)
        const width = cell.getWidth()
        if (width === 0) continue
        let fg = color(true) ?? C.text
        let bg = color(false)
        if (cell.isInverse()) [fg, bg] = [bg ?? '#000000', fg]
        const style: Style = { fg, ...(bg ? { bg } : {}), ...(cell.isBold() ? { bold: true } : {}), ...(cell.isItalic() ? { italic: true } : {}), ...(cell.isDim() ? { dim: true } : {}), ...(cell.isUnderline() ? { underline: true } : {}) }
        c.text(x, y, cell.getChars() || ' ', style)
      }
    }
    if (buffer.viewportY < buffer.baseY) {
      const note = ` ↑ history · wheel down or type to return `
      c.text(c.w - note.length - 1, 0, note, { fg: C.ink, bg: C.amber })
    }
  }

  onEvent(event: InputEvent): boolean {
    if (event.type === 'mouse') {
      if ((event.action === 'wheelup' || event.action === 'wheeldown') && this.term) {
        this.term.scrollLines(event.action === 'wheelup' ? -3 : 3)
        return true
      }
      if (event.action === 'down' && event.y > 1 && this.running()) {
        this.focus(true)
        return true
      }
      return false
    }
    if (event.type !== 'key') return false
    // Not a tab: Esc goes back to the tab it was opened from (it keeps running).
    if (event.name === 'escape') {
      this.app.switchMode(this.app.previousMode === 'claude' ? 'chat' : this.app.previousMode)
      return true
    }
    if (event.name === 'enter') {
      if (this.exited !== null || this.problem) {
        this.term = null
        this.exited = null
        this.problem = null
        this.size = { cols: 0, rows: 0 }
        this.app.invalidate()
        return true
      }
      if (this.running()) this.focus(true)
      return true
    }
    return false
  }

  status(): StatusSegment[] {
    return [
      { text: this.running() ? '● ' : '○ ', style: { fg: this.running() ? C.green : C.muted } },
      { text: this.running() ? (this.focused ? 'Claude Code has the keyboard' : 'Claude Code running') : this.exited !== null ? 'Claude Code ended' : 'Claude Code', style: S.text },
      { text: '  ·  eaon tools: trading, agent, workers, sessions', style: S.muted }
    ]
  }

  hints(): [string, string][] {
    return this.focused ? [['⌃]', 'back to Eaon']] : [['⏎', 'type to Claude Code'], ['esc', 'leave']]
  }
}
