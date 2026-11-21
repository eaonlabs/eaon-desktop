import { DotMatrix, Spinner, type DotState } from './Spinner'
import { memo, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { useShallow } from 'zustand/react/shallow'
import { Archive, ArrowDownWideNarrow, ArrowRight, AtSign, Boxes, CandlestickChart, ChevronDown, ChevronRight, ChevronsDownUp, CircleAlert, Clock3, FolderInput, FolderOpen, FolderPlus, GitPullRequest, LibraryBig, ListFilter, ListTodo, Monitor, PanelLeft, PencilLine, Pin, PinOff, Plus, ScrollText, Settings as SettingsIcon, SquarePen, Trash2 } from 'lucide-react'
import { useApp, useWorkspaceKind, type ChatListItem } from '../state/store'
import { DownloadsButton } from './DownloadsPanel'
import { WindowTitle } from './WindowTitle'
import { FadingBody } from './FadingBody'
import { UsageRings } from './UsageRings'
import { AdeDock, AdeFind, CodeSidebar } from './code/CodeSidebar'
import { COMPUTERS_IN_SIDEBAR } from './computers/ComputersPage'
import { WorkersNav } from './workers/WorkersSidebar'
import { useTradingOn } from './trading/useTradingOn'
import { WorkersSearchButton } from './workers/WorkerThreads'
import { FolderMenu } from './composer/ComposerBits'
import { notify } from './Notice'
import { CHAT_SORTS, PROJECT_SORTS, SIDEBAR_IS_NEW, sortChats, sortProjects, useChatSidebar, type ChatSort, type ChatView, type ProjectSort } from './chatSidebar'
import { DoneMark, FindTool, ProjectBadge, SidebarFind, ThreadLines, ThreadSection, useHeldOrder, useNow, WorkingFor } from './threads'
import { matchesSearch } from '@shared/threadList'
import { ageLabel } from '@shared/adeSessions'
import { ConfirmDialog, MenuItem, Modal, Popover, useDisclosure } from './ui'
import { RemoteFolderDialog } from './RemoteFolderDialog'
import type { Project } from '@shared/types'
import { isRemote, remoteDisplay, type SshHost } from '@shared/adeRemote'

export function Sidebar(): JSX.Element {
  const { sidebarOpen, toggleSidebar, goForward } = useApp(
    useShallow((s) => ({ sidebarOpen: s.sidebarOpen, toggleSidebar: s.toggleSidebar, goForward: s.goForward }))
  )
  const canGoForward = useApp((s) => s.canGoForward())

  const kind = useWorkspaceKind()
  // Inert, not only aria-hidden: a hidden sidebar's buttons were still reached
  // by Tab, invisibly. (React 18 has no `inert` prop, so it is set directly.)
  const content = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (content.current) content.current.inert = !sidebarOpen
  }, [sidebarOpen])
  return (
    <aside className="sidebar" data-open={sidebarOpen}>
      <div ref={content} className="sidebar__content" aria-hidden={!sidebarOpen}>
      <div className="sidebar__panel">
      <div className="titlebar">
        <WindowTitle />
        <DownloadsButton />
        {/* Chat and the ADE search from the row over their lists. */}
        {kind === 'workers' && <WorkersSearchButton />}
        <button className="icon-btn" onClick={toggleSidebar} title="Hide sidebar" aria-label="Hide sidebar">
          <PanelLeft size={16} strokeWidth={1.9} />
        </button>
        {/* Only when it can actually go somewhere — a permanently-dead arrow
            (as a disabled Back button would be) is not worth showing. */}
        {canGoForward && (
          <button className="icon-btn" onClick={goForward} title="Forward" aria-label="Forward">
            <ArrowRight size={16} strokeWidth={1.9} />
          </button>
        )}
      </div>

      {/* Each tab's places stay put; its list scrolls under them and fades at its edges.
          Chat's and the ADE's other places are icons along the foot. */}
      <div className="sidebar__menu" data-kind={kind}>
        {kind === 'workers' ? <WorkersNav part="menu" /> : kind === 'code' ? <AdeFind /> : <ChatMenu />}
      </div>
      <FadingBody key={kind}>{kind === 'workers' ? <WorkersNav part="list" /> : kind === 'code' ? <CodeSidebar /> : <ChatNav />}</FadingBody>
      {kind === 'code' ? <AdeDock /> : kind !== 'workers' && <ChatDock />}
      {/* The ADE has the plans' rings in its header already; Chat has them on its row of places. */}
      {kind !== 'workers' && <FootBar ade={kind === 'code'} />}
      </div>
      </div>
    </aside>
  )
}

/** One row of the sidebar's top nav. */
export function NavItem({
  icon,
  label,
  active,
  onClick,
  trail
}: {
  icon: ReactNode
  label: string
  active?: boolean
  onClick: () => void
  trail?: ReactNode
}): JSX.Element {
  return (
    <button className="nav-item" data-active={active || undefined} onClick={onClick}>
      <span className="nav-item__icon">{icon}</span>
      <span className="nav-item__label">{label}</span>
      {trail}
    </button>
  )
}

const ICON = { size: 16, strokeWidth: 1.9 } as const

/**
 * Chat's and the ADE's places along the sidebar's foot, as a row of icons:
 * Settings, Pull requests and Issues (and in the ADE Computers, where they're
 * on). Chat has the two plans' usage rings at its other end; the ADE has them
 * in its header. Their names are in the tooltips, and for screen readers.
 */
function FootBar({ ade }: { ade: boolean }): JSX.Element {
  const { view, setView, setSettingsPage } = useApp(useShallow((s) => ({ view: s.view, setView: s.setView, setSettingsPage: s.setSettingsPage })))
  const places: { label: string; icon: JSX.Element; active: boolean; go: () => void }[] = [
    { label: 'Settings', icon: <SettingsIcon size={16} strokeWidth={1.8} />, active: false, go: () => setSettingsPage('general') },
    { label: 'Pull requests', icon: <GitPullRequest size={16} strokeWidth={1.8} />, active: view === 'pull-requests', go: () => setView('pull-requests') },
    { label: 'Issues', icon: <ListTodo size={16} strokeWidth={1.8} />, active: view === 'issues', go: () => setView('issues') },
    ...(ade && COMPUTERS_IN_SIDEBAR
      ? [{ label: 'Computers', icon: <Monitor size={16} strokeWidth={1.8} />, active: view === 'computers', go: () => setView('computers') }]
      : [])
  ]
  return (
    <nav className="foot-bar" aria-label="Places">
      {places.map((place) => (
        <button
          key={place.label}
          type="button"
          className="icon-btn foot-bar__btn"
          title={place.label}
          aria-current={place.active ? 'page' : undefined}
          data-active={place.active || undefined}
          onClick={place.go}
        >
          {place.icon}
          <span className="foot-bar__label">{place.label}</span>
        </button>
      ))}
      {!ade && (
        <>
          <span className="foot-bar__spacer" />
          <UsageRings placement="top-end" />
        </>
      )}
    </nav>
  )
}

/**
 * Chat mode, laid out like the design spec's sidebar: its four destinations,
 * then Projects, then Chats, each under its own heading. Scheduled tasks
 * moved to the Workers tab — things that run on their own live together
 * there.
 */
/** Chat's places, which stay put above its projects and chats. */
function ChatMenu(): JSX.Element {
  const { view, setView, setModelsRepo, newChat } = useApp(
    useShallow((s) => ({ view: s.view, setView: s.setView, setModelsRepo: s.setModelsRepo, newChat: s.newChat }))
  )
  const { on: tradingOn } = useTradingOn()
  return (
    <>
      <NavItem icon={<SquarePen {...ICON} />} label="New chat" onClick={() => newChat()} />
      <NavItem
        icon={<Boxes {...ICON} />}
        label="Models"
        active={view === 'models'}
        onClick={() => {
          setView('models')
          setModelsRepo(null)
        }}
      />
      <NavItem icon={<LibraryBig {...ICON} />} label="Library" active={view === 'library'} onClick={() => setView('library')} />
      {tradingOn && <NavItem icon={<CandlestickChart {...ICON} />} label="Trading" active={view === 'trading'} onClick={() => setView('trading')} />}
      <NavItem
        icon={<AtSign {...ICON} />}
        label="Plugins"
        active={view === 'plugins' || view === 'integrations'}
        onClick={() => setView('plugins')}
      />
      <ChatFind />
    </>
  )
}

/**
 * Chat's list, the part of the sidebar that scrolls: Projects, each folding
 * over its chats, over Chats (ChatTree); or the chats in projects as one
 * list, each tagged with its project, over Chats (ChatThreads), as the
 * search row's view menu has it. A search always lists what it finds as one list.
 */
function ChatNav(): JSX.Element {
  const view = useChatSidebar((s) => s.view)
  const searching = useChatSidebar((s) => s.query.trim() !== '')
  return view === 'list' || searching ? <ChatThreads /> : <ChatTree />
}

/** How long a reply runs before its chat joins Working under the list: a quick answer stays where it is. */
const CHAT_WORKING_AFTER_MS = 10_000

interface ChatThreadsData {
  /** Chats in a project, as the list's rows. */
  rows: ChatListItem[]
  /** Chats outside a project, for the Chats section under the list. */
  loose: ChatListItem[]
  /** Replies running past CHAT_WORKING_AFTER_MS, longest first, with when each began. */
  working: { chat: ChatListItem; since: number }[]
  /** Each chat's project's name, by chat id; none for a chat outside a project. */
  project: Record<string, string>
  /** Each project chat's project, by chat id, and its folder (for its owner's picture) where it has one. */
  projectId: Record<string, string>
  folder: Record<string, string>
  /** When each chat was last active, to the minute (so streaming doesn't re-render the list), by id. */
  at: Record<string, number>
  /** When each running reply began, by chat id. */
  starts: Record<string, number>
  now: number
}

/**
 * Chat's chats as the list shows them (ChatThreads, ChatDock): searched, and
 * split into the project chats' rows, the ones of those working, and the
 * chats outside a project (which keep their one-line rows under Chats).
 */
function useChatThreads(): ChatThreadsData {
  const chats = useSortedChats()
  const query = useChatSidebar((s) => s.query)
  const project = useApp(
    useShallow((s) => {
      const names = new Map(s.projects.map((p) => [p.id, p.name]))
      const out: Record<string, string> = {}
      for (const chat of s.chats) {
        const name = chat.projectId && !chat.archived ? names.get(chat.projectId) : undefined
        if (name) out[chat.id] = name
      }
      return out
    })
  )
  const projectId = useApp(
    useShallow((s) => {
      const out: Record<string, string> = {}
      for (const chat of s.chats) if (chat.projectId && !chat.archived) out[chat.id] = chat.projectId
      return out
    })
  )
  const folder = useApp(
    useShallow((s) => {
      const folders = new Map(s.projects.map((p) => [p.id, p.folder]))
      const out: Record<string, string> = {}
      for (const chat of s.chats) {
        const at = chat.projectId && !chat.archived ? folders.get(chat.projectId) : null
        if (at) out[chat.id] = at
      }
      return out
    })
  )
  const at = useApp(useShallow((s) => Object.fromEntries(s.visibleChats().map((c) => [c.id, Math.floor(c.updatedAt / 60_000) * 60_000]))))
  const starts = useApp(
    useShallow((s) => {
      const out: Record<string, number> = {}
      for (const [chatId, messageId] of Object.entries(s.runs)) {
        out[chatId] = s.chats.find((c) => c.id === chatId)?.messages.find((m) => m.id === messageId)?.createdAt ?? 0
      }
      return out
    })
  )
  const now = useNow(Object.keys(starts).length > 0)
  // Titles, projects and what was said, read when the search changes rather than subscribed:
  // a subscription re-ran a full-text search of every chat on every streamed token.
  const found = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return null
    return new Set(
      useApp
        .getState()
        .visibleChats()
        .filter(
          (chat) =>
            matchesSearch(q, [chat.title, project[chat.id]]) ||
            chat.messages.some((m) => m.parts.some((part) => part.type !== 'tool' && part.text.toLowerCase().includes(q)))
        )
        .map((chat) => chat.id)
    )
  }, [query, chats, project])
  const rows: ChatListItem[] = []
  const loose: ChatListItem[] = []
  const working: ChatThreadsData['working'] = []
  for (const chat of chats) {
    if (found && !found.has(chat.id)) continue
    if (!(chat.id in project)) {
      loose.push(chat)
      continue
    }
    const since = starts[chat.id]
    if (since && now - since >= CHAT_WORKING_AFTER_MS) working.push({ chat, since })
    else rows.push(chat)
  }
  working.sort((a, b) => a.since - b.since)
  return { rows, loose, working, project, projectId, folder, at, starts, now }
}

/** The project a chat is in, for its menu's Edit project. */
function projectOfChat(chatId: string): Project | null {
  const { chats, projects } = useApp.getState()
  const id = chats.find((c) => c.id === chatId)?.projectId
  return projects.find((p) => p.id === id) ?? null
}

/**
 * The chats in projects, one list, each tagged with its project, its order
 * held still under the pointer; then the chats outside a project under
 * Chats, a line each, as they always were.
 */
function ChatThreads(): JSX.Element {
  const { view, activeChatId, runs } = useApp(useShallow((s) => ({ view: s.view, activeChatId: s.activeChatId, runs: s.runs })))
  const searching = useChatSidebar((s) => s.query.trim() !== '')
  const threads = useChatThreads()
  const { order, hold } = useHeldOrder(threads.rows.map((chat) => chat.id))
  const byId = new Map(threads.rows.map((chat) => [chat.id, chat]))
  const [editing, setEditing] = useState<Project | null>(null)
  const editProject = useCallback((chatId: string) => setEditing(projectOfChat(chatId)), [])
  const nothing = searching && threads.rows.length === 0 && threads.loose.length === 0
  return (
    <>
      {nothing && <div className="sidebar__empty">{threads.working.length > 0 ? 'Only working chats match' : 'No chats match'}</div>}
      {threads.rows.length > 0 && (
        <div className="chat-threads" {...hold}>
          {order.map((id, index) => {
            const chat = byId.get(id)
            if (!chat) return null
            return (
              <ChatRow
                key={chat.id}
                chat={chat}
                index={index}
                active={chat.id === activeChatId && view === 'chat'}
                streaming={chat.id in runs}
                inProject
                look="thread"
                project={threads.project[chat.id] ?? null}
                projectId={threads.projectId[chat.id] ?? null}
                folder={threads.folder[chat.id] ?? null}
                at={threads.at[chat.id] ?? 0}
                now={threads.now}
                since={threads.starts[chat.id] ?? 0}
                onEditProject={editProject}
              />
            )
          })}
        </div>
      )}
      <LooseChats loose={threads.loose} divided={threads.rows.length > 0} searching={searching} />
      {editing && <ProjectDialog project={editing} onClose={() => setEditing(null)} />}
    </>
  )
}

/** Under Chat's list, out of its scroll: the project chats whose replies have been running a while. */
function ChatDock(): JSX.Element | null {
  const view = useChatSidebar((s) => s.view)
  const searching = useChatSidebar((s) => s.query.trim() !== '')
  if (view !== 'list' && !searching) return null
  return <ChatWorking />
}

function ChatWorking(): JSX.Element | null {
  const { view, activeChatId } = useApp(useShallow((s) => ({ view: s.view, activeChatId: s.activeChatId })))
  const { open, setOpen } = useChatSidebar(useShallow((s) => ({ open: s.workingOpen, setOpen: s.setWorkingOpen })))
  const threads = useChatThreads()
  const [editing, setEditing] = useState<Project | null>(null)
  const editProject = useCallback((chatId: string) => setEditing(projectOfChat(chatId)), [])
  if (threads.working.length === 0) return null
  return (
    <div className="thread-dock scroll">
      <ThreadSection label="Working" count={threads.working.length} open={open} onToggle={() => setOpen(!open)} id="chat-working">
        {threads.working.map(({ chat, since }, index) => (
          <ChatRow
            key={chat.id}
            chat={chat}
            index={index}
            active={chat.id === activeChatId && view === 'chat'}
            streaming
            inProject
            look="thread"
            project={threads.project[chat.id] ?? null}
            projectId={threads.projectId[chat.id] ?? null}
            folder={threads.folder[chat.id] ?? null}
            at={0}
            now={threads.now}
            since={since}
            onEditProject={editProject}
          />
        ))}
      </ThreadSection>
      {editing && <ProjectDialog project={editing} onClose={() => setEditing(null)} />}
    </div>
  )
}

/** The search row under Chat's places: the search, how the list is shown, and a new project. */
function ChatFind(): JSX.Element {
  const { query, setQuery } = useChatSidebar(useShallow((s) => ({ query: s.query, setQuery: s.setQuery })))
  const addAnchor = useRef<HTMLButtonElement>(null)
  const adding = useDisclosure()
  const start = (folder: string | null): void => {
    if (!folder) return
    const app = useApp.getState()
    app.newChat(app.projectForFolder(folder).id)
  }
  return (
    <>
      <SidebarFind value={query} onChange={setQuery} label="Search chats and what was said in them">
        <ChatViewMenu />
        <FindTool ref={addAnchor} label="New project: choose a folder to code in" open={adding.open} onClick={adding.toggle}>
          <FolderPlus size={15} strokeWidth={1.8} />
        </FindTool>
      </SidebarFind>
      <FolderMenu anchor={addAnchor} open={adding.open} onClose={adding.close} onChoose={start} />
    </>
  )
}

const CHAT_VIEWS: Record<ChatView, string> = { projects: 'By project', list: 'One list' }

function ChatViewMenu(): JSX.Element {
  const anchor = useRef<HTMLButtonElement>(null)
  const menu = useDisclosure()
  const { view, setView } = useChatSidebar(useShallow((s) => ({ view: s.view, setView: s.setView })))
  return (
    <>
      <FindTool ref={anchor} label="Sort and view" open={menu.open} onClick={menu.toggle}>
        <ListFilter size={15} strokeWidth={1.8} />
      </FindTool>
      <Popover anchor={anchor} open={menu.open} onClose={menu.close} placement="bottom-end" width={200}>
        <div className="menu__label">Show chats</div>
        {(Object.entries(CHAT_VIEWS) as [ChatView, string][]).map(([value, title]) => (
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
        <div className="menu__label">Sort chats by</div>
        <ChatSortItems close={menu.close} />
      </Popover>
    </>
  )
}

/** Chat's projects, then its chats outside them. */
function ChatTree(): JSX.Element {
  const chats = useSortedChats()
  const projectChatIds = useApp(useShallow((s) => s.chats.filter((c) => c.projectId && !c.archived).map((c) => c.id)))
  const loose = useMemo(() => {
    const inProject = new Set(projectChatIds)
    return chats.filter((c) => !inProject.has(c.id))
  }, [chats, projectChatIds])
  // Its first showing with nothing under Chats (an update from 2026.6 moved
  // them into the project made from its folder): the projects holding chats
  // open, or the chats would look gone behind a folded project.
  const openedForNew = useRef(false)
  useEffect(() => {
    if (!SIDEBAR_IS_NEW || openedForNew.current || loose.length > 0 || projectChatIds.length === 0) return
    openedForNew.current = true
    const holding = [...new Set(useApp.getState().chats.filter((c) => c.projectId && !c.archived).map((c) => c.projectId!))]
    for (const id of holding.slice(0, 3)) useChatSidebar.getState().setProjectOpen(id, true)
  }, [loose.length, projectChatIds.length])

  return (
    <>
      <Projects />
      <LooseChats loose={loose} divided />
    </>
  )
}

/**
 * Chats outside a project, under their own folding heading, a line each:
 * the title, and a mark at the end while it replies, failed, has a new
 * reply, or is pinned. Under the projects in either view.
 */
function LooseChats({ loose, divided, searching = false }: { loose: ChatListItem[]; divided: boolean; searching?: boolean }): JSX.Element | null {
  const { view, activeChatId, runs, newChat } = useApp(
    useShallow((s) => ({
      view: s.view,
      activeChatId: s.activeChatId,
      runs: s.runs,
      newChat: s.newChat
    }))
  )
  const { folded, setFolded } = useChatSidebar(useShallow((s) => ({ folded: s.chatsFolded, setFolded: s.setChatsFolded })))
  // A chat opened (or just started) outside a project must be visible, so
  // Chats unfolds for it; folding it again is the user's call, and so is a
  // fold kept from last time.
  const activeLoose = loose.some((c) => c.id === activeChatId) ? activeChatId : null
  const shownActive = useRef(activeLoose)
  useEffect(() => {
    if (activeLoose && activeLoose !== shownActive.current) setFolded(false)
    shownActive.current = activeLoose
  }, [activeLoose, setFolded])
  // A search that finds none of them leaves the heading out.
  if (searching && loose.length === 0) return null
  // What a search finds shows even in a folded section.
  const open = !folded || searching

  return (
    <>
      <SidebarHead label="Chats" folded={!open} onFold={() => setFolded(!folded)} list="sidebar-chats" divided={divided}>
        <ChatSortButton />
        <button className="sidebar-head__tool" aria-label="New chat" title="New chat" onClick={() => newChat()}>
          <SquarePen size={14} strokeWidth={1.9} />
        </button>
      </SidebarHead>
      {open && (
        <div id="sidebar-chats">
          {loose.length === 0 ? (
            <div className="sidebar__empty">No chats</div>
          ) : (
            loose.map((chat, index) => (
              <ChatRow
                key={chat.id}
                chat={chat}
                index={index}
                active={chat.id === activeChatId && view === 'chat'}
                streaming={chat.id in runs}
              />
            ))
          )}
        </div>
      )}
    </>
  )
}

/** The chat list in the order the sidebar is set to. Reading when each chat was made only while that order needs it. */
function useSortedChats(): ChatListItem[] {
  const sort = useChatSidebar((s) => s.chatSort)
  const chats = useApp((s) => s.chatList())
  const createdAt = useApp(
    useShallow((s) => (sort === 'created' ? Object.fromEntries(s.visibleChats().map((c) => [c.id, c.createdAt])) : NO_TIMES))
  )
  return useMemo(() => sortChats(chats, sort, createdAt), [chats, sort, createdAt])
}
const NO_TIMES: Record<string, number> = {}

/**
 * A section's heading: its name, and its tools, shown while the pointer is
 * on it. One that folds is a button across the row with a chevron after the
 * name; one that is `divided` has a rule above it, the line between
 * Projects and Chats.
 */
function SidebarHead({
  label,
  folded,
  onFold,
  list,
  divided,
  children
}: {
  label: string
  folded?: boolean
  onFold?: () => void
  /** The id of the list the heading folds. */
  list?: string
  divided?: boolean
  children?: ReactNode
}): JSX.Element {
  return (
    <div className="sidebar-head" data-fold={onFold ? true : undefined} data-divided={divided || undefined}>
      {onFold ? (
        <button className="sidebar-head__label" aria-expanded={!folded} aria-controls={folded ? undefined : list} onClick={onFold}>
          {label}
          <ChevronDown size={12} strokeWidth={2.2} className="sidebar-head__chev" data-folded={folded || undefined} />
        </button>
      ) : (
        <span className="sidebar-head__label">{label}</span>
      )}
      <span className="sidebar-head__tools">{children}</span>
    </div>
  )
}

/** A heading's sort menu: how its list is ordered, a check against the one in use. */
function SortButton({ label, children }: { label: string; children: (close: () => void) => ReactNode }): JSX.Element {
  const anchor = useRef<HTMLButtonElement>(null)
  const menu = useDisclosure()
  return (
    <>
      <button ref={anchor} className="sidebar-head__tool" aria-label={label} title={label} data-open={menu.open || undefined} onClick={menu.toggle}>
        <ArrowDownWideNarrow size={14} strokeWidth={1.9} />
      </button>
      <Popover anchor={anchor} open={menu.open} onClose={menu.close} placement="bottom-end" width={200}>
        {children(menu.close)}
      </Popover>
    </>
  )
}

function ChatSortItems({ close }: { close: () => void }): JSX.Element {
  const { sort, setSort } = useChatSidebar(useShallow((s) => ({ sort: s.chatSort, setSort: s.setChatSort })))
  return (
    <>
      {(Object.entries(CHAT_SORTS) as [ChatSort, string][]).map(([value, title]) => (
        <MenuItem
          key={value}
          title={title}
          checked={value === sort}
          onClick={() => {
            setSort(value)
            close()
          }}
        />
      ))}
    </>
  )
}

function ChatSortButton(): JSX.Element {
  return <SortButton label="Sort chats">{(close) => <ChatSortItems close={close} />}</SortButton>
}

/**
 * Projects are where Chat codes: each is a folder, and its chats are coding
 * sessions in it, with the workspace card, terminal, Git and the dock's
 * files and diff. + picks a folder and starts a session there. A project
 * expands to its chats; its menu starts a chat in it, edits its name,
 * folder and instructions, shows the folder, or deletes it.
 */
function Projects(): JSX.Element {
  const sort = useChatSidebar((s) => s.projectSort)
  // Ids, not projects: a reply finishing moves a project only when the order really changes.
  const order = useApp(useShallow((s) => sortProjects(s.visibleProjects(), s.chats, sort).map((p) => p.id)))
  const all = useApp((s) => s.projects)
  const projects = useMemo(() => order.map((id) => all.find((p) => p.id === id)).filter((p): p is Project => Boolean(p)), [order, all])
  const anyOpen = useChatSidebar((s) => order.some((id) => !s.folded[id]))
  const collapseProjects = useChatSidebar((s) => s.collapseProjects)
  const [editing, setEditing] = useState<Project | null>(null)
  const addAnchor = useRef<HTMLButtonElement>(null)
  const adding = useDisclosure()
  const start = (folder: string | null): void => {
    if (!folder) return
    const app = useApp.getState()
    app.newChat(app.projectForFolder(folder).id)
  }
  return (
    <>
      <SidebarHead label="Projects">
        {anyOpen && (
          <button className="sidebar-head__tool" aria-label="Collapse all projects" title="Collapse all projects" onClick={() => collapseProjects(order)}>
            <ChevronsDownUp size={14} strokeWidth={1.9} />
          </button>
        )}
        {projects.length > 1 && <ProjectSortButton />}
        <button
          ref={addAnchor}
          className="sidebar-head__tool"
          aria-label="New project"
          title="New project: choose a folder to code in"
          data-open={adding.open || undefined}
          onClick={adding.toggle}
        >
          <Plus size={15} strokeWidth={1.9} />
        </button>
      </SidebarHead>
      <FolderMenu anchor={addAnchor} open={adding.open} onClose={adding.close} onChoose={start} />
      {projects.length === 0 ? (
        <div className="sidebar__empty">No projects</div>
      ) : (
        projects.map((project) => <ProjectRow key={project.id} project={project} onEdit={() => setEditing(project)} />)
      )}
      {editing && <ProjectDialog project={editing} onClose={() => setEditing(null)} />}
    </>
  )
}

/** The Projects heading's sort menu: the projects' order, and their chats'. */
function ProjectSortButton(): JSX.Element {
  const { sort, setSort } = useChatSidebar(useShallow((s) => ({ sort: s.projectSort, setSort: s.setProjectSort })))
  return (
    <SortButton label="Sort projects">
      {(close) => (
        <>
          <div className="menu__label">Projects</div>
          {(Object.entries(PROJECT_SORTS) as [ProjectSort, string][]).map(([value, title]) => (
            <MenuItem
              key={value}
              title={title}
              checked={value === sort}
              onClick={() => {
                setSort(value)
                close()
              }}
            />
          ))}
          <div className="menu__label">Chats</div>
          <ChatSortItems close={close} />
        </>
      )}
    </SortButton>
  )
}

function ProjectRow({ project, onEdit }: { project: Project; onEdit: () => void }): JSX.Element {
  const { view, activeChatId, runs, newChat, deleteProject } = useApp(
    useShallow((s) => ({ view: s.view, activeChatId: s.activeChatId, runs: s.runs, newChat: s.newChat, deleteProject: s.deleteProject }))
  )
  const chats = useSortedChats()
  const ids = useApp(useShallow((s) => s.chats.filter((c) => c.projectId === project.id && !c.archived).map((c) => c.id)))
  const inProject = useMemo(() => chats.filter((c) => ids.includes(c.id)), [chats, ids])
  const containsActive = inProject.some((c) => c.id === activeChatId)
  const open = useChatSidebar((s) => !s.folded[project.id])
  const setProjectOpen = useChatSidebar((s) => s.setProjectOpen)
  const setOpen = (next: boolean): void => setProjectOpen(project.id, next)
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null)
  const [confirmDelete, setConfirmDelete] = useState(false)
  // A chat opened (or just started) in this project must be visible, so the
  // row opens itself; closing it again is the user's call.
  useEffect(() => {
    if (containsActive) setProjectOpen(project.id, true)
  }, [containsActive, project.id, setProjectOpen])

  return (
    <>
      <div
        className="nav-item nav-item--project"
        role="button"
        tabIndex={0}
        aria-expanded={open}
        onClick={() => setOpen(!open)}
        onKeyDown={(e) => {
          if (e.target !== e.currentTarget) return
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault()
            setOpen(!open)
          } else if (isMenuKey(e)) {
            e.preventDefault()
            setMenu(menuAt(e.currentTarget))
          }
        }}
        onContextMenu={(e) => {
          e.preventDefault()
          setMenu({ x: e.clientX, y: e.clientY })
        }}
      >
        <span className="nav-item__icon">
          <ProjectBadge name={project.name} folder={project.folder && !project.folder.startsWith('ssh://') ? project.folder : null} />
        </span>
        <span className="nav-item__label" title={project.folder ?? 'No folder yet: Edit project to choose the one its chats code in'}>
          {project.name}
        </span>
        <ChevronRight size={13} strokeWidth={2} className="nav-item__chevron" data-open={open || undefined} />
        <button
          className="nav-item__action"
          aria-label={`New chat in ${project.name}`}
          title="New chat in this project"
          onClick={(e) => {
            e.stopPropagation()
            newChat(project.id)
          }}
        >
          <SquarePen size={13} strokeWidth={2} />
        </button>
      </div>
      {open && (
        <div className="nav-group">
          {inProject.length === 0 ? (
            <button className="nav-item nav-item--sub nav-item--muted" onClick={() => newChat(project.id)}>
              <span className="nav-item__label">Start a session in this project</span>
            </button>
          ) : (
            inProject.map((chat, index) => (
              <ChatRow
                key={chat.id}
                chat={chat}
                index={index}
                active={chat.id === activeChatId && view === 'chat'}
                streaming={chat.id in runs}
                inProject
              />
            ))
          )}
        </div>
      )}
      {menu && (
        <ContextMenu
          x={menu.x}
          y={menu.y}
          onClose={() => setMenu(null)}
          items={[
            { icon: <SquarePen size={15} strokeWidth={1.9} />, label: 'New chat', action: () => newChat(project.id) },
            { icon: <ScrollText size={15} strokeWidth={1.9} />, label: 'Edit project', action: onEdit },
            ...(project.folder && !project.folder.startsWith('ssh://')
              ? [{ icon: <FolderOpen size={15} strokeWidth={1.9} />, label: 'Show folder', action: () => void showFolder(project.folder!) }]
              : []),
            { icon: <Trash2 size={15} strokeWidth={1.9} />, label: 'Delete project', danger: true, action: () => setConfirmDelete(true) }
          ]}
        />
      )}
      <ConfirmDialog
        open={confirmDelete}
        onClose={() => setConfirmDelete(false)}
        title="Delete this project?"
        confirmLabel="Delete project"
        onConfirm={() => deleteProject(project.id)}
      >
        “{project.name}” and its instructions are removed from Eaon; the folder and its files stay where they are. Its chats are kept and move to Chats.
      </ConfirmDialog>
    </>
  )
}

/** A project's name, its folder and its instructions; the instructions ride along with every chat in it. */
function ProjectDialog({ project, onClose }: { project: Project; onClose: () => void }): JSX.Element {
  const { projects, updateProject } = useApp(useShallow((s) => ({ projects: s.projects, updateProject: s.updateProject })))
  const [name, setName] = useState(project.name)
  const [folder, setFolder] = useState(project.folder ?? null)
  // More folders the project's chats work in beside the first.
  const [extras, setExtras] = useState<string[]>(project.extraFolders ?? [])
  const [instructions, setInstructions] = useState(project.instructions)
  // A folder on another machine: picked in its own dialog, and shown as host:/folder.
  const [picking, setPicking] = useState(false)
  const [hosts, setHosts] = useState<SshHost[]>([])
  useEffect(() => {
    if (folder && isRemote(folder)) void window.api.ade.hosts().then(setHosts, () => undefined)
  }, [folder])
  const shown = folder && isRemote(folder) ? remoteDisplay(folder, (id) => hosts.find((h) => h.id === id)?.label ?? null) : folder
  const clash = folder !== null && projects.some((p) => p.id !== project.id && p.workspaceId === project.workspaceId && p.folder === folder)
  const submit = (): void => {
    if (!name.trim() || clash) return
    updateProject(project.id, { name: name.trim(), folder, extraFolders: extras.filter((f) => f !== folder), instructions })
    onClose()
  }
  const addExtra = (): void =>
    void window.api.app.openFiles({ properties: ['openDirectory'] }).then((paths) => {
      const picked = paths[0]
      if (picked && picked !== folder) setExtras((now) => (now.includes(picked) ? now : [...now, picked]))
    })
  const choose = (): void =>
    void window.api.app.openFiles({ properties: ['openDirectory'] }).then((paths) => {
      if (!paths[0]) return
      // Named after its folder until now: it follows the new one.
      if (!project.folder || name.trim() === folderName(project.folder)) setName(folderName(paths[0]))
      setFolder(paths[0])
    })
  return (
    <Modal
      open
      onClose={onClose}
      title="Edit project"
      width={480}
      actions={
        <>
          <button className="btn btn--ghost" onClick={onClose}>
            Cancel
          </button>
          <button className="btn btn--primary" disabled={!name.trim() || clash} onClick={submit}>
            Save
          </button>
        </>
      }
    >
      <label className="field">
        <span className="field-label">Name</span>
        <input autoFocus className="input" value={name} placeholder="snake-game" onChange={(e) => setName(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && submit()} />
      </label>
      <div className="field">
        <span className="field-label">Folder</span>
        <div className="project-folder">
          <FolderOpen size={15} strokeWidth={1.9} />
          <span className="project-folder__path" title={shown ?? undefined}>
            {shown ? `\u200e${shown}\u200e` : 'None yet. Its chats code once it has one'}
          </span>
          <button type="button" className="btn btn--sm" onClick={choose}>
            {folder ? 'Change…' : 'Choose…'}
          </button>
          <button type="button" className="btn btn--sm" onClick={() => setPicking(true)}>
            On another machine…
          </button>
        </div>
        {clash && <span className="field-error">Another project already works in this folder.</span>}
      </div>
      {picking && (
        <RemoteFolderDialog
          onClose={() => setPicking(false)}
          onPicked={(cwd, label) => {
            // Named after its folder until now: it follows the new one.
            if (!project.folder || name.trim() === folderName(project.folder)) setName(folderName(cwd))
            setFolder(cwd)
            // Other folders are on this computer; a project on a host has none.
            setExtras([])
            setPicking(false)
            notify(`Connected to ${label}.`)
          }}
        />
      )}
      {folder && !isRemote(folder) && (
        <div className="field">
          <span className="field-label">Other folders</span>
          {extras.map((extra) => (
            <div key={extra} className="project-folder">
              <FolderOpen size={15} strokeWidth={1.9} />
              <span className="project-folder__path" title={extra}>
                {`\u200e${extra}\u200e`}
              </span>
              <button type="button" className="btn btn--sm" aria-label={`Remove ${extra}`} onClick={() => setExtras((now) => now.filter((f) => f !== extra))}>
                Remove
              </button>
            </div>
          ))}
          <button type="button" className="btn btn--sm" onClick={addExtra}>
            Add a folder…
          </button>
          <span className="field-hint">The agent reads and changes these as freely as the project’s own folder: a frontend and its API, an app and its library. Commands still start in the first folder.</span>
        </div>
      )}
      <label className="field">
        <span className="field-label">Instructions</span>
        <textarea
          className="input input--area"
          rows={5}
          value={instructions}
          placeholder="What Eaon should know or do in every chat in this project"
          onChange={(e) => setInstructions(e.target.value)}
        />
      </label>
    </Modal>
  )
}

/** The folder's name: its last part. */
const folderName = (path: string): string => path.split(/[\\/]/).filter(Boolean).pop() ?? path

/** Shows a project's folder in Finder (Explorer, Files), or says it is gone. */
async function showFolder(folder: string): Promise<void> {
  const shown = await window.api.app.showItem(folder)
  if (!shown) notify(`${folder} isn’t there any more. Edit the project to choose its folder.`, 'error')
}

/** The folder of the project a chat is in, read when its Move menu opens. */
function projectFolderOf(chatId: string): string | null {
  const { chats, projects } = useApp.getState()
  const projectId = chats.find((c) => c.id === chatId)?.projectId
  return projects.find((p) => p.id === projectId)?.folder ?? null
}

/** Memoised so a token arriving in one chat does not re-render the whole list. */
const ChatRow = memo(function ChatRow({
  chat,
  index,
  active,
  streaming,
  inProject = false,
  look = 'tree',
  project = null,
  projectId = null,
  folder = null,
  at = 0,
  now = 0,
  since = 0,
  onEditProject
}: {
  chat: ChatListItem
  index: number
  active: boolean
  streaming: boolean
  /** Under a project rather than in Chats: it can move back out. */
  inProject?: boolean
  /** "thread": the list's row (ThreadLines), its project's tag and name over its title. */
  look?: 'tree' | 'thread'
  /** Its project's name, in the list. */
  project?: string | null
  /** Its project, for New chat in it, and that project's folder, for the picture on its tag. */
  projectId?: string | null
  folder?: string | null
  /** When it was last active, and the time now, for its age in the list. */
  at?: number
  now?: number
  /** When its running reply began. */
  since?: number
  /** Opens its project's Edit project (the list has no project rows to do it from). */
  onEditProject?: (chatId: string) => void
}): JSX.Element {
  // Read here rather than take an `onOpen` prop: `openChat` is a stable
  // reference from the store, so `chat`/`index`/`active`/`streaming` are now
  // the only props ChatRow ever receives, and they only change for a row
  // whose own chat actually changed — memo() can finally do its job.
  const { openChat, newChat, renameChat, togglePin, archiveChat, deleteChat } = useApp(
    useShallow((st) => ({
      openChat: st.openChat,
      newChat: st.newChat,
      renameChat: st.renameChat,
      togglePin: st.togglePin,
      archiveChat: st.archiveChat,
      deleteChat: st.deleteChat
    }))
  )
  const anchor = useRef<HTMLDivElement>(null)
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null)
  const [renaming, setRenaming] = useState(false)
  const [draft, setDraft] = useState(chat.title)
  const [confirm, setConfirm] = useState<'delete' | 'archive' | null>(null)
  // Moving to a project picks its folder, from where the row is.
  const [moving, setMoving] = useState(false)
  const moveTo = (folder: string | null): void => {
    const app = useApp.getState()
    app.moveChat(chat.id, folder ? app.projectForFolder(folder).id : null)
  }

  const { failed, pinned } = chat
  // Finished while another chat was on screen: a dot until it's opened.
  const unread = chat.unread && !active && !streaming
  // Its reply stopped to ask something (an approval): it waits on the user, not working.
  // Waiting out a rate limit or a retry: the only change of pace while a reply runs.
  const retrying = useApp((st) => {
    const run = st.runs[chat.id]
    if ((!inProject && look !== 'thread') || !run) return false
    return Boolean(st.chats.find((c) => c.id === chat.id)?.messages.find((m) => m.id === run)?.notice)
  })
  const asking = useApp((st) => {
    const run = st.runs[chat.id]
    return Boolean(
      run && (st.pendingApproval?.messageId === run || st.approvalQueue.some((a) => a.messageId === run) || st.pendingQuestions.some((q) => q.messageId === run))
    )
  })
  // A project's chat shows its state as dots, one element that changes state in place so the change is a fade.
  const dotState: DotState | null = !inProject ? null : streaming ? (asking ? 'asking' : retrying ? 'retrying' : 'thinking') : unread && !failed ? 'done' : failed ? 'failed' : null

  const commitRename = (): void => {
    setRenaming(false)
    if (draft.trim() && draft !== chat.title) renameChat(chat.id, draft.trim())
    else setDraft(chat.title)
  }

  const renameInput = (
    <input aria-label="Name"
      autoFocus
      className="nav-item__label"
      value={draft}
      style={{ background: 'transparent', border: 0, outline: 'none' }}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={commitRename}
      onKeyDown={(e) => {
        // Not while an input method is composing: that Enter picks the characters.
        if (e.key === 'Enter' && !e.nativeEvent.isComposing) commitRename()
        if (e.key === 'Escape') {
          setDraft(chat.title)
          setRenaming(false)
        }
      }}
      onClick={(e) => e.stopPropagation()}
    />
  )
  const thread = look === 'thread'
  // In the list: what it is doing, or how long ago it was active, at the end of its first line.
  const when = !thread ? null : streaming ? (
    asking ? (
      <span className="thread-status thread-status--asking">Needs you</span>
    ) : (
      <WorkingFor since={since} label={retrying ? 'Retrying' : 'Working'} />
    )
  ) : failed ? (
    <span className="thread-status thread-status--failed">
      <CircleAlert size={12} strokeWidth={2.2} aria-hidden="true" />
      Failed
    </span>
  ) : unread ? (
    <DoneMark />
  ) : at > 0 && now > 0 ? (
    <span className="trow__age">{ageLabel(at, now)}</span>
  ) : null

  // The list has no project headings to start one from: each project chat's row offers another chat in its project.
  const addChat = thread && projectId ? () => newChat(projectId) : undefined

  return (
    <>
      <RowWithAdd add={addChat} label={`New chat in ${project ?? 'this project'}`}>
        <div
          ref={anchor}
          className={thread ? 'chat-thread nav-item--staggered' : 'nav-item nav-item--staggered'}
          data-active={active || undefined}
          // Only the first dozen carry a delay; past that the cascade would feel
          // like lag rather than sequence.
          style={{ ['--i' as string]: Math.min(index, 12) }}
          role="button"
          tabIndex={0}
          aria-current={active ? 'page' : undefined}
          onClick={() => openChat(chat.id)}
          onKeyDown={(e) => {
            if (e.target !== e.currentTarget) return
            if (e.key === 'Enter' || e.key === ' ') {
              e.preventDefault()
              openChat(chat.id)
            } else if (isMenuKey(e)) {
              // The keyboard's way to the right-click menu (Shift+F10, or the Menu key).
              e.preventDefault()
              setMenu(menuAt(e.currentTarget))
            }
          }}
          onContextMenu={(e) => {
            e.preventDefault()
            setMenu({ x: e.clientX, y: e.clientY })
          }}
        >
          {thread ? (
            <ThreadLines project={project} folder={folder} pinned={pinned} when={when} title={renaming ? renameInput : chat.title} />
          ) : (
            <>
              {renaming ? (
                renameInput
              ) : (
                <span className="nav-item__label">{chat.title}</span>
              )}
              <span className="nav-item__trail" data-always={streaming || failed || pinned || unread ? 'true' : undefined}>
                {dotState ? (
                  <DotMatrix state={dotState} />
                ) : streaming && asking ? (
                  <span className="nav-item__asking" title="Waiting for your answer">
                    Needs you
                  </span>
                ) : streaming ? (
                  <Spinner size={14} label="Replying" />
                ) : unread && !failed ? (
                  <span className="nav-item__unread" role="img" aria-label="New reply" />
                ) : failed ? (
                  <CircleAlert size={14} strokeWidth={2} color="var(--danger)" role="img" aria-label="The last reply failed">
                    <title>The last reply failed</title>
                  </CircleAlert>
                ) : pinned ? (
                  <Pin size={13} strokeWidth={2} role="img" aria-label="Pinned" />
                ) : null}
              </span>
            </>
          )}
        </div>
      </RowWithAdd>

      {menu && (
        <ContextMenu
          x={menu.x}
          y={menu.y}
          onClose={() => setMenu(null)}
          items={[
            // Its project's name is in the row and the + button's tooltip; the menu is too narrow for it.
            ...(addChat ? [{ icon: <SquarePen size={15} strokeWidth={1.9} />, label: 'New chat in project', action: addChat }] : []),
            {
              icon: <PencilLine size={15} strokeWidth={1.9} />,
              label: 'Rename',
              action: () => {
                setDraft(chat.title)
                setRenaming(true)
              }
            },
            {
              icon: pinned ? <PinOff size={15} strokeWidth={1.9} /> : <Pin size={15} strokeWidth={1.9} />,
              label: pinned ? 'Unpin' : thread ? 'Pin to the top' : 'Pin',
              action: () => togglePin(chat.id)
            },
            ...(thread && inProject && onEditProject
              ? [{ icon: <ScrollText size={15} strokeWidth={1.9} />, label: 'Edit project', action: () => onEditProject(chat.id) }]
              : []),
            {
              icon: <FolderInput size={15} strokeWidth={1.9} />,
              label: inProject ? 'Move to another project' : 'Move to a project',
              action: () => setMoving(true)
            },
            {
              icon: <Archive size={15} strokeWidth={1.9} />,
              label: 'Archive',
              // A chat still replying asks first, as the chat's own menu does.
              action: () => (streaming ? setConfirm('archive') : archiveChat(chat.id))
            },
            {
              icon: <Trash2 size={15} strokeWidth={1.9} />,
              label: 'Delete',
              danger: true,
              action: () => setConfirm('delete')
            }
          ]}
        />
      )}
      {/* Only while open: one per row would have every row watching the projects. */}
      {moving && (
        <FolderMenu
          anchor={anchor}
          open
          onClose={() => setMoving(false)}
          onChoose={moveTo}
          // Its own project isn't somewhere to move it to.
          current={inProject ? projectFolderOf(chat.id) : null}
          none={inProject ? 'Move to Chats' : undefined}
        />
      )}
      <ConfirmDialog
        open={confirm === 'delete'}
        onClose={() => setConfirm(null)}
        title="Delete this chat?"
        confirmLabel="Delete"
        onConfirm={() => deleteChat(chat.id)}
      >
        “{chat.title}” and its messages are removed from this computer. This can’t be undone. To put a chat away and keep it, archive it instead.
      </ConfirmDialog>
      <ConfirmDialog
        open={confirm === 'archive'}
        onClose={() => setConfirm(null)}
        title="Stop and archive this chat?"
        confirmLabel="Stop and archive"
        onConfirm={() => archiveChat(chat.id)}
      >
        Archiving will stop any ongoing work. You can restore the chat later in settings.
      </ConfirmDialog>
    </>
  )
})

/** A list row with a button to start another chat in its project beside it, shown while the pointer is on the row. */
function RowWithAdd({ add, label, children }: { add?: () => void; label: string; children: ReactNode }): JSX.Element {
  if (!add) return <>{children}</>
  return (
    <div className="chat-thread-slot">
      {children}
      <button type="button" className="chat-thread__add" aria-label={label} title={label} onClick={add}>
        <Plus size={14} strokeWidth={2} />
      </button>
    </div>
  )
}

/** Shift+F10 or the Menu key: the keyboard's right click. */
const isMenuKey = (e: { key: string; shiftKey: boolean }): boolean => e.key === 'ContextMenu' || (e.shiftKey && e.key === 'F10')

/** Where a menu opened from the keyboard goes: under the row's start. */
const menuAt = (element: HTMLElement): { x: number; y: number } => {
  const rect = element.getBoundingClientRect()
  return { x: rect.left + 12, y: rect.bottom }
}

/** A menu anchored to a point rather than an element (right-click menus). */
export function ContextMenu({
  x,
  y,
  items,
  onClose
}: {
  x: number
  y: number
  items: { icon?: JSX.Element; label: string; action: () => void; danger?: boolean }[]
  onClose: () => void
}): JSX.Element {
  const anchor = useRef<HTMLDivElement>(null)
  return (
    <>
      {/* The point it opens from, at the page's top level: inside a frosted
          panel (a glass terminal pane, a see-through sidebar) `fixed` would be
          relative to that panel, and the menu opened a panel's offset away. */}
      {createPortal(<div ref={anchor} style={{ position: 'fixed', left: x, top: y, width: 1, height: 1, pointerEvents: 'none' }} />, document.body)}
      <Popover anchor={anchor} open onClose={onClose} placement="bottom-start" offset={2} width={188}>
        {items.map((item) => (
          <MenuItem
            key={item.label}
            icon={item.icon}
            title={<span style={item.danger ? { color: 'var(--danger)' } : undefined}>{item.label}</span>}
            onClick={() => {
              item.action()
              onClose()
            }}
          />
        ))}
      </Popover>
    </>
  )
}
