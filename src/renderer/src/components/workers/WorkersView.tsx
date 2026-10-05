import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { useShallow } from 'zustand/react/shallow'
import {
  CandlestickChart,
  AlarmClock,
  ArrowLeft,
  Clock,
  Eraser,
  FileText,
  FolderOpen,
  HeartPulse,
  MessagesSquare,
  MonitorPlay,
  MoreHorizontal,
  Pause,
  PencilLine,
  Play,
  Plus,
  Trash2,
  Users,
  X
} from 'lucide-react'
import { resolveSelection } from '@shared/modelSelection'
import { useApp } from '../../state/store'
import { TopBar } from '../TopBar'
import { MessageRow } from '../ChatView'
import { ContextMenu } from '../Sidebar'
import { Modal } from '../ui'
import { WorkerFace } from './WorkerFace'
import { WorkerEditor } from './WorkerEditor'
import { WorkerAsks, WorkerBrowserFact, WorkerGoalBanner, WorkerMemory } from './WorkerAutonomy'
import { WorkerComposer } from './WorkerComposer'
import { RoomEditor, RoomPage, TeamDialog } from './WorkerRooms'
import { useWorkers } from './workersStore'
import { fileName, fileUrl, isImagePath } from '../../lib/files'
import { MAX_WORKERS, TRADING_DESK, describeWorker, relativeTime, workerMood, type Worker } from '@shared/workers'
import type { McpServer } from '@shared/types'
import { CHANNEL_LABEL } from '@shared/channels'
import { ChannelLogo } from '../channels/ChannelLogo'
import { useChannels } from '../channels/channelsStore'

/**
 * The Workers tab: the team at a glance, or one worker's page — its face, its
 * one long thread and a box to write to it. Workers run in the main process;
 * everything here is a view onto them.
 */
export function WorkersView(): JSX.Element {
  const { selectedId, selectedRoomId, editing, roomEditor, teamDialog, workers, rooms } = useWorkers(
    useShallow((s) => ({
      selectedId: s.selectedId,
      selectedRoomId: s.selectedRoomId,
      editing: s.editing,
      roomEditor: s.roomEditor,
      teamDialog: s.teamDialog,
      workers: s.workers,
      rooms: s.rooms
    }))
  )
  const worker = workers.find((w) => w.id === selectedId) ?? null
  const room = rooms.find((r) => r.id === selectedRoomId) ?? null
  return (
    <>
      {room ? <RoomPage key={room.id} room={room} /> : worker ? <WorkerPage key={worker.id} worker={worker} /> : <Team />}
      {editing && <WorkerEditor workerId={editing.workerId} />}
      {roomEditor && <RoomEditor roomId={roomEditor.roomId} />}
      {teamDialog && <TeamDialog />}
    </>
  )
}

/* ------------------------------------------------------------------ Team */

function Team(): JSX.Element {
  const { workers, ready, openEditor, select, now, openTeamDialog } = useWorkers(
    useShallow((s) => ({ workers: s.workers, ready: s.ready, openEditor: s.openEditor, select: s.select, now: s.now, openTeamDialog: s.openTeamDialog }))
  )
  const working = workers.filter((w) => w.status === 'working').length

  return (
    <div className="page">
      <TopBar
        variant="page__bar"
        right={
          workers.length > 0 && workers.length < MAX_WORKERS ? (
            <div className="chat-header__actions">
              <button className="header-btn" onClick={() => openTeamDialog(true)} title="Several specialists and a group chat, in one go">
                <Users size={14} strokeWidth={2} />
                <span>New team</span>
              </button>
              <button className="header-btn" onClick={() => openEditor(null)}>
                <Plus size={14} strokeWidth={2} />
                <span>New worker</span>
              </button>
            </div>
          ) : null
        }
      />
      <div className="page__scroll scroll">
        <div className="page__inner page__inner--wide team">
          {!ready ? null : workers.length === 0 ? (
            <TeamEmpty onCreate={() => openEditor(null)} onTeam={() => openTeamDialog(true)} />
          ) : (
            <>
              <h1 className="page__title">Your team</h1>
              <p className="page__subtitle">
                {working > 0
                  ? `${working} of ${workers.length} working right now.`
                  : `${workers.length} worker${workers.length === 1 ? '' : 's'}, standing by.`}{' '}
                Each keeps its own thread, wakes itself up when something needs checking, and hands work to the others. Up to 4 work at the same time.
              </p>
              <BackgroundHint />
              <div className="team__grid">
                {workers.map((worker, index) => (
                  <WorkerCard key={worker.id} worker={worker} now={now} index={index} onOpen={() => select(worker.id)} />
                ))}
                {workers.length < MAX_WORKERS && (
                  <button className="worker-card worker-card--new" onClick={() => openEditor(null)} style={{ ['--i' as string]: workers.length }}>
                    <span className="worker-card__new-ring">
                      <Plus size={22} strokeWidth={1.8} />
                    </span>
                    <span className="worker-card__name">New worker</span>
                    <span className="worker-card__purpose">Give it a name, a colour, a personality and a job.</span>
                  </button>
                )}
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  )
}

function TeamEmpty({ onCreate, onTeam }: { onCreate: () => void; onTeam: () => void }): JSX.Element {
  return (
    <div className="team-empty">
      <div className="team-empty__faces" aria-hidden="true">
        <WorkerFace color="#8E5CE6" mood="happy" size={56} />
        <WorkerFace color="#3E86C6" mood="neutral" size={84} follow />
        <WorkerFace color="#EE8A36" mood="serious" size={56} />
      </div>
      <h1 className="team-empty__title">Meet Eaon Workers</h1>
      <p className="team-empty__text">
        Workers are agents that live on your computer and keep going around the clock. Give one a job — watching a training
        run, tidying your inbox, researching every morning — and it schedules its own check-ins, remembers everything in
        one long thread, and asks its teammates for help when a job is bigger than one worker.
      </p>
      <div className="team-empty__actions">
        <button className="btn btn--primary btn--lg" onClick={onCreate}>
          <Plus size={16} strokeWidth={2} />
          Create your first worker
        </button>
        <button className="btn btn--lg" onClick={onTeam}>
          <Users size={16} strokeWidth={2} />
          Start a team
        </button>
      </div>
    </div>
  )
}

/**
 * Workers only run while Eaon does. With the window closed that is still the
 * case on macOS, but after a quit or a restart they wait for the next launch —
 * unless background mode starts Eaon at login.
 */
function BackgroundHint(): JSX.Element | null {
  const [state, setState] = useState<{ supported: boolean; enabled: boolean } | null>(null)
  const [dismissed, setDismissed] = useState(() => {
    try {
      return localStorage.getItem('eaon.workers.bgHint') === 'dismissed'
    } catch {
      return false
    }
  })
  useEffect(() => {
    void window.api.app.background().then(setState)
  }, [])
  if (!state?.supported || state.enabled || dismissed) return null
  return (
    <div className="team-hint">
      <Clock size={15} strokeWidth={1.9} />
      <span>Workers keep going while Eaon is open, even with its window closed. To have them start again after a restart, let Eaon run in the background.</span>
      <button className="btn btn--sm" onClick={() => void window.api.app.setBackground(true).then(setState)}>
        Run in background
      </button>
      <button
        className="icon-btn"
        aria-label="Dismiss"
        onClick={() => {
          setDismissed(true)
          try {
            localStorage.setItem('eaon.workers.bgHint', 'dismissed')
          } catch {
            /* private storage — the hint just comes back next time */
          }
        }}
      >
        <X size={14} strokeWidth={2} />
      </button>
    </div>
  )
}

function WorkerCard({ worker, now, index, onOpen }: { worker: Worker; now: number; index: number; onOpen: () => void }): JSX.Element {
  const mood = workerMood(worker, now)
  return (
    <button className="worker-card" data-status={worker.status} onClick={onOpen} style={{ ['--i' as string]: index }}>
      <span className="worker-card__face">
        <WorkerFace
          color={worker.color}
          mood={mood}
          size={72}
          follow
          enter
          busy={worker.status === 'working'}
          attention={worker.asks.length > 0}
          nudge={worker.inbox.length}
          title={`${worker.name} looks ${mood}`}
        />
        {worker.unread > 0 && <span className="unread-badge worker-card__badge">{worker.unread > 9 ? '9+' : worker.unread}</span>}
      </span>
      <span className="worker-card__name">{worker.name}</span>
      <span className="worker-card__purpose">{worker.purpose || 'No purpose yet'}</span>
      <span className="worker-card__status" data-status={worker.paused ? 'paused' : worker.status}>
        <span className="status-dot" />
        <span className="worker-card__status-text">{describeWorker(worker, now)}</span>
      </span>
    </button>
  )
}

/* ------------------------------------------------------------------ Worker page */

function WorkerPage({ worker }: { worker: Worker }): JSX.Element {
  const { threads, select, now, markRead } = useWorkers(
    useShallow((s) => ({ threads: s.threads, select: s.select, now: s.now, markRead: s.markRead }))
  )
  const thread = threads[worker.id]
  const mood = workerMood(worker, now)
  const scroller = useRef<HTMLDivElement>(null)
  const following = useRef(true)

  useEffect(() => {
    if (!thread) void useWorkers.getState().loadThread(worker.id)
  }, [thread, worker.id])

  // Reading the page is reading the thread.
  useEffect(() => {
    if (worker.unread > 0) markRead(worker.id)
  }, [worker.unread, worker.id, markRead])

  useLayoutEffect(() => {
    const node = scroller.current
    if (node && following.current) node.scrollTop = node.scrollHeight
  }, [thread?.messages, worker.inbox.length])

  const queued = worker.inbox.filter((mail) => mail.from === 'user')

  return (
    <>
      <TopBar
        left={
          <>
            <button className="header-btn worker-back" onClick={() => select(null)} title="Back to the team">
              <ArrowLeft size={14} strokeWidth={2} />
              <span>Team</span>
            </button>
            <span className="worker-title">
              <WorkerFace color={worker.color} mood={mood} size={20} />
              <span className="chat-header__title">{worker.name}</span>
            </span>
          </>
        }
        right={<WorkerActions worker={worker} />}
      />

      <div
        ref={scroller}
        className="thread scroll"
        onScroll={(e) => {
          const node = e.currentTarget
          following.current = node.scrollHeight - node.scrollTop - node.clientHeight < 8
        }}
        onWheel={(e) => {
          if (e.deltaY < 0) following.current = false
        }}
      >
        <div className="thread__inner">
          <WorkerProfile worker={worker} now={now} mood={mood} />
          {thread?.summary && (
            <div className="worker-compacted">
              <span>Earlier messages were summarised to keep {worker.name}’s thread light.</span>
            </div>
          )}
          {thread && thread.messages.length === 0 && worker.inbox.length === 0 && (
            <p className="worker-first-job">
              Send {worker.name} its first job below. It takes it from there — scheduling its own check-ins and asking the team
              for help when it needs to.
            </p>
          )}
          {thread?.messages.map((message) => (
            <MessageRow key={message.id} message={message} streaming={message.id === worker.runningMessageId} quietWhenEmpty />
          ))}
          {queued.map((mail) => (
            <div key={mail.id} className="msg-row msg-user-block msg-row--queued">
              {mail.files.length > 0 && (
                <div className="msg-attachments" data-align="end">
                  {mail.files.map((path) =>
                    isImagePath(path) ? (
                      <span key={path} className="msg-attachment msg-attachment--media">
                        <img src={fileUrl(path)} alt={fileName(path)} />
                      </span>
                    ) : (
                      <span key={path} className="msg-attachment msg-attachment--file">
                        <FileText size={15} strokeWidth={1.8} />
                        <span>{fileName(path)}</span>
                      </span>
                    )
                  )}
                </div>
              )}
              {mail.text && <div className="msg--user">{mail.text}</div>}
              <span className="msg__queued">
                <Clock size={11} strokeWidth={2.2} />
                {worker.status === 'working' ? `Queued — ${worker.name} reads this when it finishes what it’s doing` : 'Delivering…'}
              </span>
            </div>
          ))}
        </div>
      </div>

      <div className="composer-dock">
        <WorkerGoalBanner worker={worker} now={now} />
        <WorkerAsks worker={worker} />
        <WorkerComposer worker={worker} />
      </div>
    </>
  )
}

/** "the trading desk", "Robinhood", or the name of a server the user added. */
function tradingAccountName(via: string, servers: McpServer[]): string {
  if (via === TRADING_DESK) return 'the trading desk'
  return servers.find((s) => s.id === via)?.name ?? 'a removed account'
}

/** The face, the job and the pulse — at the top of the thread, where a chat has nothing. */
function WorkerProfile({ worker, now, mood }: { worker: Worker; now: number; mood: ReturnType<typeof workerMood> }): JSX.Element {
  const providers = useApp((s) => s.providers)
  // A pinned model that's gone says so; it used to read "Uses your selected model", which it doesn't.
  const pinned = worker.model ? resolveSelection(worker.model, providers) : null
  const creator = useWorkers((s) => (worker.createdBy ? s.workers.find((w) => w.id === worker.createdBy) : null))
  const servers = useApp((s) => s.mcpServers)
  return (
    <div className="worker-profile">
      <WorkerFace
        color={worker.color}
        mood={mood}
        size={96}
        follow
        busy={worker.status === 'working'}
        attention={worker.asks.length > 0}
        nudge={worker.inbox.length}
      />
      <h1 className="worker-profile__name">{worker.name}</h1>
      <p className="worker-profile__purpose">{worker.purpose}</p>
      <div className="worker-profile__facts">
        <span className="worker-fact" data-status={worker.paused ? 'paused' : worker.status} title={statusLine(worker)}>
          <span className="status-dot" />
          <span className="worker-fact__text">{statusLine(worker)}</span>
        </span>
        {worker.heartbeat.nextAt !== null && !worker.paused && (
          <span className="worker-fact" title={worker.heartbeat.note || undefined}>
            <HeartPulse size={13} strokeWidth={2} />
            <span className="worker-fact__text">
              {worker.heartbeat.everyMs
                ? `Every ${Math.round(worker.heartbeat.everyMs / 60_000)} min, next ${relativeTime(worker.heartbeat.nextAt, now)}`
                : `Wakes ${relativeTime(worker.heartbeat.nextAt, now)}`}
              {worker.heartbeat.note ? ` · ${worker.heartbeat.note}` : ''}
            </span>
          </span>
        )}
        <span className="worker-fact" title={pinned?.reason ?? undefined}>
          <span className="worker-fact__text">
            {!pinned ? 'Uses your selected model' : pinned.model ? pinned.model.label : `${pinned.wanted?.label ?? worker.model!.modelId} · unavailable`}
          </span>
        </span>
        {worker.trading && (
          <span className="worker-fact" title={worker.trading.strategy || undefined}>
            <CandlestickChart size={13} strokeWidth={2} />
            <span className="worker-fact__text">
              Trades on {tradingAccountName(worker.trading.via, servers)} · every {worker.trading.everyMinutes} min while the market is open ·{' '}
              {worker.trading.autoPlace ? 'places orders itself' : 'asks before each order'}
            </span>
          </span>
        )}
        {worker.access !== 'autonomous' && (
          <span className="worker-fact">{worker.access === 'read-only' ? 'Look only' : 'Careful'}</span>
        )}
        {creator && (
          <span className="worker-fact">
            <WorkerFace color={creator.color} size={14} />
            Created by {creator.name}
          </span>
        )}
        <ConnectedApps worker={worker} />
        <WorkerBrowserFact worker={worker} />
      </div>
      {worker.personality && <p className="worker-profile__personality">“{worker.personality}”</p>}
      <WorkerMemory worker={worker} now={now} />
    </div>
  )
}

/** Settings → Chat apps, with this worker chosen for the next connection. */
function connectApp(workerId: string): void {
  useChannels.getState().focusWorker(workerId)
  useApp.getState().setSettingsPage('chat-apps')
}

/** The chat apps this worker answers in, as facts on its profile. */
function ConnectedApps({ worker }: { worker: Worker }): JSX.Element | null {
  const { links, statuses, init } = useChannels(useShallow((s) => ({ links: s.links, statuses: s.statuses, init: s.init })))
  useEffect(() => {
    void init()
  }, [init])
  const mine = links.filter((l) => l.workerId === worker.id && l.enabled)
  if (mine.length === 0) return null
  return (
    <>
      {mine.map((link) => (
        <button
          key={link.id}
          className="worker-fact worker-fact--app"
          title={statuses[link.id]?.state === 'connected' ? `Answers in ${CHANNEL_LABEL[link.kind]}` : `${CHANNEL_LABEL[link.kind]} isn’t connected right now`}
          onClick={() => connectApp(worker.id)}
        >
          <ChannelLogo kind={link.kind} size={14} />
          {link.account ?? CHANNEL_LABEL[link.kind]}
          {statuses[link.id]?.state === 'scan' ? ' · scan to link' : statuses[link.id]?.state !== 'connected' ? ' · offline' : ''}
        </button>
      ))}
    </>
  )
}

/**
 * What the worker is doing, for the profile — the heartbeat has its own fact
 * beside it, so unlike `describeWorker` this never falls back to the schedule.
 */
function statusLine(worker: Worker): string {
  if (worker.paused) return 'Paused'
  if (worker.status === 'working') return worker.activity || 'Working…'
  if (worker.status === 'failed') return worker.lastError ? `Stopped: ${worker.lastError}` : 'Last task failed'
  if (worker.inbox.length > 0) return `${worker.inbox.length} message${worker.inbox.length === 1 ? '' : 's'} waiting`
  if (worker.lastRunAt === null) return 'Ready for its first job'
  return worker.activity || (worker.heartbeat.nextAt === null ? 'Asleep until you write' : 'Waiting for its next heartbeat')
}

function WorkerActions({ worker }: { worker: Worker }): JSX.Element {
  const { setPaused, wake, clear, remove, openEditor, browserOpen, setBrowser } = useWorkers(
    useShallow((s) => ({
      setPaused: s.setPaused,
      wake: s.wake,
      clear: s.clear,
      remove: s.remove,
      openEditor: s.openEditor,
      browserOpen: s.browserFor === worker.id,
      setBrowser: s.setBrowser
    }))
  )
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null)
  const [confirm, setConfirm] = useState<'clear' | 'delete' | null>(null)
  const working = worker.status === 'working'

  return (
    <div className="chat-header__actions">
      <button
        className="header-btn"
        data-active={browserOpen || undefined}
        onClick={() => (browserOpen ? setBrowser(null, worker.id) : setBrowser(worker.id))}
        title={browserOpen ? `Close ${worker.name}’s browser` : `Watch ${worker.name}’s own browser live, or take control to help it`}
      >
        <MonitorPlay size={14} strokeWidth={1.9} />
        <span>Browser</span>
      </button>
      {!worker.paused && !working && (
        <button className="header-btn" onClick={() => void wake(worker.id)} title={`Wake ${worker.name} now and have it check in`}>
          <AlarmClock size={14} strokeWidth={1.9} />
          <span>Check in</span>
        </button>
      )}
      <button
        className="header-btn"
        onClick={() => void setPaused(worker.id, !worker.paused)}
        title={worker.paused ? `Let ${worker.name} work again` : `Pause ${worker.name}: no heartbeats, mail waits`}
      >
        {worker.paused ? <Play size={14} strokeWidth={1.9} /> : <Pause size={14} strokeWidth={1.9} />}
        <span>{worker.paused ? 'Resume' : 'Pause'}</span>
      </button>
      <button
        className="icon-btn"
        aria-label="More"
        title="More"
        onClick={(e) => {
          const rect = e.currentTarget.getBoundingClientRect()
          setMenu({ x: rect.right - 188, y: rect.bottom })
        }}
      >
        <MoreHorizontal size={16} strokeWidth={1.9} />
      </button>
      {menu && (
        <ContextMenu
          x={menu.x}
          y={menu.y}
          onClose={() => setMenu(null)}
          items={[
            { icon: <PencilLine size={15} strokeWidth={1.9} />, label: 'Edit worker', action: () => openEditor(worker.id) },
            { icon: <FolderOpen size={15} strokeWidth={1.9} />, label: 'Open its folder', action: () => void window.api.app.showItem(worker.folder) },
            { icon: <MessagesSquare size={15} strokeWidth={1.9} />, label: 'Connect a chat app', action: () => connectApp(worker.id) },
            { icon: <Eraser size={15} strokeWidth={1.9} />, label: 'Clear messages', action: () => setConfirm('clear') },
            { icon: <Trash2 size={15} strokeWidth={1.9} />, label: 'Delete worker', danger: true, action: () => setConfirm('delete') }
          ]}
        />
      )}
      <Modal
        open={confirm === 'clear'}
        onClose={() => setConfirm(null)}
        title={`Clear ${worker.name}’s messages?`}
        actions={
          <>
            <button className="btn btn--ghost" onClick={() => setConfirm(null)}>
              Cancel
            </button>
            <button
              className="btn btn--danger"
              autoFocus
              onClick={() => {
                void clear(worker.id)
                setConfirm(null)
              }}
            >
              Clear messages
            </button>
          </>
        }
      >
        {worker.name} starts a fresh thread and forgets the conversation so far. Its job, personality, heartbeat and the files in
        its folder stay as they are.
      </Modal>
      <Modal
        open={confirm === 'delete'}
        onClose={() => setConfirm(null)}
        title={`Delete ${worker.name}?`}
        actions={
          <>
            <button className="btn btn--ghost" onClick={() => setConfirm(null)}>
              Cancel
            </button>
            <button
              className="btn btn--danger"
              autoFocus
              onClick={() => {
                void remove(worker.id)
                setConfirm(null)
              }}
            >
              Delete worker
            </button>
          </>
        }
      >
        {working ? `${worker.name} stops what it is doing, and its` : `${worker.name}’s`} thread is deleted. Its folder stays on disk at{' '}
        <code>{worker.folder}</code>.
      </Modal>
    </div>
  )
}
