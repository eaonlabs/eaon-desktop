import { ApiError, errorBody, handleApi, type RemoteApiDeps } from '../../remote/api'
import { sessionSubtitle, sessionTitle, type AdeChanges, type AdeSession } from '@shared/adeSessions'
import { TERMINAL_AGENT_IDS, type TerminalAgentId } from '@shared/terminals'
import type { TerminalsControl } from '../terminals'

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
 *   *    /remote/v1/…                  the Workers API (docs/remote-api.md), as the phone uses it
 *
 * Terminals: `{t:'sub', pane}` sends `{t:'snap'}` (what it shows now, its size)
 * then `{t:'term'}` chunks as they print, and `{t:'exit'}`; `{t:'input', pane,
 * data}` types into it. Only panes in the ADE's layout can be watched or typed
 * into. A tab that goes away (`{t:'gone'}`) stops being sent anything.
 */

export interface RcHandlerDeps {
  terminals: TerminalsControl
  ade: { list: () => AdeSession[]; changes: (cwd: string) => Promise<AdeChanges | null> }
  workers: RemoteApiDeps | null
  send: (message: Record<string, unknown>) => void
}

/** A chunk of terminal output bigger than this goes out in pieces (the relay caps a message at 1 MB). */
const CHUNK = 256 * 1024
/** Uncommitted-change counts are git runs: reused for this long between polls. */
const CHANGES_TTL_MS = 8000

export function createRcHandler(deps: RcHandlerDeps) {
  const { terminals } = deps
  /** pane id → the tabs watching it. */
  const watchers = new Map<string, Set<string>>()
  const changesCache = new Map<string, { at: number; value: Promise<AdeChanges | null> }>()

  const paneInLayout = (paneId: string): { cwd: string; name: string; agent: TerminalAgentId } | null => {
    for (const [cwd, panes] of Object.entries(terminals.layout())) {
      const pane = panes.find((p) => p.id === paneId)
      if (pane) return { cwd, name: pane.name, agent: pane.agent }
    }
    return null
  }

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

  return {
    async handle(m: Record<string, unknown>): Promise<void> {
      const from = typeof m.from === 'string' ? m.from : ''
      switch (m.t) {
        case 'req': {
          let res: { status: number; body: unknown }
          try {
            res = await route(String(m.method ?? 'GET').toUpperCase(), String(m.path ?? '/'), m.body)
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
          const found = paneInLayout(id)
          if (!found || !from) return
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
          if (data && paneInLayout(id)) terminals.write(id, data)
          return
        }
        case 'gone':
          for (const tabs of watchers.values()) tabs.delete(from)
          return
      }
    },
    dispose(): void {
      untap()
      watchers.clear()
    }
  }
}
