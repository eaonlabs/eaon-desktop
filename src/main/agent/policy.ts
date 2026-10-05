import type { ApprovalMode } from '@shared/types'
import { isMutating, toolSourceOf, type AgentTool, type ToolContext } from './tools'

/**
 * The one permission policy every tool call goes through: the chat loop, a
 * swarm sub-agent, a worker's turn (and a guest's, and work a colleague
 * handed it), a scheduled task, a trading session and the CLI all ask this
 * function, so they can't drift apart. Before it existed the rules lived
 * inline in the loop and a second copy in the CLI, and sub-agents ran with
 * none of their parent's limits.
 *
 * The answer is the most restrictive of everything that applies — plan
 * mode, the turn's tool gate (a guest's cap), who the work came from, the
 * unattended policy or the user's approval mode, and the tool's own sense of
 * risk — unless the user approved this exact call in advance (`allowOnce`).
 */

/**
 * How a run with nobody watching treats changes, in place of the approval
 * prompt: 'read-only' refuses every mutating call, 'safe' runs ordinary ones
 * and refuses the risky ones "Approve for me" would still stop to ask about,
 * 'autonomous' (a worker the user trusts to act alone) runs everything but
 * the calls a tool marks catastrophic.
 */
export type UnattendedPolicy = 'read-only' | 'safe' | 'autonomous'

/** Refuses a tool call outright, whatever it is: a reason for the model, or null to let the usual rules decide. */
export type ToolGate = (tool: AgentTool, input: Record<string, unknown>) => string | null

/**
 * Who the work in this turn came from. The user (in a chat, or mailing their
 * worker) may have Eaon spend money within what they set up; a guest writing
 * from a chat app, or a colleague handing work over, may not — whatever
 * access the worker itself has.
 */
export type TurnOrigin = 'user' | 'guest' | 'delegated'

/** Everything about the run that limits what a call may do. Forwarded unchanged to swarm sub-agents. */
export interface RunPolicy {
  /** Plan mode, or a read-only sub-agent role: no mutating call runs. */
  readOnly: boolean
  /** Set when nobody is watching; decides instead of asking. */
  unattended?: UnattendedPolicy
  /**
   * The user approved this exact call in advance (a worker's answered
   * ask_user). Consulted only where the call would be refused; true spends
   * that approval.
   */
  allowOnce?: (tool: string, input: Record<string, unknown>) => boolean
  toolGate?: ToolGate
  origin?: TurnOrigin
}

export type Decision =
  | { kind: 'run'; mutating: boolean }
  /** Ask the user (the run's approver); refuse with `USER_DENIED` if they say no. */
  | { kind: 'ask'; mutating: true }
  | { kind: 'deny'; reason: string }

export const PLAN_MODE_REFUSAL = 'Plan mode is on, so this tool is disabled. Finish researching and call present_plan.'
export const USER_DENIED = 'The user denied this action. Do not retry it; continue another way or ask how they would like to proceed.'
export const UNATTENDED_READ_ONLY =
  'This run is read-only — the user did not allow it to make changes — so this action was not run. Do not retry it or look for another way to make the change; finish with what you can find out, and say in your report what you would have changed.'
export const UNATTENDED_CATASTROPHIC =
  'This action could do lasting damage (spending money, entering a card number or password, sudo, erasing a disk, force-pushing, a plugin action marked destructive), so it never runs without the user\'s approval. Do not work around it. If it is needed, ask with ask_user, passing approve_tool and approve_input with this exact call; once approved you may make it once. Carry on with the rest meanwhile.'
export const UNATTENDED_RISKY =
  'This action needs the user\'s approval, and this run has nobody to ask, so it was not run. Do not retry it; continue without it and mention it in your report.'
export const SPENDING_REFUSAL =
  'Spending money is only ever for the user\'s own requests. This turn carries work from someone else (a guest in a chat app, or a colleague handing work over), so nothing may be bought or paid for in it. Tell the user what was asked for instead.'

/**
 * Calls that hand work to agents which act with their own access, rather
 * than this run's: the chat's `team` tool creates workers (autonomous by
 * default) and writes to them as the user. Done from a run the user has not
 * trusted that far, it would launder a risky action through a colleague, so
 * such a call counts as risky: "Approve for me" asks, a scheduled task with
 * changes refuses, Full autonomy runs it.
 *
 * Kept here, by name, so the rule is in one place; a tool may also say so
 * itself with `AgentTool.delegates`.
 */
const DELEGATING: Record<string, (input: Record<string, unknown>) => boolean> = {
  team: (input) => ['create_team', 'post', 'message'].includes(String(input.action ?? '').trim().toLowerCase())
}

export function delegates(tool: AgentTool, input: Record<string, unknown>, ctx: ToolContext): boolean {
  return tool.delegates?.(input, ctx) ?? DELEGATING[tool.name]?.(input) ?? false
}

/** Everything a decision is made from, for one call. */
export interface CallFacts {
  mutating: boolean
  risky: boolean
  catastrophic: boolean
  /** Settings → MCP → "Allow all tool permissions" covers it (plugin tools only). */
  preApproved: boolean
  spends: boolean
}

/**
 * What a call is, by asking the tool. Each predicate is asked once: some
 * remember their answer for `run` (payment_card records whether the user was
 * asked), so the loop must not ask them twice.
 */
export function callFacts(
  tool: AgentTool,
  input: Record<string, unknown>,
  ctx: ToolContext,
  settings: { mcp: { allowAllToolPermissions: boolean } }
): CallFacts {
  const mutating = isMutating(tool, input, ctx)
  const spends = tool.spends?.(input, ctx) ?? false
  if (!mutating) return { mutating, risky: false, catastrophic: false, preApproved: false, spends }
  return {
    mutating,
    risky: (tool.risky?.(input, ctx) ?? false) || delegates(tool, input, ctx),
    // What can't be undone (a real-money order, a destructive plugin call) is
    // never covered by the blanket plugin pre-approval, in any mode.
    catastrophic: tool.catastrophic?.(input, ctx) ?? false,
    // Settings → MCP → Allow All MCP Tool Permissions: the user has approved
    // every plugin call in advance. Plan mode and read-only runs still refuse.
    preApproved: settings.mcp.allowAllToolPermissions && toolSourceOf(tool) === 'plugins',
    spends
  }
}

/**
 * The decision for one call. `allowOnce` is consulted only where the call
 * would otherwise be refused, and a true answer spends that approval, so
 * call this exactly once per call.
 */
export function decide(
  tool: AgentTool,
  input: Record<string, unknown>,
  facts: CallFacts,
  policy: RunPolicy,
  approvalMode: ApprovalMode,
  name = tool.name
): Decision {
  // A worker answering a guest may not use this tool at all, mutating or not.
  const gated = policy.toolGate?.(tool, input)
  if (gated) return { kind: 'deny', reason: gated }
  // Money is spent only for the user's own requests, however much the
  // worker is trusted otherwise — no Approve once lifts this.
  if (facts.spends && (policy.origin === 'guest' || policy.origin === 'delegated')) return { kind: 'deny', reason: SPENDING_REFUSAL }
  if (!facts.mutating) return { kind: 'run', mutating: false }
  if (policy.readOnly) return { kind: 'deny', reason: PLAN_MODE_REFUSAL }

  const { risky, catastrophic, preApproved } = facts
  // Scheduled tasks and workers: nobody is there to ask, so the run's own
  // policy stands in for the user's approval setting.
  if (policy.unattended) {
    if (policy.unattended === 'read-only') return { kind: 'deny', reason: UNATTENDED_READ_ONLY }
    if (policy.unattended === 'autonomous') {
      // Trusted to act alone: everything runs except what can't be undone —
      // unless the user approved this very call (ask_user).
      if (catastrophic && !policy.allowOnce?.(name, input)) return { kind: 'deny', reason: UNATTENDED_CATASTROPHIC }
      return { kind: 'run', mutating: true }
    }
    // "Allow All MCP Tool Permissions" approves plugin calls in advance, for
    // a worker as for a chat.
    if ((catastrophic || (risky && !preApproved)) && !policy.allowOnce?.(name, input)) {
      return { kind: 'deny', reason: UNATTENDED_RISKY }
    }
    return { kind: 'run', mutating: true }
  }
  if (approvalMode === 'full') {
    // Full autonomy: the user is here but has trusted the agent to act.
    // Everything runs except what can't be undone, which still waits for
    // them like any approval (plugin pre-approval or not).
    return catastrophic ? { kind: 'ask', mutating: true } : { kind: 'run', mutating: true }
  }
  if (catastrophic || (!preApproved && (approvalMode === 'ask' || risky))) return { kind: 'ask', mutating: true }
  return { kind: 'run', mutating: true }
}

/**
 * Whether a call would run without asking anybody under `approvalMode`, for
 * a front end re-checking a pending approval after the user changed the mode
 * mid-turn (the CLI). Never spends an approve-once grant.
 */
export function runsWithoutAsking(
  tool: AgentTool,
  input: Record<string, unknown>,
  ctx: ToolContext,
  approvalMode: ApprovalMode
): boolean {
  const facts = callFacts(tool, input, ctx, ctx.settings)
  const policy: RunPolicy = ctx.policy ?? { readOnly: ctx.readOnly }
  return decide(tool, input, facts, { ...policy, allowOnce: undefined }, approvalMode).kind === 'run'
}
