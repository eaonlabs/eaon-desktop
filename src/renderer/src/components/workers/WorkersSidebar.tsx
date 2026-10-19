import { useEffect, useState } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { AtSign, Clock3, HardDrive, Loader2, MessagesSquare, Plus, Settings as SettingsIcon, Users, UsersRound } from 'lucide-react'
import { useApp } from '../../state/store'
import { NavItem } from '../Sidebar'
import { useWorkers } from './workersStore'
import { WorkerFace } from './WorkerFace'
import { MAX_WORKERS, describeWorker, workerMood, type Worker } from '@shared/workers'
import type { WorkerHostState } from '@shared/workerHost'

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
      <NavItem icon={<Clock3 {...ICON} />} label="Automations" active={view === 'scheduled'} onClick={() => setView('scheduled')} />
      <NavItem
        icon={<AtSign {...ICON} />}
        label="Plugins"
        active={view === 'plugins' || view === 'integrations'}
        onClick={() => setView('plugins')}
      />
      <NavItem icon={<SettingsIcon {...ICON} />} label="Settings" onClick={() => setSettingsPage('general')} />
      <WorkerHostRow onOpen={() => setSettingsPage('worker-computer')} />

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
        workers.map((worker, index) => {
          const at = lastSeen(worker)
          return (
            <button
              key={worker.id}
              className="nav-item nav-item--staggered nav-item--worker worker-row"
              style={{ ['--i' as string]: Math.min(index, 12) }}
              data-active={(view === 'chat' && selectedId === worker.id) || undefined}
              data-unread={worker.unread > 0 || undefined}
              onClick={() => show(worker.id)}
            >
              <span className="worker-row__face">
                <WorkerFace color={worker.color} mood={workerMood(worker, now)} size={30} attention={worker.asks.length > 0} />
              </span>
              <span className="worker-row__text">
                <span className="worker-row__top">
                  <span className="worker-row__name">{worker.name}</span>
                  {at !== null && <span className="worker-row__time">{shortTime(at, now)}</span>}
                </span>
                <span className="worker-row__bottom">
                  <span className="worker-row__preview">{describeWorker(worker, now)}</span>
                  {worker.status === 'working' ? (
                    <Loader2 size={13} strokeWidth={2} className="spinner worker-row__trail" />
                  ) : worker.unread > 0 ? (
                    <span className="unread-badge worker-row__trail">{worker.unread > 9 ? '9+' : worker.unread}</span>
                  ) : null}
                </span>
              </span>
            </button>
          )
        })
      )}
    </>
  )
}

/** Where the workers run, while that's a linked worker computer: its name, and whether it's reachable. */
function WorkerHostRow({ onOpen }: { onOpen: () => void }): JSX.Element | null {
  const [state, setState] = useState<WorkerHostState | null>(null)
  useEffect(() => {
    void window.api.workerHost.state().then(setState)
    return window.api.workerHost.onState(setState)
  }, [])
  if (!state?.host || !state.enabled) return null
  const tone = state.connection === 'connected' ? 'ok' : state.connection === 'offline' ? 'off' : 'wait'
  const title =
    state.connection === 'connected'
      ? `Your workers run on ${state.host.name}`
      : state.connection === 'offline'
        ? `${state.host.name} can’t be reached; showing your workers as last seen`
        : `Connecting to ${state.host.name}`
  return (
    <button className="nav-item wh-where" onClick={onOpen} title={title}>
      <span className="nav-item__icon">
        <HardDrive {...ICON} />
      </span>
      <span className="nav-item__label">On {state.host.name}</span>
      <span className="wh-status" data-tone={tone}>
        <span className="wh-dot" aria-label={tone === 'ok' ? 'Online' : tone === 'off' ? 'Offline' : 'Connecting'} />
      </span>
    </button>
  )
}

/** When it last did something: the end of its last turn, or its start while one runs. */
function lastSeen(worker: Worker): number | null {
  if (worker.status === 'working') return null
  return worker.lastOutcome?.at ?? worker.lastRunAt
}

/** "9:41 AM" today, "Yesterday", a weekday this week, else a date. */
function shortTime(at: number, now: number): string {
  const date = new Date(at)
  const today = new Date(now)
  if (date.toDateString() === today.toDateString()) return date.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })
  if (date.toDateString() === new Date(now - 86_400_000).toDateString()) return 'Yesterday'
  if (now - at < 6 * 86_400_000) return date.toLocaleDateString(undefined, { weekday: 'short' })
  return date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
}
