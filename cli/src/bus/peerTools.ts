import { registerToolSource, type AgentTool } from '@main/agent/tools'
import type { BusNode } from './bus'
import { describeSend, describeSessions, seconds } from './format'

/**
 * The Eaon agent's side of the bus: tools to see the other sessions on this
 * computer and message them — another Eaon CLI, or a Claude Code or Codex
 * session that loaded `eaon mcp`. Offered to the main agent of a chat
 * turn only: not inside a swarm sub-agent, a worker's turn or a trading
 * session's check, which have no business chatting to other terminals.
 */

const str = (value: unknown): string => (typeof value === 'string' ? value.trim() : '')
const clip = (text: string, max: number): string => (text.length > max ? `${text.slice(0, max - 1)}…` : text)

export function peerTools(bus: BusNode): AgentTool[] {
  const list: AgentTool = {
    name: 'sessions_list',
    description: 'List the other Eaon CLI, Claude Code and Codex sessions running on this computer, which you can message with session_send.',
    inputSchema: { type: 'object', properties: {} },
    mutating: false,
    describe: () => 'List sessions',
    run: async () => describeSessions(bus, { hintExternal: true })
  }

  const send: AgentTool = {
    name: 'session_send',
    description:
      'Send a message to another session on this computer (by name from sessions_list, e.g. "claude-code@api"). Set wait_seconds to wait for its reply; a Claude Code or Codex session only sees the message when its own agent checks its Eaon inbox, so replies can take a while.',
    inputSchema: {
      type: 'object',
      properties: {
        to: { type: 'string', description: 'Session name or id' },
        text: { type: 'string', description: 'The message' },
        wait_seconds: { type: 'number', description: 'How long to wait for a reply, 0–300. Default 0.' }
      },
      required: ['to', 'text']
    },
    mutating: true,
    risky: () => false,
    describe: (input) => `Message ${str(input.to)}: ${clip(str(input.text), 60)}`,
    run: async (input) => {
      const to = str(input.to)
      const text = str(input.text)
      if (!to || !text) throw new Error('Give both `to` and `text`.')
      const wait = seconds(input.wait_seconds, 0, 300)
      return describeSend(await bus.send(to, text, wait ? { waitMs: wait * 1000 } : {}), wait)
    }
  }

  return [list, send]
}

export function registerPeerTools(bus: BusNode): void {
  const tools = peerTools(bus)
  registerToolSource({
    id: 'peers',
    tools: (query) => (query.depth === 0 && !query.request.workerId && !query.request.chatId.startsWith('trading:') ? tools : []),
    guidance: () =>
      'Other agent sessions may be running on this computer (more Eaon CLIs, Claude Code, Codex). sessions_list shows them; session_send messages one, and its wait_seconds waits for an answer.'
  })
}
