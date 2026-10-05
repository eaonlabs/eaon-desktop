import { createWriteStream, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { format } from 'node:util'
import { BusNode } from '../bus/bus'
import { registerPeerTools } from '../bus/peerTools'
import { ChatController } from '../core/chat'
import { chatStore } from '../core/chats'
import { firstRunImportState } from '../core/desktop'
import { invalidateModels } from '../core/models'
import { boot, shutdown } from '../runtime/boot'
import { setNotificationHook } from '../runtime/electron'
import { engineRole, joinEngines, leaveEngines } from '../runtime/engines'
import { events } from '../runtime/ipc'
import { cliHome } from '../runtime/paths'
import { App, type Mode } from './app'
import { openHelp, openImport } from './panels'
import { watchForUpdates } from './update'
import type { SlashContext } from './slash'
import { Screen } from './screen'
import { styleKey, type Style } from './term'
import { C } from './theme'
import { ChatView } from './views/chat'
import { ClaudeView } from './views/claude'
import { TradingView, type Page } from './views/trading/index'
import { WorkersView } from './views/workers'
import { redactSecrets } from '@main/redact'

/**
 * Starts the full-screen CLI: the main-process runtime, this session on
 * the bus, the engines (owned or shared), and the three tabs.
 *
 * Everything the app's modules print goes to a log file while the screen
 * is up — a stray `console.error` from a provider would otherwise land in
 * the middle of the picture.
 */

export interface TuiOptions {
  mode?: Mode
  page?: Page
  mouse?: boolean
  /** Render one frame to a file or stdout and exit, instead of running. */
  snapshot?: { width: number; height: number; html?: string; waitMs: number; keys?: string[] }
}

function captureConsole(): () => void {
  const dir = join(cliHome(), 'logs')
  mkdirSync(dir, { recursive: true })
  // Readable by the user only, and with keys blanked: everything any feature prints lands here.
  const stream = createWriteStream(join(dir, 'cli.log'), { flags: 'a', mode: 0o600 })
  const original = { log: console.log, info: console.info, warn: console.warn, error: console.error, debug: console.debug }
  const write =
    (level: string) =>
    (...args: unknown[]): void => {
      stream.write(`${new Date().toISOString()} ${level} ${redactSecrets(format(...args))}\n`)
    }
  console.log = write('log')
  console.info = write('info')
  console.warn = write('warn')
  console.error = write('error')
  console.debug = write('debug')
  return () => {
    Object.assign(console, original)
    stream.end()
  }
}

export async function runTui(options: TuiOptions = {}): Promise<number> {
  const snapshot = options.snapshot
  const restoreConsole = captureConsole()
  let bus: BusNode | null = null
  let app: App | null = null
  const restoreTerminal = (): void => {
    if (!snapshot) process.stdout.write('\x1b[?1002l\x1b[?1000l\x1b[?1006l\x1b[?2004l\x1b[0m\x1b[?25h\x1b[?1049l')
  }
  const crash = (error: unknown): void => {
    restoreTerminal()
    restoreConsole()
    bus?.closeSync()
    leaveEngines()
    console.error('eaon stopped because of an error:', error)
    console.error(`More in ${join(cliHome(), 'logs', 'cli.log')}`)
    process.exit(1)
  }
  process.on('uncaughtException', crash)
  process.on('unhandledRejection', (reason) => console.error('[unhandled]', reason))

  await boot({ engines: false })
  bus = await new BusNode({ kind: 'eaon', cwd: process.cwd(), mode: options.mode ?? 'chat' }).open()
  process.on('exit', () => {
    bus?.closeSync()
    leaveEngines()
  })
  await joinEngines(bus)
  registerPeerTools(bus)
  events.on('providers:changed', invalidateModels)

  const chat = new ChatController(bus)
  app = new App({ chat, bus, role: engineRole })
  const slash: SlashContext = { app, chat, bus, view: { showThinking: false, verbose: false } }
  const chatView = new ChatView(app, chat, slash)
  // /thinking and /verbose switch the chat view's own display.
  slash.view = chatView
  const trading = new TradingView(app, chat, slash)
  const claude = new ClaudeView(app)
  app.views = { chat: chatView, workers: new WorkersView(app), trading, claude }
  if (options.page) trading.setPage(options.page)
  app.showHelp = () => openHelp(app!)
  app.mouse = options.mouse ?? true
  setNotificationHook((title, body) => app?.toast(body ? `${title}: ${body}` : title))
  events.on('engines:role', (role: string) => app?.toast(role === 'owner' ? 'This session now runs the workers and trading engines' : 'Using the engines of another session', 'info', 3000))
  chat.on('peer', (message: { from: { name: string }; text: string; replyTo?: string }) => {
    if (!message.replyTo) app?.toast(`✉ ${message.from.name}: ${message.text.slice(0, 80)}`, 'info', 6000)
  })

  const finish = async (): Promise<void> => {
    claude.stop()
    leaveEngines()
    await bus?.close()
    await chatStore.flush()
    await shutdown()
  }

  if (snapshot) {
    app.headless = true
    app.mode = options.mode ?? 'chat'
    app.view.enter?.()
    // One unseen frame first, so the screen asks for what it shows (quotes, threads).
    Screen.snapshot(snapshot.width, snapshot.height, (c) => app!.draw(c))
    await new Promise((r) => setTimeout(r, snapshot.waitMs / 2))
    Screen.snapshot(snapshot.width, snapshot.height, (c) => app!.draw(c))
    await new Promise((r) => setTimeout(r, snapshot.waitMs / 2))
    const { parseInput } = await import('./input')
    for (const keys of snapshot.keys ?? []) {
      const unescaped = keys
        .replace(/\\x([0-9a-fA-F]{2})/g, (_, hex: string) => String.fromCharCode(parseInt(hex, 16)))
        .replace(/\\e/g, '\x1b')
        .replace(/\\r/g, '\r')
        .replace(/\\t/g, '\t')
        .replace(/\\n/g, '\n')
      for (const event of parseInput(unescaped).events) app.handle(event)
      await new Promise((r) => setTimeout(r, 400))
    }
    if (snapshot.keys?.length) {
      Screen.snapshot(snapshot.width, snapshot.height, (c) => app!.draw(c))
      await new Promise((r) => setTimeout(r, snapshot.waitMs / 2))
    }
    const frame = Screen.snapshot(snapshot.width, snapshot.height, (c) => app!.draw(c))
    if (snapshot.html) writeFileSync(snapshot.html, toHtml(frame, snapshot.width, snapshot.height))
    else process.stdout.write(frame.text + '\n')
    app.view.leave?.()
    await finish()
    restoreConsole()
    return 0
  }

  app.onQuit = finish
  for (const signal of ['SIGTERM', 'SIGHUP'] as const) process.on(signal, () => void app?.quit())
  app.start(options.mode ?? 'chat')
  if (firstRunImportState() === 'ask') openImport(app, true)
  watchForUpdates(app)
  await app.done
  restoreConsole()
  return 0
}

/** A frame as an HTML page: a monospace grid with the frame's colours, for checking layouts by eye. */
function toHtml(frame: { grid: { chars: string[]; styles: (Style | undefined)[] } }, width: number, height: number): string {
  const esc = (t: string): string => t.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  const rows: string[] = []
  for (let y = 0; y < height; y++) {
    let row = ''
    let run = ''
    let runKey = '\u0000'
    let runStyle: Style | undefined
    const flush = (): void => {
      if (!run) return
      const s = runStyle
      const css = [
        `color:${s?.inverse ? (s?.bg ?? '#000') : (s?.fg ?? '#d0d0d0')}`,
        s?.bg || s?.inverse ? `background:${s?.inverse ? (s?.fg ?? '#d0d0d0') : s?.bg}` : '',
        s?.bold ? 'font-weight:700' : '',
        s?.dim ? 'opacity:.6' : '',
        s?.italic ? 'font-style:italic' : '',
        s?.underline ? 'text-decoration:underline' : ''
      ]
        .filter(Boolean)
        .join(';')
      row += `<span style="${css}">${esc(run)}</span>`
      run = ''
    }
    for (let x = 0; x < width; x++) {
      const ch = frame.grid.chars[y * width + x]
      if (ch === '') continue
      const style = frame.grid.styles[y * width + x]
      const key = styleKey(style)
      if (key !== runKey) {
        flush()
        runKey = key
        runStyle = style
      }
      // Fallback fonts draw braille and symbols wider than a cell; pin non-ASCII to its cells.
      if (ch.charCodeAt(0) > 0x7e) {
        flush()
        runKey = '\u0000'
        const cells = frame.grid.chars[y * width + x + 1] === '' ? 2 : 1
        const s = style
        const css = [`color:${s?.fg ?? '#d0d0d0'}`, s?.bg ? `background:${s.bg}` : '', s?.bold ? 'font-weight:700' : '', 'display:inline-block', `width:${cells}ch`, 'overflow:hidden', 'vertical-align:top'].filter(Boolean).join(';')
        row += `<span style="${css}">${esc(ch)}</span>`
        continue
      }
      run += ch
    }
    flush()
    rows.push(row)
  }
  return `<!doctype html><meta charset="utf-8"><body style="margin:0;background:#000"><pre style="margin:0;padding:8px;font:13px/16px 'SF Mono',Menlo,monospace;color:${C.text};background:#000">${rows.join('\n')}</pre>`
}
