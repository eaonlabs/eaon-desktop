import type { TodoItem } from '@shared/types'
import { registerToolSource, type AgentTool } from './tools'

/**
 * Tools that shape how a Work turn runs rather than acting on the computer:
 * the agent's own checklist, plan mode's hand-off, and goal mode's exits.
 */

const str = (value: unknown): string => (typeof value === 'string' ? value : '')

const updatePlan: AgentTool = {
  name: 'update_plan',
  description:
    'Publish your checklist for a multi-step task so the user can follow along. Send the whole list each time, marking one item in_progress. Skip it for tasks of one or two steps.',
  inputSchema: {
    type: 'object',
    properties: {
      items: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            text: { type: 'string' },
            status: { type: 'string', enum: ['pending', 'in_progress', 'done'] }
          },
          required: ['text', 'status']
        }
      }
    },
    required: ['items']
  },
  mutating: false,
  describe: (input) => `${Array.isArray(input.items) ? input.items.length : 0} items`,
  run: async (input, ctx) => {
    const items = (Array.isArray(input.items) ? input.items : [])
      .map((item: { text?: unknown; status?: unknown }) => ({
        text: str(item?.text).slice(0, 200),
        status: (['pending', 'in_progress', 'done'].includes(str(item?.status)) ? item.status : 'pending') as TodoItem['status']
      }))
      .filter((item) => item.text)
      .slice(0, 30)
    ctx.emit({ type: 'todos', messageId: ctx.request.messageId, todos: items })
    // The model already knows what it sent; echoing the list back would only
    // cost tokens on every later round.
    return 'Plan updated.'
  }
}

const presentPlan: AgentTool = {
  name: 'present_plan',
  description:
    'Plan mode: present your finished plan to the user for approval. Call this once, after researching, and then stop — nothing is changed until the user approves.',
  inputSchema: {
    type: 'object',
    properties: {
      title: { type: 'string', description: 'Short name for the plan' },
      summary: { type: 'string', description: 'Two or three sentences: what will change and why' },
      steps: { type: 'array', items: { type: 'string' }, description: 'Concrete steps in order, naming files and commands' }
    },
    required: ['title', 'summary', 'steps']
  },
  mutating: false,
  describe: (input) => str(input.title),
  run: async (input, ctx) => {
    const plan = {
      title: str(input.title).slice(0, 120) || 'Plan',
      summary: str(input.summary).slice(0, 2000),
      steps: (Array.isArray(input.steps) ? input.steps : []).map((s) => String(s).slice(0, 500)).slice(0, 40),
      status: 'pending' as const
    }
    ctx.turn.plan = plan
    ctx.emit({ type: 'plan', messageId: ctx.request.messageId, plan })
    return 'The plan is shown to the user with Approve and Revise buttons. Stop now and wait; do not start the work.'
  }
}

const goalComplete: AgentTool = {
  name: 'goal_complete',
  description:
    'Goal mode: call ONLY when the goal is fully achieved and you have verified it (ran it, tested it, checked the output). Summarise the evidence.',
  inputSchema: {
    type: 'object',
    properties: { summary: { type: 'string', description: 'What was done and how you verified it' } },
    required: ['summary']
  },
  mutating: false,
  run: async (input, ctx) => {
    // "I wrote the code" is not "the goal is met". When the last thing the
    // agent did was change something and nothing has looked at the result
    // since, send it back once to check. Asked once only, so a goal that
    // genuinely cannot be checked is not held hostage.
    const evidence = ctx.turn.evidence
    const change = evidence?.lastChange
    if (evidence && change && change.seq > (evidence.lastCheck ?? 0) && !evidence.verifyAsked) {
      evidence.verifyAsked = true
      return {
        text:
          `Not marked achieved yet: your last action (${change.tool}) changed something and nothing has checked the result since. ` +
          'Verify it now — run it, run the tests, or read back the output — then call goal_complete again with what you observed. ' +
          'If it truly cannot be checked, call goal_complete again and say why in the summary.',
        isError: true
      }
    }
    ctx.turn.goalResolution = { status: 'achieved', summary: str(input.summary).slice(0, 4000) }
    return 'Goal marked achieved. Give the user a brief final summary.'
  }
}

const goalBlocked: AgentTool = {
  name: 'goal_blocked',
  description:
    'Goal mode: call when you cannot make further progress without the user — missing access, a decision only they can make, or repeated failures after trying real alternatives.',
  inputSchema: {
    type: 'object',
    properties: { reason: { type: 'string', description: 'What is blocking you and what you need from the user' } },
    required: ['reason']
  },
  mutating: false,
  run: async (input, ctx) => {
    ctx.turn.goalResolution = { status: 'blocked', summary: str(input.reason).slice(0, 4000) }
    return 'Goal paused. Tell the user plainly what you need.'
  }
}

/** The longest one wait may last; the agent can wait again. */
const MAX_WAIT_MINUTES = 120

/**
 * A goal with an end time runs for hours, and much of a long task is
 * waiting — for a build, a reply, a price. Without this the agent either
 * stops (and is sent straight back) or polls in a tight loop, paying for a
 * model call every few seconds. Never past the goal's end time.
 */
const wait: AgentTool = {
  name: 'wait',
  description: 'Pause for a number of minutes before your next step, when you are waiting for something to happen. Never past your end time.',
  inputSchema: {
    type: 'object',
    properties: {
      minutes: { type: 'number', description: `1–${MAX_WAIT_MINUTES}` },
      reason: { type: 'string', description: 'What you are waiting for' }
    },
    required: ['minutes']
  },
  mutating: false,
  describe: (input) => `${Number(input.minutes) || 1} min${str(input.reason) ? ` · ${str(input.reason)}` : ''}`,
  run: async (input, ctx) => {
    const until = ctx.request.goal?.until ?? Date.now()
    const asked = Math.min(Math.max(Number(input.minutes) || 1, 1), MAX_WAIT_MINUTES) * 60_000
    const ms = Math.max(0, Math.min(asked, until - Date.now()))
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, ms)
      ctx.signal?.addEventListener(
        'abort',
        () => {
          clearTimeout(timer)
          resolve()
        },
        { once: true }
      )
    })
    const now = new Date().toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })
    const left = Math.max(0, Math.round((until - Date.now()) / 60_000))
    return left > 0 ? `Waited ${Math.round(ms / 60_000)} min. It is ${now}; ${left} min left.` : `Waited until the end time (${now}). Wrap up now.`
  }
}

registerToolSource({
  id: 'workflow',
  tools: (query) => {
    if (query.mode !== 'work' || query.depth > 0) return []
    const tools = [updatePlan]
    if (query.readOnly) tools.push(presentPlan)
    if (query.request.goal?.status === 'active' && !query.readOnly) tools.push(goalComplete, goalBlocked)
    if (query.request.goal?.status === 'active' && query.request.goal.until && !query.readOnly) tools.push(wait)
    return tools
  }
})
