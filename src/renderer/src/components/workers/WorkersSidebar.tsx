import { useShallow } from 'zustand/react/shallow'
import { AtSign, Clock3, Loader2, Plus, Settings as SettingsIcon, Users } from 'lucide-react'
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
  const { workers, selectedId, select, openEditor, now } = useWorkers(
    useShallow((s) => ({ workers: s.workers, selectedId: s.selectedId, select: s.select, openEditor: s.openEditor, now: s.now }))
  )
  const full = workers.length >= MAX_WORKERS
  const show = (id: string | null): void => {
    select(id)
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
      <NavItem icon={<Users {...ICON} />} label="Team" active={view === 'chat' && selectedId === null} onClick={() => show(null)} />
      <NavItem icon={<Clock3 {...ICON} />} label="Scheduled" active={view === 'scheduled'} onClick={() => setView('scheduled')} />
      <NavItem
        icon={<AtSign {...ICON} />}
        label="Plugins"
        active={view === 'plugins' || view === 'integrations'}
        onClick={() => setView('plugins')}
      />
      <NavItem icon={<SettingsIcon {...ICON} />} label="Settings" onClick={() => setSettingsPage('general')} />

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
              <WorkerFace color={worker.color} mood={workerMood(worker, now)} size={18} />
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
