import { useState } from 'react'
import { ArchiveRestore, Trash2 } from 'lucide-react'
import { useShallow } from 'zustand/react/shallow'
import { useApp } from '../../../state/store'
import { Card, ConfirmDialog, Row, Section } from '../../ui'

export function ArchivedPage(): JSX.Element {
  const { chats, restoreChat, deleteChat } = useApp(
    useShallow((s) => ({ chats: s.chats, restoreChat: s.restoreChat, deleteChat: s.deleteChat }))
  )
  const archived = chats.filter((c) => c.archived).sort((a, b) => b.updatedAt - a.updatedAt)
  // Deleting is permanent, so it asks first, as it does in the sidebar.
  const [deleting, setDeleting] = useState<{ id: string; title: string } | null>(null)

  return (
    <>
      <h1 className="settings__h1">Archived chats</h1>
      <p className="settings__lede">Archived chats are hidden from Recents but keep their full history.</p>

      <Section>
        {archived.length === 0 ? (
          <Card>
            <Row title="No archived chats" description="Chats you archive will show up here" />
          </Card>
        ) : (
          <Card>
            {archived.map((chat) => (
              <Row
                key={chat.id}
                title={chat.title}
                description={`${chat.messages.length} message${chat.messages.length === 1 ? '' : 's'} · ${new Date(
                  chat.updatedAt
                ).toLocaleDateString()}`}
              >
                <button className="btn" onClick={() => restoreChat(chat.id)}>
                  <ArchiveRestore size={14} strokeWidth={1.9} />
                  Restore
                </button>
                <button className="icon-btn" aria-label="Delete chat" onClick={() => setDeleting({ id: chat.id, title: chat.title })}>
                  <Trash2 size={15} strokeWidth={1.9} />
                </button>
              </Row>
            ))}
          </Card>
        )}
      </Section>
      <ConfirmDialog
        open={deleting !== null}
        onClose={() => setDeleting(null)}
        title="Delete this chat?"
        confirmLabel="Delete"
        onConfirm={() => deleting && deleteChat(deleting.id)}
      >
        “{deleting?.title}” and its messages are removed from this computer. This can’t be undone.
      </ConfirmDialog>
    </>
  )
}
