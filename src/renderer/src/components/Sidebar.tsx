import { memo, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { useShallow } from 'zustand/react/shallow'
import {
  ArrowRight,
  AtSign,
  Boxes,
  ChevronRight,
  CircleAlert,
  Clock3,
  FolderClosed,
  CandlestickChart,
  GitPullRequest,
  HelpCircle,
  LibraryBig,
  Loader2,
  PanelLeft,
  Pin,
  Plus,
  Search,
  Settings as SettingsIcon,
  SquarePen,
  Trash2,
  Archive,
  PencilLine,
  ScrollText
} from 'lucide-react'
import { useApp, useWorkspaceKind, type ChatListItem } from '../state/store'
import { DownloadsButton } from './DownloadsPanel'
import { CodeSidebar } from './code/CodeSidebar'
import { openNewTerminal } from './code/terminal/terminalStore'
import { WorkersNav } from './workers/WorkersSidebar'
import { MenuItem, MenuSearch, Modal, Popover, useDisclosure } from './ui'
import type { Project } from '@shared/types'

export function Sidebar(): JSX.Element {
  const { sidebarOpen, toggleSidebar, goForward } = useApp(
    useShallow((s) => ({ sidebarOpen: s.sidebarOpen, toggleSidebar: s.toggleSidebar, goForward: s.goForward }))
  )
  const canGoForward = useApp((s) => s.canGoForward())

  const searchAnchor = useRef<HTMLButtonElement>(null)
  const searchMenu = useDisclosure()

  const kind = useWorkspaceKind()
  return (
    <aside className="sidebar" data-open={sidebarOpen}>
      <div className="sidebar__content" aria-hidden={!sidebarOpen}>
      <div className="sidebar__panel">
      <div className="titlebar">
        <DownloadsButton />
        {kind !== 'workers' && (
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
        <button
          className="icon-btn"
          aria-label="Help"
          title="Help"
          onClick={() => window.api.app.openExternal('https://github.com/eaonlabs/eaon-desktop#readme')}
        >
          <HelpCircle size={16} strokeWidth={1.9} />
        </button>
      </div>
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
 * Chat mode, laid out like the design spec's sidebar: the five destinations,
 * then Projects, then Recents. Scheduled tasks moved to the Workers tab —
 * things that run on their own live together there.
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
  const chats = useApp((s) => s.chatList())
  const projectChatIds = useApp(useShallow((s) => s.chats.filter((c) => c.projectId && !c.archived).map((c) => c.id)))
  const loose = useMemo(() => {
    const inProject = new Set(projectChatIds)
    return chats.filter((c) => !inProject.has(c.id))
  }, [chats, projectChatIds])

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
      <NavItem
        icon={<AtSign {...ICON} />}
        label="Plugins"
        active={view === 'plugins' || view === 'integrations'}
        onClick={() => setView('plugins')}
      />
      <NavItem icon={<SettingsIcon {...ICON} />} label="Settings" onClick={() => setSettingsPage('general')} />

      <Projects />

      <div className="sidebar__section">Recents</div>
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
    </>
  )
}

/** The ADE: its sessions and folders, plus the pages that belong to coding. */
function AdeNav(): JSX.Element {
  const { view, setView, setModelsRepo, setSettingsPage } = useApp(
    useShallow((s) => ({ view: s.view, setView: s.setView, setModelsRepo: s.setModelsRepo, setSettingsPage: s.setSettingsPage }))
  )
  return (
    <>
      <NavItem icon={<SquarePen {...ICON} />} label="New terminal" onClick={() => void openNewTerminal()} />
      <NavItem
        icon={<GitPullRequest {...ICON} />}
        label="Pull requests"
        active={view === 'pull-requests'}
        onClick={() => setView('pull-requests')}
      />
      <NavItem icon={<CandlestickChart {...ICON} />} label="Trading" active={view === 'trading'} onClick={() => setView('trading')} />
      <NavItem
        icon={<Boxes {...ICON} />}
        label="Models"
        active={view === 'models'}
        onClick={() => {
          setView('models')
          setModelsRepo(null)
        }}
      />
      <NavItem
        icon={<AtSign {...ICON} />}
        label="Plugins"
        active={view === 'plugins' || view === 'integrations'}
        onClick={() => setView('plugins')}
      />
      <NavItem icon={<SettingsIcon {...ICON} />} label="Settings" onClick={() => setSettingsPage('general')} />
      <CodeSidebar />
    </>
  )
}

/**
 * Projects group chats and give them shared instructions. Until now the
 * section only ever said "No projects" — there was no way to make one.
 * A project expands to its chats; its menu starts a chat in it, edits its
 * instructions, renames or deletes it.
 */
function Projects(): JSX.Element {
  const projects = useApp(useShallow((s) => s.visibleProjects()))
  const [editing, setEditing] = useState<Project | 'new' | null>(null)
  return (
    <>
      <div className="sidebar__section sidebar__section--action">
        <span>Projects</span>
        <button className="sidebar__section-btn" aria-label="New project" title="New project" onClick={() => setEditing('new')}>
          <Plus size={14} strokeWidth={2} />
        </button>
      </div>
      {projects.length === 0 ? (
        <div className="sidebar__empty">No projects</div>
      ) : (
        projects.map((project) => <ProjectRow key={project.id} project={project} onEdit={() => setEditing(project)} />)
      )}
      {editing && <ProjectDialog project={editing === 'new' ? null : editing} onClose={() => setEditing(null)} />}
    </>
  )
}

function ProjectRow({ project, onEdit }: { project: Project; onEdit: () => void }): JSX.Element {
  const { view, activeChatId, streamingChatId, newChat, deleteProject } = useApp(
    useShallow((s) => ({ view: s.view, activeChatId: s.activeChatId, streamingChatId: s.streamingChatId, newChat: s.newChat, deleteProject: s.deleteProject }))
  )
  const chats = useApp((s) => s.chatList())
  const ids = useApp(useShallow((s) => s.chats.filter((c) => c.projectId === project.id && !c.archived).map((c) => c.id)))
  const inProject = useMemo(() => chats.filter((c) => ids.includes(c.id)), [chats, ids])
  const containsActive = inProject.some((c) => c.id === activeChatId)
  const [open, setOpen] = useState(containsActive)
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null)
  // A chat opened (or just started) in this project must be visible, so the
  // row opens itself; closing it again is the user's call.
  useEffect(() => {
    if (containsActive) setOpen(true)
  }, [containsActive])

  return (
    <>
      <div
        className="nav-item nav-item--project"
        role="button"
        tabIndex={0}
        aria-expanded={open}
        onClick={() => setOpen(!open)}
        onKeyDown={(e) => e.key === 'Enter' && setOpen(!open)}
        onContextMenu={(e) => {
          e.preventDefault()
          setMenu({ x: e.clientX, y: e.clientY })
        }}
      >
        <span className="nav-item__icon">
          <FolderClosed size={15} strokeWidth={1.9} />
        </span>
        <span className="nav-item__label">{project.name}</span>
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
              <span className="nav-item__label">Start a chat in this project</span>
            </button>
          ) : (
            inProject.map((chat, index) => (
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
      {menu && (
        <ContextMenu
          x={menu.x}
          y={menu.y}
          onClose={() => setMenu(null)}
          items={[
            { icon: <SquarePen size={15} strokeWidth={1.9} />, label: 'New chat', action: () => newChat(project.id) },
            { icon: <ScrollText size={15} strokeWidth={1.9} />, label: 'Edit project', action: onEdit },
            { icon: <Trash2 size={15} strokeWidth={1.9} />, label: 'Delete project', danger: true, action: () => deleteProject(project.id) }
          ]}
        />
      )}
    </>
  )
}

/** Name and instructions for a project; the instructions ride along with every chat in it. */
function ProjectDialog({ project, onClose }: { project: Project | null; onClose: () => void }): JSX.Element {
  const { createProject, updateProject, newChat } = useApp(
    useShallow((s) => ({ createProject: s.createProject, updateProject: s.updateProject, newChat: s.newChat }))
  )
  const [name, setName] = useState(project?.name ?? '')
  const [instructions, setInstructions] = useState(project?.instructions ?? '')
  const submit = (): void => {
    if (!name.trim()) return
    if (project) updateProject(project.id, { name: name.trim(), instructions })
    else {
      const created = createProject(name.trim())
      if (instructions.trim()) updateProject(created.id, { instructions })
      newChat(created.id)
    }
    onClose()
  }
  return (
    <Modal
      open
      onClose={onClose}
      title={project ? 'Edit project' : 'New project'}
      width={480}
      actions={
        <>
          <button className="btn btn--ghost" onClick={onClose}>
            Cancel
          </button>
          <button className="btn btn--primary" disabled={!name.trim()} onClick={submit}>
            {project ? 'Save' : 'Create project'}
          </button>
        </>
      }
    >
      <label className="field">
        <span className="field-label">Name</span>
        <input
          autoFocus
          className="input"
          value={name}
          placeholder="Trip to Japan"
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && submit()}
        />
      </label>
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

/** Memoised so a token arriving in one chat does not re-render the whole list. */
const ChatRow = memo(function ChatRow({
  chat,
  index,
  active,
  streaming
}: {
  chat: ChatListItem
  index: number
  active: boolean
  streaming: boolean
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
        onClick={() => openChat(chat.id)}
        onKeyDown={(e) => e.key === 'Enter' && openChat(chat.id)}
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
              if (e.key === 'Enter') commitRename()
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
            <Loader2 size={14} strokeWidth={2} className="spinner" />
          ) : failed ? (
            <CircleAlert size={14} strokeWidth={2} color="var(--danger)" />
          ) : pinned ? (
            <Pin size={13} strokeWidth={2} />
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
              icon: <Archive size={15} strokeWidth={1.9} />,
              label: 'Archive',
              action: () => archiveChat(chat.id)
            },
            {
              icon: <Trash2 size={15} strokeWidth={1.9} />,
              label: 'Delete',
              danger: true,
              action: () => deleteChat(chat.id)
            }
          ]}
        />
      )}
    </>
  )
})

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
