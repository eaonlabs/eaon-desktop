import { useDeferredValue, useMemo, useState } from 'react'
import { Archive, ArchiveRestore, ExternalLink, Trash2 } from 'lucide-react'
import { useShallow } from 'zustand/react/shallow'
import { archivable, archivedOf, chatCount, replying, searchChats } from '@shared/chatArchive'
import { isAgentKind, revealChat, useApp } from '../../../state/store'
import { notify } from '../../Notice'
import { Card, ConfirmDialog, Row, SearchField, Section } from '../../ui'
import './archived.css'

export function ArchivedPage(): JSX.Element {
  const { chats, runs, workspaces, restoreChat, deleteChat, archiveChats, deleteChats } = useApp(
    useShallow((s) => ({ chats: s.chats, runs: s.runs, workspaces: s.workspaces, restoreChat: s.restoreChat, deleteChat: s.deleteChat, archiveChats: s.archiveChats, deleteChats: s.deleteChats }))
  )
  const archived = useMemo(() => archivedOf(chats), [chats])
  const [query, setQuery] = useState('')
  // Typing stays quick while a long history is searched behind it.
  const asked = useDeferredValue(query)
  const hits = useMemo(() => searchChats(archived, asked), [archived, asked])
  // "Archive all" takes what the sidebar lists, not a chat whose reply is still being written.
  const chatSpaces = useMemo(() => new Set(workspaces.filter((w) => isAgentKind(w.kind)).map((w) => w.id)), [workspaces])
  const toArchive = useMemo(() => archivable(chats, chatSpaces, runs), [chats, chatSpaces, runs])
  const busy = useMemo(() => replying(chats, chatSpaces, runs).length, [chats, chatSpaces, runs])
  // Deleting is permanent, so it asks first, as it does in the sidebar.
  const [deleting, setDeleting] = useState<{ id: string; title: string } | null>(null)
  const [archivingAll, setArchivingAll] = useState(false)
  const [deletingAll, setDeletingAll] = useState(false)

  return (
    <>
      <h1 className="settings__h1">Archived chats</h1>
      <p className="settings__lede">Archived chats are hidden from the sidebar but keep their full history. Open one to read it, or restore it to the sidebar.</p>

      <Section label="Everything at once">
        <Card>
          <Row
            title="Archive all chats"
            description={
              toArchive.length === 0
                ? busy > 0
                  ? `Nothing to archive yet: ${chatCount(busy)} still replying.`
                  : 'No chats in the sidebar.'
                : `Moves ${chatCount(toArchive.length)} from the sidebar to this list.${busy > 0 ? ` ${chatCount(busy)} still replying stays.` : ''}`
            }
          >
            <button type="button" className="btn" disabled={toArchive.length === 0} onClick={() => setArchivingAll(true)}>
              <Archive size={14} strokeWidth={1.9} />
              Archive all
            </button>
          </Row>
          <Row
            title="Delete all archived chats"
            description={archived.length === 0 ? 'No archived chats.' : `Permanently removes the ${chatCount(archived.length)} in this list from this computer.`}
          >
            <button type="button" className="btn btn--danger" disabled={archived.length === 0} onClick={() => setDeletingAll(true)}>
              <Trash2 size={14} strokeWidth={1.9} />
              Delete all
            </button>
          </Row>
        </Card>
      </Section>

      <Section label={archived.length === 0 ? 'Archived' : `Archived (${archived.length})`}>
        {archived.length === 0 ? (
          <Card>
            <Row title="No archived chats" description="Chats you archive will show up here" />
          </Card>
        ) : (
          <>
            <div className="archived__search">
              <SearchField value={query} onChange={setQuery} placeholder="Search archived chats" />
            </div>
            <Card>
              {hits.length === 0 && <Row title="No archived chat matches that" description="Search covers each chat's title and what was said in it." />}
              {hits.map(({ chat, snippet }) => (
                <Row
                  key={chat.id}
                  title={chat.title}
                  description={
                    <>
                      {`${chat.messages.length} message${chat.messages.length === 1 ? '' : 's'} · ${new Date(chat.updatedAt).toLocaleDateString()}`}
                      {snippet && <span className="archived__snippet">{snippet}</span>}
                    </>
                  }
                >
                  <button
                    type="button"
                    className="btn"
                    title="Read this chat. It stays archived until you restore it."
                    onClick={() => {
                      revealChat(chat.id)
                    }}
                  >
                    <ExternalLink size={14} strokeWidth={1.9} />
                    Open
                  </button>
                  <button type="button" className="btn" onClick={() => restoreChat(chat.id)}>
                    <ArchiveRestore size={14} strokeWidth={1.9} />
                    Restore
                  </button>
                  <button type="button" className="icon-btn" aria-label="Delete chat" onClick={() => setDeleting({ id: chat.id, title: chat.title })}>
                    <Trash2 size={15} strokeWidth={1.9} />
                  </button>
                </Row>
              ))}
            </Card>
          </>
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
      <ConfirmDialog
        open={archivingAll}
        onClose={() => setArchivingAll(false)}
        title={`Archive ${chatCount(toArchive.length)}?`}
        confirmLabel={`Archive ${toArchive.length === 1 ? 'chat' : 'all'}`}
        danger={false}
        onConfirm={() => {
          const moved = archiveChats(toArchive.map((c) => c.id))
          notify(`Archived ${chatCount(moved)}`)
        }}
      >
        {toArchive.length === 1 ? 'It leaves' : 'They leave'} the sidebar and {toArchive.length === 1 ? 'keeps its' : 'keep their'} full history. You can restore {toArchive.length === 1 ? 'it' : 'them'} from this page.
        {busy > 0 ? ` ${chatCount(busy)} still replying ${busy === 1 ? 'stays' : 'stay'} where ${busy === 1 ? 'it is' : 'they are'}.` : ''}
      </ConfirmDialog>
      <ConfirmDialog
        open={deletingAll}
        onClose={() => setDeletingAll(false)}
        title={archived.length === 1 ? 'Delete the archived chat?' : `Delete all ${archived.length} archived chats?`}
        confirmLabel={archived.length === 1 ? 'Delete' : 'Delete all'}
        onConfirm={() => {
          const gone = deleteChats(archived.map((c) => c.id))
          notify(`Deleted ${chatCount(gone)}`)
        }}
      >
        {archived.length === 1 ? 'It and its messages are' : `They and their messages are`} removed from this computer. This can’t be undone. Chats in the sidebar aren’t touched.
      </ConfirmDialog>
    </>
  )
}
