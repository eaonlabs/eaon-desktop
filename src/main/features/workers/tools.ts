import { isAbsolute, resolve } from 'node:path'
import { describeWorker, MAIN_THREAD, MAX_SLEEP_MINUTES } from '@shared/workers'
import type { AgentTool, ToolContext, ToolSource } from '../../agent/tools'
import { HINT_MOODS, type TransferWatch, type WorkersEngine } from './engine'

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

const fileList = (value: unknown): string[] => (Array.isArray(value) ? value.filter((f): f is string => typeof f === 'string' && f.trim().length > 0) : [])

/** A file transfer the tool's Stop ends, with "Copying 120 of 480 MB…" as it goes. */
function transferOf(ctx: ToolContext): TransferWatch {
  const mb = (bytes: number): string => `${Math.round(bytes / (1024 * 1024))}`
  return {
    signal: ctx.signal,
    onProgress: (p) => ctx.progress?.(p.total > 8 * 1024 * 1024 ? `Copying ${mb(p.bytes)} of ${mb(p.total)} MB…` : `Copying files… (${p.files})`)
  }
}

function self(ctx: ToolContext): string {
  const id = ctx.request.workerId
  if (!id) throw new Error('Only a worker can use this tool.')
  return id
}

/** The thread the calling turn runs in: its wake-ups, status and delegations belong to that thread. */
const threadOf = (ctx: ToolContext): string => ctx.request.workerThreadId ?? MAIN_THREAD

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
        files: { type: 'array', items: { type: 'string' }, description: 'Files or folders to send' },
        share_context: { type: 'boolean', description: 'Attach your recent thread, so they have the background' }
      },
      required: ['to', 'message']
    },
    mutating: false,
    describe: (input) => `Message ${str(input.to)}`,
    run: async (input, ctx) => {
      const files = fileList(input.files)
      const { recipient, delivered } = await engine.message(self(ctx), str(input.to), str(input.message), files, {
        shareContext: input.share_context === true,
        fromThreadId: threadOf(ctx),
        transfer: transferOf(ctx)
      })
      const where = delivered.length > 0 ? ` Files delivered to:\n${delivered.map((p) => `- ${p}`).join('\n')}` : ''
      const paused = recipient.paused ? ` ${recipient.name} is paused and will read it when resumed.` : ''
      return `Sent to ${recipient.name}.${paused}${where}`
    }
  }

  const checkWorker: AgentTool = {
    name: 'check_worker',
    description: "Check on a colleague: status, schedule, unread mail, open tasks, last error, and the latest thing it said. messages: N also reads its last N thread messages.",
    inputSchema: {
      type: 'object',
      properties: { name: { type: 'string' }, messages: { type: 'integer', description: 'Read this many recent messages of its thread (up to 40)' } },
      required: ['name']
    },
    mutating: false,
    describe: (input) => `Check on ${str(input.name)}`,
    run: async (input) => engine.inspect(str(input.name), Math.max(0, Math.min(40, num(input.messages) ?? 0)))
  }

  const handOff: AgentTool = {
    name: 'hand_off',
    description:
      'Delegate a well-defined job to a colleague; they work on it in a thread of their own, in parallel. Give the objective (task), the background they need (context — they see nothing else of yours), what to send back (required_output) and any files. Their result comes back to you as mail when they finish_handoff.',
    inputSchema: {
      type: 'object',
      properties: {
        to: { type: 'string', description: 'Colleague name' },
        task: { type: 'string', description: 'The objective' },
        context: { type: 'string', description: 'Background, constraints and file paths they need' },
        required_output: { type: 'string', description: 'What to send back' },
        deadline_minutes: { type: 'number', description: 'Optional: fail it if not done in this many minutes' },
        files: { type: 'array', items: { type: 'string' } },
        share_context: { type: 'boolean', description: 'Also attach your recent messages (only if they truly need them)' }
      },
      required: ['to', 'task']
    },
    mutating: false,
    describe: (input) => `Hand off to ${str(input.to)}`,
    run: async (input, ctx) => {
      const { recipient, delegation, delivered } = await engine.handOff(self(ctx), str(input.to), str(input.task), fileList(input.files), {
        shareContext: input.share_context === true,
        context: str(input.context),
        requiredOutput: str(input.required_output),
        deadlineMinutes: num(input.deadline_minutes),
        fromThreadId: threadOf(ctx),
        transfer: transferOf(ctx)
      })
      return `Delegated ${delegation.id} to ${recipient.name}${recipient.paused ? ' (paused: it starts when resumed)' : ''}. Its result will arrive as mail; carry on meanwhile.${
        delivered.length ? ` Files delivered:\n${delivered.map((p) => `- ${p}`).join('\n')}` : ''
      }`
    }
  }

  const finishHandoff: AgentTool = {
    name: 'finish_handoff',
    description: 'Report back on a task a colleague handed you: the result (and any files) goes straight to them. ok: false when you could not do it, saying why.',
    inputSchema: {
      type: 'object',
      properties: {
        task_id: { type: 'string' },
        result: { type: 'string' },
        files: { type: 'array', items: { type: 'string' } },
        ok: { type: 'boolean' }
      },
      required: ['task_id', 'result']
    },
    mutating: false,
    describe: (input) => `Report on ${str(input.task_id)}`,
    run: async (input, ctx) => engine.finishHandoff(self(ctx), str(input.task_id), str(input.result), fileList(input.files), input.ok !== false, threadOf(ctx), transferOf(ctx))
  }

  const postToRoom: AgentTool = {
    name: 'post_to_room',
    description: 'Post in a group chat you are in. @Name a colleague there to wake them for their part; everyone else reads it when next spoken to there. Your reply to a group-chat message is posted for you, so use this for extra posts.',
    inputSchema: {
      type: 'object',
      properties: { room: { type: 'string', description: 'Group chat name' }, message: { type: 'string' }, files: { type: 'array', items: { type: 'string' } } },
      required: ['room', 'message']
    },
    mutating: false,
    describe: (input) => `Post in ${str(input.room)}`,
    run: async (input, ctx) => {
      const { room, woke } = await engine.postAsWorker(self(ctx), str(input.room), str(input.message), fileList(input.files), threadOf(ctx), transferOf(ctx))
      return `Posted in "${room.name}".${woke.length ? ` Woke ${woke.join(', ')}.` : ''}`
    }
  }

  const readRoom: AgentTool = {
    name: 'read_room',
    description: 'Read the recent posts of a group chat you are in.',
    inputSchema: { type: 'object', properties: { room: { type: 'string' }, count: { type: 'integer', description: 'How many posts (default 20)' } }, required: ['room'] },
    mutating: false,
    describe: (input) => `Read ${str(input.room)}`,
    run: async (input, ctx) => engine.readRoom(self(ctx), str(input.room), num(input.count) ?? 20)
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
      return engine.setHeartbeat(
        self(ctx),
        {
          inMinutes: num(input.in_minutes),
          everyMinutes: num(input.every_minutes),
          ...(at ? { at } : {}),
          note: str(input.note),
          stop: input.stop === true
        },
        threadOf(ctx)
      )
    }
  }

  /**
   * Sleeping is how a worker waits: for a build, a reply, a price, the next
   * market open, or to pace long work. The turn ends (TurnState.yielded) and
   * frees its slot, rather than holding one while nothing happens.
   */
  const sleep: AgentTool = {
    name: 'sleep',
    description: `Stop working now and wake up again later: when you are waiting for something (a build, a reply, a page to change, the market to open) or pacing long work. minutes = how long (1–${MAX_SLEEP_MINUTES}); note = what to check or do when you wake. To wake the moment something happens instead of guessing a time, add until_process_exits (the pid of a background command) or until_file_changes (a path); minutes is then the longest you wait. This turn ends straight away; a goal you are working on carries on when you wake.`,
    inputSchema: {
      type: 'object',
      properties: {
        minutes: { type: 'number', description: `1–${MAX_SLEEP_MINUTES}` },
        note: { type: 'string', description: 'What to check or do when you wake' },
        until_process_exits: { type: 'number', description: 'Wake when this process exits (pid from run_command background: true)' },
        until_file_changes: { type: 'string', description: 'Wake when this file or folder changes or appears' }
      },
      required: ['minutes']
    },
    mutating: false,
    describe: (input) => `Sleep ${Math.max(1, Math.round(num(input.minutes) ?? 1))} min${str(input.note) ? ` · ${str(input.note)}` : ''}`,
    run: async (input, ctx) => {
      const file = str(input.until_file_changes)
      const { until, text } = engine.sleep(self(ctx), num(input.minutes) ?? 1, str(input.note), threadOf(ctx), {
        ...(num(input.until_process_exits) ? { processExits: num(input.until_process_exits) } : {}),
        ...(file ? { fileChanges: isAbsolute(file) ? file : resolve(ctx.cwd, file) } : {})
      })
      ctx.turn.yielded = { until }
      return text
    }
  }

  const setStatus: AgentTool = {
    name: 'set_status',
    description:
      'Set the one-line status the user sees on your card, and optionally the expression on your face for the next half hour: neutral, happy, excited, serious, curious, surprised, sad or angry. Pick one that fits how the work is going.',
    inputSchema: {
      type: 'object',
      properties: {
        activity: { type: 'string' },
        mood: { type: 'string', enum: HINT_MOODS }
      },
      required: ['activity']
    },
    mutating: false,
    describe: (input) => str(input.activity) || 'Update status',
    run: async (input, ctx) => {
      engine.setStatus(self(ctx), str(input.activity), str(input.mood) || undefined, threadOf(ctx))
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
      engine.ask(
        self(ctx),
        {
          question: str(input.question),
          options: Array.isArray(input.options) ? input.options.filter((o): o is string => typeof o === 'string') : [],
          approve: tool && approveInput ? { tool, input: approveInput, summary: str(input.approve_summary) || str(input.question) } : null
        },
        threadOf(ctx)
      )
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
    handOff,
    finishHandoff,
    checkWorker,
    sleep,
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
    tools: (query) => {
      const id = query.request.workerId
      if (query.mode !== 'work' || query.depth !== 0 || !id || !engine.has(id)) return []
      // Group-chat tools only for a worker in one: fewer tools, less to read on every request.
      return engine.roomsOf(id).length > 0 ? [...tools, postToRoom, readRoom] : tools
    }
  }
}
