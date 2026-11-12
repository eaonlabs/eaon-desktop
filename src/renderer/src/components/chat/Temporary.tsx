import { MessageSquareDashed } from 'lucide-react'
import { useApp } from '../../state/store'
import './temporary.css'

/**
 * Temporary chats (Chat.temporary): the start page's switch, the line under
 * its title, and the note at the top of the conversation. What they say is
 * what the code does: the chat is kept in this window only, and is dropped
 * when the window leaves it. Files the assistant makes are the user's files,
 * and an agent engine keeps its own record of a session, so the note says so.
 */

const FILES = 'Files it creates stay on your computer.'
const ENGINE = 'Agent engines such as Codex keep their own history of a session.'

/** The start page's switch: the next chat started from it is temporary. */
export function TemporaryToggle(): JSX.Element {
  const on = useApp((s) => s.pendingTemporary)
  const setPendingTemporary = useApp((s) => s.setPendingTemporary)
  return (
    <button
      type="button"
      className="header-btn"
      data-active={on || undefined}
      aria-pressed={on}
      title={`A chat that isn’t saved and is gone when you leave it. ${FILES}`}
      onClick={() => setPendingTemporary(!on)}
    >
      <MessageSquareDashed size={14} strokeWidth={1.9} />
      Temporary chat
    </button>
  )
}

/** Under the start page's title while the switch is on. */
export function TemporaryHint(): JSX.Element | null {
  const on = useApp((s) => s.pendingTemporary)
  return on ? <p className="temp-hint">Temporary chat. It won’t be saved, and it’s gone when you leave it. It can’t be in a project.</p> : null
}

/** The label by a temporary conversation's title. */
export function TemporaryPill(): JSX.Element {
  return (
    <span className="chat-header__temp" title="This chat isn’t saved. It’s gone when you leave it.">
      <MessageSquareDashed size={12} strokeWidth={1.9} />
      Temporary
    </span>
  )
}

/** The top of a temporary conversation. */
export function TemporaryNote(): JSX.Element {
  const engine = useApp((s) => Boolean(s.settings?.selectedEngine))
  return (
    <div className="thread-note" role="note">
      <MessageSquareDashed size={14} strokeWidth={1.9} />
      <span>
        Temporary chat. It isn’t saved, and it’s gone when you leave it. {FILES}
        {engine ? ` ${ENGINE}` : ''}
      </span>
    </div>
  )
}
