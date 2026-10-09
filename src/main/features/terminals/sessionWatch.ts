import { execFile } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { promisify } from 'node:util'
import { BrowserWindow } from 'electron'
import type { TerminalAgentId } from '@shared/terminals'
import { AGENT_KINDS, agentOfArgs, type AgentId } from './agentSessions'
import type { PaneRecords } from './paneRecords'

const exec = promisify(execFile)

/**
 * Watches what is actually running in each ADE pane. Ported from Eaon ADE's
 * session-watch and widened from Claude Code to every agent the ADE knows.
 *
 * Two questions, both answered off the process table under each pane's shell
 * (the app spawned the shell, so it knows its pid):
 *
 *   1. Which agent is running in the pane right now — so its header's logo
 *      and name follow it. Close Codex and type `opencode`, and the pane stops
 *      claiming to be Codex.
 *   2. Which conversation that agent is holding — so the pane can be brought
 *      back to it after Eaon quits. Most conversations are not started by the
 *      app: you open a shell and type `claude`, and nothing the app was told
 *      knows that. Identified, in falling order of confidence, by:
 *        - the agent saying so (Claude Code's sessions/<pid>.json);
 *        - its command line naming one (`--resume <id>` and kin);
 *        - a conversation appearing in its folder that was not there when it
 *          started (the agent began one);
 *        - an older one being written to again (the agent reopened one), when
 *          only one pane could have done it.
 *
 * Unix only: Windows has no `ps`, and asking WMI every few seconds is too
 * slow to be worth it. There, panes still come back with their agent and
 * their screen, carrying on the folder's latest conversation (see terminals.ts).
 */

/** How often the process table is read while an Eaon window has focus — one `ps` for every pane. */
const TICK_MS = 4000
/**
 * How often it is read while none has. Nobody is watching a pane's logo then,
 * and listing every process on the machine every few seconds, all day, is not
 * free. The records the next launch restores from still keep up, and the
 * first check after a window comes forward (within TICK_MS) catches up.
 */
const IDLE_TICK_MS = 25_000
/**
 * How far ahead of an agent a conversation may be filed and still be its own.
 * Covers the poll interval: a conversation can be a few seconds old before
 * the agent that wrote it is first seen. (Away from Eaon, an agent can go
 * longer unseen; a conversation already on disk by then is claimed when it is
 * next written to, or by the agent's own word.)
 */
const BIRTH_SLACK_MS = 15_000
/** How long after an agent is first seen before older conversations being written to count as its own. */
const ACTIVITY_GRACE_MS = 3000

export interface Proc {
  pid: number
  ppid: number
  args: string
}

export interface WatchDeps {
  table: () => Promise<Proc[]>
  cwdOf: (pid: number) => Promise<string>
  now: () => number
  /** Whether someone is using Eaon (one of its windows has focus). Without it, every beat is a check. */
  attended?: () => boolean
}

/** What is running beneath one pane, and what is known about it. */
interface Watched {
  paneId: string
  pid: number
  agent: AgentId
  cwd: string
  /** Conversations already on disk when this agent was first seen. */
  before: Set<string>
  firstSeen: number
  /** The conversation it holds, once known. */
  sessionId: string | null
}

/* ------------------------------------------------------------------ processes */

export async function processTable(): Promise<Proc[]> {
  const { stdout } = await exec('ps', ['-Ao', 'pid=,ppid=,args='], { maxBuffer: 8 * 1024 * 1024, timeout: 8000 })
  const out: Proc[] = []
  for (const line of stdout.split('\n')) {
    const m = /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(line)
    if (m) out.push({ pid: Number(m[1]), ppid: Number(m[2]), args: m[3] })
  }
  return out
}

export function byParent(table: Proc[]): Map<number, Proc[]> {
  const kids = new Map<number, Proc[]>()
  for (const proc of table) {
    const list = kids.get(proc.ppid)
    if (list) list.push(proc)
    else kids.set(proc.ppid, [proc])
  }
  return kids
}

/**
 * The agent running under a pane's shell. Breadth first, so the agent you
 * started is found rather than something it spawned — agents run nested
 * copies of themselves, and wrappers (`node …/bin/opencode` starting the real
 * binary), and the outer one is the pane's.
 */
export function agentUnder(shellPid: number, kids: Map<number, Proc[]>): { proc: Proc; agent: AgentId } | null {
  const queue = [...(kids.get(shellPid) ?? [])]
  const seen = new Set<number>()
  while (queue.length) {
    const proc = queue.shift()!
    if (seen.has(proc.pid)) continue
    seen.add(proc.pid)
    const agent = agentOfArgs(proc.args)
    if (agent) return { proc, agent }
    queue.push(...(kids.get(proc.pid) ?? []))
  }
  return null
}

/**
 * Terminal programs that are safe to start again: editors, viewers and
 * monitors, which do nothing until you touch them. Anything else the shell
 * was running — a dev server, a build, a script — is left for you to rerun;
 * starting it unasked could do something.
 */
const PROGRAMS = new Set([
  'vim',
  'nvim',
  'vi',
  'nano',
  'micro',
  'hx',
  'helix',
  'emacs',
  'htop',
  'btop',
  'top',
  'lazygit',
  'lazydocker',
  'tig',
  'k9s',
  'yazi',
  'ranger',
  'nnn',
  'mc'
])

/** A word as the shell must be given it. */
export function shellQuote(value: string): string {
  return /^[\w@%+=:,./-]+$/.test(value) ? value : `'${value.replace(/'/g, `'\\''`)}'`
}

/**
 * The line that starts a terminal program again, from what `ps` shows of it.
 * `ps` joins the arguments with spaces and loses their quoting, so a file name
 * with a space in it arrives as two words; the longest run of words that names
 * something on disk is taken as one.
 */
export function programLine(args: string, cwd: string): string | null {
  const words = args.trim().split(/\s+/)
  const bin = path.basename(words[0] ?? '')
  if (!PROGRAMS.has(bin)) return null
  const out = [bin]
  for (let i = 1; i < words.length; i++) {
    if (words[i].startsWith('-')) {
      out.push(shellQuote(words[i]))
      continue
    }
    let end = i
    for (let j = words.length - 1; j > i; j--) {
      const joined = words.slice(i, j + 1).join(' ')
      if (fs.existsSync(path.resolve(cwd || '/', joined))) {
        end = j
        break
      }
    }
    out.push(shellQuote(words.slice(i, end + 1).join(' ')))
    i = end
  }
  return out.join(' ')
}

/** The program in the foreground of a pane's shell, if it is one worth starting again. */
export function programUnder(shellPid: number, kids: Map<number, Proc[]>): Proc | null {
  return (kids.get(shellPid) ?? []).find((proc) => PROGRAMS.has(path.basename(proc.args.trim().split(/\s+/)[0] ?? ''))) ?? null
}

/**
 * Where a process is running. Asked of the process rather than assumed from
 * the pane: a folder reached with `cd` is the one an agent files its
 * conversation under, and so the one it has to be reopened from.
 */
export async function cwdOf(pid: number): Promise<string> {
  return (await cwdsOf([pid])).get(pid) ?? ''
}

/** Several processes' working folders in one call — one `lsof` on a Mac, /proc on Linux. */
export async function cwdsOf(pids: number[], timeout = 5000): Promise<Map<number, string>> {
  const out = new Map<number, string>()
  if (pids.length === 0) return out
  if (process.platform === 'linux') {
    for (const pid of pids) {
      try {
        out.set(pid, fs.readlinkSync(`/proc/${pid}/cwd`))
      } catch {
        /* gone, or not ours to read */
      }
    }
    return out
  }
  try {
    const { stdout } = await exec('lsof', ['-a', '-d', 'cwd', '-p', pids.join(','), '-Fpn'], { timeout })
    let current = 0
    for (const line of stdout.split('\n')) {
      if (line.startsWith('p')) current = Number(line.slice(1))
      else if (line.startsWith('n') && current) out.set(current, line.slice(1).trim())
    }
  } catch (error) {
    // lsof exits 1 when any one pid has gone; what it printed is still good.
    const stdout = (error as { stdout?: string }).stdout ?? ''
    let current = 0
    for (const line of stdout.split('\n')) {
      if (line.startsWith('p')) current = Number(line.slice(1))
      else if (line.startsWith('n') && current) out.set(current, line.slice(1).trim())
    }
  }
  return out
}

/* ------------------------------------------------------------------ watch */

const DEFAULT_DEPS: WatchDeps = { table: processTable, cwdOf, now: () => Date.now(), attended: () => BrowserWindow.getFocusedWindow() !== null }

export class SessionWatch {
  private timer: NodeJS.Timeout | null = null
  /** When the last pass began, for spacing them out while nobody is at Eaon. */
  private lastTick = 0
  private watched = new Map<string, Watched>()
  /** What each pane was last reported as running, so only changes are sent. */
  private running = new Map<string, TerminalAgentId>()
  /** The program each pane was last seen running, by pid, so its folder is asked once. */
  private programs = new Map<string, { pid: number; line: string | null }>()
  /** Ticks never overlap; a slow `ps` must not start a second pass. */
  private busy = false

  constructor(
    /** Each live pane's shell pid. */
    private readonly panes: () => Map<string, number>,
    /**
     * True while a pane is still starting what it was launched with. Its shell
     * is alone for a moment before the agent appears, and reading that as "the
     * agent exited" would flicker the logo and forget the conversation.
     */
    private readonly settling: (paneId: string) => boolean,
    private readonly records: PaneRecords,
    /** Told when the agent running in a pane changes — 'shell' for none. */
    private readonly onAgent: (paneId: string, agent: TerminalAgentId) => void,
    private readonly deps: WatchDeps = DEFAULT_DEPS
  ) {}

  static supported(): boolean {
    return process.platform !== 'win32'
  }

  start(): void {
    if (this.timer || !SessionWatch.supported()) return
    this.timer = setInterval(() => void this.poll(), TICK_MS)
    this.timer.unref?.()
    void this.tick()
  }

  /** One beat of the timer: a pass, unless nobody is at Eaon and the last one was under IDLE_TICK_MS ago. */
  async poll(): Promise<void> {
    if (this.deps.attended?.() === false && this.deps.now() - this.lastTick < IDLE_TICK_MS) return
    await this.tick()
  }

  /**
   * Stops looking. Called before the shells are killed on the way out: every
   * agent disappears at once when the app quits, and reading that as "closed"
   * would erase exactly the records the next launch depends on.
   */
  stop(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
  }

  /** What each pane is running, as of the last tick. */
  snapshot(): Record<string, TerminalAgentId> {
    return Object.fromEntries(this.running)
  }

  /** Tells the watch what a pane was just started as, so it is not reported back as news. */
  expect(paneId: string, agent: TerminalAgentId): void {
    this.running.set(paneId, agent)
  }

  async tick(): Promise<void> {
    if (this.busy) return
    this.busy = true
    this.lastTick = this.deps.now()
    try {
      const panes = this.panes()
      for (const map of [this.watched, this.running, this.programs]) {
        for (const paneId of [...map.keys()]) if (!panes.has(paneId)) map.delete(paneId)
      }
      if (panes.size === 0) return
      const kids = byParent(await this.deps.table())
      const open: Watched[] = []

      for (const [paneId, shellPid] of panes) {
        const found = agentUnder(shellPid, kids)
        const settling = this.settling(paneId)
        const now: TerminalAgentId = found?.agent ?? 'shell'
        // A pane still starting its agent shows what it was opened as.
        if (!(settling && !found) && this.running.get(paneId) !== now) {
          this.running.set(paneId, now)
          this.onAgent(paneId, now)
        }

        if (!found) {
          this.watched.delete(paneId)
          if (settling) continue
          // No agent: the conversation it had was closed on purpose, and stays
          // closed. A program worth reopening is noted instead.
          const proc = programUnder(shellPid, kids)
          let program: string | null = null
          if (proc) {
            const known = this.programs.get(paneId)
            if (known?.pid === proc.pid) program = known.line
            else {
              program = programLine(proc.args, await this.deps.cwdOf(proc.pid))
              this.programs.set(paneId, { pid: proc.pid, line: program })
            }
          } else this.programs.delete(paneId)
          const prev = this.records.get(paneId)
          this.records.set(paneId, { agent: 'shell', ...(program ? { program } : {}), ...(prev?.agent === 'shell' && prev.cwd ? { cwd: prev.cwd } : {}) })
          continue
        }
        this.programs.delete(paneId)

        const kind = AGENT_KINDS[found.agent]
        let w = this.watched.get(paneId)
        if (!w || w.pid !== found.proc.pid) {
          const cwd = await this.deps.cwdOf(found.proc.pid)
          w = {
            paneId,
            pid: found.proc.pid,
            agent: found.agent,
            cwd,
            before: new Set((await kind.conversations(cwd)).keys()),
            firstSeen: this.deps.now(),
            sessionId: null
          }
          this.watched.set(paneId, w)
          /*
           * Running, conversation not yet known. A pane brought back with
           * `--session <id>` keeps that id meanwhile: some agents rewrite
           * their process title, so their command line no longer names it,
           * and until the conversation is written to again nothing else will
           * — quitting in between must not lose it.
           */
          const prev = this.records.get(paneId)
          const carried = prev?.agent === found.agent && prev.sessionId && (!prev.cwd || prev.cwd === cwd) ? prev.sessionId : undefined
          this.records.set(paneId, { agent: found.agent, cwd, ...(carried ? { sessionId: carried } : {}) })
        }

        // The agent's own word, re-read every tick so a /resume or /clear inside it is followed.
        const own = kind.own?.(w.pid, w.cwd)
        if (own) {
          this.settle(w, own.sessionId, own.cwd)
          continue
        }
        if (!w.sessionId) {
          const id = kind.named(found.proc.args)
          if (id) {
            this.settle(w, id)
            continue
          }
        }
        // Settled panes stay in, so a conversation started over inside the
        // agent (/new) is followed when nothing else could have started it.
        open.push(w)
      }

      await this.attribute(open)
    } catch {
      // A failed read of the process table costs nothing but this pass.
    } finally {
      this.busy = false
    }
  }

  private settle(w: Watched, sessionId: string, cwd?: string): void {
    w.sessionId = sessionId
    if (cwd) w.cwd = cwd
    this.records.set(w.paneId, { agent: w.agent, sessionId, cwd: w.cwd })
  }

  /**
   * Hands each newly written conversation to the pane most likely to have
   * written it, and an older one being written to again to the only pane that
   * could be reopening it.
   */
  private async attribute(open: Watched[]): Promise<void> {
    const groups = new Map<string, Watched[]>()
    for (const w of open) {
      if (!w.cwd) continue
      const key = `${w.agent}\0${w.cwd}`
      const list = groups.get(key)
      if (list) list.push(w)
      else groups.set(key, [w])
    }
    const claimed = new Set([...this.watched.values()].map((w) => w.sessionId).filter(Boolean) as string[])

    for (const group of groups.values()) {
      const { agent, cwd } = group[0]
      const now = await AGENT_KINDS[agent].conversations(cwd)

      // Oldest first, so conversations go out in the order they were started.
      const arrivals = [...now.values()]
        .filter((c) => !claimed.has(c.id) && group.some((w) => !w.before.has(c.id)))
        .sort((a, b) => a.born - b.born)
      for (const conv of arrivals) {
        const candidates = group.filter((w) => !w.before.has(conv.id) && w.firstSeen - conv.born < BIRTH_SLACK_MS)
        // A pane still looking for its conversation first; failing that, the
        // only pane that could have started it (a /new inside the agent).
        const owner =
          candidates.filter((w) => !w.sessionId).sort((a, b) => b.firstSeen - a.firstSeen)[0] ??
          (group.length === 1 && candidates.length === 1 ? candidates[0] : undefined)
        for (const w of group) w.before.add(conv.id)
        if (!owner) continue
        claimed.add(conv.id)
        this.settle(owner, conv.id)
      }

      // Reopened rather than started: an older conversation written to since.
      const searching = group.filter((w) => !w.sessionId)
      if (searching.length !== 1) continue
      const w = searching[0]
      const touched = [...now.values()].filter((c) => w.before.has(c.id) && !claimed.has(c.id) && c.touched > w.firstSeen + ACTIVITY_GRACE_MS)
      if (touched.length === 1) {
        claimed.add(touched[0].id)
        this.settle(w, touched[0].id)
      }
    }
  }
}
