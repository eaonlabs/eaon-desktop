import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import type { TerminalAgentId } from '@shared/terminals'

const exec = promisify(execFile)

/**
 * What the ADE knows about each CLI agent's conversations: where it files
 * them, how a running one names its own, and the command that reopens one.
 *
 * Every agent keeps its conversations on disk under its own config folder, in
 * its own shape, and every one of them can be told to reopen a particular
 * conversation — but each spells it differently. Measured against the real
 * CLIs (Claude Code 2.1, Codex 0.159, Gemini CLI 0.62, OpenCode 1.16, Eaon
 * Code 1.0), not guessed from their docs:
 *
 *   claude     ~/.claude/projects/<slug>/<id>.jsonl      claude --resume <id>
 *              and sessions/<pid>.json, which names the conversation a
 *              running process holds — exact, and the only agent that says.
 *   codex      ~/.codex/sessions/Y/M/D/rollout-…-<id>.jsonl  codex resume <id>
 *   gemini     ~/.gemini/tmp/<project>/chats/session-….jsonl gemini --resume <id>
 *              (<project> from ~/.gemini/projects.json; a sha256 of the path
 *              in older versions)
 *   opencode   a SQLite database, table `session`        opencode --session <id>
 *   eaon-code  ~/.eaon/agent/sessions/--<path>--/<ts>_<id>.jsonl
 *                                                        eaon-code --session <id>
 */

export type AgentId = Exclude<TerminalAgentId, 'shell'>

export interface Conversation {
  id: string
  /** When it was first written. */
  born: number
  /** When it was last written. */
  touched: number
  /** The file holding it, for agents that keep one per conversation. */
  file?: string
}

export interface AgentKind {
  id: AgentId
  /** Names its process can carry in the process table. */
  bins: string[]
  /** The conversation a running process says it holds. Only Claude Code says. */
  own?: (pid: number, cwd: string) => { sessionId: string; cwd: string } | null
  /** A conversation named on its command line (`--resume <id>` and kin). */
  named: (args: string) => string | null
  /** Conversations filed for a folder. */
  conversations: (cwd: string) => Promise<Map<string, Conversation>>
  /** Whether a conversation holds anything to reopen. */
  resumable: (cwd: string, id: string) => Promise<boolean>
  /** The line that reopens a conversation, given how the agent is launched. */
  resume: (command: string, id: string) => string
  /** The line that carries on the folder's latest conversation. */
  continueLatest: (command: string) => string
}

/* ------------------------------------------------------------------ roots */

/**
 * Where the agents keep their state is read from the environment each time,
 * as the agents themselves do. Tests point it at a scratch home.
 */
let homeOverride: string | null = null
let envOverride: NodeJS.ProcessEnv | null = null

export function setAgentHome(home: string | null, env: NodeJS.ProcessEnv | null = null): void {
  homeOverride = home
  envOverride = env
}

const home = (): string => homeOverride ?? os.homedir()
const env = (): NodeJS.ProcessEnv => envOverride ?? process.env

export const claudeDir = (): string => env().CLAUDE_CONFIG_DIR || path.join(home(), '.claude')
const codexDir = (): string => env().CODEX_HOME || path.join(home(), '.codex')
const geminiDir = (): string => path.join(env().GEMINI_CLI_HOME || home(), '.gemini')
const opencodeDb = (): string => path.join(env().XDG_DATA_HOME || path.join(home(), '.local', 'share'), 'opencode', 'opencode.db')

function eaonAgentDir(): string {
  const set = env().EAON_CODE_CODING_AGENT_DIR || env().PI_CODING_AGENT_DIR
  if (set) return set.replace(/^~(?=$|[/\\])/, home())
  const own = path.join(home(), '.eaon', 'agent')
  const legacy = path.join(home(), '.pi', 'agent')
  return !fs.existsSync(own) && fs.existsSync(legacy) ? legacy : own
}

/* ------------------------------------------------------------------ helpers */

const UUID = '[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}'
const UUID_RE = new RegExp(`^${UUID}$`)

/** Reads the first `bytes` of a file; '' when it cannot be read. */
function head(file: string, bytes = 256 * 1024): string {
  let fd: number
  try {
    fd = fs.openSync(file, 'r')
  } catch {
    return ''
  }
  try {
    const buf = Buffer.allocUnsafe(bytes)
    const read = fs.readSync(fd, buf, 0, bytes, 0)
    return buf.toString('utf8', 0, read)
  } catch {
    return ''
  } finally {
    fs.closeSync(fd)
  }
}

/** Every file in a folder whose name passes `keep`, with its birth and last write. */
async function filesIn(dir: string, keep: (name: string) => string | null): Promise<Map<string, Conversation>> {
  const out = new Map<string, Conversation>()
  let names: string[]
  try {
    names = await fs.promises.readdir(dir)
  } catch {
    return out
  }
  for (const name of names) {
    const id = keep(name)
    if (!id) continue
    const file = path.join(dir, name)
    try {
      const st = await fs.promises.stat(file)
      // Birth time where the filesystem keeps one; ctime stands in elsewhere.
      out.set(id, { id, born: st.birthtimeMs || st.ctimeMs, touched: st.mtimeMs, file })
    } catch {
      /* gone between listing and asking */
    }
  }
  return out
}

const named = (re: RegExp) => (args: string): string | null => re.exec(args)?.[1] ?? null

/* ------------------------------------------------------------------ claude */

/** The folder name Claude Code files a working directory's transcripts under: every non-alphanumeric becomes '-'. */
export function claudeSlug(cwd: string): string {
  return cwd.replace(/[^a-zA-Z0-9]/g, '-')
}

/** A line that means somebody spoke, as opposed to session bookkeeping. */
const CLAUDE_TURN_RE = /"type"\s*:\s*"(?:user|assistant)"/

const claude: AgentKind = {
  id: 'claude',
  bins: ['claude'],
  /*
   * Claude Code writes sessions/<pid>.json naming the conversation that
   * process is holding, for the whole life of the process — so a conversation
   * that was already running before anyone watched is still identified, and a
   * `/resume` or `/clear` inside it is followed. The folder is checked against
   * the process's own, because a pid is reused eventually and a file left
   * behind by a dead agent would otherwise hand a pane somebody else's work.
   */
  own(pid, cwd) {
    let row: { sessionId?: unknown; cwd?: unknown; pid?: unknown }
    try {
      row = JSON.parse(fs.readFileSync(path.join(claudeDir(), 'sessions', `${pid}.json`), 'utf8'))
    } catch {
      return null
    }
    if (typeof row?.sessionId !== 'string' || !UUID_RE.test(row.sessionId)) return null
    if (typeof row.pid === 'number' && row.pid !== pid) return null
    const recorded = typeof row.cwd === 'string' ? row.cwd : ''
    if (cwd && recorded && recorded !== cwd) return null
    return { sessionId: row.sessionId, cwd: recorded || cwd }
  },
  named: named(new RegExp(`(?:--resume|-r|--session-id)(?:\\s+|=)(${UUID})`)),
  conversations: (cwd) =>
    cwd ? filesIn(path.join(claudeDir(), 'projects', claudeSlug(cwd)), (n) => (n.endsWith('.jsonl') ? n.slice(0, -6) : null)) : Promise.resolve(new Map()),
  /*
   * An agent started and closed without a word leaves a transcript with no
   * turns in it (or none at all), and `claude --resume` answers both with "No
   * conversation found". Coming back to that error is worse than a fresh
   * Claude, so a turn somebody actually took is what is looked for.
   */
  async resumable(cwd, id) {
    if (!cwd || !UUID_RE.test(id)) return false
    return CLAUDE_TURN_RE.test(head(path.join(claudeDir(), 'projects', claudeSlug(cwd), `${id}.jsonl`)))
  },
  resume: (command, id) => `${command} --resume ${id}`,
  continueLatest: (command) => `${command} --continue`
}

/* ------------------------------------------------------------------ codex */

/** Day folders a conversation started in the last few days could be filed under, in local time and UTC. */
function recentDays(now = Date.now()): string[] {
  const out = new Set<string>()
  for (let back = 0; back < 3; back++) {
    const d = new Date(now - back * 86_400_000)
    const pad = (n: number): string => String(n).padStart(2, '0')
    out.add(path.join(String(d.getFullYear()), pad(d.getMonth() + 1), pad(d.getDate())))
    out.add(path.join(String(d.getUTCFullYear()), pad(d.getUTCMonth() + 1), pad(d.getUTCDate())))
  }
  return [...out]
}

const CODEX_FILE_RE = new RegExp(`^rollout-.*-(${UUID})\\.jsonl$`)
const CWD_RE = /"cwd"\s*:\s*"((?:[^"\\]|\\.)*)"/

function unescapeJson(text: string): string {
  try {
    return JSON.parse(`"${text}"`) as string
  } catch {
    return text
  }
}

/**
 * The folder a rollout was recorded in. It never changes once written, and
 * this is asked every few seconds while a Codex pane is watched, so each
 * file's first line is read once.
 */
const codexFolders = new Map<string, string>()
function codexFolderOf(file: string): string {
  const known = codexFolders.get(file)
  if (known !== undefined) return known
  const found = CWD_RE.exec(head(file, 16 * 1024))?.[1]
  const folder = found === undefined ? '' : unescapeJson(found)
  // A file caught before its first line landed is asked again next time.
  if (folder) {
    if (codexFolders.size > 2000) codexFolders.clear()
    codexFolders.set(file, folder)
  }
  return folder
}

const codex: AgentKind = {
  id: 'codex',
  bins: ['codex'],
  named: named(new RegExp(`\\bresume\\s+(${UUID})`)),
  /*
   * Filed by date, not by folder: the folder is in each rollout's first line
   * (its session_meta). Only the last few days are read — this is asked to
   * spot a conversation starting, and to reopen one that was running when the
   * app quit, not to list history.
   */
  async conversations(cwd) {
    const out = new Map<string, Conversation>()
    if (!cwd) return out
    for (const day of recentDays()) {
      const files = await filesIn(path.join(codexDir(), 'sessions', day), (n) => CODEX_FILE_RE.exec(n)?.[1] ?? null)
      for (const conv of files.values()) {
        if (codexFolderOf(conv.file!) === cwd) out.set(conv.id, conv)
      }
    }
    return out
  },
  resumable: async (cwd, id) => (await codex.conversations(cwd)).has(id),
  resume: (command, id) => `${command} resume ${id}`,
  continueLatest: (command) => `${command} resume --last`
}

/* ------------------------------------------------------------------ gemini */

/** The chats folders Gemini CLI could be keeping a folder's conversations in. */
function geminiChatDirs(cwd: string): string[] {
  const dirs: string[] = []
  const resolved = path.resolve(cwd)
  const key = process.platform === 'win32' ? resolved.toLowerCase() : resolved
  try {
    const registry = JSON.parse(fs.readFileSync(path.join(geminiDir(), 'projects.json'), 'utf8')) as { projects?: Record<string, string> }
    const short = registry.projects?.[key]
    if (short && /^[a-z0-9-]+$/.test(short)) dirs.push(path.join(geminiDir(), 'tmp', short, 'chats'))
  } catch {
    /* no registry yet */
  }
  // Before the registry, the folder was a sha256 of the path.
  dirs.push(path.join(geminiDir(), 'tmp', createHash('sha256').update(resolved).digest('hex'), 'chats'))
  return dirs
}

const GEMINI_ID_RE = /"sessionId"\s*:\s*"([^"]+)"/
const GEMINI_TURN_RE = /"type"\s*:\s*"user"/

const gemini: AgentKind = {
  id: 'gemini',
  bins: ['gemini'],
  named: named(new RegExp(`(?:--resume|-r|--session-id)(?:\\s+|=)(${UUID})`)),
  async conversations(cwd) {
    const out = new Map<string, Conversation>()
    if (!cwd) return out
    for (const dir of geminiChatDirs(cwd)) {
      // The file name carries only the id's first eight characters; the full
      // one is in its first record.
      const files = await filesIn(dir, (n) => (n.startsWith('session-') && /\.jsonl?$/.test(n) ? n : null))
      for (const conv of files.values()) {
        const id = GEMINI_ID_RE.exec(head(conv.file!, 8 * 1024))?.[1]
        if (id) out.set(id, { ...conv, id })
      }
    }
    return out
  },
  // Gemini writes the file the moment it starts, before anybody has typed.
  async resumable(cwd, id) {
    const conv = (await gemini.conversations(cwd)).get(id)
    return Boolean(conv?.file && GEMINI_TURN_RE.test(head(conv.file)))
  },
  resume: (command, id) => `${command} --resume ${id}`,
  continueLatest: (command) => `${command} --resume latest`
}

/* ------------------------------------------------------------------ opencode */

/** A string as a SQL literal. */
const sqlText = (value: string): string => `'${value.replace(/'/g, "''")}'`

const opencode: AgentKind = {
  id: 'opencode',
  bins: ['opencode'],
  named: named(/(?:^|\s)(?:-s|--session)(?:\s+|=)(ses_[A-Za-z0-9]+)/),
  /*
   * OpenCode keeps its sessions in SQLite. Asked through the sqlite3 command
   * (on every Mac, and most Linux machines) rather than a native module, read
   * only — the database is OpenCode's, and it is open in OpenCode while this
   * runs. Sub-agent sessions (with a parent) are not conversations anybody
   * reopens.
   */
  async conversations(cwd) {
    const out = new Map<string, Conversation>()
    const db = opencodeDb()
    if (!cwd || !fs.existsSync(db)) return out
    const sql =
      `select id, time_created, time_updated from session where directory = ${sqlText(cwd)} ` +
      'and parent_id is null and time_archived is null order by time_updated desc limit 200'
    try {
      const { stdout } = await exec('sqlite3', ['-readonly', '-separator', '\t', db, sql], { timeout: 4000 })
      for (const line of stdout.split('\n')) {
        const [id, born, touched] = line.trim().split('\t')
        if (id?.startsWith('ses_')) out.set(id, { id, born: Number(born) || 0, touched: Number(touched) || 0 })
      }
    } catch {
      /* no sqlite3, or the database is mid-migration: nothing learnt this pass */
    }
    return out
  },
  resumable: async (cwd, id) => /^ses_[A-Za-z0-9]+$/.test(id) && (await opencode.conversations(cwd)).has(id),
  resume: (command, id) => `${command} --session ${id}`,
  continueLatest: (command) => `${command} --continue`
}

/* ------------------------------------------------------------------ eaon code */

/** The folder Eaon Code files a working directory's sessions under. */
export function eaonSessionDir(cwd: string): string {
  return path.join(eaonAgentDir(), 'sessions', `--${cwd.replace(/^[/\\]/, '').replace(/[/\\:]/g, '-')}--`)
}

const EAON_FILE_RE = new RegExp(`^[^_]+_(${UUID})\\.jsonl$`)

const eaonCode: AgentKind = {
  id: 'eaon-code',
  bins: ['eaon-code'],
  named: named(new RegExp(`--session(?:-id)?(?:\\s+|=)(${UUID})`)),
  // Written once the first reply lands, so a file here always holds a turn.
  conversations: (cwd) => (cwd ? filesIn(eaonSessionDir(cwd), (n) => EAON_FILE_RE.exec(n)?.[1] ?? null) : Promise.resolve(new Map())),
  resumable: async (cwd, id) => (await eaonCode.conversations(cwd)).has(id),
  resume: (command, id) => `${command} --session ${id}`,
  continueLatest: (command) => `${command} --continue`
}

/* ------------------------------------------------------------------ lookup */

export const AGENT_KINDS: Record<AgentId, AgentKind> = {
  claude,
  codex,
  gemini,
  opencode,
  'eaon-code': eaonCode
}

/** Extra names an agent's process can carry — Eaon Code run from a pinned binary, say. */
const extraBins = new Map<string, AgentId>()

export function setExtraAgentBin(bin: string | null, id: AgentId): void {
  for (const [name, owner] of extraBins) if (owner === id) extraBins.delete(name)
  if (bin) extraBins.set(binName(bin), id)
}

/** A program's name as `ps` shows it, without the folder or a script/exe suffix. */
function binName(word: string): string {
  // Either separator: a Windows path's backslashes are not path.basename's on a Mac.
  return (word.split(/[\\/]/).pop() ?? '').replace(/\.(?:js|mjs|cjs|exe|cmd)$/i, '')
}

const BY_BIN = new Map<string, AgentId>(
  Object.values(AGENT_KINDS).flatMap((kind) => kind.bins.map((bin) => [bin, kind.id] as [string, AgentId]))
)

/** Runtimes that run an agent as a script, where the agent's name is the script's. */
const RUNTIMES = new Set(['node', 'bun', 'deno', 'python', 'python3'])

/**
 * Which agent a command line is, if any. Read off the words rather than
 * searched for anywhere in the line, so a process that merely has "claude" in
 * a path it was given is not mistaken for the agent.
 */
export function agentOfArgs(args: string): AgentId | null {
  const words = args.trim().split(/\s+/)
  const first = binName(words[0] ?? '')
  const direct = BY_BIN.get(first) ?? extraBins.get(first)
  if (direct) return direct
  if (!RUNTIMES.has(first)) return null
  // `node --max-old-space-size=… /path/to/gemini`: the script is the first non-flag word.
  const script = words.slice(1).find((w) => !w.startsWith('-'))
  if (!script) return null
  const name = binName(script)
  return BY_BIN.get(name) ?? extraBins.get(name) ?? null
}
