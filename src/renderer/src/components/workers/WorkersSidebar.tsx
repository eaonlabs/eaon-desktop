import { useShallow } from 'zustand/react/shallow'
import { AtSign, Clock3, Loader2, MessagesSquare, Plus, Settings as SettingsIcon, Users, UsersRound } from 'lucide-react'
import { useApp } from '../../state/store'
import { NavItem } from '../Sidebar'
import { useWorkers } from './workersStore'
import { WorkerFace } from './WorkerFace'
import { MAX_WORKERS, workerMood } from '@shared/workers'

const ICON = { size: 16, strokeWidth: 1.9 } as const

/**
 * The Workers tab's sidebar: the team, one row per worker with its face, plus
 * Scheduled — the other thing in the app that runs on its own.
 */
export function WorkersNav(): JSX.Element {
  const { view, setView, setSettingsPage } = useApp(
    useShallow((s) => ({ view: s.view, setView: s.setView, setSettingsPage: s.setSettingsPage }))
  )
  const { workers, selectedId, select, openEditor, now, rooms, selectedRoomId, selectRoom, openRoomEditor, openTeamDialog } = useWorkers(
    useShallow((s) => ({
      workers: s.workers,
      selectedId: s.selectedId,
      select: s.select,
      openEditor: s.openEditor,
      now: s.now,
      rooms: s.rooms,
      selectedRoomId: s.selectedRoomId,
      selectRoom: s.selectRoom,
      openRoomEditor: s.openRoomEditor,
      openTeamDialog: s.openTeamDialog
    }))
  )
  const full = workers.length >= MAX_WORKERS
  const show = (id: string | null): void => {
    select(id)
    if (id === null) selectRoom(null)
    if (view !== 'chat') setView('chat')
  }
  const showRoom = (id: string): void => {
    selectRoom(id)
    if (view !== 'chat') setView('chat')
  }

  return (
    <>
      <NavItem
        icon={<Plus {...ICON} />}
        label="New worker"
        onClick={() => {
          if (view !== 'chat') setView('chat')
          openEditor(null)
        }}
      />
      <NavItem
        icon={<UsersRound {...ICON} />}
        label="New team"
        onClick={() => {
          if (view !== 'chat') setView('chat')
          openTeamDialog(true)
        }}
      />
      <NavItem icon={<Users {...ICON} />} label="Team" active={view === 'chat' && selectedId === null && selectedRoomId === null} onClick={() => show(null)} />
      <NavItem icon={<Clock3 {...ICON} />} label="Scheduled" active={view === 'scheduled'} onClick={() => setView('scheduled')} />
      <NavItem
        icon={<AtSign {...ICON} />}
        label="Plugins"
        active={view === 'plugins' || view === 'integrations'}
        onClick={() => setView('plugins')}
      />
      <NavItem icon={<SettingsIcon {...ICON} />} label="Settings" onClick={() => setSettingsPage('general')} />

      {(rooms.length > 0 || workers.length > 1) && (
        <>
          <div className="sidebar__section sidebar__section--action">
            <span>Group chats</span>
            <button className="sidebar__section-btn" aria-label="New group chat" title="New group chat" onClick={() => openRoomEditor(null)}>
              <Plus size={14} strokeWidth={2} />
            </button>
          </div>
          {rooms.length === 0 ? (
            <div className="sidebar__empty">No group chats yet</div>
          ) : (
            rooms.map((room) => {
              const answering = workers.some((w) => w.runningRooms?.includes(room.id))
              return (
                <button
                  key={room.id}
                  className="nav-item nav-item--worker"
                  data-active={(view === 'chat' && selectedRoomId === room.id) || undefined}
                  onClick={() => showRoom(room.id)}
                >
                  <span className="nav-item__icon">
                    <MessagesSquare size={15} strokeWidth={1.9} />
                  </span>
                  <span className="nav-item__label">{room.name}</span>
                  <span className="nav-item__trail" data-always={answering || room.unread > 0 ? 'true' : undefined}>
                    {answering ? (
                      <Loader2 size={13} strokeWidth={2} className="spinner" />
                    ) : room.unread > 0 ? (
                      <span className="unread-badge">{room.unread > 9 ? '9+' : room.unread}</span>
                    ) : null}
                  </span>
                </button>
              )
            })
          )}
        </>
      )}

      <div className="sidebar__section sidebar__section--action">
        <span>Workers</span>
        {!full && (
          <button className="sidebar__section-btn" aria-label="New worker" title="New worker" onClick={() => openEditor(null)}>
            <Plus size={14} strokeWidth={2} />
          </button>
        )}
      </div>
      {workers.length === 0 ? (
        <div className="sidebar__empty">No workers yet</div>
      ) : (
        workers.map((worker, index) => (
          <button
            key={worker.id}
            className="nav-item nav-item--staggered nav-item--worker"
            style={{ ['--i' as string]: Math.min(index, 12) }}
            data-active={(view === 'chat' && selectedId === worker.id) || undefined}
            onClick={() => show(worker.id)}
          >
            <span className="nav-item__icon nav-item__icon--face">
              <WorkerFace color={worker.color} mood={workerMood(worker, now)} size={18} busy={worker.status === 'working'} attention={worker.asks.length > 0} />
            </span>
            <span className="nav-item__label">{worker.name}</span>
            <span className="nav-item__trail" data-always={worker.status === 'working' || worker.unread > 0 ? 'true' : undefined}>
              {worker.status === 'working' ? (
                <Loader2 size={13} strokeWidth={2} className="spinner" />
              ) : worker.unread > 0 ? (
                <span className="unread-badge">{worker.unread > 9 ? '9+' : worker.unread}</span>
              ) : null}
            </span>
          </button>
        ))
      )}
    </>
  )
}
