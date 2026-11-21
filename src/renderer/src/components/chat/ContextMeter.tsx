import { useMemo, useRef, type JSX } from 'react'
import { useApp } from '../../state/store'
import { contextUse, type ContextParts } from '../../state/contextUse'
import { Popover, useDisclosure } from '../ui'
import { ChatUsage } from './ChatUsage'

/**
 * A small ring by the model in a conversation's message box: how much of the
 * model's context the chat fills. Opens to what fills it, a colour each
 * (what was said, the tools' calls, pictures, the summary of older messages,
 * the system prompt and tools), how much is free, how much is kept back for
 * summarizing, and how far off that is. Hidden when the model doesn't say how
 * big its context is.
 */

const PARTS: { key: keyof ContextParts; label: string }[] = [
  { key: 'messages', label: 'Messages' },
  { key: 'tools', label: 'Tool calls' },
  { key: 'files', label: 'Pictures' },
  { key: 'summary', label: 'Summary' },
  { key: 'system', label: 'System prompt and tools' }
]

export function ContextMeter({ contextWindow, modelName }: { contextWindow: number | undefined; modelName?: string }): JSX.Element | null {
  const chat = useApp((s) => s.activeChat())
  const compactAt = useApp((s) => s.settings?.context?.compactAt ?? 0.7)
  const autoCompact = useApp((s) => s.settings?.context?.autoCompact !== false)
  const anchor = useRef<HTMLButtonElement>(null)
  const panel = useDisclosure()
  // Estimating walks the whole chat, so only when the messages change, not on every store update.
  const messages = chat?.messages
  const summary = chat?.summary
  const use = useMemo(() => (chat ? contextUse(chat) : null), [messages, summary]) // eslint-disable-line react-hooks/exhaustive-deps

  if (!chat || !use || !contextWindow || contextWindow <= 0) return null
  const window = contextWindow
  const used = use.total
  const share = Math.min(1, used / window)
  const percent = share * 100
  const full = autoCompact && share >= compactAt
  const radius = 7
  const circumference = 2 * Math.PI * radius
  const shown = percent < 10 ? percent.toFixed(1).replace(/\.0$/, '') : String(Math.round(percent))
  // Kept back for summarizing: the room past where it starts. Free: what's left before it.
  const summarizeAt = autoCompact ? window * compactAt : window
  const kept = autoCompact ? Math.max(0, window - Math.max(used, summarizeAt)) : 0
  const free = Math.max(0, summarizeAt - used)
  // Shares of the window; of what's there when the chat has outgrown it.
  const whole = Math.max(window, used)
  const of = (n: number): string => `${((n / whole) * 100).toFixed(1)}%`
  const parts = PARTS.filter((p) => use.parts[p.key] >= 1)
  const over = used > window

  return (
    <>
      <button
        ref={anchor}
        type="button"
        className="context-meter"
        data-open={panel.open || undefined}
        data-full={full || undefined}
        onClick={panel.toggle}
        aria-label={`Context window about ${shown}% full`}
        title={`Context window about ${shown}% full`}
      >
        <svg viewBox="0 0 18 18" aria-hidden="true">
          <circle cx="9" cy="9" r={radius} className="context-meter__track" />
          <circle
            cx="9"
            cy="9"
            r={radius}
            className="context-meter__fill"
            strokeDasharray={circumference}
            strokeDashoffset={circumference * (1 - share)}
          />
        </svg>
      </button>
      <Popover anchor={anchor} open={panel.open} onClose={panel.close} placement="top-end" width={300} className="context-pop">
        <div className="context-panel">
          <div className="context-panel__title">Context</div>
          <div className="context-panel__head">
            <span className="context-panel__used">{shown}% used</span>
            <span className="context-panel__numbers" title={use.counted ? 'As the provider counted the latest request' : 'Estimated'}>
              {use.counted ? '' : '~'}
              {compactTokens(used)} / {compactTokens(window)}
            </span>
          </div>
          <div className="context-bar" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(percent)} aria-label="Context window used">
            {parts.map((p) => (
              <span key={p.key} className="context-bar__part" data-part={p.key} style={{ width: `${(use.parts[p.key] / whole) * 100}%` }} />
            ))}
            {autoCompact && <i style={{ left: `${compactAt * 100}%` }} aria-hidden="true" />}
          </div>
          <ul className="context-rows">
            {parts.map((p) => (
              <li key={p.key}>
                <span className="context-rows__swatch" data-part={p.key} />
                <span className="context-rows__label">{p.label}</span>
                <span className="context-rows__count">{compactTokens(use.parts[p.key])}</span>
                <span className="context-rows__share">{of(use.parts[p.key])}</span>
              </li>
            ))}
          </ul>
          {!over && (
            <ul className="context-rows context-rows--room">
              <li>
                <span className="context-rows__swatch" data-part="free" />
                <span className="context-rows__label">Free space</span>
                <span className="context-rows__count">{compactTokens(free)}</span>
                <span className="context-rows__share">{of(free)}</span>
              </li>
              {autoCompact && (
                <li>
                  <span className="context-rows__swatch" data-part="kept" />
                  <span className="context-rows__label">Kept for summarizing</span>
                  <span className="context-rows__count">{compactTokens(kept)}</span>
                  <span className="context-rows__share">{of(kept)}</span>
                </li>
              )}
            </ul>
          )}
          <div className="context-panel__foot">
            {over
              ? `Too big for ${modelName ?? 'this model'} (${compactTokens(window)}): ${autoCompact ? 'older messages are summarized before the next one' : 'summarizing is off'}`
              : !autoCompact
                ? 'Summarizing older messages is off'
                : full
                  ? 'Older messages are summarized next turn'
                  : `${compactTokens(free)} until older messages are summarized`}
          </div>
          <ChatUsage messages={chat.messages} />
        </div>
      </Popover>
    </>
  )
}

/** 54,210 → "54.2k", 1,048,576 → "1M". */
export function compactTokens(count: number): string {
  const n = Math.round(count)
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(n >= 10_000_000 ? 0 : 1).replace(/\.0$/, '')}M`
  if (n >= 1000) return `${(n / 1000).toFixed(1).replace(/\.0$/, '')}k`
  return String(n)
}
