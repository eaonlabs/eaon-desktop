import fs from 'node:fs'
import path from 'node:path'
import { randomBytes } from 'node:crypto'
import type { LockedTerminal, LockedTerminalDraft } from '@shared/rc'
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
 *   who opens a new terminal in one of your sessions. They get a locked shell
 *   in that session's folder, never one of your own shells. These live only
 *   while Eaon is open.
 *
 * Every guest terminal belongs to one GitHub login, and only that login may
 * type into it.
 */

export const GUEST_PANE = /^guest-[\w-]{1,80}$/
const FILE = 'guest-terminals.json'
const MAX = 20

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

export function createGuestTerminals(deps: {
  terminals: TerminalsControl
  store: GuestStore
  homesDir: string
  userData?: string
  /** Where a CLI is installed, from its command; null when it isn't. */
  findBin: (bin: string) => string | null
  now?: () => number
}) {
  const now = deps.now ?? Date.now
  const adhoc = new Map<string, GuestPane & { mode: 'shell' }>()

  const read = (): Saved[] => deps.store.getJson<Saved[]>(FILE, []).filter((s) => s && typeof s.id === 'string')
  const write = (list: Saved[]): void => deps.store.setJson(FILE, list)
  const live = (s: Saved): boolean => s.expiresAt === null || s.expiresAt > now()
  const paneOf = (id: string): string => `guest-${id}`

  const removeHome = (id: string): void => {
    try {
      fs.rmSync(path.join(deps.homesDir, id), { recursive: true, force: true })
    } catch {
      /* gone already */
    }
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

  function launchSaved(s: Saved, program: string | undefined, size?: { cols: number; rows: number }): void {
    const launch = buildGuestLaunch(
      { id: s.id, root: s.folder, mode: s.mode, program, programArgs: [], network: s.network, label: s.label },
      { homesDir: deps.homesDir, userData: deps.userData }
    )
    deps.terminals.startGuest(paneOf(s.id), launch, size)
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

    /** Ends it: the friend's terminal stops, its private home is deleted. Returns its rc share id. */
    remove(id: string): string | null {
      const list = read()
      const s = list.find((x) => x.id === id)
      deps.terminals.kill(paneOf(id))
      removeHome(id)
      write(list.filter((x) => x.id !== id))
      return s?.shareId ?? null
    },

    /** Drops the ones whose share is gone from rc.eaon.dev (revoked on the website) and the expired. */
    prune(liveShareIds: Set<string> | null): string[] {
      const list = read()
      const gone = list.filter((s) => !live(s) || (liveShareIds && s.shareId && !liveShareIds.has(s.shareId)))
      for (const s of gone) {
        deps.terminals.kill(paneOf(s.id))
        removeHome(s.id)
      }
      if (gone.length) write(list.filter((s) => !gone.includes(s)))
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
      return Boolean(p && p.login.toLowerCase() === login.toLowerCase())
    },

    /** Starts the friend's terminal if it isn't running. Throws with a sentence when it can't. */
    async start(paneId: string, size?: { cols: number; rows: number }): Promise<void> {
      if (deps.terminals.running(paneId)) return
      const temp = adhoc.get(paneId)
      if (temp) {
        const launch = buildGuestLaunch(
          { id: paneId.slice(6), root: temp.folder, mode: 'shell', network: false, label: temp.label },
          { homesDir: deps.homesDir, userData: deps.userData }
        )
        deps.terminals.startGuest(paneId, launch, size)
        return
      }
      const s = read().find((x) => paneOf(x.id) === paneId)
      if (!s || !live(s)) throw new Error('That terminal isn’t shared any more.')
      launchSaved(s, s.mode === 'cli' && s.agent ? await cliProgram(s.agent) : undefined, size)
    },

    /**
     * A friend with control of the whole computer opening a terminal in one of
     * your sessions: a locked shell in that folder, never one of your shells.
     */
    async openAdhoc(folder: string, login: string): Promise<GuestPane> {
      const support = guestSandboxSupport()
      if (!support.ok) throw new Error(support.reason)
      const checked = checkGuestRoot(folder, { userData: deps.userData })
      if (!checked.ok) throw new Error(checked.reason)
      const paneId = `guest-x${newId()}`
      const pane = { paneId, folder: checked.root, label: path.basename(checked.root), login, agent: null, locked: false, mode: 'shell' as const }
      adhoc.set(paneId, pane)
      await this.start(paneId)
      return pane
    },

    /** The ad-hoc terminals a friend opened, for the session list they see. */
    adhocFor(login: string): GuestPane[] {
      return [...adhoc.values()].filter((p) => p.login.toLowerCase() === login.toLowerCase())
    },

    dispose(): void {
      for (const id of adhoc.keys()) {
        deps.terminals.kill(id)
        removeHome(id.slice(6))
      }
      adhoc.clear()
    }
  }
}

export type GuestTerminals = ReturnType<typeof createGuestTerminals>
