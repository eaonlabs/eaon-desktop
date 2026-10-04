import { BusNode, listPeers, readEngineLock } from '../bus/bus'
import { agentLabel, claudeSessions, codexSessions, connect, connectionStatus, disconnect, type AgentCli, type ExternalSession } from '../bus/external'
import { ago, kindLabel } from '../bus/format'

/**
 * `eaon peers`, `eaon send` and `eaon connect`/`disconnect`:
 * the bus from a plain shell, for scripts and for checking what is
 * connected. Plain text; bold and dim only when printing to a terminal.
 */

const tty = process.stdout.isTTY === true
const bold = (text: string): string => (tty ? `\x1b[1m${text}\x1b[22m` : text)
const dim = (text: string): string => (tty ? `\x1b[2m${text}\x1b[22m` : text)

function pad(text: string, width: number): string {
  return text.length >= width ? `${text.slice(0, width - 1)}…` : text.padEnd(width)
}

function externalLines(label: string, sessions: ExternalSession[]): string[] {
  if (sessions.length === 0) return [dim(`  No ${label} sessions in this folder.`)]
  return sessions.map((s) => `  ${pad(s.id.slice(0, 8), 10)}${pad(ago(s.updatedAt), 10)}${s.title || dim('(no title)')}`)
}

export async function runPeersCommand(_args: string[]): Promise<number> {
  const peers = listPeers()
  const lock = readEngineLock()
  console.log(bold('Sessions on this computer'))
  if (peers.length === 0) {
    console.log(dim('  None running.'))
  } else {
    console.log(dim(`  ${pad('NAME', 26)}${pad('KIND', 13)}${pad('MODE', 10)}${pad('UP', 10)}FOLDER`))
    for (const peer of peers) {
      const owner = lock?.peerId === peer.id ? ' *' : ''
      console.log(`  ${pad(peer.name + owner, 26)}${pad(kindLabel(peer.kind), 13)}${pad(peer.mode ?? '', 10)}${pad(ago(peer.startedAt), 10)}${peer.cwd}`)
    }
    if (lock) console.log(dim("  * runs Eaon's engines (trading, workers)"))
  }

  const status = await connectionStatus()
  console.log('')
  console.log(bold('Claude Code and Codex'))
  for (const target of ['claude', 'codex'] as AgentCli[]) {
    const state = status[target]
    const line = !state.installed
      ? dim('not installed')
      : state.connected
        ? 'connected (its sessions have the eaon tools)'
        : `not connected — run ${bold(`eaon connect ${target}`)}`
    console.log(`  ${pad(agentLabel(target), 13)}${line}`)
  }

  const cwd = process.cwd()
  console.log('')
  console.log(bold('Recent Claude Code sessions here'))
  for (const line of externalLines('Claude Code', claudeSessions(cwd, 3))) console.log(line)
  console.log(bold('Recent Codex sessions here'))
  for (const line of externalLines('Codex', codexSessions(cwd, 3))) console.log(line)
  return 0
}

/** `eaon send <to> <message…> [--wait <seconds>]` */
export async function runSendCommand(args: string[]): Promise<number> {
  const rest: string[] = []
  let wait = 0
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]
    if (arg === '--wait' || arg === '-w') wait = Math.max(0, Math.min(600, Number(args[++i]) || 0))
    else if (arg.startsWith('--wait=')) wait = Math.max(0, Math.min(600, Number(arg.slice(7)) || 0))
    else rest.push(arg)
  }
  const [to, ...words] = rest
  const text = words.join(' ').trim()
  if (!to || !text) {
    console.error('Usage: eaon send <session> <message…> [--wait <seconds>]')
    return 2
  }
  const bus = await new BusNode({ kind: 'eaon', name: 'eaon-shell', mode: 'cmd' }).open()
  try {
    if (wait) console.log(dim(`Waiting up to ${wait}s for a reply…`))
    const result = await bus.send(to, text, wait ? { waitMs: wait * 1000 } : {})
    if (!result.delivered) {
      console.error(`Not delivered. ${result.error ?? ''}`.trim())
      return 1
    }
    console.log(`Delivered to ${result.to?.name ?? to}.`)
    if (result.reply) {
      console.log('')
      console.log(bold(`${result.reply.from.name}:`))
      console.log(result.reply.text)
    } else if (wait) {
      console.log(dim('No reply in time.'))
    }
    return 0
  } finally {
    await bus.close()
  }
}

function target(args: string[]): AgentCli | null {
  const name = (args[0] ?? '').toLowerCase()
  if (name === 'claude' || name === 'claude-code') return 'claude'
  if (name === 'codex') return 'codex'
  return null
}

/** `eaon connect <claude|codex>`; with `disconnect`, the reverse. */
export async function runConnectCommand(args: string[], remove = false): Promise<number> {
  const which = target(args)
  if (!which) {
    console.error(`Usage: eaon ${remove ? 'disconnect' : 'connect'} <claude|codex>`)
    return 2
  }
  const result = remove ? await disconnect(which) : await connect(which)
  ;(result.ok ? console.log : console.error)(result.message)
  return result.ok ? 0 : 1
}
