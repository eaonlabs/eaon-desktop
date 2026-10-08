import fs from 'node:fs'
import path from 'node:path'
import { knownAgent, type TerminalAgentId } from '@shared/terminals'

/**
 * What each ADE pane was last seen running, and what it last showed — kept
 * so that quitting and reopening Eaon brings every pane back as it was: the
 * same agent, back in the same conversation, in the same folder, with the
 * screen it had.
 *
 * Owned by the main process because only the main process can know it: it is
 * read off the process table, not off anything the window did. The window's
 * own save of the grid is debounced, so a change in the last moments before a
 * quit would never leave it — and those are exactly the moments this is for.
 *
 * Keyed by pane id, which outlives the processes it describes: the pane is in
 * the saved layout, so the record still means something on the next launch.
 */

export interface PaneRecord {
  /** What was running: an agent, or just the shell. */
  agent: TerminalAgentId
  /** The agent's conversation, once known. */
  sessionId?: string
  /** Where it was running — the folder a resumed agent, or the shell, starts in. */
  cwd?: string
  /** A terminal program open in the shell (vim, htop…), to start again. */
  program?: string
  /** When it was last seen, so records for panes long gone can be dropped. */
  at: number
}

/** A record this old belongs to a pane that is long gone. */
const STALE_MS = 30 * 24 * 60 * 60 * 1000
/** Long enough to collapse a burst of changes, short enough to survive a crash. */
const WRITE_DELAY_MS = 1000
/** How much of a pane's output is kept for its next launch. */
export const SCROLLBACK_BYTES = 256 * 1024

const safeId = (paneId: string): string => paneId.replace(/[^\w-]/g, '_')

export class PaneRecords {
  private map = new Map<string, PaneRecord>()
  /** Told of every conversation a pane is seen in (the ADE's history keeps them after the pane goes). */
  onConversation: ((agent: TerminalAgentId, sessionId: string, cwd: string) => void) | null = null
  private timer: NodeJS.Timeout | null = null
  readonly file: string
  private readonly scrollbackDir: string

  constructor(readonly dir: string) {
    this.file = path.join(dir, 'panes.json')
    this.scrollbackDir = path.join(dir, 'scrollback')
    this.read()
  }

  private read(): void {
    let raw: Record<string, PaneRecord>
    try {
      raw = JSON.parse(fs.readFileSync(this.file, 'utf8')) as Record<string, PaneRecord>
    } catch {
      // First run, or a file that cannot be read: the worst this costs is
      // that panes come back as fresh shells once.
      return
    }
    const cutoff = Date.now() - STALE_MS
    for (const [paneId, entry] of Object.entries(raw ?? {})) {
      // An agent this version no longer has (Gemini CLI) comes back as the shell it ran in.
      if (entry && typeof entry.agent === 'string' && entry.at > cutoff) {
        const agent = knownAgent(entry.agent)
        this.map.set(paneId, agent === entry.agent ? entry : { ...entry, agent, sessionId: undefined })
      }
    }
  }

  /** Every pane's record, for the ADE's history to start from. */
  all(): PaneRecord[] {
    return [...this.map.values()]
  }

  get(paneId: string): PaneRecord | null {
    return this.map.get(paneId) ?? null
  }

  /**
   * Records what a pane is running. An unchanged pane only has its timestamp
   * refreshed, without a write — otherwise every poll would rewrite the file
   * for a number nobody reads until the next launch.
   */
  set(paneId: string, next: Omit<PaneRecord, 'at'>): void {
    const prev = this.map.get(paneId)
    const clean: PaneRecord = { agent: next.agent, at: Date.now() }
    if (next.sessionId) clean.sessionId = next.sessionId
    if (next.cwd) clean.cwd = next.cwd
    if (next.program) clean.program = next.program
    if (clean.sessionId && clean.cwd) this.onConversation?.(clean.agent, clean.sessionId, clean.cwd)
    if (prev && prev.agent === clean.agent && prev.sessionId === clean.sessionId && prev.cwd === clean.cwd && prev.program === clean.program) {
      prev.at = clean.at
      return
    }
    this.map.set(paneId, clean)
    this.schedule()
  }

  delete(paneId: string): void {
    if (this.map.delete(paneId)) this.schedule()
    this.dropScrollback(paneId)
  }

  /** Forgets every pane not in `keep` — panes that were closed — with their saved screens. */
  prune(keep: Set<string>): void {
    for (const paneId of [...this.map.keys()]) if (!keep.has(paneId)) this.delete(paneId)
    let names: string[] = []
    try {
      names = fs.readdirSync(this.scrollbackDir)
    } catch {
      return
    }
    const kept = new Set([...keep].map(safeId))
    for (const name of names) {
      if (name.endsWith('.log') && !kept.has(name.slice(0, -4))) fs.rmSync(path.join(this.scrollbackDir, name), { force: true })
    }
  }

  /** Keeps the tail of what a pane printed, for its next launch. */
  saveScrollback(paneId: string, text: string): void {
    const file = path.join(this.scrollbackDir, `${safeId(paneId)}.log`)
    try {
      if (!text) {
        fs.rmSync(file, { force: true })
        return
      }
      fs.mkdirSync(this.scrollbackDir, { recursive: true })
      fs.writeFileSync(file, text.length > SCROLLBACK_BYTES ? text.slice(-SCROLLBACK_BYTES) : text)
    } catch {
      /* a screen is not worth failing a quit over */
    }
  }

  /** What a pane printed last time, once: it is replayed when the pane starts and not again. */
  takeScrollback(paneId: string): { text: string; at: number } | null {
    const file = path.join(this.scrollbackDir, `${safeId(paneId)}.log`)
    try {
      const at = fs.statSync(file).mtimeMs
      const text = fs.readFileSync(file, 'utf8')
      fs.rmSync(file, { force: true })
      return text ? { text, at } : null
    } catch {
      return null
    }
  }

  private dropScrollback(paneId: string): void {
    try {
      fs.rmSync(path.join(this.scrollbackDir, `${safeId(paneId)}.log`), { force: true })
    } catch {
      /* already gone */
    }
  }

  private schedule(): void {
    if (this.timer) return
    this.timer = setTimeout(() => this.flush(), WRITE_DELAY_MS)
    this.timer.unref?.()
  }

  /** Writes now — on the way out, where a timer would never get to fire. */
  flush(): void {
    if (this.timer) {
      clearTimeout(this.timer)
      this.timer = null
    }
    const out: Record<string, PaneRecord> = {}
    for (const [paneId, entry] of this.map) out[paneId] = entry
    try {
      fs.mkdirSync(this.dir, { recursive: true })
      // Written aside and renamed, so an interrupted write cannot leave a
      // half-file that would be thrown away whole on the next read.
      const tmp = `${this.file}.tmp`
      fs.writeFileSync(tmp, JSON.stringify(out, null, 2))
      fs.renameSync(tmp, this.file)
    } catch {
      /* a note about what was running is not worth failing a quit over */
    }
  }
}

/**
 * Modes a program can leave a terminal in, switched back off: mouse
 * reporting, bracketed paste, application keys, a hidden cursor, a colour,
 * and synchronised output — which, left on mid-frame, would hold the
 * terminal's drawing until it timed out. None of these move the cursor.
 */
const RESET_MODES =
  '\x1b[?2026l\x1b[?1000l\x1b[?1002l\x1b[?1003l\x1b[?1005l\x1b[?1006l\x1b[?1015l' +
  '\x1b[?2004l\x1b[?1l\x1b>\x1b[?7h\x1b[?25h\x1b[0m'

/**
 * The two resets that do move the cursor, so each is sent only with care.
 * Leaving the alternate screen (`?1049l`) restores the cursor saved on the
 * way in — sent when no program had entered it, that is the top-left corner,
 * and everything drawn after lands on top of the old screen. So it is sent
 * only when the saved output ends inside it (a pane quit with vim open).
 * Clearing a scroll region (`ESC[r`) homes the cursor too, so it goes between
 * a save and a restore of the cursor.
 */
function leaveModes(body: string): string {
  let alt = false
  for (const m of body.matchAll(/\x1b\[\?(?:1049|1047|47)([hl])/g)) alt = m[1] === 'h'
  const region = /\x1b\[\d+;\d*r/.test(body)
  return `${alt ? '\x1b[?1049l' : ''}${region ? '\x1b7\x1b[r\x1b8' : ''}${RESET_MODES}`
}

/**
 * A pane's saved output as it is drawn on its next launch: its own bytes,
 * replayed into a fresh terminal of the same kind so it shows what it showed,
 * then every mode put back and a quiet line saying where the old run ends.
 */
export function restoredScreen(text: string, at: number): string {
  let body = text
  // Saved as a tail, so it can begin partway through an escape sequence:
  // start from the first whole line instead.
  if (body.length >= SCROLLBACK_BYTES) {
    const line = body.indexOf('\n')
    body = line >= 0 ? body.slice(line + 1) : ''
  }
  const when = new Date(at).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })
  return `${body}${leaveModes(body)}\r\n\x1b[2m── restored · last session ended ${when} ──\x1b[0m\r\n`
}
