import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { ArrowLeft, ArrowUp, Check, FileText, Loader2, MessagesSquare, MoreHorizontal, Paperclip, PencilLine, Trash2, Users, X } from 'lucide-react'
import { TopBar } from '../TopBar'
import { ContextMenu } from '../Sidebar'
import { Modal } from '../ui'
import { Markdown } from '../agent/Markdown'
import { useSuggest, type SuggestItem } from '../composer/SuggestMenu'
import { WorkerFace } from './WorkerFace'
import { RowBoundary } from '../ErrorBoundary'
import { useWorkers } from './workersStore'
import { fileName, fileUrl, isImagePath } from '../../lib/files'
import { MAX_ROOM_MEMBERS, MAX_WORKERS, WORKER_TEMPLATES, mentionedWorkers, workerMood, type RoomPost, type Worker, type WorkerRoom } from '@shared/workers'
import '../../styles/rooms.css'

/**
 * Group chats: the user and several workers in one conversation, plus the
 * dialogs that make them — one for a room of existing workers, one that
 * creates a whole team of specialists and gives it its first job.
 *
 * Everyone in a room hears the user's posts (or only those @mentioned); each
 * worker's reply is posted back here by the main process. A worker's own
 * post wakes only the colleagues it @mentions.
 */

const errorText = (e: unknown): string => (e instanceof Error ? e.message : String(e)).replace(/^Error invoking remote method '[^']+': (Error: )?/, '')

function timeOf(at: number): string {
  return new Date(at).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })
}

/* ------------------------------------------------------------------ Room page */

export function RoomPage({ room }: { room: WorkerRoom }): JSX.Element {
  const { workers, posts, selectRoom, now } = useWorkers(
    useShallow((s) => ({ workers: s.workers, posts: s.roomPosts[room.id], selectRoom: s.selectRoom, now: s.now }))
  )
  const members = room.members.map((id) => workers.find((w) => w.id === id)).filter((w): w is Worker => !!w)
  // Answering this room: a turn it woke is running, or its message here waits for a free slot.
  const answering = members.filter((m) => m.runningRooms?.includes(room.id) || m.inbox.some((mail) => mail.room?.id === room.id))
  const scroller = useRef<HTMLDivElement>(null)
  const following = useRef(true)

  useEffect(() => {
    if (room.unread > 0) void window.api.workers.markRoomRead(room.id)
  }, [room.unread, room.id])

  useLayoutEffect(() => {
    const node = scroller.current
    if (node && following.current) node.scrollTop = node.scrollHeight
  }, [posts?.length, answering.length])

  return (
    <>
      <TopBar
        left={
          <>
            <button className="header-btn worker-back" onClick={() => selectRoom(null)} title="Back to the team">
              <ArrowLeft size={14} strokeWidth={2} />
              <span>Team</span>
            </button>
            <span className="worker-title">
              <MessagesSquare size={16} strokeWidth={1.9} />
              <span className="chat-header__title">{room.name}</span>
            </span>
          </>
        }
        right={<RoomActions room={room} />}
      />
      <div
        ref={scroller}
        className="thread scroll"
        onScroll={(e) => {
          const node = e.currentTarget
          following.current = node.scrollHeight - node.scrollTop - node.clientHeight < 8
        }}
      >
        <div className="thread__inner room">
          <div className="room-intro">
            <div className="room-intro__faces">
              {members.map((m, index) => (
                <span key={m.id} className="room-intro__member" title={m.purpose} style={{ ['--i' as string]: index }}>
                  <WorkerFace
                    color={m.color}
                    mood={workerMood(m, now)}
                    size={44}
                    enter
                    busy={m.status === 'working'}
                    attention={m.asks.length > 0}
                  />
                  <span>{m.name}</span>
                </span>
              ))}
            </div>
            <p className="room-intro__text">
              Everyone here hears what you post and they work at the same time. Write <b>@Name</b> to talk to just one of them. When one of
              them @mentions a colleague, that colleague picks it up too.
            </p>
          </div>
          {!posts ? null : posts.length === 0 ? (
            <p className="worker-first-job">Give the team its first job below.</p>
          ) : (
            posts.map((post, i) => (
              <RowBoundary key={post.id} item={post}>
                <RoomPostRow post={post} worker={workers.find((w) => w.id === post.from)} grouped={i > 0 && posts[i - 1].from === post.from && post.at - posts[i - 1].at < 120_000} />
              </RowBoundary>
            ))
          )}
          {answering.length > 0 && (
            <div className="room-typing" aria-live="polite">
              {answering.map((m) => (
                <span key={m.id} className="room-typing__member">
                  <WorkerFace color={m.color} mood="serious" size={16} busy />
                  {m.name}
                </span>
              ))}
              <span className="room-typing__label">
                <Loader2 size={12} strokeWidth={2} className="spinner" />
                {answering.length === 1 ? 'is on it' : 'are on it'}
              </span>
            </div>
          )}
        </div>
      </div>
      <div className="composer-dock">
        <RoomComposer room={room} members={members} />
      </div>
    </>
  )
}

function RoomPostRow({ post, worker, grouped }: { post: RoomPost; worker: Worker | undefined; grouped: boolean }): JSX.Element {
  // Posts saved by an older build can be missing their file list.
  const paths = post.files ?? []
  const files =
    paths.length > 0 ? (
      <div className="msg-attachments" data-align={post.from === 'user' ? 'end' : 'start'}>
        {paths.map((path) =>
          isImagePath(path) ? (
            <span key={path} className="msg-attachment msg-attachment--media">
              <img src={fileUrl(path)} alt={fileName(path)} />
            </span>
          ) : (
            <span key={path} className="msg-attachment msg-attachment--file" title={path}>
              <FileText size={15} strokeWidth={1.8} />
              <span>{fileName(path)}</span>
            </span>
          )
        )}
      </div>
    ) : null
  if (post.from === 'user') {
    return (
      <div className="msg-row msg-user-block room-post--user">
        {files}
        {post.text && <div className="msg--user">{post.text}</div>}
      </div>
    )
  }
  return (
    <div className="room-post" data-grouped={grouped || undefined}>
      <span className="room-post__face">{!grouped && <WorkerFace color={worker?.color ?? post.fromColor ?? '#6B7280'} size={28} />}</span>
      <div className="room-post__body">
        {!grouped && (
          <div className="room-post__head">
            <span className="room-post__name" style={{ color: worker?.color ?? post.fromColor }}>
              {post.fromName}
            </span>
            <span className="room-post__time">{timeOf(post.at)}</span>
          </div>
        )}
        <div className="room-post__text">
          <Markdown text={post.text} />
        </div>
        {files}
      </div>
    </div>
  )
}

function RoomComposer({ room, members }: { room: WorkerRoom; members: Worker[] }): JSX.Element {
  const postToRoom = useWorkers((s) => s.postToRoom)
  const [text, setText] = useState('')
  const [files, setFiles] = useState<string[]>([])
  const [error, setError] = useState<string | null>(null)
  const box = useRef<HTMLTextAreaElement>(null)

  const suggest = useSuggest({
    text,
    setText,
    textarea: box,
    sources: {
      '@': () =>
        members.map(
          (w): SuggestItem => ({
            id: `worker:${w.id}`,
            title: w.name,
            keywords: `${w.purpose} worker`,
            description: w.purpose ? (w.purpose.length > 70 ? `${w.purpose.slice(0, 67)}…` : w.purpose) : undefined,
            section: 'In this group chat',
            icon: <WorkerFace color={w.color} size={18} />,
            insert: `@${w.name}`
          })
        )
    },
    label: { '@': 'Members' }
  })
  const only = mentionedWorkers(text, members)

  const submit = (): void => {
    if (!text.trim() && files.length === 0) return
    setError(null)
    postToRoom(room.id, text.trim(), files).catch((e) => setError(errorText(e)))
    setText('')
    setFiles([])
  }

  return (
    <div className="composer-stack composer-stack--chat">
      <div className="composer">
        {files.length > 0 && (
          <div className="composer__attachments">
            {files.map((path) => (
              <span key={path} className="attachment-chip" title={path}>
                {isImagePath(path) ? <img className="attachment-chip__thumb" src={fileUrl(path)} alt="" /> : <FileText size={14} strokeWidth={1.8} />}
                <span className="attachment-chip__name">{fileName(path)}</span>
                <button className="attachment-chip__remove" aria-label={`Remove ${path}`} onClick={() => setFiles((c) => c.filter((p) => p !== path))}>
                  <X size={12} strokeWidth={2.2} />
                </button>
              </span>
            ))}
          </div>
        )}
        <textarea
          ref={box}
          className="composer__input"
          rows={1}
          value={text}
          placeholder={members.length ? `Message ${room.name}` : 'Add workers to this group chat first'}
          disabled={members.length === 0}
          onChange={(e) => {
            setText(e.target.value)
            suggest.onCaret()
          }}
          onSelect={suggest.onCaret}
          onKeyDown={(e) => {
            if (suggest.onKeyDown(e)) return
            if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault()
              submit()
            }
          }}
        />
        <div className="composer__toolbar">
          <button
            className="composer__round"
            aria-label="Attach files"
            title="Attach files"
            onClick={() => void window.api.app.openFiles({ properties: ['openFile', 'openDirectory', 'multiSelections'] }).then((paths) => setFiles((c) => [...new Set([...c, ...paths])].slice(0, 12)))}
          >
            <Paperclip size={16} strokeWidth={1.9} />
          </button>
          <span className="room-composer__to">
            {only.length > 0 ? (
              <>
                To {only.map((w) => w.name).join(', ')} only
              </>
            ) : (
              <>
                <Users size={12} strokeWidth={2} /> Everyone hears this
              </>
            )}
          </span>
          <div className="composer__spacer" />
          <button className="send" disabled={!text.trim() && files.length === 0} onClick={submit} aria-label="Send">
            <ArrowUp size={17} strokeWidth={2.2} />
          </button>
        </div>
      </div>
      {suggest.menu}
      {error && (
        <div className="voice-error" role="alert">
          <span className="voice-error__text">{error}</span>
          <button onClick={() => setError(null)} aria-label="Dismiss">
            <X size={12} strokeWidth={2.2} />
          </button>
        </div>
      )}
    </div>
  )
}

function RoomActions({ room }: { room: WorkerRoom }): JSX.Element {
  const { openRoomEditor, removeRoom } = useWorkers(useShallow((s) => ({ openRoomEditor: s.openRoomEditor, removeRoom: s.removeRoom })))
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null)
  const [confirm, setConfirm] = useState(false)
  return (
    <div className="chat-header__actions">
      <button className="header-btn" onClick={() => openRoomEditor(room.id)} title="Rename, or change who is in it">
        <Users size={14} strokeWidth={1.9} />
        <span>Members</span>
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
            { icon: <PencilLine size={15} strokeWidth={1.9} />, label: 'Edit group chat', action: () => openRoomEditor(room.id) },
            { icon: <Trash2 size={15} strokeWidth={1.9} />, label: 'Delete group chat', danger: true, action: () => setConfirm(true) }
          ]}
        />
      )}
      <Modal
        open={confirm}
        onClose={() => setConfirm(false)}
        title={`Delete ${room.name}?`}
        actions={
          <>
            <button className="btn btn--ghost" onClick={() => setConfirm(false)}>
              Cancel
            </button>
            <button
              className="btn btn--danger"
              autoFocus
              onClick={() => {
                void removeRoom(room.id)
                setConfirm(false)
              }}
            >
              Delete group chat
            </button>
          </>
        }
      >
        The conversation is deleted. The workers in it stay, with their own threads and folders.
      </Modal>
    </div>
  )
}

/* -------------------------------------------------------------- Room editor */

function MemberPicker({ workers, selected, onToggle, now }: { workers: Worker[]; selected: string[]; onToggle: (id: string) => void; now: number }): JSX.Element {
  return (
    <div className="member-picker" role="group" aria-label="Members">
      {workers.map((w) => {
        const on = selected.includes(w.id)
        return (
          <button key={w.id} type="button" className="member-pick" data-on={on || undefined} aria-pressed={on} onClick={() => onToggle(w.id)}>
            <WorkerFace color={w.color} mood={workerMood(w, now)} size={26} />
            <span className="member-pick__text">
              <span className="member-pick__name">{w.name}</span>
              {w.purpose && <span className="member-pick__purpose">{w.purpose}</span>}
            </span>
            <span className="member-pick__check">{on && <Check size={13} strokeWidth={2.6} />}</span>
          </button>
        )
      })}
    </div>
  )
}

export function RoomEditor({ roomId }: { roomId: string | null }): JSX.Element {
  const { workers, rooms, saveRoom, closeRoomEditor, selectRoom, now } = useWorkers(
    useShallow((s) => ({ workers: s.workers, rooms: s.rooms, saveRoom: s.saveRoom, closeRoomEditor: s.closeRoomEditor, selectRoom: s.selectRoom, now: s.now }))
  )
  const existing = roomId ? (rooms.find((r) => r.id === roomId) ?? null) : null
  const [name, setName] = useState(existing?.name ?? '')
  const [members, setMembers] = useState<string[]>(existing?.members ?? [])
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const valid = name.trim().length > 0 && members.length > 0 && members.length <= MAX_ROOM_MEMBERS

  const submit = async (): Promise<void> => {
    if (!valid || saving) return
    setSaving(true)
    setError(null)
    try {
      const room = await saveRoom({ ...(existing ? { id: existing.id } : {}), name: name.trim(), members })
      closeRoomEditor()
      if (!existing) selectRoom(room.id)
    } catch (e) {
      setError(errorText(e))
      setSaving(false)
    }
  }

  return (
    <Modal
      open
      onClose={closeRoomEditor}
      title={existing ? `Edit ${existing.name}` : 'New group chat'}
      width={520}
      actions={
        <>
          <button className="btn btn--ghost" onClick={closeRoomEditor}>
            Cancel
          </button>
          <button className="btn btn--primary" disabled={!valid || saving} onClick={() => void submit()}>
            {existing ? 'Save' : 'Create group chat'}
          </button>
        </>
      }
    >
      <div className="worker-editor">
        <label className="field">
          <span className="field-label">Name</span>
          <input autoFocus className="input" value={name} maxLength={60} placeholder="Launch team" onChange={(e) => setName(e.target.value)} />
        </label>
        <div className="field">
          <span className="field-label">
            Workers in it · {members.length}/{MAX_ROOM_MEMBERS}
          </span>
          {workers.length === 0 ? (
            <p className="worker-editor__hint">Create some workers first, or use New team to make a team of specialists in one go.</p>
          ) : (
            <MemberPicker workers={workers} selected={members} now={now} onToggle={(id) => setMembers((m) => (m.includes(id) ? m.filter((x) => x !== id) : [...m, id]))} />
          )}
        </div>
        {error && <div className="msg__error">{error}</div>}
      </div>
    </Modal>
  )
}

/* -------------------------------------------------------------- New team */

export function TeamDialog(): JSX.Element {
  const { workers, createTeam, openTeamDialog, selectRoom, now } = useWorkers(
    useShallow((s) => ({ workers: s.workers, createTeam: s.createTeam, openTeamDialog: s.openTeamDialog, selectRoom: s.selectRoom, now: s.now }))
  )
  const [name, setName] = useState('')
  const [picked, setPicked] = useState<string[]>(['researcher', 'writer'])
  const [existing, setExisting] = useState<string[]>([])
  const [kickoff, setKickoff] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const room = MAX_WORKERS - workers.length
  const total = picked.length + existing.length
  const valid = total > 0 && total <= MAX_ROOM_MEMBERS && picked.length <= room
  const close = (): void => openTeamDialog(false)
  const templates = useMemo(() => WORKER_TEMPLATES, [])

  const submit = async (): Promise<void> => {
    if (!valid || saving) return
    setSaving(true)
    setError(null)
    try {
      const roles = picked.map((id) => templates.find((t) => t.id === id)!).map((t) => ({ role: t.role, purpose: t.purpose, personality: t.personality, color: t.color }))
      const created = await createTeam({ name: name.trim() || 'Team', roles, memberIds: existing, kickoff: kickoff.trim() })
      close()
      selectRoom(created.id)
    } catch (e) {
      setError(errorText(e))
      setSaving(false)
    }
  }

  return (
    <Modal
      open
      onClose={close}
      title="New team"
      width={600}
      actions={
        <>
          <button className="btn btn--ghost" onClick={close}>
            Cancel
          </button>
          <button className="btn btn--primary" disabled={!valid || saving} onClick={() => void submit()}>
            {saving ? 'Creating…' : kickoff.trim() ? 'Create team and start' : 'Create team'}
          </button>
        </>
      }
    >
      <div className="worker-editor">
        <p className="worker-editor__hint team-dialog__lead">
          Pick the specialists. Each becomes its own worker with its own thread, and they share a group chat where they work on your job at the same time,
          hand parts to each other and report back.
        </p>
        <label className="field">
          <span className="field-label">Team name</span>
          <input autoFocus className="input" value={name} maxLength={60} placeholder="Launch team" onChange={(e) => setName(e.target.value)} />
        </label>
        <div className="field">
          <span className="field-label">Specialists</span>
          <div className="template-grid">
            {templates.map((t) => {
              const on = picked.includes(t.id)
              return (
                <button
                  key={t.id}
                  type="button"
                  className="template-card"
                  data-on={on || undefined}
                  aria-pressed={on}
                  onClick={() => setPicked((p) => (on ? p.filter((x) => x !== t.id) : [...p, t.id]))}
                >
                  <WorkerFace color={t.color} mood={on ? 'happy' : 'neutral'} size={30} />
                  <span className="template-card__role">{t.role}</span>
                  <span className="template-card__purpose">{t.purpose}</span>
                  <span className="member-pick__check">{on && <Check size={13} strokeWidth={2.6} />}</span>
                </button>
              )
            })}
          </div>
          {picked.length > room && <p className="worker-editor__hint">You can have {MAX_WORKERS} workers; there’s room for {room} more.</p>}
        </div>
        {workers.length > 0 && (
          <div className="field">
            <span className="field-label">Add existing workers</span>
            <MemberPicker workers={workers} selected={existing} now={now} onToggle={(id) => setExisting((m) => (m.includes(id) ? m.filter((x) => x !== id) : [...m, id]))} />
          </div>
        )}
        <label className="field">
          <span className="field-label">First job (optional)</span>
          <textarea
            className="input"
            rows={3}
            value={kickoff}
            placeholder="e.g. “Research the top 5 note-taking apps, write a comparison post, and reproduce the crash in issue #42.”"
            onChange={(e) => setKickoff(e.target.value)}
          />
        </label>
        {total > MAX_ROOM_MEMBERS && <p className="worker-editor__hint">A team can have up to {MAX_ROOM_MEMBERS} workers.</p>}
        {error && <div className="msg__error">{error}</div>}
      </div>
    </Modal>
  )
}
