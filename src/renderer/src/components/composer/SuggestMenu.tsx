import { Fragment, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode, type RefObject } from 'react'
import { Check } from 'lucide-react'
import { findTrigger, rankItems, replaceTrigger, type Rankable, type Trigger, type TriggerChar } from './suggest'
import './composer-menus.css'

/**
 * One row of a "/" or "@" menu, on one line. A "/" row reads "/command" and
 * then its description (or its title, when it has none); a row with no
 * command shows its title in the command's place.
 */
export interface SuggestItem extends Rankable {
  id: string
  /** Shown in the "@" menu only: "/" rows are their names, like a terminal's. */
  icon?: ReactNode
  description?: string
  hint?: ReactNode
  checked?: boolean
  /** In the "@" menu, shown above this item when it is the first of its section in the filtered list. */
  section?: string
  /** What replaces the typed word: a mention like "@Notion". Empty for a command, which only does something. */
  insert?: string
  run?: () => void
}

/** Rows per trigger, built when the menu opens so they reflect the current settings; given what was typed, for lists too long to build whole. */
export type SuggestSources = Partial<Record<TriggerChar, (query: string) => SuggestItem[]>>

/** More rows than this and the list is a wall: the best ones show, the rest wait for more typing. */
const MAX_ROWS = 60

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
  // Built per keystroke while open; lists are short, and a long one (the project's files) is narrowed by its source.
  const items = useMemo(() => (build ? rankItems(build(query), query).slice(0, MAX_ROWS) : []), [build, query])
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
        commands={trigger.char === '/'}
        active={Math.min(active, items.length - 1)}
        label={label?.[trigger.char] ?? (trigger.char === '/' ? 'Commands' : 'Mentions')}
        onHover={setActive}
        onPick={(item) => pick(item, trigger)}
      />
    ) : null

  return { menu, onKeyDown, onCaret }
}

/**
 * The list itself, a panel on the message box's top edge as wide as the box
 * (composer-menus.css). "/" rows are bare names with their descriptions, in
 * the menu's own order; "@" rows keep their icons and section names, since
 * files, commits, chats and plugins share that list. Rows scrolled toward
 * either edge fade and soften into it rather than being cut off by it.
 */
function SuggestList({
  items,
  commands,
  active,
  label,
  onHover,
  onPick
}: {
  items: SuggestItem[]
  commands: boolean
  active: number
  label: string
  onHover: (index: number) => void
  onPick: (item: SuggestItem) => void
}): JSX.Element {
  const list = useRef<HTMLDivElement>(null)
  // A row picked out by the pointer is already where the pointer is: scrolling to it moved the list under the mouse.
  const pointed = useRef(false)
  // Rows hidden above or below: that edge gets its veil.
  const [hidden, setHidden] = useState({ above: false, below: false })
  const measure = (): void => {
    const node = list.current
    if (!node) return
    const above = node.scrollTop > 2
    const below = node.scrollHeight - node.scrollTop - node.clientHeight > 2
    setHidden((current) => (current.above === above && current.below === below ? current : { above, below }))
  }
  useLayoutEffect(() => {
    if (!pointed.current) list.current?.querySelector<HTMLElement>(`[data-index="${active}"]`)?.scrollIntoView({ block: 'nearest' })
    pointed.current = false
    measure()
  }, [active, items])

  return (
    <div className="suggest-menu" data-for={commands ? 'commands' : 'mentions'} data-above={hidden.above || undefined} data-below={hidden.below || undefined}>
      <div ref={list} className="suggest-menu__list" role="listbox" aria-label={label} onScroll={measure}>
        {items.map((item, index) => {
          const name = item.command ? `/${item.command}` : item.title
          const about = item.description ?? (item.command && item.title !== item.command ? item.title : undefined)
          return (
            <Fragment key={item.id}>
              {!commands && item.section && item.section !== items[index - 1]?.section && <div className="suggest-menu__label">{item.section}</div>}
              <button
                type="button"
                role="option"
                aria-selected={index === active}
                data-index={index}
                data-highlight={index === active || undefined}
                className="suggest-row"
                // mousedown, not click: the text box keeps focus and the caret.
                onMouseDown={(e) => {
                  e.preventDefault()
                  onPick(item)
                }}
                onMouseMove={() => {
                  if (index === active) return
                  pointed.current = true
                  onHover(index)
                }}
              >
                {!commands && item.icon !== undefined && <span className="suggest-row__icon">{item.icon}</span>}
                <span className="suggest-row__name">{name}</span>
                {about && <span className="suggest-row__about">{about}</span>}
                {item.hint !== undefined && <span className="suggest-row__hint">{item.hint}</span>}
                {item.checked && (
                  <span className="suggest-row__check" aria-label="On">
                    <Check size={14} strokeWidth={2.2} />
                  </span>
                )}
              </button>
            </Fragment>
          )
        })}
      </div>
    </div>
  )
}
