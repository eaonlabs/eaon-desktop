import { describeWorker } from '@shared/workers'
import type { AgentTool, ToolContext, ToolSource } from '../../agent/tools'
import type { WorkersEngine } from './engine'

/**
 * The tools a worker gets on top of the Work agent's: see its colleagues,
 * hand them work (with files), check on them, schedule its own heartbeat and
 * routines, keep a goal and notes that outlive compaction, ask the user
 * without stopping (including for one-time approval of an action it may not
 * take alone), reach out first, keep its status line current, and — rarely —
 * create a new colleague.
 *
 * Offered only on a worker's own turn (`request.workerId`), never to a swarm
 * sub-agent or an ordinary chat. Descriptions are short on purpose: they are
 * part of every request a worker makes.
 */

const str = (value: unknown): string => (typeof value === 'string' ? value.trim() : '')
const num = (value: unknown): number | undefined => {
  const n = typeof value === 'number' ? value : typeof value === 'string' && value.trim() ? Number(value) : NaN
  return Number.isFinite(n) ? n : undefined
}

/**
 * A wake-up time a model wrote: "14:05", "2:05 PM", "9pm" (today, or tomorrow
 * if that has passed), or an ISO date-time. Null when it is neither.
 */
export function parseWakeTime(text: string, now: number): number | null {
  const clock = /^(\d{1,2})(?::(\d{2}))?\s*([ap]\.?m\.?)?$/i.exec(text.trim())
  if (clock) {
    let hours = Number(clock[1])
    const minutes = Number(clock[2] ?? 0)
    const meridiem = clock[3]?.toLowerCase().replace(/\./g, '')
    if (meridiem === 'pm' && hours < 12) hours += 12
    if (meridiem === 'am' && hours === 12) hours = 0
    if (hours > 23 || minutes > 59 || (!meridiem && !clock[2])) return null
    const at = new Date(now)
    at.setHours(hours, minutes, 0, 0)
    if (at.getTime() <= now) at.setDate(at.getDate() + 1)
    return at.getTime()
  }
  const parsed = Date.parse(text)
  return Number.isFinite(parsed) ? parsed : null
}

function self(ctx: ToolContext): string {
  const id = ctx.request.workerId
  if (!id) throw new Error('Only a worker can use this tool.')
  return id
}

export function workersToolSource(engine: WorkersEngine): ToolSource {
  const listWorkers: AgentTool = {
    name: 'list_workers',
    description: 'List your fellow workers: name, purpose, what they are doing, and their folder.',
    inputSchema: { type: 'object', properties: {} },
    mutating: false,
    run: async (_input, ctx) => {
      const others = engine.colleagues(self(ctx))
      if (others.length === 0) return 'You have no colleagues yet.'
      return others
        .map((w) => `- ${w.name}: ${w.purpose || 'no stated purpose'}\n  Status: ${describeWorker(w)}\n  Folder: ${w.folder}`)
        .join('\n')
    }
  }

  const messageWorker: AgentTool = {
    name: 'message_worker',
    description:
      'Send a colleague a message — ask for help with a well-defined part of a job, or reply with results. Optional files (paths) are copied into their folder. It wakes them.',
    inputSchema: {
      type: 'object',
      properties: {
        to: { type: 'string', description: 'Colleague name' },
        message: { type: 'string' },
        files: { type: 'array', items: { type: 'string' }, description: 'Files or folders to send' }
      },
      required: ['to', 'message']
    },
    mutating: false,
    describe: (input) => `Message ${str(input.to)}`,
    run: async (input, ctx) => {
      const files = Array.isArray(input.files) ? input.files.filter((f): f is string => typeof f === 'string' && f.trim().length > 0) : []
      const { recipient, delivered } = await engine.message(self(ctx), str(input.to), str(input.message), files)
      const where = delivered.length > 0 ? ` Files delivered to:\n${delivered.map((p) => `- ${p}`).join('\n')}` : ''
      const paused = recipient.paused ? ` ${recipient.name} is paused and will read it when resumed.` : ''
      return `Sent to ${recipient.name}.${paused}${where}`
    }
  }

  const checkWorker: AgentTool = {
    name: 'check_worker',
    description: "Check on a colleague: status, schedule, unread mail, last error, and the latest thing it said.",
    inputSchema: { type: 'object', properties: { name: { type: 'string' } }, required: ['name'] },
    mutating: false,
    describe: (input) => `Check on ${str(input.name)}`,
    run: async (input) => engine.inspect(str(input.name))
  }

  const setHeartbeat: AgentTool = {
    name: 'set_heartbeat',
    description:
      'Schedule your own next wake-up. One of: in_minutes (one-off; 0 = as soon as possible, which is 1 minute), at (a clock time like "09:30" or "9:30 PM", or an ISO date-time), every_minutes (steady beat, e.g. while watching a training run), or stop: true. note = what to do when you wake. To tell the user something now, just say it in your reply.',
    inputSchema: {
      type: 'object',
      properties: {
        in_minutes: { type: 'number', description: 'Minutes from now; 0 means the soonest (1 minute)' },
        at: { type: 'string', description: 'Local clock time ("14:05", "2:05 PM") or ISO date-time' },
        every_minutes: { type: 'number' },
        note: { type: 'string' },
        stop: { type: 'boolean' }
      }
    },
    mutating: false,
    describe: (input) =>
      input.stop
        ? 'Stop heartbeat'
        : `Heartbeat${num(input.every_minutes) ? ` every ${num(input.every_minutes)} min` : str(input.at) ? ` at ${str(input.at)}` : num(input.in_minutes) !== undefined ? ` in ${Math.max(1, num(input.in_minutes)!)} min` : ''}`,
    run: async (input, ctx) => {
      const at = str(input.at) ? parseWakeTime(str(input.at), engine.clock()) : undefined
      if (str(input.at) && at === null) {
        return { text: `Could not read at: "${str(input.at)}". Use a clock time like "09:30" or "9:30 PM", or an ISO date-time.`, isError: true }
      }
      return engine.setHeartbeat(self(ctx), {
        inMinutes: num(input.in_minutes),
        everyMinutes: num(input.every_minutes),
        ...(at ? { at } : {}),
        note: str(input.note),
        stop: input.stop === true
      })
    }
  }

  const setStatus: AgentTool = {
    name: 'set_status',
    description: 'Set the one-line status the user sees on your card, and optionally your mood (neutral, happy, serious, angry).',
    inputSchema: {
      type: 'object',
      properties: {
        activity: { type: 'string' },
        mood: { type: 'string', enum: ['neutral', 'happy', 'serious', 'angry'] }
      },
      required: ['activity']
    },
    mutating: false,
    describe: (input) => str(input.activity) || 'Update status',
    run: async (input, ctx) => {
      engine.setStatus(self(ctx), str(input.activity), str(input.mood) || undefined)
      return 'Status updated.'
    }
  }

  const createWorker: AgentTool = {
    name: 'create_worker',
    description:
      'Create a new, permanent colleague and give it its first task. Rarely needed: only when no existing colleague fits and the job needs its own long-lived agent.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string' },
        personality: { type: 'string' },
        purpose: { type: 'string' },
        first_task: { type: 'string' },
        reason: { type: 'string', description: 'Why no existing colleague can do this' },
        color: { type: 'string', description: 'Hex colour, optional' }
      },
      required: ['name', 'purpose', 'first_task', 'reason']
    },
    mutating: true,
    risky: () => false,
    describe: (input) => `Create worker ${str(input.name)}`,
    run: async (input, ctx) => {
      const worker = engine.createByWorker(self(ctx), {
        name: str(input.name),
        personality: str(input.personality),
        purpose: str(input.purpose),
        firstTask: str(input.first_task),
        reason: str(input.reason),
        color: str(input.color) || undefined
      })
      return `Created ${worker.name} (folder ${worker.folder}) and sent it the first task. Follow up with check_worker.`
    }
  }

  const setGoal: AgentTool = {
    name: 'set_goal',
    description:
      'Record what you are working towards: the objective and how you will know it is done. It stays in your prompt on every turn, even after the thread is summarised. Empty clears it.',
    inputSchema: { type: 'object', properties: { goal: { type: 'string' } }, required: ['goal'] },
    mutating: false,
    describe: (input) => str(input.goal) || 'Clear goal',
    run: async (input, ctx) => engine.setMemory(self(ctx), { goal: str(input.goal) })
  }

  const updateNotes: AgentTool = {
    name: 'update_notes',
    description:
      'Your lasting notes: decisions, the user\'s preferences, open loops, where things are. add = append one line; replace = rewrite them all (to tidy up). They stay in your prompt on every turn.',
    inputSchema: {
      type: 'object',
      properties: { add: { type: 'string', description: 'One line to append' }, replace: { type: 'string', description: 'The whole notes, rewritten' } }
    },
    mutating: false,
    describe: (input) => (str(input.replace) ? 'Rewrite notes' : str(input.add) || 'Update notes'),
    run: async (input, ctx) => {
      if (!str(input.add) && typeof input.replace !== 'string') return { text: 'Give add (one line) or replace (all the notes).', isError: true }
      return engine.setMemory(self(ctx), typeof input.replace === 'string' ? { notes: input.replace } : { appendNote: str(input.add) })
    }
  }

  const askUser: AgentTool = {
    name: 'ask_user',
    description:
      'Ask the user something without stopping — a judgment call, a missing detail, or approval for an action you may not take alone (then pass approve_tool and approve_input: the exact call). Keep working on anything else meanwhile; the answer arrives as mail.',
    inputSchema: {
      type: 'object',
      properties: {
        question: { type: 'string' },
        options: { type: 'array', items: { type: 'string' }, description: 'Up to 4 quick answers' },
        approve_tool: { type: 'string', description: 'For an approval: the name of the tool you want to call, exactly as you call it (e.g. email_send)' },
        approve_input: { type: 'object', description: 'For an approval: its exact input' },
        approve_summary: { type: 'string', description: 'For an approval: what it does, in one line' }
      },
      required: ['question']
    },
    mutating: false,
    describe: (input) => str(input.question),
    run: async (input, ctx) => {
      const tool = str(input.approve_tool)
      const approveInput = input.approve_input && typeof input.approve_input === 'object' ? (input.approve_input as Record<string, unknown>) : null
      if (tool && !approveInput) return { text: 'An approval needs approve_input: the exact input you will call it with.', isError: true }
      engine.ask(self(ctx), {
        question: str(input.question),
        options: Array.isArray(input.options) ? input.options.filter((o): o is string => typeof o === 'string') : [],
        approve: tool && approveInput ? { tool, input: approveInput, summary: str(input.approve_summary) || str(input.question) } : null
      })
      return tool
        ? 'Asked. If the user approves, you may make exactly that call once. Carry on with other work; the answer arrives as mail.'
        : 'Asked. Carry on with other work; the answer arrives as mail.'
    }
  }

  const notifyUser: AgentTool = {
    name: 'notify_user',
    description:
      'Reach out to the user first, with a notification: something they would want to know now (a job finished or failed, something you spotted). Not for routine progress.',
    inputSchema: { type: 'object', properties: { title: { type: 'string' }, message: { type: 'string' } }, required: ['message'] },
    mutating: false,
    describe: (input) => str(input.title) || str(input.message),
    run: async (input, ctx) => {
      engine.reachOut(self(ctx), str(input.title), str(input.message))
      return 'Sent.'
    }
  }

  const addRoutine: AgentTool = {
    name: 'add_routine',
    description:
      'Add (or update, by name) a repeating job: every_minutes, or daily at a 24-hour time ("08:30"). You wake for it with the task as your brief. For one-off wake-ups use set_heartbeat.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string' },
        task: { type: 'string', description: 'What to do each time' },
        every_minutes: { type: 'number' },
        daily: { type: 'string', description: '"HH:MM", local time' },
        market_hours: { type: 'boolean', description: 'Only while the US stock market is open' }
      },
      required: ['name', 'task']
    },
    mutating: false,
    describe: (input) => `${str(input.name)}${str(input.daily) ? ` · daily ${str(input.daily)}` : num(input.every_minutes) ? ` · every ${num(input.every_minutes)} min` : ''}`,
    run: async (input, ctx) =>
      engine.addRoutine(self(ctx), {
        name: str(input.name),
        task: str(input.task),
        everyMinutes: num(input.every_minutes),
        daily: str(input.daily) || undefined,
        marketHours: input.market_hours === true
      })
  }

  const removeRoutine: AgentTool = {
    name: 'remove_routine',
    description: 'Stop a routine, by name.',
    inputSchema: { type: 'object', properties: { name: { type: 'string' } }, required: ['name'] },
    mutating: false,
    describe: (input) => str(input.name),
    run: async (input, ctx) => engine.removeRoutine(self(ctx), str(input.name))
  }

  const tools = [
    listWorkers,
    messageWorker,
    checkWorker,
    setHeartbeat,
    addRoutine,
    removeRoutine,
    setStatus,
    setGoal,
    updateNotes,
    askUser,
    notifyUser,
    createWorker
  ]
  return {
    id: 'workers',
    tools: (query) =>
      query.mode === 'work' && query.depth === 0 && query.request.workerId && engine.has(query.request.workerId) ? tools : []
  }
}
