import { FileDiff, FolderOpen, GitBranch, GitCommitHorizontal, MessageSquareText, SquareSlash, TerminalSquare } from 'lucide-react'
import type { Chat } from '@shared/types'
import { MENTION_BRANCHES, TERMINAL_LINES, type GitMention, type GitRefs } from '@shared/chatContext'
import { ago } from '@shared/modelSelection'
import { expandPrompt, type PromptCommand } from '@shared/promptCommands'
import type { SuggestItem } from './SuggestMenu'

/**
 * The "@" menu's rows for what is not a file or a plugin: the project's git
 * changes, branches and commits, its terminals' output, and earlier
 * conversations. Picking one attaches it to the message (useChatContext);
 * the row says what will be read.
 */

const ICON = { size: 16, strokeWidth: 1.8 } as const
/** Commits and chats shown before anything is typed after "@". */
const QUIET_COMMITS = 5
const QUIET_CHATS = 5

/** What the "@" menu offers from git: the uncommitted changes, this branch against the base, recent commits, and other branches once something is typed. */
export function gitMentionItems({
  refs,
  changedFiles,
  query,
  now,
  onPick
}: {
  refs: GitRefs | null
  /** How many files are uncommitted, when known. */
  changedFiles: number | null
  query: string
  now: number
  onPick: (mention: GitMention) => void
}): SuggestItem[] {
  if (!refs?.repo) return []
  const items: SuggestItem[] = []
  if (changedFiles === null || changedFiles > 0) {
    items.push({
      id: 'git:uncommitted',
      title: 'Uncommitted changes',
      keywords: 'git diff changes working tree staged modified',
      section: 'Git',
      description: 'The diff against the last commit, new files included',
      icon: <FileDiff {...ICON} />,
      hint: changedFiles ? `${changedFiles} ${changedFiles === 1 ? 'file' : 'files'}` : undefined,
      run: () => onPick({ kind: 'uncommitted' })
    })
  }
  if (refs.current && refs.base && refs.current !== refs.base) {
    items.push({
      id: 'git:branch',
      title: 'Branch changes',
      keywords: 'git branch diff pull request compared',
      section: 'Git',
      description: `${refs.current} compared with ${refs.base}`,
      icon: <GitBranch {...ICON} />,
      run: () => onPick({ kind: 'branch', name: refs.current! })
    })
  }
  const q = query.trim().toLowerCase()
  // With nothing typed the menu is short, so files still show; typing reaches the rest.
  for (const commit of q ? refs.commits : refs.commits.slice(0, QUIET_COMMITS)) {
    items.push({
      id: `git:commit:${commit.sha}`,
      title: commit.subject.length > 64 ? `${commit.subject.slice(0, 63)}…` : commit.subject || commit.short,
      keywords: `${commit.short} ${commit.author} commit git`,
      section: 'Recent commits',
      description: `${commit.author} · ${ago(commit.at, now)}`,
      icon: <GitCommitHorizontal {...ICON} />,
      hint: commit.short,
      run: () => onPick({ kind: 'commit', sha: commit.sha })
    })
  }
  if (q && refs.base) {
    refs.branches
      .filter((name) => name !== refs.current && name !== refs.base && name.toLowerCase().includes(q))
      .slice(0, MENTION_BRANCHES)
      .forEach((name) =>
        items.push({
          id: `git:branch:${name}`,
          title: name,
          keywords: 'branch git',
          section: 'Branches',
          description: `Compared with ${refs.base}`,
          icon: <GitBranch {...ICON} />,
          run: () => onPick({ kind: 'branch', name })
        })
      )
  }
  return items
}

/** A terminal pane the menu can read: its tab, and whether it has printed anything. */
export interface TerminalRow {
  id: string
  title: string
  command: string | null
  hasOutput: boolean
}

/** One row per terminal in the project that has output: the last lines it printed. */
export function terminalMentionItems(rows: TerminalRow[], onPick: (row: TerminalRow) => void): SuggestItem[] {
  const shown = rows.filter((row) => row.hasOutput)
  return shown.map((row) => ({
    id: `terminal:${row.id}`,
    title: shown.length === 1 ? 'Terminal output' : `Terminal output: ${row.title}`,
    keywords: 'terminal console shell log error build test run command',
    section: 'Terminal',
    description: row.command ? `Running ${row.command}` : `The last ${TERMINAL_LINES} lines`,
    icon: <TerminalSquare {...ICON} />,
    run: () => onPick(row)
  }))
}

/** Most chats the "@" menu offers at once; a longer history is reached by typing part of a title. */
const CHATS_SHOWN = 40

/** Earlier chats, newest first, other than the open one: picking one attaches what was said in it. */
export function chatMentionItems(chats: readonly Chat[], activeId: string | null, query: string, now: number, onPick: (chat: Chat) => void): SuggestItem[] {
  return chats
    .filter((chat) => chat.id !== activeId && !chat.archived && chat.messages.some((m) => m.role !== 'system' && m.parts.length > 0))
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .slice(0, query.trim() ? CHATS_SHOWN : QUIET_CHATS)
    .map((chat) => {
      const turns = chat.messages.filter((m) => m.role === 'user').length
      return {
        id: `chat:${chat.id}`,
        title: chat.title || 'Untitled chat',
        keywords: 'chat conversation earlier past previous',
        section: 'Conversations',
        description: `${ago(chat.updatedAt, now)} · ${turns} ${turns === 1 ? 'message' : 'messages'} from you`,
        icon: <MessageSquareText {...ICON} />,
        hint: chat.summary?.text ? 'Summarized' : undefined,
        run: () => onPick(chat)
      }
    })
}

/**
 * Prompt-file commands as "/" rows. Picking one puts its prompt in the box in
 * place of the typed "/name", for the user to finish and send, as a mod's
 * command does; `$ARGUMENTS` is left out of what is put there, and what is
 * typed after the name is filled in when the message is sent instead
 * (expandCommandMessage). With none yet, a row says where to add one.
 */
export function promptCommandItems(commands: readonly PromptCommand[], query: string, onAdd: () => void): SuggestItem[] {
  const items: SuggestItem[] = commands.map((command) => ({
    id: `prompt:${command.source}:${command.name}`,
    title: command.name,
    keywords: `${command.source === 'project' ? 'project' : ''} prompt command`,
    section: 'Prompt files',
    description: [command.description, command.argumentHint].filter(Boolean).join(' ') || undefined,
    icon: <SquareSlash {...ICON} />,
    hint: command.source === 'project' ? 'Project' : command.source === 'mine' ? 'Yours' : undefined,
    insert: expandPrompt(command.prompt, '')
  }))
  // Shown when there are none to find, and to anyone who types for it.
  if (!commands.some((c) => c.source !== 'builtin') || query.trim()) {
    items.push({
      id: 'prompt:add',
      title: 'Add a command',
      keywords: 'new create custom prompt file folder commands',
      section: 'Prompt files',
      description: 'Opens your commands folder: each .md file in it becomes a / command. A project can keep its own in .eaon/commands',
      icon: <FolderOpen {...ICON} />,
      run: onAdd
    })
  }
  return items
}
