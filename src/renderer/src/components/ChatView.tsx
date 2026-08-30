import { useEffect, useLayoutEffect, useRef, useState, memo, useMemo } from 'react'
import { useShallow } from 'zustand/react/shallow'
import {
  Archive,
  Bug,
  Check,
  Compass,
  Copy,
  ExternalLink,
  Hammer,
  ListTodo,
  MessageSquareDashed,
  MoreHorizontal,
  PanelRight,
  PencilLine,
  RefreshCw,
  Share,
  Trash2,
  TriangleAlert
} from 'lucide-react'
import { messageText, useApp, useIsWork } from '../state/store'
import { Composer } from './Composer'
import { CollapsedNav } from './CollapsedNav'
import { ContextMenu } from './Sidebar'
import { Modal } from './ui'
import { ThinkingSteps } from './ThinkingSteps'
import { ThinkingOrb } from './ThinkingOrb'
import { Markdown } from './agent/Markdown'
import { ToolCall } from './agent/ToolCall'
import type { Chat, ChatMessage } from '@shared/types'

export function ChatView(): JSX.Element {
  const chat = useApp((s) => s.activeChat())
  return (
    <>
      {chat ? <Conversation chat={chat} /> : <Home />}
      <ApprovalPrompt />
    </>
  )
}

const SUGGESTIONS: { icon: typeof Compass; color: string; label: string; prompt: string }[] = [
  {
    icon: Compass,
    color: '#60a5fa',
    label: 'Explore and\nunderstand code',
    prompt: 'Help me explore this codebase and understand how the pieces fit together.'
  },
  {
    icon: Hammer,
    color: '#a78bfa',
    label: 'Build a new feature,\napp, or tool',
    prompt: 'I want to build something new. Ask me what I have in mind, then help me build it.'
  },
  {
    icon: RefreshCw,
    color: '#34d399',
    label: 'Review code and\nsuggest changes',
    prompt: 'Review the code in this project and suggest concrete improvements.'
  },
  {
    icon: Bug,
    color: '#fb923c',
    label: 'Fix issues and\nfailures',
    prompt: 'Help me find and fix a bug or a failing check in this project.'
  }
]

function Home(): JSX.Element {
  const { sidebarOpen, browserOpen, toggleBrowser, workspaces, settings, setComposerDraft } = useApp(useShallow((s) => ({ sidebarOpen: s.sidebarOpen, browserOpen: s.browserOpen, toggleBrowser: s.toggleBrowser, workspaces: s.workspaces, settings: s.settings, setComposerDraft: s.setComposerDraft })))
  const isWork = useIsWork()
  const showSuggestions = isWork && settings?.general.suggestedPrompts !== false

  return (
    <>
      <div className="chat-header" data-collapsed={!sidebarOpen || undefined}>
        {!sidebarOpen && <CollapsedNav />}
        <div className="chat-header__spacer" />
        {/* The browser panel belongs to Eaon Work; the chat product has no use
            for it, so the toggle is not offered there. */}
        {isWork && !browserOpen && (
          <button className="icon-btn" onClick={() => toggleBrowser()} aria-label="Toggle side panel">
            <PanelRight size={16} strokeWidth={1.9} />
          </button>
        )}
      </div>
      <div className="home">
        {isWork ? (
          <>
            <MessageSquareDashed size={48} strokeWidth={1.3} className="home__icon" />
            <h1 className="home__title">What should we build?</h1>
          </>
        ) : (
          <h1 className="home__title">What should we work on?</h1>
        )}
        {showSuggestions && (
          <div className="suggestions">
            {SUGGESTIONS.map((s) => (
              <button key={s.label} className="suggestion-card" onClick={() => setComposerDraft(s.prompt)}>
                <s.icon size={20} strokeWidth={1.8} style={{ color: s.color }} />
                <span className="suggestion-card__label">{s.label}</span>
              </button>
            ))}
          </div>
        )}
        <Composer variant="home" />
      </div>
    </>
  )
}

function ApprovalPrompt(): JSX.Element {
  const pending = useApp((s) => s.pendingApproval)
  const respondApproval = useApp((s) => s.respondApproval)

  const command = pending?.tool === 'run_command' ? String(pending.input.command ?? '') : null
  const write = pending?.tool === 'write_file' ? pending.input : null

  return (
    <Modal
      open={Boolean(pending)}
      onClose={() => respondApproval(false)}
      title={
        pending?.tool === 'run_command'
          ? 'Run this command?'
          : pending?.tool === 'write_file'
            ? 'Write this file?'
            : 'Approve this action?'
      }
      width={440}
      actions={
        <>
          <button className="btn btn--ghost" onClick={() => respondApproval(false)}>
            Deny
          </button>
          <button className="btn btn--danger" autoFocus onClick={() => respondApproval(true)}>
            Approve
          </button>
        </>
      }
    >
      {command !== null && (
        <pre
          style={{ margin: 0, fontFamily: 'var(--font-mono)', fontSize: 12.5, color: 'var(--text-2)', whiteSpace: 'pre-wrap' }}
        >
          {command}
        </pre>
      )}
      {write !== null && (
        <>
          <p style={{ margin: '0 0 8px' }}>
            <code>{String(write.path ?? '')}</code>
          </p>
          <pre
            style={{ margin: 0, fontFamily: 'var(--font-mono)', fontSize: 12.5, color: 'var(--text-2)', whiteSpace: 'pre-wrap' }}
          >
            {String(write.content ?? '').slice(0, 800)}
            {String(write.content ?? '').length > 800 ? '\n…' : ''}
          </pre>
        </>
      )}
    </Modal>
  )
}

function Conversation({ chat }: { chat: Chat }): JSX.Element {
  const { streamingMessageId, browserOpen, toggleBrowser, archiveChat, deleteChat, renameChat, stop } = useApp(useShallow((s) => ({ streamingMessageId: s.streamingMessageId, browserOpen: s.browserOpen, toggleBrowser: s.toggleBrowser, archiveChat: s.archiveChat, deleteChat: s.deleteChat, renameChat: s.renameChat, stop: s.stop })))
  const isWork = useIsWork()
  const thread = useRef<HTMLDivElement>(null)
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null)
  const [confirmArchive, setConfirmArchive] = useState(false)
  const moreButton = useRef<HTMLButtonElement>(null)

  const streaming = Boolean(streamingMessageId) && chat.messages.some((m) => m.id === streamingMessageId)

  // Keep the newest content in view while tokens arrive.
  useLayoutEffect(() => {
    const node = thread.current
    if (!node) return
    const nearBottom = node.scrollHeight - node.scrollTop - node.clientHeight < 160
    if (nearBottom) node.scrollTop = node.scrollHeight
  }, [chat.messages])

  useEffect(() => {
    thread.current?.scrollTo({ top: thread.current.scrollHeight })
  }, [chat.id])

  const requestArchive = (): void => {
    if (streaming) setConfirmArchive(true)
    else archiveChat(chat.id)
  }

  const sidebarOpen = useApp((s) => s.sidebarOpen)

  return (
    <>
      <div className="chat-header" data-collapsed={!sidebarOpen || undefined}>
        {!sidebarOpen && <CollapsedNav />}
        <span className="chat-header__title">{chat.title}</span>
        <button
          ref={moreButton}
          className="icon-btn"
          onClick={(e) => {
            const rect = e.currentTarget.getBoundingClientRect()
            setMenu({ x: rect.left, y: rect.bottom })
          }}
          aria-label="Chat options"
        >
          <MoreHorizontal size={16} strokeWidth={1.9} />
        </button>

        <div className="chat-header__spacer" />

        <div className="chat-header__actions">
          <button className="header-btn" onClick={() => void copyTranscript(chat)}>
            <Share size={14} strokeWidth={1.9} />
            <span>Share</span>
          </button>
          <button
            className="header-btn"
            onClick={() => void window.api.app.openExternal('https://code.visualstudio.com/')}
          >
            <ExternalLink size={14} strokeWidth={1.9} />
            <span>Open</span>
          </button>
          <button className="icon-btn" aria-label="Tasks">
            <ListTodo size={16} strokeWidth={1.9} />
          </button>
          {isWork && !browserOpen && (
            <button className="icon-btn" onClick={() => toggleBrowser()} aria-label="Toggle side panel">
              <PanelRight size={16} strokeWidth={1.9} />
            </button>
          )}
        </div>
      </div>

      <div ref={thread} className="thread scroll">
        <div className="thread__inner">
          {chat.messages.map((message) => (
            <MessageRow
              key={message.id}
              message={message}
              streaming={message.id === streamingMessageId}
            />
          ))}
        </div>
      </div>

      <div className="composer-dock">
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
const MessageRow = memo(function MessageRow({
  message,
  streaming
}: {
  message: ChatMessage
  streaming: boolean
}): JSX.Element {
  const [copied, setCopied] = useState(false)
  // Joining the parts is O(total length); recomputing it on unrelated renders
  // is what made a long reply quadratic.
  const body = useMemo(() => messageText(message), [message])
  const reasoning = useMemo(() => messageText(message, 'reasoning'), [message])
  // A turn that only called tools and said nothing still has content to show;
  // testing the joined text alone would render it as "No response".
  const hasContent = body.length > 0 || message.parts.some((part) => part.type === 'tool')

  if (message.role === 'user') {
    return (
      <div className="msg-row" style={{ display: 'flex', justifyContent: 'flex-end' }}>
        <div className="msg--user">{body}</div>
      </div>
    )
  }

  return (
    <div className="msg-row">
      <ThinkingSteps reasoning={reasoning} streaming={streaming} />

      {message.error ? (
        <div className="msg__error">
          <TriangleAlert size={15} strokeWidth={1.9} style={{ flex: 'none', marginTop: 1 }} />
          <span>{message.error}</span>
        </div>
      ) : hasContent ? (
        // Rendered part by part rather than as one joined string, so a tool call
        // stays where the model made it — between the sentence that led to it
        // and the one that follows from its result.
        <div className="msg--assistant" data-streaming={streaming || undefined}>
          {message.parts.map((part, index) =>
            part.type === 'tool' ? (
              <ToolCall key={part.id} part={part} />
            ) : part.type === 'text' ? (
              <Markdown key={index} text={part.text} />
            ) : null
          )}
        </div>
      ) : streaming ? (
        <div className="msg__status">
          <ThinkingOrb />
          <span className="shimmer">Thinking</span>
        </div>
      ) : (
        <div className="msg__status" style={{ color: 'var(--text-3)' }}>
          No response
        </div>
      )}

      {body && !streaming && (
        <div className="msg__actions">
          <button
            className="icon-btn"
            aria-label="Copy"
            onClick={() => {
              void navigator.clipboard.writeText(body)
              setCopied(true)
              setTimeout(() => setCopied(false), 1400)
            }}
          >
            {copied ? <Check size={14} strokeWidth={2} /> : <Copy size={14} strokeWidth={1.9} />}
          </button>
          <button className="icon-btn" aria-label="Regenerate">
            <RefreshCw size={14} strokeWidth={1.9} />
          </button>
        </div>
      )}
    </div>
  )
})

async function copyTranscript(chat: Chat): Promise<void> {
  const text = chat.messages
    .map((m) => `${m.role === 'user' ? 'You' : 'Assistant'}: ${messageText(m)}`)
    .join('\n\n')
  await navigator.clipboard.writeText(`# ${chat.title}\n\n${text}`)
}
