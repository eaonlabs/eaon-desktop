import { ApiError, errorBody, handleApi, type RemoteApiDeps } from '../../remote/api'
import { sessionSubtitle, sessionTitle, type AdeChanges, type AdeSession } from '@shared/adeSessions'
import { TERMINAL_AGENT_IDS, type TerminalAgentId } from '@shared/terminals'
import type { TerminalsControl } from '../terminals'
import type { AgentBrowserFrame, AgentBrowserStatus, AgentBrowserStep, BrowserTarget } from '@shared/agentBrowser'
import type { GuestTerminals } from './guestTerminals'

/**
 * This computer's side of Eaon Remote: what a browser tab may ask through the
 * relay, and the terminals it watches.
 *
 * Requests (`{t:'req', from, id, method, path, body}`, answered with
 * `{t:'res', to, id, status, body}`):
 *   GET  /ade/sessions                 sessions, their panes and what each is doing
 *   GET  /ade/panes/:id                one pane
 *   POST /ade/sessions/:id/panes       start a terminal in a session: `{ agent }`
 *   POST /ade/panes/:id/start          start a pane the window hasn't shown yet
 *   GET  /browsers                     the agents' browsers: Eaon's own and each Worker's
 *   *    /remote/v1/…                  the Workers API (docs/remote-api.md), as the phone uses it
 *
 * Terminals: `{t:'sub', pane}` sends `{t:'snap'}` (what it shows now, its size)
 * then `{t:'term'}` chunks as they print, and `{t:'exit'}`; `{t:'input', pane,
 * data}` types into it. Only panes in the ADE's layout can be watched or typed
 * into. A tab that goes away (`{t:'gone'}`) stops being sent anything.
 *
 * Agents' browsers: `{t:'bsub', target}` sends `{t:'bsnap'}` (where it is,
 * whether the user has control, its last steps) then `{t:'bframe'}` pictures
 * as the page changes (a few a second at most, the newest winning) and
 * `{t:'bstep'}` as the agent acts; `{t:'bunsub'}` stops. Watching only: the
 * page can't be clicked from the web.
 *
 * A guest's messages (another account something was shared with) carry
 * `guest`, its GitHub login. The relay checks them against what was shared,
 * and this side checks again, because a guest must never reach one of the
 * user's own shells:
 *
 * - A guest types only into a guest terminal of its own (guestTerminals.ts),
 *   a sandboxed one locked to a folder. The user's terminals are watch-only
 *   for guests, whatever the share says.
 * - A guest with control of the whole computer who opens a terminal gets a
 *   locked one in that session's folder (the CLI they picked, or a shell),
 *   not a new terminal of the user's.
 * - Workers aren't reachable by guests at all: a Worker acts with the user's
 *   own access.
 */

export interface RcHandlerDeps {
  terminals: TerminalsControl
  ade: { list: () => AdeSession[]; changes: (cwd: string) => Promise<AdeChanges | null> }
  workers: RemoteApiDeps | null
  browsers?: RcBrowsers | null
  /** Sandboxed terminals for guests. Without it, guests can only watch. */
  guests?: GuestTerminals | null
  send: (message: Record<string, unknown>) => void
}

/** The agents' browsers as Eaon Remote sees them (features/agentBrowser.ts). */
export interface RcBrowsers {
  list: () => AgentBrowserStatus[]
  status: (target: BrowserTarget) => AgentBrowserStatus
  label: (target: BrowserTarget) => string
  steps: (target: BrowserTarget) => AgentBrowserStep[]
  watch: (target: BrowserTarget, onFrame: (frame: AgentBrowserFrame) => void) => (() => void) | null
  onStep: (listener: (step: AgentBrowserStep) => void) => () => void
}

/** At most one picture of a browser this often to each tab: the relay carries every byte. */
const FRAME_GAP_MS = 350
/** A picture bigger than this isn't sent (the relay refuses a message over 1 MB). */
const MAX_FRAME = 900 * 1024
const isTarget = (value: string): boolean => /^(agent|worker:[\w-]{1,80})$/.test(value)

/** A chunk of terminal output bigger than this goes out in pieces (the relay caps a message at 1 MB). */
const CHUNK = 256 * 1024
/** Uncommitted-change counts are git runs: reused for this long between polls. */
const CHANGES_TTL_MS = 8000

export function createRcHandler(deps: RcHandlerDeps) {
  const { terminals } = deps
  /** Guests (accounts something was shared with) by their connection, and when each was last heard from. */
  const guests = new Map<string, { login: string; at: number }>()
  /** pane id → the tabs watching it. */
  const watchers = new Map<string, Set<string>>()
  const changesCache = new Map<string, { at: number; value: Promise<AdeChanges | null> }>()
  /** browser target → the tabs watching it, each with its stop and the picture waiting to go. */
  const browserWatchers = new Map<string, Map<string, { stop: () => void; timer: NodeJS.Timeout | null; next: AgentBrowserFrame | null; sentAt: number }>>()

  const stopBrowser = (target: string, from: string): void => {
    const tabs = browserWatchers.get(target)
    const tab = tabs?.get(from)
    if (!tabs || !tab) return
    tab.stop()
    if (tab.timer) clearTimeout(tab.timer)
    tabs.delete(from)
    if (!tabs.size) browserWatchers.delete(target)
  }

  const watchBrowser = (target: string, from: string): void => {
    const browsers = deps.browsers
    if (!browsers || !isTarget(target)) return
    stopBrowser(target, from)
    deps.send({ t: 'bsnap', to: from, target, label: browsers.label(target), status: browsers.status(target), steps: browsers.steps(target) })
    const tab: { stop: () => void; timer: NodeJS.Timeout | null; next: AgentBrowserFrame | null; sentAt: number } = { stop: () => undefined, timer: null, next: null, sentAt: 0 }
    const flush = (): void => {
      tab.timer = null
      if (!tab.next) return
      const frame = tab.next
      tab.next = null
      tab.sentAt = Date.now()
      if (frame.image.length <= MAX_FRAME) deps.send({ t: 'bframe', to: from, target, frame })
    }
    let tabs = browserWatchers.get(target)
    if (!tabs) browserWatchers.set(target, (tabs = new Map()))
    tabs.set(from, tab)
    const stop = browsers.watch(target, (frame) => {
      tab.next = frame
      if (tab.timer) return
      tab.timer = setTimeout(flush, Math.max(0, FRAME_GAP_MS - (Date.now() - tab.sentAt)))
    })
    tab.stop = stop ?? (() => undefined)
  }

  const untapSteps =
    deps.browsers?.onStep((step) => {
      const tabs = browserWatchers.get(step.target)
      if (!tabs?.size) return
      const status = deps.browsers!.status(step.target)
      for (const to of tabs.keys()) deps.send({ t: 'bstep', to, target: step.target, step, status })
    }) ?? (() => undefined)

  const paneInLayout = (paneId: string): { cwd: string; name: string; agent: TerminalAgentId } | null => {
    for (const [cwd, panes] of Object.entries(terminals.layout())) {
      const pane = panes.find((p) => p.id === paneId)
      if (pane) return { cwd, name: pane.name, agent: pane.agent }
    }
    return null
  }

  /** A guest terminal as a pane: its folder, the name the friend sees, what it runs. */
  const guestPane = (paneId: string): { cwd: string; name: string; agent: TerminalAgentId } | null => {
    const g = deps.guests?.pane(paneId)
    return g ? { cwd: g.folder, name: g.label, agent: ((g.agent ?? 'shell') as TerminalAgentId) } : null
  }

  /** Any pane this computer can show: one of the user's, or a guest's. */
  const anyPane = (paneId: string) => paneInLayout(paneId) ?? guestPane(paneId)

  const sendChunks = (to: string, pane: string, data: string): void => {
    for (let i = 0; i < data.length; i += CHUNK) deps.send({ t: 'term', to, pane, data: data.slice(i, i + CHUNK) })
  }

  const untap = terminals.tap((channel, payload) => {
    const { paneId, data } = payload as { paneId: string; data?: string }
    const tabs = watchers.get(paneId)
    if (!tabs?.size) return
    for (const to of tabs) {
      if (channel === 'terminal:data' && typeof data === 'string') sendChunks(to, paneId, data)
      else if (channel === 'terminal:exit') deps.send({ t: 'exit', to, pane: paneId })
    }
  })

  const changes = (cwd: string): Promise<AdeChanges | null> => {
    const hit = changesCache.get(cwd)
    if (hit && Date.now() - hit.at < CHANGES_TTL_MS) return hit.value
    const value = Promise.race([deps.ade.changes(cwd).catch(() => null), new Promise<null>((r) => setTimeout(() => r(null), 4000))])
    changesCache.set(cwd, { at: Date.now(), value })
    return value
  }

  async function paneView(id: string, name: string, agent: TerminalAgentId) {
    const agents = await terminals.agents()
    return { id, name, agent, agentLabel: agents.find((a) => a.id === agent)?.label ?? agent, status: terminals.status(id), task: terminals.task(id) }
  }

  async function sessionsView() {
    const layout = terminals.layout()
    const agents = await terminals.agents()
    const sessions = await Promise.all(
      deps.ade.list().map(async (s) => {
        const panes = await Promise.all((layout[s.cwd] ?? []).map((p) => paneView(p.id, p.name, p.agent)))
        const state = panes.some((p) => p.status === 'working') ? 'working' : panes.some((p) => p.status === 'idle') ? 'live' : 'idle'
        return { id: s.id, title: sessionTitle(s), subtitle: sessionSubtitle(s), branch: s.branch, host: s.host ?? null, state, panes, changes: s.repo && !s.missing ? await changes(s.cwd) : null }
      })
    )
    // Working first, then open, then the rest; the order the sidebar's eye goes.
    const rank = { working: 0, live: 1, idle: 2 } as Record<string, number>
    sessions.sort((a, b) => rank[a.state] - rank[b.state])
    return { sessions, agents: agents.map((a) => ({ id: a.id, label: a.label, installed: a.installed })) }
  }

  async function route(method: string, rawPath: string, body: unknown): Promise<{ status: number; body: unknown }> {
    const [pathPart, queryPart = ''] = rawPath.split('?')
    const path = pathPart.replace(/\/+$/, '') || '/'

    if (path.startsWith('/remote/v1/')) {
      if (!deps.workers) return { status: 503, body: errorBody('server_error', 'Workers aren’t available on this computer.') }
      return handleApi(deps.workers, { method, path, query: new URLSearchParams(queryPart), body })
    }

    if (method === 'GET' && path === '/ade/sessions') return { status: 200, body: await sessionsView() }

    if (method === 'GET' && path === '/browsers') {
      const browsers = deps.browsers
      if (!browsers) return { status: 200, body: { browsers: [] } }
      return {
        status: 200,
        body: { browsers: browsers.list().map((b) => ({ ...b, label: browsers.label(b.target), last: browsers.steps(b.target).at(-1) ?? null })) }
      }
    }

    const pane = /^\/ade\/panes\/([\w-]+)$/.exec(path)
    if (pane && method === 'GET') {
      const found = paneInLayout(pane[1])
      if (!found) return { status: 404, body: errorBody('not_found', 'That terminal isn’t in the ADE any more.') }
      return { status: 200, body: await paneView(pane[1], found.name, found.agent) }
    }

    const start = /^\/ade\/panes\/([\w-]+)\/start$/.exec(path)
    if (start && method === 'POST') {
      await terminals.startPane(start[1])
      return { status: 200, body: { ok: true } }
    }

    const add = /^\/ade\/sessions\/([\w-]+)\/panes$/.exec(path)
    if (add && method === 'POST') {
      const session = deps.ade.list().find((s) => s.id === add[1])
      if (!session) return { status: 404, body: errorBody('not_found', 'That session isn’t in the ADE any more.') }
      const agent = (body as { agent?: unknown } | null)?.agent
      if (typeof agent !== 'string' || !(TERMINAL_AGENT_IDS as readonly string[]).includes(agent)) return { status: 400, body: errorBody('invalid_request', 'Pick what to run.') }
      const made = await terminals.addPane(session.cwd, agent as TerminalAgentId)
      return { status: 201, body: { pane: await paneView(made.id, made.name, made.agent) } }
    }

    return { status: 404, body: errorBody('not_found', `There is no ${method} ${path}.`) }
  }

  const forbidden = (message: string): { status: number; body: unknown } => ({ status: 403, body: errorBody('forbidden', message) })

  /** What a guest may ask: a narrower route, checked here as well as on the relay. */
  async function guestRoute(login: string, method: string, rawPath: string, body: unknown): Promise<{ status: number; body: unknown }> {
    const path = rawPath.split('?')[0].replace(/\/+$/, '') || '/'
    if (path.startsWith('/remote/v1/')) return forbidden('Workers aren’t shared with guests.')
    if (method === 'GET' && (path === '/ade/sessions' || path === '/browsers')) return route(method, rawPath, null)

    const pane = /^\/ade\/panes\/([\w-]+)$/.exec(path)
    if (pane && method === 'GET') {
      const g = guestPane(pane[1])
      if (g) return deps.guests?.owns(pane[1], login) ? { status: 200, body: await paneView(pane[1], g.name, g.agent) } : forbidden('That terminal isn’t yours.')
      return route(method, rawPath, null)
    }

    const start = /^\/ade\/panes\/([\w-]+)\/start$/.exec(path)
    if (start && method === 'POST') {
      if (!deps.guests?.owns(start[1], login)) return forbidden('Only the terminal shared with you can be started.')
      await deps.guests.start(start[1])
      return { status: 200, body: { ok: true } }
    }

    const add = /^\/ade\/sessions\/([\w-]+)\/panes$/.exec(path)
    if (add && method === 'POST') {
      // A new terminal from a guest is a locked one in that folder: the CLI they picked, or a shell.
      if (!deps.guests) return forbidden('Guests can watch terminals on this computer, not open them.')
      const session = deps.ade.list().find((s) => s.id === add[1])
      if (!session) return { status: 404, body: errorBody('not_found', 'That session isn’t in the ADE any more.') }
      const agent = (body as { agent?: unknown } | null)?.agent
      const picked = typeof agent === 'string' && (TERMINAL_AGENT_IDS as readonly string[]).includes(agent) ? agent : 'shell'
      const made = await deps.guests.openAdhoc(session.cwd, login, picked)
      return { status: 201, body: { pane: await paneView(made.paneId, made.label, (made.agent ?? 'shell') as TerminalAgentId) } }
    }

    return forbidden('That isn’t shared with you.')
  }

  return {
    /** The GitHub logins of guests connected now. */
    guestsOnline(): string[] {
      const recent = Date.now() - 10 * 60_000
      return [...new Set([...guests.values()].filter((g) => g.at > recent).map((g) => g.login.toLowerCase()))]
    },
    async handle(m: Record<string, unknown>): Promise<void> {
      const from = typeof m.from === 'string' ? m.from : ''
      const guest = typeof m.guest === 'string' ? m.guest : null
      if (guest && from) guests.set(from, { login: guest, at: Date.now() })
      switch (m.t) {
        case 'req': {
          let res: { status: number; body: unknown }
          try {
            const method = String(m.method ?? 'GET').toUpperCase()
            res = guest ? await guestRoute(guest, method, String(m.path ?? '/'), m.body) : await route(method, String(m.path ?? '/'), m.body)
          } catch (error) {
            res =
              error instanceof ApiError
                ? { status: error.status, body: errorBody(error.code, error.message) }
                : { status: 500, body: errorBody('server_error', error instanceof Error ? error.message : 'Something went wrong on the computer.') }
          }
          deps.send({ t: 'res', to: from, id: m.id, status: res.status, body: res.body })
          return
        }
        case 'sub': {
          const id = String(m.pane ?? '')
          const found = anyPane(id)
          if (!found || !from) return
          const isGuestPane = !paneInLayout(id)
          // A friend watches only their own guest terminal; the user watches any.
          if (isGuestPane && guest && !deps.guests?.owns(id, guest)) return
          // The friend's terminal starts the first time they open it.
          if (isGuestPane && !terminals.running(id)) {
            try {
              await deps.guests?.start(id)
            } catch (error) {
              deps.send({ t: 'term', to: from, pane: id, data: `\r\n${error instanceof Error ? error.message : 'This terminal couldn’t start.'}\r\n` })
              return
            }
          }
          let tabs = watchers.get(id)
          if (!tabs) watchers.set(id, (tabs = new Set()))
          tabs.add(from)
          const snap = terminals.snapshot(id)
          deps.send({ t: 'snap', to: from, pane: id, name: found.name, cols: snap.cols, rows: snap.rows, running: snap.running, data: snap.data.slice(-CHUNK * 3) })
          return
        }
        case 'unsub':
          watchers.get(String(m.pane ?? ''))?.delete(from)
          return
        case 'input': {
          const id = String(m.pane ?? '')
          const data = typeof m.data === 'string' ? m.data.slice(0, 64 * 1024) : ''
          if (!data) return
          if (guest) {
            // Guests type only into their own guest terminal, never into one of the user's.
            if (deps.guests?.owns(id, guest)) terminals.write(id, data)
            return
          }
          if (paneInLayout(id) || guestPane(id)) terminals.write(id, data)
          return
        }
        case 'bsub':
          if (from) watchBrowser(String(m.target ?? ''), from)
          return
        case 'bunsub':
          stopBrowser(String(m.target ?? ''), from)
          return
        case 'gone':
          guests.delete(from)
          for (const tabs of watchers.values()) tabs.delete(from)
          for (const target of [...browserWatchers.keys()]) stopBrowser(target, from)
          return
      }
    },
    dispose(): void {
      untap()
      untapSteps()
      watchers.clear()
      for (const [target, tabs] of [...browserWatchers]) for (const from of [...tabs.keys()]) stopBrowser(target, from)
    }
  }
}
