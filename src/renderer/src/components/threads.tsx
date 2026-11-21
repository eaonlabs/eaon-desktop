import { forwardRef, useEffect, useRef, useState, useSyncExternalStore, type JSX, type ReactNode } from 'react'
import { ChevronDown, CircleCheck, Folder, Pin, Search, X } from 'lucide-react'
import { heldOrder, workingFor } from '@shared/threadList'

/**
 * The pieces of the sidebar's thread list (shared/threadList.ts): a search
 * row with the list's tools, rows that carry their project's tag, and the
 * folding sections under the list (Working, Archived).
 */

/** A clock for a list's ages: every second while something in it works (for when it joins Working), else every half minute. */
export function useNow(fast: boolean): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    setNow(Date.now())
    const timer = window.setInterval(() => setNow(Date.now()), fast ? 1000 : 30_000)
    return () => window.clearInterval(timer)
  }, [fast])
  return now
}

/**
 * A list's order that holds still while the pointer is on it (heldOrder) and
 * settles when it leaves: re-sorting by activity under the pointer moved the
 * row about to be clicked. Spread `hold` on the list.
 */
export function useHeldOrder(ids: string[]): { order: string[]; hold: { onPointerEnter: () => void; onPointerLeave: () => void } } {
  const [holding, setHolding] = useState(false)
  const shown = useRef<string[]>([])
  const order = holding ? heldOrder(ids, shown.current) : ids
  shown.current = order
  return { order, hold: { onPointerEnter: () => setHolding(true), onPointerLeave: () => setHolding(false) } }
}

/** Projects' pictures this window has asked for, by folder (null: none, or not back yet). */
const avatars = new Map<string, string | null>()
const avatarListeners = new Set<() => void>()
/** A folder with no picture is asked again after this long, the next time its tag is shown (it was offline, or the remote was added since). */
const NO_AVATAR_FOR_MS = 10 * 60_000

function askAvatar(folder: string): void {
  if (avatars.has(folder)) return
  avatars.set(folder, null)
  const forget = (): void => void window.setTimeout(() => avatars.get(folder) === null && avatars.delete(folder), NO_AVATAR_FOR_MS)
  const ask = window.api.projectAvatars?.get
  if (!ask) return
  void ask(folder).then(
    (src) => {
      if (!src) return forget()
      avatars.set(folder, src)
      for (const listener of avatarListeners) listener()
    },
    forget
  )
}

const onAvatars = (listener: () => void): (() => void) => {
  avatarListeners.add(listener)
  return () => avatarListeners.delete(listener)
}

/** The picture of whoever owns the project folder's repository (main/features/projectAvatars.ts), once it's back. */
function useProjectAvatar(folder: string | null | undefined): string | null {
  const src = useSyncExternalStore(onAvatars, () => (folder ? (avatars.get(folder) ?? null) : null))
  useEffect(() => {
    if (folder) askAvatar(folder)
  }, [folder])
  return src
}

/**
 * A project's tag: the picture of the account or organisation that owns its
 * repository on GitHub (or GitLab, Codeberg, Bitbucket), given its folder;
 * else a plain folder. No project: a dashed square.
 */
export function ProjectBadge({ name, folder }: { name: string | null; folder?: string | null }): JSX.Element {
  const avatar = useProjectAvatar(name ? folder : null)
  const [broken, setBroken] = useState<string | null>(null)
  if (!name) return <span className="thread-badge thread-badge--none" aria-hidden="true" />
  if (avatar && avatar !== broken)
    return <img className="thread-badge thread-badge--picture" src={avatar} alt="" aria-hidden="true" draggable={false} onError={() => setBroken(avatar)} />
  return (
    <span className="thread-badge thread-badge--folder" aria-hidden="true">
      <Folder size={16} strokeWidth={1.8} />
    </span>
  )
}

/**
 * A thread row's lines: its project (tag, name, pinned) with when it was
 * last active, or what it is doing, at the end; its title; and a line under
 * that (a branch). `marks` (changes, the agents in it) end the last line.
 */
export function ThreadLines({
  project,
  folder,
  pinned,
  when,
  title,
  sub,
  marks
}: {
  project: string | null
  /** The project's folder, for its owner's picture on the tag. */
  folder?: string | null
  pinned?: boolean
  when?: ReactNode
  title: ReactNode
  sub?: ReactNode
  marks?: ReactNode
}): JSX.Element {
  return (
    <span className="trow">
      <span className="trow__top">
        <ProjectBadge name={project} folder={folder} />
        {pinned && <Pin className="trow__pin" size={11} strokeWidth={2.2} role="img" aria-label="Pinned" />}
        <span className="trow__project">{project ?? 'No project'}</span>
        {when != null && when !== '' && <span className="trow__when">{when}</span>}
      </span>
      <span className="trow__line">
        <span className="trow__title">{title}</span>
        {!sub && marks && <span className="trow__marks">{marks}</span>}
      </span>
      {sub && (
        <span className="trow__line">
          <span className="trow__sub">{sub}</span>
          {marks && <span className="trow__marks">{marks}</span>}
        </span>
      )}
    </span>
  )
}

/** "Working 31s", counting up from `since`, behind a turning dashed ring. */
export function WorkingFor({ since, label = 'Working' }: { since: number; label?: string }): JSX.Element {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(timer)
  }, [])
  return (
    <span className="thread-status thread-status--working">
      <span className="thread-status__ring" aria-hidden="true" />
      {label} {since > 0 ? workingFor(now - since) : ''}
    </span>
  )
}

/** Finished while you were elsewhere: until it's opened. */
export function DoneMark({ label = 'Done' }: { label?: string }): JSX.Element {
  return (
    <span className="thread-status thread-status--done">
      <CircleCheck size={12} strokeWidth={2.2} aria-hidden="true" />
      {label}
    </span>
  )
}

/** A section under the list, folding to its heading: Working, Archived. */
export function ThreadSection({
  label,
  count,
  open,
  onToggle,
  id,
  children
}: {
  label: string
  count: number
  open: boolean
  onToggle: () => void
  /** The list's id, for the heading's aria-controls. */
  id: string
  children: ReactNode
}): JSX.Element {
  return (
    <section className="thread-section" data-open={open || undefined}>
      <button type="button" className="thread-section__head" aria-expanded={open} aria-controls={open ? id : undefined} onClick={onToggle}>
        <span className="thread-section__label">{label}</span>
        <span className="thread-section__count">{count}</span>
        <ChevronDown size={13} strokeWidth={2} className="thread-section__chev" />
      </button>
      {open && (
        <div id={id} className="thread-section__list">
          {children}
        </div>
      )}
    </section>
  )
}

/**
 * The search row over the list: a field that filters it as you type
 * (Escape clears it), and the list's tools after it.
 */
export function SidebarFind({
  value,
  onChange,
  label,
  children
}: {
  value: string
  onChange: (value: string) => void
  /** What it searches, for screen readers: "Search sessions". */
  label: string
  children?: ReactNode
}): JSX.Element {
  const input = useRef<HTMLInputElement>(null)
  return (
    <div className="side-find">
      <label className="side-find__field">
        <Search size={14} strokeWidth={1.9} className="side-find__icon" aria-hidden="true" />
        <input
          ref={input}
          className="side-find__input"
          type="text"
          spellCheck={false}
          placeholder="Search"
          aria-label={label}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Escape' && value) {
              e.preventDefault()
              e.stopPropagation()
              onChange('')
            }
          }}
        />
        {value && (
          <button
            type="button"
            className="side-find__clear"
            aria-label="Clear search"
            title="Clear search"
            onClick={() => {
              onChange('')
              input.current?.focus()
            }}
          >
            <X size={12} strokeWidth={2.2} />
          </button>
        )}
      </label>
      <span className="side-find__tools">{children}</span>
    </div>
  )
}

/** One of the search row's tools. */
export const FindTool = forwardRef<HTMLButtonElement, { label: string; onClick: () => void; open?: boolean; children: ReactNode }>(function FindTool(
  { label, onClick, open, children },
  ref
) {
  return (
    <button ref={ref} type="button" className="side-find__tool" aria-label={label} title={label} data-open={open || undefined} onClick={onClick}>
      {children}
    </button>
  )
})
