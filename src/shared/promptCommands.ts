import { parseFrontMatter } from './projectRules'

/**
 * Commands from prompt files: a Markdown file in the project (or in Eaon's own
 * commands folder) becomes a "/" command in Chat's message box. The file's
 * text is the prompt; `$ARGUMENTS` (and `$1`, `$2`…) stand for what is typed
 * after the name. Main finds the files (main/features/chatContext/commands.ts);
 * what a name means and how a prompt is filled in lives here, so it can be
 * tested on its own.
 */

/** Where a project keeps them, relative to its folder; the first folder to name a command wins. */
export const PROJECT_COMMAND_FOLDERS = ['.eaon/commands', '.claude/commands', '.cursor/commands']

/** Names the box already uses for something else. */
export const RESERVED_COMMANDS = ['btw']

export type CommandSource = 'project' | 'mine' | 'builtin'

export interface PromptCommand {
  /** What is typed after the "/": "review", or "frontend:test" for frontend/test.md. */
  name: string
  description: string
  /** What goes after the name ("<file>"), from the file's `argument-hint`; empty when it gave none. */
  argumentHint: string
  /** The prompt, with `$ARGUMENTS` and friends still in it. */
  prompt: string
  source: CommandSource
  /** The file it came from; empty for a built-in command. */
  path: string
}

/** Built in, and offered only in a project: write the project's AGENTS.md. */
export const INIT_COMMAND: PromptCommand = {
  name: 'init',
  description: 'Write an AGENTS.md for this project',
  argumentHint: '',
  prompt:
    'Look through this project and write an AGENTS.md at its top level for coding agents. Cover how to build, test and run it, how the main folders are laid out, and the conventions you can see in the code (naming, formatting, patterns). Keep it short and concrete, and put in only what you checked in the files. If an AGENTS.md already exists, improve it instead of replacing it.',
  source: 'builtin',
  path: ''
}

const SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]*$/

/** The command name for a file's path inside its commands folder ("a/b.md" → "a:b"); null when it isn't a usable name. */
export function commandName(rel: string): string | null {
  const parts = rel.split(/[\\/]/).filter(Boolean)
  if (parts.length === 0 || parts.length > 3) return null
  const last = parts[parts.length - 1]
  if (!/\.md$/i.test(last)) return null
  parts[parts.length - 1] = last.replace(/\.md$/i, '')
  if (!parts.every((p) => SEGMENT.test(p))) return null
  const name = parts.join(':')
  return name.length <= 60 && !RESERVED_COMMANDS.includes(name.toLowerCase()) ? name : null
}

const clip = (text: string, max: number): string => (text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text)

/** A command from a file's text; null when the name isn't usable or the file holds no prompt. */
export function parseCommandFile(rel: string, text: string, source: CommandSource, path: string): PromptCommand | null {
  const name = commandName(rel)
  if (!name) return null
  const { data, body } = parseFrontMatter(text)
  const prompt = body.trim()
  if (!prompt) return null
  const firstLine = prompt
    .split(/\r?\n/)
    .map((l) => l.replace(/^#+\s*/, '').trim())
    .find(Boolean)
  return {
    name,
    description: clip(data.description || firstLine || '', 100),
    argumentHint: clip(data['argument-hint'] ?? data.argument_hint ?? '', 40),
    prompt,
    source,
    path
  }
}

/** Words as a shell would split them: runs of spaces separate them, and quotes group ("two words"). */
export function splitArguments(args: string): string[] {
  const out: string[] = []
  const re = /"([^"]*)"|'([^']*)'|(\S+)/g
  for (let m = re.exec(args); m; m = re.exec(args)) out.push(m[1] ?? m[2] ?? m[3])
  return out
}

/**
 * The prompt with what was typed after the command's name put in: all of it
 * for `$ARGUMENTS`, word by word for `$1`…`$9` (a word that wasn't typed is
 * empty). A prompt that names no argument has them added after it, so what
 * was typed isn't lost.
 */
export function expandPrompt(template: string, args: string): string {
  const typed = args.trim()
  const words = splitArguments(typed)
  const uses = /\$ARGUMENTS|\$[1-9]/.test(template)
  // A word that wasn't typed takes the space before it along, so "Review $ARGUMENTS for bugs" doesn't read "Review  for bugs".
  const filled = template.replace(/( ?)(?:\$ARGUMENTS|\$([1-9]))/g, (_all, space: string, n: string | undefined) => {
    const value = n ? (words[Number(n) - 1] ?? '') : typed
    return value ? `${space}${value}` : ''
  })
  const body = filled.replace(/[ \t]+$/gm, '').trim()
  return !uses && typed ? `${body}\n\n${typed}` : body
}

/** The command a message begins with ("/review src/app.ts"), if it is one of `commands`, and what follows its name. */
export function matchCommand(text: string, commands: readonly PromptCommand[]): { command: PromptCommand; args: string } | null {
  const m = /^\/([^\s/]+)(?:\s+([\s\S]*))?$/.exec(text.trimStart())
  if (!m) return null
  const wanted = m[1].toLowerCase()
  const command = commands.find((c) => c.name.toLowerCase() === wanted)
  return command ? { command, args: m[2] ?? '' } : null
}

/** What to send for a message: the command's prompt, filled in, when it begins with one; otherwise the message itself. */
export function expandCommandMessage(text: string, commands: readonly PromptCommand[]): string {
  const hit = matchCommand(text, commands)
  return hit ? expandPrompt(hit.command.prompt, hit.args) : text
}

/**
 * The commands the "/" menu lists: the project's (the folders in
 * `PROJECT_COMMAND_FOLDERS` order, the first to name a command winning), then
 * the user's own that the project hasn't named; each group by name.
 */
export function mergeCommands(projectFolders: PromptCommand[][], mine: PromptCommand[]): PromptCommand[] {
  const seen = new Set<string>()
  const pick = (list: PromptCommand[]): PromptCommand[] => {
    const out: PromptCommand[] = []
    for (const command of list) {
      const key = command.name.toLowerCase()
      if (seen.has(key)) continue
      seen.add(key)
      out.push(command)
    }
    return out.sort((a, b) => a.name.localeCompare(b.name))
  }
  const project = pick(projectFolders.flat())
  return [...project, ...pick(mine)]
}
