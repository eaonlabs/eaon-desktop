import { Ghost, X } from 'lucide-react'
import { useApp } from '../../state/store'
import { useBindingLabel } from '../../lib/bindings'
import './temporary.css'

/**
 * Temporary chats (Chat.temporary): the start page's switch, what the start
 * page says while it is on, and the note at the top of the conversation.
 * What they say is what the code does: the chat is kept in this window only,
 * and is dropped when the window leaves it. Files the assistant makes are the
 * user's files, and an agent engine keeps its own record of a session, so the
 * note says so.
 */

const FILES = 'Files it creates stay on your computer.'
const ENGINE = 'Agent engines such as Codex keep their own history of a session.'

/**
 * The start page's switch, in the top bar's corner: a ghost to start one, an
 * × to go back to an ordinary chat. While it is on the bar's left says so.
 */
export function TemporaryToggle(): JSX.Element {
  const on = useApp((s) => s.pendingTemporary)
  const setPendingTemporary = useApp((s) => s.setPendingTemporary)
  const key = useBindingLabel('new-temporary-chat')
  const label = on ? 'Leave temporary chat' : 'Temporary chat'
  return (
    <button
      type="button"
      className="icon-btn temp-toggle"
      aria-pressed={on}
      aria-label={label}
      title={on ? label : `Temporary chat${key ? ` (${key})` : ''}: not saved, and gone when you leave it`}
      onClick={() => setPendingTemporary(!on)}
    >
      {on ? <X size={16} strokeWidth={1.9} /> : <Ghost size={16} strokeWidth={1.9} />}
    </button>
  )
}

/** The top bar's left while the switch is on. */
export function TemporaryLabel(): JSX.Element | null {
  const on = useApp((s) => s.pendingTemporary)
  return on ? (
    <span className="temp-label">
      <Ghost size={14} strokeWidth={1.9} />
      Temporary chat
    </span>
  ) : null
}

/** In place of the start page's chips while the switch is on. */
export function TemporaryHint(): JSX.Element {
  return (
    <p className="temp-hint">
      Temporary chats aren’t saved. They stay out of your chat list and search, can’t be in a project, and are gone when you leave them. Files Eaon creates stay on your computer.
    </p>
  )
}

/** The label by a temporary conversation's title. */
export function TemporaryPill(): JSX.Element {
  return (
    <span className="chat-header__temp" title="This chat isn’t saved. It’s gone when you leave it.">
      <Ghost size={12} strokeWidth={1.9} />
      Temporary
    </span>
  )
}

/** The top of a temporary conversation. */
export function TemporaryNote(): JSX.Element {
  const engine = useApp((s) => Boolean(s.settings?.selectedEngine))
  return (
    <div className="thread-note" role="note">
      <Ghost size={14} strokeWidth={1.9} />
      <span>
        Temporary chat. It isn’t saved, and it’s gone when you leave it. {FILES}
        {engine ? ` ${ENGINE}` : ''}
      </span>
    </div>
  )
}
