import { Terminal, type ITheme } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { WebLinksAddon } from '@xterm/addon-web-links'
import { WebglAddon } from '@xterm/addon-webgl'
import type { TerminalAgentId } from '@shared/terminals'

/**
 * Every xterm behind the ADE's terminal view. Ported from Eaon ADE's
 * `lib/terminals.ts`, kept to what this view needs.
 *
 * Terminals outlive React: each lives in a detached wrapper element that is
 * re-parented into whichever pane is showing it, so switching the ADE to its
 * agent view or to another folder never stops a background agent from
 * streaming, and coming back shows everything it printed meanwhile. The shell
 * itself lives in the main process (`features/terminals`).
 *
 * WebGL contexts are held only for panes on screen: a browser keeps a limited
 * number alive and silently drops the oldest, which demotes a *visible* pane to
 * the slower DOM renderer (with hairline cracks through block art).
 */

export type PaneStatus = 'starting' | 'working' | 'idle' | 'exited'

export interface Launch {
  cwd: string
  /** Typed into the shell once it is ready; null for a plain shell. */
  command: string | null
  /** What the pane runs, so main can give an agent what it needs (Eaon Code gets Eaon's keys when shared). */
  agent?: TerminalAgentId
}

interface Runtime {
  term: Terminal
  fit: FitAddon
  wrapper: HTMLDivElement
  host: HTMLElement | null
  observer: ResizeObserver | null
  webgl: WebglAddon | null
  /** No WebGL on this machine at all — stop building addons just to watch them throw. */
  gpuBlocked: boolean
  retries: number
  sentCols: number
  sentRows: number
  fitTimer: number | null
  spawned: boolean
  launch: Launch | null
  lastData: number
  /**
   * While old output is being replayed. Replayed bytes include the queries a
   * CLI asked its terminal when it started (cursor position, device
   * attributes…), and xterm answers them as if typed — into a shell that never
   * asked. Answers are dropped until the replay has been drawn.
   */
  replaying: boolean
  status: PaneStatus
  exitCode: number | null
  error: string | null
}

const IS_MAC = navigator.platform.toLowerCase().includes('mac')
/** Output within this long means something is running. */
const WORKING_MS = 1500

/* ------------------------------------------------------------------ keys */

/**
 * Who owns a keypress: the shell, the app, or this layer. The whole bug class
 * here is "two different keys send the same bytes", invisible from outside.
 */
type Verdict = { do: 'terminal' } | { do: 'app' } | { do: 'send'; data: string } | { do: 'selectAll' } | { do: 'copy' } | { do: 'paste' }

function resolveKey(e: KeyboardEvent, hasSelection: boolean): Verdict {
  if (e.type !== 'keydown') return { do: 'terminal' }
  // Shift+Enter opens a line instead of sending it. A terminal sends a bare CR
  // for both; ESC CR is what CLI agents read as "newline, don't submit".
  if (e.key === 'Enter' && e.shiftKey && !e.metaKey && !e.ctrlKey && !e.altKey) return { do: 'send', data: '\x1b\r' }

  if (!IS_MAC) {
    // One modifier on Windows/Linux, and the shell owns bare Ctrl chords (^C,
    // ^D, ^W…); the clipboard lives on Ctrl+Shift, as in every Windows terminal.
    if (e.ctrlKey && !e.altKey && !e.metaKey) {
      const key = e.key.toLowerCase()
      if (e.shiftKey && key === 'c') return { do: 'copy' }
      if (e.shiftKey && key === 'v') return { do: 'paste' }
      if (!e.shiftKey && key === 'c' && hasSelection) return { do: 'copy' }
      if (!e.shiftKey && key === 'v') return { do: 'paste' }
      if (/^[0-9,b]$/.test(key)) return { do: 'app' }
    }
    return { do: 'terminal' }
  }

  // macOS: Option is Meta. Option+arrows move by word as readline's ESC b / ESC f.
  if (e.altKey && !e.metaKey && !e.ctrlKey) {
    const word = ({ ArrowLeft: '\x1bb', ArrowRight: '\x1bf', Delete: '\x1bd' } as Record<string, string>)[e.key]
    if (word) return { do: 'send', data: word }
  }
  if (e.metaKey) {
    const key = e.key.toLowerCase()
    if (key === 'a') return { do: 'selectAll' }
    // The line editing every other Mac text field has, as readline control codes.
    const line = ({ ArrowLeft: '\x01', ArrowRight: '\x05', Backspace: '\x15', Delete: '\x0b' } as Record<string, string>)[e.key]
    if (line) return { do: 'send', data: line }
    // Copy and paste stay with xterm's own clipboard handling; every other
    // ⌘ chord (⌘1-3, ⌘B, ⌘,) belongs to the app.
    return key === 'c' || key === 'v' ? { do: 'terminal' } : { do: 'app' }
  }
  return { do: 'terminal' }
}

/* ------------------------------------------------------------------ theme */

const DARK_ANSI = {
  black: '#1f2328',
  red: '#f47067',
  green: '#57ab5a',
  yellow: '#c69026',
  blue: '#539bf5',
  magenta: '#b083f0',
  cyan: '#39c5cf',
  white: '#adbac7',
  brightBlack: '#636e7b',
  brightRed: '#ff938a',
  brightGreen: '#6bc46d',
  brightYellow: '#daaa3f',
  brightBlue: '#6cb6ff',
  brightMagenta: '#dcbdfb',
  brightCyan: '#56d4dd',
  brightWhite: '#f0f6fc'
}
const LIGHT_ANSI = {
  black: '#24292f',
  red: '#cf222e',
  green: '#116329',
  yellow: '#7d4e00',
  blue: '#0969da',
  magenta: '#8250df',
  cyan: '#1b7c83',
  white: '#6e7781',
  brightBlack: '#57606a',
  brightRed: '#a40e26',
  brightGreen: '#1a7f37',
  brightYellow: '#633c01',
  brightBlue: '#218bff',
  brightMagenta: '#a475f9',
  brightCyan: '#3192aa',
  brightWhite: '#8c959f'
}

/**
 * A CSS colour (including `color-mix()` and custom properties) as `#rrggbb`,
 * which xterm can parse. Resolved through a probe element and a 1×1 canvas,
 * because computed styles report `color(srgb …)` forms xterm does not read.
 */
function resolveColor(css: string): string {
  const probe = document.createElement('span')
  probe.style.color = css
  probe.style.display = 'none'
  document.body.appendChild(probe)
  const computed = getComputedStyle(probe).color
  probe.remove()
  const canvas = document.createElement('canvas')
  canvas.width = canvas.height = 1
  const ctx = canvas.getContext('2d', { willReadFrequently: true })
  if (!ctx) return '#000000'
  ctx.fillStyle = computed
  ctx.fillRect(0, 0, 1, 1)
  const [r, g, b] = ctx.getImageData(0, 0, 1, 1).data
  return `#${[r, g, b].map((v) => v.toString(16).padStart(2, '0')).join('')}`
}

/** The terminal palette for the app's current theme — its own background, text and accent. */
export function currentTheme(): ITheme {
  const dark = document.documentElement.dataset.theme !== 'light'
  return {
    background: resolveColor('var(--term-bg)'),
    foreground: resolveColor('var(--text)'),
    cursor: resolveColor('var(--accent)'),
    cursorAccent: resolveColor('var(--term-bg)'),
    selectionBackground: resolveColor('color-mix(in srgb, var(--accent) 35%, var(--term-bg))'),
    ...(dark ? DARK_ANSI : LIGHT_ANSI)
  }
}

/* ------------------------------------------------------------------ registry */

class TerminalRegistry {
  private panes = new Map<string, Runtime>()
  private listeners = new Set<() => void>()
  private bound = false
  private ticker: number | null = null
  private theme: ITheme | null = null
  /** Bumped whenever any pane's status changes, for useSyncExternalStore. */
  private version = 0

  private bind(): void {
    if (this.bound) return
    this.bound = true
    window.api.terminals.onData(({ paneId, data }) => {
      const rt = this.panes.get(paneId)
      if (!rt) return
      rt.term.write(data)
      rt.lastData = Date.now()
      if (rt.status !== 'working') this.setStatus(rt, 'working')
    })
    window.api.terminals.onExit(({ paneId, exitCode, requested }) => {
      const rt = this.panes.get(paneId)
      if (!rt || requested) return
      rt.exitCode = exitCode
      rt.spawned = false
      rt.term.write(`\r\n\x1b[2m[process exited${exitCode ? ` with code ${exitCode}` : ''}]\x1b[0m\r\n`)
      this.setStatus(rt, 'exited')
    })
    // Output going quiet is how a pane turns from working to idle.
    this.ticker = window.setInterval(() => {
      const now = Date.now()
      for (const rt of this.panes.values()) {
        if (rt.status === 'working' && now - rt.lastData > WORKING_MS) this.setStatus(rt, 'idle')
      }
    }, 500)
  }

  private setStatus(rt: Runtime, status: PaneStatus): void {
    rt.status = status
    this.version++
    for (const listener of this.listeners) listener()
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  getVersion = (): number => this.version

  statusOf(paneId: string): { status: PaneStatus; error: string | null; exitCode: number | null } {
    const rt = this.panes.get(paneId)
    return { status: rt?.status ?? 'starting', error: rt?.error ?? null, exitCode: rt?.exitCode ?? null }
  }

  private ensure(paneId: string): Runtime {
    const existing = this.panes.get(paneId)
    if (existing) return existing
    this.bind()
    if (!this.theme) this.theme = currentTheme()

    const wrapper = document.createElement('div')
    wrapper.className = 'term-wrapper'
    const term = new Terminal({
      allowProposedApi: true,
      allowTransparency: false,
      fontFamily: "ui-monospace, 'SF Mono', Menlo, Monaco, Consolas, monospace",
      fontSize: 12.5,
      lineHeight: 1.15,
      cursorBlink: true,
      scrollback: 10_000,
      macOptionIsMeta: true,
      // A CLI's colours are its own business; contrast "correction" rewrites them.
      minimumContrastRatio: 1,
      // Block and box-drawing characters as geometry, so solid runs meet
      // exactly (only the GPU renderer honours it).
      customGlyphs: true,
      theme: this.theme
    })
    const fit = new FitAddon()
    term.loadAddon(fit)
    try {
      term.loadAddon(new WebLinksAddon((_e, uri) => window.api.app.openExternal(uri)))
    } catch {
      /* links are a nicety */
    }
    term.open(wrapper)

    const rt: Runtime = {
      term,
      fit,
      wrapper,
      host: null,
      observer: null,
      webgl: null,
      gpuBlocked: false,
      retries: 0,
      sentCols: 0,
      sentRows: 0,
      fitTimer: null,
      spawned: false,
      launch: null,
      lastData: 0,
      replaying: false,
      status: 'starting',
      exitCode: null,
      error: null
    }

    term.onData((data) => {
      if (!rt.replaying) window.api.terminals.write(paneId, data)
    })
    term.onBinary((data) => {
      if (!rt.replaying) window.api.terminals.write(paneId, data)
    })
    term.attachCustomKeyEventHandler((e) => {
      const verdict = resolveKey(e, term.hasSelection())
      switch (verdict.do) {
        case 'send':
          e.preventDefault()
          term.input(verdict.data)
          return false
        case 'selectAll':
          e.preventDefault()
          term.selectAll()
          return false
        case 'copy': {
          e.preventDefault()
          const text = term.getSelection()
          if (text) void navigator.clipboard.writeText(text)
          return false
        }
        case 'paste':
          e.preventDefault()
          void navigator.clipboard.readText().then((text) => text && term.paste(text)).catch(() => undefined)
          return false
        case 'app':
          return false
        default:
          return true
      }
    })

    this.panes.set(paneId, rt)
    return rt
  }

  /** GPU renderer, falling back quietly to the DOM one when WebGL is gone or lost. */
  private attachRenderer(paneId: string, rt: Runtime): void {
    if (rt.gpuBlocked || rt.webgl) return
    try {
      const addon = new WebglAddon()
      addon.onContextLoss(() => {
        try {
          addon.dispose()
        } catch {
          /* already gone */
        }
        rt.webgl = null
        // A lost context nearly always means the GPU process restarted; try
        // again for a pane that is still on screen.
        if (rt.retries >= 3) return
        rt.retries += 1
        window.setTimeout(() => {
          if (this.panes.get(paneId) === rt && rt.host && !rt.webgl) this.attachRenderer(paneId, rt)
        }, 800 * rt.retries)
      })
      rt.term.loadAddon(addon)
      rt.webgl = addon
    } catch {
      rt.webgl = null
      rt.gpuBlocked = true
    }
  }

  private releaseRenderer(rt: Runtime): void {
    if (!rt.webgl) return
    try {
      rt.webgl.dispose()
    } catch {
      /* already gone */
    }
    rt.webgl = null
  }

  /** Shows a pane in `host`, starting its shell the first time. */
  attach(paneId: string, host: HTMLElement, launch: Launch): void {
    const rt = this.ensure(paneId)
    if (rt.host !== host) {
      rt.host = host
      host.appendChild(rt.wrapper)
      rt.retries = 0
      this.attachRenderer(paneId, rt)
      rt.observer?.disconnect()
      rt.observer = new ResizeObserver(() => this.scheduleFit(paneId))
      rt.observer.observe(host)
    }
    // Two frames: one for layout, one for the font metrics xterm measures.
    requestAnimationFrame(() =>
      requestAnimationFrame(() => {
        this.fit(paneId)
        if (!rt.spawned) void this.spawn(paneId, launch)
      })
    )
  }

  /** Takes a pane off screen. The terminal, its scrollback and its shell carry on. */
  detach(paneId: string, host: HTMLElement | null): void {
    const rt = this.panes.get(paneId)
    if (!rt || (host && rt.host !== host)) return
    rt.observer?.disconnect()
    rt.observer = null
    this.releaseRenderer(rt)
    rt.wrapper.remove()
    rt.host = null
  }

  private async spawn(paneId: string, launch: Launch): Promise<void> {
    const rt = this.panes.get(paneId)
    if (!rt || rt.spawned) return
    rt.spawned = true
    rt.launch = launch
    rt.exitCode = null
    rt.error = null
    const result = await window.api.terminals.spawn({
      paneId,
      cwd: launch.cwd,
      cols: rt.term.cols,
      rows: rt.term.rows,
      command: launch.command,
      ...(launch.agent ? { agent: launch.agent } : {})
    })
    if (!result.ok) {
      rt.spawned = false
      rt.error = result.error ?? 'The terminal could not start.'
      rt.term.write(`\x1b[31m${rt.error}\x1b[0m\r\n`)
      this.setStatus(rt, 'exited')
      return
    }
    // A reload lost this terminal's scrollback but not its shell: draw what
    // the shell printed so far, then nudge the size so a full-screen CLI
    // (Claude Code, Eaon Code) repaints itself for the new terminal. A pane
    // brought back from the last run draws what it showed then, before
    // anything its new shell prints.
    const old = result.reattached ? result.replay : result.restored
    if (old) this.replay(rt, old)
    if (rt.status === 'starting' || rt.status === 'exited') this.setStatus(rt, result.reattached ? 'idle' : 'working')
    rt.sentCols = rt.sentRows = 0
    if (result.reattached && rt.term.rows > 6) window.api.terminals.resize(paneId, rt.term.cols, rt.term.rows - 1)
    this.fit(paneId)
  }

  private replay(rt: Runtime, data: string): void {
    rt.replaying = true
    rt.term.write(data, () => {
      rt.replaying = false
    })
  }

  /** Ends the pane's shell and starts it again with the same launch. */
  restart(paneId: string, launch: Launch): void {
    const rt = this.panes.get(paneId)
    if (!rt) return
    window.api.terminals.kill(paneId)
    rt.spawned = false
    rt.term.reset()
    void this.spawn(paneId, launch)
  }

  clear(paneId: string): void {
    this.panes.get(paneId)?.term.clear()
  }

  focus(paneId: string): void {
    this.panes.get(paneId)?.term.focus()
  }

  /** Closes a pane for good: the shell, the terminal and its history. */
  dispose(paneId: string): void {
    const rt = this.panes.get(paneId)
    window.api.terminals.kill(paneId)
    if (!rt) return
    this.detach(paneId, null)
    try {
      rt.term.dispose()
    } catch {
      /* already gone */
    }
    this.panes.delete(paneId)
    this.version++
    for (const listener of this.listeners) listener()
  }

  /** Repaints every terminal after the app's theme changed. */
  applyTheme(): void {
    this.theme = currentTheme()
    for (const rt of this.panes.values()) rt.term.options.theme = this.theme
  }

  /**
   * Coalesces resizes: dragging a window edge fires the observer dozens of
   * times, and every SIGWINCH makes a full-screen CLI repaint from scratch.
   */
  private scheduleFit(paneId: string): void {
    const rt = this.panes.get(paneId)
    if (!rt) return
    if (rt.fitTimer !== null) window.clearTimeout(rt.fitTimer)
    rt.fitTimer = window.setTimeout(() => {
      rt.fitTimer = null
      this.fit(paneId)
    }, 60)
  }

  private fit(paneId: string): void {
    const rt = this.panes.get(paneId)
    if (!rt?.host || rt.host.clientWidth === 0 || rt.host.clientHeight === 0) return
    try {
      rt.fit.fit()
    } catch {
      return
    }
    const { cols, rows } = rt.term
    if (rt.spawned && (cols !== rt.sentCols || rows !== rt.sentRows)) {
      rt.sentCols = cols
      rt.sentRows = rows
      window.api.terminals.resize(paneId, cols, rows)
    }
  }
}

export const terminals = new TerminalRegistry()
