import { memo, useMemo, useRef, useState } from 'react'
import { useShallow } from 'zustand/react/shallow'
import {
  ArrowRight,
  AtSign,
  Boxes,
  CircleAlert,
  Clock3,
  GitPullRequest,
  HelpCircle,
  Loader2,
  PanelLeft,
  Pin,
  Search,
  Settings as SettingsIcon,
  SquarePen,
  Trash2,
  Archive,
  PencilLine
} from 'lucide-react'
import { useApp, useIsWork } from '../state/store'
import { DownloadsButton } from './DownloadsPanel'
import { MenuItem, MenuSearch, Popover, useDisclosure } from './ui'
import type { Chat } from '@shared/types'

export function Sidebar(): JSX.Element {
  const { view, activeChatId, streamingMessageId, sidebarOpen, toggleSidebar, setView, setModelsRepo, newChat, setSettingsPage, goForward } = useApp(useShallow((s) => ({ view: s.view, activeChatId: s.activeChatId, streamingMessageId: s.streamingMessageId, sidebarOpen: s.sidebarOpen, toggleSidebar: s.toggleSidebar, setView: s.setView, setModelsRepo: s.setModelsRepo, newChat: s.newChat, setSettingsPage: s.setSettingsPage, goForward: s.goForward })))
  const canGoForward = useApp((s) => s.canGoForward())
  const chats = useApp(useShallow((s) => s.visibleChats()))
  const projects = useApp(useShallow((s) => s.visibleProjects()))

  const streamingChatId = streamingMessageId
    ? chats.find((c) => c.messages.some((m) => m.id === streamingMessageId))?.id
    : undefined

  const searchAnchor = useRef<HTMLButtonElement>(null)
  const searchMenu = useDisclosure()

  const isWork = useIsWork()
  return (
    <aside className="sidebar" data-open={sidebarOpen}>
      <div className="sidebar__content" aria-hidden={!sidebarOpen}>
      <div className="sidebar__panel">
      <div className="titlebar">
        <DownloadsButton />
        <button ref={searchAnchor} className="icon-btn" onClick={searchMenu.toggle} aria-label="Search chats" title="Search chats">
          <Search size={16} strokeWidth={1.9} />
        </button>
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
        <button className="nav-item" onClick={() => newChat()}>
          <span className="nav-item__icon">
            <SquarePen size={16} strokeWidth={1.9} />
          </span>
          <span className="nav-item__label">{isWork ? 'New task' : 'New chat'}</span>
        </button>
        {isWork && (
          <button
            className="nav-item"
            data-active={view === 'pull-requests' || undefined}
            onClick={() => setView('pull-requests')}
          >
            <span className="nav-item__icon">
              <GitPullRequest size={16} strokeWidth={1.9} />
            </span>
            <span className="nav-item__label">Pull requests</span>
          </button>
        )}
        <button
          className="nav-item"
          data-active={view === 'scheduled' || undefined}
          onClick={() => setView('scheduled')}
        >
          <span className="nav-item__icon">
            <Clock3 size={16} strokeWidth={1.9} />
          </span>
          <span className="nav-item__label">Scheduled</span>
        </button>
        <button
          className="nav-item"
          data-active={view === 'plugins' || view === 'integrations' || undefined}
          onClick={() => setView('plugins')}
        >
          <span className="nav-item__icon">
            <AtSign size={16} strokeWidth={1.9} />
          </span>
          <span className="nav-item__label">Plugins</span>
        </button>
        <button
          className="nav-item"
          data-active={view === 'models' || undefined}
          onClick={() => {
            setView('models')
            setModelsRepo(null)
          }}
        >
          <span className="nav-item__icon">
            <Boxes size={16} strokeWidth={1.9} />
          </span>
          <span className="nav-item__label">Models</span>
        </button>
        {!isWork && (
          <button className="nav-item" onClick={() => setSettingsPage('general')}>
            <span className="nav-item__icon">
              <SettingsIcon size={16} strokeWidth={1.9} />
            </span>
            <span className="nav-item__label">Settings</span>
          </button>
        )}

        <div className="sidebar__section">Projects</div>
        {projects.length === 0 ? (
          <div className="sidebar__empty">No projects</div>
        ) : (
          projects.map((project) => (
            <button key={project.id} className="nav-item" onClick={() => newChat(project.id)}>
              <span className="nav-item__label">{project.name}</span>
            </button>
          ))
        )}

        {/* Found once here instead of scanning every chat's messages inside the
            .map() below — same O(messages) cost, but paid once per render
            instead of once per row. */}
        <div className="sidebar__section">Recents</div>
        {chats.length === 0 ? (
          <div className="sidebar__empty">No chats</div>
        ) : (
          chats.map((chat, index) => (
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

      <div className="sidebar__footer" data-split={isWork || undefined}>
        {isWork && (
          <button className="footer-item" onClick={() => setSettingsPage('general')}>
            <SettingsIcon size={16} strokeWidth={1.9} />
            <span>Settings</span>
          </button>
        )}
        <button
          className="icon-btn"
          aria-label="Help"
          onClick={() => window.api.app.openExternal('https://github.com/')}
        >
          <HelpCircle size={16} strokeWidth={1.9} />
        </button>
      </div>
      </div>
      </div>
    </aside>
  )
}

/** Memoised so a token arriving in one chat does not re-render the whole list. */
const ChatRow = memo(function ChatRow({
  chat,
  index,
  active,
  streaming
}: {
  chat: Chat
  index: number
  active: boolean
  streaming: boolean
}): JSX.Element {
  // Read here rather than take an `onOpen` prop: `openChat` is a stable
  // reference from the store, so `chat`/`index`/`active`/`streaming` are now
  // the only props ChatRow ever receives, and they only change for a row
  // whose own chat actually changed — memo() can finally do its job.
  const { openChat, renameChat, archiveChat, deleteChat } = useApp(
    useShallow((st) => ({
      openChat: st.openChat,
      renameChat: st.renameChat,
      archiveChat: st.archiveChat,
      deleteChat: st.deleteChat
    }))
  )
  const anchor = useRef<HTMLDivElement>(null)
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null)
  const [renaming, setRenaming] = useState(false)
  const [draft, setDraft] = useState(chat.title)

  const failed = chat.messages.some((m) => m.error)
  const pinned = chat.pinned

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
              action: () => {
                // Read lazily: subscribing to `chats` here re-rendered every
                // row on every streamed token.
                const next = useApp.getState().chats.map((c) => (c.id === chat.id ? { ...c, pinned: !c.pinned } : c))
                useApp.setState({ chats: next })
                void window.api.chats.save(next)
              }
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
  const chats = useApp(useShallow((s) => s.visibleChats()))
  const openChat = useApp((s) => s.openChat)

  const results = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return chats.slice(0, 8)
    return chats
      .filter(
        (chat) =>
          chat.title.toLowerCase().includes(q) ||
          chat.messages.some((m) => m.parts.some((p) => p.type !== 'tool' && p.text.toLowerCase().includes(q)))
      )
      .slice(0, 12)
  }, [query, chats])

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
