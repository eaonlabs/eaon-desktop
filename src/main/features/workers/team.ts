import { describeWorker, WORKER_TEMPLATES } from '@shared/workers'
import type { AgentTool, ToolSource } from '../../agent/tools'
import type { TeamDraft, WorkersEngine } from './engine'

/**
 * `team`: the chat agent's way into Workers. It can spin up a team of
 * specialists that work side by side in a group chat, post to a group chat
 * or message a worker on the user's behalf, and read what the team said —
 * so "get a researcher, a writer and a bug reproducer on this" works from
 * Chat. Never offered to workers themselves (they have their own tools),
 * sub-agents or trading sessions.
 */

const str = (value: unknown): string => (typeof value === 'string' ? value.trim() : '')
const action = (input: Record<string, unknown>): string => str(input.action).toLowerCase()

function rolesFrom(raw: unknown): TeamDraft['roles'] {
  if (!Array.isArray(raw)) return []
  return raw.flatMap((entry) => {
    if (typeof entry === 'string') {
      // A template id or role ("researcher"), or a role of its own: "Role: what it does".
      const [head, ...rest] = entry.split(':')
      const key = head.trim().toLowerCase()
      const template = WORKER_TEMPLATES.find((t) => t.id === key || t.role.toLowerCase() === key)
      const purpose = rest.join(':').trim()
      if (!head.trim()) return []
      return template && !purpose
        ? [{ role: template.role, purpose: template.purpose, personality: template.personality, color: template.color }]
        : [{ role: head.trim(), purpose: purpose || template?.purpose || '', personality: template?.personality ?? '', color: template?.color }]
    }
    if (!entry || typeof entry !== 'object') return []
    const v = entry as Record<string, unknown>
    const template = WORKER_TEMPLATES.find((t) => t.id === str(v.template) || t.role.toLowerCase() === str(v.role).toLowerCase())
    const role = str(v.role) || template?.role || ''
    if (!role) return []
    return [
      {
        role,
        name: str(v.name) || undefined,
        purpose: str(v.purpose) || template?.purpose || '',
        personality: str(v.personality) || template?.personality || '',
        color: template?.color
      }
    ]
  })
}

export function teamToolSource(engine: WorkersEngine, openRoom?: (roomId: string) => void): ToolSource {
  const roomByName = (name: string): ReturnType<WorkersEngine['rooms']>[number] => {
    const rooms = engine.rooms()
    const room = rooms.find((r) => r.id === name || r.name.toLowerCase() === name.toLowerCase())
    if (!room) throw new Error(`No group chat called "${name}". ${rooms.length ? `There are: ${rooms.map((r) => `"${r.name}"`).join(', ')}.` : 'There are none yet; create_team makes one.'}`)
    return room
  }

  const tool: AgentTool = {
    name: 'team',
    description: [
      "The user's Eaon Workers: long-lived agents that run in parallel and talk to each other.",
      'list: workers and group chats. create_team {name, roles, kickoff}: creates specialist workers plus a group chat with them, and posts kickoff there so they start at once, side by side.',
      `roles: template ids (${WORKER_TEMPLATES.map((t) => t.id).join(', ')}) or "Role: what it does". Add existing workers with members (names).`,
      'post {room, message}: post in a group chat for the user (@Name wakes only that worker). message {to, message}: write to one worker for the user. read {room, count?}: what the group chat said.'
    ].join(' '),
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['list', 'create_team', 'post', 'message', 'read'] },
        name: { type: 'string', description: 'create_team: the team / group chat name' },
        roles: { type: 'array', items: { type: 'string' }, description: 'Each a template id, or "Role: what it does" for another specialist' },
        members: { type: 'array', items: { type: 'string' }, description: 'create_team: existing workers to include, by name' },
        kickoff: { type: 'string', description: 'create_team: the first message to the team — the job' },
        room: { type: 'string' },
        to: { type: 'string' },
        message: { type: 'string' },
        count: { type: 'integer' }
      },
      required: ['action']
    },
    mutating: (input) => ['create_team', 'post', 'message'].includes(action(input)),
    describe: (input) => {
      const a = action(input)
      if (a === 'create_team') return `Create team ${str(input.name)}`
      if (a === 'post') return `Post in ${str(input.room)}`
      if (a === 'message') return `Message ${str(input.to)}`
      return `team ${a}`
    },
    run: async (input) => {
      switch (action(input)) {
        case 'list': {
          const workers = engine.list()
          const rooms = engine.rooms()
          const name = (id: string): string => workers.find((w) => w.id === id)?.name ?? '?'
          return [
            workers.length ? `Workers:\n${workers.map((w) => `- ${w.name}: ${w.purpose || 'no purpose'} — ${describeWorker(w)}`).join('\n')}` : 'No workers yet.',
            rooms.length ? `Group chats:\n${rooms.map((r) => `- "${r.name}": ${r.members.map(name).join(', ')}`).join('\n')}` : 'No group chats yet.'
          ].join('\n')
        }
        case 'create_team': {
          const workers = engine.list()
          const memberIds = (Array.isArray(input.members) ? input.members : [])
            .map((m) => workers.find((w) => w.name.toLowerCase() === str(m).toLowerCase())?.id)
            .filter((id): id is string => !!id)
          const { room, workers: created } = engine.createTeam({ name: str(input.name), roles: rolesFrom(input.roles), memberIds, kickoff: str(input.kickoff) })
          openRoom?.(room.id)
          return [
            `Created the "${room.name}" group chat with ${created.map((w) => w.name).join(', ')}${memberIds.length ? ` and ${memberIds.length} existing worker${memberIds.length === 1 ? '' : 's'}` : ''}.`,
            str(input.kickoff) ? 'The kickoff is posted; they are working on it in parallel. The user can watch in Workers → the group chat.' : 'Nothing posted yet: use post to give them the job.',
            'Use read later to see what they said.'
          ].join(' ')
        }
        case 'post': {
          const room = roomByName(str(input.room))
          engine.postAsUser(room.id, str(input.message))
          return `Posted in "${room.name}" for the user.`
        }
        case 'message': {
          const worker = engine.lookup(str(input.to))
          if (!worker) return { text: `No worker called "${str(input.to)}".`, isError: true }
          engine.send(worker.id, str(input.message))
          return `Sent to ${worker.name} for the user. It works on it in the background.`
        }
        case 'read': {
          const room = roomByName(str(input.room))
          const workers = engine.list()
          const posts = engine.roomPosts(room.id).slice(-Math.max(1, Math.min(Number(input.count) || 20, 60)))
          const working = room.members.map((id) => workers.find((w) => w.id === id)).filter((w) => w?.status === 'working').map((w) => w!.name)
          return [
            `"${room.name}"${working.length ? ` — working now: ${working.join(', ')}` : ''}`,
            ...(posts.length ? posts.map((p) => `${p.from === 'user' ? 'User' : p.fromName}: ${p.text.length > 1500 ? `${p.text.slice(0, 1499)}…` : p.text}`) : ['(no posts yet)'])
          ].join('\n')
        }
        default:
          return { text: 'action is list, create_team, post, message or read.', isError: true }
      }
    }
  }

  return {
    id: 'team',
    tools: (query) => (query.mode === 'work' && query.depth === 0 && !query.request.workerId && !query.request.chatId?.startsWith('trading:') ? [tool] : []),
    guidance: () =>
      'team reaches the user\'s Workers: for a job that needs several specialists working in parallel (research + writing + a bug repro, say), create_team with a clear kickoff instead of doing every part yourself, then tell the user where to watch.'
  }
}
