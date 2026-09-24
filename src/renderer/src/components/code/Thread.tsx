import { memo, useEffect, useLayoutEffect, useMemo, useRef, useState, type JSX } from 'react'
import {
  Archive,
  Check,
  ChevronRight,
  CircleStop,
  Copy,
  Info,
  Puzzle,
  RefreshCw,
  SquareTerminal,
  TriangleAlert
} from 'lucide-react'
import { ThinkingOrb } from '../ThinkingOrb'
import { Markdown } from '../agent/Markdown'
import { useCode } from './codeStore'
import { ToolRow } from './ToolRow'
import type { Block, Item } from './transcript'

type AssistantItem = Extract<Item, { kind: 'assistant' }>

/** The conversation, newest at the bottom, kept pinned there while it streams unless the user scrolled up. */
export function Thread(): JSX.Element {
  const items = useCode((s) => s.transcript.items)
  const running = useCode((s) => s.transcript.running)
  const awaiting = useCode((s) => s.awaiting)
  const scroller = useRef<HTMLDivElement>(null)
  const pinned = useRef(true)

  const last = items[items.length - 1]
  // Working, but nothing on screen shows it yet: the prompt went out, or a
  // turn is between messages (a tool finished, the next reply has not begun).
  const showWorking = awaiting || (running && !(last?.kind === 'assistant' && last.streaming && hasVisible(last)))

  useLayoutEffect(() => {
    const node = scroller.current
    if (node && pinned.current) node.scrollTop = node.scrollHeight
  })

  useEffect(() => {
    const node = scroller.current
    if (!node) return
    const onScroll = (): void => {
      pinned.current = node.scrollHeight - node.scrollTop - node.clientHeight < 120
    }
    node.addEventListener('scroll', onScroll, { passive: true })
    return () => node.removeEventListener('scroll', onScroll)
  }, [])

  return (
    <div ref={scroller} className="thread scroll code-thread">
      <div className="thread__inner">
        {items.map((item) => (
          <ItemRow key={item.id} item={item} />
        ))}
        {showWorking && (
          <div className="msg-row">
            <div className="msg__status">
              <ThinkingOrb />
              <span className="shimmer">{awaiting ? 'Starting' : 'Working'}</span>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}

function hasVisible(item: AssistantItem): boolean {
  return item.blocks.some((block) => block && (block.kind === 'tool' || block.text.trim().length > 0))
}

const ItemRow = memo(function ItemRow({ item }: { item: Item }): JSX.Element | null {
  switch (item.kind) {
    case 'user':
      return (
        <div className="msg-row code-user">
          <div className="msg--user">
            {item.text}
            {item.images > 0 && <span className="code-user__images">+{item.images} image{item.images === 1 ? '' : 's'}</span>}
          </div>
        </div>
      )
    case 'assistant':
      return <AssistantRow item={item} />
    case 'bash':
      return <BashRow item={item} />
    case 'notice':
      return <NoticeRow item={item} />
    case 'custom':
      return (
        <div className="msg-row code-custom">
          <div className="code-custom__label">
            <Puzzle size={13} strokeWidth={1.9} />
            {item.label}
          </div>
          <Markdown text={item.text} />
        </div>
      )
  }
})

function AssistantRow({ item }: { item: AssistantItem }): JSX.Element | null {
  const [copied, setCopied] = useState(false)
  const text = useMemo(
    () =>
      item.blocks
        .filter((block): block is Extract<Block, { kind: 'text' }> => block?.kind === 'text')
        .map((block) => block.text)
        .join('\n\n')
        .trim(),
    [item.blocks]
  )
  const visible = hasVisible(item)
  const truncated = item.stopReason === 'length'
  if (!visible && !item.error && item.stopReason !== 'aborted' && !truncated) return null

  // The last text block carries the streaming caret.
  let lastText = -1
  item.blocks.forEach((block, index) => {
    if (block?.kind === 'text' && block.text) lastText = index
  })

  return (
    <div className="msg-row">
      <div className="msg--assistant code-assistant" data-streaming={item.streaming || undefined}>
        {item.blocks.map((block, index) => {
          if (!block) return null
          if (block.kind === 'tool') return <ToolRow key={block.id} id={block.id} />
          if (block.kind === 'thinking') {
            return block.text.trim() ? (
              <ThinkingBlock key={index} text={block.text} live={item.streaming && index === item.blocks.length - 1} />
            ) : null
          }
          return block.text ? (
            <div key={index} className="code-text" data-caret={(item.streaming && index === lastText) || undefined}>
              <Markdown text={block.text} />
            </div>
          ) : null
        })}
      </div>
      {item.error && (
        <div className="msg__error">
          <TriangleAlert size={15} strokeWidth={1.9} style={{ flex: 'none', marginTop: 1 }} />
          <span>{item.error}</span>
        </div>
      )}
      {truncated && !item.streaming && (
        <div className="code-stopped">
          <TriangleAlert size={13} strokeWidth={1.9} />
          The reply hit the model&rsquo;s output limit and was cut off
        </div>
      )}
      {item.stopReason === 'aborted' && (
        <div className="code-stopped">
          <CircleStop size={13} strokeWidth={1.9} />
          Stopped
        </div>
      )}
      {!item.streaming && text && (
        <div className="msg__actions">
          <button
            className="icon-btn"
            aria-label="Copy reply"
            onClick={() => {
              void navigator.clipboard.writeText(text)
              setCopied(true)
              setTimeout(() => setCopied(false), 1400)
            }}
          >
            {copied ? <Check size={14} strokeWidth={2} /> : <Copy size={14} strokeWidth={1.9} />}
          </button>
          {item.model && <span className="code-model-tag">{item.model}</span>}
        </div>
      )}
    </div>
  )
}

/** Reasoning, folded to one line. Open while it is being written, so the user can watch it. */
function ThinkingBlock({ text, live }: { text: string; live: boolean }): JSX.Element {
  const [open, setOpen] = useState<boolean | null>(null)
  const expanded = open ?? live
  const words = text.trim().split(/\s+/).length
  return (
    <div className="thinking code-thinking">
      <button className="thinking__summary" onClick={() => setOpen(!expanded)} aria-expanded={expanded}>
        {live ? <ThinkingOrb size={20} /> : <span className="thinking__dot" />}
        <span className={live ? 'shimmer' : undefined}>{live ? 'Thinking' : `Thought · ${words.toLocaleString()} words`}</span>
        <ChevronRight size={13} strokeWidth={2} className="thinking__chevron" data-open={expanded || undefined} />
      </button>
      <div className="thinking__body" data-open={expanded || undefined}>
        <div className="code-thinking__text">{text}</div>
      </div>
    </div>
  )
}

function BashRow({ item }: { item: Extract<Item, { kind: 'bash' }> }): JSX.Element {
  const failed = !item.running && (item.cancelled || (typeof item.exitCode === 'number' && item.exitCode !== 0))
  return (
    <div className="msg-row">
      <div className="tool code-bash" data-open data-status={item.running ? 'running' : failed ? 'error' : 'done'}>
        <div className="tool__head">
          <span className="tool__glyph">
            {item.running ? <ThinkingOrb size={14} state="searching" /> : <SquareTerminal size={14} strokeWidth={1.9} />}
          </span>
          <span className="code-bash__command">{item.command}</span>
          <span className="tool__spacer" />
          {item.excluded && <span className="code-bash__tag">not in context</span>}
          {!item.running && (
            <span className="code-bash__tag" data-error={failed || undefined}>
              {item.cancelled ? 'cancelled' : typeof item.exitCode === 'number' ? `exit ${item.exitCode}` : 'done'}
            </span>
          )}
        </div>
        <div className="tool__panel">
          {item.output ? (
            <pre className={`tool__output scroll${item.running ? ' tool__output--live' : ''}`}>{item.output}</pre>
          ) : (
            <div className="tool__waiting">{item.running ? 'Running…' : 'No output'}</div>
          )}
          {item.truncated && <div className="tool__waiting">Output truncated; the full log is saved by Eaon Code.</div>}
        </div>
      </div>
    </div>
  )
}

const NOTICE_ICONS = { compact: Archive, retry: RefreshCw, info: Info, extension: Puzzle, stop: TriangleAlert }

function NoticeRow({ item }: { item: Extract<Item, { kind: 'notice' }> }): JSX.Element {
  const [open, setOpen] = useState(false)
  const Icon = NOTICE_ICONS[item.icon] ?? Info
  return (
    <div className="msg-row code-notice" data-tone={item.tone}>
      <button className="code-notice__head" onClick={() => item.detail && setOpen(!open)} disabled={!item.detail}>
        {item.pending ? (
          <RefreshCw size={13} strokeWidth={2} className="spinner" />
        ) : (
          <Icon size={13} strokeWidth={1.9} />
        )}
        <span className={item.pending ? 'shimmer' : undefined}>{item.text}</span>
        {item.detail && <ChevronRight size={13} strokeWidth={2} className="thinking__chevron" data-open={open || undefined} />}
      </button>
      {open && item.detail && (
        <div className="code-notice__detail">
          <Markdown text={item.detail} />
        </div>
      )}
    </div>
  )
}
