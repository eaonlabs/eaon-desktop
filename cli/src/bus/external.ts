import { execFile, spawn } from 'node:child_process'
import { closeSync, copyFileSync, existsSync, openSync, readdirSync, readFileSync, readSync, readlinkSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, join, resolve } from 'node:path'
import { onPath } from '@main/shellEnv'
import type { PeerKind } from './bus'

/**
 * Claude Code and Codex on this machine: which sessions they have, which are
 * running, and whether they have Eaon's MCP bridge (`eaon mcp`) installed.
 *
 * All of this only *looks* at their files and processes, or registers the
 * bridge with their own `mcp add` commands when the user asks. Nothing here
 * starts them headless or feeds them prompts: when the user wants a Claude
 * Code or Codex session, `openInTerminal` opens the real, interactive CLI in
 * a terminal window of its own, and the two talk over the bus from there.
 */

export type AgentCli = 'claude' | 'codex'

export interface ExternalSession {
  id: string
  cwd: string | null
  updatedAt: number
  /** The first thing the user asked, trimmed; empty when it couldn't be read. */
  title: string
  file: string
}

export interface RunningAgent {
  pid: number
  kind: Extract<PeerKind, 'claude-code' | 'codex'>
  cwd: string | null
}

const LABEL: Record<AgentCli, string> = { claude: 'Claude Code', codex: 'Codex' }
const BRIDGE_NAME = 'eaon'

/* ---------------------------------------------------------------- reading */

/** The first `bytes` of a file: transcripts can be huge, and only their start is needed. */
function readHead(file: string, bytes: number): string {
  const fd = openSync(file, 'r')
  try {
    const buffer = Buffer.alloc(bytes)
    const read = readSync(fd, buffer, 0, bytes, 0)
    return buffer.subarray(0, read).toString('utf8')
  } finally {
    closeSync(fd)
  }
}

/** The first JSON string value for `key` in some text, even inside a cut-off line. */
function stringField(text: string, key: string, from = 0): string | null {
  const match = new RegExp(`"${key}":"((?:[^"\\\\]|\\\\.)*)"`).exec(text.slice(from))
  if (!match) return null
  try {
    return JSON.parse(`"${match[1]}"`) as string
  } catch {
    return null
  }
}

function clipTitle(text: string): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length > 80 ? `${flat.slice(0, 79)}…` : flat
}

/** Prompts the CLI writes itself (slash commands, caveats, environment blocks) aren't what the user asked. */
const isBoilerplate = (text: string): boolean => /^\s*(<|Caveat:|# AGENTS\.md)/.test(text)

/* ------------------------------------------------------------ Claude Code */

/** Claude Code's folder name for a project: the path with everything but letters and digits as `-`. */
export function claudeProjectSlug(path: string): string {
  return resolve(path).replace(/[^a-zA-Z0-9]/g, '-')
}

/** The first real user message in the start of a Claude Code transcript. */
function claudeTitle(head: string): string {
  for (const line of head.split('\n')) {
    if (!line.includes('"type":"user"')) continue
    try {
      const entry = JSON.parse(line) as { isMeta?: boolean; message?: { content?: unknown } }
      if (entry.isMeta) continue
      const content = entry.message?.content
      const text =
        typeof content === 'string'
          ? content
          : Array.isArray(content)
            ? ((content as { type?: string; text?: string }[]).find((part) => part.type === 'text' && typeof part.text === 'string')?.text ?? '')
            : ''
      if (text && !isBoilerplate(text)) return clipTitle(text)
    } catch {
      // A first message with images can run past the bytes read: take its text out of the cut-off line.
      if (line.includes('"isMeta":true')) continue
      const at = line.indexOf('"content"')
      const text = at === -1 ? null : (stringField(line, 'text', at) ?? stringField(line, 'content', at))
      if (text && !isBoilerplate(text)) return clipTitle(text)
    }
  }
  return ''
}

/** Recent Claude Code sessions, newest first: for one folder, or for every project. */
export function claudeSessions(cwd?: string, limit = 10, home = homedir()): ExternalSession[] {
  const root = join(home, '.claude', 'projects')
  if (!existsSync(root)) return []
  const dirs = cwd ? [join(root, claudeProjectSlug(cwd))] : readdirSync(root).map((name) => join(root, name))
  const files: { file: string; mtime: number }[] = []
  for (const dir of dirs) {
    if (!existsSync(dir)) continue
    try {
      for (const name of readdirSync(dir)) {
        if (!name.endsWith('.jsonl')) continue
        const file = join(dir, name)
        files.push({ file, mtime: statSync(file).mtimeMs })
      }
    } catch {
      /* not a folder */
    }
  }
  return files
    .sort((a, b) => b.mtime - a.mtime)
    .slice(0, limit)
    .map(({ file, mtime }) => {
      let head = ''
      try {
        head = readHead(file, 64 * 1024)
      } catch {
        /* unreadable: list it without a title */
      }
      return { id: basename(file, '.jsonl'), cwd: stringField(head, 'cwd') ?? (cwd ? resolve(cwd) : null), updatedAt: mtime, title: claudeTitle(head), file }
    })
}

/* ------------------------------------------------------------------ Codex */

function walkRollouts(dir: string, out: { file: string; mtime: number }[]): void {
  let names: string[]
  try {
    names = readdirSync(dir)
  } catch {
    return
  }
  for (const name of names) {
    const path = join(dir, name)
    if (name.startsWith('rollout-') && name.endsWith('.jsonl')) {
      try {
        out.push({ file: path, mtime: statSync(path).mtimeMs })
      } catch {
        /* gone */
      }
    } else if (!name.includes('.')) {
      walkRollouts(path, out)
    }
  }
}

/** Recent Codex sessions, newest first, from `~/.codex/sessions`; only those started in `cwd` when given. */
export function codexSessions(cwd?: string, limit = 10, home = homedir()): ExternalSession[] {
  const root = join(home, '.codex', 'sessions')
  if (!existsSync(root)) return []
  const files: { file: string; mtime: number }[] = []
  walkRollouts(root, files)
  files.sort((a, b) => b.mtime - a.mtime)
  const wanted = cwd ? resolve(cwd) : null
  const out: ExternalSession[] = []
  // Each head is read only until enough match; a long history isn't read whole.
  for (const { file, mtime } of files.slice(0, 200)) {
    if (out.length >= limit) break
    let head = ''
    try {
      // The first line carries Codex's whole system prompt, so the user's first message sits further in.
      head = readHead(file, 256 * 1024)
    } catch {
      continue
    }
    const sessionCwd = stringField(head, 'cwd')
    if (wanted && sessionCwd !== wanted) continue
    const at = head.indexOf('"type":"user_message"')
    const title = at === -1 ? '' : (stringField(head, 'message', at) ?? '')
    const id = stringField(head, 'session_id') ?? stringField(head, 'id') ?? /([0-9a-f-]{36})\.jsonl$/.exec(file)?.[1] ?? basename(file, '.jsonl')
    out.push({ id, cwd: sessionCwd, updatedAt: mtime, title: isBoilerplate(title) ? '' : clipTitle(title), file })
  }
  return out
}

/* --------------------------------------------------------------- processes */

/** Which agent CLI a command line belongs to; null when it's neither (a shell, node, npx). */
export function classifyCommand(command: string): Extract<PeerKind, 'claude-code' | 'codex'> | null {
  const tokens = command.trim().split(/\s+/).slice(0, 4)
  for (const token of tokens) {
    const name = basename(token).toLowerCase().replace(/\.(m?js|cjs|exe|cmd)$/, '')
    if (name === 'claude' || name === 'claude-code' || token.includes('@anthropic-ai/claude-code')) return 'claude-code'
    if (name === 'codex' || token.includes('@openai/codex')) return 'codex'
  }
  return null
}

function output(command: string, args: string[], timeout = 3000): Promise<{ ok: boolean; stdout: string; stderr: string }> {
  return new Promise((resolveRun) => {
    execFile(command, args, { timeout, windowsHide: true, maxBuffer: 4 * 1024 * 1024 }, (error, stdout, stderr) =>
      resolveRun({ ok: !error, stdout: String(stdout ?? ''), stderr: String(stderr ?? '') })
    )
  })
}

async function cwdOf(pid: number): Promise<string | null> {
  if (process.platform === 'linux') {
    try {
      return readlinkSync(`/proc/${pid}/cwd`)
    } catch {
      return null
    }
  }
  const { stdout } = await output('lsof', ['-a', '-d', 'cwd', '-p', String(pid), '-Fn'])
  const line = stdout.split('\n').find((l) => l.startsWith('n'))
  return line ? line.slice(1) : null
}

/** Claude Code and Codex processes running now, with the folder each was started in. Best effort; none on Windows. */
export async function runningAgents(): Promise<RunningAgent[]> {
  if (process.platform === 'win32') return []
  const { stdout } = await output('ps', process.platform === 'darwin' ? ['-axo', 'pid=,args='] : ['-eo', 'pid=,args='])
  const found: { pid: number; kind: RunningAgent['kind'] }[] = []
  for (const line of stdout.split('\n')) {
    const match = /^\s*(\d+)\s+(.*)$/.exec(line)
    if (!match) continue
    const pid = Number(match[1])
    if (pid === process.pid) continue
    const kind = classifyCommand(match[2])
    if (kind) found.push({ pid, kind })
  }
  return Promise.all(found.map(async (agent) => ({ ...agent, cwd: await cwdOf(agent.pid) })))
}

/* ------------------------------------------------------- the MCP bridge */

/** How a host starts the bridge: this Node running this CLI's script with `mcp`. */
export function mcpCommand(): string[] {
  return [process.execPath, resolve(process.argv[1] ?? 'eaon'), 'mcp']
}

const claudeConfigFile = (home = homedir()): string => join(home, '.claude.json')
const codexConfigFile = (home = homedir()): string => join(home, '.codex', 'config.toml')

function claudeHasBridge(home = homedir()): boolean {
  try {
    const config = JSON.parse(readFileSync(claudeConfigFile(home), 'utf8')) as { mcpServers?: Record<string, unknown> }
    return Boolean(config.mcpServers && BRIDGE_NAME in config.mcpServers)
  } catch {
    return false
  }
}

const TABLE = /^\s*\[\s*mcp_servers\s*\.\s*("eaon"|eaon)\s*\]\s*$/
const SUBTABLE = /^\s*\[\s*mcp_servers\s*\.\s*("eaon"|eaon)\s*\./

export function codexTomlHasBridge(text: string): boolean {
  return text.split('\n').some((line) => TABLE.test(line))
}

/** The config without the bridge's table (and its sub-tables such as `.env`). */
export function codexTomlWithoutBridge(text: string): string {
  const lines = text.split('\n')
  const kept: string[] = []
  let skipping = false
  for (const line of lines) {
    if (TABLE.test(line) || SUBTABLE.test(line)) {
      skipping = true
      continue
    }
    if (skipping && /^\s*\[/.test(line)) skipping = false
    if (!skipping) kept.push(line)
  }
  return kept.join('\n').replace(/\n{3,}/g, '\n\n')
}

/** The config with exactly one bridge table, pointing at `command`. TOML basic strings take JSON's escapes. */
export function codexTomlWithBridge(text: string, command: string[]): string {
  const [program, ...args] = command
  const base = codexTomlWithoutBridge(text).replace(/\s*$/, '')
  const table = `[mcp_servers.${BRIDGE_NAME}]\ncommand = ${JSON.stringify(program)}\nargs = [${args.map((a) => JSON.stringify(a)).join(', ')}]\n`
  return base ? `${base}\n\n${table}` : table
}

export interface ConnectionStatus {
  claude: { installed: boolean; connected: boolean }
  codex: { installed: boolean; connected: boolean }
}

export async function connectionStatus(home = homedir()): Promise<ConnectionStatus> {
  let codexConnected = false
  try {
    codexConnected = codexTomlHasBridge(readFileSync(codexConfigFile(home), 'utf8'))
  } catch {
    /* no config */
  }
  return {
    claude: { installed: onPath('claude') !== null, connected: claudeHasBridge(home) },
    codex: { installed: onPath('codex') !== null, connected: codexConnected }
  }
}

function describeFailure(result: { stdout: string; stderr: string }): string {
  return (result.stderr || result.stdout).trim().split('\n').slice(-3).join(' ') || 'it exited with an error'
}

/**
 * Registers the bridge with Claude Code or Codex for every folder (user
 * scope), through their own commands. Codex versions without `codex mcp add`
 * get a table appended to `~/.codex/config.toml`, after a backup.
 */
export async function connect(target: AgentCli, command = mcpCommand()): Promise<{ ok: boolean; message: string }> {
  const bin = onPath(target)
  if (target === 'claude') {
    if (!bin) return { ok: false, message: 'Claude Code isn’t installed (no `claude` on PATH).' }
    // Re-adding replaces an entry left by an older install of this CLI.
    if (claudeHasBridge()) await output(bin, ['mcp', 'remove', '--scope', 'user', BRIDGE_NAME], 15_000)
    const added = await output(bin, ['mcp', 'add', '--scope', 'user', BRIDGE_NAME, '--', ...command], 15_000)
    return added.ok
      ? { ok: true, message: 'Claude Code can now reach Eaon: every new Claude Code session has the eaon tools (eaon_sessions, eaon_send, eaon_inbox…).' }
      : { ok: false, message: `\`claude mcp add\` failed: ${describeFailure(added)}` }
  }
  if (bin) {
    const help = await output(bin, ['mcp', 'add', '--help'], 10_000)
    if (help.ok) {
      await output(bin, ['mcp', 'remove', BRIDGE_NAME], 10_000)
      const added = await output(bin, ['mcp', 'add', BRIDGE_NAME, '--', ...command], 15_000)
      if (added.ok) return { ok: true, message: 'Codex can now reach Eaon: new Codex sessions have the eaon tools.' }
      return { ok: false, message: `\`codex mcp add\` failed: ${describeFailure(added)}` }
    }
  }
  const file = codexConfigFile()
  if (!bin && !existsSync(file)) return { ok: false, message: 'Codex isn’t installed (no `codex` on PATH and no ~/.codex/config.toml).' }
  try {
    const before = existsSync(file) ? readFileSync(file, 'utf8') : ''
    if (before) copyFileSync(file, `${file}.bak-eaon`)
    writeFileSync(file, codexTomlWithBridge(before, command))
    return { ok: true, message: `Added Eaon to ${file}${before ? ' (the old file is saved as config.toml.bak-eaon)' : ''}. New Codex sessions have the eaon tools.` }
  } catch (error) {
    return { ok: false, message: `Couldn’t update ${file}: ${error instanceof Error ? error.message : String(error)}` }
  }
}

export async function disconnect(target: AgentCli): Promise<{ ok: boolean; message: string }> {
  const bin = onPath(target)
  if (target === 'claude') {
    if (!claudeHasBridge()) return { ok: true, message: 'Claude Code wasn’t connected.' }
    if (!bin) return { ok: false, message: 'Claude Code isn’t on PATH, so its settings can’t be changed from here.' }
    const removed = await output(bin, ['mcp', 'remove', '--scope', 'user', BRIDGE_NAME], 15_000)
    return removed.ok ? { ok: true, message: 'Removed Eaon from Claude Code.' } : { ok: false, message: `\`claude mcp remove\` failed: ${describeFailure(removed)}` }
  }
  if (bin) {
    const removed = await output(bin, ['mcp', 'remove', BRIDGE_NAME], 10_000)
    if (removed.ok) return { ok: true, message: 'Removed Eaon from Codex.' }
  }
  const file = codexConfigFile()
  try {
    const before = readFileSync(file, 'utf8')
    if (!codexTomlHasBridge(before)) return { ok: true, message: 'Codex wasn’t connected.' }
    copyFileSync(file, `${file}.bak-eaon`)
    writeFileSync(file, codexTomlWithoutBridge(before))
    return { ok: true, message: `Removed Eaon from ${file}.` }
  } catch {
    return { ok: true, message: 'Codex wasn’t connected.' }
  }
}

/* ----------------------------------------------------- opening a window */

/** AppleScript string literal. */
const appleString = (text: string): string => `"${text.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`

/**
 * Starts the real Claude Code or Codex, interactively, in a new terminal
 * window in `cwd`. The user drives it; with the bridge connected it can
 * message this session over the bus.
 */
export async function openInTerminal(target: AgentCli, cwd: string): Promise<{ ok: boolean; message: string }> {
  if (!onPath(target)) return { ok: false, message: `${LABEL[target]} isn’t installed (no \`${target}\` on PATH).` }
  const folder = resolve(cwd)
  try {
    if (process.platform === 'darwin') {
      const script = `tell application "Terminal"\nactivate\ndo script "cd " & quoted form of ${appleString(folder)} & " && ${target}"\nend tell`
      const result = await output('osascript', ['-e', script], 10_000)
      if (!result.ok) return { ok: false, message: `Terminal didn’t open: ${describeFailure(result)}` }
    } else if (process.platform === 'win32') {
      // cmd's own quoting: `start ""` takes the empty window title literally.
      const child = spawn('cmd.exe', ['/c', `start "" cmd /k ${target}`], { cwd: folder, detached: true, stdio: 'ignore', windowsVerbatimArguments: true })
      child.on('error', () => {})
      child.unref()
    } else {
      const child = spawn('x-terminal-emulator', ['-e', target], { cwd: folder, detached: true, stdio: 'ignore' })
      const failed = await new Promise<boolean>((resolveSpawn) => {
        child.once('error', () => resolveSpawn(true))
        child.once('spawn', () => resolveSpawn(false))
      })
      if (failed) return { ok: false, message: 'No terminal emulator found (x-terminal-emulator). Start it yourself in that folder.' }
      child.unref()
    }
    return { ok: true, message: `Opened ${LABEL[target]} in a new terminal window in ${folder}.` }
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : String(error) }
  }
}

export function agentLabel(target: AgentCli): string {
  return LABEL[target]
}
