import type { BusNode, PeerInfo, PeerKind, PeerMessage, SendResult } from './bus'

/**
 * How sessions and messages read to a model, shared by the MCP bridge
 * (`mcpServer.ts`) and the Eaon agent's own peer tools (`peerTools.ts`), so
 * Claude Code and Eaon describe the bus the same way.
 */

const KIND_LABEL: Record<PeerKind, string> = {
  eaon: 'Eaon CLI',
  'claude-code': 'Claude Code',
  codex: 'Codex',
  other: 'other'
}

export function kindLabel(kind: PeerKind): string {
  return KIND_LABEL[kind] ?? kind
}

/** "3m ago", "just now", "2h ago". */
export function ago(at: number, now = Date.now()): string {
  const seconds = Math.max(0, Math.round((now - at) / 1000))
  if (seconds < 45) return 'just now'
  const minutes = Math.round(seconds / 60)
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.round(minutes / 60)
  if (hours < 48) return `${hours}h ago`
  return `${Math.round(hours / 24)}d ago`
}

export function describePeer(peer: PeerInfo): string {
  const parts = [`${peer.name} (${kindLabel(peer.kind)})`, `folder ${peer.cwd}`]
  if (peer.mode) parts.push(`mode ${peer.mode}`)
  if (peer.owner) parts.push("runs Eaon's engines (trading, workers)")
  parts.push(`up since ${ago(peer.startedAt)}`)
  return `- ${parts.join(', ')}`
}

/** The live sessions other than this one, as a short list for a model. */
export function describeSessions(bus: BusNode, options: { hintExternal?: boolean } = {}): string {
  const peers = bus.peers()
  const lines = [`This session: ${bus.self.name} (${kindLabel(bus.self.kind)}).`]
  if (peers.length === 0) lines.push('No other sessions are running.')
  else lines.push('Other sessions:', ...peers.map(describePeer))
  if (options.hintExternal && !peers.some((p) => p.kind === 'claude-code' || p.kind === 'codex')) {
    lines.push('No Claude Code or Codex session is connected. Claude Code or Codex can join with `eaon connect claude` / `eaon connect codex`.')
  }
  return lines.join('\n')
}

export function describeMessage(message: PeerMessage, now = Date.now()): string {
  const head = `[${message.id}] from ${message.from.name} (${kindLabel(message.from.kind)}), ${ago(message.at, now)}${message.expectReply ? ', waiting for a reply' : ''}${message.replyTo ? `, replying to ${message.replyTo}` : ''}:`
  return `${head}\n${message.text}`
}

export function describeSend(result: SendResult, waitedSeconds: number): string {
  if (!result.delivered) return `Not delivered. ${result.error ?? ''}`.trim()
  const to = result.to ? result.to.name : 'the session'
  if (result.reply) return `Delivered to ${to}. Reply from ${result.reply.from.name}:\n${result.reply.text}`
  if (waitedSeconds > 0) return `Delivered to ${to}. No reply within ${waitedSeconds}s; it may answer later.`
  return `Delivered to ${to}.`
}

/** Clamps a model-supplied number of seconds. */
export function seconds(value: unknown, fallback: number, max: number): number {
  const n = typeof value === 'number' ? value : typeof value === 'string' && value.trim() ? Number(value) : NaN
  if (!Number.isFinite(n)) return fallback
  return Math.min(max, Math.max(0, Math.round(n)))
}
