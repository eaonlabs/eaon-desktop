import { create } from 'zustand'
import type { AdeConversation, AdeSession, NewSessionRequest } from '@shared/adeSessions'
import type { TerminalAgentId } from '@shared/terminals'
import { useApp } from '../../state/store'
import { useCode } from './codeStore'
import { terminals } from './terminal/registry'
import { useTerminals } from './terminal/terminalStore'

/**
 * The ADE's sessions in the window (see `shared/adeSessions.ts`). The session
 * shown is the one whose folder is the ADE's folder (`useCode.cwd`), which
 * main reopens at launch — so there is no separate "current session" to keep.
 */

interface SessionsState {
  loaded: boolean
  error: string | null
  sessions: AdeSession[]
  /** Past conversations per folder, loaded when a session is shown. */
  conversations: Record<string, AdeConversation[]>
  /** The conversation each pane is in, as main last saw it. */
  paneConversations: Record<string, string | null>
  /** Projects folded away in the sidebar. */
  collapsed: Record<string, boolean>
  /** The New session dialog, for this project; undefined when closed. */
  creatingIn: string | null | undefined

  load: () => Promise<void>
  open: (session: AdeSession) => Promise<void>
  /** A folder's own session (made when it has none), opened. */
  openFolder: (folder: string) => Promise<void>
  create: (req: NewSessionRequest, agent: TerminalAgentId | null) => Promise<string | null>
  /** Removes a session after closing its terminals; an error to show, or null. */
  remove: (session: AdeSession, deleteWorktree: boolean) => Promise<string | null>
  rename: (session: AdeSession, title: string) => Promise<void>
  /** Takes a project and all its sessions off the sidebar; nothing on disk is deleted. An error, or null. */
  removeProject: (project: string) => Promise<string | null>
  loadConversations: (cwd: string) => Promise<void>
  /** Reopens a past conversation in a new pane of its session. */
  resume: (session: AdeSession, conversation: AdeConversation) => Promise<void>
  toggleProject: (project: string) => void
  newSession: (project?: string | null) => void
  closeNewSession: () => void
}

const COLLAPSED_KEY = 'eaon.ade.collapsed'

function readCollapsed(): Record<string, boolean> {
  try {
    const value = JSON.parse(localStorage.getItem(COLLAPSED_KEY) ?? '{}') as unknown
    return value && typeof value === 'object' ? (value as Record<string, boolean>) : {}
  } catch {
    return {}
  }
}

const clean = (error: unknown): string =>
  (error instanceof Error ? error.message : String(error)).replace(/^Error invoking remote method '[^']+': (?:Error: )?/, '')

/** Shows the ADE (the Code tab) in the agent view, where the terminals are. */
function showAde(): void {
  const app = useApp.getState()
  const ade = app.workspaces.find((w) => w.kind === 'code')
  if (ade && ade.id !== app.settings?.activeWorkspaceId) app.setWorkspace(ade.id)
  if (app.view !== 'chat') app.setView('chat')
}

export const useAdeSessions = create<SessionsState>((set, get) => ({
  loaded: false,
  error: null,
  sessions: [],
  conversations: {},
  paneConversations: {},
  collapsed: readCollapsed(),
  creatingIn: undefined,

  async load() {
    try {
      set({ sessions: await window.api.ade.sessions(), loaded: true, error: null })
    } catch (error) {
      set({ error: clean(error), loaded: true })
    }
  },

  async open(session) {
    useCode.setState({ cwd: session.cwd })
    try {
      useCode.setState({ recents: await window.api.ade.open(session.id) })
    } catch (error) {
      set({ error: clean(error) })
    }
    void get().loadConversations(session.cwd)
  },

  async openFolder(folder) {
    const { session, recents } = await window.api.ade.openFolder(folder)
    set((s) => ({ sessions: s.sessions.some((x) => x.id === session.id) ? s.sessions : [...s.sessions, session] }))
    useCode.setState({ cwd: session.cwd, recents })
    void get().loadConversations(session.cwd)
  },

  async create(req, agent) {
    let result: Awaited<ReturnType<typeof window.api.ade.create>>
    try {
      result = await window.api.ade.create(req)
    } catch (error) {
      return clean(error)
    }
    if (!result.ok) return result.error
    const session = result.session
    set((s) => ({ sessions: [...s.sessions, session], creatingIn: undefined, collapsed: { ...s.collapsed, [session.project]: false } }))
    await get().open(session)
    showAde()
    if (agent) {
      await useTerminals.getState().load()
      useTerminals.getState().add(session.cwd, agent)
    }
    return null
  },

  async remove(session, deleteWorktree) {
    // Its terminals end first: a worktree git is asked to remove must not have a shell in it.
    const panes = useTerminals.getState().layout[session.cwd] ?? []
    for (const pane of panes) useTerminals.getState().close(session.cwd, pane.id)
    let result: Awaited<ReturnType<typeof window.api.ade.remove>>
    try {
      result = await window.api.ade.remove(session.id, { deleteWorktree })
    } catch (error) {
      return clean(error)
    }
    if (!result.ok) return result.error
    set((s) => ({ sessions: s.sessions.filter((x) => x.id !== session.id) }))
    // The session on screen went: show its project's own folder, or another session, or nothing.
    if (useCode.getState().cwd === session.cwd) {
      const rest = get().sessions
      const next = rest.find((x) => x.cwd === session.project) ?? rest.find((x) => x.project === session.project) ?? rest[0]
      if (next) await get().open(next)
      else useCode.setState({ cwd: null })
    }
    return null
  },

  async removeProject(project) {
    for (const session of get().sessions.filter((s) => s.project === project)) {
      const failed = await get().remove(session, false)
      if (failed) return failed
    }
    await useCode.getState().forgetFolder(project)
    return null
  },

  async rename(session, title) {
    const renamed = await window.api.ade.rename(session.id, title)
    if (renamed) set((s) => ({ sessions: s.sessions.map((x) => (x.id === renamed.id ? renamed : x)) }))
  },

  async loadConversations(cwd) {
    const paneIds = (useTerminals.getState().layout[cwd] ?? []).map((p) => p.id)
    try {
      const [conversations, held] = await Promise.all([
        window.api.ade.conversations(cwd),
        paneIds.length ? window.api.terminals.conversations(paneIds) : Promise.resolve({} as Record<string, string | null>)
      ])
      set((s) => ({ conversations: { ...s.conversations, [cwd]: conversations }, paneConversations: { ...s.paneConversations, ...held } }))
    } catch {
      /* the list is a convenience; the sidebar shows the panes either way */
    }
  },

  async resume(session, conversation) {
    if (useCode.getState().cwd !== session.cwd) await get().open(session)
    showAde()
    await useTerminals.getState().load()
    const panes = useTerminals.getState().layout[session.cwd] ?? []
    // Already open in a pane: show that one rather than a second copy.
    const holder = panes.find((p) => p.resume === conversation.id || get().paneConversations[p.id] === conversation.id)
    if (holder) {
      terminals.focus(holder.id)
      return
    }
    const pane = useTerminals.getState().add(session.cwd, conversation.agent, conversation.id)
    set((s) => ({ paneConversations: { ...s.paneConversations, [pane.id]: conversation.id } }))
  },

  toggleProject(project) {
    const collapsed = { ...get().collapsed, [project]: !get().collapsed[project] }
    set({ collapsed })
    try {
      localStorage.setItem(COLLAPSED_KEY, JSON.stringify(collapsed))
    } catch {
      /* folding is remembered where it can be */
    }
  },

  newSession(project) {
    const current = get().sessions.find((s) => s.cwd === useCode.getState().cwd)
    set({ creatingIn: project ?? current?.project ?? null })
  },

  closeNewSession() {
    set({ creatingIn: undefined })
  }
}))

/** "New session" from the sidebar or the collapsed rail: the dialog, for the project on screen. */
export async function openNewSession(): Promise<void> {
  await useCode.getState().init()
  if (!useAdeSessions.getState().loaded) await useAdeSessions.getState().load()
  useAdeSessions.getState().newSession()
}
