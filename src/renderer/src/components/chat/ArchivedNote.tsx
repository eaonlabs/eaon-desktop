import { Archive } from 'lucide-react'
import { useApp } from '../../state/store'
import './temporary.css'

/** The top of an archived chat opened from Settings → Archived chats: it isn't in the sidebar until it is restored. */
export function ArchivedNote({ chatId }: { chatId: string }): JSX.Element {
  const restoreChat = useApp((s) => s.restoreChat)
  return (
    <div className="thread-note" role="note">
      <Archive size={14} strokeWidth={1.9} />
      <span>
        This chat is archived, so it isn’t in the sidebar.{' '}
        <button type="button" className="link-btn" onClick={() => restoreChat(chatId)}>
          Restore it
        </button>
      </span>
    </div>
  )
}
