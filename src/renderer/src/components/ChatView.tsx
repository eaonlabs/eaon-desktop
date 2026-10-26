import { useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore, memo, useMemo } from 'react'
import { createPortal } from 'react-dom'
import { useShallow } from 'zustand/react/shallow'
import {
  Archive,
  ArrowDown,
  CalendarClock,
  Check,
  ChevronDown,
  Compass,
  Copy,
  Eye,
  FileText,
  FolderInput,
  FolderOpen,
  FolderTree,
  Globe,
  Hammer,
  HeartPulse,
  MoreHorizontal,
  PanelRight,
  PencilLine,
  Target,
  Terminal,
  Trash2,
  TriangleAlert,
  X
} from 'lucide-react'
import { codeFolder, messageText, useApp, useCoding, useIsWork, type PendingApproval } from '../state/store'
import { Composer } from './Composer'
import { FolderMenu } from './composer/ComposerBits'
import { ContextMenu } from './Sidebar'
import { ConfirmDialog, Modal } from './ui'
import { notify } from './Notice'
import { errorText } from '../lib/errors'
import { Markdown } from './agent/Markdown'
import { EditedFiles } from './chatCode/EditedFiles'
import { LoadingState } from './agent/Loaders'
import { toolPartChanges } from './agent/ToolCall'
import { TurnLive } from './agent/StepCards'
import { TurnHeader } from './agent/TurnSteps'
import { ToolCall } from './agent/ToolCall'
import { PlanRow, ThoughtRow, ToolRun } from './chat/WorkRows'
import { workLog } from './chat/workLog'
import { TopBar } from './TopBar'
import { AsciiField } from './AsciiField'
import { RowBoundary } from './ErrorBoundary'
import { GoalBanner, PlanCard, TodoPanel, UsageLine } from './agent/WorkBits'
import { MessageActions } from './agent/MessageActions'
import { ProviderErrorActions } from './composer/ProviderErrorActions'
import { ApprovalCard } from './agent/ApprovalCard'
import { ApprovalPreview, ApprovalRow, useApprovalKeys } from './agent/ApprovalRow'
import { approvalDetail, approvalTitle, askerName } from './agent/approvalText'
import { WorkerFace } from './workers/WorkerFace'
import { ChannelLogo } from './channels/ChannelLogo'
import { DockToggle, DrawerToggle } from './ide/Dock'
import { useIde } from './ide/ideStore'
import { CodeKeys } from './chatCode/CodeTools'
import { useCardInline, WorkspaceCard, WorkspaceToggle } from './chatCode/WorkspaceCard'
import { TerminalDrawer } from './chatCode/TerminalDrawer'
import { ProjectSearch } from './chatCode/ProjectSearch'
import { FileLinks, type FileLinkHandler } from './agent/FileRef'
import { joinPath } from './ide/paths'
import { preferredTarget, useChatCode } from './chatCode/chatCodeStore'
import { openInCode } from './ide/ideStore'
import { CHANNEL_LABEL } from '@shared/channels'
import type { WorkerMail } from '@shared/workers'
import { fileUrl, isImagePath, isVideoPath } from '../lib/files'
import { CLIPBOARD_FAILED, copyText } from '../lib/clipboard'
import { FindBar } from './chat/FindBar'
import { Minimap } from './chat/Minimap'
import { QuoteSelection } from './chat/QuoteSelection'
import { viewImage } from './chat/ImageViewer'
import type { Chat, ChatMessage, ChatToolPart } from '@shared/types'

/** Window event: the app menu's Archive Chat, for the conversation on screen to handle like its own Archive. */
export const ARCHIVE_REQUEST = 'eaon:archive-chat'

export function ChatView(): JSX.Element {
  const chat = useApp((s) => s.activeChat())
  // The overlay approval card is mounted once, at the app's root (App.tsx),
  // not here: a run that asked while Settings or another tab was open waited
  // on a card nobody could see. The open conversation asks in its transcript
  // (see ApprovalPrompt and MessageRow).
  return chat ? <Conversation chat={chat} /> : <Home />
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
  const isWork = useIsWork()
  // A chat in a project codes; an ordinary one has none of the coding tools.
  const coding = useCoding() && isWork

  return (
    <>
      <TopBar
        right={
          <div className="chat-header__actions">
            {isWork ? <PanelToggles over /> : !browserOpen && <BrowserToggle onClick={() => toggleBrowser()} />}
          </div>
        }
      />
      <AsciiField className="home__field" />
      <div className="home">
        <div className="home__hero">
          <EaonSymbol className="home__mark" />
          <h1 className="home__title">{isWork ? 'What should we work on?' : 'What can I help with?'}</h1>
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
        <div className="home__dock">
          <Composer variant="home" />
        </div>
      </div>
      {coding && <WorkspaceCard over />}
      {coding && <TerminalDrawer />}
      {coding && <ProjectSearch />}
    </>
  )
}

/** Eaon's mark, in the text colour: the brand's symbol, drawn inline so it follows the theme. */
function EaonSymbol({ className }: { className?: string }): JSX.Element {
  return (
    <svg className={className} viewBox="0 0 200 200" aria-hidden="true">
      <path
        fill="currentColor"
        fillRule="evenodd"
        d="M186.6 50A100 100 0 1 0 186.6 150H103A15 15 0 0 1 103 120H197.98A100 100 0 0 0 197.98 80H103A15 15 0 0 1 103 50Z"
      />
    </svg>
  )
}

/**
 * Opens the browser panel. Shown only while the agent has used the browser
 * in this chat, or on the home screen once the panel has been opened before —
 * otherwise it lives in the + menu, where it does not crowd the top bar.
 */
/**
 * The top bar's panel switches in Chat: the workspace card, the terminal
 * under the conversation, and the dock. With the dock open the last two are
 * on the dock's own bar instead. `over`: the card opens over the page, never
 * beside it (the start page has no room kept for it). An ordinary chat, in
 * no project, has only the dock, for the browser.
 */
function PanelToggles({ over = false }: { over?: boolean }): JSX.Element {
  const dockOpen = useIde((s) => s.open)
  const coding = useCoding()
  return (
    <div className="panel-toggles">
      {coding && <CodeKeys />}
      {coding && <WorkspaceToggle over={over} />}
      {coding && !dockOpen && <DrawerToggle />}
      {!dockOpen && <DockToggle holds={coding ? undefined : 'the browser'} />}
    </div>
  )
}

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
/** A path in a reply opens in the code panel at its line; ⌘-click opens it in the editor the Open button uses. */
const fileLinks: FileLinkHandler = {
  open: (path, line, external) => {
    const code = useChatCode.getState()
    const target = external ? preferredTarget(code.targets, code.preferred) : null
    if (target && target.kind === 'editor' && code.folder) {
      void window.api.chatCode.openIn(code.folder, target.id, joinPath(code.folder, path), line).catch(() => openInCode(path, line ?? undefined))
      return
    }
    void openInCode(path, line ?? undefined)
  }
}

/**
 * How many conversations are on screen: one while a chat is open. Its
 * transcript asks about its own turns (agent/ApprovalRow.tsx); with none,
 * the app-wide dialog asks about the open chat's turns too, since Settings
 * or another page is in front of it.
 */
let conversations = 0
const conversationListeners = new Set<() => void>()
const isConversationOpen = (): boolean => conversations > 0
function subscribeConversation(listener: () => void): () => void {
  conversationListeners.add(listener)
  return () => {
    conversationListeners.delete(listener)
  }
}
function registerConversation(): () => void {
  conversations++
  conversationListeners.forEach((listener) => listener())
  return () => {
    conversations--
    conversationListeners.forEach((listener) => listener())
  }
}

/**
 * Asking before a tool runs (agent/ApprovalCard.tsx) about a turn that isn't
 * on screen — another chat's, or the open one's while another page covers
 * it — as a card over the page (mounted once, in App.tsx). It stays a moment
 * after it's answered so it can leave the way it was answered, and the next
 * approval in the queue slides in where it was.
 */
export function ApprovalPrompt(): JSX.Element | null {
  const open = useSyncExternalStore(subscribeConversation, isConversationOpen)
  const { asked, waiting, respondApproval, here, askingChat } = useApp(
    useShallow((s) => {
      const ask = s.pendingApproval
      const here = Boolean(ask && s.activeChat()?.messages.some((m) => m.id === ask.messageId))
      // Over another chat, the card says which chat is asking: "Eaon is waiting" read as the one on screen.
      const askingChat = ask && !here ? (s.chats.find((c) => c.messages.some((m) => m.id === ask.messageId))?.title ?? null) : null
      return { asked: ask, waiting: s.approvalQueue.length, respondApproval: s.respondApproval, here, askingChat }
    })
  )
  // The open conversation asks about its own turns, in its transcript.
  const pending = asked && !(here && open) ? asked : null
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

  useApprovalKeys(pending, respond)

  if (!shown) return null
  const edit = shown.tool === 'write_file' || shown.tool === 'edit_file'
  const card = (
    <ApprovalCard
      key={shown.requestId}
      variant="dialog"
      tool={shown.tool}
      input={shown.input}
      title={approvalTitle(shown.tool, shown.input, shown.before)}
      detail={approvalDetail(shown.tool, shown.input)}
      asker={`${askerName(shown.agent)}${askingChat ? ` in “${askingChat}”` : ''}`}
      waiting={pending ? waiting : 0}
      busy={!pending}
      onApprove={() => respond(true)}
      onDeny={() => respond(false)}
      swap={swap}
    >
      <ApprovalPreview ask={shown} />
    </ApprovalCard>
  )

  return createPortal(
    <div className="approval-layer" data-state={pending ? 'in' : 'out'} data-answer={answer ?? undefined} data-wide={edit || undefined}>
      {card}
    </div>,
    document.body
  )
}

function Conversation({ chat }: { chat: Chat }): JSX.Element {
  const { streamingMessageId, remoteStreaming, streamingChatId, browserOpen, toggleBrowser, archiveChat, deleteChat, renameChat, stop } = useApp(useShallow((s) => ({ streamingMessageId: s.streamingMessageId, remoteStreaming: s.remoteStreaming, streamingChatId: s.streamingChatId, browserOpen: s.browserOpen, toggleBrowser: s.toggleBrowser, archiveChat: s.archiveChat, deleteChat: s.deleteChat, renameChat: s.renameChat, stop: s.stop })))
  const isWork = useIsWork()
  const thread = useRef<HTMLDivElement>(null)
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null)
  const [confirmArchive, setConfirmArchive] = useState(false)
  const [confirmDelete, setConfirmDelete] = useState(false)
  const [renaming, setRenaming] = useState(false)
  const [finding, setFinding] = useState(false)
  // Move to a project from the top bar's menu, as from the sidebar's.
  const [moving, setMoving] = useState(false)
  const moreButton = useRef<HTMLButtonElement>(null)
  // Before paint, so the app-wide dialog never flashes a question the transcript has taken.
  useLayoutEffect(registerConversation, [])

  // ⌘F finds in the conversation. Not from the browser panel, a terminal or
  // the code editor, which have their own find; not over a dialog.
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key.toLowerCase() !== 'f' || !(event.metaKey || event.ctrlKey) || event.shiftKey || event.altKey) return
      const target = event.target instanceof Element ? event.target : null
      if (target?.closest('.browser, .term-pane, .xterm, .cm-editor, .monaco-editor, .ide')) return
      if (document.querySelector('[role="dialog"][aria-modal="true"]')) return
      event.preventDefault()
      // A reader looking something up isn't following the reply any more.
      following.current = false
      setFinding(true)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])
  useEffect(() => setFinding(false), [chat.id])

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

  // The thread changing size without a new message — the code panel or the
  // browser sliding open, the window resizing, a card folding — keeps a
  // reader who was at the end there, rather than leaving the reply below the fold.
  useEffect(() => {
    const node = thread.current
    const inner = node?.firstElementChild
    if (!node || !inner) return
    const observer = new ResizeObserver(() => {
      if (following.current) node.scrollTop = node.scrollHeight
    })
    observer.observe(node)
    observer.observe(inner)
    return () => observer.disconnect()
  }, [])

  // Rows already there when a chat opens have been read: they appear with the
  // thread, which fades in as one. Only rows that arrive afterwards rise into
  // place, so opening a long chat no longer replays every message's entrance.
  const opened = useRef<{ chatId: string; ids: Set<string> }>({ chatId: '', ids: new Set() })
  if (opened.current.chatId !== chat.id) opened.current = { chatId: chat.id, ids: new Set(chat.messages.map((m) => m.id)) }
  useLayoutEffect(() => {
    if (document.body.dataset.reduceMotion === 'on') return
    thread.current?.animate([{ opacity: 0, transform: 'translateY(6px)' }, { opacity: 1, transform: 'none' }], {
      duration: 240,
      easing: 'cubic-bezier(0.32, 0.72, 0, 1)'
    })
  }, [chat.id])

  // Scrolled away from the end: a button to get back to it.
  const [away, setAway] = useState(false)
  // Scrolled off the top: a veil of graded blur builds over what passes
  // under the top bar, as far as the reader has scrolled — no re-render,
  // one custom property the veil's blur and wash are scaled by. Not its
  // opacity: a backdrop blur can't see past a parent that isn't fully
  // opaque, so fading the veil kept the blur off until the fade ended.
  // The thread gets one too: under a translucent window it fades its own top
  // instead of the blur (chat.css), and sooner, since a short scroll already
  // takes the first message under the bar.
  const veil = useRef<HTMLDivElement>(null)
  const showVeil = (top: number): void => {
    // Smoothstep: eases in from nothing and settles, rather than a straight ramp.
    const over = (distance: number): string => {
      const t = Math.min(1, Math.max(0, top / distance))
      return (t * t * (3 - 2 * t)).toFixed(3)
    }
    veil.current?.style.setProperty('--veil', over(140))
    thread.current?.style.setProperty('--veil', over(48))
  }
  useEffect(() => {
    setAway(false)
    showVeil(thread.current?.scrollTop ?? 0)
  }, [chat.id])
  const toEnd = (): void => {
    const node = thread.current
    if (!node) return
    following.current = true
    node.scrollTo({ top: node.scrollHeight, behavior: document.body.dataset.reduceMotion === 'on' ? 'auto' : 'smooth' })
  }

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

  const workFolder = useApp((s) => codeFolder(s) ?? s.settings?.work.defaultFolder ?? '~/Eaon')
  const coding = useCoding() && isWork
  // The workspace card beside the conversation: the thread and the message box move over for it.
  const cardInline = useCardInline() && coding

  return (
    <FileLinks.Provider value={coding ? fileLinks : null}>
      <TopBar
        className="chat-header--float"
        left={
          <>
            <span className="chat-header__title" title={chat.title}>
              {chat.title}
            </span>
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
            {isWork && <PanelToggles />}
          </div>
        }
      />
      {coding && <WorkspaceCard />}

      <FindBar open={finding} onClose={() => setFinding(false)} thread={thread} version={chat.messages} />
      <Minimap thread={thread} version={chat.messages.length} />
      <QuoteSelection thread={thread} />
      <div ref={veil} className="scroll-veil" aria-hidden="true">
        {[0, 1, 2, 3, 4, 5].map((i) => (
          <span key={i} style={{ '--i': i } as React.CSSProperties} />
        ))}
      </div>
      <div
        ref={thread}
        className="thread scroll"
        data-card={cardInline || undefined}
        onScroll={(e) => {
          // Reaching the end follows again. Leaving it is only ever the
          // reader's doing (below): layout moves the scroll position too — a
          // panel sliding open reflows the thread, scroll anchoring shifts it —
          // and dropping the follow on those left the reply below the fold.
          const node = e.currentTarget
          const gap = node.scrollHeight - node.scrollTop - node.clientHeight
          if (gap < 8) following.current = true
          // Past a screenful's edge, not a nudge: the button is for finding the way back.
          setAway(!following.current && gap > 160)
          showVeil(node.scrollTop)
        }}
        onKeyDown={(e) => {
          if (['ArrowUp', 'PageUp', 'Home'].includes(e.key) || (e.key === ' ' && e.shiftKey)) following.current = false
        }}
        // On the thread itself rather than a message: the scrollbar.
        onPointerDown={(e) => {
          if (e.target === e.currentTarget) following.current = false
        }}
        // Wheel events arrive before the scroll they cause, so this lets go
        // before the next token's scroll-to-end can undo the user's move.
        onWheel={(e) => {
          if (e.deltaY < 0) following.current = false
        }}
      >
        <div className="thread__inner">
          {chat.messages.map((message) => (
            <RowBoundary key={message.id} item={message}>
              <MessageRow
                message={message}
                streaming={message.id === streamingMessageId || remoteStreaming.includes(message.id)}
                chatActions
                last={message.id === lastReplyId}
                canRetry={message.id === lastReplyId && !streamingChatId}
                canEdit={!streamingChatId}
                fresh={!opened.current.ids.has(message.id)}
              />
            </RowBoundary>
          ))}
        </div>
      </div>

      <div className="composer-dock" data-card={cardInline || undefined}>
        <button className="thread-jump" data-shown={away || undefined} onClick={toEnd} tabIndex={away ? 0 : -1} aria-hidden={!away} aria-label="Scroll to latest" title="Scroll to latest">
          <ArrowDown size={15} strokeWidth={2} />
        </button>
        {isWork && (
          <div className="composer-dock__pinned">
            <GoalBanner chat={chat} />
            <TodoPanel chat={chat} />
          </div>
        )}
        {/* Keyed on the chat, so what was typed in one chat stays with it
            (Composer keeps each chat's unsent draft) instead of following
            the user into the next. */}
        <Composer key={chat.id} variant="chat" />
      </div>
      {coding && <TerminalDrawer />}
      {coding && <ProjectSearch />}

      {menu && (
        <ContextMenu
          x={menu.x}
          y={menu.y}
          onClose={() => setMenu(null)}
          items={[
            // window.prompt does nothing in Electron, so Rename here did nothing.
            { icon: <PencilLine size={15} strokeWidth={1.9} />, label: 'Rename', action: () => setRenaming(true) },
            {
              icon: <Copy size={15} strokeWidth={1.9} />,
              label: 'Copy transcript',
              action: () =>
                void copyTranscript(chat).then(
                  () => notify('Transcript copied'),
                  () => notify("Couldn't copy the transcript. Click in the window and try again.", 'error')
                )
            },
            {
              icon: <FolderOpen size={15} strokeWidth={1.9} />,
              label: coding ? 'Open project folder' : 'Open Eaon’s folder',
              action: () =>
                void window.api.app.showItem(workFolder).then((shown) => {
                  if (!shown) notify(`${workFolder} doesn't exist yet. Eaon makes it the first time it works with files.`, 'error')
                })
            },
            { icon: <FolderInput size={15} strokeWidth={1.9} />, label: chat.projectId ? 'Move to another project' : 'Move to a project', action: () => setMoving(true) },
            { icon: <Archive size={15} strokeWidth={1.9} />, label: 'Archive', action: requestArchive },
            // Deleting can't be undone, so it asks; Archive is the way to put a chat away.
            { icon: <Trash2 size={15} strokeWidth={1.9} />, label: 'Delete', danger: true, action: () => setConfirmDelete(true) }
          ]}
        />
      )}

      {moving && (
        <FolderMenu
          anchor={moreButton}
          open
          onClose={() => setMoving(false)}
          onChoose={(folder) => {
            const app = useApp.getState()
            app.moveChat(chat.id, folder ? app.projectForFolder(folder).id : null)
          }}
          // Its own project isn't somewhere to move it to.
          current={chat.projectId ? (useApp.getState().projects.find((p) => p.id === chat.projectId)?.folder ?? null) : null}
          none={chat.projectId ? 'Move to Chats' : undefined}
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

      <ConfirmDialog
        open={confirmDelete}
        onClose={() => setConfirmDelete(false)}
        title="Delete this chat?"
        confirmLabel="Delete"
        onConfirm={() => deleteChat(chat.id)}
      >
        “{chat.title}” and its messages are removed from this computer. This can’t be undone. To put a chat away and keep it, archive it instead.
      </ConfirmDialog>

      {renaming && <RenameChat title={chat.title} onClose={() => setRenaming(false)} onRename={(title) => renameChat(chat.id, title)} />}
    </FileLinks.Provider>
  )
}

/** The header menu's Rename, as a small dialog with the title selected. */
function RenameChat({ title, onRename, onClose }: { title: string; onRename: (title: string) => void; onClose: () => void }): JSX.Element {
  const [draft, setDraft] = useState(title)
  const save = (): void => {
    if (draft.trim() && draft.trim() !== title) onRename(draft.trim())
    onClose()
  }
  return (
    <Modal
      open
      onClose={onClose}
      title="Rename chat"
      actions={
        <>
          <button type="button" className="btn btn--ghost" onClick={onClose}>
            Cancel
          </button>
          <button type="button" className="btn btn--primary" disabled={!draft.trim()} onClick={save}>
            Rename
          </button>
        </>
      }
    >
      <input
        className="input"
        aria-label="Chat name"
        value={draft}
        autoFocus
        onFocus={(e) => e.currentTarget.select()}
        onChange={(e) => setDraft(e.target.value)}
        // Not while an input method is composing: that Enter picks the characters.
        onKeyDown={(e) => e.key === 'Enter' && !e.nativeEvent.isComposing && save()}
      />
    </Modal>
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
  canRetry = false,
  canEdit = false,
  fresh = true,
  bubbles = false
}: {
  message: ChatMessage
  streaming: boolean
  /** A chat's own message, with nothing running: Edit from here is offered. */
  canEdit?: boolean
  /**
   * A worker's thread: each run of the reply's text is its own bubble, and a
   * turn that has said nothing yet shows nothing — the thread's "is working"
   * line stands in for it.
   */
  bubbles?: boolean
  /** Arrived while the chat was open, so it rises into place; see Conversation. */
  fresh?: boolean
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
  // Sentences, thoughts and runs of calls in the order they happened; see chat/workLog.ts.
  const items = useMemo(() => workLog(message.parts), [message.parts])
  // A turn that only thought or called tools and said nothing still has
  // content to show; testing the joined text alone would render it as "No response".
  const hasContent = items.length > 0
  // A turn that did work — thought, read, ran — gets the "Worked for" line over it; a plain answer doesn't.
  const didWork = useMemo(() => items.some((item) => item.kind !== 'text'), [items])
  // What this turn is asking the user, in the conversation (a chat's own
  // replies only: a worker asks through its own card), and how many more wait.
  const ask = useApp((s) => (chatActions && s.pendingApproval?.messageId === message.id ? s.pendingApproval : null))
  const askWaiting = useApp((s) => (ask ? s.approvalQueue.length : 0))
  // The call it asks about. The loop announces a call before it asks, so it
  // is in a run already, reading as running; the question stands in for it
  // until it is answered. A sub-agent's calls aren't in the transcript.
  const askedPart = useMemo(() => {
    if (!ask || ask.agent) return null
    const input = JSON.stringify(ask.input)
    for (let i = message.parts.length - 1; i >= 0; i--) {
      const part = message.parts[i]
      if (part.type === 'tool' && part.status === 'running' && part.name === ask.tool && JSON.stringify(part.input) === input) return part.id
    }
    return null
  }, [ask, message.parts])
  const changes = useMemo(
    () => toolPartChanges(message.parts.filter((part): part is ChatToolPart => part.type === 'tool')),
    [message.parts]
  )
  // Still being written, by this window's run or another's (another window, a
  // scheduled task): its action bar waits until it is finished.
  const unfinished = streaming || message.parts.some((part) => part.type === 'tool' && part.status === 'running')
  const isWork = useIsWork()
  // The action bar (and the Try again in it) only shows for a reply with
  // something in it; one cut off before it said anything gets its own button.
  const actionBar = Boolean(body || message.usage) && !unfinished
  const retryReply = useApp((s) => s.retryReply)
  // A finished turn folds its work — thoughts, calls, what it said along the
  // way — under "Worked for 2m 4s", leaving its answer and what it changed.
  const [workOpen, setWorkOpen] = useState(false)
  const foldable = didWork && !unfinished && !bubbles && Boolean(message.finishedAt) && !message.error && !message.stopped
  const folded = foldable && !workOpen
  // The answer: the sentences after the turn's last run of steps.
  const answerFrom = useMemo(() => {
    for (let i = items.length - 1; i >= 0; i--) if (items[i].kind !== 'text') return i + 1
    return 0
  }, [items])

  if (message.role === 'user') {
    // A worker's turn: each piece of mail is its own bubble, and a heartbeat
    // is a quiet marker rather than something the user seems to have said.
    if (message.mail || message.heartbeat) {
      return (
        <div className="msg-row msg-row--mail" data-fresh={fresh || undefined}>
          {message.heartbeat && (
            <div className="msg__heartbeat">
              <HeartPulse size={13} strokeWidth={2} />
              <span>Heartbeat{message.heartbeat ? ` · ${message.heartbeat}` : ''}</span>
            </div>
          )}
          {message.mail?.map((mail) =>
            mail.event ? (
              <MailEvent key={mail.id} event={mail.event} text={mail.text} />
            ) : mail.from === 'user' ? (
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
      <div className="msg-row msg-user-block" data-fresh={fresh || undefined} data-user-message={message.id}>
        {message.scheduledTaskId && (
          <span className="msg__scheduled">
            <CalendarClock size={12} strokeWidth={2} />
            Scheduled run
          </span>
        )}
        <Attachments paths={message.attachments} />
        {body && <UserText text={body} />}
        {chatActions && body && <UserActions message={message} text={body} canEdit={canEdit && !message.scheduledTaskId} />}
      </div>
    )
  }

  if (!hasContent && !streaming && !message.error && !message.plan && quietWhenEmpty) return null
  if (bubbles && !hasContent && streaming && !message.error && !message.plan) return null

  return (
    <TurnLive.Provider value={unfinished}>
      <div className="msg-row" ref={row} data-fresh={fresh || undefined}>
        {(didWork || (streaming && !hasContent)) && (
          <TurnHeader
            startedAt={message.createdAt}
            finishedAt={message.finishedAt}
            live={unfinished}
            {...(foldable ? { open: workOpen, onToggle: () => setWorkOpen(!workOpen) } : {})}
          />
        )}
        {/* An error no longer replaces what the turn already did: a Work turn
            that failed on its twentieth call used to hide the nineteen edits and
            commands before it, which still happened. */}
        {hasContent ? (
          // Rendered part by part rather than as one joined string, so a thought
          // or a tool call stays where the model made it — between the sentence
          // that led to it and the one that follows from its result.
          <div className="msg--assistant" data-streaming={streaming || undefined}>
            {(folded ? items.slice(answerFrom) : items).map((item, index) =>
              item.kind === 'text' ? (
                bubbles ? (
                  <div key={item.key} className="msg-bubble">
                    <Markdown text={item.text} />
                  </div>
                ) : (
                  <Markdown key={item.key} text={item.text} />
                )
              ) : item.kind === 'thought' ? (
                // Only the turn's newest thought, while it streams, is still being written.
                <ThoughtRow key={item.key} text={item.text} live={streaming && (folded ? answerFrom : 0) + index === items.length - 1} />
              ) : item.kind === 'tools' ? (
                item.parts.some((part) => part.id === askedPart) ? (
                  item.parts.length > 1 && <ToolRun key={item.key} parts={item.parts.filter((part) => part.id !== askedPart)} />
                ) : (
                  <ToolRun key={item.key} parts={item.parts} />
                )
              ) : (
                <ToolCall key={item.key} part={item.part} />
              )
            )}
          </div>
        ) : streaming ? (
          <LoadingState label="Thinking" />
        ) : message.error ? null : message.interrupted ? null : (
          <div className="msg__status" style={{ color: 'var(--text-3)' }}>
            No response
          </div>
        )}

        {ask && <ApprovalRow key={ask.requestId} ask={ask} waiting={askWaiting} />}

        {message.interrupted && !streaming && (
          <div className="msg__status" style={{ color: 'var(--text-3)' }} role="status">
            Eaon was closed before this reply finished{hasContent ? '; this is what it had so far' : ''}.
            {canRetry && actionBar && ' To ask again, use Try again in the menu below it.'}
            {canRetry && !actionBar && !message.error && (
              <button type="button" className="btn btn--sm" onClick={() => retryReply(message.id)}>
                Try again
              </button>
            )}
          </div>
        )}

        {message.error && (
          <div className="msg__error">
            <TriangleAlert size={15} strokeWidth={1.9} style={{ flex: 'none', marginTop: 1 }} />
            <span>{message.error}</span>
            <ProviderErrorActions issue={message.errorIssue} retryId={canRetry ? message.id : null} />
          </div>
        )}

        {message.plan && <PlanCard message={message} plan={message.plan} />}

        {/* The plan is pinned above the composer while the latest reply works through it; after that it lives here. */}
        {!unfinished && message.todos && message.todos.length > 0 && (!last || message.todos.every((t) => t.status === 'done')) && (
          <PlanRow todos={message.todos} />
        )}

        {!streaming && changes.length > 0 && <EditedFiles messageId={message.id} changes={changes} work={isWork} />}

        {message.stopped && !streaming && (
          <div className="msg__stopped" role="status">
            <X size={13} strokeWidth={2.2} />
            <span>Stopped</span>
            <span className="msg__stopped-why">· You stopped this reply</span>
          </div>
        )}

        {actionBar && (
          <div className="msg__actions" data-pinned={last || Boolean(message.feedback) || undefined}>
            <ReplyActions message={message} text={body} row={row} chatActions={chatActions} canRetry={canRetry} />
          </div>
        )}
      </div>
    </TurnLive.Provider>
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
  // A file moved or deleted since, or with no app to open it, said nothing.
  const open = (path: string): void =>
    void window.api.library.open(path).catch((error: unknown) => notify(`Couldn't open it: ${errorText(error)}`, 'error'))
  return (
    <div className="msg-attachments" data-align={align}>
      {paths.map((path) => {
        const name = path.split(/[\\/]/).pop() ?? path
        if (isImagePath(path)) {
          return (
            <button key={path} className="msg-attachment msg-attachment--media" title={name} onClick={() => viewImage(path, chatImages())}>
              <img src={fileUrl(path)} alt={name} loading="lazy" />
            </button>
          )
        }
        if (isVideoPath(path)) {
          return (
            <button key={path} className="msg-attachment msg-attachment--media" title={name} onClick={() => open(path)}>
              <video src={fileUrl(path)} preload="metadata" muted />
            </button>
          )
        }
        return (
          <button key={path} className="msg-attachment msg-attachment--file" title={path} onClick={() => open(path)}>
            <FileText size={15} strokeWidth={1.8} />
            <span>{name}</span>
          </button>
        )
      })}
    </div>
  )
}

/** Every picture attached in the open chat, in order: what the image viewer steps through. */
function chatImages(): string[] {
  const chat = useApp.getState().activeChat()
  return (chat?.messages ?? []).flatMap((m) => [...(m.attachments ?? []), ...(m.mail?.flatMap((mail) => mail.files ?? []) ?? [])]).filter(isImagePath)
}

/** Past this, a message of the user's folds to its first lines, with a way to open it. */
const FOLD_LINES = 12
const FOLD_CHARS = 900

/**
 * What the user wrote. A long paste — a log, a file, a spec — folds to its
 * first lines with a fade and a Show more, so it doesn't push the reply a
 * screen away. Find opens folded messages while it's up (chat.css).
 */
function UserText({ text }: { text: string }): JSX.Element {
  const [open, setOpen] = useState(false)
  const long = text.length > FOLD_CHARS || text.split('\n').length > FOLD_LINES
  return (
    <div className="msg--user" data-folded={(long && !open) || undefined}>
      <div className="msg-user__body">{text}</div>
      {long && (
        <button type="button" className="msg-user__more" onClick={() => setOpen(!open)} aria-expanded={open}>
          {open ? 'Show less' : 'Show more'}
        </button>
      )}
    </div>
  )
}

/** Under one of the user's messages, on hover: copy it, or edit it and go again from there. */
function UserActions({ message, text, canEdit }: { message: ChatMessage; text: string; canEdit: boolean }): JSX.Element {
  const editMessage = useApp((s) => s.editMessage)
  const [copied, setCopied] = useState(false)
  return (
    <div className="msg-user__actions">
      <button
        type="button"
        className="msg-user__action"
        aria-label={copied ? 'Copied' : 'Copy message'}
        title={copied ? 'Copied' : 'Copy'}
        onClick={() =>
          void copyText(text).then((ok) => {
            if (!ok) return notify(CLIPBOARD_FAILED, 'error')
            setCopied(true)
            setTimeout(() => setCopied(false), 1400)
          })
        }
      >
        {copied ? <Check size={13} strokeWidth={2.2} /> : <Copy size={13} strokeWidth={1.9} />}
      </button>
      {canEdit && (
        <button
          type="button"
          className="msg-user__action"
          aria-label="Edit from here"
          title="Edit from here — the replies after it are replaced"
          onClick={() => editMessage(message.id)}
        >
          <PencilLine size={13} strokeWidth={1.9} />
        </button>
      )}
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

const EVENT_ICON = { job: Terminal, watch: Eye, goal: Target } as const

/**
 * Something a worker set up reporting back — a job ending, a watch firing,
 * a timed goal running out — as a quiet marker like a heartbeat, with what
 * it said one click away.
 */
function MailEvent({ event, text }: { event: NonNullable<WorkerMail['event']>; text: string }): JSX.Element {
  const [open, setOpen] = useState(false)
  const Icon = EVENT_ICON[event.kind] ?? Eye
  return (
    <div className="msg__event" data-open={open || undefined}>
      <button className="msg__heartbeat msg__event-head" onClick={() => setOpen(!open)} aria-expanded={open}>
        <Icon size={13} strokeWidth={2} />
        <span>{event.title}</span>
        <ChevronDown size={12} strokeWidth={2} className="msg__event-chevron" />
      </button>
      {open && <pre className="msg__event-text">{text}</pre>}
    </div>
  )
}
