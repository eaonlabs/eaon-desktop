import fs from 'node:fs'
import path from 'node:path'
import { randomBytes } from 'node:crypto'
import type { GuestTerminalView, LockedTerminal, LockedTerminalDraft } from '@shared/rc'
import type { TerminalAgent } from '@shared/terminals'
import { buildGuestLaunch, checkGuestRoot, guestSandboxSupport } from '../terminals/guestSandbox'
import type { TerminalsControl } from '../terminals'

/**
 * Terminals this computer shares with friends, each locked to a folder by the
 * operating system's sandbox. On rc.eaon.dev a locked terminal is an ordinary
 * one-terminal share whose pane id is `guest-<id>`; this module is what makes
 * that pane a sandboxed terminal of its own instead of one of yours.
 *
 * Two kinds of guest terminal:
 * - Locked shares, made in Settings, saved here, with their folder, mode and
 *   expiry. The friend's terminal starts the first time they open it.
 * - Ad-hoc ones: a friend you shared the whole computer with, with control,
 *   who opens a new terminal in one of your sessions. They get a locked
 *   terminal in that session's folder, running the CLI they picked (or a
 *   shell), never one of your own. These live only while Eaon is open.
 *
 * Every guest terminal belongs to one GitHub login, and only that login may
 * type into it. Each friend has one private home for all their terminals here
 * (`friend-<login>`), so what they sign in to in one stays signed in in the
 * next, and after Eaon restarts. It's deleted when nothing is shared with
 * them any more.
 */

export const GUEST_PANE = /^guest-[\w-]{1,80}$/
const FILE = 'guest-terminals.json'
const MAX = 20
const FRIEND_HOME = /^friend-([a-z0-9-]{1,39})$/

export interface GuestStore {
  getJson<T>(name: string, fallback: T): T
  setJson(name: string, value: unknown): void
}

export interface GuestPane {
  paneId: string
  folder: string
  label: string
  login: string
  agent: string | null
  /** From Settings (saved) rather than opened on the fly by a whole-computer guest. */
  locked: boolean
}

type Saved = Omit<LockedTerminal, 'running' | 'online' | 'pending'>

const newId = (): string => randomBytes(9).toString('base64url').replace(/[^\w-]/g, '')
/** The private home a friend's terminals share. GitHub logins are letters, digits and dashes. */
export const friendHome = (login: string): string => `friend-${login.toLowerCase()}`

export function createGuestTerminals(deps: {
  terminals: TerminalsControl
  store: GuestStore
  homesDir: string
  userData?: string
  /** Where a CLI is installed, from its command; null when it isn't. */
  findBin: (bin: string) => string | null
  /** A friend's terminal started or ended: what you watch them in changes. */
  onChange?: () => void
  now?: () => number
}) {
  const now = deps.now ?? Date.now
  const adhoc = new Map<string, GuestPane & { mode: 'shell' | 'cli' }>()
  /** The terminals started this run, and when: the ones there is something of to watch. */
  const started = new Map<string, number>()
  const changed = (): void => {
    try {
      deps.onChange?.()
    } catch {
      /* the window's business */
    }
  }
  const startGuest = (paneId: string, launch: Parameters<TerminalsControl['startGuest']>[1], size?: { cols: number; rows: number }): void => {
    deps.terminals.startGuest(paneId, launch, size)
    started.set(paneId, now())
    changed()
  }
  const kill = (paneId: string): void => {
    deps.terminals.kill(paneId)
    if (started.delete(paneId)) changed()
  }

  const read = (): Saved[] => deps.store.getJson<Saved[]>(FILE, []).filter((s) => s && typeof s.id === 'string')
  const write = (list: Saved[]): void => deps.store.setJson(FILE, list)
  const live = (s: Saved): boolean => s.expiresAt === null || s.expiresAt > now()
  const paneOf = (id: string): string => `guest-${id}`
  const same = (a: string, b: string): boolean => a.toLowerCase() === b.toLowerCase()

  const rm = (p: string): void => {
    try {
      fs.rmSync(p, { recursive: true, force: true })
    } catch {
      /* gone already */
    }
  }

  /**
   * Tidies up after a terminal of `login`'s ends for good: its shell's
   * startup files, a home from before homes were per friend, and the friend's
   * home itself once nothing else here is theirs.
   */
  const ended = (id: string, login: string, remaining: Saved[]): void => {
    rm(path.join(deps.homesDir, id))
    const home = path.join(deps.homesDir, friendHome(login))
    rm(path.join(home, '.eaon', 'shells', id))
    const stillTheirs = remaining.some((s) => same(s.login, login)) || [...adhoc.values()].some((p) => same(p.login, login))
    if (!stillTheirs) rm(home)
  }

  async function cliProgram(agentId: string): Promise<string> {
    const agents: TerminalAgent[] = await deps.terminals.agents()
    const agent = agents.find((a) => a.id === agentId)
    if (!agent || !agent.command || agentId === 'shell') throw new Error('Pick a CLI for them to use.')
    // Only the binary: never the flags a pane of yours starts it with (Claude
    // Code's permission skipping, for one). Your friend's CLI asks as it should.
    const bin = deps.findBin(agent.command.split(/\s+/)[0])
    if (!bin) throw new Error(`${agent.label} isn’t installed on this computer.`)
    return bin
  }

  /** The CLIs installed here, by command name, for the friend's PATH. Binaries only, as above. */
  async function tools(): Promise<Record<string, string>> {
    const out: Record<string, string> = {}
    let agents: TerminalAgent[] = []
    try {
      agents = await deps.terminals.agents()
    } catch {
      /* none listed: a shell without them */
    }
    for (const agent of agents) {
      const name = agent.command?.split(/\s+/)[0]
      if (agent.id === 'shell' || !agent.installed || !name || !/^[\w.-]{1,40}$/.test(name)) continue
      const bin = deps.findBin(name)
      if (bin) out[name] = bin
    }
    return out
  }

  async function launchSaved(s: Saved, program: string | undefined, size?: { cols: number; rows: number }): Promise<void> {
    const launch = buildGuestLaunch(
      { id: s.id, homeId: friendHome(s.login), root: s.folder, mode: s.mode, program, programArgs: [], tools: await tools(), network: s.network, label: s.label },
      { homesDir: deps.homesDir, userData: deps.userData }
    )
    startGuest(paneOf(s.id), launch, size)
  }

  return {
    support: () => guestSandboxSupport(),

    list(): LockedTerminal[] {
      return read().map((s) => ({ ...s, running: deps.terminals.running(paneOf(s.id)) }))
    },

    /** Checked and saved, before the share exists on rc.eaon.dev. Returns it with its pane id. */
    async prepare(draft: LockedTerminalDraft): Promise<{ saved: Saved; paneId: string }> {
      const support = guestSandboxSupport()
      if (!support.ok) throw new Error(support.reason)
      const checked = checkGuestRoot(draft.folder, { userData: deps.userData })
      if (!checked.ok) throw new Error(checked.reason)
      const login = String(draft.login ?? '').trim().replace(/^@/, '')
      if (!/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/.test(login)) throw new Error('Type their GitHub username.')
      if (draft.mode !== 'shell' && draft.mode !== 'cli') throw new Error('Pick a shell or a CLI.')
      const agent = draft.mode === 'cli' ? String(draft.agent ?? '') : null
      if (agent) await cliProgram(agent)
      const list = read().filter(live)
      if (list.length >= MAX) throw new Error(`You already share ${MAX} locked terminals. Revoke one first.`)
      const hours = Number(draft.hours ?? 0)
      const saved: Saved = {
        id: newId(),
        shareId: null,
        folder: checked.root,
        label: (draft.label ?? '').trim().slice(0, 60) || path.basename(checked.root),
        mode: draft.mode,
        agent,
        network: draft.mode === 'cli' ? true : draft.network === true,
        login,
        createdAt: now(),
        expiresAt: hours > 0 ? now() + Math.min(hours, 24 * 30) * 3_600_000 : null
      }
      return { saved, paneId: paneOf(saved.id) }
    },

    /** Saves a prepared one once rc.eaon.dev has made its share. */
    commit(saved: Saved, shareId: string): LockedTerminal {
      const s = { ...saved, shareId }
      write([...read(), s])
      return { ...s, running: false }
    },

    /**
     * Ends it: the friend's terminal stops, and their home goes too unless
     * something else here is still theirs. Returns its rc share id.
     */
    remove(id: string): string | null {
      const list = read()
      const s = list.find((x) => x.id === id)
      const rest = list.filter((x) => x.id !== id)
      kill(paneOf(id))
      write(rest)
      if (s) ended(id, s.login, rest)
      else rm(path.join(deps.homesDir, id))
      return s?.shareId ?? null
    },

    /**
     * Drops the ones whose share is gone from rc.eaon.dev (revoked on the
     * website) and the expired. Given who still has a share of any kind (the
     * website's list), the homes of friends with none left go too.
     */
    prune(liveShareIds: Set<string> | null, liveLogins?: Set<string>): string[] {
      const list = read()
      const gone = list.filter((s) => !live(s) || (liveShareIds && s.shareId && !liveShareIds.has(s.shareId)))
      const rest = list.filter((s) => !gone.includes(s))
      if (gone.length) write(rest)
      for (const s of gone) {
        kill(paneOf(s.id))
        ended(s.id, s.login, rest)
      }
      if (liveLogins) {
        const keep = new Set([...liveLogins, ...rest.map((s) => s.login), ...[...adhoc.values()].map((p) => p.login)].map((l) => l.toLowerCase()))
        let names: string[] = []
        try {
          names = fs.readdirSync(deps.homesDir)
        } catch {
          /* no homes yet */
        }
        for (const name of names) {
          const login = FRIEND_HOME.exec(name)?.[1]
          // Anything else is a home from before they were per friend.
          if (!login || !keep.has(login)) rm(path.join(deps.homesDir, name))
        }
      }
      return gone.flatMap((s) => (s.shareId ? [s.shareId] : []))
    },

    /** The guest terminal behind a pane id, or null (unknown, revoked or expired). */
    pane(paneId: string): GuestPane | null {
      if (!GUEST_PANE.test(paneId)) return null
      const temp = adhoc.get(paneId)
      if (temp) return temp
      const s = read().find((x) => paneOf(x.id) === paneId)
      if (!s || !live(s)) return null
      return { paneId, folder: s.folder, label: s.label, login: s.login, agent: s.agent, locked: true }
    },

    /** Whether `login` may type into this pane: only the friend it belongs to. */
    owns(paneId: string, login: string): boolean {
      const p = this.pane(paneId)
      return Boolean(p && same(p.login, login))
    },

    /** Starts the friend's terminal if it isn't running. Throws with a sentence when it can't. */
    async start(paneId: string, size?: { cols: number; rows: number }): Promise<void> {
      if (deps.terminals.running(paneId)) return
      const temp = adhoc.get(paneId)
      if (temp) {
        const program = temp.mode === 'cli' && temp.agent ? await cliProgram(temp.agent) : undefined
        // A friend with the whole computer is someone you trust a lot: the
        // internet is on, so they can sign in, and still only through the walls.
        const launch = buildGuestLaunch(
          { id: paneId.slice(6), homeId: friendHome(temp.login), root: temp.folder, mode: temp.mode, program, tools: await tools(), network: true, label: temp.label },
          { homesDir: deps.homesDir, userData: deps.userData }
        )
        startGuest(paneId, launch, size)
        return
      }
      const s = read().find((x) => paneOf(x.id) === paneId)
      if (!s || !live(s)) throw new Error('That terminal isn’t shared any more.')
      await launchSaved(s, s.mode === 'cli' && s.agent ? await cliProgram(s.agent) : undefined, size)
    },

    /**
     * A friend with control of the whole computer opening a terminal in one of
     * your sessions: a locked one in that folder running what they picked (a
     * CLI installed here, or a shell), never one of your shells.
     */
    async openAdhoc(folder: string, login: string, agent?: string | null): Promise<GuestPane> {
      const support = guestSandboxSupport()
      if (!support.ok) throw new Error(support.reason)
      const checked = checkGuestRoot(folder, { userData: deps.userData })
      if (!checked.ok) throw new Error(checked.reason)
      const cli = agent && agent !== 'shell' ? agent : null
      if (cli) await cliProgram(cli)
      const paneId = `guest-x${newId()}`
      const pane = { paneId, folder: checked.root, label: path.basename(checked.root), login, agent: cli, locked: false, mode: cli ? ('cli' as const) : ('shell' as const) }
      adhoc.set(paneId, pane)
      try {
        await this.start(paneId)
      } catch (error) {
        adhoc.delete(paneId)
        throw error
      }
      return pane
    },

    /** Friends' terminals started this run, newest first, for watching them. */
    watching(): GuestTerminalView[] {
      const views: GuestTerminalView[] = []
      for (const [paneId, at] of started) {
        const p = this.pane(paneId)
        if (!p) continue
        views.push({ paneId, login: p.login, label: p.label, folder: p.folder, agent: p.agent, locked: p.locked, startedAt: at, running: deps.terminals.running(paneId) })
      }
      return views.sort((a, b) => b.startedAt - a.startedAt)
    },

    /** Whether this pane is a friend's terminal you can watch. */
    watchable(paneId: string): boolean {
      return started.has(paneId) && this.pane(paneId) !== null
    },

    /** Ends a friend's terminal now, without taking the share back: they can start it again. */
    stop(paneId: string): void {
      if (this.pane(paneId)) deps.terminals.kill(paneId)
      changed()
    },

    /** The ad-hoc terminals a friend opened, for the session list they see. */
    adhocFor(login: string): GuestPane[] {
      return [...adhoc.values()].filter((p) => same(p.login, login))
    },

    /** Eaon is closing: the ad-hoc terminals end. Friends' homes stay for next time. */
    dispose(): void {
      for (const [id, p] of adhoc) {
        deps.terminals.kill(id)
        started.delete(id)
        rm(path.join(deps.homesDir, friendHome(p.login), '.eaon', 'shells', id.slice(6)))
      }
      adhoc.clear()
    }
  }
}

export type GuestTerminals = ReturnType<typeof createGuestTerminals>
