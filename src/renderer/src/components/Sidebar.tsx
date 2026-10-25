import { memo, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { Archive, ArrowDownWideNarrow, ArrowRight, AtSign, BookOpen, Boxes, CandlestickChart, ChevronDown, ChevronRight, ChevronsDownUp, CircleAlert, Clock3, Compass, FolderClosed, FolderInput, FolderOpen, GitPullRequest, ListTodo, HelpCircle, LibraryBig, Loader2, PanelLeft, PencilLine, Pin, Plus, ScrollText, Search, Settings as SettingsIcon, Sparkles, SquarePen, Trash2 } from 'lucide-react'
import { DOCS_URL } from '@shared/links'
import { WHATS_NEW_RELEASE } from '@shared/whatsNew'
import { useApp, useWorkspaceKind, type ChatListItem } from '../state/store'
import { DownloadsButton } from './DownloadsPanel'
import { CodeSidebar } from './code/CodeSidebar'
import { openNewSession } from './code/sessionsStore'
import { WorkersNav } from './workers/WorkersSidebar'
import { WorkersSearchButton } from './workers/WorkerThreads'
import { useOnboarding } from './onboarding/onboardingStore'
import { FolderMenu } from './composer/ComposerBits'
import { notify } from './Notice'
import { CHAT_SORTS, PROJECT_SORTS, sortChats, sortProjects, useChatSidebar, type ChatSort, type ProjectSort } from './chatSidebar'
import { ConfirmDialog, MenuItem, MenuSearch, Modal, Popover, useDisclosure } from './ui'
import type { Project } from '@shared/types'

export function Sidebar(): JSX.Element {
  const { sidebarOpen, toggleSidebar, goForward } = useApp(
    useShallow((s) => ({ sidebarOpen: s.sidebarOpen, toggleSidebar: s.toggleSidebar, goForward: s.goForward }))
  )
  const canGoForward = useApp((s) => s.canGoForward())

  const searchAnchor = useRef<HTMLButtonElement>(null)
  const searchMenu = useDisclosure()

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
        <DownloadsButton />
        {kind === 'workers' ? (
          <WorkersSearchButton />
        ) : (
          <button ref={searchAnchor} className="icon-btn" onClick={searchMenu.toggle} aria-label="Search chats" title="Search chats">
            <Search size={16} strokeWidth={1.9} />
          </button>
        )}
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

      <SearchMenu anchor={searchAnchor} open={searchMenu.open} onClose={searchMenu.close} />

      <div className="sidebar__body scroll">
        {kind === 'workers' ? <WorkersNav /> : kind === 'code' ? <AdeNav /> : <ChatNav />}
      </div>

      <div className="sidebar__footer">
        <HelpButton />
      </div>
      </div>
      </div>
    </aside>
  )
}

/** Help: the tour of the app (the same one the first-run setup offers), what's new in this release, and the documentation. */
function HelpButton(): JSX.Element {
  const anchor = useRef<HTMLButtonElement>(null)
  const menu = useDisclosure()
  const startTour = useOnboarding((s) => s.startTour)
  return (
    <>
      <button ref={anchor} className="icon-btn" aria-label="Help" title="Help" data-open={menu.open || undefined} onClick={menu.toggle}>
        <HelpCircle size={16} strokeWidth={1.9} />
      </button>
      <Popover anchor={anchor} open={menu.open} onClose={menu.close} placement="top-start" width={220}>
        <MenuItem
          icon={<Compass size={14} strokeWidth={2} />}
          title="Take the tour"
          onClick={() => {
            menu.close()
            startTour()
          }}
        />
        <MenuItem
          icon={<Sparkles size={14} strokeWidth={2} />}
          title={`What’s new in ${WHATS_NEW_RELEASE}`}
          onClick={() => {
            menu.close()
            startTour('whatsNew')
          }}
        />
        <MenuItem
          icon={<BookOpen size={14} strokeWidth={2} />}
          title="Documentation"
          onClick={() => {
            menu.close()
            void window.api.app.openExternal(DOCS_URL)
          }}
        />
      </Popover>
    </>
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
 * Chat mode, laid out like the design spec's sidebar: the five destinations,
 * then Projects, then Chats, each under its own heading. Scheduled tasks
 * moved to the Workers tab — things that run on their own live together
 * there.
 */
function ChatNav(): JSX.Element {
  const { view, activeChatId, streamingChatId, setView, setModelsRepo, newChat, setSettingsPage } = useApp(
    useShallow((s) => ({
      view: s.view,
      activeChatId: s.activeChatId,
      streamingChatId: s.streamingChatId,
      setView: s.setView,
      setModelsRepo: s.setModelsRepo,
      newChat: s.newChat,
      setSettingsPage: s.setSettingsPage
    }))
  )
  // Keeps its identity while a reply streams (see `chatList`), so tokens do
  // not re-render the sidebar.
  const chats = useSortedChats()
  const projectChatIds = useApp(useShallow((s) => s.chats.filter((c) => c.projectId && !c.archived).map((c) => c.id)))
  const loose = useMemo(() => {
    const inProject = new Set(projectChatIds)
    return chats.filter((c) => !inProject.has(c.id))
  }, [chats, projectChatIds])
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
      <NavItem icon={<CandlestickChart {...ICON} />} label="Trading" active={view === 'trading'} onClick={() => setView('trading')} />
      <NavItem
        icon={<AtSign {...ICON} />}
        label="Plugins"
        active={view === 'plugins' || view === 'integrations'}
        onClick={() => setView('plugins')}
      />
      <NavItem icon={<SettingsIcon {...ICON} />} label="Settings" onClick={() => setSettingsPage('general')} />

      <Projects />

      <SidebarHead label="Chats" folded={folded} onFold={() => setFolded(!folded)} list="sidebar-chats" divided>
        <ChatSortButton />
        <button className="sidebar-head__tool" aria-label="New chat" title="New chat" onClick={() => newChat()}>
          <SquarePen size={14} strokeWidth={1.9} />
        </button>
      </SidebarHead>
      {!folded && (
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
                streaming={chat.id === streamingChatId}
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
 * The ADE: only what coding needs. Starting a session (on this computer, or
 * over SSH from the same dialog), the pull requests and Linear issues it works
 * from, and Settings; then its sessions. Models, Plugins and Trading live in
 * the Chat sidebar, where they are used.
 */
function AdeNav(): JSX.Element {
  const { view, setView, setSettingsPage } = useApp(useShallow((s) => ({ view: s.view, setView: s.setView, setSettingsPage: s.setSettingsPage })))
  return (
    <>
      <NavItem icon={<SquarePen {...ICON} />} label="New session" onClick={() => void openNewSession()} />
      <NavItem
        icon={<GitPullRequest {...ICON} />}
        label="Pull requests"
        active={view === 'pull-requests'}
        onClick={() => setView('pull-requests')}
      />
      <NavItem icon={<ListTodo {...ICON} />} label="Linear" active={view === 'linear'} onClick={() => setView('linear')} />
      <NavItem icon={<SettingsIcon {...ICON} />} label="Settings" onClick={() => setSettingsPage('general')} />
      <CodeSidebar />
    </>
  )
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
  const anyOpen = useChatSidebar((s) => order.some((id) => s.open[id]))
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
          <button className="sidebar-head__tool" aria-label="Collapse all projects" title="Collapse all projects" onClick={collapseProjects}>
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
  const { view, activeChatId, streamingChatId, newChat, deleteProject } = useApp(
    useShallow((s) => ({ view: s.view, activeChatId: s.activeChatId, streamingChatId: s.streamingChatId, newChat: s.newChat, deleteProject: s.deleteProject }))
  )
  const chats = useSortedChats()
  const ids = useApp(useShallow((s) => s.chats.filter((c) => c.projectId === project.id && !c.archived).map((c) => c.id)))
  const inProject = useMemo(() => chats.filter((c) => ids.includes(c.id)), [chats, ids])
  const containsActive = inProject.some((c) => c.id === activeChatId)
  const open = useChatSidebar((s) => Boolean(s.open[project.id]))
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
          <FolderClosed size={15} strokeWidth={1.9} />
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
                streaming={chat.id === streamingChatId}
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
            ...(project.folder
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
  const [instructions, setInstructions] = useState(project.instructions)
  const clash = folder !== null && projects.some((p) => p.id !== project.id && p.workspaceId === project.workspaceId && p.folder === folder)
  const submit = (): void => {
    if (!name.trim() || clash) return
    updateProject(project.id, { name: name.trim(), folder, instructions })
    onClose()
  }
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
          <span className="project-folder__path" title={folder ?? undefined}>
            {folder ? `\u200e${folder}\u200e` : 'None yet. Its chats code once it has one'}
          </span>
          <button type="button" className="btn btn--sm" onClick={choose}>
            {folder ? 'Change…' : 'Choose…'}
          </button>
        </div>
        {clash && <span className="field-error">Another project already works in this folder.</span>}
      </div>
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

/** Memoised so a token arriving in one chat does not re-render the whole list. */
const ChatRow = memo(function ChatRow({
  chat,
  index,
  active,
  streaming,
  inProject = false
}: {
  chat: ChatListItem
  index: number
  active: boolean
  streaming: boolean
  /** Under a project rather than in Chats: it can move back out. */
  inProject?: boolean
}): JSX.Element {
  // Read here rather than take an `onOpen` prop: `openChat` is a stable
  // reference from the store, so `chat`/`index`/`active`/`streaming` are now
  // the only props ChatRow ever receives, and they only change for a row
  // whose own chat actually changed — memo() can finally do its job.
  const { openChat, renameChat, togglePin, archiveChat, deleteChat } = useApp(
    useShallow((st) => ({
      openChat: st.openChat,
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

  const commitRename = (): void => {
    setRenaming(false)
    if (draft.trim() && draft !== chat.title) renameChat(chat.id, draft.trim())
    else setDraft(chat.title)
  }

  return (
    <>
      <div
        ref={anchor}
        className="nav-item nav-item--staggered"
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
        {renaming ? (
          <input
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
        ) : (
          <span className="nav-item__label">{chat.title}</span>
        )}
        <span className="nav-item__trail" data-always={streaming || failed || pinned ? 'true' : undefined}>
          {streaming ? (
            <Loader2 size={14} strokeWidth={2} className="spinner" role="img" aria-label="Replying" />
          ) : failed ? (
            <CircleAlert size={14} strokeWidth={2} color="var(--danger)" role="img" aria-label="The last reply failed">
              <title>The last reply failed</title>
            </CircleAlert>
          ) : pinned ? (
            <Pin size={13} strokeWidth={2} role="img" aria-label="Pinned" />
          ) : null}
        </span>
      </div>

      {menu && (
        <ContextMenu
          x={menu.x}
          y={menu.y}
          onClose={() => setMenu(null)}
          items={[
            {
              icon: <PencilLine size={15} strokeWidth={1.9} />,
              label: 'Rename',
              action: () => {
                setDraft(chat.title)
                setRenaming(true)
              }
            },
            {
              icon: <Pin size={15} strokeWidth={1.9} />,
              label: pinned ? 'Unpin' : 'Pin',
              action: () => togglePin(chat.id)
            },
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
      {moving && <FolderMenu anchor={anchor} open onClose={() => setMoving(false)} onChoose={moveTo} none={inProject ? 'Move to Chats' : undefined} />}
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
      <div ref={anchor} style={{ position: 'fixed', left: x, top: y, width: 1, height: 1 }} />
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

function SearchMenu({
  anchor,
  open,
  onClose
}: {
  anchor: React.RefObject<HTMLElement>
  open: boolean
  onClose: () => void
}): JSX.Element {
  const [query, setQuery] = useState('')
  const openChat = useApp((s) => s.openChat)

  // Read when the query changes, not subscribed: this stays mounted while
  // closed, and a subscription re-ran a full-text search of every chat on
  // every streamed token whenever an earlier query was still in the box.
  const results = useMemo(() => {
    if (!open) return []
    const chats = useApp.getState().visibleChats()
    const q = query.trim().toLowerCase()
    if (!q) return chats.slice(0, 8)
    return chats
      .filter(
        (chat) =>
          chat.title.toLowerCase().includes(q) ||
          chat.messages.some((m) => m.parts.some((p) => p.type !== 'tool' && p.text.toLowerCase().includes(q)))
      )
      .slice(0, 12)
  }, [query, open])

  return (
    <Popover anchor={anchor} open={open} onClose={onClose} placement="bottom-end" width={300}>
      <MenuSearch value={query} onChange={setQuery} placeholder="Search chats" />
      {results.length === 0 ? (
        <div className="menu__empty">No chats found</div>
      ) : (
        results.map((chat) => (
          <MenuItem
            key={chat.id}
            title={chat.title}
            onClick={() => {
              openChat(chat.id)
              onClose()
            }}
          />
        ))
      )}
    </Popover>
  )
}
