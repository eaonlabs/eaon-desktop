import { useEffect } from 'react'
import { create } from 'zustand'
import { chatTranscript, terminalAttachment, type GitMention, type GitRefs } from '@shared/chatContext'
import { expandCommandMessage, INIT_COMMAND, type PromptCommand } from '@shared/promptCommands'
import { useApp } from '../../state/store'
import { useChatCode } from '../chatCode/chatCodeStore'
import { terminals } from '../code/terminal/registry'
import { errorText } from '../../lib/errors'
import { notify } from '../Notice'
import type { SuggestItem } from './SuggestMenu'
import { chatMentionItems, gitMentionItems, promptCommandItems, terminalMentionItems, type TerminalRow } from './contextSources'

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
/** The folder last asked for: if it moved while git answered, the answer is asked for again. */
let refsWanted: string | null = null

const useGitRefs = create<RefsState>((set, get) => ({
  folder: null,
  refs: null,
  // Never sets while it is called: it is called as the menu is built, and a store set then would update the box in the middle of drawing it.
  load: (folder) => {
    refsWanted = folder
    if (refsLoading || (get().folder === folder && Date.now() - refsAt < REFS_FRESH_MS)) return
    refsLoading = true
    refsAt = Date.now()
    window.api.chatContext
      .refs(folder)
      .then((refs) => set({ folder, refs }))
      .catch(() => set({ folder, refs: null }))
      .finally(() => {
        refsLoading = false
        if (refsWanted !== null && refsWanted !== folder) get().load(refsWanted)
      })
  }
}))

/** Prompt files are read again after this long, so a file added meanwhile shows. */
const COMMANDS_FRESH_MS = 10_000

interface CommandsState {
  /** The project folder the list is for; null is no project (the user's own commands only). */
  folder: string | null | undefined
  list: PromptCommand[]
  load: (folder: string | null) => void
}

let commandsAt = 0
let commandsLoading = false
let commandsWanted: string | null = null

const useCommands = create<CommandsState>((set, get) => ({
  folder: undefined,
  list: [],
  // As the refs store: set only once the answer is in, never while the menu is being built.
  load: (folder) => {
    commandsWanted = folder
    if (commandsLoading || (get().folder === folder && Date.now() - commandsAt < COMMANDS_FRESH_MS)) return
    commandsLoading = true
    commandsAt = Date.now()
    window.api.chatContext
      .commands(folder)
      .then((list) => set({ folder, list }))
      .catch(() => set({ folder, list: [] }))
      .finally(() => {
        commandsLoading = false
        if (commandsWanted !== folder) get().load(commandsWanted)
      })
  }
}))

/** The commands the box knows: the files', and /init in a project unless a file already names it. */
const withBuiltins = (list: PromptCommand[], project: boolean): PromptCommand[] =>
  project && !list.some((c) => c.name.toLowerCase() === INIT_COMMAND.name) ? [...list, INIT_COMMAND] : list

/** What an attach job produced: the saved file, a note worth telling the user, or why it failed. */
type Attached = { path: string; note?: string } | { error: string }

export function useChatContext({ cwd, addAttachments }: { cwd: string | null; addAttachments: (paths: string[]) => void }): {
  /** The "@" rows for git, terminals and earlier chats, for what has been typed after the "@". */
  mentionItems: (query: string) => SuggestItem[]
  /** The "/" rows for prompt files (and /init in a project), for what has been typed after the "/". */
  commandItems: (query: string) => SuggestItem[]
  /** The message to send: a prompt-file command's prompt filled in when the text begins with one, else the text. */
  expand: (text: string) => string
} {
  // Subscribed so the menu fills in when git answers; both change rarely.
  const refs = useGitRefs((s) => s.refs)
  const refsFolder = useGitRefs((s) => s.folder)
  const changedFiles = useChatCode((s) => s.status?.changes?.files ?? null)
  const commands = useCommands((s) => s.list)
  const commandsFolder = useCommands((s) => s.folder)
  // Read when the box appears and when the project changes, so "/name args" works before the menu is ever opened.
  useEffect(() => useCommands.getState().load(cwd), [cwd])
  const known = withBuiltins(commandsFolder === cwd ? commands : [], Boolean(cwd))

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

  const commandItems = (query: string): SuggestItem[] => {
    useCommands.getState().load(cwd)
    return promptCommandItems(known, query, () => void window.api.chatContext.openCommandsFolder().catch((error: unknown) => notify(`Couldn’t open the folder: ${errorText(error)}`, 'error')))
  }

  return { mentionItems, commandItems, expand: (text) => expandCommandMessage(text, known) }
}
