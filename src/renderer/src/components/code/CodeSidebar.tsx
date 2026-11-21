import { useEffect, useMemo, useRef, useState, useSyncExternalStore, type JSX } from 'react'
import { useShallow } from 'zustand/react/shallow'
import {
  Archive,
  ChevronRight,
  CircleCheck,
  CircleDashed,
  Copy,
  Folder,
  FolderOpen,
  FolderPlus,
  GitMerge,
  GitPullRequest,
  GitPullRequestClosed,
  GitPullRequestDraft,
  ListFilter,
  Moon,
  PencilLine,
  Pin,
  PinOff,
  Plus,
  RotateCcw,
  SquarePen,
  SquareTerminal,
  Trash2
} from 'lucide-react'
import { ContextMenu } from '../Sidebar'
import { useCode } from './codeStore'
import { openNewSession, orderedGroups, paneLife, useAdeSessions } from './sessionsStore'
import { ADE_SORTS, useAdeList, watchFinishes, type AdeListSort, type AdeListView } from './adeList'
import { useBranchPr, useBranchPrsForAll } from './branchPrs'
import { DoneMark, FindTool, ProjectBadge, SidebarFind, ThreadLines, ThreadSection, useHeldOrder, useNow, WorkingFor } from '../threads'
import { MenuItem, Popover, useDisclosure } from '../ui'
import { useApp } from '../../state/store'
import { matchesSearch, threadOrder } from '@shared/threadList'
import { isAsleep } from '@shared/adeSleep'
import { AgentMark } from './terminal/TerminalWorkspace'
import { terminals } from './terminal/registry'
import { useTerminals } from './terminal/terminalStore'
import { RemoteSessionDialog } from './RemoteSessionDialog'
import { ArchiveSessionDialog, NewSessionDialog, RemoveProjectDialog, RemoveSessionDialog, RenameSessionDialog } from './SessionDialogs'
import { revealLabel } from '../../lib/files'
import { CLIPBOARD_FAILED, copyText } from '../../lib/clipboard'
import { notify } from '../Notice'
import { useEditorMenuItems } from './openInEditor'
import {
  ageLabel,
  folderName,
  sessionSubtitle,
  sessionTitle,
  splitArchived,
  visibleSessions,
  type AdeChanges,
  type AdeConversation,
  type AdeSession,
  type ProjectGroup
} from '@shared/adeSessions'
import { branchPrLabel, type BranchPr } from '@shared/adeReview'
import type { TerminalPaneSpec } from '@shared/terminals'

/**
 * The ADE's sidebar. By default its projects, the way T3 Code and Orca list
 * them: each a heading with its owner's picture that folds over its
 * sessions, and each session with its pull request and the tray of its
 * agents. Or, from the search row's view menu, one list: every session
 * tagged with its project, pinned ones first and then the most recently
 * active, with the sessions whose agents are working gathered under the list
 * (AdeDock) and the archived ones folded under those. A session's tray opens
 * the list of its agents and terminals (the open session's starts open).
 * Conversations that ended are not listed (they filled every folder with
 * sessions long closed); an empty session's page offers them to reopen
 * (TerminalWorkspace).
 */
export function CodeSidebar(): JSX.Element | null {
  const { cwd, recents, chooseFolder } = useCode(useShallow((s) => ({ cwd: s.cwd, recents: s.recents, chooseFolder: s.chooseFolder })))
  const { sessions, loaded, error } = useAdeSessions(useShallow((s) => ({ sessions: s.sessions, loaded: s.loaded, error: s.error })))
  const view = useAdeList((s) => s.view)
  const loadPanes = useTerminals((s) => s.load)

  // The sidebar mounts before the view on first open; either may start things off.
  useEffect(() => {
    void useCode
      .getState()
      .init()
      .then(() => useAdeSessions.getState().load())
    void loadPanes()
    watchFinishes()
  }, [loadPanes])

  // The folder the ADE reopened is a session even if it was never made one.
  useEffect(() => {
    if (loaded && cwd && !sessions.some((s) => s.cwd === cwd)) void useAdeSessions.getState().openFolder(cwd).catch(() => undefined)
  }, [loaded, cwd, sessions])

  useConversationsForAll(loaded)
  useBranchPrsForAll(loaded)

  if (error) return <div className="sidebar__empty">{error}</div>
  // With nothing open yet, New session on the search row still opens its dialog (SSH is in it).
  if (loaded && sessions.length === 0)
    return (
      <>
        <button type="button" className="nav-item ade-open-first" onClick={() => void chooseFolder()}>
          <span className="nav-item__icon">
            <FolderPlus size={15} strokeWidth={1.9} />
          </span>
          <span className="nav-item__label code-sidebar__muted">Open a project folder…</span>
        </button>
        <NewSessionDialog />
        <RemoteSessionDialog />
      </>
    )
  return (
    <>
      {view === 'projects' ? <ProjectTree recents={recents} activeCwd={cwd} /> : <SessionList activeCwd={cwd} />}
      <NewSessionDialog />
      <RemoteSessionDialog />
    </>
  )
}

/** The sessions, top to bottom, as the sidebar last listed them: what "open session 3" counts (useAdeKeys). */
let listed: AdeSession[] = []
export const listedSessions = (): AdeSession[] => listed

/**
 * The projects' sessions, a project's together, and the archived ones in a
 * group of their own. No heading over a project: each session carries its
 * project's logo, and its + and menu start another in the same project.
 */
function ProjectTree({ recents, activeCwd }: { recents: string[]; activeCwd: string | null }): JSX.Element {
  const sessions = useAdeSessions((s) => s.sessions)
  const query = useAdeList((s) => s.query)
  const conversations = useAdeSessions((s) => s.conversations)
  // Sorted once by how recently each project was opened, then kept in place (see keepOrder).
  const groups = useMemo(() => {
    const all = orderedGroups(sessions, recents)
    if (!query.trim()) return all
    return all
      .map((group) => ({ ...group, sessions: group.sessions.filter((session) => sessionMatches(session, query, conversations)) }))
      .filter((group) => group.sessions.length > 0)
  }, [sessions, recents, query, conversations])
  const archived = useMemo(() => splitArchived(sessions).archived.filter((session) => sessionMatches(session, query, conversations)), [sessions, query, conversations])
  // Nothing folds without a heading to fold it from, so a project folded before still shows.
  listed = visibleSessions(groups, {})
  if (groups.length === 0 && archived.length === 0) return <div className="sidebar__empty">No sessions match</div>
  return (
    <div className="ade-tree">
      {groups.map((group) => (
        <div key={group.project} className="ade-group" data-project={folderName(group.project)}>
          {group.sessions.map((session) => (
            <SessionRow key={session.id} session={session} active={session.cwd === activeCwd} group={group} />
          ))}
        </div>
      ))}
      {archived.length > 0 && <ArchivedGroup sessions={archived} />}
    </div>
  )
}

/** Whether the search finds a session: by its name, branch, folder, host or project, or the title of a conversation its agents had. */
function sessionMatches(session: AdeSession, query: string, conversations: Record<string, AdeConversation[]>): boolean {
  if (!query.trim()) return true
  return matchesSearch(query, [
    sessionTitle(session),
    session.branch,
    session.cwd,
    session.host,
    folderName(session.project),
    ...(conversations[session.cwd] ?? []).map((c) => c.title)
  ])
}

/**
 * Every session's past conversations, read once the sessions are known (one
 * folder at a time): they date the list's rows and the search reads their
 * titles. The open session's are read again as it's used (AgentList).
 */
function useConversationsForAll(loaded: boolean): void {
  const count = useAdeSessions((s) => s.sessions.length)
  useEffect(() => {
    if (!loaded) return
    let live = true
    void (async () => {
      const store = useAdeSessions.getState()
      for (const session of store.sessions) {
        if (!live) return
        if (session.host || session.missing || session.archivedAt !== undefined || useAdeSessions.getState().conversations[session.cwd]) continue
        await store.loadConversations(session.cwd).catch(() => undefined)
      }
    })()
    return () => {
      live = false
    }
  }, [loaded, count])
}

/** Work this fresh is an agent starting up, not a task: a session joins Working once it has gone on this long. */
const WORKING_AFTER_MS = 3_000

/** When the session's agents started the work they are doing (the earliest still at it), or 0 when none is working. Plain shells don't count: a dev server prints all day. */
function workingSince(panes: readonly TerminalPaneSpec[]): number {
  let since = 0
  for (const pane of panes) {
    if (pane.agent === 'shell') continue
    const info = terminals.infoOf(pane.id)
    if (info.status === 'working' && info.workingSince > 0) since = since ? Math.min(since, info.workingSince) : info.workingSince
  }
  return since
}

/** When anything last happened in a session: made, an agent's conversation, a terminal printing. */
function activityOf(session: AdeSession, panes: readonly TerminalPaneSpec[], conversations: readonly AdeConversation[] | undefined): number {
  let at = session.createdAt
  for (const conversation of conversations ?? []) at = Math.max(at, conversation.touched)
  for (const pane of panes) at = Math.max(at, terminals.infoOf(pane.id).lastData)
  return at
}

interface Threads {
  /** The list, in its order. */
  rows: AdeSession[]
  /** Working, longest at it first, with when each began. */
  working: { session: AdeSession; since: number }[]
  archived: AdeSession[]
  /** When each listed session was last active, by id. */
  at: Map<string, number>
  now: number
}

/** The sessions as the list shows them (SessionList, AdeDock): searched, split into the list, Working and Archived, and ordered. */
function useThreads(): Threads {
  const sessions = useAdeSessions((s) => s.sessions)
  const conversations = useAdeSessions((s) => s.conversations)
  const layout = useTerminals((s) => s.layout)
  const { query, sort, pinned } = useAdeList(useShallow((s) => ({ query: s.query, sort: s.sort, pinned: s.pinned })))
  useSyncExternalStore(terminals.subscribe, terminals.getVersion)
  const { live, archived } = splitArchived(sessions)
  const anyWorking = live.some((session) => workingSince(layout[session.cwd] ?? EMPTY_PANES) > 0)
  const now = useNow(anyWorking)
  const found = live.filter((session) => sessionMatches(session, query, conversations))
  const at = new Map(found.map((session) => [session.id, sort === 'created' ? session.createdAt : activityOf(session, layout[session.cwd] ?? EMPTY_PANES, conversations[session.cwd])]))
  const working: Threads['working'] = []
  const rest: AdeSession[] = []
  for (const session of found) {
    const since = session.missing ? 0 : workingSince(layout[session.cwd] ?? EMPTY_PANES)
    if (since > 0 && now - since >= WORKING_AFTER_MS) working.push({ session, since })
    else rest.push(session)
  }
  working.sort((a, b) => a.since - b.since)
  return {
    rows: threadOrder(rest, (session) => at.get(session.id) ?? 0, (session) => Boolean(pinned[session.id])),
    working,
    archived: archived.filter((session) => sessionMatches(session, query, conversations)),
    at,
    now
  }
}

/** The list, its order held still while the pointer is on it (useHeldOrder). */
function SessionList({ activeCwd }: { activeCwd: string | null }): JSX.Element {
  const threads = useThreads()
  const workingOpen = useAdeList((s) => s.workingOpen)
  const query = useAdeList((s) => s.query)
  const { order, hold } = useHeldOrder(threads.rows.map((session) => session.id))
  const byId = new Map(threads.rows.map((session) => [session.id, session]))
  const rows = order.map((id) => byId.get(id)!).filter(Boolean)
  listed = [...rows, ...(workingOpen ? threads.working.map((w) => w.session) : [])]

  if (rows.length === 0) {
    if (query.trim() && threads.working.length === 0 && threads.archived.length === 0) return <div className="sidebar__empty">No sessions match</div>
    if (threads.working.length > 0) return <div className="sidebar__empty">Every session is working</div>
    return <div className="sidebar__empty">{query.trim() ? 'No other sessions match' : 'No sessions open'}</div>
  }
  return (
    <div className="ade-threads" {...hold}>
      {rows.map((session) => (
        <SessionRow key={session.id} session={session} active={session.cwd === activeCwd} look="thread" at={threads.at.get(session.id) ?? 0} now={threads.now} />
      ))}
    </div>
  )
}

/**
 * Under the list, out of its scroll: the sessions whose agents are working,
 * each saying for how long, and the archived sessions, folded until asked
 * for. Only with the list view; the projects view keeps Archived in its tree.
 */
export function AdeDock(): JSX.Element | null {
  const view = useAdeList((s) => s.view)
  const loaded = useAdeSessions((s) => s.loaded)
  if (view !== 'list' || !loaded) return null
  return <Dock />
}

function Dock(): JSX.Element | null {
  const threads = useThreads()
  const cwd = useCode((s) => s.cwd)
  const { workingOpen, archivedOpen, setWorkingOpen, setArchivedOpen, query } = useAdeList(
    useShallow((s) => ({ workingOpen: s.workingOpen, archivedOpen: s.archivedOpen, setWorkingOpen: s.setWorkingOpen, setArchivedOpen: s.setArchivedOpen, query: s.query }))
  )
  if (threads.working.length === 0 && threads.archived.length === 0) return null
  // A search that only finds archived sessions shows them.
  const showArchived = archivedOpen || (query.trim() !== '' && threads.archived.length > 0)
  return (
    <div className="thread-dock scroll">
      {threads.working.length > 0 && (
        <ThreadSection label="Working" count={threads.working.length} open={workingOpen} onToggle={() => setWorkingOpen(!workingOpen)} id="ade-working">
          {threads.working.map(({ session, since }) => (
            <SessionRow key={session.id} session={session} active={session.cwd === cwd} look="thread" at={0} now={threads.now} working={since} />
          ))}
        </ThreadSection>
      )}
      {threads.archived.length > 0 && (
        <ThreadSection label="Archived" count={threads.archived.length} open={showArchived} onToggle={() => setArchivedOpen(!archivedOpen)} id="ade-archived">
          {threads.archived.map((session) => (
            <ArchivedRow key={session.id} session={session} look="thread" />
          ))}
        </ThreadSection>
      )}
    </div>
  )
}

/** The search row over the ADE's list: the search, then how the list is shown, open a project folder, and a new session. */
export function AdeFind(): JSX.Element {
  const { query, setQuery } = useAdeList(useShallow((s) => ({ query: s.query, setQuery: s.setQuery })))
  const chooseFolder = useCode((s) => s.chooseFolder)
  return (
    <SidebarFind value={query} onChange={setQuery} label="Search sessions and their conversations">
      <AdeViewMenu />
      <FindTool label="Open a project folder" onClick={() => void chooseFolder()}>
        <FolderPlus size={15} strokeWidth={1.8} />
      </FindTool>
      <FindTool label="New session" onClick={() => void openNewSession()}>
        <SquarePen size={15} strokeWidth={1.8} />
      </FindTool>
    </SidebarFind>
  )
}

const VIEWS: Record<AdeListView, string> = { projects: 'By project', list: 'One list' }

function AdeViewMenu(): JSX.Element {
  const anchor = useRef<HTMLButtonElement>(null)
  const menu = useDisclosure()
  const { view, sort, setView, setSort } = useAdeList(useShallow((s) => ({ view: s.view, sort: s.sort, setView: s.setView, setSort: s.setSort })))
  return (
    <>
      <FindTool ref={anchor} label="Sort and view" open={menu.open} onClick={menu.toggle}>
        <ListFilter size={15} strokeWidth={1.8} />
      </FindTool>
      <Popover anchor={anchor} open={menu.open} onClose={menu.close} placement="bottom-end" width={200}>
        <div className="menu__label">Show sessions</div>
        {(Object.entries(VIEWS) as [AdeListView, string][]).map(([value, title]) => (
          <MenuItem
            key={value}
            title={title}
            checked={value === view}
            onClick={() => {
              setView(value)
              menu.close()
            }}
          />
        ))}
        {view === 'list' && (
          <>
            <div className="menu__label">Sort by</div>
            {(Object.entries(ADE_SORTS) as [AdeListSort, string][]).map(([value, title]) => (
              <MenuItem
                key={value}
                title={title}
                checked={value === sort}
                onClick={() => {
                  setSort(value)
                  menu.close()
                }}
              />
            ))}
          </>
        )}
      </Popover>
    </>
  )
}

/** In the sidebar's folded-state record, but the other way round: set means the Archived group is open (it starts closed). */
const ARCHIVED_OPEN_KEY = '\u0000archived-open'

/** Archived sessions, folded away until asked for: each can be restored (its row, or its menu), or removed for good. */
function ArchivedGroup({ sessions }: { sessions: AdeSession[] }): JSX.Element {
  const open = useAdeSessions((s) => Boolean(s.collapsed[ARCHIVED_OPEN_KEY]))
  const toggleProject = useAdeSessions((s) => s.toggleProject)
  return (
    <div className="ade-project ade-archived">
      <div className="ade-project__head">
        <button type="button" className="ade-project__row" aria-expanded={open} onClick={() => toggleProject(ARCHIVED_OPEN_KEY)}>
          <Archive className="ade-project__icon" size={16} strokeWidth={1.8} />
          <span className="ade-project__name">Archived</span>
          <span className="ade-project__count" aria-label={`${sessions.length} archived ${sessions.length === 1 ? 'session' : 'sessions'}`}>
            {sessions.length}
          </span>
        </button>
      </div>
      {open && sessions.map((session) => <ArchivedRow key={session.id} session={session} />)}
    </div>
  )
}

function ArchivedRow({ session, look = 'tree' }: { session: AdeSession; look?: 'tree' | 'thread' }): JSX.Element {
  const restore = useAdeSessions((s) => s.restore)
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null)
  const [removing, setRemoving] = useState(false)
  const title = sessionTitle(session)
  const back = (): void => {
    void restore(session).then((failed) => failed && notify(failed, 'error'))
  }
  return (
    <div className="ade-session ade-session--archived" data-look={look}>
      <button
        type="button"
        className="ade-session__row"
        title={`Restore “${title}”`}
        onClick={back}
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
        {look === 'thread' ? (
          <ThreadLines
            project={folderName(session.project)}
            folder={session.host ? null : session.project}
            when={session.archivedAt ? ageLabel(session.archivedAt, Date.now()) : undefined}
            title={<span className="ade-session__title">{title}</span>}
            sub={session.branch ? <span className="ade-session__branch">{session.branch}</span> : undefined}
          />
        ) : (
          <span className="ade-session__text">
            <span className="ade-session__title">{title}</span>
            <span className="ade-session__branch">{[folderName(session.project), session.branch].filter(Boolean).join(' · ')}</span>
          </span>
        )}
      </button>
      <button type="button" className="ade-project__add ade-session__add" aria-label={`Restore ${title}`} title="Restore" onClick={back}>
        <RotateCcw size={13} strokeWidth={2} />
      </button>
      {menu && (
        <ContextMenu
          x={menu.x}
          y={menu.y}
          onClose={() => setMenu(null)}
          items={[
            { icon: <RotateCcw size={15} strokeWidth={1.9} />, label: 'Restore', action: back },
            { icon: <Trash2 size={15} strokeWidth={1.9} />, label: 'Remove session…', danger: true, action: () => setRemoving(true) }
          ]}
        />
      )}
      {removing && <RemoveSessionDialog session={session} onClose={() => setRemoving(false)} />}
    </div>
  )
}

const EMPTY_PANES: TerminalPaneSpec[] = []
const EMPTY_CONVERSATIONS: AdeConversation[] = []

/**
 * Where a session stands, from its terminals: something is printing,
 * something is open, it's asleep (it has panes, none running: they start
 * when it's shown), or there's nothing in it.
 */
type SessionState = 'working' | 'live' | 'asleep' | 'idle' | 'missing'

function useSessionPanes(session: AdeSession, active = false): { panes: TerminalPaneSpec[]; state: SessionState } {
  const panes = useTerminals((s) => s.layout[session.cwd] ?? EMPTY_PANES)
  useSyncExternalStore(terminals.subscribe, terminals.getVersion)
  if (session.missing) return { panes, state: 'missing' }
  const infos = panes.map((p) => terminals.infoOf(p.id))
  if (infos.some((i) => i.status === 'working')) return { panes, state: 'working' }
  if (infos.some((i) => i.known && i.status !== 'exited')) return { panes, state: 'live' }
  // The open session's panes are starting, not asleep.
  if (!active && isAsleep(panes.map((p) => paneLife(p.id)))) return { panes, state: 'asleep' }
  return { panes, state: 'idle' }
}

const STATE_LABEL: Record<SessionState, string> = {
  working: 'An agent is working',
  live: 'Open, waiting for you',
  asleep: 'Asleep: nothing running. Open it to start its terminals again',
  idle: 'Nothing running',
  missing: 'Its folder is gone'
}

/** How often an idle session's count is read again while Eaon is on screen: a commit or an edit elsewhere tells nobody. */
const CHANGES_EVERY_MS = 15_000

/**
 * What a session's agents have changed and not committed. Counted again when
 * its agents stop working (not while they type), when Eaon comes back to the
 * front, and every quarter minute while it is on screen, since the files may
 * have been edited, or committed from Review, without a word to the sidebar.
 */
function useChanges(session: AdeSession, state: SessionState): AdeChanges | null {
  const [changes, setChanges] = useState<AdeChanges | null>(null)
  useEffect(() => {
    if (!session.repo || session.missing || state === 'working') return
    let live = true
    const look = (): void => {
      window.api.ade.changes(session.cwd).then(
        (c) => live && setChanges((now) => (now && c && now.added === c.added && now.removed === c.removed && now.files === c.files ? now : c)),
        () => undefined
      )
    }
    look()
    // Asleep, nothing in it is editing files: one look, no git every quarter minute.
    if (state === 'asleep') {
      return () => {
        live = false
      }
    }
    const timer = window.setInterval(() => {
      if (document.visibilityState === 'visible') look()
    }, CHANGES_EVERY_MS)
    window.addEventListener('focus', look)
    return () => {
      live = false
      window.clearInterval(timer)
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

/**
 * In the tree, a session's project logo (its owner's picture, or a folder)
 * where a state dot was: what it's doing rides on the logo's corner, green
 * while its agents wait, a turning ring while one works, a moon asleep.
 */
function SessionLogo({ session, state }: { session: AdeSession; state: SessionState }): JSX.Element {
  return (
    <span className="ade-logo" data-state={state} role="img" aria-label={`${folderName(session.project)}: ${STATE_LABEL[state]}`} title={`${folderName(session.project)} · ${STATE_LABEL[state]}`}>
      <ProjectBadge name={folderName(session.project)} folder={session.host ? null : session.project} />
      {state === 'asleep' ? (
        <span className="ade-logo__state">
          <Moon size={7} strokeWidth={2.6} />
        </span>
      ) : (
        (state === 'live' || state === 'working') && <span className={`ade-logo__state${state === 'working' ? ' ade-spinner' : ''}`} />
      )}
    </span>
  )
}

/** The end of a list row's first line: what the session is doing, or how long ago anything happened in it. */
function SessionWhen({ session, state, working, done, at, now }: { session: AdeSession; state: SessionState; working: number; done: boolean; at: number; now: number }): JSX.Element | null {
  if (session.missing) return <span className="thread-status thread-status--missing">Folder gone</span>
  if (working > 0) return <WorkingFor since={working} />
  if (done) return <DoneMark />
  const age = at > 0 && now > 0 ? ageLabel(at, now) : null
  if (state === 'asleep')
    return (
      <span className="trow__age" title={STATE_LABEL.asleep}>
        <Moon size={10} strokeWidth={2.2} aria-label="Asleep" />
        {age}
      </span>
    )
  if (state === 'live')
    return (
      <span className="trow__age" title={STATE_LABEL.live}>
        <span className="trow__live" role="img" aria-label="Open, waiting for you" />
        {age}
      </span>
    )
  return age ? <span className="trow__age">{age}</span> : null
}

/** The end of a list row's branch line: what its agents changed and haven't committed, and its branch's pull request. */
function SessionMarks({ changes, pr }: { changes: AdeChanges | null; pr: BranchPr | null }): JSX.Element | null {
  const counted = changes && (changes.added > 0 || changes.removed > 0 || changes.files > 0)
  if (!counted && !pr) return null
  return (
    <>
      <ChangeCount changes={changes} />
      {pr && <PrMark pr={pr} />}
    </>
  )
}

/**
 * The branch's pull request, GitHub's way: open in green (amber while its
 * checks run, red when one fails), a draft in grey, merged in purple, closed
 * in red. What it stands for is in its title.
 */
function PrMark({ pr }: { pr: BranchPr }): JSX.Element {
  const Icon = pr.state === 'MERGED' ? GitMerge : pr.state === 'CLOSED' ? GitPullRequestClosed : pr.draft ? GitPullRequestDraft : GitPullRequest
  const tone = pr.state === 'MERGED' ? 'merged' : pr.state === 'CLOSED' ? 'closed' : pr.draft ? 'draft' : (pr.checks ?? 'open')
  const label = branchPrLabel(pr)
  return (
    <span className="ade-pr" data-tone={tone} role="img" aria-label={label} title={label}>
      <Icon size={13} strokeWidth={2} />
    </span>
  )
}

/**
 * A session: under its project's heading, its state, title and branch with
 * what it changed and its pull request, and the tray of its agents.
 *
 * `look` "thread" is the list's row (ThreadLines): its project's tag and name
 * with how long ago it was active (`at`, against `now`), or for how long it
 * has been working (`working`, when it began), its title, its branch, and
 * what it has changed with the agents in it at the end.
 */
function SessionRow({
  session,
  active,
  look = 'tree',
  at = 0,
  now = 0,
  working = 0,
  group
}: {
  session: AdeSession
  active: boolean
  look?: 'tree' | 'thread'
  at?: number
  now?: number
  working?: number
  /** In the tree: the session's project, for its menu's "Remove project". */
  group?: ProjectGroup
}): JSX.Element {
  const { show, sleep, sleepOthers, newSession } = useAdeSessions(
    useShallow((s) => ({ show: s.show, sleep: s.sleep, sleepOthers: s.sleepOthers, newSession: s.newSession }))
  )
  const { panes, state } = useSessionPanes(session, active)
  const changes = useChanges(session, state)
  const pr = useBranchPr(session)
  const { pinned, done, togglePin } = useAdeList(useShallow((s) => ({ pinned: Boolean(s.pinned[session.id]), done: Boolean(s.done[session.cwd]), togglePin: s.togglePin })))
  // The open session's agents are listed under it until folded; another's, once its tray is opened.
  const agentsOpen = useAdeList((s) => s.agentsOpen[session.cwd]) ?? active
  const setAgentsOpen = useAdeList((s) => s.setAgentsOpen)
  const agentsId = `ade-agents-${session.id}`
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null)
  const [dialog, setDialog] = useState<'rename' | 'archive' | 'remove' | 'remove-project' | null>(null)
  const editors = useEditorMenuItems(session.cwd, Boolean(menu))
  const title = sessionTitle(session)
  const thread = look === 'thread'
  const project = folderName(session.project)
  // In the list the project is on the row's first line, so the project folder's own session needs only its branch under it.
  // In the tree there's no heading to name the project, so a session in a worktree says it before its branch.
  const sub = thread
    ? session.missing
      ? null
      : session.cwd === session.project && !session.host
        ? session.branch
        : sessionSubtitle(session)
    : session.cwd !== session.project && !session.missing && !session.host
      ? `${project} · ${sessionSubtitle(session)}`
      : sessionSubtitle(session)
  // Another session in a repository's project: from the row's menu, and its + (there are no headings to start one from).
  const addSession = session.repo && !session.missing && !session.host ? () => newSession(session.project) : undefined
  const addLabel = `New session in ${project}`

  return (
    <div className="ade-session" data-look={look} data-active={active || undefined} data-state={state} data-project={project}>
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
        {thread ? (
          <ThreadLines
            project={project}
            folder={session.host ? null : session.project}
            pinned={pinned}
            when={<SessionWhen session={session} state={state} working={working} done={done && !active} at={at} now={now} />}
            title={<span className="ade-session__title">{title}</span>}
            sub={sub ? <span className="ade-session__branch">{sub}</span> : undefined}
            marks={<SessionMarks changes={changes} pr={pr} />}
          />
        ) : (
          <>
            <SessionLogo session={session} state={state} />
            <span className="ade-session__text">
              <span className="ade-session__title">{title}</span>
              {sub && <span className="ade-session__branch">{sub}</span>}
            </span>
            {(changes || pr) && (
              <span className="ade-session__end">
                <ChangeCount changes={changes} />
                {pr && <PrMark pr={pr} />}
              </span>
            )}
          </>
        )}
      </button>
      {addSession && (
        <button type="button" className="ade-project__add ade-session__add" aria-label={addLabel} title={addLabel} onClick={addSession}>
          <Plus size={14} strokeWidth={2} />
        </button>
      )}
      {!session.missing && panes.length > 0 && <AgentTray panes={panes} open={agentsOpen} controls={agentsId} onToggle={() => setAgentsOpen(session.cwd, !agentsOpen)} />}
      {agentsOpen && !session.missing && <AgentList session={session} id={agentsId} />}
      {menu && (
        <ContextMenu
          x={menu.x}
          y={menu.y}
          onClose={() => setMenu(null)}
          items={[
            ...(addSession ? [{ icon: <Plus size={15} strokeWidth={1.9} />, label: 'New session…', action: addSession }] : []),
            ...(thread
              ? [
                  pinned
                    ? { icon: <PinOff size={15} strokeWidth={1.9} />, label: 'Unpin', action: () => togglePin(session.id) }
                    : { icon: <Pin size={15} strokeWidth={1.9} />, label: 'Pin to the top', action: () => togglePin(session.id) }
                ]
              : []),
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
            ...(pr
              ? [{ icon: <GitPullRequest size={15} strokeWidth={1.9} />, label: `Open pull request #${pr.number}`, action: () => void window.api.app.openExternal(pr.url) }]
              : []),
            // A folder on another machine has nothing to show in Finder.
            ...(session.host ? [] : [{ icon: <Folder size={15} strokeWidth={1.9} />, label: revealLabel(), action: () => void window.api.app.showItem(session.cwd) }]),
            // Only a folder that is here, and not one that has gone.
            ...(session.missing ? [] : editors),
            ...(state === 'live' || state === 'working'
              ? [
                  {
                    icon: <Moon size={15} strokeWidth={1.9} />,
                    label: 'Sleep session',
                    action: () =>
                      void sleep(session).then(() =>
                        notify(`${title} is asleep. Its terminals closed to free memory; open it to start them again${state === 'working' ? ' (the agent that was working stopped)' : ''}.`, 'done')
                      )
                  }
                ]
              : []),
            {
              icon: <Moon size={15} strokeWidth={1.9} />,
              label: 'Sleep other sessions',
              action: () => void sleepOthers().then((n) => notify(n === 0 ? 'No other session is running.' : `${n === 1 ? '1 session' : `${n} sessions`} asleep.`, 'done'))
            },
            { icon: <Archive size={15} strokeWidth={1.9} />, label: 'Archive session…', action: () => setDialog('archive') },
            { icon: <Trash2 size={15} strokeWidth={1.9} />, label: 'Remove session…', danger: true, action: () => setDialog('remove') },
            // What the project's heading's menu did, now that there's no heading: all its sessions at once.
            ...(group && group.sessions.length > 1
              ? [{ icon: <Trash2 size={15} strokeWidth={1.9} />, label: 'Remove project from the ADE…', danger: true, action: () => setDialog('remove-project') }]
              : [])
          ]}
        />
      )}
      {dialog === 'archive' && <ArchiveSessionDialog session={session} onClose={() => setDialog(null)} />}
      {dialog === 'rename' && <RenameSessionDialog session={session} onClose={() => setDialog(null)} />}
      {dialog === 'remove' && <RemoveSessionDialog session={session} onClose={() => setDialog(null)} />}
      {dialog === 'remove-project' && group && <RemoveProjectDialog group={group} onClose={() => setDialog(null)} />}
    </div>
  )
}

interface AgentItem {
  key: string
  agent: TerminalPaneSpec['agent']
  /** With a plain shell: the program in its foreground (any CLI), shown by its initial. */
  program?: string
  task: string
  kind: PaneKind
  at: number
  onOpen: () => void
}

/** A pane's state: working, open and waiting, ended, or not started yet this run (it starts when shown). */
type PaneKind = 'working' | 'live' | 'exited' | 'past'

function paneKind(paneId: string): PaneKind {
  const info = terminals.infoOf(paneId)
  return info.status === 'working' ? 'working' : info.status === 'exited' ? 'exited' : info.known ? 'live' : 'past'
}

/** A session's agents and terminals, each opening its pane: under the open session, or under another's tray once opened. */
function AgentList({ session, id }: { session: AdeSession; id: string }): JSX.Element | null {
  const { panes } = useSessionPanes(session)
  const agents = useTerminals((s) => s.agents)
  const programs = useTerminals((s) => s.programs)
  const { conversations, held, loadConversations } = useAdeSessions(
    useShallow((s) => ({
      conversations: s.conversations[session.cwd] ?? EMPTY_CONVERSATIONS,
      held: s.paneConversations,
      loadConversations: s.loadConversations
    }))
  )
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
  const label = (agentId: string): string => agents.find((a) => a.id === agentId)?.label ?? agentId

  const items: AgentItem[] = panes.map((pane) => {
    const info = terminals.infoOf(pane.id)
    const conversation = byId.get(held[pane.id] ?? pane.resume ?? '')
    return {
      key: pane.id,
      agent: pane.agent,
      program: pane.agent === 'shell' ? programs[pane.id] : undefined,
      task: info.task ?? conversation?.title ?? `${pane.name} · ${pane.agent === 'shell' && programs[pane.id] ? programs[pane.id] : label(pane.agent)}`,
      kind: paneKind(pane.id),
      at: info.lastData || conversation?.touched || 0,
      onOpen: () => void useAdeSessions.getState().show(session).then(() => terminals.focus(pane.id))
    }
  })
  if (items.length === 0) return null
  return (
    <div className="ade-agents" id={id}>
      <div className="ade-agents__list">
        {items.map((item) => (
          <button key={item.key} type="button" className="ade-agent" data-kind={item.kind} title={item.task} onClick={item.onOpen}>
            <AgentStatus kind={item.kind} />
            <AgentMark agent={item.agent} program={item.program} size={15} />
            <span className="ade-agent__task">{item.task}</span>
            <span className="ade-agent__age">{item.kind === 'working' ? 'now' : item.at ? ageLabel(item.at, now) : ''}</span>
          </button>
        ))}
      </div>
    </div>
  )
}

const KIND_LABEL: Record<PaneKind, string> = {
  working: 'Working',
  live: 'Waiting for you',
  exited: 'Ended',
  past: 'Starts when you show it'
}

function AgentStatus({ kind }: { kind: PaneKind }): JSX.Element {
  if (kind === 'working') return <span className="ade-agent__status ade-spinner" role="img" aria-label={KIND_LABEL[kind]} />
  if (kind === 'exited') return <CircleDashed className="ade-agent__status" size={14} strokeWidth={2} role="img" aria-label={KIND_LABEL[kind]} />
  return <CircleCheck className="ade-agent__status" size={14} strokeWidth={2} role="img" aria-label={KIND_LABEL[kind]} />
}

/** The tray's groups, in this order: the ones working first. */
const TRAY_KINDS: PaneKind[] = ['working', 'live', 'past', 'exited']
const TRAY_SAID: Record<PaneKind, string> = { working: 'working', live: 'waiting for you', past: 'not started', exited: 'ended' }
/** A group shows this many marks; past one more, the rest are a count. */
const TRAY_MARKS = 3

/**
 * Along the bottom of a session's row: its agents, gathered by what they're
 * doing (working, waiting for you, not started, ended), each group its state
 * and the agents' marks, then its terminals' count. It opens and folds the
 * list of them under it (AgentList). Open, the list shows each one, so the
 * tray is only its heading: how many there are, and the chevron to fold it.
 */
function AgentTray({ panes, open, controls, onToggle }: { panes: readonly TerminalPaneSpec[]; open: boolean; controls: string; onToggle: () => void }): JSX.Element {
  const agents = useTerminals((s) => s.agents)
  const name = (agentId: string): string => agents.find((a) => a.id === agentId)?.label ?? agentId
  const kinds = new Map(panes.map((pane) => [pane.id, paneKind(pane.id)]))
  const groups = TRAY_KINDS.map((kind) => ({ kind, panes: panes.filter((pane) => pane.agent !== 'shell' && kinds.get(pane.id) === kind) })).filter((group) => group.panes.length > 0)
  const shells = panes.filter((pane) => pane.agent === 'shell').length
  const said = [
    ...groups.map((group) => `${group.panes.length} ${TRAY_SAID[group.kind]}`),
    ...(shells > 0 ? [`${shells} ${shells === 1 ? 'terminal' : 'terminals'}`] : [])
  ].join(', ')
  const agentCount = panes.length - shells
  const label = agentCount > 0 ? `${agentCount === 1 ? 'Agent' : 'Agents'}: ${said}` : `Terminals: ${shells}`
  if (open) {
    const heading = [
      agentCount > 0 && `${agentCount} ${agentCount === 1 ? 'agent' : 'agents'}`,
      shells > 0 && `${shells} ${shells === 1 ? 'terminal' : 'terminals'}`
    ]
      .filter(Boolean)
      .join(' · ')
    return (
      <button type="button" className="ade-tray" aria-expanded aria-controls={controls} aria-label={label} title={label} onClick={onToggle}>
        <span className="ade-tray__heading">{heading}</span>
        <ChevronRight className="ade-tray__chev" size={14} strokeWidth={2} />
      </button>
    )
  }
  return (
    <button type="button" className="ade-tray" aria-expanded={false} aria-label={label} title={label} onClick={onToggle}>
      {groups.map((group) => {
        const shown = group.panes.length > TRAY_MARKS ? group.panes.slice(0, TRAY_MARKS - 1) : group.panes
        return (
          <span key={group.kind} className="ade-tray__group" data-kind={group.kind} title={`${KIND_LABEL[group.kind]}: ${group.panes.map((pane) => name(pane.agent)).join(', ')}`}>
            <TrayStatus kind={group.kind} />
            <span className="ade-tray__marks">
              {shown.map((pane) => (
                <AgentMark key={pane.id} agent={pane.agent} size={13} />
              ))}
            </span>
            {group.panes.length > shown.length && <span className="ade-tray__more">+{group.panes.length - shown.length}</span>}
          </span>
        )
      })}
      {shells > 0 && (
        <span className="ade-tray__group" data-kind="shell" title={`${shells} ${shells === 1 ? 'terminal' : 'terminals'}`}>
          <SquareTerminal size={13} strokeWidth={2} />
          {shells > 1 && <span className="ade-tray__more">{shells}</span>}
        </span>
      )}
      <ChevronRight className="ade-tray__chev" size={14} strokeWidth={2} />
    </button>
  )
}

function TrayStatus({ kind }: { kind: PaneKind }): JSX.Element {
  if (kind === 'working') return <span className="ade-tray__status ade-spinner" aria-hidden="true" />
  if (kind === 'live') return <CircleCheck className="ade-tray__status" size={13} strokeWidth={2.2} aria-hidden="true" />
  if (kind === 'exited') return <CircleDashed className="ade-tray__status" size={13} strokeWidth={2.2} aria-hidden="true" />
  return <span className="ade-tray__status ade-tray__dot" aria-hidden="true" />
}
