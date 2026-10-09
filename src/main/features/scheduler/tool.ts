import { describeSchedule, WEEKDAYS, WEEKEND, WORKDAYS, type Schedule, type ScheduledTask, type TaskDraft } from '@shared/scheduler'
import type { AgentTool, ToolSource } from '../../agent/tools'
import type { SchedulerEngine } from './engine'

/**
 * The `schedule` Work tool: lets the user set up a recurring task in plain
 * words ("every weekday at 9 summarise my GitHub notifications") instead of
 * filling in the editor. Everything but `list` is mutating, so the usual
 * approval gate shows the user exactly what is about to be scheduled.
 */

const DAY_KEYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat']

const str = (value: unknown): string => (typeof value === 'string' ? value.trim() : '')

function parseDay(value: unknown): number | null {
  if (typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= 6) return value
  const index = DAY_KEYS.indexOf(str(value).toLowerCase().slice(0, 3))
  return index === -1 ? null : index
}

function parseDays(value: unknown): number[] {
  if (value === undefined || value === null || value === '') return WEEKDAYS
  if (typeof value === 'string') {
    const text = value.trim().toLowerCase()
    if (/^(weekdays?|workdays?|mon(day)?\s*-\s*fri(day)?)$/.test(text)) return WORKDAYS
    if (/^weekends?$/.test(text)) return WEEKEND
    if (/^(daily|every ?day|all|everyday)$/.test(text)) return WEEKDAYS
    return parseDays(text.split(/[\s,]+/))
  }
  if (!Array.isArray(value)) throw new Error('schedule.days must be a list of weekdays like ["mon","wed"].')
  const days = value.map(parseDay)
  if (days.some((d) => d === null)) throw new Error(`Unrecognised weekday in ${JSON.stringify(value)}; use mon, tue, wed, thu, fri, sat, sun.`)
  return days as number[]
}

/** "9", "9:30", "09:30", "9am", "9:30 pm" → "HH:MM". */
function parseClock(value: unknown): string {
  const match = /^(\d{1,2})(?::(\d{2}))?\s*(am|pm)?$/i.exec(str(value))
  if (!match) throw new Error(`schedule.time must look like "09:00" (24-hour); got ${JSON.stringify(value)}.`)
  let hours = Number(match[1])
  const minutes = Number(match[2] ?? 0)
  const meridiem = match[3]?.toLowerCase()
  if (meridiem === 'pm' && hours < 12) hours += 12
  if (meridiem === 'am' && hours === 12) hours = 0
  if (hours > 23 || minutes > 59) throw new Error(`${JSON.stringify(value)} is not a time of day.`)
  return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}`
}

/** "2026-09-24T09:00" in the user's local time; a string without an offset parses as local. */
function parseLocalDateTime(value: unknown): number {
  const text = str(value).replace(' ', 'T')
  const at = /^\d{4}-\d{2}-\d{2}T\d{1,2}:\d{2}/.test(text) ? new Date(text).getTime() : NaN
  if (!Number.isFinite(at)) throw new Error(`schedule.at must be a local date-time like "2026-09-24T09:00"; got ${JSON.stringify(value)}.`)
  return at
}

export function scheduleFromInput(raw: unknown): Schedule {
  const input = (raw ?? {}) as Record<string, unknown>
  const type = str(input.type || input.kind).toLowerCase()
  switch (type) {
    case 'interval': {
      const unit = /^h/i.test(str(input.unit)) ? 'hours' : 'minutes'
      return { kind: 'interval', every: Number(input.every), unit }
    }
    case 'daily':
      return { kind: 'daily', time: parseClock(input.time), days: parseDays(input.days) }
    case 'weekly': {
      const day = parseDay(input.day ?? (Array.isArray(input.days) ? input.days[0] : input.days))
      if (day === null) throw new Error('A weekly schedule needs schedule.day, e.g. "mon".')
      return { kind: 'weekly', time: parseClock(input.time), day }
    }
    case 'once':
      return { kind: 'once', at: parseLocalDateTime(input.at) }
    default:
      throw new Error('schedule.type must be one of interval, daily, weekly, once.')
  }
}

function when(at: number | null): string {
  if (at === null) return 'not scheduled'
  return new Date(at).toLocaleString('en-US', { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })
}

function line(task: ScheduledTask): string {
  const mode = task.mode === 'work' ? `Work, ${task.allowChanges ? 'may make changes' : 'read-only'}${task.cwd ? `, in ${task.cwd}` : ''}` : 'Chat'
  const state = task.enabled ? `next run ${when(task.nextRunAt)}` : 'paused'
  // A skipped slot is newer than the run that blocked it; the run is what "last run" means.
  const latest = task.history.find((run) => run.status !== 'skipped')
  const last = latest ? `; last run ${latest.status}` : ''
  return `- ${task.name} [id ${task.id}] — ${describeSchedule(task.schedule)}; ${mode}; ${state}${last}`
}

function draftOf(task: ScheduledTask): TaskDraft {
  return {
    id: task.id,
    name: task.name,
    prompt: task.prompt,
    schedule: task.schedule,
    mode: task.mode,
    model: task.model,
    cwd: task.cwd,
    allowChanges: task.allowChanges,
    enabled: task.enabled
  }
}

function describeCall(input: Record<string, unknown>): string {
  const action = str(input.action) || 'list'
  let schedule = ''
  try {
    if (input.schedule) schedule = ` — ${describeSchedule(scheduleFromInput(input.schedule))}`
  } catch {
    /* shown as-is; the run reports the error */
  }
  const name = str(input.name) || str(input.id)
  const changes = input.allow_changes === true ? ', may make changes' : ''
  return `${action[0].toUpperCase()}${action.slice(1)}${name ? ` “${name}”` : ''}${schedule}${changes}`
}

/** The task fields whose change alters what runs, when or where; a name or the on/off switch does not. */
const BEHAVIOUR_FIELDS = ['prompt', 'schedule', 'mode', 'allow_changes', 'folder'] as const

/** Whether the call leaves a recurring task that may make changes without asking (create, or an update that alters one). */
export function leavesChangingTask(input: Record<string, unknown>, find: (id: unknown) => ScheduledTask): boolean {
  const action = str(input.action)
  // Work is the default mode, as in `run` below; only work runs can make changes.
  if (action === 'create') return input.mode !== 'chat' && input.allow_changes === true
  if (action !== 'update') return false
  let task: ScheduledTask
  try {
    task = find(input.id)
  } catch {
    return false // nothing to change: the call fails on its own
  }
  const mode = input.mode !== undefined ? (input.mode === 'chat' ? 'chat' : 'work') : task.mode
  const allowChanges = input.allow_changes !== undefined ? input.allow_changes === true : task.allowChanges
  if (mode !== 'work' || !allowChanges) return false
  return BEHAVIOUR_FIELDS.some((field) => input[field] !== undefined)
}

export function scheduleTool(engine: SchedulerEngine): AgentTool {
  const find = (id: unknown): ScheduledTask => {
    const tasks = engine.list()
    const task = tasks.find((t) => t.id === str(id)) ?? tasks.find((t) => t.name.toLowerCase() === str(id).toLowerCase())
    if (!task) throw new Error(`No scheduled task with id ${JSON.stringify(id)}. Call schedule with action "list" to see the ids.`)
    return task
  }

  return {
    name: 'schedule',
    description:
      "Manage the user's scheduled tasks: prompts Eaon runs by itself on a cadence, each run producing a new chat in Recents. Use it when the user wants something done regularly or later (\"every weekday at 9 summarise my GitHub notifications\"). Times are the user's local time. The prompt runs later with no memory of this conversation, so write it as a complete, self-contained instruction. Work runs are read-only unless allow_changes is true — set it when the task must edit files or run shell commands (e.g. the gh CLI). Use action list to find ids before update, delete or run.",
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['create', 'list', 'update', 'delete', 'run'] },
        id: { type: 'string', description: 'Task id (update, delete, run)' },
        name: { type: 'string', description: 'Short name shown in the list and as the chat title' },
        prompt: { type: 'string', description: 'The complete instruction to run each time' },
        schedule: {
          type: 'object',
          description:
            'interval: {type, every, unit: minutes|hours}. daily: {type, time: "HH:MM", days?: ["mon",…] (omit for every day)}. weekly: {type, time, day: "mon"}. once: {type, at: "YYYY-MM-DDTHH:MM"}.',
          properties: {
            type: { type: 'string', enum: ['interval', 'daily', 'weekly', 'once'] },
            every: { type: 'number' },
            unit: { type: 'string', enum: ['minutes', 'hours'] },
            time: { type: 'string' },
            days: { type: 'array', items: { type: 'string' } },
            day: { type: 'string' },
            at: { type: 'string' }
          },
          required: ['type']
        },
        mode: { type: 'string', enum: ['work', 'chat'], description: 'work (default): full agent with tools. chat: answer with web search only.' },
        allow_changes: { type: 'boolean', description: 'Work only: let runs edit files and run commands without asking; risky actions are still refused. Default false.' },
        folder: { type: 'string', description: 'Work folder for the runs. Defaults to the current one.' },
        enabled: { type: 'boolean' }
      },
      required: ['action']
    },
    mutating: (input) => str(input.action) !== 'list',
    // Creating or changing a task that may edit files and run commands on its
    // own, on a schedule, with nobody there to approve: "Approve for me" asks
    // about it like a risky command. Otherwise a chat steered by a web page
    // could plant a recurring task that acts unattended, and nothing would
    // have asked. A task that only reads, a rename, pausing and deleting stay
    // as they were.
    risky: (input) => leavesChangingTask(input, find),
    describe: describeCall,
    run: async (input, ctx) => {
      const action = str(input.action)
      if (action === 'list') {
        const tasks = engine.list()
        return tasks.length ? `Scheduled tasks:\n${tasks.map(line).join('\n')}` : 'No scheduled tasks yet.'
      }
      if (action === 'create') {
        const prompt = str(input.prompt)
        const task = engine.save({
          name: str(input.name) || prompt.split('\n')[0].slice(0, 60),
          prompt,
          schedule: scheduleFromInput(input.schedule),
          mode: input.mode === 'chat' ? 'chat' : 'work',
          model: null,
          cwd: str(input.folder) || ctx.cwd || null,
          allowChanges: input.allow_changes === true,
          enabled: input.enabled !== false
        })
        return `Scheduled:\n${line(task)}\nIt shows on the Scheduled page, where the user can edit, pause or run it.`
      }
      if (action === 'update') {
        const draft = draftOf(find(input.id))
        if (input.name !== undefined) draft.name = str(input.name)
        if (input.prompt !== undefined) draft.prompt = str(input.prompt)
        if (input.schedule !== undefined) draft.schedule = scheduleFromInput(input.schedule)
        if (input.mode !== undefined) draft.mode = input.mode === 'chat' ? 'chat' : 'work'
        if (input.allow_changes !== undefined) draft.allowChanges = input.allow_changes === true
        if (input.folder !== undefined) draft.cwd = str(input.folder) || null
        if (input.enabled !== undefined) draft.enabled = input.enabled === true
        return `Updated:\n${line(engine.save(draft))}`
      }
      if (action === 'delete') {
        const task = find(input.id)
        engine.remove(task.id)
        return `Deleted “${task.name}”. Chats from its earlier runs are kept.`
      }
      if (action === 'run') {
        const task = find(input.id)
        engine.runNow(task.id)
        return `Started “${task.name}” now. It runs in the background and appears in Recents as a new chat.`
      }
      throw new Error('action must be one of create, list, update, delete, run.')
    }
  }
}

export function scheduleToolSource(engine: SchedulerEngine): ToolSource {
  const tool = scheduleTool(engine)
  return {
    id: 'scheduler',
    tools: (query) => {
      if (query.mode !== 'work' || query.depth > 0) return []
      // Workers schedule themselves with set_heartbeat; offering both had a
      // worker reach for this (which starts separate chats) when asked to
      // "message me in a minute".
      if (query.request.workerId) return []
      // A scheduled run does not get to schedule more of itself.
      const history = query.request.history
      if (history[history.length - 1]?.scheduledTaskId) return []
      return [tool]
    }
  }
}
