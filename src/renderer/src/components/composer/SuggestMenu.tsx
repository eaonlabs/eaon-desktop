import { Fragment, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode, type RefObject } from 'react'
import { Check } from 'lucide-react'
import { findTrigger, rankItems, replaceTrigger, type Rankable, type Trigger, type TriggerChar } from './suggest'
import './composer-menus.css'

/** One row of a "/" or "@" menu. */
export interface SuggestItem extends Rankable {
  id: string
  icon?: ReactNode
  description?: string
  hint?: ReactNode
  checked?: boolean
  /** Shown above this item when it is the first of its section in the filtered list. */
  section?: string
  /** What replaces the typed word: a mention like "@Notion". Empty for a command, which only does something. */
  insert?: string
  run?: () => void
}

/** Rows per trigger, built when the menu opens so they reflect the current settings. */
export type SuggestSources = Partial<Record<TriggerChar, () => SuggestItem[]>>

export interface Suggest {
  /** The menu, to render inside the positioned composer stack; null when closed. */
  menu: JSX.Element | null
  /** Call first in the textarea's onKeyDown; true means the menu used the key. */
  onKeyDown: (event: React.KeyboardEvent<HTMLTextAreaElement>) => boolean
  /** Call from onChange, onSelect and onClick so the menu follows the caret. */
  onCaret: () => void
}

/**
 * Typeahead menus for a composer: "/" for commands, "@" for things to
 * mention. The menu opens on a trigger at the start of a word, filters as
 * the word grows, and leaves focus in the text box the whole time. ↑ ↓ move,
 * Enter or Tab picks, Esc closes it until the word changes.
 *
 * Not a Popover: a Popover lays a click-catcher over the window, which would
 * swallow the clicks people make in the text box while the menu is open.
 */
export function useSuggest({
  text,
  setText,
  textarea,
  sources,
  label
}: {
  text: string
  setText: (text: string) => void
  textarea: RefObject<HTMLTextAreaElement>
  sources: SuggestSources
  /** Read aloud for the list, per trigger. */
  label?: Partial<Record<TriggerChar, string>>
}): Suggest {
  const [caret, setCaret] = useState(0)
  const [dismissed, setDismissed] = useState<string | null>(null)
  const [active, setActive] = useState(0)
  const chars = Object.keys(sources) as TriggerChar[]
  const trigger = findTrigger(text, caret, chars)
  const key = trigger ? `${trigger.char}${trigger.start}` : null
  const build = trigger ? sources[trigger.char] : undefined
  const query = trigger?.query ?? ''
  // Built per keystroke while open; every list is short (commands, plugins, workers).
  const items = useMemo(() => (build ? rankItems(build(), query) : []), [build, query])
  const open = Boolean(trigger) && key !== dismissed && items.length > 0

  useEffect(() => setActive(0), [key, query])
  useEffect(() => {
    if (dismissed && dismissed !== key) setDismissed(null)
  }, [dismissed, key])

  const onCaret = (): void => {
    const node = textarea.current
    if (node) setCaret(node.selectionStart ?? node.value.length)
  }

  const pick = (item: SuggestItem, at: Trigger): void => {
    const next = replaceTrigger(text, at, item.insert ?? '')
    setText(next.text)
    setCaret(next.caret)
    item.run?.()
    requestAnimationFrame(() => {
      const node = textarea.current
      if (!node) return
      node.focus()
      node.setSelectionRange(next.caret, next.caret)
    })
  }

  const onKeyDown = (event: React.KeyboardEvent<HTMLTextAreaElement>): boolean => {
    if (!open || !trigger || event.nativeEvent.isComposing) return false
    const count = items.length
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault()
      setActive((current) => (current + (event.key === 'ArrowDown' ? 1 : -1) + count) % count)
      return true
    }
    if ((event.key === 'Enter' && !event.shiftKey) || event.key === 'Tab') {
      event.preventDefault()
      pick(items[Math.min(active, count - 1)], trigger)
      return true
    }
    if (event.key === 'Escape') {
      event.preventDefault()
      event.stopPropagation()
      setDismissed(key)
      return true
    }
    return false
  }

  const menu =
    open && trigger ? (
      <SuggestList
        items={items}
        active={Math.min(active, items.length - 1)}
        label={label?.[trigger.char] ?? (trigger.char === '/' ? 'Commands' : 'Mentions')}
        onHover={setActive}
        onPick={(item) => pick(item, trigger)}
      />
    ) : null

  return { menu, onKeyDown, onCaret }
}

function SuggestList({
  items,
  active,
  label,
  onHover,
  onPick
}: {
  items: SuggestItem[]
  active: number
  label: string
  onHover: (index: number) => void
  onPick: (item: SuggestItem) => void
}): JSX.Element {
  const list = useRef<HTMLDivElement>(null)
  useLayoutEffect(() => {
    list.current?.querySelector<HTMLElement>(`[data-index="${active}"]`)?.scrollIntoView({ block: 'nearest' })
  }, [active])

  return (
    <div ref={list} className="menu suggest-menu" role="listbox" aria-label={label}>
      {items.map((item, index) => (
        <Fragment key={item.id}>
          {item.section && item.section !== items[index - 1]?.section && <div className="menu__label">{item.section}</div>}
          <button
            type="button"
            role="option"
            aria-selected={index === active}
            data-index={index}
            data-highlight={index === active || undefined}
            className={`menu__item ${item.description ? 'menu__item--tall' : ''}`}
            // mousedown, not click: the text box keeps focus and the caret.
            onMouseDown={(e) => {
              e.preventDefault()
              onPick(item)
            }}
            onMouseMove={() => index !== active && onHover(index)}
          >
            {item.icon !== undefined && <span className="menu__item-icon">{item.icon}</span>}
            <span className="menu__item-body">
              <span className="menu__item-title">{item.title}</span>
              {item.description && <span className="menu__item-desc">{item.description}</span>}
            </span>
            {item.hint !== undefined && <span className="menu__item-hint">{item.hint}</span>}
            {item.checked && (
              <span className="menu__item-check">
                <Check size={15} strokeWidth={2.2} />
              </span>
            )}
          </button>
        </Fragment>
      ))}
    </div>
  )
}
