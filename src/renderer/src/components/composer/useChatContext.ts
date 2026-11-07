import { create } from 'zustand'
import { chatTranscript, terminalAttachment, type GitMention, type GitRefs } from '@shared/chatContext'
import { useApp } from '../../state/store'
import { useChatCode } from '../chatCode/chatCodeStore'
import { terminals } from '../code/terminal/registry'
import { errorText } from '../../lib/errors'
import { notify } from '../Notice'
import type { SuggestItem } from './SuggestMenu'
import { chatMentionItems, gitMentionItems, terminalMentionItems, type TerminalRow } from './contextSources'

/**
 * What the message box pulls in from around the chat: the "@" menu's git,
 * terminal and earlier-conversation rows (contextSources.tsx), and what
 * picking one does, which is to read it and attach it to the message as a
 * small text file. Kept out of Composer, which is long enough.
 */

/** The commits and branches for the "@" menu, read when it first asks and again after a short while. */
const REFS_FRESH_MS = 15_000

interface RefsState {
  folder: string | null
  refs: GitRefs | null
  load: (folder: string) => void
}

let refsAt = 0
let refsLoading = false

const useGitRefs = create<RefsState>((set, get) => ({
  folder: null,
  refs: null,
  load: (folder) => {
    if (get().folder !== folder) {
      refsAt = 0
      set({ folder, refs: null })
    }
    if (refsLoading || Date.now() - refsAt < REFS_FRESH_MS) return
    refsLoading = true
    refsAt = Date.now()
    window.api.chatContext
      .refs(folder)
      .then((refs) => get().folder === folder && set({ refs }))
      .catch(() => get().folder === folder && set({ refs: null }))
      .finally(() => (refsLoading = false))
  }
}))

/** What an attach job produced: the saved file, a note worth telling the user, or why it failed. */
type Attached = { path: string; note?: string } | { error: string }

export function useChatContext({ cwd, addAttachments }: { cwd: string | null; addAttachments: (paths: string[]) => void }): {
  /** The "@" rows for git, terminals and earlier chats, for what has been typed after the "@". */
  mentionItems: (query: string) => SuggestItem[]
} {
  // Subscribed so the menu fills in when git answers; both change rarely.
  const refs = useGitRefs((s) => s.refs)
  const refsFolder = useGitRefs((s) => s.folder)
  const changedFiles = useChatCode((s) => s.status?.changes?.files ?? null)

  const attach = async (job: () => Promise<Attached>): Promise<void> => {
    try {
      const done = await job()
      if ('error' in done) {
        notify(done.error, 'error')
        return
      }
      addAttachments([done.path])
      if (done.note) notify(done.note)
    } catch (error) {
      notify(`Couldn’t attach that: ${errorText(error)}`, 'error')
    }
  }

  const pickGit = (mention: GitMention): void => {
    if (!cwd) return
    void attach(async () => {
      const made = await window.api.chatContext.git(cwd, mention)
      return made.ok ? { path: made.path, note: made.note } : { error: made.error }
    })
  }

  const pickTerminal = (row: TerminalRow): void =>
    void attach(async () => {
      const made = terminalAttachment(row.title, terminals.screenText(row.id, 2000), cwd ?? '')
      if (!made) return { error: 'That terminal has no output yet.' }
      return { path: await window.api.chatContext.save(made.label, made.text) }
    })

  const pickChat = (chatId: string): void =>
    void attach(async () => {
      const chat = useApp.getState().chats.find((c) => c.id === chatId)
      if (!chat) return { error: 'That conversation isn’t there any more.' }
      const made = chatTranscript(chat)
      const path = await window.api.chatContext.save(`Chat ${chat.title}`, made.text)
      return { path, ...(made.cut ? { note: 'That conversation is long, so the middle is left out. The start and the latest messages are attached.' } : {}) }
    })

  const mentionItems = (query: string): SuggestItem[] => {
    const now = Date.now()
    const items: SuggestItem[] = []
    if (cwd) {
      useGitRefs.getState().load(cwd)
      items.push(...gitMentionItems({ refs: refsFolder === cwd ? refs : null, changedFiles, query, now, onPick: pickGit }))
      // Panes are read when the menu is built: xterm keeps the text, so this is a few lines of each, not a copy of the screen.
      const rows: TerminalRow[] = useChatCode
        .getState()
        .tabs.filter((t) => t.cwd === cwd)
        .map((t) => ({ id: t.id, title: t.title, command: t.command, hasOutput: terminals.screenText(t.id, 40).trim().length > 0 }))
      items.push(...terminalMentionItems(rows, pickTerminal))
    }
    items.push(...chatMentionItems(useApp.getState().chats, useApp.getState().activeChatId, query, now, (chat) => pickChat(chat.id)))
    return items
  }

  return { mentionItems }
}
