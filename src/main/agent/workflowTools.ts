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

registerToolSource({
  id: 'workflow',
  tools: (query) => {
    if (query.mode !== 'work' || query.depth > 0) return []
    const tools = [updatePlan]
    if (query.readOnly) tools.push(presentPlan)
    if (query.request.goal?.status === 'active' && !query.readOnly) tools.push(goalComplete, goalBlocked)
    return tools
  }
})
