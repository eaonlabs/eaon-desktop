import type { AgentTool, ToolSource } from '../../agent/tools'
import type { ChannelsService } from './service'

/**
 * `send_chat_message`: a worker posting in a connected chat on its own — a
 * routine's digest to a WhatsApp group, news to the user on Telegram.
 * Answers to chat messages go back without it; this is for everything else.
 * Offered only to a worker's own turn, and only once it has somewhere to post.
 */

const str = (value: unknown): string => (typeof value === 'string' ? value.trim() : '')

export function channelsToolSource(service: ChannelsService): ToolSource {
  const tool: AgentTool = {
    name: 'send_chat_message',
    description:
      'Post in one of your connected chats (Discord, Telegram, WhatsApp), optionally with files from your folder. Replies to chat messages are posted for you; use this to post on your own, like a routine’s results.',
    inputSchema: {
      type: 'object',
      properties: {
        chat: { type: 'string', description: 'A chat from your list of connected chats (its name or id)' },
        text: { type: 'string' },
        files: { type: 'array', items: { type: 'string' }, description: 'Paths inside your folder' }
      },
      required: ['chat', 'text']
    },
    mutating: false,
    describe: (input) => str(input.chat),
    run: async (input, ctx) => {
      const workerId = ctx.request.workerId
      if (!workerId) throw new Error('Only a worker can use this tool.')
      const files = Array.isArray(input.files) ? input.files.filter((f): f is string => typeof f === 'string' && f.length > 0) : []
      return service.post(workerId, str(input.chat), str(input.text), files)
    }
  }

  return {
    id: 'channels',
    tools: (query) => {
      const id = query.request.workerId
      return query.mode === 'work' && query.depth === 0 && id && service.destinations(id).length > 0 ? [tool] : []
    },
    // In the system prompt, so it only changes when a chat is added or removed.
    guidance: (query) => {
      const id = query.request.workerId
      if (query.mode !== 'work' || query.depth > 0 || !id) return null
      const chats = service.destinations(id)
      if (chats.length === 0) return null
      return ['Your connected chats (send_chat_message):', ...chats.map((c) => `- ${c.label} (id: ${c.id})`)].join('\n')
    }
  }
}
