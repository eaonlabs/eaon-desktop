import type { SubagentRun } from '@shared/types'
import { adapterFor, getProvider } from '../providers'
import { addUsage, emptyUsage } from '../providers/adapters/types'
import { runLoop } from './loop'
import { workSystemPrompt } from './prompts'
import { guidanceFor, registerToolSource, toolsFor, type AgentTool, type ToolContext } from './tools'

/**
 * Swarm mode: the agent delegates to 2–6 sub-agents that run at once.
 *
 * Sub-agents run in-process on the same loop as the main agent — same
 * provider, same credentials, their own transcript and a role-scoped tool set
 * — the design Eaon Code settled on after spawning processes proved fragile.
 * They never get spawn_agents themselves, so there is no recursion, and their
 * text never streams into the main transcript: only their final reports come
 * back, which is also what keeps swarm affordable — each sub-agent's
 * exploration stays in its own context instead of the parent's.
 */

interface Role {
  readOnly: boolean
  /** Extra tools a read-only role still gets. */
  allow?: string[]
  brief: string
}

const ROLES: Record<string, Role> = {
  scout: { readOnly: true, brief: 'You are a scout sub-agent. Locate the files, symbols, APIs and facts the task asks about and report them precisely (paths, line numbers). Change nothing.' },
  researcher: { readOnly: true, brief: 'You are a researcher sub-agent. Answer the question from docs, config, code and the web. Cite where each fact came from. Change nothing.' },
  reviewer: { readOnly: true, brief: 'You are a reviewer sub-agent. Read the change or artifact described and list concrete defects and gaps against the request, most serious first. Change nothing.' },
  tester: {
    readOnly: true,
    allow: ['run_command'],
    brief: 'You are a tester sub-agent. Run the builds, tests or checks described and report the results verbatim, failures first. Do not edit files.'
  },
  implementer: { readOnly: false, brief: 'You are an implementer sub-agent. Make the change described, touching only the files it names, then verify it builds or runs.' },
  worker: { readOnly: false, brief: 'You are a sub-agent. Complete the task described and verify the result.' }
}

const MAX_AGENTS = 6
const CONCURRENCY = 4
const SUBAGENT_ROUNDS = 30

async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length)
  let next = 0
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const index = next++
      out[index] = await fn(items[index], index)
    }
  })
  await Promise.all(workers)
  return out
}

async function runSubagent(
  spec: { role: string; task: string },
  index: number,
  ctx: ToolContext,
  publish: (run: SubagentRun) => void
): Promise<{ run: SubagentRun; output: string }> {
  const roleName = ROLES[spec.role?.toLowerCase()] ? spec.role.toLowerCase() : 'worker'
  const role = ROLES[roleName]
  const run: SubagentRun = { index, role: roleName, task: spec.task, status: 'running', toolCalls: 0 }
  publish(run)

  const request = ctx.request
  const modelId = ctx.settings.work.subagentModelId || request.modelId
  const provider =
    (ctx.settings.work.subagentModelId
      ? (await import('../providers')).listProviders().find((p) => p.models.some((m) => m.id === modelId))
      : undefined) ?? getProvider(request.providerId)
  if (!provider) {
    const failed = { ...run, status: 'error' as const, output: 'No provider for the sub-agent model.' }
    publish(failed)
    return { run: failed, output: failed.output! }
  }

  const readOnly = role.readOnly || ctx.readOnly
  const query = { mode: 'work' as const, cwd: ctx.cwd, depth: 1, readOnly, settings: ctx.settings, request }
  let tools = toolsFor(query).filter((tool) => tool.name !== 'spawn_agents')
  if (role.allow && !ctx.readOnly) {
    const full = toolsFor({ ...query, readOnly: false }).filter((tool) => role.allow!.includes(tool.name))
    tools = [...tools.filter((tool) => !role.allow!.includes(tool.name)), ...full]
  }
  // In a read-only role, mutating tools are withheld outright rather than
  // offered and then refused — cheaper, and the model does not try them.
  if (readOnly) tools = tools.filter((tool) => tool.mutating === false || role.allow?.includes(tool.name))

  const usage = emptyUsage()
  try {
    const outcome = await runLoop({
      request,
      provider,
      adapter: adapterFor(provider),
      modelId,
      model: provider.models.find((m) => m.id === modelId),
      system: workSystemPrompt({
        cwd: ctx.cwd,
        projectInstructions: request.projectInstructions,
        guidance: guidanceFor(query),
        swarm: false,
        plan: false,
        goal: null,
        roleBrief: `${role.brief} Your final message is your report to the lead agent — make it complete and self-contained; it cannot see your tool calls.`
      }),
      tools,
      messages: [{ role: 'user', text: spec.task }],
      cwd: ctx.cwd,
      depth: 1,
      readOnly,
      settings: ctx.settings,
      signal: ctx.signal,
      // Only approvals reach the UI; tool traffic becomes the card's activity line.
      emit: (event) => {
        if (event.type === 'approval-request') ctx.emit(event)
        if (event.type === 'tool-call') {
          run.toolCalls++
          const detail = String(event.input.path ?? event.input.command ?? event.input.query ?? event.input.pattern ?? event.input.url ?? '')
          publish({ ...run, activity: `${event.name}${detail ? ` ${detail.slice(0, 80)}` : ''}` })
        }
      },
      approver: (tool, input, summary) => ctx.confirm(tool, input, summary),
      maxRounds: SUBAGENT_ROUNDS,
      goal: null,
      // Filled round by round, so a sub-agent that fails part-way still
      // counts what it spent.
      usage,
      onText: () => {},
      onReasoning: () => {}
    })
    const output = outcome.text.trim() || '(the sub-agent finished without a report)'
    const done = { ...run, status: 'done' as const, output: output.slice(0, 4000), activity: undefined }
    publish(done)
    return { run: done, output }
  } catch (error) {
    const message = ctx.signal.aborted ? 'Stopped.' : error instanceof Error ? error.message : String(error)
    const failed = { ...run, status: 'error' as const, output: message, activity: undefined }
    publish(failed)
    return { run: failed, output: `Failed: ${message}` }
  } finally {
    ctx.turn.extraUsage = addUsage(ctx.turn.extraUsage ?? emptyUsage(), usage)
  }
}

const spawnAgents: AgentTool = {
  name: 'spawn_agents',
  description:
    'Run 2–6 sub-agents on independent parts of the task. Roles: scout, researcher, reviewer (read-only), tester (runs commands), implementer (edits files). Each task must be self-contained. mode "parallel" (default) or "chain" ({previous} in a task is replaced with the prior agent\'s report).',
  inputSchema: {
    type: 'object',
    properties: {
      agents: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            role: { type: 'string', enum: Object.keys(ROLES) },
            task: { type: 'string', description: 'Goal, context (paths), success criteria, constraints, what to report' }
          },
          required: ['role', 'task']
        }
      },
      mode: { type: 'string', enum: ['parallel', 'chain'] }
    },
    required: ['agents']
  },
  // The sub-agents' own tool calls go through approval individually.
  mutating: false,
  describe: (input) => `${Array.isArray(input.agents) ? input.agents.length : 0} agents`,
  run: async (input, ctx) => {
    const specs = (Array.isArray(input.agents) ? input.agents : [])
      .map((a: { role?: unknown; task?: unknown }) => ({ role: String(a?.role ?? 'worker'), task: String(a?.task ?? '') }))
      .filter((a) => a.task.trim())
      .slice(0, MAX_AGENTS)
    if (specs.length === 0) return { text: 'Pass at least one agent with a task.', isError: true }

    const runs: SubagentRun[] = specs.map((spec, index) => ({ index, role: spec.role, task: spec.task, status: 'queued', toolCalls: 0 }))
    const publish = (run: SubagentRun): void => {
      runs[run.index] = run
      ctx.emit({ type: 'subagent', messageId: ctx.request.messageId, toolId: ctx.toolId, run })
    }
    runs.forEach(publish)

    let results: { run: SubagentRun; output: string }[]
    if (input.mode === 'chain') {
      results = []
      let previous = ''
      for (let i = 0; i < specs.length; i++) {
        if (ctx.signal.aborted) break
        const task = specs[i].task.replace(/\{previous\}/g, previous)
        const result = await runSubagent({ ...specs[i], task }, i, ctx, publish)
        results.push(result)
        previous = result.output
      }
    } else {
      results = await mapLimit(specs, CONCURRENCY, (spec, i) => runSubagent(spec, i, ctx, publish))
    }

    return results
      .map(({ run, output }) => `## Agent ${run.index + 1} — ${run.role}${run.status === 'error' ? ' (failed)' : ''}\nTask: ${run.task.slice(0, 300)}\n\n${output}`)
      .join('\n\n')
  }
}

registerToolSource({
  id: 'swarm',
  tools: (query) => (query.mode === 'work' && query.depth === 0 && query.request.work.swarm ? [spawnAgents] : [])
})
