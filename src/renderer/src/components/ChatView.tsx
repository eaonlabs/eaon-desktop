import { useEffect, useLayoutEffect, useRef, useState, memo, useMemo } from 'react'
import { createPortal } from 'react-dom'
import { useShallow } from 'zustand/react/shallow'
import {
  Archive,
  CalendarClock,
  Compass,
  Copy,
  FileText,
  FolderOpen,
  FolderTree,
  Globe,
  Hammer,
  HeartPulse,
  MoreHorizontal,
  PanelRight,
  PencilLine,
  Trash2,
  TriangleAlert
} from 'lucide-react'
import { agentWorkspace, messageText, useApp, useIsWork, type PendingApproval } from '../state/store'
import { Composer } from './Composer'
import { ContextMenu } from './Sidebar'
import { Modal } from './ui'
import { Markdown } from './agent/Markdown'
import { FilesChanged } from './agent/FilesChanged'
import { LoadingState } from './agent/Loaders'
import { toolPartChanges } from './agent/ToolCall'
import { StepRun } from './agent/TurnSteps'
import { turnItems } from './agent/turnItems'
import { TopBar } from './TopBar'
import { GoalBanner, PlanCard, TodoPanel, UsageLine } from './agent/WorkBits'
import { FileDiff } from './agent/FileDiff'
import { MessageActions } from './agent/MessageActions'
import { ApprovalCard, CallPreview, CommandPreview } from './agent/ApprovalCard'
import { WorkerFace } from './workers/WorkerFace'
import { ChannelLogo } from './channels/ChannelLogo'
import { AgentBrowserToggle } from './agentBrowser/AgentBrowserPanel'
import { CHANNEL_LABEL } from '@shared/channels'
import { fileUrl, isImagePath, isVideoPath } from '../lib/files'
import type { Chat, ChatMessage, ChatToolPart } from '@shared/types'

/** Window event: the app menu's Archive Chat, for the conversation on screen to handle like its own Archive. */
export const ARCHIVE_REQUEST = 'eaon:archive-chat'

export function ChatView(): JSX.Element {
  const chat = useApp((s) => s.activeChat())
  return (
    <>
      {chat ? <Conversation chat={chat} /> : <Home />}
      <ApprovalPrompt />
    </>
  )
}

/**
 * Chips under the home composer. Each drops a starting prompt into the box —
 * and together they are how someone new learns that Chat is an agent: it
 * researches, works with files, builds things, uses the browser and runs on a
 * schedule, not only answers questions.
 */
const SUGGESTIONS: { icon: typeof Compass; label: string; prompt: string }[] = [
  { icon: Compass, label: 'Research', prompt: 'Research the following and write up what you find, with sources: ' },
  { icon: FolderTree, label: 'Organize files', prompt: 'Tidy up my Downloads folder: group files into sensible subfolders and tell me what you moved.' },
  { icon: Hammer, label: 'Build an app', prompt: 'Build me ' },
  { icon: Globe, label: 'Use my browser', prompt: 'In my browser, ' }
]

function Home(): JSX.Element {
  const { settings, setComposerDraft, browserOpen, toggleBrowser } = useApp(
    useShallow((s) => ({ settings: s.settings, setComposerDraft: s.setComposerDraft, browserOpen: s.browserOpen, toggleBrowser: s.toggleBrowser }))
  )
  const showSuggestions = settings?.general.suggestedPrompts !== false

  return (
    <>
      <TopBar
        right={
          browserOpen ? null : (
            <BrowserToggle onClick={() => toggleBrowser()} />
          )
        }
      />
      <div className="home">
        <h1 className="home__title">What can I help with?</h1>
        <Composer variant="home" />
        {showSuggestions && (
          <div className="home-chips" role="group" aria-label="Things Eaon can do">
            {SUGGESTIONS.map((s, index) => (
              <button
                key={s.label}
                type="button"
                className="suggestion-chip"
                style={{ ['--i' as string]: index }}
                onClick={() => setComposerDraft(s.prompt)}
              >
                <s.icon size={15} strokeWidth={1.9} />
                {s.label}
              </button>
            ))}
          </div>
        )}
      </div>
    </>
  )
}

/**
 * Opens the browser panel. Shown only while the agent has used the browser
 * in this chat, or on the home screen once the panel has been opened before —
 * otherwise it lives in the + menu, where it does not crowd the top bar.
 */
function BrowserToggle({ onClick }: { onClick: () => void }): JSX.Element | null {
  const used = useApp((s) => s.activeChat()?.messages.some((m) => m.parts.some((p) => p.type === 'tool' && p.name === 'browser')) ?? false)
  if (!used) return null
  return (
    <button className="icon-btn" onClick={onClick} aria-label="Show browser" title="Show browser">
      <PanelRight size={16} strokeWidth={1.9} />
    </button>
  )
}

/** Dialog titles per tool; anything unlisted asks generically. */
const APPROVAL_TITLES: Record<string, string> = {
  run_command: 'Run this command?',
  write_file: 'Write this file?',
  edit_file: 'Make this edit?',
  delete_file: 'Move this to the Trash?',
  move_file: 'Move this file?',
  computer: 'Let Eaon use your computer?',
  browser: 'Let Eaon do this in your browser?',
  web_browser: 'Let Eaon do this in its browser?',
  email_send: 'Send this email?',
  email_reply: 'Send this reply?',
  trading_order: 'Place this order?',
  trading_session: 'Let Eaon trade?',
  use_plugin_tool: 'Use this plugin?',
  schedule: 'Change your schedules?'
}

/** The one line that says what is about to happen, for tools without a bespoke preview. */
function approvalSummary(tool: string, input: Record<string, unknown>): string {
  const pick = (key: string): string => (typeof input[key] === 'string' ? (input[key] as string) : '')
  if (tool === 'move_file') return `${pick('from')} → ${pick('to')}`
  if (tool === 'use_plugin_tool') return pick('name')
  if (tool === 'computer' || tool === 'browser') {
    const detail = pick('text') || pick('keys') || pick('key') || pick('url') || pick('ref') || pick('app')
    const point = typeof input.x === 'number' ? ` at ${input.x}, ${input.y}` : ''
    return `${pick('action')}${point}${detail ? ` — ${detail}` : ''}`
  }
  return pick('path') || pick('name') || pick('action') || ''
}

/**
 * Asking before a tool runs, as a card over the chat (agent/ApprovalCard.tsx).
 * It stays a moment after it's answered so it can leave the way it was
 * answered, and the next approval in the queue slides in where it was.
 */
function ApprovalPrompt(): JSX.Element | null {
  const { pending, waiting, respondApproval } = useApp(
    useShallow((s) => ({ pending: s.pendingApproval, waiting: s.approvalQueue.length, respondApproval: s.respondApproval }))
  )
  const [shown, setShown] = useState<PendingApproval | null>(pending)
  const [answer, setAnswer] = useState<'approve' | 'deny' | null>(null)
  const [swap, setSwap] = useState(false)

  useEffect(() => {
    if (pending) {
      setSwap((current) => current || (shown !== null && shown.requestId !== pending.requestId))
      setShown(pending)
      setAnswer(null)
      return
    }
    if (!shown) return
    const timer = setTimeout(() => {
      setShown(null)
      setAnswer(null)
      setSwap(false)
    }, 200)
    return () => clearTimeout(timer)
    // `shown` is what the card shows now; only a change in what's pending moves it on.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pending])

  const respond = (approved: boolean): void => {
    if (!pending) return
    setAnswer(approved ? 'approve' : 'deny')
    respondApproval(approved)
  }

  // ⏎ approves and esc denies, unless a button has focus: it answers ⏎ itself.
  useEffect(() => {
    if (!pending) return
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        event.preventDefault()
        respond(false)
      } else if (event.key === 'Enter' && !event.isComposing && !(event.target instanceof HTMLButtonElement)) {
        event.preventDefault()
        respond(true)
      }
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  })

  if (!shown) return null
  const tool = shown.tool
  const input = shown.input
  const text = (key: string): string => String(input[key] ?? '')
  const edit = tool === 'write_file' || tool === 'edit_file'

  let body: JSX.Element
  if (tool === 'run_command') {
    body = <CommandPreview command={text('command')} />
  } else if (edit) {
    body = (
      <div className="approval__diff">
        <FileDiff
          file={text('path')}
          before={tool === 'edit_file' ? text('old_text') : ''}
          after={tool === 'edit_file' ? text('new_text') : text('content').slice(0, 6000)}
        />
      </div>
    )
  } else {
    body = <CallPreview summary={shown.summary || approvalSummary(tool, input)} args={tool === 'use_plugin_tool' ? input.arguments : input} />
  }

  return createPortal(
    <div className="approval-layer" data-state={pending ? 'in' : 'out'} data-answer={answer ?? undefined} data-wide={edit || undefined}>
      <ApprovalCard
        key={shown.requestId}
        variant="dialog"
        tool={tool}
        input={shown.input}
        title={APPROVAL_TITLES[tool] ?? `Allow ${tool.replace(/_/g, ' ')}?`}
        waiting={pending ? waiting : 0}
        busy={!pending}
        onApprove={() => respond(true)}
        onDeny={() => respond(false)}
        swap={swap}
      >
        {body}
      </ApprovalCard>
    </div>,
    document.body
  )
}

function Conversation({ chat }: { chat: Chat }): JSX.Element {
  const { streamingMessageId, streamingChatId, browserOpen, toggleBrowser, archiveChat, deleteChat, renameChat, stop } = useApp(useShallow((s) => ({ streamingMessageId: s.streamingMessageId, streamingChatId: s.streamingChatId, browserOpen: s.browserOpen, toggleBrowser: s.toggleBrowser, archiveChat: s.archiveChat, deleteChat: s.deleteChat, renameChat: s.renameChat, stop: s.stop })))
  const isWork = useIsWork()
  const thread = useRef<HTMLDivElement>(null)
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null)
  const [confirmArchive, setConfirmArchive] = useState(false)
  const moreButton = useRef<HTMLButtonElement>(null)

  const streaming = streamingChatId === chat.id
  // Only the last reply can be asked again; see retryPlan.
  const lastReplyId = useMemo(() => {
    for (let i = chat.messages.length - 1; i >= 0; i--) {
      if (chat.messages[i].role === 'assistant') return chat.messages[i].id
      if (chat.messages[i].role === 'user') return null
    }
    return null
  }, [chat.messages])

  // Keep the newest content in view while tokens arrive — but only while the
  // reader is at the bottom, which their own scrolling decides. Measuring after
  // the content grew got both cases wrong: anything that landed taller than
  // the threshold in one go (a long pasted message, a tool card, a code block)
  // stopped the follow, and a reader who had scrolled up a little was yanked
  // back down on the next token.
  const following = useRef(true)
  const seen = useRef({ chatId: chat.id, count: chat.messages.length })
  useLayoutEffect(() => {
    const node = thread.current
    if (!node) return
    // A different chat opens at its end, and a new message (the user's own
    // send) jumps there too.
    if (seen.current.chatId !== chat.id || chat.messages.length > seen.current.count) following.current = true
    seen.current = { chatId: chat.id, count: chat.messages.length }
    if (following.current) node.scrollTop = node.scrollHeight
  }, [chat.id, chat.messages])

  const requestArchive = (): void => {
    if (streaming) setConfirmArchive(true)
    else archiveChat(chat.id)
  }
  // ⇧⌘A and File → Archive Chat. They archived straight from the store, so a
  // chat in the middle of a reply was stopped without the question below.
  const archiveRequest = useRef(requestArchive)
  archiveRequest.current = requestArchive
  useEffect(() => {
    const onRequest = (): void => archiveRequest.current()
    window.addEventListener(ARCHIVE_REQUEST, onRequest)
    return () => window.removeEventListener(ARCHIVE_REQUEST, onRequest)
  }, [])

  const workFolder = useApp((s) => agentWorkspace(s.workspaces)?.cwd ?? s.settings?.work.defaultFolder ?? '~/Eaon')

  return (
    <>
      <TopBar
        left={
          <>
            <span className="chat-header__title">{chat.title}</span>
            <button
              ref={moreButton}
              className="icon-btn"
              onClick={(e) => {
                const rect = e.currentTarget.getBoundingClientRect()
                setMenu({ x: rect.left, y: rect.bottom })
              }}
              aria-label="Chat options"
              title="Chat options"
            >
              <MoreHorizontal size={16} strokeWidth={1.9} />
            </button>
          </>
        }
        right={
          <div className="chat-header__actions">
            {isWork && <AgentBrowserToggle />}
            {isWork && !browserOpen && <BrowserToggle onClick={() => toggleBrowser()} />}
          </div>
        }
      />

      <div
        ref={thread}
        className="thread scroll"
        onScroll={(e) => {
          const node = e.currentTarget
          following.current = node.scrollHeight - node.scrollTop - node.clientHeight < 8
        }}
        // Wheel events arrive before the scroll they cause, so this lets go
        // before the next token's scroll-to-end can undo the user's move.
        onWheel={(e) => {
          if (e.deltaY < 0) following.current = false
        }}
      >
        <div className="thread__inner">
          {chat.messages.map((message) => (
            <MessageRow
              key={message.id}
              message={message}
              streaming={message.id === streamingMessageId}
              chatActions
              last={message.id === lastReplyId}
              canRetry={message.id === lastReplyId && !streamingChatId}
            />
          ))}
        </div>
      </div>

      <div className="composer-dock">
        {isWork && (
          <div className="composer-dock__pinned">
            <GoalBanner chat={chat} />
            <TodoPanel chat={chat} />
          </div>
        )}
        <Composer variant="chat" />
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
                const next = window.prompt('Rename chat', chat.title)
                if (next?.trim()) renameChat(chat.id, next.trim())
              }
            },
            { icon: <Copy size={15} strokeWidth={1.9} />, label: 'Copy transcript', action: () => void copyTranscript(chat) },
            { icon: <FolderOpen size={15} strokeWidth={1.9} />, label: 'Open work folder', action: () => void window.api.app.showItem(workFolder) },
            { icon: <Archive size={15} strokeWidth={1.9} />, label: 'Archive', action: requestArchive },
            { icon: <Trash2 size={15} strokeWidth={1.9} />, label: 'Delete', danger: true, action: () => deleteChat(chat.id) }
          ]}
        />
      )}

      <Modal
        open={confirmArchive}
        onClose={() => setConfirmArchive(false)}
        title="Stop and archive this chat?"
        actions={
          <>
            <button className="btn btn--ghost" onClick={() => setConfirmArchive(false)}>
              Cancel
            </button>
            <button
              className="btn btn--danger"
              autoFocus
              onClick={() => {
                stop()
                archiveChat(chat.id)
                setConfirmArchive(false)
              }}
            >
              Stop and archive
            </button>
          </>
        }
      >
        Archiving will stop any ongoing work. You can restore the chat later in settings.
      </Modal>
    </>
  )
}

/**
 * Memoised deliberately: during streaming the store hands back a new `chats`
 * array every token, but `.map()` preserves the identity of every message
 * except the one being written to. Without this, a 100-turn conversation
 * re-rendered all 100 rows — and re-ran both `messageText` joins on each —
 * for every single token.
 */
export const MessageRow = memo(function MessageRow({
  message,
  streaming,
  quietWhenEmpty = false,
  chatActions = false,
  last = false,
  canRetry = false
}: {
  message: ChatMessage
  streaming: boolean
  /**
   * A chat's reply: thumbs, emoji, reply, fork and (for the last reply) try
   * again, all kept in the chat. A worker's reply has nowhere to keep them, so
   * its bar is copy, read aloud and the time.
   */
  chatActions?: boolean
  /** The chat's latest reply: its bar stays in view rather than waiting for a hover. */
  last?: boolean
  canRetry?: boolean
  /**
   * A finished turn with nothing in it shows nothing, rather than "No
   * response". A worker's turn that was stopped, or woke and had nothing to
   * say, is not a reply that went missing.
   */
  quietWhenEmpty?: boolean
}): JSX.Element | null {
  const row = useRef<HTMLDivElement>(null)
  // Joining the parts is O(total length); recomputing it on unrelated renders
  // is what made a long reply quadratic.
  const body = useMemo(() => messageText(message), [message])
  // Thinking, calls and sentences in the order they happened; see turnItems.ts.
  const items = useMemo(() => turnItems(message.parts), [message.parts])
  // A turn that only thought or called tools and said nothing still has
  // content to show; testing the joined text alone would render it as "No response".
  const hasContent = items.length > 0
  const changes = useMemo(
    () => toolPartChanges(message.parts.filter((part): part is ChatToolPart => part.type === 'tool')),
    [message.parts]
  )
  // Still being written, by this window's run or another's (another window, a
  // scheduled task): its action bar waits until it is finished.
  const unfinished = streaming || message.parts.some((part) => part.type === 'tool' && part.status === 'running')

  if (message.role === 'user') {
    // A worker's turn: each piece of mail is its own bubble, and a heartbeat
    // is a quiet marker rather than something the user seems to have said.
    if (message.mail || message.heartbeat) {
      return (
        <div className="msg-row msg-row--mail">
          {message.heartbeat && (
            <div className="msg__heartbeat">
              <HeartPulse size={13} strokeWidth={2} />
              <span>Heartbeat{message.heartbeat ? ` · ${message.heartbeat}` : ''}</span>
            </div>
          )}
          {message.mail?.map((mail) =>
            mail.from === 'user' ? (
              <div key={mail.id} className="msg-user-block">
                <Attachments paths={mail.files} />
                {mail.text && <div className="msg--user">{mail.text}</div>}
                {mail.channel && (
                  <span className="msg__via">
                    <ChannelLogo kind={mail.channel.kind} size={13} />
                    {mail.channel.isGroup ? `In ${mail.channel.chatName} on ${CHANNEL_LABEL[mail.channel.kind]}` : `From ${CHANNEL_LABEL[mail.channel.kind]}`}
                  </span>
                )}
              </div>
            ) : (
              <div key={mail.id} className="msg-mail">
                {mail.channel ? (
                  <span className="msg-mail__avatar" aria-hidden="true">
                    {initials(mail.fromName)}
                  </span>
                ) : (
                  <WorkerFace color={mail.fromColor ?? '#6B7280'} size={26} />
                )}
                <div className="msg-mail__body">
                  <span className="msg-mail__from">
                    {mail.channel && <ChannelLogo kind={mail.channel.kind} size={14} />}
                    {mail.fromName}
                    {mail.channel?.isGroup && <span className="msg-mail__where"> in {mail.channel.chatName}</span>}
                  </span>
                  <div className="msg-mail__text">{mail.text}</div>
                  <Attachments paths={mail.files} align="start" />
                </div>
              </div>
            )
          )}
        </div>
      )
    }
    return (
      <div className="msg-row msg-user-block">
        {message.scheduledTaskId && (
          <span className="msg__scheduled">
            <CalendarClock size={12} strokeWidth={2} />
            Scheduled run
          </span>
        )}
        <Attachments paths={message.attachments} />
        {body && <div className="msg--user">{body}</div>}
      </div>
    )
  }

  if (!hasContent && !streaming && !message.error && !message.plan && quietWhenEmpty) return null

  return (
    <div className="msg-row" ref={row}>
      {/* An error no longer replaces what the turn already did: a Work turn
          that failed on its twentieth call used to hide the nineteen edits and
          commands before it, which still happened. */}
      {hasContent ? (
        // Rendered part by part rather than as one joined string, so a thought
        // or a tool call stays where the model made it — between the sentence
        // that led to it and the one that follows from its result.
        <div className="msg--assistant" data-streaming={streaming || undefined}>
          {items.map((item, index) =>
            item.kind === 'text' ? (
              <Markdown key={item.key} text={item.text} />
            ) : (
              <StepRun key={item.key} steps={item.steps} active={streaming && index === items.length - 1} />
            )
          )}
        </div>
      ) : streaming ? (
        <LoadingState label="Thinking" />
      ) : message.error ? null : (
        <div className="msg__status" style={{ color: 'var(--text-3)' }}>
          No response
        </div>
      )}

      {message.error && (
        <div className="msg__error">
          <TriangleAlert size={15} strokeWidth={1.9} style={{ flex: 'none', marginTop: 1 }} />
          <span>{message.error}</span>
        </div>
      )}

      {message.plan && <PlanCard message={message} plan={message.plan} />}

      {!streaming && changes.length > 0 && <FilesChanged changes={changes} />}

      {(body || message.usage) && !unfinished && (
        <div className="msg__actions" data-pinned={last || Boolean(message.feedback) || undefined}>
          <ReplyActions message={message} text={body} row={row} chatActions={chatActions} canRetry={canRetry} />
        </div>
      )}
    </div>
  )
})

/**
 * A reply's action bar (see agent/MessageActions.tsx) with what it does in a
 * chat: thumbs and emoji kept on the message, Reply quoting the reply (or the
 * part of it that is selected) into the message box, Try again, and Fork.
 */
function ReplyActions({
  message,
  text,
  row,
  chatActions,
  canRetry
}: {
  message: ChatMessage
  text: string
  row: React.RefObject<HTMLDivElement>
  chatActions: boolean
  canRetry: boolean
}): JSX.Element {
  const { setMessageFeedback, retryReply, forkChat, setComposerDraft } = useApp(
    useShallow((s) => ({ setMessageFeedback: s.setMessageFeedback, retryReply: s.retryReply, forkChat: s.forkChat, setComposerDraft: s.setComposerDraft }))
  )
  const quote = (): void => {
    const selection = window.getSelection()
    const picked = selection && !selection.isCollapsed && row.current?.contains(selection.anchorNode) ? selection.toString().trim() : ''
    const source = picked || text.trim()
    const excerpt = source.length > 280 ? `${source.slice(0, 280).trimEnd()}…` : source
    setComposerDraft(`${excerpt.split('\n').map((line) => `> ${line}`).join('\n')}\n\n`)
  }
  return (
    <MessageActions
      text={text}
      sentAt={new Date(message.createdAt)}
      vote={message.feedback?.vote ?? null}
      reaction={message.feedback?.reaction ?? null}
      {...(chatActions
        ? {
            onVote: (vote) => setMessageFeedback(message.id, { vote }),
            onReact: (reaction) => setMessageFeedback(message.id, { reaction }),
            onReply: quote,
            onFork: () => forkChat(message.id),
            ...(canRetry ? { onRetry: () => retryReply(message.id) } : {})
          }
        : {})}
    >
      {message.usage && <UsageLine usage={message.usage} />}
    </MessageActions>
  )
}

/**
 * Files sent with a message. They were attached and sent to the model but
 * never shown in the conversation, so a reply about "the photo" had nothing
 * next to it. Images and videos preview; everything else is a chip that
 * opens the file.
 */
function Attachments({ paths, align = 'end' }: { paths?: string[]; align?: 'start' | 'end' }): JSX.Element | null {
  if (!paths || paths.length === 0) return null
  return (
    <div className="msg-attachments" data-align={align}>
      {paths.map((path) => {
        const name = path.split(/[\\/]/).pop() ?? path
        if (isImagePath(path)) {
          return (
            <button key={path} className="msg-attachment msg-attachment--media" title={name} onClick={() => void window.api.library.open(path)}>
              <img src={fileUrl(path)} alt={name} loading="lazy" />
            </button>
          )
        }
        if (isVideoPath(path)) {
          return (
            <button key={path} className="msg-attachment msg-attachment--media" title={name} onClick={() => void window.api.library.open(path)}>
              <video src={fileUrl(path)} preload="metadata" muted />
            </button>
          )
        }
        return (
          <button key={path} className="msg-attachment msg-attachment--file" title={path} onClick={() => void window.api.library.open(path)}>
            <FileText size={15} strokeWidth={1.8} />
            <span>{name}</span>
          </button>
        )
      })}
    </div>
  )
}

async function copyTranscript(chat: Chat): Promise<void> {
  const text = chat.messages
    .map((m) => `${m.role === 'user' ? 'You' : 'Assistant'}: ${messageText(m)}`)
    .join('\n\n')
  await navigator.clipboard.writeText(`# ${chat.title}\n\n${text}`)
}

/** "Alex Rivera (@alex)" → "AR": a guest from a chat app has no face of its own. */
function initials(name: string): string {
  const words = name.replace(/\(.*?\)/g, '').trim().split(/\s+/).filter(Boolean)
  return ((words[0]?.[0] ?? '?') + (words.length > 1 ? words[words.length - 1][0] : '')).toUpperCase()
}
