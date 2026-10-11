import { useEffect, useMemo, useRef, useState, useSyncExternalStore, type JSX } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { ChevronDown, CircleCheck, CircleDashed, Copy, Folder, FolderOpen, FolderPlus, PencilLine, Plus, Trash2 } from 'lucide-react'
import { ContextMenu } from '../Sidebar'
import { useCode } from './codeStore'
import { useAdeSessions } from './sessionsStore'
import { AgentMark } from './terminal/TerminalWorkspace'
import { terminals } from './terminal/registry'
import { useTerminals } from './terminal/terminalStore'
import { RemoteSessionDialog } from './RemoteSessionDialog'
import { NewSessionDialog, RemoveProjectDialog, RemoveSessionDialog, RenameSessionDialog } from './SessionDialogs'
import { revealLabel } from '../../lib/files'
import { CLIPBOARD_FAILED, copyText } from '../../lib/clipboard'
import { notify } from '../Notice'
import {
  ageLabel,
  folderName,
  groupSessions,
  isSoloProject,
  keepOrder,
  sessionSubtitle,
  sessionTitle,
  type AdeChanges,
  type AdeConversation,
  type AdeSession,
  type ProjectGroup
} from '@shared/adeSessions'
import type { TerminalPaneSpec } from '@shared/terminals'

/**
 * The ADE's sidebar: its projects, each with its sessions, and the open
 * session's agents — the terminals open in it. Conversations that ended are
 * not listed here (they filled every folder with sessions long closed); an
 * empty session's page offers them to reopen (TerminalWorkspace).
 */
export function CodeSidebar(): JSX.Element | null {
  const { cwd, recents, chooseFolder } = useCode(useShallow((s) => ({ cwd: s.cwd, recents: s.recents, chooseFolder: s.chooseFolder })))
  const { sessions, loaded, error } = useAdeSessions(useShallow((s) => ({ sessions: s.sessions, loaded: s.loaded, error: s.error })))
  const loadPanes = useTerminals((s) => s.load)

  // The sidebar mounts before the view on first open; either may start things off.
  useEffect(() => {
    void useCode
      .getState()
      .init()
      .then(() => useAdeSessions.getState().load())
    void loadPanes()
  }, [loadPanes])

  // The folder the ADE reopened is a session even if it was never made one.
  useEffect(() => {
    if (loaded && cwd && !sessions.some((s) => s.cwd === cwd)) void useAdeSessions.getState().openFolder(cwd).catch(() => undefined)
  }, [loaded, cwd, sessions])

  // Sorted once by how recently each project was opened, then kept in place (see keepOrder).
  const shown = useRef<string[]>([])
  const groups = useMemo(() => {
    const next = keepOrder(groupSessions(sessions, recents), shown.current)
    shown.current = next.map((g) => g.project)
    return next
  }, [sessions, recents])

  return (
    <>
      <div className="sidebar__section sidebar__section--action">
        <span>Sessions</span>
        <button type="button" className="sidebar__section-btn" aria-label="Open a project folder" title="Open a project folder" onClick={() => void chooseFolder()}>
          <FolderPlus size={14} strokeWidth={1.9} />
        </button>
      </div>
      {error && <div className="sidebar__empty">{error}</div>}
      {loaded && groups.length === 0 ? (
        <button type="button" className="nav-item" onClick={() => void chooseFolder()}>
          <span className="nav-item__icon">
            <FolderPlus size={15} strokeWidth={1.9} />
          </span>
          <span className="nav-item__label code-sidebar__muted">Open a project folder…</span>
        </button>
      ) : (
        <div className="ade-tree">
          {groups.map((group) => (
            <ProjectRow key={group.project} group={group} activeCwd={cwd} />
          ))}
        </div>
      )}
      <NewSessionDialog />
      <RemoteSessionDialog />
    </>
  )
}

function ProjectRow({ group, activeCwd }: { group: ProjectGroup; activeCwd: string | null }): JSX.Element {
  const collapsed = useAdeSessions((s) => Boolean(s.collapsed[group.project]))
  const { toggleProject, newSession, openFolder } = useAdeSessions(
    useShallow((s) => ({ toggleProject: s.toggleProject, newSession: s.newSession, openFolder: s.openFolder }))
  )
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null)
  const [removing, setRemoving] = useState(false)
  const name = folderName(group.project)
  // Just its own folder: one row, not a heading over a row that repeats it.
  if (isSoloProject(group)) {
    const session = group.sessions[0]
    return (
      <div className="ade-project ade-project--solo">
        <SessionRow session={session} active={session.cwd === activeCwd} solo onNewSession={session.repo ? () => newSession(group.project) : undefined} />
      </div>
    )
  }
  return (
    <div className="ade-project">
      <div className="ade-project__head">
        <button
          type="button"
          className="ade-project__row"
          aria-expanded={!collapsed}
          title={group.project}
          onClick={() => toggleProject(group.project)}
          onContextMenu={(e) => {
            e.preventDefault()
            setMenu({ x: e.clientX, y: e.clientY })
          }}
          onKeyDown={(e) => {
            if (e.key === 'ContextMenu' || (e.shiftKey && e.key === 'F10')) {
              e.preventDefault()
              const rect = e.currentTarget.getBoundingClientRect()
              setMenu({ x: rect.left + 12, y: rect.bottom })
            }
          }}
        >
          {collapsed ? <Folder className="ade-project__icon" size={16} strokeWidth={1.8} /> : <FolderOpen className="ade-project__icon" size={16} strokeWidth={1.8} />}
          <span className="ade-project__name">{name}</span>
          <span className="ade-project__count" aria-label={`${group.sessions.length} ${group.sessions.length === 1 ? 'session' : 'sessions'}`}>
            {group.sessions.length}
          </span>
        </button>
        <button type="button" className="ade-project__add" aria-label={`New session in ${name}`} title={`New session in ${name}`} onClick={() => newSession(group.project)}>
          <Plus size={14} strokeWidth={2} />
        </button>
      </div>
      {!collapsed && group.sessions.map((session) => <SessionRow key={session.id} session={session} active={session.cwd === activeCwd} />)}
      {menu && (
        <ContextMenu
          x={menu.x}
          y={menu.y}
          onClose={() => setMenu(null)}
          items={[
            { icon: <Plus size={15} strokeWidth={1.9} />, label: 'New session…', action: () => newSession(group.project) },
            { icon: <FolderOpen size={15} strokeWidth={1.9} />, label: 'Open the project folder', action: () => void openFolder(group.project) },
            { icon: <Folder size={15} strokeWidth={1.9} />, label: revealLabel(), action: () => void window.api.app.showItem(group.project) },
            { icon: <Trash2 size={15} strokeWidth={1.9} />, label: 'Remove from the ADE…', danger: true, action: () => setRemoving(true) }
          ]}
        />
      )}
      {removing && <RemoveProjectDialog group={group} onClose={() => setRemoving(false)} />}
    </div>
  )
}

const EMPTY_PANES: TerminalPaneSpec[] = []
const EMPTY_CONVERSATIONS: AdeConversation[] = []

/** Where a session stands, from its terminals: something is printing, something is open, or nothing runs. */
type SessionState = 'working' | 'live' | 'idle' | 'missing'

function useSessionPanes(session: AdeSession): { panes: TerminalPaneSpec[]; state: SessionState } {
  const panes = useTerminals((s) => s.layout[session.cwd] ?? EMPTY_PANES)
  useSyncExternalStore(terminals.subscribe, terminals.getVersion)
  if (session.missing) return { panes, state: 'missing' }
  const infos = panes.map((p) => terminals.infoOf(p.id))
  if (infos.some((i) => i.status === 'working')) return { panes, state: 'working' }
  // A pane this window hasn't shown since launch has no shell yet: it starts when shown.
  if (infos.some((i) => i.known && i.status !== 'exited')) return { panes, state: 'live' }
  return { panes, state: 'idle' }
}

const STATE_LABEL: Record<SessionState, string> = {
  working: 'An agent is working',
  live: 'Open, waiting for you',
  idle: 'Nothing running',
  missing: 'Its folder is gone'
}

/**
 * What a session's agents have changed and not committed. Counted again when
 * its agents stop working (not while they type) and when Eaon comes back to
 * the front, since the files may have been edited elsewhere.
 */
function useChanges(session: AdeSession, state: SessionState): AdeChanges | null {
  const [changes, setChanges] = useState<AdeChanges | null>(null)
  useEffect(() => {
    if (!session.repo || session.missing || state === 'working') return
    let live = true
    const look = (): void => {
      window.api.ade.changes(session.cwd).then(
        (c) => live && setChanges(c),
        () => undefined
      )
    }
    look()
    window.addEventListener('focus', look)
    return () => {
      live = false
      window.removeEventListener('focus', look)
    }
  }, [session.cwd, session.repo, session.missing, state])
  return changes
}

function ChangeCount({ changes }: { changes: AdeChanges | null }): JSX.Element | null {
  if (!changes || (changes.added === 0 && changes.removed === 0 && changes.files === 0)) return null
  const files = `${changes.files} ${changes.files === 1 ? 'file' : 'files'}`
  return (
    <span className="ade-session__diff" title={`${files} changed, not committed: ${changes.added} lines added, ${changes.removed} removed`}>
      <span className="ade-session__diff-add">+{changes.added}</span>
      <span className="ade-session__diff-del">−{changes.removed}</span>
    </span>
  )
}

function StateMark({ state }: { state: SessionState }): JSX.Element {
  return <span className="ade-state" data-state={state} role="img" aria-label={STATE_LABEL[state]} title={STATE_LABEL[state]} />
}

/**
 * A session. `solo`: it stands for its whole project (a project that is just
 * its own folder), so the line under it is only its branch, and it offers New
 * session itself when the project is a repository.
 */
function SessionRow({ session, active, solo = false, onNewSession }: { session: AdeSession; active: boolean; solo?: boolean; onNewSession?: () => void }): JSX.Element {
  const show = useAdeSessions((s) => s.show)
  const { state } = useSessionPanes(session)
  const changes = useChanges(session, state)
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null)
  const [dialog, setDialog] = useState<'rename' | 'remove' | null>(null)
  const title = sessionTitle(session)
  const sub = solo && !session.missing && !session.host ? session.branch : sessionSubtitle(session)

  return (
    <div className="ade-session" data-active={active || undefined} data-state={state} data-solo={solo || undefined}>
      <button
        type="button"
        className="ade-session__row"
        aria-current={active ? 'true' : undefined}
        title={session.cwd}
        onClick={() => {
          if (session.missing) {
            notify(`${session.cwd} isn’t there any more. Bring the folder back, or remove the session from its menu.`, 'error')
            return
          }
          // Shown even when it's the active one: from Pull requests or Linear, that's the way back.
          void show(session)
        }}
        onContextMenu={(e) => {
          e.preventDefault()
          setMenu({ x: e.clientX, y: e.clientY })
        }}
        onKeyDown={(e) => {
          if (e.key === 'ContextMenu' || (e.shiftKey && e.key === 'F10')) {
            e.preventDefault()
            const rect = e.currentTarget.getBoundingClientRect()
            setMenu({ x: rect.left + 12, y: rect.bottom })
          }
        }}
      >
        <StateMark state={state} />
        <span className="ade-session__text">
          <span className="ade-session__title">{title}</span>
          {sub && <span className="ade-session__branch">{sub}</span>}
        </span>
        <ChangeCount changes={changes} />
      </button>
      {onNewSession && (
        <button type="button" className="ade-project__add ade-session__add" aria-label={`New session in ${title}`} title={`New session in ${title}`} onClick={onNewSession}>
          <Plus size={14} strokeWidth={2} />
        </button>
      )}
      {active && !session.missing && <AgentList session={session} />}
      {menu && (
        <ContextMenu
          x={menu.x}
          y={menu.y}
          onClose={() => setMenu(null)}
          items={[
            ...(onNewSession ? [{ icon: <Plus size={15} strokeWidth={1.9} />, label: 'New session…', action: onNewSession }] : []),
            { icon: <PencilLine size={15} strokeWidth={1.9} />, label: 'Rename', action: () => setDialog('rename') },
            ...(session.branch
              ? [
                  {
                    icon: <Copy size={15} strokeWidth={1.9} />,
                    label: 'Copy branch name',
                    action: () => void copyText(session.branch ?? '').then((ok) => notify(ok ? 'Branch name copied.' : CLIPBOARD_FAILED, ok ? 'done' : 'error'))
                  }
                ]
              : []),
            // A folder on another machine has nothing to show in Finder.
            ...(session.host ? [] : [{ icon: <Folder size={15} strokeWidth={1.9} />, label: revealLabel(), action: () => void window.api.app.showItem(session.cwd) }]),
            { icon: <Trash2 size={15} strokeWidth={1.9} />, label: 'Remove session…', danger: true, action: () => setDialog('remove') }
          ]}
        />
      )}
      {dialog === 'rename' && <RenameSessionDialog session={session} onClose={() => setDialog(null)} />}
      {dialog === 'remove' && <RemoveSessionDialog session={session} onClose={() => setDialog(null)} />}
    </div>
  )
}

interface AgentItem {
  key: string
  agent: TerminalPaneSpec['agent']
  task: string
  /** working, open and waiting, ended, or not started yet this run (it starts when shown). */
  kind: 'working' | 'live' | 'exited' | 'past'
  at: number
  onOpen: () => void
}

function AgentList({ session }: { session: AdeSession }): JSX.Element | null {
  const { panes } = useSessionPanes(session)
  const agents = useTerminals((s) => s.agents)
  const { conversations, held, loadConversations } = useAdeSessions(
    useShallow((s) => ({
      conversations: s.conversations[session.cwd] ?? EMPTY_CONVERSATIONS,
      held: s.paneConversations,
      loadConversations: s.loadConversations
    }))
  )
  const [folded, setFolded] = useState(false)
  const [now, setNow] = useState(() => Date.now())

  // The folder's conversations give each pane its title; kept current, with the ages, while on screen.
  useEffect(() => {
    void loadConversations(session.cwd)
    const tick = window.setInterval(() => {
      setNow(Date.now())
      void loadConversations(session.cwd)
    }, 30_000)
    return () => window.clearInterval(tick)
  }, [session.cwd, panes.length, loadConversations])

  const byId = new Map(conversations.map((c) => [c.id, c]))
  const label = (id: string): string => agents.find((a) => a.id === id)?.label ?? id

  const live: AgentItem[] = panes.map((pane) => {
    const info = terminals.infoOf(pane.id)
    const conversation = byId.get(held[pane.id] ?? pane.resume ?? '')
    const kind: AgentItem['kind'] = info.status === 'working' ? 'working' : info.status === 'exited' ? 'exited' : info.known ? 'live' : 'past'
    return {
      key: pane.id,
      agent: pane.agent,
      task: info.task ?? conversation?.title ?? `${pane.name} · ${label(pane.agent)}`,
      kind,
      at: info.lastData || conversation?.touched || 0,
      onOpen: () => void useAdeSessions.getState().show(session).then(() => terminals.focus(pane.id))
    }
  })
  const items = live
  const total = items.length
  if (total === 0) return null

  return (
    <div className="ade-agents">
      <button type="button" className="ade-agents__head" aria-expanded={!folded} onClick={() => setFolded(!folded)}>
        <span>
          {total} {total === 1 ? 'agent' : 'agents'}
        </span>
        <ChevronDown size={14} strokeWidth={2} className="ade-agents__chevron" />
      </button>
      {!folded && (
        <div className="ade-agents__list">
          {items.map((item) => (
            <button key={item.key} type="button" className="ade-agent" data-kind={item.kind} title={item.task} onClick={item.onOpen}>
              <AgentStatus kind={item.kind} />
              <AgentMark agent={item.agent} size={15} />
              <span className="ade-agent__task">{item.task}</span>
              <span className="ade-agent__age">{item.kind === 'working' ? 'now' : item.at ? ageLabel(item.at, now) : ''}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

const KIND_LABEL: Record<AgentItem['kind'], string> = {
  working: 'Working',
  live: 'Waiting for you',
  exited: 'Ended',
  past: 'Starts when you show it'
}

function AgentStatus({ kind }: { kind: AgentItem['kind'] }): JSX.Element {
  if (kind === 'working') return <span className="ade-agent__status ade-spinner" role="img" aria-label={KIND_LABEL[kind]} />
  if (kind === 'exited') return <CircleDashed className="ade-agent__status" size={14} strokeWidth={2} role="img" aria-label={KIND_LABEL[kind]} />
  return <CircleCheck className="ade-agent__status" size={14} strokeWidth={2} role="img" aria-label={KIND_LABEL[kind]} />
}

